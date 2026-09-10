/**
 * Máquina de estados da esteira.
 *
 * A esteira NÃO é um agente conversacional grande: é uma fila em `env.DB` com
 * um cron avançando estados. Cada estágio é idempotente e reprocessável
 * isoladamente, porque o PIAPP é assíncrono, o Worker tem teto de CPU por
 * requisição e é preciso refazer um item sem refazer o lote.
 *
 * Divisão de quem executa o quê:
 *  - estágios de IA e de dado -> este arquivo, chamados pelo cron
 *  - estágios de GEOMETRIA    -> o browser (src/web/motor.js), porque o runtime
 *    do Worker não tem Canvas API e o orçamento de CPU é compartilhado. O item
 *    fica parado em `planejada` até um runner reivindicar.
 *
 * O estado `planejada` é, portanto, a fronteira do que o cron consegue fazer
 * sozinho. Ver docs/ARQUITETURA.md.
 */

import { escolherCor } from '../agentes/colorista';
import { planejar, planoPadrao } from '../agentes/estrategista';
import { lerEstampa } from '../agentes/leitor';
import { nomear } from '../agentes/nomeador';
import { redigir } from '../agentes/redator';
import { bloqueioPorFalha, revisarMarca } from '../agentes/revisor';
import { auditar } from '../agentes/auditor';
import { proxyConfigurado } from './aiproxy';
import { atualiza, falha, itemPorId, itensPorEstado, lePreview, registra } from './db';
import { MASCARA_PADRAO, resolverArte } from './dados';
import type { Env, ItemFila } from './tipos';

/** Duas reprovas de costura e o item vai para gente. */
export const TETO_TENTATIVAS = 2;

/** Um item travado há mais que isto é considerado abandonado e liberado. */
const LOCK_MINUTOS = 10;

/** Abaixo desta confiança o item vai para revisão humana em vez de seguir. */
const CORTE_CONFIANCA = 0.6;

/**
 * Estados que o cron consegue avançar sozinho, na ordem em que são varridos.
 *
 * `planejada` não está aqui de propósito: é o estágio do motor gráfico, que
 * roda no browser. `composta` está, porque a partir dali volta a ser IA.
 */
export const AVANCAVEIS_POR_CRON = ['candidata', 'arte_ok', 'lida', 'composta', 'auditada'] as const;

export interface ResultadoAvanco {
  item_id: number;
  de: string;
  para: string;
  ok: boolean;
  detalhe?: string;
}

/**
 * Reivindica um item para processar.
 *
 * Duas execuções do cron podem se sobrepor (uma lenta, a seguinte pontual).
 * Sem o lock, o mesmo item seria lido duas vezes e pagaria duas chamadas de
 * agente. `rowsWritten` é o que diz se a reivindicação venceu.
 */
async function reivindica(env: Env, id: number, estado: string): Promise<boolean> {
  const limite = `-${LOCK_MINUTOS} minutes`;
  const r = await env.DB.exec(
    `UPDATE fila SET travado_em = datetime('now')
     WHERE id = ? AND estado = ?
       AND (travado_em IS NULL OR travado_em < datetime('now', ?))`,
    [id, estado, limite],
  );
  return r.rowsWritten > 0;
}

async function libera(env: Env, id: number): Promise<void> {
  await env.DB.exec('UPDATE fila SET travado_em = NULL WHERE id = ?', [id]);
}

/**
 * Baixa a imagem e devolve como data URL.
 *
 * Por que o worker busca em vez de passar a URL ao proxy: não há garantia de
 * que o AI Proxy alcance os hosts de imagem da Gocase, e um agente falhando por
 * egress bloqueado é dificílimo de diagnosticar pelo log ("resposta vazia").
 * Base64 não decodifica pixel — é barato e não encosta no teto de CPU.
 *
 * Acima do teto devolve a URL crua e deixa o proxy tentar: melhor uma chance de
 * funcionar que uma falha certa por estourar memória.
 */
const TETO_DOWNLOAD = 4_000_000;

export async function comoDataUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > TETO_DOWNLOAD) return url;
    const bytes = new Uint8Array(buf);
    let bin = '';
    // Em blocos: String.fromCharCode com centenas de milhares de argumentos
    // estoura a pilha.
    const bloco = 8192;
    for (let i = 0; i < bytes.length; i += bloco) {
      bin += String.fromCharCode(...bytes.subarray(i, i + bloco));
    }
    const tipo = res.headers.get('content-type') || 'image/png';
    return `data:${tipo};base64,${btoa(bin)}`;
  } catch {
    return url;
  }
}

/** Preview guardado pelo runner, pronto para ir a um agente de visão. */
async function imagemDoItem(env: Env, itemId: number, tipo: string): Promise<string | null> {
  const p = await lePreview(env, itemId, tipo);
  return p?.data_url || null;
}

// ---------------------------------------------------------------------------
// Estágios
// ---------------------------------------------------------------------------

/** candidata -> arte_ok. Precisa de cookie: a cascata bate no proxy de dados. */
async function estagioResolver(env: Env, item: ItemFila, cookie: string): Promise<ResultadoAvanco> {
  const arte = await resolverArte(env, item.estampa_key, cookie);
  if (!arte) {
    await falha(env, item.id, 'resolvedor', 'nenhuma das três fontes tem PNG em alta desta estampa');
    return { item_id: item.id, de: item.estado, para: 'falhou_resolvedor', ok: false };
  }
  await atualiza(env, item.id, {
    estado: 'arte_ok',
    png_alta: arte.png_alta,
    material: arte.material,
    engine_identifier: arte.engine_identifier,
    mascara_w: MASCARA_PADRAO.w,
    mascara_h: MASCARA_PADRAO.h,
  });
  return { item_id: item.id, de: item.estado, para: 'arte_ok', ok: true, detalhe: arte.origem };
}

/**
 * arte_ok -> lida. A2, o roteador da esteira.
 *
 * Texto e logo BLOQUEIAM aqui, antes de qualquer geometria: não faz sentido
 * gastar composição e auditoria numa arte que não pode entrar em rapport.
 */
async function estagioLer(env: Env, item: ItemFila): Promise<ResultadoAvanco> {
  if (!item.png_alta) {
    await falha(env, item.id, 'leitor', 'item sem png_alta');
    return { item_id: item.id, de: item.estado, para: 'falhou_leitor', ok: false };
  }

  const img = await comoDataUrl(item.png_alta);
  const leitura = await lerEstampa(
    env,
    img,
    { nome: item.nome, tema: item.tema, licenca: item.licenca },
    item.id,
  );

  const rota = leitura.separavel ? 'deterministica' : 'generativa';

  if (leitura.tem_texto || leitura.tem_logo) {
    const quais = [leitura.tem_texto ? 'texto' : null, leitura.tem_logo ? 'logo' : null]
      .filter(Boolean)
      .join(' e ');
    await atualiza(env, item.id, {
      estado: 'bloqueado_leitor',
      leitura,
      rota_usada: rota,
      motivo_falha: `A2 detectou ${quais}: não pode entrar em rapport, vai para fila manual`,
    });
    await registra(env, item.id, 'bloqueado_leitor', `${quais} detectado`, 'A2');
    return { item_id: item.id, de: item.estado, para: 'bloqueado_leitor', ok: true, detalhe: quais };
  }

  if (leitura.confianca < CORTE_CONFIANCA) {
    await atualiza(env, item.id, {
      estado: 'aguardando_aprovacao',
      leitura,
      rota_usada: rota,
      motivo_falha: `A2 com confiança ${leitura.confianca.toFixed(2)}, abaixo do corte de ${CORTE_CONFIANCA}`,
    });
    return { item_id: item.id, de: item.estado, para: 'aguardando_aprovacao', ok: true, detalhe: 'baixa confiança' };
  }

  await atualiza(env, item.id, { estado: 'lida', leitura, rota_usada: rota });
  return { item_id: item.id, de: item.estado, para: 'lida', ok: true, detalhe: rota };
}

/**
 * lida -> planejada. A3.
 *
 * Se o A3 cair, usa `planoPadrao()` (a regra fixa densidade->estilo) em vez de
 * travar o item: o plano padrão produz composição válida, só menos afinada.
 */
async function estagioPlanejar(env: Env, item: ItemFila): Promise<ResultadoAvanco> {
  if (!item.leitura) {
    await falha(env, item.id, 'estrategista', 'item sem leitura do A2');
    return { item_id: item.id, de: item.estado, para: 'falhou_estrategista', ok: false };
  }

  const mascara = { ...MASCARA_PADRAO, w: item.mascara_w, h: item.mascara_h };
  const ajuste = item.auditoria?.ajuste_sugerido ?? null;

  let plano;
  try {
    plano = await planejar(env, item.leitura, mascara, item.id, ajuste);
  } catch (e) {
    plano = planoPadrao(item.leitura);
    await registra(env, item.id, 'a3_fallback', (e as Error)?.message || 'A3 caiu', 'sistema');
  }

  await atualiza(env, item.id, { estado: 'planejada', plano });
  return { item_id: item.id, de: item.estado, para: 'planejada', ok: true, detalhe: plano.estilo };
}

/**
 * composta -> auditada. A5.
 *
 * O erro de costura em px vem MEDIDO pelo runner (determinístico) e é gravado
 * na linha antes desta chamada. O agente só julga o que a medição não pega.
 */
async function estagioAuditar(env: Env, item: ItemFila): Promise<ResultadoAvanco> {
  const ladrilho = await imagemDoItem(env, item.id, 'ladrilho3x1');
  if (!ladrilho) {
    await falha(env, item.id, 'auditor', 'runner não enviou o ladrilho 3x1');
    return { item_id: item.id, de: item.estado, para: 'falhou_auditor', ok: false };
  }

  const auditoria = await auditar(
    env,
    ladrilho,
    item.erro_costura_px ?? 0,
    item.rota_usada || 'deterministica',
    item.id,
  );

  if (auditoria.veredito !== 'aprovado') {
    const tentativas = item.tentativas + 1;
    if (tentativas >= TETO_TENTATIVAS) {
      await atualiza(env, item.id, {
        estado: 'aguardando_aprovacao',
        auditoria,
        nota_auditor: auditoria.nota,
        tentativas,
        motivo_falha: `reprovado ${tentativas}x no A5: ${auditoria.problemas[0] || 'sem detalhe'}`,
      });
      return {
        item_id: item.id,
        de: item.estado,
        para: 'aguardando_aprovacao',
        ok: true,
        detalhe: `2 reprovas, foi para humano`,
      };
    }
    // Volta ao A3 com o ajuste sugerido. O plano é refeito, a geometria também.
    await atualiza(env, item.id, {
      estado: 'lida',
      auditoria,
      nota_auditor: auditoria.nota,
      tentativas,
    });
    return {
      item_id: item.id,
      de: item.estado,
      para: 'lida',
      ok: true,
      detalhe: `nota ${auditoria.nota}, replanejando`,
    };
  }

  await atualiza(env, item.id, { estado: 'auditada', auditoria, nota_auditor: auditoria.nota });
  return { item_id: item.id, de: item.estado, para: 'auditada', ok: true, detalhe: `nota ${auditoria.nota}` };
}

/**
 * auditada -> nomeada. A6, A7, A8 e A9 em sequência.
 *
 * A7 roda ANTES do A8/A9 de propósito: não vale gastar copy numa arte que a
 * revisão de marca vai bloquear. E se o A7 cair, o item é bloqueado, não
 * liberado (ver bloqueioPorFalha).
 */
async function estagioFecharPacote(env: Env, item: ItemFila): Promise<ResultadoAvanco> {
  const composicao = await imagemDoItem(env, item.id, 'composicao');
  if (!composicao) {
    await falha(env, item.id, 'pacote', 'runner não enviou a composição');
    return { item_id: item.id, de: item.estado, para: 'falhou_pacote', ok: false };
  }
  const leitura = item.leitura;

  // A7 primeiro: é a trava.
  let marca;
  try {
    marca = await revisarMarca(env, composicao, { nome: item.nome, licenca: item.licenca }, item.id);
  } catch (e) {
    marca = bloqueioPorFalha((e as Error)?.message || 'erro desconhecido');
  }

  if (marca.bloqueia) {
    const onde = marca.achados.find((a) => a.gravidade === 'alta')?.onde || 'sem detalhe';
    await atualiza(env, item.id, {
      estado: 'bloqueado_marca',
      marca,
      motivo_falha: `A7 bloqueou: ${onde}`,
    });
    await registra(env, item.id, 'bloqueado_marca', onde, 'A7');
    return { item_id: item.id, de: item.estado, para: 'bloqueado_marca', ok: true, detalhe: onde };
  }

  let cor = null;
  try {
    cor = await escolherCor(env, composicao, leitura?.paleta || [], item.id);
  } catch (e) {
    await registra(env, item.id, 'a6_falhou', (e as Error)?.message || 'A6 caiu', 'sistema');
  }

  const nomeacao = await nomear(
    env,
    {
      estampa_key: item.estampa_key,
      nome: item.nome,
      tema: item.tema,
      licenca: item.licenca,
      estilo: leitura?.estilo || 'não classificado',
    },
    item.id,
  );

  let copy = null;
  try {
    copy = await redigir(
      env,
      {
        nome_comercial: nomeacao.nome_comercial,
        tema: item.tema,
        estilo: leitura?.estilo || 'não classificado',
        motivos: (leitura?.motivos || []).map((m) => m.nome),
        paleta: leitura?.paleta || [],
        cores_corpo: (cor?.recomendadas || []).map((c) => c.cor_corpo),
      },
      item.id,
    );
  } catch (e) {
    await registra(env, item.id, 'a9_falhou', (e as Error)?.message || 'A9 caiu', 'sistema');
  }

  await atualiza(env, item.id, {
    estado: 'aguardando_aprovacao',
    cor,
    marca,
    nomeacao,
    copy,
    engine_identifier: nomeacao.engine_identifier,
  });
  return {
    item_id: item.id,
    de: item.estado,
    para: 'aguardando_aprovacao',
    ok: true,
    detalhe: nomeacao.engine_identifier,
  };
}

// ---------------------------------------------------------------------------
// Avanço
// ---------------------------------------------------------------------------

/** Avança UM item, se der. Não lança: devolve o resultado, inclusive de falha. */
export async function avancaItem(
  env: Env,
  item: ItemFila,
  cookie: string,
): Promise<ResultadoAvanco | null> {
  if (!(await reivindica(env, item.id, item.estado))) return null;

  try {
    switch (item.estado) {
      case 'candidata':
        if (!cookie) {
          // Sem cookie a cascata de arte não roda. Não é falha do item.
          return null;
        }
        return await estagioResolver(env, item, cookie);
      case 'arte_ok':
        return await estagioLer(env, item);
      case 'lida':
        return await estagioPlanejar(env, item);
      case 'composta':
        return await estagioAuditar(env, item);
      case 'auditada':
        return await estagioFecharPacote(env, item);
      default:
        return null;
    }
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    await falha(env, item.id, item.estado, msg);
    return { item_id: item.id, de: item.estado, para: `falhou_${item.estado}`, ok: false, detalhe: msg };
  } finally {
    await libera(env, item.id);
  }
}

export interface ResumoTick {
  avancos: ResultadoAvanco[];
  parados_no_motor: number;
  proxy_ia: boolean;
  tinha_cookie: boolean;
}

/**
 * Um tick do cron: avança o que consegue, com teto de itens por rodada.
 *
 * O teto existe porque o Worker tem orçamento de CPU e de tempo por requisição
 * e cada estágio pode custar duas chamadas de visão. Melhor avançar 6 itens a
 * cada 5 minutos que estourar tentando avançar 60.
 */
export async function tick(env: Env, cookie = '', teto = 6): Promise<ResumoTick> {
  const avancos: ResultadoAvanco[] = [];
  const temProxy = proxyConfigurado(env);

  for (const estado of AVANCAVEIS_POR_CRON) {
    if (avancos.length >= teto) break;
    // Estágios de IA não têm o que fazer sem o proxy configurado.
    if (estado !== 'candidata' && !temProxy) continue;
    if (estado === 'candidata' && !cookie) continue;

    const itens = await itensPorEstado(env, estado, teto - avancos.length);
    for (const item of itens) {
      if (avancos.length >= teto) break;
      const r = await avancaItem(env, item, cookie);
      if (r) avancos.push(r);
    }
  }

  const parados = await env.DB.query(`SELECT COUNT(*) AS n FROM fila WHERE estado = 'planejada'`, []);

  return {
    avancos,
    parados_no_motor: Number(parados.rows[0]?.n || 0),
    proxy_ia: temProxy,
    tinha_cookie: Boolean(cookie),
  };
}

/** Reprocessa um item em falha, devolvendo-o ao estado anterior ao erro. */
export async function reprocessa(env: Env, id: number, autor: string): Promise<boolean> {
  const item = await itemPorId(env, id);
  if (!item) return false;
  const m = /^falhou_(.+)$/.exec(item.estado);
  const volta = m ? m[1] : item.estado;
  await atualiza(env, id, { estado: volta, motivo_falha: null, travado_em: null }, autor);
  await registra(env, id, 'reprocessar', `voltou para ${volta}`, autor);
  return true;
}
