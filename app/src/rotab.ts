// Rota B do Separador — quando o Leitor marca separavel=false (fundo
// contínuo, sem motivo isolável), não há o que recortar. Em vez de recompor
// peças, pedimos ao PIAPP um padrão novo, do zero, já na proporção da máscara.
//
// Duas chamadas de IA em cadeia, nunca uma só — é o padrão trazido do app
// benchmark-mockups (Giovanna/Ravenna), documentado em docs/MAPA-ATIVOS.md:
//   1. visão -> texto   (chamarAgente, reaproveita o cliente do AI Proxy)
//   2. texto -> imagem  (PIAPP, job assíncrono: dispara, guarda job_id, poll)
// A MESMA restrição negativa ("sem case, sem texto, sem logo") é reforçada
// nas duas etapas — é o que evita o modelo generativo "vazar" o produto de
// origem na arte nova. Uma restrição só, num lugar só, não é suficiente na
// prática (lição registrada no benchmark-mockups).

import { chamarAgente, type Env as AiEnv } from './aiproxy';

export interface Env extends AiEnv {
  PIAPP_TOKEN?: string;
  PIAPP_URL?: string;
}

const JSON_ONLY = ' Responda APENAS um objeto JSON válido, sem markdown e sem texto antes ou depois.';

const PROMPT_SYSTEM =
  'Você é engenheiro de prompt para modelos de geração de imagem (Flux, Midjourney, GPT Image, Ideogram). ' +
  'Você recebe a foto de uma capinha de celular. Descreva SOMENTE a arte impressa — o padrão, os motivos, ' +
  'as cores, o estilo. Ignore completamente o celular, a case, os recortes de câmera, botões, bordas, ' +
  'reflexo, sombra e qualquer moldura de mockup. ' +
  'O destino é uma garrafa térmica cilíndrica: a arte vai dar a volta no objeto, então descreva um padrão ' +
  'CONTÍNUO (seamless), sem elemento único centralizado que quebre ao repetir horizontalmente. ' +
  'Ignore também a marca "gocase" e qualquer letra ou nome de exemplo de personalização queimados no ' +
  'preview — não fazem parte da estampa. ' +
  'Escreva em inglês, um único parágrafo rico e específico (60 a 120 palavras, sem markdown, sem aspas), ' +
  'cobrindo: tema/assunto, estilo, composição, elementos-chave, paleta de cor, textura, técnica. ' +
  'CRÍTICO: exclua TODO texto, letra, número, marca, logo, marca d\'água ou assinatura — nunca descreva ' +
  'ou inclua isso no prompt. Nunca mencione celular, case, mockup ou produto. ' +
  'Formato: {"prompt":"..."}' + JSON_ONLY;

export interface PromptResultado {
  ok: boolean;
  prompt?: string;
  erro?: string;
}

/** Etapa 1: olha a arte de origem e devolve o prompt textual para a etapa 2. */
export async function gerarPromptRapport(env: Env, arteUrl: string): Promise<PromptResultado> {
  const r = await chamarAgente(env, PROMPT_SYSTEM, 'Escreva o prompt de geração para esta arte.', arteUrl, 0.4);
  if (!r.ok) return { ok: false, erro: r.erro };
  const prompt = (r.dados as { prompt?: unknown } | undefined)?.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, erro: 'O agente não devolveu um prompt utilizável.' };
  }
  return { ok: true, prompt };
}

/**
 * Reforça, com outras palavras, a MESMA restrição negativa do PROMPT_SYSTEM.
 * Geradores de imagem tendem a "vazar" o produto/hardware de origem mesmo
 * com uma descrição limpa — a correção é redundância deliberada nos dois
 * estágios, não confiar num só.
 */
function reforcoNegativo(): string {
  return '\n\nImportant: seamless decorative pattern only, as a flat full-bleed print with no visible seam ' +
    'when tiled horizontally. Absolutely no text, letters, words, numbers, logos, brand names, watermarks ' +
    'or signatures anywhere in the image. No phone or phone-case elements: no camera cutout, no button or ' +
    'port cutouts, no device shape, no mockup framing, no hands, no background beyond the pattern itself.';
}

function mdc(a: number, b: number): number {
  a = Math.round(Math.abs(a)); b = Math.round(Math.abs(b));
  return b === 0 ? (a || 1) : mdc(b, a % b);
}

/** Reduz w×h para uma razão "L:A" simples, no formato que o PIAPP espera. */
export function proporcaoDe(w: number, h: number): string {
  const d = mdc(w, h);
  return `${Math.round(w / d)}:${Math.round(h / d)}`;
}

export interface DisparoResultado {
  ok: boolean;
  jobId?: string;
  erro?: string;
}

/** Etapa 2, parte 1: dispara o job de geração e devolve o job_id — nunca espera o resultado aqui. */
export async function dispararGeracao(env: Env, prompt: string, aspectRatio: string): Promise<DisparoResultado> {
  if (!env.PIAPP_TOKEN) {
    return { ok: false, erro: 'Falta o PIAPP_TOKEN. Configure com setAppSecret e rode de novo.' };
  }
  const base = (env.PIAPP_URL || 'https://piapp-v2.vercel.app/api/v1').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/generate-image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.PIAPP_TOKEN}` },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ prompt: prompt + reforcoNegativo(), aspect_ratio: aspectRatio }),
    });
    const bruto = await res.text();
    if (!res.ok) return { ok: false, erro: `PIAPP HTTP ${res.status}: ${bruto.slice(0, 300)}` };
    let corpo: { job_id?: string };
    try { corpo = JSON.parse(bruto); } catch { return { ok: false, erro: 'O PIAPP respondeu algo que não é JSON.' }; }
    if (!corpo.job_id) return { ok: false, erro: 'O PIAPP não devolveu job_id.' };
    return { ok: true, jobId: corpo.job_id };
  } catch (e) {
    return { ok: false, erro: 'Falha ao chamar o PIAPP: ' + ((e as Error)?.message || String(e)) };
  }
}

export interface StatusResultado {
  ok: boolean;
  status?: 'queued' | 'processing' | 'completed' | 'failed';
  outputUrl?: string;
  erro?: string;
}

/** Etapa 2, parte 2: consulta o job — chamado de novo pelo cliente a cada poll, nunca bloqueante. */
export async function consultarJob(env: Env, jobId: string): Promise<StatusResultado> {
  if (!env.PIAPP_TOKEN) return { ok: false, erro: 'Falta o PIAPP_TOKEN.' };
  const base = (env.PIAPP_URL || 'https://piapp-v2.vercel.app/api/v1').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/jobs?ids=${encodeURIComponent(jobId)}`, {
      headers: { authorization: `Bearer ${env.PIAPP_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    const bruto = await res.text();
    if (!res.ok) return { ok: false, erro: `PIAPP HTTP ${res.status}: ${bruto.slice(0, 300)}` };
    let corpo: { jobs?: { status?: string; output_url?: string; error?: string }[] };
    try { corpo = JSON.parse(bruto); } catch { return { ok: false, erro: 'O PIAPP respondeu algo que não é JSON.' }; }
    const job = corpo.jobs && corpo.jobs[0];
    if (!job) return { ok: false, erro: 'Job não encontrado no PIAPP.' };
    return {
      ok: true,
      status: (job.status as StatusResultado['status']) || 'processing',
      outputUrl: job.output_url,
      erro: job.error,
    };
  } catch (e) {
    return { ok: false, erro: 'Falha ao consultar o PIAPP: ' + ((e as Error)?.message || String(e)) };
  }
}
