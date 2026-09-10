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
import { chamarAgente } from './aiproxy';
import { gerarPromptRapport, dispararGeracao, consultarJob, proporcaoDe, type Env as RotaBEnv } from './rotab';

interface Env extends RotaBEnv { PROXY_BASE_URL?: string }

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
  // Rota B do Separador (fundo contínuo -> PIAPP). Uma geração por (caminho,
  // máscara); os bytes ficam em rotab_chunks porque a output_url do PIAPP
  // expira em ~1h — nunca servimos ela direto pro cliente.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS rotab_geracoes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       caminho TEXT NOT NULL, mascara TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
       job_id TEXT, status TEXT NOT NULL DEFAULT 'queued', mime TEXT, erro TEXT,
       quando TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(caminho, mascara)
     )`, []);
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS rotab_chunks (
       geracao_id INTEGER NOT NULL, idx INTEGER NOT NULL, b64 TEXT NOT NULL
     )`, []);
  // Recados entre especialistas. Ficam por sessão de trabalho (a arte em curso),
  // para que um agente leia o que outro deixou mesmo em etapas separadas.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS recados (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       sessao TEXT NOT NULL, de TEXT NOT NULL, para TEXT NOT NULL,
       assunto TEXT NOT NULL DEFAULT '', pedido TEXT NOT NULL DEFAULT '',
       lido INTEGER NOT NULL DEFAULT 0,
       quando TEXT NOT NULL DEFAULT (datetime('now'))
     )`, []);
  await env.DB.exec('CREATE INDEX IF NOT EXISTS idx_recados ON recados(sessao, para, lido)', []);
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
              area: a.area, fora: a.fora,
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
        // Agente de visão aceita URL pública OU data URL. O data URL é o que
        // permite auditar o padrão recém-montado, que só existe como canvas no
        // navegador e não tem endereço público nenhum.
        const ehImagem = /^https?:\/\//i.test(entrada) || /^data:image\/(png|jpeg|webp);base64,/i.test(entrada);
        if (ag.visao && !ehImagem) {
          return json({ error: 'Este agente lê imagem: mande uma URL http(s) ou um data URL.' }, 400);
        }

        let system = String(b.system || '').trim();
        if (!system) {
          const salvo = await env.DB.query('SELECT prompt FROM donos WHERE chave = ?', [ag.chave]);
          system = String(salvo.rows[0]?.prompt || '') || ag.system;
        }

        // ── a mesa conversa: entrega os recados pendentes para este especialista
        const sessao = String((b as any).sessao || '').slice(0, 80) || 'avulso';
        let pendentes: Record<string, unknown>[] = [];
        try {
          const q = await env.DB.query(
            'SELECT id, de, assunto, pedido FROM recados WHERE sessao = ? AND para = ? AND lido = 0 ORDER BY id',
            [sessao, ag.chave]);
          pendentes = q.rows;
        } catch { /* sem recado não impede o agente de trabalhar */ }

        let corpo = ag.user(entrada);
        if (pendentes.length) {
          corpo += '\n\nRECADOS DE COLEGAS — leve em conta e registre em "atendi":\n' +
            pendentes.map((r) => `- de ${r.de} · ${r.assunto}: ${r.pedido}`).join('\n');
        }

        const r = await chamarAgente(
          env, system, corpo, ag.visao ? entrada : undefined, ag.temperatura);

        // marca como lidos e guarda os recados que este agente deixou para os outros
        if (r.ok) {
          if (pendentes.length) {
            for (const rc of pendentes) {
              await env.DB.exec('UPDATE recados SET lido = 1 WHERE id = ?', [rc.id]);
            }
          }
          const saiu = ((r.dados as any)?.recados_para || []) as { para?: string; assunto?: string; pedido?: string }[];
          for (const rc of saiu.slice(0, 6)) {
            const para = String(rc?.para || '');
            if (!acharAgente(para) || para === ag.chave) continue;   // recado para colega que não existe é ruído
            await env.DB.exec(
              'INSERT INTO recados (sessao, de, para, assunto, pedido) VALUES (?, ?, ?, ?, ?)',
              [sessao, ag.chave, para, String(rc.assunto || '').slice(0, 200), String(rc.pedido || '').slice(0, 600)]);
          }
        }

        await env.DB.exec(
          `INSERT INTO execucoes (agente, entrada, saida, ok, ms, tokens, quem)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [ag.chave,
           /^data:/i.test(entrada) ? '(imagem gerada, ' + Math.round(entrada.length/1024) + ' KB)' : entrada.slice(0, 2000),
           JSON.stringify(r.ok ? r.dados : { erro: r.erro }).slice(0, 4000),
           r.ok ? 1 : 0, r.ms, r.tokens ?? null, quem]);

        return json(r, r.ok ? 200 : 502);
      }

      // Quadro de recados da sessão — o que a mesa trocou até agora.
      if (p === '/api/recados') {
        const sessao = (url.searchParams.get('sessao') || 'avulso').slice(0, 80);
        const q = await env.DB.query(
          'SELECT de, para, assunto, pedido, lido, quando FROM recados WHERE sessao = ? ORDER BY id DESC LIMIT 40',
          [sessao]);
        return json({ recados: q.rows });
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

      // ── Rota B do Separador: fundo contínuo -> PIAPP ──────────────────
      // (docs/COMO-FUNCIONA.md § Rota generativa; padrão trazido do app
      // benchmark-mockups — ver docs/MAPA-ATIVOS.md § 8)

      if (p === '/api/rotab/prompt' && request.method === 'POST') {
        const b = (await request.json()) as { arte?: string };
        const arte = String(b.arte || '');
        if (!arte) return json({ error: 'Faltou a arte de origem.' }, 400);
        const r = await gerarPromptRapport(env, arte);
        if (!r.ok) return json({ error: r.erro }, 502);
        return json({ prompt: r.prompt });
      }

      if (p === '/api/rotab/gerar' && request.method === 'POST') {
        const b = (await request.json()) as { caminho?: string; mascara?: string; prompt?: string };
        const caminho = String(b.caminho || '');
        const chave = String(b.mascara || '');
        const prompt = String(b.prompt || '').trim();
        const m = MASCARAS.find((x) => x.chave === chave);
        if (!caminho || !m) return json({ error: 'Faltou a arte de origem ou a máscara não existe.' }, 400);
        if (!prompt) return json({ error: 'Gere o prompt na etapa anterior antes de gerar a imagem.' }, 400);

        const disparo = await dispararGeracao(env, prompt, proporcaoDe(m.w, m.h));
        if (!disparo.ok) return json({ error: disparo.erro }, 502);

        await env.DB.exec(
          `INSERT INTO rotab_geracoes (caminho, mascara, prompt, job_id, status)
           VALUES (?, ?, ?, ?, 'queued')
           ON CONFLICT(caminho, mascara) DO UPDATE SET
             prompt = excluded.prompt, job_id = excluded.job_id, status = 'queued', erro = NULL`,
          [caminho, chave, prompt, disparo.jobId ?? null]);
        const row = await env.DB.query(
          'SELECT id FROM rotab_geracoes WHERE caminho = ? AND mascara = ?', [caminho, chave]);
        return json({ id: row.rows[0]?.id, status: 'queued' });
      }

      if (p === '/api/rotab/status') {
        const id = Number(url.searchParams.get('id') || 0);
        if (!id) return json({ error: 'Faltou o id.' }, 400);
        const row = await env.DB.query('SELECT * FROM rotab_geracoes WHERE id = ?', [id]);
        const g = row.rows[0] as Record<string, unknown> | undefined;
        if (!g) return json({ error: 'Geração não encontrada.' }, 404);

        if (g.status === 'completed') return json({ status: 'completed', url: '/api/rotab/imagem?id=' + id });
        if (g.status === 'failed') return json({ status: 'failed', erro: g.erro });

        const s = await consultarJob(env, String(g.job_id || ''));
        if (!s.ok) return json({ status: 'processing', aviso: s.erro });
        if (s.status === 'queued' || s.status === 'processing') return json({ status: s.status });

        if (s.status === 'failed' || !s.outputUrl) {
          const erro = s.erro || 'O PIAPP marcou concluído sem imagem.';
          await env.DB.exec(`UPDATE rotab_geracoes SET status = 'failed', erro = ? WHERE id = ?`, [erro, id]);
          return json({ status: 'failed', erro });
        }

        // completed: baixa os bytes agora — a output_url do PIAPP é assinada e expira.
        try {
          const img = await fetch(s.outputUrl);
          if (!img.ok) throw new Error('a imagem respondeu ' + img.status);
          const mime = img.headers.get('content-type') || 'image/png';
          const bytes = new Uint8Array(await img.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          const b64 = btoa(bin);
          const CHUNK = 800_000; // abaixo do limite por linha do D1/SQLite
          await env.DB.exec('DELETE FROM rotab_chunks WHERE geracao_id = ?', [id]);
          for (let off = 0, idx = 0; off < b64.length; off += CHUNK, idx++) {
            await env.DB.exec('INSERT INTO rotab_chunks (geracao_id, idx, b64) VALUES (?, ?, ?)',
              [id, idx, b64.slice(off, off + CHUNK)]);
          }
          await env.DB.exec(`UPDATE rotab_geracoes SET status = 'completed', mime = ?, erro = NULL WHERE id = ?`,
            [mime, id]);
          return json({ status: 'completed', url: '/api/rotab/imagem?id=' + id });
        } catch (e) {
          const msg = (e as Error)?.message || String(e);
          await env.DB.exec(`UPDATE rotab_geracoes SET status = 'failed', erro = ? WHERE id = ?`, [msg, id]);
          return json({ status: 'failed', erro: msg }, 502);
        }
      }

      if (p === '/api/rotab/imagem') {
        const id = Number(url.searchParams.get('id') || 0);
        if (!id) return new Response('faltou o id', { status: 400 });
        const ger = await env.DB.query('SELECT mime, status FROM rotab_geracoes WHERE id = ?', [id]);
        const g = ger.rows[0] as { mime?: string; status?: string } | undefined;
        if (!g || g.status !== 'completed') return new Response('imagem ainda não está pronta', { status: 404 });
        const chunks = await env.DB.query(
          'SELECT b64 FROM rotab_chunks WHERE geracao_id = ? ORDER BY idx', [id]);
        if (!chunks.rows.length) return new Response('imagem sem bytes — gere de novo', { status: 404 });
        const b64 = chunks.rows.map((r) => String(r.b64)).join('');
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes, {
          headers: {
            'content-type': g.mime || 'image/png',
            'cache-control': 'public, max-age=604800, immutable',
          },
        });
      }

      return json({ error: 'Rota não encontrada.' }, 404);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      console.log('erro', p, msg);
      return json({ error: 'Falhou no servidor: ' + msg }, 500);
    }
  },
};
