/**
 * Fábrica de Térmicos — worker.
 *
 * Divisão de trabalho entre os dois runtimes, que é o que sustenta o projeto:
 *
 *   WORKER (aqui)   fila, estados, os 10 agentes do AI Proxy, curadoria,
 *                   resolução de arte, agente_log, aprovação. Nunca toca pixel.
 *   BROWSER         separador e rapport (src/web/motor.js), porque o runtime
 *                   não tem Canvas API e o teto de CPU é compartilhado.
 *
 * O browser não é "o cliente": é um executor da esteira. Ele reivindica item em
 * `planejada`, roda a geometria e devolve o resultado medido. Ver
 * docs/ARQUITETURA.md.
 */

import { priorizar } from './agentes/portfolio';
import { revisarSegmentacao } from './agentes/segmentacao';
import { acoesExecutaveis, supervisionar } from './agentes/supervisor';
import { proxyConfigurado } from './core/aiproxy';
import {
  atualiza,
  contagemPorEstado,
  garanteSchema,
  guardaFatia,
  guardaPreview,
  itemPorId,
  leBlob,
  lePreview,
  limpaBlob,
  metricas,
  paraItem,
  registra,
} from './core/db';
import { MASCARA_PADRAO, MASCARAS, curar, hostLiberado } from './core/dados';
import { avancaItem, reprocessa, tick } from './core/fila';
import type { Env, ItemFila } from './core/tipos';
import { ESTADOS } from './core/tipos';

function json(d: unknown, s = 200): Response {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Valor devolvido por `quem()` quando nao ha usuario autenticado. */
const ANONIMO = 'anonimo';

function quem(request: Request): string {
  return request.headers.get('x-godeploy-user-email') || ANONIMO;
}

function cookieDe(request: Request): string {
  return request.headers.get('Cookie') || '';
}

/** Autoriza a rota de cron. */
function cronAutorizado(request: Request): boolean {
  // `x-godeploy-cron` e uma ASSINATURA derivada da chave, nao a chave em texto,
  // e a plataforma injeta `GODEPLOY_CRON_KEY` sozinha. Comparar o header com a
  // chave rejeita o proprio cron do gateway — foi o 403 das primeiras versoes.
  //
  // O que da para verificar aqui e a PRESENCA do header: o gateway remove
  // qualquer `x-godeploy-*` que venha de fora antes de despachar, entao quem
  // chega com esse header e o gateway. A porta de entrada continua sendo a
  // visibilidade `authenticated` do app, que barra qualquer um de fora.
  if (request.headers.get('x-godeploy-cron')) return true;
  // Chamada manual de alguem logado tambem vale: e assim que se depura a fila.
  return quem(request) !== ANONIMO;
}

async function corpo(request: Request): Promise<Record<string, unknown>> {
  try {
    return ((await request.json()) as Record<string, unknown>) || {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------

/** Enche a fila. Precisa de cookie: a curadoria bate no proxy de dados. */
async function rotaCurar(request: Request, env: Env): Promise<Response> {
  const b = await corpo(request);
  const janela = Math.min(365, Math.max(7, Number(b.janela_dias) || 90));
  const limite = Math.min(60, Math.max(1, Number(b.limite) || 20));
  const autor = quem(request);

  const r = await curar(env, cookieDe(request), janela, limite);

  let inseridas = 0;
  for (const c of r.candidatas) {
    // Uma linha por statement: o env.DB tem teto de parâmetros ligados e
    // INSERT em lote grande quebra só em runtime.
    const res = await env.DB.exec(
      `INSERT INTO fila (estampa_key, nome, tema, licenca, unidades, receita, estado,
                         mascara_w, mascara_h, atualizado_por)
       VALUES (?, ?, ?, ?, ?, ?, 'candidata', ?, ?, ?)
       ON CONFLICT(estampa_key) DO NOTHING`,
      [
        c.estampa_key,
        c.nome,
        c.tema,
        c.licenca,
        c.unidades,
        c.receita,
        MASCARA_PADRAO.w,
        MASCARA_PADRAO.h,
        autor,
      ],
    );
    inseridas += res.rowsWritten;
  }

  await registra(env, null, 'curar', `${inseridas} novas de ${r.candidatas.length} candidatas`, autor);

  return json({
    ok: true,
    inseridas,
    candidatas: r.candidatas,
    descartadas: r.descartadas,
    modo_agregacao: r.modo,
    total_analisadas: r.total_analisadas,
  });
}

/** A1: ordena as candidatas que já estão na fila. */
async function rotaPriorizar(request: Request, env: Env): Promise<Response> {
  const r = await env.DB.query(
    `SELECT estampa_key, nome, tema, licenca, unidades, receita
     FROM fila WHERE estado = 'candidata' ORDER BY receita DESC LIMIT 50`,
    [],
  );
  if (!r.rows.length) return json({ error: 'Nenhuma candidata na fila para priorizar.' }, 400);

  const candidatas = r.rows.map((x) => ({
    estampa_key: String(x.estampa_key),
    nome: String(x.nome),
    tema: (x.tema as string) ?? null,
    licenca: (x.licenca as string) ?? null,
    unidades: Number(x.unidades),
    receita: Number(x.receita),
    score: Number(x.unidades),
  }));

  const ranking = await priorizar(env, candidatas);
  await registra(env, null, 'priorizar', `${ranking.ranking.length} ordenadas pelo A1`, quem(request));
  return json({ ok: true, ...ranking });
}

/**
 * O runner do browser reivindica um item parado no motor.
 *
 * `travado_em` evita que duas abas abertas peguem o mesmo item e paguem duas
 * vezes a mesma geometria.
 */
async function rotaReivindicar(request: Request, env: Env): Promise<Response> {
  const autor = quem(request);
  const r = await env.DB.query(
    `SELECT * FROM fila WHERE estado = 'planejada'
       AND (travado_em IS NULL OR travado_em < datetime('now', '-10 minutes'))
     ORDER BY receita DESC, id ASC LIMIT 1`,
    [],
  );
  if (!r.rows.length) return json({ item: null });

  const item = paraItem(r.rows[0]);
  const ok = await env.DB.exec(
    `UPDATE fila SET travado_em = datetime('now'), atualizado_por = ?
     WHERE id = ? AND estado = 'planejada'
       AND (travado_em IS NULL OR travado_em < datetime('now', '-10 minutes'))`,
    [autor, item.id],
  );
  if (!ok.rowsWritten) return json({ item: null });

  return json({ item });
}

/** O A4 é chamado pelo worker, mas com a imagem que o browser acabou de gerar. */
async function rotaSegmentacao(request: Request, env: Env): Promise<Response> {
  const b = await corpo(request);
  const dataUrl = String(b.contact_sheet || '');
  const bboxes = Array.isArray(b.bboxes) ? (b.bboxes as Record<string, number>[]) : [];
  const itemId = Number(b.item_id) || null;
  if (!dataUrl.startsWith('data:') || !bboxes.length) {
    return json({ error: 'Envie contact_sheet (data URL) e bboxes.' }, 400);
  }

  const revisao = await revisarSegmentacao(
    env,
    dataUrl,
    bboxes.map((x) => ({
      id: Number(x.id),
      ox: Number(x.ox),
      oy: Number(x.oy),
      ow: Number(x.ow),
      oh: Number(x.oh),
    })),
    itemId,
  );
  return json({ ok: true, revisao });
}

/** O runner entrega o resultado da geometria: previews + costura medida. */
async function rotaEntregar(request: Request, env: Env): Promise<Response> {
  const b = await corpo(request);
  const id = Number(b.item_id) || 0;
  const item = id ? await itemPorId(env, id) : null;
  if (!item) return json({ error: 'Item não encontrado.' }, 404);

  const autor = quem(request);
  const erroStr = String(b.erro || '');
  if (erroStr) {
    await atualiza(
      env,
      id,
      { estado: 'falhou_motor', motivo_falha: erroStr.slice(0, 400), travado_em: null },
      autor,
    );
    await registra(env, id, 'falhou_motor', erroStr, autor);
    return json({ ok: true, estado: 'falhou_motor' });
  }

  const previews = (b.previews || {}) as Record<string, { data_url: string; w: number; h: number }>;
  if (!previews.composicao?.data_url || !previews.ladrilho3x1?.data_url) {
    return json({ error: 'Faltou o preview da composição ou do ladrilho 3x1.' }, 400);
  }

  try {
    for (const [tipo, p] of Object.entries(previews)) {
      if (!p?.data_url) continue;
      await guardaPreview(env, id, tipo, p.data_url, Number(p.w) || 0, Number(p.h) || 0);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }

  const costura = (b.costura || {}) as Record<string, unknown>;
  const erroPx = Math.max(0, Number(costura.erro_costura_px) || 0);

  await atualiza(
    env,
    id,
    {
      estado: 'composta',
      erro_costura_px: erroPx,
      segmentacao: b.segmentacao ?? item.segmentacao,
      travado_em: null,
    },
    autor,
  );
  await registra(
    env,
    id,
    'composta',
    `costura ${erroPx}px · ${JSON.stringify(b.diagnostico || {}).slice(0, 240)}`,
    autor,
  );

  return json({ ok: true, estado: 'composta', erro_costura_px: erroPx });
}

/** PNG de produção, enviado em fatias porque não cabe em 2 MB por linha. */
async function rotaBlob(request: Request, env: Env): Promise<Response> {
  const b = await corpo(request);
  const id = Number(b.item_id) || 0;
  const tipo = String(b.tipo || 'producao');
  const fatia = Number(b.fatia);
  const total = Number(b.total);
  const dados = String(b.dados || '');
  if (!id || !dados || !Number.isInteger(fatia) || !Number.isInteger(total) || total < 1) {
    return json({ error: 'Envie item_id, tipo, fatia, total e dados.' }, 400);
  }
  if (fatia === 0) await limpaBlob(env, id, tipo);
  try {
    await guardaFatia(env, id, tipo, fatia, total, dados);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  return json({ ok: true, fatia, total });
}

async function rotaAprovar(request: Request, env: Env, id: number): Promise<Response> {
  const item = await itemPorId(env, id);
  if (!item) return json({ error: 'Item não encontrado.' }, 404);
  const autor = quem(request);

  if (item.marca?.bloqueia) {
    return json(
      { error: 'Este item está bloqueado pelo A7 (marca). Destrave a revisão de marca antes de aprovar.' },
      409,
    );
  }

  await atualiza(env, id, { estado: 'aprovada' }, autor);
  await registra(env, id, 'aprovada', item.engine_identifier || item.estampa_key, autor);
  return json({ ok: true, estado: 'aprovada' });
}

async function rotaAjustar(request: Request, env: Env, id: number): Promise<Response> {
  const b = await corpo(request);
  const item = await itemPorId(env, id);
  if (!item) return json({ error: 'Item não encontrado.' }, 404);
  const autor = quem(request);

  const estilo = String(b.estilo || '');
  const escala = Number(b.escala);
  const ajuste = {
    ...(estilo ? { estilo } : {}),
    ...(Number.isFinite(escala) ? { escala } : {}),
  };

  // Volta a `lida` para o A3 replanejar. O contador de tentativas é ZERADO:
  // um ajuste pedido por pessoa não é uma reprova automática, e sem isso o
  // item cairia direto na fila humana de novo na próxima auditoria.
  await atualiza(
    env,
    id,
    {
      estado: 'lida',
      tentativas: 0,
      auditoria: item.auditoria
        ? { ...item.auditoria, ajuste_sugerido: Object.keys(ajuste).length ? ajuste : null }
        : null,
      motivo_falha: null,
    },
    autor,
  );
  await registra(env, id, 'ajustar', JSON.stringify(ajuste), autor);
  return json({ ok: true, estado: 'lida' });
}

async function rotaReprovar(request: Request, env: Env, id: number): Promise<Response> {
  const b = await corpo(request);
  const autor = quem(request);
  const motivo = String(b.motivo || 'reprovado por revisão humana').slice(0, 400);
  const item = await itemPorId(env, id);
  if (!item) return json({ error: 'Item não encontrado.' }, 404);
  await atualiza(env, id, { estado: 'reprovada', motivo_falha: motivo }, autor);
  await registra(env, id, 'reprovada', motivo, autor);
  return json({ ok: true, estado: 'reprovada' });
}

/** A10. Sugere ações; o código filtra o que pode ser executado sozinho. */
async function rotaSupervisor(request: Request, env: Env): Promise<Response> {
  const autor = quem(request);
  const [contagens, falhas, log, m] = await Promise.all([
    contagemPorEstado(env),
    env.DB.query(
      `SELECT id, estampa_key, estado, motivo_falha, tentativas FROM fila
       WHERE estado LIKE 'falhou%' OR estado LIKE 'bloqueado%' ORDER BY id DESC LIMIT 25`,
      [],
    ),
    env.DB.query('SELECT agente, ok, erro FROM agente_log ORDER BY id DESC LIMIT 40', []),
    metricas(env),
  ]);

  const listaFalhas = falhas.rows.map((x) => ({
    id: Number(x.id),
    estampa_key: String(x.estampa_key),
    estado: String(x.estado),
    motivo_falha: (x.motivo_falha as string) ?? null,
    tentativas: Number(x.tentativas || 0),
  }));

  const sup = await supervisionar(env, {
    contagens,
    falhas: listaFalhas,
    logRecente: log.rows.map((x) => ({
      agente: String(x.agente),
      ok: Number(x.ok),
      erro: (x.erro as string) ?? null,
    })),
    metricas: { rotas: m.rotas, custo_total_usd: m.custo_total_usd, nota_media: m.nota_media },
  });

  const tentativasPorItem = new Map(listaFalhas.map((f) => [f.id, f.tentativas]));
  const { executar, recomendacoes } = acoesExecutaveis(sup.acoes, tentativasPorItem);

  const feitas: { item_id: number; acao: string; ok: boolean }[] = [];
  for (const a of executar) {
    if (a.acao === 'reprocessar') {
      feitas.push({ item_id: a.item_id, acao: 'reprocessar', ok: await reprocessa(env, a.item_id, 'A10') });
    } else if (a.acao === 'escalar') {
      await atualiza(env, a.item_id, { estado: 'aguardando_aprovacao', motivo_falha: a.motivo }, 'A10');
      await registra(env, a.item_id, 'escalado_pelo_a10', a.motivo, autor);
      feitas.push({ item_id: a.item_id, acao: 'escalar', ok: true });
    }
  }

  return json({ ok: true, supervisao: sup, executadas: feitas, recomendacoes });
}

async function rotaEstado(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const filtro = url.searchParams.get('estado') || '';
  const autor = quem(request);

  const where = filtro && (ESTADOS as readonly string[]).includes(filtro) ? 'WHERE estado = ?' : '';
  const params = where ? [filtro] : [];

  const [fila, contagens, m, hist] = await Promise.all([
    env.DB.query(
      `SELECT id, estampa_key, nome, tema, licenca, unidades, receita, estado, rota_usada,
              nota_auditor, erro_costura_px, engine_identifier, tentativas, motivo_falha,
              atualizado_em, atualizado_por
       FROM fila ${where} ORDER BY receita DESC, id ASC LIMIT 200`,
      params,
    ),
    contagemPorEstado(env),
    metricas(env),
    env.DB.query('SELECT * FROM historico ORDER BY id DESC LIMIT 20', []),
  ]);

  return json({
    usuario: autor,
    fila: fila.rows,
    contagens,
    metricas: m,
    historico: hist.rows,
    mascara: MASCARA_PADRAO,
    mascaras: MASCARAS,
    proxy_ia: proxyConfigurado(env),
  });
}

async function rotaItem(env: Env, id: number): Promise<Response> {
  const item = await itemPorId(env, id);
  if (!item) return json({ error: 'Item não encontrado.' }, 404);

  const [comp, tile, recortes, log] = await Promise.all([
    lePreview(env, id, 'composicao'),
    lePreview(env, id, 'ladrilho3x1'),
    lePreview(env, id, 'recortes'),
    env.DB.query(
      `SELECT agente, modelo, tokens_entrada, tokens_saida, latencia_ms, custo_usd, ok, erro, quando
       FROM agente_log WHERE item_id = ? ORDER BY id DESC LIMIT 40`,
      [id],
    ),
  ]);

  return json({
    item,
    previews: { composicao: comp, ladrilho3x1: tile, recortes },
    log: log.rows,
    custo_item_usd: log.rows.reduce((s, x) => s + Number(x.custo_usd || 0), 0),
  });
}

async function rotaHealth(env: Env): Promise<Response> {
  const contagens = await contagemPorEstado(env).catch(() => []);
  return json({
    ok: true,
    ai_proxy: proxyConfigurado(env)
      ? { configurado: true, modelo: env.AI_MODEL || 'gpt-5.6-sol (padrão)' }
      : {
          configurado: false,
          falta: [
            env.AI_BASE_URL ? null : 'AI_BASE_URL',
            env.AI_API_KEY ? null : 'AI_API_KEY',
          ].filter((k): k is string => k !== null),
        },
    proxy_dados: Boolean(env.PROXY_BASE_URL),
    cron_assinado: Boolean(env.GODEPLOY_CRON_KEY),
    piapp: Boolean(env.PIAPP_TOKEN),
    removebg: Boolean(env.REMOVEBG_KEY),
    contagens,
    // Restrições conhecidas, ditas em voz alta para não virarem surpresa.
    limites: {
      curadoria_precisa_de_cookie:
        'o proxy de dados autentica pelo cookie do visitante; o cron não tem cookie, ' +
        'então a fila é enchida por ação humana e só depois anda sozinha',
      geometria_no_browser:
        'separador e rapport rodam no browser (sem Canvas API no worker); itens param ' +
        'em "planejada" até um runner reivindicar',
    },
  });
}

// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/') return Response.redirect(url.origin + '/index.html', 302);

    if (!p.startsWith('/api/') && !p.startsWith('/tasks/')) {
      return new Response('Not found', { status: 404 });
    }

    try {
      await garanteSchema(env);
      const metodo = request.method;

      // --- cron da plataforma -------------------------------------------
      if (p === '/tasks/tick' && metodo === 'POST') {
        if (!cronAutorizado(request)) {
          return json({ error: 'Assinatura de cron inválida.' }, 403);
        }
        const r = await tick(env, cookieDe(request), 6);
        console.log(
          '[tick]',
          JSON.stringify({
            ...r,
            headers_do_chamador: [...request.headers.keys()].filter((h) => h.startsWith('x-godeploy')),
          }),
        );
        return json({ ok: true, ...r });
      }

      // Reserve a imagem externa pela nossa origem.
      //
      // Sem isto o canvas do browser fica "tainted" e getImageData lança
      // SecurityError — os hosts de imagem da Gocase não mandam CORS. A lista
      // de hosts liberados é fechada de propósito: uma rota que busca qualquer
      // URL que chegue por querystring é SSRF.
      if (p === '/api/img' && metodo === 'GET') {
        const alvo = url.searchParams.get('u') || '';
        if (!hostLiberado(alvo)) {
          return json({ error: 'Host não liberado para proxy de imagem.' }, 403);
        }
        const up = await fetch(alvo);
        if (!up.ok) return json({ error: `origem devolveu ${up.status}` }, 502);
        return new Response(up.body, {
          status: 200,
          headers: {
            'content-type': up.headers.get('content-type') || 'image/png',
            'cache-control': 'public, max-age=86400',
            'access-control-allow-origin': '*',
          },
        });
      }

      if (p === '/api/health') return await rotaHealth(env);
      if (p === '/api/estado' && metodo === 'GET') return await rotaEstado(request, env);

      if (p === '/api/curar' && metodo === 'POST') return await rotaCurar(request, env);
      if (p === '/api/priorizar' && metodo === 'POST') return await rotaPriorizar(request, env);
      if (p === '/api/supervisor' && metodo === 'POST') return await rotaSupervisor(request, env);

      if (p === '/api/tick' && metodo === 'POST') {
        const r = await tick(env, cookieDe(request), 6);
        return json({ ok: true, ...r });
      }

      if (p === '/api/motor/reivindicar' && metodo === 'POST') return await rotaReivindicar(request, env);
      if (p === '/api/motor/segmentacao' && metodo === 'POST') return await rotaSegmentacao(request, env);
      if (p === '/api/motor/entregar' && metodo === 'POST') return await rotaEntregar(request, env);
      if (p === '/api/blob' && metodo === 'POST') return await rotaBlob(request, env);

      const mItem = /^\/api\/item\/(\d+)$/.exec(p);
      if (mItem && metodo === 'GET') return await rotaItem(env, Number(mItem[1]));

      const mAcao = /^\/api\/item\/(\d+)\/(aprovar|ajustar|reprovar|reprocessar|avancar)$/.exec(p);
      if (mAcao && metodo === 'POST') {
        const id = Number(mAcao[1]);
        switch (mAcao[2]) {
          case 'aprovar':
            return await rotaAprovar(request, env, id);
          case 'ajustar':
            return await rotaAjustar(request, env, id);
          case 'reprovar':
            return await rotaReprovar(request, env, id);
          case 'reprocessar': {
            const ok = await reprocessa(env, id, quem(request));
            return ok ? json({ ok: true }) : json({ error: 'Item não encontrado.' }, 404);
          }
          case 'avancar': {
            const item = await itemPorId(env, id);
            if (!item) return json({ error: 'Item não encontrado.' }, 404);
            const r = await avancaItem(env, item, cookieDe(request));
            return json({ ok: true, resultado: r });
          }
        }
      }

      const mDown = /^\/api\/download\/(\d+)$/.exec(p);
      if (mDown && metodo === 'GET') {
        const dataUrl = await leBlob(env, Number(mDown[1]), 'producao');
        if (!dataUrl) return json({ error: 'PNG de produção ainda não foi gerado.' }, 404);
        return json({ ok: true, data_url: dataUrl });
      }

      const mImg = /^\/api\/imagem\/(\d+)\/([a-z0-9_]+)$/.exec(p);
      if (mImg && metodo === 'GET') {
        const pv = await lePreview(env, Number(mImg[1]), mImg[2]);
        if (!pv) return json({ error: 'Preview não encontrado.' }, 404);
        return json(pv);
      }

      if (p === '/api/log' && metodo === 'GET') {
        const r = await env.DB.query(
          `SELECT id, item_id, agente, modelo, tokens_entrada, tokens_saida, latencia_ms,
                  custo_usd, ok, erro, quando
           FROM agente_log ORDER BY id DESC LIMIT 200`,
          [],
        );
        return json({ log: r.rows });
      }

      return json({ error: 'Rota não encontrada: ' + p }, 404);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      console.log('[erro]', p, msg);
      const status = (e as { status?: number })?.status === 401 ? 401 : 500;
      return json({ error: msg }, status);
    }
  },
};

export type { Env, ItemFila };
