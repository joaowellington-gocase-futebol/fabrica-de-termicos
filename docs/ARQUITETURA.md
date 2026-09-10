# Arquitetura de execução — o que a plataforma impõe

Este documento existe porque **três restrições do GoDeploy contradizem o desenho
original** descrito em `ORQUESTRACAO.md`. Nenhuma é contornável com esforço; as
três mudam onde o código roda. Ler antes de mexer na esteira.

No fim há um quarto achado, de outra natureza: a margem de segurança da logo
Gocase **não está cadastrada** no Factory para os térmicos deste projeto.

Levantado em 2026-09-10, contra a plataforma real.

---

## 1. O worker não tem Canvas API — a geometria roda no browser

O runtime é Cloudflare Workers: sem `canvas`, sem `OffscreenCanvas`, e com
orçamento de CPU **compartilhado** com os outros apps do gateway. Uma composição
em 2754×2340 são 6,4 milhões de pixels; decodificar o PNG de entrada e
rasterizar isso em JS puro estoura o teto por requisição.

Não é uma limitação nova do projeto: é onde o `gerador-de-adaptacoes` já faz
esse trabalho hoje — `ag-psd.js` e canvas, **no browser**.

### Consequência

| runtime | o que faz |
|---|---|
| **worker** | fila, estados, os 10 agentes do AI Proxy, curadoria, resolução de arte, `agente_log`, aprovação. **Nunca toca pixel.** |
| **browser** | separador (flood-fill + componentes conexos) e rapport (`layoutCompute`, `wrapOffsets`, `composeFrom`), e as três medições do A11: costura, ampliação e invasão da zona da logo. `src/web/motor.js`. |

O browser não é "o cliente": é um **executor da esteira**. Enquanto o botão
_Ligar motor gráfico_ está ativo, a aba reivindica itens parados em `planejada`,
roda a geometria e devolve o resultado medido.

**Sem uma aba com o motor ligado, a esteira anda até `planejada` e para ali.**
Isso está dito no painel (`N esperando o motor`) e em `/api/health`.

### O que isso não muda

A garantia do rapport. `wrapOffsets` continua desenhando cada camada em `x-W`,
`x` e `x+W`, e a costura continua fechando por construção com erro zero. Mudou
onde o `drawImage` acontece, não a matemática.

### Por que não guardar o PNG de produção

O pipeline é determinístico: o separador não tem aleatoriedade e o layout usa
PRNG semeado pelos próprios parâmetros do plano. Rodar de novo no mesmo item dá
o mesmo pixel. Então o PNG 2754×2340 é **regenerado on demand** em vez de
ocupar o SQLite (que tem teto de 2 MB por linha). Só os previews leves — WebP,
até ~900px — ficam gravados, e é deles que os agentes de visão se alimentam.

---

## 2. O proxy de dados autentica pelo cookie do visitante — o cron não cura

`env.PROXY_BASE_URL` é **somente leitura**, e a autorização é o cookie de sessão
Google do visitante, repassado pelo worker. Duas consequências:

### 2a. Existe SQL — mas com um teto silencioso

Correção de uma versão anterior deste documento: o proxy **aceita SQL**, via
`POST /{db}/_query` com `{sql}`. A primeira versão de `dados.ts` usava a
interface PostgREST (`GET /{db}/{schema}.{tabela}`) e agregava no worker por
supor que não havia `GROUP BY` — desnecessário. O padrão de SQL é o que o
`mockup-studio` já usa em produção.

O que **é** verdade e continua importando: o proxy **corta a resposta em 1000
linhas sem avisar**. Toda consulta que pode passar disso precisa de agregação ou
de paginação com ordenação total — senão a resposta chega incompleta em
silêncio. A "query do gap" é resolvida em duas consultas agregadas (uma no
datamart, uma no factory) com o anti-join feito no worker, porque o datamart não
conhece a tabela `products`.

### 2b. O cron não tem cookie

Uma chamada de cron chega com `X-Godeploy-Cron`, **sem cookie de sessão**. Logo:

> **A fila não se enche sozinha às 6h da manhã.** Ela se enche quando alguém
> logado clica em _Encher a fila_ — e daí em diante anda sozinha.

Isso contradiz diretamente o critério de pronto da T2 ("a fila enche sozinha
toda manhã"). O cron avança tudo o que depende só do AI Proxy, que usa secret e
não cookie: A2, A3, A5, A6, A7, A8, A9.

**O que destravaria:** uma credencial de serviço para o datamart
(`METABASE_TOKEN` ou equivalente) que não dependa de sessão de visitante. Hoje
não existe configurada. Até existir, a curadoria é o único estágio com humano
obrigatório na entrada.

---

## 3. Não há cron trigger dentro do worker

O worker é HTTP-only: sem `scheduled()`, sem `setInterval`, sem fila de
consumidor. O agendamento é da **plataforma**, via `createCronJob`, que faz um
`POST` numa rota comum do app.

Por isso a esteira é `POST /tasks/tick` e não um handler agendado.

Um detalhe que custou três deploys: `X-Godeploy-Cron` é uma **assinatura**
derivada da chave, não a chave em texto, e a plataforma injeta
`GODEPLOY_CRON_KEY` sozinha. Comparar o header com a chave devolve 403 ao
próprio cron do gateway. O que dá para verificar é a **presença** do header — o
gateway remove qualquer `x-godeploy-*` que venha de fora antes de despachar.

Cada tick avança **no máximo 6 itens**. O teto existe porque cada estágio pode
custar duas chamadas de visão e o orçamento de CPU/tempo é por requisição —
melhor avançar 6 itens a cada 5 minutos que estourar tentando avançar 60.

---

## Estados e quem executa cada transição

```
candidata ──[worker + cookie]──► arte_ok ──[worker A2]──► lida
                                              │
                                              ├─ tem_texto/tem_logo → bloqueado_leitor
                                              └─ confiança < 0,6    → aguardando_aprovacao

lida ──[worker A3]──► planejada ──[BROWSER: separador + rapport + medições]──► composta
                          ▲                                                       │
                          │                                               [worker A5]
                          │                                                       │
                          │                                              auditada │
                          │                                                       │
                          │                                              [worker A11]
                          │                                                       │
                          └────── nota < 7 (até 2x) ◄──────── julgada ◄───────────┘
                                                                │
                                                  [worker A6, A7, A8, A9]
                                                                │
                                       bloqueado_marca ◄────────┴───► aguardando_aprovacao
                                                                             │
                                                                        [HUMANO]
                                                                             │
                                                              aprovada / reprovada
```

O A11 roda **depois** do A5 e **antes** do A6/A7/A8/A9: é caro gerar cor, copy e
nome de uma arte que não passa de fidelidade. E as medições que ele consome
(costura, ampliação, invasão da logo) são calculadas pelo BROWSER e gravadas na
coluna `medicao` — quem mede e quem julga são runtimes diferentes, em
requisições diferentes.

Falha em qualquer estágio vira `falhou_<estagio>` com o motivo, sem travar a
fila. `POST /api/item/:id/reprocessar` devolve o item ao estado anterior ao erro.

---

## Nomes de secret: o que a doc dizia e o que a plataforma usa

`ORQUESTRACAO.md` fala em `AI_PROXY_TOKEN` e `AI_PROXY_URL`. Os apps que **já
rodam em produção** (`buscador-de-estampas`, `trend-hunter`) usam:

| secret | uso |
|---|---|
| `AI_API_KEY` | Bearer do AI Proxy |
| `AI_BASE_URL` | base; o cliente concatena `/v1/chat/completions` |
| `AI_MODEL` | opcional; padrão `gpt-5.6-sol` |

Seguimos o que existe, para a mesma credencial servir os dois apps. `PIAPP_TOKEN`
e `REMOVEBG_KEY` seguem os nomes originais. `PROXY_BASE_URL` e
`GODEPLOY_CRON_KEY` são injetados pela plataforma.

Um detalhe do proxy que já custou depuração em outro app e está tratado em
`chamarAgente()`: o nome do campo de limite de tokens divergiu entre gerações da
API OpenAI (`max_tokens` virou `max_completion_tokens`). O cliente tenta o nome
novo e, se o servidor reclamar do parâmetro, repete com o antigo.

---

## Travas que não devem ser "otimizadas" depois

1. **A7 falha fechado.** Se o revisor de marca cair, o item é bloqueado, não
   liberado (`bloqueioPorFalha`). Um agente de compliance que falha aberto não é
   trava. `gravidade: alta` bloqueia sempre, sem limiar de confiança que libere.
2. **Medição vence opinião.** `consolidar()` rebaixa a nota do A5 quando a
   costura medida passa do teto, mesmo que o modelo tenha dado 9.
3. **O A10 não descarta.** `acoesExecutaveis()` converte `descartar` em
   `escalar`, preservando o motivo, para uma pessoa bater o martelo.
4. **`engine_identifier` não passa por IA.** `<estampa>-case` →
   `<estampa>-termicos` é transformação de string com resposta exata.
5. **As chaves vindas do A1 são validadas contra o que foi enviado.** Sem esse
   cerco o modelo alucina uma `estampa_key` plausível e a falha aparece três
   estágios adiante, longe da causa.
6. **O A11 falha fechado, e três dos cinco critérios dele são medidos.** O
   modelo recebe o número e escreve a observação; se contradisser a medição,
   `consolidar()` sobrescreve.
7. **Critério de compliance sem dado responde "não verificado", nunca
   "aprovado".** Vale hoje para a margem da logo — ver abaixo.

---

## A margem da logo não está no Factory (medido em 2026-09-10)

A intenção era ler de `factory materials` onde a logo Gocase fica e qual a folga
dela em cada térmico. As colunas existem — `logo_pos_x`, `logo_pos_y`,
`logo_size`, `logo_border_size` — mas para os materiais deste projeto **os dados
não estão lá**:

| material | logo_pos_x/y | logo_size | applies_custom_logo |
|---|---|---|---|
| `*-garrafafresh650` / `950` | NULL | NULL | false |
| `*-garrafapro750ml` (flip pro) | NULL | NULL | false |
| `*-copocerveja470` | NULL | NULL | false |
| `*-garrafamagsafe750` | **0** | **0** | false |
| `*-garrafakids460` | 1184 / 1303 | 412 (borda 199) | false |

De 11.109 materiais, 3.047 têm `logo_pos_x`; dos térmicos, 102 — e desses, a
maioria com zeros. As únicas linhas com valor real são as garrafas Kids.

O `grid_mask` / `preview_mask` do material é uma **imagem** (a silhueta do
mockup), não um número: serve para renderizar prévia, não para delimitar área
segura de impressão.

**Como o código trata isso.** `zonaLogo()` em `core/dados.ts` é o mecanismo
completo, pronto para o dia em que o cadastro for preenchido: quando há valor,
devolve o retângulo proibido (a logo dilatada por `logo_border_size`), o motor
descarta as colocações que caem ali e o A11 mede a invasão. Quando não há,
devolve `{ disponivel: false, motivo }`, o critério 5 responde
**"NÃO VERIFICADO"** com o motivo, sai do cálculo da média e o problema aparece
na lista do card.

**O que destrava:** preencher `logo_pos_x/y`, `logo_size` e `logo_border_size`
dos materiais de térmico no Factory. Feito isso, nada precisa mudar no código.
