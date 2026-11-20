// Coordinates refer to the upright source photograph, normalized from 0 to 1.
const confident = 0.8;
const clean = value => String(value ?? '').trim();
const fold = value => clean(value).toLowerCase();
const retailer = value => fold(value).replace(/\s+/g,' ');
const hasBox = v => v && ['x','y','w','h'].every(k=>Number.isFinite(v[k])) && v.w>0 && v.h>0;
const boxOf = parts => {
  const boxes=parts.filter(hasBox);
  if (!boxes.length) return null;
  const x=Math.min(...boxes.map(b=>b.x)), y=Math.min(...boxes.map(b=>b.y));
  return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};
};

function receiptLines(ocr) {
  let input=ocr?.lines || [];
  if (!input.length) input=clean(ocr?.text).split('\n').map(text=>({text,confidence:ocr?.confidence}));
  const rows=[];
  for (const line of [...input].sort((a,b)=> (a.y??0)-(b.y??0) || (a.x??0)-(b.x??0))) {
    if (!clean(line.text)) continue;
    const prior=rows.at(-1)?.[0];
    if (hasBox(prior) && hasBox(line) && Math.abs(prior.y+prior.h/2-line.y-line.h/2) <= .4*Math.min(prior.h,line.h))
      rows.at(-1).push(line);
    else rows.push([line]);
  }
  return rows.map(row=>{
    const words=row.flatMap(line=>line.words?.length ? line.words : [line])
      .filter(w=>clean(w.text)).sort((a,b)=>(a.x??0)-(b.x??0));
    let text='';
    const spans=words.map(w=>{
      if (text) text+=' ';
      const start=text.length; text+=clean(w.text);
      return {...w,start,end:text.length};
    });
    return {text,spans,box:boxOf(words)};
  });
}

function span(line, start, end) {
  const words=line.spans.filter(w=>w.start<end && w.end>start);
  return {box:boxOf(words),certainty:Math.min(...words.map(w=>Number(w.confidence) || 0))};
}
function numericDate(value) {
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(value)) return true;
  return /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(value)
    || /^(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2}$/.test(value)
    || /^(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:19|20)\d{2}$/.test(value);
}
function identifier(value) {
  return value.length>=2 && value.length<=40 && /\d/.test(value)
    && /^[a-z\d]+(?:[-_/][a-z\d]+)*$/i.test(value) && !numericDate(value);
}
function barcodeOrCard(value) {
  if (!/^\d+$/.test(value)) return false;
  if ([8,12,13,14].includes(value.length)) {
    const sum=[...value].reverse().reduce((s,n,i)=>s+Number(n)*(i%2?3:1),0);
    if (sum%10===0) return true;
  }
  return value.length>=13 && value.length<=19;
}
const labelRx=/\b(order\s*(?:i\.?d\.?|identifier)|(?:order|commande|bestellung)\s*(?:number|n[uú]mero|no\.?|n[°º]|nr\.?|#|reference|ref\.?)?|(?:sales\s+)?receipt(?:\s*(?:number|no\.?|id|#|ref\.?))?|(?:transaction|trans\.?|txn)(?:\s*(?:number|no\.?|id|#|ref\.?))?|ticket(?:\s*(?:number|no\.?|n[°º]|id|#))?|beleg(?:nummer|nr\.?)?|reference|ref\.?)(?=$|[\s:#=])/gi;
const unrelated=/\b(?:payment|pymt|card|debit|credit|authorization|authorisation|auth|approval|acquir(?:er|ing)|bank|terminal|processor|eftpos|eft|sku|style|item|product|membership|loyalty|rewards?|cashier|register|customer|kiosk|tax|vat)\s*[-:]?\s*$/i;
const paymentContext=/\b(?:payment terminal|card(?:holder)? (?:payment|receipt|number|ending)|debit card|credit card|visa|mastercard|amex|authori[sz]ation|auth code|acquirer|approval code|eftpos)\b/i;
const riskyLine=/\b(?:sku|barcode|ean|upc|payment|visa|mastercard|amex|debit|credit|card|auth(?:orization|orisation)?|approval|loyalty|membership|rewards?|siret|vat|tax|tel(?:ephone)?|phone|cashier|register|terminal|subtotal|amount|total|tender|qty|quantity|balance|item|style|code postal|postal code)\b/i;
function typeOf(label) {
  if (/^order\s*i\.?d|^order\s*identifier/i.test(label)) return ['orderId','Order ID'];
  if (/^(order|commande|bestellung)/i.test(label)) return ['orderNumber','Order number'];
  if (/^(trans|txn)/i.test(label)) return ['receiptReference','Transaction number'];
  if (/^ticket/i.test(label)) return ['receiptReference','Ticket number'];
  return ['receiptReference','Receipt reference'];
}
const startToken=/^[\s:#=]*(?:\[|<)?([a-z\d]+(?:[-_/][a-z\d]+)*)(?=$|[\s\]>;,|])/i;
function neighbour(label,value) {
  if (!hasBox(label) || !hasBox(value)) return false;
  const gap=value.y-label.y-label.h;
  return Math.abs(label.x-value.x)<.055 && gap>=-.3*label.h && gap<=Math.min(.05,1.25*Math.max(label.h,value.h));
}
function sameCode(a,b) { return fold(a)===fold(b); }

function labelCandidates(lines) {
  const out=[];
  for (const [i,line] of lines.entries()) {
    for (const m of line.text.matchAll(labelRx)) {
      const before=line.text.slice(0,m.index), tail=line.text.slice(m.index+m[0].length);
      const [kind,label]=typeOf(m[0]);
      const customerOrder=kind!=='receiptReference' && /\bcustomer\s*$/i.test(before);
      if ((unrelated.test(before) && !customerOrder) || /\b(?:return|present|your|please|retain|keep|pr[ée]sentation|show)\b/i.test(before)) continue;
      if (/^(ref|trans|txn)/i.test(m[0]) && lines.slice(Math.max(0,i-2),i).some(l=>paymentContext.test(l.text))) continue;
      let source=line, offset=m.index+m[0].length, after=tail;
      if (/^[\s#:=]*$/.test(tail)) {
        const next=lines[i+1];
        // A generic document title such as "SALES RECEIPT" does not label a number below it.
        if (!next || !/(?:id|number|no\.?|n[°º]|nr\.?|#|ref(?:erence)?\.?|:\s*$)/i.test(m[0]+tail)
            || !neighbour(span(line,m.index,offset).box,next.box) || next.text.trim().split(/\s+/).length!==1) continue;
        source=next;offset=0;after=next.text;
      }
      const token=after.match(startToken);
      if (!token || !identifier(token[1])) continue;
      let value=token[1];
      const start=offset+token[0].lastIndexOf(value);
      const remainder=after.slice(token[0].length);
      const nextPart=remainder.match(/^\s+([\d][\d_/-]*)(?=\s|$)/);
      const possibleContinuation=nextPart && identifier(nextPart[1]);
      if (possibleContinuation) value+=nextPart[0];
      const location=span(source,start,start+value.length), heading=span(line,m.index,m.index+m[0].length);
      out.push({kind,value,label,basis:'label',box:location.box,
        evidence:source===line?line.text:line.text+' / '+source.text,
        incomplete:Boolean(possibleContinuation),certainty:Math.min(heading.certainty,location.certainty)});
    }
  }
  return out;
}

const bareLine=/^\s*[#<(\[]?\s*([a-z\d]+(?:[-_/][a-z\d]+)*)\s*[>)\]]?\s*$/i;
const calendar=/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/;
const clock=/\b\d{1,2}:\d{2}\b/;
const itemStart=/\b(?:unit price|item\s+(?:qty|price|description)|qty\s+(?:price|item|description)|description\s+(?:qty|amount|price)|article\s+qt|style\s+nr|subtotal|amount due|total to pay)\b/i;
function independentRefs(data,orders) {
  const shop=retailer(data?.merchant), refs=new Map();
  if (!shop || !Array.isArray(orders)) return refs;
  for (const row of orders) {
    if (retailer(row.retailer)!==shop) continue;
    for (const [column,other,kind] of [['order_id','order_number','orderId'],['order_number','order_id','orderNumber']]) {
      const val=fold(row[column]); if (!val) continue;
      const key=kind+'|'+val, record=refs.get(key) || {kind,related:new Set()};
      if (fold(row[other])) record.related.add(fold(row[other]));
      refs.set(key,record);
    }
  }
  return refs;
}

function additionalCandidates(data,lines,labelled,orders) {
  const entries=independentRefs(data,orders), out=[];
  const sku=new Set((data?.items||[]).map(i=>fold(i.sku)).filter(Boolean));
  const shop=retailer(data?.merchant);
  const firstProduct=lines.findIndex(l=>itemStart.test(l.text));
  const headerLimit=firstProduct<0 ? Math.min(12,Math.max(4,Math.ceil(lines.length*.45))) : firstProduct;
  const lastTotal=lines.findLastIndex(l=>/\b(?:total|balance due|net [àa] payer)\b/i.test(l.text));
  const listMatches=c=>{
    if (sku.has(fold(c.value))) return;
    for (const kind of ['orderId','orderNumber']) {
      const record=entries.get(kind+'|'+fold(c.value));
      if (record && !out.some(p=>p.basis==='order-list' && p.kind===kind && p.evidence===c.evidence && sameCode(p.value,c.value))) {
        out.push({...c,kind,label:kind==='orderId'?'Order ID':'Order number',basis:'order-list',recordConflict:record.related.size>1});
      }
    }
  };
  for (const c of labelled) if (c.kind==='receiptReference') listMatches(c);
  for (const [i,line] of lines.entries()) {
    if (riskyLine.test(line.text)) continue;
    const bare=line.text.match(bareLine);
    const next=lines.slice(i+1,i+3).find(l=>/[a-z\d]/i.test(l.text))?.text || '';
    const adjacentDate=lines.slice(Math.max(0,i-1),i+2).some(l=>calendar.test(l.text) || clock.test(l.text));
    // These are receipt numbers, even when the retailer leaves off their labels.
    const culinarion=shop.includes('culinarion') && calendar.test(line.text) && clock.test(line.text) && /\bticket\b/i.test(next);
    const ekosport=shop.includes('ekosport') && calendar.test(next) && clock.test(next)
      && lines.slice(i+2,i+5).some(l=>/document\s+original/i.test(l.text));
    if ((culinarion || ekosport) && i<headerLimit) {
      const layout = culinarion ? /\bTK[-=][\dOILS]{5,8}\b/ig : /^(?:T[IL1]-\d{2}-[A-Z\d]{3}-\d{3}-\d{3}-\d{3}|GRE[\dOIL]{2}\/[\dOIL]{7})$/ig;
      for (const m of line.text.matchAll(layout)) {
        const incomplete=culinarion ? !/^TK-\d{7}$/i.test(m[0]) : /^T[L1]-/i.test(m[0]) || (/^GRE/i.test(m[0]) && !/^GRE\d{2}\/\d{7}$/i.test(m[0]));
        const c={kind:'receiptReference',label:'Receipt reference',value:m[0],evidence:line.text,
          basis:'retailer-layout',incomplete,...span(line,m.index,m.index+m[0].length)};
        out.push(c);listMatches(c);
      }
    }
    if (!bare || !identifier(bare[1]) || bare[1].length<4 || barcodeOrCard(bare[1]) || sku.has(fold(bare[1]))) continue;
    // A label preceding a separate value can identify a SKU, phone, customer or payment number.
    if (i && riskyLine.test(lines[i-1].text) && !/\d/.test(lines[i-1].text)) continue;
    const value=bare[1], start=line.text.indexOf(value);
    const c={kind:'receiptReference',label:'Possible receipt reference',value,evidence:line.text,...span(line,start,start+value.length)};
    // Standalone footer references can be confirmed by an independent order record too.
    // Keep item rows and monetary/card fields away from unlabelled detection.
    if (i>=headerLimit && !(lastTotal>=0 && i>lastTotal)) continue;
    listMatches(c);
    if (/^ord(?:er)?[-_/](?=[a-z\d_/-]*\d{3})[a-z\d_/-]{4,}$/i.test(value))
      out.push({...c,kind:'orderNumber',label:'Order number',basis:'order-prefix'});
    else if (i<headerLimit && adjacentDate && c.certainty>=confident && /^\d{5,12}$/.test(value))
      out.push({...c,basis:'position'});
  }
  return out;
}

const reasons={
  'label':'The printed label identifies this value.',
  'order-list':'The printed value exactly matches a reference in the order list for this retailer.',
  'retailer-layout':'The code format and its position beside the date or time match this retailer’s ticket layout.',
  'order-prefix':'The standalone code has an order prefix in the receipt header.'
};
function uncertain(candidates, reasonCode, reason) {
  return {status:candidates.length?'ambiguous':'missing',kind:null,value:null,label:null,evidence:'',box:null,basis:null,candidates,reasonCode,reason};
}

function choose(candidates) {
  const strongest = candidates.filter(c=>c.basis!=='position');
  for (const kind of ['orderId','orderNumber','receiptReference']) {
    const group=strongest.filter(c=>c.kind===kind);
    if (!group.length) continue;
    const values=new Set(group.map(c=>fold(c.value)));
    if (values.size>1 || group.some(c=>c.recordConflict))
      return uncertain(group,'conflict','Several different references could identify this purchase.');
    const legible=group.filter(c=>!c.incomplete);
    const first=legible.reduce((best,c)=>!best || c.certainty>best.certainty ? c : best,null);
    if (!first || first.certainty<confident) return uncertain(group,'unclear','The reference is visible but some characters could not be read confidently.');
    return {...first,status:'found',reasonCode:null,reason:reasons[first.basis],candidates};
  }
  const possible=candidates.filter(c=>c.basis==='position');
  if (possible.length) return uncertain(possible,'unconfirmed','An unlabelled number appears near the purchase date or time. Its purpose could not be confirmed.');
  return uncertain([],'missing','No reliable purchase or order reference was located.');
}

export function inspectReference(data, ocr, orders=null) {
  const lines=receiptLines(ocr), labelled=labelCandidates(lines);
  return choose([...labelled,...additionalCandidates(data,lines,labelled,orders)]);
}

export function combineReferenceReadings(primary, secondary) {
  // Compare printed values verbatim. Two OCR passes can repeat the same wrong glyph.
  const candidates=new Map();
  for (const reading of [primary,secondary]) {
    for (const c of reading?.candidates?.length ? reading.candidates : reading?.status==='found' ? [reading] : []) {
      const key=JSON.stringify([c.kind,fold(c.value),c.basis,Boolean(c.recordConflict),Boolean(c.incomplete)]);
      const existing=candidates.get(key);
      if (!existing || c.certainty>existing.certainty) candidates.set(key,c);
    }
  }
  return choose([...candidates.values()]);
}
