# Benchmark — Captura de Mockups (integração)

Cópia do app GoDeploy **`benchmark-mockups`** (id `0684e674`, dona
`ravenna.alencar@gocase.com`), trazida para dentro deste repositório em
2026-09-10 a pedido de Giovanna Gouvea (editora do app).

- App original (live): https://benchmark-mockups.devgogroup.com/
- Fonte trazida como está, sem modificação: [`src/server.ts`](src/server.ts) + [`index.html`](index.html)
- Este diretório **não é deployado** por conta própria — é referência congelada
  no momento da cópia. O app original continua rodando no GoDeploy normalmente;
  mudanças feitas aqui não voltam para lá automaticamente.

## O que o app faz

Dashboard de benchmark competitivo: faz scrape das coleções de best-sellers de
marcas concorrentes (Casetify, Shopify de outras marcas, catálogo próprio da
Gocase), gera um **prompt de recriação da estampa** via AI Proxy
(`generatePrompt`, `src/server.ts:510`) e depois gera uma imagem 9:16 a partir
só do prompt via **PIAPP** (`generateImage`, `src/server.ts:548` — `job_id` +
polling, exatamente o padrão descrito em `docs/AGENTES.md` para a rota
generativa). Tem fila de revisão manual (cadastrada / descartada) por estampa.

## Por que interessa à Fábrica de Térmicos

Não é o mesmo problema (aqui é benchmark de concorrência; a Fábrica adapta
best-seller **própria** de case para térmico), mas duas partes são
diretamente reaproveitáveis:

1. **`PROMPT_SYSTEM`** (`src/server.ts:57`) — prompt de sistema já testado em
   produção para descrever uma estampa a partir de imagem, útil como ponto de
   partida para o A2 (Leitor de Estampa) e para a rota B do Separador.
2. **`generateImage`** (`src/server.ts:548`) — implementação de referência do
   ciclo PIAPP `job_id` + polling + cache de bytes em chunks no `env.DB`, que é
   exatamente o mecanismo que a rota generativa de reserva do Estágio 3 vai
   precisar.

Antes de copiar trechos para dentro de `src/agentes/` ou `src/estagios/`:
adaptar para passar pelo `chamarAgente()` único (`src/core/aiproxy.ts`) em vez
de `fetch` direto — este app é anterior a essa convenção e chama o AI Proxy
sem o cliente único.
