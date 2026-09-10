/**
 * A11 — Juiz de Fidelidade. Trilha T4. A última porta antes do humano.
 *
 * Julga o RESULTADO contra a arte de origem, nos cinco critérios do produto:
 *
 *   1. semelhança com a composição da capinha deve ser alta   (julgado)
 *   2. o rapport deve encaixar bem                            (MEDIDO)
 *   3. o recorte dos elementos deve ser coerente              (julgado)
 *   4. respeitar a resolução da case — sem arte pixelada      (MEDIDO)
 *   5. respeitar a margem de segurança da logo                (MEDIDO)
 *
 * A divisão medido/julgado não é detalhe de implementação: é o que separa este
 * agente de uma opinião. Três dos cinco critérios têm resposta exata, calculada
 * no motor (`medirFidelidade` em motor.js), e o modelo NÃO opina sobre eles —
 * recebe o número e escreve a observação. Se ele contradisser a medição,
 * `consolidar()` sobrescreve.
 *
 * Diferença em relação ao A5 (Auditor de Costura): o A5 olha só o resultado e
 * pergunta "esta arte está bem feita?". O A11 olha resultado E ORIGEM e
 * pergunta "esta arte continua sendo a arte que vendia?". São perguntas
 * diferentes e a segunda é a que o projeto promete.
 */

import { chamarAgente, conf, listaStr, num, obj, str } from '../core/aiproxy';
import type {
  Env,
  EstiloComposicao,
  Fidelidade,
  LeituraEstampa,
  MedicaoFidelidade,
  NotaCriterio,
} from '../core/tipos';
import { comImagens, resumoLeitura, sistema } from './comum';

/** Acima disto a emenda não fecha. Mesmo teto do A5, de propósito. */
export const TETO_COSTURA_PX = 2;

/**
 * Ampliação máxima tolerada de um recorte.
 *
 * 1.0 é o tamanho nativo. Até 1.5x a perda não aparece na impressão; acima de
 * 2.0x o pixel da arte original virou um bloco de 4 e a borda do traço fica
 * visivelmente mole. Estes números vêm da regra prática de pré-impressão, não
 * de medição nossa — quando houver reprova de gráfica, corrija AQUI, num lugar
 * só, em vez de dentro de um prompt.
 */
export const AMPLIACAO_BOA = 1.5;
export const AMPLIACAO_REPROVA = 2.0;

/** Peso de cada critério na nota final. Semelhança pesa mais: é a promessa. */
const PESOS = {
  semelhanca_composicao: 0.3,
  rapport: 0.25,
  coerencia_recorte: 0.2,
  resolucao: 0.15,
  margem_logo: 0.1,
};

const PAPEL = `Você é o JUIZ DE FIDELIDADE. Recebe DUAS imagens:

  IMAGEM 1 — a arte original da capinha (o que vende hoje)
  IMAGEM 2 — a arte adaptada para a garrafa térmica, ladrilhada 3x na horizontal

Sua pergunta não é "esta arte é bonita". É: **esta continua sendo a mesma arte?**
Uma adaptação que fica bonita mas parece outro produto é uma falha, porque o que
justifica o projeto é aproveitar uma estampa que JÁ vende.

Você julga DOIS critérios. Os outros três já foram medidos em código e os
valores vêm no texto — para esses você só escreve a observação, sem discutir o
número.

## Critério 1 — semelhança com a composição da capinha (o mais importante)

Compare as duas imagens e pergunte:
- os MESMOS elementos aparecem? algum sumiu, algum novo apareceu?
- a HIERARQUIA se manteve? Se na capinha havia um elemento grande com outros
  menores em volta, isso continua visível? Ou tudo virou do mesmo tamanho?
- o ARRANJO se manteve? Uma arte agrupada em buquê que virou grade regular
  perdeu a identidade, mesmo usando as mesmas peças.
- a densidade é parecida? A garrafa é mais larga, então alguma diferença é
  esperada — mas arte que era arejada e virou massa cheia falhou.
- a paleta é a mesma?

nota 9-10: reconheceria como a mesma estampa num catálogo, lado a lado.
nota 7-8:  é a mesma família, com diferença de distribuição aceitável.
nota 5-6:  usa as mesmas peças mas a composição mudou de caráter.
nota 0-4:  parece outra arte.

## Critério 3 — coerência do recorte

Olhe os elementos na IMAGEM 2 e verifique se cada um está INTEIRO e
COMPREENSÍVEL:
- há metade de flor, pétala solta, pedaço de folha sem galho?
- algum elemento ficou irreconhecível por ter sido cortado errado?
- sobrou moldura, retângulo de fundo ou halo em volta de algum elemento (sinal
  de que a remoção de fundo falhou)?
- há elemento que na capinha era um desenho só e na garrafa aparece partido?

Elemento cortado pela BORDA da imagem não é defeito quando a outra metade
encosta do outro lado — isso é rapport funcionando.

nota 9-10: todos os elementos íntegros e limpos.
nota 7-8:  um fragmento pequeno e discreto.
nota 5-6:  fragmento visível ou halo de fundo em vários elementos.
nota 0-4:  os elementos não são compreensíveis.

## Saída

Para "rapport", "resolucao" e "margem_logo", copie a nota que foi informada no
texto e escreva uma observação curta explicando o que aquele número significa.
NÃO invente nota diferente da informada.

"problemas": o que reprovou, em ordem de gravidade, uma frase por item. Vazio
quando está tudo bem.

"ajuste_sugerido": quando não for aprovado, o que mudar — outro estilo de
distribuição ou outra escala.`;

const SCHEMA = `{
  "criterios": {
    "semelhanca_composicao": { "nota": number, "observacao": "string" },
    "coerencia_recorte":     { "nota": number, "observacao": "string" },
    "rapport":               { "nota": number, "observacao": "string" },
    "resolucao":             { "nota": number, "observacao": "string" },
    "margem_logo":           { "nota": number, "observacao": "string" }
  },
  "problemas": ["string"],
  "ajuste_sugerido": { "estilo": "stickers"|"linear"|"distribuido"|"localizada", "escala": number } | null,
  "confianca": number
}

Todas as notas de 0 a 10.`;

const ESTILOS = ['stickers', 'linear', 'distribuido', 'localizada'] as const;

// ---------------------------------------------------------------------------
// Os três critérios medidos — conta, não opinião
// ---------------------------------------------------------------------------

/** Critério 2. Costura em px -> nota. Zero é o esperado na rota A. */
export function notaRapport(erroPx: number, semRapport: boolean): NotaCriterio {
  if (semRapport) {
    return {
      nota: 0,
      fonte: 'medido',
      observacao:
        'a composição saiu sem rapport (arte de fundo contínuo, sem motivo a repetir): ' +
        'a emenda não fecha por construção',
    };
  }
  if (erroPx === 0) {
    return { nota: 10, fonte: 'medido', observacao: 'costura fecha com erro zero, por construção' };
  }
  if (erroPx <= TETO_COSTURA_PX) {
    return {
      nota: 8,
      fonte: 'medido',
      observacao: `${erroPx}px de descontinuidade na emenda, dentro da tolerância de ${TETO_COSTURA_PX}px`,
    };
  }
  // Degrada linearmente até 0 em 60px de descontinuidade.
  const nota = Math.max(0, 7 * (1 - (erroPx - TETO_COSTURA_PX) / 60));
  return {
    nota: Math.round(nota * 10) / 10,
    fonte: 'medido',
    observacao:
      `${erroPx} linhas de descontinuidade na emenda — acima da tolerância de ` +
      `${TETO_COSTURA_PX}px, a costura aparece`,
  };
}

/** Critério 4. Fator de ampliação -> nota. */
export function notaResolucao(
  ampliacao: number,
  piorCamada: string | null,
  nativa: { w: number; h: number } | null,
): NotaCriterio {
  const onde = piorCamada ? ` (pior caso: "${piorCamada}")` : '';
  const origem = nativa ? ` A arte nativa é ${nativa.w}x${nativa.h}px.` : '';

  if (ampliacao <= 1.001) {
    return {
      nota: 10,
      fonte: 'medido',
      observacao: `nenhum recorte foi ampliado — todos saem no tamanho nativo ou menor.${origem}`,
    };
  }
  if (ampliacao <= AMPLIACAO_BOA) {
    const nota = 10 - 2 * ((ampliacao - 1) / (AMPLIACAO_BOA - 1));
    return {
      nota: Math.round(nota * 10) / 10,
      fonte: 'medido',
      observacao: `ampliação máxima de ${ampliacao.toFixed(2)}x${onde}, dentro do aceitável para impressão.${origem}`,
    };
  }
  if (ampliacao <= AMPLIACAO_REPROVA) {
    const nota = 8 - 3 * ((ampliacao - AMPLIACAO_BOA) / (AMPLIACAO_REPROVA - AMPLIACAO_BOA));
    return {
      nota: Math.round(nota * 10) / 10,
      fonte: 'medido',
      observacao: `ampliação de ${ampliacao.toFixed(2)}x${onde} — começa a amolecer o traço.${origem}`,
    };
  }
  return {
    nota: Math.max(0, 5 - (ampliacao - AMPLIACAO_REPROVA) * 2),
    fonte: 'medido',
    observacao:
      `ampliação de ${ampliacao.toFixed(2)}x${onde}: cada pixel da arte virou ` +
      `${Math.round(ampliacao ** 2)} na impressão, a arte sai pixelada.${origem}`,
  };
}

/**
 * Critério 5. Invasão da zona da logo -> nota.
 *
 * Quando o Factory não tem a margem cadastrada — que é o caso de TODOS os
 * térmicos do primeiro corte hoje — a nota é `null` conceitualmente. Aqui isso
 * virou nota 5 com `fonte: 'medido'` e observação explícita de que NÃO foi
 * verificado, e o critério sai do cálculo da média (peso redistribuído). Um
 * critério de compliance que "passa" por falta de dado é pior que não existir.
 */
export function notaMargemLogo(m: MedicaoFidelidade): { nota: NotaCriterio; verificado: boolean } {
  if (!m.invade_logo) {
    return {
      nota: {
        nota: 5,
        fonte: 'medido',
        observacao:
          'NÃO VERIFICADO: ' +
          (m.logo_indisponivel || 'a zona da logo não está cadastrada no Factory para este material') +
          '. Confira à mão antes de aprovar.',
      },
      verificado: false,
    };
  }
  if (!m.invade_logo.invade) {
    return {
      nota: { nota: 10, fonte: 'medido', observacao: 'nenhum motivo invade a zona da logo' },
      verificado: true,
    };
  }
  const pct = Math.round(m.invade_logo.cobertura * 100);
  return {
    nota: {
      nota: Math.max(0, 6 - pct / 12),
      fonte: 'medido',
      observacao:
        `${m.invade_logo.colocacoes_invasoras} motivo(s) invadem a zona da logo, ` +
        `cobrindo ${pct}% dela`,
    },
    verificado: true,
  };
}

// ---------------------------------------------------------------------------
// Validação e consolidação
// ---------------------------------------------------------------------------

function criterio(v: unknown, fonte: 'medido' | 'julgado'): NotaCriterio {
  const o = obj(v) || {};
  return {
    nota: Math.min(10, Math.max(0, num(o.nota, 0))),
    fonte,
    observacao: str(o.observacao, '').slice(0, 300),
  };
}

export function validaFidelidade(bruto: unknown): Partial<Fidelidade> | null {
  const o = obj(bruto);
  if (!o) return null;
  const c = obj(o.criterios);
  if (!c) return null;
  // Sem os dois critérios julgados o agente não fez o trabalho dele.
  if (!obj(c.semelhanca_composicao) || !obj(c.coerencia_recorte)) return null;

  const aj = obj(o.ajuste_sugerido);
  return {
    criterios: {
      semelhanca_composicao: criterio(c.semelhanca_composicao, 'julgado'),
      coerencia_recorte: criterio(c.coerencia_recorte, 'julgado'),
      rapport: criterio(c.rapport, 'medido'),
      resolucao: criterio(c.resolucao, 'medido'),
      margem_logo: criterio(c.margem_logo, 'medido'),
    },
    problemas: listaStr(o.problemas, 12).map((p) => p.slice(0, 240)),
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

/**
 * Junta o julgado com o medido, e o medido vence.
 *
 * As três notas medidas SOBRESCREVEM o que o modelo escreveu, e cada uma tem
 * poder de veto próprio: costura acima do teto, ampliação acima do limite de
 * impressão ou invasão da zona da logo reprovam sozinhas, independente de a
 * média ter ficado alta. Média é para ler "quão bom"; veto é para decidir.
 */
export function consolidar(
  parcial: Partial<Fidelidade>,
  medicao: MedicaoFidelidade,
): Fidelidade {
  const julgados = parcial.criterios ?? {
    semelhanca_composicao: { nota: 0, fonte: 'julgado' as const, observacao: 'sem julgamento' },
    coerencia_recorte: { nota: 0, fonte: 'julgado' as const, observacao: 'sem julgamento' },
    rapport: { nota: 0, fonte: 'medido' as const, observacao: '' },
    resolucao: { nota: 0, fonte: 'medido' as const, observacao: '' },
    margem_logo: { nota: 0, fonte: 'medido' as const, observacao: '' },
  };

  const rapport = notaRapport(medicao.erro_costura_px, medicao.sem_rapport);
  const resolucao = notaResolucao(
    medicao.ampliacao_maxima,
    medicao.ampliacao_pior_camada,
    medicao.arte_nativa,
  );
  const { nota: margemLogo, verificado: logoVerificada } = notaMargemLogo(medicao);

  const criterios = {
    semelhanca_composicao: julgados.semelhanca_composicao,
    rapport,
    coerencia_recorte: julgados.coerencia_recorte,
    resolucao,
    margem_logo: margemLogo,
  };

  // Critério não verificado sai da média: o peso dele é redistribuído entre os
  // demais, em vez de um 5 arbitrário puxar a nota para baixo ou para cima.
  const usados = Object.entries(PESOS).filter(
    ([k]) => !(k === 'margem_logo' && !logoVerificada),
  ) as [keyof typeof PESOS, number][];
  const somaPesos = usados.reduce((s, [, p]) => s + p, 0);
  const notaFinal =
    usados.reduce((s, [k, p]) => s + criterios[k].nota * p, 0) / (somaPesos || 1);

  const problemas = [...(parcial.problemas ?? [])];
  let veredito: Fidelidade['veredito'] = notaFinal >= 7 ? 'aprovado' : notaFinal >= 5 ? 'ajustar' : 'reprovado';

  // Vetos, cada um com a sua razão dita por extenso.
  if (medicao.erro_costura_px > TETO_COSTURA_PX || medicao.sem_rapport) {
    veredito = 'reprovado';
    problemas.unshift(`critério 2 (rapport): ${rapport.observacao}`);
  }
  if (medicao.ampliacao_maxima > AMPLIACAO_REPROVA) {
    veredito = 'reprovado';
    problemas.unshift(`critério 4 (resolução): ${resolucao.observacao}`);
  }
  if (medicao.invade_logo?.invade) {
    veredito = 'reprovado';
    problemas.unshift(`critério 5 (margem da logo): ${margemLogo.observacao}`);
  }
  if (!logoVerificada) {
    problemas.push(`critério 5 não pôde ser verificado: ${margemLogo.observacao}`);
  }
  if (criterios.semelhanca_composicao.nota < 5) {
    // Não é veto duro: é julgamento, e julgamento com nota baixa merece humano,
    // não descarte automático.
    problemas.unshift(
      `critério 1 (semelhança): ${criterios.semelhanca_composicao.observacao || 'nota baixa'}`,
    );
  }

  return {
    criterios,
    nota_final: Math.round(notaFinal * 10) / 10,
    veredito,
    problemas: problemas.slice(0, 14),
    ajuste_sugerido: parcial.ajuste_sugerido ?? null,
    medicao,
    confianca: parcial.confianca ?? 0,
  };
}

/**
 * Se o A11 cair, o item NÃO é aprovado.
 *
 * Mesma lógica do A7: o juiz final indisponível significa "ninguém conferiu",
 * que é exatamente o caso em que a decisão tem de ser humana. As notas medidas
 * continuam valendo, porque não dependiam do modelo.
 */
export function julgamentoPorFalha(medicao: MedicaoFidelidade, motivo: string): Fidelidade {
  return consolidar(
    {
      criterios: {
        semelhanca_composicao: {
          nota: 0,
          fonte: 'julgado',
          observacao: `não julgado: ${motivo}`,
        },
        coerencia_recorte: { nota: 0, fonte: 'julgado', observacao: `não julgado: ${motivo}` },
        rapport: { nota: 0, fonte: 'medido', observacao: '' },
        resolucao: { nota: 0, fonte: 'medido', observacao: '' },
        margem_logo: { nota: 0, fonte: 'medido', observacao: '' },
      },
      problemas: [`o juiz de fidelidade não respondeu (${motivo}) — revise à mão`],
      ajuste_sugerido: null,
      confianca: 0,
    },
    medicao,
  );
}

export async function julgar(
  env: Env,
  imagens: { originalUrl: string; ladrilhoUrl: string },
  medicao: MedicaoFidelidade,
  leitura: LeituraEstampa | null,
  itemId: number | null = null,
): Promise<Fidelidade> {
  const rapport = notaRapport(medicao.erro_costura_px, medicao.sem_rapport);
  const resolucao = notaResolucao(
    medicao.ampliacao_maxima,
    medicao.ampliacao_pior_camada,
    medicao.arte_nativa,
  );
  const { nota: margemLogo } = notaMargemLogo(medicao);

  const medido =
    `Critérios JÁ MEDIDOS em código — copie estas notas:\n` +
    `- rapport: nota ${rapport.nota} (${rapport.observacao})\n` +
    `- resolucao: nota ${resolucao.nota} (${resolucao.observacao})\n` +
    `- margem_logo: nota ${margemLogo.nota} (${margemLogo.observacao})\n\n` +
    `Contexto da composição: ${medicao.camadas} recorte(s), ` +
    `${medicao.colocacoes} colocação(ões) na máscara.`;

  const contexto = leitura
    ? `\n\nLeitura que o A2 fez da capinha (use para conferir se a hierarquia se manteve):\n${resumoLeitura(leitura)}`
    : '';

  let parcial: Partial<Fidelidade>;
  try {
    parcial = await chamarAgente<Fidelidade>(
      env,
      'A11_fidelidade',
      [
        sistema(PAPEL, SCHEMA),
        comImagens(
          [
            { url: imagens.originalUrl, rotulo: 'IMAGEM 1 — arte original da capinha:' },
            { url: imagens.ladrilhoUrl, rotulo: 'IMAGEM 2 — arte adaptada, ladrilhada 3x:' },
          ],
          `${medido}${contexto}\n\nJulgue os critérios 1 e 3 e devolva o JSON.`,
        ),
      ],
      {
        temperature: 0.2,
        maxTokens: 2500,
        itemId,
        // O validador devolve o parcial; a consolidação com as medições é
        // feita fora, para o veto não depender de o modelo ter cooperado.
        valida: (b) => validaFidelidade(b) as Fidelidade | null,
        tentativas: 2,
      },
    );
  } catch (e) {
    return julgamentoPorFalha(medicao, (e as Error)?.message || 'erro desconhecido');
  }

  return consolidar(parcial, medicao);
}
