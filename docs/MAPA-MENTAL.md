# Mapa mental — como é feito e quem faz

Versão navegável e editável: **https://quadro-termicos.devgogroup.com/**
(o app mostra o progresso vivo de cada trilha, vindo dos cards).

```mermaid
mindmap
  root(("Fábrica<br/>de Térmicos"))
    ("COMO É FEITO<br/>a esteira")
      ("0 · Curador<br/>SQL · top cases sem térmico")
      ("1 · Resolvedor<br/>Factory → Site → Catalog")
      ("2 · A2 Leitor 👁<br/>roteia a esteira")
      ("3 · Separador<br/>componentes conexos + A4")
      ("4 · Compositor<br/>wrapOffsets · costura 0 px")
      ("5 · A5 Auditor 👁<br/>nota 0-10")
      ("6 · A6 · A7 👁<br/>cor do corpo · veto de marca")
      ("7 · A8 · A9<br/>nome, SKU, descrição")
      ("8 · Aprovação<br/>os 10% humanos")
    ("QUEM FAZ<br/>6 trilhas")
      ("T1 · Arquitetura & Motor<br/>João Wellington")
        ("contratos + chamarAgente")
        ("separador determinístico")
        ("porte do rapport")
        ("fila + cron")
      ("T2 · Dados & Curadoria<br/>A1")
        ("query do gap")
        ("resolvedor de arte")
      ("T3 · Agentes de Visão<br/>A2 · A4")
        ("30 estampas rotuladas")
        ("prompts + evals")
      ("T4 · Qualidade<br/>A5 · A6 · A7")
        ("20 violações plantadas")
        ("veto de marca")
      ("T5 · Interface & Fila<br/>A10")
        ("fila real")
        ("aprovar em 1 clique")
      ("T6 · Cadastro<br/>A8 · A9")
        ("nome, SKU, descrição")
        ("mockup + render")
```

## Como seis pessoas trabalham ao mesmo tempo

O paralelismo não vem de dividir tarefas — vem de dividir **contratos**.

```mermaid
flowchart LR
    T1["<b>T1 · semana 1</b><br/>publica tipos + stubs"]
    T1 --> T2["T2 · Dados"]
    T1 --> T3["T3 · Visão"]
    T1 --> T4["T4 · Qualidade"]
    T1 --> T5["T5 · Interface"]
    T1 --> T6["T6 · Cadastro"]
    T2 & T3 & T4 & T5 & T6 --> INT["semana 4<br/>ponta a ponta"]

    classDef a fill:#0E6E6E,stroke:#0A5252,color:#fff
    classDef b fill:#E0F2FE,stroke:#0284C7,color:#0C4A6E
    classDef c fill:#141B1E,stroke:#000,color:#fff
    class T1 a
    class T2,T3,T4,T5,T6 b
    class INT c
```

Cada trilha é dona de um diretório e de um contrato. Ninguém edita o arquivo de
outra: se precisar de mudança, abre PR com revisão do dono. Contrato quebrado em
silêncio é o que trava um time de seis.

| Contrato | Dono | Consumido por |
|---|---|---|
| `Camada {canvas, ox, oy, ow, oh, kind}` | T1 | T3, T4 |
| `LeituraEstampa` (JSON do A2) | T3 | T1, T4, T6 |
| `PlanoComposicao` (JSON do A3) | T3 | T1 |
| `ItemFila` + estados | T1 | T2, T5, T6 |
| `chamarAgente()` | T1 | T2, T3, T4, T6 |

## Marcos que destravam outra trilha

Estes cinco cards estão marcados como **marco** no board — atrasar um deles
para alguém, não só quem o executa:

1. **T1 · contratos e stubs** (semana 1) — destrava as outras cinco
2. **T3 · 30 estampas rotuladas** (semana 1) — sem isso não há como medir prompt
3. **T4 · 20 violações plantadas** (semana 1) — sem isso o veto do A7 é cego
4. **T1 · porte do rapport** (semana 3) — sem isso T5 não tem o que mostrar
5. **T6 · cadastro ponta a ponta** (semana 4) — fecha o ciclo
