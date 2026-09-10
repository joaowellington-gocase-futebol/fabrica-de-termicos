# Fábrica de Térmicos

Uma estampa que vende bem em capinha vira garrafa térmica, com o padrão já
fechado para dar a volta no objeto. Cinco agentes de IA decidem; o código cuida
da geometria.

**Painel dos agentes:** https://quadro-termicos.devgogroup.com/

Cada agente roda de verdade contra o AI Proxy do Gogroup, tem um dono e uma
instrução que dá para ajustar na tela, sem deploy.

## Começando

1. Abra o painel.
2. Escreva seu nome no agente que você vai cuidar.
3. Clique em **Rodar agora** — já vem com um exemplo real preenchido.
4. Abra **Instrução do agente**, mude o texto, rode de novo. É assim que melhora.

Um agente por pessoa, seis no total. Ninguém depende de ninguém para começar.

## O que tem aqui

| | |
|---|---|
| [`app/`](app/) | o painel e os agentes — é o que está no ar |
| [`app/src/agentes.ts`](app/src/agentes.ts) | os 6 agentes, um bloco cada |
| [`app/src/aiproxy.ts`](app/src/aiproxy.ts) | a chamada ao AI Proxy, num lugar só |
| [docs/COMO-FUNCIONA.md](docs/COMO-FUNCIONA.md) | a esteira e por que o rapport não é IA |
| [docs/MAPA-ATIVOS.md](docs/MAPA-ATIVOS.md) | o que já existe pronto pra reusar |
| [`prototipo/`](prototipo/) | como a tela de aprovação vai ficar |

## Ligar o AI Proxy

Os agentes só rodam com o segredo `AI_PROXY_TOKEN` configurado no app
(`setAppSecret`, nunca no código). Sem ele o painel avisa na primeira tela.

## Próximo passo

Rodar o **Leitor** nas estampas campeãs de capinha e contar quantas ele marca
como separáveis. Esse número diz o quanto da esteira roda sozinha — e é a única
pergunta que ainda não tem resposta.
