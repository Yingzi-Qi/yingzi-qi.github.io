import {extractStrictReceipt} from './extract.js?v=discounts1';
// Tillroll v2 layer: Run sanity checks, Linked Workbooks (Google Drive),
// Reading History, quota status and Brave attribution. Talks only to the
// same-origin /api/* Cloudflare Pages Functions; holds no secrets.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLUMNS = ['采购小票id', '采购时间', '供应商', '品牌', '品名', '品牌货号', '采购商品原价', '采购商品金额', '采购商品方法', '销售金额'];
const FIELD_TO_COL = [[/^items\.\d+\.itemId/, '品牌货号'], [/^items\.\d+\.(item|name)/, '品名'], [/^items\.\d+\.unitPrice/, '采购商品原价'], [/^items\.\d+\.amount/, '采购商品金额'],
  [/^items\.\d+\.brand/, '品牌'], [/^(date|time)/, '采购时间'], [/^(orderNumber|orderId|receiptReference)/, '采购小票id'], [/^payment/, '采购商品方法'], [/^merchant/, '供应商']];
let lastResult = null, lastBatchId = null;

async function api(path, init = {}, allowUnlock = true) {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  if (allowUnlock && res.status === 401) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.code === 'locked' && (await unlock())) return api(path, init, false);
  }
  return res;
}
const note = msg => { const n = $('#notice'); if (!n) return; n.textContent = msg; n.hidden = false; clearTimeout(note.t); note.t = setTimeout(() => { n.hidden = true; }, 6000); };

function unlock() {
  return new Promise(resolve => {
    const d = $('#v2-unlock-dialog'); const f = $('#v2-unlock-form'); const err = $('#v2-unlock-error');
    const pass = f.querySelector('[name=passcode]');
    let settled = false;
    const finish = ok => { if (settled) return; settled = true; resolve(ok); };
    err.textContent = ''; pass.value = '';
    f.onsubmit = async e => {
      e.preventDefault();
      const r = await fetch('/api/auth/unlock', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: pass.value }) });
      if (r.ok) { finish(true); d.close(); }
      else err.textContent = (await r.json().catch(() => ({}))).error || 'Could not unlock.';
    };
    d.addEventListener('close', () => finish(false), { once: true });
    if (!d.open) d.showModal();
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
    // The strict OCR reader is the only source admitted to the server review
    // pipeline. Structured model output remains diagnostic evidence until it
    // passes the same fixed-layout whitelist.
    const strict = r.ocr?.lines?.length ? extractStrictReceipt(r.ocr) : null;
    const d = strict || r.data;
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
      id: r.id,
      receiptKey: r.hash ? 'sha:' + r.hash.slice(0, 16) : undefined, sha256: r.hash, filename: r.filename, imageLink: r.url || null,
      merchant: d.merchant, receiptReference: d.receiptReference, orderNumber: d.orderNumber, orderId: d.orderId,
      date: d.date, dateIssue: d.dateIssue, time: d.time, payment: d.payment, currency: d.currency, discount: d.discount,
      total: d.total, subtotal: d.subtotal, receiptDiscount: d.receiptDiscount, receiptDiscounts: d.receiptDiscounts,
      itemCount: d.itemCountCheck?.printed ?? d.itemCount ?? null, itemCountCheck: d.itemCountCheck || null,
      layout: d.layout, layoutStatus: d.layoutStatus, layoutReason: d.layoutReason, gateRequired: true,
      parserReasons: d.parserReasons || [], fieldIssues: d.fieldIssues || [], readMode: d.readMode || null,
      storeClues: d.storeClues || deriveStoreClues(r.ocr),
      items: (d.items || []).map((it, i) => ({ ...it, lineIndex: i, sourceLines: it.sourceLines || [], readingFlags: [...(flagsByLine.get(i) || [])] })),
    };
  });
}

// Optional per-receipt "needs checking" selection. An empty selection means the whole batch.
const needsChecking = new Set();
export function receiptSelectId(r) { return r?.id; }
export function getNeedsChecking() { return new Set(needsChecking); }
export function setNeedsChecking(id, on) { if (on) needsChecking.add(id); else needsChecking.delete(id); }
export function clearNeedsChecking() { needsChecking.clear(); }

export function buildSanityPayload(batch, selectedIds = needsChecking) {
  const all = receiptsFromBatch(batch);
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const usedSelection = ids.size > 0;
  const receipts = usedSelection ? all.filter(r => ids.has(receiptSelectId(r))) : all;
  const scope = usedSelection ? 'selected' : 'batch';
  const label = usedSelection
    ? `${receipts.length} selected receipt${receipts.length === 1 ? '' : 's'} marked as needing checking`
    : `the whole batch (${all.length} receipt${all.length === 1 ? '' : 's'})`;
  return { receipts, scope, label, selectedCount: usedSelection ? receipts.length : 0, batchCount: all.length };
}

export function readingNetworkPolicy(mode, apiKey) {
  // Upload/read must never start /api/sanity-run or /api/lookup. /api/ocr only when
  // Settings > reader is "Tillroll server" (apiKey __server__); default reader is local.
  const server = mode === 'server' && String(apiKey || '').trim() === '__server__';
  return { mayCallOcr: server, mayCallSanityRun: false, mayCallLookup: false };
}

const RUN_HINT_IDLE = 'Upload and read at least one receipt, then run sanity checks.';
const RUN_HINT_READY = "Start the bots' review and show only the final agreed version";

export function syncRunButton(batch = window.tillrollV2Hooks?.getBatch?.() || []) {
  const btn = $('#v2-run');
  const bar = $('#v2-select-bar');
  const ready = receiptsFromBatch(batch).length > 0;
  if (btn) {
    btn.disabled = !ready;
    btn.title = ready ? RUN_HINT_READY : RUN_HINT_IDLE;
  }
  if (bar) bar.hidden = !ready;
  const all = $('#v2-check-all');
  if (all) {
    const ids = receiptsFromBatch(batch).map(receiptSelectId).filter(id => id != null);
    all.checked = ids.length > 0 && ids.every(id => needsChecking.has(id));
    all.indeterminate = needsChecking.size > 0 && !all.checked;
  }
}

export function receiptCheckHtml(r) {
  if (r.state !== 'done' || r.duplicateOf) return '';
  const on = needsChecking.has(r.id);
  return `<label class="v2-needs-check v2-only"><input type="checkbox" class="v2-check-receipt" value="${r.id}" ${on ? 'checked' : ''}> Needs checking</label>`;
}

// ---- Run sanity checks ------------------------------------------------------
async function runSanity() {
  const batch = window.tillrollV2Hooks?.getBatch?.() || [];
  const payload = buildSanityPayload(batch);
  const receipts = payload.receipts;
  if (!receipts.length) { note('Upload and read receipts first, then run sanity checks.'); return; }
  const btn = $('#v2-run'); btn.disabled = true;
  const panel = $('#v2-panel'); panel.hidden = false;
  panel.innerHTML = `<p class="v2-status" role="status">The bots are reviewing ${esc(payload.label)}. Only the final agreed version will appear here.</p>`;
  try {
    lastBatchId = 'b_' + Date.now().toString(36);
    await api('/api/batches', { method: 'POST', body: JSON.stringify({ batchId: lastBatchId, files: receipts.filter(r => r.sha256).map(r => ({ sha256: r.sha256, filename: r.filename })) }) }).catch(() => null);
    const res = await api('/api/sanity-run', { method: 'POST', body: JSON.stringify({ batchId: lastBatchId, receipts, mode: 'round1', selection: payload.scope }) });
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
      <div class="actions"><button id="v2-csv" class="quiet">Download CSV</button><button id="v2-xlsx" class="primary">Export Excel</button></div></div>
    ${out.lookupsPaused ? `<p class="v2-paused" style="background:#FDE68A">Look-ups are paused: ${esc((out.pausedReasons || []).join(' '))} Affected cells are flagged Amber.</p>` : ''}
    <p class="v2-summary">${rowsForExport(out).length} exportable rows of ${out.agreedRows.length} read · <span class="v2-chip" style="background:#FECDD3">${out.readingErrors.length} reading errors</span> · <span class="v2-chip" style="background:#FDE68A">${out.lookupUncertainties.length} look-up flags</span> · ${(out.reviewReceipts || []).length} receipt(s) held for review · ${out.excludedZeroCount} zero-price line(s) excluded</p>
    ${pinkList ? `<details open><summary>Reading errors to check first (Pink)</summary><ul>${pinkList}</ul></details>` : ''}
    ${amberList ? `<details><summary>Look-up uncertainty (Amber)</summary><ul>${amberList}</ul></details>` : ''}
    <div class="table-wrap"><table class="v2-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  $('#v2-csv').onclick = () => download('tillroll-agreed.csv', toCsv(out), 'text/csv;charset=utf-8');
  $('#v2-xlsx').onclick = () => exportAgreed(out);
}
const rowsForExport = out => Array.isArray(out?.exportableRows) ? out.exportableRows : (out?.agreedRows || []);
const toCsv = out => '\ufeff' + [COLUMNS, ...rowsForExport(out).map(r => COLUMNS.map(c => r.cells[c] ?? ''))].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
let driveReplace = null;
async function exportAgreed(out) {
  const { buildV2XlsxBlob, uploadExport } = await import('./v2-excel.js');
  const blob = await buildV2XlsxBlob(out);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'Tillroll receipts.xlsx'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  try {
    const saved = await uploadExport(blob, { name: 'Tillroll receipts.xlsx', batchId: lastBatchId });
    if (saved?.file?.id) driveReplace = { driveFileId: saved.file.id, name: saved.file.name || 'Tillroll receipts.xlsx' };
    note('Excel saved to Google Drive (Tillroll/Exports).');
  } catch (e) {
    note(e.message && /not set up|Drive|OAuth|sign/i.test(e.message) ? e.message : 'Excel downloaded. Connect Google Drive to store it in Tillroll/Exports.');
  }
}

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
    const wb = data.workbooks.find(w => w.workbook_id === btn.dataset.wb);
    const res = await api(`/api/workbooks/${encodeURIComponent(btn.dataset.wb)}/refresh`, { method: 'POST' });
    if (!res.ok) { btn.textContent = (await res.json().catch(() => ({}))).error || 'Refresh failed'; return; }
    try {
      const { readV2Workbook, applyV2Refresh } = await import('./v2-excel.js');
      const planned = await readV2Workbook(await res.arrayBuffer());
      if (planned.kind !== 'v2') throw new Error('This linked workbook is not a Tillroll v2 export.');
      driveReplace = { driveFileId: wb?.drive_file_id, name: wb?.name };
      const outcome = await applyV2Refresh(planned, { batchId: wb?.batch_id || lastBatchId, replace: driveReplace, download: true });
      lastResult = outcome.result; renderResult(outcome.result); d.close(); note(outcome.message);
    } catch (e) { btn.disabled = false; btn.textContent = e.message || 'Refresh failed'; }
  };
}
// One Reading History dialog. api() opens the unlock dialog on a locked 401
// and retries this request once. A dismissed unlock does not show local history.
// 5xx and network errors are the only offline fallback.
async function serverHistory(limit = 100) {
  try {
    const r = await api(`/api/history?limit=${encodeURIComponent(limit)}`);
    if (r.status === 401) {
      const body = await r.json().catch(() => ({}));
      if (body.code === 'locked') return { ok: false, status: 401, locked: true };
      return { ok: false, status: 401, error: body.error || 'History request was not authorized.' };
    }
    if (r.status >= 500) return { ok: false, status: r.status, offline: true };
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      return { ok: false, status: r.status, error: body.error || `History request failed (${r.status}).` };
    }
    const data = await r.json().catch(() => null);
    if (!data || !Array.isArray(data.entries)) return { ok: false, status: r.status, error: 'History response was not a list.' };
    return { ok: true, entries: data.entries };
  } catch { return { ok: false, status: 0, offline: true }; }
}

function onCheckChange(e) {
  const t = e.target;
  if (t?.id === 'v2-check-all') {
    const batch = window.tillrollV2Hooks?.getBatch?.() || [];
    for (const r of receiptsFromBatch(batch)) setNeedsChecking(receiptSelectId(r), t.checked);
    window.tillrollV2Hooks?.render?.();
    syncRunButton();
    return;
  }
  if (t?.classList?.contains('v2-check-receipt')) {
    setNeedsChecking(Number(t.value) || t.value, t.checked);
    syncRunButton();
  }
}

function init() {
  $('#v2-run')?.addEventListener('click', runSanity);
  window.tillrollV2Hooks = Object.assign(window.tillrollV2Hooks || {}, {
    batchId: () => lastBatchId,
    lastResult: () => lastResult,
    showResult: out => { lastResult = out; const panel = $('#v2-panel'); if (panel) panel.hidden = false; renderResult(out); },
    driveReplace: () => driveReplace,
    serverHistory,
    afterRender: syncRunButton,
    receiptCheckHtml,
    syncRunButton,
  });
  $('#v2-workbooks')?.addEventListener('click', openWorkbooks);
  document.addEventListener('change', onCheckChange);
  const china = $('#excel-china');
  if (china) {
    const localExport = china.onclick;
    // Same writer as the panel's Export Excel: buildV2XlsxBlob, which masks the tender.
    china.onclick = event => lastResult?.agreedRows ? exportAgreed(lastResult) : localExport?.call(china, event);
  }
  for (const b of document.querySelectorAll('[data-v2-close]')) b.onclick = () => document.getElementById(b.dataset.v2Close).close();
  const p = new URLSearchParams(location.search).get('drive');
  if (p === 'connected') note('Google Drive connected.'); else if (p === 'denied') note('Google Drive was not connected.');
  syncRunButton();
  refreshQuota(); refreshDrive();
}
const hasDom = typeof document !== 'undefined' && typeof location !== 'undefined';
if (hasDom && location.protocol.startsWith('http') && !location.hostname.endsWith('github.io')) init();
else if (hasDom) document.documentElement.classList.add('v2-static'); // GitHub Pages mirror: no backend
