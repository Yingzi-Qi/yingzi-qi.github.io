// Keep read permission for the selected file only for the lifetime of this tab.
export function bindExcelRefresh({hasBatch,prepare,finish,onLinkChange}) {
  const element=id=>document.getElementById(id);
  const dialog=element('refresh-dialog'), choose=element('pick-refresh'), input=element('refresh-input');
  const apply=element('apply-refresh'), status=element('refresh-status'), error=element('refresh-error');
  let linked=null, pending=null, revision=0, usePicker=typeof window.showOpenFilePicker==='function';

  function open(){
    revision++;pending=null;apply.hidden=true;choose.disabled=false;
    status.textContent='';error.textContent='';
    element('refresh-title').textContent=hasBatch()?'Refresh from Excel':'Open Tillroll workbook';
    element('refresh-hint').textContent=hasBatch()
      ? 'Save your Tillroll workbook in Excel, then choose it here. Edited cells update the matching receipts and items.'
      : 'Choose a saved Tillroll Excel export to reopen its receipt rows. You can attach the original photos and compare an order list afterwards.';
    if(!dialog.open)dialog.showModal();
  }
  function commit(prepared,handle){
    finish(prepared);
    linked=handle;onLinkChange(linked);dialog.close();
  }
  async function read(file,handle=null){
    const current=++revision;
    choose.disabled=true;apply.hidden=true;pending=null;
    status.textContent='Reading workbook…';error.textContent='';
    try {
      const prepared=await prepare(file);
      if(current!==revision || !dialog.open)return;
      if(prepared.confirmation){
        status.textContent=prepared.confirmation;
        pending={prepared,handle};apply.hidden=false;apply.focus();
      }else commit(prepared,handle);
    }catch(err){
      if(current===revision && dialog.open){
        status.textContent='';error.textContent=err.message || 'Could not refresh this workbook.';
      }
    }finally{if(current===revision)choose.disabled=false;}
  }
  choose.onclick=async()=>{
    if(!usePicker){input.click();return;}
    const current=revision;
    let handle;
    try {
      [handle]=await window.showOpenFilePicker({types:[{description:'Excel workbook',accept:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx']}}]});
      const file=await handle.getFile();
      if(current===revision && dialog.open)await read(file,handle);
    }catch(err){
      if(current!==revision || !dialog.open || err.name==='AbortError')return;
      if(!handle){usePicker=false;input.click();}
      else error.textContent='Could not read that file. Choose the saved workbook again.';
    }
  };
  input.onchange=()=>{const file=input.files[0];input.value='';if(file && dialog.open)read(file);};
  apply.onclick=()=>{
    if(!pending)return;
    try{commit(pending.prepared,pending.handle);}
    catch(err){status.textContent='';error.textContent=err.message;apply.hidden=true;pending=null;}
  };
  element('refresh-excel').onclick=async()=>{
    open();
    if(!linked)return;
    const current=revision;
    choose.disabled=true;
    try{
      const file=await linked.getFile();
      if(current===revision && dialog.open)await read(file,linked);
    }catch{
      if(current!==revision || !dialog.open)return;
      linked=null;onLinkChange(null);choose.disabled=false;
      error.textContent='The linked file could not be opened. Choose the saved workbook again.';
    }
  };
  element('open-tillroll').onclick=element('change-refresh').onclick=open;
  dialog.addEventListener('close',()=>{revision++;pending=null;});
  return ()=>{linked=null;onLinkChange(null);};
}
