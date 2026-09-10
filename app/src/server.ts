// Fábrica de Térmicos — painel dos 6 agentes.
//
// Uma tela: seis agentes de IA, um por pessoa. Cada um roda de verdade contra o
// AI Proxy do Gogroup e mostra a resposta na hora.
//
// Estado em env.DB: quem é dono de cada agente e o histórico de execuções
// (entrada, saída, tempo, custo em tokens) — para a equipe comparar prompts.

import { AGENTES, acharAgente } from './agentes';
import { chamarAgente, type Env } from './aiproxy';

function json(d: unknown, s = 200): Response {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

let pronto = false;
async function schema(env: Env): Promise<void> {
  if (pronto) return;
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS donos (
       chave TEXT PRIMARY KEY,
       dono TEXT NOT NULL DEFAULT '',
       prompt TEXT NOT NULL DEFAULT ''
     )`, []);
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS execucoes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       agente TEXT NOT NULL,
       entrada TEXT NOT NULL DEFAULT '',
       saida TEXT NOT NULL DEFAULT '',
       ok INTEGER NOT NULL DEFAULT 1,
       ms INTEGER NOT NULL DEFAULT 0,
       tokens INTEGER,
       quem TEXT NOT NULL DEFAULT '',
       quando TEXT NOT NULL DEFAULT (datetime('now'))
     )`, []);
  pronto = true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    const quem = request.headers.get('x-godeploy-user-email') || 'anônimo';

    if (p === '/') return Response.redirect(url.origin + '/index.html', 302);
    if (!p.startsWith('/api/')) return new Response('Not found', { status: 404 });

    try {
      await schema(env);

      // Lista os agentes com dono, prompt salvo e as últimas rodadas.
      if (p === '/api/estado') {
        const [donos, execs] = await Promise.all([
          env.DB.query('SELECT * FROM donos', []),
          env.DB.query(
            'SELECT id, agente, ok, ms, tokens, quem, quando, substr(saida,1,600) AS saida FROM execucoes ORDER BY id DESC LIMIT 15', []),
        ]);
        const mapa = new Map(donos.rows.map((d) => [String(d.chave), d]));
        return json({
          usuario: quem,
          temToken: !!env.AI_PROXY_TOKEN,
          modelo: env.AI_MODEL || 'gpt-5.5',
          agentes: AGENTES.map((a) => {
            const d = mapa.get(a.chave);
            return {
              chave: a.chave, nome: a.nome, oque: a.oque, visao: a.visao,
              temperatura: a.temperatura, exemplo: a.exemplo,
              dono: d ? String(d.dono) : '',
              system: d && String(d.prompt) ? String(d.prompt) : a.system,
              customizado: !!(d && String(d.prompt)),
            };
          }),
          execucoes: execs.rows,
        });
      }

      // Roda um agente de verdade contra o AI Proxy.
      if (p === '/api/rodar' && request.method === 'POST') {
        const b = (await request.json()) as { agente?: string; entrada?: string; system?: string };
        const ag = acharAgente(String(b.agente || ''));
        if (!ag) return json({ error: 'Esse agente não existe.' }, 400);

        const entrada = String(b.entrada || '').trim();
        if (!entrada) return json({ error: 'Escreva a entrada antes de rodar.' }, 400);

        // Prompt vindo da tela vence o do código: é assim que a equipe itera sem deploy.
        let system = String(b.system || '').trim();
        if (!system) {
          const salvo = await env.DB.query('SELECT prompt FROM donos WHERE chave = ?', [ag.chave]);
          system = String(salvo.rows[0]?.prompt || '') || ag.system;
        }

        const imagem = ag.visao ? entrada : undefined;
        const texto = ag.visao ? ag.user(entrada) : ag.user(entrada);

        if (ag.visao && !/^https?:\/\//i.test(entrada)) {
          return json({ error: 'Este agente lê imagem: a entrada precisa ser uma URL http(s).' }, 400);
        }

        const r = await chamarAgente(env, system, texto, imagem, ag.temperatura);

        await env.DB.exec(
          `INSERT INTO execucoes (agente, entrada, saida, ok, ms, tokens, quem)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [ag.chave, entrada.slice(0, 2000),
           JSON.stringify(r.ok ? r.dados : { erro: r.erro }).slice(0, 4000),
           r.ok ? 1 : 0, r.ms, r.tokens ?? null, quem],
        );

        return json(r, r.ok ? 200 : 502);
      }

      // Quem cuida de cada agente.
      if (p === '/api/dono' && request.method === 'POST') {
        const b = (await request.json()) as { agente?: string; dono?: string };
        const ag = acharAgente(String(b.agente || ''));
        if (!ag) return json({ error: 'Esse agente não existe.' }, 400);
        const dono = String(b.dono || '').trim().slice(0, 60);
        await env.DB.exec(
          `INSERT INTO donos (chave, dono) VALUES (?, ?)
           ON CONFLICT(chave) DO UPDATE SET dono = excluded.dono`, [ag.chave, dono]);
        return json({ ok: true });
      }

      // Salva o prompt ajustado, sem precisar de deploy.
      if (p === '/api/prompt' && request.method === 'POST') {
        const b = (await request.json()) as { agente?: string; system?: string };
        const ag = acharAgente(String(b.agente || ''));
        if (!ag) return json({ error: 'Esse agente não existe.' }, 400);
        const s = String(b.system || '').trim().slice(0, 8000);
        await env.DB.exec(
          `INSERT INTO donos (chave, prompt) VALUES (?, ?)
           ON CONFLICT(chave) DO UPDATE SET prompt = excluded.prompt`, [ag.chave, s]);
        return json({ ok: true, restaurado: !s });
      }

      return json({ error: 'Rota não encontrada.' }, 404);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      console.log('erro', p, msg);
      return json({ error: 'Falhou no servidor: ' + msg }, 500);
    }
  },
};
