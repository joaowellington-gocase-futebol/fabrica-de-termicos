/**
 * Cliente único do AI Proxy do Gogroup.
 *
 * NENHUM estágio chama `fetch` no proxy direto. Tudo passa por
 * `chamarAgente()`. É o que permite trocar de modelo, medir custo e comparar
 * prompt sem caçar código espalhado — e o que garante que toda chamada, sem
 * exceção, vire uma linha em `agente_log`.
 *
 * Nomes de variável: a doc original do projeto falava em `AI_PROXY_TOKEN` /
 * `AI_PROXY_URL`, mas os apps que já rodam em produção (buscador-de-estampas,
 * trend-hunter) usam `AI_API_KEY` / `AI_BASE_URL`. Seguimos o que existe, para
 * a mesma credencial servir os dois. Ver docs/ARQUITETURA.md.
 */

import type { Env, SaidaAgente } from './tipos';

/** Modelo padrão. É o que os apps do Gogroup já usam em produção hoje. */
const MODELO_PADRAO = 'gpt-5.6-sol';

/** Teto de 25s por agente: quem cai não derruba a esteira. */
const TIMEOUT_MS = 25_000;

/**
 * Preço por milhão de tokens, em USD, para estimar custo por estampa.
 *
 * É ESTIMATIVA e mora aqui de propósito, num lugar só, porque a tabela muda
 * quando o proxy troca de modelo. `agente_log` guarda os tokens crus, então
 * corrigir a tabela e recalcular o histórico continua possível.
 */
const PRECO_POR_MTOK: Record<string, { entrada: number; saida: number }> = {
  'gpt-5.6-sol': { entrada: 1.25, saida: 10 },
  'gpt-5.5': { entrada: 1.25, saida: 10 },
  default: { entrada: 1.25, saida: 10 },
};

export interface ConteudoTexto {
  type: 'text';
  text: string;
}
export interface ConteudoImagem {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
}
export type Conteudo = ConteudoTexto | ConteudoImagem;

export interface Mensagem {
  role: 'system' | 'user' | 'assistant';
  content: string | Conteudo[];
}

export interface OpcoesAgente<T> {
  /** Temperatura. 0.2 em decisão; 0.7 só em criação de texto (só o A9). */
  temperature?: number;
  maxTokens?: number;
  /** Item da fila a que esta chamada pertence, para o log. */
  itemId?: number | null;
  /**
   * Valida e normaliza a resposta. Devolver `null` reprova a resposta e
   * dispara retry — é aqui que schema quebrado é pego, não no consumidor.
   */
  valida?: (bruto: unknown) => T | null;
  /** Quantas tentativas no total (inclui a primeira). */
  tentativas?: number;
}

export class ErroAgente extends Error {
  constructor(
    public agente: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'ErroAgente';
  }
}

export function proxyConfigurado(env: Env): boolean {
  return Boolean(env.AI_BASE_URL && env.AI_API_KEY);
}

/**
 * O modelo às vezes embrulha o JSON em ``` ou escreve uma frase antes.
 * Pega o maior bloco entre chaves em vez de exigir resposta limpa — mesma
 * lógica já validada no trend-hunter.
 */
export function parseJsonLoose(texto: string): unknown | null {
  if (!texto) return null;
  const cercado = texto.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidatos = [cercado?.[1], texto.match(/\{[\s\S]*\}/)?.[0], texto];
  for (const c of candidatos) {
    if (!c) continue;
    try {
      return JSON.parse(c.trim());
    } catch {
      /* tenta o próximo */
    }
  }
  return null;
}

function preco(modelo: string, entrada: number, saida: number): number {
  const p = PRECO_POR_MTOK[modelo] || PRECO_POR_MTOK.default;
  return (entrada / 1e6) * p.entrada + (saida / 1e6) * p.saida;
}

/**
 * Grava a linha do log. Falha de log NUNCA derruba a chamada do agente: se a
 * tabela ainda não existe ou o DB está indisponível, o trabalho já foi feito e
 * perder a métrica é melhor que perder a estampa.
 */
async function logar(
  env: Env,
  linha: {
    itemId: number | null;
    agente: string;
    modelo: string;
    tokensEntrada: number;
    tokensSaida: number;
    latenciaMs: number;
    ok: boolean;
    erro: string | null;
  },
): Promise<void> {
  try {
    await env.DB.exec(
      `INSERT INTO agente_log
         (item_id, agente, modelo, tokens_entrada, tokens_saida, latencia_ms, custo_usd, ok, erro)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        linha.itemId,
        linha.agente,
        linha.modelo,
        linha.tokensEntrada,
        linha.tokensSaida,
        linha.latenciaMs,
        preco(linha.modelo, linha.tokensEntrada, linha.tokensSaida),
        linha.ok ? 1 : 0,
        linha.erro ? linha.erro.slice(0, 400) : null,
      ],
    );
  } catch (e) {
    console.log('[agente_log] não gravou:', (e as Error)?.message);
  }
}

interface RespostaProxy {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Uma requisição ao proxy.
 *
 * O nome do campo de limite de tokens divergiu entre gerações da API OpenAI
 * (`max_tokens` virou `max_completion_tokens` nos modelos de raciocínio) e não
 * dá para saber qual este proxy aceita sem chamar. Tenta o nome novo e, se o
 * servidor reclamar especificamente do parâmetro, repete com o antigo — em vez
 * de o agente inteiro morrer por causa de um nome de campo.
 */
async function requisitar(
  env: Env,
  modelo: string,
  mensagens: Mensagem[],
  temperature: number,
  maxTokens: number,
  sinal: AbortSignal,
): Promise<RespostaProxy> {
  const corpo = (campoToken: string) =>
    JSON.stringify({
      model: modelo,
      [campoToken]: maxTokens,
      temperature,
      response_format: { type: 'json_object' },
      messages: mensagens,
    });

  const enviar = (campoToken: string) =>
    fetch(`${env.AI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: corpo(campoToken),
      signal: sinal,
    });

  let res = await enviar('max_completion_tokens');

  if (res.status === 400) {
    const detalhe = await res.text();
    if (/max_completion_tokens|unsupported|unknown|unrecognized/i.test(detalhe)) {
      res = await enviar('max_tokens');
    } else {
      throw new ErroAgente('', `AI Proxy 400: ${detalhe.slice(0, 300)}`, 400);
    }
  }

  if (!res.ok) {
    throw new ErroAgente('', `AI Proxy ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  }
  return (await res.json()) as RespostaProxy;
}

/**
 * Chama um agente e devolve JSON já validado.
 *
 * Erros de rede/5xx e schema reprovado disparam retry. Erro 4xx que não seja de
 * parâmetro não: repetir uma requisição malformada só queima cota.
 */
export async function chamarAgente<T extends SaidaAgente>(
  env: Env,
  agente: string,
  mensagens: Mensagem[],
  opts: OpcoesAgente<T> = {},
): Promise<T> {
  if (!proxyConfigurado(env)) {
    throw new ErroAgente(agente, 'AI Proxy não configurado: falta AI_BASE_URL e/ou AI_API_KEY.');
  }

  const modelo = env.AI_MODEL || MODELO_PADRAO;
  const temperature = opts.temperature ?? 0.2;
  const maxTokens = opts.maxTokens ?? 4000;
  const total = Math.max(1, opts.tentativas ?? 2);
  const itemId = opts.itemId ?? null;

  let ultimoErro: Error | null = null;

  for (let tentativa = 1; tentativa <= total; tentativa++) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const relogio = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      const data = await requisitar(env, modelo, mensagens, temperature, maxTokens, ctrl.signal);
      clearTimeout(relogio);

      const entrada = Number(data.usage?.prompt_tokens || 0);
      const saida = Number(data.usage?.completion_tokens || 0);
      const texto = String(data.choices?.[0]?.message?.content || '').trim();
      const bruto = parseJsonLoose(texto);

      if (bruto === null) {
        throw new ErroAgente(agente, `resposta não é JSON (${texto.slice(0, 120)})`);
      }

      const validado = opts.valida ? opts.valida(bruto) : (bruto as T);
      if (validado === null) {
        throw new ErroAgente(agente, `JSON fora do schema: ${JSON.stringify(bruto).slice(0, 200)}`);
      }

      await logar(env, {
        itemId,
        agente,
        modelo,
        tokensEntrada: entrada,
        tokensSaida: saida,
        latenciaMs: Date.now() - t0,
        ok: true,
        erro: null,
      });
      return validado;
    } catch (e) {
      clearTimeout(relogio);
      const erro = e as Error;
      const abortado = erro?.name === 'AbortError';
      ultimoErro = abortado ? new ErroAgente(agente, `timeout de ${TIMEOUT_MS}ms`) : erro;

      await logar(env, {
        itemId,
        agente,
        modelo,
        tokensEntrada: 0,
        tokensSaida: 0,
        latenciaMs: Date.now() - t0,
        ok: false,
        erro: ultimoErro.message,
      });

      const status = (erro as ErroAgente)?.status;
      const naoValeRepetir = typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
      if (naoValeRepetir || tentativa === total) break;
    }
  }

  throw new ErroAgente(agente, ultimoErro?.message || 'falhou sem mensagem');
}

// ---------------------------------------------------------------------------
// Ajudantes de validação — usados pelos schemas de cada agente
// ---------------------------------------------------------------------------

export function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function str(v: unknown, padrao = ''): string {
  return typeof v === 'string' ? v : padrao;
}

export function num(v: unknown, padrao = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : padrao;
}

export function bool(v: unknown, padrao = false): boolean {
  return typeof v === 'boolean' ? v : padrao;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Confiança sempre entre 0 e 1; ausente vira 0, não 1 — o padrão é desconfiar. */
export function conf(v: unknown): number {
  return Math.min(1, Math.max(0, num(v, 0)));
}

export function umDe<T extends string>(v: unknown, opcoes: readonly T[], padrao: T): T {
  return (opcoes as readonly string[]).includes(str(v)) ? (str(v) as T) : padrao;
}

/** Lista de strings limpa, sem vazios e com teto — protege o prompt seguinte. */
export function listaStr(v: unknown, teto = 30): string[] {
  return arr(v)
    .map((x) => str(x).trim())
    .filter(Boolean)
    .slice(0, teto);
}
