# Malha de agentes de IA — AI Proxy do Gogroup

Todos os agentes falam com `https://ai-proxy.gogroupbr.com/v1/chat/completions`
(OpenAI-compatible, com visão), `Authorization: Bearer ${AI_PROXY_TOKEN}`,
modelo `${AI_MODEL}` — padrão `gpt-5.5`.

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
                 "papel": "principal|secundario|ornamento" } ],
  "paleta": ["#8B7AA8"], "estilo": "aquarela botânica",
  "densidade": "baixa|media|alta",
  "tem_texto": false, "tem_logo": false,
  "rota_recomendada": "deterministica|generativa", "confianca": 0.86 }
```
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

Geração de imagem (rota generativa de reserva) **não** é AI Proxy: é PIAPP
(`seedream-v5-pro` / `flux-2-max-edit`), assíncrono via `job_id` + polling.

## Cliente único

Todo agente passa por um só helper, `chamarAgente(env, nome, mensagens, opts)`,
que centraliza auth, timeout, retry, parse de JSON, validação de schema e
`agente_log`. Nenhum estágio chama `fetch` no AI Proxy direto — é o que torna
possível trocar de modelo, medir custo e comparar prompt sem caçar código.
