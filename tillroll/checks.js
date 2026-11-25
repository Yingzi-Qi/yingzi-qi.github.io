import {orderNeedsReview} from './orders.js?v=lineverify1';
import {isPrintedItemNumber,parsePrintedItemId,printedBarcodeDetail,barcodesBelowNames} from './product-code.js?v=productcodes3';
import {referenceFormat} from './retail-rules.js?v=6';
import {validCalendarDate} from './purchase-date.js?v=6';
import {inspectReference} from './reference.js?v=6';
import {normalizeTender,cleanProductCode,nonItemName,storeReceiptId} from './receipt-rules.js?v=1';
// Geometry is normalized to the upright photo, with the origin at its top left.
const PHOTO_CONFIDENCE = 0.8;
const ID_LABEL = /^order\s+i\.?d\.?\s*[:#]?$/i;
const INLINE_ID = /^order\s+i\.?d\.?(?:\s*[:#]\s*|\s+)(\S+)$/i;
const PRICE = /^(?:[£€$]\s*)?\d[\d,]*\.\d{2}$/;
const TRAILING_PRICE = /\s+(?:[£€$]\s*|(?:GBP|EUR|USD)\s+)\d[\d,]*\.\d{2}$/i;
const text = value => String(value ?? '').trim();
const name = value => text(value).toLowerCase().replace(/\s+/g, ' ');
const identifier = value => name(value).replace(/[^a-z0-9]/g, '');
const number = value => text(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const near = (a, b) => Math.abs(a - b) <= 0.020000001;
const money = value => value.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const avg = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const unique = values => [...new Set(values)];
const foldGlyphs = str => identifier(str).replace(/o/g, '0').replace(/[il]/g, '1').replace(/s/g, '5').replace(/b/g, '8').replace(/z/g, '2');

function hasGeometry(box) {
  return box && text(box.text) && [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0;
}

function joinBoxes(boxes) {
  const x = Math.min(...boxes.map(b => b.x));
  const y = Math.min(...boxes.map(b => b.y));
  return {
    text: boxes.map(b => text(b.text)).join(' '), x, y,
    w: Math.max(...boxes.map(b => b.x + b.w)) - x,
    h: Math.max(...boxes.map(b => b.y + b.h)) - y,
    confidence: avg(boxes.map(b => Number(b.confidence) || 0)),
  };
}

function visualLines(ocr) {
  const center = b => b.y + b.h / 2;
  const boxes = (ocr?.lines || []).filter(hasGeometry).sort((a, b) => center(a) - center(b) || a.x - b.x);
  const rows = [];
  for (const box of boxes) {
    const row = rows.at(-1);
    if (row && Math.abs(center(row[0]) - center(box)) <= .45 * Math.min(row[0].h, box.h)) row.push(box);
    else rows.push([box]);
  }
  return rows.map(row => {
    row.sort((a, b) => a.x - b.x);
    const words = row.flatMap(box => {
      const words = box.words?.filter(hasGeometry);
      return words?.length ? words : [box];
    }).sort((a, b) => a.x - b.x);
    const groups = [];
    for (const word of words) {
      const group = groups.at(-1);
      const prior = group?.at(-1);
      const glyph = Math.max(word.w / text(word.text).length, prior ? prior.w / text(prior.text).length : 0);
      if (prior && word.x - prior.x - prior.w < Math.max(.014, 1.65 * glyph)) group.push(word);
      else groups.push([word]);
    }
    return {...joinBoxes(row), words, cells: groups.map(joinBoxes)};
  });
}

function adjacent(a, b) {
  const gap = b.y - a.y - a.h;
  return Math.abs(a.x - b.x) <= .055 && gap >= -.3 * a.h && gap <= Math.min(.055, 1.25 * Math.max(a.h, b.h));
}

function printedIds(lines) {
  const ids = [];
  for (const [i, line] of lines.entries()) {
    const inline = line.text.match(INLINE_ID);
    if (inline) {
      ids.push({id: inline[1], evidence: line.text, confidence: line.confidence});
      continue;
    }
    for (const [j, cell] of line.cells.entries()) {
      const match = cell.text.match(INLINE_ID);
      if (match) { ids.push({id: match[1], evidence: cell.text, confidence: cell.confidence}); continue; }
      if (!ID_LABEL.test(cell.text)) continue;
      const right = line.cells[j + 1];
      const below = lines[i + 1]?.cells.filter(candidate => adjacent(cell, candidate)) || [];
      // A neighbouring heading (e.g. DATE) is never the value of the ID label.
      const idShaped = b => b && /^\S+$/.test(b.text) && /\d/.test(b.text);
      const value = idShaped(right) ? right : (below.length === 1 && /^\S+$/.test(below[0].text) ? below[0] : null);
      if (value) ids.push({id: value.text, evidence: cell.text + ' / ' + value.text,
        confidence: Math.min(cell.confidence, value.confidence)});
    }
  }
  return ids;
}

function productLines(lines) {
  return lines.map(line => {
    const cells = [...line.cells];
    let hadPrice = false;
    while (cells.length > 1 && PRICE.test(cells.at(-1).text)) { cells.pop(); hadPrice = true; }
    if (hadPrice && cells.length > 1 && /^\d+$/.test(cells.at(-1).text)) cells.pop();
    const plain = cells.map(c => c.text).join(' ').replace(TRAILING_PRICE, '');
    const parsed = parsePrintedItemId(codeDescription(line.text));
    return {line,cells,parsed,wording:name(parsed?.item || plain),confidence:Math.min(...cells.map(c => c.confidence))};
  });
}

function productEvidence(lines, brand, item) {
  const hits = [];
  let brandEvidence = '', itemEvidence = '';
  for (const [i, {line, wording, cells, confidence, parsed}] of lines.entries()) {
    const fieldText=value=>{
      const read=parsed && parsePrintedItemId(value);
      return name(read && read.itemId===parsed.itemId ? read.item : value);
    };
    const split = cells.some((_, splitAt) => splitAt > 0 &&
      fieldText(cells.slice(0, splitAt).map(c => c.text).join(' ')) === brand &&
      fieldText(cells.slice(splitAt).map(c => c.text).join(' ').replace(TRAILING_PRICE, '')) === item);
    const delimiter = [' - ', ' – ', ' | ', ': '].some(separator => wording === brand + separator + item);
    if (split || delimiter) hits.push({rows:[i], brand:line.text, item:line.text, confidence});
    if (wording === item) {
      itemEvidence = line.text;
      const prior = lines[i - 1];
      if (prior?.wording === brand && adjacent(prior.line, line)) {
        hits.push({rows:[i - 1, i], brand:prior.line.text, item:line.text, confidence:Math.min(prior.confidence, confidence)});
      }
    } else if (wording.endsWith(' ' + item)) itemEvidence = line.text;
    if (wording === brand || wording.startsWith(brand + ' ')) brandEvidence = line.text;
  }
  if (!hits.length && itemEvidence) brandEvidence = '';
  return {hits, brandEvidence, itemEvidence};
}

function itemWording(value) {
  return name(value).normalize('NFKD').replace(/\p{M}+/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}

function standaloneItemHits(products, item) {
  const wanted = itemWording(item);
  if (wanted.length < 3 || !/\p{L}/u.test(wanted)) return [];
  return products.filter(({line}) => {
    // A faint trailing price need not undermine clear product words on the same row.
    const words = line.words.map(word => word.confidence >= PHOTO_CONFIDENCE ? itemWording(word.text) : '�');
    return (' '+words.filter(Boolean).join(' ')+' ').includes(' '+wanted+' ');
  });
}

function labelledProductLines(lines) {
  const pairs = [];
  let columns;
  for (const [i,line] of lines.entries()) {
    const brandHead=line.cells.find(c=>/^brand$/i.test(c.text));
    const itemHead=line.cells.find(c=>/^(item|description|product name)$/i.test(c.text));
    if (brandHead && itemHead) { columns={brand:brandHead.x,item:itemHead.x}; continue; }
    if (line.confidence < PHOTO_CONFIDENCE) continue;
    const explicit=line.text.match(/^brand\s*:\s*(.+?)\s+[|–-]?\s*(?:item|description)\s*:\s*(.+)$/i);
    if (explicit) {
      pairs.push({row:i,brand:name(explicit[1]),item:name(explicit[2]),line});
    } else if (columns) {
      if (/^(total|subtotal|payment|change|tax|vat)\b/i.test(line.text)) { columns=null; continue; }
      const at=x=>line.cells.find(c=>Math.abs(c.x-x)<.035 && c.confidence>=PHOTO_CONFIDENCE && /\p{L}/u.test(c.text));
      const brand=at(columns.brand),item=at(columns.item);
      if (brand && item && brand !== item) pairs.push({row:i,brand:name(brand.text),item:name(item.text),line});
    }
  }
  return pairs;
}

const nonProductLine=/^\s*(?:sub\s*total|total|payment|visa|amex|master\s*card|cash\b|change\b|tender|loyalty|rewards?|member(?:ship)?|order\b|receipt\s*(?:no|number|id)|transaction\s*(?:no|number|id)|reference\b|tel(?:ephone)?\b|phone\b|authorization|auth\s+code|card\b|date\b|time\b|terminal\b|register\b|cashier\b)/i;
const productCodeLabel=/\b(sku|style(?:\s*(?:\/\s*sku|code|no\.?|number|id))?|(?:(?:item|product|article)\s*(?:id|code|no\.?|number))|upc|ean|gtin|barcode)\b\s*[:#=]?\s*/ig;
const codeKind=label=>/^(sku|style)/i.test(label)?'sku':'itemId';

function codeDescription(value) {
  // Price columns (sometimes followed by a tax code) end the item description.
  const amount=/(?:^|\s)(?:(?:GBP|USD|EUR|CAD|CHF|AUD|NZD|[£€$])\s*)?-?(?:\d{1,3}(?:[., ]\d{3})+|\d+)[.,]\d{2}(?=\s|$)/i.exec(value);
  let description=amount ? value.slice(0,amount.index) : value;
  if (amount && /\d[.,]\d{2}/.test(value.slice(amount.index+amount[0].length))) description=description.replace(/\s+\d{1,3}$/, '');
  return description.replace(/\s+(?:\d+\s*[@×x]|(?:qty|quantity)\s*[:=]?\s*\d+)\s*$/i,'').trim();
}

// A number under a specific heading inherits its printed role. In particular,
// a numeric SKU or size beside the name is never evidence for a missing item ID.
function productCodeLayout(line) {
  if (line.confidence<PHOTO_CONFIDENCE || !/\b(?:description|product name|item name|item description)\b/i.test(line.text)) return null;
  const names=/\b(item\s*(?:id|code|no|number)|product\s*(?:id|code)|article\s*(?:id|code)|barcode|upc|gtin|ean|sku|style(?:\s*\/\s*sku)?|qty|quantity|size|price|amount|item description|description|item name|product name)\b/gi;
  const headers=[...line.text.matchAll(names)];
  if (headers.length<2) return null;
  const kind=label=>/description|name/i.test(label) ? 'description' : /^(?:size|qty|quantity|price|amount)$/i.test(label) ? 'other' : codeKind(label);
  const columns=line.cells.filter(c=>headers.some(h=>name(h[0])===name(c.text))).map(c=>({kind:kind(c.text),x:c.x,center:c.x+c.w/2}));
  const kinds=headers.map(h=>kind(h[0]));
  const index=kinds.indexOf('description'), before=kinds.slice(0,index), after=kinds.slice(index+1).filter((_,i)=>!/^(?:amount|price)$/i.test(headers[index+1+i][0]));
  return {columns,prefix:before.length===1 ? before[0] : null,suffix:after.length===1 ? after[0] : null};
}

function codeObservations(lines, groups, items) {
  // Only assign an identifier to a named product when that product has a unique position on the photo.
  const owners=new Map();
  for (const {positions,itemHits,match} of groups.values()) {
    if (positions.length!==1) continue;
    const anchors=itemHits.length===positions.length ? itemHits.map(hit=>hit.line)
      : match?.hits.length===positions.length ? match.hits.map(hit=>lines[hit.rows.at(-1)]) : [];
    anchors.forEach((line,i)=>{
      const previous=owners.get(line);
      owners.set(line,previous===undefined?positions[i]:null);
    });
  }
  const byValue=new Map(), byProduct=new Map(), uncertain=new Map();
  const remember=(map,key,value)=>{
    const entries=map.get(key)||[];
    entries.push(value);
    map.set(key,entries);
  };
  const nearRow=(a,b)=>a && b && b.y-a.y-a.h<=Math.min(.095,3.2*Math.max(a.h,b.h));
  let layout=null;
  const belowNames=barcodesBelowNames(lines);
  for (const [i,line] of lines.entries()) {
    if (nonProductLine.test(line.text)) {layout=null;continue;}
    const header=productCodeLayout(line);
    if (header) {layout=header;continue;}
    const labels=[...line.text.matchAll(productCodeLabel)];
    const description=codeDescription(line.text);
    const parsed=!labels.length && parsePrintedItemId(description);
    const detail=printedBarcodeDetail(line);
    const bare=detail?.id || (isPrintedItemNumber(description) ? description : null);
    const bareRow=bare && !belowNames.has(i) && !detail?.hasQuantityOrPrice && !/\d+[.,]\d{2}/.test(line.text);
    const previous=lines[i-1], next=lines[i+1];
    let owner=owners.get(line);
    const previousOwner=nearRow(previous,line) ? owners.get(previous) : undefined;
    const nextOwner=nearRow(line,next) ? owners.get(next) : undefined;
    const afterHeading=previous && (nonProductLine.test(previous.text) ||
      /^(?:sku|style|size|qty|quantity|barcode|upc|ean|item id)\s*[:#=]?\s*$/i.test(previous.text));
    const ambiguousOwners=[];
    // A standalone number between two product rows has no unique owner. A code
    // and price below a description, in contrast, share its product block.
    if (owner===undefined && bare && !labels.length) {
      if (bareRow) {
        if (!afterHeading && Number.isInteger(previousOwner)) ambiguousOwners.push(previousOwner);
        if (!afterHeading && Number.isInteger(nextOwner) && !ambiguousOwners.includes(nextOwner)) ambiguousOwners.push(nextOwner);
        if (ambiguousOwners.length===1) owner=ambiguousOwners.pop();
      } else if (Number.isInteger(previousOwner)) owner=previousOwner;
    }
    const detailRow=labels.length || /^\s*[\w/-]*\d[\w/-]*\s+(?:[$£€]|\d+[.,]\d{2}(?:\s|$)|\d+\s*[x×@])/i.test(line.text);
    if (owner===undefined && detailRow && i>0) {
      let start=i-1;
      // Two labelled detail rows can follow one product name (e.g. Style, then UPC).
      if (labels.length && !owners.has(lines[start]) && start>0 && [...lines[start].text.matchAll(productCodeLabel)].length) start--;
      if (nearRow(lines[start],line)) owner=owners.get(lines[start]);
    }
    if (owner===undefined && !labels.length && !ambiguousOwners.length) continue;
    const edgeCodes=(!labels.length && !parsed && !bare) ? description.match(/^(\d+)\s+.*\p{L}.*\s+(\d+)$/u) : null;
    const alternativeEdges=edgeCodes && isPrintedItemNumber(edgeCodes[1]) && isPrintedItemNumber(edgeCodes[2]) && edgeCodes[1]!==edgeCodes[2] ? edgeCodes.slice(1) : [];
    let index=0;
    for (const word of line.words) {
      const offset=line.text.indexOf(word.text,index);
      if (offset<0) continue;
      index=offset+word.text.length;
      // Also accept a label and value joined by a colon in the same OCR word.
      for (const token of word.text.matchAll(/[A-Za-z0-9][A-Za-z0-9_/.–—-]*/g)) {
        if (word.confidence<PHOTO_CONFIDENCE) continue;
        const value=token[0].replace(/\.$/,'');
        const point=offset+token.index;
        const label=labels.find(l=>l.index+l[0].length===point);
        if (value.length<2 || (!label && (!/\d/.test(value) || /^(?:\d+[.,]\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/.test(value)))) continue;
        if (!/\d/.test(value) && !(label && /[:#=]/.test(label[0]) && /^[A-Z]+$/.test(value))) continue;
        let column;
        if (layout && Number.isInteger(owner) && owners.get(line)===owner && isPrintedItemNumber(value)) {
          const wordCenter=word.x+word.w/2;
          const aligned=word.text===value ? layout.columns.filter(c=>Math.min(Math.abs(word.x-c.x),Math.abs(wordCenter-c.center))<.035) : [];
          if (aligned.length===1 && aligned[0].kind!=='description') column=aligned[0].kind;
          else if (value===parsed?.itemId) column=point<line.text.indexOf(parsed.item) ? layout.prefix : layout.suffix;
        }
        const ownItem=items[owner];
        // An unseparated number already in the full product name can be its model
        // number. A separately printed style/SKU makes that ambiguity material.
        const modelInName=parsed?.evidence==='position' && name(ownItem?.sku) && name(ownItem.sku)!==name(value) &&
          itemWording(ownItem.item).split(' ').includes(name(value));
        const positional=!labels.length && (column==='itemId' || (!column && !modelInName)) && (value===parsed?.itemId || value===bare);
        const kind=label ? codeKind(label[1]) : column || (positional ? 'itemId' : null);
        const observation={owner,kind,value,text:line.text};
        if (positional) for (const possible of ambiguousOwners) remember(uncertain,possible,observation);
        if (Number.isInteger(owner) && alternativeEdges.includes(value)) remember(uncertain,owner,observation);
        remember(byValue,name(value),observation);
        if ((kind==='itemId' || kind==='sku') && Number.isInteger(owner)) remember(byProduct,owner+'|'+kind,observation);
      }
    }
  }
  return {byValue,byProduct,uncertain};
}

function verifyProductCode(observations, item, field, index) {
  const value=name(item[field]);
  const label=field==='sku'?'SKU':'Item ID';
  const known=observations.byProduct.get(index+'|'+field) || [];
  const printed=unique(known.map(hit=>name(hit.value)));
  if (field==='itemId' && printed.length>1) return {issue:'Several item IDs could belong to this product line.',evidence:unique(known.map(hit=>hit.text)).join(' | ')};
  const observed=field==='itemId' && printed.length===1 ? {printedItemId:known[0].value} : {};
  const keptAside=field==='itemId' && [item.concessionCode,item.internalCode,item.ean].some(code=>name(code) && name(code)===name(observed.printedItemId));
  if (!value && observed.printedItemId && !keptAside) return {...observed,issue:'The printed item ID '+observed.printedItemId+' is missing from the record.',evidence:known[0].text};
  const hits=value ? (observations.byValue.get(value)||[]).filter(hit=>hit.kind===field || (!hit.kind && field==='sku')) : [];
  const own=hits.find(hit=>hit.owner===index);
  if (own) return {...observed,found:true,evidence:own.text};
  if (hits.length && hits.every(hit=>Number.isInteger(hit.owner))) {
    return {...observed,issue:label+' '+text(item[field])+' is printed with a different item on this receipt.',evidence:hits[0].text};
  }
  if (value && known.length) return {...observed,issue:label+' on this product line differs from the extracted '+text(item[field])+'.',evidence:known[0].text};
  const uncertain=field==='itemId' ? observations.uncertain.get(index) : null;
  if (uncertain?.length) return {issue:'The printed item ID cannot be assigned uniquely to this item.',evidence:unique(uncertain.map(hit=>hit.text)).join(' | ')};
  const unlinked=hits.find(hit=>hit.kind===field);
  return unlinked ? {unlinked:true,evidence:unlinked.text} : {};
}

function collectProductEvidence(lines,items) {
  const labelled=labelledProductLines(lines);
  const products = productLines(lines);
  const groups = new Map(), owners = new Map();

  for (const [i, product] of items.entries()) {
    const brand = name(product.brand), item = name(product.item), key = JSON.stringify([brand,item]);
    if (!groups.has(key)) {
      const match = brand && item ? productEvidence(products, brand, item) : null;
      const corresponding = labelled.filter(p=>p.item===item || (items.length===1 && labelled.length===1));
      const exact = corresponding.filter(p=>p.brand===brand && p.item===item);
      for (const p of exact) {
        if (match && !match.hits.some(hit=>hit.rows.includes(p.row)))
          match.hits.push({rows:[p.row],brand:p.line.text,item:p.line.text,confidence:p.line.confidence});
      }
      const conflict = match && !match.hits.length && corresponding.length===1 ? corresponding[0] : null;
      groups.set(key, {positions:[], match, conflict, itemHits:standaloneItemHits(products,item)});
      for (const hit of match?.hits || []) for (const row of hit.rows) {
        if (!owners.has(row)) owners.set(row, new Set());
        owners.get(row).add(key);
      }
    }
    groups.get(key).positions.push(i);
  }
  return {groups,owners,codes:codeObservations(lines,groups,items)};
}

export function verifyImportedItemIds(data,ocr) {
  const items=data.items || [];
  const {codes}=collectProductEvidence(visualLines(ocr),items);
  return items.map((item,index)=>{
    const checked=verifyProductCode(codes,item,'itemId',index);
    const status=checked.issue ? 'Needs review' : checked.found ? 'Item ID found' : 'Not verified';
    const reason=checked.issue || (checked.found ? 'Item ID agrees on the product line.' : 'No item ID could be confirmed for this product on the photo.');
    return {status,reason,itemIdEvidence:checked.evidence || '',printedItemId:checked.printedItemId || null};
  });
}

function verifyPhoto(data, ocr, independent, reference) {
  const lines = visualLines(ocr), ids = printedIds(lines).filter(id=>!reference.reviewedValues?.some(v=>name(v)===name(id.id)));
  const locatedId = reference.status==='found' && reference.kind==='orderId';
  if(locatedId && !ids.some(id=>id.id===reference.value))
    ids.push({id:reference.value,evidence:reference.evidence,confidence:reference.certainty});
  const idEvidence = unique(ids.map(id => id.evidence)).join(' | ');
  const orderId = text(data.orderId);
  let idIssue = '';
  const expectsId = Boolean(orderId || ids.length);
  if (!orderId && ids.length) idIssue = 'The photo has a labelled order ID that is missing from the extracted record.';
  else if (orderId && !ids.length) idIssue = 'The extracted order ID could not be located on the photo.';
  else if (ids.some(entry => entry.id !== orderId)) idIssue = 'The printed order ID differs or the photo shows conflicting IDs.';
  else if (ids.length && reference.basis!=='user-confirmed' && Math.max(...ids.map(id => id.confidence)) < PHOTO_CONFIDENCE) idIssue = 'The printed ID is unclear.';

  const items=data.items || [];
  const {groups,owners,codes}=collectProductEvidence(lines,items);
  const result = Array(items.length);
  for (const {positions, match, conflict, itemHits} of groups.values()) {
    const enough = match?.hits.length === positions.length;
    const collides = match?.hits.some(h => h.rows.some(i => owners.get(i).size > 1));
    for (const [index, i] of positions.entries()) {
      const issueList = idIssue ? [idIssue] : [];
      const hit = match?.hits[index] || match?.hits[0];
      const paired = enough && !collides && hit?.confidence >= PHOTO_CONFIDENCE;
      if (conflict) issueList.push('The labelled brand or item on the photo differs from the extracted product.');
      else if (expectsId && !['order-list','user-confirmed'].includes(reference.basis) && match && !paired) {
        if (!match.hits.length) issueList.push('The full item and brand could not be paired on the printed line.');
        else if (!enough || collides) issueList.push('Repeated or overlapping product lines could not be paired uniquely.');
        else issueList.push('The product line is unclear.');
      }
      const itemHit = itemHits.length === positions.length ? itemHits[index] : null;
      const itemId=verifyProductCode(codes,items[i],'itemId',i);
      const sku=verifyProductCode(codes,items[i],'sku',i);
      for (const code of [itemId,sku]) if (code.issue) issueList.push(code.issue);
      let status, reason;
      if (issueList.length) {
        status = 'Needs review'; reason = issueList.join(' ');
      } else if (paired && expectsId) {
        status = independent ? 'Confirmed on photo' : 'Text agrees';
        reason = 'The located order ID and the paired brand and item agree with the receipt reading.';
      } else {
        status = paired ? 'Brand and item found' : itemHit ? 'Item found' : itemId.found || itemId.unlinked ? 'Item ID found' : sku.found || sku.unlinked ? 'SKU found' : 'Not verified';
        const evidence = paired ? 'The brand and item appear together.' : itemHit ? 'The item wording appears on the receipt.' : itemId.found || sku.found ? 'The product code agrees with the printed product line.' : itemId.unlinked || sku.unlinked ? 'The labelled product code is present. Its link to this item could not be established.' : 'The item could not be independently identified in the photo text.';
        reason = evidence + (expectsId ? ' The located order ID agrees.' : ' No order ID was established for comparison.');
      }
      for (const [field,label,code] of [['itemId','Item ID',itemId],['sku','SKU',sku]]) {
        if (!text(items[i][field]) || code.issue) continue;
        if (code.found) reason+=' '+label+' agrees on the product line.';
        else if (code.unlinked) reason+=' A labelled '+label+' was found without a unique product pairing.';
        else reason+=' '+label+' could not be confirmed on the product line.';
      }
      result[i] = {
        status, reason, lineIssue:issueList.filter(issue=>issue!==idIssue).join(' '), idEvidence, skuEvidence:sku.evidence||'', itemIdEvidence:itemId.evidence||'',
        brandEvidence:conflict?.line.text || hit?.brand || match?.brandEvidence || '', itemEvidence:conflict?.line.text || hit?.item || itemHit?.line.text || match?.itemEvidence || '',
      };
    }
  }
  return result;
}

function inspectDate(value, issue, now, flag) {
  if (issue) flag('date',issue,value ? 'check' : 'fix');
  if (!text(value)) {
    if (!issue) flag('date','Purchase date is missing.','fix');
    return;
  }
  if (!validCalendarDate(value)) return flag('date','Purchase date is invalid.','fix');
  const today=new Date(now).toISOString().slice(0,10);
  if (value>today) flag('date','Purchase date is in the future. Check the day and month.','fix');
  let anniversary=String(Number(today.slice(0,4))-5).padStart(4,'0')+today.slice(4);
  if (!validCalendarDate(anniversary)) anniversary=anniversary.slice(0,8)+'28';
  if (value<anniversary) flag('date','Purchase date is more than five years ago.','check');
}

function includedLineDiscount(item) {
  const discount=number(item.lineDiscount), qty=number(item.qty), price=number(item.unitPrice), amount=number(item.amount);
  if(discount===null || discount<=0 || qty===null || price===null || amount===null) return 0;
  return near(qty*price-discount,amount) ? discount : 0;
}

function arithmetic(data, items, flag, repeats) {
  const amounts = items.map(i => number(i.amount)), total = number(data.total);
  const sum = amounts.reduce((a, b) => a + (b || 0), 0), tax = number(data.tax);
  const alreadyApplied = items.reduce((value,item)=>value+includedLineDiscount(item),0);
  // A saving kept beside the product's own price is not already inside that amount.
  const outsideLine = items.reduce((value, item) => {
    const discount = number(item.lineDiscount), amount = number(item.amount), unit = number(item.unitPrice), qty = number(item.qty) ?? 1;
    if (discount === null || discount <= 0 || amount === null || includedLineDiscount(item)) return value;
    return unit == null || near(qty * unit, amount) ? value + discount : value;
  }, 0);
  // receiptDiscount is only the saving that is not already inside a line amount.
  // Older readings that lack the field still use the printed discount minus line discounts.
  const listedReceiptDiscount = number(data.receiptDiscount);
  const discount = (listedReceiptDiscount !== null ? Math.max(0, listedReceiptDiscount) : Math.max(0,(number(data.discount) ?? 0)-alreadyApplied)) + outsideLine;
  const balances = beforeDiscount => total !== null && (
    near(beforeDiscount - discount, total) || (tax !== null && near(beforeDiscount - discount + tax, total)));
  const repeated = new Map();
  for (const [i, item] of items.entries()) {
    const key = JSON.stringify([name(item.item) || name(item.sku), amounts[i]]);
    if (!(text(item.item) || text(item.sku)) || amounts[i] === null) continue;
    if (!repeated.has(key)) repeated.set(key, []);
    repeated.get(key).push(i);
  }
  let explained = false;
  for (const indices of repeated.values()) {
    if (indices.length < 2) continue;
    const complete = amounts.every(n => n !== null);
    if (complete && balances(sum)) {
      for (const i of indices) repeats[i] = 'Repeat confirmed';
      flag('items.'+indices[1]+'.item','Repeated lines reconcile with the printed total.', 'info');
    } else {
      const remove = complete && balances(sum - amounts[indices[0]] * (indices.length - 1));
      explained ||= remove;
      for (const i of indices.slice(1)) {
        repeats[i] = remove ? 'Possible duplicate' : 'Check repeat';
        flag('items.'+i+'.item', remove ? 'The total reconciles only after removing the repeated row.' : 'Check whether this item was bought more than once.', remove ? 'fix' : 'check');
      }
    }
  }
  if (total !== null && items.length && !explained && !balances(sum))
    flag('total', 'Line amounts after discount total ' + money(sum - discount) + '. The receipt total is ' + money(total) + '.', 'fix');
}

function ocrChecks(data, ocr, format, add, confirmed) {
  const content = text(ocr?.text);
  if (!ocr || ocr.confidence < .75 || content.length < 80) {
    if (ocr && text(data.orderNumber)) add('orderNumber', 'The OCR reading is too short or unclear to cross-check the order number.', 'info', true);
    return;
  }
  for (const key of ['orderNumber','orderId']) {
    const value = text(data[key]), normalized = identifier(value);
    if (normalized.length < 5) continue;
    const validFormat = key === 'orderNumber' && format?.source==='demo' && format.test(value);
    if (identifier(content).includes(normalized)) confirmed.push(key);
    else if (foldGlyphs(content).includes(foldGlyphs(value))) {
      if (validFormat) confirmed.push(key);
      else add(key, 'OCR found a lookalike character in this identifier.', 'check', false);
    } else if (!validFormat) add(key, 'OCR could not find this identifier.', 'check');
  }
  if (number(data.total) !== null && identifier(content).includes(identifier(number(data.total).toFixed(2)))) confirmed.push('total');
}

function printedOrderNumbers(ocr) {
  const heading = /^order\s*(?:number\b|no\b\.?|#)\s*[:#]?\s*/i;
  const valuePattern = /^(?=[\w./-]*\d)[\w][\w./-]*$/;
  const ocrLines = ocr?.lines?.length ? ocr.lines : text(ocr?.text).split('\n').map(line => ({text:line,confidence:ocr?.confidence}));
  const printedNumbers = new Set();
  for (const [i,line] of ocrLines.entries()) {
    const label = text(line.text);
    if (!(line.confidence >= PHOTO_CONFIDENCE) || !heading.test(label)) continue;
    const tail = label.replace(heading,'').trim();
    const below = ocrLines[i+1];
    let value = tail.split(/\s+/)[0];
    if (!tail && below?.confidence >= PHOTO_CONFIDENCE && hasGeometry(line) && hasGeometry(below) && adjacent(line,below))
      value = text(below.text);
    const valueWord = tail && line.words?.find(word => word.text === value);
    if (valuePattern.test(value) && (!valueWord || valueWord.confidence >= PHOTO_CONFIDENCE)) printedNumbers.add(value);
  }
  return printedNumbers;
}

// Flag categories: 'reading' (Pink #FECDD3: OCR doubt, pass mismatch, sanity failure),
// 'lookup' (Amber #FDE68A: comparison with an order list, catalogue or imported format)
// and 'info' (no colour).
export function flagCategory(flag) {
  if (!flag || flag.severity === 'info') return 'info';
  return flag.category === 'lookup' ? 'lookup' : 'reading';
}

// Field issues raised by the readers that always need a reading check.
const readerIssueMessages = {
  rejected_code:'This value is not a product code and was cleared',
  doubtful_code:'Check the printed product code',
  doubtful_zero_price:'Check this zero price',
  channel_not_tender:'Payment must be the tender, not the purchase channel',
  unreadable_time:'Purchase time is unreadable',
  ambiguous_time:'Purchase time is ambiguous',
  discount_line_unclear:'discount line unclear',
  receipt_id_pass_conflict:'receipt id pass conflict',
  payment_method:'Payment method must be UnionPay, Card, Alipay or WeChat',
  unreadable_price:'The price is not a number',
  item_name_missing:'item-name-missing',
  tendered_mismatch:'TOTAL does not match the tendered amount',
};

// A line amount must be printed on the item's own row or its short detail block.
// Only clear, unique matches are compared; missing evidence is neutral.
function rowAlignment(items, ocr, add) {
  const lines = visualLines(ocr);
  if (lines.length < 3) return;
  const words = value => ' '+itemWording(value)+' ';
  const moneyForms = value => {
    const fixed = Math.abs(value).toFixed(2);
    return [fixed, fixed.replace('.', ','), Number(fixed).toLocaleString('en-GB',{minimumFractionDigits:2})];
  };
  items.forEach((item, i) => {
    const wanted = itemWording(item.item), amount = number(item.amount);
    if (wanted.length < 4 || !/\p{L}{3}/u.test(wanted) || amount === null || amount === 0) return;
    const nameRows = lines.map((line, j) => words(line.text).includes(' '+wanted+' ') ? j : -1).filter(j => j >= 0);
    const forms = moneyForms(amount);
    const priceRows = lines.map((line, j) => forms.some(f => new RegExp('(?<![\\d.,])'+f.replace(/[.,]/g, '[.,]')+'(?![\\d])').test(line.text)) ? j : -1).filter(j => j >= 0);
    if (nameRows.length !== 1 || !priceRows.length) return;
    const at = nameRows[0];
    if (priceRows.some(j => j >= at - 1 && j <= at + 3)) return;
    add('items.'+i+'.amount', 'The line amount is printed on a row that does not align with this item.', 'check');
  });
}

export function checkReceipt(data, ocr, previous = null, {independentPhoto = false, today = new Date(), orders = null, demoFormats = false, reference = inspectReference(data,ocr)} = {}) {
  const items = data.items || [], flags = [], confirmedFields = [];
  const repeats = Array(items.length).fill(null);
  const add = (field, message, severity, escalate = severity !== 'info', category = severity === 'info' ? 'info' : 'reading') => {
    if (!flags.some(flag => flag.field === field && flag.message === message))
      flags.push({field, message, severity, escalate, category});
  };
  if (!items.length) add('receipt','No line items were read.', 'fix');
  if (!items.length && number(data.total) !== null) add('receipt','items-missing', 'check');
  if (!text(data.merchant)) add('merchant','Retailer is missing.', 'fix');
  if (number(data.total) === null) add('total','Receipt total is missing or unreadable.', 'fix');
  inspectDate(data.date, data.dateIssue, today, add);
  const format=referenceFormat(data.merchant,'orderNumber',orders,demoFormats);
  const idFormat=referenceFormat(data.merchant,'orderId',orders,demoFormats);
  for (const [key,label,rule] of [['orderNumber','Order number',format],['orderId','Order ID',idFormat]]) {
    const value=text(data[key]);
    if (!rule || !value) continue;
    const matches=rule.test(value);
    const description=rule.source+' format for '+text(data.merchant)+' ('+rule.description+').';
    add(key,label+(matches?' matches the ':' does not match the ')+description,matches?'info':'check',!matches,matches?'info':'lookup');
  }
  const printedNumbers = printedOrderNumbers(ocr);
  const storeId = storeReceiptId(data.merchant, ocr);
  // A store rule owns 采购小票id, so a generic heuristic is not the photo value to confirm.
  const genericReceipt = storeId && reference.kind==='receiptReference';
  const storeRuleId = storeId && (storeId.status==='found' || storeId.status==='unclear') && storeId.value
    && name(data.receiptReference)===name(storeId.value);
  if(!genericReceipt && reference.status==='found' && data[reference.kind] && name(data[reference.kind])!==name(reference.value)) {
    add(reference.kind,reference.label+' differs from the value on the photo ('+reference.value+').','check');
  } else if(reference.requiresReview && reference.suggestion && !storeRuleId) {
    add('receipt','Check the suggested reference '+reference.suggestion.value+' against the other possible numbers.','check');
  } else if(!storeRuleId && reference.reasonCode==='conflict') {
    add('receipt',reference.reason,'check');
  }
  const orderNumber = text(data.orderNumber);
  for(const value of printedNumbers)if(reference.reviewedValues?.some(v=>name(v)===name(value)))printedNumbers.delete(value);
  if (!orderNumber) {
    if (printedNumbers.size) add('orderNumber','A labelled order number is visible on the photo but is missing from the record.', 'fix');
    else if (!text(data.orderId)) add('orderNumber',text(data.receiptReference) ? 'A receipt reference is available. Order-list matching requires a shared order reference.' : 'No confirmed order reference is available for matching.', 'info');
  } else if ([...printedNumbers].some(value => {
    if (value.toLowerCase() === orderNumber.toLowerCase()) return false;
    // A Q or O in a digits-only field is a common OCR reading of zero.
    const glyphs = ref => foldGlyphs(ref).replace(/q/g,'0');
    return !(format?.test(orderNumber) && !format.test(value) && glyphs(value) === glyphs(orderNumber));
  })) {
    add('orderNumber','The labelled order number on the photo differs from the record.', 'check');
  } else if (!format) add('orderNumber','This retailer has no configured order-number format.', 'info');

  items.forEach((item,i) => {
    const path = 'items.'+i+'.';
    const nameMissing=(data.fieldIssues||[]).some(issue=>issue.field===path+'item' && issue.reason==='item_name_missing');
    if (!text(item.item)) add(path+'item', nameMissing ? 'item-name-missing' : (text(item.sku) ? 'Only the product code was read.' : 'Item description is missing.'), 'fix');
    else if ((text(item.sku) && name(item.item) === name(item.sku)) || /^(?:\d{4,}|[A-Z]{1,6}[-/.]?\d{3,}[A-Z0-9]*(?:[-/.][A-Z0-9]+)*)$/i.test(text(item.item)))
      add(path+'item','The item description looks like a product code.', 'check');
    const blocked = text(item.item) && nonItemName(item.item);
    if (blocked) add(path+'item', blocked, 'fix');
    if (text(item.item) && !text(item.brand)) add(path+'brand','No brand was read for this item.', 'info');
    for (const key of ['itemId','sku']) {
      if (!text(item[key])) continue;
      const code = cleanProductCode(item[key], {brand:item.brand, card:data.card, phone:data.storeClues?.phone, date:data.date});
      if (code.rejected) add(path+key, code.issue, 'fix');
      else if (code.issue) add(path+key, code.issue, 'check');
      else if (code.code !== text(item[key])) add(path+key, 'The product code repeats the brand name ('+text(item[key])+'). Use '+code.code+'.', 'check');
    }
    if (number(item.amount) === 0 && !(data.fieldIssues || []).some(f => f.field === path+'amount'))
      add(path+'amount', 'A zero price was kept because it could not be confirmed as printed. Check this line.', 'check');
    const amount = number(item.amount), qty = number(item.qty), unit = number(item.unitPrice);
    if (amount === null) add(path+'amount','Line amount is missing or unreadable.', 'fix');
    else if (qty !== null && unit !== null && !near(qty*unit-includedLineDiscount(item), amount)) add(path+'amount','Quantity multiplied by unit price differs from the line amount.', 'fix');
  });
  arithmetic(data, items, add, repeats);
  rowAlignment(items, ocr, add);
  if (text(data.time) && !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(text(data.time)))
    add('time','Purchase time must be HH:MM:SS in 24-hour format.', 'check');
  if (text(data.payment)) {
    const tender = normalizeTender(data.payment);
    if (tender.channel) add('payment','“'+text(data.payment)+'” is a purchase channel, not a payment tender.', 'fix');
    else if (!tender.known) add('payment','The payment tender “'+text(data.payment)+'” is not recognised.', 'check');
  }
  // Store-specific 采购小票id layouts. The store rule decides the id.
  // Missing or unclear is a reading error even when a generic heuristic also found a number.
  const passConflict = (data.fieldIssues||[]).some(issue => issue?.field==='receiptReference' && issue.reason==='receipt_id_pass_conflict');
  if (storeId && ocr?.lines?.length && !passConflict) {
    const recorded = text(data.receiptReference);
    if (storeId.status === 'found') {
      if (recorded && name(recorded) !== name(storeId.value))
        add('receiptReference', storeId.reason+' The photo shows '+storeId.value+'.', 'check');
    } else add('receiptReference', storeId.reason, 'check');
  }
  for (const issue of Array.isArray(data.fieldIssues) ? data.fieldIssues : []) {
    const field = text(issue?.field);
    if (!/^(merchant|orderId|orderNumber|receiptReference|date|time|payment|total|items\.\d+\.(item|amount|itemId|sku))$/.test(field) || issue.reason === 'missing_on_receipt' || issue.reason === 'item_name_missing') continue;
    if (issue.reason === 'printed_footer') { add(field, text(issue.evidence), 'info'); continue; }
    const known = readerIssueMessages[issue.reason];
    if (known) {
      add(field, known + (issue.evidence ? '. '+text(issue.evidence) : '.'), issue.reason === 'rejected_code' || issue.reason === 'channel_not_tender' ? 'fix' : 'check');
      continue;
    }
    if (!(reference.basis==='user-confirmed' && reference.kind===field) && !flags.some(f => f.field === field && f.severity !== 'info'))
      add(field,'Hard to read' + (issue.evidence ? '. '+text(issue.evidence) : '.') , 'check');
  }
  if (name(data.imageQuality) === 'poor' && !flags.some(f => f.escalate)) add('receipt','Image quality is poor.', 'check');
  const ocrData=reference.basis==='user-confirmed' ? {...data,[reference.kind]:null} : data;
  ocrChecks(ocrData, ocr, format, add, confirmedFields);
  for (const key of ['orderNumber','orderId']) {
    if(reference.basis==='user-confirmed' && reference.kind===key)continue;
    if (text(previous?.[key]) && text(data[key]) && text(previous[key]) !== text(data[key]))
      add(key,'The two readings disagree. First reading: '+text(previous[key])+'.', 'check', false);
  }
  const photo = verifyPhoto(data, ocr, independentPhoto, reference);
  photo.forEach((row, i) => {
    if (row.status === 'Needs review') add('items.'+i+'.photo', row.reason, 'check', true);
  });
  return {flags, photo, repeats, confirmedFields};
}

export function reviewForLine(receipt, index) {
  const prefix = 'items.'+index+'.';
  const flags = (receipt.review?.flags || []).filter(flag => flag.severity !== 'info' &&
    (!flag.field.startsWith('items.') || flag.field.startsWith(prefix)));
  const messages = flags.map(flag => flag.message);
  const photo = receipt.review?.photo?.[index], order = receipt.orders?.[index];
  if (photo?.status === 'Needs review') messages.push(photo.reason);
  if (orderNeedsReview(order)) messages.push(order.reason || order.status);
  return {flags, messages:unique(messages.filter(Boolean))};
}

export function samePurchase(a, b) {
  if (!a || !b || !identifier(a.merchant) || identifier(a.merchant) !== identifier(b.merchant)) return false;
  const refs = obj => [obj.orderId, obj.orderNumber].map(identifier).filter(r => r.length >= 5);
  if (refs(a).some(r => refs(b).includes(r))) return true;
  if (!text(a.date) || a.date !== b.date || number(a.total) === null || number(a.total) !== number(b.total)) return false;
  if (text(a.card) && text(a.card) === text(b.card)) return true;
  if (text(a.time) && text(a.time) === text(b.time)) return true;
  const amounts = obj => (obj.items || []).map(i => number(i.amount)).sort((l,r) => l - r);
  const left = amounts(a), right = amounts(b);
  return left.length > 0 && left.length === right.length && left.every((v, i) => v !== null && v === right[i]);
}
