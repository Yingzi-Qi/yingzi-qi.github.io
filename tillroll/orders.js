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
    order_sku:text(line.sku),order_qty:text(line.qty)};
}

function lookup(data,orders) {
  const retailer=name(data.merchant);
  if (!retailer) return result('Needs review','Receipt retailer is missing.');
  const primary=reference(data.orderId)?'order_id':'order_number';
  const other=primary==='order_id'?'order_number':'order_id';
  const values={order_id:reference(data.orderId),order_number:reference(data.orderNumber)};
  const ref=values[primary], extra=values[other];
  const label=primary==='order_id'?'order ID':'order number';
  if (!ref) return result('Needs review','Receipt has neither an order ID nor an order number.');
  const retailerOrders=orders.filter(row=>name(row.retailer)===retailer);
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

function compareLine(item,order) {
  const differences=[], missing=[];
  for (const key of ['brand','item','sku']) {
    const normalized=key==='sku'?reference:name;
    const a=normalized(item[key]), b=normalized(order[key]);
    if (a && b && a!==b) differences.push(key==='sku'?'SKU':key);
    else if (key!=='sku' && !(a && b)) missing.push(key);
  }
  if (text(item.qty) && text(order.qty)) {
    const a=quantity(item.qty), b=quantity(order.qty);
    if (a===null || b===null) missing.push('readable quantity');
    else if (a!==b) differences.push('quantity');
  }
  const missingNote='Missing evidence for '+missing.join(', ')+'.';
  if (differences.length) return result('Mismatch','Receipt and order differ in '+differences.join(', ')+'.'+
    (missing.length?' '+missingNote:''),order);
  if (missing.length) return result('Needs review',missingNote,order);
  return result('Matched','Brand and item agree with the order line.',order);
}

function lineValues(row) {
  return {sku:reference(row.sku),item:name(row.item),brand:name(row.brand),qty:quantity(row.qty)};
}

function candidates(receipt,groups) {
  const values=lineValues(receipt);
  const skuHits=values.sku ? groups.filter(g=>g.values.sku===values.sku) : [];
  const pool=skuHits.length ? skuHits : groups.filter(g=>values.item && g.values.item===values.item);
  const evidence=['item','brand','qty'].filter(k=>values[k] && pool.some(g=>g.values[k]===values[k]));
  const narrowed=pool.filter(g=>evidence.every(k=>g.values[k]===values[k]));
  return {possible:narrowed.length?narrowed:pool,strength:(skuHits.length?10:0)+evidence.length};
}

// A record can service one receipt line. Resolve strong, unique pairings first,
// then reconsider other lines as candidates are consumed.
export function compareOrder(data,orders) {
  const items=data.items??[], lines=lookup(data,orders);
  if (!Array.isArray(lines)) return items.map(()=>({...lines}));
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
        results[i]=compareLine(items[i],group.available.pop());
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
      results[i]=compareLine(items[i],remaining[0]);
    } else {
      const values=lineValues(items[i]);
      const absent=['sku','item'].some(k=>values[k] && groups.every(g=>g.values[k] && g.values[k]!==values[k]));
      results[i]=absent ? result('Mismatch','No order line matches the recorded receipt SKU or item.')
        : result('Needs review','Insufficient item information to identify an order line.');
    }
  }
  return results;
}
