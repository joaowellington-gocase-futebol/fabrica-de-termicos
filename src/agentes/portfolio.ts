/**
 * A1 — Analista de Portfólio. Trilha T2.
 *
 * O SQL do Curador traz números; este agente traz o julgamento que a query não
 * tem: que estampa de Natal não entra em setembro, que tema religioso
 * transfere melhor para térmico que oncinha, que time fora de temporada pode
 * esperar.
 *
 * Ele NÃO filtra a fila — ordena. O que sai da fila é decisão do Curador
 * (determinística e auditável) e do A7 (compliance). Um agente de priorização
 * que também pudesse descartar candidata tornaria irreprodutível a pergunta
 * "por que esta estampa não entrou".
 */

import { arr, chamarAgente, conf, num, obj, str, umDe } from '../core/aiproxy';
import type { Candidata, Env, ItemRanking, RankingPortfolio } from '../core/tipos';
import { sistema } from './comum';

const PAPEL = `Você é o ANALISTA DE PORTFÓLIO. Recebe as estampas que mais
venderam em capinha nos últimos 90 dias e que ainda NÃO têm versão em garrafa
térmica. Sua tarefa é dizer em que ORDEM adaptá-las.

Volume de venda em capinha é o ponto de partida, não a resposta. Pese também:

- SAZONALIDADE. Compare com a data de hoje. Estampa de data comemorativa só
  vale se a data ainda está por vir com folga de produção (algumas semanas).
  Passada a data, empurre para a janela do ano seguinte.
- TRANSFERÊNCIA DE CONTEXTO. Capinha é objeto pessoal, visto de perto; garrafa
  térmica é objeto de trabalho, academia e faculdade, visto por outras pessoas.
  Arte que funciona como identidade pública (floral, natureza, religioso,
  geométrico, minimalista) transfere bem. Arte de nicho fechado, piada interna
  ou frase pessoal transfere pior.
- ADEQUAÇÃO A PADRÃO REPETIDO. A arte vai dar a volta no cilindro. Motivo que se
  repete bem tem vantagem; composição única centralizada tem desvantagem.
- RISCO DE LICENÇA. Licença declarada = risco de o uso em padrão não ser
  permitido. Sinalize em "risco", não descarte.
- SATURAÇÃO. Muitas estampas do mesmo tema no topo da lista: diga isso, e
  espalhe os temas em vez de empilhar cinco florais nas cinco primeiras posições.

janela_ideal: "imediata", "30d", ou "sazonal:<mes>" (ex. "sazonal:novembro").

risco: "nenhum" | "licenca" | "sazonalidade" | "saturacao".

score de 0 a 1: sua convicção de que vale adaptar agora.

"descartadas" é para candidata que você considera desperdício de esteira, com o
motivo. Isso é RECOMENDAÇÃO — quem decide a exclusão é humano.

Inclua TODAS as candidatas recebidas, no ranking ou em descartadas. Não invente
estampa que não está na lista, e use exatamente as estampa_key informadas.`;

const SCHEMA = `{
  "ranking": [ { "estampa_key": "string", "posicao": number, "score": number,
                 "racional": "uma frase", "janela_ideal": "string",
                 "risco": "nenhum"|"licenca"|"sazonalidade"|"saturacao" } ],
  "descartadas": [ { "estampa_key": "string", "motivo": "uma frase" } ],
  "confianca": number
}`;

const RISCOS = ['nenhum', 'licenca', 'sazonalidade', 'saturacao'] as const;

/**
 * Valida contra as chaves que realmente foram enviadas.
 *
 * Sem esse cerco o modelo alucina uma `estampa_key` plausível e a esteira tenta
 * resolver arte de uma estampa que não existe — falha três estágios adiante,
 * longe da causa.
 */
export function fazValidador(chavesEnviadas: string[]) {
  const validas = new Set(chavesEnviadas);

  return function validaRanking(bruto: unknown): RankingPortfolio | null {
    const o = obj(bruto);
    if (!o) return null;
    const cru = arr(o.ranking);
    if (!cru.length) return null;

    const vistas = new Set<string>();
    const ranking: ItemRanking[] = [];
    for (const r of cru) {
      const ro = obj(r);
      if (!ro) continue;
      const key = str(ro.estampa_key).trim();
      if (!validas.has(key) || vistas.has(key)) continue;
      vistas.add(key);
      ranking.push({
        estampa_key: key,
        posicao: Math.max(1, Math.round(num(ro.posicao, ranking.length + 1))),
        score: Math.min(1, Math.max(0, num(ro.score, 0.5))),
        racional: str(ro.racional, '').slice(0, 300),
        janela_ideal: str(ro.janela_ideal, 'imediata').slice(0, 40),
        risco: umDe(ro.risco, RISCOS, 'nenhum'),
      });
    }
    if (!ranking.length) return null;

    ranking.sort((a, b) => a.posicao - b.posicao || b.score - a.score);
    ranking.forEach((r, i) => (r.posicao = i + 1));

    const descartadas = arr(o.descartadas)
      .map((d) => {
        const dobj = obj(d);
        if (!dobj) return null;
        const key = str(dobj.estampa_key).trim();
        if (!validas.has(key)) return null;
        return { estampa_key: key, motivo: str(dobj.motivo, '').slice(0, 240) };
      })
      .filter((d): d is { estampa_key: string; motivo: string } => d !== null);

    return { ranking, descartadas, confianca: conf(o.confianca) };
  };
}

export async function priorizar(
  env: Env,
  candidatas: Candidata[],
  itemId: number | null = null,
): Promise<RankingPortfolio> {
  const hoje = new Date().toISOString().slice(0, 10);
  const tabela = candidatas
    .map(
      (c) =>
        `${c.estampa_key} | ${c.nome} | tema: ${c.tema || '-'} | licença: ${c.licenca || '-'} | ` +
        `${Math.round(c.unidades)} un | R$ ${Math.round(c.receita)}`,
    )
    .join('\n');

  return chamarAgente<RankingPortfolio>(
    env,
    'A1_portfolio',
    [
      sistema(PAPEL, SCHEMA),
      {
        role: 'user',
        content:
          `Data de hoje: ${hoje}\n\n` +
          `Candidatas (best-sellers de capinha em 90 dias, SEM versão térmica):\n` +
          `estampa_key | nome | tema | licença | unidades | receita\n${tabela}\n\n` +
          `Ordene e devolva o JSON.`,
      },
    ],
    {
      temperature: 0.2,
      maxTokens: 4000,
      itemId,
      valida: fazValidador(candidatas.map((c) => c.estampa_key)),
      tentativas: 2,
    },
  );
}
