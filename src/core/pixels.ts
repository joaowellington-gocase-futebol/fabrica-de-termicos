// T1 · buffer RGBA puro (sem DOM/canvas — precisa rodar num Worker) + PNG via upng-js.
import type { RGBABuffer } from './tipos.js';

// upng-js não publica tipos; a API usada é: decode(ArrayBuffer) -> img,
// toRGBA8(img) -> ArrayBuffer[] (um por frame), encode(imgs, w, h, cnum) -> ArrayBuffer.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import UPNG from 'upng-js';

export function criarBuffer(width: number, height: number): RGBABuffer {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export async function decodificarPng(bytes: Uint8Array): Promise<RGBABuffer> {
  // .buffer é ArrayBufferLike (pode ser SharedArrayBuffer); aqui é sempre um ArrayBuffer normal.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const img = UPNG.decode(ab);
  const [rgba] = UPNG.toRGBA8(img);
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(rgba) };
}

export function codificarPng(buf: RGBABuffer): Uint8Array {
  const bytes = UPNG.encode([buf.data.buffer as ArrayBuffer], buf.width, buf.height, 0);
  return new Uint8Array(bytes);
}

function amostrarBilinear(src: RGBABuffer, sx: number, sy: number): [number, number, number, number] {
  const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(sx)));
  const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(sy)));
  const x1 = Math.min(src.width - 1, x0 + 1);
  const y1 = Math.min(src.height - 1, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const i00 = (y0 * src.width + x0) * 4;
  const i10 = (y0 * src.width + x1) * 4;
  const i01 = (y1 * src.width + x0) * 4;
  const i11 = (y1 * src.width + x1) * 4;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const topo = src.data[i00 + c] * (1 - fx) + src.data[i10 + c] * fx;
    const baixo = src.data[i01 + c] * (1 - fx) + src.data[i11 + c] * fx;
    out[c] = topo * (1 - fy) + baixo * fy;
  }
  return out;
}

/** Redimensiona por amostragem bilinear. w/h <= 0 devolve buffer 1x1 transparente. */
export function redimensionar(src: RGBABuffer, w: number, h: number): RGBABuffer {
  const largura = Math.max(1, Math.round(w));
  const altura = Math.max(1, Math.round(h));
  const out = criarBuffer(largura, altura);
  if (src.width === 0 || src.height === 0) return out;
  const escalaX = src.width / largura;
  const escalaY = src.height / altura;
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      const [r, g, b, a] = amostrarBilinear(src, (x + 0.5) * escalaX - 0.5, (y + 0.5) * escalaY - 0.5);
      const i = (y * largura + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = a;
    }
  }
  return out;
}

export interface BufferGirado {
  buffer: RGBABuffer;
  /** quanto o canto superior-esquerdo se deslocou em relação ao original, por causa da expansão do canvas. */
  offsetX: number;
  offsetY: number;
}

/** Gira em torno do centro, expandindo o canvas o suficiente pra não cortar nada. */
export function girar(src: RGBABuffer, graus: number): BufferGirado {
  if (!graus) return { buffer: src, offsetX: 0, offsetY: 0 };
  const rad = (graus * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const w = src.width;
  const h = src.height;
  const novaLargura = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const novaAltura = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = criarBuffer(novaLargura, novaAltura);
  const cxSrc = w / 2;
  const cySrc = h / 2;
  const cxDst = novaLargura / 2;
  const cyDst = novaAltura / 2;
  // amostragem inversa: pra cada pixel de destino, acha de onde ele veio na origem
  const cosInv = Math.cos(-rad);
  const sinInv = Math.sin(-rad);
  for (let y = 0; y < novaAltura; y++) {
    for (let x = 0; x < novaLargura; x++) {
      const dx = x - cxDst;
      const dy = y - cyDst;
      const sx = dx * cosInv - dy * sinInv + cxSrc;
      const sy = dx * sinInv + dy * cosInv + cySrc;
      if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) continue;
      const [r, g, b, a] = amostrarBilinear(src, sx, sy);
      const i = (y * novaLargura + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = a;
    }
  }
  return { buffer: out, offsetX: cxDst - cxSrc, offsetY: cyDst - cySrc };
}

/** Alpha-composita src sobre dst na posição (x,y) — "over" padrão, com clip nas bordas de dst. */
export function compositar(dst: RGBABuffer, src: RGBABuffer, x: number, y: number): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(dst.width, Math.floor(x) + src.width);
  const y1 = Math.min(dst.height, Math.floor(y) + src.height);
  for (let dy = y0; dy < y1; dy++) {
    const sy = dy - Math.floor(y);
    for (let dx = x0; dx < x1; dx++) {
      const sx = dx - Math.floor(x);
      const si = (sy * src.width + sx) * 4;
      const alphaSrc = src.data[si + 3] / 255;
      if (alphaSrc <= 0) continue;
      const di = (dy * dst.width + dx) * 4;
      const alphaDst = dst.data[di + 3] / 255;
      const alphaOut = alphaSrc + alphaDst * (1 - alphaSrc);
      if (alphaOut <= 0) continue;
      for (let c = 0; c < 3; c++) {
        dst.data[di + c] = (src.data[si + c] * alphaSrc + dst.data[di + c] * alphaDst * (1 - alphaSrc)) / alphaOut;
      }
      dst.data[di + 3] = alphaOut * 255;
    }
  }
}
