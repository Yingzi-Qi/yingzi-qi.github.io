// Canonical brand names, aliases and official domains. Owned jointly with the
// Brand & Catalogue Look-up Verifier; changes go through Orchestrator + Change Log.
export const BRANDS = {
  'Chanel': ['chanel.com'],
  'Louis Vuitton': ['louisvuitton.com'],
  'Van Cleef & Arpels': ['vancleefarpels.com'],
  'Cartier': ['cartier.com'],
  'Hermès': ['hermes.com'],
  'Dior': ['dior.com'],
  'Gucci': ['gucci.com'],
  'Prada': ['prada.com'],
  'Miu Miu': ['miumiu.com'],
  'Rolex': ['rolex.com'],
  'Tiffany & Co.': ['tiffany.co.uk', 'tiffany.com'],
  'Bulgari': ['bulgari.com'],
  'Celine': ['celine.com'],
  'Loewe': ['loewe.com'],
  'Saint Laurent': ['ysl.com'],
  'Burberry': ['burberry.com'],
  'Fendi': ['fendi.com'],
  'Balenciaga': ['balenciaga.com'],
  'Bottega Veneta': ['bottegaveneta.com'],
  'Valentino': ['valentino.com'],
  'Givenchy': ['givenchy.com'],
  'Moncler': ['moncler.com'],
  'Goyard': ['goyard.com'],
  'Omega': ['omegawatches.com'],
  'Graff': ['graff.com'],
  'Chloé': ['chloe.com'],
  'Jimmy Choo': ['jimmychoo.com'],
  'Christian Louboutin': ['christianlouboutin.com'],
  'Alexander McQueen': ['alexandermcqueen.com'],
  'MAC': ['maccosmetics.co.uk', 'maccosmetics.com'],
  'Jo Malone London': ['jomalone.co.uk', 'jomalone.com'],
  'La Mer': ['cremedelamer.co.uk', 'cremedelamer.com'],
  'Tom Ford': ['tomford.com', 'tomfordbeauty.co.uk'],
  'Montblanc': ['montblanc.com'],
  'Chopard': ['chopard.com'],
  'Boucheron': ['boucheron.com'],
  'Dolce & Gabbana': ['dolcegabbana.com'],
  'Versace': ['versace.com'],
  'Off-White': ['off---white.com'],
  'New Balance': ['newbalance.co.uk', 'newbalance.com'],
};
export const UK_RETAILERS = ['selfridges.com', 'harrods.com', 'harveynichols.com', 'libertylondon.com', 'johnlewis.com', 'flannels.com', 'net-a-porter.com', 'mytheresa.com'];
const ALIASES = {
  'vca': 'Van Cleef & Arpels', 'van cleef': 'Van Cleef & Arpels', 'van cleef and arpels': 'Van Cleef & Arpels',
  'lv': 'Louis Vuitton', 'ysl': 'Saint Laurent', 'yves saint laurent': 'Saint Laurent', 'bv': 'Bottega Veneta',
  'hermes': 'Hermès', 'tiffany': 'Tiffany & Co.', 'tiffany and co': 'Tiffany & Co.', 'tiffany & co': 'Tiffany & Co.',
  'bvlgari': 'Bulgari', 'christian dior': 'Dior', 'céline': 'Celine', 'chloe': 'Chloé', 'jo malone': 'Jo Malone London',
  'creme de la mer': 'La Mer', 'mac cosmetics': 'MAC', 'm.a.c': 'MAC', 'd&g': 'Dolce & Gabbana', 'mcqueen': 'Alexander McQueen',
  'louboutin': 'Christian Louboutin',
};
const DEPARTMENT_SUFFIX = /\s+(accessory|accessories|beauty|fragrance|fragrances|parfums?|watches?|fine jewell?ery|jewell?ery|shoes|footwear|rtw|ready[- ]to[- ]wear|leather goods|boutique|cosmetics|uk|london)$/i;
const fold = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const CANON = new Map(Object.keys(BRANDS).map(b => [fold(b), b]));
export function canonicalBrand(input) {
  if (!input || !String(input).trim()) return null;
  let s = fold(input);
  for (let i = 0; i < 3; i++) {
    if (CANON.has(s)) return CANON.get(s);
    if (ALIASES[s]) return ALIASES[s];
    const stripped = s.replace(DEPARTMENT_SUFFIX, '');
    if (stripped === s) break;
    s = stripped;
  }
  return String(input).trim();
}
export function officialDomains(brand) {
  const c = canonicalBrand(brand);
  return c && BRANDS[c] ? BRANDS[c] : [];
}
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
export const hostMatches = (host, domain) => host === domain || host.endsWith('.' + domain);
export function isOfficialUrl(url, brand, titleHint) {
  const domains = officialDomains(brand);
  if (!domains.length) return false;
  const host = hostOf(url);
  if (domains.some(d => hostMatches(host, d))) return true;
  // Gemini grounding returns redirect URLs whose chunk title is the source domain.
  const t = String(titleHint || '').toLowerCase().replace(/^www\./, '');
  return Boolean(t) && domains.some(d => hostMatches(t, d));
}
export const isUkRetailerUrl = url => UK_RETAILERS.some(d => hostMatches(hostOf(url), d));

// Known multi-store UK branches resolvable offline from printed postcodes.
const KNOWN_BRANCHES = [
  { supplier: 'Selfridges', postcode: /^W1[AU]/i, name: 'Selfridges London Oxford Street' },
  { supplier: 'Selfridges', postcode: /^M17/i, name: 'Selfridges Manchester Trafford' },
  { supplier: 'Selfridges', postcode: /^M3/i, name: 'Selfridges Manchester Exchange Square' },
  { supplier: 'Selfridges', postcode: /^B5/i, name: 'Selfridges Birmingham' },
  { supplier: 'Harrods', postcode: /^SW1X/i, name: 'Harrods Knightsbridge' },
  { supplier: 'Harvey Nichols', postcode: /^SW1X/i, name: 'Harvey Nichols Knightsbridge' },
  { supplier: 'Rolex', postcode: /^E14/i, name: 'Rolex Canary Wharf' },
];
export function knownBranch(supplier, postcode) {
  if (!supplier || !postcode) return null;
  const s = fold(supplier);
  const hit = KNOWN_BRANCHES.find(b => fold(b.supplier) === s && b.postcode.test(String(postcode).replace(/\s+/g, '')));
  return hit ? hit.name : null;
}
