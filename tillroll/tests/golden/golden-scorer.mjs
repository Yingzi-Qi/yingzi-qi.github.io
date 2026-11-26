import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import JSZip from '../../export-vendor/jszip.min.js';
import * as reader from '../../extract.js';
import {inspectReference} from '../../reference.js';
import {checkReceipt} from '../../checks.js';
import {buildSanityPayload} from '../../v2.js';
import {VISIBLE_COLUMNS, PINK, AMBER, buildV2XlsxBlob, readV2Workbook} from '../../v2-excel.js';
import {runSanity} from '../../../tillroll-cloudflare/functions/_lib/sanity.js';
import {sanitiseRunInput} from '../../../tillroll-cloudflare/functions/_lib/sanitise-run-input.js';
import {makeEnv} from '../../../tillroll-cloudflare/tests/helpers.mjs';

export const GOLDEN_COLUMNS = VISIBLE_COLUMNS;
const colours = {[PINK]: 'Pink', [AMBER]: 'Amber'};
const percent = (count, total) => total ? Math.round(10000 * count / total) / 100 : null;

function validateDataset(dataset) {
  const ids = new Set();
  if (!Array.isArray(dataset.fixtures) || !dataset.fixtures.length) throw new Error('At least one receipt is required.');
  if (!Number.isFinite(Date.parse(dataset.asOf))) throw new Error('Supply asOf as an ISO timestamp.');
  for (const fixture of dataset.fixtures) {
    if (!fixture.id || ids.has(fixture.id)) throw new Error('Receipt fixture IDs must be present and unique.');
    ids.add(fixture.id);
    if (!fixture.ocr?.lines?.length) throw new Error(`Missing OCR for ${fixture.id}.`);
    const expected = fixture.expected;
    if (!['pass','review'].includes(expected?.gate) || !Array.isArray(expected.rows))
      throw new Error(`Supply expected.gate and expected.rows for ${fixture.id}.`);
    if (expected.gate === 'review' && (!expected.reviewReason?.trim() || expected.rows.length))
      throw new Error(`A review receipt needs a reviewReason and zero main-sheet rows: ${fixture.id}.`);
    if (expected.gate === 'pass' && !expected.rows.length) throw new Error(`A pass receipt needs unit rows: ${fixture.id}.`);
    for (const row of expected.rows) {
      if (VISIBLE_COLUMNS.some(col => !Object.hasOwn(row, col))) throw new Error(`Supply all ten columns for ${fixture.id}.`);
      for (const [col, flag] of Object.entries(row.flags || {})) {
        if (!VISIBLE_COLUMNS.includes(col) || !['Pink','Amber'].includes(flag.status) || !flag.evidence?.trim() || !flag.reasonIncludes?.trim())
          throw new Error(`Invalid expected flag for ${fixture.id} / ${col}.`);
      }
      if (VISIBLE_COLUMNS.some(col => row[col] === null && !row.flags?.[col])) throw new Error(`Explain every expected blank for ${fixture.id}.`);
    }
  }
}

function inputPhoto(fixture, today) {
  const {id, ocr} = fixture;
  const hash = fixture.sha256 || createHash('sha256').update(id).digest('hex');
  const parseReceipt = reader.extractStrictReceipt || reader.extractLocal;
  const data = parseReceipt(ocr);
  const reference = inspectReference(data, ocr);
  return {id, hash, filename: fixture.filename || id + '.png', state: 'done', data, ocr,
    review: checkReceipt(data, ocr, null, {reference, today})};
}

async function readReviewSheet(blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const parse = part => new JSDOM(part, {contentType: 'text/xml'}).window.document;
  const book = parse(await zip.file('xl/workbook.xml').async('string'));
  const sheet = [...book.querySelectorAll('sheet')].find(entry => entry.getAttribute('name') === 'Review receipts');
  if (!sheet) return [];
  const rels = parse(await zip.file('xl/_rels/workbook.xml.rels').async('string'));
  const relation = [...rels.querySelectorAll('Relationship')].find(entry => entry.getAttribute('Id') === sheet.getAttribute('r:id'));
  const doc = parse(await zip.file('xl/' + relation.getAttribute('Target')).async('string'));
  return [...doc.querySelectorAll('sheetData > row')].slice(1).map(row => {
    const [receiptId, receiptKey, image, reason] = [...row.querySelectorAll('c')].map(cell => cell.textContent);
    return {receiptId, receiptKey, image, reason};
  });
}

export async function runGoldenBatch(dataset) {
  validateDataset(dataset);
  const env = makeEnv();
  for (const entry of dataset.catalogue || []) {
    await env.DB.prepare('INSERT INTO catalogue_items (brand,item_id,official_name,price_pence,currency,source_url) VALUES (?,?,?,?,?,?)')
      .bind(entry.brand, entry.itemId, entry.name, entry.pricePence, entry.currency, entry.url).run();
  }
  const now = new Date(dataset.asOf);
  const photos = dataset.fixtures.map(fixture => inputPhoto(fixture, now));
  const payload = buildSanityPayload(photos);
  const input = sanitiseRunInput({batchId:'golden', mode:'round1', receipts:payload.receipts});
  const {result} = await runSanity(env, input, {now});
  const blob = await buildV2XlsxBlob(result);
  let rows;
  try { ({rows} = await readV2Workbook(blob)); }
  catch (error) {
    if (error.message !== 'The workbook has no receipt rows to refresh.') throw error;
    rows = [];
  }
  const review = await readReviewSheet(blob);
  const keys = new Map(input.receipts.map(receipt => [receipt.id, receipt.receiptKey]));
  const gates = result.receiptGates || [];
  const gatesByFixture = new Map(dataset.fixtures.map((fixture, index) => [fixture.id, gates[index]]));
  return {rows, review, gates, gatesByFixture, keys};
}

function compareCell(wantRow, readRow, col) {
  const expected = wantRow[col], got = readRow.values[col];
  const flag = wantRow.flags?.[col];
  const status = colours[readRow.fills[col]];
  const reason = readRow.baseline?.flagReasons?.[col] || readRow.comments?.[col] || '';
  if (flag) {
    if (!status) return {expected, got, status:'WRONG', reason:'Expected review flag is missing.'};
    if (!reason.trim()) return {expected, got, status:'WRONG', reason:'Coloured cell has no written reason.'};
    if (status !== flag.status || !reason.toLowerCase().includes(flag.reasonIncludes.toLowerCase()))
      return {expected, got, status:'WRONG', reason:`Expected ${flag.status} / ${flag.reasonIncludes}. Got ${status} / ${reason}`};
    if (got !== null && expected !== got) return {expected, got, status:'WRONG', reason:'Cell value differs from the confirmed value.'};
    return {expected, got, status, reason, evidence:flag.evidence};
  }
  if (status) {
    if (!reason.trim()) return {expected, got, status:'WRONG', reason:'Coloured cell has no written reason.'};
    return {expected, got, status, reason};
  }
  if (got !== null && expected !== got) return {expected, got, status:'WRONG', reason:'Cell value differs from the confirmed value.'};
  if (got === null) return {expected, got, status:'WRONG', reason:'Cell is blank without a flag.'};
  return {expected, got, status:'OK', reason:''};
}

export function scoreResults(dataset, actual) {
  const table = [], receipts = [];
  const resultKeys = new Set(actual.keys.values());
  for (const fixture of dataset.fixtures) {
    const receipt = fixture.id, want = fixture.expected;
    const key = actual.keys.get(receipt);
    const expectedReceiptId = want.receiptId || fixture.expected.receipt?.receiptId || receipt;
    const rows = want.gate === 'review' ? [] : actual.rows.filter(row => row.values['Tillroll receipt key'] === key);
    const reviewMatches = actual.review.filter(row => row.receiptId === expectedReceiptId);
    const reviewOffset = dataset.fixtures.slice(0, dataset.fixtures.indexOf(fixture))
      .filter(previous => previous.expected.gate === 'review' && (previous.expected.receiptId || previous.id) === expectedReceiptId).length;
    const review = want.gate === 'review' ? reviewMatches.slice(reviewOffset, reviewOffset + 1) : [];
    const decisions = actual.gatesByFixture?.has(fixture.id)
      ? [actual.gatesByFixture.get(fixture.id)]
      : actual.gates.filter(gate => gate.receiptId === expectedReceiptId);
    const details = [];
    const add = (field, expected, got, ok, reason='') => details.push({receipt, row:null, field, expected, got, status:ok?'OK':'WRONG', reason});
    add('Receipt gate', want.gate, decisions.map(gate => gate.status).join(', '),
      decisions.length === 1 && decisions[0].status === want.gate, decisions.flatMap(gate => gate.reasons || []).join(' '));
    add('Main sheet rows', want.rows.length, rows.length, rows.length === want.rows.length);
    add('Review sheet rows', want.gate === 'review' ? 1 : 0, review.length, review.length === (want.gate === 'review' ? 1 : 0));
    if (want.gate === 'review' && review.length === 1) {
      const printed = review[0];
      const ok = printed.reason.toLowerCase().includes(want.reviewReason.toLowerCase()) && Boolean(printed.image?.trim());
      add('Review reason and image', want.reviewReason, printed.reason, ok, printed.image ? '' : 'Source image reference missing.');
      if (Object.hasOwn(want, 'receiptId')) add('Review receipt ID', want.receiptId, printed.receiptId || null, (printed.receiptId || null) === want.receiptId);
    }
    for (let i = 0; i < Math.max(want.rows.length, rows.length); i++) {
      for (const field of VISIBLE_COLUMNS) {
        let cell;
        if (!want.rows[i] || !rows[i]) {
          cell = {expected:want.rows[i]?.[field] ?? null, got:rows[i]?.values[field] ?? null,
            status:'WRONG', reason: rows[i] ? 'Unexpected main-sheet row.' : 'Expected main-sheet row missing.'};
        } else cell = compareCell(want.rows[i], rows[i], field);
        details.push({receipt, row:i+1, field, ...cell});
      }
    }
    table.push(...details);
    receipts.push({receipt, exported:rows.length>0, passed:decisions.length===1 && decisions[0].status==='pass' && review.length===0,
      clean:want.gate==='pass' && rows.length>0 && details.every(field => field.status==='OK')});
  }
  for (const key of new Set([...actual.rows.map(row => row.values['Tillroll receipt key']), ...actual.review.map(row=>row.receiptKey), ...actual.gates.map(gate=>gate.receiptKey)]))
    if (!resultKeys.has(key)) table.push({receipt:key, row:null, field:'Unexpected receipt', expected:null, got:key, status:'WRONG', reason:'Output belongs to no expected photograph.'});
  const cells = table.filter(entry => VISIBLE_COLUMNS.includes(entry.field));
  const count = status => table.filter(entry => entry.status === status).length;
  const exported = receipts.filter(receipt => receipt.exported);
  const clean = receipts.filter(receipt => receipt.clean).length;
  const columns = VISIBLE_COLUMNS.map(field => {
    const column = cells.filter(entry => entry.field === field);
    const correct = column.filter(entry => entry.status === 'OK' || (entry.evidence && entry.got === entry.expected)).length;
    return {field, correct, scored:column.length, accuracyPct:percent(correct,column.length)};
  });
  return {table, columns, wrongValues: cells.filter(cell => cell.status === 'WRONG').length, wrongChecks:table.filter(cell => cell.row===null && cell.status==='WRONG').length,
    wrong:count('WRONG'), pink:count('Pink'), amber:count('Amber'), blankFlagged:cells.filter(cell=>cell.got===null && ['Pink','Amber'].includes(cell.status)).length,
    unsupportedFlags:cells.filter(cell=>['Pink','Amber'].includes(cell.status) && !cell.evidence).length,
    clean, receipts:receipts.length, cleanPct:percent(clean,receipts.length), exported:exported.length,
    exportedPass:exported.filter(receipt=>receipt.passed).length, exportedGatePassPct:percent(exported.filter(receipt=>receipt.passed).length,exported.length)};
}

export async function scoreGolden(dataset) {
  return scoreResults(dataset, await runGoldenBatch(dataset));
}

function markdownTable(rows, columns) {
  const value = text => String(text ?? '—').replaceAll('|','\\|').replace(/\s+/g,' ');
  return [columns.join(' | '), columns.map(()=> '---').join(' | '), ...rows.map(row=>columns.map(col=>value(row[col])).join(' | '))].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const paths = args.filter(arg=>!arg.startsWith('--'));
  if (paths.length>1 || args.some(arg=>arg.startsWith('--') && !['--json','--issues'].includes(arg))) throw new Error('Usage: node tests/golden/golden-scorer.mjs [batch.json] [--json | --issues]');
  const dataset = paths.length ? JSON.parse(await readFile(paths[0],'utf8')) : (await import('./fixtures.mjs')).goldenDataset;
  const score = await scoreGolden(dataset);
  if (args.includes('--json')) console.log(JSON.stringify(score,null,2));
  else {
    const {table, columns, ...summary} = score;
    console.log(markdownTable(args.includes('--issues') ? table.filter(entry=>entry.status!=='OK') : table, ['receipt','row','field','expected','got','status','reason','evidence']));
    console.log('\n'+markdownTable(columns,['field','correct','scored','accuracyPct']));
    console.log('\n'+JSON.stringify(summary));
  }
  if (score.wrong || score.unsupportedFlags) process.exitCode = 1;
}
