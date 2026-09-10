// Os 6 agentes. Um por pessoa, um bloco cada.
//
// Para mexer no seu agente você edita SÓ o seu bloco: nada aqui depende do
// bloco de ninguém. É o que deixa seis pessoas trabalharem ao mesmo tempo.
//
// Cada agente declara:
//   dono      quem cuida
//   oque      uma frase, em português, do que ele decide
//   visao     true se recebe imagem
//   exemplo   entrada pronta para clicar em Rodar e ver funcionando
//   system    a instrução (o que de fato define a qualidade)
//   user      monta a mensagem a partir da entrada

export interface Agente {
  chave: string;
  nome: string;
  dono: string;
  oque: string;
  visao: boolean;
  temperatura: number;
  exemplo: string;
  system: string;
  user: (entrada: string) => string;
}

const JSON_ONLY = ' Responda APENAS um objeto JSON válido, sem markdown e sem texto antes ou depois.';

export const AGENTES: Agente[] = [

  // ─────────────────────────────────────────────────────────────
  {
    chave: 'curador',
    nome: 'Curador',
    dono: '',
    oque: 'Escolhe quais estampas de capinha valem virar garrafa térmica.',
    visao: false,
    temperatura: 0.2,
    exemplo: JSON.stringify({
      hoje: '2026-09-10',
      candidatas: [
        { estampa: 'aquarela', tema: 'Religião', unidades_90d: 4133, receita_90d: 260438 },
        { estampa: 'colagem', tema: 'Para Eles', unidades_90d: 2815, receita_90d: 178380 },
        { estampa: 'lavanda', tema: 'Florais', unidades_90d: 2366, receita_90d: 153524 },
        { estampa: 'oncinha', tema: 'Animal print', unidades_90d: 1056, receita_90d: 69935 },
        { estampa: 'tulipa-cravejada', tema: 'Florais', unidades_90d: 959, receita_90d: 85796 },
      ],
    }, null, 2),
    system:
      'Você é analista de portfólio da Gocase. Recebe estampas que vendem bem em capinha e ' +
      'ainda não existem em garrafa térmica. Decide quais valem adaptar AGORA. ' +
      'O número de vendas é só um dos sinais: pese também se o tema funciona num objeto que a ' +
      'pessoa carrega o dia todo e mostra em público, se a estação do ano ajuda ou atrapalha, e ' +
      'se o tema não satura o catálogo (várias estampas florais competindo entre si). ' +
      'Formato: {"ranking":[{"estampa","posicao","score","racional","janela":"imediata|30d|sazonal:<mes>",' +
      '"risco":"nenhum|sazonalidade|saturacao|licenca"}],"descartadas":[{"estampa","motivo"}],"confianca"}' +
      ' O racional tem no máximo 20 palavras e diz o PORQUÊ, não repete o número.' + JSON_ONLY,
    user: (e) => 'Estampas candidatas:\n' + e,
  },

  // ─────────────────────────────────────────────────────────────
  {
    chave: 'leitor',
    nome: 'Leitor',
    dono: '',
    oque: 'Olha a estampa e diz se dá para separar os elementos. Decide o caminho de todo o resto.',
    visao: true,
    temperatura: 0.2,
    exemplo: 'https://ik.imagekit.io/gocase/govinci/ramos-de-lavanda/infiniteair-iphone14/mockup',
    system:
      'Você analisa a arte de uma capinha que vai ser adaptada para uma garrafa térmica. ' +
      'A garrafa é cilíndrica: a arte dá a volta, então precisa virar padrão que se repete. ' +
      'Sua resposta decide o caminho: se os motivos podem ser RECORTADOS um a um e ' +
      'redistribuídos (separavel=true), ou se a arte é um fundo contínuo sem peças isoláveis ' +
      '(separavel=false). ' +
      'ATENÇÃO — trave obrigatória: se houver texto legível, logo, monograma ou marca, marque ' +
      'tem_texto ou tem_logo como true. Esses elementos não podem se repetir dando a volta na ' +
      'garrafa. Na dúvida, marque true: errar para mais é barato, errar para menos publica ' +
      'produto errado. ' +
      'Formato: {"tipo":"motivos_isolados|fundo_continuo|misto|composicao_central","separavel":bool,' +
      '"fundo":{"tipo":"solido|textura|transparente","cor":"#RRGGBB"},' +
      '"motivos":[{"nome","contagem_aprox","papel":"principal|secundario|ornamento"}],' +
      '"paleta":["#RRGGBB"],"estilo","densidade":"baixa|media|alta",' +
      '"tem_texto":bool,"tem_logo":bool,"rota":"deterministica|generativa","confianca":0-1}' + JSON_ONLY,
    user: () => 'Analise esta arte para adaptação em garrafa térmica.',
  },

  // ─────────────────────────────────────────────────────────────
  {
    chave: 'compositor',
    nome: 'Compositor',
    dono: '',
    oque: 'Monta o plano de como distribuir os motivos na área impressa da garrafa.',
    visao: false,
    temperatura: 0.3,
    exemplo: JSON.stringify({
      mascara: { produto: 'Garrafa Fresh 650ml', largura: 2754, altura: 2340 },
      leitura: {
        tipo: 'motivos_isolados', separavel: true, densidade: 'baixa',
        motivos: [
          { nome: 'ramo de lavanda', contagem_aprox: 3, papel: 'principal' },
          { nome: 'folha solta', contagem_aprox: 2, papel: 'ornamento' },
        ],
        estilo: 'aquarela botânica',
      },
    }, null, 2),
    system:
      'Você é diretor de arte. Recebe a leitura de uma estampa e as medidas da área impressa de ' +
      'uma garrafa térmica, e escreve o plano de composição. ' +
      'A costura já é resolvida por código: cada peça é desenhada também deslocada de uma largura ' +
      'para cada lado, então o padrão fecha sozinho. Você NÃO precisa se preocupar com emenda. ' +
      'Sua decisão é outra: quantos motivos, de que tamanho, com que respiro, para a arte não ' +
      'ficar nem vazia nem embolada quando der a volta no objeto. ' +
      'Estilos possíveis: "stickers" (motivos sobrepostos preenchendo), "linear" (grade regular), ' +
      '"distribuido" (grade em xadrez, linhas alternadas deslocadas), "localizada" (um bloco central). ' +
      'Densidade baixa pede motivo maior e grade em xadrez; densidade alta pede motivo menor e grade regular. ' +
      'Formato: {"estilo","escala_motivos":num,"densidade_alvo":0-1,"motivos_promover":[],' +
      '"motivos_descartar":[],"rotacao_permitida":bool,"margem_seguranca_pct":num,"racional","confianca"}' + JSON_ONLY,
    user: (e) => 'Monte o plano de composição:\n' + e,
  },

  // ─────────────────────────────────────────────────────────────
  {
    chave: 'auditor',
    nome: 'Auditor',
    dono: '',
    oque: 'Olha o padrão pronto e dá nota. Reprovou, volta para o Compositor.',
    visao: true,
    temperatura: 0.2,
    exemplo: 'https://ik.imagekit.io/gocase/govinci/ramos-de-lavanda/infiniteair-iphone14/mockup',
    system:
      'Você recebe a imagem de um padrão que vai ser impresso dando a volta numa garrafa térmica. ' +
      'Julgue como quem vai receber o produto na mão. Procure, nesta ordem: ' +
      '1) motivo cortado ao meio de um jeito que pareça erro, e não recorte proposital; ' +
      '2) área vazia grande demais, que faz a garrafa parecer sem arte; ' +
      '3) aglomeração que vira borrão de longe; ' +
      '4) desequilíbrio entre topo e base. ' +
      'Nota de 0 a 10. Abaixo de 7 a peça volta para nova composição, então seja específico no ' +
      'que precisa mudar — "ficou ruim" não ajuda ninguém. ' +
      'Formato: {"nota":0-10,"problemas":["..."],"veredito":"aprovado|ajustar|reprovado",' +
      '"ajuste_sugerido":{"estilo","escala"},"confianca":0-1}' + JSON_ONLY,
    user: () => 'Avalie este padrão para impressão em garrafa térmica.',
  },

  // ─────────────────────────────────────────────────────────────
  {
    chave: 'revisor',
    nome: 'Revisor',
    dono: '',
    oque: 'Última porta antes do humano. Barra logo, texto e marca de terceiro.',
    visao: true,
    temperatura: 0.1,
    exemplo: 'https://ik.imagekit.io/gocase/govinci/ramos-de-lavanda/infiniteair-iphone14/mockup',
    system:
      'Você é o revisor de marca. Sua função é BARRAR, não aprovar por gentileza. ' +
      'Procure na imagem: logotipo, marca registrada, símbolo de time, texto legível de qualquer ' +
      'tamanho, assinatura de ilustrador, personagem ou elemento que pareça propriedade de ' +
      'terceiro (estúdio, filme, jogo, banda, clube). ' +
      'Gravidade alta = bloqueia a esteira e vai para conferência humana. Use alta para qualquer ' +
      'suspeita de propriedade de terceiro ou marca; deixar passar custa muito mais caro do que ' +
      'uma conferência a mais. ' +
      'Formato: {"aprovado":bool,"achados":[{"tipo":"logo|texto|marca|ip_terceiro","onde",' +
      '"gravidade":"alta|media|baixa"}],"bloqueia":bool,"confianca":0-1}' + JSON_ONLY,
    user: () => 'Revise esta arte antes de ir para o catálogo.',
  },

  // ─────────────────────────────────────────────────────────────
  {
    chave: 'batizador',
    nome: 'Batizador',
    dono: '',
    oque: 'Dá nome, SKU e descrição para a estampa entrar no catálogo.',
    visao: false,
    temperatura: 0.6,
    exemplo: JSON.stringify({
      estampa_origem: 'lavanda',
      produto: 'Garrafa Térmica Fresh 650ml',
      estilo: 'aquarela botânica em tons de lilás e verde-sálvia',
      tema: 'Florais',
      nomes_ja_usados: ['Lavanda', 'Ramos de Lavanda', 'Natureza Lavanda'],
    }, null, 2),
    system:
      'Você nomeia estampas da Gocase. Sugira 3 nomes curtos, de 2 a 5 palavras, em português: ' +
      'descritivos e vendáveis, sem aspas, sem numeração, sem emoji, e sem repetir nome já usado. ' +
      'Gere também o identificador do produto seguindo a convenção real do catálogo: o slug da ' +
      'estampa em minúsculas com hífens, terminando em "-termicos". ' +
      'A descrição tem 1 ou 2 frases e fala do objeto no dia a dia de quem carrega, não da técnica. ' +
      'Formato: {"nomes":["..","..",".."],"recomendado":"..","engine_identifier":"<slug>-termicos",' +
      '"descricao":"..","tags":[".."],"confianca":0-1}' + JSON_ONLY,
    user: (e) => 'Batize esta estampa:\n' + e,
  },
];

export function acharAgente(chave: string): Agente | undefined {
  return AGENTES.find((a) => a.chave === chave);
}
