// T1 · cliente único do AI Proxy. Nenhum estágio chama fetch no proxy direto —
// é o que permite trocar de modelo, medir custo e comparar prompt sem caçar código.
import type { AgenteLog, Env } from './tipos.js';

export interface ParteConteudo {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface MensagemChat {
  role: 'system' | 'user' | 'assistant';
  content: string | ParteConteudo[];
}

export interface OpcoesAgente<T> {
  /** nome curto do agente para o log, ex.: 'A2', 'A5'. */
  agente: string;
  mensagens: MensagemChat[];
  /** decisão = 0.2 (padrão), criação de texto (A9) = 0.7. */
  temperatura?: number;
  timeoutMs?: number;
  tentativasMax?: number;
  modelo?: string;
  /** valida o JSON já parseado; devolva string[] com os problemas, ou [] se ok. */
  validar?: (json: unknown) => string[];
  itemFilaId?: number | null;
}

export interface ResultadoAgente<T> {
  sucesso: boolean;
  dados: T | null;
  confianca: number | null;
  erro: string | null;
  tokensEntrada: number;
  tokensSaida: number;
  latenciaMs: number;
  custoUsd: number;
}

const TIMEOUT_PADRAO_MS = 25_000;
const TENTATIVAS_PADRAO = 2;
const MODELO_PADRAO = 'gpt-5.5';
const URL_PADRAO = 'https://ai-proxy.gogroupbr.com/v1/chat/completions';

// Preço por 1k tokens em USD. gpt-5.5 ainda não tem tabela pública confirmada aqui —
// mantém em 0 (custo não estimado) até alguém preencher via secret, em vez de
// inventar um número que poluiria a métrica de custo por estampa.
function precoPorMilToken(env: Env): { entrada: number; saida: number } {
  const entrada = Number((env as unknown as Record<string, unknown>).AI_MODEL_PRECO_ENTRADA_USD_1K ?? 0);
  const saida = Number((env as unknown as Record<string, unknown>).AI_MODEL_PRECO_SAIDA_USD_1K ?? 0);
  return { entrada: Number.isFinite(entrada) ? entrada : 0, saida: Number.isFinite(saida) ? saida : 0 };
}

let schemaLogPronto = false;
async function garanteSchemaLog(env: Env): Promise<void> {
  if (schemaLogPronto) return;
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS agente_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       agente TEXT NOT NULL,
       modelo TEXT NOT NULL,
       tokens_entrada INTEGER NOT NULL DEFAULT 0,
       tokens_saida INTEGER NOT NULL DEFAULT 0,
       latencia_ms INTEGER NOT NULL DEFAULT 0,
       custo_usd REAL NOT NULL DEFAULT 0,
       confianca REAL,
       sucesso INTEGER NOT NULL,
       erro TEXT,
       item_fila_id INTEGER,
       criado_em TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    [],
  );
  schemaLogPronto = true;
}

async function registrarLog(env: Env, log: AgenteLog): Promise<void> {
  await garanteSchemaLog(env);
  await env.DB.exec(
    `INSERT INTO agente_log
       (agente, modelo, tokens_entrada, tokens_saida, latencia_ms, custo_usd, confianca, sucesso, erro, item_fila_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      log.agente,
      log.modelo,
      log.tokens_entrada,
      log.tokens_saida,
      log.latencia_ms,
      log.custo_usd,
      log.confianca,
      log.sucesso ? 1 : 0,
      log.erro,
      log.item_fila_id,
    ],
  );
}

function extrairJson(texto: string): unknown {
  // response_format json_object devolve JSON puro; ainda assim alguns modelos
  // envolvem em ```json ... ``` — tolera os dois formatos.
  const limpo = texto.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(limpo);
}

async function chamarComTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controlador.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Único ponto de entrada pro AI Proxy. Falha suave: nunca lança — devolve
 * sucesso:false e quem chamou decide marcar falhou_<agente> e seguir a fila.
 */
export async function chamarAgente<T = Record<string, unknown>>(
  env: Env,
  opts: OpcoesAgente<T>,
): Promise<ResultadoAgente<T>> {
  const url = env.AI_PROXY_URL || URL_PADRAO;
  const modelo = opts.modelo || env.AI_MODEL || MODELO_PADRAO;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_PADRAO_MS;
  const tentativasMax = opts.tentativasMax ?? TENTATIVAS_PADRAO;
  const inicio = Date.now();

  if (!env.AI_PROXY_TOKEN) {
    const r = falha(opts, 'AI_PROXY_TOKEN não configurado (setAppSecret no GoDeploy)', modelo, Date.now() - inicio);
    await registrarLog(env, logDe(opts, modelo, r));
    return r;
  }

  let ultimoErro = '';
  for (let tentativa = 0; tentativa <= tentativasMax; tentativa++) {
    try {
      const resp = await chamarComTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.AI_PROXY_TOKEN}`,
          },
          body: JSON.stringify({
            model: modelo,
            temperature: opts.temperatura ?? 0.2,
            response_format: { type: 'json_object' },
            messages: opts.mensagens,
          }),
        },
        timeoutMs,
      );

      if (!resp.ok) {
        ultimoErro = `AI Proxy respondeu ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
        if (resp.status >= 500 && tentativa < tentativasMax) continue; // transitório, tenta de novo
        break; // 4xx não é transitório — não adianta repetir
      }

      const corpo = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const conteudo = corpo.choices?.[0]?.message?.content ?? '';
      const latenciaMs = Date.now() - inicio;
      const tokensEntrada = corpo.usage?.prompt_tokens ?? 0;
      const tokensSaida = corpo.usage?.completion_tokens ?? 0;
      const preco = precoPorMilToken(env);
      const custoUsd = (tokensEntrada / 1000) * preco.entrada + (tokensSaida / 1000) * preco.saida;

      let json: unknown;
      try {
        json = extrairJson(conteudo);
      } catch (e) {
        const r: ResultadoAgente<T> = {
          sucesso: false,
          dados: null,
          confianca: null,
          erro: `resposta não é JSON válido: ${(e as Error).message}`,
          tokensEntrada,
          tokensSaida,
          latenciaMs,
          custoUsd,
        };
        await registrarLog(env, logDeResultado(opts, modelo, r));
        return r;
      }

      const problemas = opts.validar ? opts.validar(json) : [];
      if (problemas.length > 0) {
        const r: ResultadoAgente<T> = {
          sucesso: false,
          dados: null,
          confianca: extrairConfianca(json),
          erro: `schema inválido: ${problemas.join('; ')}`,
          tokensEntrada,
          tokensSaida,
          latenciaMs,
          custoUsd,
        };
        await registrarLog(env, logDeResultado(opts, modelo, r));
        return r;
      }

      const r: ResultadoAgente<T> = {
        sucesso: true,
        dados: json as T,
        confianca: extrairConfianca(json),
        erro: null,
        tokensEntrada,
        tokensSaida,
        latenciaMs,
        custoUsd,
      };
      await registrarLog(env, logDeResultado(opts, modelo, r));
      return r;
    } catch (e) {
      ultimoErro = (e as Error)?.name === 'AbortError' ? `timeout após ${timeoutMs}ms` : (e as Error)?.message || String(e);
      if (tentativa >= tentativasMax) break;
    }
  }

  const r = falha(opts, ultimoErro || 'falha desconhecida', modelo, Date.now() - inicio);
  await registrarLog(env, logDeResultado(opts, modelo, r));
  return r;
}

function extrairConfianca(json: unknown): number | null {
  if (json && typeof json === 'object' && 'confianca' in (json as Record<string, unknown>)) {
    const v = Number((json as Record<string, unknown>).confianca);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

function falha<T>(_opts: OpcoesAgente<T>, erro: string, _modelo: string, latenciaMs: number): ResultadoAgente<T> {
  return { sucesso: false, dados: null, confianca: null, erro, tokensEntrada: 0, tokensSaida: 0, latenciaMs, custoUsd: 0 };
}

function logDe<T>(opts: OpcoesAgente<T>, modelo: string, r: ResultadoAgente<T>): AgenteLog {
  return logDeResultado(opts, modelo, r);
}

function logDeResultado<T>(opts: OpcoesAgente<T>, modelo: string, r: ResultadoAgente<T>): AgenteLog {
  return {
    agente: opts.agente,
    modelo,
    tokens_entrada: r.tokensEntrada,
    tokens_saida: r.tokensSaida,
    latencia_ms: r.latenciaMs,
    custo_usd: r.custoUsd,
    confianca: r.confianca,
    sucesso: r.sucesso,
    erro: r.erro,
    item_fila_id: opts.itemFilaId ?? null,
  };
}
