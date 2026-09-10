/**
 * Peças compartilhadas pelos prompts dos agentes.
 *
 * Os prompts moram no código, não num banco: prompt é lógica de produto e
 * precisa ir junto no PR, com diff revisável e eval rodando contra a mudança.
 */

import type { Conteudo, Mensagem } from '../core/aiproxy';
import type { LeituraEstampa } from '../core/tipos';

/**
 * Preâmbulo comum. Repetido em todo agente de propósito: o modelo responde
 * melhor sabendo o produto físico de que se trata do que recebendo só o schema.
 */
export const CONTEXTO = `Você trabalha na esteira de adaptação de estampas da Gocase.
Uma estampa que vende bem em CAPINHA DE CELULAR (arte pequena, retrato, vista de
perto, sem repetição) precisa virar arte de GARRAFA TÉRMICA: um retângulo largo,
impresso desenrolado, que dá a volta no corpo cilíndrico — então a borda
esquerda encosta na borda direita e a arte é vista a distância, em movimento.

Duas consequências que orientam todo julgamento seu:
- o que atravessa a borda reaparece do outro lado, portanto texto e logo NÃO
  podem entrar em padrão repetido: repetiriam a marca em volta da garrafa;
- a arte é vista de longe: motivo pequeno demais vira sujeira visual.

Responda SEMPRE com um único objeto JSON válido, sem texto fora dele, sem
comentários e sem cercas de código.`;

/** Monta a mensagem de sistema de um agente. */
export function sistema(papel: string, schema: string): Mensagem {
  return {
    role: 'system',
    content: `${CONTEXTO}\n\n## Seu papel\n${papel}\n\n## Formato exato da resposta\n${schema}`,
  };
}

/** Mensagem de usuário com uma imagem e um texto. */
export function comImagem(url: string, texto: string, detail: 'low' | 'high' = 'high'): Mensagem {
  const conteudo: Conteudo[] = [
    { type: 'image_url', image_url: { url, detail } },
    { type: 'text', text: texto },
  ];
  return { role: 'user', content: conteudo };
}

/** Mensagem de usuário com várias imagens rotuladas e um texto. */
export function comImagens(
  imagens: { url: string; rotulo: string }[],
  texto: string,
  detail: 'low' | 'high' = 'high',
): Mensagem {
  const conteudo: Conteudo[] = [];
  for (const img of imagens) {
    conteudo.push({ type: 'text', text: img.rotulo });
    conteudo.push({ type: 'image_url', image_url: { url: img.url, detail } });
  }
  conteudo.push({ type: 'text', text: texto });
  return { role: 'user', content: conteudo };
}

/**
 * Resumo da leitura do A2 em texto, para alimentar os agentes seguintes sem
 * reenviar o JSON inteiro (que gasta token e distrai o modelo com campos que
 * não interessam àquela decisão).
 */
export function resumoLeitura(l: LeituraEstampa): string {
  const motivos = l.motivos
    .map(
      (m) =>
        `${m.nome} (${m.papel}, ~${m.contagem_aprox}x, tamanho relativo ${m.tamanho_relativo.toFixed(2)})`,
    )
    .join('; ');
  const c = l.composicao;
  return [
    `tipo: ${l.tipo}`,
    `separável: ${l.separavel ? 'sim' : 'não'}`,
    `fundo: ${l.fundo.tipo}${l.fundo.cor ? ' ' + l.fundo.cor : ''}`,
    `densidade: ${l.densidade}`,
    `estilo: ${l.estilo}`,
    `paleta: ${l.paleta.join(', ')}`,
    `motivos: ${motivos || 'nenhum isolado'}`,
    // A hierarquia vem em bloco proprio porque e o que os agentes seguintes
    // tem de PRESERVAR — achatar isso e a forma mais comum de a garrafa virar
    // outra arte.
    `composicao: hierarquia ${c.hierarquia}, arranjo ${c.arranjo}, ` +
      `maior/menor ${c.proporcao_maior_menor.toFixed(1)}x, ` +
      `orientacao ${c.tem_orientacao ? 'sim' : 'nao'}` +
      (c.elemento_principal ? `, elemento principal: ${c.elemento_principal}` : ''),
    `tem_texto: ${l.tem_texto} · tem_logo: ${l.tem_logo}`,
  ].join('\n');
}
