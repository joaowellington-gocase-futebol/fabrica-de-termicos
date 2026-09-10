// T1 · contratos entre trilhas. Mudou algo aqui? PR com revisão do dono (ver docs/EQUIPE.md).

// --- infraestrutura compartilhada (env.DB, secrets) -------------------------

export interface ResultadoConsultaDb {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsRead: number;
}
export interface ResultadoExecDb {
  rowsWritten: number;
}
export interface Db {
  query(sql: string, params?: unknown[]): Promise<ResultadoConsultaDb>;
  exec(sql: string, params?: unknown[]): Promise<ResultadoExecDb>;
}

export interface Env {
  DB: Db;
  AI_PROXY_TOKEN?: string;
  AI_PROXY_URL?: string;
  AI_MODEL?: string;
  PIAPP_TOKEN?: string;
  REMOVEBG_KEY?: string;
  METABASE_TOKEN?: string;
  PROXY_BASE_URL?: string;
}

// --- geometria: buffer de pixel usado por separador e rapport ---------------

/** RGBA não pré-multiplicado, 8 bits por canal — o mesmo formato que upng-js lê/escreve. */
export interface RGBABuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// --- Camada: contrato central, no mesmo formato que o ag-psd produz ---------
// T1 é dono. Consumido por T3 (A4 olha o contact-sheet dos recortes) e T4 (A5/A6 avaliam).

export type CamadaKind = 'motivo' | 'fundo' | 'fonte';

export interface Camada {
  /** pixels já recortados pela bbox do componente — não o canvas inteiro da estampa. */
  canvas: RGBABuffer;
  /** offset x/y e tamanho ORIGINAL dentro da estampa fonte (antes de qualquer escala do layout). */
  ox: number;
  oy: number;
  ow: number;
  oh: number;
  /** 'fonte' = guia de composição (personalização), nunca entra no arquivo final. */
  kind: CamadaKind;
  nome?: string;
}

export interface Mascara {
  key: string;
  w: number;
  h: number;
}

// --- LeituraEstampa: saída do A2, dono é T3 ---------------------------------
// Roteia a esteira inteira. tem_texto/tem_logo são trava: true bloqueia rapport.

export type TipoEstampa = 'motivos_isolados' | 'fundo_continuo' | 'misto' | 'composicao_central';
export type TipoFundo = 'solido' | 'textura' | 'transparente';
export type Densidade = 'baixa' | 'media' | 'alta';
export type RotaEstampa = 'deterministica' | 'generativa';
export type PapelMotivo = 'principal' | 'secundario' | 'ornamento';

export interface MotivoLido {
  nome: string;
  contagem_aprox: number;
  papel: PapelMotivo;
}

export interface LeituraEstampa {
  tipo: TipoEstampa;
  separavel: boolean;
  fundo: { tipo: TipoFundo; cor: string };
  motivos: MotivoLido[];
  paleta: string[];
  estilo: string;
  densidade: Densidade;
  tem_texto: boolean;
  tem_logo: boolean;
  rota_recomendada: RotaEstampa;
  confianca: number;
}

// --- PlanoComposicao: saída do A3, dono é T3 --------------------------------

export type EstiloComposicao = 'stickers' | 'linear' | 'distribuido' | 'localizada';

export interface PlanoComposicao {
  estilo: EstiloComposicao;
  escala_motivos: number;
  densidade_alvo: number;
  motivos_promover: string[];
  motivos_descartar: string[];
  rotacao_permitida: boolean;
  margem_seguranca_pct: number;
  racional: string;
  confianca: number;
}

/** O "S" do motor de rapport: PlanoComposicao + o tipo de máscara (pattern dá a volta, localizada não). */
export interface ConfigComposicao {
  tipo: 'pattern' | 'localizada';
  estilo: EstiloComposicao;
  cols?: number;
  overlap?: boolean;
}

// --- resultado do layout / composição ---------------------------------------

export interface TransformCamada {
  w: number;
  h: number;
  x: number;
  y: number;
  rot?: number;
}

export interface ResultadoLayout {
  T: Map<Camada, TransformCamada>;
  onlyStar: boolean;
  star: Camada | null;
  guias: Camada[];
}

export interface OffsetRapport {
  dx: number;
  dy: number;
}

// --- ItemFila + estados: dono é T1, consumido por T2, T5, T6 ----------------

export const ESTADOS_FILA = [
  'candidata',
  'arte_ok',
  'lida',
  'separada',
  'composta',
  'auditada',
  'nomeada',
  'aguardando_aprovacao',
  'aprovada',
  'cadastrada',
  'reprovada',
] as const;

export type EstadoFilaOk = (typeof ESTADOS_FILA)[number];
/** falhou_<estagio>, ex.: falhou_leitor, falhou_separador — não trava a fila, só marca o item. */
export type EstadoFila = EstadoFilaOk | `falhou_${string}`;

export interface ItemFila {
  id: number;
  estampa_key: string;
  status: EstadoFila;
  rota_usada: 'deterministica' | 'generativa' | null;
  nota_auditor: number | null;
  tentativas: number;
  criado_em: string;
  atualizado_em: string;
  motivo_falha: string | null;
  /** dados acumulados de cada estágio (png_alta, leitura, plano, etc.) — schema solto de propósito. */
  payload: Record<string, unknown>;
}

// --- agente_log: toda chamada ao AI Proxy grava uma linha aqui --------------

export interface AgenteLog {
  agente: string;
  modelo: string;
  tokens_entrada: number;
  tokens_saida: number;
  latencia_ms: number;
  custo_usd: number;
  confianca: number | null;
  sucesso: boolean;
  erro: string | null;
  item_fila_id: number | null;
}
