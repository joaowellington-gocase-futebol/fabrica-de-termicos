/**
 * A8 — Nomeador. Trilha T6.
 *
 * Divisão importante aqui: `engine_identifier` NÃO é gerado por IA.
 *
 * A convenção do catálogo já foi verificada e é limpa — `<estampa>-case` vira
 * `<estampa>-termicos`. Isso é uma transformação de string com resposta exata;
 * pedir a um modelo é trocar certeza por variância e arriscar cadastrar um
 * identificador que o motor não acha. O agente cuida só do que é julgamento:
 * o nome comercial e o SKU.
 *
 * A tabela de prefixo por licenciado vive no app `nomeador-estampas`, numa
 * planilha. Enquanto não houver acesso programático a ela, PREFIXOS abaixo é a
 * cópia local e declaradamente incompleta — e `prefixo_licenciado` volta null
 * para licença desconhecida, em vez de o agente inventar um prefixo.
 */

import { chamarAgente, conf, obj, str } from '../core/aiproxy';
import { SUFIXO_TERMICO } from '../core/dados';
import type { Env, Nomeacao } from '../core/tipos';
import { sistema } from './comum';

/**
 * Prefixo de SKU por licenciado. INCOMPLETA de propósito: só entra aqui o que
 * foi conferido. Licença fora da tabela devolve null e cai para revisão humana
 * no cadastro — que é melhor que um SKU plausível e errado.
 */
const PREFIXOS: Record<string, string> = {};

export function prefixoDe(licenca: string | null): string | null {
  if (!licenca) return null;
  return PREFIXOS[licenca.trim().toLowerCase()] ?? null;
}

/**
 * A parte determinística. `<estampa>-case` -> `<estampa>-termicos`, e
 * `<estampa>` puro também vira `<estampa>-termicos`.
 */
export function identificadorTermico(estampaKey: string): string {
  const base = estampaKey.replace(/-case$/, '').replace(new RegExp(`${SUFIXO_TERMICO}$`), '');
  return `${base}${SUFIXO_TERMICO}`;
}

const PAPEL = `Você é o NOMEADOR. Recebe uma estampa que já vende bem em capinha
e que agora vai sair em garrafa térmica. Devolve o nome comercial e o SKU.

nome_comercial: o nome que aparece na loja. Curto (2 a 4 palavras), em
português, sem o nome do produto ("Garrafa", "Térmica") e sem volumetria — o
site já mostra isso. Descreve a ARTE, não o objeto. Se a estampa já tem um nome
bom no catálogo, mantenha-o: reconhecimento vale mais que criatividade aqui.

sku: código curto em MAIÚSCULAS, sem espaço nem acento, palavras separadas por
hífen, no máximo 24 caracteres. Derive da arte. Se houver um prefixo de
licenciado informado, comece o SKU por ele.

Não invente informação sobre a licença. Se nenhum prefixo foi informado, não
crie um.`;

const SCHEMA = `{
  "nome_comercial": "string",
  "sku": "STRING-EM-MAIUSCULAS",
  "confianca": number
}`;

export function fazValidador(estampaKey: string, licenca: string | null) {
  const prefixo = prefixoDe(licenca);

  return function validaNomeacao(bruto: unknown): Nomeacao | null {
    const o = obj(bruto);
    if (!o) return null;
    const nome = str(o.nome_comercial).trim();
    if (!nome) return null;

    let sku = str(o.sku)
      .toUpperCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24);
    if (!sku) return null;
    if (prefixo && !sku.startsWith(prefixo)) sku = `${prefixo}-${sku}`.slice(0, 24);

    return {
      nome_comercial: nome.slice(0, 80),
      sku,
      // Determinístico: nunca vem do modelo.
      engine_identifier: identificadorTermico(estampaKey),
      prefixo_licenciado: prefixo,
      confianca: conf(o.confianca),
    };
  };
}

export async function nomear(
  env: Env,
  contexto: { estampa_key: string; nome: string; tema: string | null; licenca: string | null; estilo: string },
  itemId: number | null = null,
): Promise<Nomeacao> {
  const prefixo = prefixoDe(contexto.licenca);

  return chamarAgente<Nomeacao>(
    env,
    'A8_nomeador',
    [
      sistema(PAPEL, SCHEMA),
      {
        role: 'user',
        content:
          `Estampa: ${contexto.estampa_key}\n` +
          `Nome atual no catálogo: ${contexto.nome}\n` +
          (contexto.tema ? `Tema: ${contexto.tema}\n` : '') +
          (contexto.licenca ? `Licença: ${contexto.licenca}\n` : 'Sem licença.\n') +
          (prefixo ? `Prefixo de SKU do licenciado: ${prefixo}\n` : 'Nenhum prefixo de licenciado.\n') +
          `Estilo visual lido pelo A2: ${contexto.estilo}\n\n` +
          `Devolva nome comercial e SKU em JSON.`,
      },
    ],
    {
      temperature: 0.5,
      maxTokens: 600,
      itemId,
      valida: fazValidador(contexto.estampa_key, contexto.licenca),
      tentativas: 2,
    },
  );
}
