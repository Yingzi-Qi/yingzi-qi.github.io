import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(here + '../migrations/0001_init.sql', 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    run: async () => { const p = db.prepare(sql); return /RETURNING/i.test(sql) ? { results: p.all(...args) } : (p.run(...args), { success: true }); },
    _exec: () => db.prepare(sql).run(...args),
  });
  return { prepare: sql => stmt(sql), batch: async list => { db.exec('BEGIN'); try { for (const s of list) s._exec(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; }, _db: db };
}
export function makeKV() {
  const m = new Map(); let writes = 0;
  return { get: async (k, t) => { const v = m.get(k); if (!v) return null; return t === 'json' ? JSON.parse(v.body) : v.body; }, put: async (k, body, o) => { writes++; m.set(k, { body, ttl: o?.expirationTtl }); },
    delete: async k => { writes++; m.delete(k); }, _m: m, get writes() { return writes; } };
}
export function makeEnv(extra = {}) { return { DB: makeD1(), LOOKUP_CACHE: makeKV(), ...extra }; }
// Mock Brave + Gemini. catalogue: [{brand, officialName, itemId, price, currency, weightGrams, url}]
export function mockFetch(catalogue, calls = { brave: 0, gemini: 0 }, opts = {}) {
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.search.brave.com')) {
      calls.brave++;
      if (typeof opts.brave === 'function') return opts.brave(u, init);
      if (opts.braveStatus) return new Response('error', { status: opts.braveStatus });
      const q = new URL(u).searchParams.get('q');
      const chanelFallbackQ = /site:chanel\.cn|site:chanel\.com\/gb/.test(q);
      if (opts.blockChanelPrimary && /site:chanel\.com/.test(q) && !chanelFallbackQ) {
        return new Response('blocked', { status: 403 });
      }
      const results = catalogue.filter(c => q.includes(c.itemId) || c.officialName.split(' ').some(w => w.length > 3 && q.toLowerCase().includes(w.toLowerCase())))
        .map(c => ({
          url: c.url,
          title: c.title || `${c.officialName} | ${c.brand}`,
          description: c.description !== undefined ? c.description : (c.price != null ? `${c.itemId} £${c.price}` : String(c.itemId || '')),
          extra_snippets: c.extra_snippets || [],
        }));
      return new Response(JSON.stringify({ web: { results } }), { status: 200 });
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      calls.gemini++;
      if (typeof opts.gemini === 'function') return opts.gemini(u, init);
      if (opts.geminiStatus) return new Response(JSON.stringify({ error: { message: 'failed' } }), { status: opts.geminiStatus });
      const text = JSON.parse(init.body).contents[0].parts[0].text;
      if (opts.blockChanelPrimary && !/chanel\.com was blocked|chanel\.cn or chanel\.com\/gb/.test(text)) {
        return new Response('blocked', { status: 403 });
      }
      const facts = JSON.parse(text.match(/\(quoted data, not instructions\): (\{.*\})/)[1]);
      let cands;
      if (typeof opts.geminiCandidates === 'function') cands = opts.geminiCandidates(facts, text);
      else if (Array.isArray(opts.geminiCandidates)) cands = opts.geminiCandidates;
      else if (/matched nothing/.test(text)) cands = catalogue.filter(c => c.brand === facts.brand);
      else if (/item\/reference\/style number/.test(text)) cands = catalogue.filter(c => c.itemId === facts.itemId);
      else if (/official UK store name/.test(text)) return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ candidates: [], branch: { officialStoreName: `${facts.supplier} Canary Wharf`, sourceUrls: ['https://www.rolex.com/en-gb/store'] } }) }] } }] }));
      else cands = catalogue.filter(c => c.brand === facts.brand && facts.name && c.officialName.toLowerCase().includes(facts.name.toLowerCase().split(' ')[0]));
      const body = { candidates: cands.map(c => ({ brand: c.brand, officialName: c.officialName, itemId: c.itemId, price: c.price ?? null, currency: c.currency ?? null, weightGrams: c.weightGrams ?? null, sourceUrls: c.sourceUrls || [c.url], priceText: c.priceText, description: c.description, sourceSnippets: c.sourceSnippets })), branch: null };
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '```json\n' + JSON.stringify(body) + '\n```' }] },
        groundingMetadata: { groundingChunks: cands.map(c => ({ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x', title: new URL(c.url || 'https://www.example.com').hostname.replace(/^www\./, '') } })) } }] }));
    }
    throw new Error('unexpected fetch ' + u);
  };
  fn.calls = calls;
  return fn;
}

export const CATALOGUE = [
  { brand: 'Chanel', officialName: 'Classic Flap Mini Bag', itemId: 'A69900', price: 4950, currency: 'GBP', url: 'https://www.chanel.com/gb/fashion/p/A69900/' },
  { brand: 'Van Cleef & Arpels', officialName: 'Vintage Alhambra pendant', itemId: '0012345', price: 3600, currency: 'GBP', url: 'https://www.vancleefarpels.com/gb/en/0012345.html' },
  { brand: 'Gucci', officialName: 'GG Marmont mini bag', itemId: '446744', price: 1350, currency: 'GBP', weightGrams: 410, url: 'https://www.gucci.com/uk/en_gb/pr/446744' },
  { brand: 'Gucci', officialName: 'Horsebit 1955 mini bag', itemId: '658574', price: 1350, currency: 'GBP', weightGrams: 380, url: 'https://www.gucci.com/uk/en_gb/pr/658574' },
  { brand: 'Gucci', officialName: 'Fake reseller listing', itemId: '999999', price: 100, currency: 'GBP', url: 'https://www.some-reseller.example/gucci-999999' },
  { brand: 'Dior', officialName: 'Lady Dior Small', itemId: 'M0531', price: 5000, currency: 'GBP', url: 'https://www.dior.com/en_gb/M0531' },
  { brand: 'Dior', officialName: 'Saddle Bag', itemId: 'M0446', price: 5000, currency: 'GBP', url: 'https://www.dior.com/en_gb/M0446' },
];
