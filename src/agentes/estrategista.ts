/**
 * A3 — Estrategista de Composição. Trilha T3.
 *
 * Recebe a leitura do A2 e a máscara alvo e escreve o PLANO de composição.
 * Antes isso era uma regra fixa densidade->estilo; virar agente é o que permite
 * tratar cada arte pelo que ela é.
 *
 * O plano é dado de entrada para geometria determinística — o agente escolhe
 * PARÂMETRO, nunca desenha. `escala_motivos` e `densidade_alvo` vêm com faixa
 * fechada porque valor fora de faixa não é opinião discutível: é composição
 * quebrada.
 */

import { chamarAgente, conf, listaStr, num, obj, str, umDe, bool } from '../core/aiproxy';
import type {
  Env,
  EstiloComposicao,
  LeituraEstampa,
  Mascara,
  PlanoComposicao,
  ZonaLogo,
} from '../core/tipos';
import { resumoLeitura, sistema } from './comum';

const PAPEL = `Você é o ESTRATEGISTA DE COMPOSIÇÃO, um diretor de arte. Recebe a
leitura de uma estampa e a máscara da garrafa, e decide COMO distribuir os
motivos no retângulo desenrolado. Você não desenha: escolhe parâmetros que um
motor determinístico executa.

Os quatro estilos disponíveis, e quando cada um é o certo:
- "stickers"    → motivos variados, tamanhos diferentes, podem se sobrepor.
                  Bom para densidade média e motivos de peso parecido.
- "linear"      → grade regular, sem sobreposição, tudo alinhado. Bom para
                  densidade alta e motivo pequeno e repetitivo (oncinha, poá).
- "distribuido" → mesma grade, mas em xadrez (stagger). Bom para densidade
                  baixa, quando a grade regular deixaria faixas vazias óbvias.
- "localizada"  → só o motivo principal, centralizado, grande. Bom para
                  composição central que não sobrevive a ser repetida.

Faixas: escala_motivos entre 0.5 e 2.0; densidade_alvo entre 0.15 e 0.75;
margem_seguranca_pct entre 0 e 12.

rotacao_permitida: false quando o motivo tem orientação de leitura óbvia (uma
flor com haste, um animal), true para elemento ornamental sem topo definido.

Lembre que a arte é vista a distância e dá a volta no cilindro: prefira motivo
maior a motivo pequeno demais, e evite densidade_alvo alta com escala grande ao
mesmo tempo — vira massa sem respiro.

## PRESERVAR A HIERARQUIA DA CAPINHA

A leitura traz "hierarquia" e "arranjo". Respeita-los e o criterio numero 1 pelo
qual esta composicao vai ser julgada depois: ela precisa PARECER a mesma arte da
capinha, nao um padrao genarico feito com as mesmas pecas.

Use este mapa como ponto de partida, e so saia dele com motivo no racional:
- "uniforme"            -> "linear" (grade regular), ou "distribuido" se a
                          densidade for baixa. NAO use "stickers": variar
                          tamanho destroi justamente o que define esta arte.
- "um_dominante"        -> "stickers", que aceita tamanhos diferentes.
- "heroi_com_satelites" -> "localizada" quando o heroi e o assunto e nao
                          sobrevive repetido; "stickers" quando da para repetir
                          o conjunto heroi+satelites como unidade.
- "escalonada"          -> "stickers".

E o arranjo:
- "grade"        -> "linear"
- "espalhado"    -> "distribuido" ou "stickers"
- "agrupado"     -> "stickers"
- "centralizado" -> "localizada"
- "moldura"      -> "distribuido"

"rotacao_permitida" deve ser false sempre que a leitura disser "orientacao sim":
girar uma flor com haste ou um animal deixa a arte de cabeca para baixo dando a
volta na garrafa.

## ZONA DA LOGO

Quando a mascara informar uma zona proibida da logo Gocase, a composicao nao
pode ter motivo importante ali. Aumente "margem_seguranca_pct" e escolha um
estilo que deixe respiro naquela regiao; se a zona for central e o estilo pedido
for "localizada", diga isso no racional.`;

const SCHEMA = `{
  "estilo": "stickers" | "linear" | "distribuido" | "localizada",
  "escala_motivos": number,
  "densidade_alvo": number,
  "motivos_promover": ["nome do motivo que deve aparecer mais"],
  "motivos_descartar": ["nome do motivo que não deve entrar"],
  "rotacao_permitida": boolean,
  "margem_seguranca_pct": number,
  "racional": "uma ou duas frases explicando a escolha",
  "confianca": number
}`;

const ESTILOS = ['stickers', 'linear', 'distribuido', 'localizada'] as const;

/** Regra fixa de partida, e o fallback quando o agente cai. */
export function estiloPorDensidade(densidade: string): EstiloComposicao {
  if (densidade === 'baixa') return 'distribuido';
  if (densidade === 'alta') return 'linear';
  return 'stickers';
}

/**
 * Estilo que preserva a hierarquia lida. E o fallback quando o A3 cai, e e
 * tambem o mapa que o prompt do A3 recebe — os dois concordando de proposito.
 */
export function estiloPorHierarquia(leitura: LeituraEstampa): EstiloComposicao {
  const { hierarquia, arranjo } = leitura.composicao;
  if (arranjo === 'centralizado' || leitura.tipo === 'composicao_central') return 'localizada';
  switch (hierarquia) {
    case 'uniforme':
      // Nunca stickers aqui: variar tamanho destroi o que define a arte.
      return leitura.densidade === 'baixa' ? 'distribuido' : 'linear';
    case 'heroi_com_satelites':
      return 'localizada';
    case 'um_dominante':
    case 'escalonada':
      return 'stickers';
    default:
      return estiloPorDensidade(leitura.densidade);
  }
}

export function planoPadrao(leitura: LeituraEstampa): PlanoComposicao {
  return {
    estilo: estiloPorHierarquia(leitura),
    escala_motivos: 1,
    densidade_alvo: leitura.densidade === 'alta' ? 0.55 : leitura.densidade === 'baixa' ? 0.28 : 0.42,
    motivos_promover: leitura.motivos.filter((m) => m.papel === 'principal').map((m) => m.nome),
    motivos_descartar: [],
    // Orientacao de leitura proibe rotacao: girar flor com haste deixa a arte
    // de cabeca para baixo dando a volta na garrafa.
    rotacao_permitida: !leitura.composicao.tem_orientacao,
    margem_seguranca_pct: 4,
    racional: `plano padrao pela hierarquia ${leitura.composicao.hierarquia} (A3 indisponivel)`,
    confianca: 0.5,
  };
}


function faixa(v: unknown, min: number, max: number, padrao: number): number {
  const n = num(v, padrao);
  return Math.min(max, Math.max(min, n));
}

export function validaPlano(bruto: unknown): PlanoComposicao | null {
  const o = obj(bruto);
  if (!o) return null;
  if (!(ESTILOS as readonly string[]).includes(str(o.estilo))) return null;

  return {
    estilo: umDe(o.estilo, ESTILOS, 'stickers'),
    escala_motivos: faixa(o.escala_motivos, 0.5, 2.0, 1),
    densidade_alvo: faixa(o.densidade_alvo, 0.15, 0.75, 0.42),
    motivos_promover: listaStr(o.motivos_promover, 12),
    motivos_descartar: listaStr(o.motivos_descartar, 12),
    rotacao_permitida: bool(o.rotacao_permitida, false),
    margem_seguranca_pct: faixa(o.margem_seguranca_pct, 0, 12, 4),
    racional: str(o.racional, '').slice(0, 400),
    confianca: conf(o.confianca),
  };
}

export async function planejar(
  env: Env,
  leitura: LeituraEstampa,
  mascara: Mascara,
  itemId: number | null = null,
  ajuste: { estilo?: EstiloComposicao; escala?: number } | null = null,
  zona: ZonaLogo | null = null,
): Promise<PlanoComposicao> {
  const razao = (mascara.w / mascara.h).toFixed(2);
  const logo = zona?.disponivel
    ? `\n\nZona proibida da logo Gocase: retangulo de ${zona.w}x${zona.h} px em ` +
      `(${zona.x}, ${zona.y}). Nenhum motivo importante pode cair ali.`
    : zona
      ? `\n\nZona da logo: nao cadastrada para esta mascara (${zona.motivo}). ` +
        `Nao ha restricao a aplicar.`
      : '';
  const correcao = ajuste
    ? `\n\nATENÇÃO — esta é uma segunda tentativa. O auditor reprovou a composição
anterior e sugeriu: ${JSON.stringify(ajuste)}. Leve a sugestão a sério e explique
no racional o que mudou em relação à tentativa anterior.`
    : '';

  return chamarAgente<PlanoComposicao>(
    env,
    'A3_estrategista',
    [
      sistema(PAPEL, SCHEMA),
      {
        role: 'user',
        content:
          `Leitura da estampa (saída do A2):\n${resumoLeitura(leitura)}\n\n` +
          `Máscara alvo: ${mascara.produto} ${mascara.volumetria}, ` +
          `${mascara.w}x${mascara.h} px (razão ${razao}:1).${logo}${correcao}\n\n` +
          `Devolva o plano em JSON.`,
      },
    ],
    { temperature: 0.3, maxTokens: 1200, itemId, valida: validaPlano, tentativas: 2 },
  );
}
