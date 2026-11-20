import {readPhoto,secondReadPhoto,extractLocal,extractAI} from './extract.js';
import {checkReceipt,samePurchase,reviewForLine} from './checks.js?v=3';
import {exportExcel,exportCSV,readOrderFile} from './exports.js?v=3';
import {loadSamples} from './samples.js?v=2';
import {compareOrder} from './orders.js';
const $ = s=>document.querySelector(s);
const escape = v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={settings:'<path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',upload:'<path d="M12 15V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',plus:'<path d="M12 5v14M5 12h14"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',link:'<path d="m10 14 4-4m-4-3 2-2a5 5 0 0 1 7 7l-2 2m-3 3-2 2a5 5 0 0 1-7-7l2-2"/>',play:'<path d="m8 5 10 7-10 7z"/>'};
for(const el of document.querySelectorAll('[data-icon]')) el.innerHTML=`<svg aria-hidden="true" class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[el.dataset.icon]}</svg>`;
let batch=[],orderList=null,orderFilename='',filter='all',seq=0,generation=0,nowReading=0;
let mode='local',apiKey='',noticeTimer,startTime=0,finishedTime=0;
const queue=[], hashOwners=new Map();
const emptyOCR=()=>({text:'',confidence:0,lines:[]});
const blankItem=()=>({brand:'',item:'',sku:'',colour:'',size:'',qty:null,unitPrice:null,amount:null});
const get=(obj,key)=>key.split('.').reduce((v,k)=>v?.[k],obj);
function set(obj,key,value){const keys=key.split('.'); const end=keys.pop(); let cur=obj;for(const k of keys)cur=cur[k];cur[end]=value;}
const normalData=data=>({...data,items:Array.isArray(data?.items)?data.items.map(x=>({...blankItem(),...x})):[]});
const confidenceOptions = r=>({independentPhoto:r.origin==='ai'||r.origin==='sample'});
const active = ()=>batch.filter(r=>r.state==='done' && !r.duplicateOf);
const notDone = r=>['queued','reading','checking','second'].includes(r.state);
const isReview = r=>r.state==='error' || (!r.duplicateOf && r.data && (r.review.flags.some(x=>x.severity!=='info') || r.review.photo.some(x=>x.status==='Needs review') || r.orders?.some(x=>x.status!=='Matched')));
function note(message){const n=$('#notice');clearTimeout(noticeTimer);n.hidden=!message;n.textContent=message;if(message)noticeTimer=setTimeout(()=>{n.hidden=true;},6500);}
function evaluate(r){
  if(!r.data)return;
  r.review=checkReceipt(r.data,r.ocr||emptyOCR(),r.previous||null,confidenceOptions(r));
  r.review.flags=r.review.flags.filter(f=>!r.ack.has(f.field+'|'+f.message));
  if(r.data.items.length && !r.review.photo.length)r.review.photo=r.data.items.map(()=>({status:'Not verified',reason:'No photo evidence available.'}));
  r.orders=orderList?compareOrder(r.data,orderList):null;
}
function duplicates(){
  const canonical=[];
  for(const r of batch){
    if(r.exactOf){r.duplicateOf=r.exactOf;continue;}
    r.duplicateOf=null;if(r.state!=='done')continue;
    const match=canonical.find(s=>samePurchase(s.data,r.data));
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
    r.demo=entry.sample?entry:null;r.readerSettings={mode,key:apiKey};batch.push(r);queue.push(r);
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
    if(r.demo){r.data=normalData(structuredClone(r.demo.data));r.ocr=r.demo.ocr;r.origin='sample';r.method=r.demo.set==='photos'?'Photo sample':'Demo';}
    else{
      const modelEnabled=chosenMode==='ai'&&!!chosenKey;
      const [ocrRead,aiRead]=await Promise.allSettled([readPhoto(r.file),modelEnabled?extractAI(r.file,chosenKey,1,[]):Promise.resolve(null)]);if(!current())return;
      r.ocr=ocrRead.status==='fulfilled'?ocrRead.value:emptyOCR();
      if(ocrRead.status==='rejected')r.notes.push('Local photo reading failed.');
      if(aiRead.status==='fulfilled'&&aiRead.value){r.data=normalData(aiRead.value);r.origin='ai';r.usedAI=true;r.method=r.data.model||'Gemini';}
      else if(r.ocr.text){r.data=normalData(extractLocal(r.ocr));r.origin='local';r.method='Local OCR';if(modelEnabled)r.notes.push('Gemini was unavailable. This result uses on-device OCR.');}
      else throw new Error('No readable extraction. Try a brighter, sharper photo or check the reader settings.');
    }
    r.firstData=structuredClone(r.data);evaluate(r);
    const failures=r.review.flags.filter(f=>f.escalate);const hasPhotoIssues=r.review.photo.some(p=>p.status==='Needs review');
    // Local extraction and verification use separate OCR passes. Model output is
    // already independent of the on-device OCR used to check it.
    if(!r.demo&&(r.origin==='local'||failures.length||hasPhotoIssues)){
      r.second=Boolean(failures.length||hasPhotoIssues);r.state=r.second?'second':'checking';r.reasons=[...new Set(failures.map(f=>f.message))];if(hasPhotoIssues)r.reasons.push('Unresolved printed order ID, brand or item.');render();
      try{
        if(r.usedAI){const better=await extractAI(r.file,chosenKey,2,r.reasons);if(!current())return;r.previous=r.firstData;r.data=normalData(better);r.method=r.data.model||'Gemini second opinion';}
        else {const other=await secondReadPhoto(r.file);if(!current())return;
          r.ocr=other?.text?other:emptyOCR();r.method='On-device OCR';if(!other?.text)r.notes.push('No printed evidence was available from the second reading.');}
      }catch{if(!r.usedAI)r.ocr=emptyOCR();r.notes.push('The second reading failed. Review the first reading.');}
    }
    if(!current())return;evaluate(r);r.state='done';
  }catch(err){if(current()){r.state='error';r.error=String(err?.message||'Could not process this receipt.');}}
  finally{r.elapsed=(performance.now()-begun)/1000;if(current()){duplicates();render();}}
}
const filt = (r,f)=>f==='all'||(f==='review'&&isReview(r))||(f==='photo'&&!r.duplicateOf&&r.review.photo.some(p=>p.status==='Needs review'))||(f==='dupes'&&!!r.duplicateOf)||(f==='second'&&r.second);
const filterTitles={all:'All',review:'Needs review',photo:'Photo flags',dupes:'Duplicates',second:'Second pass'};
const textOf=r=>[r.filename,r.data?.merchant,r.data?.orderNumber,r.data?.orderId,...r.review.photo.map(x=>x.idEvidence),...(r.data?.items||[]).flatMap(i=>[i.brand,i.item,i.sku])].join(' ').toLowerCase();
function badge(label,style='',reason=''){return `<span class="status ${style}" title="${escape(reason)}">${escape(label)}</span>`;}
function photoBadge(photo){if(!photo)return '—';return badge(photo.status,photo.status==='Needs review'?'warn':photo.status==='Not verified'?'muted':'',photo.reason);}
function cell(r,path,txt){const warning=r.review.flags.some(f=>f.field===path&&f.severity!=='info');return `<button class="cell ${warning?'marked':''}" data-id="${r.id}" data-path="${escape(path)}" title="${escape(txt??'Edit')}">${escape(txt??'')||'—'}</button>`;}
function rowHTML(r){
  const first=`<button class="receipt-no" data-id="${r.id}" aria-label="Open receipt ${r.id}">#${r.id}</button>`;
  if(r.state!=='done'){const status=r.exactOf?`Same file as #${r.exactOf}`:r.state==='error'?'Could not read photo':r.state==='second'?'Second reading…':r.state==='checking'?'Checking photo…':r.state==='queued'?'Waiting…':'Reading…';return `<tr><td>${first}</td><td colspan="10">${badge(status,r.state==='error'?'bad':'muted')} &nbsp;${escape(r.filename)}</td></tr>`;}
  const d=r.data, items=d.items.length?d.items:[blankItem()];
  return items.map((it,i)=>{
    const {messages}=reviewForLine(r,i);
    if(filter==='review'&&!messages.length || filter==='photo'&&r.review.photo[i]?.status!=='Needs review')return '';
    const reviewBadge=messages.length
      ? `<button class="status warn review-reason" data-id="${r.id}" title="${escape(messages.join(' '))}" aria-label="${escape('Needs review. '+messages.join(' '))}">Needs review</button>`
      : badge('Checked','','The automated receipt checks raised no issues for this line.');
    const prop=k=>cell(r,`items.${i}.${k}`,it[k]);return `<tr><td>${first}</td><td>${cell(r,'merchant',d.merchant)}</td><td>${cell(r,'orderId',d.orderId)}</td><td>${prop('brand')}</td><td>${prop('item')}</td><td class="qty">${prop('qty')}</td><td class="money">${cell(r,`items.${i}.amount`,it.amount==null?null:Number(it.amount).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2}))}</td><td>${r.duplicateOf?badge('Duplicate of #'+r.duplicateOf,'muted'):photoBadge(r.review.photo[i])}</td><td>${r.orders?badge(r.orders[i]?.status||'Needs review',r.orders[i]?.status==='Matched'?'':'warn'):cell(r,'payment',d.payment)}</td><td>${r.duplicateOf?'—':reviewBadge}</td><td>${escape(r.method)}</td></tr>`;}).join('');
}
const sampleLabels={photos:'25 real receipt photos',demo:'25 demo receipts'};
let loadingSamples=false;
function render(){
  const has=batch.length>0;$('#landing').hidden=has;$('#workspace').hidden=!has;if(!has)return;
  const sets=new Set(batch.map(r=>r.demo?.set).filter(Boolean));
  const more=$('#more-samples');
  more.hidden=sets.size!==1;
  if(!more.hidden){more.dataset.next=sets.has('photos')?'demo':'photos';more.textContent='Add '+sampleLabels[more.dataset.next];more.disabled=loadingSamples;}
  const done=active(), work=batch.some(notDone),nRows=done.reduce((n,r)=>n+Math.max(1,r.data.items.length),0);
  const dollars=batch.reduce((n,r)=>n+Number(r.firstData?.cost||0)+(r.previous?Number(r.data?.cost||0):0),0);
  $('#summary').innerHTML=`<span><b>${batch.length}</b> receipt${batch.length===1?'':'s'}</span><span><b>${nRows}</b> export row${nRows===1?'':'s'}</span><span><b>${batch.filter(isReview).length}</b> to review</span>${work?'<span>Processing…</span>':`<span>${((Math.max(finishedTime||Date.now(),startTime)-startTime)/1000).toFixed(1)} s</span>`}${dollars?`<span>Est. model cost $${dollars.toFixed(4)}</span>`:''}${orderList?`<span>Order list · ${escape(orderFilename)}</span>`:''}`;
  $('#filters').innerHTML=Object.entries(filterTitles).map(([k,t])=>`<button data-filter="${k}" aria-pressed="${filter===k}">${t} <span class="num">${batch.filter(r=>filt(r,k)).length}</span></button>`).join('');
  const q=$('#search').value.trim().toLowerCase(), shown=batch.filter(r=>filt(r,filter)&&(!q||textOf(r).includes(q)));
  $('#table').innerHTML=shown.length?`<table aria-label="Receipt line items"><thead><tr>${['Receipt','Source','Order ID','Brand','Item','Qty','Amount','Photo check',orderList?'Order check':'Payment','Review','Read by'].map(s=>`<th scope="col">${s}</th>`).join('')}</tr></thead><tbody>${shown.map(rowHTML).join('')}</tbody></table>`:'<p class="empty">No receipts match this view.</p>';
  $('#excel').disabled=$('#csv').disabled=!done.length||work;$('#startover').disabled=work;$('#clear-orders').hidden=!orderList;
}
async function openDetail(id,path=''){
  const r=batch.find(x=>x.id===Number(id));if(!r)return;
  const {showDetail}=await import('./detail.js?v=3');
  const refresh=()=>{duplicates();render();};
  const rerender=(focus='')=>{refresh();openDetail(r.id,focus).catch(e=>note(e.message));};
  showDetail(r,{
    onSave(data){r.data=normalData(data);r.ack.clear();evaluate(r);refresh();note('Changes saved. Checks updated.');},
    onAcknowledge(f){if(f.severity==='check'&&!f.field.endsWith('.photo'))r.ack.add(f.field+'|'+f.message);evaluate(r);rerender();},
    onKeepBoth(){if(!r.exactOf)r.keepBoth=true;rerender();},
    onRemove(){if(r.exactOf||r.duplicateOf){batch=batch.filter(x=>x!==r);URL.revokeObjectURL(r.url);if(hashOwners.get(r.hash)===r.id)hashOwners.set(r.hash,r.duplicateOf);for(const other of batch)if(other.exactOf===r.id)other.exactOf=r.duplicateOf;if($('#receipt-dialog').open)$('#receipt-dialog').close();refresh();}},
    onRetry(){if(r.state!=='error')return;r.notes=[];r.state='queued';r.readerSettings={mode,key:apiKey};finishedTime=0;queue.push(r);$('#receipt-dialog').close();pump();},
    onRemoveLine(i){if(!Number.isInteger(i)||!r.data?.items[i])return;r.data.items.splice(i,1);r.ack.clear();evaluate(r);rerender();},
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
$('#excel').onclick=async()=>{try{await exportExcel(active());}catch(e){note('Excel export failed. '+e.message);}};
$('#csv').onclick=()=>{try{exportCSV(active());}catch(e){note('CSV export failed. '+e.message);}};
$('#orders').onclick=()=>$('#orders-dialog').showModal();
$('#pick-orders').onclick=()=>$('#orders-input').click();
$('#orders-input').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{const rows=await readOrderFile(file);orderFilename=file.name;orderList=rows;batch.forEach(evaluate);render();$('#orders-dialog').close();note(`${rows.length} order lines loaded.`);}catch(err){$('#order-error').textContent=err.message;}};
$('#clear-orders').onclick=()=>{orderList=null;orderFilename='';batch.forEach(evaluate);render();};
$('#startover').onclick=()=>$('#reset-dialog').showModal();$('#reset').onclick=()=>{generation++;for(const r of batch)URL.revokeObjectURL(r.url);batch=[];queue.length=0;hashOwners.clear();seq=0;orderList=null;orderFilename='';startTime=finishedTime=0;$('#search').value='';$('#reset-dialog').close();render();};
const refreshSettings=()=>{const ai=$('#reader').value==='ai';$('#key-box').hidden=!ai;$('#key').required=ai;$('#local-explain').hidden=ai;};
$('#settings').onclick=()=>{$('#reader').value=mode;$('#key').value=apiKey;refreshSettings();$('#settings-dialog').showModal();};$('#reader').onchange=refreshSettings;
$('#settings-form').onsubmit=e=>{e.preventDefault();const selected=$('#reader').value,key=$('#key').value.trim();if(selected==='ai'&&!key)return;mode=selected;apiKey=selected==='ai'?key:'';$('#key').value='';$('#settings-dialog').close();note(mode==='ai'?'Gemini enabled for new photos.':'On-device reader selected.');};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>document.getElementById(b.dataset.close).close();
for(const d of document.querySelectorAll('dialog'))d.addEventListener('click',e=>{if(e.target===d){const b=d.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)d.close();}});
