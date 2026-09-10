/**
 * A7 — Revisor de Marca. Trilha T4. A TRAVA DURA.
 *
 * Última porta antes do humano, e o único agente com poder de veto absoluto.
 * Existe porque licenciamento é o risco caro deste projeto: uma capinha com
 * logo é um item; uma garrafa com o mesmo logo repetido dando a volta no corpo
 * é uso de marca em padrão, que é outra conversa jurídica.
 *
 * Duas decisões de desenho que não devem ser "otimizadas" depois:
 *
 * 1. `gravidade: alta` bloqueia SEMPRE, sem exceção automática. Não existe
 *    limiar de confiança que libere — só um humano destrava.
 * 2. Se o agente CAIR, o item é bloqueado, não liberado. `bloqueioPorFalha()`
 *    existe para isso. Um agente de compliance que falha aberto não é trava.
 *
 * Temperatura 0.1: é o agente onde variância é prejuízo.
 */

import { arr, chamarAgente, conf, num, obj, str, umDe, bool } from '../core/aiproxy';
import type { Achado, Env, RevisaoMarca } from '../core/tipos';
import { comImagem, sistema } from './comum';

const PAPEL = `Você é o REVISOR DE MARCA, a última verificação antes de esta arte
virar produto. Seu trabalho é achar motivo para NÃO publicar.

Procure, na arte inteira e em cada motivo repetido:
- LOGO: qualquer logotipo, marca registrada, símbolo de empresa, escudo de time.
- TEXTO: qualquer palavra, letra, número, versículo, assinatura ou marca d'água
  legível. Texto em padrão repetido é sempre problema, mesmo texto genérico.
- IP_TERCEIRO: personagem, criatura, veículo ou cenário reconhecível de
  propriedade de terceiro (desenho, filme, série, anime, jogo, quadrinho), ou
  semelhança próxima o suficiente para ser confundida com um.
- MARCA: elemento de identidade visual de terceiro — padrão proprietário
  (monogramas de moda, xadrez registrado), embalagem icônica, mascote.

Gravidade:
- "alta"  → identificável e atribuível a um dono. Marca real, personagem
            reconhecível, texto de marca. BLOQUEIA a esteira.
- "media" → estilo que evoca uma propriedade sem copiá-la, ou texto decorativo
            ilegível. Vai para revisão humana.
- "baixa" → observação, sem risco prático.

"aprovado" é true apenas se NÃO houver nenhum achado de gravidade alta.
"bloqueia" é true se houver qualquer achado de gravidade alta.

Na dúvida, ACUSE com gravidade media. Falso positivo custa uma revisão humana
de dois minutos; falso negativo custa um produto publicado com marca de
terceiro. A assimetria é essa e ela é intencional.

"onde" localiza o achado em português ("canto inferior direito", "no centro de
cada motivo repetido").`;

const SCHEMA = `{
  "aprovado": boolean,
  "achados": [ { "tipo": "logo"|"texto"|"ip_terceiro"|"marca",
                 "onde": "string curta", "gravidade": "alta"|"media"|"baixa" } ],
  "bloqueia": boolean,
  "confianca": number
}

"achados" é [] quando a arte está limpa.`;

const TIPOS = ['logo', 'texto', 'ip_terceiro', 'marca'] as const;
const GRAVIDADES = ['alta', 'media', 'baixa'] as const;

export function validaMarca(bruto: unknown): RevisaoMarca | null {
  const o = obj(bruto);
  if (!o) return null;
  if (typeof o.aprovado !== 'boolean' && !Array.isArray(o.achados)) return null;

  const achados: Achado[] = arr(o.achados)
    .map((a) => {
      const ao = obj(a);
      if (!ao) return null;
      return {
        tipo: umDe(ao.tipo, TIPOS, 'marca'),
        onde: str(ao.onde, 'não localizado').slice(0, 160),
        gravidade: umDe(ao.gravidade, GRAVIDADES, 'media'),
      } as Achado;
    })
    .filter((a): a is Achado => a !== null)
    .slice(0, 20);

  // A trava não é opinião do modelo: é derivada dos achados. Se ele listar um
  // achado de gravidade alta e ainda assim marcar aprovado, vale o achado.
  const temAlta = achados.some((a) => a.gravidade === 'alta');

  return {
    aprovado: !temAlta && bool(o.aprovado, achados.length === 0),
    achados,
    bloqueia: temAlta,
    confianca: conf(o.confianca),
  };
}

/**
 * O que vale quando o A7 não responde.
 *
 * Bloqueia. Um agente de compliance indisponível não pode significar "pode
 * publicar" — significa "ninguém verificou", que é exatamente o caso em que a
 * decisão tem de ser humana.
 */
export function bloqueioPorFalha(motivo: string): RevisaoMarca {
  return {
    aprovado: false,
    achados: [
      {
        tipo: 'marca',
        onde: `revisão de marca não pôde ser feita: ${motivo}`.slice(0, 160),
        gravidade: 'alta',
      },
    ],
    bloqueia: true,
    confianca: 0,
  };
}

export async function revisarMarca(
  env: Env,
  composicaoUrl: string,
  contexto: { nome: string; licenca: string | null },
  itemId: number | null = null,
): Promise<RevisaoMarca> {
  const pistas = [
    `Nome da estampa: ${contexto.nome}`,
    contexto.licenca
      ? `Licença declarada no catálogo: ${contexto.licenca} — atenção redobrada: ` +
        `arte licenciada tem regra de uso própria e repetição em padrão costuma não ser permitida.`
      : 'Sem licença declarada no catálogo.',
  ].join('\n');

  return chamarAgente<RevisaoMarca>(
    env,
    'A7_revisor',
    [
      sistema(PAPEL, SCHEMA),
      comImagem(
        composicaoUrl,
        `${pistas}\n\nEsta é a arte composta que iria para a garrafa. Revise e devolva o JSON.`,
      ),
    ],
    { temperature: 0.1, maxTokens: 1500, itemId, valida: validaMarca, tentativas: 2 },
  );
}
