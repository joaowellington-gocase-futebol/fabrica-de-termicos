/**
 * Contratos da Fábrica de Térmicos — a entrega da semana 1 da T1.
 *
 * Este arquivo é o único ponto de acoplamento entre as seis trilhas. Todas as
 * outras trabalham contra estes tipos, não contra implementação. Mudar algo
 * aqui exige PR com revisão do dono da trilha (ver docs/EQUIPE.md).
 *
 * Regra de ouro do projeto, e o motivo de os tipos serem partidos assim:
 *
 *   IA onde há julgamento. Determinístico onde há geometria.
 *
 * Tudo que descreve *decisão* (LeituraEstampa, PlanoComposicao, Auditoria...)
 * é saída de agente e carrega `confianca`. Tudo que descreve *geometria*
 * (Camada, Offset, Colocacao) é dado puro, sem confiança, porque não é opinião.
 */

// ---------------------------------------------------------------------------
// Geometria — sem IA em nenhum campo
// ---------------------------------------------------------------------------

/**
 * Uma camada recortada da estampa original.
 *
 * O formato imita de propósito o que o `ag-psd` entrega ao ler um PSD, campo a
 * campo. É o pulo do gato do projeto: o Separador produz esta mesma forma sem
 * PSD nenhum, então o motor de rapport que já existe roda sem alteração.
 *
 * `canvas` é um HTMLCanvasElement no browser e fica `null` no worker — o worker
 * orquestra e julga, mas nunca toca pixel (o runtime não tem Canvas API e o
 * orçamento de CPU é compartilhado). Ver docs/ARQUITETURA.md.
 */
export interface Camada {
  /** Bitmap da camada já recortada. `null` do lado do worker. */
  canvas: unknown | null;
  /** Origem X da bbox no canvas original. */
  ox: number;
  /** Origem Y da bbox no canvas original. */
  oy: number;
  /** Largura da bbox. */
  ow: number;
  /** Altura da bbox. */
  oh: number;
  /**
   * `fonte` são guias de personalização e são EXCLUÍDAS da composição final.
   * `fundo` é camada que cobre >=85% do canvas (isSpanning) e recebe tratamento
   * de fundo, não de motivo.
   */
  kind: 'motivo' | 'fundo' | 'fonte';
  /** Índice estável do recorte, usado para casar com o veredito do A4. */
  id: number;
  /** Nome dado pelo A4, quando houver. */
  nome?: string;
  /** Área em pixels opacos — usada para descartar ruído e ordenar por peso. */
  areaOpaca?: number;
}

/** Deslocamento horizontal aplicado a uma camada para fechar o rapport. */
export interface Offset {
  dx: number;
  dy: number;
}

/** Uma instância de uma camada colocada na máscara. */
export interface Colocacao {
  camadaId: number;
  x: number;
  y: number;
  escala: number;
  /** Radianos. Zero quando o plano proíbe rotação. */
  rotacao: number;
}

/** Máscara de produção: o retângulo da área impressa desenrolada, em px reais. */
export interface Mascara {
  produto: string;
  volumetria: string;
  /** Vem de factory materials.width — nunca inventar. */
  w: number;
  /** Vem de factory materials.height. */
  h: number;
  material?: string;
}

// ---------------------------------------------------------------------------
// Saídas de agente — todas carregam confianca
// ---------------------------------------------------------------------------

/** Todo agente devolve confiança; abaixo do corte o item vai para humano. */
export interface SaidaAgente {
  confianca: number;
}

/** A1 — Analista de Portfólio. */
export interface ItemRanking {
  estampa_key: string;
  posicao: number;
  score: number;
  racional: string;
  janela_ideal: string;
  risco: 'nenhum' | 'licenca' | 'sazonalidade' | 'saturacao';
}
export interface RankingPortfolio extends SaidaAgente {
  ranking: ItemRanking[];
  descartadas: { estampa_key: string; motivo: string }[];
}

/** A2 — Leitor de Estampa. É esta saída que roteia a esteira inteira. */
export interface Motivo {
  nome: string;
  contagem_aprox: number;
  papel: 'principal' | 'secundario' | 'ornamento';
}
export interface LeituraEstampa extends SaidaAgente {
  tipo: 'motivos_isolados' | 'fundo_continuo' | 'misto' | 'composicao_central';
  separavel: boolean;
  fundo: { tipo: 'solido' | 'textura' | 'transparente'; cor: string };
  motivos: Motivo[];
  paleta: string[];
  estilo: string;
  densidade: 'baixa' | 'media' | 'alta';
  /** Trava de segurança: texto não pode entrar em rapport. */
  tem_texto: boolean;
  /** Trava de segurança: logo repetiria a marca dando a volta na garrafa. */
  tem_logo: boolean;
  rota_recomendada: Rota;
}

export type EstiloComposicao = 'stickers' | 'linear' | 'distribuido' | 'localizada';

/** A3 — Estrategista de Composição. */
export interface PlanoComposicao extends SaidaAgente {
  estilo: EstiloComposicao;
  escala_motivos: number;
  densidade_alvo: number;
  motivos_promover: string[];
  motivos_descartar: string[];
  rotacao_permitida: boolean;
  margem_seguranca_pct: number;
  racional: string;
}

/** A4 — Copiloto de Segmentação. */
export interface VeredictoPeca {
  id: number;
  veredito: 'motivo_valido' | 'fragmento' | 'ruido' | 'duplicata';
  funde_com: number[];
  nome: string;
}
export interface RevisaoSegmentacao extends SaidaAgente {
  pecas: VeredictoPeca[];
  qualidade_recorte: number;
  refazer_com_tolerancia: number | null;
}

/** A5 — Auditor de Costura. Camada 1 é medida em código; camada 2 é visão. */
export interface Auditoria extends SaidaAgente {
  /** Medido deterministicamente. Na rota A deve ser 0 por construção. */
  erro_costura_px: number;
  nota: number;
  problemas: string[];
  veredito: 'aprovado' | 'ajustar' | 'reprovado';
  ajuste_sugerido: { estilo?: EstiloComposicao; escala?: number } | null;
}

/** A6 — Colorista. */
export type CorCorpo = 'branco' | 'preto' | 'azul';
export interface EscolhaCor extends SaidaAgente {
  recomendadas: { cor_corpo: CorCorpo; contraste: number; nota: number }[];
  reprovadas: { cor_corpo: CorCorpo; motivo: string }[];
  ajuste_paleta_sugerido: string | null;
}

/** A7 — Revisor de Marca. Trava dura: gravidade alta bloqueia sempre. */
export interface Achado {
  tipo: 'logo' | 'texto' | 'ip_terceiro' | 'marca';
  onde: string;
  gravidade: 'alta' | 'media' | 'baixa';
}
export interface RevisaoMarca extends SaidaAgente {
  aprovado: boolean;
  achados: Achado[];
  bloqueia: boolean;
}

/** A8 — Nomeador. */
export interface Nomeacao extends SaidaAgente {
  nome_comercial: string;
  sku: string;
  engine_identifier: string;
  prefixo_licenciado: string | null;
}

/** A9 — Redator de Catálogo. O único agente com temperatura 0.7. */
export interface CopyCatalogo extends SaidaAgente {
  nome: string;
  descricao: string;
  alt_text: string;
  tags: string[];
}

/** A10 — Supervisor da Esteira. Não toca arte: opera a fila. */
export interface AcaoSupervisor {
  item_id: number;
  acao: 'reprocessar' | 'escalar' | 'descartar';
  motivo: string;
}
export interface Supervisao extends SaidaAgente {
  acoes: AcaoSupervisor[];
  alerta: string;
  resumo_dia: string;
}

// ---------------------------------------------------------------------------
// Fila — a esteira é uma máquina de estados, não um agente conversacional
// ---------------------------------------------------------------------------

/**
 * Estados da esteira. A ordem do array É a ordem de avanço: `proximoEstado()`
 * usa o índice, então inserir um estágio no meio significa inserir aqui.
 */
export const ESTADOS = [
  'candidata',
  'arte_ok',
  'lida',
  'planejada',
  'separada',
  'composta',
  'auditada',
  'nomeada',
  'aguardando_aprovacao',
  'aprovada',
  'cadastrada',
] as const;
export type Estado = (typeof ESTADOS)[number];

/** Rota de produção da arte. A métrica que decide o projeto é a proporção A/B. */
export type Rota = 'deterministica' | 'generativa';

/**
 * Estágios cuja execução exige Canvas API, portanto rodam no browser e não no
 * cron. O worker deixa o item parado no estado de origem e um runner aberto
 * reivindica. Ver docs/ARQUITETURA.md — "por que a geometria não roda no
 * worker".
 */
export const ESTAGIOS_DE_MOTOR: Estado[] = ['planejada'];

export interface ItemFila {
  id: number;
  estampa_key: string;
  nome: string;
  tema: string | null;
  licenca: string | null;
  unidades: number;
  receita: number;
  estado: Estado | string;
  /** Gravado desde o dia 1: é a métrica que decide se o número é 90% ou 60%. */
  rota_usada: Rota | null;
  /** Gravado desde o dia 1, junto com rota_usada. */
  nota_auditor: number | null;
  erro_costura_px: number | null;
  png_alta: string | null;
  material: string | null;
  engine_identifier: string | null;
  mascara_w: number;
  mascara_h: number;
  leitura: LeituraEstampa | null;
  plano: PlanoComposicao | null;
  segmentacao: RevisaoSegmentacao | null;
  auditoria: Auditoria | null;
  cor: EscolhaCor | null;
  marca: RevisaoMarca | null;
  nomeacao: Nomeacao | null;
  copy: CopyCatalogo | null;
  /** Quantas vezes voltou ao A3 por reprova de costura. Duas -> fila humana. */
  tentativas: number;
  motivo_falha: string | null;
  criado_em: string;
  atualizado_em: string;
  atualizado_por: string;
}

/** Uma candidata crua saída do Curador, antes de entrar na fila. */
export interface Candidata {
  estampa_key: string;
  nome: string;
  tema: string | null;
  licenca: string | null;
  unidades: number;
  receita: number;
  /** unidades x fator de transferência do tema. */
  score: number;
}

/** Saída do Resolvedor de arte. */
export interface ArteResolvida {
  png_alta: string;
  material: string | null;
  engine_identifier: string;
  /** Qual etapa da cascata respondeu — diagnóstico, não decoração. */
  origem: 'factory' | 'site' | 'catalog';
}

// ---------------------------------------------------------------------------
// Observabilidade — sem isto não há como melhorar prompt depois
// ---------------------------------------------------------------------------

export interface LinhaAgenteLog {
  id: number;
  item_id: number | null;
  agente: string;
  modelo: string;
  tokens_entrada: number;
  tokens_saida: number;
  latencia_ms: number;
  custo_usd: number;
  ok: number;
  erro: string | null;
  quando: string;
}

/** Env do worker. Nenhum secret mora no repositório — só via setAppSecret. */
export interface Env {
  DB: {
    query(sql: string, params?: unknown[]): Promise<{
      columns: string[];
      rows: Record<string, unknown>[];
      rowsRead: number;
    }>;
    exec(sql: string, params?: unknown[]): Promise<{ rowsWritten: number }>;
  };
  /** Injetado pelo GoDeploy. Nunca hardcodar o host. */
  PROXY_BASE_URL?: string;
  /** AI Proxy do Gogroup, compatível com OpenAI. */
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  /** Só na rota generativa de reserva. Assíncrono: job_id + polling. */
  PIAPP_TOKEN?: string;
  /** Fundo com textura cai aqui, quando flood-fill não serve. */
  REMOVEBG_KEY?: string;
  /** Assinatura do cron da plataforma. */
  GODEPLOY_CRON_KEY?: string;
}
