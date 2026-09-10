/**
 * Schema e acesso ao `env.DB` (SQLite do GoDeploy).
 *
 * A esteira é uma fila com estado, não um agente conversacional: cada candidata
 * é uma linha em `fila` e o cron da plataforma avança os estados. Cada estágio
 * é idempotente e reprocessável isoladamente.
 *
 * Limites do runtime que moldaram este schema:
 *  - linha de no máximo 2 MB  -> imagem grande vai fatiada em `blobs`
 *  - ~100 parâmetros ligados por statement -> nada de INSERT em lote gigante
 *  - 100 colunas por tabela -> as saídas de agente moram em colunas JSON
 */

import type { Env, Estado, ItemFila } from './tipos';

/**
 * Fatia de base64 por linha de `blobs`.
 *
 * O teto real é 2 MB por linha; 700 KB dá folga para o overhead do statement e
 * ainda mantém o número de fatias baixo num PNG de produção.
 */
export const TAMANHO_FATIA = 700_000;

/**
 * Colunas adicionadas depois da primeira versão do schema.
 *
 * Acrescentar aqui é o jeito de evoluir a tabela sem perder a fila que já está
 * no ar. Nunca remover uma linha desta lista: quem já rodou a migração não a
 * roda de novo, mas quem está subindo pela primeira vez precisa dela.
 */
const COLUNAS_NOVAS: [string, string, string][] = [
  ['fila', 'fidelidade', 'TEXT'],
  ['fila', 'medicao', 'TEXT'],
  ['fila', 'zona_logo', 'TEXT'],
  ['fila', 'arte_w', 'INTEGER'],
  ['fila', 'arte_h', 'INTEGER'],
];

let pronto = false;

export async function garanteSchema(env: Env): Promise<void> {
  if (pronto) return;

  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS fila (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       estampa_key TEXT NOT NULL UNIQUE,
       nome TEXT NOT NULL DEFAULT '',
       tema TEXT,
       licenca TEXT,
       unidades REAL NOT NULL DEFAULT 0,
       receita REAL NOT NULL DEFAULT 0,
       estado TEXT NOT NULL DEFAULT 'candidata',
       rota_usada TEXT,
       nota_auditor REAL,
       erro_costura_px REAL,
       png_alta TEXT,
       material TEXT,
       engine_identifier TEXT,
       mascara_w INTEGER NOT NULL DEFAULT 2754,
       mascara_h INTEGER NOT NULL DEFAULT 2340,
       leitura TEXT,
       plano TEXT,
       segmentacao TEXT,
       auditoria TEXT,
       fidelidade TEXT,
       medicao TEXT,
       zona_logo TEXT,
       arte_w INTEGER,
       arte_h INTEGER,
       cor TEXT,
       marca TEXT,
       nomeacao TEXT,
       copy TEXT,
       tentativas INTEGER NOT NULL DEFAULT 0,
       motivo_falha TEXT,
       travado_em TEXT,
       criado_em TEXT NOT NULL DEFAULT (datetime('now')),
       atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
       atualizado_por TEXT NOT NULL DEFAULT ''
     )`,
    [],
  );

  // Sem esta tabela não há como melhorar prompt depois. Existe desde o dia 1.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS agente_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       item_id INTEGER,
       agente TEXT NOT NULL,
       modelo TEXT NOT NULL DEFAULT '',
       tokens_entrada INTEGER NOT NULL DEFAULT 0,
       tokens_saida INTEGER NOT NULL DEFAULT 0,
       latencia_ms INTEGER NOT NULL DEFAULT 0,
       custo_usd REAL NOT NULL DEFAULT 0,
       ok INTEGER NOT NULL DEFAULT 1,
       erro TEXT,
       quando TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    [],
  );

  // Previews pequenos (WebP), um por tipo e por item. Cabem numa linha.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS imagens (
       item_id INTEGER NOT NULL,
       tipo TEXT NOT NULL,
       data_url TEXT NOT NULL,
       w INTEGER NOT NULL DEFAULT 0,
       h INTEGER NOT NULL DEFAULT 0,
       criado_em TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (item_id, tipo)
     )`,
    [],
  );

  // PNG de produção em fatias, porque não cabe em 2 MB.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS blobs (
       item_id INTEGER NOT NULL,
       tipo TEXT NOT NULL,
       fatia INTEGER NOT NULL,
       total INTEGER NOT NULL,
       dados TEXT NOT NULL,
       PRIMARY KEY (item_id, tipo, fatia)
     )`,
    [],
  );

  // O que a equipe fez, para a esteira ser auditável por gente.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS historico (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       item_id INTEGER,
       acao TEXT NOT NULL,
       detalhe TEXT NOT NULL DEFAULT '',
       quem TEXT NOT NULL DEFAULT '',
       quando TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    [],
  );

  // Conjunto de avaliação da T3/T4: rótulo humano contra o qual o prompt mede.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS eval_rotulos (
       estampa_key TEXT PRIMARY KEY,
       png TEXT NOT NULL DEFAULT '',
       separavel INTEGER,
       densidade TEXT,
       tem_texto INTEGER,
       tem_logo INTEGER,
       violacao_plantada TEXT,
       quem TEXT NOT NULL DEFAULT '',
       quando TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    [],
  );

  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS eval_corridas (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       agente TEXT NOT NULL,
       modelo TEXT NOT NULL DEFAULT '',
       n INTEGER NOT NULL DEFAULT 0,
       acerto_separavel REAL,
       acerto_densidade REAL,
       recall_texto REAL,
       recall_logo REAL,
       detalhe TEXT,
       quem TEXT NOT NULL DEFAULT '',
       quando TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    [],
  );

  // Migração de coluna.
  //
  // `CREATE TABLE IF NOT EXISTS` não toca numa tabela que já existe, e o
  // env.DB é persistente entre deploys — então coluna nova só entra por ALTER.
  // O SQLite não tem `ADD COLUMN IF NOT EXISTS`, e um ALTER repetido lança;
  // por isso cada um vai em try/catch. É idempotente por consequência, não por
  // elegância.
  for (const [tabela, coluna, tipo] of COLUNAS_NOVAS) {
    try {
      await env.DB.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`, []);
      console.log(`[schema] coluna ${tabela}.${coluna} criada`);
    } catch {
      /* já existe */
    }
  }

  await env.DB.exec('CREATE INDEX IF NOT EXISTS idx_fila_estado ON fila(estado)', []);
  await env.DB.exec('CREATE INDEX IF NOT EXISTS idx_log_item ON agente_log(item_id)', []);
  await env.DB.exec('CREATE INDEX IF NOT EXISTS idx_log_quando ON agente_log(quando)', []);

  pronto = true;
}

// ---------------------------------------------------------------------------
// Colunas JSON
// ---------------------------------------------------------------------------

function leJson<T>(v: unknown): T | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

/** Converte a linha crua do SQLite no `ItemFila` do contrato. */
export function paraItem(r: Record<string, unknown>): ItemFila {
  return {
    id: Number(r.id),
    estampa_key: String(r.estampa_key || ''),
    nome: String(r.nome || ''),
    tema: (r.tema as string) ?? null,
    licenca: (r.licenca as string) ?? null,
    unidades: Number(r.unidades || 0),
    receita: Number(r.receita || 0),
    estado: String(r.estado || 'candidata'),
    rota_usada: (r.rota_usada as ItemFila['rota_usada']) ?? null,
    nota_auditor: r.nota_auditor === null || r.nota_auditor === undefined ? null : Number(r.nota_auditor),
    erro_costura_px:
      r.erro_costura_px === null || r.erro_costura_px === undefined ? null : Number(r.erro_costura_px),
    png_alta: (r.png_alta as string) ?? null,
    material: (r.material as string) ?? null,
    engine_identifier: (r.engine_identifier as string) ?? null,
    mascara_w: Number(r.mascara_w || 2754),
    mascara_h: Number(r.mascara_h || 2340),
    leitura: leJson(r.leitura),
    plano: leJson(r.plano),
    segmentacao: leJson(r.segmentacao),
    auditoria: leJson(r.auditoria),
    fidelidade: leJson(r.fidelidade),
    medicao: leJson(r.medicao),
    zona_logo: leJson(r.zona_logo),
    arte_w: r.arte_w === null || r.arte_w === undefined ? null : Number(r.arte_w),
    arte_h: r.arte_h === null || r.arte_h === undefined ? null : Number(r.arte_h),
    cor: leJson(r.cor),
    marca: leJson(r.marca),
    nomeacao: leJson(r.nomeacao),
    copy: leJson(r.copy),
    tentativas: Number(r.tentativas || 0),
    motivo_falha: (r.motivo_falha as string) ?? null,
    criado_em: String(r.criado_em || ''),
    atualizado_em: String(r.atualizado_em || ''),
    atualizado_por: String(r.atualizado_por || ''),
  };
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

export async function itemPorId(env: Env, id: number): Promise<ItemFila | null> {
  const r = await env.DB.query('SELECT * FROM fila WHERE id = ?', [id]);
  return r.rows.length ? paraItem(r.rows[0]) : null;
}

export async function itensPorEstado(env: Env, estado: string, limite = 20): Promise<ItemFila[]> {
  const r = await env.DB.query(
    'SELECT * FROM fila WHERE estado = ? ORDER BY receita DESC, id ASC LIMIT ?',
    [estado, limite],
  );
  return r.rows.map(paraItem);
}

/**
 * Grava campos de um item.
 *
 * Monta o SET dinamicamente a partir de uma lista fechada de colunas: nome de
 * coluna nunca vem de fora, só valor vai como parâmetro. Sem isso, um campo
 * vindo do corpo de um POST viraria injeção.
 */
const COLUNAS_GRAVAVEIS = new Set([
  'estado',
  'rota_usada',
  'nota_auditor',
  'erro_costura_px',
  'png_alta',
  'material',
  'engine_identifier',
  'mascara_w',
  'mascara_h',
  'leitura',
  'plano',
  'segmentacao',
  'auditoria',
  'fidelidade',
  'medicao',
  'zona_logo',
  'arte_w',
  'arte_h',
  'cor',
  'marca',
  'nomeacao',
  'copy',
  'tentativas',
  'motivo_falha',
  'travado_em',
  'nome',
  'tema',
  'licenca',
]);

export async function atualiza(
  env: Env,
  id: number,
  campos: Record<string, unknown>,
  autor = 'sistema',
): Promise<void> {
  const nomes: string[] = [];
  const valores: unknown[] = [];
  for (const [k, v] of Object.entries(campos)) {
    if (!COLUNAS_GRAVAVEIS.has(k)) continue;
    nomes.push(`${k} = ?`);
    valores.push(v && typeof v === 'object' ? JSON.stringify(v) : v);
  }
  if (!nomes.length) return;
  nomes.push(`atualizado_em = datetime('now')`, `atualizado_por = ?`);
  valores.push(autor, id);
  await env.DB.exec(`UPDATE fila SET ${nomes.join(', ')} WHERE id = ?`, valores);
}

export async function registra(
  env: Env,
  itemId: number | null,
  acao: string,
  detalhe: string,
  quem: string,
): Promise<void> {
  try {
    await env.DB.exec('INSERT INTO historico (item_id, acao, detalhe, quem) VALUES (?, ?, ?, ?)', [
      itemId,
      acao,
      detalhe.slice(0, 400),
      quem,
    ]);
  } catch (e) {
    console.log('[historico] não gravou:', (e as Error)?.message);
  }
}

/** Marca falha sem travar a fila: o item para, os outros seguem. */
export async function falha(
  env: Env,
  id: number,
  estagio: string,
  motivo: string,
  autor = 'sistema',
): Promise<void> {
  await atualiza(env, id, { estado: `falhou_${estagio}`, motivo_falha: motivo.slice(0, 400) }, autor);
  await registra(env, id, `falhou_${estagio}`, motivo, autor);
}

// ---------------------------------------------------------------------------
// Imagens
// ---------------------------------------------------------------------------

/** Teto do preview: acima disso a linha estoura o limite de 2 MB do SQLite. */
export const TETO_PREVIEW = 1_400_000;

export async function guardaPreview(
  env: Env,
  itemId: number,
  tipo: string,
  dataUrl: string,
  w: number,
  h: number,
): Promise<void> {
  if (dataUrl.length > TETO_PREVIEW) {
    throw new Error(
      `preview "${tipo}" tem ${dataUrl.length} bytes; teto é ${TETO_PREVIEW}. Reduza a escala no cliente.`,
    );
  }
  await env.DB.exec(
    `INSERT INTO imagens (item_id, tipo, data_url, w, h) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id, tipo) DO UPDATE SET data_url = excluded.data_url,
       w = excluded.w, h = excluded.h, criado_em = datetime('now')`,
    [itemId, tipo, dataUrl, w, h],
  );
}

export async function lePreview(
  env: Env,
  itemId: number,
  tipo: string,
): Promise<{ data_url: string; w: number; h: number } | null> {
  const r = await env.DB.query('SELECT data_url, w, h FROM imagens WHERE item_id = ? AND tipo = ?', [
    itemId,
    tipo,
  ]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { data_url: String(row.data_url), w: Number(row.w), h: Number(row.h) };
}

/** Grava uma fatia do PNG de produção. O cliente envia em ordem. */
export async function guardaFatia(
  env: Env,
  itemId: number,
  tipo: string,
  fatia: number,
  total: number,
  dados: string,
): Promise<void> {
  if (dados.length > TAMANHO_FATIA * 1.5) {
    throw new Error(`fatia ${fatia} tem ${dados.length} bytes; use no máximo ${TAMANHO_FATIA}.`);
  }
  await env.DB.exec(
    `INSERT INTO blobs (item_id, tipo, fatia, total, dados) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id, tipo, fatia) DO UPDATE SET dados = excluded.dados, total = excluded.total`,
    [itemId, tipo, fatia, total, dados],
  );
}

/** Remonta o blob. Devolve `null` se ainda falta fatia — nunca meio arquivo. */
export async function leBlob(env: Env, itemId: number, tipo: string): Promise<string | null> {
  const r = await env.DB.query(
    'SELECT fatia, total, dados FROM blobs WHERE item_id = ? AND tipo = ? ORDER BY fatia',
    [itemId, tipo],
  );
  if (!r.rows.length) return null;
  const total = Number(r.rows[0].total);
  if (r.rows.length !== total) return null;
  return r.rows.map((x) => String(x.dados)).join('');
}

export async function limpaBlob(env: Env, itemId: number, tipo: string): Promise<void> {
  await env.DB.exec('DELETE FROM blobs WHERE item_id = ? AND tipo = ?', [itemId, tipo]);
}

// ---------------------------------------------------------------------------
// Painel do A10
// ---------------------------------------------------------------------------

export interface Contagem {
  estado: string;
  n: number;
}

export async function contagemPorEstado(env: Env): Promise<Contagem[]> {
  const r = await env.DB.query(
    'SELECT estado, COUNT(*) AS n FROM fila GROUP BY estado ORDER BY n DESC',
    [],
  );
  return r.rows.map((x) => ({ estado: String(x.estado), n: Number(x.n) }));
}

/**
 * A métrica que decide o projeto: que fatia das best-sellers fecha na rota
 * determinística. É por isso que `rota_usada` é gravada em toda linha.
 */
export async function metricas(env: Env): Promise<{
  rotas: { rota: string; n: number; nota_media: number | null }[];
  custo_total_usd: number;
  custo_por_estampa_usd: number | null;
  chamadas: number;
  falhas: number;
  nota_media: number | null;
  costura_zero_pct: number | null;
  fidelidade_media: number | null;
}> {
  const [rotas, custo, notas, costura, fid] = await Promise.all([
    env.DB.query(
      `SELECT COALESCE(rota_usada, 'indefinida') AS rota, COUNT(*) AS n, AVG(nota_auditor) AS nota
       FROM fila GROUP BY rota_usada`,
      [],
    ),
    env.DB.query(
      `SELECT COALESCE(SUM(custo_usd), 0) AS total, COUNT(*) AS chamadas,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS falhas
       FROM agente_log`,
      [],
    ),
    env.DB.query('SELECT AVG(nota_auditor) AS m, COUNT(nota_auditor) AS n FROM fila', []),
    env.DB.query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN erro_costura_px = 0 THEN 1 ELSE 0 END), 0) AS zeros
       FROM fila WHERE erro_costura_px IS NOT NULL`,
      [],
    ),
    // A nota do A11 mora dentro de uma coluna JSON; json_extract evita ter de
    // trazer a linha inteira só para calcular a média.
    env.DB.query(
      `SELECT AVG(CAST(json_extract(fidelidade, '$.nota_final') AS REAL)) AS m,
              COUNT(fidelidade) AS n
       FROM fila WHERE fidelidade IS NOT NULL`,
      [],
    ),
  ]);

  const total = Number(custo.rows[0]?.total || 0);
  const comRota = rotas.rows.reduce(
    (s, x) => s + (String(x.rota) === 'indefinida' ? 0 : Number(x.n)),
    0,
  );
  const nCostura = Number(costura.rows[0]?.n || 0);

  return {
    rotas: rotas.rows.map((x) => ({
      rota: String(x.rota),
      n: Number(x.n),
      nota_media: x.nota === null ? null : Number(x.nota),
    })),
    custo_total_usd: total,
    custo_por_estampa_usd: comRota ? total / comRota : null,
    chamadas: Number(custo.rows[0]?.chamadas || 0),
    falhas: Number(custo.rows[0]?.falhas || 0),
    nota_media: Number(notas.rows[0]?.n || 0) ? Number(notas.rows[0]?.m) : null,
    costura_zero_pct: nCostura ? (Number(costura.rows[0]?.zeros || 0) / nCostura) * 100 : null,
    fidelidade_media: Number(fid.rows[0]?.n || 0) ? Number(fid.rows[0]?.m) : null,
  };
}

export async function estadoValido(e: string): Promise<boolean> {
  const { ESTADOS } = await import('./tipos');
  return (ESTADOS as readonly string[]).includes(e);
}

export type { Estado };
