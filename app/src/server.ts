// Fábrica de Térmicos — estúdio.
//
// Um fluxo, da capinha ao térmico entregue:
//   1 escolher a case   2 interpretar   3 variar cor (opcional)
//   4 montar o set      5 separar em camadas (tira fundo)
//   6 o ilustrador escolhe as máscaras   7 entrega: PNGs, mockups 2D e prévia 3D
//
// O que é IA passa pelo AI Proxy do Gogroup. O recorte e o rapport são código,
// no navegador, em cima dos pixels reais — por isso existe o proxy /api/img:
// canvas não lê pixel de outra origem sem CORS.

import { AGENTES, acharAgente } from './agentes';
import { MASCARAS, mockupUrl } from './produtos';
import { chamarAgente, type Env as AiEnv } from './aiproxy';

interface Env extends AiEnv { PROXY_BASE_URL?: string }

const IMG_HOSTS = [
  'custom-case-images.s3.amazonaws.com',
  'ik.imagekit.io',
  'static-goengines.gocase.com.br',
  'catalog-api-v2.gocase.com.br',
];

function json(d: unknown, s = 200): Response {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Consulta o proxy de dados com o cookie de quem está usando o app. */
async function pg(env: Env, request: Request, db: string, path: string): Promise<any[]> {
  const base = (env.PROXY_BASE_URL || 'https://data.devgogroup.com').replace(/\/$/, '');
  const res = await fetch(`${base}/${db}/${path}`, {
    headers: { cookie: request.headers.get('cookie') || '' },
  });
  if (!res.ok) throw new Error(`${db} respondeu ${res.status}`);
  return await res.json();
}

/** Do image_br do Site tira o caminho da arte plana ("stamp="). */
function caminhoDoStamp(imageBr: string): string | null {
  const i = imageBr.indexOf('stamp=');
  if (i < 0) return null;
  return imageBr.slice(i + 6).split('&')[0];
}

let pronto = false;
async function schema(env: Env): Promise<void> {
  if (pronto) return;
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS donos (
       chave TEXT PRIMARY KEY, dono TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT ''
     )`, []);
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS execucoes (
       id INTEGER PRIMARY KEY AUTOINCREMENT, agente TEXT NOT NULL,
       entrada TEXT NOT NULL DEFAULT '', saida TEXT NOT NULL DEFAULT '',
       ok INTEGER NOT NULL DEFAULT 1, ms INTEGER NOT NULL DEFAULT 0, tokens INTEGER,
       quem TEXT NOT NULL DEFAULT '', quando TEXT NOT NULL DEFAULT (datetime('now'))
     )`, []);
  pronto = true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    const quem = request.headers.get('x-godeploy-user-email') || 'anônimo';

    if (p === '/') return Response.redirect(url.origin + '/index.html', 302);

    // Proxy de imagem: o canvas precisa ler os pixels para tirar fundo e recortar.
    if (p === '/api/img') {
      const alvo = url.searchParams.get('url') || '';
      let u: URL;
      try { u = new URL(alvo); } catch { return new Response('url inválida', { status: 400 }); }
      if (!IMG_HOSTS.includes(u.hostname)) return new Response('host não liberado', { status: 403 });
      try {
        const up = await fetch(u.toString(), {
          headers: {
            'user-agent': request.headers.get('user-agent') || 'Mozilla/5.0',
            accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
          },
        });
        if (!up.ok) return new Response('a imagem respondeu ' + up.status, { status: 502 });
        return new Response(up.body, {
          headers: {
            'content-type': up.headers.get('content-type') || 'image/png',
            'access-control-allow-origin': '*',
            'cache-control': 'public, max-age=3600',
          },
        });
      } catch {
        return new Response('não consegui buscar a imagem', { status: 502 });
      }
    }

    if (!p.startsWith('/api/')) return new Response('Not found', { status: 404 });

    try {
      await schema(env);

      if (p === '/api/estado') {
        const [donos, execs] = await Promise.all([
          env.DB.query('SELECT * FROM donos', []),
          env.DB.query(
            'SELECT id, agente, ok, ms, tokens, quem, quando FROM execucoes ORDER BY id DESC LIMIT 12', []),
        ]);
        const mapa = new Map(donos.rows.map((d) => [String(d.chave), d]));
        return json({
          usuario: quem,
          temToken: !!env.AI_PROXY_TOKEN,
          modelo: env.AI_MODEL || 'gpt-5.5',
          mascaras: MASCARAS,
          agentes: AGENTES.map((a) => {
            const d = mapa.get(a.chave);
            return {
              chave: a.chave, nome: a.nome, oque: a.oque, visao: a.visao,
              exemplo: a.exemplo, dono: d ? String(d.dono) : '',
              system: d && String(d.prompt) ? String(d.prompt) : a.system,
              customizado: !!(d && String(d.prompt)),
            };
          }),
          execucoes: execs.rows,
        });
      }

      // Busca a case de origem e devolve a arte plana + o caminho do stamp.
      if (p === '/api/case') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(q)) {
          return json({ error: 'Digite o identificador da estampa (ex.: ramos-de-lavanda).' }, 400);
        }
        const rows = await pg(
          env, request, 'site',
          `public.velociraptor_products?or=(engine_identifier.eq.${q},sku.eq.${q})` +
          `&select=sku,name_br,engine_identifier,image_br&limit=60`,
        );
        const itens = rows
          .filter((r: any) => r.image_br && caminhoDoStamp(r.image_br))
          .map((r: any) => {
            const caminho = caminhoDoStamp(r.image_br) as string;
            return {
              sku: r.sku,
              nome: r.name_br || r.sku,
              identifier: r.engine_identifier,
              caminho,
              arte: `https://custom-case-images.s3.amazonaws.com/${caminho}`,
            };
          });
        // Sem duplicar a mesma arte várias vezes.
        const vistos = new Set<string>();
        const unicos = itens.filter((i) => !vistos.has(i.caminho) && vistos.add(i.caminho));
        if (!unicos.length) return json({ q, itens: [], aviso: `Nada encontrado para "${q}".` });
        return json({ q, itens: unicos.slice(0, 12) });
      }

      // Monta as URLs de mockup 2D no Prisma para as máscaras escolhidas.
      if (p === '/api/mockups' && request.method === 'POST') {
        const b = (await request.json()) as { caminho?: string; mascaras?: string[] };
        const caminho = String(b.caminho || '');
        if (!caminho) return json({ error: 'Faltou a arte de origem.' }, 400);
        const querem = new Set(b.mascaras || []);
        const lista = MASCARAS.filter((m) => querem.has(m.chave)).map((m) => ({
          chave: m.chave, label: m.label, w: m.w, h: m.h,
          url: mockupUrl(m, caminho, 700),
        }));
        return json({ mockups: lista });
      }

      if (p === '/api/rodar' && request.method === 'POST') {
        const b = (await request.json()) as { agente?: string; entrada?: string; system?: string };
        const ag = acharAgente(String(b.agente || ''));
        if (!ag) return json({ error: 'Esse agente não existe.' }, 400);

        const entrada = String(b.entrada || '').trim();
        if (!entrada) return json({ error: 'Escreva a entrada antes de rodar.' }, 400);
        if (ag.visao && !/^https?:\/\//i.test(entrada)) {
          return json({ error: 'Este agente lê imagem: a entrada precisa ser uma URL http(s).' }, 400);
        }

        let system = String(b.system || '').trim();
        if (!system) {
          const salvo = await env.DB.query('SELECT prompt FROM donos WHERE chave = ?', [ag.chave]);
          system = String(salvo.rows[0]?.prompt || '') || ag.system;
        }

        const r = await chamarAgente(
          env, system, ag.user(entrada), ag.visao ? entrada : undefined, ag.temperatura);

        await env.DB.exec(
          `INSERT INTO execucoes (agente, entrada, saida, ok, ms, tokens, quem)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [ag.chave, entrada.slice(0, 2000),
           JSON.stringify(r.ok ? r.dados : { erro: r.erro }).slice(0, 4000),
           r.ok ? 1 : 0, r.ms, r.tokens ?? null, quem]);

        return json(r, r.ok ? 200 : 502);
      }

      if (p === '/api/dono' && request.method === 'POST') {
        const b = (await request.json()) as { agente?: string; dono?: string };
        const ag = acharAgente(String(b.agente || ''));
        if (!ag) return json({ error: 'Esse agente não existe.' }, 400);
        await env.DB.exec(
          `INSERT INTO donos (chave, dono) VALUES (?, ?)
           ON CONFLICT(chave) DO UPDATE SET dono = excluded.dono`,
          [ag.chave, String(b.dono || '').trim().slice(0, 60)]);
        return json({ ok: true });
      }

      if (p === '/api/prompt' && request.method === 'POST') {
        const b = (await request.json()) as { agente?: string; system?: string };
        const ag = acharAgente(String(b.agente || ''));
        if (!ag) return json({ error: 'Esse agente não existe.' }, 400);
        await env.DB.exec(
          `INSERT INTO donos (chave, prompt) VALUES (?, ?)
           ON CONFLICT(chave) DO UPDATE SET prompt = excluded.prompt`,
          [ag.chave, String(b.system || '').trim().slice(0, 8000)]);
        return json({ ok: true });
      }

      return json({ error: 'Rota não encontrada.' }, 404);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      console.log('erro', p, msg);
      return json({ error: 'Falhou no servidor: ' + msg }, 500);
    }
  },
};
