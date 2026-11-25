// Tillroll v2 layer: Run sanity checks, Linked Workbooks (Google Drive),
// Reading History, quota status and Brave attribution. Talks only to the
// same-origin /api/* Cloudflare Pages Functions; holds no secrets.
import { exportAgreedChina } from './exports.js?v=1';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLUMNS = ['采购小票id', '采购时间', '供应商', '品牌', '品名', '品牌货号', '采购商品原价', '采购商品金额', '采购商品方法', '销售金额'];
const FIELD_TO_COL = [[/^items\.\d+\.itemId/, '品牌货号'], [/^items\.\d+\.(item|name)/, '品名'], [/^items\.\d+\.unitPrice/, '采购商品原价'], [/^items\.\d+\.amount/, '采购商品金额'],
  [/^items\.\d+\.brand/, '品牌'], [/^(date|time)/, '采购时间'], [/^(orderNumber|orderId|receiptReference)/, '采购小票id'], [/^payment/, '采购商品方法'], [/^merchant/, '供应商']];
let lastResult = null, lastBatchId = null;

async function api(path, init = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  if (res.status === 401) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.code === 'locked' && (await unlock())) return api(path, init);
  }
  return res;
}
const note = msg => { const n = $('#notice'); if (!n) return; n.textContent = msg; n.hidden = false; clearTimeout(note.t); note.t = setTimeout(() => { n.hidden = true; }, 6000); };

function unlock() {
  return new Promise(resolve => {
    const d = $('#v2-unlock-dialog'); const f = $('#v2-unlock-form'); const err = $('#v2-unlock-error');
    err.textContent = ''; f.passcode.value = '';
    f.onsubmit = async e => {
      e.preventDefault();
      const r = await fetch('/api/auth/unlock', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: f.passcode.value }) });
      if (r.ok) { d.close(); resolve(true); } else err.textContent = (await r.json().catch(() => ({}))).error || 'Could not unlock.';
    };
    d.addEventListener('close', () => resolve(false), { once: true });
    d.showModal();
  });
}

// ---- Receipts -> sanity-run payload ----------------------------------------
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const PHONE = /(?:\+44\s?|\b0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/;
// Provisional fallback only; the Receipt Reader owns storeClues (binding Reader contract).
function deriveStoreClues(ocr) {
  const lines = (ocr?.lines || []).map(l => l.text).filter(Boolean);
  if (!lines.length) return null;
  const edge = [...lines.slice(0, 8), ...lines.slice(-8)];
  const pc = edge.map(t => t.match(UK_POSTCODE)).find(Boolean);
  const ph = edge.map(t => t.match(PHONE)).find(Boolean);
  const sn = edge.map(t => t.match(/\bstore\s*(?:no\.?|#|number)?\s*(\d{2,6})\b/i)).find(Boolean);
  const pcIndex = pc ? lines.findIndex(t => UK_POSTCODE.test(t)) : -1;
  const addressLines = pcIndex > 0 ? lines.slice(Math.max(0, pcIndex - 2), pcIndex + 1) : [];
  return { addressLines, postcode: pc ? pc[1].toUpperCase() : null, storeNumber: sn ? sn[1] : null, phone: ph ? ph[0] : null };
}
export function receiptsFromBatch(batch) {
  return batch.filter(r => r.state === 'done' && !r.duplicateOf && r.data).map(r => {
    const d = r.data;
    const flagsByLine = new Map();
    for (const f of r.review?.flags || []) {
      if (!f.escalate) continue;
      const hit = FIELD_TO_COL.find(([re]) => re.test(f.field || ''));
      if (!hit) continue;
      const m = String(f.field).match(/^items\.(\d+)/);
      const keys = m ? [Number(m[1])] : d.items.map((_, i) => i);
      for (const k of keys) { if (!flagsByLine.has(k)) flagsByLine.set(k, new Set()); flagsByLine.get(k).add(hit[1]); }
    }
    return {
      receiptKey: r.hash ? 'sha:' + r.hash.slice(0, 16) : undefined, sha256: r.hash, filename: r.filename,
      merchant: d.merchant, receiptReference: d.receiptReference, orderNumber: d.orderNumber, orderId: d.orderId,
      date: d.date, time: d.time, payment: d.payment, currency: d.currency, discount: d.discount,
      storeClues: d.storeClues || deriveStoreClues(r.ocr),
      items: (d.items || []).map((it, i) => ({ ...it, lineIndex: i, readingFlags: [...(flagsByLine.get(i) || [])] })),
    };
  });
}

// ---- Run sanity checks ------------------------------------------------------
async function runSanity() {
  const batch = window.tillrollV2Hooks?.getBatch?.() || [];
  const receipts = receiptsFromBatch(batch);
  if (!receipts.length) { note('Upload and read receipts first, then run sanity checks.'); return; }
  const btn = $('#v2-run'); btn.disabled = true;
  const panel = $('#v2-panel'); panel.hidden = false;
  panel.innerHTML = '<p class="v2-status" role="status">The bots are reviewing your receipts. Only the final agreed version will appear here.</p>';
  try {
    lastBatchId = 'b_' + Date.now().toString(36);
    await api('/api/batches', { method: 'POST', body: JSON.stringify({ batchId: lastBatchId, files: receipts.filter(r => r.sha256).map(r => ({ sha256: r.sha256, filename: r.filename })) }) }).catch(() => null);
    const res = await api('/api/sanity-run', { method: 'POST', body: JSON.stringify({ batchId: lastBatchId, receipts, mode: 'round1' }) });
    const start = await res.json();
    if (!res.ok) throw new Error(start.error || `Sanity run could not start (${res.status}).`);
    let wait = start.pollAfterMs || 1500, out;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, wait));
      const g = await api(`/api/sanity-run/${encodeURIComponent(start.runId)}`);
      out = await g.json();
      if (out.status === 'completed' || out.status === 'failed') break;
      wait = Math.min(out.pollAfterMs || 2000, 4000);
    }
    if (out?.status !== 'completed') throw new Error(out?.error || 'The review did not finish. Try again.');
    lastResult = out; renderResult(out);
  } catch (e) {
    panel.innerHTML = `<p class="v2-error">${esc(e.message)}</p>`;
  } finally { btn.disabled = false; refreshQuota(); }
}

function renderResult(out) {
  const panel = $('#v2-panel');
  const reasons = new Map();
  for (const e of [...out.readingErrors, ...out.lookupUncertainties]) {
    const k = e.rowId + '|' + e.col; reasons.set(k, [...(reasons.get(k) || []), e.reason + (e.confidence != null ? ` (confidence ${e.confidence})` : '')]);
  }
  const head = COLUMNS.map(c => `<th>${esc(c)}</th>`).join('');
  const body = out.agreedRows.map(row => '<tr>' + COLUMNS.map(c => {
    const f = row.flags[c]; const why = reasons.get(row.rowId + '|' + c);
    const v = row.cells[c];
    return `<td${f ? ` style="background:${f}" class="${f === '#FECDD3' ? 'v2-pink' : 'v2-amber'}"` : ''}${why ? ` title="${esc(why.join(' · '))}"` : ''}>${esc(typeof v === 'number' ? v.toFixed(2) : v ?? '')}</td>`;
  }).join('') + '</tr>').join('');
  const pinkList = out.readingErrors.slice(0, 30).map(e => `<li><b>${esc(e.col)}</b> · ${esc(e.reason)}</li>`).join('');
  const mismatchText = e => (e.mismatches || []).map(m => `${m.field}: receipt ${m.receiptValue ?? '—'} vs official ${m.officialValue ?? '—'}`).join('; ');
  const amberList = out.lookupUncertainties.slice(0, 30).map(e => `<li><b>${esc(e.col)}</b> · ${esc(e.reason)}${mismatchText(e) ? ' · ' + esc(mismatchText(e)) : ''}${(e.sourceUrls || []).slice(0, 2).map(u => ` <a href="${esc(u)}" target="_blank" rel="noopener noreferrer">source</a>`).join('')}</li>`).join('');
  panel.innerHTML = `
    <div class="v2-result-head"><h2>Final agreed version</h2>
      <div class="actions"><button id="v2-csv" class="quiet">Download CSV</button><button id="v2-json" class="quiet">Download JSON (for Excel export)</button></div></div>
    ${out.lookupsPaused ? `<p class="v2-paused" style="background:#FDE68A">Look-ups are paused: ${esc((out.pausedReasons || []).join(' '))} Affected cells are flagged Amber.</p>` : ''}
    <p class="v2-summary">${out.agreedRows.length} rows · <span class="v2-chip" style="background:#FECDD3">${out.readingErrors.length} reading errors</span> · <span class="v2-chip" style="background:#FDE68A">${out.lookupUncertainties.length} look-up flags</span> · ${out.excludedZeroCount} zero-price line(s) excluded</p>
    ${pinkList ? `<details open><summary>Reading errors to check first (Pink)</summary><ul>${pinkList}</ul></details>` : ''}
    ${amberList ? `<details><summary>Look-up uncertainty (Amber)</summary><ul>${amberList}</ul></details>` : ''}
    <div class="table-wrap"><table class="v2-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  $('#v2-csv').onclick = () => download('tillroll-agreed.csv', toCsv(out), 'text/csv;charset=utf-8');
  $('#v2-json').onclick = () => download('tillroll-agreed.json', JSON.stringify(out, null, 2), 'application/json');
}
const toCsv = out => '\ufeff' + [COLUMNS, ...out.agreedRows.map(r => COLUMNS.map(c => r.cells[c] ?? ''))].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

// ---- Quota pill, Drive, Workbooks, History -------------------------------
async function refreshQuota() {
  const pill = $('#v2-quota'); if (!pill) return;
  try {
    const q = await (await fetch('/api/quota', { credentials: 'same-origin' })).json();
    pill.hidden = false;
    pill.textContent = q.lookupsPaused ? 'Look-ups paused' : `Look-ups ready · Brave ${q.brave.used}/${q.brave.limit}`;
    pill.style.background = q.lookupsPaused ? '#FDE68A' : '';
    pill.title = q.lookupsPaused ? q.pausedReasons.join(' ') : `Gemini grounding today ${q.geminiGroundingDaily.used}/${q.geminiGroundingDaily.limit}, this month ${q.geminiGroundingMonthly.used}/${q.geminiGroundingMonthly.limit}`;
  } catch { pill.hidden = true; }
}
async function refreshDrive() {
  const b = $('#v2-drive'); if (!b) return;
  try {
    const s = await (await fetch('/api/auth/session', { credentials: 'same-origin' })).json();
    b.textContent = s.drive.connected ? `Google Drive connected${s.drive.email ? ' · ' + s.drive.email : ''}` : 'Connect Google Drive';
    b.onclick = () => s.drive.connected ? null : s.drive.configured ? (location.href = '/api/auth/google') : note('Google Drive sign-in is not set up yet. It will work once the OAuth client is added.');
  } catch { b.textContent = 'Connect Google Drive'; }
}
async function openWorkbooks() {
  const d = $('#v2-workbooks-dialog'), list = $('#v2-workbooks-list');
  list.innerHTML = '<p>Loading…</p>'; d.showModal();
  const r = await api('/api/workbooks');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { list.innerHTML = `<p class="v2-error">${esc(data.error || 'Could not load linked workbooks.')}</p>`; return; }
  if (!data.workbooks.length) { list.innerHTML = '<p>No workbooks linked yet. Exports saved to Google Drive (Tillroll/Exports) appear here.</p>'; return; }
  list.innerHTML = '<ul class="v2-list">' + data.workbooks.map(w => `<li><span><b>${esc(w.name)}</b><br><small>${esc(w.folder)} · linked ${esc(w.created_at.slice(0, 16).replace('T', ' '))}${w.last_refreshed_at ? ' · refreshed ' + esc(w.last_refreshed_at.slice(0, 16).replace('T', ' ')) : ''}</small></span>
    <span>${w.web_view_link ? `<a href="${esc(w.web_view_link)}" target="_blank" rel="noopener noreferrer">Open</a> ` : ''}<button data-wb="${esc(w.workbook_id)}">Update / Refresh</button></span></li>`).join('') + '</ul>';
  for (const btn of list.querySelectorAll('[data-wb]')) btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Refreshing…';
    const res = await api(`/api/workbooks/${encodeURIComponent(btn.dataset.wb)}/refresh`, { method: 'POST' });
    if (!res.ok) { btn.textContent = (await res.json().catch(() => ({}))).error || 'Refresh failed'; return; }
    const file = new File([await res.blob()], 'linked-workbook.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    d.close();
    window.tillrollV2Hooks?.refreshFromFile?.(file);
  };
}
function showBrowserHistory() {
  const list = $('#v2-history-list');
  if (list) list.innerHTML = '';
  window.tillrollV2Hooks?.showLocalHistory?.();
}
async function openHistory() {
  const d = $('#v2-history-dialog'), list = $('#v2-history-list'), fallback = $('#history-fallback');
  if (!d) return;
  if (list) list.innerHTML = '<p>Loading…</p>';
  if (fallback) fallback.hidden = true;
  d.showModal();
  try {
    const r = await api('/api/history?limit=100');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Could not load history.');
    if (list) list.innerHTML = data.entries.length ? '<ul class="v2-list">' + data.entries.map(e => `<li><span><b>${esc(e.kind)}</b> · ${esc(e.summary)}<br><small>${esc(new Date(e.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' }))}${e.batch_id ? ' · ' + esc(e.batch_id) : ''}</small></span></li>`).join('') + '</ul>' : '<p>No history yet.</p>';
  } catch {
    showBrowserHistory();
  }
}

function init() {
  $('#v2-run')?.addEventListener('click', runSanity);
  $('#v2-workbooks')?.addEventListener('click', openWorkbooks);
  for (const id of ['v2-history', 'history', 'landing-history']) {
    const button = document.getElementById(id);
    if (button) button.onclick = openHistory;
  }
  const china = $('#excel-china');
  if (china) {
    const localExport = china.onclick;
    china.onclick = event => lastResult?.agreedRows ? exportAgreedChina(lastResult.agreedRows) : localExport?.call(china, event);
  }
  for (const b of document.querySelectorAll('[data-v2-close]')) b.onclick = () => document.getElementById(b.dataset.v2Close).close();
  const p = new URLSearchParams(location.search).get('drive');
  if (p === 'connected') note('Google Drive connected.'); else if (p === 'denied') note('Google Drive was not connected.');
  refreshQuota(); refreshDrive();
}
if (location.protocol.startsWith('http') && !location.hostname.endsWith('github.io')) init();
else document.documentElement.classList.add('v2-static'); // GitHub Pages mirror: no backend
