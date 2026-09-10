# Blueprint: Pipeline "Scrape → Visão → Prompt → Geração de Imagem"

> Template genérico extraído da arquitetura do app `benchmark-mockups` (Gogroup), com nomes/serviços trocados por placeholders para reuso em qualquer projeto novo. Troque cada `<PLACEHOLDER>` pelo equivalente do seu stack.
>
> Aplicado nesta base em `app/src/rotab.ts` (rota generativa do Separador) — ver [`docs/COMO-FUNCIONA.md`](COMO-FUNCIONA.md#rota-generativa-fundo-contínuo---piapp) para a versão concreta, com os placeholders já preenchidos (AI Proxy do Gogroup + PIAPP).

## 1. Quando usar esse padrão

Você tem imagens de referência (fotos de produto, mockups, prints) e quer **gerar uma versão nova/própria só do elemento de interesse** (a arte, o padrão, o estilo) sem herdar o resto da imagem de origem (produto, moldura, marca, hardware, fundo). Nunca gere direto a partir da imagem de referência — separe em duas etapas de IA.

## 2. Arquitetura em 5 blocos

```
[1] Coleta de referências  →  [2] Visão → prompt textual  →  [3] Prompt → imagem (job assíncrono)
                                                                        │
[5] Serving com cache  ◀──  [4] Download + persistência própria dos bytes
```

| Bloco | Papel | Serviço possível |
|---|---|---|
| 1. Coleta | obter imagens de referência + metadados (posição, url de origem) | scraping (headless browser), API pública, upload manual |
| 2. Visão → prompt | descrever *só* o elemento de interesse, em texto | qualquer LLM com visão (Claude, GPT-4V/5, Gemini) |
| 3. Prompt → imagem | gerar a arte nova a partir do texto | Flux, Midjourney API, GPT Image, Ideogram, Replicate, fal.ai |
| 4. Persistência | baixar bytes e guardar você mesmo (URLs de provedor expiram) | S3/blob storage, ou banco com chunking se não houver blob |
| 5. Serving | servir com cache longo, dedup por chave estável | rota HTTP própria |

## 3. Variáveis de ambiente (template)

```
SCRAPE_BACKEND_URL, SCRAPE_BACKEND_TOKEN    # serviço de headless browser (se precisar de JS/lazy-load)
VISION_LLM_URL, VISION_LLM_TOKEN, VISION_LLM_MODEL   # provedor de visão (etapa 2)
IMAGE_GEN_URL, IMAGE_GEN_TOKEN               # provedor de geração de imagem (etapa 3)
WEBHOOK_URL, WEBHOOK_KEY                     # opcional: log externo (planilha, Slack, etc.)
```

## 4. Etapa 1 — Coleta de referências

Regra prática: **cada fonte pode precisar de uma estratégia diferente** — não force um scraper único.

- Se a fonte expõe uma API pública/JSON (ex.: `/products.json` do Shopify): `fetch` direto, sem headless browser. Mais barato e rápido — prefira sempre que possível.
- Se a página depende de JS renderizado no client: rode um script dentro de um serviço de headless browser (Browserless, Playwright/Puppeteer como serviço), com:
  - viewport fixo,
  - scroll até o lazy-load terminar,
  - filtro para descartar thumbnails minúsculas e forçar a versão em alta resolução,
  - **retry com backoff** (2–3 tentativas), guardando sempre a melhor captura obtida — serviços de headless browser em dyno único são intermitentes (500/502/timeout).
- Dedup na captura por uma **chave estável** (ex. `product_url`), nunca pela URL da imagem/CDN — querystrings de render (tamanho, lazy-load) variam a cada load e quebram o dedup se você usar `image_url` como chave.
- Ao reconciliar uma nova captura com o que já existe: **preserve** o que já foi decidido/aprovado/processado (não regenere prompt/imagem de itens que não mudaram) e não deixe itens já revisados voltarem pro pool.

## 5. Etapa 2 — Visão → prompt textual

Chamada padrão (formato compatível OpenAI, funciona com a maioria dos provedores de visão):

```ts
const res = await fetch(VISION_LLM_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${VISION_LLM_TOKEN}` },
  body: JSON.stringify({
    model: VISION_LLM_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
          { type: 'text', text: 'Write the image-generation prompt for the <ELEMENTO_DE_INTERESSE> in this image, following the rules.' },
          { type: 'image_url', image_url: { url: referenceImageUrl } }, // vision-by-URL: evita mandar base64 se a imagem já é pública
      ]},
    ],
  }),
});
const prompt = (await res.json()).choices?.[0]?.message?.content?.trim();
```

### Template de system prompt (a parte que realmente importa)

O ponto crítico não é dizer o que descrever — é dizer **o que ignorar explicitamente**:

```
You are an expert prompt engineer for text-to-image models.
You are shown <TIPO_DE_IMAGEM_DE_REFERENCIA>. Describe ONLY <ELEMENTO_DE_INTERESSE>.
Completely ignore <TUDO_QUE_NAO_E_O_ELEMENTO: produto/moldura/fundo/mão/reflexo/etc>.
<REGRA_DE_HARDWARE_OU_RUIDO_ESPECIFICO_DO_SEU_DOMINIO — ex.: "elementos X são hardware físico,
não parte do design; nunca os descreva ou reproduza; imagine o design continuando uniformemente
por baixo deles">.
Return ONE single rich, detailed English prompt (no preamble, no markdown, no quotes, 60-120 words)
covering: tema/assunto, estilo, composição, elementos-chave, paleta de cor, textura, técnica, humor.
CRITICAL: exclude ALL text, letters, words, numbers, brand names, logos, watermarks and signatures —
never describe or include them.
Never mention <O_QUE_NAO_PODE_APARECER_NA_DESCRICAO: produto/mockup/marca>.
```

Cacheie o prompt resultante por item (não regere à toa — cada chamada custa dinheiro e tempo).

## 6. Etapa 3 — Prompt → imagem (job assíncrono)

**Nunca trate geração de imagem como chamada síncrona.** Use o padrão dispara→id→poll:

```ts
// reforço redundante da MESMA restrição do system prompt da etapa 2 — não confie em um só lugar
const genPrompt = `${prompt}

Important: <REFORCO_DA_MESMA_REGRA_NEGATIVA_DA_ETAPA_2, escrito de novo, de outro jeito>.`;

// 1) dispara o job
const { job_id } = await fetch(`${IMAGE_GEN_URL}/generate-image`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${IMAGE_GEN_TOKEN}` },
  body: JSON.stringify({ prompt: genPrompt, aspect_ratio: '<FORMATO_FINAL, ex: 9:16 ou 1:1>' }),
}).then(r => r.json());
// -> persista job_id + status='queued' associado ao item

// 2) poll (chamado de novo periodicamente, pelo client ou por um worker, até completed/failed)
const { jobs } = await fetch(`${IMAGE_GEN_URL}/jobs?ids=${job_id}`, {
  headers: { authorization: `Bearer ${IMAGE_GEN_TOKEN}` },
}).then(r => r.json());
// job.status: queued | processing | completed | failed ; job.output_url quando completed
```

Por que reforçar a regra duas vezes (etapa 2 e etapa 3): modelos de geração de imagem tendem a "vazar" o elemento indesejado mesmo com uma descrição limpa — redundância deliberada corrige isso na prática.

## 7. Etapa 4 — Persistência própria dos bytes

`output_url` de serviços de geração costuma ser **assinada e expirar** (minutos a poucas horas). Assim que o job completa:

```ts
const img = await fetch(job.output_url);
const bytes = new Uint8Array(await img.arrayBuffer());
const mime = img.headers.get('content-type') || 'image/png';

// caminho A (recomendado, se você tem blob storage): suba os bytes pro seu S3/bucket e guarde a key própria.
// caminho B (sem blob storage, ex.: SQLite/D1 com limite de tamanho por linha): faça chunking manual.
let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
const b64 = btoa(bin);
const CHUNK = 800_000; // fique abaixo do limite do seu banco por linha/valor
for (let off = 0, idx = 0; off < b64.length; off += CHUNK, idx++) {
  await db.exec(`INSERT INTO chunks (key, idx, b64) VALUES (?, ?, ?)`, [itemKey, idx, b64.slice(off, off + CHUNK)]);
}
```

Nunca sirva a `output_url` do provedor direto pro cliente — ela expira e quebra silenciosamente depois.

## 8. Etapa 5 — Serving + dedup + auto-cura

- Rota própria (`/img?id=`) remonta os chunks (ordenados por `idx`) e serve com `cache-control` longo — a arte gerada é imutável uma vez persistida.
- Se o registro diz "completed" mas não há bytes persistidos (falha no meio da gravação), **detecte e force regeneração** em vez de servir quebrado — tanto no backend (checagem antes de reusar) quanto no client (`<img onerror>` dispara nova geração).
- Dedup por chave estável de negócio (não pela URL do asset).

## 9. Padrões operacionais (o que evita dor depois)

1. **Migração de schema sem framework**: `ALTER TABLE ... ADD COLUMN` envolto em `try/catch` (idempotente por erro) + uma tabela `settings(k,v)` com flags "já rodei essa migração" para passes de dado que só devem rodar uma vez.
2. **Concorrência limitada por recurso externo**: se o backend de scraping/geração tem capacidade única (1 dyno, 1 worker), não dispare tudo em paralelo — rode em rodízio sequencial (fila com prioridade pro item mais desatualizado) e reserve paralelismo só para as fontes "baratas" (APIs diretas, sem headless browser).
3. **Filas de concorrência no client** também, quando o usuário pode disparar dezenas de itens de uma vez (ex.: abrir uma tela com 30 cards) — limite quantas chamadas de LLM/geração ficam em voo ao mesmo tempo.
4. **Log append-only** de cada captura/geração (tabela `history` ou equivalente) — útil pra debugar "por que esse item ficou diferente" sem depender de reconstituir estado.
5. **Separe "em aberto" de "decidido"**: itens aprovados/descartados por um humano não devem competir por espaço no pool nem ser reprocessados na próxima captura.

## 10. Checklist de bootstrap para um projeto novo

- [ ] Definir o "elemento de interesse" que deve ser isolado (o que a etapa de visão deve descrever) e o que deve ser explicitamente ignorado.
- [ ] Escolher o provedor de visão e escrever o system prompt com a lista negativa (seção 5).
- [ ] Escolher o provedor de geração de imagem e confirmar se ele é síncrono ou assíncrono (se síncrono, ainda assim trate como se fosse job — não bloqueie a resposta principal nele).
- [ ] Decidir onde persistir os bytes finais (blob storage > chunking manual em banco).
- [ ] Definir a chave estável de dedup/cache (não usar URL de CDN/assinada).
- [ ] Se houver scraping: mapear fonte por fonte se dá pra usar API direta ou precisa de headless browser, e implementar retry+backoff.
- [ ] Se houver múltiplas fontes concorrendo por um recurso externo limitado (headless browser, GPU de geração), desenhar o rodízio/fila desde o início.
