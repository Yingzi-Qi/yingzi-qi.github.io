import {oldestPurchaseFirst,purchaseDateText} from './receipt-date-display.js?v=8';
import {inspectReference,combineReferenceReadings} from './reference.js?v=6';
import {readPhoto,secondReadPhoto,extractLocal,extractAI,reconcileReadings,photoFieldConflicts,recoverPhotoItemIds} from './extract.js?v=curatedphotos1';
import {checkReceipt,samePurchase,reviewForLine,verifyImportedItemIds} from './checks.js?v=productcodes3';
import {exportExcel,exportChinaExcel,exportCSV,readOrderFile,readAchungWorkbook,readTillrollEdits} from './exports.js?v=history2';
import {planWorkbookRefresh,restoreWorkbookReceipts,nextWorkbookBaseline,withLegacyWorkbookBaseline,nextLegacyWorkbookBaseline} from './workbook-refresh.js?v=history2';
import {bindExcelRefresh} from './excel-refresh-ui.js?v=1';
import {loadSamples} from './samples.js?v=curatedphotos1';
import {compareOrder,orderNeedsReview} from './orders.js?v=lineverify1';
import {verifyOutputItems} from './item-verification.js?v=history2';
import {photoVerificationRows} from './verification-photo.js?v=curatedphotos1';
import {captureLineWarnings,classifyVerification,hasVerificationMismatch} from './verification-history.js?v=history2';
import {normalizeReceiptData,kindForFlag,kindForVerification,reviewKinds} from './receipt-policy.js?v=policy1';
import {recordReading,recordExport,recordRefresh,historyEntries,clearHistory} from './reading-history.js?v=history1';
const $ = s=>document.querySelector(s);
const escape = v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={settings:'<path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',upload:'<path d="M12 15V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',plus:'<path d="M12 5v14M5 12h14"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',link:'<path d="m10 14 4-4m-4-3 2-2a5 5 0 0 1 7 7l-2 2m-3 3-2 2a5 5 0 0 1-7-7l2-2"/>',play:'<path d="m8 5 10 7-10 7z"/>'};
for(const el of document.querySelectorAll('[data-icon]')) el.innerHTML=`<svg aria-hidden="true" class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[el.dataset.icon]}</svg>`;
window.tillrollV2Hooks={getBatch:()=>batch};
let batch=[],orderList=null,orderFilename='',filter='all',seq=0,generation=0,nowReading=0;
let mode='local',apiKey='',savedSamples=false,noticeTimer,startTime=0,finishedTime=0;
const queue=[], hashOwners=new Map();
const receiptFileHashes=new Set();
let referenceHash=null,referenceRevision=0;
const excelBaselines=new Map();
const legacyBaselines=new Map();
const emptyOCR=()=>({text:'',confidence:0,lines:[]});
const blankItem=()=>({brand:'',item:'',sku:'',itemId:'',colour:'',size:'',qty:null,unitPrice:null,amount:null});
const referenceLabels={orderId:'Order ID',orderNumber:'Order number',receiptReference:'Receipt reference'};
const sameReference=(a,b)=>String(a??'').trim().toLowerCase()===String(b??'').trim().toLowerCase();
const get=(obj,key)=>key.split('.').reduce((v,k)=>v?.[k],obj);
function set(obj,key,value){const keys=key.split('.'); const end=keys.pop(); let cur=obj;for(const k of keys)cur=cur[k];cur[end]=value;}
const normalData=data=>normalizeReceiptData({...data,items:Array.isArray(data?.items)?data.items.map(x=>({...blankItem(),...x})):[]});
const confidenceOptions = r=>({independentPhoto:r.origin==='ai'||r.origin==='sample'});
const active = ()=>batch.filter(r=>r.state==='done' && !r.duplicateOf).sort(oldestPurchaseFirst);
const notDone = r=>['queued','reading','checking','second'].includes(r.state);
const isReview = r=>r.state==='error' || (!r.duplicateOf && r.data && (r.review.flags.some(x=>x.severity!=='info') || r.review.photo.some(x=>x.status==='Needs review') || r.orders?.some(orderNeedsReview) || r.verification?.some(hasVerificationMismatch)));
function note(message){const n=$('#notice');clearTimeout(noticeTimer);n.hidden=!message;n.textContent=message;if(message)noticeTimer=setTimeout(()=>{n.hidden=true;},6500);}
function historyRecordReading(r){try{recordReading(r);}catch{} }
function formatHistoryTime(value){try{return new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}catch{return value||'';}}
function renderHistory(){
  const list=$('#history-list');if(!list)return;
  const entries=historyEntries();
  if(!entries.length){list.innerHTML='<p class="history-empty">No reading or workbook history yet.</p>';return;}
  list.innerHTML=entries.map(entry=>{
    const events=(entry.events||[]).slice(0,12);
    const lines=entry.reading?.lines||[];
    const eventHtml=events.map(event=>`<li><span class="history-tag ${event.type==='manual-clear'||event.type==='lookup-change'?'change':event.type==='refresh'?'refresh':''}">${escape(event.type==='manual-clear'?'Manual correction':event.type==='refresh'?'Excel refresh':event.type==='lookup-change'?'Lookup change':event.type==='export'?'Export':'Reading')}</span> <time>${escape(formatHistoryTime(event.at))}</time> · ${escape(event.detail||'')}</li>`).join('');
    const preview=lines.length?`<details class="history-preview"><summary>View ${lines.length} exported row${lines.length===1?'':'s'}</summary><div class="history-table"><div class="history-row history-head"><span>品牌</span><span>品名</span><span>品牌货号</span><span>采购商品金额</span></div>${lines.map(line=>`<div class="history-row"><span>${escape(line.brand||'—')}</span><span>${escape(line.item||'—')}</span><span>${escape(line.itemId||'—')}</span><span>${escape(line.amount??line.unitPrice??'—')}</span></div>`).join('')}</div></details>`:'';
    return `<article class="history-entry"><strong>${escape(entry.filename||entry.merchant||'Receipt')}</strong><small>${escape(entry.merchant||'')}</small><div class="history-meta"><ul>${eventHtml}</ul></div>${preview}</article>`;
  }).join('')||'<p class="history-empty">No reading or workbook history yet.</p>';
}
function openHistory(){renderHistory();const dialog=$('#history-dialog');if(dialog && !dialog.open)dialog.showModal();}
function importedPhotoChecks(r, fillMissing=false) {
  const passes=(r.itemIdReadings || []).map(ocr=>verifyImportedItemIds(r.data,ocr));
  if (!passes.length) return [];
  return r.data.items.map((item,i)=>{
    const results=passes.map(pass=>pass[i]);
    const ids=[...new Set(results.map(result=>result.printedItemId).filter(Boolean))];
    const evidence=[...new Set(results.map(result=>result.itemIdEvidence).filter(Boolean))].join(' | ');
    if (ids.length>1) return {status:'Needs review',reason:'The photo readings disagree on the item ID: '+ids.join(' / ')+'.',itemIdEvidence:evidence};
    const issue=results.find(result=>result.status==='Needs review' && !result.printedItemId)
      || (item.itemId && results.find(result=>result.status==='Needs review'));
    if (issue) return {...issue,itemIdEvidence:evidence};
    if (fillMissing && !item.itemId && ids.length===1) item.itemId=ids[0];
    if (ids.length===1 && ids[0]===item.itemId) return {status:'Item ID found',reason:'The printed item ID agrees with this product line.',itemIdEvidence:evidence};
    return results.find(result=>result.printedItemId) || results[0];
  });
}
function comparePurchase(record) {
  if (!orderList) return null;
  const key=value=>String(value??'').trim().toLowerCase().replace(/\s+/g,' ');
  const hasReference=row=>Boolean(row.order_number || row.order_id);
  const purchases=orderList.filter(hasReference);
  if (!purchases.length) return null;
  const retailer=key(record.merchant);
  if (orderList.some(row=>!hasReference(row) && key(row.retailer)===retailer) &&
      !purchases.some(row=>key(row.retailer)===retailer)) return null;
  return compareOrder(record,purchases);
}

function verifyFinalOutput(r) {
  if (!r.lookupReady) { r.verification=[]; return; }
  let readings=r.itemIdReadings || [r.ocr,r.otherOcr].filter(Boolean);
  const local=r.origin==='local';
  if (local && readings.length<2) readings=[];
  if (!r.photoWitnessCache || r.photoWitnessCache.readings.length!==readings.length ||
      readings.some((ocr,i)=>r.photoWitnessCache.readings[i]!==ocr)) {
    r.photoWitnessCache={readings,rows:photoVerificationRows(readings,{requireAgreement:local})};
  }
  const results=verifyOutputItems(r.record,orderList,r.photoWitnessCache.rows);
  const branch=results.find(result=>result.storeAddress)?.storeAddress;
  if(branch && r.data.merchant) r.data.merchantDisplay=r.data.merchant+' · '+String(branch).split(',').slice(0,2).join(',').trim();
  r.verification=results.map((result,i)=>{
    const line=classifyVerification(result,r.priorLineChecks[i]);
    const manualFields=[`items.${i}.verification`,`items.${i}.verification.status`,`items.${i}.verification.reason`,
      ...result.fields.map(field=>`items.${i}.${field.key}`)];
    if (manualFields.some(field=>r.manualClears?.has(field)) && hasVerificationMismatch(line)) {
      line.status='Manually cleared';
      line.reason='Previously reviewed in Excel and manually unflagged. '+line.reason;
    }
    const sources=[...new Set(result.fields.map(field=>field.source))];
    if (!r.data.items[i].itemId && r.data.items[i].sku && line.status==='Not verified') {
      line.reason='This line has a style/SKU. Verification by item ID needs a separately recorded item ID.';
    }
    line.source=sources.map(source=>source+' · '+(source==='Receipt photo'?r.filename:orderFilename)).join(' + ');
    return line;
  });
}

function finalizeOutput(r) {
  r.priorLineChecks=captureLineWarnings(r);
  verifyFinalOutput(r);
  historyRecordReading(r);
}

function evaluate(r, fillMissing=false) {
  if (!r.data) return;
  evaluateReceipt(r,fillMissing);
  if (r.priorLineChecks) verifyFinalOutput(r);
}

function evaluateReceipt(r,fillMissing){
  if(!r.data)return;
  if(r.origin==='achung'){
    r.record=r.duplicateRecord=r.data;
    r.review={flags:r.nativeFlags,photo:importedPhotoChecks(r,fillMissing),repeats:[]};
  r.orders=r.lookupReady ? comparePurchase(r.record) : null;
    return;
  }
  if(r.origin==='workbook' && fillMissing)importedPhotoChecks(r,true);
  const ocr=r.itemIdReadings?.[0] || r.ocr || emptyOCR();
  const other=r.itemIdReadings?.[1] || r.otherOcr;
  r.reference=inspectReference(r.data,ocr,orderList);
  if(other)r.reference=combineReferenceReadings(r.reference,inspectReference(r.data,other,orderList));
  r.record={...r.data};
  const choice=r.confirmedReference;
  const competing=choice?.values || (r.reference.suggestion ? r.reference.candidates.map(c=>c.value) : []);
  for(const key of Object.keys(referenceLabels)){
    if(!r.editedReferences?.has(key) && competing.some(value=>sameReference(value,r.data[key]))) r.record[key]=null;
  }
  if(choice){
    r.reference={...choice.candidate,kind:choice.kind,label:referenceLabels[choice.kind],status:'found',
      basis:'user-confirmed',reason:'You confirmed this number on the receipt.',reasonCode:null,
      requiresReview:false,suggestion:null,candidates:[],reviewedValues:choice.values};
    r.record[choice.kind]=choice.candidate.value;
  }
  const ref=r.reference;
  // Duplicate detection can use printed or manually accepted IDs, independently of an imported list.
  r.duplicateRecord={...r.record};
  if(ref.status==='found' && !r.record[ref.kind] && !r.editedReferences?.has(ref.kind))
    r.record[ref.kind]=ref.value;
  r.review=checkReceipt(r.record,ocr,r.previous||null,{...confidenceOptions(r),reference:ref,orders:orderList,demoFormats:r.demo?.set==='demo'});
  if(r.origin==='workbook' && !ocr.text){
    r.review.flags=r.review.flags.filter(f=>!f.field.endsWith('.photo'));
    r.review.photo=r.data.items.map(()=>({status:'Not verified',reason:'No readable original photo is attached.'}));
  }
  const extra=[...(r.readingConflicts||[])];
  if(r.origin==='ai' && ocr.text) {
    for(const issue of photoFieldConflicts(r.record,ocr)) extra.push({...issue,stage:'Model compared with photo OCR'});
  }
  if(r.verifyIssue)extra.push({field:'verification',message:r.verifyIssue,severity:'check',escalate:false});
  for(const issue of extra){
    if(choice && issue.field===choice.kind)continue;
    if(!r.review.flags.some(f=>f.field===issue.field && f.message===issue.message))r.review.flags.push(issue);
  }
  r.review.flags=r.review.flags.filter(f=>!r.ack.has(f.field+'|'+f.message) && !r.manualClears?.has(f.field));
  if(r.data.items.length && !r.review.photo.length)r.review.photo=r.data.items.map(()=>({status:'Not verified',reason:'No photo evidence available.'}));
  r.orders=r.lookupReady ? comparePurchase(r.record) : null;
}
function duplicates(){
  const canonical=[];
  for(const r of batch){
    if(r.exactOf){r.duplicateOf=r.exactOf;continue;}
    r.duplicateOf=null;if(r.state!=='done')continue;
    // Achung already chose which receipts to include in its workbook.
    const match=canonical.find(s=>!(r.importGroup && s.importGroup===r.importGroup) && samePurchase(s.duplicateRecord,r.duplicateRecord));
    if(match && !r.keepBoth) r.duplicateOf=match.id;
    else canonical.push(r);
  }
}
function startInput(entries, useSaved=savedSamples){
  if(!entries.length)return;
  if(!startTime)startTime=Date.now();
  else if(finishedTime)startTime+=Date.now()-finishedTime;
  finishedTime=0;
  for(const entry of entries){const file=entry.file;if(!file)continue;
    const r={id:++seq,filename:file.name,file,url:URL.createObjectURL(file),state:'queued',method:'Queued',review:{flags:[],photo:[],repeats:[]},ack:new Set(),notes:[],reasons:[],generation,origin:'',usedAI:false,lookupReady:Boolean(entry.sample&&useSaved)};
    r.demo=entry.sample?entry:null;r.useSaved=Boolean(r.demo && useSaved);r.readerSettings={mode,key:apiKey};batch.push(r);queue.push(r);
  }
  filter='all';render();pump();
}
function pump(){while(nowReading<2 && queue.length){const r=queue.shift();if(r.generation!==generation)continue;nowReading++;run(r).finally(()=>{nowReading--;if(!queue.length&&!batch.some(notDone))finishedTime=Date.now();render();pump();});}}
async function fingerprint(file){const b=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));return Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');}
async function run(r){
  const begun=performance.now();const current=()=>r.generation===generation&&batch.includes(r);const {mode:chosenMode,key:chosenKey}=r.readerSettings;delete r.readerSettings;
  try{
    r.state='reading';render();r.hash=await fingerprint(r.file);if(!current())return;
    const owner=hashOwners.get(r.hash);
    if(owner && owner!==r.id){r.exactOf=owner;r.duplicateOf=owner;r.state='duplicate';return;}
    hashOwners.set(r.hash,r.id);
    if(r.useSaved){r.data=normalData(structuredClone(r.demo.data));r.ocr=r.demo.ocr;r.otherOcr=r.demo.referenceOcr;r.origin='sample';r.method='Saved reading';}
    else{
      const modelEnabled=chosenMode==='server'&&!!chosenKey;
      const [ocrRead,aiRead]=await Promise.allSettled([readPhoto(r.file),modelEnabled?extractAI(r.file,chosenKey,1,[]):Promise.resolve(null)]);if(!current())return;
      r.ocr=ocrRead.status==='fulfilled'?ocrRead.value:emptyOCR();
      if(ocrRead.status==='rejected')r.notes.push('Local photo reading failed.');
      if(aiRead.status==='fulfilled'&&aiRead.value){r.data=normalData(aiRead.value);r.origin='ai';r.usedAI=true;r.method=r.data.model||'Gemini';}
      else if(r.ocr.text){r.data=normalData(extractLocal(r.ocr));r.origin='local';r.method='Local OCR';if(modelEnabled)r.notes.push('Gemini was unavailable. This result uses on-device OCR.');}
      else throw new Error('No readable extraction. Try a brighter, sharper photo or check the reader settings.');
    }
    if (r.origin==='ai' || r.origin==='sample') r.data=recoverPhotoItemIds(r.data,r.ocr);
    r.firstData=structuredClone(r.data);evaluate(r);
    const failures=r.review.flags.filter(f=>f.escalate);const hasPhotoIssues=r.review.photo.some(p=>p.status==='Needs review');
    const orderIssue=r.orders?.some(orderNeedsReview);
    const needsSecondOpinion=Boolean(failures.length||hasPhotoIssues||orderIssue);
    // Local extraction and verification use separate OCR passes. Model output is
    // already independent of the on-device OCR used to check it.
    if(!r.useSaved&&(r.origin==='local'||needsSecondOpinion)){
      r.second=needsSecondOpinion;r.state=r.second?'second':'checking';
      r.reasons=[...new Set(failures.map(f=>f.message))];
      if(hasPhotoIssues)r.reasons.push('Unresolved printed order ID, brand or item.');
      if(orderIssue)r.reasons.push('Recheck the printed identifiers, products and amounts against the receipt.');
      render();
      try{
        let next;
        if(r.usedAI){
          next=recoverPhotoItemIds(await extractAI(r.file,chosenKey,2,r.reasons),r.ocr);
        }else{
          const other=await secondReadPhoto(r.file);
          if(!current())return;
          if(!other?.text)throw new Error('Empty second OCR reading');
          r.otherOcr=r.ocr;r.ocr=other;
          next=extractLocal(other);
        }
        if(!current())return;
        const resolved=reconcileReadings(r.firstData,next,r.usedAI ? r.ocr : undefined);
        r.previous=r.firstData;r.data=normalData(resolved.data);r.readingConflicts=resolved.conflicts;
        r.method=r.usedAI ? next.model||'Gemini second opinion' : 'On-device OCR';
        if(r.usedAI){r.data.cost=next.cost;r.data.model=next.model;}
      }catch{r.verifyIssue='The second reading could not be completed. Check the receipt against the first reading.';}
    }
    if(r.usedAI && !r.ocr.text)r.verifyIssue='On-device photo verification was unavailable. Check the model reading against the receipt.';
    if(!current())return;evaluate(r);finalizeOutput(r);r.state='done';
  }catch(err){if(current()){r.state='error';r.error=String(err?.message||'Could not process this receipt.');}}
  finally{r.elapsed=(performance.now()-begun)/1000;if(current()){duplicates();render();}}
}
const filt = (r,f)=>f==='all'||(f==='review'&&isReview(r))||(f==='verification'&&!r.duplicateOf&&r.verification?.some(line=>line.status==='Verification error'))||(f==='photo'&&!r.duplicateOf&&r.review.photo.some(p=>p.status==='Needs review'))||(f==='dupes'&&!!r.duplicateOf)||(f==='second'&&r.second);
const filterTitles={all:'All',review:'Needs review',verification:'Verification errors',photo:'Photo flags',dupes:'Duplicates',second:'Second pass'};
const textOf=r=>[r.filename,r.data?.merchant,r.data?.date,r.data?.time,r.record?.orderNumber,r.record?.orderId,r.record?.receiptReference,r.reference?.value,...(r.reference?.candidates||[]).map(c=>c.value),...r.review.photo.map(x=>x.idEvidence),...(r.data?.items||[]).flatMap(i=>[i.brand,i.item,i.sku,i.itemId])].join(' ').toLowerCase();
function fieldReviewKinds(r,path,index=null){
  const kinds=new Set();
  for(const flag of r.review?.flags||[])if(flag.field===path && flag.severity!=='info')kinds.add(kindForFlag(flag));
  if(index!==null && r.review?.photo?.[index]?.status==='Needs review')kinds.add(reviewKinds.reading);
  const verification=index!==null ? r.verification?.[index] : null;
  if(verification && hasVerificationMismatch(verification))kinds.add(kindForVerification(verification));
  return kinds;
}
function reviewKindClass(kinds){
  if(kinds.has(reviewKinds.reading))return 'reading-error';
  if(kinds.has(reviewKinds.lookup))return 'lookup-uncertainty';
  return '';
}
function receiptReviewKinds(r){
  const kinds=new Set();
  for(const flag of r.review?.flags||[])if(flag.severity!=='info')kinds.add(kindForFlag(flag));
  for(const photo of r.review?.photo||[])if(photo.status==='Needs review')kinds.add(reviewKinds.reading);
  for(const result of r.verification||[])if(hasVerificationMismatch(result))kinds.add(kindForVerification(result));
  for(const order of r.orders||[])if(orderNeedsReview(order))kinds.add(reviewKinds.lookup);
  return kinds;
}
function badge(label,style='',reason=''){return `<span class="status ${style}" title="${escape(reason)}">${escape(label)}</span>`;}
function cell(r,path,txt,title,extraClass=''){
  const idLine=/^items\.(\d+)\.itemId$/.exec(path);
  const product=/^items\.(\d+)\.(item|brand|amount|itemId)$/.exec(path);
  const mismatch=product && r.verification?.[Number(product[1])]?.fields.some(f=>f.key===product[2] && f.status==='mismatch');
  const kinds=fieldReviewKinds(r,path,idLine?Number(idLine[1]):null);
  const warning=mismatch || kinds.size>0;
  return `<button class="cell ${extraClass} ${warning?'marked':''} ${reviewKindClass(kinds)}" data-id="${r.id}" data-path="${escape(path)}" title="${escape(title??txt??'Edit')}">${escape(txt??'')||'—'}</button>`;
}
function orderNumberCell(r){
  const value=(r.record || r.data).orderNumber;
  const proposal=r.reference?.suggestion;
  if(!value && !r.editedReferences?.has('orderNumber') && r.reference?.requiresReview && proposal?.kind==='orderNumber'){
    return `<button class="cell marked proposed-order" data-id="${r.id}" title="Check this suggested order number against the photo">${escape(proposal.value)}<small>Suggested · check</small></button>`;
  }
  return cell(r,'orderNumber',value,'Edit order number');
}
function receiptStatus(r){
  if(r.duplicateOf)return badge('Duplicate of #'+r.duplicateOf,'muted');
  const flags=r.review.flags.filter(f=>f.severity!=='info').map(f=>f.message);
  const photo=r.review.photo.filter(p=>p.status==='Needs review').map(p=>p.reason);
  const orders=(r.orders||[]).filter(orderNeedsReview).map(o=>o.reason||o.status);
  const verification=(r.verification || []).filter(hasVerificationMismatch).map(v=>v.reason);
  const messages=[...new Set([...flags,...photo,...orders,...verification].filter(Boolean))];
  if(messages.length){
    const reason=messages.join(' ');
    return `<button class="status warn review-reason" data-id="${r.id}" title="${escape(reason)}" aria-label="${escape('Needs review. '+reason)}">Needs review</button>`;
  }
  if(r.orders?.length && r.orders.every(o=>o.status==='Matched'))return badge('Order matched');
  return '';
}
function productCodeCell(r,item,path) {
  if (String(item.itemId??'').trim()) return cell(r,path+'itemId',item.itemId,'Edit item ID');
  if (String(item.sku??'').trim()) return cell(r,path+'sku','SKU '+item.sku,'Only the style/SKU is recorded. Edit the style/SKU.');
  return cell(r,path+'itemId','No code','No item ID or style/SKU recorded. Enter an item ID.','no-product-code');
}
const amountFormat=new Intl.NumberFormat('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
function itemRow(r,item,i,shared=''){
  const field='items.'+i+'.';
  const price=item.amount==null ? '' : [r.data.currency,amountFormat.format(item.amount)].filter(Boolean).join(' ');
  const check=r.verification?.[i];
  const reviewClass=check && hasVerificationMismatch(check) ? (kindForVerification(check)==='reading'?'reading-error':'lookup-uncertainty') : '';
  const status=check ? `<button class="line-verification ${hasVerificationMismatch(check)?'line-warning':''} ${reviewClass}" data-id="${r.id}" data-path="verification.${i}" title="${escape(check.reason)}" aria-label="${escape('Line '+(i+1)+' verification: '+check.status)}">${escape(check.status)}</button>` : '';
  return `<tr>${shared}<td>${cell(r,field+'brand',item.brand,'Edit brand')}</td><td class="item-id">${productCodeCell(r,item,field)}</td><td>${cell(r,field+'item',item.item,'Edit item')}${status}</td><td class="money">${cell(r,field+'amount',price,'Line amount including quantity')}</td></tr>`;
}
function rowHTML(r){
  const preview=r.url ? `<img src="${escape(r.url)}" alt="" width="48" height="60" loading="lazy" decoding="async">` : '';
  const label=`Open receipt ${r.id}`;
  const open=`<button class="receipt-no" data-id="${r.id}" aria-label="${label}" title="${label}${preview?' with its original photo':''}">${preview}<span>#${r.id}</span></button>`;
  if(r.state!=='done'){
    const status=r.exactOf?`Same file as #${r.exactOf}`:r.state==='error'?'Could not read photo':r.state==='second'?'Second reading…':r.state==='checking'?'Checking photo…':r.state==='queued'?'Waiting…':'Reading…';
    return `<tbody><tr><th scope="rowgroup">${open}</th><td colspan="7">${badge(status,r.state==='error'?'bad':'muted')} ${escape(r.filename)}</td></tr></tbody>`;
  }
  const d=r.data,items=d.items.length?d.items:[blankItem()];
  const visible=[];
  items.forEach((item,index)=>{
    if(filter==='review' && !reviewForLine(r,index).messages.length && !hasVerificationMismatch(r.verification?.[index]))return;
    if(filter==='verification' && r.verification?.[index]?.status!=='Verification error')return;
    if(filter==='photo' && r.review.photo[index]?.status!=='Needs review')return;
    visible.push({item,index});
  });
  if(!visible.length)return '';
  const span=`rowspan="${visible.length}"`;
  const date=cell(r,'date',purchaseDateText(d),d.dateIssue||d.date||'Enter purchase date');
  const time=d.time?cell(r,'time',d.time,'Purchase time','purchase-time'):'';
  const shared=`<th scope="rowgroup" ${span}><div class="receipt-controls">${open}${receiptStatus(r)}</div></th>
    <td ${span} class="purchase-date">${date}${time}</td><td ${span}>${cell(r,'merchant',d.merchantDisplay||d.merchant,'Edit shop')}</td>
    <td ${span} class="order-number"><span class="mobile-order-label" aria-hidden="true">Order number</span>${orderNumberCell(r)}</td>`;
  if(!d.items.length)return `<tbody aria-label="Receipt ${r.id}"><tr>${shared}<td colspan="4" class="no-items">No items read</td></tr></tbody>`;
  return `<tbody aria-label="Receipt ${r.id}">${visible.map(({item,index},position)=>itemRow(r,item,index,position===0?shared:'')).join('')}</tbody>`;
}
let loadingSamples=false;
function render(){
  const has=batch.length>0;$('#landing').hidden=has;$('#workspace').hidden=!has;
  $('#landing-orders').textContent=orderList?'Order list · '+orderFilename:'Compare order list';
  $('#landing-clear-orders').hidden=!orderList;
  if(!has)return;
  const sets=new Set(batch.map(r=>r.demo?.set).filter(Boolean));
  const more=$('#more-samples');
  more.hidden=!sets.size || (sets.has('featured') && sets.has('photos'));
  if(!more.hidden){
    more.dataset.next=sets.has('photos')?'featured':'photos';
    more.textContent=sets.has('photos')?'Add remaining demo photos':'Add photos from the 25-photo collection';
    more.disabled=loadingSamples;
  }
  $('#verify-import-photos').hidden=!batch.some(r=>r.origin==='achung' || r.origin==='workbook');
  $('#verify-import-photos').disabled=verifyingPhotos;
  const done=active(), work=batch.some(notDone)||verifyingPhotos,nRows=done.reduce((n,r)=>n+Math.max(1,r.data.items.length),0);
  const readingCount=done.filter(r=>receiptReviewKinds(r).has(reviewKinds.reading)).length;
  const lookupCount=done.filter(r=>receiptReviewKinds(r).has(reviewKinds.lookup)).length;
  const pendingLookup=done.filter(r=>!r.lookupReady).length;
  const dollars=batch.reduce((n,r)=>n+Number(r.firstData?.cost||0)+(r.previous?Number(r.data?.cost||0):0),0);
  const checkedDemo=batch.every(r=>r.demo?.set==='featured' && r.useSaved) ? '<span>Checked demo readings</span>' : '';
  const timing=work?'<span>Processing…</span>':startTime?`<span>${((Math.max(finishedTime||Date.now(),startTime)-startTime)/1000).toFixed(1)} s</span>`:'';
  $('#summary').innerHTML=`<span><b>${batch.length}</b> receipt${batch.length===1?'':'s'}</span><span><b>${nRows}</b> export row${nRows===1?'':'s'}</span><span><b>${batch.filter(isReview).length}</b> to review</span><span class="review-count reading-error"><b>${readingCount}</b> reading error${readingCount===1?'':'s'}</span><span class="review-count lookup-uncertainty"><b>${lookupCount}</b> lookup uncertaint${lookupCount===1?'y':'ies'}</span>${pendingLookup?`<span class="lookup-uncertainty">Lookup pending · refresh corrected Excel</span>`:''}${checkedDemo}${timing}${dollars?`<span>Est. model cost $${dollars.toFixed(4)}</span>`:''}${orderList?`<span>Order list · ${escape(orderFilename)}</span>`:''}`;
  $('#filters').innerHTML=Object.entries(filterTitles).map(([k,t])=>`<button data-filter="${k}" aria-pressed="${filter===k}">${t} <span class="num">${batch.filter(r=>filt(r,k)).length}</span></button>`).join('');
  const q=$('#search').value.trim().toLowerCase(), shown=batch.filter(r=>filt(r,filter)&&(!q||textOf(r).includes(q))).sort(oldestPurchaseFirst);
  const headers=['Receipt','Purchase date','Shop','Order number','Brand','Item ID','Item','Price'].map(title=>
    title==='Purchase date' ? '<th scope="col" aria-sort="ascending" title="Oldest purchase first">Purchase date <span aria-hidden="true">↑</span></th>' : `<th scope="col">${title}</th>`);
  $('#table').innerHTML=shown.length?`<table class="receipt-lines" aria-label="Receipt line items"><thead><tr>${headers.join('')}</tr></thead>${shown.map(rowHTML).join('')}</table>`:'<p class="empty">No receipts match this view.</p>';
  $('#refresh-excel').disabled=$('#excel').disabled=$('#excel-china').disabled=$('#csv').disabled=!done.length||work;
  $('#startover').disabled=work;$('#clear-orders').hidden=!orderList;
}
function resolveImportFlags(r, resolved){
  if(r.origin!=='achung' || !resolved.length)return;
  for(const f of resolved){
    const line=/^items\.(\d+)\./.exec(f.field);
    if(line)r.sourceNotes[Number(line[1])]=undefined;
    else r.sourceNotes.fill(undefined);
  }
  r.nativeFlags=r.nativeFlags.filter(f=>!resolved.includes(f));
}
function removeReceiptLine(r,i){
  if(!Number.isInteger(i)||!r.data?.items[i])return;
  r.data.items.splice(i,1);
  r.priorLineChecks?.splice(i,1);
  if(r.origin==='achung')r.sourceNotes.splice(i,1);
  for(const key of ['readingConflicts','nativeFlags']){
    if(!r[key])continue;
    r[key]=r[key].flatMap(f=>{
      if(f.field==='items')return [];
      const match=/^items\.(\d+)\.(.+)$/.exec(f.field);
      if(!match || Number(match[1])<i)return [f];
      if(Number(match[1])===i)return [];
      return [{...f,field:`items.${Number(match[1])-1}.${match[2]}`}];
    });
  }
}
function updateReceiptFields(r,data,removeIndex=null){
  if(r.origin==='achung'){
    resolveImportFlags(r,r.nativeFlags.filter(f=>{
      const after=get(data,f.field);
      return after!=null && String(after).trim()!=='' && after!==get(r.record,f.field);
    }));
  }
  if(data.date!==r.record.date)delete data.dateIssue;
  r.readingConflicts=(r.readingConflicts||[]).filter(f=>JSON.stringify(get(data,f.field))===JSON.stringify(get(r.record,f.field)));
  if(data.merchant!==r.data.merchant || (r.confirmedReference && data[r.confirmedReference.kind]!==r.record[r.confirmedReference.kind]))r.confirmedReference=null;
  for(const key of Object.keys(referenceLabels)){
    if(data[key]===r.record[key])data[key]=r.data[key];
    else (r.editedReferences??=new Set()).add(key);
  }
  const previousData=r.data;
  r.data=normalData(data);removeReceiptLine(r,removeIndex);r.ack.clear();r.manualClears??=new Set();
  for(const key of ['merchant','date','time','orderNumber','orderId','receiptReference','payment','card'])
    if(data[key]!==previousData?.[key])r.manualClears.delete(key);
  (data.items||[]).forEach((item,index)=>{
    const before=previousData?.items?.[index]||{};
    for(const key of ['brand','itemId','item','sku','colour','size','qty','unitPrice','amount'])
      if(item[key]!==before[key])r.manualClears.delete(`items.${index}.${key}`);
  });
  r.lookupReady=true;evaluate(r);
}
async function openDetail(id,path=''){
  const r=batch.find(x=>x.id===Number(id));if(!r)return;
  const {showDetail}=await import('./detail.js?v=curatedphotos1');
  const refresh=()=>{duplicates();render();};
  const rerender=(focus='')=>{refresh();openDetail(r.id,focus).catch(e=>note(e.message));};
  showDetail({...r,data:r.record||r.data},{
    onSave(data,removeIndex=null){
      updateReceiptFields(r,data,removeIndex);refresh();note('Changes saved. Checks updated.');
    },
    onConfirmReference(candidate,kind){
      if(!Object.hasOwn(referenceLabels,kind) || !r.reference.requiresReview)return;
      const listed=r.reference.candidates.find(c=>c.value===candidate.value && c.kind===candidate.kind);
      if(!listed)return;
      r.confirmedReference={candidate:listed,kind,values:r.reference.candidates.map(c=>c.value)};
      evaluate(r);rerender();note('Reference confirmed.');
    },
    onAcknowledge(f){if(f.severity==='check'&&!f.field.endsWith('.photo')){
      if(r.origin==='achung')resolveImportFlags(r,[f]);
      else r.ack.add(f.field+'|'+f.message);
    }evaluate(r);rerender();},
    onKeepBoth(){if(!r.exactOf)r.keepBoth=true;rerender();},
    onRemove(){if(r.exactOf||r.duplicateOf){batch=batch.filter(x=>x!==r);URL.revokeObjectURL(r.url);if(hashOwners.get(r.hash)===r.id)hashOwners.set(r.hash,r.duplicateOf);for(const other of batch)if(other.exactOf===r.id)other.exactOf=r.duplicateOf;if($('#receipt-dialog').open)$('#receipt-dialog').close();refresh();}},
    onRetry(){if(r.state!=='error')return;r.notes=[];r.state='queued';r.readerSettings={mode,key:apiKey};finishedTime=0;queue.push(r);$('#receipt-dialog').close();pump();},
    onRemoveLine(i){
      removeReceiptLine(r,i);
      r.ack.clear();evaluate(r);rerender();
    },
    onAddLine(){r.data.items.push(blankItem());evaluate(r);rerender(`items.${r.data.items.length-1}.item`);},
    onOpenOriginal(){if(r.duplicateOf)openDetail(r.duplicateOf);}
  },path);
}
function fileSelection(files){const input=[...files], valid=input.filter(f=>f.type.startsWith('image/')||/\.(?:jpe?g|png|webp|avif|heic|heif|bmp|tiff?)$/i.test(f.name));if(valid.length<input.length)note('Only receipt images can be read.');startInput(valid.map(file=>({file})));}
for(const button of document.querySelectorAll('[data-action="upload"]'))button.onclick=()=>$('#file-input').click();
$('#file-input').onchange=e=>{fileSelection(e.target.files);e.target.value='';};
let dragDepth=0;const isFileDrag=e=>[...e.dataTransfer.types].includes('Files');
document.addEventListener('dragenter',e=>{if(isFileDrag(e)){e.preventDefault();dragDepth++;document.body.classList.add('dragging');}});
document.addEventListener('dragleave',e=>{if(isFileDrag(e)&&--dragDepth<=0){dragDepth=0;document.body.classList.remove('dragging');}});
document.addEventListener('dragover',e=>{if(isFileDrag(e))e.preventDefault();});
document.addEventListener('drop',e=>{if(isFileDrag(e)){e.preventDefault();dragDepth=0;document.body.classList.remove('dragging');if(!document.querySelector('dialog[open]'))fileSelection(e.dataTransfer.files);}});
async function addSampleSet(set, useSaved=savedSamples) {
  if(loadingSamples || batch.some(r=>r.demo?.set===set))return;
  loadingSamples=true;
  const controls=document.querySelectorAll('[data-sample-set],#more-samples');
  for(const button of controls)button.disabled=true;
  try {
    const existing=new Set(batch.filter(r=>r.demo).map(r=>r.filename));
    startInput(await loadSamples(set,existing),useSaved);
  }
  catch(error) { note(error.message); }
  finally { loadingSamples=false;for(const button of controls)button.disabled=false;render(); }
}
for(const button of document.querySelectorAll('[data-sample-set]'))
  button.onclick=()=>addSampleSet(button.dataset.sampleSet);
$('#more-samples').onclick=e=>addSampleSet(e.currentTarget.dataset.next);
$('#filters').onclick=e=>{const b=e.target.closest('[data-filter]');if(b){filter=b.dataset.filter;render();}};
$('#search').oninput=render;
$('#history').onclick=openHistory;$('#landing-history').onclick=openHistory;$('#history-clear').onclick=()=>{clearHistory();renderHistory();};$('#history-refresh').onclick=()=>{const dialog=$('#history-dialog');if(dialog?.open)dialog.close();$('#refresh-excel')?.click();};
$('#table').onclick=e=>{const b=e.target.closest('[data-id]');if(b)openDetail(b.dataset.id,b.dataset.path).catch(err=>note(err.message));};
async function downloadBatch(exporter) {
  const current=generation;
  try {
    const receipts=active();
    const blob=await exporter(receipts);
    const hash=await fingerprint(blob);
    if(current===generation) {
      receiptFileHashes.add(hash);
      recordExport(receipts,exporter===exportChinaExcel?'china':exporter===exportExcel?'detailed':'csv');
      renderHistory();
    }
  } catch(e) { note('Export failed. '+e.message); }
}
$('#excel').onclick=()=>downloadBatch(exportExcel);
$('#excel-china').onclick=()=>downloadBatch(exportChinaExcel);
$('#csv').onclick=()=>downloadBatch(exportCSV);
async function prepareExcelRefresh(file){
  const currentGeneration=generation;
  const [workbook,hash]=await Promise.all([readTillrollEdits(file),fingerprint(file)]);
  if(currentGeneration!==generation)throw new Error('The batch changed. Choose the workbook again.');
  const previousLegacy=workbook.exportKey ? null : legacyBaselines.get(file.name);
  const parsed=previousLegacy ? withLegacyWorkbookBaseline(workbook,previousLegacy) : workbook;
  const previous=excelBaselines.get(parsed.exportKey);
  if(previous){
    for(const row of parsed.rows)row.baseline=previous.get(row.lineKey) || row.baseline;
  }
  const prepared={filename:file.name,hash,parsed,currentGeneration};
  if(!batch.length){
    prepared.records=restoreWorkbookReceipts(parsed);
  }else{
    prepared.patches=planWorkbookRefresh(batch,parsed);
    if(!parsed.exportKey && !previousLegacy && prepared.patches.length){
      const count=prepared.patches.length;
      prepared.confirmation=`This older workbook matches ${count} receipt${count===1?'':'s'} with changes. Applying it can replace values you edited in this tab.`;
    }
  }
  return prepared;
}

function finishExcelRefresh({filename,hash,parsed,currentGeneration,records,patches}){
  if(currentGeneration!==generation || (records && batch.length))throw new Error('The batch changed. Choose the workbook again.');
  const nextBaseline=parsed.exportKey ? nextWorkbookBaseline(parsed) : null;
  let nextLegacy=null;
  const previousOrders=orderList, clearReference=referenceHash===hash;
  if(clearReference)orderList=null;
  const drafts=new Map();
  const refreshLookupChanges=new Map();
  let restored=[];
  try{
    if(records){
      const group=Symbol();
      restored=records.map((entry,i)=>{
        const r={...entry,id:seq+i+1,data:normalData(entry.data),origin:'workbook',state:'done',lookupReady:true,manualClears:new Set(entry.manualClears||[]),
          method:'Tillroll Excel',workbookName:filename,importGroup:group,editedReferences:new Set(Object.keys(referenceLabels)),
          ack:new Set(),notes:[],reasons:[]};
        evaluate(r);finalizeOutput(r);return r;
      });
      if(!parsed.exportKey)nextLegacy=nextLegacyWorkbookBaseline(parsed,restored,[]);
    }else{
      if(!parsed.exportKey)nextLegacy=nextLegacyWorkbookBaseline(parsed,batch,patches);
      for(const {receipt:r,receiptChanges,itemChanges,clearedFields=[]} of patches){
        const data=structuredClone(r.record || r.data);
        Object.assign(data,receiptChanges);
        for(const {index,fields} of itemChanges)Object.assign(data.items[index],fields);
        const beforeLookup=JSON.stringify((r.verification||[]).map(line=>({status:line.status,reason:line.reason,source:line.source})));
        const draft={...r,ack:new Set(r.ack),manualClears:new Set(r.manualClears||[]),editedReferences:new Set(r.editedReferences),sourceNotes:r.sourceNotes?.slice()};
        updateReceiptFields(draft,data);
        for(const field of clearedFields)draft.manualClears.add(field);
        evaluate(draft);
        const afterLookup=JSON.stringify((draft.verification||[]).map(line=>({status:line.status,reason:line.reason,source:line.source})));
        refreshLookupChanges.set(r,beforeLookup!==afterLookup);
        drafts.set(r,draft);
      }
      if(clearReference){
        for(const r of batch)if(r.data && !drafts.has(r)){
          const draft={...r};evaluate(draft);drafts.set(r,draft);
        }
      }
    }
  }catch(err){orderList=previousOrders;throw err;}
  if(clearReference){referenceHash=null;orderFilename='';referenceRevision++;}
  for(const [target,draft] of drafts)Object.assign(target,draft);
  if(records){batch=restored;seq+=restored.length;filter='all';$('#search').value='';}
  if(nextBaseline)excelBaselines.set(parsed.exportKey,nextBaseline);
  if(nextLegacy)legacyBaselines.set(filename,nextLegacy);
  receiptFileHashes.add(hash);duplicates();render();
  const n=records ? restored.length : patches.length;
  if(records) restored.forEach(receipt=>recordRefresh({receipt,changedFields:[],clearedFields:receipt.manualClears||[],lookupChanged:(receipt.verification||[]).some(hasVerificationMismatch)}));
  else patches.forEach(({receipt,receiptChanges,itemChanges,clearedFields=[]})=>{
    const changedFields=[...Object.keys(receiptChanges),...itemChanges.flatMap(({index,fields})=>Object.keys(fields).map(key=>`items.${index}.${key}`))];
    const updated=drafts.get(receipt)||receipt;
    recordRefresh({receipt:updated,changedFields,clearedFields,lookupChanged:refreshLookupChanges.get(receipt)??false});
  });
  renderHistory();
  const message=records ? `Opened ${n} receipt${n===1?'':'s'} from Excel.`
    : n ? `Updated ${n} receipt${n===1?'':'s'} from Excel. Checks refreshed.` : 'Already up to date.';
  note(message+(clearReference?' Select a separate file to compare orders.':''));
}
const unlinkWorkbook=bindExcelRefresh({
  hasBatch:()=>batch.length>0,prepare:prepareExcelRefresh,finish:finishExcelRefresh,
  onLinkChange(handle){$('#change-refresh').hidden=!handle;
    $('#refresh-excel').title=handle?'Read the latest saved changes from '+handle.name:'Update this batch from a saved Tillroll workbook';}
});
let importingWorkbook=false;
let verifyingPhotos=false;
$('#verify-import-photos').onclick=()=>$('#import-photos-input').click();
$('#import-photos-input').onchange=async e=>{
  const files=Array.from(e.target.files);
  e.target.value='';
  if (!files.length || verifyingPhotos) return;
  const key=name=>name.split(/[\\/]/).at(-1).normalize('NFC').toLowerCase();
  const counts=new Map();
  for (const file of files) counts.set(key(file.name),(counts.get(key(file.name)) || 0)+1);
  verifyingPhotos=true;
  render();
  let attached=0, unmatched=0, failed=0, recovered=0, review=0, invalid=0;
  try {
    for (const file of files) {
      const targets=batch.filter(r=>(r.origin==='achung' || r.origin==='workbook') && key(r.filename)===key(file.name));
      if (targets.length!==1 || counts.get(key(file.name))!==1) { unmatched++; continue; }
      const r=targets[0];
      const url=URL.createObjectURL(file);
      const image=new Image();
      image.src=url;
      try { await image.decode(); }
      catch { URL.revokeObjectURL(url); invalid++; continue; }
      if (!batch.includes(r)) { URL.revokeObjectURL(url); continue; }
      const previous=r.url;
      r.url=url;
      r.itemIdReadings=[];
      evaluate(r);
      render();
      if (previous) URL.revokeObjectURL(previous);
      attached++;
      const passes=await Promise.allSettled([readPhoto(file),secondReadPhoto(file)]);
      if (!batch.includes(r)) continue;
      r.itemIdReadings=passes.filter(p=>p.status==='fulfilled' && p.value.text?.trim()).map(p=>p.value);
      if (!r.itemIdReadings.length) { failed++; continue; }
      const missingBefore=r.data.items.filter(item=>!item.itemId).length;
      evaluate(r,true);
      recovered+=missingBefore-r.data.items.filter(item=>!item.itemId).length;
      review+=r.review.photo.filter(line=>line.status==='Needs review').length;
    }
  } catch (err) { note('Could not check the original photos. '+err.message); return; }
  finally { verifyingPhotos=false; duplicates(); render(); }
  const summary=[attached+' original photo'+(attached===1?'':'s')+' attached.'];
  if (recovered) summary.push(recovered+' item ID'+(recovered===1?'':'s')+' added.');
  if (review) summary.push(review+' item ID'+(review===1?' needs':'s need')+' review.');
  if (unmatched) summary.push(unmatched+' could not be linked. Use one original photo with the workbook filename for each receipt.');
  if (failed) summary.push('No readable text in '+failed+' attached photo'+(failed===1?'':'s')+'.');
  if (invalid) summary.push(invalid+' image'+(invalid===1?' could':'s could')+' not be opened. Try a JPEG or PNG.');
  note(summary.join(' '));
};
const achungDialog=$('#achung-dialog');
for(const button of document.querySelectorAll('[data-action="achung"]')){
  button.onclick=()=>{$('#achung-error').textContent='';achungDialog.showModal();};
}
$('#pick-achung').onclick=()=>$('#achung-input').click();
$('#achung-input').onchange=async e=>{
  const file=e.target.files[0],currentGeneration=generation;
  e.target.value='';
  if(!file || importingWorkbook)return;
  $('#achung-error').textContent='';
  importingWorkbook=true;
  $('#pick-achung').disabled=true;
  try{
    const [records,hash]=await Promise.all([readAchungWorkbook(file),fingerprint(file)]);
    if(generation!==currentGeneration || !achungDialog.open)return;
    const existing=new Set(batch.map(r=>r.filename));
    const collision=records.find(record=>existing.has(record.filename));
    if(collision)throw new Error(collision.filename+' is already in this batch. Start a new batch to import this workbook separately.');
    receiptFileHashes.add(hash);
    const removedSelfReference=hash===referenceHash;
    if(removedSelfReference) {
      referenceRevision++; orderList=null; orderFilename=''; referenceHash=null;
      batch.forEach(r=>evaluate(r));
    }
    const group=Symbol();
    const imported=records.map(entry=>{
      const r={id:++seq,filename:entry.filename,workbookName:file.name,importGroup:group,
        data:normalData(entry.data),nativeFlags:entry.flags,sourceNotes:entry.sourceNotes,
        state:'done',origin:'achung',method:'Achung Excel',lookupReady:true,ack:new Set(),notes:[],reasons:[]};
      evaluate(r);finalizeOutput(r);
      return r;
    });
    batch=batch.concat(imported);filter='all';$('#search').value='';duplicates();render();
    achungDialog.close();note(`Imported ${imported.length} receipts from Achung.`+(removedSelfReference?' Select a separate file to verify this workbook.':''));
  }catch(err){$('#achung-error').textContent=err.message || 'The workbook could not be imported.';}
  finally{importingWorkbook=false;$('#pick-achung').disabled=false;}
};
$('#landing-orders').onclick=$('#orders').onclick=()=>{$('#order-error').textContent='';$('#orders-dialog').showModal();};
$('#pick-orders').onclick=()=>$('#orders-input').click();
$('#orders-input').onchange=async e=>{
  const file=e.target.files[0];
  e.target.value='';
  if (!file) return;
  const revision=++referenceRevision, current=generation;
  try {
    const hash=await fingerprint(file);
    if (receiptFileHashes.has(hash)) throw new Error('This file contains this batch’s own receipts. Choose a separate order or product list.');
    const rows=await readOrderFile(file);
    if (revision!==referenceRevision || current!==generation) return;
    if (receiptFileHashes.has(hash)) throw new Error('Choose an independent order or product list for this batch.');
    referenceHash=hash;orderFilename=file.name;orderList=rows;
    batch.forEach(r=>{r.lookupReady=true;});
    batch.forEach(r=>evaluate(r));duplicates();render();$('#orders-dialog').close();
    note(`${rows.length} reference lines loaded. Item verification updated.`);
  } catch(err) { if (revision===referenceRevision) $('#order-error').textContent=err.message; }
};
$('#landing-clear-orders').onclick=$('#clear-orders').onclick=()=>{
  referenceRevision++;referenceHash=null;orderList=null;orderFilename='';
  batch.forEach(r=>evaluate(r));duplicates();render();
};
$('#startover').onclick=()=>$('#reset-dialog').showModal();$('#reset').onclick=()=>{generation++;unlinkWorkbook();excelBaselines.clear();legacyBaselines.clear();for(const r of batch)URL.revokeObjectURL(r.url);batch=[];queue.length=0;hashOwners.clear();receiptFileHashes.clear();referenceHash=null;referenceRevision++;seq=0;orderList=null;orderFilename='';startTime=finishedTime=0;$('#search').value='';$('#reset-dialog').close();render();};
const refreshSettings=()=>{const ai=$('#reader').value==='server';$('#key-box').hidden=true;$('#key').required=false;$('#local-explain').hidden=ai;};
$('#settings').onclick=()=>{$('#reader').value=mode;$('#key').value=apiKey;$('#sample-reading').value=savedSamples?'saved':'live';refreshSettings();$('#settings-dialog').showModal();};$('#reader').onchange=refreshSettings;
$('#settings-form').onsubmit=e=>{e.preventDefault();const selected=$('#reader').value;mode=selected;apiKey=selected==='server'?'__server__':'';savedSamples=$('#sample-reading').value==='saved';$('#key').value='';$('#settings-dialog').close();note('Reading settings saved.');};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>document.getElementById(b.dataset.close).close();
for(const d of document.querySelectorAll('dialog'))d.addEventListener('click',e=>{if(e.target===d){const b=d.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)d.close();}});

const example=new URLSearchParams(location.search).get('examples');
if(example==='fictional')addSampleSet('demo');
if(example==='checked')addSampleSet('featured',true);
