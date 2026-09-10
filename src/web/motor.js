/**
 * Motor gráfico da Fábrica de Térmicos — Separador + Rapport.
 *
 * POR QUE ISTO RODA NO BROWSER E NÃO NO WORKER
 * O runtime do GoDeploy não tem Canvas API e o orçamento de CPU é
 * compartilhado com os outros apps. Uma composição em 2754x2340 são 6,4 milhões
 * de pixels; decodificar PNG e rasterizar isso em JS puro no worker estoura o
 * teto. O browser tem canvas acelerado e o custo é da máquina de quem opera.
 * É também onde o `gerador-de-adaptacoes` já faz esse trabalho hoje.
 *
 * O QUE NUNCA MUDA AQUI
 * `wrapOffsets` desenha cada camada em x-W, x e x+W. O que atravessa a borda
 * direita reaparece na esquerda pela MESMA operação de desenho, então a costura
 * fecha por construção, com erro zero — não por um modelo ter acertado o
 * "seamless". Se alguém trocar isto por geração generativa, troca uma garantia
 * matemática por uma aposta. Não troque.
 *
 * Módulo ES puro, sem dependência: é servido como asset estático.
 */

// ---------------------------------------------------------------------------
// Utilitários de canvas
// ---------------------------------------------------------------------------

/** Alvo de pixels para a etapa de ANÁLISE. O recorte final sai do original. */
const PIXELS_ANALISE = 1_500_000;

/** Componente menor que isto (fração do canvas) é ruído de recorte. */
const FRACAO_RUIDO = 0.001;

/** Camada que cobre esta fração do canvas é fundo, não motivo. */
const FRACAO_SPANNING = 0.85;

export function novoCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(canvas, alpha = true) {
  const c = canvas.getContext('2d', { alpha, willReadFrequently: true });
  if (!c) throw new Error('canvas 2d indisponível neste navegador');
  return c;
}

/**
 * Carrega a imagem. `crossOrigin` é obrigatório: sem ele o canvas fica
 * "tainted" e `getImageData` lança SecurityError — que é o erro mais comum de
 * quem mexe nisto pela primeira vez.
 */
export async function carregaImagem(url) {
  if (typeof createImageBitmap === 'function' && !url.startsWith('data:')) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) return await createImageBitmap(await res.blob());
    } catch {
      /* cai para o Image() abaixo */
    }
  }
  return await new Promise((ok, erro) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => ok(img);
    img.onerror = () => erro(new Error(`não carregou a imagem: ${url.slice(0, 120)}`));
    img.src = url;
  });
}

export function paraCanvas(fonte) {
  const w = fonte.width;
  const h = fonte.height;
  const c = novoCanvas(w, h);
  ctx2d(c).drawImage(fonte, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// Separador — etapa 1: remoção de fundo
// ---------------------------------------------------------------------------

function hexParaRgb(hex) {
  const s = String(hex || '').replace('#', '');
  if (s.length === 3) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
  }
  if (s.length >= 6) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  return [255, 255, 255];
}

/** Cor mais frequente nas 4 bordas — o fundo real, quando o A2 não informou. */
export function corDasBordas(dados, w, h) {
  const conta = new Map();
  const amostra = (x, y) => {
    const i = (y * w + x) * 4;
    if (dados[i + 3] < 8) return;
    const k = `${dados[i] >> 3},${dados[i + 1] >> 3},${dados[i + 2] >> 3}`;
    conta.set(k, (conta.get(k) || 0) + 1);
  };
  const passo = Math.max(1, Math.floor(Math.min(w, h) / 200));
  for (let x = 0; x < w; x += passo) {
    amostra(x, 0);
    amostra(x, h - 1);
  }
  for (let y = 0; y < h; y += passo) {
    amostra(0, y);
    amostra(w - 1, y);
  }
  let melhor = null;
  let max = -1;
  for (const [k, n] of conta) {
    if (n > max) {
      max = n;
      melhor = k;
    }
  }
  if (!melhor) return [255, 255, 255];
  return melhor.split(',').map((v) => (Number(v) << 3) + 4);
}

/**
 * Flood-fill a partir das 4 bordas, zerando o alpha do fundo.
 *
 * Só partir das bordas — e não pintar toda a imagem por semelhança de cor — é o
 * que preserva o branco DENTRO do desenho (o miolo de uma flor branca continua
 * lá). É exato, roda em milissegundos e não custa nada; remove.bg só entra
 * quando o fundo é textura e não tem cor única.
 */
export function removeFundoSolido(imageData, corHex, tolerancia = 32) {
  const { data, width: w, height: h } = imageData;
  const [br, bg, bb] = corHex ? hexParaRgb(corHex) : corDasBordas(data, w, h);
  const tol2 = tolerancia * tolerancia * 3;

  const visitado = new Uint8Array(w * h);
  const pilha = new Int32Array(w * h);
  let topo = 0;

  const parecido = (p) => {
    const i = p * 4;
    if (data[i + 3] < 8) return true; // já transparente
    const dr = data[i] - br;
    const dg = data[i + 1] - bg;
    const db = data[i + 2] - bb;
    return dr * dr + dg * dg + db * db <= tol2;
  };

  const empilha = (p) => {
    if (!visitado[p] && parecido(p)) {
      visitado[p] = 1;
      pilha[topo++] = p;
    }
  };

  for (let x = 0; x < w; x++) {
    empilha(x);
    empilha((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    empilha(y * w);
    empilha(y * w + w - 1);
  }

  let removidos = 0;
  while (topo > 0) {
    const p = pilha[--topo];
    data[p * 4 + 3] = 0;
    removidos++;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) empilha(p - 1);
    if (x < w - 1) empilha(p + 1);
    if (y > 0) empilha(p - w);
    if (y < h - 1) empilha(p + w);
  }

  return { imageData, removidos, cor: [br, bg, bb] };
}

// ---------------------------------------------------------------------------
// Separador — etapa 2: componentes conexos
// ---------------------------------------------------------------------------

/**
 * Rotula componentes conexos no canal alpha, 8-vizinhos.
 *
 * 8-vizinhos e não 4: com 4-vizinhos uma linha diagonal de 1px de espessura —
 * comum em traço de ilustração — vira uma corrente de componentes soltos.
 */
export function componentesConexos(imageData, limiarAlpha = 16) {
  const { data, width: w, height: h } = imageData;
  const rotulo = new Int32Array(w * h).fill(-1);
  const fila = new Int32Array(w * h);
  const comps = [];

  for (let p0 = 0; p0 < w * h; p0++) {
    if (rotulo[p0] !== -1 || data[p0 * 4 + 3] < limiarAlpha) continue;

    const id = comps.length;
    let ini = 0;
    let fim = 0;
    fila[fim++] = p0;
    rotulo[p0] = id;

    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    let area = 0;

    while (ini < fim) {
      const p = fila[ini++];
      const x = p % w;
      const y = (p - x) / w;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
          const q = ny * w + nx;
          if (rotulo[q] === -1 && data[q * 4 + 3] >= limiarAlpha) {
            rotulo[q] = id;
            fila[fim++] = q;
          }
        }
      }
    }

    comps.push({ id, ox: minX, oy: minY, ow: maxX - minX + 1, oh: maxY - minY + 1, area });
  }

  return { comps, rotulo };
}

/**
 * Descarta ruído e funde fragmentos vizinhos.
 *
 * A fusão é por PROXIMIDADE DE BBOX dilatada, não por dilatação de pixel: o
 * resultado é o mesmo para o caso que importa (pétalas do mesmo desenho ficam
 * coladas) e custa duas ordens de grandeza menos. A dilatação em pixel de um
 * canvas de milhões de pixels é o que trava a aba.
 *
 * O A4 tem a palavra final sobre agrupamento; isto é o primeiro corte.
 */
export function limpaComponentes(comps, w, h, raioFusaoPct = 1.5) {
  const totalPixels = w * h;
  const uteis = comps.filter((c) => c.area >= totalPixels * FRACAO_RUIDO);
  const descartados = comps.length - uteis.length;

  const raio = Math.max(2, Math.round(Math.min(w, h) * (raioFusaoPct / 100)));

  const pai = uteis.map((_, i) => i);
  const acha = (i) => {
    while (pai[i] !== i) {
      pai[i] = pai[pai[i]];
      i = pai[i];
    }
    return i;
  };
  const une = (a, b) => {
    const ra = acha(a);
    const rb = acha(b);
    if (ra !== rb) pai[ra] = rb;
  };

  const perto = (a, b) =>
    a.ox - raio < b.ox + b.ow &&
    b.ox - raio < a.ox + a.ow &&
    a.oy - raio < b.oy + b.oh &&
    b.oy - raio < a.oy + a.oh;

  for (let i = 0; i < uteis.length; i++) {
    for (let j = i + 1; j < uteis.length; j++) {
      if (perto(uteis[i], uteis[j])) une(i, j);
    }
  }

  const grupos = new Map();
  uteis.forEach((c, i) => {
    const r = acha(i);
    grupos.set(r, [...(grupos.get(r) || []), c]);
  });

  const fundidos = [...grupos.values()].map((grupo, i) => {
    const ox = Math.min(...grupo.map((c) => c.ox));
    const oy = Math.min(...grupo.map((c) => c.oy));
    const fx = Math.max(...grupo.map((c) => c.ox + c.ow));
    const fy = Math.max(...grupo.map((c) => c.oy + c.oh));
    return {
      id: i,
      ox,
      oy,
      ow: fx - ox,
      oh: fy - oy,
      area: grupo.reduce((s, c) => s + c.area, 0),
      origem: grupo.map((c) => c.id),
    };
  });

  fundidos.sort((a, b) => b.area - a.area);
  fundidos.forEach((c, i) => (c.id = i));
  return { comps: fundidos, descartados };
}

// ---------------------------------------------------------------------------
// Separador — etapa 3: recorte no formato do ag-psd
// ---------------------------------------------------------------------------

/**
 * Separa a estampa em camadas.
 *
 * A análise roda numa versão reduzida (rápido) e o RECORTE sai do original
 * (qualidade). É o que permite tratar um PNG de 3000px sem travar a aba nem
 * perder resolução na arte que vai para produção.
 *
 * Saída: `{canvas, ox, oy, ow, oh, kind}` — exatamente o que o `ag-psd`
 * entrega ao ler um PSD com camadas. É por isso que o motor de rapport aceita
 * esta saída sem uma linha de alteração.
 */
export async function separa(imgFonte, leitura, opcoes = {}) {
  const original = paraCanvas(imgFonte);
  const W = original.width;
  const H = original.height;

  const escala = Math.min(1, Math.sqrt(PIXELS_ANALISE / (W * H)));
  const aw = Math.max(64, Math.round(W * escala));
  const ah = Math.max(64, Math.round(H * escala));

  const analise = novoCanvas(aw, ah);
  ctx2d(analise).drawImage(original, 0, 0, aw, ah);
  const ctxA = ctx2d(analise);
  const dadosA = ctxA.getImageData(0, 0, aw, ah);

  const tipoFundo = leitura?.fundo?.tipo || 'solido';
  let corFundo = null;
  let removidos = 0;

  if (tipoFundo !== 'transparente') {
    const r = removeFundoSolido(
      dadosA,
      leitura?.fundo?.cor && leitura.fundo.cor !== '#00000000' ? leitura.fundo.cor : null,
      opcoes.tolerancia ?? 32,
    );
    corFundo = r.cor;
    removidos = r.removidos;
  }

  const { comps: crus } = componentesConexos(dadosA);
  const { comps, descartados } = limpaComponentes(crus, aw, ah, opcoes.raioFusaoPct ?? 1.5);

  const inv = 1 / escala;
  const camadas = [];

  for (const c of comps) {
    // Volta a bbox para a escala original, com 1px de folga para não cortar
    // o antialiasing da borda do traço.
    const ox = Math.max(0, Math.floor(c.ox * inv) - 1);
    const oy = Math.max(0, Math.floor(c.oy * inv) - 1);
    const ow = Math.min(W - ox, Math.ceil(c.ow * inv) + 2);
    const oh = Math.min(H - oy, Math.ceil(c.oh * inv) + 2);
    if (ow < 2 || oh < 2) continue;

    const recorte = novoCanvas(ow, oh);
    const cr = ctx2d(recorte);
    cr.drawImage(original, ox, oy, ow, oh, 0, 0, ow, oh);

    // Remove o fundo de novo, agora em resolução cheia e só dentro do recorte:
    // barato, e é o que dá alpha limpo na arte de produção.
    if (corFundo) {
      const d = cr.getImageData(0, 0, ow, oh);
      removeFundoSolido(
        d,
        `#${corFundo.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`,
        opcoes.tolerancia ?? 32,
      );
      cr.putImageData(d, 0, 0);
    }

    const areaOpaca = c.area * inv * inv;
    const kind = c.ow * c.oh >= aw * ah * FRACAO_SPANNING ? 'fundo' : 'motivo';

    camadas.push({ canvas: recorte, ox, oy, ow, oh, kind, id: camadas.length, areaOpaca });
  }

  return {
    camadas,
    diagnostico: {
      original: { w: W, h: H },
      escala_analise: escala,
      pixels_fundo_removidos: removidos,
      componentes_crus: crus.length,
      componentes_descartados_ruido: descartados,
      camadas: camadas.length,
      cor_fundo: corFundo,
    },
  };
}

/** Refaz o agrupamento com o veredito do A4. */
export function aplicaSegmentacao(camadas, revisao) {
  if (!revisao?.pecas?.length) return camadas;

  const porId = new Map(camadas.map((c) => [c.id, c]));
  const pai = new Map();
  const acha = (x) => {
    if (!pai.has(x)) pai.set(x, x);
    let r = pai.get(x);
    while (r !== pai.get(r)) r = pai.get(r);
    pai.set(x, r);
    return r;
  };
  const une = (a, b) => {
    const ra = acha(a);
    const rb = acha(b);
    if (ra !== rb) pai.set(ra, rb);
  };

  const fora = new Set();
  for (const p of revisao.pecas) {
    if (!porId.has(p.id)) continue;
    acha(p.id);
    if (p.veredito === 'ruido' || p.veredito === 'duplicata') {
      fora.add(p.id);
      continue;
    }
    for (const o of p.funde_com || []) if (porId.has(o)) une(p.id, o);
  }

  const nomes = new Map(revisao.pecas.map((p) => [p.id, p.nome]));
  const grupos = new Map();
  for (const c of camadas) {
    if (fora.has(c.id)) continue;
    const r = acha(c.id);
    grupos.set(r, [...(grupos.get(r) || []), c]);
  }

  const saida = [];
  for (const grupo of grupos.values()) {
    if (grupo.length === 1) {
      saida.push({ ...grupo[0], nome: nomes.get(grupo[0].id) || grupo[0].nome });
      continue;
    }
    // Redesenha o grupo num canvas só, mantendo a posição relativa entre as
    // partes — é isso que faz a flor voltar a ser uma flor.
    const ox = Math.min(...grupo.map((c) => c.ox));
    const oy = Math.min(...grupo.map((c) => c.oy));
    const fx = Math.max(...grupo.map((c) => c.ox + c.ow));
    const fy = Math.max(...grupo.map((c) => c.oy + c.oh));
    const c2 = novoCanvas(fx - ox, fy - oy);
    const cc = ctx2d(c2);
    for (const g of grupo) cc.drawImage(g.canvas, g.ox - ox, g.oy - oy);
    saida.push({
      canvas: c2,
      ox,
      oy,
      ow: fx - ox,
      oh: fy - oy,
      kind: grupo[0].kind,
      id: saida.length,
      nome: nomes.get(grupo[0].id) || 'grupo',
      areaOpaca: grupo.reduce((s, g) => s + (g.areaOpaca || 0), 0),
    });
  }

  saida.forEach((c, i) => (c.id = i));
  return saida;
}

// ---------------------------------------------------------------------------
// Rapport — a parte que NÃO muda
// ---------------------------------------------------------------------------

/**
 * Os deslocamentos que fecham a costura.
 *
 * Toda camada é desenhada três vezes: em x-W, em x e em x+W. O que sai pela
 * direita entra pela esquerda pela mesma chamada de desenho — então a emenda é
 * exata, não aproximada. Zero é o valor esperado de `medirCostura` na rota
 * determinística, e qualquer coisa acima disso é regressão de código.
 */
export function wrapOffsets(W) {
  return [{ dx: -W, dy: 0 }, { dx: 0, dy: 0 }, { dx: W, dy: 0 }];
}

/** Camada que cobre quase tudo é fundo, não motivo. */
export function isSpanning(camada, W, H) {
  return camada.ow * camada.oh >= W * H * FRACAO_SPANNING;
}

function embaralhavel(semente) {
  let s = semente >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/**
 * A hierarquia da capinha é preservada de graça, e vale entender por quê.
 *
 * Os recortes saem do separador no tamanho NATIVO que tinham na arte original —
 * se lá uma flor era o triplo de uma folha, o canvas dela é o triplo. Aplicando
 * a MESMA escala a todos, a proporção entre eles atravessa intacta.
 *
 * O que destrói isso é jitter de escala por motivo. Em arte `uniforme` (poá,
 * oncinha) variar tamanho é justamente apagar o que define a arte — então o
 * jitter é ligado pela hierarquia lida, não por gosto.
 */
function jitterPermitido(leitura) {
  return leitura?.composicao?.hierarquia !== 'uniforme';
}

/** Retângulo de uma colocação, para testar contra a zona da logo. */
function retanguloDe(camada, p) {
  const w = camada.ow * p.escala;
  const h = camada.oh * p.escala;
  return { x: p.x - w / 2, y: p.y - h / 2, w, h };
}

function interseccao(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 <= x || y2 <= y ? 0 : (x2 - x) * (y2 - y);
}

/**
 * Remove as colocações que caem na zona proibida da logo.
 *
 * Descartar em vez de empurrar: mover a peça quebraria a grade e, com ela, o
 * fechamento do rapport (o passo em X é calculado para fechar exato na
 * largura). Um buraco onde a logo vai ficar é o resultado correto — é ali que a
 * logo entra.
 */
function evitaLogo(colocacoes, camadas, zona) {
  if (!zona || !zona.disponivel) return { colocacoes, removidas: 0 };
  const porId = new Map(camadas.map((c) => [c.id, c]));
  const proibido = { x: zona.x, y: zona.y, w: zona.w, h: zona.h };
  const mantidas = [];
  let removidas = 0;
  for (const p of colocacoes) {
    const camada = porId.get(p.camadaId);
    if (camada && interseccao(retanguloDe(camada, p), proibido) > 0) {
      removidas++;
      continue;
    }
    mantidas.push(p);
  }
  return { colocacoes: mantidas, removidas };
}

/**
 * Grade sem sobreposição. `stagger` desloca linhas alternadas meio passo — é o
 * que evita a leitura de "fileira" quando a densidade é baixa.
 */
function fillGridNoOverlap(camadas, W, H, plano, stagger, leitura) {
  const motivos = camadas.filter((c) => c.kind === 'motivo');
  if (!motivos.length) return [];

  const escala = plano.escala_motivos;
  const medioW = motivos.reduce((s, c) => s + c.ow, 0) / motivos.length;
  const medioH = motivos.reduce((s, c) => s + c.oh, 0) / motivos.length;

  // Passo derivado da densidade alvo: mais densidade, passo menor.
  const folga = 1 + (1 - plano.densidade_alvo) * 1.2;
  const passoX = Math.max(24, medioW * escala * folga);
  const passoY = Math.max(24, medioH * escala * folga);

  const cols = Math.max(1, Math.round(W / passoX));
  const rows = Math.max(1, Math.round(H / passoY));
  // O passo em X é recalculado a partir do número inteiro de colunas: é isso
  // que faz a grade fechar exatamente na largura e o rapport não "andar".
  const px = W / cols;
  const py = H / rows;

  const rnd = embaralhavel(cols * 7919 + rows * 104729);
  const margem = (Math.min(W, H) * plano.margem_seguranca_pct) / 100;
  const gira = plano.rotacao_permitida && jitterPermitido(leitura);
  const coloc = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const camada = motivos[(r * cols + c) % motivos.length];
      const desloc = stagger && r % 2 === 1 ? px / 2 : 0;
      const x = c * px + px / 2 + desloc;
      const y = Math.min(H - margem, Math.max(margem, r * py + py / 2));
      coloc.push({
        camadaId: camada.id,
        x,
        y,
        escala,
        rotacao: gira ? (rnd() - 0.5) * 0.5 : 0,
      });
    }
  }
  return coloc;
}

/** Distribuição tipo stickers: tamanhos variados, sobreposição permitida. */
function autoCompute(camadas, W, H, plano, leitura) {
  const motivos = camadas.filter((c) => c.kind === 'motivo');
  if (!motivos.length) return [];

  const areaMotivo =
    (motivos.reduce((s, c) => s + c.ow * c.oh, 0) / motivos.length) * plano.escala_motivos ** 2;
  const quantos = Math.max(
    motivos.length,
    Math.min(220, Math.round((W * H * plano.densidade_alvo) / Math.max(1, areaMotivo))),
  );

  const rnd = embaralhavel(quantos * 31 + motivos.length);
  const margem = (Math.min(W, H) * plano.margem_seguranca_pct) / 100;
  // Em arte uniforme o jitter de escala apaga a identidade da estampa.
  const varia = jitterPermitido(leitura);
  const gira = plano.rotacao_permitida && varia;
  const coloc = [];

  // Grade jitterada em vez de posição aleatória pura: aleatório puro amontoa
  // num canto e deixa buraco no outro, e o auditor reprova por "vazio grande".
  const cols = Math.max(1, Math.round(Math.sqrt((quantos * W) / H)));
  const rows = Math.max(1, Math.ceil(quantos / cols));
  const px = W / cols;
  const py = H / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (coloc.length >= quantos) break;
      const camada = motivos[coloc.length % motivos.length];
      coloc.push({
        camadaId: camada.id,
        x: c * px + px * (0.25 + rnd() * 0.5),
        y: Math.min(H - margem, Math.max(margem, r * py + py * (0.25 + rnd() * 0.5))),
        escala: plano.escala_motivos * (varia ? 0.75 + rnd() * 0.5 : 1),
        rotacao: gira ? (rnd() - 0.5) * 1.0 : 0,
      });
    }
  }
  return coloc;
}

/**
 * Composição localizada: o elemento principal em destaque.
 *
 * Quando a leitura diz `heroi_com_satelites`, os satélites entram em volta do
 * herói em vez de serem descartados — era a diferença entre reproduzir a arte e
 * entregar só o elemento central sozinho, que é outra composição.
 *
 * O herói é repetido pelos wrapOffsets como qualquer camada, então a costura
 * continua fechando; o que muda é a quantidade (um por volta) e a escala.
 */
function localizada(camadas, W, H, plano, leitura) {
  const motivos = camadas.filter((c) => c.kind === 'motivo');
  if (!motivos.length) return [];

  const porArea = [...motivos].sort((a, b) => (b.areaOpaca || 0) - (a.areaOpaca || 0));
  const heroi = porArea[0];
  const satelites = porArea.slice(1);

  const cabe = Math.min((W * 0.5) / heroi.ow, (H * 0.62) / heroi.oh);
  const escalaHeroi = cabe * plano.escala_motivos;
  const coloc = [
    { camadaId: heroi.id, x: W / 2, y: H / 2, escala: escalaHeroi, rotacao: 0 },
  ];

  const comSatelites =
    leitura?.composicao?.hierarquia === 'heroi_com_satelites' && satelites.length > 0;
  if (!comSatelites) return coloc;

  // Satélites em anel elíptico em volta do herói. O raio sai do tamanho do
  // herói, então eles acompanham a escala em vez de flutuarem soltos.
  const rnd = embaralhavel(satelites.length * 6151 + Math.round(escalaHeroi * 100));
  const raioX = (heroi.ow * escalaHeroi) / 2 + Math.min(W, H) * 0.1;
  const raioY = (heroi.oh * escalaHeroi) / 2 + Math.min(W, H) * 0.08;
  const quantos = Math.min(12, Math.max(satelites.length, 6));
  const margem = (Math.min(W, H) * plano.margem_seguranca_pct) / 100;

  for (let i = 0; i < quantos; i++) {
    const camada = satelites[i % satelites.length];
    const ang = (i / quantos) * Math.PI * 2 + rnd() * 0.3;
    coloc.push({
      camadaId: camada.id,
      x: W / 2 + Math.cos(ang) * raioX,
      y: Math.min(H - margem, Math.max(margem, H / 2 + Math.sin(ang) * raioY)),
      // Satélite acompanha a escala do herói, mantendo a proporção nativa
      // entre eles — é o que preserva a hierarquia da capinha.
      escala: escalaHeroi * 0.9,
      rotacao: plano.rotacao_permitida ? (rnd() - 0.5) * 0.6 : 0,
    });
  }
  return coloc;
}

/**
 * Distribui as camadas na máscara conforme o plano do A3.
 *
 * `leitura` entra aqui porque a hierarquia decide detalhes que o plano não
 * carrega (se pode variar escala, se satélites acompanham o herói), e `zona`
 * porque a zona da logo é restrição de geometria, não de julgamento.
 */
export function layoutCompute(camadas, mascara, plano, leitura = null, zona = null) {
  const { w: W, h: H } = mascara;
  let coloc;
  switch (plano.estilo) {
    case 'linear':
      coloc = fillGridNoOverlap(camadas, W, H, plano, false, leitura);
      break;
    case 'distribuido':
      coloc = fillGridNoOverlap(camadas, W, H, plano, true, leitura);
      break;
    case 'localizada':
      coloc = localizada(camadas, W, H, plano, leitura);
      break;
    case 'stickers':
    default:
      coloc = autoCompute(camadas, W, H, plano, leitura);
      break;
  }
  const { colocacoes, removidas } = evitaLogo(coloc, camadas, zona);
  return { colocacoes, removidas_pela_logo: removidas };
}

/**
 * Rasteriza no tamanho EXATO da máscara, fundo transparente.
 *
 * Três regras que vêm do motor que já roda em produção:
 *  - camada `kind === 'fonte'` é guia de personalização e NÃO entra;
 *  - camada `kind === 'fundo'` é desenhada primeiro, esticada na máscara;
 *  - toda camada de motivo é desenhada 3x, pelos wrapOffsets.
 */
export function composeFrom(camadas, colocacoes, mascara) {
  const { w: W, h: H } = mascara;
  const saida = novoCanvas(W, H);
  const c = ctx2d(saida);
  c.clearRect(0, 0, W, H);

  const porId = new Map(camadas.map((x) => [x.id, x]));

  for (const camada of camadas) {
    if (camada.kind === 'fundo') c.drawImage(camada.canvas, 0, 0, W, H);
  }

  const offsets = wrapOffsets(W);

  for (const p of colocacoes) {
    const camada = porId.get(p.camadaId);
    if (!camada || camada.kind === 'fonte') continue;
    const w = camada.ow * p.escala;
    const h = camada.oh * p.escala;

    for (const off of offsets) {
      c.save();
      c.translate(p.x + off.dx, p.y + off.dy);
      if (p.rotacao) c.rotate(p.rotacao);
      c.drawImage(camada.canvas, -w / 2, -h / 2, w, h);
      c.restore();
    }
  }

  return saida;
}

// ---------------------------------------------------------------------------
// Medição de costura — camada 1 do A5, determinística
// ---------------------------------------------------------------------------

/**
 * Mede a descontinuidade da emenda, em linhas de pixel.
 *
 * A definição importa. Não basta comparar a coluna 0 com a coluna W-1 e exigir
 * igualdade: numa arte com variação elas SÃO diferentes, e deveriam ser — são
 * duas colunas vizinhas no cilindro. O que caracteriza costura visível é a
 * emenda ter um salto MAIOR que o salto típico entre colunas vizinhas dentro
 * da arte.
 *
 * Então: mede o degrau na emenda linha a linha, e conta quantas linhas passam
 * do 99º percentil do degrau interno. Rapport perfeito dá 0.
 */
export function medirCostura(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const c = ctx2d(canvas);

  const esq = c.getImageData(0, 0, 1, h).data;
  const dir = c.getImageData(w - 1, 0, 1, h).data;

  // Amostra de degraus internos, para saber o que é "normal" nesta arte.
  const amostras = [];
  const passo = Math.max(1, Math.floor(w / 60));
  for (let x = passo; x < w - 1; x += passo) {
    const faixa = c.getImageData(x, 0, 2, h).data;
    for (let y = 0; y < h; y += 4) {
      const i = y * 8;
      amostras.push(
        Math.abs(faixa[i] - faixa[i + 4]) +
          Math.abs(faixa[i + 1] - faixa[i + 5]) +
          Math.abs(faixa[i + 2] - faixa[i + 6]) +
          Math.abs(faixa[i + 3] - faixa[i + 7]),
      );
    }
  }
  amostras.sort((a, b) => a - b);
  const p99 = amostras.length ? amostras[Math.floor(amostras.length * 0.99)] : 0;

  // Piso absoluto: em arte muito lisa o p99 é ~0 e qualquer ruído de
  // compressão contaria como costura.
  const limiar = Math.max(p99, 24);

  let linhas = 0;
  let pior = 0;
  for (let y = 0; y < h; y++) {
    const i = y * 4;
    const d =
      Math.abs(esq[i] - dir[i]) +
      Math.abs(esq[i + 1] - dir[i + 1]) +
      Math.abs(esq[i + 2] - dir[i + 2]) +
      Math.abs(esq[i + 3] - dir[i + 3]);
    if (d > limiar) linhas++;
    if (d > pior) pior = d;
  }

  return { erro_costura_px: linhas, pior_degrau: pior, limiar, altura: h };
}

/**
 * Critério 4 — ampliação máxima aplicada a um recorte.
 *
 * `escala` de uma colocação é exatamente o fator de ampliação, porque o recorte
 * é desenhado a partir do canvas nativo dele: escala 2 significa que cada pixel
 * da arte original virou 4 na impressão. Camada de fundo é medida pelo esticão
 * até a máscara.
 *
 * É medida, não estimativa — e é por isso que o A11 não opina sobre este
 * critério, só escreve a observação.
 */
export function medirAmpliacao(camadas, colocacoes, mascara) {
  const porId = new Map(camadas.map((c) => [c.id, c]));
  let pior = 0;
  let onde = null;

  for (const p of colocacoes) {
    const camada = porId.get(p.camadaId);
    if (!camada || camada.kind === 'fonte') continue;
    if (p.escala > pior) {
      pior = p.escala;
      onde = camada.nome || `recorte #${camada.id}`;
    }
  }

  for (const camada of camadas) {
    if (camada.kind !== 'fundo') continue;
    const f = Math.max(mascara.w / camada.ow, mascara.h / camada.oh);
    if (f > pior) {
      pior = f;
      onde = camada.nome || 'fundo';
    }
  }

  return { ampliacao_maxima: pior || 1, ampliacao_pior_camada: onde };
}

/**
 * Critério 5 — quanto da zona proibida da logo está coberto por arte.
 *
 * Mede na composição já rasterizada, não nas colocações: é o pixel que decide,
 * e camada de fundo esticada também invade. Devolve `null` quando não há zona
 * cadastrada, para o A11 responder "não verificado" em vez de "aprovado".
 */
export function medirInvasaoLogo(canvas, zona) {
  if (!zona || !zona.disponivel) return null;

  const x = Math.max(0, Math.round(zona.x));
  const y = Math.max(0, Math.round(zona.y));
  const w = Math.min(canvas.width - x, Math.round(zona.w));
  const h = Math.min(canvas.height - y, Math.round(zona.h));
  if (w <= 0 || h <= 0) {
    return { invade: false, cobertura: 0, colocacoes_invasoras: 0 };
  }

  const d = ctx2d(canvas).getImageData(x, y, w, h).data;
  let opacos = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 24) opacos++;
  const cobertura = opacos / (w * h);

  // 2% de tolerância: antialiasing de um motivo vizinho encostando na borda da
  // zona não é invasão, e reprovar por isso geraria ajuste sem fim.
  return { invade: cobertura > 0.02, cobertura, colocacoes_invasoras: 0 };
}

/** Reúne as três medições que o A11 recebe como fato. */
export function medirFidelidade(canvas, camadas, colocacoes, mascara, contexto = {}) {
  const costura = medirCostura(canvas);
  const amp = medirAmpliacao(camadas, colocacoes, mascara);
  const logo = medirInvasaoLogo(canvas, contexto.zonaLogo);

  const invasoras = (() => {
    if (!logo || !contexto.zonaLogo?.disponivel) return logo;
    const z = contexto.zonaLogo;
    const porId = new Map(camadas.map((c) => [c.id, c]));
    let n = 0;
    for (const p of colocacoes) {
      const camada = porId.get(p.camadaId);
      if (camada && interseccao(retanguloDe(camada, p), { x: z.x, y: z.y, w: z.w, h: z.h }) > 0) n++;
    }
    return { ...logo, colocacoes_invasoras: n };
  })();

  return {
    erro_costura_px: costura.erro_costura_px,
    ampliacao_maxima: amp.ampliacao_maxima,
    ampliacao_pior_camada: amp.ampliacao_pior_camada,
    arte_nativa: contexto.arteNativa || null,
    invade_logo: invasoras,
    logo_indisponivel:
      contexto.zonaLogo && !contexto.zonaLogo.disponivel ? contexto.zonaLogo.motivo : null,
    camadas: camadas.length,
    colocacoes: colocacoes.length,
    sem_rapport: colocacoes.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Saídas visuais
// ---------------------------------------------------------------------------

/** Ladrilho 3x1: é assim que a arte aparece dando a volta na garrafa. */
export function ladrilho3x1(canvas, alturaAlvo = 700) {
  const escala = Math.min(1, alturaAlvo / canvas.height);
  const w = Math.round(canvas.width * escala);
  const h = Math.round(canvas.height * escala);
  const saida = novoCanvas(w * 3, h);
  const c = ctx2d(saida);
  // Fundo cinza claro: sobre transparente o modelo não vê onde a arte acaba.
  c.fillStyle = '#f2f2f2';
  c.fillRect(0, 0, w * 3, h);
  for (let i = 0; i < 3; i++) c.drawImage(canvas, i * w, 0, w, h);
  return saida;
}

/** Contact-sheet numerado dos recortes, entrada do A4. */
export function contactSheet(camadas, larguraAlvo = 1100) {
  const n = camadas.length;
  if (!n) return { canvas: novoCanvas(10, 10), bboxes: [] };

  const cols = Math.min(6, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const cel = Math.floor(larguraAlvo / cols);
  const rotulo = 22;

  const saida = novoCanvas(cols * cel, rows * (cel + rotulo));
  const c = ctx2d(saida);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, saida.width, saida.height);

  const bboxes = [];
  camadas.forEach((camada, i) => {
    const cx = (i % cols) * cel;
    const cy = Math.floor(i / cols) * (cel + rotulo);

    c.strokeStyle = '#cccccc';
    c.strokeRect(cx + 0.5, cy + rotulo + 0.5, cel - 1, cel - 1);

    const k = Math.min((cel - 12) / camada.ow, (cel - 12) / camada.oh);
    const w = camada.ow * k;
    const h = camada.oh * k;
    c.drawImage(camada.canvas, cx + (cel - w) / 2, cy + rotulo + (cel - h) / 2, w, h);

    c.fillStyle = '#111111';
    c.font = 'bold 15px system-ui, sans-serif';
    c.fillText(`#${camada.id}`, cx + 6, cy + 16);

    bboxes.push({ id: camada.id, ox: camada.ox, oy: camada.oy, ow: camada.ow, oh: camada.oh });
  });

  return { canvas: saida, bboxes };
}

/**
 * Preview leve para guardar no banco e mandar aos agentes de visão.
 *
 * WebP com qualidade 0.85 porque o teto de linha do SQLite é 2 MB e um PNG
 * dessa área passa fácil disso. `mimeAlternativo` cobre navegador sem WebP.
 */
export function paraDataUrl(canvas, alturaAlvo = 900, mime = 'image/webp', qualidade = 0.85) {
  const escala = Math.min(1, alturaAlvo / canvas.height);
  const alvo =
    escala < 1
      ? (() => {
          const c2 = novoCanvas(canvas.width * escala, canvas.height * escala);
          ctx2d(c2).drawImage(canvas, 0, 0, c2.width, c2.height);
          return c2;
        })()
      : canvas;

  let url = alvo.toDataURL(mime, qualidade);
  if (!url.startsWith(`data:${mime}`)) url = alvo.toDataURL('image/jpeg', qualidade);
  return { data_url: url, w: alvo.width, h: alvo.height };
}

// ---------------------------------------------------------------------------
// Esteira completa do lado do browser
// ---------------------------------------------------------------------------

/**
 * Roda os estágios de geometria de um item: separa, compõe e mede.
 *
 * Devolve tudo o que o worker precisa gravar — inclusive o diagnóstico, porque
 * quando a composição sai estranha a primeira pergunta é sempre quantos
 * recortes saíram e quanto fundo foi removido.
 */
export async function processaItem(item, opcoes = {}) {
  const t0 = performance.now();
  const leitura = item.leitura;
  const plano = item.plano;
  if (!leitura || !plano) throw new Error('item sem leitura do A2 ou plano do A3');

  const mascara = { w: item.mascara_w, h: item.mascara_h };
  const img = await carregaImagem(item.png_alta);

  const { camadas: brutas, diagnostico } = await separa(img, leitura, opcoes);
  if (!brutas.length) throw new Error('separador não achou nada, nem motivo nem fundo');

  const folha = contactSheet(brutas);

  // O A4 é opcional: se o chamador não passar o revisor, segue com o primeiro
  // corte determinístico em vez de travar.
  let camadas = brutas;
  let segmentacao = null;
  if (typeof opcoes.revisarSegmentacao === 'function') {
    try {
      segmentacao = await opcoes.revisarSegmentacao(paraDataUrl(folha.canvas, 1000), folha.bboxes);
      if (segmentacao) camadas = aplicaSegmentacao(brutas, segmentacao);
    } catch (e) {
      console.warn('[motor] A4 falhou, seguindo com o recorte determinístico:', e?.message);
    }
  }

  const { colocacoes, removidas_pela_logo } = layoutCompute(
    camadas,
    mascara,
    plano,
    leitura,
    opcoes.zonaLogo || null,
  );

  // Arte de fundo contínuo (aquarela corrida, tie-dye) não tem motivo para
  // distribuir: o separador devolve uma camada só, que cobre o canvas e por
  // isso vira `kind: 'fundo'`. Nesse caso `composeFrom` estica o fundo na
  // máscara e a composição sai — sem rapport, porque não há o que repetir.
  //
  // Isso NÃO é a rota generativa (PIAPP), que ainda não está implementada. É o
  // degradê honesto até ela existir: produz uma arte que o A5 pode julgar, e a
  // costura medida vai denunciar que a emenda não fecha, em vez de o item
  // morrer com "layout vazio" e ninguém saber por quê.
  const temFundo = camadas.some((c) => c.kind === 'fundo');
  if (!colocacoes.length && !temFundo) {
    throw new Error(
      'layout não produziu colocação e não há camada de fundo — ' +
        'arte provavelmente precisa da rota generativa (PIAPP), ainda não implementada',
    );
  }

  const composicao = composeFrom(camadas, colocacoes, mascara);
  const costura = medirCostura(composicao);
  const medicao = medirFidelidade(composicao, camadas, colocacoes, mascara, {
    zonaLogo: opcoes.zonaLogo || null,
    arteNativa: opcoes.arteNativa || null,
  });
  const tile = ladrilho3x1(composicao);

  return {
    composicao,
    camadas,
    segmentacao,
    costura,
    medicao,
    previews: {
      composicao: paraDataUrl(composicao, 900),
      ladrilho3x1: paraDataUrl(tile, 700),
      recortes: paraDataUrl(folha.canvas, 900),
    },
    diagnostico: {
      ...diagnostico,
      camadas_finais: camadas.length,
      colocacoes: colocacoes.length,
      estilo: plano.estilo,
      hierarquia: leitura?.composicao?.hierarquia || null,
      removidas_pela_logo,
      ampliacao_maxima: medicao.ampliacao_maxima,
      sem_rapport: colocacoes.length === 0,
      ms: Math.round(performance.now() - t0),
    },
  };
}
