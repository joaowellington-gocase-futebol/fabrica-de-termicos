# Trilhas de trabalho — 6 pessoas em paralelo

Seis trilhas desenhadas para não colidir: cada uma é dona de um diretório e de
um contrato. Ninguém edita o arquivo de outra trilha — se precisar de mudança,
abre issue no dono do contrato.

## Regra que destrava o paralelismo

Na **semana 1**, a T1 publica os contratos (tipos TypeScript) e um *stub* de
cada função. A partir daí as cinco trilhas trabalham contra os tipos, não
contra a implementação. Sem isso, cinco pessoas ficam esperando uma.

```
T1 publica contratos  ──►  T2 T3 T4 T5 T6 trabalham em paralelo
     (semana 1)                        (semana 2+)
```

---

## T1 · Arquitetura & Motor Gráfico — **João Wellington** (dono do projeto)

A espinha dorsal. É a trilha da qual todas as outras dependem, e a que exige
mais domínio de geometria — por isso fica com quem conhece o motor.

**Escopo**
- `src/core/tipos.ts` — todos os contratos (entregar na semana 1)
- `src/core/aiproxy.ts` — `chamarAgente()`: auth, timeout, retry, parse JSON,
  validação de schema, `agente_log`. **Nenhum agente chama `fetch` direto.**
- `src/core/separador.ts` — flood-fill de fundo sólido, componentes conexos
  (union-find), limpeza de ruído, recorte por bbox
- `src/core/rapport.ts` — porte de `layoutCompute`, `wrapOffsets`, `composeFrom`
- `src/core/fila.ts` — máquina de estados em `env.DB` + cron

**Entrega:** dado um PNG de case, sai um PNG 2754x2340 com rapport de costura
zero, sem nenhuma chamada de IA no caminho.
**Pronto quando:** `erro_costura_px == 0` em 10 estampas de teste.

## T2 · Dados & Curadoria — agente A1

**Escopo:** `src/estagios/curador.ts`, `src/estagios/resolvedor.ts`
- query sobre `gold.product_estampa_daily` + `dim_estampa` (o gap case→térmico)
- cascata Factory → Site → Catalog para achar o PNG em alta
- agente A1: ranking com racional, janela e risco

**Cuidado documentado:** não usar `gold.estampa_opportunity` — está furada
(`MAPA-ATIVOS.md` §6). Já custou meio dia de investigação; não repita.
**Pronto quando:** a fila enche sozinha toda manhã com candidatas válidas e
zero acessório (`cordao-para-case` e afins filtrados).

## T3 · Agentes de Visão — agentes A2 e A4

A trilha de maior alavancagem: o A2 roteia a esteira inteira.

**Escopo:** `src/agentes/leitor.ts`, `src/agentes/segmentacao.ts`,
`prompts/`, `evals/`
- schema JSON estrito + validação
- **conjunto de avaliação**: 30 estampas rotuladas à mão (separável sim/não,
  densidade, tem texto/logo). Sem esse conjunto não há como saber se um prompt
  melhorou ou piorou.

**Pronto quando:** o A2 acerta `separavel` em ≥90% das 30, e nunca deixa passar
`tem_logo` verdadeiro (recall 100% no que bloqueia — falso positivo aqui é
barato, falso negativo é caro).

## T4 · Qualidade & Compliance — agentes A5, A6 e A7

**Escopo:** `src/agentes/auditor.ts`, `colorista.ts`, `revisor.ts`, `testes/`
- A5: medição determinística de costura + julgamento visual
- A6: contraste da arte contra corpo branco/preto/azul
- A7: **trava dura** — logo, texto, marca, IP de terceiro

**Pronto quando:** o A7 tem recall 100% num conjunto de 20 artes com violação
plantada de propósito. Esta trilha é a que impede publicar produto errado.

## T5 · Interface & Fila — os 10% humanos

**Escopo:** `prototipo/` → `src/web/`
- fila visual com os estados da esteira
- card da estampa: original, recortes, rapport 3x1, mockup, render 3D
- aprovar / ajustar / reprovar em um clique
- painel do A10: resumo do dia, alertas, custo por estampa

**Pronto quando:** alguém aprova uma estampa de ponta a ponta sem abrir o
Photoshop e sem perguntar nada a ninguém.

## T6 · Cadastro & Integração — agentes A8 e A9

**Escopo:** `src/estagios/empacotador.ts`, `src/agentes/nomeador.ts`,
`redator.ts`
- nome + SKU + `engine_identifier = <estampa>-termicos`
- prefixo por licenciado (planilha do `nomeador-estampas`)
- mockup 2D (`tpl/garrafa-fresh-650.json`) e render no `.glb`
- gravação no destino de cadastro

**Pronto quando:** aprovar na fila gera o registro completo, sem digitação.

---

## Sequenciamento

| Semana | T1 | T2 | T3 | T4 | T5 | T6 |
|---|---|---|---|---|---|---|
| 1 | **contratos + stubs** | query do gap | rotular 30 estampas | rotular 20 violações | protótipo navegável | mapear cadastro |
| 2 | separador | resolvedor | A2 | A5 | fila real | A8 |
| 3 | rapport | A1 | A4 | A6 + A7 | card completo | A9 + mockup |
| 4 | fila + cron | ajustes | evals | evals | painel A10 | ponta a ponta |

## Contratos entre trilhas

| Contrato | Dono | Quem consome |
|---|---|---|
| `Camada {canvas, ox, oy, ow, oh, kind}` | T1 | T3, T4 |
| `LeituraEstampa` (JSON do A2) | T3 | T1, T4, T6 |
| `PlanoComposicao` (JSON do A3) | T3 | T1 |
| `ItemFila` + estados | T1 | T2, T5, T6 |
| `chamarAgente()` | T1 | T2, T3, T4, T6 |

Mudou contrato? PR no repo com revisão obrigatória do dono. Contrato quebrado
em silêncio é o que trava time de seis pessoas.

## Combinados

- branch por trilha: `t3/leitor-json-schema`
- todo agente novo entra com **eval** junto — prompt sem eval não é mensurável
- `agente_log` desde o primeiro dia: agente, modelo, tokens, latência, custo
- ninguém commita `AI_PROXY_TOKEN`; secrets só via `setAppSecret` do GoDeploy
