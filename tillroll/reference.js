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
const unrelated=/\b(?:payment|pymt|card|debit|credit|authorization|authorisation|auth|approval|acquir(?:er|ing)|bank|terminal|processor|eftpos|eft|sku|style|item|product|membership|loyalty|rewards?|cashier|register|customer|kiosk|serial|store|till|bank account|tax|vat)\s*[-:]?\s*$/i;
const paymentContext=/\b(?:payment terminal|card(?:holder)? (?:payment|receipt|number|ending)|debit card|credit card|visa|mastercard|amex|authori[sz]ation|auth code|acquirer|approval code|eftpos)\b/i;
const riskyLine=/\b(?:sku|barcode|ean|upc|payment|visa|mastercard|amex|debit|credit|card|auth(?:orization|orisation)?|approval|loyalty|membership|rewards?|siret|vat|tax|tel(?:ephone)?|phone|cashier|register|terminal|subtotal|amount|total|tender|qty|quantity|balance|item|style|code postal|postal code|postcode|zip|customer|telephone|mobile|store|shop|branch|till|operator|counter|serial|coupon|voucher|gift card|iban|account|siren|siret|tva|caisse|cais[s]?ier|tél|fidélité|carte|article)\b/i;
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
      out.push({kind,value,label,basis:'label',box:location.box,lineNumber:i,
        evidence:source===line?line.text:line.text+' / '+source.text,
        incomplete:Boolean(possibleContinuation),certainty:Math.min(heading.certainty,location.certainty)});
    }
  }
  return out;
}

const calendar=/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/;
const clock=/\b\d{1,2}:\d{2}\b/;
const transactionHeader=/\b(?:sales? receipt|purchase receipt|sales? transaction|ticket de vente|transaction|purchase date|self[- ]checkout)\b/i;
const itemStart=/\b(?:unit price|item\s+(?:qty|price|description)|qty\s+(?:price|item|description)|description\s+(?:qty|amount|price)|article\s+qt|style\s+nr|subtotal|amount due|total to pay)\b/i;
const pricedProduct=/[a-z]{2}.+?(?:[$£€]\s*\d|\d[.,]\d{2}(?:\s|$))/i;
const orderPrefix=/^ord(?:er)?[-_/](?=[a-z\d_/-]*\d{3})[a-z\d_/-]{4,}$/i;
const stockOrAccount=/^(?:sku|ean|upc|item|style|stock|prod|serial|vat|auth|visa|card|mem(?:ber)?|cust|tel|zip|post|store|till|terminal|loyalty|siret)[-_/#]?\d/i;
const totalLine=/\b(?:total|balance due|net [àa] payer)\b/i;
const standaloneToken=/^[#<(\[]?([a-z\d]+(?:[-_/][a-z\d]+)*)[>)\]]?$/i;
function plausibleBare(value) {
  return /^\d{5,12}$/.test(value) || (value.length>=5 && (value.match(/\d/g)||[]).length>=3 && /[a-z_/-]/i.test(value));
}

const address=/\b(?:road|street|avenue|drive|lane|rue|strasse|gmbh|post ?code|zip)\b|\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i;

function independentRefs(data,orders) {
  const shop=retailer(data?.merchant), refs=new Map();
  if (!shop || !Array.isArray(orders)) return refs;
  for (const row of orders) {
    if (retailer(row.retailer)!==shop) continue;
    // Each line item of one order may repeat its two references.
    const orderKey=JSON.stringify([fold(row.order_id),fold(row.order_number)]);
    for (const [column,kind] of [['order_id','orderId'],['order_number','orderNumber']]) {
      const key=fold(row[column]);
      if (!key) continue;
      const kinds=refs.get(key) || new Map();
      const records=kinds.get(kind) || new Set();
      records.add(orderKey); kinds.set(kind,records); refs.set(key,kinds);
    }
  }
  for (const kinds of refs.values()) {
    for (const [kind,records] of kinds) {
      if (records.size>1) {
        const other=kind==='orderId'?1:0;
        for (const key of records) if (!JSON.parse(key)[other]) records.delete(key);
      }
    }
  }
  return refs;
}

function additionalCandidates(data,lines,labelled,orders) {
  const entries=independentRefs(data,orders), out=[];
  const productCodes=new Set((data?.items||[]).flatMap(i=>[fold(i.sku),fold(i.itemId)]).filter(Boolean));
  const shop=retailer(data?.merchant);
  const dateLines=[], headerLines=[];
  lines.forEach((line,i)=>{
    if (calendar.test(line.text) || clock.test(line.text)) dateLines.push(i);
    if (transactionHeader.test(line.text)) headerLines.push(i);
  });
  const anchors=[...dateLines,...headerLines];
  const proximityTo=i=>anchors.length?anchors.reduce((d,index)=>Math.min(d,Math.abs(index-i)),Infinity):null;
  for (const c of labelled) c.proximity=proximityTo(c.lineNumber);
  const firstProduct=lines.findIndex(l=>itemStart.test(l.text) || (!totalLine.test(l.text) && !riskyLine.test(l.text) && pricedProduct.test(l.text) && !calendar.test(l.text)));
  const headerLimit=firstProduct<0 ? Math.min(12,Math.max(5,Math.ceil(lines.length*.55))) : firstProduct;
  const lastTotal=lines.findLastIndex(l=>totalLine.test(l.text));
  const matches=c=>{
    if (productCodes.has(fold(c.value))) return;
    for (const [kind,records] of entries.get(fold(c.value)) || []) {
      // A labelled order number and a labelled order ID have distinct meanings.
      if (c.basis==='label' && c.kind!=='receiptReference' && c.kind!==kind) continue;
      out.push({...c,kind,label:kind==='orderId'?'Order ID':'Order number',basis:'order-list',
        printedBasis:c.basis,printedOrder:explicitOrder(c),recordKeys:[...records],recordConflict:records.size>1});
    }
  };
  for (const c of labelled) matches(c);
  for (const [i,line] of lines.entries()) {
    if (riskyLine.test(line.text)) continue;
    const next=lines.slice(i+1,i+3).find(l=>/[a-z\d]/i.test(l.text))?.text || '';
    const distance=proximityTo(i);
    const culinarion=shop.includes('culinarion') && calendar.test(line.text) && clock.test(line.text) && /\bticket\b/i.test(next);
    const ekosport=shop.includes('ekosport') && calendar.test(next) && clock.test(next)
      && lines.slice(i+2,i+5).some(l=>/document\s+original/i.test(l.text));
    if ((culinarion || ekosport) && i<headerLimit) {
      const layout=culinarion ? /\bTK[-=][\dOILS]{5,8}\b/ig : /^(?:T[IL1]-\d{2}-[A-Z\d]{3}-\d{3}-\d{3}-\d{3}|GRE[\dOIL]{2}\/[\dOIL]{7})$/ig;
      for (const m of line.text.matchAll(layout)) {
        const incomplete=culinarion ? !/^TK-\d{7}$/i.test(m[0]) : /^T[L1]-/i.test(m[0]) || (/^GRE/i.test(m[0]) && !/^GRE\d{2}\/\d{7}$/i.test(m[0]));
        const c={kind:'receiptReference',label:'Receipt reference',value:m[0],evidence:line.text,lineNumber:i,
          basis:'retailer-layout',incomplete,...span(line,m.index,m.index+m[0].length)};
        out.push(c);matches(c);
      }
    }
    const footer=lastTotal>=0 && i>lastTotal;
    if (!footer && i>=headerLimit) continue;
    const previous=lines[i-1]?.text || '';
    if (riskyLine.test(previous) && !/\d/.test(previous)) continue;
    if (/^\s*(?:\(\d{2,5}\)|0\d{2,3})[ -]+\d{4,8}\s*$/.test(line.text)) continue;
    if (lines.slice(Math.max(0,i-2),i).some(l=>paymentContext.test(l.text))) continue;

    // Accept reference-only rows, including two references side by side or one beside the time.
    // Requiring each other token to be a date, time or reference excludes product descriptions.
    const tokens=[];
    let referenceRow=true;
    for (const word of line.text.matchAll(/\S+/g)) {
      if (calendar.test(word[0]) || clock.test(word[0]) || /^(?:date|time|am|pm)[:.]?$/i.test(word[0])) continue;
      const bare=word[0].match(standaloneToken);
      if (!bare || !identifier(bare[1]) || bare[1].length<4) { referenceRow=false;break; }
      tokens.push({value:bare[1],start:word.index+word[0].indexOf(bare[1])});
    }
    if (!referenceRow || !tokens.length) continue;
    for (const {value,start} of tokens) {
      if (productCodes.has(fold(value)) || stockOrAccount.test(value) || barcodeOrCard(value)) continue;
      if (shop.includes('ekosport') && /^mag[0-9oil]{5,}$/i.test(value)) continue;
      // A bare phone number in the address block has no order semantics.
      if (/^\d{10,11}$/.test(value) && address.test(previous)) continue;
      const besideReference=tokens.length>1 || [previous,next].some(text=>{
        const other=clean(text).match(standaloneToken)?.[1];
        return other && identifier(other) && plausibleBare(other) && !barcodeOrCard(other) && !stockOrAccount.test(other) && !productCodes.has(fold(other));
      });
      const prefixed=orderPrefix.test(value);
      const c={kind:prefixed?'orderNumber':'receiptReference',label:prefixed?'Order number':'Possible receipt reference',
        basis:prefixed?'order-prefix':'position',value,evidence:line.text,lineNumber:i,
        proximity:distance,footer,...span(line,start,start+value.length)};
      matches(c);
      if (prefixed || (plausibleBare(value) && ((distance!=null && distance<=3) || besideReference || (footer && i-lastTotal<=3)))) out.push(c);
    }
  }
  return out;
}

const reasons={
  'label':'The printed label identifies this value.',
  'order-list':'The printed value matches an order reference in the order list for this retailer.',
  'retailer-layout':'The format and location match this retailer’s ticket layout.',
  'order-prefix':'The printed code starts with an order prefix.',
  'position':'This code appears in the transaction details on the receipt.'
};

const explicitOrder=c=>c.kind!=='receiptReference' && c.basis==='label';
const keyFor=c=>fold(c.value);
const typeRank={orderId:3,orderNumber:2,receiptReference:1};
const basisRank={'label':4,'order-prefix':3,'retailer-layout':2,'position':1};
const semanticRank=c=>c.basis==='order-list'
  ? (basisRank[c.printedBasis] || 0) : (basisRank[c.basis] || 0);

function rankSignals(c) {
  return [
    Number(Boolean(c.recordKeys?.length && !c.recordConflict)), // An independent record identifies the typed reference.
    Number(explicitOrder(c) || (c.basis==='order-list' && c.printedBasis==='label' && c.printedOrder)),
    semanticRank(c),
    Number(!c.incomplete),
    c.proximity==null ? -10 : -Math.min(9,c.proximity),
    c.reads || 1, c.occurrences || 1, c.certainty || 0
  ];
}
function rank(a,b) {
  const left=rankSignals(a), right=rankSignals(b);
  for (let i=0;i<left.length;i++) if (left[i]!==right[i]) return right[i]-left[i];
  return (a.box?.y??a.lineNumber??0)-(b.box?.y??b.lineNumber??0)
    || (a.box?.x??0)-(b.box?.x??0) || keyFor(a).localeCompare(keyFor(b));
}
function sameLocation(a,b) {
  if (!hasBox(a.box) || !hasBox(b.box)) return false;
  const p=a.box,q=b.box;
  const width=Math.max(0,Math.min(p.x+p.w,q.x+q.w)-Math.max(p.x,q.x));
  const height=Math.max(0,Math.min(p.y+p.h,q.y+q.h)-Math.max(p.y,q.y));
  return width*height>=.65*Math.min(p.w*p.h,q.w*q.h);
}

function joinCandidates(candidates) {
  const groups=new Map();
  for (const c of candidates) {
    const key=keyFor(c), group=groups.get(key) || [];
    group.push(c);groups.set(key,group);
  }
  return [...groups.values()].map(group=>{
    const ordered=group.slice().sort((a,b)=>rank(a,b) || typeRank[b.kind]-typeRank[a.kind]);
    const best=ordered[0], recordKeys=[...new Set(group.flatMap(c=>c.recordKeys || []))];
    const readings=new Set(group.map(c=>c.pass ?? 0));
    const occurrences=Math.max(1,...[...readings].map(pass=>{
      const places=[];
      for (const c of group.filter(c=>(c.pass??0)===pass)) {
        if (!places.some(p=>sameLocation(c,p) || (p.lineNumber!=null && p.lineNumber===c.lineNumber))) places.push(c);
      }
      return places.length;
    }),...group.map(c=>c.occurrences || 1));
    const value={...best,reads:readings.size,occurrences,recordKeys,recordConflict:recordKeys.length>1 || group.some(c=>c.recordConflict)};
    delete value.pass;
    return value;
  }).sort(rank);
}

function rankReason(best,runnerUp,sameSpot) {
  if (!runnerUp) return reasons[best.basis];
  const a=rankSignals(best), b=rankSignals(runnerUp);
  const difference=a.findIndex((n,i)=>n!==b[i]);
  switch (difference) {
    case 0:return 'This value has a unique matching order in the list for this retailer.';
    case 1:return 'The printed order label gives this number the strongest support.';
    case 2:return reasons[best.basis];
    case 3:return 'This reading contains the complete printed reference.';
    case 4:return 'This code appears closest to the transaction heading, date or time.';
    case 5:return 'Both OCR readings detected this value.';
    case 6:return 'This value appears more than once on the receipt.';
    case 7:return 'The OCR read this value more clearly than the alternative.';
    default:return sameSpot
      ? 'Both readings have equal support. One is shown for comparison with the photograph.'
      : 'The numbers have equal support. The first in receipt reading order is shown.';
  }
}
function uncertain(candidates,reasonCode,reason) {
  return {status:candidates.length?'ambiguous':'missing',kind:null,value:null,label:null,evidence:'',box:null,basis:null,
    candidates,reasonCode,reason,suggestion:null,requiresReview:false};
}

function choose(input) {
  const candidates=joinCandidates(input);
  if (!candidates.length) return uncertain([],'missing','No reliable purchase or order reference was located.');

  // Distinct printed fields can legitimately identify the same transaction (order ID, order number and till ticket).
  // Keep genuine alternatives to the same field and distinct matches to an independent order list.
  const explicit=candidates.filter(c=>explicitOrder(c) || c.printedOrder);
  const listed=candidates.filter(c=>c.recordKeys.length);
  const primaryKind=explicit.slice().sort((a,b)=>typeRank[b.kind]-typeRank[a.kind])[0]?.kind;
  const typed=primaryKind ? explicit.filter(c=>c.kind===primaryKind) : [];
  const orderRecords=new Set(listed.flatMap(c=>c.recordKeys));
  let group=candidates;
  if (typed.length) {
    group=candidates.filter(c=>typed.includes(c) || (c.recordKeys.length && (c.kind===primaryKind || orderRecords.size>1)));
  } else {
    const orderEvidence=candidates.filter(c=>c.kind!=='receiptReference');
    if (orderEvidence.length) {
      group=candidates.filter(c=>orderEvidence.includes(c) || c.basis==='position');
    }
  }
  // An ID and an order number linked to one recorded purchase corroborate each other.
  if (orderRecords.size===1 && group.some(c=>c.kind==='orderId' && c.recordKeys.length))
    group=group.filter(c=>!(c.kind==='orderNumber' && c.recordKeys.length));

  const best=group[0];
  if (group.length>1 || group.some(c=>c.recordConflict)) {
    const sameSpot=group.length>1 && group.every(c=>sameLocation(best,c));
    const reason=group.length===1 ? 'This reference matches more than one order for this retailer.'
      :sameSpot ? 'The OCR readings disagree about the characters in this reference.'
      :'Several printed references could identify this purchase.';
    const result=uncertain(group,'conflict',reason);
    result.suggestion={...best,reason:rankReason(best,group[1],sameSpot)};
    result.requiresReview=true;
    return result;
  }
  if (best.basis==='position') return uncertain(group,'unconfirmed','An unlabelled code appears in the transaction details. Its purpose could not be confirmed.');
  if (best.incomplete || best.certainty<confident) {
    const result=uncertain(group,'unclear','The reference is visible but some characters could not be read confidently.');
    result.requiresReview=true;
    return result;
  }
  return {...best,status:'found',reasonCode:null,reason:reasons[best.basis],candidates,suggestion:null,requiresReview:false};
}

export function inspectReference(data, ocr, orders=null) {
  const lines=receiptLines(ocr), labelled=labelCandidates(lines);
  return choose([...labelled,...additionalCandidates(data,lines,labelled,orders)]);
}

export function combineReferenceReadings(primary, secondary) {
  // Agreement across reads helps rank competing values, without promoting uncertain characters to confirmed.
  const candidates=[];
  [primary,secondary].forEach((reading,pass)=>{
    const observations=reading?.candidates?.length ? reading.candidates : reading?.status==='found' ? [reading] : [];
    for (const c of observations) candidates.push({...c,pass});
  });
  return choose(candidates);
}
