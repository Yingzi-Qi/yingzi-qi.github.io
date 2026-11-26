// Tillroll v2 workbook. 10 visible Chinese columns, Pink #FECDD3 / Amber #FDE68A
// only, hidden system columns, cell comments for receipt-vs-official mismatches,
// and the Update/Refresh read-back (values + OOXML fills).
//
// Style index (xl/styles.xml cellXfs), owned here:
//   0 plain text
//   1 header (fill #1E4946 — not a flag colour)
//   2 plain money (#,##0.00)
//   3 amber text   #FDE68A
//   4 amber money  #FDE68A
//   5 pink text    #FECDD3
//   6 pink money   #FECDD3
// Fills: 0 none, 1 gray125, 2 header, 3 #FDE68A, 4 #FECDD3. No #FFEDC0.
//
// Refresh contract (browser reads the xlsx, then the existing endpoints):
//   POST /api/locks            { locks: [{ rowId, col }] }
//   POST /api/sanity-run       { mode:'round2', batchId, receipts:[{ items:[{
//                                rowId, editedCols, clearedCols, flaggedCols,
//                                previousItemId, previousCells, unitSettled:true, ... }] }] }
//   POST /api/drive/upload?folder=exports&name=&batchId=&replaceId=
// A cell that was Pink or Amber in the baseline and whose fill is now gone is
// a lock. It is never re-flagged. 销售金额 is a fixed number, never a formula.

import * as zipPackage from './export-vendor/jszip.min.js';
import { expandReceipt, joinPurchaseTime, round2, saleAmount, supplierVisibleName } from './units.js';
import { ALLOWED_TENDERS, TENDER_REASON, normaliseTender } from './tender.js';
import { withoutCardDigits } from './exports.js';

const JSZip = zipPackage.default ?? globalThis.JSZip;
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const WORKBOOK_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PINK = '#FECDD3';
export const AMBER = '#FDE68A';

export const VISIBLE_COLUMNS = ['采购小票id', '采购时间', '供应商', '品牌', '品名', '品牌货号', '采购商品原价', '采购商品金额', '采购商品方法', '销售金额'];
export const MONEY_COLUMNS = new Set(['采购商品原价', '采购商品金额', '销售金额']);
export const HIDDEN_COLUMNS = [
  'Tillroll row id', 'Tillroll receipt key', 'Tillroll source URLs', 'Tillroll confidence',
  'Tillroll match type', 'Tillroll original values', 'Tillroll price-fallback candidates', 'Tillroll other values',
];
const ALL_COLUMNS = [...VISIBLE_COLUMNS, ...HIDDEN_COLUMNS];

// cellXfs index for a flag colour. Money columns use the numeric format.
export function styleIndex(colour, money) {
  if (colour === AMBER) return money ? 4 : 3;
  if (colour === PINK) return money ? 6 : 5;
  return money ? 2 : 0;
}
export const STYLE = { plain: 0, header: 1, money: 2, amber: 3, amberMoney: 4, pink: 5, pinkMoney: 6 };

const esc = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const colName = n => (n > 26 ? colName(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(64 + ((n - 1) % 26) + 1);
const columnIndex = ref => {
  const m = /^([A-Z]+)/.exec(ref || '');
  return m ? [...m[1]].reduce((v, c) => v * 26 + c.charCodeAt(0) - 64, 0) - 1 : null;
};

const stylesXml = XML + `<styleSheet xmlns="${MAIN}">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  ['FF1E4946', 'FFFDE68A', 'FFFECDD3'].map(rgb => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`).join('') +
  `</fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="4" fontId="0" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment vertical="top"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="4" fontId="0" fillId="4" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment vertical="top"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function cellXml(row, col, { value, numeric, style }) {
  const attrs = ` r="${colName(col)}${row}" s="${style}"`;
  if (numeric && value !== null && value !== '' && Number.isFinite(Number(value))) return `<c${attrs}><v>${Number(value)}</v></c>`;
  if (value === null || value === undefined || value === '') return `<c${attrs}/>`;
  return `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(String(value).slice(0, 32767))}</t></is></c>`;
}

function agreedList(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    if (input.some(r => r?.cells && r?.rowId)) return input.filter(r => r?.cells);
    return input.filter(r => r?.data || r?.items).flatMap(receiptToRows);
  }
  if (Array.isArray(input.exportableRows)) return input.exportableRows;
  if (Array.isArray(input.agreedRows)) return input.agreedRows;
  return [];
}

// P4 tender first, then PR #1's card-digit backstop, on every row (receipts and
// agreedRows / Round 2). Flags for cash/empty are applied in receiptToRows
// (and already by the server); this step only rewrites the cell value.
function maskPaymentRow(row) {
  const v = row?.cells?.['采购商品方法'];
  const tender = normaliseTender(v);
  const masked = tender == null || tender === '' ? tender : withoutCardDigits(tender);
  if (masked === (v ?? null) || (masked == null && (v == null || v === ''))) return row;
  return { ...row, cells: { ...row.cells, '采购商品方法': masked } };
}

function receiptToRows(receipt) {
  const data = receipt.data || receipt;
  const expanded = expandReceipt({ ...data, receiptKey: receipt.receiptKey || receipt.hash || data.receiptKey || 'receipt' });
  const ts = data['采购时间'] || joinPurchaseTime(data.date, data.time);
  const tender = normaliseTender(data.payment);
  return expanded.items.map(it => {
    const cells = {
      '采购小票id': data.receiptReference || data.orderNumber || data.orderId || null,
      '采购时间': ts,
      '供应商': supplierVisibleName(data.merchant, null),
      '品牌': it.brand || null,
      '品名': it.item || null,
      '品牌货号': it.itemId || null,
      '采购商品原价': it.unitPrice,
      '采购商品金额': it.amount,
      '采购商品方法': tender,
      '销售金额': saleAmount(it.unitPrice),
    };
    const flags = {};
    const comments = {};
    if (it.discountKind === 'estimated' && typeof cells['采购商品金额'] === 'number') flags['采购商品金额'] = AMBER;
    if ((it.unitPrice === 0 || it.amount === 0) && it.zeroConfirmed !== true) flags['采购商品原价'] = PINK;
    if (!tender || !ALLOWED_TENDERS.includes(tender)) {
      flags['采购商品方法'] = PINK;
      comments['采购商品方法'] = TENDER_REASON;
    }
    return {
      rowId: it.rowId, receiptKey: data.receiptKey || receipt.receiptKey || 'receipt', lineIndex: it.lineIndex,
      cells, flags, notes: [], lookup: null,
      exportMeta: { discountKind: it.discountKind || 'none', currency: data.currency || null, alternates: {}, comments },
    };
  });
}

function metaOf(row) {
  return row.exportMeta || row.meta || {};
}
export function normaliseConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim().toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high') return s;
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value).trim();
}
export function sourceUrlList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return String(value).split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean);
}
function baselineFor(row, exportKey) {
  const meta = metaOf(row);
  const reasons = meta.flagReasons || row.flagReasons || {};
  return {
    v: 2, exportKey, rowId: row.rowId, receiptKey: row.receiptKey || null,
    currency: meta.currency || row.currency || 'GBP',
    discountKind: meta.discountKind || 'none',
    cells: Object.fromEntries(VISIBLE_COLUMNS.map(c => [c, row.cells?.[c] ?? null])),
    // Explicit null means the cell was unflagged. Round 2 keeps this unless the cell is cleared, edited, or re-looked-up.
    flags: Object.fromEntries(VISIBLE_COLUMNS.map(c => [c, row.flags?.[c] === PINK || row.flags?.[c] === AMBER ? row.flags[c] : null])),
    flagReasons: Object.fromEntries(Object.entries(reasons).filter(([, reason]) => reason)),
    storeClues: meta.storeClues || row.storeClues || null,
    sourceUrls: sourceUrlList(meta.sourceUrls || row.lookup?.sourceUrls),
    confidence: normaliseConfidence(meta.confidence ?? row.lookup?.confidence),
    matchType: meta.matchType || row.lookup?.matchType || null,
    alternates: meta.alternates || {},
    comments: meta.comments || {},
    gateNotes: meta.gateNotes || null,
    // Receipt-level evidence must survive a workbook refresh so Round 2 can
    // re-run the same deterministic gate instead of guessing from rows.
    receiptEvidence: meta.receiptEvidence || row.receiptEvidence || null,
    pendingOwnerConfirmation: meta.pendingOwnerConfirmation || null,
  };
}

function sheetDocument(headers, dataRows, { hiddenFrom = Infinity, legacy = '' } = {}) {
  const width = 22;
  const all = [headers, ...dataRows];
  const rowXml = (n, cells) => `<row r="${n}" ht="32" customHeight="1">${cells.map((cell, i) => cellXml(n, i + 1, cell)).join('')}</row>`;
  const cols = headers.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"${i >= hiddenFrom ? ' hidden="1"' : ''}/>`).join('');
  const lastRow = Math.max(1, all.length);
  const range = `A1:${colName(headers.length)}${lastRow}`;
  const filter = `A1:${colName(Math.min(headers.length, hiddenFrom))}${lastRow}`;
  return XML + `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="${range}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" state="frozen" topLeftCell="A2" activePane="bottomLeft"/>` +
    `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="32" defaultColWidth="${width}"/><cols>${cols}</cols><sheetData>` +
    all.map((cells, i) => rowXml(i + 1, cells)).join('') +
    `</sheetData><autoFilter ref="${filter}"/>${legacy}</worksheet>`;
}
function textCell(value, style = 0) {
  return { value: value ?? '', numeric: false, style };
}
function moneyCell(value, colour) {
  const numeric = typeof value === 'number';
  return { value, numeric, style: styleIndex(numeric ? colour : null, numeric) };
}

export async function buildV2XlsxBlob(input, { exportKey = (globalThis.crypto?.randomUUID?.() || `exp-${Date.now()}`) } = {}) {
  const rows = agreedList(input).map(maskPaymentRow);
  if (rows.length > 1048575) throw new Error('This batch exceeds the number of item rows allowed in one Excel worksheet.');
  const comments = [];
  const body = rows.map((row, i) => {
    const baseline = baselineFor(row, exportKey);
    const meta = metaOf(row);
    const hidden = [
      row.rowId,
      row.receiptKey || '',
      sourceUrlList(meta.sourceUrls || row.lookup?.sourceUrls).join(' | '),
      normaliseConfidence(meta.confidence ?? row.lookup?.confidence) ?? '',
      meta.matchType || row.lookup?.matchType || '',
      JSON.stringify(baseline),
      JSON.stringify(meta.candidates || row.priceFallbackCandidates || []),
      JSON.stringify(meta.alternates || {}),
    ];
    const cells = VISIBLE_COLUMNS.map(col => {
      const value = row.cells?.[col] ?? null;
      const money = MONEY_COLUMNS.has(col);
      const colour = row.flags?.[col] === PINK || row.flags?.[col] === AMBER ? row.flags[col] : null;
      const comment = meta.comments?.[col];
      if (comment) comments.push({ ref: `${colName(VISIBLE_COLUMNS.indexOf(col) + 1)}${i + 2}`, text: comment });
      // A price cell is a finite number or empty. Never inline text.
      const numeric = money && typeof value === 'number' && Number.isFinite(value);
      return { value: numeric || !money ? value : null, numeric, style: styleIndex(colour, numeric) };
    }).concat(hidden.map(value => ({ value, numeric: false, style: 0 })));
    return cells;
  });
  const header = ALL_COLUMNS.map(title => ({ value: title, numeric: false, style: STYLE.header }));
  const legacy = comments.length ? `<legacyDrawing r:id="rIdVml"/>` : '';
  const worksheet = sheetDocument(header, body, { hiddenFrom: VISIBLE_COLUMNS.length, legacy });
  const excluded = Array.isArray(input?.excludedZero) ? input.excludedZero : [];
  const zeroHeaders = ['采购小票id', '采购时间', 'Tillroll receipt key', 'Line', '品名', 'Qty', '采购商品原价', '采购商品金额', 'Reason'].map(title => textCell(title, STYLE.header));
  const zeroRows = excluded.map(z => [
    textCell(z.receiptId || z['采购小票id']),
    textCell(z.purchaseTime || z['采购时间']),
    textCell(z.receiptKey), textCell(z.lineIndex), textCell(z.name), textCell(z.qty),
    moneyCell(z.unitPrice, null), moneyCell(z.amount, null), textCell(z.reason || 'Confirmed printed zero.'),
  ]);
  const flagHeaders = ['Tillroll row id', 'Tillroll receipt key', 'Column', 'Value', 'Flag', 'Reason'].map(title => textCell(title, STYLE.header));
  const flagRows = [];
  for (const row of rows) {
    const reasons = metaOf(row).flagReasons || row.flagReasons || {};
    for (const col of VISIBLE_COLUMNS) {
      const colour = row.flags?.[col];
      if (colour !== PINK && colour !== AMBER) continue;
      const value = row.cells?.[col];
      flagRows.push([
        textCell(row.rowId), textCell(row.receiptKey), textCell(col),
        MONEY_COLUMNS.has(col) ? moneyCell(value, colour) : textCell(value, styleIndex(colour, false)),
        textCell(colour, styleIndex(colour, false)),
        textCell(reasons[col] || ''),
      ]);
    }
  }
  const reviewHeaders = ['采购小票id', 'Tillroll receipt key', 'Image link', 'Failing check'];
  const reviewRows = (Array.isArray(input?.reviewReceipts) ? input.reviewReceipts : []).map(review => [
    textCell(review.receiptId), textCell(review.receiptKey), textCell(review.imageLink), textCell((review.failingChecks || []).join(' ')),
  ]);
  const hasReviewSheet = Array.isArray(input?.reviewReceipts);
  const zip = new JSZip();
  const overrides = [
    ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
    ['/xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
    ['/xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
    ['/xl/worksheets/sheet2.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
    ['/xl/worksheets/sheet3.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
  ];
  if (hasReviewSheet) overrides.push(['/xl/worksheets/sheet4.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']);
  if (comments.length) overrides.push(['/xl/comments1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml']);
  zip.file('[Content_Types].xml', XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    (comments.length ? `<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>` : '') +
    overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') + `</Types>`);
  zip.file('_rels/.rels', XML + `<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', XML + `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
    `<sheet name="Line items" sheetId="1" r:id="rId1"/>` +
    `<sheet name="Excluded zero items" sheetId="2" r:id="rId3"/>` +
    `<sheet name="Flags" sheetId="3" r:id="rId4"/>` +
    (hasReviewSheet ? `<sheet name="Review receipts" sheetId="4" r:id="rId5"/>` : '') +
    `</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', XML + `<Relationships xmlns="${PACKAGE}">` +
    `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
    `<Relationship Id="rId4" Type="${REL}/worksheet" Target="worksheets/sheet3.xml"/>` +
    (hasReviewSheet ? `<Relationship Id="rId5" Type="${REL}/worksheet" Target="worksheets/sheet4.xml"/>` : '') +
    `</Relationships>`);
  zip.file('xl/worksheets/sheet2.xml', sheetDocument(zeroHeaders, zeroRows));
  zip.file('xl/worksheets/sheet3.xml', sheetDocument(flagHeaders, flagRows));
  if (hasReviewSheet) zip.file('xl/worksheets/sheet4.xml', sheetDocument(reviewHeaders.map(title => textCell(title, STYLE.header)), reviewRows));
  const sheetRels = comments.length
    ? XML + `<Relationships xmlns="${PACKAGE}"><Relationship Id="rIdComments" Type="${REL}/comments" Target="../comments1.xml"/><Relationship Id="rIdVml" Type="${REL}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/></Relationships>`
    : XML + `<Relationships xmlns="${PACKAGE}"/>`;
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', sheetRels);
  zip.file('xl/worksheets/sheet1.xml', worksheet);
  zip.file('xl/styles.xml', stylesXml);
  if (comments.length) {
    const list = comments.map((c, i) => `<comment ref="${c.ref}" authorId="0" shapeId="${i + 1}"><text><r><rPr><b/><sz val="9"/><color rgb="FF192A23"/><rFont val="Calibri"/></rPr><t xml:space="preserve">${esc(c.text)}</t></r></text></comment>`).join('');
    zip.file('xl/comments1.xml', XML + `<comments xmlns="${MAIN}"><authors><author>Tillroll</author></authors><commentList>${list}</commentList></comments>`);
    const shapes = comments.map((c, i) => `<v:shape id="cmt${i + 1}" type="#_x0000_t202" style="width:140pt;height:48pt" fillcolor="#FDE68A" o:insetmode="auto"><v:fill color2="#FDE68A"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>1, 15, 0, 2, 3, 15, 4, 2</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${Number(c.ref.replace(/^[A-Z]+/, '')) - 1}</x:Row><x:Column>${columnIndex(c.ref)}</x:Column></x:ClientData></v:shape>`).join('');
    zip.file('xl/drawings/vmlDrawing1.vml', `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes}</xml>`);
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return new Blob([bytes], { type: WORKBOOK_MIME });
}

// ---- read back values, fills and comments ---------------------------------

function decodeXml(s) {
  return String(s ?? '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z:_-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}
function blocks(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}>)`, 'g');
  for (const m of xml.matchAll(re)) out.push({ attrs: attrs(m[1] || ''), body: m[2] || '', raw: m[0] });
  return out;
}

async function loadZip(file) {
  const buf = file instanceof ArrayBuffer ? file
    : ArrayBuffer.isView(file) ? file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    : typeof file?.arrayBuffer === 'function' ? await file.arrayBuffer()
    : file;
  return JSZip.loadAsync(buf);
}
async function partText(zip, path) {
  const entry = zip.file(path);
  if (!entry) return null;
  return entry.async('string');
}

function parseFills(styles) {
  const fillsParent = blocks(styles, 'fills')[0];
  const fills = blocks(fillsParent?.body || '', 'fill').map(fill => {
    const pattern = blocks(fill.body, 'patternFill')[0];
    const rgb = blocks(pattern?.body || '', 'fgColor')[0]?.attrs.rgb || '';
    return { pattern: pattern?.attrs.patternType || null, rgb: rgb.slice(-6).toUpperCase() };
  });
  const xfs = blocks(blocks(styles, 'cellXfs')[0]?.body || '', 'xf').map(xf => {
    if (xf.attrs.applyFill === '0') return null;
    const fill = fills[Number(xf.attrs.fillId || 0)];
    if (!fill || fill.pattern !== 'solid') return null;
    if (fill.rgb === 'FECDD3') return PINK;
    if (fill.rgb === 'FDE68A') return AMBER;
    return null;
  });
  return xfs;
}
function inlineText(isBody) {
  const runs = [...(isBody || '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1]));
  return runs.join('');
}
function cellOf(raw, strings, fills) {
  const a = attrs(raw.match(/^<c\b([^>]*?)>/)?.[1] || '');
  const ref = a.r || '';
  const type = a.t || 'n';
  const style = fills[Number(a.s || 0)] ?? null;
  let value = null;
  if (type === 'inlineStr') value = inlineText(raw.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] || '');
  else if (type === 's') value = strings[Number(raw.match(/<v>([\s\S]*?)<\/v>/)?.[1] || 0)] ?? '';
  else {
    const v = raw.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    value = v === undefined ? null : decodeXml(v);
  }
  return { ref, col: columnIndex(ref), style, value, type };
}

export async function readV2Workbook(file) {
  const zip = await loadZip(file);
  const sheet = await partText(zip, 'xl/worksheets/sheet1.xml');
  if (!sheet) throw Object.assign(new Error('Choose a Tillroll Excel export with a Line items worksheet.'), { v2: true });
  const styles = await partText(zip, 'xl/styles.xml');
  const fills = styles ? parseFills(styles) : [];
  const shared = await partText(zip, 'xl/sharedStrings.xml');
  const strings = shared ? blocks(shared, 'si').map(si => inlineText(si.body)) : [];
  const commentsXml = await partText(zip, 'xl/comments1.xml');
  const commentByRef = new Map();
  if (commentsXml) for (const c of blocks(commentsXml, 'comment')) commentByRef.set(c.attrs.ref, inlineText(c.body));

  const sheetData = sheet.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)?.[1] || '';
  const rows = [...sheetData.matchAll(/<row\b([^>]*?)>([\s\S]*?)<\/row>/g)];
  if (!rows.length) throw Object.assign(new Error('The Line items worksheet is empty.'), { v2: true });
  const headerCells = [...rows[0][2].matchAll(/<c\b[\s\S]*?(?:\/>|<\/c>)/g)].map(m => cellOf(m[0], strings, fills));
  const headers = new Map();
  headerCells.forEach(cell => { if (cell.col !== null && cell.value) headers.set(cell.col, String(cell.value).trim()); });
  if (![...headers.values()].includes('采购小票id')) {
    return { kind: 'legacy' };
  }
  // Main's pre-v2 中文 Excel (Chinese columns + hidden English detailed columns with
  // 'Tillroll line key'): keep it on the legacy refresh path (clearedFields/manualClears).
  if (!new Set(headers.values()).has('Tillroll row id') && new Set(headers.values()).has('Tillroll line key')) {
    return { kind: 'legacy' };
  }
  for (const title of VISIBLE_COLUMNS) {
    if (![...headers.values()].includes(title)) throw Object.assign(new Error('Missing ' + title + ' column. Choose a complete Tillroll export.'), { v2: true });
  }
  const colByName = new Map([...headers].map(([i, name]) => [name, i]));

  const parsed = [];
  for (const row of rows.slice(1)) {
    const rowNumber = Number(attrs(row[1]).r) || parsed.length + 2;
    const cells = [...row[2].matchAll(/<c\b[\s\S]*?(?:\/>|<\/c>)/g)].map(m => cellOf(m[0], strings, fills));
    const byCol = new Map(cells.map(c => [c.col, c]));
    const values = {}, fillsByCol = {}, commentsByCol = {};
    for (const [name, index] of colByName) {
      const cell = byCol.get(index);
      let value = cell ? cell.value : null;
      if (MONEY_COLUMNS.has(name)) {
        if (value === null || value === '') value = null;
        else {
          const n = Number(value);
          value = Number.isFinite(n) ? round2(n) : value;
        }
      } else if (name === 'Tillroll confidence') value = normaliseConfidence(value);
      else if (name === 'Tillroll source URLs') value = sourceUrlList(value).join(' | ') || null;
      else if (typeof value === 'string') value = value.trim() === '' ? null : value;
      values[name] = value ?? null;
      if (cell?.style) fillsByCol[name] = cell.style;
      const ref = `${colName(index + 1)}${rowNumber}`;
      if (commentByRef.has(ref)) commentsByCol[name] = commentByRef.get(ref);
    }
    if (VISIBLE_COLUMNS.every(name => values[name] === null) && !values['Tillroll row id']) continue;
    let baseline = null;
    try { baseline = JSON.parse(values['Tillroll original values'] || 'null'); } catch { baseline = null; }
    if (!baseline?.cells || !baseline.rowId) throw Object.assign(new Error('Missing original receipt information in row ' + rowNumber + '. Export a fresh workbook.'), { v2: true });
    parsed.push({ rowNumber, values, fills: fillsByCol, comments: commentsByCol, baseline, rowId: baseline.rowId || values['Tillroll row id'] });
  }
  if (!parsed.length) throw Object.assign(new Error('The workbook has no receipt rows to refresh.'), { v2: true });
  const excludedZero = await readExcludedZeros(zip);
  const planned = planRefresh(parsed);
  if (excludedZero.length) for (const receipt of planned.receipts) receipt.excludedZero = excludedZero.filter(z => !z.receiptKey || z.receiptKey === receipt.receiptKey);
  return { kind: 'v2', exportKey: parsed[0].baseline.exportKey || null, excludedZero, ...planned };
}

async function sheetPath(zip, name) {
  const book = await partText(zip, 'xl/workbook.xml');
  const rels = await partText(zip, 'xl/_rels/workbook.xml.rels');
  if (!book || !rels) return null;
  const sheet = blocks(book, 'sheet').find(s => s.attrs.name === name);
  if (!sheet) return null;
  const rid = sheet.attrs['r:id'];
  const rel = blocks(rels, 'Relationship').find(r => r.attrs.Id === rid);
  if (!rel?.attrs.Target) return null;
  const target = rel.attrs.Target.replace(/^\//, '');
  return target.startsWith('xl/') ? target : `xl/${target}`;
}
async function readExcludedZeros(zip) {
  const path = await sheetPath(zip, 'Excluded zero items');
  const xml = path ? await partText(zip, path) : null;
  if (!xml) return [];
  const sheetData = xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)?.[1] || '';
  const rows = [...sheetData.matchAll(/<row\b([^>]*?)>([\s\S]*?)<\/row>/g)];
  if (rows.length < 2) return [];
  const headers = [...rows[0][2].matchAll(/<c\b[\s\S]*?(?:\/>|<\/c>)/g)].map(m => cellOf(m[0], [], []));
  const col = title => headers.find(h => h.value === title)?.col;
  const at = (cells, title) => {
    const i = col(title);
    return i === undefined ? null : (cells.find(c => c.col === i)?.value ?? null);
  };
  const out = [];
  for (const row of rows.slice(1)) {
    const cells = [...row[2].matchAll(/<c\b[\s\S]*?(?:\/>|<\/c>)/g)].map(m => cellOf(m[0], [], []));
    const name = at(cells, '品名');
    if (!name && at(cells, 'Tillroll receipt key') == null) continue;
    const unit = at(cells, '采购商品原价'), amount = at(cells, '采购商品金额'), qty = at(cells, 'Qty');
    out.push({
      receiptKey: at(cells, 'Tillroll receipt key'),
      receiptId: at(cells, '采购小票id'),
      purchaseTime: at(cells, '采购时间'),
      lineIndex: Number(at(cells, 'Line')),
      name, qty: qty === null || qty === '' ? null : Number(qty),
      unitPrice: unit === null || unit === '' ? null : Number(unit),
      amount: amount === null || amount === '' ? null : Number(amount),
      reason: at(cells, 'Reason') || 'Confirmed printed zero.',
    });
  }
  return out;
}

function sameValue(column, a, b) {
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  if (MONEY_COLUMNS.has(column) || typeof a === 'number' || typeof b === 'number') {
    const na = Number(a), nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.001;
  }
  return String(a) === String(b);
}

// Diff one uploaded sheet against its baseline JSON and the fills Excel saved.
export function planRefresh(parsedRows) {
  const locks = [], rows = [];
  for (const row of parsedRows) {
    const baseFlags = row.baseline.flags || {};
    const baseCells = row.baseline.cells || {};
    const editedCols = [], clearedCols = [], flaggedCols = [];
    for (const col of VISIBLE_COLUMNS) {
      const was = baseFlags[col];
      const now = row.fills[col] || null;
      if (was === PINK || was === AMBER) {
        if (!now) clearedCols.push(col);
        else flaggedCols.push(col);
      } else if (now) flaggedCols.push(col);
      if (!sameValue(col, baseCells[col], row.values[col])) editedCols.push(col);
    }
    for (const col of clearedCols) locks.push({ rowId: row.rowId, col });
    rows.push({
      rowNumber: row.rowNumber,
      rowId: row.rowId,
      receiptKey: row.baseline.receiptKey || row.values['Tillroll receipt key'] || null,
      currency: row.baseline.currency || 'GBP',
      discountKind: row.baseline.discountKind || 'none',
      values: row.values,
      fills: row.fills,
      editedCols, clearedCols, flaggedCols,
      previousCells: baseCells,
      previousItemId: baseCells['品牌货号'] ?? null,
      comments: row.comments,
      baseline: row.baseline,
    });
  }
  const byReceipt = new Map();
  for (const row of rows) {
    const key = row.receiptKey || row.rowId;
    if (!byReceipt.has(key)) byReceipt.set(key, []);
    byReceipt.get(key).push(row);
  }
  const receipts = [...byReceipt].map(([receiptKey, group]) => {
    const first = group[0];
    const evidence = first.baseline.receiptEvidence || null;
    const storeClues = group.map(row => row.baseline.storeClues).find(v => v && typeof v === 'object') || null;
    return {
      receiptKey,
      merchant: first.values['供应商'],
      receiptReference: first.values['采购小票id'],
      date: first.values['采购时间'],
      time: null,
      payment: first.values['采购商品方法'],
      currency: first.currency || 'GBP',
      storeClues,
      layout: evidence?.layout || null,
      layoutStatus: evidence?.layoutStatus || null,
      gateRequired: Boolean(evidence?.layoutStatus || evidence?.layout),
      parserReasons: evidence?.parserReasons || [],
      total: evidence?.total ?? null,
      itemCountCheck: evidence?.itemCountCheck || null,
      imageLink: evidence?.imageLink || null,
      sha256: evidence?.sha256 || null,
      items: group.map(row => {
        const baseFlags = row.baseline.flags || {};
        const readingFlags = VISIBLE_COLUMNS.filter(col => baseFlags[col] === PINK && !row.clearedCols.includes(col) && !row.editedCols.includes(col));
        return {
          rowId: row.rowId,
          unitSettled: true,
          qty: 1,
          brand: row.values['品牌'],
          item: row.values['品名'],
          itemId: row.values['品牌货号'],
          unitPrice: row.values['采购商品原价'],
          amount: row.values['采购商品金额'],
          discountKind: row.discountKind,
          discount: typeof row.values['采购商品原价'] === 'number' && typeof row.values['采购商品金额'] === 'number'
            ? round2(row.values['采购商品原价'] - row.values['采购商品金额']) : 0,
          editedCols: row.editedCols,
          clearedCols: row.clearedCols,
          flaggedCols: row.flaggedCols,
          readingFlags,
          baselineFlags: baseFlags,
          baselineFlagReasons: row.baseline.flagReasons || {},
          baselineConfidence: normaliseConfidence(row.baseline.confidence ?? row.values['Tillroll confidence']),
          baselineSourceUrls: sourceUrlList(row.baseline.sourceUrls?.length ? row.baseline.sourceUrls : row.values['Tillroll source URLs']),
          baselineMatchType: row.baseline.matchType || row.values['Tillroll match type'] || null,
          previousItemId: row.editedCols.includes('品牌货号') ? row.previousItemId : null,
          previousCells: row.previousCells,
          sourceLines: evidence?.sourceLines || [],
        };
      }),
    };
  });
  return { rows, locks, receipts };
}

export function round2Body(planned, batchId) {
  return { batchId: batchId || planned.exportKey || 'refresh', mode: 'round2', receipts: planned.receipts };
}

// Browser hook: locks, then Round 2, then a new workbook back to Tillroll/Exports.
export async function applyV2Refresh(planned, hooks = {}) {
  const post = hooks.post || defaultPost;
  if (planned.locks?.length) await post('/api/locks', { locks: planned.locks });
  const start = await post('/api/sanity-run', round2Body(planned, hooks.batchId));
  const result = hooks.poll ? await hooks.poll(start) : await pollSanity(start.runId || start, post);
  const blob = await buildV2XlsxBlob(result);
  let uploaded = null;
  if (hooks.replace?.driveFileId && hooks.upload !== false) {
    const name = hooks.replace.name || 'tillroll-refresh.xlsx';
    uploaded = await postBinary(`/api/drive/upload?folder=exports&name=${encodeURIComponent(name)}&batchId=${encodeURIComponent(hooks.batchId || '')}&replaceId=${encodeURIComponent(hooks.replace.driveFileId)}`, blob);
  }
  if (hooks.download !== false && typeof document !== 'undefined') downloadBlob(blob, hooks.replace?.name || 'Tillroll receipts.xlsx');
  const message = `${planned.locks.length} confirmed cell${planned.locks.length === 1 ? '' : 's'} locked. Round 2 updated ${result?.agreedRows?.length || 0} rows.`;
  return { result, blob, uploaded, locks: planned.locks, message };
}

async function defaultPost(path, body) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}
async function postBinary(path, blob) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': WORKBOOK_MIME }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status}).`);
  return data;
}
async function pollSanity(runId, post) {
  let wait = 1500;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, wait));
    const res = await fetch(`/api/sanity-run/${encodeURIComponent(runId)}`, { credentials: 'same-origin' });
    const out = await res.json();
    if (out.status === 'completed') return out;
    if (out.status === 'failed') throw new Error(out.error || 'Round 2 did not finish.');
    wait = Math.min(out.pollAfterMs || 2000, 4000);
  }
  throw new Error('Round 2 did not finish.');
  void post;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function uploadExport(blob, { name, batchId, postBinary: send = postBinary } = {}) {
  const fileName = name || `tillroll-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return send(`/api/drive/upload?folder=exports&name=${encodeURIComponent(fileName)}&batchId=${encodeURIComponent(batchId || '')}`, blob);
}
