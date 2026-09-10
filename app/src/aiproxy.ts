// Cliente único do AI Proxy do Gogroup. Todo agente passa por aqui.
// Um lugar só para auth, timeout, JSON e medição.

export interface Env {
  DB: {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    exec(sql: string, params?: unknown[]): Promise<{ rowsWritten: number }>;
  };
  AI_PROXY_TOKEN?: string;
  AI_PROXY_URL?: string;
  AI_MODEL?: string;
}

export interface Resultado {
  ok: boolean;
  dados?: unknown;
  erro?: string;
  ms: number;
  modelo: string;
  tokens?: number;
}

/**
 * Chama o AI Proxy e devolve JSON já parseado.
 * `imagem` opcional: URL pública que o modelo enxerga (agentes de visão).
 */
export async function chamarAgente(
  env: Env,
  system: string,
  user: string,
  imagem?: string,
  temperatura = 0.2,
): Promise<Resultado> {
  const inicio = Date.now();
  const modelo = env.AI_MODEL || 'gpt-5.5';

  if (!env.AI_PROXY_TOKEN) {
    return {
      ok: false, ms: 0, modelo,
      erro: 'Falta o AI_PROXY_TOKEN. Configure com setAppSecret e rode de novo.',
    };
  }

  const conteudo: unknown[] = [{ type: 'text', text: user }];
  if (imagem) conteudo.push({ type: 'image_url', image_url: { url: imagem } });

  try {
    const res = await fetch(env.AI_PROXY_URL || 'https://ai-proxy.gogroupbr.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.AI_PROXY_TOKEN}`,
      },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: modelo,
        temperature: temperatura,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: conteudo },
        ],
      }),
    });

    const bruto = await res.text();
    const ms = Date.now() - inicio;

    if (!res.ok) {
      return { ok: false, ms, modelo, erro: `AI Proxy HTTP ${res.status}: ${bruto.slice(0, 300)}` };
    }

    let corpo: {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    try {
      corpo = JSON.parse(bruto);
    } catch {
      return { ok: false, ms, modelo, erro: 'O proxy respondeu algo que não é JSON: ' + bruto.slice(0, 200) };
    }

    const texto = corpo.choices?.[0]?.message?.content || '';
    if (!texto) return { ok: false, ms, modelo, erro: 'O modelo respondeu vazio.' };

    // Alguns modelos embrulham o JSON em ```json ... ```
    const limpo = texto.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    try {
      return { ok: true, ms, modelo, dados: JSON.parse(limpo), tokens: corpo.usage?.total_tokens };
    } catch {
      // Não é JSON válido: devolve o texto para a pessoa ver o que veio e ajustar o prompt.
      return { ok: true, ms, modelo, dados: { resposta_crua: limpo }, tokens: corpo.usage?.total_tokens };
    }
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    const ms = Date.now() - inicio;
    if (/timeout|aborted/i.test(msg)) {
      return { ok: false, ms, modelo, erro: 'O modelo passou de 60s e a chamada foi cortada.' };
    }
    return { ok: false, ms, modelo, erro: 'Falha ao falar com o AI Proxy: ' + msg };
  }
}
