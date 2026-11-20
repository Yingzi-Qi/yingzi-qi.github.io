import {isGtin} from './product-code.js?v=6';

const text = value => String(value ?? '').trim();
const reference = value => text(value).toLowerCase();
const name = value => reference(value).replace(/\s+/g,' ');

// Use a decimal significand and exponent rather than binary floating-point equality.
function quantity(value) {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text(value));
  if (!match || !(match[2] || match[3])) return null;
  const fraction = match[3] || '';
  const digits = (match[2]+fraction).replace(/^0+/,'');
  if (!digits) return '0';
  const base = digits.replace(/0+$/,'');
  const exponent = BigInt(match[4]||0) + BigInt(digits.length-base.length-fraction.length);
  return (match[1]==='-'?'-':'')+base+'e'+exponent;
}

function result(status,reason,line={}) {
  return {status,reason,order_brand:text(line.brand),order_item:text(line.item),
    order_item_id:text(line.item_id),order_sku:text(line.sku),order_qty:text(line.qty),order_amount:text(line.amount)};
}

export function orderNeedsReview(order) {
  return Boolean(order?.status && order.status !== 'Matched' && order.status !== 'Not compared');
}

function lookup(data,orders) {
  const retailer=name(data.merchant);
  if (!retailer) return result('Needs review','Receipt retailer is missing.');
  const retailerOrders=orders.filter(row=>name(row.retailer)===retailer);
  // An older order list may provide only the order number even when the receipt prints both.
  const useNumber=reference(data.orderNumber) && !retailerOrders.some(row=>text(row.order_id));
  const primary=reference(data.orderId) && !useNumber?'order_id':'order_number';
  const other=primary==='order_id'?'order_number':'order_id';
  const values={order_id:reference(data.orderId),order_number:reference(data.orderNumber)};
  const ref=values[primary], extra=values[other];
  const label=primary==='order_id'?'order ID':'order number';
  if (!ref) return result('Not compared','There is no shared order ID or order number to look up.');
  const lines=retailerOrders.filter(row=>reference(row[primary])===ref);
  if (!lines.length) {
    if (orders.some(row=>!name(row.retailer) && reference(row[primary])===ref))
      return result('Needs review','This '+label+' occurs in an order with no retailer.');
    if (extra && retailerOrders.some(row=>reference(row[other])===extra))
      return result('Needs review','The order number was found but the receipt order ID was not.');
    return result('Order not found','No '+label+' matches for this retailer in the supplied orders.');
  }
  const extraRefs=new Set(lines.map(row=>reference(row[other])).filter(Boolean));
  if (extra && extraRefs.size && !extraRefs.has(extra))
    return result('Needs review','The two order references point to different records.');
  if (extraRefs.size<=1) return lines;
  if (!extra || lines.some(row=>!reference(row[other])))
    return result('Needs review','Several orders at this retailer share this '+label+'.');
  return lines.filter(row=>reference(row[other])===extra);
}

// Currency must come from the independent record or its amount text. A bare dollar sign cannot identify a currency.
export function currencyCode(input) {
  const value=text(input).toUpperCase();
  return ({'€':'EUR','£':'GBP'})[value] || (/^[A-Z]{3}$/.test(value) ? value : '');
}

export function readMoney(input) {
  let value=text(input);
  const prefix=value.match(/^([a-z]{3}|[£€$])\s*/i);
  const suffix=value.match(/\s*([a-z]{3}|[£€$])$/i);
  const currency=currencyCode(prefix?.[1] || suffix?.[1]);
  if(prefix) value=value.slice(prefix[0].length);
  if(suffix) value=value.slice(0,-suffix[0].length);
  if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value)) value=value.replaceAll(',','');
  else if (/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(value)) value=value.replaceAll('.','').replace(',','.');
  const sign=prefix?.[1] || suffix?.[1];
  return {value:quantity(value),currency,dollar:sign==='$',invalid:Boolean(prefix && suffix)};
}

function compareLine(item,order,amountComparable) {
  const differences=[], missing=[], checked=[];
  for (const key of ['brand','item']) {
    const a=name(item[key]), b=name(order[key]);
    if (!a || !b) missing.push(key);
    else if (a!==b) differences.push(key);
    else checked.push(key);
  }
  const receiptCodes=lineValues(item), expectedCodes=lineValues(order);
  for (const [key,other,label] of [['itemId','sku','item ID'],['sku','itemId','SKU']]) {
    const expected=expectedCodes[key], actual=receiptCodes[key];
    if (!expected) continue;
    if (actual && actual!==expected) differences.push(label);
    else if (actual===expected || (!expectedCodes[other] && receiptCodes[other]===expected)) checked.push(label);
    else missing.push('receipt '+label);
  }
  if (text(item.qty) && text(order.qty)) {
    const a=quantity(item.qty), b=quantity(order.qty);
    if (a===null || b===null) missing.push('readable quantity');
    else if (a!==b) differences.push('quantity');
  }
  if (text(order.amount)) {
    const receiptAmount=readMoney(item.amount), expected=readMoney(order.amount);
    if (receiptAmount.value===null || expected.value===null || expected.invalid) missing.push('readable line amount');
    else if (amountComparable && receiptAmount.value!==expected.value) differences.push('line amount (receipt '+text(item.amount)+', order '+text(order.amount)+')');
  }
  const missingNote='Missing evidence for '+missing.join(', ')+'.';
  if (differences.length) return result('Mismatch','Receipt and order differ in '+differences.join(', ')+'.'+
    (missing.length?' '+missingNote:''),order);
  if (missing.length) return result('Needs review',missingNote,order);
  if (text(item.qty) && text(order.qty)) checked.push('quantity');
  if (amountComparable && text(order.amount)) checked.push('line amount');
  return result('Matched','Order line agrees on '+checked.join(', ')+'.',order);
}

function lineValues(row) {
  return {itemId:reference(row.itemId ?? row.item_id),sku:reference(row.sku),item:name(row.item),brand:name(row.brand),qty:quantity(row.qty),amount:readMoney(row.amount).value};
}

function candidates(receipt,groups) {
  const values=lineValues(receipt);
  const codeStrength=g=>{
    const hitId=values.itemId && g.values.itemId===values.itemId;
    const hitSku=values.sku && g.values.sku===values.sku;
    if (hitId || hitSku) return (hitId?20:0)+(hitSku?10:0);
    // Older single-code files sometimes call an item ID a SKU. Only exact equality is evidence.
    if (!values.itemId && !g.values.sku && values.sku && values.sku===g.values.itemId) return 5;
    if (!values.sku && !g.values.itemId && values.itemId && values.itemId===g.values.sku) return 5;
    return 0;
  };
  const bestCode=groups.reduce((best,g)=>Math.max(best,codeStrength(g)),0);
  const pool=bestCode ? groups.filter(g=>codeStrength(g)===bestCode) : groups.filter(g=>values.item && g.values.item===values.item);
  const evidence=['item','brand','qty','amount'].filter(k=>values[k] && pool.some(g=>g.values[k]===values[k]));
  const narrowed=pool.filter(g=>evidence.every(k=>g.values[k]===values[k]));
  return {possible:narrowed.length?narrowed:pool,strength:bestCode+evidence.length};
}

// Order-level values can appear once or repeat on every line of a spreadsheet.
function purchaseCheck(data,lines) {
  const totals=new Map(), currencies=new Set();
  let hasPrices=false, invalidCurrency=false, ambiguousDollar=false;
  for (const line of lines) {
    if (text(line.currency)) {
      const code=currencyCode(line.currency);
      if (code) currencies.add(code);
      else invalidCurrency=true;
    }
    for (const key of ['amount','total']) {
      if (!text(line[key])) continue;
      hasPrices=true;
      const money=readMoney(line[key]);
      if (money.currency) currencies.add(money.currency);
      if (money.dollar) ambiguousDollar=true;
      if (key==='total') totals.set(money.invalid ? null : money.value,text(line[key]));
    }
  }
  const notes=[], receiptCurrency=currencyCode(data.currency);
  const orderCurrency=currencies.size===1 ? [...currencies][0] : '';
  const invalidDollar=ambiguousDollar && orderCurrency && !new Intl.NumberFormat('en',{
    style:'currency',currency:orderCurrency,currencyDisplay:'narrowSymbol'
  }).formatToParts(0).some(part=>part.type==='currency' && part.value.includes('$'));
  let status='Matched';
  const issue=(reason,mismatch=false)=>{
    notes.push(reason);
    if (status!=='Mismatch') status=mismatch?'Mismatch':'Needs review';
  };
  if (currencies.size>1) issue('The order records contain conflicting currencies.');
  else if (invalidCurrency || invalidDollar) issue('The order currency is unclear or conflicts with the printed amount.');
  else if (orderCurrency && receiptCurrency && orderCurrency!==receiptCurrency)
    issue('Currency differs (receipt '+receiptCurrency+', order '+orderCurrency+').',true);
  else if ((hasPrices || orderCurrency) && (!orderCurrency || !receiptCurrency))
    issue('Currency is missing for the '+(!orderCurrency && !receiptCurrency?'receipt and order':!orderCurrency?'order':'receipt')+'.');
  const amountComparable=currencies.size<=1 && !invalidCurrency && !invalidDollar && !(receiptCurrency && orderCurrency && orderCurrency!==receiptCurrency);
  if (totals.size>1) issue('The order records contain conflicting purchase totals.');
  else if (totals.size===1) {
    const [[expected,raw]]=totals, actual=readMoney(data.total);
    if (expected===null || actual.value===null) issue('A purchase total is missing or unreadable.');
    else if (expected!==actual.value && amountComparable) issue('Purchase total differs (receipt '+text(data.total)+', order '+raw+').',true);
    else if (amountComparable) notes.push('Purchase total agrees.');
  }
  return {status,reason:notes.join(' '),amountComparable,order_total:[...totals.values()].join(' / '),order_currency:[...currencies].join(' / ')};
}

function possibleOrder(data,orders) {
  if (reference(data.orderId) || reference(data.orderNumber)) return null;
  const retailer=name(data.merchant), currency=currencyCode(data.currency), total=readMoney(data.total).value;
  const barcodes=new Set((data.items || []).map(item=>text(item.itemId)).filter(isGtin));
  if (!retailer || !currency || total===null || barcodes.size<2) return null;

  const byOrder=new Map();
  for (const row of orders) {
    if (name(row.retailer)!==retailer || !(text(row.order_id) || text(row.order_number))) continue;
    const key=JSON.stringify([reference(row.order_id),reference(row.order_number)]);
    if (!byOrder.has(key)) byOrder.set(key,[]);
    byOrder.get(key).push(row);
  }
  let candidate=null;
  for (const lines of byOrder.values()) {
    const orderedCodes=new Set(lines.map(row=>text(row.item_id)).filter(Boolean));
    if (![...barcodes].every(code=>orderedCodes.has(code))) continue;
    const purchase=purchaseCheck(data,lines);
    if (purchase.status!=='Matched' || purchase.order_currency!==currency || readMoney(purchase.order_total).value!==total) continue;
    if (candidate) return null;
    const first=lines[0], kind=text(first.order_id)?'order ID':'order number';
    const value=text(first.order_id) || text(first.order_number);
    candidate={lines,value,reason:'Possible '+kind+' '+value+' in the imported list. Retailer, '+barcodes.size+
      ' distinct item barcodes, purchase total and currency agree. Confirm the order independently.'};
  }
  return candidate;
}

// A record can service one receipt line. Resolve strong, unique pairings first,
// then reconsider other lines as candidates are consumed.
export function compareOrder(data,orders) {
  const items=data.items??[], possible=possibleOrder(data,orders);
  const lines=possible?.lines || lookup(data,orders);
  if (!Array.isArray(lines)) return (items.length?items:[null]).map(()=>({...lines}));
  const purchase=purchaseCheck(data,lines);
  const bySignature=new Map();
  for (const line of lines) {
    const values=lineValues(line);
    const key=JSON.stringify({...values,qty:values.qty??text(line.qty)});
    if (!bySignature.has(key)) bySignature.set(key,{values,available:[]});
    bySignature.get(key).available.push(line);
  }
  const groups=[...bySignature.values()];
  const choices=items.map(item=>candidates(item,groups));
  const pending=new Set(items.keys()), results=new Array(items.length);
  while (pending.size) {
    const requests=new Map();
    for (const i of pending) {
      const remaining=choices[i].possible.filter(g=>g.available.length);
      if (remaining.length!==1) continue;
      const group=remaining[0];
      if (!requests.has(group)) requests.set(group,[]);
      requests.get(group).push(i);
    }
    const before=pending.size;
    for (const [group,indices] of requests) {
      const best=indices.reduce((max,i)=>Math.max(max,choices[i].strength),0);
      const strongest=indices.filter(i=>choices[i].strength===best);
      if (strongest.length>group.available.length) continue;
      for (const i of strongest) {
        results[i]=compareLine(items[i],group.available.pop(),purchase.amountComparable);
        pending.delete(i);
      }
    }
    if (before===pending.size) break;
  }

  const remaining=groups.flatMap(g=>g.available);
  for (const i of pending) {
    if (choices[i].possible.length) {
      results[i]=result('Needs review','Multiple or competing lines prevent a unique pairing.');
    } else if (pending.size===1 && remaining.length===1) {
      results[i]=compareLine(items[i],remaining[0],purchase.amountComparable);
    } else {
      const values=lineValues(items[i]);
      const absent=['itemId','sku','item'].some(k=>values[k] && groups.every(g=>g.values[k] && g.values[k]!==values[k]));
      results[i]=absent ? result('Mismatch','No order line matches the recorded item ID, SKU or item name.')
        : result('Needs review','Insufficient item information to identify an order line.');
    }
  }
  if (!items.length) results.push(result('Needs review','No receipt items were extracted for comparison.'));
  for (const line of results) line.lineIssue=orderNeedsReview(line) ? line.reason : '';
  const extra=lines.length-items.length;
  if (extra>0 && items.length) {
    const onlyOnce=results[0];
    if (onlyOnce.status==='Matched') onlyOnce.status='Needs review';
    onlyOnce.reason+=' The order lists '+extra+' more '+(extra===1?'line':'lines')+' than this receipt. Check for a partial purchase or a missing line.';
  }
  return results.map(line=>{
    const status=line.status==='Mismatch' || purchase.status==='Mismatch' ? 'Mismatch' :
      purchase.status==='Needs review' ? 'Needs review' : line.status;
    return {...line,status:possible?'Possible order':status,
      reason:[possible?.reason,line.reason,purchase.reason].filter(Boolean).join(' '),order_candidate:possible?.value || '',
      order_total:purchase.order_total,order_currency:purchase.order_currency};
  });
}
