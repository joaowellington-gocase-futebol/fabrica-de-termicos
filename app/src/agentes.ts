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
      '"risco":"nenhum|sazonalidade|saturacao|licenca"}],"descartadas":[{"estampa","motivo"}],"confianca":0-1}' +
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
    exemplo: 'https://custom-case-images.s3.amazonaws.com/prisma-render/prod-v2/previews/ramos-de-lavanda/100688/standard-iphone11/17773150714228854032720886829191875.png',
    system:
      'Você analisa a arte de uma capinha que vai ser adaptada para uma garrafa térmica. ' +
      'A garrafa é cilíndrica: a arte dá a volta, então precisa virar padrão que se repete. ' +
      'Sua resposta decide o caminho: se os motivos podem ser RECORTADOS um a um e ' +
      'redistribuídos (separavel=true), ou se a arte é um fundo contínuo sem peças isoláveis ' +
      '(separavel=false). ' +
      'CONTEXTO IMPORTANTE: esta imagem vem do preview do catálogo, e o preview quase sempre ' +
      'traz dois elementos que NÃO fazem parte da estampa — a marca "gocase" num canto, e uma ' +
      'letra ou nome de exemplo da personalização (ex.: "A."). Os dois são REMOVIDOS antes da ' +
      'adaptação. Liste-os em elementos_a_remover, dizendo onde estão, e NÃO os trate como ' +
      'impedimento nem os inclua na lista de motivos. ' +
      'Bloqueio é outra coisa: marque bloqueio_terceiro=true só se houver marca, personagem, ' +
      'escudo de time, logo de empresa ou obra que pertença a TERCEIRO — nunca pela marca da ' +
      'própria Gocase. Nesse caso, na dúvida marque true. ' +
      'texto_na_arte é para texto que faz parte do desenho (uma frase, um versículo, um lettering ' +
      'decorativo). Esse texto impede o padrão, porque ficaria se repetindo em volta da garrafa. ' +
      'Formato: {"tipo":"motivos_isolados|fundo_continuo|misto|composicao_central","separavel":bool,' +
      '"fundo":{"tipo":"solido|textura|transparente","cor":"#RRGGBB"},' +
      '"motivos":[{"nome","contagem_aprox","papel":"principal|secundario|ornamento"}],' +
      '"elementos_a_remover":[{"tipo":"marca_gocase|texto_personalizacao|assinatura","onde"}],' +
      '"paleta":["#RRGGBB"],"estilo","densidade":"baixa|media|alta",' +
      '"texto_na_arte":bool,"bloqueio_terceiro":bool,' +
      '"rota":"deterministica|generativa","confianca":0-1}' + JSON_ONLY,
    user: () => 'Analise esta arte para adaptação em garrafa térmica.',
  },

  // ─────────────────────────────────────────────────────────────
  {
    chave: 'colorista',
    nome: 'Variação de cor',
    dono: '',
    oque: 'Propõe outras cartelas para a mesma arte, sem mudar o desenho. Etapa opcional.',
    visao: true,
    temperatura: 0.5,
    exemplo: 'https://custom-case-images.s3.amazonaws.com/prisma-render/prod-v2/previews/ramos-de-lavanda/100688/standard-iphone11/17773150714228854032720886829191875.png',
    system:
      'Você recebe uma estampa e propõe variações de COR — o desenho continua o mesmo, muda a ' +
      'cartela. O destino é uma garrafa térmica de corpo branco, preto ou azul claro. ' +
      'Para cada variação diga em qual corpo ela funciona: arte muito clara some no branco, ' +
      'arte muito escura fecha demais no preto. ' +
      'Proponha 3 variações com propósito diferente entre si — por exemplo uma mais sóbria para ' +
      'público masculino, uma mais quente para o verão, uma monocromática. Não repita a original. ' +
      'Descreva a troca em termos do que a pessoa vê ("lilás vira terracota"), não em teoria de cor. ' +
      'Formato: {"original":{"paleta":["#RRGGBB"],"leitura":"..."},' +
      '"variacoes":[{"nome","paleta":["#RRGGBB"],"de_para":[{"era":"#RRGGBB","vira":"#RRGGBB"}],' +
      '"corpo_ideal":"branco|preto|azul","publico","racional"}],"confianca":0-1}' + JSON_ONLY,
    user: () => 'Proponha variações de cor para esta estampa.',
  },

  // ─────────────────────────────────────────────────────────────
  {
    chave: 'colecao',
    nome: 'Set / Coleção',
    dono: '',
    oque: 'Transforma uma estampa em conjunto: peças que conversam entre si na prateleira.',
    visao: false,
    temperatura: 0.6,
    exemplo: JSON.stringify({
      estampa: 'ramos-de-lavanda',
      estilo: 'ilustração botânica em aquarela sobre papel texturizado',
      motivos: ['ramos de lavanda roxa', 'folhagens verdes alongadas', 'flores lilás'],
      paleta: ['#F4D9AE', '#56308F', '#8E63C5', '#45633B'],
      pecas_do_set: 4,
    }, null, 2),
    system:
      'Você monta um SET a partir de uma estampa: peças diferentes que se reconhecem como da ' +
      'mesma família quando ficam lado a lado na prateleira ou numa foto. ' +
      'Cada peça usa os MESMOS motivos e a MESMA paleta — o que muda é a densidade, a escala e ' +
      'quais motivos aparecem. A regra é ter contraste entre elas: se todas tiverem a mesma ' +
      'densidade, o set vira repetição, não coleção. ' +
      'Distribua entre: uma peça cheia (motivos densos), uma média, uma respirada (poucos motivos ' +
      'grandes) e, quando fizer sentido, uma quase lisa que só cita a paleta. ' +
      'Nomeie o set com 1 a 3 palavras. Cada peça também ganha nome curto. ' +
      'Formato: {"nome_do_set","conceito","pecas":[{"nome","motivos_usados":[],"densidade":"baixa|media|alta",' +
      '"escala":"pequena|media|grande","estilo":"stickers|linear|distribuido|localizada",' +
      '"corpo_sugerido":"branco|preto|azul","papel_no_set"}],"confianca":0-1}' + JSON_ONLY,
    user: (e) => 'Monte o set a partir desta estampa:\n' + e,
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
      'Ignore o que estiver em elementos_a_remover: marca da casa e letra de personalização saem antes de compor. ' +
      'escala_motivos é um MULTIPLICADOR sobre o tamanho que a peça teria na grade, entre 0.6 e 1.8: ' +
      '1.0 mantém, 1.4 aumenta 40%, 0.7 encolhe. Não é pixel, não é porcentagem, e nunca passa de 1.8. ' +
      'Formato: {"estilo","escala_motivos":0.6-1.8,"densidade_alvo":0-1,"motivos_promover":[],' +
      '"motivos_descartar":[],"rotacao_permitida":bool,"margem_seguranca_pct":num,"racional","confianca":0-1}' + JSON_ONLY,
    user: (e) => 'Monte o plano de composição:\n' + e,
  },

  // ─────────────────────────────────────────────────────────────
  {
    chave: 'auditor',
    nome: 'Auditor',
    dono: '',
    oque: 'Olha o padrão montado e dá nota. Reprovou, volta para o Compositor.',
    visao: true,
    temperatura: 0.2,
    exemplo: 'https://custom-case-images.s3.amazonaws.com/prisma-render/prod-v2/previews/ramos-de-lavanda/100688/standard-iphone11/17773150714228854032720886829191875.png',
    system:
      'Você recebe o PADRÃO JÁ MONTADO — não a arte da capinha. Ele é um ladrilho que será ' +
      'impresso dando a volta na garrafa: a borda direita encosta na esquerda. ' +
      'Duas coisas que NÃO são defeito aqui, e você não deve apontar: ' +
      '(a) motivo cortado na borda esquerda ou direita — ele continua do outro lado quando enrola, ' +
      'é assim que o padrão funciona; (b) fundo transparente ou xadrez de transparência. ' +
      'Corte nas bordas de CIMA e de BAIXO é defeito, porque ali não há continuidade. ' +
      'Julgue como quem vai receber o produto na mão, nesta ordem: ' +
      '1) vazio grande que faz a garrafa parecer sem arte; ' +
      '2) aglomeração que vira borrão a um metro de distância; ' +
      '3) motivo cortado no topo ou na base; ' +
      '4) ritmo irregular — pedaços densos brigando com pedaços vazios; ' +
      '5) repetição óbvia demais, com o olho achando a grade. ' +
      'Nota de 0 a 10. Abaixo de 7 a peça volta para nova composição, então diga o que mudar em ' +
      'termos que o compositor executa: estilo e escala. "Ficou ruim" não ajuda ninguém. ' +
      'Formato: {"nota":0-10,"problemas":["..."],"veredito":"aprovado|ajustar|reprovado",' +
      '"ajuste_sugerido":{"estilo":"stickers|linear|distribuido|localizada","escala":0.6-1.8},' +
      '"confianca":0-1}' + JSON_ONLY,
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
    exemplo: 'https://custom-case-images.s3.amazonaws.com/prisma-render/prod-v2/previews/ramos-de-lavanda/100688/standard-iphone11/17773150714228854032720886829191875.png',
    system:
      'Você é o revisor de marca, e olha a arte JÁ ADAPTADA, pouco antes de ela ir ao catálogo. ' +
      'Sua função é BARRAR, não aprovar por gentileza. ' +
      'Procure: marca registrada, escudo de time, personagem, cena de filme, jogo ou série, ' +
      'assinatura de ilustrador, e qualquer elemento que pareça pertencer a terceiro. ' +
      'A marca "gocase" NÃO é motivo de bloqueio — é nossa. Se ela ainda aparecer, isso é falha ' +
      'de limpeza: registre como tipo "marca_gocase" com gravidade media, para alguém remover. ' +
      'Texto legível que faça parte do desenho é gravidade alta: repetido em volta da garrafa, ' +
      'fica ilegível e estraga o produto. ' +
      'Para propriedade de terceiro, na dúvida use gravidade alta — uma conferência a mais custa ' +
      'muito menos que publicar errado. ' +
      'Formato: {"aprovado":bool,"achados":[{"tipo":"ip_terceiro|marca_terceiro|texto|assinatura|marca_gocase",' +
      '"onde","gravidade":"alta|media|baixa"}],"bloqueia":bool,"confianca":0-1}' + JSON_ONLY,
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
      'O identificador NÃO é derivado do nome que você criou. Ele é o campo estampa_origem que ' +
      'veio na entrada, com "-termicos" no fim, e nada mais: se estampa_origem é ' +
      '"ramos-de-lavanda", o identificador é "ramos-de-lavanda-termicos", mesmo que o nome ' +
      'escolhido seja outro. É esse sufixo que amarra o térmico à capinha que já vende; trocar o ' +
      'slug quebra o vínculo no catálogo. ' +
      'A descrição tem 1 ou 2 frases e fala do objeto no dia a dia de quem carrega, não da técnica. ' +
      'Formato: {"nomes":["..","..",".."],"recomendado":"..","engine_identifier":"<slug>-termicos",' +
      '"descricao":"..","tags":[".."],"confianca":0-1}' + JSON_ONLY,
    user: (e) => 'Batize esta estampa:\n' + e,
  },
];

export function acharAgente(chave: string): Agente | undefined {
  return AGENTES.find((a) => a.chave === chave);
}
