/**
 * Acesso ao proxy de dados do GoDeploy (`env.PROXY_BASE_URL`).
 *
 * O proxy aceita SQL: `POST /{db}/_query` com `{sql}`. Uma primeira versão
 * deste arquivo usava a interface PostgREST (`GET /{db}/{schema}.{tabela}`) e
 * agregava no worker por não haver GROUP BY — desnecessário. O padrão de SQL é
 * o que o `mockup-studio` já usa em produção.
 *
 * DUAS COISAS QUE CONTINUAM VALENDO:
 *
 * 1. A autenticação é o COOKIE DO VISITANTE, repassado pelo worker. Um cron não
 *    tem cookie. Logo o Curador NÃO roda no cron: roda quando alguém logado
 *    pede. O cron avança o que depende só do AI Proxy, que usa secret.
 *
 * 2. O proxy corta a resposta em 1000 linhas SEM AVISAR. Toda consulta que pode
 *    passar disso precisa de agregação ou paginação com ordenação total —
 *    senão a resposta chega incompleta em silêncio.
 */

import type { Candidata, Env, Mascara, ZonaLogo } from './tipos';

/** Categoria de origem: é de capinha que saem as best-sellers a adaptar. */
const CATEGORIA_CASE = 'Capinha de Celular';

/** Sufixo que marca a versão térmica de uma estampa. Convenção do catálogo. */
export const SUFIXO_TERMICO = '-termicos';

/** Teto do proxy. Passar disso corta a resposta sem erro. */
const TETO_LINHAS = 1000;

/**
 * Acessórios e afins que aparecem na venda de "capinha" mas não são estampa
 * adaptável. Filtro explícito porque `cordao-para-case` entrou na fila de
 * teste e custou tempo de quem revisou.
 */
const RUIDO = [
  'cordao-para-case',
  'cordao',
  'pop-socket',
  'popsocket',
  'suporte',
  'carregador',
  'fone',
  'pelicula',
  'anel',
];

export function ehRuido(estampaKey: string): boolean {
  const k = estampaKey.toLowerCase();
  return RUIDO.some((r) => k === r || k.startsWith(r + '-') || k.includes('-' + r));
}

/**
 * Fator de transferência por tema: quanto do sucesso em capinha se espera que
 * atravesse para térmico.
 *
 * É heurística de partida, não verdade medida — e é DE PROPÓSITO que ela é
 * grosseira e visível aqui em vez de escondida num prompt. O A1 tem a palavra
 * final sobre prioridade; este número só ordena a lista que ele recebe.
 */
const FATOR_TEMA: Record<string, number> = {
  florais: 1.15,
  religiao: 1.2,
  cristianismo: 1.2,
  frases: 0.5,
  'para eles': 0.8,
  animais: 1.0,
  geometrico: 1.05,
  abstrato: 1.05,
};

export function fatorDoTema(tema: string | null): number {
  if (!tema) return 1;
  return FATOR_TEMA[tema.trim().toLowerCase()] ?? 1;
}

// ---------------------------------------------------------------------------
// Cliente SQL
// ---------------------------------------------------------------------------

export class ErroDados extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ErroDados';
  }
}

/** Escapa aspas simples para interpolação em literal SQL. */
const esc = (s: string) => String(s).replace(/'/g, "''");

/**
 * Chaves de estampa e slugs vêm de fora (corpo de POST, querystring).
 * Só passam se casarem com o formato do catálogo — nada de confiar no `esc()`
 * sozinho quando dá para recusar a entrada.
 */
const CHAVE_OK = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

export function chaveValida(k: string): boolean {
  return CHAVE_OK.test(k);
}

type Banco = 'factory' | 'site' | 'datamart';

async function sql(
  env: Env,
  cookie: string,
  db: Banco,
  consulta: string,
): Promise<Record<string, unknown>[]> {
  if (!env.PROXY_BASE_URL) throw new ErroDados('PROXY_BASE_URL não injetado no worker.', 500);
  const res = await fetch(`${env.PROXY_BASE_URL}/${db}/_query`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: consulta }),
  });
  if (res.status === 401) {
    throw new ErroDados('não autenticado no proxy de dados (o cron não tem cookie).', 401);
  }
  const texto = await res.text();
  if (!res.ok) throw new ErroDados(`${db} HTTP ${res.status}: ${texto.slice(0, 240)}`, res.status);
  try {
    return (JSON.parse(texto).rows as Record<string, unknown>[]) || [];
  } catch {
    throw new ErroDados(`${db} devolveu resposta não-JSON`, 502);
  }
}

/** Consulta que pode falhar sem derrubar o estágio. 401 sempre propaga. */
async function sqlOpcional(
  env: Env,
  cookie: string,
  db: Banco,
  consulta: string,
): Promise<Record<string, unknown>[]> {
  try {
    return await sql(env, cookie, db, consulta);
  } catch (e) {
    if ((e as ErroDados).status === 401) throw e;
    console.log(`[dados] ${db} falhou:`, (e as Error)?.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Estágio 0 — Curador (SQL, sem IA)
// ---------------------------------------------------------------------------

export interface ResultadoCuradoria {
  candidatas: Candidata[];
  total_analisadas: number;
  descartadas: { estampa_key: string; motivo: string }[];
}

/**
 * Estágio 0. Top cases da janela que ainda não têm versão térmica.
 *
 * Sem IA de propósito: é uma pergunta com resposta exata, e um LLM aqui só
 * adicionaria variância. O julgamento vem depois, no A1.
 *
 * Nunca usar `gold.estampa_opportunity`: `indice_transferencia` é 0 em todas as
 * linhas, `receita_potencial_30d` é constante e `estampa_key` vem poluído com
 * volumetria. Ver docs/MAPA-ATIVOS.md secao 6 — já custou meio dia.
 *
 * O gap é fechado em duas consultas em bancos diferentes (o datamart não conhece
 * `products`), com o anti-join feito aqui. Cada consulta é agregada, então
 * nenhuma das duas encosta no teto de 1000 linhas.
 */
export async function curar(
  env: Env,
  cookie: string,
  janelaDias = 90,
  limite = 30,
): Promise<ResultadoCuradoria> {
  const dias = Math.min(365, Math.max(1, Math.round(janelaDias)));

  const vendas = await sql(
    env,
    cookie,
    'datamart',
    `SELECT d.estampa_key,
            SUM(d.unidades) AS unidades,
            SUM(d.receita)  AS receita,
            MAX(e.estampa_nome) AS nome,
            MAX(e.tema)         AS tema,
            MAX(e.licenca)      AS licenca,
            BOOL_OR(COALESCE(e.is_clear, false)) AS is_clear
       FROM gold.product_estampa_daily d
       LEFT JOIN gold.dim_estampa e ON e.estampa_key = d.estampa_key
      WHERE d.data >= CURRENT_DATE - INTERVAL '${dias} days'
        AND d.categoria = '${esc(CATEGORIA_CASE)}'
      GROUP BY d.estampa_key
      HAVING SUM(d.unidades) > 0
      ORDER BY SUM(d.unidades) DESC
      LIMIT 400`,
  );

  const comTermico = new Set(
    (
      await sql(
        env,
        cookie,
        'factory',
        `SELECT DISTINCT LEFT(engine_identifier, LENGTH(engine_identifier) - ${SUFIXO_TERMICO.length}) AS base
           FROM products
          WHERE deleted_at IS NULL
            AND engine_identifier LIKE '%${esc(SUFIXO_TERMICO)}'
          LIMIT 900`,
      )
    ).map((r) => String(r.base || '')),
  );

  const descartadas: { estampa_key: string; motivo: string }[] = [];
  const candidatas: Candidata[] = [];

  for (const r of vendas) {
    const key = String(r.estampa_key || '');
    if (!key) continue;

    if (ehRuido(key)) {
      descartadas.push({ estampa_key: key, motivo: 'acessório, não é estampa' });
      continue;
    }
    if (comTermico.has(key)) {
      descartadas.push({ estampa_key: key, motivo: 'já tem versão térmica' });
      continue;
    }
    if (r.is_clear === true) {
      descartadas.push({ estampa_key: key, motivo: 'is_clear' });
      continue;
    }

    const tema = (r.tema as string) ?? null;
    const unidades = Number(r.unidades || 0);
    candidatas.push({
      estampa_key: key,
      nome: String(r.nome || key),
      tema,
      licenca: (r.licenca as string) ?? null,
      unidades,
      receita: Number(r.receita || 0),
      score: unidades * fatorDoTema(tema),
    });
    if (candidatas.length >= limite) break;
  }

  candidatas.sort((a, b) => b.score - a.score);
  return { candidatas, total_analisadas: vendas.length, descartadas: descartadas.slice(0, 60) };
}

// ---------------------------------------------------------------------------
// Estágio 1 — Resolvedor de arte (cascata, sem IA)
// ---------------------------------------------------------------------------

const HOST_CATALOG = 'https://catalog-api-v2.gocase.com.br/api/v1/public/line_item_image';
const HOST_S3 = 'https://custom-case-images.s3.amazonaws.com';

/** Hosts de imagem liberados. Nada fora desta lista é buscado. */
export const HOSTS_LIBERADOS = [
  'custom-case-images.s3.amazonaws.com',
  'ik.imagekit.io',
  'static-goengines.gocase.com.br',
  'static-factory.gocase.com.br',
  'catalog-api-v2.gocase.com.br',
];

export function hostLiberado(url: string): boolean {
  try {
    return HOSTS_LIBERADOS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface ArteComOrigem {
  png_alta: string;
  material: string | null;
  engine_identifier: string;
  /** Qual etapa da cascata respondeu — diagnóstico, não decoração. */
  origem: 'factory' | 'site';
  /** Resolução nativa da arte na capinha. Entra no critério 4 do A11. */
  arte_w: number | null;
  arte_h: number | null;
}

/**
 * Estágio 1. Acha o PNG em alta da estampa: Factory -> Site.
 *
 * Devolve `origem` porque quando a arte vem errada a primeira pergunta é sempre
 * "de onde ela veio" — e sem esse campo a resposta é uma escavação. Devolve
 * também a resolução nativa (`stamps.width/height`), que é o teto de qualidade
 * do que o motor pode ampliar sem pixelar.
 */
export async function resolverArte(
  env: Env,
  estampaKey: string,
  cookie: string,
): Promise<ArteComOrigem | null> {
  if (!chaveValida(estampaKey)) throw new ErroDados(`estampa_key inválida: ${estampaKey}`, 400);

  // Factory: products -> stamps.image + materials.slug, numa consulta só.
  const linhas = await sqlOpcional(
    env,
    cookie,
    'factory',
    `SELECT p.engine_identifier, s.image, s.width, s.height, m.slug AS material
       FROM products p
       JOIN stamps s ON s.product_id = p.id AND s.image IS NOT NULL
       LEFT JOIN available_product_materials apm
              ON apm.product_id = p.id AND apm.deleted_at IS NULL
       LEFT JOIN materials m ON m.id = apm.material_id AND m.deleted_at IS NULL
      WHERE p.deleted_at IS NULL
        AND p.engine_identifier IN ('${esc(estampaKey)}-case', '${esc(estampaKey)}')
        AND m.slug IS NOT NULL
      ORDER BY s.width DESC NULLS LAST
      LIMIT 1`,
  );

  if (linhas.length) {
    const r = linhas[0];
    const img = String(r.image || '').replace(/\.[a-z]+$/i, '');
    const ident = String(r.engine_identifier || '');
    const material = String(r.material || '');
    if (img && material) {
      return {
        png_alta: `${HOST_CATALOG}/${material}/${ident}/${img}.png`,
        material,
        engine_identifier: ident,
        origem: 'factory',
        arte_w: r.width === null ? null : Number(r.width),
        arte_h: r.height === null ? null : Number(r.height),
      };
    }
  }

  // Site: velociraptor_products.image_br, cortando no `stamp=`
  const doSite = await sqlOpcional(
    env,
    cookie,
    'site',
    `SELECT image_br FROM velociraptor_products
      WHERE image_br LIKE '%stamp=${esc(estampaKey)}%'
      LIMIT 1`,
  );
  if (doSite.length) {
    const bruto = String(doSite[0].image_br || '');
    const caminho = bruto.split('stamp=')[1]?.split('&')[0];
    if (caminho) {
      const url = `${HOST_S3}/${caminho}`;
      if (hostLiberado(url)) {
        return {
          png_alta: url,
          material: null,
          engine_identifier: `${estampaKey}-case`,
          origem: 'site',
          arte_w: null,
          arte_h: null,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Máscaras e zona da logo
// ---------------------------------------------------------------------------

/**
 * Máscaras de produção. Números vindos de `materials.width/height` do Factory.
 *
 * Para térmico cilíndrico a máscara é o retângulo da área impressa desenrolada;
 * não existe (nem é preciso) PSD de máscara. NÃO inventar dimensão aqui.
 */
export const MASCARAS: Mascara[] = [
  { produto: 'garrafa-fresh', volumetria: '650ml', w: 2754, h: 2340 },
  { produto: 'garrafa-fresh', volumetria: '950ml', w: 3380, h: 2114 },
  { produto: 'garrafa-urban', volumetria: '500ml', w: 2672, h: 1465 },
  { produto: 'garrafa-mini', volumetria: '350ml', w: 2754, h: 1335 },
  { produto: 'garrafa-fun', volumetria: 'unica', w: 2783, h: 1524 },
  { produto: 'copo-life', volumetria: '600ml', w: 3488, h: 1890 },
  { produto: 'copo-life', volumetria: '880ml', w: 3495, h: 2384 },
  { produto: 'copo-life', volumetria: '1180ml', w: 3827, h: 2598 },
  { produto: 'copo-vibe', volumetria: '470ml', w: 3512, h: 1441 },
  { produto: 'garrafa-flip', volumetria: '750ml', w: 2915, h: 2102 },
  { produto: 'garrafa-magsafe', volumetria: '650ml', w: 2754, h: 2340 },
];

/** Primeiro corte do projeto: Garrafa Fresh 650ml. */
export const MASCARA_PADRAO: Mascara = MASCARAS[0];

/**
 * Zona de segurança da logo Gocase, lida do Factory.
 *
 * ATENÇÃO — ESTADO REAL DO DADO, medido em 2026-09-10 contra o Factory:
 *
 *   Para os térmicos do primeiro corte (garrafafresh650/950, flippro,
 *   copocerveja470) as quatro colunas — `logo_pos_x`, `logo_pos_y`,
 *   `logo_size`, `logo_border_size` — vêm **NULL**, e `applies_custom_logo` é
 *   **false**. Nos MagSafe vêm **zeradas**. As únicas linhas com valor real são
 *   as garrafas Kids (`garrafakids460`: 1184/1303, size 412, border 199 numa
 *   máscara 2754x1335 — logo embaixo, ao centro).
 *
 * Ou seja: a margem de segurança da logo NÃO está cadastrada no Factory para os
 * materiais que este projeto ataca. Ela existe na estrutura, não nos dados.
 *
 * Esta função é o mecanismo, pronto para o dia em que o cadastro for
 * preenchido: quando há valor, devolve a zona; quando não há, devolve `null` e
 * o critério 5 do A11 responde "não verificável" em vez de "aprovado". Um
 * critério de compliance que passa por falta de dado não é critério.
 *
 * A margem é o retângulo da logo dilatado por `logo_border_size`, que é a folga
 * cadastrada em volta dela.
 */
export async function zonaLogo(
  env: Env,
  cookie: string,
  materialSlug: string,
): Promise<ZonaLogo> {
  if (!chaveValida(materialSlug)) {
    return { disponivel: false, motivo: `slug de material inválido: ${materialSlug}` };
  }

  const linhas = await sqlOpcional(
    env,
    cookie,
    'factory',
    `SELECT width, height, logo_pos_x, logo_pos_y, logo_size, logo_border_size,
            applies_custom_logo
       FROM materials
      WHERE deleted_at IS NULL AND slug = '${esc(materialSlug)}'
      LIMIT 1`,
  );

  if (!linhas.length) {
    return { disponivel: false, motivo: `material ${materialSlug} não encontrado no Factory` };
  }

  const r = linhas[0];
  const px = r.logo_pos_x === null || r.logo_pos_x === undefined ? null : Number(r.logo_pos_x);
  const py = r.logo_pos_y === null || r.logo_pos_y === undefined ? null : Number(r.logo_pos_y);
  const size = r.logo_size === null || r.logo_size === undefined ? null : Number(r.logo_size);
  const borda = Number(r.logo_border_size || 0);

  if (px === null || py === null || size === null) {
    return {
      disponivel: false,
      motivo:
        `o Factory não tem logo_pos_x/logo_pos_y/logo_size para ${materialSlug} ` +
        `(vêm NULL). A margem da logo não está cadastrada para este material.`,
    };
  }
  if (size <= 0) {
    return {
      disponivel: false,
      motivo:
        `o Factory tem logo_size = ${size} para ${materialSlug} — cadastro zerado, ` +
        `não é margem real.`,
    };
  }

  return {
    disponivel: true,
    x: Math.max(0, px - borda),
    y: Math.max(0, py - borda),
    w: size + borda * 2,
    h: size + borda * 2,
    logo: { x: px, y: py, size },
    borda,
    aplica_logo: r.applies_custom_logo === true,
    material: materialSlug,
  };
}

/** Máscara real do material, direto do Factory, em vez da tabela estática. */
export async function mascaraDoMaterial(
  env: Env,
  cookie: string,
  materialSlug: string,
): Promise<Mascara | null> {
  if (!chaveValida(materialSlug)) return null;
  const linhas = await sqlOpcional(
    env,
    cookie,
    'factory',
    `SELECT slug, name, width, height FROM materials
      WHERE deleted_at IS NULL AND slug = '${esc(materialSlug)}'
        AND width IS NOT NULL AND height IS NOT NULL
      LIMIT 1`,
  );
  if (!linhas.length) return null;
  const r = linhas[0];
  return {
    produto: String(r.name || materialSlug),
    volumetria: '',
    w: Number(r.width),
    h: Number(r.height),
    material: materialSlug,
  };
}

export { TETO_LINHAS };
