// Benchmark - monitor de mockups mais vendidos + prompt de estampa.
//
// Agendamento (cron da plataforma, horário UTC):
//   /tasks/weekly  toda segunda -> marca pela semana do mês:
//                  1 Casetify · 2 Skinnydip · 3 Burga · 4 Velvet Caviar · 5 Case-Mate
//   /tasks/monthly dias 28-31   -> se hoje for o ÚLTIMO dia do mês, roda Case-Mate
//                  (garante Case-Mate mesmo em meses sem 5ª segunda)
//
// Captura na ORDEM da página (posição = ranking de vendas), substitui o snapshot
// no SQLite, grava links na planilha. Para cada imagem, um prompt detalhado da
// ESTAMPA é gerado sob demanda via Claude (visão) e cacheado.
//
// Secrets (setAppSecret):
//   BROWSERLESS_URL, BROWSERLESS_TOKEN   obrigatórios (captura)
//   AI_PROXY_TOKEN                       obrigatório p/ gerar os prompts (visão via proxy Gogroup)
//   AI_PROXY_URL, AI_MODEL               opcionais (default: ai-proxy.gogroupbr.com, gpt-5.5)
//   PIAPP_TOKEN                          obrigatório p/ gerar a imagem 9:16 a partir do prompt
//   PIAPP_URL                            opcional (default: piapp-v2.vercel.app/api/v1)
//   SHEETS_WEBHOOK, SHEETS_KEY           opcionais (gravação no Sheets)

interface Env {
  DB: {
    query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    exec: (sql: string, params: unknown[]) => Promise<{ rowsWritten: number }>;
  };
  BROWSERLESS_URL?: string;
  BROWSERLESS_TOKEN?: string;
  AI_PROXY_URL?: string;
  AI_PROXY_TOKEN?: string;
  AI_MODEL?: string;
  PIAPP_URL?: string;
  PIAPP_TOKEN?: string;
  SHEETS_WEBHOOK?: string;
  SHEETS_KEY?: string;
}

interface Brand { key: string; name: string; mode: 'casetify' | 'shopify' | 'shopifyjson' | 'gocase'; url: string; limit?: number; }

// ordem = semana do mês (índice 0 -> semana 1); shopifyjson usa /products.json (sem browserless)
const BRANDS: Brand[] = [
  { key: 'gocase', name: 'Gocase', mode: 'gocase', url: 'https://www.gocase.com.br/capinha-para-celular/iphone/' },
  { key: 'casetify', name: 'Casetify', mode: 'casetify', url: 'https://www.casetify.com/collection/best-selling-prints' },
  { key: 'skinnydip', name: 'Skinnydip London', mode: 'shopifyjson', url: 'https://www.skinnydiplondon.com/collections/best-selling-phone-cases' },
  { key: 'burga', name: 'Burga', mode: 'shopify', url: 'https://burga.com/collections/all?filter.v.option.case%20type=Tough%20(MagSafe)&filter.v.option.case%20details%20color=N%2FA&filter.p.m.custom.product_gender_context=female,unisex&page=1&model=iPhone%2017%20Pro%20Max&sort_by=best-selling' },
  { key: 'velvetcaviar', name: 'Velvet Caviar', mode: 'shopify', url: 'https://velvetcaviar.com/collections/best-sellers' },
  { key: 'casemate', name: 'Case-Mate', mode: 'shopify', url: 'https://case-mate.com/collections/case-mate-loveshackfancy-collection?sort_by=best-selling' },
  { key: 'thedairy', name: 'The Dairy', mode: 'shopifyjson', url: 'https://thedairy.com/collections/popular-phone-cases' },
  { key: 'casely', name: 'Casely', mode: 'shopifyjson', url: 'https://www.getcasely.com/collections/best-sellers' },
  { key: 'bluntcases', name: 'Blunt Cases', mode: 'shopifyjson', url: 'https://bluntcases.com/collections/best-selling-cases-blunt-cases' },
];
const byKey = (k: string) => BRANDS.find((b) => b.key === k);
const CASEMATE = 'casemate';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_ITEMS = 35; // teto do POOL bruto capturado do site por marca (antes de descartar as já revisadas)
const BOARD_CAP = 30; // teto de estampas EM ABERTO (nem cadastrada, nem descartada) por aba — usado ao "Atualizar agora"

const PROMPT_SYSTEM =
  'You are an expert prompt engineer for text-to-image models (Flux, Midjourney, GPT Image, Ideogram). ' +
  'You are shown a product photo of a phone case. Describe ONLY the printed artwork / graphic design on the case surface. ' +
  'Completely ignore the phone, the case shape and material, camera cutouts, edges, buttons, bezels, glare, shadows, reflections, product-mockup framing and any background. ' +
  'The case may show a MagSafe magnet ring, a circular camera ring, lens cutouts and button/port cutouts — these are physical hardware, NOT part of the print. Never describe or reproduce any ring, circle, magnet ring, camera cutout, hole or button shape that comes from the device; imagine the printed artwork continuing uniformly beneath them. Describe it as a flat, full-bleed pattern with no device hardware, no rings, no holes and no circular overlays. ' +
  'Analyze only the graphic design of the print. ' +
  'Return ONE single rich, detailed English prompt (no preamble, no markdown, no quotes, 60-120 words) that another image model could use to recreate a visually very similar artwork. ' +
  'Cover, weaving them naturally into prose: theme/subject, art style, composition, key visual elements, color palette, textures, lighting when it is part of the art, level of detail, finish, mood/atmosphere, and any repeating patterns or motifs, plus the illustration or painting technique. ' +
  'CRITICAL: exclude ALL text, letters, words, numbers, brand names, logos, watermarks, signatures and labels. Never describe or include them. If the case shows a brand name, logo, watermark or any lettering (for example a brand name printed on the case), treat it as product branding and omit it entirely — describe only the decorative pattern/illustration itself. The described artwork must contain no text and no logos of any kind. ' +
  'Never mention phones, cases, mockups or products.';

// Prompt para imagens de referência genéricas (Pinterest): descreve a arte, não um mockup de capinha.
const PROMPT_SYSTEM_PINTEREST =
  'You are an expert prompt engineer for text-to-image models (Flux, Midjourney, GPT Image, Ideogram). ' +
  'You are shown a reference image (an illustration, pattern, artwork or photo). Describe its visual content so another model can recreate a visually very similar artwork. ' +
  'Return ONE single rich, detailed English prompt (no preamble, no markdown, no quotes, 60-120 words). ' +
  'Cover, weaving them naturally into prose: theme/subject, art style and technique, composition, key visual elements, color palette, textures, lighting, level of detail, finish, mood/atmosphere, and any repeating patterns or motifs. ' +
  'CRITICAL: exclude ALL text, letters, words, numbers, brand names, logos, watermarks, signatures and labels — describe only the decorative/visual content. Describe it as a flat, full-bleed composition with no device hardware, rings, holes or product framing.';

// ---- código que roda DENTRO do browserless (validado por site) ----
function shopifyCode(url: string): string {
  return String.raw`export default async function ({ page }) {
  await page.setViewport({ width: 1440, height: 900 });
  const resp = await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const status = resp ? resp.status() : 0;
  // espera a grade de produtos aparecer (views lazy/Searchspring)
  for (let i = 0; i < 20; i++) { const c = await page.evaluate(() => document.querySelectorAll('a[href*="/products/"]').length); if (c > 5) break; await new Promise(r => setTimeout(r, 400)); }
  let last = 0;
  for (let i = 0; i < 22; i++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)); await new Promise(r => setTimeout(r, 330)); const h = await page.evaluate(() => document.body.scrollHeight); if (h === last && i > 6) break; last = h; }
  await new Promise(r => setTimeout(r, 700));
  const pairs = await page.evaluate(() => {
    function hi(v){ v = v.split('?')[0]; if (v.startsWith('//')) v = 'https:' + v; v = v.replace(/_(\d+)x(\d+)?(?=\.[a-z]{2,4}(\.[a-z]{2,4})?$)/i, ''); return v; }
    const bad = /drop_down|dropdown|banner|menu|nav_|logo|placeholder|icon|_dd_|header|swatch/i;
    const root = document.querySelector('[class*="ProductGrid"],#product-grid,ul.product-grid,.product-grid,.collection__products') || document;
    const seen = new Set(); const out = []; let pos = 0;
    root.querySelectorAll('a[href*="/products/"]').forEach((a) => {
      const href = (a.href || '').split('?')[0]; const k = href.split('/products/')[1]; if (!k) return; const handle = k.split('/')[0]; if (!handle || seen.has(handle)) return;
      const card = a.closest('li,.card,.grid__item,.product-card,product-card,[class*="card"],[class*="product-item"]') || a;
      const imgs = new Set();
      card.querySelectorAll('img,source').forEach((el) => { ['src','data-src','srcset','data-srcset'].forEach((attr) => { let v = el.getAttribute && el.getAttribute(attr); if (!v) return; v = v.split(',').pop().trim().split(/\s+/)[0]; if ((/\/cdn\/shop\//.test(v) || /cdn\.shopify\.com/.test(v)) && !bad.test(v)) imgs.add(hi(v)); }); });
      if (imgs.size) { seen.add(handle); pos++; out.push({ pos, p: href, i: [...imgs][0] }); }
    });
    return out;
  });
  return { data: { status, pairs: pairs.slice(0, 400) }, type: 'application/json' };
}`;
}

function casetifyCode(url: string): string {
  return String.raw`export default async function ({ page }) {
  await page.setViewport({ width: 1440, height: 900 });
  const resp = await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const status = resp ? resp.status() : 0;
  const n = await page.evaluate(() => document.querySelectorAll('a[href*="/product/"]').length);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const r = await page.evaluate((idx) => { const c = document.querySelectorAll('a[href*="/product/"]'); const el = c[idx]; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, ok: b.width > 0 }; }, i);
    if (r && r.ok) { try { await page.mouse.move(r.x, r.y, { steps: 2 }); } catch (e) {} }
    await new Promise((z) => setTimeout(z, 120));
    if (Date.now() - t0 > 22000) break;
  }
  await new Promise((r) => setTimeout(r, 1200));
  const pairs = await page.evaluate(() => {
    const seenHref = {}; const out = []; let pos = 0;
    document.querySelectorAll('a[href*="/product/"]').forEach((a) => {
      const href = a.href.split('#')[0].split('?')[0].replace('.com//', '.com/');
      if (seenHref[href]) return;
      const card = a.closest('div,li') || a;
      let first = null;
      const els = card.querySelectorAll('img,source');
      for (let e = 0; e < els.length && !first; e++) {
        const attrs = ['src', 'data-src', 'srcset'];
        for (let k = 0; k < attrs.length; k++) {
          let v = els[e].getAttribute && els[e].getAttribute(attrs[k]); if (!v) continue;
          v = v.split(',')[0].trim().split(/\s+/)[0];
          if (/cdn-image0\d\.casetify\.com\/usr\//.test(v) && /\.webp/.test(v)) { first = v.split('?')[0].replace(/\.(\d{2,4})x(\d{2,4})-/, '.1000x1000-'); break; }
        }
      }
      if (first) { pos++; seenHref[href] = true; out.push({ pos, p: href, i: first }); }
    });
    return out;
  });
  return { data: { status, pairs: pairs.slice(0, 400) }, type: 'application/json' };
}`;
}

// termos de slug (URL do produto) excluídos da captura do Gocase: acessório de cordão, licenciados
// (Disney, Sanrio, Warner etc.), estampas de futebol e estampas "clear"/transparentes — pedido do usuário.
// Best-effort baseado no nome do produto que aparece na URL; se algo escapar (ou for excluído à toa), me avise
// com o link do produto pra eu ajustar a lista.
const GOCASE_EXCLUDE_TERMS = [
  'capinha-para-celular-minha-cara', 'cordao-de-cases',
  // clear / transparente
  'clear', 'transparente',
  // licenciados
  'disney', 'mickey', 'minnie', 'stitch', 'frozen', 'princesa', 'marvel', 'vingadores', 'avengers',
  'homem-aranha', 'spider-man', 'batman', 'superman', 'liga-da-justica', 'dc-comics', 'looney-tunes',
  'turma-da-monica', 'sanrio', 'hello-kitty', 'my-melody', 'cinnamoroll', 'kuromi', 'pokemon', 'harry-potter',
  'hogwarts', 'star-wars', 'naruto', 'warner', 'tom-e-jerry', 'snoopy', 'barbie', 'hot-wheels', 'minions',
  'toy-story', 'pixar',
  // futebol — termos gerais + clubes/seleções (nomes de clube isolados têm algum risco de falso positivo
  // com produto não-futebolístico que cite a mesma cidade/palavra; peça ajuste se acontecer)
  'futebol', 'copa-do-mundo', 'mundial', 'libertadores', 'brasileirao', 'camisa-retro', 'blusa-retro',
  'camisa-de-time', 'selecao-brasileira', 'flamengo', 'corinthians', 'palmeiras', 'sao-paulo', 'santos',
  'gremio', 'internacional', 'cruzeiro', 'vasco', 'botafogo', 'fluminense', 'atletico-mineiro', 'bahia',
  'fortaleza', 'sport-recife', 'real-madrid', 'barcelona', 'manchester', 'liverpool', 'juventus', 'psg',
  'chelsea', 'arsenal', 'bayern', 'milan',
];

// Gocase (plataforma própria): grade .products-grid, cards a.list-product__link, imagens ik.imagekit.io (data-src lazy,
// mantém a querystring de render). Rola até a página parar de carregar produto novo (lazy-load), pra ter pool suficiente
// pra preencher o BOARD_CAP mesmo quando boa parte do topo do ranking já foi cadastrada/descartada.
function gocaseCode(url: string): string {
  return String.raw`export default async function ({ page }) {
  await page.setViewport({ width: 1440, height: 900 });
  const resp = await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 35000 });
  const status = resp ? resp.status() : 0;
  let last = 0;
  for (let i = 0; i < 35; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await new Promise(r => setTimeout(r, 320));
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === last && i > 8) break; // parou de carregar produto novo
    last = h;
  }
  await new Promise(r => setTimeout(r, 700));
  const pairs = await page.evaluate(() => {
    const norm = (v) => { if (v.startsWith('//')) v = 'https:' + v; return v; };
    const EXCLUDE_RE = new RegExp(${JSON.stringify(GOCASE_EXCLUDE_TERMS)}.join('|'), 'i');
    const root = document.querySelector('.products-grid, .new-catalog-page__products') || document;
    const seen = new Set(); const out = []; let pos = 0;
    const cards = root.querySelectorAll('a.list-product__link, .products-grid__item a[href]');
    cards.forEach((a) => {
      if (out.length >= 150) return;
      const href = (a.href || '').split('?')[0]; if (!href || seen.has(href)) return;
      if (EXCLUDE_RE.test(href)) return; // cordão, licenciados, futebol, clear — filtro do usuário
      let img = null;
      a.querySelectorAll('img,source').forEach((el) => { if (img) return; ['data-src','src','data-srcset','srcset'].forEach((at) => { if (img) return; let v = el.getAttribute && el.getAttribute(at); if (!v) return; v = v.split(',')[0].trim().split(/\s+/)[0]; if (/ik\.imagekit\.io\/gocase\//.test(v)) img = norm(v); }); });
      if (img) { seen.add(href); pos++; out.push({ pos, p: href, i: img }); }
    });
    return out.slice(0, 150);
  });
  return { data: { status, pairs }, type: 'application/json' };
}`;
}

// Pinterest: board (várias imagens) ou pin (uma). Extrai pelos PRÓPRIOS cards de pin
// (a[href*="/pin/"]), 1 imagem por pin, na ordem do DOM — os pins do board vêm primeiro,
// então não puxa o feed de recomendações. Sobe para /originals/ quando essa versão carrega.
function pinterestCode(url: string, limit: number, isPin: boolean): string {
  return String.raw`export default async function ({ page }) {
  await page.setViewport({ width: 1280, height: 1000 });
  try { await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }); } catch (e) {}
  const resp = await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle2', timeout: 45000 });
  const status = resp ? resp.status() : 0;
  const pinPage = await page.evaluate(() => /\/pin\//.test(location.pathname));
  const asPin = ${isPin} || pinPage;
  if (!asPin) {
    // rola só o necessário para carregar ~LIMIT pins do próprio board (evita o feed de recomendações)
    for (let i = 0; i < 25; i++) {
      const n = await page.evaluate(() => { const s = new Set(); document.querySelectorAll('a[href*="/pin/"]').forEach((a) => { const m = (a.getAttribute('href') || '').match(/\/pin\/(\d+)/); if (m) s.add(m[1]); }); return s.size; });
      if (n >= ${limit} + 4) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await new Promise((r) => setTimeout(r, 650));
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  const out = await page.evaluate(async (LIMIT) => {
    const isPinPage = /\/pin\//.test(location.pathname);
    const tiny = /\/(30x30|45x45|60x60|75x75|136x136|140x140)\//;
    const upgrade = (u) => u.replace(/\/(\d+x\d*)(_RS)?\//, '/originals/');
    const verify = (u) => new Promise((res) => { const im = new Image(); im.onload = () => res(true); im.onerror = () => res(false); im.src = u; setTimeout(() => res(false), 4000); });
    const bestFrom = (im) => { let b = im.currentSrc || im.getAttribute('src') || ''; const ss = im.getAttribute('srcset'); if (ss) { const parts = ss.split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean); if (parts.length) b = parts[parts.length - 1]; } if (b.startsWith('//')) b = 'https:' + b; return b; };
    const picks = [];
    if (isPinPage) {
      const og = document.querySelector('meta[property="og:image"]');
      const ogc = og && og.content ? og.content : '';
      if (ogc && /i\.pinimg\.com/.test(ogc)) picks.push({ img: ogc, p: location.href.split('?')[0] });
      if (!picks.length) {
        let best = '', area = 0;
        document.querySelectorAll('img[src*="i.pinimg.com"], img[srcset*="i.pinimg.com"]').forEach((im) => { const a = (im.naturalWidth || 0) * (im.naturalHeight || 0); if (a > area) { area = a; best = bestFrom(im); } });
        if (best) picks.push({ img: best, p: location.href.split('?')[0] });
      }
    } else {
      const seen = new Set();
      const anchors = [...document.querySelectorAll('a[href*="/pin/"]')];
      for (const a of anchors) {
        const m = (a.getAttribute('href') || '').match(/\/pin\/(\d+)/); if (!m) continue;
        const pinId = m[1]; if (seen.has(pinId)) continue;
        let im = a.querySelector('img[src*="i.pinimg.com"], img[srcset*="i.pinimg.com"]');
        if (!im) { const c = a.closest('[data-test-id],[data-grid-item],div'); if (c) im = c.querySelector('img[src*="i.pinimg.com"], img[srcset*="i.pinimg.com"]'); }
        if (!im) continue;
        const best = bestFrom(im);
        if (!best || tiny.test(best)) continue;
        seen.add(pinId);
        picks.push({ img: best, p: 'https://www.pinterest.com/pin/' + pinId + '/' });
        if (picks.length >= LIMIT) break;
      }
    }
    const res = await Promise.all(picks.map(async (it) => { const up = upgrade(it.img); const useUp = up !== it.img ? await verify(up) : false; return { img: useUp ? up : it.img, p: it.p }; }));
    return res;
  }, ${limit});
  return { data: { status, images: out }, type: 'application/json' };
}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function ensureSchema(env: Env): Promise<void> {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS items (
       id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT NOT NULL, captured_at TEXT NOT NULL,
       position INTEGER, product_url TEXT NOT NULL, image_url TEXT NOT NULL, prompt TEXT)`, []);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_items_brand ON items(brand)`, []);
  await env.DB.exec(`ALTER TABLE items ADD COLUMN position INTEGER`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN prompt TEXT`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN gen_job_id TEXT`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN gen_status TEXT`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN gen_mime TEXT`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN gen_image_b64 TEXT`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN gen_url TEXT`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN gen_error TEXT`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN cataloged INTEGER DEFAULT 0`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN cataloged_at TEXT`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN discarded INTEGER DEFAULT 0`, []).catch(() => {});
  await env.DB.exec(`ALTER TABLE items ADD COLUMN discarded_at TEXT`, []).catch(() => {});
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS history (
       id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT NOT NULL, captured_at TEXT NOT NULL,
       position INTEGER, product_url TEXT NOT NULL, image_url TEXT NOT NULL)`, []);
  await env.DB.exec(`ALTER TABLE history ADD COLUMN position INTEGER`, []).catch(() => {});
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`, []);
  // limpeza única: manter só a 1ª imagem (menor id) de cada produto por marca
  const dedupDone = (await env.DB.query(`SELECT v FROM settings WHERE k = 'dedup_first_image_v1'`, [])).rows[0];
  if (!dedupDone) {
    await env.DB.exec(`DELETE FROM items WHERE id NOT IN (SELECT MIN(id) FROM items GROUP BY brand, product_url)`, []);
    await env.DB.exec(`INSERT INTO settings (k, v) VALUES ('dedup_first_image_v1', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v`, []);
  }
  // chunks da imagem gerada (permanente, sem limite de tamanho de linha)
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS img_chunks (image_url TEXT NOT NULL, idx INTEGER NOT NULL, b64 TEXT NOT NULL)`, []);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_imgchunks ON img_chunks(image_url)`, []);
  // reset único das imagens que ficaram na URL temporária (quebram ao expirar) -> regeneram como chunks
  const resetDone = (await env.DB.query(`SELECT v FROM settings WHERE k = 'reset_urlfallback_v1'`, [])).rows[0];
  if (!resetDone) {
    await env.DB.exec(`UPDATE items SET gen_status = NULL, gen_url = NULL, gen_job_id = NULL WHERE gen_url IS NOT NULL`, []);
    await env.DB.exec(`INSERT INTO settings (k, v) VALUES ('reset_urlfallback_v1', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v`, []);
  }
  // Gocase: marca para recapturar (remove os 3 modelos descartados; carry-over preserva o resto)
  const gocaseRefilter = (await env.DB.query(`SELECT v FROM settings WHERE k = 'gocase_refilter_v1'`, [])).rows[0];
  if (!gocaseRefilter) {
    await env.DB.exec(`UPDATE items SET position = NULL WHERE brand = 'gocase'`, []);
    await env.DB.exec(`INSERT INTO settings (k, v) VALUES ('gocase_refilter_v1', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v`, []);
  }
}

async function setSetting(env: Env, k: string, v: string): Promise<void> {
  await env.DB.exec(`INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, v]);
}
async function getSetting(env: Env, k: string): Promise<string | null> {
  const r = await env.DB.query(`SELECT v FROM settings WHERE k = ?`, [k]);
  return (r.rows[0]?.v as string) ?? null;
}

async function pushToSheets(env: Env, brand: Brand, capturedAt: string, pairs: { pos?: number; p: string; i: string }[]): Promise<{ ok: boolean; detail?: string }> {
  if (!env.SHEETS_WEBHOOK) return { ok: false, detail: 'sem webhook' };
  const rows = pairs.map((x) => [brand.name, capturedAt, x.pos ?? '', x.p, x.i]);
  try {
    const res = await fetch(env.SHEETS_WEBHOOK, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: env.SHEETS_KEY || '', brand: brand.name, replace: true, rows }), redirect: 'follow',
    });
    return { ok: res.ok, detail: (await res.text()).slice(0, 160) };
  } catch (e) {
    return { ok: false, detail: String((e as Error).message || e) };
  }
}

// modo products.json (Shopify): GET direto, sem browserless — evita ruído de menu/lazy
async function collectShopifyJson(brand: Brand): Promise<{ pos: number; p: string; i: string }[]> {
  const base = brand.url.split('?')[0].replace(/\/$/, '');
  const origin = new URL(brand.url).origin;
  const cap = brand.limit || MAX_ITEMS;
  const res = await fetch(`${base}/products.json?limit=${cap}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`products.json HTTP ${res.status}`);
  const j = (await res.json()) as { products?: { handle?: string; images?: { src?: string }[] }[] };
  const out: { pos: number; p: string; i: string }[] = [];
  let pos = 0;
  for (const p of j.products || []) {
    const img = p.images && p.images[0] && p.images[0].src;
    if (!img || !p.handle) continue;
    pos++;
    out.push({ pos, p: `${origin}/products/${p.handle}`, i: img });
    if (pos >= cap) break;
  }
  return out;
}

async function scrapeBrand(env: Env, brand: Brand): Promise<Response> {
  await ensureSchema(env);
  let rawPairs: { pos?: number; p: string; i: string }[] = [];
  let pageStatus: number | null = null;
  try {
    if (brand.mode === 'shopifyjson') {
      rawPairs = await collectShopifyJson(brand);
    } else {
      if (!env.BROWSERLESS_URL || !env.BROWSERLESS_TOKEN) return json({ error: 'browserless não configurado' }, 500);
      const endpoint = `${env.BROWSERLESS_URL.replace(/\/$/, '')}/function?token=${env.BROWSERLESS_TOKEN}`;
      const code = brand.mode === 'casetify' ? casetifyCode(brand.url) : brand.mode === 'gocase' ? gocaseCode(brand.url) : shopifyCode(brand.url);
      // browserless (Heroku) é intermitente (500/502, limite de 30s) — tenta algumas vezes e fica com a melhor captura
      let lastErr = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/javascript' }, body: code });
          if (!res.ok) { lastErr = `browserless HTTP ${res.status}`; await new Promise((r) => setTimeout(r, 800)); continue; }
          const text = await res.text();
          let payload: { data?: { status?: number; pairs?: { pos?: number; p: string; i: string }[] } };
          try { payload = JSON.parse(text); } catch { lastErr = 'browserless devolveu não-JSON'; await new Promise((r) => setTimeout(r, 800)); continue; }
          const got = payload?.data?.pairs || [];
          pageStatus = payload?.data?.status ?? null;
          if (got.length > rawPairs.length) rawPairs = got;
          if (rawPairs.length >= 5) break; // captura saudável
          lastErr = `poucos itens (${rawPairs.length})`;
        } catch (e) { lastErr = String((e as Error).message || e); }
        await new Promise((r) => setTimeout(r, 800));
      }
      if (rawPairs.length === 0) { console.log(`scrape ${brand.key} FALHOU browserless: ${lastErr}`); return json({ error: 'falha browserless após retries', detail: lastErr, brand: brand.key }, 502); }
    }
  } catch (e) {
    const detail = String((e as Error).message || e);
    console.log(`scrape ${brand.key} FALHOU (exceção): ${detail}`);
    return json({ error: 'falha na captura', detail }, 502);
  }

  const seen = new Set<string>();
  // dedup por imagem, preserva a ordem de captura (= ranking de mais vendidos)
  const capturedPairs = rawPairs.filter((x) => x && x.i && !seen.has(x.i) && seen.add(x.i));
  if (capturedPairs.length === 0) { console.log(`scrape ${brand.key} FALHOU: 0 pares (pageStatus ${pageStatus})`); return json({ error: 'nenhum mockup capturado', brand: brand.key, pageStatus }, 502); }

  const capturedAt = new Date().toISOString();
  let pairs: { pos?: number; p: string; i: string }[] = [];
  let skipped = 0;
  try {
    // linhas já DECIDIDAS (cadastradas ou descartadas) dessa marca: nunca são apagadas nem recriadas aqui
    // (as abas "Adaptações feitas"/"Lixo" dependem delas existirem) e não disputam vaga no teto de BOARD_CAP —
    // assim uma estampa já resolvida não "prende" a posição de uma estampa nova.
    // Casa por product_url (não por image_url): a imagem em CDNs como o imagekit do Gocase pode vir com
    // querystring de render diferente a cada captura (lazy-load/tamanho variam), então casar por image_url
    // deixa a mesma estampa escapar da exclusão e voltar pro quadro já cadastrada/descartada.
    const decided = await env.DB.query(`SELECT product_url FROM items WHERE brand = ? AND (cataloged = 1 OR discarded = 1)`, [brand.key]);
    const decidedUrls = new Set((decided.rows || []).map((r) => r.product_url as string));
    skipped = capturedPairs.filter((x) => decidedUrls.has(x.p)).length;
    // corta nos primeiros BOARD_CAP já SEM contar as que já foram cadastradas/descartadas
    pairs = capturedPairs.filter((x) => !decidedUrls.has(x.p)).slice(0, brand.limit || BOARD_CAP);

    // preserva prompt/estampa dos itens em aberto cujo produto não mudou (evita regenerar tudo no refresh).
    // NÃO seleciona gen_image_b64 (blob base64 pesado, pode estourar limite do D1): a imagem completa
    // já vive em img_chunks (servida de lá por image_url, que é preservado). Só carrega metadados.
    const prevOpen = await env.DB.query(`SELECT product_url, prompt, gen_job_id, gen_status, gen_mime, gen_url FROM items WHERE brand = ? AND (cataloged IS NULL OR cataloged = 0) AND (discarded IS NULL OR discarded = 0)`, [brand.key]);
    const prevByUrl = new Map((prevOpen.rows || []).map((r) => [r.product_url as string, r as Record<string, unknown>]));
    // apaga só as linhas EM ABERTO — cadastradas/descartadas ficam intactas
    await env.DB.exec(`DELETE FROM items WHERE brand = ? AND (cataloged IS NULL OR cataloged = 0) AND (discarded IS NULL OR discarded = 0)`, [brand.key]);
    for (const x of pairs) {
      const o = prevByUrl.get(x.p) || {};
      await env.DB.exec(`INSERT INTO items (brand, captured_at, position, product_url, image_url, prompt, gen_job_id, gen_status, gen_mime, gen_url, cataloged, cataloged_at, discarded, discarded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL)`, [brand.key, capturedAt, x.pos ?? null, x.p, x.i, (o.prompt as string) ?? null, (o.gen_job_id as string) ?? null, (o.gen_status as string) ?? null, (o.gen_mime as string) ?? null, (o.gen_url as string) ?? null]);
      await env.DB.exec(`INSERT INTO history (brand, captured_at, position, product_url, image_url) VALUES (?, ?, ?, ?, ?)`, [brand.key, capturedAt, x.pos ?? null, x.p, x.i]);
    }
  } catch (e) {
    const detail = String((e as Error).message || e);
    console.log(`scrape ${brand.key} FALHOU gravação: ${detail}`);
    return json({ error: 'falha ao gravar no banco', detail, brand: brand.key }, 502);
  }
  // se não sobrou nenhum item novo (tudo que veio já tinha sido cadastrado/descartado), não sobrescreve a planilha com vazio
  const sheets = pairs.length ? await pushToSheets(env, brand, capturedAt, pairs) : { ok: true, detail: 'sem itens novos' };
  console.log(`scrape ${brand.key}: ${pairs.length} itens novos (${skipped} já cadastrada/descartada ignorada${skipped === 1 ? '' : 's'}), sheets=${sheets.ok}`);
  return json({ brand: brand.key, name: brand.name, captured_at: capturedAt, count: pairs.length, skipped_already_reviewed: skipped, sheets });
}

// Board do Pinterest via feed RSS (público): pega EXATAMENTE os pins da pasta, na ordem,
// sem browserless e sem o feed de recomendações. Sobe para /originals/ (com fallback 736x).
async function collectPinterestBoard(rawUrl: string): Promise<{ img: string; p: string }[]> {
  const base = rawUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const res = await fetch(`${base}.rss`, { headers: { 'user-agent': UA, accept: 'application/rss+xml, text/xml' } });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const raw: { link: string; img236: string }[] = [];
  for (const m of items) {
    const it = m[1];
    const link = ((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim();
    const desc = (it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
    const un = desc.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const img = (un.match(/<img[^>]+src="([^"]+)"/) || [])[1] || '';
    if (!img) continue;
    raw.push({ link: link || rawUrl, img236: img });
    if (raw.length >= 30) break;
  }
  return Promise.all(raw.map(async (r) => {
    const orig = r.img236.replace(/\/\d+x\d*\//, '/originals/');
    let ok = false;
    try { const h = await fetch(orig, { headers: { 'user-agent': UA } }); ok = h.ok && (h.headers.get('content-type') || '').startsWith('image'); } catch (e) {}
    return { p: r.link, img: ok ? orig : r.img236.replace(/\/\d+x\d*\//, '/736x/') };
  }));
}

// Pinterest: capta imagens de um board (via RSS) ou pin (via og:image) e grava como itens brand='pinterest'.
async function scrapePinterest(env: Env, rawUrl: string): Promise<Response> {
  await ensureSchema(env);
  let u: URL;
  try { u = new URL(rawUrl); } catch { return json({ error: 'URL inválida' }, 400); }
  if (!/pinterest\.|pin\.it/i.test(u.hostname)) return json({ error: 'informe uma URL do Pinterest (board ou pin)' }, 400);
  const isPin = /\/pin\//.test(u.pathname) || /pin\.it$/i.test(u.hostname);
  let images: { img: string; p: string }[] = [];
  try {
    if (isPin) {
      // pin individual: og:image via browserless
      if (!env.BROWSERLESS_URL || !env.BROWSERLESS_TOKEN) return json({ error: 'browserless não configurado' }, 500);
      const endpoint = `${env.BROWSERLESS_URL.replace(/\/$/, '')}/function?token=${env.BROWSERLESS_TOKEN}`;
      const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/javascript' }, body: pinterestCode(rawUrl, 1, true) });
      if (!res.ok) return json({ error: `browserless HTTP ${res.status}`, detail: (await res.text()).slice(0, 200) }, 502);
      const text = await res.text();
      let payload: { data?: { status?: number; images?: { img: string; p: string }[] } };
      try { payload = JSON.parse(text); } catch { return json({ error: 'browserless devolveu não-JSON', detail: text.slice(0, 200) }, 502); }
      images = payload?.data?.images || [];
    } else {
      // board: RSS público -> exatamente os pins da pasta
      images = await collectPinterestBoard(rawUrl);
    }
  } catch (e) {
    return json({ error: 'falha na captura', detail: String((e as Error).message || e) }, 502);
  }

  const seen = new Set<string>();
  const pics = images.filter((x) => x && x.img && !seen.has(x.img) && seen.add(x.img));
  if (pics.length === 0) return json({ error: 'nenhuma imagem captada (board privado, login exigido ou layout mudou)' }, 502);

  const capturedAt = new Date().toISOString();
  // preserva prompt/geração/cadastro/descarte das imagens que se repetem entre capturas
  const prev = await env.DB.query(`SELECT image_url, prompt, gen_job_id, gen_status, gen_mime, cataloged, cataloged_at, discarded, discarded_at FROM items WHERE brand = 'pinterest'`, []);
  const prevByImg = new Map((prev.rows || []).map((r) => [r.image_url as string, r as Record<string, unknown>]));
  await env.DB.exec(`DELETE FROM items WHERE brand = 'pinterest'`, []);
  let pos = 0;
  for (const x of pics) {
    pos++;
    const o = prevByImg.get(x.img) || {};
    await env.DB.exec(`INSERT INTO items (brand, captured_at, position, product_url, image_url, prompt, gen_job_id, gen_status, gen_mime, cataloged, cataloged_at, discarded, discarded_at) VALUES ('pinterest', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [capturedAt, pos, x.p || rawUrl, x.img, (o.prompt as string) ?? null, (o.gen_job_id as string) ?? null, (o.gen_status as string) ?? null, (o.gen_mime as string) ?? null, (o.cataloged as number) ?? 0, (o.cataloged_at as string) ?? null, (o.discarded as number) ?? 0, (o.discarded_at as string) ?? null]);
  }
  console.log(`pinterest ${isPin ? 'pin' : 'board'}: ${pics.length} imagens de ${rawUrl}`);
  return json({ key: 'pinterest', kind: isPin ? 'pin' : 'board', count: pics.length, source: rawUrl, captured_at: capturedAt });
}

async function generatePrompt(env: Env, id: number): Promise<Response> {
  await ensureSchema(env);
  const row = await env.DB.query(`SELECT id, image_url, prompt, brand FROM items WHERE id = ?`, [id]);
  if (!row.rows.length) return json({ error: 'item não encontrado' }, 404);
  const existing = row.rows[0].prompt as string | null;
  if (existing) return json({ id, prompt: existing, cached: true });
  if (!env.AI_PROXY_TOKEN) return json({ error: 'AI_PROXY_TOKEN não configurado' }, 500);
  const imageUrl = row.rows[0].image_url as string;
  const system = (row.rows[0].brand as string) === 'pinterest' ? PROMPT_SYSTEM_PINTEREST : PROMPT_SYSTEM;
  const endpoint = env.AI_PROXY_URL || 'https://ai-proxy.gogroupbr.com/v1/chat/completions';
  const model = env.AI_MODEL || 'gpt-5.5';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_PROXY_TOKEN}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [
            { type: 'text', text: 'Write the image-generation prompt for the artwork in this image, following the rules.' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ] },
        ],
      }),
    });
    if (!res.ok) return json({ error: `proxy HTTP ${res.status}`, detail: (await res.text()).slice(0, 300) }, 502);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const prompt = (j.choices?.[0]?.message?.content || '').trim();
    if (!prompt) return json({ error: 'prompt vazio' }, 502);
    await env.DB.exec(`UPDATE items SET prompt = ? WHERE id = ?`, [prompt, id]);
    return json({ id, prompt, cached: false });
  } catch (e) {
    return json({ error: 'falha ao gerar prompt', detail: String((e as Error).message || e) }, 502);
  }
}

// máquina de estados da imagem gerada (assíncrona): dispara job -> poll -> baixa e cacheia bytes
async function generateImage(env: Env, id: number): Promise<Response> {
  await ensureSchema(env);
  const r = await env.DB.query(
    `SELECT id, image_url, prompt, gen_job_id, gen_status FROM items WHERE id = ?`, [id]);
  if (!r.rows.length) return json({ error: 'item não encontrado' }, 404);
  const row = r.rows[0] as Record<string, unknown>;
  let status = (row.gen_status as string) || null;
  const imageUrl = row.image_url as string;
  let jobId = row.gen_job_id as string | null;
  if (status === 'completed') {
    // confirma que os bytes realmente existem — uma geração anterior pode ter sido
    // marcada 'completed' sem terminar de gravar os chunks (ex.: timeout no meio da gravação),
    // deixando a estampa "quebrada" (sem imagem pra servir). Nesse caso, força nova geração.
    const has = await env.DB.query(`SELECT 1 AS x FROM img_chunks WHERE image_url = ? LIMIT 1`, [imageUrl]);
    if (has.rows.length) return json({ id, status: 'completed' });
    await env.DB.exec(`UPDATE items SET gen_status = NULL, gen_job_id = NULL, gen_url = NULL, gen_error = NULL WHERE id = ?`, [id]);
    status = null; jobId = null;
  }
  if (!env.PIAPP_TOKEN) return json({ error: 'PIAPP_TOKEN não configurado' }, 500);
  const base = (env.PIAPP_URL || 'https://piapp-v2.vercel.app/api/v1').replace(/\/$/, '');
  const auth = { authorization: `Bearer ${env.PIAPP_TOKEN}` };

  try {
    // 1) sem job ainda -> precisa do prompt -> dispara geração
    if (!jobId) {
      const prompt = row.prompt as string | null;
      if (!prompt) return json({ id, status: 'need_prompt' });
      const genPrompt = `${prompt}\n\nImportant: seamless decorative artwork only, as a flat full-bleed pattern. Absolutely no text, letters, words, numbers, logos, brand names, watermarks or signatures anywhere in the image. No phone-case hardware: no MagSafe ring, no circular magnet ring, no camera cutout or lens rings, no button/port cutouts, no holes and no device shapes.`;
      const res = await fetch(`${base}/generate-image`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ prompt: genPrompt, aspect_ratio: '9:16' }),
      });
      if (!res.ok) return json({ error: `piapp HTTP ${res.status}`, detail: (await res.text()).slice(0, 200) }, 502);
      const j = (await res.json()) as { job_id?: string };
      if (!j.job_id) return json({ error: 'piapp sem job_id' }, 502);
      await env.DB.exec(`UPDATE items SET gen_job_id = ?, gen_status = 'queued', gen_error = NULL WHERE id = ?`, [j.job_id, id]);
      return json({ id, status: 'queued' });
    }

    // 2) tem job -> consulta status
    const res = await fetch(`${base}/jobs?ids=${encodeURIComponent(jobId)}`, { headers: auth });
    if (!res.ok) return json({ id, status: status || 'processing', detail: `poll HTTP ${res.status}` });
    const s = (await res.json()) as { jobs?: { status?: string; output_url?: string; error?: string }[] };
    const job = (s.jobs && s.jobs[0]) || {};
    if (job.status === 'failed') {
      await env.DB.exec(`UPDATE items SET gen_status = 'failed', gen_error = ? WHERE id = ?`, [String(job.error || 'falhou'), id]);
      return json({ id, status: 'failed', error: job.error || 'falhou' });
    }
    if (job.status !== 'completed' || !job.output_url) {
      return json({ id, status: job.status || 'processing' });
    }
    // 3) completou -> baixa os bytes e cacheia em CHUNKS (permanente; a URL assinada expira em ~1h)
    const img = await fetch(job.output_url);
    if (!img.ok) return json({ id, status: 'processing', detail: `img HTTP ${img.status}` });
    const mime = img.headers.get('content-type') || 'image/png';
    const bytes = new Uint8Array(await img.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    const CHUNK = 800_000; // < limite de 2MB por linha do SQLite
    await env.DB.exec(`DELETE FROM img_chunks WHERE image_url = ?`, [imageUrl]);
    let ci = 0;
    for (let off = 0; off < b64.length; off += CHUNK, ci++) {
      await env.DB.exec(`INSERT INTO img_chunks (image_url, idx, b64) VALUES (?, ?, ?)`, [imageUrl, ci, b64.slice(off, off + CHUNK)]);
    }
    await env.DB.exec(`UPDATE items SET gen_status = 'completed', gen_mime = ?, gen_url = NULL, gen_image_b64 = NULL WHERE id = ?`, [mime, id]);
    return json({ id, status: 'completed' });
  } catch (e) {
    return json({ error: 'falha na geração de imagem', detail: String((e as Error).message || e) }, 502);
  }
}

function b64ToResponse(b64: string, mime: string): Response {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'content-type': mime, 'cache-control': 'public, max-age=604800' } });
}

async function serveImage(env: Env, id: number): Promise<Response> {
  await ensureSchema(env);
  const r = await env.DB.query(`SELECT image_url, gen_image_b64, gen_mime, gen_url FROM items WHERE id = ?`, [id]);
  if (!r.rows.length) return new Response('not found', { status: 404 });
  const row = r.rows[0] as Record<string, unknown>;
  const mime = (row.gen_mime as string) || 'image/png';
  // chunks (permanente, chaveado por image_url — sobrevive ao refresh)
  const ch = await env.DB.query(`SELECT b64 FROM img_chunks WHERE image_url = ? ORDER BY idx`, [row.image_url]);
  if (ch.rows.length) return b64ToResponse(ch.rows.map((c) => c.b64 as string).join(''), mime);
  // legado: base64 inline pequeno
  if (row.gen_image_b64) return b64ToResponse(row.gen_image_b64 as string, mime);
  // legado: URL temporária (pode ter expirado)
  if (row.gen_url) return Response.redirect(row.gen_url as string, 302);
  return new Response('not ready', { status: 404 });
}

async function apiBrands(env: Env): Promise<Response> {
  await ensureSchema(env);
  const out = [];
  for (const b of BRANDS) {
    const r = await env.DB.query(`SELECT COUNT(*) AS c, MAX(captured_at) AS m FROM items WHERE brand = ? AND (cataloged IS NULL OR cataloged = 0) AND (discarded IS NULL OR discarded = 0)`, [b.key]);
    out.push({ key: b.key, name: b.name, url: b.url, kind: 'brand', count: Number(r.rows[0]?.c || 0), captured_at: (r.rows[0]?.m as string) || null });
  }
  // fonte extra: Pinterest (não é marca; alimentada por URL sob demanda)
  const p = await env.DB.query(`SELECT COUNT(*) AS c, MAX(captured_at) AS m FROM items WHERE brand = 'pinterest' AND (cataloged IS NULL OR cataloged = 0) AND (discarded IS NULL OR discarded = 0)`, []);
  out.push({ key: 'pinterest', name: 'Pinterest', url: null, kind: 'pinterest', count: Number(p.rows[0]?.c || 0), captured_at: (p.rows[0]?.m as string) || null });
  // aba de adaptações já feitas (estampas marcadas como cadastradas, de todas as marcas)
  const c = await env.DB.query(`SELECT COUNT(*) AS c, MAX(cataloged_at) AS m FROM items WHERE cataloged = 1`, []);
  out.push({ key: '__cataloged__', name: 'Adaptações feitas', url: null, kind: 'cataloged', count: Number(c.rows[0]?.c || 0), captured_at: (c.rows[0]?.m as string) || null });
  // lixeira (estampas descartadas por ficarem ruins, de todas as marcas)
  const t = await env.DB.query(`SELECT COUNT(*) AS c, MAX(discarded_at) AS m FROM items WHERE discarded = 1`, []);
  out.push({ key: '__discarded__', name: 'Lixo', url: null, kind: 'discarded', count: Number(t.rows[0]?.c || 0), captured_at: (t.rows[0]?.m as string) || null });
  return json({ brands: out });
}

async function apiBrand(env: Env, key: string): Promise<Response> {
  await ensureSchema(env);
  const b = key === 'pinterest' ? { key: 'pinterest', name: 'Pinterest', url: null as string | null } : byKey(key);
  if (!b) return json({ error: 'marca inválida' }, 404);
  const r = await env.DB.query(
    `SELECT id, position, product_url, image_url, prompt, gen_status, captured_at FROM items WHERE brand = ? AND (cataloged IS NULL OR cataloged = 0) AND (discarded IS NULL OR discarded = 0) ORDER BY position IS NULL, position, id`, [b.key]);
  const captured_at = r.rows.length ? (r.rows[0].captured_at as string) : null;
  return json({ key: b.key, name: b.name, url: b.url, kind: key === 'pinterest' ? 'pinterest' : 'brand', captured_at, count: r.rows.length, items: r.rows });
}

// lista as estampas já marcadas como cadastradas, de qualquer marca, mais recentes primeiro
async function apiCataloged(env: Env): Promise<Response> {
  await ensureSchema(env);
  const r = await env.DB.query(
    `SELECT id, brand, position, product_url, image_url, prompt, gen_status, captured_at, cataloged_at FROM items WHERE cataloged = 1 ORDER BY cataloged_at DESC, id DESC`, []);
  const items = r.rows.map((row) => {
    const brandKey = row.brand as string;
    const brandName = brandKey === 'pinterest' ? 'Pinterest' : (byKey(brandKey)?.name || brandKey);
    return { ...row, brand_name: brandName };
  });
  return json({ key: '__cataloged__', name: 'Adaptações feitas', kind: 'cataloged', count: items.length, items });
}

// lista as estampas descartadas (feias/ruins), de qualquer marca, mais recentes primeiro
async function apiDiscarded(env: Env): Promise<Response> {
  await ensureSchema(env);
  const r = await env.DB.query(
    `SELECT id, brand, position, product_url, image_url, prompt, gen_status, captured_at, discarded_at FROM items WHERE discarded = 1 ORDER BY discarded_at DESC, id DESC`, []);
  const items = r.rows.map((row) => {
    const brandKey = row.brand as string;
    const brandName = brandKey === 'pinterest' ? 'Pinterest' : (byKey(brandKey)?.name || brandKey);
    return { ...row, brand_name: brandName };
  });
  return json({ key: '__discarded__', name: 'Lixo', kind: 'discarded', count: items.length, items });
}

// marca/desmarca uma estampa como já cadastrada (some do quadro da marca / volta pra ele)
async function setCataloged(env: Env, id: number, value: boolean): Promise<Response> {
  await ensureSchema(env);
  const row = await env.DB.query(`SELECT id FROM items WHERE id = ?`, [id]);
  if (!row.rows.length) return json({ error: 'item não encontrado' }, 404);
  if (value) {
    await env.DB.exec(`UPDATE items SET cataloged = 1, cataloged_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  } else {
    await env.DB.exec(`UPDATE items SET cataloged = 0, cataloged_at = NULL WHERE id = ?`, [id]);
  }
  return json({ id, cataloged: value });
}

// descarta/restaura uma estampa (feia/gerada errada) — some do quadro da marca / volta pra ele
async function setDiscarded(env: Env, id: number, value: boolean): Promise<Response> {
  await ensureSchema(env);
  const row = await env.DB.query(`SELECT id FROM items WHERE id = ?`, [id]);
  if (!row.rows.length) return json({ error: 'item não encontrado' }, 404);
  if (value) {
    await env.DB.exec(`UPDATE items SET discarded = 1, discarded_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  } else {
    await env.DB.exec(`UPDATE items SET discarded = 0, discarded_at = NULL WHERE id = ?`, [id]);
  }
  return json({ id, discarded: value });
}

// semana do mês -> marca (1..5)
function brandForNow(): Brand | null {
  const day = new Date().getUTCDate();
  const week = Math.ceil(day / 7);
  return BRANDS[week - 1] || null;
}
function isLastDayOfMonthUTC(): boolean {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.getUTCDate() === 1;
}

// escolhe a próxima marca a (re)capturar, em rodízio — nunca martela uma só
async function nextSeedTarget(env: Env): Promise<Brand | null> {
  const candidates: Brand[] = [];
  for (const b of BRANDS) {
    const c = await env.DB.query(`SELECT COUNT(*) AS c, SUM(CASE WHEN position IS NULL THEN 1 ELSE 0 END) AS nulls FROM items WHERE brand = ?`, [b.key]);
    if (Number(c.rows[0]?.c || 0) === 0 || Number(c.rows[0]?.nulls || 0) > 0) candidates.push(b);
  }
  if (!candidates.length) return null;
  let target = candidates[0], oldest = Infinity;
  for (const b of candidates) {
    const ts = Number((await getSetting(env, `seed_ts_${b.key}`)) || 0);
    if (ts < oldest) { oldest = ts; target = b; }
  }
  await setSetting(env, `seed_ts_${target.key}`, String(Date.now()));
  return target;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === '/api/brands') return await apiBrands(env);
      if (pathname === '/api/brand') return await apiBrand(env, url.searchParams.get('key') || '');
      // botão "Atualizar agora" de cada aba: recaptura sob demanda só a marca pedida (respeita BOARD_CAP e ignora já cadastradas/descartadas)
      if (pathname === '/api/refresh' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { key?: string };
        const b = byKey(String(body.key || ''));
        if (!b) return json({ error: 'marca inválida' }, 400);
        return await scrapeBrand(env, b);
      }
      // botão "Atualizar todas" da barra lateral: recaptura todas as marcas de uma vez (respeitando BOARD_CAP
      // e ignorando já cadastradas/descartadas, igual ao /api/refresh individual), com opção de excluir marcas
      // com captura sabidamente quebrada (ex.: Gocase) sem precisar mexer no cron de fundo.
      if (pathname === '/api/refresh-all' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { exclude?: string[] };
        const exclude = new Set((Array.isArray(body.exclude) ? body.exclude : []).map(String));
        const targets = BRANDS.filter((b) => !exclude.has(b.key));
        const out: Record<string, { status: number; count?: number; skipped?: number; error?: string }> = {};
        const run = async (b: Brand) => {
          try {
            const r = await scrapeBrand(env, b);
            const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
            out[b.key] = { status: r.status, count: j.count as number, skipped: j.skipped_already_reviewed as number, error: j.error as string };
          } catch (e) {
            out[b.key] = { status: 0, error: String((e as Error).message || e) };
          }
        };
        const jsonBrands = targets.filter((b) => b.mode === 'shopifyjson');
        const browserBrands = targets.filter((b) => b.mode !== 'shopifyjson');
        await Promise.allSettled(jsonBrands.map(run)); // rápidos, sem browserless
        for (const b of browserBrands) { await run(b); } // 1 por vez: o dyno Chromium cai (503) sob concorrência
        return json({ refreshed_at: new Date().toISOString(), excluded: [...exclude], brands: out });
      }
      if (pathname === '/api/cataloged') return await apiCataloged(env);
      if (pathname === '/api/catalog' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { id?: number; value?: boolean };
        if (!body.id) return json({ error: 'id obrigatório' }, 400);
        return await setCataloged(env, Number(body.id), body.value !== false);
      }
      if (pathname === '/api/discarded') return await apiDiscarded(env);
      if (pathname === '/api/discard' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { id?: number; value?: boolean };
        if (!body.id) return json({ error: 'id obrigatório' }, 400);
        return await setDiscarded(env, Number(body.id), body.value !== false);
      }
      if (pathname === '/api/pinterest' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { url?: string };
        if (!body.url) return json({ error: 'url obrigatória' }, 400);
        return await scrapePinterest(env, String(body.url));
      }
      if (pathname === '/api/prompt' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { id?: number };
        if (!body.id) return json({ error: 'id obrigatório' }, 400);
        return await generatePrompt(env, Number(body.id));
      }
      if (pathname === '/api/generate' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { id?: number };
        if (!body.id) return json({ error: 'id obrigatório' }, 400);
        return await generateImage(env, Number(body.id));
      }
      if (pathname === '/img') {
        const idp = url.searchParams.get('id');
        if (!idp) return new Response('id obrigatório', { status: 400 });
        return await serveImage(env, Number(idp));
      }

      if (pathname === '/tasks/weekly' && request.method === 'POST') {
        const b = brandForNow();
        if (!b) return json({ skipped: 'sem marca para esta semana' });
        return await scrapeBrand(env, b);
      }
      if (pathname === '/tasks/monthly' && request.method === 'POST') {
        if (!isLastDayOfMonthUTC()) return json({ skipped: 'não é o último dia do mês' });
        return await scrapeBrand(env, byKey(CASEMATE)!);
      }
      // recaptura manual, sob demanda, só da aba Gocase — pega o que está no site AGORA (estampas novas entram, substitui o snapshot)
      if (pathname === '/tasks/scrape-gocase' && request.method === 'POST') {
        return await scrapeBrand(env, byKey('gocase')!);
      }
      // atualiza TODAS as marcas (cron de domingo). shopifyjson em paralelo (rápido);
      // browserless em lotes pequenos p/ não sobrecarregar o único dyno Chromium (evita timeouts/cancelamentos).
      if (pathname === '/tasks/refresh-all' && request.method === 'POST') {
        await ensureSchema(env);
        const pre = await env.DB.query(`SELECT brand, COUNT(*) AS c FROM items GROUP BY brand`, []);
        console.log('refresh-all counts@start: ' + JSON.stringify((pre.rows || []).reduce((a: Record<string, number>, r) => { a[r.brand as string] = Number(r.c); return a; }, {})));
        const out: Record<string, string> = {};
        const run = async (b: Brand) => { try { const r = await scrapeBrand(env, b); out[b.key] = String(r.status); } catch (e) { out[b.key] = 'error'; } };
        const jsonBrands = BRANDS.filter((b) => b.mode === 'shopifyjson');
        const browserBrands = BRANDS.filter((b) => b.mode !== 'shopifyjson');
        await Promise.allSettled(jsonBrands.map(run)); // rápidos, sem browserless
        for (const b of browserBrands) { await run(b); } // 1 por vez: o dyno Chromium cai (503) sob concorrência
        console.log('refresh-all counts@end: ' + JSON.stringify(out));
        return json({ refreshed_at: new Date().toISOString(), brands: out });
      }

      // seed em rodízio: limpa marcas órfãs e captura a próxima marca sem dados/posição
      if (pathname === '/tasks/seed' && request.method === 'POST') {
        await ensureSchema(env);
        const valid = BRANDS.map((b) => b.key).concat('pinterest'); // pinterest é fonte válida, não apagar
        await env.DB.exec(`DELETE FROM items WHERE brand NOT IN (${valid.map(() => '?').join(',')})`, valid);
        const target = await nextSeedTarget(env);
        if (!target) return json({ done: 'todas as marcas atualizadas' });
        return await scrapeBrand(env, target);
      }

      // recaptura em rodízio TODAS as marcas, uma por chamada (rotação por timestamp mais antigo).
      // Evita a sobrecarga do refresh-all paralelo: cada marca usa o browserless sozinha.
      if (pathname === '/tasks/recapture' && request.method === 'POST') {
        await ensureSchema(env);
        let target = BRANDS[0], oldest = Infinity;
        for (const b of BRANDS) {
          const ts = Number((await getSetting(env, `recap_ts_${b.key}`)) || 0);
          if (ts < oldest) { oldest = ts; target = b; }
        }
        const resp = await scrapeBrand(env, target);
        // sucesso -> agenda pro fim da fila; falha -> mantém quase no topo p/ retentar logo (motivo já logado no scrapeBrand)
        await setSetting(env, `recap_ts_${target.key}`, String(resp.status === 200 ? Date.now() : Date.now() - 3 * 86400000));
        return resp;
      }
    } catch (e) {
      return json({ error: 'erro interno', detail: String((e as Error).message || e) }, 500);
    }
    return new Response('Not found', { status: 404 });
  },
};
