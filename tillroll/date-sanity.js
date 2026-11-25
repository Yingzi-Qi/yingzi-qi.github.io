// Batch date checks. This never rewrites a parsed date. It only reports flags
// on 采购时间 (purchaseTime). It runs on the dates the parser already emitted.

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

function receiptKey(receipt) {
  const key = receipt?.receiptKey ?? receipt?.id;
  return key == null || key === '' ? '' : String(key);
}

function londonDate(instant) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = type => parts.find(entry => entry.type === type).value;
  return part('year') + '-' + part('month') + '-' + part('day');
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
  const byReceipt = new Map();
  for (const row of dated) {
    const key = receiptKey(row.receipt);
    if (!byReceipt.has(key)) byReceipt.set(key, row);
  }
  const uniqueReceipts = [...byReceipt.values()];
  const counts = new Map();
  for (const row of uniqueReceipts) {
    const key = row.parsed.year + '-' + pad(row.parsed.month);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let mode = null, modeCount = 0;
  for (const [key, count] of counts) if (count > modeCount) { mode = key; modeCount = count; }
  // A different shopping month is not a reading error. The month test runs only
  // when one month is a strict majority of receipts, and only to explain a day/month swap.
  const strictMajority = uniqueReceipts.length >= 3 && modeCount * 2 > uniqueReceipts.length;
  const middle = median(dated.map(row => row.parsed.time));
  const upload = uploadTime instanceof Date ? uploadTime : new Date(uploadTime);
  const today = Number.isFinite(upload.getTime()) ? londonDate(upload) : null;
  const longAgo = new Date(middle);
  longAgo.setUTCMonth(longAgo.getUTCMonth() - 12);
  const flags = [];
  for (const row of dated) {
    if (locked(row.receipt, cleared)) continue;
    const reasons = [];
    const month = row.parsed.year + '-' + pad(row.parsed.month);
    if (strictMajority && month !== mode) {
      const swapped = swappedDayMonth(row.parsed);
      if (swapped && swapped.slice(0, 7) === mode) reasons.push('possible DD/MM swap; would be ' + swapped);
    }
    if (Math.abs(row.parsed.time - middle) / DAY > 45) reasons.push('far from the rest of the batch');
    if (today && row.parsed.iso > today) reasons.push('future date');
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

/**
 * One receipt row in a batch, after purchase-date parsing.
 * @typedef {object} DateOutlierUnit
 * @property {string} rowId Stable id of the receipt row. It is copied onto each returned flag and is not a line number.
 * @property {string} [receiptKey] Groups units that belong to one receipt. The month count uses one date per key.
 * @property {string} [date] Parsed purchase date, `YYYY-MM-DD`, as `readPurchaseDate` left it. This is the date the check reads.
 * @property {string} [purchaseTime] Used only when `date` is absent. Only the leading `YYYY-MM-DD` of this 采购时间 value is read.
 * @property {string[]} [human_verified_unflagged] Field names the user cleared. `purchaseTime` or `采购时间` in this list skips the row.
 */

/**
 * Backend batch date check. Pure: no I/O, and it does not change a date.
 * The month test runs only when at least three receipts have a parsed date.
 * Same rules as {@link batchDateFlags}.
 * @param {DateOutlierUnit[]} units
 * @param {{now?: Date|string|number}} [options] `now` is the upload time.
 * @returns {Array<{rowId: string, field: '采购时间', flag: '#FECDD3', reason: string}>}
 */
export function checkBatchDateOutliers(units, { now = new Date() } = {}) {
  const flags = batchDateFlags((units || []).map(unit => {
    const listed = [].concat(unit?.human_verified_unflagged || unit?.humanVerifiedUnflagged || []);
    const lockedField = listed.some(name => name === 'purchaseTime' || name === '采购时间');
    return {
      id: unit?.rowId,
      receiptKey: unit?.receiptKey ?? unit?.rowId,
      date: unit?.date ?? unit?.purchaseTime,
      human_verified_unflagged: lockedField ? ['purchaseTime'] : [],
    };
  }), {uploadTime: now});
  return flags.map(flag => ({
    rowId: flag.id,
    field: '采购时间',
    flag: '#FECDD3',
    reason: flag.message,
  }));
}
