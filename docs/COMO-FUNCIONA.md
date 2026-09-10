# Como funciona

## A esteira

Uma estampa de capinha vira garrafa térmica passando por oito passos.
Cinco são agentes de IA; três são código.

```
Curador      IA      escolhe o que adaptar
Leitor       IA      olha a arte e diz se dá pra separar
Compositor   IA      decide como distribuir na garrafa
Recorte      código  separa os motivos da arte
Rapport      código  fecha a costura
Auditor      IA      dá nota no resultado
Revisor      IA      barra logo, texto e marca de terceiro
Batizador    IA      nome, SKU e descrição
```

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

## Duas coisas verificadas que poupam tempo

1. **`gold.estampa_opportunity` está furada.** Parece feita pra isso, mas o
   índice é 0 em todas as linhas e a receita é uma constante. Use
   `gold.product_estampa_daily` + `gold.dim_estampa`.
2. **O nome segue padrão:** `<estampa>-case` ↔ `<estampa>-termicos`.

Detalhes técnicos do que já existe pronto para reusar: [MAPA-ATIVOS.md](MAPA-ATIVOS.md).
