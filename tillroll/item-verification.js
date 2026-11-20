import {currencyCode,readMoney} from './orders.js?v=lineverify1';

const text = value => String(value ?? '').trim();
const words = value => text(value).normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
const labels = {item:'Item name',brand:'Brand',amount:'Price',itemId:'Item ID'};
const orderRefs = [['orderId','order_id'],['orderNumber','order_number']];
const unique = values => [...new Set(values.filter(Boolean))];

// Do not look up the same product in a different known purchase.
function scopeOrders(receipt,orders) {
  const merchant=words(receipt.merchant);
  const retailer=merchant ? orders.filter(row=>words(row.retailer)===merchant) : [];
  const catalogue=retailer.filter(row=>orderRefs.every(([,column])=>!text(row[column])));
  const known=orderRefs.filter(([key])=>text(receipt[key]));
  if (!known.length) return {rows:retailer.filter(row=>orderRefs.some(([,column])=>text(row[column]))),
    catalogue,source:'Order list (retailer and item ID)',purchase:false};
  const shared=known.filter(([,column])=>retailer.some(row=>text(row[column])));
  const scoped=retailer.filter(row=>{
    const comparable=shared.filter(([,column])=>text(row[column]));
    return comparable.length && comparable.every(([key,column])=>words(row[column])===words(receipt[key]));
  });
  const collision=orderRefs.some(([,column])=>unique(scoped.map(row=>words(row[column]))).length>1);
  return {rows:collision ? [] : scoped, catalogue,source:'Order list (same purchase)', purchase:true,
    problem:collision ? 'The references identify several orders at this retailer.' : !scoped.length ? 'The supplied order references did not identify a matching purchase at this retailer.' : ''};
}

const quantity = value => /^\+?\d+(?:\.\d+)?$/.test(text(value)) && text(value).length<=40
  ? readMoney(value).value : null;
function price(value,currency) {
  const raw=text(value), explicit=currencyCode(currency);
  if (!raw || raw.length>70 || (text(currency) && !explicit)) return null;
  const parsed=readMoney(raw), code=explicit || parsed.currency;
  if (!code || (parsed.currency && explicit && parsed.currency!==explicit) || parsed.invalid || parsed.value===null) return null;
  if (parsed.dollar && !new Intl.NumberFormat('en',{style:'currency',currency:code,currencyDisplay:'narrowSymbol'})
    .formatToParts(0).some(part=>part.type==='currency' && part.value.includes('$'))) return null;
  return {value:parsed.value,currency:code,label:raw+(parsed.currency===code?'':' '+code)};
}
function times(value,qty) {
  if (value==='0' || qty==='0') return '0';
  const [a,i]=value.split('e'), [b,j]=qty.split('e');
  const product=String(BigInt(a)*BigInt(b)), digits=product.replace(/0+$/,'');
  return digits+'e'+String(BigInt(i)+BigInt(j)+BigInt(product.length-digits.length));
}
function lineFromUnit(unit,qty,displayQty) {
  return unit && qty && qty!=='0' ? {...unit,value:times(unit.value,qty),label:unit.label+' × '+text(displayQty)} : null;
}
const hasDiscount = row => [row.lineDiscount,row.discount].some(value=>text(value) && Number(value)!==0);
function priceObservation(item,currency,row,purchase) {
  const line=price(item.amount,currency), otherLine=price(row.amount,row.currency);
  const unit=price(item.unitPrice,currency), otherUnit=price(row.unit_price ?? row.unitPrice,row.currency);
  const qty=quantity(item.qty), otherQty=quantity(row.qty);
  let actual, expected, key;
  // Same-purchase line totals share a basis. For a product lookup in other
  // purchases, require compatible quantities or explicitly comparable unit prices.
  if (!text(item.amount)) {
    const expectedLine=otherLine && (purchase || (qty && qty===otherQty)) ? otherLine
      : !hasDiscount(item) && !hasDiscount(row) && lineFromUnit(otherUnit,qty,item.qty);
    if (expectedLine && (purchase || expectedLine.currency===currencyCode(currency))) {
      return {actual:'',expected:expectedLine.label,signature:'line amount '+expectedLine.currency+' '+expectedLine.value,agrees:false};
    }
  }
  const differentQty=qty && otherQty && qty!==otherQty;
  const explicitUnitDiff=unit && otherUnit && (unit.value!==otherUnit.value || unit.currency!==otherUnit.currency);
  if (otherLine && line && !differentQty && !explicitUnitDiff && (purchase || (qty && qty===otherQty))) {
    actual=line; expected=otherLine; key='line amount';
  } else if (unit && otherUnit) {
    actual=unit; expected=otherUnit; key='unit price';
  } else if (line && otherUnit && qty && qty!=='0' && !hasDiscount(item) && !hasDiscount(row)) {
    actual=line; expected=lineFromUnit(otherUnit,qty,item.qty); key='line amount';
  } else if (unit && otherLine && otherQty && otherQty!=='0' && !hasDiscount(item) && !hasDiscount(row)) {
    actual=lineFromUnit(unit,otherQty,row.qty); expected=otherLine; key='line amount';
  }
  if (!actual || !expected || (!purchase && actual.currency!==expected.currency)) return null;
  return {actual:actual.label,expected:expected.label,signature:[key,expected.currency,expected.value].join(' '),
    agrees:actual.currency===expected.currency && actual.value===expected.value};
}
function field(key,status,actual,expected,source,reason='') {
  return {key,status,actual:text(actual),expected:text(expected),source,reason};
}
function compareField(key,item,currency,rows,source,purchase) {
  const actual=key==='amount' ? text(item.amount ?? item.unitPrice) : text(item[key]);
  const conflictKeys=key==='amount' ? ['amount','unitPrice','qty','currency'] : [key];
  const conflict=rows.some(row=>row.conflicts?.some(k=>conflictKeys.includes(k)));
  const evidence=rows.map(row=>{
    if (key==='amount') return priceObservation(item,currency,row,purchase);
    const expected=text(row[key]);
    return expected ? {actual,expected,signature:words(expected),agrees:words(expected)===words(actual)} : null;
  });
  const observed=evidence.filter(Boolean);
  const values=unique(observed.map(x=>x.signature));
  if (conflict || values.length>1) return {...field(key,'unchecked',actual,unique(observed.map(x=>x.expected)).join(' / '),source,
    source+' has conflicting readings or records for '+labels[key].toLowerCase()+'.'),ambiguous:true};
  if (!observed.length || evidence.includes(null)) return field(key,'unchecked',actual,'',source,
    key==='amount' ? 'Comparable prices, quantities or currency are missing.' : labels[key]+' is missing from the output or reference.');
  const first=observed[0];
  return field(key,first.agrees?'match':'mismatch',first.actual,first.expected,source);
}

function summarize(fields,notes) {
  const differences=fields.filter(f=>f.status==='mismatch');
  const keys=['item','brand','amount'];
  const missing=keys.filter(key=>fields.some(f=>f.key===key && f.ambiguous) || !fields.some(f=>f.key===key && f.status==='match'));
  const sources=unique(fields.map(f=>f.source));
  const status=differences.length?'mismatch':!missing.length?'verified':fields.some(f=>f.status==='match')?'partial':'unchecked';
  const reasons=differences.map(f=>{
    const corroborated=unique(fields.filter(other=>other.key===f.key && other.status==='match').map(other=>other.source));
    const description=f.actual ? labels[f.key]+' differs. Output “'+f.actual+'”, '+f.source+' “'+f.expected+'”.'
      : labels[f.key]+' is missing from the output. '+f.source+' shows “'+f.expected+'”.';
    return description+
      (corroborated.length?' '+corroborated.join(' and ')+' agrees with the output.':'');
  });
  if (status==='verified') reasons.push('Item ID, item name, brand and price agree.');
  if (status==='partial' || status==='unchecked') {
    reasons.push(...unique(fields.filter(f=>f.ambiguous).map(f=>f.reason)),...notes);
    if (fields.length) reasons.push('Unverified fields: '+missing.map(k=>labels[k].toLowerCase()).join(', ')+'.');
  }
  return {status,source:sources.join(' + '),reason:unique(reasons).join(' '),fields};
}

// A supplied order can identify a different printed ID only when a separate
// line anchor agrees. An unsuccessful ID lookup alone is not a discrepancy.
function differentOrderId(item,id,rows,source) {
  const sku=text(item.sku), name=words(item.item), brand=words(item.brand);
  const anchors=rows.filter(row=>{
    if (sku && text(row.sku)) return text(row.sku)===sku;
    return name && brand && words(row.item)===name && words(row.brand)===brand;
  });
  const values=unique(anchors.map(row=>text(row.item_id)));
  return values.length===1 && anchors.every(row=>text(row.item_id)) && values[0]!==id
    ? field('itemId','mismatch',id,values[0],source) : null;
}

export function verifyOutputItems(receipt,orders=[],photoLines=[]) {
  const order=scopeOrders(receipt,orders || []);
  return (receipt.items || []).map(item=>{
    const id=text(item.itemId);
    if (!id) return summarize([],['The output has no item ID to look up.']);
    const orderRows=order.rows.filter(row=>text(row.item_id)===id);
    const catalogueRows=order.catalogue.filter(row=>text(row.item_id)===id);
    const photoRows=(photoLines || []).filter(row=>text(row.itemId)===id && !row.conflicts?.includes('itemId'));
    const fields=[], notes=[];
    for (const key of ['item','brand','amount']) {
      const orderField=orderRows.length ? compareField(key,item,receipt.currency,orderRows,order.source,order.purchase) : null;
      if (orderField) fields.push(orderField);
      if (catalogueRows.length && (!orderField || (orderField.status==='unchecked' && !orderField.ambiguous))) {
        fields.push(compareField(key,item,receipt.currency,catalogueRows,'Product catalogue (retailer and item ID)',false));
      }
      if (photoRows.length) fields.push(compareField(key,item,receipt.currency,photoRows,'Receipt photo',true));
    }
    if (!orderRows.length && order.purchase) {
      const mismatch=differentOrderId(item,id,order.rows,order.source);
      if (mismatch) fields.push(mismatch);
    }
    if (!fields.length) notes.push(order.problem || 'No independent reference with the same item ID was available for this line.');
    return summarize(fields,notes);
  });
}
