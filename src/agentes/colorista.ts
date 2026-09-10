/**
 * A6 — Colorista. Trilha T4.
 *
 * Decisão comercial, não estética: a arte foi desenhada para o fundo branco de
 * uma capinha; o térmico tem corpo branco, preto ou azul. Este agente diz em
 * qual corpo aquela estampa deve sair — e em qual ela NÃO pode sair, que é a
 * parte que evita produto publicado com arte que desaparece.
 */

import { arr, chamarAgente, conf, num, obj, str, umDe } from '../core/aiproxy';
import type { CorCorpo, Env, EscolhaCor } from '../core/tipos';
import { comImagem, sistema } from './comum';

const PAPEL = `Você é o COLORISTA. A arte que você vê tem FUNDO TRANSPARENTE e
vai ser impressa sobre o corpo da garrafa, que é branco, preto ou azul-marinho.
O que é transparente na arte fica com a cor do corpo.

Para cada uma das três cores de corpo, avalie:
- os motivos continuam legíveis a distância?
- há contraste suficiente entre a arte e o corpo?
- algum elemento claro desaparece no corpo branco, ou algum elemento escuro
  desaparece no corpo preto?

Regra prática que erra pouco: arte de tom claro (pastel, aquarela suave, branco)
precisa de corpo escuro; arte de tom escuro ou saturado aguenta corpo branco.
Arte com contorno preto costuma funcionar em branco e sumir em preto.

"contraste" de 0 a 1 é sua estimativa de contraste percebido entre arte e corpo.
"nota" de 0 a 10 é o quanto você recomenda comercialmente aquela combinação.

Coloque em "recomendadas" só as cores que valem publicar (nota >= 7) e em
"reprovadas" as que não valem, com o motivo em uma frase. Uma cor deve aparecer
em exatamente uma das duas listas. É aceitável — e comum — que só uma cor seja
recomendada.

"ajuste_paleta_sugerido": normalmente null. Use uma frase curta apenas se um
ajuste simples de paleta (escurecer contornos, por exemplo) destravaria uma cor
de corpo que hoje está reprovada.`;

const SCHEMA = `{
  "recomendadas": [ { "cor_corpo": "branco"|"preto"|"azul", "contraste": number, "nota": number } ],
  "reprovadas": [ { "cor_corpo": "branco"|"preto"|"azul", "motivo": "string curta" } ],
  "ajuste_paleta_sugerido": "string" | null,
  "confianca": number
}`;

const CORES = ['branco', 'preto', 'azul'] as const;

export function validaCor(bruto: unknown): EscolhaCor | null {
  const o = obj(bruto);
  if (!o) return null;
  const rec = arr(o.recomendadas);
  const rep = arr(o.reprovadas);
  // Sem nenhuma das duas listas o agente não decidiu nada.
  if (!rec.length && !rep.length) return null;

  const vistas = new Set<CorCorpo>();

  const recomendadas = rec
    .map((x) => {
      const xo = obj(x);
      if (!xo) return null;
      const cor = umDe(xo.cor_corpo, CORES, 'branco');
      if (vistas.has(cor)) return null;
      vistas.add(cor);
      return {
        cor_corpo: cor,
        contraste: Math.min(1, Math.max(0, num(xo.contraste, 0.5))),
        nota: Math.min(10, Math.max(0, num(xo.nota, 7))),
      };
    })
    .filter((x): x is { cor_corpo: CorCorpo; contraste: number; nota: number } => x !== null);

  const reprovadas = rep
    .map((x) => {
      const xo = obj(x);
      if (!xo) return null;
      const cor = umDe(xo.cor_corpo, CORES, 'preto');
      if (vistas.has(cor)) return null;
      vistas.add(cor);
      return { cor_corpo: cor, motivo: str(xo.motivo, 'sem motivo informado').slice(0, 200) };
    })
    .filter((x): x is { cor_corpo: CorCorpo; motivo: string } => x !== null);

  return {
    recomendadas: recomendadas.sort((a, b) => b.nota - a.nota),
    reprovadas,
    ajuste_paleta_sugerido: o.ajuste_paleta_sugerido ? str(o.ajuste_paleta_sugerido).slice(0, 240) : null,
    confianca: conf(o.confianca),
  };
}

export async function escolherCor(
  env: Env,
  composicaoUrl: string,
  paleta: string[],
  itemId: number | null = null,
): Promise<EscolhaCor> {
  return chamarAgente<EscolhaCor>(
    env,
    'A6_colorista',
    [
      sistema(PAPEL, SCHEMA),
      comImagem(
        composicaoUrl,
        `Arte composta para a garrafa, fundo transparente.\n` +
          (paleta.length ? `Paleta medida na arte: ${paleta.join(', ')}\n` : '') +
          `\nCorpos disponíveis: branco, preto, azul-marinho.\n` +
          `Diga em quais vale publicar e em quais não. Devolva o JSON.`,
      ),
    ],
    { temperature: 0.2, maxTokens: 1200, itemId, valida: validaCor, tentativas: 2 },
  );
}
