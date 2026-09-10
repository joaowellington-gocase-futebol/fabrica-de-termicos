# Fábrica de Térmicos

Esteira que pega uma estampa **best-seller de capinha** e a devolve pronta para
**garrafa térmica**, com o rapport já fechado — operada por dez agentes de IA no
AI Proxy do Gogroup.

Hoje a criação automática de estampas por IA só atende case. Cada adaptação para
térmico é manual: alguém abre o PSD, separa as camadas na mão, distribui na
máscara e confere a costura. Este projeto automatiza esse caminho e deixa para
a pessoa só a decisão final.

**Primeiro corte:** Garrafa Fresh 650ml — máscara `2754 × 2340 px`.

## O achado que define a arquitetura

O rapport **já está resolvido, e não é IA**. No `gerador-de-adaptacoes`:

```ts
wrapOffsets(mk, S) → [{ dx: -W }, { dx: +W }]
```

Cada camada é rasterizada três vezes (`x-W`, `x`, `x+W`). A costura fecha por
construção, com erro zero. Pedir "seamless" a um modelo generativo troca uma
garantia matemática por uma aposta — e ainda redesenha a arte que estava
vendendo.

Daí o princípio que organiza o repositório inteiro:

> **IA onde há julgamento. Determinístico onde há geometria.**

Os dez agentes decidem *o quê* compor e julgam o resultado. A geometria — recorte
e rapport — continua em código. É o que garante que a arte da best-seller chegue
no térmico preservada pixel a pixel.

O que faltava, e é a peça nova deste projeto, é a **entrada**: hoje o motor exige
um PSD com camadas separadas, feito à mão. O Separador produz essas camadas
sozinho, no mesmo formato que o `ag-psd` entrega — então o motor roda sem uma
linha de alteração.

## A esteira

```
0  Curador        SQL          top cases 90d sem <estampa>-termicos
1  Resolvedor     cascata      Factory → Site → Catalog → PNG em alta
2  A2 LEITOR      IA visão     JSON estruturado → roteia a esteira
3  Separador      determ.+A4   flood-fill + componentes conexos → camadas
4  Compositor     determ.      layoutCompute + wrapOffsets @ 2754×2340
5  A5 AUDITOR     IA visão     costura em px + nota 0-10
6  A6/A7          IA visão     cor do corpo + veto de marca
7  A8/A9          IA           nome, SKU, descrição, mockup, render 3D
8  Humano         os 10%       aprovar · ajustar · reprovar
```

Não é um agente conversacional grande: é uma **fila em `env.DB`** com um cron
avançando estados. O PIAPP é assíncrono, o Worker tem teto de CPU, e é preciso
reprocessar um item sem refazer o lote.

## Documentação

| Documento | O que traz |
|---|---|
| [docs/ORQUESTRACAO.md](docs/ORQUESTRACAO.md) | a esteira estágio a estágio, com a máquina de estados |
| [docs/AGENTES.md](docs/AGENTES.md) | contrato de entrada/saída de cada um dos 10 agentes |
| [docs/ORGANOGRAMA.md](docs/ORGANOGRAMA.md) | organograma das funções de IA (Mermaid) |
| [docs/EQUIPE.md](docs/EQUIPE.md) | as 6 trilhas de trabalho e o sequenciamento |
| [docs/MAPA-MENTAL.md](docs/MAPA-MENTAL.md) | mapa mental, dependências entre trilhas e os 5 marcos |
| [docs/MAPA-ATIVOS.md](docs/MAPA-ATIVOS.md) | levantamento do que já existe e pode ser reusado |

**Quadro da equipe (ao vivo):** https://quadro-termicos.devgogroup.com/ — mapa mental,
board com cards arrastáveis e edição das trilhas. Código em [`app/`](app/).

**Protótipo da esteira:** [`prototipo/index.html`](prototipo/index.html)

## Antes de escrever código, leia isto

Três coisas já verificadas que poupam dias:

1. **`gold.estampa_opportunity` está furada.** Parece feita exatamente para este
   projeto, mas `indice_transferencia` é 0 em todas as linhas,
   `receita_potencial_30d` é a constante `7.035.073`, e `estampa_key` vem com
   volumetria (`"880ml"`) no lugar do slug. Use
   `gold.product_estampa_daily` + `gold.dim_estampa`. Detalhes em
   [MAPA-ATIVOS.md §6](docs/MAPA-ATIVOS.md).
2. **A convenção de nomes é limpa:** `<estampa>-case` ↔ `<estampa>-termicos`.
   Detecção de gap e cadastro ficam determinísticos.
3. **As máscaras já existem em px reais**, vindas de `materials.width/height` do
   Factory. Não invente dimensão — a tabela está em
   [MAPA-ATIVOS.md §2](docs/MAPA-ATIVOS.md).

## AI Proxy

```
POST https://ai-proxy.gogroupbr.com/v1/chat/completions
Authorization: Bearer ${AI_PROXY_TOKEN}
```

OpenAI-compatible, com visão. Modelo padrão `gpt-5.5`.
Geração de **imagem** não passa por aqui — é o PIAPP (assíncrono, `job_id` +
polling), usado só na rota generativa de reserva.

Todo agente passa por `chamarAgente()` em `src/core/aiproxy.ts`: auth, timeout,
retry, parse de JSON, validação de schema e `agente_log`. **Nenhum estágio chama
`fetch` no AI Proxy direto** — é o que permite trocar de modelo, medir custo e
comparar prompt sem caçar código.

## Secrets

Nunca no repositório. Só via `setAppSecret` do GoDeploy.

```
AI_PROXY_TOKEN  AI_PROXY_URL  AI_MODEL
PIAPP_TOKEN     REMOVEBG_KEY  METABASE_TOKEN
PROXY_BASE_URL  (injetado pelo GoDeploy)
```

## Trilhas

Seis trilhas em paralelo, cada uma dona de um diretório e de um contrato.
Detalhe e sequenciamento em [docs/EQUIPE.md](docs/EQUIPE.md).

| Trilha | Escopo | Agentes |
|---|---|---|
| T1 · Arquitetura & Motor Gráfico | contratos, `chamarAgente`, separador, rapport, fila | — |
| T2 · Dados & Curadoria | query do gap, resolvedor de arte | A1 |
| T3 · Agentes de Visão | leitor e segmentação, prompts, evals | A2, A4 |
| T4 · Qualidade & Compliance | costura, cor, veto de marca | A5, A6, A7 |
| T5 · Interface & Fila | protótipo → produção, painel do A10 | — |
| T6 · Cadastro & Integração | nome, SKU, descrição, mockup, cadastro | A8, A9 |

Na semana 1 a T1 publica os contratos e os stubs; a partir daí as outras cinco
trabalham contra os tipos, não contra a implementação.

## Combinados

- branch por trilha: `t3/leitor-json-schema`
- todo agente novo entra **com eval** — prompt sem eval não é mensurável
- `agente_log` desde o primeiro dia: agente, modelo, tokens, latência, custo
- mudou contrato? PR com revisão do dono da trilha

## A métrica que decide o projeto

Quanto das best-sellers cai na rota determinística e quanto precisa da rota
generativa. É isso que define se o número é 90% ou 60% — e por isso `rota_usada`
e `nota_auditor` são gravados em toda linha da fila desde o primeiro dia.
