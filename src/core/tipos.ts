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

/**
 * Zona proibida da logo Gocase na máscara, em px.
 *
 * Lida de `factory materials` (logo_pos_x/y, logo_size, logo_border_size). O
 * campo `disponivel` existe porque, para os térmicos do primeiro corte, essas
 * colunas vêm NULL — ver `zonaLogo()` em core/dados.ts. Quando o dado falta, o
 * critério de margem responde "não verificável", nunca "aprovado".
 */
export type ZonaLogo =
  | { disponivel: false; motivo: string }
  | {
      disponivel: true;
      /** Retângulo proibido: a logo dilatada pela folga cadastrada. */
      x: number;
      y: number;
      w: number;
      h: number;
      /** A logo em si, sem a folga. */
      logo: { x: number; y: number; size: number };
      borda: number;
      aplica_logo: boolean;
      material: string;
    };

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
  /**
   * Tamanho do motivo em relação ao MAIOR motivo da arte, de 0 a 1.
   *
   * É o que permite ao compositor preservar a hierarquia da capinha em vez de
   * achatar tudo no mesmo tamanho. O maior motivo é sempre 1.
   */
  tamanho_relativo: number;
}

/**
 * Como os elementos se relacionam entre si na capinha.
 *
 * Sem isto o compositor trata toda arte como padrão uniforme, e uma composição
 * com um elemento herói cercado de satélites sai como uma grade de iguais —
 * que é outra arte. É a entrada do critério 1 do A11 (semelhança com a
 * composição da capinha).
 */
export interface Composicao {
  /**
   * `uniforme`            todos os elementos do mesmo tamanho e peso (poá, oncinha)
   * `um_dominante`        um elemento claramente maior, os outros o acompanham
   * `heroi_com_satelites` um elemento central em destaque e outros ao redor
   * `escalonada`          vários tamanhos em degradê, sem um dono único
   */
  hierarquia: 'uniforme' | 'um_dominante' | 'heroi_com_satelites' | 'escalonada';
  /** Nome do motivo dominante, quando existe um. */
  elemento_principal: string | null;
  /** Quantas vezes o maior motivo é maior que o menor. 1 = todos iguais. */
  proporcao_maior_menor: number;
  /** Como os elementos ocupam o espaço. */
  arranjo: 'grade' | 'espalhado' | 'agrupado' | 'centralizado' | 'moldura';
  /** A arte tem direção de leitura (topo/base definidos)? */
  tem_orientacao: boolean;
}
export interface LeituraEstampa extends SaidaAgente {
  tipo: 'motivos_isolados' | 'fundo_continuo' | 'misto' | 'composicao_central';
  separavel: boolean;
  fundo: { tipo: 'solido' | 'textura' | 'transparente'; cor: string };
  motivos: Motivo[];
  /** A relação entre os elementos, não só a lista deles. */
  composicao: Composicao;
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

/**
 * A11 — Juiz de Fidelidade: medições determinísticas.
 *
 * Três dos cinco critérios são MEDIDOS, não julgados, e por isso vivem aqui e
 * não na saída do modelo. Um agente que "acha" que a resolução está boa é pior
 * que uma conta: a conta não tem variância.
 */
export interface MedicaoFidelidade {
  /** Critério 2. Linhas de descontinuidade na emenda. 0 = fecha. */
  erro_costura_px: number;
  /**
   * Critério 4. Maior fator de ampliação aplicado a algum recorte.
   *
   * 1 = desenhado no tamanho nativo. 2 = dobrado, ou seja, cada pixel da arte
   * original virou 4 na impressão. Acima de `TETO_AMPLIACAO` pixela.
   */
  ampliacao_maxima: number;
  /** Qual recorte puxou a pior ampliação — para saber onde olhar. */
  ampliacao_pior_camada: string | null;
  /** Resolução nativa da arte na capinha, quando o Factory informa. */
  arte_nativa: { w: number; h: number } | null;
  /**
   * Critério 5. `null` quando a zona da logo não está cadastrada no Factory —
   * que é o caso de todos os térmicos do primeiro corte hoje.
   */
  invade_logo: {
    invade: boolean;
    /** Fração da zona proibida coberta por arte, de 0 a 1. */
    cobertura: number;
    colocacoes_invasoras: number;
  } | null;
  /** Por que a checagem de logo não pôde ser feita, quando não pôde. */
  logo_indisponivel: string | null;
  /** Contexto para o julgamento do modelo. */
  camadas: number;
  colocacoes: number;
  /** Composição saiu sem rapport (arte de fundo contínuo). */
  sem_rapport: boolean;
}

/** Nota de um critério, do A11. */
export interface NotaCriterio {
  nota: number;
  /** `medido` vem de conta; `julgado` vem do modelo. */
  fonte: 'medido' | 'julgado';
  observacao: string;
}

/**
 * A11 — Juiz de Fidelidade. A última porta antes do humano.
 *
 * Os cinco critérios do pedido, nesta ordem:
 *   1. semelhança com a composição da capinha  (julgado)
 *   2. rapport encaixa                          (medido)
 *   3. recorte dos elementos é coerente         (julgado)
 *   4. respeita a resolução da case             (medido)
 *   5. respeita a margem da logo                (medido, quando há dado)
 */
export interface Fidelidade extends SaidaAgente {
  criterios: {
    semelhanca_composicao: NotaCriterio;
    rapport: NotaCriterio;
    coerencia_recorte: NotaCriterio;
    resolucao: NotaCriterio;
    margem_logo: NotaCriterio;
  };
  /** Média ponderada, 0 a 10. */
  nota_final: number;
  veredito: 'aprovado' | 'ajustar' | 'reprovado';
  /** O que reprovou, em ordem de gravidade. */
  problemas: string[];
  ajuste_sugerido: { estilo?: EstiloComposicao; escala?: number } | null;
  medicao: MedicaoFidelidade;
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
  'julgada',
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
  /** A11 — o juiz dos cinco critérios. */
  fidelidade: Fidelidade | null;
  /**
   * As medições determinísticas, gravadas pelo runner ANTES de o A11 rodar.
   *
   * Ficam numa coluna própria porque quem mede (o browser) e quem julga (o
   * worker) são runtimes diferentes, em requisições diferentes.
   */
  medicao: MedicaoFidelidade | null;
  /** Zona da logo lida do Factory no momento em que a arte foi resolvida. */
  zona_logo: ZonaLogo | null;
  /** Resolução nativa da arte na capinha (factory stamps.width/height). */
  arte_w: number | null;
  arte_h: number | null;
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
