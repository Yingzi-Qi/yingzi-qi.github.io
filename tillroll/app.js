import {oldestPurchaseFirst,purchaseDateText} from './receipt-date-display.js?v=8';
import {inspectReference,combineReferenceReadings} from './reference.js?v=6';
import {readPhoto,secondReadPhoto,extractLocal,extractAI,reconcileReadings,photoFieldConflicts,recoverPhotoItemIds} from './extract.js?v=productcodes3';
import {checkReceipt,samePurchase,reviewForLine,verifyImportedItemIds} from './checks.js?v=productcodes3';
import {exportExcel,exportCSV,readOrderFile,readAchungWorkbook} from './exports.js?v=productcodes3';
import {loadSamples} from './samples.js?v=productcodes3';
import {compareOrder,orderNeedsReview} from './orders.js?v=lineverify1';
import {verifyOutputItems} from './item-verification.js?v=lineverify1';
import {photoVerificationRows} from './verification-photo.js?v=productcodes3';
import {captureLineWarnings,classifyVerification,hasVerificationMismatch} from './verification-history.js?v=lineverify1';
const $ = s=>document.querySelector(s);
const escape = v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={settings:'<path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',upload:'<path d="M12 15V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',plus:'<path d="M12 5v14M5 12h14"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',link:'<path d="m10 14 4-4m-4-3 2-2a5 5 0 0 1 7 7l-2 2m-3 3-2 2a5 5 0 0 1-7-7l2-2"/>',play:'<path d="m8 5 10 7-10 7z"/>'};
for(const el of document.querySelectorAll('[data-icon]')) el.innerHTML=`<svg aria-hidden="true" class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[el.dataset.icon]}</svg>`;
let batch=[],orderList=null,orderFilename='',filter='all',seq=0,generation=0,nowReading=0;
let mode='local',apiKey='',savedSamples=false,noticeTimer,startTime=0,finishedTime=0;
const queue=[], hashOwners=new Map();
const receiptFileHashes=new Set();
let referenceHash=null,referenceRevision=0;
const emptyOCR=()=>({text:'',confidence:0,lines:[]});
const blankItem=()=>({brand:'',item:'',sku:'',itemId:'',colour:'',size:'',qty:null,unitPrice:null,amount:null});
const referenceLabels={orderId:'Order ID',orderNumber:'Order number',receiptReference:'Receipt reference'};
const sameReference=(a,b)=>String(a??'').trim().toLowerCase()===String(b??'').trim().toLowerCase();
const get=(obj,key)=>key.split('.').reduce((v,k)=>v?.[k],obj);
function set(obj,key,value){const keys=key.split('.'); const end=keys.pop(); let cur=obj;for(const k of keys)cur=cur[k];cur[end]=value;}
const normalData=data=>({...data,items:Array.isArray(data?.items)?data.items.map(x=>({...blankItem(),...x})):[]});
const confidenceOptions = r=>({independentPhoto:r.origin==='ai'||r.origin==='sample'});
const active = ()=>batch.filter(r=>r.state==='done' && !r.duplicateOf).sort(oldestPurchaseFirst);
const notDone = r=>['queued','reading','checking','second'].includes(r.state);
const isReview = r=>r.state==='error' || (!r.duplicateOf && r.data && (r.review.flags.some(x=>x.severity!=='info') || r.review.photo.some(x=>x.status==='Needs review') || r.orders?.some(orderNeedsReview) || r.verification?.some(hasVerificationMismatch)));
function note(message){const n=$('#notice');clearTimeout(noticeTimer);n.hidden=!message;n.textContent=message;if(message)noticeTimer=setTimeout(()=>{n.hidden=true;},6500);}
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
  let readings=r.itemIdReadings || [r.ocr,r.otherOcr].filter(Boolean);
  const local=r.origin==='local';
  if (local && readings.length<2) readings=[];
  if (!r.photoWitnessCache || r.photoWitnessCache.readings.length!==readings.length ||
      readings.some((ocr,i)=>r.photoWitnessCache.readings[i]!==ocr)) {
    r.photoWitnessCache={readings,rows:photoVerificationRows(readings,{requireAgreement:local})};
  }
  const results=verifyOutputItems(r.record,orderList,r.photoWitnessCache.rows);
  r.verification=results.map((result,i)=>{
    const line=classifyVerification(result,r.priorLineChecks[i]);
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
    r.orders=comparePurchase(r.record);
    return;
  }
  const ocr=r.ocr||emptyOCR();
  r.reference=inspectReference(r.data,ocr,orderList);
  if(r.otherOcr)r.reference=combineReferenceReadings(r.reference,inspectReference(r.data,r.otherOcr,orderList));
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
  const extra=[...(r.readingConflicts||[])];
  if(r.origin==='ai' && ocr.text) {
    for(const issue of photoFieldConflicts(r.record,ocr)) extra.push({...issue,stage:'Model compared with photo OCR'});
  }
  if(r.verifyIssue)extra.push({field:'verification',message:r.verifyIssue,severity:'check',escalate:false});
  for(const issue of extra){
    if(choice && issue.field===choice.kind)continue;
    if(!r.review.flags.some(f=>f.field===issue.field && f.message===issue.message))r.review.flags.push(issue);
  }
  r.review.flags=r.review.flags.filter(f=>!r.ack.has(f.field+'|'+f.message));
  if(r.data.items.length && !r.review.photo.length)r.review.photo=r.data.items.map(()=>({status:'Not verified',reason:'No photo evidence available.'}));
  r.orders=comparePurchase(r.record);
}
function duplicates(){
  const canonical=[];
  for(const r of batch){
    if(r.exactOf){r.duplicateOf=r.exactOf;continue;}
    r.duplicateOf=null;if(r.state!=='done')continue;
    // Achung already chose which receipts to include in its workbook.
    const match=canonical.find(s=>!(r.origin==='achung' && s.importGroup===r.importGroup) && samePurchase(s.duplicateRecord,r.duplicateRecord));
    if(match && !r.keepBoth) r.duplicateOf=match.id;
    else canonical.push(r);
  }
}
function startInput(entries){
  if(!entries.length)return;
  if(!startTime)startTime=Date.now();
  else if(finishedTime)startTime+=Date.now()-finishedTime;
  finishedTime=0;
  for(const entry of entries){const file=entry.file;if(!file)continue;
    const r={id:++seq,filename:file.name,file,url:URL.createObjectURL(file),state:'queued',method:'Queued',review:{flags:[],photo:[],repeats:[]},ack:new Set(),notes:[],reasons:[],generation,origin:'',usedAI:false};
    r.demo=entry.sample?entry:null;r.useSaved=Boolean(r.demo && savedSamples);r.readerSettings={mode,key:apiKey};batch.push(r);queue.push(r);
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
      const modelEnabled=chosenMode==='ai'&&!!chosenKey;
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
function badge(label,style='',reason=''){return `<span class="status ${style}" title="${escape(reason)}">${escape(label)}</span>`;}
function cell(r,path,txt,title,extraClass=''){
  const idLine=/^items\.(\d+)\.itemId$/.exec(path);
  const product=/^items\.(\d+)\.(item|brand|amount|itemId)$/.exec(path);
  const mismatch=product && r.verification?.[Number(product[1])]?.fields.some(f=>f.key===product[2] && f.status==='mismatch');
  const warning=mismatch || r.review.flags.some(f=>f.field===path && f.severity!=='info') || (r.itemIdReadings && idLine && r.review.photo[Number(idLine[1])]?.status==='Needs review');
  return `<button class="cell ${extraClass} ${warning?'marked':''}" data-id="${r.id}" data-path="${escape(path)}" title="${escape(title??txt??'Edit')}">${escape(txt??'')||'—'}</button>`;
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
  const status=check ? `<button class="line-verification ${hasVerificationMismatch(check)?'line-warning':''}" data-id="${r.id}" data-path="verification.${i}" title="${escape(check.reason)}" aria-label="${escape('Line '+(i+1)+' verification: '+check.status)}">${escape(check.status)}</button>` : '';
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
    <td ${span} class="purchase-date">${date}${time}</td><td ${span}>${cell(r,'merchant',d.merchant,'Edit shop')}</td>
    <td ${span} class="order-number"><span class="mobile-order-label" aria-hidden="true">Order number</span>${orderNumberCell(r)}</td>`;
  if(!d.items.length)return `<tbody aria-label="Receipt ${r.id}"><tr>${shared}<td colspan="4" class="no-items">No items read</td></tr></tbody>`;
  return `<tbody aria-label="Receipt ${r.id}">${visible.map(({item,index},position)=>itemRow(r,item,index,position===0?shared:'')).join('')}</tbody>`;
}
const sampleLabels={photos:'25 real receipt photos',demo:'25 demo receipts'};
let loadingSamples=false;
function render(){
  const has=batch.length>0;$('#landing').hidden=has;$('#workspace').hidden=!has;
  $('#landing-orders').textContent=orderList?'Order list · '+orderFilename:'Compare order list';
  $('#landing-clear-orders').hidden=!orderList;
  if(!has)return;
  const sets=new Set(batch.map(r=>r.demo?.set).filter(Boolean));
  const more=$('#more-samples');
  more.hidden=sets.size!==1;
  if(!more.hidden){more.dataset.next=sets.has('photos')?'demo':'photos';more.textContent='Add '+sampleLabels[more.dataset.next];more.disabled=loadingSamples;}
  $('#verify-import-photos').hidden=!batch.some(r=>r.origin==='achung');
  $('#verify-import-photos').disabled=verifyingPhotos;
  const done=active(), work=batch.some(notDone)||verifyingPhotos,nRows=done.reduce((n,r)=>n+Math.max(1,r.data.items.length),0);
  const dollars=batch.reduce((n,r)=>n+Number(r.firstData?.cost||0)+(r.previous?Number(r.data?.cost||0):0),0);
  const timing=work?'<span>Processing…</span>':startTime?`<span>${((Math.max(finishedTime||Date.now(),startTime)-startTime)/1000).toFixed(1)} s</span>`:'';
  $('#summary').innerHTML=`<span><b>${batch.length}</b> receipt${batch.length===1?'':'s'}</span><span><b>${nRows}</b> export row${nRows===1?'':'s'}</span><span><b>${batch.filter(isReview).length}</b> to review</span>${timing}${dollars?`<span>Est. model cost $${dollars.toFixed(4)}</span>`:''}${orderList?`<span>Order list · ${escape(orderFilename)}</span>`:''}`;
  $('#filters').innerHTML=Object.entries(filterTitles).map(([k,t])=>`<button data-filter="${k}" aria-pressed="${filter===k}">${t} <span class="num">${batch.filter(r=>filt(r,k)).length}</span></button>`).join('');
  const q=$('#search').value.trim().toLowerCase(), shown=batch.filter(r=>filt(r,filter)&&(!q||textOf(r).includes(q))).sort(oldestPurchaseFirst);
  const headers=['Receipt','Purchase date','Shop','Order number','Brand','Item ID','Item','Price'].map(title=>
    title==='Purchase date' ? '<th scope="col" aria-sort="ascending" title="Oldest purchase first">Purchase date <span aria-hidden="true">↑</span></th>' : `<th scope="col">${title}</th>`);
  $('#table').innerHTML=shown.length?`<table class="receipt-lines" aria-label="Receipt line items"><thead><tr>${headers.join('')}</tr></thead>${shown.map(rowHTML).join('')}</table>`:'<p class="empty">No receipts match this view.</p>';
  $('#excel').disabled=$('#csv').disabled=!done.length||work;$('#startover').disabled=work;$('#clear-orders').hidden=!orderList;
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
async function openDetail(id,path=''){
  const r=batch.find(x=>x.id===Number(id));if(!r)return;
  const {showDetail}=await import('./detail.js?v=productcodes3');
  const refresh=()=>{duplicates();render();};
  const rerender=(focus='')=>{refresh();openDetail(r.id,focus).catch(e=>note(e.message));};
  showDetail({...r,data:r.record||r.data},{
    onSave(data,removeIndex=null){
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
      r.data=normalData(data);removeReceiptLine(r,removeIndex);r.ack.clear();evaluate(r);refresh();note('Changes saved. Checks updated.');
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
async function addSampleSet(set) {
  if(loadingSamples || batch.some(r=>r.demo?.set===set))return;
  loadingSamples=true;
  const controls=document.querySelectorAll('[data-sample-set],#more-samples');
  for(const button of controls)button.disabled=true;
  try { startInput(await loadSamples(set)); }
  catch(error) { note(error.message); }
  finally { loadingSamples=false;for(const button of controls)button.disabled=false;render(); }
}
for(const button of document.querySelectorAll('[data-sample-set]'))
  button.onclick=()=>addSampleSet(button.dataset.sampleSet);
$('#more-samples').onclick=e=>addSampleSet(e.currentTarget.dataset.next);
$('#filters').onclick=e=>{const b=e.target.closest('[data-filter]');if(b){filter=b.dataset.filter;render();}};
$('#search').oninput=render;
$('#table').onclick=e=>{const b=e.target.closest('[data-id]');if(b)openDetail(b.dataset.id,b.dataset.path).catch(err=>note(err.message));};
async function downloadBatch(exporter) {
  const current=generation;
  try {
    const blob=await exporter(active());
    const hash=await fingerprint(blob);
    if(current===generation) receiptFileHashes.add(hash);
  } catch(e) { note('Export failed. '+e.message); }
}
$('#excel').onclick=()=>downloadBatch(exportExcel);
$('#csv').onclick=()=>downloadBatch(exportCSV);
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
      const targets=batch.filter(r=>r.origin==='achung' && key(r.filename)===key(file.name));
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
        state:'done',origin:'achung',method:'Achung Excel',ack:new Set(),notes:[],reasons:[]};
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
    batch.forEach(r=>evaluate(r));duplicates();render();$('#orders-dialog').close();
    note(`${rows.length} reference lines loaded. Item verification updated.`);
  } catch(err) { if (revision===referenceRevision) $('#order-error').textContent=err.message; }
};
$('#landing-clear-orders').onclick=$('#clear-orders').onclick=()=>{
  referenceRevision++;referenceHash=null;orderList=null;orderFilename='';
  batch.forEach(r=>evaluate(r));duplicates();render();
};
$('#startover').onclick=()=>$('#reset-dialog').showModal();$('#reset').onclick=()=>{generation++;for(const r of batch)URL.revokeObjectURL(r.url);batch=[];queue.length=0;hashOwners.clear();receiptFileHashes.clear();referenceHash=null;referenceRevision++;seq=0;orderList=null;orderFilename='';startTime=finishedTime=0;$('#search').value='';$('#reset-dialog').close();render();};
const refreshSettings=()=>{const ai=$('#reader').value==='ai';$('#key-box').hidden=!ai;$('#key').required=ai;$('#local-explain').hidden=ai;};
$('#settings').onclick=()=>{$('#reader').value=mode;$('#key').value=apiKey;$('#sample-reading').value=savedSamples?'saved':'live';refreshSettings();$('#settings-dialog').showModal();};$('#reader').onchange=refreshSettings;
$('#settings-form').onsubmit=e=>{e.preventDefault();const selected=$('#reader').value,key=$('#key').value.trim();if(selected==='ai'&&!key)return;mode=selected;apiKey=selected==='ai'?key:'';savedSamples=$('#sample-reading').value==='saved';$('#key').value='';$('#settings-dialog').close();note('Reading settings saved.');};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>document.getElementById(b.dataset.close).close();
for(const d of document.querySelectorAll('dialog'))d.addEventListener('click',e=>{if(e.target===d){const b=d.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)d.close();}});
