# Fábrica de Térmicos — orquestração de agentes

Escopo do primeiro corte: **Garrafa Fresh 650ml — máscara 2754x2340**.
Rota de separação: **determinística primeiro, IA de reserva**.

## Princípio de desenho

> IA onde há julgamento. Determinístico onde há geometria.

O rapport **nunca** passa por modelo generativo. `wrapOffsets()` desenha cada
camada em `x-W`, `x` e `x+W`: a costura fecha por construção, com erro zero.
Pedir seamless a um modelo é trocar uma garantia matemática por uma aposta.

A IA entra em três pontos, todos de julgamento: entender a estampa, auditar o
resultado e nomear. Nenhum deles toca a geometria.

## Máquina de estados (não é um agente conversacional)

A esteira é uma fila em `env.DB` (SQLite do GoDeploy). Cada candidata é uma
linha com `status`; um cron avança a fila. Cada estágio é idempotente e
reprocessável isoladamente.

```
candidata -> arte_ok -> lida -> separada -> composta -> auditada
          -> nomeada -> aguardando_aprovacao -> aprovada -> cadastrada
```
Falhas viram `falhou_<estagio>` com o motivo, sem travar a fila.

Por que fila e não chamada síncrona: o PIAPP é assíncrono (job_id + polling),
o Worker tem teto de CPU por requisição, e é preciso reprocessar um item sem
refazer o lote.

---

## Estágio 0 — Curador  *(SQL, sem IA)*

`curar(janela_dias, limite)` sobre `gold.product_estampa_daily` + `dim_estampa`.

- top cases da janela sem `<estampa>-termicos` publicado
- exclui `is_clear`, acessórios (`cordao-para-case`) e licenças bloqueadas
- score = unidades_case x fator de transferência do tema

Sem IA de propósito: é SQL, e SQL é auditável e reprodutível. Um LLM aqui só
adicionaria variância a uma pergunta que tem resposta exata.

> Não usar `gold.estampa_opportunity`: índice zerado e receita constante.
> Ver `MAPA-ATIVOS.md` seção 6.

**Saída:** `{estampa_key, nome, tema, licenca, unidades, receita}`

## Estágio 1 — Resolvedor de arte  *(sem IA)*

`resolverArte(estampa_key)` — cascata Factory -> Site -> Catalog
(`MAPA-ATIVOS.md` seção 4).

**Saída:** `{png_alta, material, engine_identifier}`

## Estágio 2 — Agente LEITOR  *(AI Proxy, visão)*  **[IA 1]**

O "entender a estampa" do teu pedido. Hoje `describeImage` devolve um parágrafo
solto — bom para prompt, inútil para decidir. Aqui ele passa a devolver JSON
estruturado, porque **esta saída é o roteador do pipeline**.

```json
{
  "tipo": "motivos_isolados | fundo_continuo | misto | composicao_central",
  "separavel": true,
  "fundo": { "tipo": "solido|textura|transparente", "cor": "#F2E8DC" },
  "motivos": [{ "nome": "ramo de lavanda", "contagem_aprox": 7, "papel": "principal" }],
  "paleta": ["#8B7AA8", "#F2E8DC"],
  "estilo": "aquarela botânica",
  "densidade": "baixa | media | alta",
  "tem_texto": false,
  "tem_logo": false,
  "rota_recomendada": "deterministica | generativa",
  "confianca": 0.86
}
```

`tem_texto`/`tem_logo` são trava de segurança: texto e logo não podem entrar em
rapport (repetiriam a marca ao redor da garrafa) — vão para a fila manual.

Modelo: `gpt-5.5` visão, `response_format` JSON, temperatura baixa.

## Estágio 3 — Separador de assets  *(determinístico + IA de reserva)*

O agente que "separa os assets dentro da capinha". **Peça nova do projeto.**

### Rota A — determinística (`separavel: true`)
1. **Remover fundo** — se `fundo.tipo == "solido"`, flood-fill por tolerância a
   partir das 4 bordas: exato e de graça. Se textura, cai no remove.bg
   (`REMOVEBG_KEY`, já integrado no `svg-to-ttf`).
2. **Rotular componentes conexos** no canal alpha (union-find).
3. **Limpar** — descarta ruído (< 0,1% do canvas) e funde fragmentos vizinhos
   por dilatação, para que uma flor não vire 5 pétalas soltas.
4. **Recortar** cada componente pela bbox em canvas próprio.

**Saída no mesmo formato que o `ag-psd` produz:** `{canvas, ox, oy, ow, oh, kind}`.

Esse é o pulo do gato: imitando a estrutura de camadas do PSD, o motor de
rapport que já existe roda sem uma linha de alteração. O agente substitui o PSD
manual, não o motor.

### Rota B — IA de reserva (`separavel: false`)
Arte de fundo contínuo (aquarela corrida, tie-dye) não tem o que separar.
PIAPP com o `buildPrompt(seg='termicos')` que já existe -> auditoria de costura
**obrigatória** no estágio 5, porque aqui o seamless deixa de ser garantido.

## Estágio 4 — Compositor de rapport  *(determinístico, código portado)*

`layoutCompute` + `wrapOffsets` + `composeFrom` do `gerador-de-adaptacoes`,
rodando em 2754x2340. O estilo sai da `densidade` que o Leitor mediu:

| densidade | estilo | função |
|---|---|---|
| baixa | distribuido | `fillGridNoOverlap(stagger)` |
| media | stickers | `autoCompute(fill, overlap)` |
| alta | linear | `fillGridNoOverlap` |

## Estágio 5 — Agente AUDITOR  *(determinístico + AI Proxy)*  **[IA 2]**

Camada 1, determinística: compara a faixa de 8px da borda esquerda com a da
direita. Na rota A o erro é 0 por construção — o teste serve de regressão, para
pegar quebra de código. Na rota B é o teste que de fato reprova.

Camada 2, visão: ladrilha 3x1 e pergunta ao modelo — costura visível? motivo
cortado ao meio? vazio grande? densidade irregular? Nota 0-10 + motivo.

Nota < 7 -> volta ao estágio 3 com ajuste (troca de estilo, escala). Duas
reprovas -> fila manual.

## Estágio 6 — Agente NOMEADOR  *(AI Proxy)*  **[IA 3]**

Reusa `sugerirNomesEstampa` + a tabela de prefixo por licenciado do
`nomeador-estampas`. Emite `engine_identifier = <estampa>-termicos`, seguindo a
convenção já verificada no catálogo.

## Estágio 7 — Empacotador  *(sem IA)*

- PNG de produção 2754x2340, fundo transparente
- mockup 2D via `tpl/garrafa-fresh-650.json` (`aprovacao-licenciamento`)
- render 3D no `garrafa-fresh-650.glb`, com UV cilíndrico gerado em runtime

## Estágio 8 — Aprovação humana  *(os 10%)*

Fila visual: aprovar / ajustar / reprovar. Aprovar dispara o cadastro.

---

## Alocação de modelos

| Agente | Modelo | Por quê |
|---|---|---|
| Leitor | `gpt-5.5` visão (AI Proxy) | JSON estruturado + leitura de composição |
| Auditor | `gpt-5.5` visão (AI Proxy) | comparação visual barata |
| Nomeador | `gpt-5.5` (AI Proxy) | texto curto, já validado em produção |
| Rota B | PIAPP `seedream-v5-pro` / `flux-2-max-edit` | edição com referência |

Custo por estampa — rota A: 2 chamadas de visão. Rota B: + US$ 0,05-0,09.

## Secrets

`AI_PROXY_TOKEN`, `AI_PROXY_URL`, `AI_MODEL`, `PIAPP_TOKEN`, `REMOVEBG_KEY`,
`PROXY_BASE_URL` (injetado), `METABASE_TOKEN`.

## Incerteza a medir na v1

Qual fatia das best-sellers cai na rota A e qual na B. Isso decide se o número
é 90% automatizado ou menos. É a primeira métrica a instrumentar: gravar
`rota_usada` e `nota_auditor` em toda linha da fila desde o dia 1.
