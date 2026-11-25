// Plan the entire refresh before the caller changes any receipt or reruns its checks.
const receiptFields = {
  merchant:'Source', date:'Date', time:'Time', orderNumber:'Order Number', orderId:'Order ID',
  currency:'Currency', total:'Receipt Total', payment:'Payment Type', card:'Card', receiptReference:'Receipt reference'
};
const itemFields = {
  brand:'Brand', itemId:'Item ID', item:'Item', sku:'Style / SKU', colour:'Colour', size:'Size',
  qty:'Qty', unitPrice:'Unit Price', amount:'Amount'
};

const nullable = value => value === undefined || value === '' ? null : value;
function currentReceipt(receipt) { return receipt.record || receipt.data; }
function nameKey(filename) { return String(filename ?? '').trim().normalize('NFC').toLowerCase(); }
function comparable(value,field) {
  if (field==='time' && typeof value==='string') return value.replace(/^(\d\d:\d\d):00$/,'$1');
  return nullable(value);
}
function equal(a,b,field) { return comparable(a,field)===comparable(b,field); }

function conflict(filename,field) {
  return new Error(filename+' — '+field+' changed in both Excel and Tillroll. Export the current batch and reapply this edit.');
}

const previousValues = row => row.baseline || row.legacyBaseline;

// Values repeated across receipt lines are independent cells in Excel. A change
// to one copy is enough. Two different edits to the same field need clarification.
function fieldChanges(rows,scope,fields,current) {
  const changes={};
  for (const [key,label] of Object.entries(fields)) {
    const present=rows.filter(row=>Object.hasOwn(row[scope],key));
    if (!present.length) continue;
    const first=present[0];
    const effectiveBase=snapshot=>scope==='receipt' && snapshot.appliedReceipt
      ? snapshot.appliedReceipt : snapshot[scope];
    const firstSnapshot=previousValues(first);
    const base=firstSnapshot ? effectiveBase(firstSnapshot)[key] : current[key];
    let edited=false, proposed;
    for (const row of present) {
      const snapshot=previousValues(row);
      if (snapshot && (!Object.hasOwn(snapshot[scope],key) || !equal(effectiveBase(snapshot)[key],base,key)))
        throw new Error('Inconsistent export data for '+label+' in '+row.filename+'. Export a fresh workbook.');
      const value=row[scope][key];
      if (equal(value,snapshot ? snapshot[scope][key] : base,key)) continue;
      if (edited && !equal(value,proposed,key))
        throw new Error('Excel has different edits to '+label+' on rows for '+row.filename+'. Use the same value for that receipt.');
      edited=true;
      proposed=value;
    }
    if (!edited || equal(proposed,current[key],key)) continue;
    if (firstSnapshot && !equal(current[key],base,key)) throw conflict(first.filename,label);
    changes[key]=nullable(proposed);
  }
  return changes;
}

const identity = value => String(value ?? '').trim().normalize('NFC').toLowerCase();
function sameIdentity(left,right) { return Boolean(identity(left)) && identity(left)===identity(right); }
function receiptMatches(row,receipt) {
  const current=currentReceipt(receipt);
  return ['orderId','orderNumber','receiptReference'].some(key=>sameIdentity(row.receipt[key],current[key])) ||
    ['merchant','date','total'].every(key=>sameIdentity(row.receipt[key],current[key]));
}

function fieldsEqual(values,current,fields) {
  return Object.keys(fields).every(key=>!Object.hasOwn(values,key) || equal(values[key],current[key],key));
}
function legacyLineIndex(row,receipt,used) {
  const items=receipt.data.items;
  // Resolve by all surviving product identifiers, never by spreadsheet row order.
  // Ignore a changed identifier with no matches; refuse contradictory matches.
  let candidates;
  for (const key of ['itemId','sku','item']) {
    const matches=[];
    items.forEach((item,index)=>{if(sameIdentity(item[key],row.line[key])) matches.push(index);});
    if (matches.length) candidates=candidates ? candidates.filter(index=>matches.includes(index)) : matches;
  }
  if (candidates?.length===1) return candidates[0];
  if (candidates?.length>1) {
    const exact=candidates.find(index=>!used.has(index) && fieldsEqual(row.line,items[index],itemFields));
    if (exact!==undefined) return exact;
  }
  if (!candidates && items.length===1 && receiptMatches(row,receipt)) return 0;
  throw new Error('Cannot identify the item on Excel row '+row.rowNumber+' in '+row.filename+'. Export a fresh workbook from this batch.');
}

function matchLine(row,receipt,keyed,used) {
  if (!receipt.data.items.length) {
    if (keyed && row.lineKey!==receipt.emptyLineRefreshKey)
      throw new Error('The item on Excel row '+row.rowNumber+' is no longer in '+row.filename+'. Export the current batch.');
    if (Object.keys(itemFields).some(key=>nullable(row.line[key])!==null))
      throw new Error('Excel row '+row.rowNumber+' adds an item to '+row.filename+'. Add it in Tillroll and export again.');
    if (!keyed && !receiptMatches(row,receipt))
      throw new Error('Cannot match '+row.filename+' to the current receipt. Export a fresh workbook.');
    return -1;
  }
  if (!keyed) {
    const previous=row.legacyBaseline;
    return legacyLineIndex(previous ? {...row,receipt:previous.appliedReceipt,line:previous.line} : row,receipt,used);
  }
  const index=receipt.data.items.findIndex(item=>item.refreshKey===row.lineKey);
  if (index===-1) throw new Error('Unknown or deleted item on Excel row '+row.rowNumber+' in '+row.filename+'. Export the current batch.');
  return index;
}

export function planWorkbookRefresh(batch,{rows}) {
  if (!rows?.length) throw new Error('This workbook has no receipt rows.');
  const keyed=Boolean(rows[0].receiptKey);
  const candidates=batch.filter(r=>r.data && (!r.state || r.state==='done'));
  const byKey=new Map(), byName=new Map();
  for (const r of candidates) {
    if (r.refreshKey) byKey.set(r.refreshKey,r);
    const name=nameKey(r.filename);
    if (!byName.has(name)) byName.set(name,[]);
    byName.get(name).push(r);
  }
  const groups=new Map();
  for (const row of rows) {
    if ([row.receiptKey,row.lineKey,row.baseline].some(value=>Boolean(value)!==keyed))
      throw new Error('Excel row '+row.rowNumber+' is missing its export identifiers. Export a fresh workbook.');
    const name=nameKey(row.filename);
    let receipt;
    if (keyed) {
      receipt=byKey.get(row.receiptKey);
      if (!receipt) throw new Error('Excel row '+row.rowNumber+' belongs to a different batch or to a removed receipt. Open the batch this workbook was exported from.');
      if (name!==nameKey(receipt.filename))
        throw new Error('The File value in Excel row '+row.rowNumber+' does not match '+receipt.filename+'. Restore the original filename.');
    } else {
      const matches=byName.get(name) || [];
      if (matches.length!==1)
        throw new Error('The filename on Excel row '+row.rowNumber+' must match exactly one receipt in this batch: '+row.filename+'.');
      receipt=matches[0];
    }
    if (!groups.has(receipt)) groups.set(receipt,{rows:[],lines:new Map()});
    const group=groups.get(receipt);
    group.rows.push(row);
    // A legacy row already linked to its last saved copy needs no live item
    // match until an item cell changes. The website may have edited its SKU.
    if (row.legacyBaseline && fieldsEqual(row.line,row.legacyBaseline.line,itemFields)) continue;
    const index=matchLine(row,receipt,keyed,group.lines);
    if (group.lines.has(index))
      throw new Error('Excel rows '+group.lines.get(index).rowNumber+' and '+row.rowNumber+' identify the same item in '+receipt.filename+'. Export one row per item.');
    group.lines.set(index,row);
  }
  const plans=[];
  for (const [receipt,{rows:groupRows,lines}] of groups) {
    // A new item in Tillroll that never received an export key was not in the
    // workbook. Preserve it. Never interpret an absent workbook row as a deletion.
    const missing=keyed ? receipt.data.items.some((item,index)=>item.refreshKey && !lines.has(index))
      : groupRows.length!==Math.max(1,receipt.data.items.length);
    if (missing) throw new Error('Excel is missing an item row for '+receipt.filename+'. Restore the row or export the current batch.');
    const receiptChanges=fieldChanges(groupRows,'receipt',receiptFields,currentReceipt(receipt));
    const itemChanges=[];
    const clearedFields=[...new Set(groupRows.flatMap(row=>row.clearedFields||[]))];
    for (const [index,row] of lines) {
      if (index===-1) continue;
      const fields=fieldChanges([row],'line',itemFields,receipt.data.items[index]);
      if (Object.keys(fields).length) itemChanges.push({index,fields});
    }
    if (Object.keys(receiptChanges).length || itemChanges.length || clearedFields.length)
      plans.push({receipt,receiptChanges,itemChanges,clearedFields});
  }
  return plans;
}

function workbookGroups(rows) {
  if (!rows?.length) throw new Error('This workbook has no receipt rows.');
  const keyed=Boolean(rows[0].receiptKey), groups=new Map(), lineKeys=new Set();
  for (const row of rows) {
    if ([row.receiptKey,row.lineKey,row.baseline].some(value=>Boolean(value)!==keyed))
      throw new Error('Excel row '+row.rowNumber+' is missing its export identifiers. Export a fresh workbook.');
    if (keyed && lineKeys.has(row.lineKey)) throw new Error('Duplicate item identifier on Excel row '+row.rowNumber+'.');
    if (keyed) lineKeys.add(row.lineKey);
    const key=keyed ? row.receiptKey : nameKey(row.filename);
    if (!groups.has(key)) groups.set(key,[]);
    const group=groups.get(key);
    if (group.length && nameKey(group[0].filename)!==nameKey(row.filename))
      throw new Error('Receipt filenames disagree on Excel row '+row.rowNumber+'.');
    group.push(row);
  }
  return groups;
}

function editableValues(source,fields) {
  return Object.fromEntries(Object.keys(fields).filter(key=>Object.hasOwn(source,key)).map(key=>[key,source[key]]));
}

// This represents the spreadsheet side of the merge; keeping it independent
// from the live receipt preserves website-only edits on subsequent refreshes.
function effectiveReceipt(group) {
  const first=group[0];
  const snapshot=previousValues(first);
  if (snapshot) {
    const base=editableValues(snapshot.appliedReceipt || snapshot.receipt,receiptFields);
    return {...base,...fieldChanges(group,'receipt',receiptFields,base)};
  }
  for (const row of group) {
    for (const [key,label] of Object.entries(receiptFields)) {
      if (!equal(first.receipt[key],row.receipt[key],key))
        throw new Error('Rows for '+first.filename+' disagree on '+label+'. Make the receipt fields consistent for that filename before opening this older workbook.');
    }
  }
  return editableValues(first.receipt,receiptFields);
}

export function nextWorkbookBaseline({rows}) {
  const next=new Map();
  if (!rows[0]?.receiptKey) return next;
  for (const group of workbookGroups(rows).values()) {
    const appliedReceipt=effectiveReceipt(group);
    for (const row of group) next.set(row.lineKey,{
      receipt:{...row.receipt},line:{...row.line},appliedReceipt,emptyReceipt:row.baseline.emptyReceipt
    });
  }
  return next;
}

// Older exports have no immutable line keys. Keep the accepted worksheet
// values for each original file, and link the next save by product identity.
export function withLegacyWorkbookBaseline(parsed,previous) {
  if (!previous || parsed.exportKey) return parsed;
  const groups=workbookGroups(parsed.rows), rows=[];
  if (groups.size!==previous.size)
    throw new Error('The receipts in this older workbook have changed. Choose the same saved workbook or reopen it as a new batch.');
  for (const [name,group] of groups) {
    const saved=previous.get(name);
    if (!saved || saved.rows.length!==group.length)
      throw new Error('The receipt rows for '+group[0].filename+' differ from the last refresh. Choose the same saved workbook or reopen it as a new batch.');
    const prior={data:{...saved.appliedReceipt,items:saved.rows.map(row=>row.line)}}, matched=new Set(), aligned=new Map();
    // Match unchanged rows first. Identical products can then be reordered
    // without mistaking their repeated receipt-level cells for new edits.
    for (const row of group) {
      const index=saved.rows.findIndex((old,i)=>!matched.has(i) &&
        fieldsEqual(row.line,old.line,itemFields) && fieldsEqual(row.receipt,old.receipt,receiptFields));
      if (index===-1) continue;
      aligned.set(row,index);
      matched.add(index);
    }
    for (const row of group.filter(row=>!aligned.has(row))) {
      const index=legacyLineIndex(row,prior,matched);
      if (matched.has(index)) throw new Error('Excel row '+row.rowNumber+' repeats a product from the last refresh of '+row.filename+'. Export a current workbook.');
      aligned.set(row,index);
      matched.add(index);
    }
    for (const row of group) rows.push({...row,legacyBaseline:{...saved.rows[aligned.get(row)],appliedReceipt:saved.appliedReceipt}});
  }
  return {...parsed,rows};
}

export function nextLegacyWorkbookBaseline({rows},batch,plans=[]) {
  const previous=new Map();
  const changes=new Map(plans.map(plan=>[plan.receipt,plan.receiptChanges]));
  const records=new Map(batch.filter(r=>r.data && (!r.state || r.state==='done')).map(r=>[nameKey(r.filename),r]));
  for (const [name,group] of workbookGroups(rows)) {
    const record=records.get(name);
    if (!record) throw new Error('Cannot locate '+group[0].filename+' in the batch.');
    const appliedReceipt=group[0].legacyBaseline ? effectiveReceipt(group)
      : editableValues({...currentReceipt(record),...changes.get(record)},receiptFields);
    previous.set(name,{appliedReceipt,
      rows:group.map(row=>({receipt:{...row.receipt},line:{...row.line}}))});
  }
  return previous;
}

export function restoreWorkbookReceipts({rows}) {
  const restored=[];
  for (const group of workbookGroups(rows).values()) {
    const first=group[0];
    const data=effectiveReceipt(group);
    const items=[];
    const manualClears=[...new Set(group.flatMap(row=>row.clearedFields||[]))];
    let emptyLineRefreshKey=null;
    for (const row of group) {
      const hasItem=Object.keys(itemFields).some(key=>nullable(row.line[key])!==null);
      if (row.baseline?.emptyReceipt) {
        if (group.length!==1 || hasItem)
          throw new Error('Excel row '+row.rowNumber+' adds an item to an empty receipt. Add the item in Tillroll and export again.');
        emptyLineRefreshKey=row.lineKey;
      } else if (row.lineKey || hasItem) {
        const item=editableValues(row.line,itemFields);
        if (row.lineKey) item.refreshKey=row.lineKey;
        items.push(item);
      }
    }
    restored.push({filename:first.filename,refreshKey:first.receiptKey,emptyLineRefreshKey,manualClears,data:{...data,items}});
  }
  return restored;
}
