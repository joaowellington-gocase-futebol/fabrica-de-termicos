// Máscaras dos térmicos e como montar o mockup 2D de cada um.
//
// w/h  = área impressa desenrolada, em px. Vem de materials.width/height do
//        Factory (a mesma tabela que o gerador-de-adaptacoes usa).
// mat  = slug do mockup 360 no Prisma.
// sku  = um produto real que já usa esse mockup; entra só para compor a URL.
//
// O mockup sai de:
//   https://ik.imagekit.io/gocase/govinci/{sku}/{mat}/mockup?stamp={caminho}&expires=yes
// Trocando o `stamp`, o Prisma compõe QUALQUER arte naquele produto — não é
// preciso cadastrar nada antes. Verificado em 2026-09-10.

export interface Mascara {
  chave: string;
  label: string;
  w: number;
  h: number;
  mat: string;
  sku: string;
}

export const MASCARAS: Mascara[] = [
  { chave: 'fresh-650',  label: 'Garrafa Fresh 650ml',  w: 2754, h: 2340,
    mat: '360freshbrancav3-garrafafresh650ebook',  sku: '1errohexa-garrafa-fresh' },
  { chave: 'fresh-950',  label: 'Garrafa Fresh 950ml',  w: 3380, h: 2114,
    mat: '360freshbrancav3-garrafafresh1200ebook', sku: 'abrito-1-950-b2b' },
  { chave: 'urban-500',  label: 'Garrafa Urban 500ml',  w: 2672, h: 1465,
    mat: '360urbanbranca-garrafaurban500ebook',    sku: '111safari-glam-garrafa-urban' },
  { chave: 'mini-350',   label: 'Garrafa Mini 350ml',   w: 2754, h: 1335,
    mat: '360minibranca-garrafamini350',           sku: 'arcanjo-sao-miguel-crianca-garrafa-mini' },
  { chave: 'fun-460',    label: 'Garrafa Fun 460ml',    w: 2783, h: 1524,
    mat: '360kidsbranco-garrafakids460ebook',      sku: 'abstract-colors-garrafa-fun' },
  { chave: 'flip-750',   label: 'Garrafa Flip Pro 750ml', w: 2915, h: 2102,
    mat: '360propreta-garrafapro750ebook',         sku: 'abstrato-e-colorido-garrafa-pro' },
  { chave: 'magsafe-750',label: 'Garrafa Magsafe 750ml', w: 2915, h: 2102,
    mat: '360magsafepreta-garrafamagsafe750',      sku: '111safari-glam-garrafa-urban-nbk' },
  { chave: 'life-880',   label: 'Copo Life 880ml',      w: 3495, h: 2384,
    mat: '360lifebranco-copolife880ebook',         sku: 'acho-pr-copo-life' },
  { chave: 'life-600',   label: 'Copo Daily 600ml',     w: 3488, h: 1890,
    mat: '360lifepreto600-copolife600ebook',       sku: 'atleticomg-u3-2025-cld' },
];

export function mockupUrl(m: Mascara, stampPath: string, w = 700): string {
  return `https://ik.imagekit.io/gocase/govinci/${m.sku}/${m.mat}/mockup` +
         `?stamp=${stampPath}&expires=yes&tr=w-${w}`;
}
