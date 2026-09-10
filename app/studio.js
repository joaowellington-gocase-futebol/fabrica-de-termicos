/* Estúdio da Fábrica de Térmicos — fluxo da capinha ao térmico entregue.
 *
 * O que é julgamento vai para os agentes (AI Proxy). O que é geometria fica
 * aqui, no navegador, mexendo nos pixels de verdade:
 *   - separar()        tira o fundo e recorta cada motivo
 *   - comporRapport()  distribui na máscara e fecha a costura
 *
 * A costura fecha porque cada peça é desenhada três vezes: em x-L, x e x+L.
 * Nada disso passa por modelo generativo — por isso a arte chega intacta.
 *
 * Quando o Leitor marca separavel=false (fundo contínuo, sem motivo pra
 * recortar), a etapa 5 muda de rota — etapaSepararGenerativa() + gerarViaPiapp()
 * pedem ao PIAPP um padrão novo (visão -> prompt -> job assíncrono, o mesmo
 * padrão do app benchmark-mockups). Aí sim é uma aposta, não uma garantia —
 * por isso a costura continua sendo medida na entrega, como na rota de cima.
 */
(function () {
  "use strict";

  // ══════════════════════════════ tema claro/escuro ══════════════════════════════
  (function initTema() {
    var btn = document.getElementById("tema-btn");
    var label = document.getElementById("tema-label");
    if (!btn) return;
    function aplicar(t) {
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem("tema-termicos", t); } catch (e) {}
      if (label) label.textContent = t === "dark" ? "Modo claro" : "Modo escuro";
      btn.setAttribute("aria-label", t === "dark" ? "Mudar para o modo claro" : "Mudar para o modo escuro");
    }
    aplicar(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    btn.addEventListener("click", function () {
      aplicar(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  })();

  var S = {
    etapa: 0,
    temToken: false,
    agentes: {},
    mascaras: [],
    case: null,        // {sku, nome, identifier, caminho, arte}
    imagem: null,      // HTMLImageElement da arte
    leitura: null,     // saída do agente Leitor
    cores: null,       // saída do agente Variação de cor
    colecao: null,     // saída do agente Set/Coleção
    pecas: [],         // [{canvas, x, y, w, h, area, on}]
    fundo: null,       // laudo do especialista em Fundo
    rotabPrompt: null, // rota generativa: prompt de geração (visão -> texto, PIAPP)
    escolhidas: [],    // chaves de máscara
    plano: null,       // saída do agente Compositor
    saidas: []         // [{mascara, canvas, mockup}]
  };

  /** true quando o Leitor não achou motivo isolável — vai pra rota B (PIAPP). */
  function rotaGenerativa() { return !!(S.leitura && S.leitura.separavel === false); }
  /** etapa 5 (Separador) está pronta tanto na rota determinística quanto na B. */
  function passoSepararOk() { return rotaGenerativa() ? !!S.rotabPrompt : S.pecas.length > 0; }

  var ETAPAS = [
    { k: "case",     t: "Produto de origem", s: "escolher a case" },
    { k: "leitura",  t: "Interpretação",     s: "agente lê a arte" },
    { k: "cor",      t: "Variação de cor",   s: "opcional", op: 1 },
    { k: "colecao",  t: "Set / Coleção",     s: "agente monta o set" },
    { k: "separar",  t: "Separador",         s: "tira fundo, gera camadas" },
    { k: "mascaras", t: "Máscaras",          s: "o ilustrador decide" },
    { k: "entrega",  t: "Entrega",           s: "PNGs, mockups e 3D" }
  ];

  var $ = function (i) { return document.getElementById(i); };
  var el = function (tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var prox = function (u) { return "/api/img?url=" + encodeURIComponent(u); };

  var tT = null;
  function toast(m, erro) {
    var t = $("toast");
    t.textContent = m; t.className = "toast" + (erro ? " err" : ""); t.hidden = false;
    clearTimeout(tT); tT = setTimeout(function () { t.hidden = true; }, erro ? 6500 : 2600);
  }

  function api(rota, opts) {
    return fetch(rota, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok && j.error) throw new Error(j.error);
        return j;
      });
    });
  }

  function rodar(agente, entrada) {
    var a = S.agentes[agente];
    return api("/api/rodar", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agente: agente, entrada: entrada, system: a ? a.system : "",
        // a sessão é a arte em curso: é o que faz o recado de um especialista
        // chegar ao outro mesmo em etapas diferentes
        sessao: S.case ? S.case.identifier : "avulso"
      })
    });
  }

  /** Mostra o que a mesa trocou até agora. */
  function mesaDeRecados(destino) {
    if (!S.case) return;
    api("/api/recados?sessao=" + encodeURIComponent(S.case.identifier)).then(function (j) {
      var rs = j.recados || [];
      if (!rs.length) { destino.innerHTML = ""; return; }
      destino.innerHTML = '<span class="rot" style="margin-top:14px">conversa entre os especialistas</span>' +
        rs.map(function (r) {
          return '<div style="font-size:12.5px;padding:6px 9px;border-left:2px solid var(--accent);' +
                 'background:var(--surface-2);border-radius:0 5px 5px 0;margin-bottom:5px">' +
                 '<span class="mono" style="font-size:10.5px;color:var(--accent-ink)">' +
                 esc(r.de) + ' → ' + esc(r.para) + (Number(r.lido) ? ' · lido' : ' · pendente') + '</span><br>' +
                 '<b style="font-weight:500">' + esc(r.assunto) + '</b> — ' + esc(r.pedido) + '</div>';
        }).join("");
    }).catch(function () {});
  }

  // ══════════════════════════════ geometria ══════════════════════════════

  /** Carrega a imagem pelo proxy, para o canvas poder ler os pixels. */
  function carregarImagem(url) {
    return new Promise(function (ok, erro) {
      var i = new Image();
      i.crossOrigin = "anonymous";
      i.onload = function () { ok(i); };
      i.onerror = function () { erro(new Error("Não consegui carregar a arte.")); };
      i.src = prox(url);
    });
  }

  /**
   * Tira o fundo e recorta cada motivo.
   * 1. lê a cor do fundo nas quatro bordas
   * 2. flood-fill a partir das bordas, com tolerância -> alpha 0
   * 3. rotula o que sobrou em grupos conectados
   * 4. descarta grupo pequeno demais e recorta cada um pela bbox
   */
  function separar(img, tol, areaMinPct) {
    var W = img.naturalWidth, H = img.naturalHeight;
    var cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    var cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    var id = cx.getImageData(0, 0, W, H), d = id.data;

    // cor de fundo: média dos cantos e do meio de cada borda
    var amostras = [[0,0],[W-1,0],[0,H-1],[W-1,H-1],[(W/2)|0,0],[(W/2)|0,H-1],[0,(H/2)|0],[W-1,(H/2)|0]];
    var br=0,bg=0,bb=0;
    amostras.forEach(function (p) {
      var o = (p[1]*W + p[0]) * 4;
      br += d[o]; bg += d[o+1]; bb += d[o+2];
    });
    br /= amostras.length; bg /= amostras.length; bb /= amostras.length;

    var fundo = new Uint8Array(W*H);
    var fila = new Int32Array(W*H), ini = 0, fim = 0;

    function distCor(o) {
      var dr = d[o]-br, dg = d[o+1]-bg, db = d[o+2]-bb;
      return Math.sqrt(dr*dr + dg*dg + db*db);
    }
    function combina(o) { return distCor(o) <= tol; }
    function semear(x, y) {
      var p = y*W + x;
      if (fundo[p]) return;
      if (d[p*4+3] < 8 || combina(p*4)) { fundo[p] = 1; fila[fim++] = p; }
    }
    for (var x = 0; x < W; x++) { semear(x, 0); semear(x, H-1); }
    for (var y = 0; y < H; y++) { semear(0, y); semear(W-1, y); }

    while (ini < fim) {
      var p = fila[ini++], px = p % W, py = (p / W) | 0;
      if (px > 0)   semear(px-1, py);
      if (px < W-1) semear(px+1, py);
      if (py > 0)   semear(px, py-1);
      if (py < H-1) semear(px, py+1);
    }

    // Segunda passada: ILHAS de fundo.
    //
    // O preenchimento acima entra pelas quatro bordas, então só alcança o
    // fundo que encosta na moldura. Um bolsão de papel cercado por folhas fica
    // intocado — e pior, costuma estar colado ao desenho pela borda macia, de
    // modo que cai no mesmo grupo e nem o teste de cor por grupo o separa.
    //
    // Aqui cada bolsão é varrido por conta própria. Some se for grande o
    // bastante para ser fundo de verdade; bolsão minúsculo é detalhe claro do
    // desenho (um miolo de flor, um brilho) e fica onde está.
    var ilhaMin = Math.max(64, W * H * 0.0004);
    var visit = new Uint8Array(W * H);
    var buf = new Int32Array(W * H);
    for (var si = 0; si < W * H; si++) {
      if (fundo[si] || visit[si] || !combina(si * 4)) continue;
      var bi = 0, bf = 0;
      buf[bf++] = si; visit[si] = 1;
      while (bi < bf) {
        var bp = buf[bi++], bx = bp % W, by = (bp / W) | 0;
        for (var oy = -1; oy <= 1; oy++) {
          for (var ox = -1; ox <= 1; ox++) {
            if (!ox && !oy) continue;
            var mx2 = bx + ox, my2 = by + oy;
            if (mx2 < 0 || my2 < 0 || mx2 >= W || my2 >= H) continue;
            var mp = my2 * W + mx2;
            if (visit[mp] || fundo[mp] || !combina(mp * 4)) continue;
            visit[mp] = 1; buf[bf++] = mp;
          }
        }
      }
      if (bf >= ilhaMin) for (var k2 = 0; k2 < bf; k2++) fundo[buf[k2]] = 1;
    }

    // Apaga o fundo, suavizando SÓ a silhueta.
    //
    // Zerar o alpha de todo pixel de fundo devolve degrau de pixel na borda —
    // a aquarela tem transição macia e o corte seco a destrói. Mas aplicar a
    // rampa na região inteira é pior: num fundo de papel texturizado, milhares
    // de pixels ficam meio transparentes e a textura reaparece como sujeira
    // espalhada pela peça.
    //
    // Então: o fundo some inteiro, e o alpha parcial volta apenas na FRONTEIRA
    // — os pixels de fundo que encostam no motivo. É ali, e só ali, que estava
    // o serrilhado.
    var alphaOrig = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) alphaOrig[i] = d[i * 4 + 3];
    for (var i2 = 0; i2 < W * H; i2++) if (fundo[i2]) d[i2 * 4 + 3] = 0;

    var faixaIni = tol * 0.72;
    var faixa = Math.max(1, tol - faixaIni);
    for (var y2 = 0; y2 < H; y2++) {
      for (var x2 = 0; x2 < W; x2++) {
        var pp = y2 * W + x2;
        if (!fundo[pp]) continue;
        // encosta em algo que não é fundo?
        var naSilhueta = false;
        for (var dy2 = -1; dy2 <= 1 && !naSilhueta; dy2++) {
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            if (!dx2 && !dy2) continue;
            var nx2 = x2 + dx2, ny2 = y2 + dy2;
            if (nx2 < 0 || ny2 < 0 || nx2 >= W || ny2 >= H) continue;
            if (!fundo[ny2 * W + nx2]) { naSilhueta = true; break; }
          }
        }
        if (!naSilhueta) continue;
        var dd = distCor(pp * 4);
        if (dd <= faixaIni) continue;                       // é fundo mesmo: fica invisível
        var f = Math.min(1, (dd - faixaIni) / faixa);
        d[pp * 4 + 3] = Math.round(alphaOrig[pp] * f);       // meio caminho: borda macia
      }
    }

    // grupos conectados no que sobrou
    var lab = new Int32Array(W*H), atual = 0, grupos = [];
    for (var s = 0; s < W*H; s++) {
      if (lab[s] || fundo[s] || d[s*4+3] < 24) continue;
      atual++;
      var minx = W, miny = H, maxx = 0, maxy = 0, n = 0;
      var sr = 0, sg = 0, sb = 0;
      ini = 0; fim = 0; fila[fim++] = s; lab[s] = atual;
      while (ini < fim) {
        var q = fila[ini++], qx = q % W, qy = (q / W) | 0;
        n++;
        sr += d[q*4]; sg += d[q*4+1]; sb += d[q*4+2];
        if (qx < minx) minx = qx; if (qx > maxx) maxx = qx;
        if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var nx = qx+dx, ny = qy+dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          var np = ny*W + nx;
          if (lab[np] || fundo[np] || d[np*4+3] < 24) continue;
          lab[np] = atual; fila[fim++] = np;
        }
      }
      grupos.push({ id: atual, minx: minx, miny: miny, maxx: maxx, maxy: maxy, n: n,
                    cr: sr/n, cg: sg/n, cb: sb/n });
    }

    // Peça que cobre quase o canvas inteiro é o fundo que escapou do flood-fill
    // (acontece quando o fundo é textura e a tolerância ficou baixa), não um
    // motivo. Entra no rapport como chapado e mata o padrão — fora.
    var areaMin = W*H*(areaMinPct/100);
    grupos = grupos.filter(function (g) {
      if (g.n < areaMin) return false;
      var gw = g.maxx-g.minx+1, gh = g.maxy-g.miny+1;
      // fundo inteiro que escapou do preenchimento
      if (gw >= W*0.85 && gh >= H*0.85) return false;
      // ILHA DE FUNDO: bolsão de papel cercado por folhas, que o preenchimento
      // não alcança porque não encosta em borda nenhuma. A cor entrega: se a
      // média do grupo é a cor do papel, aquilo não é desenho.
      var dr = g.cr - br, dg2 = g.cg - bg, db = g.cb - bb;
      if (Math.sqrt(dr*dr + dg2*dg2 + db*db) <= tol * 0.85) return false;
      return true;
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, 40);

    // recorta cada grupo, mantendo só os pixels DELE
    return grupos.map(function (g) {
      var gw = g.maxx-g.minx+1, gh = g.maxy-g.miny+1;
      var c = document.createElement("canvas");
      c.width = gw; c.height = gh;
      var ctx = c.getContext("2d");
      var out = ctx.createImageData(gw, gh), od = out.data;
      for (var yy = 0; yy < gh; yy++) for (var xx = 0; xx < gw; xx++) {
        var src = (g.miny+yy)*W + (g.minx+xx), dst = (yy*gw + xx)*4;
        // do próprio motivo, ou pixel de silhueta que encosta nele
        if (lab[src] !== g.id) {
          if (lab[src] !== 0 || d[src*4+3] === 0) continue;
          var vizinhoDoGrupo = false;
          var sx = g.minx+xx, sy = g.miny+yy;
          for (var vy = -1; vy <= 1 && !vizinhoDoGrupo; vy++) {
            for (var vx = -1; vx <= 1; vx++) {
              if (!vx && !vy) continue;
              var ax = sx+vx, ay = sy+vy;
              if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
              if (lab[ay*W + ax] === g.id) { vizinhoDoGrupo = true; break; }
            }
          }
          if (!vizinhoDoGrupo) continue;
        }
        od[dst] = d[src*4]; od[dst+1] = d[src*4+1]; od[dst+2] = d[src*4+2]; od[dst+3] = d[src*4+3];
      }
      ctx.putImageData(out, 0, 0);
      return {
        canvas: c, w: gw, h: gh, area: g.n, on: true,
        // centro de onde a peça saiu, em 0..1 — é o que permite cruzar com a
        // posição que o Leitor descreveu ("canto superior direito").
        cx: (g.minx + gw/2) / W, cy: (g.miny + gh/2) / H,
      };
    });
  }

  /**
   * O Leitor descreve a posição em português ("canto superior direito").
   * Aqui isso vira uma faixa de 0 a 1 para cruzar com o centro de cada peça.
   * Serve para SUGERIR o que desligar — quem decide continua sendo o ilustrador.
   */
  function regiaoDoTexto(txt) {
    var t = (txt || "").toLowerCase();
    var x0 = 0, x1 = 1, y0 = 0, y1 = 1;
    if (/(superior|topo|alto|cima)/.test(t))      { y0 = 0;    y1 = 0.38; }
    if (/(inferior|baixo|rodap|fundo da)/.test(t)) { y0 = 0.62; y1 = 1;    }
    if (/(central|meio|centro)/.test(t))          { y0 = 0.28; y1 = 0.72; }
    if (/(direit)/.test(t))                        { x0 = 0.55; x1 = 1;    }
    if (/(esquerd)/.test(t))                       { x0 = 0;    x1 = 0.45; }
    if (x0 === 0 && x1 === 1 && y0 === 0 && y1 === 1) return null;  // vago demais
    return { x0: x0, x1: x1, y0: y0, y1: y1 };
  }

  /** Desliga as peças que caem onde o Leitor apontou marca ou personalização. */
  function sugerirRemocao(pecas, leitura) {
    var alvos = (leitura && leitura.elementos_a_remover) || [];
    if (!alvos.length) return 0;
    var n = 0;
    alvos.forEach(function (a) {
      var r = regiaoDoTexto(a.onde);
      if (!r) return;
      pecas.forEach(function (p) {
        if (p.suspeita) return;
        if (p.cx >= r.x0 && p.cx <= r.x1 && p.cy >= r.y0 && p.cy <= r.y1) {
          p.on = false; p.suspeita = a.tipo; n++;
        }
      });
    });
    return n;
  }

  /**
   * Distribui as peças na máscara e fecha a costura.
   * Cada peça entra três vezes — x-L, x e x+L — então o que sai pela direita
   * volta pela esquerda com o mesmo recorte. É aqui que o rapport acontece.
   */
  function comporRapport(pecas, L, A, opts) {
    opts = opts || {};
    var escalaPedida = Math.max(0.3, Math.min(1.8, opts.escala || 1));
    // Teto de ampliação. A arte de origem é o preview da capinha (~851 px de
    // largura) e a máscara do térmico tem 2754: a área de impressão do térmico
    // é 4x maior em pixels. Esticar a peça para preencher a máscara borra —
    // media 1,36x e pior caso 2,48x na versão anterior. A saída é repetir mais
    // vezes em vez de ampliar: acima de 1 a peça perde definição de verdade.
    var teto = opts.maxUpscale != null ? opts.maxUpscale : 1;
    var stagger = opts.stagger !== false;
    var fundo = opts.fundo || null;

    var cv = document.createElement("canvas");
    cv.width = L; cv.height = A;
    var cx = cv.getContext("2d");
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    if (fundo) { cx.fillStyle = fundo; cx.fillRect(0, 0, L, A); }

    if (!pecas.length) return cv;

    var margemY = A * (opts.margemPct != null ? opts.margemPct : 0.035);
    var areaY = A - margemY * 2;

    // A célula sai do tamanho NATIVO das peças, não da contagem delas. É o que
    // decide quantas cabem — e o que impede o esticão.
    var lados = pecas.map(function (p) { return Math.max(p.w, p.h); })
                     .sort(function (a, b) { return a - b; });
    var tipico = lados[lados.length >> 1] || 1;
    var celula = (tipico * escalaPedida) / 0.88;         // 0.88 = respiro; menor = padrão mais cheio

    var cols = Math.max(2, Math.round(L / celula));
    var rows = Math.max(2, Math.round(areaY / celula));
    var cw = L / cols, ch = areaY / rows;

    var n = pecas.length, idx = 0, somaK = 0, contK = 0, piorK = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var pe = pecas[idx % n]; idx++;
        var off = (stagger && (r % 2)) ? cw / 2 : 0;
        var ccx = c * cw + cw / 2 + off;
        var ccy = margemY + r * ch + ch / 2;

        var cabe = Math.min(cw, ch) * 0.82;
        // reduzir é de graça; ampliar custa nitidez, então tem teto
        var k = Math.min(cabe / pe.w, cabe / pe.h, escalaPedida * teto);
        var w = pe.w * k, h = pe.h * k;
        var x = ccx - w / 2, y = ccy - h / 2;

        somaK += k; contK++; if (k > piorK) piorK = k;

        // a mesma peça, três vezes: é isso que fecha a emenda
        cx.drawImage(pe.canvas, x - L, y, w, h);
        cx.drawImage(pe.canvas, x,     y, w, h);
        cx.drawImage(pe.canvas, x + L, y, w, h);
      }
    }
    cv._nitidez = { media: contK ? somaK / contK : 1, pior: piorK, grade: cols + "x" + rows,
                    repeticoes: cols * rows };
    return cv;
  }

  /**
   * Mede a emenda comparando-a com a variação natural do próprio desenho.
   *
   * Ao enrolar na garrafa, a última coluna encosta na primeira: são VIZINHAS,
   * não iguais. Então a pergunta não é "o salto é zero?", e sim "esse salto se
   * destaca dos saltos que já existem dentro do desenho?".
   *
   * A primeira versão comparava com a mediana dos saltos internos, e isso
   * enganava: num padrão esparso a maioria das colunas cai em área vazia, a
   * mediana despenca e qualquer emenda parece enorme. Agora a emenda é
   * posicionada na distribuição inteira — se existem colunas internas com salto
   * maior, a emenda não é achável a olho.
   */
  function medirCostura(cv) {
    var cx = cv.getContext("2d", { willReadFrequently: true });
    var W = cv.width, H = cv.height;

    function salto(x1, x2) {
      var a = cx.getImageData(x1, 0, 1, H).data;
      var b = cx.getImageData(x2, 0, 1, H).data;
      var s = 0;
      for (var i = 0; i < a.length; i += 4) {
        s += Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) +
             Math.abs(a[i+2]-b[i+2]) + Math.abs(a[i+3]-b[i+3]);
      }
      return s / (H * 4);
    }

    var emenda = salto(W - 1, 0);

    // amostragem densa o bastante para a distribuição significar algo
    var passo = Math.max(4, Math.floor(W / 150));
    var internos = [];
    for (var x = 0; x < W - 1; x += passo) internos.push(salto(x, x + 1));
    internos.sort(function (a, b) { return a - b; });

    var piores = internos.filter(function (v) { return v > emenda; }).length;
    var percentil = internos.length
      ? Math.round(100 * internos.filter(function (v) { return v < emenda; }).length / internos.length)
      : 0;

    return {
      emenda: emenda,
      mediana: internos[internos.length >> 1] || 0,
      maior: internos[internos.length - 1] || 0,
      percentil: percentil,
      piores: piores,
      // Invisível quando o desenho já tem, em vários pontos, saltos desse
      // tamanho. Percentil 100 com zero colunas piores é costura de verdade.
      invisivel: piores >= 2,
    };
  }

  // ══════════════════════════════ navegação ══════════════════════════════

  function liberada(i) {
    if (i === 0) return true;
    if (i === 1) return !!S.case;
    if (i === 2 || i === 3) return !!S.leitura;
    if (i === 4) return !!S.leitura;
    if (i === 5) return passoSepararOk();
    if (i === 6) return S.saidas.length > 0;
    return false;
  }
  function feita(i) {
    return [!!S.case, !!S.leitura, !!S.cores, !!S.colecao,
            passoSepararOk(), S.escolhidas.length > 0, S.saidas.length > 0][i];
  }

  function trilha() {
    var t = $("trilha"); t.innerHTML = "";
    ETAPAS.forEach(function (e, i) {
      var b = el("button", "pas");
      b.type = "button";
      if (e.op) b.dataset.op = "1";
      b.dataset.st = feita(i) ? "feito" : "";
      b.setAttribute("aria-current", String(i === S.etapa));
      b.disabled = !liberada(i);
      b.innerHTML = '<span class="n">' + (i+1) + '</span>' +
                    '<span class="t">' + esc(e.t) + '</span>' +
                    '<span class="s">' + (feita(i) ? "pronto" : esc(e.s)) + '</span>';
      b.addEventListener("click", function () { ir(i); });
      t.appendChild(b);
    });
  }

  function ir(i) { S.etapa = i; trilha(); pintar(); window.scrollTo({ top: 0, behavior: "smooth" }); }

  function painel(titulo, desc) {
    var p = el("section", "painel");
    p.appendChild(el("div", "p-hd", "<h2>" + esc(titulo) + "</h2><p>" + desc + "</p>"));
    var bd = el("div", "p-bd"); p.appendChild(bd);
    var ft = el("div", "p-ft"); p.appendChild(ft);
    return { p: p, bd: bd, ft: ft };
  }
  function avancar(ft, rotulo, i, cond) {
    var b = el("button", "btn primary", rotulo || "Avançar");
    b.type = "button";
    b.disabled = cond === false;
    b.addEventListener("click", function () { ir(i); });
    ft.appendChild(el("span", "sp"));
    ft.appendChild(b);
    return b;
  }

  // ══════════════════════════════ etapas ══════════════════════════════

  function pintar() {
    var palco = $("palco"); palco.innerHTML = "";
    [etapaCase, etapaLeitura, etapaCor, etapaColecao, etapaSeparar, etapaMascaras, etapaEntrega][S.etapa](palco);
  }

  // ---------- 1. produto de origem ----------
  function etapaCase(palco) {
    var v = painel("Produto de origem",
      "Comece pela capinha. Digite o identificador da estampa e escolha a arte que vai virar térmico.");
    var busca = el("div", null,
      '<span class="rot">identificador da estampa</span>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<input class="txt" id="q" value="ramos-de-lavanda" placeholder="ex.: ramos-de-lavanda">' +
        '<button class="btn" type="button" id="buscar">Buscar</button>' +
      '</div>' +
      '<div style="margin-top:7px;font-size:12.5px;color:var(--muted)">' +
        'Sugestões que vendem bem e ainda não existem em térmico: ' +
        '<a href="#" data-s="aquarela">aquarela</a> · <a href="#" data-s="colagem">colagem</a> · ' +
        '<a href="#" data-s="ramos-de-lavanda">ramos-de-lavanda</a> · <a href="#" data-s="oncinha">oncinha</a>' +
      '</div>');
    v.bd.appendChild(busca);
    var res = el("div", null, '<div class="vazio">Busque uma estampa para começar.</div>');
    res.style.marginTop = "18px";
    v.bd.appendChild(res);
    palco.appendChild(v.p);

    function buscar(q) {
      res.innerHTML = '<div class="carregando"><span class="spin"></span>procurando…</div>';
      api("/api/case?q=" + encodeURIComponent(q)).then(function (j) {
        if (!j.itens || !j.itens.length) {
          res.innerHTML = '<div class="vazio">' + esc(j.aviso || "Nada encontrado.") + '</div>';
          return;
        }
        res.innerHTML = '<span class="rot">' + j.itens.length + ' arte(s) encontradas — escolha uma</span>';
        var g = el("div", "artes");
        j.itens.forEach(function (it) {
          var b = el("button", "arte");
          b.type = "button";
          b.setAttribute("aria-pressed", String(!!S.case && S.case.caminho === it.caminho));
          b.innerHTML = '<img loading="lazy" src="' + esc(prox(it.arte)) + '" alt="">' +
                        '<b>' + esc(it.nome) + '</b><span>' + esc(it.sku) + '</span>';
          b.addEventListener("click", function () {
            S.case = it; S.imagem = null; S.leitura = null; S.cores = null;
            S.colecao = null; S.pecas = []; S.rotabPrompt = null; S.saidas = [];
            toast("Case selecionada: " + it.nome);
            ir(1);
          });
          g.appendChild(b);
        });
        res.appendChild(g);
      }).catch(function (e) {
        res.innerHTML = '<div class="aviso err">' + esc(e.message) + '</div>';
      });
    }

    $("buscar").addEventListener("click", function () { buscar($("q").value.trim()); });
    $("q").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); buscar($("q").value.trim()); }
    });
    Array.prototype.forEach.call(busca.querySelectorAll("[data-s]"), function (a) {
      a.addEventListener("click", function (ev) {
        ev.preventDefault(); $("q").value = a.dataset.s; buscar(a.dataset.s);
      });
    });
    buscar($("q").value.trim());
  }

  // ---------- 2. interpretação ----------
  function etapaLeitura(palco) {
    var v = painel("Interpretação",
      "O agente olha a arte e decide o caminho: se dá para recortar os motivos um a um, e o que " +
      "precisa sair antes — a marca da casa e a letra de personalização vêm queimadas no preview.");
    var d = el("div", "dupla");
    var vis = el("div", "visual", '<img src="' + esc(prox(S.case.arte)) + '" alt="Arte da case">');
    var lado = el("div");
    d.appendChild(vis); d.appendChild(lado);
    v.bd.appendChild(d);
    palco.appendChild(v.p);

    var b = el("button", "btn primary", S.leitura ? "Interpretar de novo" : "Interpretar");
    b.type = "button";
    v.ft.appendChild(b);

    function mostrar(x) {
      lado.innerHTML = "";
      var r = el("div", "resumo");
      function kv(k, html) { r.appendChild(el("div", "kv", "<b>" + k + "</b><span>" + html + "</span>")); }
      kv("tipo", esc(x.tipo || "—"));
      kv("dá pra separar", x.separavel
        ? '<span class="pil ok">sim — recorte direto</span>'
        : '<span class="pil no">não — precisa recompor</span>');
      kv("densidade", esc(x.densidade || "—"));
      kv("estilo", esc(x.estilo || "—"));
      if (x.motivos && x.motivos.length) {
        kv("motivos", '<span class="pilulas">' + x.motivos.map(function (m) {
          return '<span class="pil">' + esc(m.nome) + (m.contagem_aprox ? " ×" + esc(m.contagem_aprox) : "") + '</span>';
        }).join("") + '</span>');
      }
      if (x.elementos_a_remover && x.elementos_a_remover.length) {
        kv("sai antes do recorte", '<span class="pilulas">' + x.elementos_a_remover.map(function (m) {
          return '<span class="pil rm">' + esc(m.tipo) + " · " + esc(m.onde) + '</span>';
        }).join("") + '</span>');
      }
      kv("bloqueio", (x.bloqueio_terceiro || x.texto_na_arte)
        ? '<span class="pil no">sim — vai para conferência humana</span>'
        : '<span class="pil ok">livre</span>');
      if (x.paleta && x.paleta.length) {
        kv("paleta", '<span class="swatches">' + x.paleta.map(function (c) {
          return '<i class="sw" style="background:' + esc(c) + '" title="' + esc(c) + '"></i>';
        }).join("") + '</span>');
      }
      lado.appendChild(r);
      var det = el("details", "crua", "<summary>resposta completa do agente</summary>");
      det.appendChild(el("pre", "out", esc(JSON.stringify(x, null, 2))));
      lado.appendChild(det);
    }

    if (S.leitura) mostrar(S.leitura);
    else lado.innerHTML = '<div class="vazio">Clique em Interpretar para o agente ler esta arte.</div>';

    b.addEventListener("click", function () {
      b.disabled = true; b.textContent = "Lendo…";
      lado.innerHTML = '<div class="carregando"><span class="spin"></span>o agente está olhando a arte…</div>';
      rodar("leitor", S.case.arte).then(function (r) {
        if (!r.ok) throw new Error(r.erro);
        S.leitura = r.dados;
        toast("Interpretado em " + (r.ms/1000).toFixed(1) + "s");
        ir(2);
      }).catch(function (e) {
        lado.innerHTML = '<div class="aviso err">' + esc(e.message) + '</div>';
      }).then(function () { b.disabled = false; b.textContent = "Interpretar de novo"; });
    });
  }

  // ---------- 3. variação de cor (opcional) ----------
  function etapaCor(palco) {
    var v = painel("Variação de cor <span style='font-size:12px;color:var(--muted);font-weight:400'>· opcional</span>",
      "Mesma arte, outra cartela. Serve para render a estampa em mais de um corpo de garrafa. " +
      "Pode pular sem prejuízo.");
    var d = el("div", "dupla");
    var vis = el("div", "visual", '<img src="' + esc(prox(S.case.arte)) + '" alt="Arte da case">');
    var lado = el("div");
    d.appendChild(vis); d.appendChild(lado);
    v.bd.appendChild(d);
    palco.appendChild(v.p);

    var b = el("button", "btn", S.cores ? "Gerar de novo" : "Gerar variações");
    b.type = "button"; v.ft.appendChild(b);
    var pular = el("button", "btn ghost", "Pular esta etapa"); pular.type = "button";
    pular.addEventListener("click", function () { ir(3); });
    v.ft.appendChild(pular);
    avancar(v.ft, "Avançar", 3, true);

    function mostrar(x) {
      lado.innerHTML = "";
      (x.variacoes || []).forEach(function (o) {
        var c = el("div", "resumo");
        c.style.cssText = "border:1px solid var(--line);border-radius:7px;padding:11px;margin-bottom:9px";
        c.innerHTML =
          '<div class="kv"><b>' + esc(o.nome || "variação") + '</b>' +
          '<span class="swatches">' + (o.paleta||[]).map(function (h) {
            return '<i class="sw" style="background:' + esc(h) + '" title="' + esc(h) + '"></i>';
          }).join("") + '</span></div>' +
          '<div class="kv"><b>corpo ideal</b><span class="pil">' + esc(o.corpo_ideal || "—") + '</span></div>' +
          '<div class="kv"><b>por quê</b><span>' + esc(o.racional || "") + '</span></div>';
        lado.appendChild(c);
      });
      var det = el("details", "crua", "<summary>resposta completa do agente</summary>");
      det.appendChild(el("pre", "out", esc(JSON.stringify(x, null, 2))));
      lado.appendChild(det);
    }

    if (S.cores) mostrar(S.cores);
    else lado.innerHTML = '<div class="vazio">Opcional — gere variações ou siga direto.</div>';

    b.addEventListener("click", function () {
      b.disabled = true; b.textContent = "Gerando…";
      lado.innerHTML = '<div class="carregando"><span class="spin"></span>propondo cartelas…</div>';
      rodar("colorista", S.case.arte).then(function (r) {
        if (!r.ok) throw new Error(r.erro);
        S.cores = r.dados; mostrar(r.dados); trilha();
      }).catch(function (e) {
        lado.innerHTML = '<div class="aviso err">' + esc(e.message) + '</div>';
      }).then(function () { b.disabled = false; b.textContent = "Gerar de novo"; });
    });
  }

  // ---------- 4. set / coleção ----------
  function etapaColecao(palco) {
    var v = painel("Set / Coleção",
      "O agente transforma a estampa em conjunto: peças que se reconhecem como da mesma família, " +
      "variando densidade e escala. Cada peça vira uma opção de composição adiante.");
    var lado = el("div");
    v.bd.appendChild(lado);
    palco.appendChild(v.p);

    var b = el("button", "btn primary", S.colecao ? "Montar de novo" : "Montar o set");
    b.type = "button"; v.ft.appendChild(b);
    var prox2 = avancar(v.ft, "Separar as camadas", 4, true);

    function mostrar(x) {
      lado.innerHTML = '<div class="kv"><b>set</b><span style="font-size:16px;font-weight:600">' +
                       esc(x.nome_do_set || "—") + '</span></div>' +
                       '<div class="kv"><b>conceito</b><span>' + esc(x.conceito || "") + '</span></div>';
      var g = el("div", "entrega"); g.style.marginTop = "14px";
      (x.pecas || []).forEach(function (pz) {
        var c = el("div", "ent");
        c.innerHTML =
          '<div class="ent-hd"><b>' + esc(pz.nome || "peça") + '</b><span>' + esc(pz.densidade || "") + '</span></div>' +
          '<div style="padding:11px 12px;display:grid;gap:6px;font-size:12.5px">' +
            '<div class="pilulas">' +
              '<span class="pil">' + esc(pz.estilo || "—") + '</span>' +
              '<span class="pil">escala ' + esc(pz.escala || "—") + '</span>' +
              '<span class="pil">corpo ' + esc(pz.corpo_sugerido || "—") + '</span>' +
            '</div>' +
            '<div style="color:var(--muted)">' + esc(pz.papel_no_set || "") + '</div>' +
          '</div>';
        g.appendChild(c);
      });
      lado.appendChild(g);
      var det = el("details", "crua", "<summary>resposta completa do agente</summary>");
      det.appendChild(el("pre", "out", esc(JSON.stringify(x, null, 2))));
      lado.appendChild(det);
    }

    if (S.colecao) mostrar(S.colecao);
    else lado.innerHTML = '<div class="vazio">Clique em Montar o set.</div>';

    b.addEventListener("click", function () {
      b.disabled = true; b.textContent = "Montando…";
      lado.innerHTML = '<div class="carregando"><span class="spin"></span>montando o set…</div>';
      var entrada = JSON.stringify({
        estampa: S.case.identifier,
        estilo: S.leitura.estilo,
        motivos: (S.leitura.motivos || []).map(function (m) { return m.nome; }),
        paleta: S.leitura.paleta,
        pecas_do_set: 4
      }, null, 2);
      rodar("colecao", entrada).then(function (r) {
        if (!r.ok) throw new Error(r.erro);
        S.colecao = r.dados; mostrar(r.dados); trilha();
      }).catch(function (e) {
        lado.innerHTML = '<div class="aviso err">' + esc(e.message) + '</div>';
      }).then(function () { b.disabled = false; b.textContent = "Montar de novo"; });
    });
  }

  // ---------- 5. separador ----------
  function etapaSeparar(palco) {
    if (rotaGenerativa()) { etapaSepararGenerativa(palco); return; }
    var v = painel("Separador",
      "O recorte é código: o fundo sai por preenchimento a partir das bordas e cada motivo é " +
      "separado por vizinhança de pixel. A arte continua a mesma, nada é redesenhado. " +
      "Quem decide a <b>tolerância</b> é o especialista em Fundo — pergunte a ele antes de separar. " +
      "Depois, desligue o que for sujeira ou o que o Leitor apontou para remover.");
    var ctrl = el("div", null,
      '<div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">' +
        '<label><span class="rot">tolerância do fundo</span>' +
          '<input type="range" id="tol" min="20" max="220" value="110" style="width:180px"> ' +
          '<span class="mono" id="tolv">110</span></label>' +
        '<label><span class="rot">tamanho mínimo da peça</span>' +
          '<input type="range" id="amin" min="1" max="40" value="6" style="width:180px"> ' +
          '<span class="mono" id="aminv">0,06%</span></label>' +
        '<button class="btn" type="button" id="fundoAg">Perguntar ao Fundo</button>' +
        '<button class="btn" type="button" id="sep">Separar</button>' +
      '</div>');
    v.bd.appendChild(ctrl);
    var laudo = el("div"); laudo.style.marginTop = "12px";
    v.bd.appendChild(laudo);
    var saida = el("div"); saida.style.marginTop = "16px";
    v.bd.appendChild(saida);
    var mesa = el("div");
    v.bd.appendChild(mesa);
    palco.appendChild(v.p);
    var prox2 = avancar(v.ft, "Escolher as máscaras", 5, S.pecas.length > 0);

    // O Fundo é quem sabe a tolerância. Antes disso era um número no escuro.
    $("fundoAg").addEventListener("click", function () {
      var b = $("fundoAg");
      b.disabled = true; b.textContent = "Perguntando…";
      laudo.innerHTML = '<div class="carregando"><span class="spin"></span>o Fundo está olhando…</div>';
      rodar("fundo", S.case.arte).then(function (r) {
        if (!r.ok) throw new Error(r.erro);
        var d = r.dados;
        S.fundo = d;
        var t = Number(d.tolerancia_recomendada);
        if (t >= 20 && t <= 220) { $("tol").value = t; $("tolv").textContent = t; }
        laudo.innerHTML =
          '<div class="pilulas">' +
            '<span class="pil ok">Fundo</span>' +
            '<span class="pil">' + esc(d.tipo || "—") + '</span>' +
            '<span class="pil">tolerância ' + esc(t) + '</span>' +
            '<span class="pil"><i class="sw" style="display:inline-block;width:11px;height:11px;' +
              'vertical-align:-1px;background:' + esc(d.cor_dominante || "#ccc") + '"></i> ' +
              esc(d.cor_dominante || "") + '</span>' +
            (d.removivel === false ? '<span class="pil no">não removível — rota generativa</span>' : "") +
          '</div>' +
          '<div style="font-size:12.5px;color:var(--muted);margin-top:5px">' + esc(d.por_que || "") + '</div>';
        mesaDeRecados(mesa);
        toast("Fundo sugeriu tolerância " + t + ".");
      }).catch(function (e) {
        laudo.innerHTML = '<div class="aviso err">' + esc(e.message) + '</div>';
      }).then(function () { b.disabled = false; b.textContent = "Perguntar ao Fundo"; });
    });

    $("tol").addEventListener("input", function (e) { $("tolv").textContent = e.target.value; });
    $("amin").addEventListener("input", function (e) {
      $("aminv").textContent = (e.target.value/100).toFixed(2).replace(".", ",") + "%";
    });

    function desenhar() {
      saida.innerHTML = "";
      if (!S.pecas.length) {
        saida.innerHTML = '<div class="vazio">Nenhuma peça ainda. Clique em Separar.</div>';
        return;
      }
      var ativas = S.pecas.filter(function (p) { return p.on; }).length;
      saida.appendChild(el("span", "rot",
        S.pecas.length + " peças recortadas · " + ativas + " em uso — clique para ligar ou desligar"));
      var g = el("div", "camadas");
      S.pecas.forEach(function (pz, i) {
        var b = el("div", "cam");
        b.setAttribute("role", "button");
        b.setAttribute("tabindex", "0");
        b.setAttribute("aria-pressed", String(pz.on));
        var mini = document.createElement("canvas");
        var k = Math.min(96/pz.w, 96/pz.h);
        mini.width = Math.max(1, Math.round(pz.w*k));
        mini.height = Math.max(1, Math.round(pz.h*k));
        mini.getContext("2d").drawImage(pz.canvas, 0, 0, mini.width, mini.height);
        b.appendChild(mini);
        b.appendChild(el("small", null,
          pz.suspeita ? "⚠ " + pz.suspeita.replace(/_/g, " ") : pz.w + "×" + pz.h));
        if (pz.suspeita) b.title = "O Leitor apontou " + pz.suspeita.replace(/_/g, " ") +
                                   " nesta região. Confira antes de ligar.";
        function alterna() {
          pz.on = !pz.on;
          b.setAttribute("aria-pressed", String(pz.on));
          saida.querySelector(".rot").textContent =
            S.pecas.length + " peças recortadas · " +
            S.pecas.filter(function (q) { return q.on; }).length + " em uso — clique para ligar ou desligar";
        }
        b.addEventListener("click", alterna);
        b.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); alterna(); }
        });
        g.appendChild(b);
      });
      saida.appendChild(g);
    }

    desenhar();

    $("sep").addEventListener("click", function () {
      var b = $("sep");
      b.disabled = true; b.textContent = "Separando…";
      saida.innerHTML = '<div class="carregando"><span class="spin"></span>lendo os pixels…</div>';
      var passo = S.imagem ? Promise.resolve(S.imagem) : carregarImagem(S.case.arte);
      passo.then(function (img) {
        S.imagem = img;
        return new Promise(function (ok) {
          setTimeout(function () {
            S.pecas = separar(img, Number($("tol").value), Number($("amin").value)/100);
            S.desligadas = sugerirRemocao(S.pecas, S.leitura);
            ok();
          }, 30);
        });
      }).then(function () {
        desenhar(); mesaDeRecados(mesa); trilha();
        prox2.disabled = S.pecas.length === 0;
        toast(S.pecas.length + " peças recortadas" +
              (S.desligadas ? " · " + S.desligadas + " desligadas onde o Leitor apontou marca" : "") + ".");
      }).catch(function (e) {
        saida.innerHTML = '<div class="aviso err">' + esc(e.message) + '</div>';
      }).then(function () { b.disabled = false; b.textContent = "Separar"; });
    });
  }

  // ---------- 5b. separador · rota generativa (fundo contínuo -> PIAPP) ----------
  //
  // Sem motivo isolável para recortar: dois agentes em cadeia descrevem a
  // arte em texto (ignorando case, logo e letra de personalização) e o PIAPP
  // gera um padrão novo, do zero, seamless. É uma aposta, não uma garantia —
  // por isso a costura continua sendo MEDIDA na entrega, igual à rota
  // determinística (docs/COMO-FUNCIONA.md § Por que o rapport não é IA).
  function etapaSepararGenerativa(palco) {
    var v = painel("Separador · rota generativa",
      "O Leitor não achou motivo isolável nesta arte — é fundo contínuo. Aqui não tem recorte de pixel: " +
      "um agente de visão descreve a arte em texto (ignorando case, logo e letra de personalização) e o " +
      "PIAPP gera um padrão novo a partir do texto. Revise o prompt antes de gerar — é a única alavanca " +
      "desta etapa.");
    var lado = el("div");
    v.bd.appendChild(lado);
    palco.appendChild(v.p);

    var b = el("button", "btn primary", S.rotabPrompt ? "Gerar prompt de novo" : "Gerar prompt");
    b.type = "button"; v.ft.appendChild(b);
    var prox2 = avancar(v.ft, "Escolher as máscaras", 5, !!S.rotabPrompt);

    function mostrar() {
      lado.innerHTML =
        '<span class="rot">prompt de geração (editável, em inglês)</span>' +
        '<textarea id="rotab-prompt" class="txt" style="width:100%;min-height:130px;' +
          'font-family:\'IBM Plex Mono\',monospace;font-size:12.5px;line-height:1.5"></textarea>' +
        '<div style="margin-top:7px;font-size:12px;color:var(--muted)">' +
          'Editar aqui muda só esta geração. Ao gerar, o mesmo tipo de restrição (sem case, sem texto, ' +
          'sem logo) é reforçado de novo — reduz o risco de o PIAPP "vazar" o produto de origem.</div>';
      $("rotab-prompt").value = S.rotabPrompt;
      $("rotab-prompt").addEventListener("input", function (e) { S.rotabPrompt = e.target.value; });
    }

    if (S.rotabPrompt) mostrar();
    else lado.innerHTML = '<div class="vazio">Clique em Gerar prompt.</div>';

    b.addEventListener("click", function () {
      b.disabled = true; b.textContent = "Descrevendo a arte…";
      lado.innerHTML = '<div class="carregando"><span class="spin"></span>' +
                        'o agente de visão está descrevendo a arte…</div>';
      api("/api/rotab/prompt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ arte: S.case.arte })
      }).then(function (r) {
        S.rotabPrompt = r.prompt; mostrar();
        prox2.disabled = false; trilha();
        toast("Prompt gerado.");
      }).catch(function (e) {
        lado.innerHTML = '<div class="aviso err">' + esc(e.message) + '</div>';
      }).then(function () { b.disabled = false; b.textContent = "Gerar prompt de novo"; });
    });
  }

  /** Carrega uma imagem já servida por esta mesma origem (sem precisar do proxy /api/img). */
  function carregarImagemLocal(url) {
    return new Promise(function (ok, erro) {
      var i = new Image();
      i.crossOrigin = "anonymous";
      i.onload = function () { ok(i); };
      i.onerror = function () { erro(new Error("Não consegui carregar a imagem gerada.")); };
      i.src = url;
    });
  }

  /** Poll do job PIAPP: 6s entre tentativas, até 40 (4 minutos) — como no benchmark-mockups. */
  function aguardarPiapp(id) {
    var tentativas = 0;
    return new Promise(function (ok, erro) {
      (function checar() {
        tentativas++;
        api("/api/rotab/status?id=" + id).then(function (s) {
          if (s.status === "completed") { ok("/api/rotab/imagem?id=" + id); return; }
          if (s.status === "failed") { erro(new Error(s.erro || "Falhou na geração.")); return; }
          if (tentativas >= 40) { erro(new Error("A geração passou de 4 minutos e foi cancelada.")); return; }
          setTimeout(checar, 6000);
        }).catch(erro);
      })();
    });
  }

  /** Rota B: gera um padrão por máscara escolhida via PIAPP e monta S.saidas. */
  function gerarViaPiapp(ger) {
    if (!S.rotabPrompt) { toast("Gere o prompt na etapa anterior primeiro.", true); return; }
    ger.disabled = true;
    var total = S.escolhidas.length, feitos = 0;
    ger.textContent = "Gerando 0/" + total + "…";

    var tarefas = S.escolhidas.map(function (ch) {
      var m = S.mascaras.filter(function (x) { return x.chave === ch; })[0];
      return api("/api/rotab/gerar", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ caminho: S.case.caminho, mascara: ch, prompt: S.rotabPrompt })
      }).then(function (r) { return aguardarPiapp(r.id); })
        .then(carregarImagemLocal)
        .then(function (img) {
          var cv = document.createElement("canvas");
          cv.width = m.w; cv.height = m.h;
          var cx = cv.getContext("2d");
          // cover-fit: preenche a máscara inteira (o PIAPP não devolve o pixel exato pedido)
          var k = Math.max(m.w / img.naturalWidth, m.h / img.naturalHeight);
          var w = img.naturalWidth * k, h = img.naturalHeight * k;
          cx.drawImage(img, (m.w - w) / 2, (m.h - h) / 2, w, h);
          feitos++; ger.textContent = "Gerando " + feitos + "/" + total + "…";
          return { mascara: m, canvas: cv, costura: medirCostura(cv), gerado: true };
        });
    });

    Promise.all(tarefas).then(function (saidas) {
      S.saidas = saidas;
      ger.disabled = false; ger.textContent = "Gerar os padrões";
      trilha(); ir(6);
      toast(total + " padrão(ões) gerado(s) pelo PIAPP.");
    }).catch(function (e) {
      ger.disabled = false; ger.textContent = "Gerar os padrões";
      toast(e.message, true);
    });
  }

  // ---------- 6. máscaras ----------
  function etapaMascaras(palco) {
    var v = painel("Máscaras dos térmicos",
      "As medidas vêm das máscaras que já existem — as mesmas do PSD, em pixels reais de impressão. " +
      "Você decide em quais produtos esta estampa entra.");
    var g = el("div", "mascaras");
    S.mascaras.forEach(function (m) {
      var b = el("button", "msk"); b.type = "button";
      var on = S.escolhidas.indexOf(m.chave) >= 0;
      b.setAttribute("aria-pressed", String(on));
      var prop = m.w / m.h;
      var bw = prop >= 1 ? 34 : Math.round(34*prop), bh = prop >= 1 ? Math.round(34/prop) : 34;
      b.innerHTML = '<span class="box"><i style="width:' + bw + 'px;height:' + bh + 'px"></i></span>' +
                    '<span><b>' + esc(m.label) + '</b><span>' + m.w + " × " + m.h + ' px</span></span>';
      b.addEventListener("click", function () {
        var i = S.escolhidas.indexOf(m.chave);
        if (i >= 0) S.escolhidas.splice(i, 1); else S.escolhidas.push(m.chave);
        b.setAttribute("aria-pressed", String(i < 0));
        ger.disabled = S.escolhidas.length === 0;
        trilha();
      });
      g.appendChild(b);
    });
    v.bd.appendChild(g);
    var nota = el("div", null, rotaGenerativa()
      ? '<div style="margin-top:14px;font-size:13px;color:var(--muted)">' +
        'Rota generativa: cada máscara escolhida vira um job separado no PIAPP, a partir do prompt da ' +
        'etapa anterior. A costura não é garantida por construção aqui — ela é medida na entrega, como ' +
        'na rota determinística.</div>'
      : '<div style="margin-top:14px;font-size:13px;color:var(--muted)">' +
        'Ao gerar, o Compositor decide escala e arranjo para o formato de cada máscara. ' +
        'O padrão usa as peças que você deixou ligadas, e a costura é fechada desenhando ' +
        'cada peça também em <span class="mono">x−L</span> e <span class="mono">x+L</span>.</div>');
    v.bd.appendChild(nota);
    var planoBox = el("div");
    planoBox.style.marginTop = "10px";
    v.bd.appendChild(planoBox);
    palco.appendChild(v.p);

    var ger = el("button", "btn primary", "Gerar os padrões");
    ger.type = "button";
    ger.disabled = S.escolhidas.length === 0;
    v.ft.appendChild(ger);

    ger.addEventListener("click", function () {
      // Fundo contínuo não tem peça pra recortar: vai pro PIAPP, sem Compositor.
      if (rotaGenerativa()) { gerarViaPiapp(ger); return; }
      ger.disabled = true; ger.textContent = "Consultando o Compositor…";
      var pecas = S.pecas.filter(function (p) { return p.on; });
      if (!pecas.length) { toast("Ligue pelo menos uma peça na etapa anterior.", true); ger.disabled = false; return; }

      var m0 = S.mascaras.filter(function (x) { return x.chave === S.escolhidas[0]; })[0];
      var entrada = JSON.stringify({
        mascara: { produto: m0.label, largura: m0.w, altura: m0.h },
        leitura: {
          tipo: S.leitura.tipo, separavel: S.leitura.separavel,
          densidade: S.leitura.densidade, estilo: S.leitura.estilo,
          motivos: S.leitura.motivos
        },
        pecas_recortadas: pecas.length
      }, null, 2);

      rodar("compositor", entrada).then(function (r) {
        if (r.ok) {
          S.plano = r.dados;
          planoBox.innerHTML =
            '<div class="pilulas"><span class="pil ok">plano do Compositor</span>' +
            '<span class="pil">' + esc(S.plano.estilo || "—") + '</span>' +
            '<span class="pil">escala ' + esc(S.plano.escala_motivos || 1) + '</span>' +
            '<span class="pil">margem ' + esc(S.plano.margem_seguranca_pct || 3.5) + '%</span></div>' +
            '<div style="font-size:12.5px;color:var(--muted);margin-top:5px">' +
            esc(S.plano.racional || "") + '</div>';
        } else {
          S.plano = null;
          planoBox.innerHTML = '<div style="font-size:12.5px;color:var(--warn)">' +
            'O Compositor não respondeu — seguindo com o arranjo padrão.</div>';
        }
      }).catch(function () {
        S.plano = null;
        planoBox.innerHTML = '<div style="font-size:12.5px;color:var(--warn)">' +
          'O Compositor não respondeu — seguindo com o arranjo padrão.</div>';
      }).then(function () {
        ger.textContent = "Montando os padrões…";
        montar();
      });

      function montar() {
      setTimeout(function () {
        S.saidas = S.escolhidas.map(function (ch) {
          var m = S.mascaras.filter(function (x) { return x.chave === ch; })[0];
          // Se o Compositor rodou, o plano dele manda: escala e estilo saem de lá.
          var plano = S.plano || {};
          var esc2 = Math.min(1.8, Math.max(0.6, Number(plano.escala_motivos) || 1));
          var cv = comporRapport(pecas, m.w, m.h, {
            escala: esc2,
            stagger: plano.estilo !== "linear",
            margemPct: plano.margem_seguranca_pct ? plano.margem_seguranca_pct/100 : 0.035,
          });
          return { mascara: m, canvas: cv, costura: medirCostura(cv), nitidez: cv._nitidez };
        });
        ger.disabled = false; ger.textContent = "Gerar os padrões";
        trilha(); ir(6);
      }, 30);
      }
    });
  }

  // ---------- 7. entrega ----------
  function etapaEntrega(palco) {
    var v = painel("Entrega",
      "PNG de produção no tamanho exato da máscara, mockup 2D montado pelo Prisma e prévia em 3D. " +
      "Em <b>conferir</b>, o Auditor dá nota no padrão e o Revisor procura marca de terceiro — os dois " +
      "olham o arquivo montado, não a arte de origem.");
    var g = el("div", "entrega");

    S.saidas.forEach(function (s) {
      var c = el("div", "ent");
      var hd = el("div", "ent-hd",
        "<b>" + esc(s.mascara.label) + "</b><span>" + s.mascara.w + "×" + s.mascara.h + "</span>");
      c.appendChild(hd);

      var par = el("div", "par");
      var d1 = el("div", null, '<small>padrão · PNG de produção</small>');
      var mini = document.createElement("canvas");
      var k = 320 / s.canvas.width;
      mini.width = 320; mini.height = Math.round(s.canvas.height * k);
      mini.getContext("2d").drawImage(s.canvas, 0, 0, mini.width, mini.height);
      d1.appendChild(mini);
      var d2 = el("div", null, '<small>mockup 2D · Prisma</small>');
      var im = document.createElement("img");
      im.loading = "lazy"; im.alt = "Mockup " + s.mascara.label;
      im.src = prox("https://ik.imagekit.io/gocase/govinci/" + s.mascara.sku + "/" +
                    s.mascara.mat + "/mockup?stamp=" + S.case.caminho + "&expires=yes&tr=w-1000");
      d2.appendChild(im);
      par.appendChild(d1); par.appendChild(d2);
      c.appendChild(par);

      var ft = el("div", "ent-ft");
      var a = el("a", null, "baixar PNG");
      a.href = "#";
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        s.canvas.toBlob(function (bl) {
          var u = URL.createObjectURL(bl);
          var l = document.createElement("a");
          l.href = u;
          l.download = S.case.identifier + "-termicos-" + s.mascara.chave + ".png";
          document.body.appendChild(l); l.click(); l.remove();
          setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
        }, "image/png");
      });
      ft.appendChild(a);
      var ver = el("a", null, "ver em 3D");
      ver.href = "#";
      ver.addEventListener("click", function (ev) { ev.preventDefault(); montar3D(s); });
      ft.appendChild(ver);
      var conf = el("a", null, "conferir");
      conf.href = "#";
      conf.addEventListener("click", function (ev) { ev.preventDefault(); conferir(s, c); });
      ft.appendChild(conf);
      var cost = el("span", "mono");
      // Na rota determinística a emenda fecha por construção — cada peça é
      // desenhada em x-L, x e x+L. A medição fica como conferência de
      // regressão. Na rota generativa não há garantia nenhuma, e aí a medição
      // é o único teste que existe.
      var gerado = !!s.geradoPorIA;
      var bom = gerado ? s.costura.invisivel : true;
      cost.style.cssText = "margin-left:auto;font-size:10.5px;color:" +
        (bom ? "var(--ok)" : "var(--warn)");
      cost.title = "salto na emenda " + s.costura.emenda.toFixed(1) +
                   " · maior salto dentro do desenho " + s.costura.maior.toFixed(1) +
                   " · " + s.costura.piores + " colunas internas saltam mais que a emenda";
      cost.textContent = gerado
        ? (bom ? "emenda confere" : "emenda suspeita")
        : "emenda fecha por construção";
      if (s.nitidez) {
        var nit = el("span", "mono");
        var esticou = s.nitidez.pior > 1.02;
        nit.style.cssText = "font-size:10.5px;margin-left:10px;color:" +
          (esticou ? "var(--warn)" : "var(--ok)");
        nit.title = "grade " + s.nitidez.grade + " · " + s.nitidez.repeticoes + " repetições · " +
                    "ampliação média " + s.nitidez.media.toFixed(2) + "x";
        nit.textContent = esticou
          ? "esticado " + s.nitidez.pior.toFixed(2) + "x"
          : "sem esticar";
        ft.appendChild(nit);
      }
      ft.appendChild(cost);
      c.appendChild(ft);
      g.appendChild(c);
    });

    v.bd.appendChild(g);

    var box3d = el("div", null,
      '<span class="rot" style="margin-top:22px">prévia em 3D — arraste para girar e conferir a emenda</span>' +
      '<canvas id="tresd"></canvas>' +
      '<div class="d3-bar"><span class="mono" id="d3-nome" style="font-size:12px;color:var(--muted)"></span></div>');
    v.bd.appendChild(box3d);
    palco.appendChild(v.p);

    var voltar = el("button", "btn", "Trocar as máscaras");
    voltar.type = "button";
    voltar.addEventListener("click", function () { ir(5); });
    v.ft.appendChild(voltar);

    if (S.saidas.length) setTimeout(function () { montar3D(S.saidas[0]); }, 60);
  }

  /**
   * Manda o padrão montado para o Auditor e o Revisor.
   * O canvas não tem endereço público, então vai como data URL — reduzido a
   * 900px, que é o suficiente para julgar composição e sobra bem menos byte.
   */
  function conferir(s, cartao) {
    var alvo = cartao.querySelector("[data-conf]");
    if (!alvo) {
      alvo = el("div");
      alvo.setAttribute("data-conf", "1");
      alvo.style.cssText = "padding:10px 12px;border-top:1px solid var(--line);font-size:12.5px";
      cartao.appendChild(alvo);
    }
    alvo.innerHTML = '<div class="carregando"><span class="spin"></span>Auditor e Revisor olhando…</div>';

    var mini = document.createElement("canvas");
    var k = Math.min(1, 900 / s.canvas.width);
    mini.width = Math.round(s.canvas.width * k);
    mini.height = Math.round(s.canvas.height * k);
    var mx = mini.getContext("2d");
    mx.fillStyle = "#ffffff";            // fundo branco: transparência vira xadrez e confunde o modelo
    mx.fillRect(0, 0, mini.width, mini.height);
    mx.drawImage(s.canvas, 0, 0, mini.width, mini.height);
    var dataUrl = mini.toDataURL("image/jpeg", 0.88);

    Promise.all([
      rodar("auditor", dataUrl).catch(function (e) { return { ok: false, erro: e.message }; }),
      rodar("revisor", dataUrl).catch(function (e) { return { ok: false, erro: e.message }; })
    ]).then(function (rs) {
      var a = rs[0], r = rs[1];
      var h = "";
      if (a.ok && a.dados) {
        var nota = Number(a.dados.nota);
        var cor = nota >= 7 ? "var(--ok)" : "var(--warn)";
        h += '<div style="display:flex;gap:8px;align-items:baseline"><b style="color:' + cor +
             '">Auditor: ' + (isNaN(nota) ? "—" : nota) + '/10</b><span style="color:var(--muted)">' +
             esc(a.dados.veredito || "") + '</span></div>';
        (a.dados.problemas || []).slice(0, 3).forEach(function (pp) {
          h += '<div style="color:var(--muted);margin-top:3px">• ' + esc(pp) + '</div>';
        });
      } else {
        h += '<div style="color:var(--crit)">Auditor falhou: ' + esc(a.erro || "") + '</div>';
      }
      if (r.ok && r.dados) {
        var bloq = !!r.dados.bloqueia;
        h += '<div style="margin-top:7px"><b style="color:' + (bloq ? "var(--crit)" : "var(--ok)") + '">' +
             (bloq ? "Revisor: bloqueia" : "Revisor: liberado") + '</b></div>';
        (r.dados.achados || []).forEach(function (ac) {
          h += '<div style="color:var(--muted);margin-top:2px">• ' + esc(ac.tipo) + " · " +
               esc(ac.onde) + " · " + esc(ac.gravidade) + '</div>';
        });
      } else {
        h += '<div style="color:var(--crit)">Revisor falhou: ' + esc(r.erro || "") + '</div>';
      }
      alvo.innerHTML = h;
    });
  }

  // ---------- 3D ----------
  var cena = null;
  function montar3D(s) {
    var cv = $("tresd");
    if (!cv || typeof THREE === "undefined") return;
    $("d3-nome").textContent = s.mascara.label + " · " + s.mascara.w + "×" + s.mascara.h;

    if (!cena) {
      var ren = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
      ren.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      var sc = new THREE.Scene();
      var cam = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
      cam.position.set(0, 0.3, 7.4);
      sc.add(new THREE.AmbientLight(0xffffff, 0.85));
      var l1 = new THREE.DirectionalLight(0xffffff, 0.75); l1.position.set(4, 6, 7); sc.add(l1);
      var l2 = new THREE.DirectionalLight(0xffffff, 0.35); l2.position.set(-5, 2, -4); sc.add(l2);

      var grupo = new THREE.Group();
      // corpo onde a arte é aplicada
      var corpo = new THREE.Mesh(
        new THREE.CylinderGeometry(1.05, 1.05, 3.5, 96, 1, true),
        new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }));
      corpo.position.y = -0.15;
      grupo.add(corpo);
      // base, ombro e tampa, só para dar leitura de garrafa
      var aco = new THREE.MeshStandardMaterial({ color: 0xe9edee, roughness: 0.4, metalness: 0.3 });
      var base = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.0, 0.12, 96), aco);
      base.position.y = -1.96; grupo.add(base);
      var ombro = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 1.05, 0.6, 96), aco);
      ombro.position.y = 1.9; grupo.add(ombro);
      var gargalo = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.36, 64), aco);
      gargalo.position.y = 2.38; grupo.add(gargalo);
      var tampa = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.3, 64),
        new THREE.MeshStandardMaterial({ color: 0xf4f5f5, roughness: 0.6 }));
      tampa.position.y = 2.66; grupo.add(tampa);
      sc.add(grupo);

      cena = { ren: ren, sc: sc, cam: cam, grupo: grupo, corpo: corpo, girando: true, vel: 0.0055 };

      var arrastando = false, ultimo = 0;
      cv.style.cursor = "grab";
      cv.addEventListener("pointerdown", function (e) {
        arrastando = true; ultimo = e.clientX; cena.girando = false;
        cv.style.cursor = "grabbing"; cv.setPointerCapture(e.pointerId);
      });
      cv.addEventListener("pointermove", function (e) {
        if (!arrastando) return;
        cena.grupo.rotation.y += (e.clientX - ultimo) * 0.008;
        ultimo = e.clientX;
      });
      ["pointerup", "pointercancel"].forEach(function (ev) {
        cv.addEventListener(ev, function () { arrastando = false; cv.style.cursor = "grab"; });
      });

      function laco() {
        requestAnimationFrame(laco);
        var l = cv.clientWidth, a = cv.clientHeight;
        if (l && a && (cv.width !== l || cv.height !== a)) {
          cena.ren.setSize(l, a, false);
          cena.cam.aspect = l/a; cena.cam.updateProjectionMatrix();
        }
        if (cena.girando) cena.grupo.rotation.y += cena.vel;
        cena.ren.render(cena.sc, cena.cam);
      }
      laco();
    }

    var tex = new THREE.CanvasTexture(s.canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    if ("colorSpace" in tex) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    if (cena.corpo.material.map) cena.corpo.material.map.dispose();
    cena.corpo.material.map = tex;
    cena.corpo.material.color = new THREE.Color(0xffffff);
    cena.corpo.material.needsUpdate = true;
  }

  // ══════════════════════════════ início ══════════════════════════════

  api("/api/estado").then(function (j) {
    S.temToken = j.temToken;
    S.mascaras = j.mascaras || [];
    (j.agentes || []).forEach(function (a) { S.agentes[a.chave] = a; });
    $("b-token").textContent = j.temToken ? "AI Proxy ligado" : "AI Proxy sem token";
    $("b-token").className = "badge " + (j.temToken ? "on" : "off");
    $("b-modelo").textContent = j.modelo || "";
    trilha(); pintar();
  }).catch(function (e) {
    $("palco").innerHTML = '<div class="aviso err">Não consegui iniciar: ' + esc(e.message) + '</div>';
  });
})();
