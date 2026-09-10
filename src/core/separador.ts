// T1 · separador determinístico. Substitui o "abrir o PSD e separar camadas na mão":
// produz Camada[] no mesmo formato que o ag-psd entrega, pra rodar no motor de rapport sem alteração.
import type { Camada, RGBABuffer } from './tipos.js';
import { criarBuffer } from './pixels.js';

export interface OpcoesSeparador {
  /** distância euclidiana no RGB (0-441) até a cor de fundo amostrada nas bordas. */
  tolerancia: number;
  /** componentes menores que isso (fração do canvas) são descartados como ruído. */
  ruidoMinFracao: number;
  /** raio de dilatação (px) usado só pra decidir fusão de fragmentos vizinhos. */
  fusaoDilatacaoPx: number;
}

export const OPCOES_PADRAO: OpcoesSeparador = {
  tolerancia: 24,
  ruidoMinFracao: 0.001,
  fusaoDilatacaoPx: 3,
};

function corNoPixel(img: RGBABuffer, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

function distancia(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Amostra as 4 bordas e devolve a cor mediana — mais robusta a ruído/anti-aliasing que a média. */
function estimarCorFundo(img: RGBABuffer): [number, number, number] {
  const amostras: [number, number, number][] = [];
  const { width: w, height: h } = img;
  for (let x = 0; x < w; x++) {
    amostras.push(corNoPixel(img, x, 0));
    amostras.push(corNoPixel(img, x, h - 1));
  }
  for (let y = 0; y < h; y++) {
    amostras.push(corNoPixel(img, 0, y));
    amostras.push(corNoPixel(img, w - 1, y));
  }
  const mediana = (vals: number[]) => vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  return [mediana(amostras.map((c) => c[0])), mediana(amostras.map((c) => c[1])), mediana(amostras.map((c) => c[2]))];
}

/**
 * Flood-fill (BFS) do fundo sólido a partir das 4 bordas. Devolve uma NOVA imagem
 * com alpha=0 onde é fundo — não altera `img`. Só marca fundo alcançável a partir da
 * borda, então um "buraco" da mesma cor no meio do motivo não é apagado por engano.
 */
export function removerFundoSolido(img: RGBABuffer, opts: OpcoesSeparador = OPCOES_PADRAO): RGBABuffer {
  const { width: w, height: h } = img;
  const corFundo = estimarCorFundo(img);
  const out: RGBABuffer = { width: w, height: h, data: new Uint8ClampedArray(img.data) };
  const visitado = new Uint8Array(w * h);
  const fila = new Int32Array(w * h);
  let inicio = 0;
  let fim = 0;

  const tentaEmpilhar = (x: number, y: number) => {
    const idx = y * w + x;
    if (visitado[idx]) return;
    if (distancia(corNoPixel(img, x, y), corFundo) > opts.tolerancia) return;
    visitado[idx] = 1;
    fila[fim++] = idx;
  };

  for (let x = 0; x < w; x++) {
    tentaEmpilhar(x, 0);
    tentaEmpilhar(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    tentaEmpilhar(0, y);
    tentaEmpilhar(w - 1, y);
  }

  while (inicio < fim) {
    const idx = fila[inicio++];
    const x = idx % w;
    const y = (idx / w) | 0;
    out.data[idx * 4 + 3] = 0;
    if (x > 0) tentaEmpilhar(x - 1, y);
    if (x < w - 1) tentaEmpilhar(x + 1, y);
    if (y > 0) tentaEmpilhar(x, y - 1);
    if (y < h - 1) tentaEmpilhar(x, y + 1);
  }
  return out;
}

// --- union-find (path compression + union by rank) -------------------------

class UnionFind {
  private pai: Int32Array;
  private rank: Uint8Array;
  constructor(n: number) {
    this.pai = new Int32Array(n);
    for (let i = 0; i < n; i++) this.pai[i] = i;
    this.rank = new Uint8Array(n);
  }
  encontrar(x: number): number {
    while (this.pai[x] !== x) {
      this.pai[x] = this.pai[this.pai[x]];
      x = this.pai[x];
    }
    return x;
  }
  unir(a: number, b: number): void {
    const ra = this.encontrar(a);
    const rb = this.encontrar(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.pai[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.pai[rb] = ra;
    else {
      this.pai[rb] = ra;
      this.rank[ra]++;
    }
  }
}

export interface Rotulagem {
  /** label por pixel; 0 = fundo/transparente, sem componente. */
  labels: Int32Array;
  /** número de componentes distintos (labels vão de 1..count). */
  count: number;
}

/** Componentes conexos (4-vizinhos) sobre o canal alpha: alpha>0 é motivo. */
export function rotularComponentesConexos(img: RGBABuffer, limiarAlpha = 8): Rotulagem {
  const { width: w, height: h } = img;
  const n = w * h;
  const ehMotivo = (idx: number) => img.data[idx * 4 + 3] > limiarAlpha;
  const uf = new UnionFind(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!ehMotivo(idx)) continue;
      if (x > 0 && ehMotivo(idx - 1)) uf.unir(idx, idx - 1);
      if (y > 0 && ehMotivo(idx - w)) uf.unir(idx, idx - w);
    }
  }
  const labels = new Int32Array(n);
  const raizParaLabel = new Map<number, number>();
  let proximo = 1;
  for (let idx = 0; idx < n; idx++) {
    if (!ehMotivo(idx)) continue;
    const raiz = uf.encontrar(idx);
    let label = raizParaLabel.get(raiz);
    if (label === undefined) {
      label = proximo++;
      raizParaLabel.set(raiz, label);
    }
    labels[idx] = label;
  }
  return { labels, count: proximo - 1 };
}

/** Descarta componentes menores que `ruidoMinFracao` do canvas. Relabela o restante em sequência. */
export function limparRuido(rot: Rotulagem, w: number, h: number, ruidoMinFracao: number): Rotulagem {
  const area = new Int32Array(rot.count + 1);
  for (let i = 0; i < rot.labels.length; i++) area[rot.labels[i]]++;
  const minPixels = w * h * ruidoMinFracao;
  const novoLabel = new Int32Array(rot.count + 1);
  let proximo = 1;
  for (let l = 1; l <= rot.count; l++) {
    if (area[l] >= minPixels) novoLabel[l] = proximo++;
  }
  const labels = new Int32Array(rot.labels.length);
  for (let i = 0; i < rot.labels.length; i++) {
    const l = rot.labels[i];
    labels[i] = l ? novoLabel[l] : 0;
  }
  return { labels, count: proximo - 1 };
}

/**
 * Funde componentes cujos "halos" dilatados se tocam — evita que uma ilustração
 * com traço fino ou pequenas quebras vire vários fragmentos soltos (ex.: flor -> 5 pétalas).
 */
export function fundirFragmentosVizinhos(rot: Rotulagem, w: number, h: number, dilatacaoPx: number): Rotulagem {
  if (rot.count <= 1 || dilatacaoPx <= 0) return rot;
  const uf = new UnionFind(rot.count + 1);
  const r = dilatacaoPx;
  // Pra cada pixel de um componente, olha um raio r ao redor: se achar pixel de
  // OUTRO componente ali dentro, os dois "quase se tocam" e devem ser um motivo só.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l1 = rot.labels[y * w + x];
      if (!l1) continue;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const l2 = rot.labels[ny * w + nx];
          if (l2 && l2 !== l1) uf.unir(l1, l2);
        }
      }
    }
  }
  const raizParaLabel = new Map<number, number>();
  let proximo = 1;
  const mapa = new Int32Array(rot.count + 1);
  for (let l = 1; l <= rot.count; l++) {
    const raiz = uf.encontrar(l);
    let novo = raizParaLabel.get(raiz);
    if (novo === undefined) {
      novo = proximo++;
      raizParaLabel.set(raiz, novo);
    }
    mapa[l] = novo;
  }
  const labels = new Int32Array(rot.labels.length);
  for (let i = 0; i < rot.labels.length; i++) {
    const l = rot.labels[i];
    labels[i] = l ? mapa[l] : 0;
  }
  return { labels, count: proximo - 1 };
}

/** Recorta cada componente pela sua bbox, num canvas próprio — vira uma Camada 'motivo'. */
export function recortarComponentes(img: RGBABuffer, rot: Rotulagem): Camada[] {
  const { width: w, height: h } = img;
  const bboxes = Array.from({ length: rot.count + 1 }, () => ({
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = rot.labels[y * w + x];
      if (!l) continue;
      const b = bboxes[l];
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
    }
  }
  const camadas: Camada[] = [];
  for (let l = 1; l <= rot.count; l++) {
    const b = bboxes[l];
    if (!Number.isFinite(b.minX)) continue;
    const ow = b.maxX - b.minX + 1;
    const oh = b.maxY - b.minY + 1;
    const canvas = criarBuffer(ow, oh);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const sx = b.minX + x;
        const sy = b.minY + y;
        const pertence = rot.labels[sy * w + sx] === l;
        const si = (sy * w + sx) * 4;
        const di = (y * ow + x) * 4;
        if (pertence) {
          canvas.data[di] = img.data[si];
          canvas.data[di + 1] = img.data[si + 1];
          canvas.data[di + 2] = img.data[si + 2];
          canvas.data[di + 3] = img.data[si + 3];
        }
      }
    }
    camadas.push({ canvas, ox: b.minX, oy: b.minY, ow, oh, kind: 'motivo', nome: `motivo-${l}` });
  }
  return camadas;
}

/** Orquestra os 4 passos do estágio 3 (ORQUESTRACAO.md): remove fundo, rotula, limpa, funde e recorta. */
export function separar(img: RGBABuffer, opts: OpcoesSeparador = OPCOES_PADRAO): Camada[] {
  const semFundo = removerFundoSolido(img, opts);
  let rot = rotularComponentesConexos(semFundo);
  rot = limparRuido(rot, img.width, img.height, opts.ruidoMinFracao);
  rot = fundirFragmentosVizinhos(rot, img.width, img.height, opts.fusaoDilatacaoPx);
  return recortarComponentes(semFundo, rot);
}
