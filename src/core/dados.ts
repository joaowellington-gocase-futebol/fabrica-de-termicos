/**
 * Acesso ao proxy de dados do GoDeploy (`env.PROXY_BASE_URL`).
 *
 * DUAS RESTRIÇÕES QUE MUDAM O DESENHO DA ESTEIRA, e que a doc original não
 * previa — leia antes de mexer aqui:
 *
 * 1. NÃO é SQL. É PostgREST, somente leitura. Não existe JOIN nem GROUP BY
 *    arbitrário. A "query do gap" virou: agregação no proxy quando ele aceita,
 *    e agregação no worker quando não aceita.
 *
 * 2. A autenticação é o COOKIE DO VISITANTE, repassado pelo worker. Um cron não
 *    tem cookie. Logo o Curador NÃO roda no cron: roda quando alguém logado
 *    pede (botão "Encher a fila") ou por chamada com cookie válido. O cron
 *    avança tudo o que depende só do AI Proxy, que usa secret e não cookie.
 *
 * Consequência prática: a fila não se enche sozinha às 6h da manhã. Ela se
 * enche quando um humano abre o painel, e daí em diante anda sozinha. Trocar
 * isso exige uma credencial de serviço para o datamart (METABASE_TOKEN ou
 * equivalente), que hoje não existe configurada.
 */

import type { Candidata, Env, Mascara } from './tipos';

/** Categoria de origem: é de capinha que saem as best-sellers a adaptar. */
const CATEGORIA_CASE = 'Capinha de Celular';

/** Sufixo que marca a versão térmica de uma estampa. Convenção do catálogo. */
export const SUFIXO_TERMICO = '-termicos';

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
 * final sobre prioridade; este número só ordena a lista que ele recebe. Quando
 * houver histórico de térmico vendido, isto vira regressão sobre dado real.
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
// Cliente PostgREST
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

/**
 * GET no proxy, repassando o cookie do visitante.
 *
 * `cookie` vem do `Request` original. Sem ele o proxy devolve 401 — o que é o
 * comportamento correto e não um bug a contornar.
 */
async function proxyGet(
  env: Env,
  caminho: string,
  consulta: string,
  cookie: string,
): Promise<unknown[]> {
  if (!env.PROXY_BASE_URL) throw new ErroDados('PROXY_BASE_URL não injetado no worker.', 500);
  const url = `${env.PROXY_BASE_URL}/${caminho}?${consulta}`;
  const res = await fetch(url, { headers: { Cookie: cookie } });
  if (res.status === 401) {
    throw new ErroDados('não autenticado no proxy de dados (o cron não tem cookie).', 401);
  }
  if (!res.ok) {
    throw new ErroDados(`proxy ${res.status} em ${caminho}: ${(await res.text()).slice(0, 240)}`, res.status);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

function isoDiasAtras(dias: number): string {
  return new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Estágio 0 — Curador (SQL/PostgREST, sem IA)
// ---------------------------------------------------------------------------

interface Agregado {
  estampa_key: string;
  unidades: number;
  receita: number;
}

/**
 * Soma unidades e receita por estampa na janela.
 *
 * Tenta a sintaxe de agregação do PostgREST (`unidades.sum()`), que resolve tudo
 * numa requisição. Se o servidor não tiver agregação habilitada, cai para
 * páginas de linhas cruas somadas aqui. Os dois caminhos existem porque não é
 * possível saber a configuração do proxy sem chamar — e o modo usado é
 * devolvido junto, para aparecer no /api/health em vez de virar mistério.
 */
async function agregaPorEstampa(
  env: Env,
  janelaDias: number,
  cookie: string,
): Promise<{ dados: Agregado[]; modo: 'agregado' | 'paginado' }> {
  const desde = isoDiasAtras(janelaDias);
  const base = `data=gte.${desde}&categoria=eq.${encodeURIComponent(CATEGORIA_CASE)}`;

  try {
    const linhas = (await proxyGet(
      env,
      'datamart/gold.product_estampa_daily',
      `${base}&select=estampa_key,unidades.sum(),receita.sum()&limit=400`,
      cookie,
    )) as Record<string, unknown>[];

    const dados = linhas
      .map((r) => ({
        estampa_key: String(r.estampa_key || ''),
        // O PostgREST preserva o nome da coluna agregada; versões antigas
        // devolvem "sum". Preferir o nome da coluna evita ler o total errado
        // quando duas colunas são somadas na mesma consulta.
        unidades: Number(r['unidades'] ?? r.sum ?? 0),
        receita: Number(r['receita'] ?? 0),
      }))
      .filter((r) => r.estampa_key);

    // Agregação habilitada mas com nomes de campo diferentes do esperado
    // devolveria zeros silenciosos. Melhor cair para o caminho paginado.
    if (dados.length && dados.some((d) => d.unidades > 0)) return { dados, modo: 'agregado' };
  } catch (e) {
    if ((e as ErroDados).status === 401) throw e;
    console.log('[curador] agregação no proxy indisponível:', (e as Error)?.message);
  }

  // Fallback: páginas de linhas cruas, somadas no worker.
  const soma = new Map<string, Agregado>();
  const porPagina = 1000;
  const maxPaginas = 40; // teto de CPU: 40k linhas é o limite sensato aqui.
  for (let p = 0; p < maxPaginas; p++) {
    const linhas = (await proxyGet(
      env,
      'datamart/gold.product_estampa_daily',
      `${base}&select=estampa_key,unidades,receita&order=estampa_key&limit=${porPagina}&offset=${p * porPagina}`,
      cookie,
    )) as Record<string, unknown>[];
    for (const r of linhas) {
      const k = String(r.estampa_key || '');
      if (!k) continue;
      const atual = soma.get(k) || { estampa_key: k, unidades: 0, receita: 0 };
      atual.unidades += Number(r.unidades || 0);
      atual.receita += Number(r.receita || 0);
      soma.set(k, atual);
    }
    if (linhas.length < porPagina) break;
  }
  return { dados: [...soma.values()], modo: 'paginado' };
}

/** Estampas que JÁ têm versão térmica publicada — o lado direito do gap. */
async function jaTemTermico(env: Env, cookie: string): Promise<Set<string>> {
  const linhas = (await proxyGet(
    env,
    'factory/public.products',
    `select=engine_identifier&engine_identifier=like.*${SUFIXO_TERMICO}&active=is.true&deleted_at=is.null&limit=5000`,
    cookie,
  )) as Record<string, unknown>[];

  const set = new Set<string>();
  for (const r of linhas) {
    const id = String(r.engine_identifier || '');
    if (id.endsWith(SUFIXO_TERMICO)) set.add(id.slice(0, -SUFIXO_TERMICO.length));
  }
  return set;
}

/** Metadados da estampa: nome, tema, licença, is_clear. */
async function dimEstampas(
  env: Env,
  chaves: string[],
  cookie: string,
): Promise<Map<string, Record<string, unknown>>> {
  const mapa = new Map<string, Record<string, unknown>>();
  // `in.()` numa URL tem limite de tamanho; 120 chaves por lote é seguro.
  const lote = 120;
  for (let i = 0; i < chaves.length; i += lote) {
    const parte = chaves.slice(i, i + lote).map((k) => `"${k.replace(/"/g, '')}"`);
    const linhas = (await proxyGet(
      env,
      'datamart/gold.dim_estampa',
      `select=estampa_key,estampa_nome,licenca,is_clear,tema,first_seen_at&estampa_key=in.(${parte.join(',')})`,
      cookie,
    )) as Record<string, unknown>[];
    for (const r of linhas) mapa.set(String(r.estampa_key), r);
  }
  return mapa;
}

export interface ResultadoCuradoria {
  candidatas: Candidata[];
  modo: 'agregado' | 'paginado';
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
 */
export async function curar(
  env: Env,
  cookie: string,
  janelaDias = 90,
  limite = 30,
): Promise<ResultadoCuradoria> {
  const { dados, modo } = await agregaPorEstampa(env, janelaDias, cookie);
  const ordenado = dados.sort((a, b) => b.unidades - a.unidades);
  const descartadas: { estampa_key: string; motivo: string }[] = [];

  const semRuido = ordenado.filter((d) => {
    if (ehRuido(d.estampa_key)) {
      descartadas.push({ estampa_key: d.estampa_key, motivo: 'acessório, não é estampa' });
      return false;
    }
    return true;
  });

  const comTermico = await jaTemTermico(env, cookie);
  const gap = semRuido.filter((d) => {
    if (comTermico.has(d.estampa_key)) {
      descartadas.push({ estampa_key: d.estampa_key, motivo: 'já tem versão térmica' });
      return false;
    }
    return true;
  });

  const topo = gap.slice(0, limite * 3);
  const dim = await dimEstampas(
    env,
    topo.map((d) => d.estampa_key),
    cookie,
  );

  const candidatas: Candidata[] = [];
  for (const d of topo) {
    const meta = dim.get(d.estampa_key);
    if (meta?.is_clear === true) {
      descartadas.push({ estampa_key: d.estampa_key, motivo: 'is_clear' });
      continue;
    }
    const tema = (meta?.tema as string) ?? null;
    candidatas.push({
      estampa_key: d.estampa_key,
      nome: String(meta?.estampa_nome || d.estampa_key),
      tema,
      licenca: (meta?.licenca as string) ?? null,
      unidades: d.unidades,
      receita: d.receita,
      score: d.unidades * fatorDoTema(tema),
    });
    if (candidatas.length >= limite) break;
  }

  candidatas.sort((a, b) => b.score - a.score);
  return { candidatas, modo, total_analisadas: dados.length, descartadas: descartadas.slice(0, 60) };
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
  origem: 'factory' | 'site' | 'catalog';
}

/**
 * Estágio 1. Acha o PNG em alta da estampa: Factory -> Site -> Catalog.
 *
 * Devolve `origem` porque quando a arte vem errada a primeira pergunta é sempre
 * "de onde ela veio" — e sem esse campo a resposta é uma escavação.
 */
export async function resolverArte(
  env: Env,
  estampaKey: string,
  cookie: string,
): Promise<ArteComOrigem | null> {
  const candidatosId = [`${estampaKey}-case`, estampaKey];

  // 1. Factory: products -> stamps.image + materials.slug
  for (const ident of candidatosId) {
    try {
      const prods = (await proxyGet(
        env,
        'factory/public.products',
        `select=id,engine_identifier,sku&engine_identifier=eq.${encodeURIComponent(ident)}&deleted_at=is.null&limit=1`,
        cookie,
      )) as Record<string, unknown>[];
      if (!prods.length) continue;

      const produtoId = Number(prods[0].id);
      const stamps = (await proxyGet(
        env,
        'factory/public.stamps',
        `select=image,width,height&product_id=eq.${produtoId}&image=not.is.null&order=width.desc&limit=1`,
        cookie,
      )) as Record<string, unknown>[];
      if (!stamps.length) continue;

      const img = String(stamps[0].image || '').replace(/\.[a-z]+$/i, '');
      const mats = (await proxyGet(
        env,
        'factory/public.available_product_materials',
        `select=material_id&product_id=eq.${produtoId}&deleted_at=is.null&limit=1`,
        cookie,
      ).catch(() => [])) as Record<string, unknown>[];

      let materialSlug: string | null = null;
      if (mats.length) {
        const m = (await proxyGet(
          env,
          'factory/public.materials',
          `select=slug&id=eq.${Number(mats[0].material_id)}&limit=1`,
          cookie,
        ).catch(() => [])) as Record<string, unknown>[];
        materialSlug = m.length ? String(m[0].slug || '') || null : null;
      }

      if (img && materialSlug) {
        return {
          png_alta: `${HOST_CATALOG}/${materialSlug}/${ident}/${img}.png`,
          material: materialSlug,
          engine_identifier: ident,
          origem: 'factory',
        };
      }
    } catch (e) {
      if ((e as ErroDados).status === 401) throw e;
      console.log('[resolvedor] factory falhou para', ident, (e as Error)?.message);
    }
  }

  // 2. Site: velociraptor_products.image_br, cortando no `stamp=`
  try {
    const linhas = (await proxyGet(
      env,
      'site/public.velociraptor_products',
      `select=image_br&image_br=like.*stamp=${estampaKey}*&limit=1`,
      cookie,
    )) as Record<string, unknown>[];
    if (linhas.length) {
      const bruto = String(linhas[0].image_br || '');
      const caminho = bruto.split('stamp=')[1]?.split('&')[0];
      if (caminho) {
        const url = `${HOST_S3}/${caminho}`;
        if (hostLiberado(url)) {
          return { png_alta: url, material: null, engine_identifier: `${estampaKey}-case`, origem: 'site' };
        }
      }
    }
  } catch (e) {
    if ((e as ErroDados).status === 401) throw e;
    console.log('[resolvedor] site falhou:', (e as Error)?.message);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Máscaras — px reais, vindos de factory materials.width/height
// ---------------------------------------------------------------------------

/**
 * Máscaras de produção. Números vindos de `materials.width/height` do Factory
 * e conferidos no `gerador-de-adaptacoes`.
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
