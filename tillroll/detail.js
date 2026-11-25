import {purchaseDateText} from './receipt-date-display.js?v=8';
import {orderNeedsReview} from './orders.js?v=lineverify1';
import {kindForFlag,kindForVerification,referenceHint,reviewKinds} from './receipt-policy.js?v=policy1';
// Receipt data and OCR are untrusted strings. Only write them through DOM text/value APIs.
function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function button(label, action, style = '') {
  const control = element('button', label, style);
  control.type = 'button';
  control.addEventListener('click', action);
  return control;
}

const receiptFields = [
  ['merchant', 'Retailer'], ['date', 'Purchase date'], ['time', 'Time'],
  ['orderNumber', 'Order number'], ['orderId', 'Order ID'], ['receiptReference', 'Receipt reference'], ['currency', 'Currency'],
  ['subtotal', 'Subtotal', 'number'], ['discount', 'Discount', 'number'], ['receiptDiscount', 'Receipt discount', 'number'],
  ['tax', 'Tax', 'number'], ['total', 'Receipt total', 'number'],
  ['payment', 'Payment method'], ['card', 'Card ending'],
];
const itemFields = [
  ['brand','Brand'], ['item','Item'], ['itemId','Item ID / barcode'], ['sku','Style / SKU'], ['colour','Colour'],
  ['size','Size'], ['qty','Quantity','number'], ['unitPrice','Unit price','number'], ['amount','Line amount','number'],
  ['lineDiscount','Line discount','number'], ['lineDiscountLabel','Discount label'],
];
const blankItem = () => Object.fromEntries(itemFields.map(([key,,type]) => [key, type === 'number' ? null : '']));

function flagLabel(path) {
  if (path === 'receipt') return 'Receipt';
  if (path === 'items') return 'Line items';
  if (path === 'verification') return 'Photo recheck';
  const parts = path.split('.');
  if (parts[0] === 'items') {
    const label = parts[2]==='review' ? 'Workbook note' : itemFields.find(([key]) => key === parts[2])?.[1] || 'Photo check';
    return 'Line ' + (Number(parts[1]) + 1) + ' · ' + label;
  }
  return receiptFields.find(([key]) => key === path)?.[1] || path;
}

function section(title) {
  const s = element('section');
  s.append(element('h3',title));
  return s;
}

function disclosure(title, open = false) {
  const box = element('details');
  box.open = open;
  box.append(element('summary',title));
  return box;
}

function displayReading(value) {
  return value == null || value === '' ? '—' : String(value);
}

function referenceBox(box) {
  if (!box || ![box.x,box.y,box.w,box.h].every(Number.isFinite)) return null;
  const x=Math.max(0,box.x), y=Math.max(0,box.y);
  const w=Math.min(1,box.x+box.w)-x, h=Math.min(1,box.y+box.h)-y;
  return w>0 && h>0 ? {x,y,w,h} : null;
}

function sharedReferenceLocation(candidates) {
  if (!candidates || candidates.length<2) return null;
  const boxes=candidates.map(candidate=>referenceBox(candidate.box));
  if (boxes.some(box=>!box)) return null;
  const left=Math.max(...boxes.map(b=>b.x)), top=Math.max(...boxes.map(b=>b.y));
  const right=Math.min(...boxes.map(b=>b.x+b.w)), bottom=Math.min(...boxes.map(b=>b.y+b.h));
  const width=right-left, height=bottom-top;
  const minWidth=Math.min(...boxes.map(b=>b.w)), minHeight=Math.min(...boxes.map(b=>b.h));
  // Require one common piece of the same text line, including when one OCR
  // pass boxed the whole line and another boxed just the reference digits.
  if (width<.65*minWidth || height<.6*minHeight || boxes.some(b=>b.h>2*minHeight)) return null;
  return {x:left,y:top,w:width,h:height};
}

const referenceTypes = {orderId:'Order ID', orderNumber:'Order number', receiptReference:'Receipt reference'};

function photoPosition(box) {
  if (!box) return '';
  const col=Math.min(2,Math.floor(3*(box.x+box.w/2))), row=Math.min(2,Math.floor(3*(box.y+box.h/2)));
  return [['Top left','Top centre','Top right'],['Centre left','Centre','Centre right'],['Bottom left','Bottom centre','Bottom right']][row][col];
}

function markReference(pictureLink, box, tentative) {
  if (!pictureLink) return;
  pictureLink.querySelector('.reference-marker')?.remove();
  if (!box) return;
  const marker=element('span',undefined,'reference-marker'+(tentative?' tentative':''));
  marker.setAttribute('aria-hidden','true');
  marker.style.left=box.x*100+'%';marker.style.top=box.y*100+'%';
  marker.style.width=box.w*100+'%';marker.style.height=box.h*100+'%';
  pictureLink.append(marker);
}

function showSuggestion(pictureLink, panel, reference, onConfirm) {
  const suggested=reference.suggestion;
  const block=section('Suggested reference');
  const choices=element('fieldset',undefined,'reference-choices');
  choices.append(element('legend','Choose a reference','sr-only'));
  const kind=element('select');
  for (const [key,label] of Object.entries(referenceTypes)) {
    const option=element('option',label);
    option.value=key;
    kind.append(option);
  }
  let selected=suggested;
  let alternativesSummary;
  let alternativesTitle;
  function select(candidate) {
    selected=candidate;
    kind.value=candidate.basis==='position' ? 'orderId' : Object.hasOwn(referenceTypes,candidate.kind) ? candidate.kind : 'receiptReference';
    if (alternativesSummary) alternativesSummary.textContent=alternativesTitle+(candidate===suggested?'':' · Selected '+candidate.value);
    markReference(pictureLink,referenceBox(candidate.box),true);
  }
  const seen=new Set();
  const candidates=[suggested,...(reference.candidates || [])].filter(candidate=>{
    const key=JSON.stringify([candidate?.kind,String(candidate?.value ?? '').trim().toLowerCase()]);
    if (!candidate?.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  function choice(candidate, preferred) {
    const label=element('label',undefined,'reference-choice');
    const radio=element('input');
    radio.type='radio';radio.name='reference-choice';radio.value=candidate.value;radio.checked=preferred;
    radio.addEventListener('change',()=>{if (radio.checked) select(candidate);});
    const content=element('span',undefined,'reference-choice-text');
    const type=(candidate.label || referenceTypes[candidate.kind] || 'Receipt reference').replace(/^possible\s+/i,'');
    const tentative=candidate.basis==='position' ? 'Unlabelled reference' : 'Possible '+type[0].toLowerCase()+type.slice(1);
    const position=photoPosition(referenceBox(candidate.box));
    content.append(element('strong',candidate.value,'reference-value'),element('span',[tentative,position].filter(Boolean).join(' · '),'reference-context'));
    if (candidate.evidence) content.append(element('span','Photo text · '+candidate.evidence,'reference-evidence'));
    label.append(radio,content);
    return label;
  }
  choices.append(choice(suggested,true));
  const differingReadings=new Set(candidates.map(candidate=>candidate.value)).size>1 && sharedReferenceLocation(candidates);
  const explanation=[suggested.reason, differingReadings
    ? 'The readings disagree on the characters at the same place on the photo.' : reference.reason];
  for (const line of new Set(explanation.filter(Boolean))) choices.append(element('p',line,'hint'));
  if (candidates.length>1) {
    alternativesTitle='Other possible references ('+(candidates.length-1)+')';
    const alternatives=disclosure(alternativesTitle);
    alternatives.className='reference-alternatives';
    alternativesSummary=alternatives.querySelector('summary');
    for (const candidate of candidates.slice(1)) alternatives.append(choice(candidate,false));
    choices.append(alternatives);
  }
  block.append(choices);
  if (onConfirm) {
    const actions=element('div',undefined,'reference-actions');
    const field=element('label','Save as','form-field');
    field.append(kind);
    actions.append(field,button('Confirm reference',()=>onConfirm(selected,kind.value),'primary'));
    block.append(actions);
  }
  select(suggested);
  panel.append(block);
}

function showReference(pictureLink, panel, reference, onConfirm) {
  if (!reference) return;
  if (reference.requiresReview && reference.suggestion?.value) {
    showSuggestion(pictureLink,panel,reference,onConfirm);
    return;
  }
  const found=reference.status==='found';
  const candidate=found ? reference : reference.status==='ambiguous' && reference.candidates?.length===1 ? reference.candidates[0] : null;
  const shared=reference.status==='ambiguous' ? sharedReferenceLocation(reference.candidates) : null;
  const box=shared || referenceBox(candidate?.box);
  const block=section('Reference on photo');
  if (shared || (candidate?.value && (found || box))) {
    const label=found ? candidate.label || referenceTypes[candidate.kind] || 'Receipt reference' : 'Possible reference';
    const text=shared ? 'Reference location · digits unclear' : label+' · '+candidate.value;
    const value=element('p',text,'reference-value');
    block.append(value);
    if (box && pictureLink) {
      markReference(pictureLink,box,!found);
      value.append(document.createTextNode(' · '+photoPosition(box)));
    }
  }
  let reason=shared ? 'The readings point to the same place and disagree on the characters.' : reference.reason;
  if (!reason && !found) reason=referenceHint(reference.merchant || '');
  if (!reason && !found) reason=reference.status==='ambiguous' ? 'The photo contains an uncertain reference.' : 'No reliable order reference was found.';
  if (reason) block.append(element('p',reason,'hint'));
  panel.append(block);
}

function changesSinceFirst(r) {
  const first = r.previous, second = r.data;
  if (!first || !second) return [];
  const changes = [];
  const compare = (a, b, prefix, fields) => {
    for (const [key,label] of fields) {
      if (displayReading(a?.[key]) !== displayReading(b?.[key]))
        changes.push(prefix + label + ' · ' + displayReading(a?.[key]) + ' → ' + displayReading(b?.[key]));
    }
  };
  compare(first, second, '', receiptFields);
  if (first.items.length !== second.items.length) changes.push('Line count · '+first.items.length+' → '+second.items.length);
  for (let i=0; i<Math.min(first.items.length,second.items.length); i++)
    compare(first.items[i], second.items[i], 'Line '+(i+1)+' · ', itemFields);
  return changes;
}

function showReading(panel, r) {
  if (r.origin==='achung') {
    const source=r.workbookName ? 'Achung Excel · '+r.workbookName : 'Achung Excel';
    panel.append(element('p',source,'hint'),element('p','The receipt fields and review flags came from this workbook.','hint'));
    return;
  }
  const reasons = [...(r.reasons || []), ...(r.notes || [])];
  const clues = r.data?.storeClues;
  if (clues && (clues.addressLines?.length || clues.postcode || clues.storeNumber || clues.phone))
    reasons.push('Printed store details: '+[...(clues.addressLines||[]),clues.postcode&&'Postcode '+clues.postcode,clues.storeNumber&&'Store '+clues.storeNumber,clues.phone&&'Tel '+clues.phone].filter(Boolean).join(' · '));
  const elapsed = Number(r.elapsed);
  const sub = [r.method, Number.isFinite(elapsed) && elapsed > 0 ? elapsed.toFixed(1)+' s' : ''].filter(Boolean).join(' · ');
  if (sub) panel.append(element('p', sub, 'hint'));
  const changes = changesSinceFirst(r);
  if (!r.second && !reasons.length && !changes.length) return;
  const detail = disclosure(r.second ? 'Second pass' : 'Reading notes');
  if (reasons.length || changes.length) {
    const list = element('ul', undefined,'issue-list');
    for (const reason of [...new Set(reasons), ...changes]) list.append(element('li',reason));
    detail.append(list);
  } else detail.append(element('p','No fields changed.', 'hint'));
  panel.append(detail);
}

function showProof(panel, r) {
  const imported=r.origin==='achung';
  const hasVerification=Boolean(r.verification?.length);
  if (imported && !hasVerification && !r.orders?.length && !r.review.photo.length) return;
  const title=hasVerification ? 'Item verification' : imported && !r.review.photo.length ? 'Order comparison' : 'Photo check';
  const block = section(title);
  const items=r.data.items || [];
  const rows=items.length ? items : r.orders?.length ? [null] : [];
  rows.forEach((item,i) => {
    const receipt = r.review.photo?.[i], order = r.orders?.[i];
    const line = element('div',undefined,'proof');
    const label = item ? 'Line '+(i+1)+(item.item ? ' · '+item.item : '') : 'Receipt';
    line.append(element('h3',label));
    if (item?.itemId || item?.sku) {
      const codes=[item.itemId && 'Item ID '+item.itemId,item.sku && 'Style / SKU '+item.sku];
      line.append(element('p',codes.filter(Boolean).join(' · '),'hint'));
    }
    const verification=r.verification?.[i];
    if (verification) {
      const audit=element('div');
      audit.id='verification-line-'+i;
      audit.tabIndex=-1;
      audit.setAttribute('role','group');
      audit.setAttribute('aria-label',label+' · Item verification');
      const result=element('p');
      const status=verification.status;
      const tone=status==='Verification error' ? 'bad' : status==='Previously flagged' ? 'warn' : status==='Verified' ? '' : 'muted';
      result.append(element('span',status,'status '+tone));
      if (verification.source) result.append(document.createTextNode(' '+verification.source));
      audit.append(result);
      if (verification.reason) audit.append(element('p',verification.reason,'hint'));
      if (verification.storeAddress) audit.append(element('p','Official branch · '+verification.storeAddress,'hint'));
      line.append(audit);
    }
    if (receipt) {
      const summary = element('p');
      summary.append(element('span',receipt.status, 'status '+(receipt.status==='Needs review'?'warn reading-error':receipt.status==='Not verified'?'muted reading-error':'reading-error')),document.createTextNode(' '+receipt.reason));
      line.append(summary);
      const evidence = [...new Set([receipt.idEvidence, receipt.brandEvidence, receipt.itemEvidence,receipt.itemIdEvidence,receipt.skuEvidence].filter(Boolean))];
      if (evidence.length) line.append(element('blockquote',evidence.join('\n')));
    }
    if (order) {
      const orderDetail = disclosure('Order record · '+order.status,orderNeedsReview(order));
      orderDetail.append(element('p',order.reason,'hint'));
      const expected=[order.order_brand,order.order_item,order.order_item_id && 'Item ID '+order.order_item_id,order.order_sku && 'Style / SKU '+order.order_sku,
        order.order_qty && 'Qty '+order.order_qty,order.order_amount && 'Line amount '+order.order_amount,
        order.order_total && 'Purchase total '+order.order_total,order.order_currency].filter(Boolean);
      if (expected.length) orderDetail.append(element('blockquote',expected.join(' · ')));
      line.append(orderDetail);
    }
    block.append(line);
  });
  if (rows.length) panel.append(block);
}

function showFlags(panel, r, act, callbacks) {
  const ordinary = r.review.flags.filter(f=>!f.field.endsWith('.photo'));
  const include = (flags, parent) => {
    const list = element('ul',undefined,'issue-list');
    for (const flag of flags) {
      const li = element('li');
      const severity=r.origin==='achung' && flag.severity==='fix' ? 'Fix · ' : '';
      li.append(element('strong',severity+flagLabel(flag.field)+' · '),document.createTextNode(flag.message));
      if (flag.severity === 'check' && flag.field!=='receipt' && callbacks.onAcknowledge) {
        const accept = button('Mark checked',()=>act('onAcknowledge',flag),'quiet');
        accept.setAttribute('aria-label','Mark checked: '+flagLabel(flag.field));
        li.append(accept);
      }
      list.append(li);
    }
    parent.append(list);
  };
  const issues = ordinary.filter(f=>f.severity!=='info');
  const reading = issues.filter(f=>kindForFlag(f)===reviewKinds.reading);
  const lookup = issues.filter(f=>kindForFlag(f)===reviewKinds.lookup);
  if (reading.length) { const s = section('Reading errors'); include(reading,s); panel.append(s); }
  if (lookup.length) { const s = section('Lookup uncertainty'); include(lookup,s); panel.append(s); }
  const info = ordinary.filter(f=>f.severity==='info');
  if (info.length) { const box = disclosure('Other checks'); include(info,box); panel.append(box); }
}

function showEditor(panel, r, act, focusPath) {
  const form = element('form');
  const box = disclosure(r.origin==='achung' ? 'Edit imported fields' : 'Edit extracted fields',!!focusPath);
  let dirty = false;
  const fields = new Map();
  const addFields = (fieldsForPart, source, path, parent) => {
    const grid = element('div',undefined,'edit-grid');
    for (const [key,label,type='text'] of fieldsForPart) {
      const holder = element('label',label,'form-field'), input = element('input');
      input.type=type;
      if(key==='date')input.placeholder='YYYY-MM-DD';
      if(type==='number') input.step='any';
      input.value=source[key] ?? '';
      input.autocomplete='off';
      if (key==='orderNumber' || key==='orderId' || key==='sku' || key==='card') input.spellcheck=false;
      input.name=path+key;
      input.addEventListener('input',()=>{dirty=true;});
      fields.set(input.name,input);
      holder.append(input); grid.append(holder);
    }
    parent.append(grid);
  };
  const collect = () => {
    if (!form.reportValidity()) return null;
    const next=structuredClone(r.data);
    for (const [path,input] of fields) {
      const parts=path.split('.');
      const target=parts.length===3 ? next.items[Number(parts[1])] : next;
      const key=parts.at(-1), value=input.value.trim();
      // Untouched empty values, including null in the supplied extraction, retain their type.
      if (String(target[key] ?? '') === value) continue;
      target[key] = input.type==='number' ? (value==='' ? null : Number(value)) : value;
    }
    return next;
  };
  const changeCount = (removeIndex) => {
    if (!dirty) { if (removeIndex===null) act('onAddLine'); else act('onRemoveLine',removeIndex); return; }
    const next=collect();
    if (!next) return;
    if(removeIndex===null) next.items.push(blankItem());
    act('onSave',next,removeIndex);
  };
  addFields(receiptFields,r.data,'',form);
  (r.data.items || []).forEach((item,i)=>{
    const group=element('fieldset');
    group.append(element('legend','Line '+(i+1)));
    addFields(itemFields,item,'items.'+i+'.',group);
    const remove=button('Remove line',()=>changeCount(i),'quiet');
    remove.setAttribute('aria-label','Remove line '+(i+1));
    group.append(remove);form.append(group);
  });
  const actions=element('div',undefined,'dialog-actions');
  actions.append(button('Add line',()=>changeCount(null)));
  const save=element('button','Save changes','primary'); save.type='submit';actions.append(save);
  form.append(actions);form.addEventListener('submit',e=>{
    e.preventDefault();const next=collect();if(next)act('onSave',next);
  });
  box.append(form);panel.append(box);
  return fields.get(focusPath);
}

export function showDetail(r, callbacks={}, focusPath='') {
  const dialog=document.getElementById('receipt-dialog');
  const close=()=>{if(dialog.open)dialog.close();};
  const act=(name,...args)=>{if(typeof callbacks[name]==='function'){close();callbacks[name](...args);}};
  const title=element('div',undefined,'dialog-title');
  const heading=element('div'), h=element('h2','Receipt '+r.id+(r.data?.merchant?' · '+(r.data.merchantDisplay||r.data.merchant):''));
  h.id='receipt-detail-title';dialog.setAttribute('aria-labelledby',h.id);
  heading.append(h,element('small',r.filename));
  if(r.data)heading.append(element('small',['Purchase date · '+purchaseDateText(r.data),r.data.time].filter(Boolean).join(' · ')));
  const exit=button('×',close,'icon close');exit.setAttribute('aria-label','Close receipt');title.append(heading,exit);
  const body=element('div',undefined,'detail-grid'), picture=element('div',undefined,'picture');
  let pictureLink;
  if (r.url) {
    pictureLink=element('a',undefined,'photo-frame');pictureLink.href=r.url;pictureLink.target='_blank';pictureLink.rel='noopener noreferrer';pictureLink.title='Open full-size receipt';
    pictureLink.setAttribute('aria-label','Open full-size receipt photo for '+r.filename);
    const image=element('img');image.alt='Original photo for '+r.filename;
    image.addEventListener('load',()=>{
      if (image.naturalHeight>0) pictureLink.style.setProperty('--photo-ratio',String(image.naturalWidth/image.naturalHeight));
    });
    image.src=r.url;pictureLink.append(image);picture.append(pictureLink);
  }
  if(r.demo?.credit) {
    const credit=element('p',undefined,'picture-credit');
    const source=element('a',r.demo.credit.label);
    source.href=r.demo.credit.url;source.target='_blank';source.rel='noopener noreferrer';
    credit.append(source);picture.append(credit);
  }
  if(Number.isFinite(r.data?.total)) {
    const amount=r.data.total.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
    heading.append(element('small',['Receipt total',r.data.currency,amount].filter(Boolean).join(' ')));
  }
  const panel=element('div',undefined,'review-panel');
  if (r.state==='done' && r.origin!=='achung') showReference(pictureLink,panel,{...r.reference,merchant:r.data?.merchant},
    callbacks.onConfirmReference && ((candidate,kind)=>act('onConfirmReference',candidate,kind)));
  if (r.useSaved && r.demo?.note) panel.append(element('p',r.demo.note,'hint'));
  if (r.duplicateOf || r.exactOf) {
    const id=r.exactOf || r.duplicateOf;
    const duplicate=section(r.exactOf?'Identical file':'Possible duplicate');
    duplicate.append(element('p',(r.exactOf?'Same file as receipt ':'Same purchase as receipt ')+id+'. This copy is excluded from export.','hint'));
    const actions=element('div',undefined,'actions');
    if(callbacks.onOpenOriginal)actions.append(button('Open receipt '+id,()=>act('onOpenOriginal',id)));
    if(!r.exactOf && callbacks.onKeepBoth)actions.append(button('Keep both',()=>act('onKeepBoth')));
    if(callbacks.onRemove)actions.append(button('Remove this copy',()=>act('onRemove'),'quiet'));
    duplicate.append(actions);panel.append(duplicate);
  }
  let focused;
  if (r.state==='error') {
    panel.append(element('h3','Could not read photo'),element('p',r.error || 'The receipt reader could not finish.', 'hint'));
    if (callbacks.onRetry) panel.append(button('Retry',()=>act('onRetry')));
  } else if(r.state==='done' && r.data) {
    showReading(panel,r);showProof(panel,r);showFlags(panel,r,act,callbacks);
    const verificationLine=/^verification\.(\d+)$/.exec(focusPath);
    focused=showEditor(panel,r,act,verificationLine ? '' : focusPath);
    if (verificationLine) focused=panel.querySelector('#verification-line-'+verificationLine[1]);
  } else if(!r.exactOf) {
    panel.append(element('p',r.state==='second'?'Second reading in progress…':r.state==='queued'?'Waiting for a reader…':'Reading receipt…','hint'));
  }
  if (picture.childElementCount) body.append(picture);
  else panel.style.gridColumn='1 / -1';
  body.append(panel);dialog.replaceChildren(title,body);
  dialog.onclick=e=>{if(e.target===dialog){const b=dialog.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)close();}};
  if(!dialog.open) dialog.showModal();
  if(focused) {focused.focus();focused.select?.();}
}
