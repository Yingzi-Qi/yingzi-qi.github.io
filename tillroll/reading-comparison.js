const receiptFields=['merchant','date','time','orderId','orderNumber','receiptReference','currency','payment','card','total','subtotal','discount','receiptDiscount','tax'];
const productFields=['brand','item','itemId','sku','qty','unitPrice','amount','colour','size','lineDiscount','lineDiscountLabel'];
const labels={merchant:'Retailer',date:'Purchase date',time:'Time',orderId:'Order ID',orderNumber:'Order number',
  receiptReference:'Receipt reference',currency:'Currency',payment:'Payment',card:'Card ending',total:'Receipt total',
  subtotal:'Subtotal',discount:'Discount',receiptDiscount:'Receipt discount',tax:'Tax',brand:'Brand',item:'Item name',itemId:'Item ID',sku:'Style / SKU',qty:'Quantity',
  unitPrice:'Unit price',amount:'Line amount',colour:'Colour',size:'Size',lineDiscount:'Line discount',lineDiscountLabel:'Discount label'};
const numeric=new Set(['qty','unitPrice','amount','lineDiscount','receiptDiscount','total','subtotal','discount','tax']);
const present=value=>value!=null && String(value).trim()!=='';
// OCR engines frequently alternate between straight and typographic
// punctuation for the same printed value. Treat those glyph variants as the
// same value during cross-reading comparisons while keeping the visible text
// that the reader chose. This prevents a punctuation-only change from becoming
// a reading error, especially for names such as D'E/PENET/R.
const normal=value=>String(value??'').normalize('NFKC').trim().toLowerCase()
  .replace(/[\u2018\u2019\u201a\u201b\u02bc\u0060\u00b4]/g,"'")
  .replace(/[\u2010-\u2015\u2212]/g,'-')
  .replace(/\s+/g,' ');
function same(key,a,b) {
  if (!present(a) || !present(b))return !present(a) && !present(b);
  if (numeric.has(key)) return Number.isFinite(Number(a)) && Number(a)===Number(b);
  return normal(a)===normal(b);
}
function conflict(field,message) { return {field,message,severity:'check',escalate:false}; }
function compareFields(first,second,keys,prefix,issues,result,source='The second reading',photo=null) {
  for(const key of keys) {
    if(!present(second[key]))continue;
    if(!present(first[key])) {
      if(result)result[key]=second[key];
    } else if(!same(key,first[key],second[key])) {
      const firstValue=first[key];
      const firstConfidence=first.readConfidence?.[key], nextConfidence=second.readConfidence?.[key];
      // A matching barcode pins the row down even when the two readings disagree on a style character.
      const clearerStyle=result && key==='sku' && present(first.itemId) && same('itemId',first.itemId,second.itemId)
        && firstConfidence<.7 && nextConfidence>=firstConfidence+.08;
      const corroborated=result && present(photo?.[key]) && same(key,photo[key],second[key]);
      if(corroborated || clearerStyle)result[key]=second[key];
      if(clearerStyle)result.readConfidence={...result.readConfidence,[key]:nextConfidence};
      let message=labels[key]+' differs. The record shows “'+firstValue+'”. '+source+' shows “'+second[key]+'”.';
      if(corroborated || clearerStyle) {
        message=labels[key]+' differs. The first reading shows “'+firstValue+'”. The second reading shows “'+second[key]+'”. '+
          (corroborated?'The independent photo reading agrees with the second value.':'The second reading was more legible. Check the printed style.');
      }
      issues.push(conflict(prefix+key,message));
    }
  }
}

// SKU and complete item wording are independent anchors. If they point to two rows,
// avoid attributing the other row’s prices or identifiers to this one.
const anchorMatches=(a,b)=>['itemId','sku','item'].some(k=>present(a[k]) && present(b[k]) && same(k,a[k],b[k]));
function uniquePrintedRows(items,printed) {
  const out=new Map();
  for(const [i,item] of items.entries()){
    const hits=printed.filter(row=>anchorMatches(item,row));
    if(hits.length===1 && items.filter(other=>anchorMatches(other,hits[0])).length===1)out.set(i,hits[0]);
  }
  return out;
}
function pairRows(left,right) {
  const used=new Set(), pairs=new Map(), remaining=new Set(left.map((_,i)=>i));
  const exact=(a,b)=>productFields.every(k=>(!present(a[k]) && !present(b[k])) || same(k,a[k],b[k]));
  for(const i of [...remaining]){
    const j=right.findIndex((row,j)=>!used.has(j) && exact(left[i],row));
    if(j>=0){used.add(j);pairs.set(i,j);remaining.delete(i);}
  }
  for(const i of remaining) {
    const hits=right.map((r,j)=>!used.has(j) && anchorMatches(left[i],r) ? j : -1).filter(j=>j>=0);
    if(hits.length!==1)continue;
    const j=hits[0];
    if([...remaining].some(k=>k!==i && anchorMatches(left[k],right[j])))continue;
    used.add(j);pairs.set(i,j);
  }
  // If the two passes kept the same number and order of lines, use a guarded
  // positional fallback for a single OCR name typo. Amount and quantity must
  // agree, identifiers and brands must not contradict each other, and the
  // item names must be equal or one edit apart. This narrows the review to the
  // field that differs while leaving repeated or reordered lines unresolved.
  const oneEditApart=(a,b)=>{
    const leftName=normal(a), rightName=normal(b);
    if(!leftName || !rightName || leftName===rightName)return leftName===rightName;
    if(Math.abs(leftName.length-rightName.length)>1)return false;
    let row=0, column=0, edits=0;
    while(row<leftName.length && column<rightName.length){
      if(leftName[row]===rightName[column]){row++;column++;continue;}
      if(++edits>1)return false;
      if(leftName.length>rightName.length)row++;
      else if(rightName.length>leftName.length)column++;
      else {row++;column++;}
    }
    return edits + (leftName.length-row) + (rightName.length-column) <= 1;
  };
  const compatible=(a,b)=>{
    const both=(key)=>present(a[key]) && present(b[key]);
    const equalWhenPresent=(key)=>!both(key) || same(key,a[key],b[key]);
    const names=present(a.item) && present(b.item) && oneEditApart(a.item,b.item);
    return names && equalWhenPresent('amount') && equalWhenPresent('qty') &&
      equalWhenPresent('brand') && equalWhenPresent('itemId') && equalWhenPresent('sku');
  };
  if(left.length===right.length){
    for(const i of [...remaining]){
      const j=i;
      if(!used.has(j) && compatible(left[i],right[j])){
        used.add(j);pairs.set(i,j);remaining.delete(i);
      }
    }
  }
  return pairs;
}
function rowsBalance(rows,data) {
  if(!present(data.total) || !rows.length || rows.some(row=>!present(row.amount) || !Number.isFinite(Number(row.amount))))return false;
  const sum=rows.reduce((t,row)=>t+Number(row.amount),0), discount=Number(data.discount)||0;
  // Only an exactly supported total can justify introducing additional product rows.
  const totals=[sum,sum-discount];
  if(present(data.tax))totals.push(sum+Number(data.tax),sum-discount+Number(data.tax));
  return totals.some(value=>Math.abs(value-Number(data.total))<.005);
}
function rowSummary(rows) {
  const display=rows.slice(0,4).map(r=>[r.item||r.sku||'Unreadable name',r.amount].filter(present).join(' · ')).join(', ');
  return display+(rows.length>4?'…':'');
}

function oneDigitApart(a, b) {
  const left=String(a).trim().toUpperCase(), right=String(b).trim().toUpperCase();
  if (!left || left.length!==right.length || left===right) return false;
  let diffs=0;
  for (let i=0;i<left.length;i++) if (left[i]!==right[i]) {
    if (!/\d/.test(left[i]+right[i])) return false;
    diffs++;
  }
  return diffs===1;
}
export function mergeReadings(first,second,photo) {
  const data={...first,model:second.model??first.model,cost:second.cost??first.cost,
    items:(first.items||[]).map(row=>({...row})),fieldIssues:[...(first.fieldIssues||[])]};
  const conflicts=[];
  let fields=receiptFields;
  if (present(first.receiptReference) && present(second.receiptReference) && !same('receiptReference',first.receiptReference,second.receiptReference) && oneDigitApart(first.receiptReference,second.receiptReference)) {
    const firstConfidence=Number(first.readConfidence?.receiptReference);
    const secondConfidence=Number(second.readConfidence?.receiptReference);
    const preferSecond=Number.isFinite(secondConfidence) && (!Number.isFinite(firstConfidence) || secondConfidence>firstConfidence);
    data.receiptReference=preferSecond ? second.receiptReference : first.receiptReference;
    data.readConfidence={...(data.readConfidence||{}), receiptReference: preferSecond ? secondConfidence : (Number.isFinite(firstConfidence) ? firstConfidence : 0)};
    data.fieldIssues.push({field:'receiptReference', reason:'receipt_id_pass_conflict', evidence:first.receiptReference+' / '+second.receiptReference});
    fields=receiptFields.filter(key=>key!=='receiptReference');
  }
  compareFields(first,second,fields,'',conflicts,data,'The second reading',photo);
  data.dateIssue=[...new Set([first.dateIssue,second.dateIssue].filter(Boolean))].join(' ') || null;
  const other=second.items||[], pairs=pairRows(data.items,other);
  const witnesses=uniquePrintedRows(other,photo?.items||[]);
  const indexFromSecond=new Map();
  for(const [i,j] of pairs) {
    compareFields(data.items[i],other[j],productFields,'items.'+i+'.',conflicts,data.items[i],'The second reading',witnesses.get(j));
    indexFromSecond.set(j,i);
  }
  const unused=other.map((_,j)=>j).filter(j=>!indexFromSecond.has(j));
  const unmatched=data.items.length-pairs.size;
  if(unused.length && (!data.items.length || (!unmatched && rowsBalance(other,data) && !rowsBalance(data.items,data)))) {
    for(const j of unused){indexFromSecond.set(j,data.items.length);data.items.push({...other[j]});}
  } else if(unused.length || unmatched) {
    conflicts.push(conflict('items','The product lines could not be paired uniquely. First reading ('+first.items.length+'): '+rowSummary(first.items)+'. Second reading ('+other.length+'): '+rowSummary(other)+'.'));
  }
  for(const issue of second.fieldIssues||[]) {
    let field=issue.field;
    const match=/^items\.(\d+)\.(.+)$/.exec(field);
    if(match){const i=indexFromSecond.get(Number(match[1]));if(i==null)continue;field='items.'+i+'.'+match[2];}
    if(!data.fieldIssues.some(f=>f.field===field && f.reason===issue.reason && f.evidence===issue.evidence)) data.fieldIssues.push({...issue,field});
  }
  return {data,conflicts};
}

export function comparePhotoFields(data,photo) {
  const issues=[];
  compareFields(data,photo,['total'],'',issues,null,'The photo reading');
  const rows=data.items||[], printed=photo.items||[];
  for(const [i,row] of uniquePrintedRows(rows,printed))
    compareFields(rows[i],row,['brand','item','itemId','sku','qty','unitPrice','amount'],'items.'+i+'.',issues,null,'The photo reading');
  return issues.map(issue=>({...issue,escalate:true}));
}
