// Fábrica de Térmicos — quadro de organização da equipe (GoDeploy Worker).
//
// Duas visões sobre os MESMOS dados em env.DB:
//   - Mapa mental: a esteira (como é feito) + as trilhas (quem faz), com
//     contagem viva de cards por trilha.
//   - Board: cards editáveis por status, arrastáveis entre colunas.
//
// Toda escrita registra quem fez (x-godeploy-user-email, injetado pelo gateway)
// e vira uma linha em `historico`, para a equipe enxergar o que mudou.

interface DbResult { columns: string[]; rows: Record<string, unknown>[]; rowsRead: number }
interface DbExecResult { rowsWritten: number }
interface Db {
  query(sql: string, params?: unknown[]): Promise<DbResult>;
  exec(sql: string, params?: unknown[]): Promise<DbExecResult>;
}
interface Env { DB: Db }

const STATUS = ['backlog', 'fazendo', 'revisao', 'pronto'] as const;
type Status = (typeof STATUS)[number];

function json(d: unknown, s = 200): Response {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function quem(request: Request): string {
  return request.headers.get('x-godeploy-user-email') || 'anônimo';
}

/** Nome curto a partir do e-mail, para caber no card. */
function curto(email: string): string {
  const n = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return n ? n.replace(/\b\w/g, (c) => c.toUpperCase()) : email;
}

// --- schema -----------------------------------------------------------------

let pronto = false;
async function garanteSchema(env: Env): Promise<void> {
  if (pronto) return;
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS trilhas (
       chave TEXT PRIMARY KEY,
       nome TEXT NOT NULL,
       dono TEXT NOT NULL DEFAULT '',
       escopo TEXT NOT NULL DEFAULT '',
       agentes TEXT NOT NULL DEFAULT '',
       ordem INTEGER NOT NULL DEFAULT 0
     )`, []);
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS cards (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       trilha TEXT NOT NULL,
       titulo TEXT NOT NULL,
       detalhe TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT 'backlog',
       semana INTEGER NOT NULL DEFAULT 1,
       agentes TEXT NOT NULL DEFAULT '',
       marco INTEGER NOT NULL DEFAULT 0,
       ordem INTEGER NOT NULL DEFAULT 0,
       atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
       atualizado_por TEXT NOT NULL DEFAULT ''
     )`, []);
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS historico (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       card_id INTEGER,
       acao TEXT NOT NULL,
       detalhe TEXT NOT NULL DEFAULT '',
       quem TEXT NOT NULL DEFAULT '',
       quando TEXT NOT NULL DEFAULT (datetime('now'))
     )`, []);
  await env.DB.exec('CREATE INDEX IF NOT EXISTS idx_cards_trilha ON cards(trilha)', []);
  pronto = true;
}

async function registra(env: Env, cardId: number | null, acao: string, detalhe: string, autor: string) {
  await env.DB.exec(
    'INSERT INTO historico (card_id, acao, detalhe, quem) VALUES (?, ?, ?, ?)',
    [cardId, acao, detalhe.slice(0, 400), autor],
  );
}

// --- seed -------------------------------------------------------------------
// Uma linha por statement de propósito: o env.DB tem teto de ~100 parâmetros
// ligados por statement, e INSERT em lote grande quebra só em runtime (passa
// batido por tsc e esbuild). Isso roda uma vez; não vale o risco.

const TRILHAS: [string, string, string, string, string, number][] = [
  ['T1', 'Arquitetura & Motor Gráfico', 'João Wellington',
   'Contratos, chamarAgente(), separador determinístico, rapport e fila. Todas as outras trilhas dependem daqui.', '', 1],
  ['T2', 'Dados & Curadoria', '',
   'Query do gap case→térmico, resolvedor de arte na cascata Factory→Site→Catalog.', 'A1', 2],
  ['T3', 'Agentes de Visão', '',
   'Leitor e copiloto de segmentação, prompts e conjunto de avaliação.', 'A2, A4', 3],
  ['T4', 'Qualidade & Compliance', '',
   'Auditoria de costura, escolha de cor do corpo e veto de marca.', 'A5, A6, A7', 4],
  ['T5', 'Interface & Fila', '',
   'Fila visual, card da estampa, aprovação em um clique e painel do supervisor.', 'A10', 5],
  ['T6', 'Cadastro & Integração', '',
   'Nome, SKU, descrição, mockup 2D, render 3D e gravação no catálogo.', 'A8, A9', 6],
];

// [trilha, título, detalhe, semana, agentes, marco]
const CARDS: [string, string, string, number, string, number][] = [
  ['T1', 'Publicar contratos e stubs', 'src/core/tipos.ts com Camada, LeituraEstampa, PlanoComposicao, ItemFila e os estados. Stub de cada estágio devolvendo dado de exemplo. É o que destrava as outras cinco trilhas.', 1, '', 1],
  ['T1', 'chamarAgente() — cliente único do AI Proxy', 'Auth, timeout de 25s, retry, parse de JSON, validação de schema e agente_log. Nenhum estágio chama fetch no proxy direto.', 1, '', 1],
  ['T1', 'Separador determinístico', 'Flood-fill do fundo sólido pelas 4 bordas, componentes conexos no alpha (union-find), descarte de ruído e fusão de fragmentos. Saída no formato do ag-psd.', 2, '', 0],
  ['T1', 'Porte do motor de rapport', 'layoutCompute, wrapOffsets e composeFrom vindos do gerador-de-adaptacoes, rodando em 2754x2340.', 3, '', 1],
  ['T1', 'Fila em env.DB + cron', 'Máquina de estados, idempotência por estágio e reprocessamento item a item.', 4, '', 0],

  ['T2', 'Query do gap case→térmico', 'gold.product_estampa_daily + dim_estampa. NÃO usar estampa_opportunity: índice zerado e receita constante.', 1, '', 0],
  ['T2', 'Filtros de ruído da fila', 'Descartar is_clear, acessórios como cordao-para-case e licenças bloqueadas.', 1, '', 0],
  ['T2', 'Resolvedor de arte', 'Cascata Factory → Site → Catalog até o PNG em alta.', 2, '', 0],
  ['T2', 'Agente A1 — Analista de Portfólio', 'Ranking com racional, janela ideal e risco. O SQL traz número; o A1 traz julgamento.', 3, 'A1', 0],

  ['T3', 'Rotular 30 estampas', 'Conjunto de avaliação: separável sim/não, densidade, tem texto, tem logo. Sem isso não dá pra saber se um prompt melhorou.', 1, '', 1],
  ['T3', 'Agente A2 — Leitor de Estampa', 'JSON estrito que roteia a esteira inteira. Recall 100% em tem_logo e tem_texto.', 2, 'A2', 1],
  ['T3', 'Agente A4 — Copiloto de Segmentação', 'Olha o contact-sheet e conserta o agrupamento: funde fragmentos, descarta ruído.', 3, 'A4', 0],
  ['T3', 'Eval automatizada dos dois agentes', 'Rodar contra as 30 e reportar acerto por campo a cada mudança de prompt.', 4, 'A2, A4', 0],

  ['T4', 'Plantar 20 violações de marca', 'Conjunto com logo, texto e IP de terceiro escondidos, para medir o recall do A7.', 1, '', 1],
  ['T4', 'Agente A5 — Auditor de Costura', 'Medição em px da borda esquerda contra a direita, mais julgamento visual do ladrilho 3x1.', 2, 'A5', 0],
  ['T4', 'Agente A6 — Colorista', 'Contraste da arte contra corpo branco, preto e azul.', 3, 'A6', 0],
  ['T4', 'Agente A7 — Revisor de Marca', 'Veto absoluto. Gravidade alta bloqueia sempre, sem exceção automática.', 3, 'A7', 1],

  ['T5', 'Ligar o protótipo em dado real', 'A fila visual passa a ler a fila de verdade em vez do exemplo.', 2, '', 0],
  ['T5', 'Card completo da estampa', 'Original, recortes, rapport 3x1, mockup 2D e render no .glb.', 3, '', 0],
  ['T5', 'Aprovar em um clique', 'Aprovar, ajustar e reprovar direto da fila, sem abrir o Photoshop.', 3, '', 1],
  ['T5', 'Painel do A10', 'Resumo do dia, alertas de padrão de erro e custo por estampa.', 4, 'A10', 0],

  ['T6', 'Mapear o destino de cadastro', 'Onde a estampa aprovada é gravada e quais campos são obrigatórios.', 1, '', 0],
  ['T6', 'Agente A8 — Nomeador', 'Nome, SKU e engine_identifier <estampa>-termicos, com prefixo por licenciado.', 2, 'A8', 0],
  ['T6', 'Agente A9 — Redator de Catálogo', 'Descrição, alt text e tags. Único agente com temperatura 0.7.', 3, 'A9', 0],
  ['T6', 'Empacotador', 'PNG 2754x2340 transparente, mockup e render prontos no card.', 3, '', 0],
  ['T6', 'Cadastro ponta a ponta', 'Aprovar na fila gera o registro completo, sem digitação.', 4, '', 1],
];

async function semeia(env: Env, autor: string): Promise<number> {
  const t = await env.DB.query('SELECT COUNT(*) AS n FROM trilhas', []);
  if (Number(t.rows[0]?.n || 0) === 0) {
    for (const [chave, nome, dono, escopo, agentes, ordem] of TRILHAS) {
      await env.DB.exec(
        'INSERT INTO trilhas (chave, nome, dono, escopo, agentes, ordem) VALUES (?, ?, ?, ?, ?, ?)',
        [chave, nome, dono, escopo, agentes, ordem],
      );
    }
  }
  const c = await env.DB.query('SELECT COUNT(*) AS n FROM cards', []);
  if (Number(c.rows[0]?.n || 0) > 0) return 0;
  let i = 0;
  for (const [trilha, titulo, detalhe, semana, agentes, marco] of CARDS) {
    await env.DB.exec(
      `INSERT INTO cards (trilha, titulo, detalhe, status, semana, agentes, marco, ordem, atualizado_por)
       VALUES (?, ?, ?, 'backlog', ?, ?, ?, ?, ?)`,
      [trilha, titulo, detalhe, semana, agentes, marco, i, autor],
    );
    i++;
  }
  await registra(env, null, 'seed', `${i} cards criados`, autor);
  return i;
}

// --- worker -----------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    const autor = quem(request);

    if (p === '/') return Response.redirect(url.origin + '/index.html', 302);
    if (!p.startsWith('/api/')) return new Response('Not found', { status: 404 });

    try {
      await garanteSchema(env);

      // GET /api/estado — tudo que a tela precisa, numa chamada só.
      if (p === '/api/estado' && request.method === 'GET') {
        await semeia(env, autor);
        const [trilhas, cards, hist] = await Promise.all([
          env.DB.query('SELECT * FROM trilhas ORDER BY ordem', []),
          env.DB.query('SELECT * FROM cards ORDER BY trilha, ordem, id', []),
          env.DB.query('SELECT * FROM historico ORDER BY id DESC LIMIT 12', []),
        ]);
        return json({
          usuario: autor, usuarioCurto: curto(autor),
          trilhas: trilhas.rows, cards: cards.rows, historico: hist.rows,
        });
      }

      // POST /api/card — cria (sem id) ou edita (com id).
      if (p === '/api/card' && request.method === 'POST') {
        const b = (await request.json()) as Record<string, unknown>;
        const trilha = String(b.trilha || '').trim();
        const titulo = String(b.titulo || '').trim();
        if (!titulo) return json({ error: 'Escreva um título para o card.' }, 400);
        if (!/^T[1-6]$/.test(trilha)) return json({ error: 'Escolha uma trilha entre T1 e T6.' }, 400);

        const detalhe = String(b.detalhe || '').slice(0, 2000);
        const status = STATUS.includes(b.status as Status) ? String(b.status) : 'backlog';
        const semana = Math.min(12, Math.max(1, Number(b.semana) || 1));
        const agentes = String(b.agentes || '').slice(0, 60);
        const marco = b.marco ? 1 : 0;

        if (b.id) {
          const id = Number(b.id);
          await env.DB.exec(
            `UPDATE cards SET trilha=?, titulo=?, detalhe=?, status=?, semana=?, agentes=?, marco=?,
             atualizado_em=datetime('now'), atualizado_por=? WHERE id=?`,
            [trilha, titulo, detalhe, status, semana, agentes, marco, autor, id],
          );
          await registra(env, id, 'editou', titulo, autor);
          return json({ ok: true, id });
        }
        const mx = await env.DB.query('SELECT COALESCE(MAX(ordem), 0) AS m FROM cards WHERE trilha = ?', [trilha]);
        const ordem = Number(mx.rows[0]?.m || 0) + 1;
        await env.DB.exec(
          `INSERT INTO cards (trilha, titulo, detalhe, status, semana, agentes, marco, ordem, atualizado_por)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [trilha, titulo, detalhe, status, semana, agentes, marco, ordem, autor],
        );
        // O id é conveniência: o front recarrega o estado inteiro depois de salvar.
        // Se o runtime não expuser last_insert_rowid, o card já foi criado — não
        // faz sentido devolver 500 e sugerir à pessoa que a escrita falhou.
        let id = 0;
        try {
          const novo = await env.DB.query('SELECT last_insert_rowid() AS id', []);
          id = Number(novo.rows[0]?.id || 0);
        } catch (e) {
          console.log('last_insert_rowid indisponível:', (e as Error)?.message);
        }
        await registra(env, id || null, 'criou', titulo, autor);
        return json({ ok: true, id });
      }

      // POST /api/card/status — mover entre colunas (arrastar).
      if (p === '/api/card/status' && request.method === 'POST') {
        const b = (await request.json()) as { id?: number; status?: string };
        const id = Number(b.id || 0);
        const status = String(b.status || '');
        if (!id || !STATUS.includes(status as Status)) {
          return json({ error: 'Movimento inválido.' }, 400);
        }
        const r = await env.DB.query('SELECT titulo FROM cards WHERE id = ?', [id]);
        if (!r.rows.length) return json({ error: 'Card não encontrado.' }, 404);
        await env.DB.exec(
          `UPDATE cards SET status=?, atualizado_em=datetime('now'), atualizado_por=? WHERE id=?`,
          [status, autor, id],
        );
        await registra(env, id, 'moveu p/ ' + status, String(r.rows[0].titulo), autor);
        return json({ ok: true });
      }

      // DELETE /api/card?id=
      if (p === '/api/card' && request.method === 'DELETE') {
        const id = Number(url.searchParams.get('id') || 0);
        if (!id) return json({ error: 'Informe o id do card.' }, 400);
        const r = await env.DB.query('SELECT titulo FROM cards WHERE id = ?', [id]);
        if (!r.rows.length) return json({ error: 'Card não encontrado.' }, 404);
        await env.DB.exec('DELETE FROM cards WHERE id = ?', [id]);
        await registra(env, id, 'apagou', String(r.rows[0].titulo), autor);
        return json({ ok: true });
      }

      // POST /api/trilha — editar nome, dono e escopo da trilha.
      if (p === '/api/trilha' && request.method === 'POST') {
        const b = (await request.json()) as Record<string, unknown>;
        const chave = String(b.chave || '');
        if (!/^T[1-6]$/.test(chave)) return json({ error: 'Trilha inválida.' }, 400);
        const nome = String(b.nome || '').trim().slice(0, 80);
        const dono = String(b.dono || '').trim().slice(0, 60);
        const escopo = String(b.escopo || '').trim().slice(0, 500);
        if (!nome) return json({ error: 'A trilha precisa de um nome.' }, 400);
        await env.DB.exec('UPDATE trilhas SET nome=?, dono=?, escopo=? WHERE chave=?', [nome, dono, escopo, chave]);
        await registra(env, null, 'trilha ' + chave, dono ? `dono: ${dono}` : 'sem dono', autor);
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
