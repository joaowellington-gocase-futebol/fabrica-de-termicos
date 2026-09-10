// T1 · motor de rapport. Porte fiel de `layoutCompute`/`wrapOffsets`/`composeFrom` do
// `gerador-de-adaptacoes` (dona: ravenna.alencar) — ver docs/MAPA-ATIVOS.md §1. Trocado
// canvas de DOM por RGBABuffer (precisa rodar num Worker, sem document). Determinístico:
// o rapport nunca passa por modelo generativo (README "O achado que define a arquitetura").
import type { Camada, ConfigComposicao, Mascara, OffsetRapport, ResultadoLayout, TransformCamada } from './tipos.js';
import { compositar, criarBuffer, girar, redimensionar } from './pixels.js';
import type { RGBABuffer } from './tipos.js';

const LIMIAR_SPANNING = 0.85;

/** Camada que já cobre quase toda a arte original — vira "fundo"/textura de preenchimento em vez de motivo. */
export function ehSpanning(c: Camada, larguraOriginal: number, alturaOriginal: number): boolean {
  return c.ow >= larguraOriginal * LIMIAR_SPANNING && c.oh >= alturaOriginal * LIMIAR_SPANNING;
}

/** Guias de fonte (kind 'fonte', personalização) ficam fora do arranjo: sempre centralizadas, tamanho fixo. */
function posicionaGuias(guias: Camada[], W: number, H: number, T: Map<Camada, TransformCamada>): void {
  for (const g of guias) {
    const s = Math.min((W * 0.45) / g.ow, (H * 0.35) / g.oh);
    const w = g.ow * s;
    const h = g.oh * s;
    T.set(g, { w, h, x: (W - w) / 2, y: (H - h) / 2 });
  }
}

/**
 * Preenche SEM sobrepor: grade 1-motivo-por-célula com respiro.
 * stagger=true desloca linhas ímpares meia célula (estilo "distribuido"/xadrez).
 */
export function fillGridNoOverlap(
  motivos: Camada[],
  W: number,
  H: number,
  T: Map<Camada, TransformCamada>,
  stagger = false,
): void {
  const n = motivos.length;
  if (!n) return;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * W) / H))));
  const rows = Math.ceil(n / cols);
  const cellW = W / cols;
  const cellH = H / rows;
  const margem = 0.76;
  const ordenados = motivos
    .slice()
    .sort((a, b) => a.oy + a.oh / 2 - (b.oy + b.oh / 2) || a.ox + a.ow / 2 - (b.ox + b.ow / 2));
  ordenados.forEach((e, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const s = Math.min((cellW * margem) / e.ow, (cellH * margem) / e.oh);
    const w = e.ow * s;
    const h = e.oh * s;
    const freeX = cellW - w;
    const freeY = cellH - h;
    const jx = stagger ? 0 : (((i * 73) % 100) / 100 - 0.5) * freeX * 0.5;
    const jy = stagger ? 0 : (((i * 37 + 11) % 100) / 100 - 0.5) * freeY * 0.5;
    const off = stagger && r % 2 === 1 ? cellW / 2 : 0;
    T.set(e, { w, h, x: c * cellW + freeX / 2 + jx + off, y: r * cellH + freeY / 2 + jy });
  });
}

/**
 * 'fill' (estilo stickers, com sobreposição) ou 'center' (localizada sem estrela): distribui
 * em torno do centro de massa original, preservando a composição relativa entre motivos.
 */
export function autoCompute(
  W: number,
  H: number,
  modo: 'fill' | 'center',
  overlap: boolean,
  T: Map<Camada, TransformCamada>,
  fg: Camada[],
  larguraOriginal: number,
  alturaOriginal: number,
): void {
  if (modo === 'fill') {
    for (const e of fg.filter((c) => ehSpanning(c, larguraOriginal, alturaOriginal))) {
      const ss = Math.max(W / e.ow, H / e.oh);
      T.set(e, { w: e.ow * ss, h: e.oh * ss, x: (W - e.ow * ss) / 2, y: (H - e.oh * ss) / 2 });
    }
    const motivos = fg.filter((c) => !ehSpanning(c, larguraOriginal, alturaOriginal));
    if (!overlap) {
      fillGridNoOverlap(motivos, W, H, T);
      return;
    }
    const dist = motivos.length ? motivos : fg;
    const cxs = dist.map((e) => e.ox + e.ow / 2);
    const cys = dist.map((e) => e.oy + e.oh / 2);
    const minCx = Math.min(...cxs);
    const maxCx = Math.max(...cxs);
    const minCy = Math.min(...cys);
    const maxCy = Math.max(...cys);
    const spanX = Math.max(1, maxCx - minCx);
    const spanY = Math.max(1, maxCy - minCy);
    const mx = W * 0.04;
    const my = H * 0.04;
    const usX = W - 2 * mx;
    const usY = H - 2 * my;
    let s = Math.sqrt(Math.max(0.0001, (usX / spanX) * (usY / spanY)));
    s = Math.min(1.8, Math.max(0.4, s));
    for (const e of motivos) {
      const ncx = (e.ox + e.ow / 2 - minCx) / spanX;
      const ncy = (e.oy + e.oh / 2 - minCy) / spanY;
      let w = e.ow * s;
      let h = e.oh * s;
      const cap = Math.min(1, (W * 0.9) / w, (H * 0.9) / h);
      w *= cap;
      h *= cap;
      const x = Math.max(0, Math.min(W - w, mx + ncx * usX - w / 2));
      const y = Math.max(0, Math.min(H - h, my + ncy * usY - h / 2));
      T.set(e, { w, h, x, y });
    }
    return;
  }
  // 'center': agrupa tudo pela bbox união e escala pra caber com margem, sem separar spanning.
  let uL = Infinity;
  let uT = Infinity;
  let uR = -Infinity;
  let uB = -Infinity;
  for (const e of fg) {
    uL = Math.min(uL, e.ox);
    uT = Math.min(uT, e.oy);
    uR = Math.max(uR, e.ox + e.ow);
    uB = Math.max(uB, e.oy + e.oh);
  }
  const uW = Math.max(1, uR - uL);
  const uH = Math.max(1, uB - uT);
  const margem = 0.86;
  const s = Math.min((W * margem) / uW, (H * margem) / uH);
  const offX = (W - uW * s) / 2 - uL * s;
  const offY = (H - uH * s) / 2 - uT * s;
  for (const e of fg) T.set(e, { w: e.ow * s, h: e.oh * s, x: e.ox * s + offX, y: e.oy * s + offY });
}

/**
 * Calcula o layout puro (não desenha nada): onde cada camada vai na máscara.
 * 'localizada' com estrela definida → só ela, centralizada a 62%. Sem estrela → autoCompute 'center'.
 * 'pattern' → camadas spanning cobrem a máscara inteira; os motivos distribuem pelo estilo
 * (stickers = autoCompute fill com sobreposição; linear/distribuido = fillGridNoOverlap).
 */
export function layoutCompute(
  mascara: Mascara,
  config: ConfigComposicao,
  camadas: Camada[],
  larguraOriginal: number,
  alturaOriginal: number,
  estrela: Camada | null = null,
): ResultadoLayout {
  const T = new Map<Camada, TransformCamada>();
  const { w: W, h: H } = mascara;
  const guias = camadas.filter((c) => c.kind === 'fonte');
  const fg = camadas.filter((c) => c.kind !== 'fonte');
  posicionaGuias(guias, W, H, T);

  if (!fg.length) return { T, onlyStar: false, star: null, guias };

  if (config.tipo === 'localizada') {
    if (estrela && fg.includes(estrela)) {
      const s = (Math.min(W, H) * 0.62) / Math.max(estrela.ow, estrela.oh);
      const w = estrela.ow * s;
      const h = estrela.oh * s;
      T.set(estrela, { w, h, x: (W - w) / 2, y: (H - h) / 2 });
      return { T, onlyStar: true, star: estrela, guias };
    }
    autoCompute(W, H, 'center', false, T, fg, larguraOriginal, alturaOriginal);
    return { T, onlyStar: false, star: null, guias };
  }

  if (config.estilo === 'stickers') {
    autoCompute(W, H, 'fill', true, T, fg, larguraOriginal, alturaOriginal);
  } else {
    for (const e of fg.filter((c) => ehSpanning(c, larguraOriginal, alturaOriginal))) {
      const ss = Math.max(W / e.ow, H / e.oh);
      T.set(e, { w: e.ow * ss, h: e.oh * ss, x: (W - e.ow * ss) / 2, y: (H - e.oh * ss) / 2 });
    }
    const motivos = fg.filter((c) => !ehSpanning(c, larguraOriginal, alturaOriginal));
    fillGridNoOverlap(motivos, W, H, T, config.estilo === 'distribuido');
  }
  return { T, onlyStar: false, star: null, guias };
}

/** Rapport (dá a volta): cópias laterais ±largura, só no tipo 'pattern'. Fecha a costura por construção. */
export function wrapOffsets(mascara: Mascara, config: ConfigComposicao): OffsetRapport[] {
  return config.tipo === 'pattern' ? [{ dx: -mascara.w, dy: 0 }, { dx: mascara.w, dy: 0 }] : [];
}

function desenharCamada(dst: RGBABuffer, camada: Camada, t: TransformCamada, dx: number, dy: number): void {
  const escalada = redimensionar(camada.canvas, t.w, t.h);
  if (!t.rot) {
    compositar(dst, escalada, t.x + dx, t.y + dy);
    return;
  }
  const { buffer: girada } = girar(escalada, t.rot);
  const centroX = t.x + dx + t.w / 2;
  const centroY = t.y + dy + t.h / 2;
  compositar(dst, girada, centroX - girada.width / 2, centroY - girada.height / 2);
}

/**
 * Rasteriza no tamanho EXATO da máscara, fundo sempre transparente. Guias ('fonte') nunca
 * entram no arquivo final. Localizada com estrela desenha só ela; pattern desenha todas as
 * camadas do layout + as cópias de rapport (wrapOffsets).
 */
export function composeFrom(mascara: Mascara, layout: ResultadoLayout, config: ConfigComposicao): RGBABuffer {
  const { w: W, h: H } = mascara;
  const out = criarBuffer(W, H);
  const els = (layout.onlyStar ? [layout.star].filter((c): c is Camada => c !== null) : [...layout.T.keys()]).filter(
    (c) => c.kind !== 'fonte',
  );
  const wraps = layout.onlyStar ? [] : wrapOffsets(mascara, config);
  for (const e of els) {
    const t = layout.T.get(e);
    if (!t) continue;
    desenharCamada(out, e, t, 0, 0);
    for (const o of wraps) desenharCamada(out, e, t, o.dx, o.dy);
  }
  return out;
}

/**
 * Mede o erro de costura em px: diferença média por canal entre a faixa esquerda e a
 * direita da imagem final — a mesma medição da Camada 1 do Auditor (A5, T4). Na rota
 * determinística deve dar 0 por construção; serve de teste de regressão do rapport.
 */
export function medirErroCostura(buffer: RGBABuffer, faixaPx = 8): number {
  const { width: w, height: h, data } = buffer;
  const faixa = Math.min(faixaPx, w);
  if (faixa <= 0) return 0;
  let somaDiff = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < faixa; x++) {
      const iEsq = (y * w + x) * 4;
      const iDir = (y * w + (w - faixa + x)) * 4;
      for (let c = 0; c < 4; c++) {
        somaDiff += Math.abs(data[iEsq + c] - data[iDir + c]);
        n++;
      }
    }
  }
  return n ? somaDiff / n : 0;
}
