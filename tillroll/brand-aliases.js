// Display aliases. The look-up service owns normalisation and returns canonicalBrand.
// This table stays aligned with tillroll-cloudflare/functions/_lib/brands.js so a
// row can show the same name before a response arrives. Unknown names are not expanded.

export const BRANDS = [
  'Chanel', 'Louis Vuitton', 'Van Cleef & Arpels', 'Cartier', 'Hermès', 'Dior', 'Gucci', 'Prada',
  'Miu Miu', 'Rolex', 'Tiffany & Co.', 'Bulgari', 'Celine', 'Loewe', 'Saint Laurent', 'Burberry',
  'Fendi', 'Balenciaga', 'Bottega Veneta', 'Valentino', 'Givenchy', 'Moncler', 'Goyard', 'Omega',
  'Graff', 'Chloé', 'Jimmy Choo', 'Christian Louboutin', 'Alexander McQueen', 'MAC',
  'Jo Malone London', 'La Mer', 'Tom Ford', 'Montblanc', 'Chopard', 'Boucheron',
  'Dolce & Gabbana', 'Versace', 'Off-White', 'New Balance', 'Chrome Hearts',
];

const ALIASES = {
  'vca': 'Van Cleef & Arpels',
  'van cleef': 'Van Cleef & Arpels',
  'van cleef and arpels': 'Van Cleef & Arpels',
  'lv': 'Louis Vuitton',
  'ysl': 'Saint Laurent',
  'yves saint laurent': 'Saint Laurent',
  'bv': 'Bottega Veneta',
  'hermes': 'Hermès',
  'tiffany': 'Tiffany & Co.',
  'tiffany and co': 'Tiffany & Co.',
  'tiffany & co': 'Tiffany & Co.',
  'bvlgari': 'Bulgari',
  'christian dior': 'Dior',
  'celine': 'Celine',
  'chloe': 'Chloé',
  'jo malone': 'Jo Malone London',
  'creme de la mer': 'La Mer',
  'mac cosmetics': 'MAC',
  'm.a.c': 'MAC',
  'd&g': 'Dolce & Gabbana',
  'mcqueen': 'Alexander McQueen',
  'louboutin': 'Christian Louboutin',
  'chrome hearts': 'Chrome Hearts',
};

const DEPARTMENT_SUFFIX = /\s+(accessory|accessories|beauty|fragrance|fragrances|parfums?|watches?|fine jewell?ery|jewell?ery|shoes|footwear|rtw|ready[- ]to[- ]wear|leather goods|boutique|cosmetics|uk|london)$/i;

export const fold = value => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[.'’]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const CANON = new Map(BRANDS.map(brand => [fold(brand), brand]));

export function canonicalBrand(input) {
  if (input == null || !String(input).trim()) return '';
  let folded = fold(input);
  for (let pass = 0; pass < 3; pass++) {
    if (CANON.has(folded)) return CANON.get(folded);
    if (ALIASES[folded]) return ALIASES[folded];
    const stripped = folded.replace(DEPARTMENT_SUFFIX, '');
    if (stripped === folded) break;
    folded = stripped;
  }
  return String(input).trim();
}

// Server cache identity: upper-case, spaces removed, leading zeros kept.
export function normaliseItemId(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, '').toUpperCase();
}

export function sameText(a, b) {
  return fold(a) === fold(b);
}
