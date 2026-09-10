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

## Duas coisas verificadas que poupam tempo

1. **`gold.estampa_opportunity` está furada.** Parece feita pra isso, mas o
   índice é 0 em todas as linhas e a receita é uma constante. Use
   `gold.product_estampa_daily` + `gold.dim_estampa`.
2. **O nome segue padrão:** `<estampa>-case` ↔ `<estampa>-termicos`.

Detalhes técnicos do que já existe pronto para reusar: [MAPA-ATIVOS.md](MAPA-ATIVOS.md).
