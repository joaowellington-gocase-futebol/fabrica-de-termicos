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
import type { Env, EstiloComposicao, LeituraEstampa, Mascara, PlanoComposicao } from '../core/tipos';
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
mesmo tempo — vira massa sem respiro.`;

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

export function planoPadrao(leitura: LeituraEstampa): PlanoComposicao {
  const central = leitura.tipo === 'composicao_central';
  return {
    estilo: central ? 'localizada' : estiloPorDensidade(leitura.densidade),
    escala_motivos: 1,
    densidade_alvo: leitura.densidade === 'alta' ? 0.55 : leitura.densidade === 'baixa' ? 0.28 : 0.42,
    motivos_promover: leitura.motivos.filter((m) => m.papel === 'principal').map((m) => m.nome),
    motivos_descartar: [],
    rotacao_permitida: false,
    margem_seguranca_pct: 4,
    racional: 'plano padrão pela densidade medida (A3 indisponível)',
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
): Promise<PlanoComposicao> {
  const razao = (mascara.w / mascara.h).toFixed(2);
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
          `${mascara.w}x${mascara.h} px (razão ${razao}:1).${correcao}\n\n` +
          `Devolva o plano em JSON.`,
      },
    ],
    { temperature: 0.3, maxTokens: 1200, itemId, valida: validaPlano, tentativas: 2 },
  );
}
