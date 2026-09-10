/**
 * A5 — Auditor de Costura. Trilha T4.
 *
 * Duas camadas, e a ordem importa:
 *
 * Camada 1, determinística: `medirCostura()` roda no browser (motor.js) e mede
 * a descontinuidade na emenda em px. Na rota determinística o erro é 0 POR
 * CONSTRUÇÃO — wrapOffsets desenha cada camada em x-W, x e x+W. Ali o teste não
 * julga arte: é teste de regressão, para pegar quebra de código no motor.
 * Na rota generativa é o teste que de fato reprova, porque o seamless deixa de
 * ser garantido e passa a ser aposta.
 *
 * Camada 2, visão: este agente. Olha o ladrilho 3x1 e julga o que a medição não
 * pega — motivo cortado ao meio, vazio grande, densidade irregular.
 *
 * A nota final NÃO é só a do modelo: `consolidar()` rebaixa a nota quando a
 * medição determinística acusa erro, porque medição vence opinião.
 */

import { chamarAgente, conf, listaStr, num, obj, str, umDe } from '../core/aiproxy';
import type { Auditoria, Env, EstiloComposicao, Rota } from '../core/tipos';
import { comImagem, sistema } from './comum';

const PAPEL = `Você é o AUDITOR DE COSTURA. Recebe a arte da garrafa já composta,
ladrilhada 3 vezes na horizontal (a mesma imagem repetida lado a lado, três
vezes). É assim que a arte vai aparecer dando a volta no cilindro.

As emendas ficam a 1/3 e a 2/3 da largura da imagem que você recebe. Olhe
especificamente para essas duas linhas verticais.

Julgue quatro coisas, nesta ordem de gravidade:
1. COSTURA VISÍVEL — dá para ver onde uma cópia termina e a outra começa?
   Linha vertical, salto de cor, motivo que muda de tamanho na emenda.
2. MOTIVO CORTADO — algum desenho aparece pela metade, sem a outra metade
   encostando do outro lado da emenda?
3. VAZIO GRANDE — buraco sem arte que chame atenção, sobretudo colado na emenda.
4. DENSIDADE IRREGULAR — uma faixa vertical claramente mais cheia que outra.

Repetição de motivo NÃO é defeito: é o objetivo de um rapport. Só reclame se a
repetição for tão próxima que vire fileira óbvia.

nota de 0 a 10:
  9-10 emenda invisível, distribuição equilibrada
  7-8  boa, defeito pequeno e não óbvio a distância
  5-6  defeito visível que precisa de ajuste
  0-4  costura quebrada ou composição inutilizável

veredito: "aprovado" (nota >= 7), "ajustar" (4-6), "reprovado" (< 4).
Quando não for "aprovado", preencha "ajuste_sugerido" com o que mudar: outro
estilo de distribuição, ou uma escala diferente dos motivos.
"problemas" é a lista do que você viu, em português, uma frase por item. Vazia
quando não há defeito.`;

const SCHEMA = `{
  "erro_costura_px": number,
  "nota": number,
  "problemas": ["string"],
  "veredito": "aprovado" | "ajustar" | "reprovado",
  "ajuste_sugerido": { "estilo": "stickers"|"linear"|"distribuido"|"localizada", "escala": number } | null,
  "confianca": number
}

Em "erro_costura_px" repita o valor medido que foi informado no texto — não
estime por conta própria; a medição em px é feita em código, não a olho.`;

const VEREDITOS = ['aprovado', 'ajustar', 'reprovado'] as const;
const ESTILOS = ['stickers', 'linear', 'distribuido', 'localizada'] as const;

export function validaAuditoria(bruto: unknown): Auditoria | null {
  const o = obj(bruto);
  if (!o) return null;
  if (o.nota === undefined || o.nota === null) return null;

  const aj = obj(o.ajuste_sugerido);
  const nota = Math.min(10, Math.max(0, num(o.nota, 0)));

  return {
    erro_costura_px: Math.max(0, num(o.erro_costura_px, 0)),
    nota,
    problemas: listaStr(o.problemas, 12).map((p) => p.slice(0, 200)),
    veredito: umDe(o.veredito, VEREDITOS, nota >= 7 ? 'aprovado' : nota >= 4 ? 'ajustar' : 'reprovado'),
    ajuste_sugerido: aj
      ? {
          estilo: (ESTILOS as readonly string[]).includes(str(aj.estilo))
            ? (str(aj.estilo) as EstiloComposicao)
            : undefined,
          escala: aj.escala === undefined ? undefined : Math.min(2, Math.max(0.5, num(aj.escala, 1))),
        }
      : null,
    confianca: conf(o.confianca),
  };
}

/** Acima disto a emenda é considerada quebrada, independente do que o modelo ache. */
export const TETO_COSTURA_PX = 2;

/**
 * Junta a medição determinística com o julgamento visual.
 *
 * Medição vence opinião: se a costura mediu erro acima do teto, a nota é
 * rebaixada e o veredito viaja para "reprovado" mesmo que o modelo tenha dado
 * 9. O contrário não vale — costura zero não salva composição feia, porque o
 * modelo está julgando outra coisa (vazio, corte, densidade).
 *
 * Na rota determinística, erro acima de zero é BUG NO MOTOR, não arte ruim. Por
 * isso a mensagem é explícita: é o que faz o teste de regressão valer.
 */
export function consolidar(visao: Auditoria, erroMedidoPx: number, rota: Rota): Auditoria {
  const problemas = [...visao.problemas];
  let nota = visao.nota;
  let veredito = visao.veredito;

  if (erroMedidoPx > TETO_COSTURA_PX) {
    nota = Math.min(nota, 3);
    veredito = 'reprovado';
    problemas.unshift(
      rota === 'deterministica'
        ? `costura mediu ${erroMedidoPx}px na rota determinística, onde deveria ser 0 — ` +
            `isto indica regressão no motor de rapport, não defeito da arte`
        : `costura mediu ${erroMedidoPx}px: a emenda não fecha`,
    );
  }

  return { ...visao, erro_costura_px: erroMedidoPx, nota, veredito, problemas };
}

export async function auditar(
  env: Env,
  ladrilho3x1Url: string,
  erroMedidoPx: number,
  rota: Rota,
  itemId: number | null = null,
): Promise<Auditoria> {
  const visao = await chamarAgente<Auditoria>(
    env,
    'A5_auditor',
    [
      sistema(PAPEL, SCHEMA),
      comImagem(
        ladrilho3x1Url,
        `Ladrilho 3x1 da composição. As emendas estão a 1/3 e 2/3 da largura.\n\n` +
          `Medição determinística da emenda: ${erroMedidoPx} px de descontinuidade.\n` +
          `Rota usada: ${rota}.\n\n` +
          `Julgue e devolva o JSON.`,
      ),
    ],
    { temperature: 0.2, maxTokens: 1500, itemId, valida: validaAuditoria, tentativas: 2 },
  );

  return consolidar(visao, erroMedidoPx, rota);
}
