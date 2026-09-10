/**
 * Interface da Fábrica de Térmicos + runner do motor gráfico.
 *
 * Esta página é as duas coisas ao mesmo tempo:
 *  - a fila visual e a aprovação humana (os 10% que sobram para gente);
 *  - o EXECUTOR dos estágios de geometria. Enquanto o botão "motor gráfico"
 *    está ligado, a aba reivindica itens parados em `planejada`, roda separador
 *    e rapport, mede a costura e devolve o resultado ao worker.
 *
 * Sem uma aba com o motor ligado, a esteira anda até `planejada` e para ali —
 * é a consequência de o worker não ter Canvas API. Ver docs/ARQUITETURA.md.
 */

import { processaItem } from '/motor.js';

const AGENTES = [
  ['A1', 'portfólio'],
  ['A2', 'leitor'],
  ['A3', 'estratégia'],
  ['A4', 'segmentação'],
  ['A5', 'costura'],
  ['A6', 'cor'],
  ['A7', 'marca'],
  ['A8', 'nome'],
  ['A9', 'copy'],
  ['A11', 'fidelidade'],
];

const ESTADO_ROTULO = {
  candidata: ['', 'candidata'],
  arte_ok: ['', 'arte encontrada'],
  lida: ['acc', 'lida pelo A2'],
  planejada: ['warn', 'esperando o motor'],
  composta: ['acc', 'composta'],
  auditada: ['acc', 'auditada'],
  julgada: ['acc', 'aprovada pelo A11'],
  aguardando_aprovacao: ['ok', 'aguardando você'],
  aprovada: ['ok', 'aprovada'],
  cadastrada: ['ok', 'cadastrada'],
  reprovada: ['crit', 'reprovada'],
  bloqueado_marca: ['crit', 'bloqueado pelo A7'],
  bloqueado_leitor: ['crit', 'texto/logo — fila manual'],
};

let ESTADO = null;
let SELECIONADO = null;
let RUNNER_LIGADO = false;
let RUNNER_OCUPADO = false;

// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);

function toast(msg, tipo = '') {
  const d = document.createElement('div');
  d.className = 't ' + tipo;
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), tipo === 'erro' ? 9000 : 5000);
}

async function api(rota, opts = {}) {
  const res = await fetch(rota, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
  });
  const texto = await res.text();
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    throw new Error(`${rota} devolveu resposta não-JSON (${res.status})`);
  }
  if (!res.ok) throw new Error(dados.error || `${rota} falhou (${res.status})`);
  return dados;
}

const post = (rota, corpo) => api(rota, { method: 'POST', body: JSON.stringify(corpo || {}) });

const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => (n >= 1000 ? 'R$ ' + Math.round(n / 1000) + 'k' : 'R$ ' + Math.round(n || 0));

function ocupado(botao, ligado, textoOcupado) {
  const b = $(botao);
  if (!b) return;
  if (ligado) {
    b.dataset.antes = b.textContent;
    b.textContent = textoOcupado;
    b.disabled = true;
  } else {
    b.textContent = b.dataset.antes || b.textContent;
    b.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Pintura
// ---------------------------------------------------------------------------

function pintaSaude(s) {
  const chips = [];
  if (s.proxy_ia) chips.push(['ok', 'AI Proxy ligado']);
  else chips.push(['crit', 'AI Proxy não configurado']);
  chips.push([RUNNER_LIGADO ? 'ok' : 'warn', RUNNER_LIGADO ? 'motor ligado' : 'motor desligado']);
  $('#saude').innerHTML = chips
    .map(([c, t]) => `<span class="chip ${c}">${t}</span>`)
    .join('');
}

function pintaPainel(m, contagens) {
  const det = m.rotas.find((r) => r.rota === 'deterministica');
  const gen = m.rotas.find((r) => r.rota === 'generativa');
  const nDet = det?.n || 0;
  const nGen = gen?.n || 0;
  const comRota = nDet + nGen;
  const pctDet = comRota ? Math.round((nDet / comRota) * 100) : null;

  const total = contagens.reduce((s, c) => s + c.n, 0);
  const esperando = contagens.find((c) => c.estado === 'aguardando_aprovacao')?.n || 0;
  const noMotor = contagens.find((c) => c.estado === 'planejada')?.n || 0;

  const kpis = [
    [total, 'itens na fila', ''],
    [
      pctDet === null ? '—' : pctDet + '%',
      'na rota determinística',
      comRota ? `${nDet} determ. · ${nGen} gener.` : 'sem item roteado ainda',
    ],
    [esperando, 'esperando você', ''],
    [noMotor, 'esperando o motor', noMotor && !RUNNER_LIGADO ? 'ligue o motor gráfico' : ''],
    [m.nota_media === null ? '—' : m.nota_media.toFixed(1), 'nota média do A5', 'costura e composição'],
    [
      m.fidelidade_media === null ? '—' : m.fidelidade_media.toFixed(1),
      'fidelidade (A11)',
      'semelhança com a capinha',
    ],
    [
      m.costura_zero_pct === null ? '—' : Math.round(m.costura_zero_pct) + '%',
      'com costura zero',
      'meta: 100% na rota determinística',
    ],
    [
      m.custo_por_estampa_usd === null ? '—' : 'US$ ' + m.custo_por_estampa_usd.toFixed(3),
      'custo por estampa',
      `${num(m.chamadas)} chamadas · ${num(m.falhas)} falhas`,
    ],
  ];

  $('#painel').innerHTML = kpis
    .map(
      ([v, r, s]) =>
        `<div class="kpi"><b>${v}</b><span>${r}</span>${s ? `<small>${s}</small>` : ''}</div>`,
    )
    .join('');
}

function pintaFila(fila) {
  const ul = $('#fila');
  $('#fila-n').textContent = `${fila.length} ${fila.length === 1 ? 'item' : 'itens'}`;
  if (!fila.length) {
    ul.innerHTML = `<li><div class="vazio">Fila vazia. Clique em <b>Encher a fila</b>.</div></li>`;
    return;
  }
  ul.innerHTML = '';
  for (const it of fila) {
    const [cls, txt] = ESTADO_ROTULO[it.estado] || ['warn', it.estado];
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-current', String(Number(it.id) === SELECIONADO));
    b.innerHTML =
      `<span class="nm">${escapa(it.nome || it.estampa_key)}</span>` +
      `<span class="un">${num(it.unidades)} un</span>` +
      `<span class="st"><span class="chip ${cls}">${escapa(txt)}</span>` +
      (it.rota_usada ? `<span class="chip">${it.rota_usada}</span>` : '') +
      (it.nota_auditor != null ? `<span class="chip mono">nota ${it.nota_auditor}</span>` : '') +
      `</span>`;
    b.onclick = () => abre(Number(it.id));
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function escapa(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function valorAgente(it, k) {
  const l = it.leitura;
  switch (k) {
    case 'A1': return it.receita ? brl(it.receita) : '—';
    case 'A2': return l ? (l.tem_logo ? 'tem logo' : l.tem_texto ? 'tem texto' : l.tipo.replace(/_/g, ' ')) : '—';
    case 'A3': return it.plano?.estilo || '—';
    case 'A4': return it.segmentacao ? it.segmentacao.qualidade_recorte.toFixed(2) : '—';
    case 'A5': return it.auditoria ? String(it.auditoria.nota) : '—';
    case 'A6': return it.cor?.recomendadas?.[0]?.cor_corpo || '—';
    case 'A7': return it.marca ? (it.marca.bloqueia ? 'veto' : 'limpo') : '—';
    case 'A8': return it.nomeacao ? 'ok' : '—';
    case 'A9': return it.copy ? 'ok' : '—';
    case 'A11': return it.fidelidade ? String(it.fidelidade.nota_final) : '—';
    default: return '—';
  }
}

function pintaCard(dados) {
  const it = dados.item;
  const pv = dados.previews || {};
  const [cls, txt] = ESTADO_ROTULO[it.estado] || ['warn', it.estado];

  const imagens = [];
  if (it.png_alta) {
    imagens.push(
      `<figure class="img-cel"><figcaption>original da capinha</figcaption>` +
        `<img src="/api/img?u=${encodeURIComponent(it.png_alta)}" alt="estampa original" loading="lazy"></figure>`,
    );
  }
  if (pv.recortes) {
    imagens.push(
      `<figure class="img-cel"><figcaption>recortes do separador</figcaption>` +
        `<img src="${pv.recortes.data_url}" alt="recortes"></figure>`,
    );
  }
  if (pv.composicao) {
    imagens.push(
      `<figure class="img-cel"><figcaption>composição ${it.mascara_w}×${it.mascara_h}</figcaption>` +
        `<img src="${pv.composicao.data_url}" alt="composição"></figure>`,
    );
  }
  if (pv.ladrilho3x1) {
    imagens.push(
      `<figure class="img-cel wide"><figcaption>rapport 3×1 — as emendas ficam a 1/3 e 2/3</figcaption>` +
        `<img src="${pv.ladrilho3x1.data_url}" alt="rapport 3x1"></figure>`,
    );
  }

  const blocos = [];
  if (it.motivo_falha) {
    blocos.push(`<div class="bloco" style="border-color:var(--crit)"><b>motivo</b>${escapa(it.motivo_falha)}</div>`);
  }
  if (it.marca?.achados?.length) {
    blocos.push(
      `<div class="bloco"><b>A7 · revisão de marca</b><ul class="lista">` +
        it.marca.achados
          .map((a) => `<li>${escapa(a.tipo)} · ${escapa(a.onde)} — <b>${escapa(a.gravidade)}</b></li>`)
          .join('') +
        `</ul></div>`,
    );
  }
  if (it.fidelidade) {
    const f = it.fidelidade;
    const NOMES = {
      semelhanca_composicao: '1. semelhança com a capinha',
      rapport: '2. rapport encaixa',
      coerencia_recorte: '3. recorte coerente',
      resolucao: '4. resolução da case',
      margem_logo: '5. margem da logo',
    };
    const linhas = Object.entries(NOMES)
      .map(([k, rotulo]) => {
        const c = f.criterios[k];
        if (!c) return '';
        const cor = c.nota >= 7 ? 'var(--ok)' : c.nota >= 5 ? 'var(--warn)' : 'var(--crit)';
        // `medido` vs `julgado` fica visível de propósito: saber se o número
        // veio de conta ou de modelo muda o quanto se confia nele.
        return (
          `<tr><td>${escapa(rotulo)}</td>` +
          `<td class="mono" style="color:${cor};font-weight:600">${c.nota}</td>` +
          `<td><span class="chip">${escapa(c.fonte)}</span></td>` +
          `<td style="color:var(--ink-2)">${escapa(c.observacao)}</td></tr>`
        );
      })
      .join('');
    const corV =
      f.veredito === 'aprovado' ? 'ok' : f.veredito === 'ajustar' ? 'warn' : 'crit';
    blocos.push(
      `<div class="bloco"><b>A11 · juiz de fidelidade</b>` +
        `<div style="margin-bottom:6px">nota final <b class="mono">${f.nota_final}</b> ` +
        `<span class="chip ${corV}">${escapa(f.veredito)}</span></div>` +
        `<table class="log"><tr><th>critério</th><th>nota</th><th>fonte</th><th>observação</th></tr>` +
        linhas +
        `</table>` +
        (f.medicao
          ? `<div style="margin-top:6px;font-size:11px;color:var(--muted)" class="mono">` +
            `ampliação máxima ${Number(f.medicao.ampliacao_maxima || 1).toFixed(2)}x` +
            (f.medicao.ampliacao_pior_camada ? ` em "${escapa(f.medicao.ampliacao_pior_camada)}"` : '') +
            ` · costura ${f.medicao.erro_costura_px}px` +
            ` · ${f.medicao.camadas} recorte(s), ${f.medicao.colocacoes} colocação(ões)</div>`
          : '') +
        (f.problemas?.length
          ? `<ul class="lista">${f.problemas.map((p) => `<li>${escapa(p)}</li>`).join('')}</ul>`
          : '') +
        `</div>`,
    );
  }
  if (it.auditoria?.problemas?.length) {
    blocos.push(
      `<div class="bloco"><b>A5 · problemas apontados</b><ul class="lista">` +
        it.auditoria.problemas.map((p) => `<li>${escapa(p)}</li>`).join('') +
        `</ul></div>`,
    );
  }
  if (it.plano?.racional) {
    blocos.push(`<div class="bloco"><b>A3 · racional</b>${escapa(it.plano.racional)}</div>`);
  }
  if (it.cor) {
    const rec = it.cor.recomendadas.map((c) => `${c.cor_corpo} (nota ${c.nota})`).join(', ') || 'nenhuma';
    const rep = it.cor.reprovadas.map((c) => `${c.cor_corpo}: ${c.motivo}`).join(' · ');
    blocos.push(
      `<div class="bloco"><b>A6 · cor do corpo</b>recomendadas: ${escapa(rec)}` +
        (rep ? `<br>reprovadas: ${escapa(rep)}` : '') +
        `</div>`,
    );
  }
  if (it.copy) {
    blocos.push(
      `<div class="bloco"><b>A9 · catálogo</b><b style="text-transform:none;font-size:13px;color:var(--ink)">` +
        `${escapa(it.copy.nome)}</b>${escapa(it.copy.descricao)}<br><small>` +
        `tags: ${escapa(it.copy.tags.join(', '))}</small></div>`,
    );
  }

  const podeAprovar = it.estado === 'aguardando_aprovacao' && !it.marca?.bloqueia;
  const temGeometria = Boolean(it.leitura && it.plano);

  $('#card').innerHTML = `
    <div class="caixa-bd">
      <div class="card-hd">
        <h2>${escapa(it.nome || it.estampa_key)}</h2>
        <span class="chip ${cls}">${escapa(txt)}</span>
        ${it.rota_usada ? `<span class="chip acc">rota ${it.rota_usada}</span>` : ''}
      </div>
      <div class="ident">${escapa(it.estampa_key)}-case → ${escapa(it.engine_identifier || it.estampa_key + '-termicos')}</div>

      <div class="dados">
        <div><b>${num(it.unidades)}</b><span>unidades em 90d</span></div>
        <div><b>${brl(it.receita)}</b><span>receita em capinha</span></div>
        <div><b>${escapa(it.tema || '—')}</b><span>tema</span></div>
        <div><b>${it.erro_costura_px == null ? '—' : it.erro_costura_px}</b><span>erro de costura (px)</span></div>
        <div><b>US$ ${(dados.custo_item_usd || 0).toFixed(4)}</b><span>custo de IA deste item</span></div>
        ${
          it.leitura
            ? `<div><b>${escapa(it.leitura.composicao?.hierarquia || '—')}</b><span>hierarquia na capinha</span></div>`
            : ''
        }
        ${
          it.arte_w && it.arte_h
            ? `<div><b>${it.arte_w}×${it.arte_h}</b><span>resolução nativa da arte</span></div>`
            : ''
        }
        <div><b>${it.zona_logo?.disponivel ? 'sim' : 'não'}</b><span>zona de logo cadastrada</span></div>
      </div>

      <div class="cadeia">
        ${AGENTES.map(([k, nome]) => {
          const v = valorAgente(it, k);
          let c = 'pend';
          if (k === 'A7' && v === 'veto') c = 'block';
          else if (k === 'A2' && (v === 'tem logo' || v === 'tem texto')) c = 'block';
          else if (v !== '—') c = 'done';
          return `<div class="ag ${c}"><span class="k">${k}</span><span class="n">${nome}</span><span class="v">${escapa(v)}</span></div>`;
        }).join('')}
      </div>

      ${imagens.length ? `<div class="imgs">${imagens.join('')}</div>` : ''}
      ${blocos.join('')}

      <div class="acoes">
        <button id="c-aprovar" class="primary" ${podeAprovar ? '' : 'disabled'}>Aprovar</button>
        <select id="c-estilo" title="Estilo para o replanejamento">
          <option value="">ajustar: manter estilo</option>
          <option value="stickers">stickers</option>
          <option value="linear">linear</option>
          <option value="distribuido">distribuído</option>
          <option value="localizada">localizada</option>
        </select>
        <input id="c-escala" type="number" step="0.05" min="0.5" max="2" placeholder="escala" style="width:88px">
        <button id="c-ajustar">Ajustar e refazer</button>
        <button id="c-reprovar">Reprovar</button>
        <div class="grow"></div>
        ${temGeometria ? `<button id="c-png">Gerar PNG ${it.mascara_w}×${it.mascara_h}</button>` : ''}
        <button id="c-avancar">Avançar 1 estágio</button>
        ${it.estado.startsWith('falhou') ? `<button id="c-reproc">Reprocessar</button>` : ''}
      </div>

      ${
        dados.log?.length
          ? `<details><summary>log de agentes deste item (${dados.log.length})</summary>
             <table class="log"><tr><th>agente</th><th>tokens</th><th>ms</th><th>US$</th><th>erro</th></tr>` +
            dados.log
              .map(
                (l) =>
                  `<tr><td>${escapa(l.agente)}</td><td class="mono">${l.tokens_entrada}/${l.tokens_saida}</td>` +
                  `<td class="mono">${l.latencia_ms}</td><td class="mono">${Number(l.custo_usd).toFixed(4)}</td>` +
                  `<td>${escapa(l.erro || '')}</td></tr>`,
              )
              .join('') +
            `</table></details>`
          : ''
      }
    </div>`;

  const liga = (sel, fn) => {
    const el = $(sel);
    if (el) el.onclick = fn;
  };

  liga('#c-aprovar', async () => {
    ocupado('#c-aprovar', true, 'aprovando…');
    try {
      await post(`/api/item/${it.id}/aprovar`);
      toast('Aprovada. O cadastro pode seguir com o PNG de produção.', 'ok');
      await recarrega();
      abre(it.id);
    } catch (e) {
      toast(e.message, 'erro');
      ocupado('#c-aprovar', false);
    }
  });

  liga('#c-ajustar', async () => {
    const estilo = $('#c-estilo').value;
    const escala = parseFloat($('#c-escala').value);
    try {
      await post(`/api/item/${it.id}/ajustar`, {
        estilo: estilo || undefined,
        escala: Number.isFinite(escala) ? escala : undefined,
      });
      toast('Volta ao A3 para replanejar. Deixe o motor ligado.', 'ok');
      await recarrega();
      abre(it.id);
    } catch (e) {
      toast(e.message, 'erro');
    }
  });

  liga('#c-reprovar', async () => {
    const motivo = prompt('Por que esta estampa não serve para térmico?');
    if (motivo === null) return;
    try {
      await post(`/api/item/${it.id}/reprovar`, { motivo });
      await recarrega();
      abre(it.id);
    } catch (e) {
      toast(e.message, 'erro');
    }
  });

  liga('#c-avancar', async () => {
    ocupado('#c-avancar', true, 'avançando…');
    try {
      const r = await post(`/api/item/${it.id}/avancar`);
      const res = r.resultado;
      toast(res ? `${res.de} → ${res.para}${res.detalhe ? ' · ' + res.detalhe : ''}` : 'nada a avançar agora', res?.ok === false ? 'erro' : 'ok');
      await recarrega();
      abre(it.id);
    } catch (e) {
      toast(e.message, 'erro');
      ocupado('#c-avancar', false);
    }
  });

  liga('#c-reproc', async () => {
    try {
      await post(`/api/item/${it.id}/reprocessar`);
      await recarrega();
      abre(it.id);
    } catch (e) {
      toast(e.message, 'erro');
    }
  });

  liga('#c-png', () => geraProducao(it));
}

// ---------------------------------------------------------------------------
// PNG de produção
// ---------------------------------------------------------------------------

/**
 * Regenera a composição em resolução cheia e entrega o arquivo.
 *
 * Regenerar em vez de guardar: o pipeline é DETERMINÍSTICO — o separador não
 * tem aleatoriedade e o layout usa PRNG semeado pelos próprios parâmetros do
 * plano. Rodar de novo com o mesmo item dá o mesmo pixel. Então não vale
 * carregar megabytes de PNG no SQLite (que tem teto de 2 MB por linha) para
 * guardar algo reproduzível em segundos.
 *
 * As fatias vão para o worker além do download, porque o cadastro roda no
 * servidor e precisa alcançar o arquivo.
 */
async function geraProducao(item) {
  ocupado('#c-png', true, 'gerando…');
  try {
    const r = await processaItem(
      { ...item, png_alta: viaProxy(item.png_alta) },
      {
        zonaLogo: item.zona_logo || null,
        arteNativa: item.arte_w && item.arte_h ? { w: item.arte_w, h: item.arte_h } : null,
      },
    );

    const blob = await new Promise((ok) => r.composicao.toBlob(ok, 'image/png'));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.engine_identifier || item.estampa_key + '-termicos'}-${item.mascara_w}x${item.mascara_h}.png`;
    a.click();
    URL.revokeObjectURL(url);

    const dataUrl = r.composicao.toDataURL('image/png');
    const FATIA = 700000;
    const total = Math.ceil(dataUrl.length / FATIA);
    for (let i = 0; i < total; i++) {
      await post('/api/blob', {
        item_id: item.id,
        tipo: 'producao',
        fatia: i,
        total,
        dados: dataUrl.slice(i * FATIA, (i + 1) * FATIA),
      });
    }

    toast(`PNG baixado e guardado no servidor em ${total} fatia(s). Costura: ${r.costura.erro_costura_px}px.`, 'ok');
  } catch (e) {
    toast('PNG de produção falhou: ' + e.message, 'erro');
  } finally {
    ocupado('#c-png', false);
  }
}

/** Imagem externa sempre pelo worker: same-origin resolve CORS de uma vez. */
function viaProxy(url) {
  if (!url || url.startsWith('data:') || url.startsWith('/')) return url;
  return `/api/img?u=${encodeURIComponent(url)}`;
}

// ---------------------------------------------------------------------------
// Runner do motor gráfico
// ---------------------------------------------------------------------------

async function umaVoltaDoRunner() {
  if (RUNNER_OCUPADO) return;
  RUNNER_OCUPADO = true;
  try {
    const { item } = await post('/api/motor/reivindicar');
    if (!item) return;

    toast(`Motor: processando ${item.nome || item.estampa_key}…`);

    let entrega;
    try {
      const r = await processaItem(
        { ...item, png_alta: viaProxy(item.png_alta) },
        {
          // A zona da logo e a resolução nativa vêm do Factory, lidas pelo
          // worker quando resolveu a arte. O motor precisa das duas: uma para
          // não invadir a área da logo, a outra para medir a ampliação.
          zonaLogo: item.zona_logo || null,
          arteNativa: item.arte_w && item.arte_h ? { w: item.arte_w, h: item.arte_h } : null,
          // O A4 mora no worker (é ele quem tem a chave do AI Proxy), mas a
          // imagem que ele julga acabou de ser gerada aqui.
          revisarSegmentacao: async (folha, bboxes) => {
            const res = await post('/api/motor/segmentacao', {
              item_id: item.id,
              contact_sheet: folha.data_url,
              bboxes,
            });
            return res.revisao;
          },
        },
      );
      entrega = {
        item_id: item.id,
        previews: r.previews,
        costura: r.costura,
        medicao: r.medicao,
        segmentacao: r.segmentacao,
        diagnostico: r.diagnostico,
      };
    } catch (e) {
      entrega = { item_id: item.id, erro: e.message };
    }

    const res = await post('/api/motor/entregar', entrega);
    if (entrega.erro) toast(`Motor falhou em ${item.estampa_key}: ${entrega.erro}`, 'erro');
    else toast(`Motor: ${item.estampa_key} composta, costura ${res.erro_costura_px}px.`, 'ok');

    await recarrega();
  } catch (e) {
    toast('Runner: ' + e.message, 'erro');
  } finally {
    RUNNER_OCUPADO = false;
  }
}

let TIMER_RUNNER = null;

function ligaRunner(ligar) {
  RUNNER_LIGADO = ligar;
  const b = $('#b-runner');
  b.textContent = ligar ? 'Desligar motor gráfico' : 'Ligar motor gráfico';
  b.classList.toggle('on', ligar);
  if (TIMER_RUNNER) clearInterval(TIMER_RUNNER);
  if (ligar) {
    umaVoltaDoRunner();
    TIMER_RUNNER = setInterval(umaVoltaDoRunner, 8000);
    toast('Motor ligado. Esta aba passa a executar a geometria da esteira.', 'ok');
  }
  if (ESTADO) pintaSaude(ESTADO);
}

// ---------------------------------------------------------------------------
// Ciclo da página
// ---------------------------------------------------------------------------

async function recarrega() {
  const filtro = $('#f-estado').value;
  ESTADO = await api('/api/estado' + (filtro ? `?estado=${encodeURIComponent(filtro)}` : ''));
  pintaSaude(ESTADO);
  pintaPainel(ESTADO.metricas, ESTADO.contagens);
  pintaFila(ESTADO.fila);

  const sel = $('#f-estado');
  if (sel.options.length <= 1) {
    for (const c of ESTADO.contagens) {
      const o = document.createElement('option');
      o.value = c.estado;
      o.textContent = `${c.estado} (${c.n})`;
      sel.appendChild(o);
    }
  }
}

async function abre(id) {
  SELECIONADO = id;
  document.querySelectorAll('#fila button').forEach((b) => b.setAttribute('aria-current', 'false'));
  try {
    const dados = await api(`/api/item/${id}`);
    pintaCard(dados);
    pintaFila(ESTADO?.fila || []);
  } catch (e) {
    toast(e.message, 'erro');
  }
}

$('#b-curar').onclick = async () => {
  ocupado('#b-curar', true, 'consultando o datamart…');
  try {
    const r = await post('/api/curar', { janela_dias: 90, limite: 20 });
    toast(
      `${r.inseridas} nova(s) na fila de ${r.candidatas.length} candidatas ` +
        `(${r.total_analisadas} estampas analisadas, agregação ${r.modo_agregacao}).`,
      'ok',
    );
    await recarrega();
  } catch (e) {
    toast(
      e.message.includes('autenticado')
        ? 'O proxy de dados recusou: recarregue a página para renovar a sessão do Google.'
        : e.message,
      'erro',
    );
  } finally {
    ocupado('#b-curar', false);
  }
};

$('#b-priorizar').onclick = async () => {
  ocupado('#b-priorizar', true, 'A1 pensando…');
  try {
    const r = await post('/api/priorizar');
    const topo = r.ranking.slice(0, 3).map((x) => `${x.posicao}. ${x.estampa_key}`).join(' · ');
    toast(`A1 ordenou ${r.ranking.length}: ${topo}`, 'ok');
    if (r.descartadas?.length) toast(`A1 sugere descartar ${r.descartadas.length}.`);
    await recarrega();
  } catch (e) {
    toast(e.message, 'erro');
  } finally {
    ocupado('#b-priorizar', false);
  }
};

$('#b-tick').onclick = async () => {
  ocupado('#b-tick', true, 'avançando…');
  try {
    const r = await post('/api/tick');
    if (!r.avancos.length) {
      toast(
        r.parados_no_motor
          ? `Nada avançou: ${r.parados_no_motor} item(ns) esperam o motor gráfico. Ligue o motor.`
          : 'Nada para avançar agora.',
      );
    } else {
      for (const a of r.avancos) {
        toast(`#${a.item_id}: ${a.de} → ${a.para}${a.detalhe ? ' · ' + a.detalhe : ''}`, a.ok ? 'ok' : 'erro');
      }
    }
    await recarrega();
  } catch (e) {
    toast(e.message, 'erro');
  } finally {
    ocupado('#b-tick', false);
  }
};

$('#b-supervisor').onclick = async () => {
  ocupado('#b-supervisor', true, 'A10 lendo a fila…');
  try {
    const r = await post('/api/supervisor');
    const s = r.supervisao;
    $('#resumo').innerHTML =
      `<div class="resumo"><b>A10 · resumo do dia</b>${escapa(s.resumo_dia)}` +
      (s.alerta ? `<br><br><b>alerta</b>${escapa(s.alerta)}` : '') +
      (r.executadas.length ? `<br><br><small>${r.executadas.length} ação(ões) executada(s)</small>` : '') +
      `</div>`;
    toast(`A10: ${r.executadas.length} ação(ões).`, 'ok');
    await recarrega();
  } catch (e) {
    toast(e.message, 'erro');
  } finally {
    ocupado('#b-supervisor', false);
  }
};

$('#b-runner').onclick = () => ligaRunner(!RUNNER_LIGADO);
$('#b-recarregar').onclick = () => recarrega().catch((e) => toast(e.message, 'erro'));
$('#f-estado').onchange = () => recarrega().catch((e) => toast(e.message, 'erro'));

recarrega().catch((e) => toast('Não carregou o estado: ' + e.message, 'erro'));
