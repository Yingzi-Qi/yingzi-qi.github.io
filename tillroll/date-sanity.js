// Batch date checks. This never rewrites a parsed date. It only reports flags
// on 采购时间 (purchaseTime). DD/MM parsing is unchanged.

const FIELD = 'purchaseTime';
const DAY = 86400000;

function pad(value) {
  return String(value).padStart(2, '0');
}

function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!match) return null;
  const iso = match[1] + '-' + match[2] + '-' + match[3];
  const time = Date.parse(iso + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== iso) return null;
  return {iso, time, year: Number(match[1]), month: Number(match[2]), day: Number(match[3])};
}

function median(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function swappedDayMonth(parsed) {
  if (parsed.day === parsed.month) return null;
  const iso = parsed.year + '-' + pad(parsed.day) + '-' + pad(parsed.month);
  const time = Date.parse(iso + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

function locked(receipt, locks) {
  const field = FIELD;
  const listed = receipt?.humanVerifiedUnflagged || receipt?.human_verified_unflagged || [];
  if ([].concat(listed).includes(field)) return true;
  const id = receipt?.id;
  return locks.has(id) || locks.has(String(id)) || locks.has(id + '|' + field) || locks.has(String(id) + '|' + field);
}

// Returns flags only. Receipt dates are left as the parser emitted them.
export function batchDateFlags(receipts, {uploadTime = new Date(), locks} = {}) {
  const cleared = locks instanceof Set ? locks : new Set(locks || []);
  const dated = [];
  for (const receipt of receipts || []) {
    const parsed = parseDay(receipt?.date ?? receipt?.purchaseTime);
    if (parsed) dated.push({receipt, parsed});
  }
  if (!dated.length) return [];
  const counts = new Map();
  for (const row of dated) {
    const key = row.parsed.year + '-' + pad(row.parsed.month);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let mode = null, modeCount = 0;
  for (const [key, count] of counts) if (count > modeCount) { mode = key; modeCount = count; }
  const middle = median(dated.map(row => row.parsed.time));
  const upload = uploadTime instanceof Date ? uploadTime : new Date(uploadTime);
  const uploadTimeMs = upload.getTime();
  const longAgo = new Date(middle);
  longAgo.setUTCMonth(longAgo.getUTCMonth() - 12);
  const flags = [];
  for (const row of dated) {
    if (locked(row.receipt, cleared)) continue;
    const reasons = [];
    const month = row.parsed.year + '-' + pad(row.parsed.month);
    if (dated.length >= 3 && month !== mode) {
      const swapped = swappedDayMonth(row.parsed);
      if (swapped && swapped.slice(0, 7) === mode) reasons.push('possible DD/MM swap; would be ' + swapped);
      else reasons.push('month differs from the majority month');
    }
    if (Math.abs(row.parsed.time - middle) / DAY > 45) reasons.push('far from the rest of the batch');
    if (Number.isFinite(uploadTimeMs) && row.parsed.time > uploadTimeMs) reasons.push('future date');
    if (row.parsed.time < longAgo.getTime()) reasons.push('date long ago');
    if (!reasons.length) continue;
    flags.push({
      id: row.receipt.id,
      field: FIELD,
      message: reasons.join('; '),
      reasons,
      severity: 'check',
      category: 'reading',
    });
  }
  return flags;
}
