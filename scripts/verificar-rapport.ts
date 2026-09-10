// Verificação sintética do "Pronto quando" da T1 (ver docs/EQUIPE.md):
// `erro_costura_px == 0` em estampas de teste, na rota determinística.
// Gera estampas sintéticas (sem depender de PNG real ainda inexistente no repo),
// roda separador -> rapport -> composeFrom e mede a costura. Uso: `npm run verificar`.
import type { Camada, ConfigComposicao, Mascara } from '../src/core/tipos.js';
import { criarBuffer } from '../src/core/pixels.js';
import { separar } from '../src/core/separador.js';
import { composeFrom, layoutCompute, medirErroCostura } from '../src/core/rapport.js';
import type { RGBABuffer } from '../src/core/tipos.js';

/** Desenha `n` "motivos" (quadrados coloridos) sobre fundo sólido — imita uma estampa de case. */
function estampaSintetica(w: number, h: number, n: number, seed: number): RGBABuffer {
  const buf = criarBuffer(w, h);
  const corFundo: [number, number, number] = [242, 232, 220];
  for (let i = 0; i < buf.data.length; i += 4) {
    buf.data[i] = corFundo[0];
    buf.data[i + 1] = corFundo[1];
    buf.data[i + 2] = corFundo[2];
    buf.data[i + 3] = 255;
  }
  for (let k = 0; k < n; k++) {
    const lado = 40 + ((seed + k * 17) % 60);
    const cx = ((seed + k * 53) % (w - lado * 2)) + lado;
    const cy = ((seed + k * 31) % (h - lado * 2)) + lado;
    const cor: [number, number, number] = [(k * 47 + seed) % 200, (k * 91 + seed) % 200, (k * 133 + seed) % 200];
    for (let y = cy - lado / 2; y < cy + lado / 2; y++) {
      for (let x = cx - lado / 2; x < cx + lado / 2; x++) {
        const i = (Math.floor(y) * w + Math.floor(x)) * 4;
        buf.data[i] = cor[0];
        buf.data[i + 1] = cor[1];
        buf.data[i + 2] = cor[2];
        buf.data[i + 3] = 255;
      }
    }
  }
  return buf;
}

const MASCARA: Mascara = { key: 'garrafa-fresh', w: 2754, h: 2340 };
const CONFIG: ConfigComposicao = { tipo: 'pattern', estilo: 'distribuido' };
const QTD_TESTE = 10;

let falhas = 0;
for (let i = 0; i < QTD_TESTE; i++) {
  const largura = 900 + i * 20;
  const altura = 900 + i * 15;
  const origem = estampaSintetica(largura, altura, 4 + (i % 3), i * 97 + 1);
  const camadas: Camada[] = separar(origem);
  const layout = layoutCompute(MASCARA, CONFIG, camadas, largura, altura);
  const final = composeFrom(MASCARA, layout, CONFIG);
  const erro = medirErroCostura(final);
  const status = erro === 0 ? 'ok' : 'FALHOU';
  if (erro !== 0) falhas++;
  console.log(`estampa ${i + 1}/${QTD_TESTE} (${camadas.length} camadas): erro_costura_px=${erro} [${status}]`);
}

if (falhas > 0) {
  console.error(`\n${falhas}/${QTD_TESTE} estampas com costura != 0.`);
  process.exit(1);
}
console.log(`\nOK: erro_costura_px == 0 em ${QTD_TESTE}/${QTD_TESTE} estampas sintéticas (rota determinística).`);
