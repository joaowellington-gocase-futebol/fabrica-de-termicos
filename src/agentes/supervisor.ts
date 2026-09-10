/**
 * A10 — Supervisor da Esteira. Trilha T5. O maestro.
 *
 * Não toca arte. Lê o estado da fila e opera: reprocessa falha transitória,
 * decide quando desistir e escalar para humano, detecta padrão de erro repetido
 * e escreve o resumo do dia.
 *
 * É este agente que faz a esteira parecer autônoma — e o que torna a promessa
 * de "90% automatizado" observável em vez de prometida.
 *
 * Trava importante: as ações do A10 são FILTRADAS antes de executar
 * (`acoesExecutaveis`). O modelo sugere; o código decide o que é permitido. Um
 * agente com poder de descartar item sem revisão viraria uma forma criativa de
 * a fila esvaziar sozinha.
 */

import { arr, chamarAgente, conf, num, obj, str, umDe } from '../core/aiproxy';
import type { AcaoSupervisor, Env, Supervisao } from '../core/tipos';
import { sistema } from './comum';

const PAPEL = `Você é o SUPERVISOR da esteira de adaptação de estampas. Você não
julga arte: você opera a fila. Recebe a contagem por estado, os itens travados
em falha e as últimas linhas de log dos agentes.

Para cada item em falha, escolha uma ação:
- "reprocessar" → a falha parece transitória (timeout, erro de rede, 5xx, JSON
                  malformado numa tentativa). Vale tentar de novo.
- "escalar"     → a falha é de julgamento ou já repetiu. Precisa de humano.
                  Sempre escale bloqueio de marca, texto e logo — nunca
                  reprocesse esses: o resultado seria o mesmo.
- "descartar"   → recomendação de tirar da fila (arte inviável para térmico).

"alerta" é uma frase só, para quem opera. Use quando você detectar PADRÃO, não
caso isolado: vários itens falhando no mesmo agente, ou reprova repetida no
mesmo tipo de arte. Escreva string vazia se não houver padrão.

"resumo_dia": duas ou três frases em português, tom de recado de colega — quantas
entraram, quantas fecharam sozinhas, quantas estão esperando pessoa, e o que
merece atenção. Números concretos, sem adjetivo de marketing.`;

const SCHEMA = `{
  "acoes": [ { "item_id": number, "acao": "reprocessar"|"escalar"|"descartar",
               "motivo": "uma frase" } ],
  "alerta": "string",
  "resumo_dia": "string",
  "confianca": number
}`;

const ACOES = ['reprocessar', 'escalar', 'descartar'] as const;

export function fazValidador(idsValidos: number[]) {
  const validos = new Set(idsValidos);

  return function validaSupervisao(bruto: unknown): Supervisao | null {
    const o = obj(bruto);
    if (!o) return null;
    if (typeof o.resumo_dia !== 'string') return null;

    const vistos = new Set<number>();
    const acoes: AcaoSupervisor[] = [];
    for (const a of arr(o.acoes)) {
      const ao = obj(a);
      if (!ao) continue;
      const id = Math.round(num(ao.item_id, -1));
      if (!validos.has(id) || vistos.has(id)) continue;
      vistos.add(id);
      acoes.push({
        item_id: id,
        acao: umDe(ao.acao, ACOES, 'escalar'),
        motivo: str(ao.motivo, '').slice(0, 240),
      });
    }

    return {
      acoes,
      alerta: str(o.alerta, '').slice(0, 300),
      resumo_dia: str(o.resumo_dia, '').slice(0, 800),
      confianca: conf(o.confianca),
    };
  };
}

/**
 * Filtra o que o supervisor pode de fato executar sozinho.
 *
 * `reprocessar` é reversível e barato: liberado, com teto de tentativas.
 * `escalar` só move o item para a fila humana: liberado.
 * `descartar` é destrutivo e fica como RECOMENDAÇÃO — vira `escalar`, com o
 * motivo preservado, para uma pessoa bater o martelo.
 */
export function acoesExecutaveis(
  acoes: AcaoSupervisor[],
  tentativasPorItem: Map<number, number>,
  tetoTentativas = 2,
): { executar: AcaoSupervisor[]; recomendacoes: AcaoSupervisor[] } {
  const executar: AcaoSupervisor[] = [];
  const recomendacoes: AcaoSupervisor[] = [];

  for (const a of acoes) {
    if (a.acao === 'descartar') {
      recomendacoes.push(a);
      executar.push({ ...a, acao: 'escalar', motivo: `descarte sugerido pelo A10: ${a.motivo}` });
      continue;
    }
    if (a.acao === 'reprocessar' && (tentativasPorItem.get(a.item_id) ?? 0) >= tetoTentativas) {
      executar.push({
        ...a,
        acao: 'escalar',
        motivo: `já tentou ${tetoTentativas}x; escalado em vez de reprocessado`,
      });
      continue;
    }
    executar.push(a);
  }

  return { executar, recomendacoes };
}

export async function supervisionar(
  env: Env,
  estado: {
    contagens: { estado: string; n: number }[];
    falhas: { id: number; estampa_key: string; estado: string; motivo_falha: string | null; tentativas: number }[];
    logRecente: { agente: string; ok: number; erro: string | null }[];
    metricas: { rotas: { rota: string; n: number }[]; custo_total_usd: number; nota_media: number | null };
  },
  itemId: number | null = null,
): Promise<Supervisao> {
  const contagens = estado.contagens.map((c) => `${c.estado}: ${c.n}`).join(' · ') || 'fila vazia';
  const falhas =
    estado.falhas
      .map(
        (f) =>
          `#${f.id} ${f.estampa_key} — estado ${f.estado}, ${f.tentativas} tentativa(s): ` +
          `${f.motivo_falha || 'sem motivo registrado'}`,
      )
      .join('\n') || 'nenhum item em falha';
  const erros =
    estado.logRecente
      .filter((l) => !l.ok)
      .map((l) => `${l.agente}: ${l.erro}`)
      .slice(0, 20)
      .join('\n') || 'nenhum erro recente de agente';
  const rotas = estado.metricas.rotas.map((r) => `${r.rota}: ${r.n}`).join(' · ') || 'sem dado';

  return chamarAgente<Supervisao>(
    env,
    'A10_supervisor',
    [
      sistema(PAPEL, SCHEMA),
      {
        role: 'user',
        content:
          `Contagem por estado:\n${contagens}\n\n` +
          `Itens em falha:\n${falhas}\n\n` +
          `Erros recentes de agente:\n${erros}\n\n` +
          `Rotas usadas: ${rotas}\n` +
          `Custo acumulado: US$ ${estado.metricas.custo_total_usd.toFixed(4)}\n` +
          `Nota média do auditor: ${estado.metricas.nota_media?.toFixed(1) ?? 'sem dado'}\n\n` +
          `Devolva o JSON.`,
      },
    ],
    {
      temperature: 0.2,
      maxTokens: 2500,
      itemId,
      valida: fazValidador(estado.falhas.map((f) => f.id)),
      tentativas: 2,
    },
  );
}
