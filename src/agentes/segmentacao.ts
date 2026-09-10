/**
 * A4 — Copiloto de Segmentação. Trilha T3.
 *
 * O recorte é determinístico (flood-fill + componentes conexos). O problema
 * clássico é a ilustração quebrar em pedaços: uma flor vira cinco pétalas
 * soltas, porque as pétalas não se tocam no canal alpha.
 *
 * Este agente olha o contact-sheet numerado dos recortes e conserta o
 * agrupamento. Ele NÃO recorta — devolve veredito por peça, e o motor refaz o
 * agrupamento com base nisso. A geometria continua determinística.
 */

import { arr, chamarAgente, conf, num, obj, str, umDe } from '../core/aiproxy';
import type { Env, RevisaoSegmentacao, VeredictoPeca } from '../core/tipos';
import { comImagem, sistema } from './comum';

const PAPEL = `Você é o COPILOTO DE SEGMENTAÇÃO. Recebe um contact-sheet: os
recortes automáticos de uma estampa, cada um numerado e com sua bbox em px.
O recorte foi feito por componentes conexos no canal alpha, então ele erra
sempre do mesmo jeito: parte uma ilustração única em vários pedaços que não se
tocam.

Sua tarefa é dizer, para cada peça numerada, o que ela é:
- "motivo_valido" → é uma ilustração completa e usável sozinha.
- "fragmento"     → é PARTE de uma ilustração maior. Preencha "funde_com" com
                    os números das outras peças do mesmo desenho. Exemplo: se as
                    peças 3, 4 e 5 são pétalas da mesma flor, marque as três como
                    fragmento e cada uma com funde_com apontando para as outras.
- "ruido"         → respingo, poeira, pedaço de borda, sobra de recorte.
- "duplicata"     → é o mesmo motivo de outra peça, repetido. Aponte a original
                    em "funde_com" com um único número.

Use o TAMANHO e a POSIÇÃO das bboxes como pista: pedaços do mesmo desenho ficam
próximos e costumam ter escalas parecidas. Peça minúscula e isolada é ruído.

"nome" é uma etiqueta curta em português para a peça ("flor de lavanda", "folha").
Para fragmento, use o nome do desenho INTEIRO, não do pedaço.

"qualidade_recorte" de 0 a 1: quanto o recorte automático acertou no geral.
"refazer_com_tolerancia": normalmente null. Devolva um número entre 5 e 60
apenas se o recorte estiver claramente ruim porque o fundo não foi removido
(sobrou moldura de fundo em volta das peças) — é a tolerância de cor sugerida
para uma nova tentativa.`;

const SCHEMA = `{
  "pecas": [ { "id": number, "veredito": "motivo_valido" | "fragmento" | "ruido" | "duplicata",
               "funde_com": [number], "nome": "string curta" } ],
  "qualidade_recorte": number,
  "refazer_com_tolerancia": number | null,
  "confianca": number
}

Inclua UMA entrada por peça numerada no contact-sheet, com o mesmo id.
"funde_com" é [] quando o veredito é "motivo_valido" ou "ruido".`;

const VEREDITOS = ['motivo_valido', 'fragmento', 'ruido', 'duplicata'] as const;

export function validaSegmentacao(bruto: unknown): RevisaoSegmentacao | null {
  const o = obj(bruto);
  if (!o) return null;
  const cru = arr(o.pecas);
  if (!cru.length) return null;

  const pecas: VeredictoPeca[] = [];
  for (const p of cru) {
    const po = obj(p);
    if (!po) continue;
    const id = Math.round(num(po.id, -1));
    if (id < 0) continue;
    pecas.push({
      id,
      veredito: umDe(po.veredito, VEREDITOS, 'motivo_valido'),
      funde_com: arr(po.funde_com)
        .map((x) => Math.round(num(x, -1)))
        .filter((x) => x >= 0 && x !== id)
        .slice(0, 40),
      nome: str(po.nome, 'peça').slice(0, 80),
    });
  }
  if (!pecas.length) return null;

  const tol = o.refazer_com_tolerancia;
  return {
    pecas,
    qualidade_recorte: Math.min(1, Math.max(0, num(o.qualidade_recorte, 0.5))),
    refazer_com_tolerancia:
      tol === null || tol === undefined ? null : Math.min(60, Math.max(5, num(tol, 20))),
    confianca: conf(o.confianca),
  };
}

/**
 * Fecha os grupos de fusão transitivamente.
 *
 * O modelo costuma devolver a relação pela metade — diz que 3 funde com 4 e que
 * 5 funde com 4, mas não que 3 funde com 5. Sem fechar isso por union-find, a
 * flor volta a sair partida mesmo o agente tendo acertado a leitura.
 *
 * Devolve os grupos já sem as peças descartadas (ruído e duplicata).
 */
export function gruposDeFusao(revisao: RevisaoSegmentacao): { grupos: number[][]; descartar: number[] } {
  const pai = new Map<number, number>();
  const acha = (x: number): number => {
    if (!pai.has(x)) pai.set(x, x);
    let r = pai.get(x)!;
    while (r !== pai.get(r)!) r = pai.get(r)!;
    pai.set(x, r);
    return r;
  };
  const une = (a: number, b: number) => {
    const ra = acha(a);
    const rb = acha(b);
    if (ra !== rb) pai.set(ra, rb);
  };

  const descartar: number[] = [];
  for (const p of revisao.pecas) {
    acha(p.id);
    if (p.veredito === 'ruido' || p.veredito === 'duplicata') {
      descartar.push(p.id);
      continue;
    }
    for (const outro of p.funde_com) une(p.id, outro);
  }

  const porRaiz = new Map<number, number[]>();
  for (const p of revisao.pecas) {
    if (descartar.includes(p.id)) continue;
    const r = acha(p.id);
    porRaiz.set(r, [...(porRaiz.get(r) || []), p.id]);
  }

  return { grupos: [...porRaiz.values()], descartar };
}

export async function revisarSegmentacao(
  env: Env,
  contactSheetUrl: string,
  bboxes: { id: number; ox: number; oy: number; ow: number; oh: number }[],
  itemId: number | null = null,
): Promise<RevisaoSegmentacao> {
  const tabela = bboxes
    .map((b) => `#${b.id}: ${b.ow}x${b.oh} px em (${b.ox}, ${b.oy})`)
    .join('\n');

  return chamarAgente<RevisaoSegmentacao>(
    env,
    'A4_segmentacao',
    [
      sistema(PAPEL, SCHEMA),
      comImagem(
        contactSheetUrl,
        `Contact-sheet com ${bboxes.length} recortes numerados.\n\nBboxes:\n${tabela}\n\n` +
          `Devolva o veredito de cada peça em JSON.`,
      ),
    ],
    { temperature: 0.2, maxTokens: 3000, itemId, valida: validaSegmentacao, tentativas: 2 },
  );
}
