/**
 * A2 — Leitor de Estampa. Trilha T3.
 *
 * O agente de maior alavancagem da esteira: é a saída dele que decide a rota de
 * todo o resto. Se ele erra `separavel`, o pipeline inteiro trabalha no caminho
 * errado; se ele deixa passar `tem_logo`, a marca de um licenciado dá a volta
 * numa garrafa e o problema deixa de ser técnico.
 *
 * Por isso duas assimetrias de propósito no prompt:
 *  - em texto/logo, na dúvida ACUSA. Falso positivo custa uma revisão humana;
 *    falso negativo custa um produto publicado errado.
 *  - `separavel` só é `true` com motivos de contorno fechado sobre fundo
 *    chapado. Aquarela corrida não é separável, e insistir gera 40 fragmentos.
 */

import { arr, chamarAgente, conf, listaStr, num, obj, str, umDe } from '../core/aiproxy';
import type { Env, LeituraEstampa, Motivo } from '../core/tipos';
import { comImagem, sistema } from './comum';

const PAPEL = `Você é o LEITOR. Olha a estampa de capinha e devolve uma leitura
estruturada que vai ROTEAR a esteira. Você não opina sobre estética: você
classifica o que a arte é, mecanicamente.

Como decidir "separavel" — a pergunta é se dá para recortar motivos inteiros:
- true  → motivos com contorno definido, destacados, sobre fundo chapado ou
          transparente (ramos, flores soltas, ícones, animais isolados).
- false → arte de fundo contínuo onde não há o que recortar: aquarela corrida,
          tie-dye, degradê, textura, mancha que ocupa tudo, ou composição única
          centralizada que só faz sentido inteira.
Na dúvida entre os dois, responda false: tentar separar arte contínua produz
dezenas de fragmentos inúteis, e a rota generativa existe justamente para ela.

Como decidir "densidade" — quanto da área da arte está coberta por motivo:
baixa (< 25%), media (25-55%), alta (> 55%).

tem_texto: QUALQUER palavra, letra, número ou versículo legível. Marca d'água
conta. Assinatura de ilustrador conta.
tem_logo: qualquer marca, logotipo, escudo de time, personagem licenciado
reconhecível ou símbolo de propriedade de terceiro.
Nestes dois campos, na dúvida responda true.

rota_recomendada: "deterministica" quando separavel é true; "generativa" quando
é false.

confianca: 0 a 1. Seja honesto — abaixo de 0.6 o item vai para revisão humana,
o que é o resultado correto quando a arte é ambígua.`;

const SCHEMA = `{
  "tipo": "motivos_isolados" | "fundo_continuo" | "misto" | "composicao_central",
  "separavel": boolean,
  "fundo": { "tipo": "solido" | "textura" | "transparente", "cor": "#RRGGBB" },
  "motivos": [ { "nome": "string curta em português", "contagem_aprox": number,
                 "papel": "principal" | "secundario" | "ornamento" } ],
  "paleta": ["#RRGGBB", "..."],
  "estilo": "string curta, ex: aquarela botânica",
  "densidade": "baixa" | "media" | "alta",
  "tem_texto": boolean,
  "tem_logo": boolean,
  "rota_recomendada": "deterministica" | "generativa",
  "confianca": number
}

"fundo.cor" deve ser o hex do fundo predominante; se o fundo for transparente,
devolva "#00000000". "motivos" pode vir vazio quando separavel é false.`;

const TIPOS = ['motivos_isolados', 'fundo_continuo', 'misto', 'composicao_central'] as const;
const FUNDOS = ['solido', 'textura', 'transparente'] as const;
const DENSIDADES = ['baixa', 'media', 'alta'] as const;
const PAPEIS = ['principal', 'secundario', 'ornamento'] as const;
const ROTAS = ['deterministica', 'generativa'] as const;

/** Aceita "#RGB", "#RRGGBB" e "#RRGGBBAA"; qualquer outra coisa vira null. */
function hex(v: unknown): string {
  const s = str(v).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s : '';
}

export function validaLeitura(bruto: unknown): LeituraEstampa | null {
  const o = obj(bruto);
  if (!o) return null;

  // Sem estes três campos a saída não serve para rotear nada.
  if (typeof o.separavel !== 'boolean') return null;
  if (typeof o.tem_texto !== 'boolean' || typeof o.tem_logo !== 'boolean') return null;

  const f = obj(o.fundo) || {};
  const motivos: Motivo[] = arr(o.motivos)
    .map((m) => {
      const mo = obj(m);
      if (!mo) return null;
      return {
        nome: str(mo.nome, 'motivo'),
        contagem_aprox: Math.max(0, Math.round(num(mo.contagem_aprox, 1))),
        papel: umDe(mo.papel, PAPEIS, 'secundario'),
      } as Motivo;
    })
    .filter((m): m is Motivo => m !== null)
    .slice(0, 24);

  const separavel = o.separavel;

  return {
    tipo: umDe(o.tipo, TIPOS, separavel ? 'motivos_isolados' : 'fundo_continuo'),
    separavel,
    fundo: {
      tipo: umDe(f.tipo, FUNDOS, 'solido'),
      cor: hex(f.cor) || '#FFFFFF',
    },
    motivos,
    paleta: listaStr(o.paleta, 12).map((c) => hex(c)).filter(Boolean),
    estilo: str(o.estilo, 'não classificado').slice(0, 120),
    densidade: umDe(o.densidade, DENSIDADES, 'media'),
    tem_texto: o.tem_texto,
    tem_logo: o.tem_logo,
    // A rota segue `separavel` mesmo que o modelo se contradiga: o campo
    // booleano é o que a esteira consegue executar.
    rota_recomendada: separavel ? 'deterministica' : umDe(o.rota_recomendada, ROTAS, 'generativa'),
    confianca: conf(o.confianca),
  };
}

export async function lerEstampa(
  env: Env,
  pngUrl: string,
  contexto: { nome: string; tema: string | null; licenca: string | null },
  itemId: number | null = null,
): Promise<LeituraEstampa> {
  const pistas = [
    `Nome da estampa: ${contexto.nome}`,
    contexto.tema ? `Tema no catálogo: ${contexto.tema}` : null,
    contexto.licenca ? `Licença: ${contexto.licenca}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return chamarAgente<LeituraEstampa>(
    env,
    'A2_leitor',
    [
      sistema(PAPEL, SCHEMA),
      comImagem(
        pngUrl,
        `${pistas}\n\nEsta é a arte da capinha. Leia e devolva o JSON.\n\n` +
          `Atenção: o nome e a licença acima são pistas, não verdade — se a arte tiver ` +
          `texto ou logo que o nome não menciona, o que vale é o que você vê.`,
      ),
    ],
    { temperature: 0.2, maxTokens: 2000, itemId, valida: validaLeitura, tentativas: 2 },
  );
}
