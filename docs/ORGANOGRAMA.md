# Organograma das funções de IA

Dez agentes no AI Proxy, organizados em quatro diretorias sob um supervisor.
A leitura é hierárquica: o **A10 Supervisor** não executa arte — ele opera a
esteira e é o único que enxerga o estado global.

```mermaid
flowchart TD
    A10["<b>A10 · SUPERVISOR DA ESTEIRA</b><br/>prioriza · reprocessa · escala · resume"]

    A10 --> D1["<b>DIRETORIA DE DEMANDA</b><br/>o que vale adaptar"]
    A10 --> D2["<b>DIRETORIA DE LEITURA</b><br/>o que a arte é"]
    A10 --> D3["<b>DIRETORIA DE CRIAÇÃO</b><br/>como vira térmico"]
    A10 --> D4["<b>DIRETORIA DE QUALIDADE</b><br/>pode ir pro catálogo?"]

    D1 --> A1["A1 · Analista de Portfólio<br/><i>ranking + janela + risco</i>"]
    D2 --> A2["A2 · Leitor de Estampa 👁<br/><i>ROTEIA a esteira</i>"]
    D3 --> A3["A3 · Estrategista de Composição<br/><i>plano: estilo, escala, densidade</i>"]
    D3 --> A4["A4 · Copiloto de Segmentação 👁<br/><i>funde fragmentos, descarta ruído</i>"]
    D4 --> A5["A5 · Auditor de Costura 👁<br/><i>nota 0-10 · reprova</i>"]
    D4 --> A6["A6 · Colorista 👁<br/><i>em qual corpo sai</i>"]
    D4 --> A7["A7 · Revisor de Marca 👁<br/><i>TRAVA DURA</i>"]
    D4 --> A8["A8 · Nomeador<br/><i>nome + SKU</i>"]
    D4 --> A9["A9 · Redator de Catálogo<br/><i>descrição + tags</i>"]

    A7 -.->|gravidade alta| STOP(["🛑 bloqueia · humano"])
    A5 -.->|nota < 7| A3
    A2 -.->|texto ou logo| STOP

    classDef sup fill:#1e293b,stroke:#0f172a,color:#fff
    classDef dir fill:#334155,stroke:#1e293b,color:#fff
    classDef ag  fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
    classDef stop fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    class A10 sup
    class D1,D2,D3,D4 dir
    class A1,A2,A3,A4,A5,A6,A7,A8,A9 ag
    class STOP stop
```

👁 = agente de visão (recebe imagem).

## Onde cada agente entra na esteira

```mermaid
flowchart LR
    S0["0 · Curador<br/>SQL"] --> A1
    A1 --> S1["1 · Resolvedor<br/>Factory→Site→Catalog"]
    S1 --> A2
    A2 -->|separável| A3
    A2 -->|fundo contínuo| GEN["rota reserva<br/>PIAPP"]
    A3 --> SEP["3 · Separador<br/><b>determinístico</b>"]
    SEP --> A4
    A4 --> COMP["4 · Compositor<br/><b>wrapOffsets · erro 0</b>"]
    GEN --> COMP
    COMP --> A5
    A5 --> A6 --> A7 --> A8 --> A9
    A9 --> FILA["8 · Fila humana<br/>os 10%"]

    classDef ia fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
    classDef det fill:#dcfce7,stroke:#16a34a,color:#14532d
    class A1,A2,A3,A4,A5,A6,A7,A8,A9 ia
    class S0,S1,SEP,COMP det
```

Verde = determinístico. Azul = agente de IA.
A geometria (Separador e Compositor) é verde de propósito: é o que garante
costura com erro zero e a arte da best-seller preservada pixel a pixel.

## Divisão de responsabilidade

| Diretoria | Agentes | Pergunta que responde | Falha custa |
|---|---|---|---|
| Demanda | A1 | vale adaptar esta estampa? | esforço em arte que não vende |
| Leitura | A2 | o que esta arte é? | rota errada, retrabalho em cascata |
| Criação | A3, A4 | como ela vira térmico? | estampa feia, reprovada no A5 |
| Qualidade | A5-A9 | pode ir pro catálogo? | **produto errado publicado** |

O A7 (Revisor de Marca) é o único com poder de veto absoluto: `gravidade: alta`
bloqueia sempre, sem exceção automática. Licenciamento é o risco caro aqui.
