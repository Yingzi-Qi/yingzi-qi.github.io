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
  'cd': 'Dior',
  'ysl': 'Saint Laurent',
  'yves saint laurent': 'Saint Laurent',
  'bv': 'Bottega Veneta',
  'dior mens': 'Dior',
  'dior men': 'Dior',
  'dior homme': 'Dior',
  'dior femme': 'Dior',
  'dior baby': 'Dior',
  'dior kids': 'Dior',
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

const DEPARTMENT_SUFFIX = /\s+(accessory|accessories|beauty|fragrance|fragrances|parfums?|watches?|fine jewell?ery|jewell?ery|shoes|footwear|rtw|ready[- ]to[- ]wear|leather goods|boutique|cosmetics|uk|london|mens|men|homme|femme|women|baby|kids)$/i;

// CD, LV and BV are brands only as a whole token. They must not match inside
// CDG, or inside a code that happens to contain those letters.
const SHORT_BRAND = { cd: 'Dior', lv: 'Louis Vuitton', bv: 'Bottega Veneta' };
const shortToken = () => /\b(CD|LV|BV)\b/gi;

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

// A brand this table actually knows. An unknown name comes back empty, so a
// code or a word such as CDG is not treated as a brand.
export function knownBrand(input) {
  if (input == null || !String(input).trim()) return '';
  const canon = canonicalBrand(input);
  const folded = fold(input);
  if (CANON.has(folded) || ALIASES[folded]) return canon;
  if (canon && fold(canon) !== folded && BRANDS.includes(canon)) return canon;
  return '';
}

export function brandInLine(text) {
  const direct = knownBrand(text);
  if (direct) return direct;
  const source = String(text ?? '');
  const padded = ` ${fold(source)} `;
  const phrases = [...BRANDS.map(fold), ...Object.keys(ALIASES)].sort((left, right) => right.length - left.length);
  for (const phrase of phrases) {
    if (padded.includes(` ${phrase} `)) return canonicalBrand(phrase);
  }
  const short = shortToken().exec(source);
  return short ? SHORT_BRAND[short[1].toLowerCase()] : '';
}

const DEPARTMENT_WORD = /^(accessory|accessories|beauty|fragrance|fragrances|parfum|parfums|boutique|cosmetics|uk|london|mens|men|homme|femme|women|baby|kids)$/i;

export function stripBrandWords(text) {
  let raw = ` ${String(text ?? '')} `;
  const phrases = [...BRANDS.map(fold), ...Object.keys(ALIASES)].sort((left, right) => right.length - left.length);
  for (const phrase of phrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    raw = raw.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=[^A-Za-z0-9]|$)`, 'ig'), '$1 ');
  }
  return raw.replace(shortToken(), ' ');
}

export function productWords(text) {
  return stripBrandWords(text)
    .split(/[^A-Za-z0-9]+/)
    .filter(word => word.length > 1 && /[A-Za-z]/.test(word) && !DEPARTMENT_WORD.test(word));
}

// Server cache identity: upper-case, spaces removed, leading zeros kept.
export function normaliseItemId(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, '').toUpperCase();
}

export function sameText(a, b) {
  return fold(a) === fold(b);
}
