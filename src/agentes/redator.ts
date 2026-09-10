/**
 * A9 — Redator de Catálogo. Trilha T6.
 *
 * Único agente com temperatura 0.7: é o único cuja tarefa é criar texto, e não
 * classificar. Todos os outros decidem, e em decisão variância é defeito.
 */

import { chamarAgente, conf, listaStr, obj, str } from '../core/aiproxy';
import type { CopyCatalogo, Env } from '../core/tipos';
import { sistema } from './comum';

const PAPEL = `Você é o REDATOR DE CATÁLOGO da Gocase. Escreve o texto de venda de
uma garrafa térmica estampada.

nome: o nome do produto na loja. Use o nome comercial que já foi definido, sem
reescrever.

descricao: 2 a 3 frases. Fale da ARTE e de onde ela cabe na vida de quem compra
(trabalho, academia, faculdade, carro). Não prometa especificação técnica que
você não recebeu — nada de horas de temperatura, material ou capacidade, porque
isso vem do cadastro do produto e não da estampa. Sem superlativo vazio
("incrível", "perfeita"), sem emoji, sem exclamação.

alt_text: uma frase que descreve a imagem para quem não pode vê-la. Descreve o
que está desenhado, objetivamente, começando pelo produto.

tags: 5 a 10 termos de busca em minúsculas, um a dois palavras cada. Inclua o
tema, os elementos da arte e o estilo. Não repita "garrafa" nem "térmica" — o
catálogo já indexa isso.

Português do Brasil.`;

const SCHEMA = `{
  "nome": "string",
  "descricao": "string",
  "alt_text": "string",
  "tags": ["string"],
  "confianca": number
}`;

export function validaCopy(bruto: unknown): CopyCatalogo | null {
  const o = obj(bruto);
  if (!o) return null;
  const descricao = str(o.descricao).trim();
  const nome = str(o.nome).trim();
  if (!descricao || !nome) return null;

  const tags = listaStr(o.tags, 12)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1);

  return {
    nome: nome.slice(0, 120),
    descricao: descricao.slice(0, 800),
    alt_text: str(o.alt_text, nome).trim().slice(0, 300),
    tags: [...new Set(tags)],
    confianca: conf(o.confianca),
  };
}

export async function redigir(
  env: Env,
  contexto: {
    nome_comercial: string;
    tema: string | null;
    estilo: string;
    motivos: string[];
    paleta: string[];
    cores_corpo: string[];
  },
  itemId: number | null = null,
): Promise<CopyCatalogo> {
  return chamarAgente<CopyCatalogo>(
    env,
    'A9_redator',
    [
      sistema(PAPEL, SCHEMA),
      {
        role: 'user',
        content:
          `Nome comercial definido: ${contexto.nome_comercial}\n` +
          (contexto.tema ? `Tema: ${contexto.tema}\n` : '') +
          `Estilo visual: ${contexto.estilo}\n` +
          (contexto.motivos.length ? `Elementos da arte: ${contexto.motivos.join(', ')}\n` : '') +
          (contexto.paleta.length ? `Paleta: ${contexto.paleta.join(', ')}\n` : '') +
          (contexto.cores_corpo.length
            ? `Sai nos corpos: ${contexto.cores_corpo.join(', ')}\n`
            : '') +
          `\nEscreva o texto de catálogo em JSON.`,
      },
    ],
    { temperature: 0.7, maxTokens: 1200, itemId, valida: validaCopy, tentativas: 2 },
  );
}
