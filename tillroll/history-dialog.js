// One Reading History dialog. Server-backed (v2 /api/history) when signed in;
// the browser-local history (reading-history.js) is the offline fallback.
// Exactly one of #history-server-list / #history-list is shown at a time.
import {historyEntries,clearHistory} from './reading-history.js';

const $ = s=>document.querySelector(s);
const escape = v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

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
// One Reading History dialog. A dismissed unlock shows neither list.
// Local history is an explicit choice. 5xx and network errors are the only automatic fallback.
function renderServerHistory(entries){
  const list=$('#history-server-list');if(!list)return;
  list.innerHTML=entries.length?entries.map(e=>`<article class="history-entry"><strong>${escape(e.kind||'Event')}</strong> · ${escape(e.summary||'')}<small>${escape(formatHistoryTime(e.created_at))}${e.batch_id?' · '+escape(e.batch_id):''}</small></article>`).join(''):'<p class="history-empty">No reading or workbook history yet.</p>';
}
function localHistoryChoice(){
  const btn=$('#history-local-choice');
  if(btn && !btn.dataset.bound){
    btn.dataset.bound='1';
    btn.addEventListener('click', ()=>{
      historyMode='local';
      renderHistory();
      showHistoryMode('offline');
    });
  }
  return btn;
}
function showHistoryMode(mode, errorText){
  const s=$('#history-server-list'),l=$('#history-list'),c=$('#history-clear'),st=$('#history-status'),btn=localHistoryChoice();
  const server=mode==='server', local=mode==='offline', locked=mode==='locked';
  if(s)s.hidden=!server;
  if(l)l.hidden=!local;
  if(c)c.hidden=!local;
  if(btn)btn.hidden=!locked;
  if(!st)return;
  st.textContent=server?'Showing the reading history saved on the Tillroll server.'
    :locked?'unlock required'
    :mode==='error'?(errorText||'Could not load reading history.')
    :'Showing the history kept in this browser (offline).';
}
let historyMode='local';
function applyHistoryResult(server){
  if(server?.ok){historyMode='server';renderServerHistory(server.entries);showHistoryMode('server');}
  else if(server?.error){historyMode='error';showHistoryMode('error', server.error);}
  else if(server?.locked){historyMode='locked';showHistoryMode('locked');}
  else{historyMode='local';renderHistory();showHistoryMode('offline');}
}
async function loadServerHistory(){
  const hook=window.tillrollV2Hooks?.serverHistory;
  if(typeof hook!=='function')return null;
  try{return await hook();}catch{return {ok:false,offline:true,status:0};}
}
async function openHistory(){
  const dialog=$('#history-dialog');
  const hook=window.tillrollV2Hooks?.serverHistory;
  if(typeof hook==='function')applyHistoryResult(await loadServerHistory());
  else applyHistoryResult(null);
  if(dialog && !dialog.open)dialog.showModal();
}
function refreshHistoryView(){if(historyMode==='local')renderHistory();}

export {openHistory,renderHistory,refreshHistoryView,clearHistory};
