// T1 · máquina de estados da esteira em env.DB + cron. Cada estágio é idempotente e
// reprocessável isoladamente; falha vira falhou_<estagio> sem travar o lote (ver README e
// docs/ORQUESTRACAO.md). T1 só dá o motor genérico — T2 a T6 entram com os manipuladores de
// cada estágio/agente, registrados contra este mesmo `avancarEstagio`.
import type { Env, EstadoFila, EstadoFilaOk, ItemFila } from './tipos.js';
import { ESTADOS_FILA } from './tipos.js';

let schemaPronto = false;

async function garanteSchemaFila(env: Env): Promise<void> {
  if (schemaPronto) return;
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS fila (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       estampa_key TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'candidata',
       rota_usada TEXT,
       nota_auditor REAL,
       tentativas INTEGER NOT NULL DEFAULT 0,
       motivo_falha TEXT,
       payload TEXT NOT NULL DEFAULT '{}',
       criado_em TEXT NOT NULL DEFAULT (datetime('now')),
       atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    [],
  );
  await env.DB.exec('CREATE INDEX IF NOT EXISTS idx_fila_status ON fila(status)', []);
  schemaPronto = true;
}

function linhaParaItem(row: Record<string, unknown>): ItemFila {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(row.payload ?? '{}'));
  } catch {
    payload = {};
  }
  return {
    id: Number(row.id),
    estampa_key: String(row.estampa_key),
    status: String(row.status) as EstadoFila,
    rota_usada: (row.rota_usada as ItemFila['rota_usada']) ?? null,
    nota_auditor: row.nota_auditor === null || row.nota_auditor === undefined ? null : Number(row.nota_auditor),
    tentativas: Number(row.tentativas ?? 0),
    criado_em: String(row.criado_em),
    atualizado_em: String(row.atualizado_em),
    motivo_falha: (row.motivo_falha as string | null) ?? null,
    payload,
  };
}

/** Enfileira uma candidata nova (saída do Curador, estágio 0). Idempotente: não duplica item ativo da mesma estampa. */
export async function enfileirar(
  env: Env,
  estampaKey: string,
  payloadInicial: Record<string, unknown> = {},
): Promise<number> {
  await garanteSchemaFila(env);
  const existente = await env.DB.query(
    `SELECT id FROM fila WHERE estampa_key = ? AND status NOT IN ('cadastrada', 'reprovada')`,
    [estampaKey],
  );
  if (existente.rows.length) return Number(existente.rows[0].id);
  await env.DB.exec(`INSERT INTO fila (estampa_key, status, payload) VALUES (?, 'candidata', ?)`, [
    estampaKey,
    JSON.stringify(payloadInicial),
  ]);
  const r = await env.DB.query('SELECT last_insert_rowid() AS id', []);
  return Number(r.rows[0]?.id || 0);
}

export async function buscarPorStatus(env: Env, status: EstadoFila, limite = 20): Promise<ItemFila[]> {
  await garanteSchemaFila(env);
  const r = await env.DB.query('SELECT * FROM fila WHERE status = ? ORDER BY id LIMIT ?', [status, limite]);
  return r.rows.map(linhaParaItem);
}

export async function buscarItem(env: Env, id: number): Promise<ItemFila | null> {
  await garanteSchemaFila(env);
  const r = await env.DB.query('SELECT * FROM fila WHERE id = ?', [id]);
  return r.rows.length ? linhaParaItem(r.rows[0]) : null;
}

export interface ResultadoEstagio {
  /** próximo estado OK da esteira (ex.: 'lida' depois do estágio do Leitor). */
  proximoStatus: EstadoFilaOk;
  /** mesclado sobre o payload existente — schema solto de propósito (ver ItemFila em tipos.ts). */
  payloadPatch?: Record<string, unknown>;
  rotaUsada?: ItemFila['rota_usada'];
  notaAuditor?: number;
}

/** Um estágio recebe o item e diz pra onde ele vai. Lançar (throw) marca falhou_<nomeEstagio>. */
export type ManipuladorEstagio = (env: Env, item: ItemFila) => Promise<ResultadoEstagio>;

const MAX_TENTATIVAS_ESTAGIO = 3;

/**
 * Roda um manipulador sobre um item e grava o resultado. Falha suave: nunca lança pra fora —
 * até `MAX_TENTATIVAS_ESTAGIO` falhas o item permanece no status atual (o cron tenta de novo
 * no próximo tick); na última, vira `falhou_<nomeEstagio>` com o motivo e sai da fila ativa,
 * sem travar o resto do lote.
 */
export async function processarItem(
  env: Env,
  item: ItemFila,
  nomeEstagio: string,
  manipulador: ManipuladorEstagio,
): Promise<void> {
  await garanteSchemaFila(env);
  try {
    const r = await manipulador(env, item);
    const payload = { ...item.payload, ...(r.payloadPatch ?? {}) };
    await env.DB.exec(
      `UPDATE fila SET status=?, payload=?, rota_usada=COALESCE(?, rota_usada),
         nota_auditor=COALESCE(?, nota_auditor), tentativas=0, motivo_falha=NULL,
         atualizado_em=datetime('now') WHERE id=?`,
      [r.proximoStatus, JSON.stringify(payload), r.rotaUsada ?? null, r.notaAuditor ?? null, item.id],
    );
  } catch (e) {
    const motivo = (e as Error)?.message || String(e);
    const tentativas = item.tentativas + 1;
    const falhouDeVez = tentativas >= MAX_TENTATIVAS_ESTAGIO;
    const status: EstadoFila = falhouDeVez ? `falhou_${nomeEstagio}` : item.status;
    await env.DB.exec(
      `UPDATE fila SET status=?, tentativas=?, motivo_falha=?, atualizado_em=datetime('now') WHERE id=?`,
      [status, tentativas, motivo.slice(0, 500), item.id],
    );
  }
}

/** Reprocessa um item isolado: volta pro status indicado e zera tentativas, sem refazer o lote. */
export async function reprocessar(env: Env, itemId: number, statusDestino: EstadoFilaOk): Promise<void> {
  await garanteSchemaFila(env);
  await env.DB.exec(
    `UPDATE fila SET status=?, tentativas=0, motivo_falha=NULL, atualizado_em=datetime('now') WHERE id=?`,
    [statusDestino, itemId],
  );
}

/**
 * O que o cron chama por estágio: busca itens parados em `statusEntrada` e roda o
 * manipulador em cada um. Cada trilha (T2-T6) registra seu próprio par
 * (status de entrada, manipulador) contra esta função — T1 só dá a máquina.
 */
export async function avancarEstagio(
  env: Env,
  statusEntrada: EstadoFilaOk,
  nomeEstagio: string,
  manipulador: ManipuladorEstagio,
  limitePorTick = 5,
): Promise<number> {
  const itens = await buscarPorStatus(env, statusEntrada, limitePorTick);
  for (const item of itens) {
    await processarItem(env, item, nomeEstagio, manipulador);
  }
  return itens.length;
}

/** Visão rápida do estado do lote, para o painel do A10 (T5) e o resumo diário. */
export async function contarPorStatus(env: Env): Promise<Record<string, number>> {
  await garanteSchemaFila(env);
  const r = await env.DB.query('SELECT status, COUNT(*) AS n FROM fila GROUP BY status', []);
  const out: Record<string, number> = {};
  for (const row of r.rows) out[String(row.status)] = Number(row.n);
  return out;
}

export { ESTADOS_FILA };
