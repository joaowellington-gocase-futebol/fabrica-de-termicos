// upng-js não publica tipos (ver pixels.ts) — declaração ambiente mínima, só o que usamos.
declare module 'upng-js' {
  interface ImagemDecodificada {
    width: number;
    height: number;
  }
  function decode(buffer: ArrayBuffer): ImagemDecodificada;
  function toRGBA8(img: ImagemDecodificada): ArrayBuffer[];
  function encode(imgs: ArrayBuffer[], w: number, h: number, cnum: number): ArrayBuffer;
  const _default: { decode: typeof decode; toRGBA8: typeof toRGBA8; encode: typeof encode };
  export default _default;
}
