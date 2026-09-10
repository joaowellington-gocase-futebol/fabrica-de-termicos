# Como funciona

## O estúdio, em 7 etapas

```
1  Produto de origem   você escolhe a case
2  Interpretação       IA      lê a arte e decide o caminho
3  Variação de cor     IA      opcional — outras cartelas
4  Set / Coleção       IA      vira conjunto: peças que conversam
5  Separador           código  tira o fundo, recorta cada motivo
6  Máscaras            humano  o ilustrador escolhe os produtos
7  Entrega             código  PNGs, mockups 2D e prévia 3D
```

Curador, Auditor, Revisor e Batizador continuam disponíveis como agentes e
entram na esteira automática; o estúdio é o caminho manual, para o ilustrador.

## Por que o PNG saía borrado

A área impressa da capinha tem cerca de **1,5 Mpx**; a da Fresh 650 tem
**6,4 Mpx**. Adaptar case→térmico é sempre subir de resolução, e a arte de
origem é o preview do catálogo, com 851 px de largura.

A primeira versão do rapport escalava cada peça para preencher a célula da
grade. Medido: ampliação **média 1,36×**, **pior caso 2,48×** — um ramo de
330 px virava 900 px. Daí o borrão.

A fonte maior existe, e eu tinha desistido cedo demais dela. O preview do S3
não tem versão de produção (403 em `production`, `prod`, `originals`, `full`),
mas o **Factory** guarda o arquivo de produção: para `ramos-de-lavanda`,
**9080×3880** contra os 851×1742 do preview. O `catalog-api` respondia 503
porque exige o cookie do visitante, não por estar fora do ar. Detalhes em
[MAPA-ATIVOS.md §9](MAPA-ATIVOS.md).

O estúdio agora tenta as fontes da maior para a menor e mostra qual vingou.
Ainda assim, a correção geométrica abaixo continua valendo: o catalog-api é
instável, e quando ele falha o preview de 851 px é o que resta.

A saída é geométrica, não de origem: **repetir mais vezes em vez de ampliar**.
A grade passou a ser calculada pelo tamanho nativo das peças, com teto de
ampliação em 1,0.

| | antes | depois |
|---|---|---|
| grade | 7×6 (42 repetições) | 15×12 (180 repetições) |
| ampliação média | 1,36× | **0,80×** |
| ampliação pior | 2,48× | **1,00×** |

Reduzir não custa nitidez; ampliar custa. Por isso o teto é 1,0 — e é também
por isso que pedir motivo maior tem preço: a etiqueta na entrega avisa quando
a peça foi esticada.

## Por que os assets saíam serrilhados

O PNG nítido resolveu o esticão, mas as peças continuavam com degrau de pixel
na silhueta. A causa não era resolução: era o recorte **binarizando** a borda.

A arte é aquarela, com transição macia entre motivo e papel. O preenchimento
zerava o alpha de todo pixel de fundo, de uma vez — e a transição virava
escada.

A primeira tentativa foi trocar o corte seco por uma rampa aplicada à região
inteira de fundo. Piorou muito: num papel texturizado, milhares de pixels
ficaram meio transparentes e a textura voltou como sujeira espalhada pela peça
(29% dos pixels com alpha parcial, contra ~2% de uma silhueta real).

O que funciona é aplicar a rampa **só na fronteira** — os pixels de fundo que
encostam no motivo. O miolo do fundo some inteiro; a borda volta macia.

Duas correções vieram junto, porque apareceram no mesmo teste:

- **Bolsão de papel cercado pelo desenho.** O preenchimento entra pelas quatro
  bordas, então não alcança um vazio no meio das folhas — e como esse vazio
  costuma estar colado ao desenho pela borda macia, cai no mesmo grupo e nem o
  teste de cor por grupo o separa. Agora cada bolsão é varrido por conta
  própria, e some se for grande o bastante para ser fundo de verdade.
- **Respingo do motivo vizinho.** Um pixel de borda só entra na peça se
  encostar no próprio motivo; antes, qualquer pixel solto dentro da caixa
  delimitadora entrava junto.

Verificação: peça ampliada 4× em *nearest neighbor* — o teste mais severo, que
mostra o pixel cru sem suavização do navegador. Silhueta macia, fundo limpo,
sem respingo.

## Sobre medir a emenda

A medição passou por duas versões erradas antes de assentar. A primeira exigia
que a primeira e a última coluna fossem **idênticas** — não são: ao enrolar,
elas ficam vizinhas. A segunda comparava o salto da emenda com a **mediana**
dos saltos internos, e isso engana num padrão esparso, onde a maioria das
colunas cai em área vazia e a mediana despenca.

A versão atual posiciona a emenda na distribuição inteira dos saltos internos.
Mas há um limite honesto: com padrão denso, poucos motivos cruzam a borda, e a
medição perde poder de discriminar — no controle sem wrap ela também passou.

Por isso o rótulo agora depende da rota:

- **determinística**: "emenda fecha por construção". É verdade matemática —
  cada peça é desenhada em `x−L`, `x` e `x+L`. Não depende de medir.
- **generativa (PIAPP)**: aí não há garantia nenhuma, e a medição é o único
  teste que existe.

## Medido, não prometido

O separador e o rapport rodaram na estampa real `ramos-de-lavanda`
(851×1742) contra a máscara da Fresh 650 (2754×2340):

| | resultado |
|---|---|
| peças recortadas | 40 |
| salto na emenda | 1,09 |
| salto normal dentro do desenho | 1,20 |
| razão | **0,90** |

Razão abaixo de 1 quer dizer que a emenda varia *menos* que o próprio desenho:
não dá para achar a costura olhando. O controle negativo — mesmo layout, sem as
cópias em ±L — deu razão **11,5**, com salto de 19,58 na emenda. É a diferença
entre fechar por construção e torcer para fechar.

## Por que o rapport não é IA

A garrafa é cilíndrica: a arte dá a volta e a borda esquerda precisa encaixar na
direita. Isso se resolve desenhando cada peça três vezes — em `x−L`, `x` e `x+L`:

```
wrapOffsets(mascara) → [{ dx: -largura }, { dx: +largura }]
```

A emenda fecha por construção, erro zero. Pedir "faça sem emenda" a um modelo
generativo troca essa garantia por uma aposta — e ainda redesenha a arte que
estava vendendo. Por isso os dois passos de geometria ficam em código, e os
cinco de julgamento ficam com os agentes.

## A mesa de especialistas

Onze agentes, cada um com uma área e um limite. O ponto de delimitar não é
burocracia: é impedir que dois agentes decidam a mesma coisa e se contradigam.
Cada um declara, no próprio prompt:

- **`area`** — o que só ele decide
- **`fora`** — o que não é dele. Ao notar algo aqui, **não palpita: manda recado**
  ao colega responsável.

| agente | decide | não decide |
|---|---|---|
| curador | quais estampas entram e em que ordem | qualquer coisa da imagem |
| leitor | o que a arte é e por qual rota vai | tolerância, qualidade do recorte, arranjo |
| **fundo** | tipo de fundo e **a tolerância numérica do recorte** | os motivos, a composição |
| **recorte** | o que é motivo, caco ou sujeira nas peças | onde as peças vão ficar |
| colorista | cartelas e corpo de garrafa | desenho, arranjo, recorte |
| colecao | quantas peças o set tem e o que difere | parâmetros de composição |
| compositor | estilo, escala, densidade, margem | a emenda, a cor, se dá pra separar |
| auditor | nota do padrão e o que mudar | marca de terceiro, nome, cor |
| revisor | marca de terceiro e bloqueio | estética — não reprova por gosto |
| batizador | nome, identificador, descrição | julgamento visual |
| **tresd** | como a arte se lê no objeto curvo | a emenda no plano |

### Como conversam

Todo agente pode devolver `recados_para: [{para, assunto, pedido}]`. O recado
é gravado em `env.DB` com a **sessão** — a estampa em curso — e entregue ao
destinatário na próxima vez que ele rodar, dentro do prompt. Ele responde em
`atendi`, dizendo o que fez com cada um, inclusive discordar.

Lista vazia é resposta boa e comum: recado inventado atrapalha a mesa.

### O caso que mostra por que isso vale

O parâmetro de tolerância do recorte era um número no escuro. Eu descobri por
varredura que 60 falhava (o papel texturizado sobrevivia e a arte inteira
virava uma peça só) e que 90–120 funcionava; adotei 110 no braço.

O especialista em Fundo, olhando a mesma arte, respondeu **105** — e explicou:
*"papel com textura fibrosa fina e variação tonal moderada; 105 alcança a maior
parte da variação preservando pétalas e folhas muito claras."*

Na mesma resposta, mandou recado ao **revisor** sobre a marca `gocase` e o `A.`
que viu na arte. Não era área dele; não engoliu nem decidiu — passou adiante.
É esse o comportamento que a mesa existe para produzir.

## Um agente por pessoa

Cada agente é um bloco isolado em [`app/src/agentes.ts`](../app/src/agentes.ts).
Para mexer no seu, você edita só o seu bloco — nada ali depende do bloco de
ninguém, e não existe ordem de quem começa primeiro.

| Agente | Decide | Dono |
|---|---|---|
| Curador | quais estampas valem adaptar | |
| Leitor | se a arte pode ser separada em peças | |
| Compositor | tamanho, quantidade e respiro dos motivos | |
| Auditor | se o padrão pronto está bom (nota 0-10) | |
| Revisor | se tem logo, texto ou marca de terceiro | |
| Batizador | nome, SKU e descrição | |

Os donos são preenchidos direto no painel, não aqui.

## Ajustar um agente sem deploy

A instrução de cada agente é editável na tela e fica salva no banco. Você muda o
texto, clica em Rodar, vê a resposta, ajusta de novo. Só vale a pena passar para
o código quando a instrução estabilizar.

O que define a qualidade de um agente é essa instrução — não o modelo.

## AI Proxy

```
POST https://ai-proxy.gogroupbr.com/v1/chat/completions
Authorization: Bearer ${AI_PROXY_TOKEN}
```

Compatível com a API da OpenAI, aceita imagem, modelo padrão `gpt-5.5`.
Todo agente passa por `chamarAgente()` em
[`app/src/aiproxy.ts`](../app/src/aiproxy.ts) — um lugar só para autenticação,
tempo limite, JSON e medição.

Geração de **imagem** não é aqui: é o PIAPP, e só entra no caminho de reserva,
quando a arte é um fundo contínuo que não dá para recortar.

## A arte do catálogo vem suja — e isso muda o recorte

O preview que o catálogo serve **não é a estampa limpa**. Ele traz dois
elementos queimados no arquivo:

- a marca **gocase**, normalmente num canto
- uma **letra ou nome de exemplo** da personalização (ex.: `A.`)

Confirmado olhando o arquivo de `ramos-de-lavanda` no S3, e é o mesmo motivo
pelo qual o `gerador-de-adaptacoes` já pedia no prompt dele para "ignorar logos,
marcas d'água, monogramas e texto de personalização".

Isso tem uma consequência prática: o Leitor **não pode** tratar logo e texto
como bloqueio, senão trava 100% das estampas. Ele separa as duas coisas:

| | O que é | O que acontece |
|---|---|---|
| `elementos_a_remover` | marca da casa, letra de personalização, assinatura | some antes do recorte |
| `bloqueio_terceiro` | marca, personagem, escudo de time, obra de terceiro | para a esteira |
| `texto_na_arte` | frase ou lettering que faz parte do desenho | para a esteira |

O Leitor devolve **onde** cada elemento está, e o separador usa isso: peças
recortadas naquela região já vêm desligadas, marcadas com ⚠. Na lavanda, foi
assim que o `A.` da personalização saiu sozinho do padrão.

A região é grosseira de propósito — o Leitor descreve em palavras ("canto
superior direito"), então a sugestão pega motivos legítimos vizinhos junto. Por
isso ela apenas **desliga**, nunca apaga: quem confirma é o ilustrador, na
etapa 5.

## Rota generativa (PIAPP)

Padrão genérico documentado em [`docs/PIPELINE-VISAO-PROMPT-IMAGEM.md`](PIPELINE-VISAO-PROMPT-IMAGEM.md)
(reusável em qualquer app do Gogroup, não só aqui). Versão concreta desta base:

Quando o Leitor marca `separavel=false` — a arte é um fundo contínuo, sem
motivo isolável — não há o que recortar. A etapa 5 do Estúdio muda de rota:
em vez de `separar()` + `comporRapport()`, dois agentes de IA em cadeia
(`app/src/rotab.ts`) pedem um padrão novo ao PIAPP. É o mesmo padrão do app
`benchmark-mockups` (Giovanna/Ravenna, trazido em
[`integracoes/benchmark-mockups/`](../integracoes/benchmark-mockups/README.md)),
adaptado para reusar `chamarAgente()` em vez de `fetch` direto:

1. **Visão → prompt** (`gerarPromptRapport`): o AI Proxy olha a arte da case e
   descreve SÓ o padrão — ignora case, hardware, mockup, e a marca/letra de
   personalização queimadas no preview. Pede explicitamente um padrão
   contínuo, porque o destino é cilíndrico.
2. **Prompt → imagem** (`dispararGeracao` + `consultarJob`): o PIAPP gera a
   imagem como job assíncrono — dispara, guarda `job_id`, o cliente faz poll
   de 6 em 6s em `/api/rotab/status` até `completed`/`failed`. Nunca é uma
   chamada síncrona bloqueante.

A MESMA restrição negativa (sem texto, sem logo, sem hardware de case) é
reforçada nas duas etapas — um modelo generativo tende a "vazar" o produto de
origem mesmo com uma descrição limpa; a correção é redundância deliberada,
não confiar num só lugar.

A `output_url` que o PIAPP devolve é assinada e expira em cerca de 1h — por
isso, assim que o job completa, os bytes são baixados e persistidos em
`rotab_chunks` (fatiados em base64, abaixo do limite por linha do D1/SQLite).
`/api/rotab/imagem?id=` remonta os chunks e serve com cache longo; a
`output_url` do provedor nunca é exposta ao cliente.

**Isso é uma aposta, não uma garantia** — ao contrário do rapport
determinístico (que fecha por construção, erro zero), aqui a costura só é
descoberta depois. Por isso `medirCostura()` roda igual nas duas rotas, e a
Entrega mostra "emenda visível/invisível" nos dois casos. Requer o segredo
`PIAPP_TOKEN` (`setAppSecret`), além do `AI_PROXY_TOKEN` já usado pelos
agentes.
## O que os agentes erraram, e o que mudou

Cada refino abaixo veio de rodar o agente contra dado real e olhar a resposta.

| Agente | O que saiu errado | O que mudou no prompt |
|---|---|---|
| Compositor | devolveu `escala_motivos: 620` — pensou em pixel | dito que é **multiplicador de 0,6 a 1,8** |
| Batizador | devolveu `jardim-de-lavanda-termicos`, inventando slug a partir do nome novo e quebrando o vínculo com a capinha | o identificador vem de `estampa_origem`, **nunca** do nome criado |
| Auditor | reclamava de motivo cortado na lateral — que é justamente como o rapport funciona | dito que corte lateral **não é defeito**; corte em cima e embaixo é |
| Leitor | marcava `tem_logo` em toda estampa e travaria 100% | separa `elementos_a_remover` de `bloqueio_terceiro` |

Depois dos refinos, no padrão real de `ramos-de-lavanda`:

- **Auditor**: nota 6,2, reprovado — apontou corte na base, contraste de escala
  irregular, vazios competindo com aglomerados e a grade ficando visível. Os
  quatro conferem na imagem. Não reclamou das laterais.
- **Revisor**: aprovado, sem achados — a marca e o `A.` já tinham saído.

O corte na base era bug de código, não do agente: a grade ia até a borda. O
rapport ganhou margem vertical. Na horizontal não há margem de propósito — ali
o desenho continua do outro lado.
## Duas coisas verificadas que poupam tempo

1. **`gold.estampa_opportunity` está furada.** Parece feita pra isso, mas o
   índice é 0 em todas as linhas e a receita é uma constante. Use
   `gold.product_estampa_daily` + `gold.dim_estampa`.
2. **O nome segue padrão:** `<estampa>-case` ↔ `<estampa>-termicos`.

Detalhes técnicos do que já existe pronto para reusar: [MAPA-ATIVOS.md](MAPA-ATIVOS.md).
