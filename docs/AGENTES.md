# Malha de agentes de IA — AI Proxy do Gogroup

Todos os agentes falam com `${AI_BASE_URL}/v1/chat/completions`
(OpenAI-compatible, com visão), `Authorization: Bearer ${AI_API_KEY}`,
modelo `${AI_MODEL}` — padrão `gpt-5.6-sol`.

> Os nomes de secret são `AI_API_KEY` / `AI_BASE_URL`, **não**
> `AI_PROXY_TOKEN` / `AI_PROXY_URL` como uma versão anterior desta doc dizia:
> seguem o que `buscador-de-estampas` e `trend-hunter` já usam em produção, para
> a mesma credencial servir os três apps. Ver `docs/ARQUITETURA.md`.

Convenção obrigatória para todo agente:

- resposta **sempre** em JSON (`response_format: {type:'json_object'}`)
- `temperature` baixa (0.2) em decisão; 0.7 só em criação de texto
- todo agente devolve `confianca` (0-1); abaixo do corte o item vai para humano
- toda chamada grava `agente`, `modelo`, `tokens`, `latencia_ms`, `custo` na
  tabela `agente_log` — sem isso não há como melhorar prompt depois
- timeout de 25s e falha suave: agente que cai não derruba a esteira, marca
  `falhou_<agente>` e segue

> **O que NÃO passa por IA:** o rapport. `wrapOffsets()` fecha a costura por
> construção (erro zero). A IA decide *o quê* compor e julga o resultado; a
> geometria continua determinística. É o que garante que a arte da best-seller
> chegue no térmico sem ser redesenhada.

---

## A1 — Analista de Portfólio  *(decide o que vale adaptar)*

O SQL traz números; este agente traz julgamento. Ele sabe o que a query não
sabe: que estampa de Natal não entra em setembro, que tema religioso converte
em térmico melhor que oncinha, que time fora de temporada pode esperar.

**Entrada:** top 50 cases da janela (estampa, tema, licença, unidades, receita,
`first_seen_at`), data de hoje, calendário sazonal, o que já existe em térmico.
**Saída:**
```json
{ "ranking": [ { "estampa_key": "...", "posicao": 1, "score": 0.92,
  "racional": "...", "janela_ideal": "imediata|30d|sazonal:novembro",
  "risco": "nenhum|licenca|sazonalidade|saturacao" } ],
  "descartadas": [ { "estampa_key": "...", "motivo": "..." } ], "confianca": 0.9 }
```

## A2 — Leitor de Estampa  *(visão — o roteador da esteira)*

Entende a estampa. É a saída dele que decide a rota de todo o resto.

**Entrada:** PNG da case em alta.
**Saída:**
```json
{ "tipo": "motivos_isolados|fundo_continuo|misto|composicao_central",
  "separavel": true,
  "fundo": { "tipo": "solido|textura|transparente", "cor": "#F2E8DC" },
  "motivos": [ { "nome": "ramo de lavanda", "contagem_aprox": 7,
                 "papel": "principal|secundario|ornamento",
                 "tamanho_relativo": 1.0 } ],
  "composicao": {
    "hierarquia": "uniforme|um_dominante|heroi_com_satelites|escalonada",
    "elemento_principal": "flor grande" ,
    "proporcao_maior_menor": 3.2,
    "arranjo": "grade|espalhado|agrupado|centralizado|moldura",
    "tem_orientacao": true },
  "paleta": ["#8B7AA8"], "estilo": "aquarela botânica",
  "densidade": "baixa|media|alta",
  "tem_texto": false, "tem_logo": false,
  "rota_recomendada": "deterministica|generativa", "confianca": 0.86 }
```

O bloco `composicao` é a **relação** entre os elementos, e não a lista deles.
Existe porque uma lista de motivos não distingue um padrão de iguais de um
desenho com um elemento herói cercado de satélites — e os dois viram
composições completamente diferentes na garrafa. É a entrada do critério 1 do
A11, e o `tamanho_relativo` de cada motivo é o que permite ao compositor
preservar a hierarquia em vez de achatar tudo no mesmo tamanho.

Detalhe de implementação que evita um erro comum: os recortes saem do separador
no tamanho **nativo** que tinham na arte original, então aplicar a mesma escala
a todos já preserva a proporção. O que destrói a hierarquia é *jitter* de escala
por motivo — por isso ele é ligado pela `hierarquia` lida, e desligado em arte
`uniforme`.

`tem_texto` / `tem_logo` são trava: texto e logo não podem entrar em rapport —
repetiriam a marca dando a volta na garrafa. Vão direto para a fila humana.

## A3 — Estrategista de Composição  *(design director)*

Recebe a leitura do A2 e a máscara alvo (2754x2340, razão 1,18:1) e escreve o
**plano** de composição. Antes isso era uma regra fixa densidade->estilo; virar
agente é o que permite tratar cada arte pelo que ela é.

**Saída:**
```json
{ "estilo": "stickers|linear|distribuido|localizada",
  "escala_motivos": 1.15, "densidade_alvo": 0.42,
  "motivos_promover": ["ramo-principal"], "motivos_descartar": ["respingo-01"],
  "rotacao_permitida": true, "margem_seguranca_pct": 4,
  "racional": "...", "confianca": 0.83 }
```

## A4 — Copiloto de Segmentação  *(visão — supervisiona o recorte)*

O recorte é determinístico (flood-fill + componentes conexos). O problema
clássico é a ilustração quebrar em pedaços: uma flor vira cinco pétalas soltas.
Este agente olha o contact-sheet dos recortes e conserta o agrupamento.

**Entrada:** contact-sheet numerado dos N recortes + bboxes.
**Saída:**
```json
{ "pecas": [ { "id": 3, "veredito": "motivo_valido|fragmento|ruido|duplicata",
               "funde_com": [4,5], "nome": "flor de lavanda" } ],
  "qualidade_recorte": 0.88, "refazer_com_tolerancia": null, "confianca": 0.85 }
```

## A5 — Auditor de Costura  *(visão + medição determinística)*

Camada 1, código: compara a faixa de 8px da borda esquerda com a da direita.
Na rota determinística o erro é 0 por construção — serve de teste de regressão.
Na rota generativa é o teste que de fato reprova.
Camada 2, visão: ladrilha 3x1 e julga.

**Saída:**
```json
{ "erro_costura_px": 0, "nota": 8.5,
  "problemas": ["motivo cortado ao meio na borda superior"],
  "veredito": "aprovado|ajustar|reprovado",
  "ajuste_sugerido": { "estilo": "distribuido", "escala": 0.9 }, "confianca": 0.9 }
```
Nota < 7 volta ao A3 com o ajuste. Duas reprovas -> fila humana.

## A6 — Colorista  *(visão — decisão comercial)*

A arte foi desenhada para o fundo branco de uma capinha. O térmico tem corpo
branco, preto ou azul. Este agente diz em qual corpo aquela estampa deve sair.

**Saída:**
```json
{ "recomendadas": [ { "cor_corpo": "branco", "contraste": 0.82, "nota": 9 } ],
  "reprovadas": [ { "cor_corpo": "preto", "motivo": "arte clara some" } ],
  "ajuste_paleta_sugerido": null, "confianca": 0.87 }
```

## A7 — Revisor de Marca  *(visão — trava de compliance)*

Última porta antes do humano. Procura logo, marca registrada, texto legível,
elemento licenciado que não pode repetir, e semelhança indevida com IP de
terceiro. Existe porque licenciamento é o risco caro deste projeto.

**Saída:**
```json
{ "aprovado": true, "achados": [ { "tipo": "logo|texto|ip_terceiro|marca",
  "onde": "canto inferior direito", "gravidade": "alta|media|baixa" } ],
  "bloqueia": false, "confianca": 0.93 }
```
`gravidade: alta` **bloqueia** a esteira, sempre. Sem exceção automática.

## A8 — Nomeador  *(já validado em produção)*

Reusa `sugerirNomesEstampa` do `gerador-de-adaptacoes` + a tabela de prefixo por
licenciado do `nomeador-estampas`. Emite `engine_identifier` =
`<estampa>-termicos`, seguindo a convenção verificada no catálogo.

## A9 — Redator de Catálogo  *(texto)*

Nome comercial, descrição, alt text e tags de busca para o cadastro.
Único agente com `temperature: 0.7`. Reusa `/api/copys` do gerador.

## A10 — Supervisor da Esteira  *(o maestro)*

Não toca arte. Lê o estado da fila e opera: prioriza, reprocessa falha
transitória, decide quando desistir e escalar para humano, detecta padrão de
erro repetido, e escreve o resumo diário.

**Saída:**
```json
{ "acoes": [ { "item_id": 42, "acao": "reprocessar|escalar|descartar",
               "motivo": "..." } ],
  "alerta": "3 reprovas seguidas de costura em artes de aquarela — revisar A3",
  "resumo_dia": "12 entraram, 9 automáticas, 3 na sua fila.", "confianca": 0.9 }
```
É este agente que faz a esteira parecer autônoma — e o que torna o número de
90% observável em vez de prometido.

## A11 — Juiz de Fidelidade  *(visão — a última porta antes do humano)*

Julga o RESULTADO contra a ARTE DE ORIGEM. É a diferença em relação ao A5: o A5
olha só o resultado e pergunta "esta arte está bem feita?"; o A11 olha os dois e
pergunta **"esta continua sendo a arte que vendia?"** — que é o que o projeto
promete.

Recebe duas imagens (a capinha original e o ladrilho 3x1 do térmico) e avalia
cinco critérios. **Três são MEDIDOS em código, não julgados:**

| # | critério | fonte | como |
|---|---|---|---|
| 1 | semelhança com a composição da capinha | julgado | compara elementos, hierarquia, arranjo, densidade e paleta |
| 2 | o rapport encaixa | **medido** | `medirCostura()` — linhas de descontinuidade na emenda |
| 3 | recorte dos elementos é coerente | julgado | fragmento, meia-flor, halo de fundo sobrando |
| 4 | respeita a resolução da case | **medido** | `medirAmpliacao()` — maior fator de ampliação aplicado a um recorte |
| 5 | respeita a margem da logo | **medido** | `medirInvasaoLogo()` — fração da zona proibida coberta por arte |

Para os medidos o modelo recebe o número e escreve só a observação; se
contradisser a medição, `consolidar()` sobrescreve. **Medição vence opinião.**

```json
{ "criterios": {
    "semelhanca_composicao": { "nota": 8.5, "fonte": "julgado", "observacao": "..." },
    "rapport":               { "nota": 10,  "fonte": "medido",  "observacao": "..." },
    "coerencia_recorte":     { "nota": 9,   "fonte": "julgado", "observacao": "..." },
    "resolucao":             { "nota": 9.2, "fonte": "medido",  "observacao": "..." },
    "margem_logo":           { "nota": 5,   "fonte": "medido",  "observacao": "NÃO VERIFICADO: ..." } },
  "nota_final": 8.7, "veredito": "aprovado|ajustar|reprovado",
  "problemas": [], "ajuste_sugerido": null, "medicao": { ... }, "confianca": 0.88 }
```

Pesos: semelhança 0,30 · rapport 0,25 · recorte 0,20 · resolução 0,15 ·
margem 0,10. Semelhança pesa mais porque é a promessa do projeto.

**Vetos independentes da média:** costura acima de 2px, ampliação acima de 2,0x
ou invasão da zona da logo reprovam sozinhas. Média serve para ler *quão bom*;
veto serve para decidir.

**Critério 5 e o dado que falta.** A margem da logo vem de
`factory materials.logo_pos_x/logo_pos_y/logo_size/logo_border_size`. Medido em
2026-09-10, essas colunas vêm **NULL** para todos os térmicos do primeiro corte
(fresh 650/950, flip pro, copo 470) e **zeradas** nos MagSafe; só as garrafas
Kids têm valor real. Quando o dado falta, o critério responde
**"NÃO VERIFICADO"** e sai do cálculo da média, com o peso redistribuído — em
vez de "aprovado". Um critério de compliance que passa por falta de dado é pior
que não existir.

Como o A7, **falha fechado**: se o A11 cair, o item não é aprovado.

---

## Tabela de alocação

| # | Agente | Tipo | Modelo | Temp. | Bloqueia? |
|---|---|---|---|---|---|
| A1 | Analista de Portfólio | texto | gpt-5.5 | 0.2 | não |
| A2 | Leitor de Estampa | visão | gpt-5.5 | 0.2 | sim (texto/logo) |
| A3 | Estrategista de Composição | texto | gpt-5.5 | 0.3 | não |
| A4 | Copiloto de Segmentação | visão | gpt-5.5 | 0.2 | não |
| A5 | Auditor de Costura | visão | gpt-5.5 | 0.2 | sim (nota<7) |
| A6 | Colorista | visão | gpt-5.5 | 0.2 | não |
| A7 | Revisor de Marca | visão | gpt-5.5 | 0.1 | **sim** |
| A8 | Nomeador | texto | gpt-5.5 | 0.5 | não |
| A9 | Redator de Catálogo | texto | gpt-5.5 | 0.7 | não |
| A10 | Supervisor | texto | gpt-5.5 | 0.2 | não |
| A11 | Juiz de Fidelidade | visão | gpt-5.5 | 0.2 | **sim** (veto medido) |

Geração de imagem (rota generativa de reserva) **não** é AI Proxy: é PIAPP
(`seedream-v5-pro` / `flux-2-max-edit`), assíncrono via `job_id` + polling.

## Cliente único

Todo agente passa por um só helper, `chamarAgente(env, nome, mensagens, opts)`,
que centraliza auth, timeout, retry, parse de JSON, validação de schema e
`agente_log`. Nenhum estágio chama `fetch` no AI Proxy direto — é o que torna
possível trocar de modelo, medir custo e comparar prompt sem caçar código.
