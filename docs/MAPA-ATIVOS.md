# Mapa de ativos existentes — base para a Fábrica de Térmicos

Levantado em 2026-09-10 a partir dos apps GoDeploy, do datamart e do Drive.

## 1. Motor de rapport — JÁ EXISTE e é determinístico
App: `gerador-de-adaptacoes` (2cf259c9, v108, dona: ravenna.alencar)

- `wrapOffsets(mk, S)` → `[{dx:-W},{dx:+W}]`. Cada camada é rasterizada 3x
  (x-W, x, x+W). Isso é o rapport cilíndrico: a costura fecha por construção,
  **não** depende de a IA "acertar" o seamless.
- `layoutCompute(mk, S)` distribui as camadas na máscara. Estilos:
  - pattern/stickers → `autoCompute(fill, overlap:true)`
  - pattern/linear → `fillGridNoOverlap`
  - pattern/distribuido → mesma grade com stagger (xadrez)
  - localizada/estrela → só o elemento principal, centralizado a 62%
- `composeFrom(ed)` rasteriza no tamanho EXATO da máscara, fundo transparente,
  e exclui camadas `kind === 'fonte'` (guias de personalização).
- `isSpanning(e)` = camada que cobre >=85% do canvas → tratada como fundo.
- Entrada hoje: **PSD com camadas separadas**, lido no browser por `ag-psd.js`.
- Preview: grade 3x3 (`showRapportGrid`) + GLB real
  (`garrafa-fresh-650.glb`, UV gerado por projeção cilíndrica em runtime).

> Conclusão: o rapport está resolvido. O gargalo é a ENTRADA (exige PSD manual).

## 2. Máscaras de produção (px reais, vindos de Factory materials.width/height)
Fonte: `src/server.ts` do mesmo app, const `PRODUTOS`, servido em `/api/produtos`.

| produto | máscaras (w x h) |
|---|---|
| garrafa-fresh | 2754x2340 (650ml), 3380x2114 (950ml) |
| garrafa-urban | 2672x1465 (500ml) |
| garrafa-mini | 2754x1335 (350ml) |
| garrafa-fun | 2783x1524 |
| copo-life | 3488x1890 (600), 3495x2384 (880), 3827x2598 (1180) |
| copo-vibe | 3512x1441 (470), 2672x1465 |
| garrafa-flip | 2915x2102 (750), 2754x2340 (750) |
| garrafa-magsafe | 2915x2102 (750), 2754x2340 (650) |

Para térmico cilíndrico a máscara é o retângulo da área impressa desenrolada —
não existe (nem é preciso) PSD de máscara. Confirmado: o Drive não tem PSD de
máscara de térmico.

## 3. Prompt de rapport por IA — já existe
`buildPrompt(aspect, desc, seg, tipo)` com `seg='termicos'`:
"create a SEAMLESS horizontally-repeating pattern (rapport)... LEFT edge must
tile perfectly with the RIGHT edge" + fundo chapado sólido (#FFF ou #000) para
permitir recorte limpo depois. Geração via PIAPP `/api/v1/generate-image`.

## 4. Resolução estampa -> imagem em alta (cascata, do aprovacao-licenciamento)
1. **Factory** `products` (engine_identifier|sku) -> `stamps.image` +
   `available_product_materials` -> `materials.slug`, monta
   `https://catalog-api-v2.gocase.com.br/api/v1/public/line_item_image/{material}/{engine_identifier}/{img}.png`
2. **Site** `velociraptor_products.image_br`, corta em `stamp=` ->
   `https://custom-case-images.s3.amazonaws.com/{path}`
3. **Catalog** Metabase db 19, `design_customizations.preview_pt`

Hosts liberados: custom-case-images.s3.amazonaws.com, ik.imagekit.io,
static-goengines.gocase.com.br, catalog-api-v2.gocase.com.br

## 5. Convenção de nomes (chave para detectar gap e cadastrar)
`engine_identifier` = `<estampa>-case` (ou `<estampa>`) e `<estampa>-termicos`.
Ex.: `ramos-laterais-lavanda-case` <-> `ramos-laterais-lavanda-termicos`.

## 6. Dados de best-seller
`datamart:gold.product_estampa_daily` (data, modelo_key, estampa_key, cor_corpo,
categoria, licenca, pedidos, unidades, receita, share_no_modelo_pct,
share_na_categoria_pct) + `gold.dim_estampa` (estampa_nome, licenca, is_clear,
illustrator_id, tema, first_seen_at).

Validado: 90d, categoria 'Capinha de Celular' = 364.422 un.
Query de gap (case best-seller SEM versão térmica) retorna resultado coerente:
aquarela 4.133un/R$260k, colagem 2.815un/R$178k, lavanda 2.366un/R$153k,
watercolor-nature, amendoeira-em-flor, oncinha, tulipa-cravejada...

### ATENÇÃO: `gold.estampa_opportunity` está furada — NÃO usar
`indice_transferencia` = 0 em todas as linhas; `receita_potencial_30d` é uma
constante (7.035.073 = receita do modelo alvo, não da estampa); `estampa_key`
poluído com volumetria ("880ml", "fresh-350ml-650ml") em vez de estampa.
A priorização precisa ser reconstruída sobre `product_estampa_daily`.

## 7. Outros ativos reaproveitáveis
- `nomeador-estampas` (b761a7dc): já tem aba **Térmicos**, gera nome+SKU por IA,
  grava em Sheets/Drive, tabela de prefixo por licenciado.
- `aprovacao-licenciamento` (ab83dddd): 42 templates de mockup 2D
  (mask+scene+colors), 10 deles térmicos -> preview de aprovação pronto.
  Templates grandes ficam em 3 apps auxiliares (AUX_TEMPLATE_MAP).
- `svg-to-ttf` (8132aa43): proxy PIAPP + **remove.bg** já integrado.
- `central-estampas` (aee3ede7): histórico de gerações por IA + aprovação.
- PIAPP MCP: seedream-v4/v5, flux-2-max-edit, gpt-image-2.5, gemini-3-pro-image.
  Edição com até 14-16 imagens de referência.

## 8. Benchmark - Captura de Mockups — trazido para o repo em 2026-09-10
App `benchmark-mockups` (0684e674), dona ravenna.alencar. Código copiado para
[`integracoes/benchmark-mockups/`](../integracoes/benchmark-mockups/README.md)
(referência congelada, não deployado daqui). Faz scrape de coleções
concorrentes + `generatePrompt` (AI Proxy) + `generateImage` (PIAPP, `job_id`
+ polling) — mesmo padrão descrito em `docs/COMO-FUNCIONA.md` § Rota
generativa.

**Reaproveitamento implementado em 2026-09-10** (`app/src/rotab.ts` +
rotas `/api/rotab/*` em `app/src/server.ts` + `etapaSepararGenerativa()` em
`app/studio.js`): o `PROMPT_SYSTEM` virou a base do prompt de rapport da
etapa 5b, e o ciclo `generateImage`/poll do PIAPP virou `dispararGeracao()` +
`consultarJob()` — agora chamando `chamarAgente()` (não mais `fetch` direto)
e com a mesma persistência em chunks (`rotab_chunks`) porque a `output_url`
expira. Precisa do segredo `PIAPP_TOKEN` além do `AI_PROXY_TOKEN`.
