const STORAGE_KEY='tillroll.reading-history.v1';
const LIMIT=120;

function readStore(){
  try {
    const value=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');
    return {entries:Array.isArray(value.entries)?value.entries:[],events:Array.isArray(value.events)?value.events:[]};
  } catch { return {entries:[],events:[]}; }
}
function writeStore(store){
  try { localStorage.setItem(STORAGE_KEY,JSON.stringify(store)); } catch { /* Private browsing can disable localStorage. */ }
}
function text(value){return String(value??'').trim();}
function lineSnapshot(r){
  return (r.data?.items||[]).map(item=>({brand:text(item.brand),item:text(item.item),itemId:text(item.itemId),sku:text(item.sku),
    unitPrice:item.unitPrice??null,amount:item.amount??null,qty:item.qty??null}));
}
function lookupSnapshot(r){
  return (r.verification||[]).map(result=>({status:result.status||'',source:result.source||'',reason:result.reason||'',
    skipped:Boolean(result.skipped),fields:(result.fields||[]).map(field=>({key:field.key,status:field.status,actual:field.actual,expected:field.expected}))}));
}
function receiptKey(r){return text(r.hash)||text(r.filename)||'receipt-'+String(r.id??'');}
function label(r){return text(r.workbookName)||text(r.filename)||('Receipt '+String(r.id??''));}
export function recordReading(r){
  if(!r?.data)return;
  const store=readStore(), key=receiptKey(r), lines=lineSnapshot(r), lookup=lookupSnapshot(r);
  let entry=store.entries.find(item=>item.key===key);
  if(!entry){entry={key,filename:r.filename||'',merchant:r.data.merchant||'',events:[],reading:null,lookup:null};store.entries.unshift(entry);}
  const before=JSON.stringify(entry.lookup||[]), after=JSON.stringify(lookup);
  entry.filename=r.filename||entry.filename;entry.merchant=r.data.merchant||entry.merchant;
  entry.reading={at:new Date().toISOString(),method:r.method||'',merchant:r.data.merchant||'',date:r.data.date||'',time:r.data.time||'',lines};
  entry.lookup=lookup;
  entry.events.unshift({type:'reading',at:entry.reading.at,detail:`${lines.length} item line${lines.length===1?'':'s'} read`});
  if (before!==after && before!=='[]' && before!=='null')
    entry.events.unshift({type:'lookup-change',at:new Date().toISOString(),detail:'Lookup result changed after a new reading.'});
  store.entries=store.entries.slice(0,LIMIT);writeStore(store);
}
export function recordExport(receipts,kind='detailed'){
  const store=readStore(), at=new Date().toISOString();
  for(const r of receipts||[]){
    if(!r?.data)continue;
    const key=receiptKey(r);let entry=store.entries.find(item=>item.key===key);
    if(!entry){entry={key,filename:r.filename||'',merchant:r.data.merchant||'',events:[]};store.entries.unshift(entry);}
    entry.events??=[];entry.events.unshift({type:'export',at,key,detail:kind==='china'?'Chinese operating workbook exported':'Detailed Tillroll workbook exported'});
  }
  store.entries=store.entries.slice(0,LIMIT);writeStore(store);
}
export function recordRefresh({receipt,changedFields=[],clearedFields=[],lookupChanged=false}){
  if(!receipt?.data)return;
  const store=readStore(),key=receiptKey(receipt);let entry=store.entries.find(item=>item.key===key);
  if(!entry){entry={key,filename:receipt.filename||'',merchant:receipt.data.merchant||'',events:[]};store.entries.unshift(entry);}
  const previousLookup=JSON.stringify(entry.lookup||null), nextLookup=lookupSnapshot(receipt);
  const lookupDidChange=lookupChanged || (entry.lookup!==undefined && previousLookup!==JSON.stringify(nextLookup));
  const fields=[...new Set(changedFields.map(text).filter(Boolean))];
  const clears=[...new Set(clearedFields.map(text).filter(Boolean))];
  const detail=[fields.length?`Excel changed ${fields.join(', ')}`:'Excel values unchanged',clears.length?`manually unflagged ${clears.join(', ')}`:'',lookupDidChange?'lookup result changed':'' ].filter(Boolean).join('. ')+'.';
  entry.events??=[];entry.events.unshift({type:clears.length?'manual-clear':'refresh',at:new Date().toISOString(),detail});
  entry.reading={...(entry.reading||{}),at:new Date().toISOString(),merchant:receipt.data.merchant||'',date:receipt.data.date||'',time:receipt.data.time||'',lines:lineSnapshot(receipt)};
  entry.lookup=nextLookup;store.entries=store.entries.slice(0,LIMIT);writeStore(store);
}
export function historyEntries(){return readStore().entries;}
export function clearHistory(){try{localStorage.removeItem(STORAGE_KEY);}catch{} }
