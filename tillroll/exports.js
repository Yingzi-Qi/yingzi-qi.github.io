import {orderNeedsReview} from './orders.js?v=6';
import {reviewForLine} from './checks.js?v=6';
import {validateOrderPatterns} from './retail-rules.js?v=6';
import * as zipPackage from './export-vendor/jszip.min.js';

const JSZip = zipPackage.default ?? globalThis.JSZip;
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const WORKBOOK_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const receiptColumns = [
  ['Source','merchant',22], ['Date','date',13], ['Time','time',9],
  ['Order Number','orderNumber',22], ['Order ID','orderId',23],
  ['Brand','brand',20,'line'], ['Item ID','itemId',24,'line'], ['Item','item',33,'line'], ['Style / SKU','sku',20,'line'],
  ['Colour','colour',16,'line'], ['Size','size',12,'line'], ['Qty','qty',8,'line','number'],
  ['Unit Price','unitPrice',14,'line','money'], ['Amount','amount',14,'line','money'],
  ['Currency','currency',12], ['Receipt Total','total',16,'receipt','money'],
  ['Payment Type','payment',18], ['Card','card',9],
  ['Needs Checking','message',48,'review'], ['File','filename',28,'meta'],
  ['Photo check','status',22,'photo'], ['Photo check reason','reason',52,'photo'],
  ['Order ID on photo','idEvidence',30,'photo'], ['Brand on photo','brandEvidence',29,'photo'],
  ['Item on photo','itemEvidence',38,'photo'], ['Item ID on photo','itemIdEvidence',30,'photo'], ['Style / SKU on photo','skuEvidence',30,'photo'],
  ['Receipt reference','receiptReference',24], ['Located reference','value',24,'reference'],
  ['Reference type','label',22,'reference'], ['Reference evidence','evidence',46,'reference'],
  ['Reference finding','reason',52,'reference'], ['Suggested reference','suggested',24,'proposal'],
  ['Other possible references','alternatives',32,'proposal']
];
const orderColumns = [
  ['Order check','status',24,'order'], ['Order check detail','reason',52,'order'], ['Possible order reference','order_candidate',24,'order'],
  ['Order record brand','order_brand',24,'order'], ['Order record item','order_item',32,'order'],
  ['Order record item ID','order_item_id',24,'order'], ['Order record SKU','order_sku',22,'order'], ['Order record qty','order_qty',16,'order','number'],
  ['Order record line amount','order_amount',24,'order','money'], ['Order record purchase total','order_total',26,'order','money'],
  ['Order record currency','order_currency',22,'order']
];
const esc = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g,'')
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const colName = n => n > 26 ? colName(Math.floor((n-1)/26)) + colName((n-1)%26+1) : String.fromCharCode(64+n);
function exportData(receipts) {
  const columns = receipts.some(r => r.orders?.length) ? [...receiptColumns,...orderColumns] : receiptColumns;
  const rows = [];
  for (const r of receipts) {
    if (!r.data) continue;
    const lines = r.data.items?.length ? r.data.items : [{}];
    lines.forEach((line,i) => {
      const prefix = 'items.' + i + '.';
      const {flags,messages} = reviewForLine(r,i);
      const photo = r.review?.photo?.[i] ?? {};
      const order = r.orders?.[i] ?? {};
      const imported=r.origin==='achung';
      const originalNote=imported ? r.sourceNotes?.[i] : undefined;
      const orderIssue=orderNeedsReview(order) ? order.reason || order.status : '';
      const note=typeof originalNote==='string'
        ? [...new Set([originalNote,orderIssue].filter(Boolean))].join('; ')
        : messages.join('; ');
      const ref=r.reference || {};
      const suggested=ref.requiresReview ? ref.suggestion?.value : '';
      const alternatives=suggested ? [...new Set(ref.candidates.map(c=>c.value))].filter(v=>v!==suggested).join(' / ') : '';
      const sources = {
        receipt:r.record || r.data, line, photo, order, meta:r,
        reference:suggested ? {...ref,reason:[ref.reason,ref.suggestion.reason].filter(Boolean).join(' ')} : ref,
        proposal:{suggested,alternatives},
        review:{message:note}
      };
      rows.push(columns.map(([,key,,source='receipt',type]) => {
        let value = sources[source]?.[key] ?? '';
        const numeric = type && value !== '' && Number.isFinite(Number(value));
        value = numeric ? Number(value) : String(value);
        const field = source === 'line' ? prefix+key : key;
        const fieldFlags=flags.filter(f=>f.field===field);
        if (imported && fieldFlags.length && (source==='receipt' || source==='line')) {
          const style=fieldFlags.some(f=>f.severity==='fix') ? 8 : 6;
          return {value,numeric,style:type==='money' ? style+1 : style};
        }
        if (imported && source==='review' && value && !orderIssue) return {value,numeric,style:2};
        const flagged = fieldFlags.length || (source==='review' && value!=='' && (!imported || orderIssue))
          || (source==='proposal' && value!=='')
          || (source==='photo' && ['status','reason'].includes(key) && photo.status === 'Needs review')
          || (source==='order' && ['status','reason'].includes(key) && orderNeedsReview(order));
        return {value,numeric,style:flagged ? (type==='money' ? 5 : 4) : type==='money' ? 3 : 0};
      }));
    });
  }
  if (rows.length > 1048575) throw new Error('This batch exceeds the number of item rows allowed in one Excel worksheet.');
  return {columns,rows};
}

function csvValue(value) {
  let s = String(value);
  if (typeof value !== 'number' && (/^\s*[=+@-]/.test(s) || /^[\t\r\n]/.test(s))) s = "'" + s;
  return '"' + s.replaceAll('"','""') + '"';
}
export function buildCsvBlob(receipts) {
  const {columns,rows} = exportData(receipts);
  const all = [columns.map(c => c[0]), ...rows.map(row => row.map(c => c.value))];
  return new Blob(['\uFEFF',all.map(row => row.map(csvValue).join(',')).join('\r\n'),'\r\n'],
    {type:'text/csv;charset=utf-8'});
}

function cellXml(row,col,{value,numeric,style}) {
  const attrs = ' r="'+colName(col)+row+'" s="'+style+'"';
  if (numeric) return '<c'+attrs+'><v>'+value+'</v></c>';
  if (value==='') return '<c'+attrs+'/>';
  return '<c'+attrs+' t="inlineStr"><is><t xml:space="preserve">'+esc(String(value).slice(0,32767))+'</t></is></c>';
}
const styles = XML + `<styleSheet xmlns="${MAIN}">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${['FF1E4946','FFFFEDC0','FFFDE68A','FFFECDD3'].map(rgb=>'<fill><patternFill patternType="solid"><fgColor rgb="'+rgb+'"/><bgColor indexed="64"/></patternFill></fill>').join('')}</fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>${[3,4,5].map(fill=>'<xf numFmtId="0" fontId="0" fillId="'+fill+'" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="4" fontId="0" fillId="'+fill+'" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>').join('')}</cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
export async function buildXlsxBlob(receipts) {
  const {columns,rows} = exportData(receipts);
  const range = 'A1:'+colName(columns.length)+(rows.length+1);
  const header = columns.map((c,i)=>cellXml(1,i+1,{value:c[0],style:1})).join('');
  const contents = rows.map((row,i)=>{
    const wraps = Math.max(1,...row.map((c,j)=>[2,4,6,8].includes(c.style) ? Math.ceil(String(c.value).length/(columns[j][2]*.85)) : 1));
    return '<row r="'+(i+2)+'" ht="'+Math.min(180,Math.max(19,wraps*16))+'" customHeight="1">'+row.map((c,j)=>cellXml(i+2,j+1,c)).join('')+'</row>';
  }).join('');
  const worksheet = XML + `<worksheet xmlns="${MAIN}"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" state="frozen" topLeftCell="A2" activePane="bottomLeft"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="17"/><cols>${columns.map((c,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+c[2]+'" customWidth="1"/>').join('')}</cols><sheetData><row r="1" ht="24" customHeight="1">${header}</row>${contents}</sheetData><autoFilter ref="${range}"/></worksheet>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml',XML+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file('_rels/.rels',XML+`<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml',XML+`<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Line items" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels',XML+`<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml',worksheet);
  zip.file('xl/styles.xml',styles);
  return new Blob([await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})],{type:WORKBOOK_MIME});
}
function download(blob,extension) {
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url; link.download='Tillroll receipts.'+extension;
  document.body.append(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
export function exportCSV(receipts) { download(buildCsvBlob(receipts),'csv'); }
export async function exportExcel(receipts) { download(await buildXlsxBlob(receipts),'xlsx'); }

const aliases = {
  retailer:['retailer','source','merchant','store','mall','issuer'], order_id:['orderid','orderidentifier'],
  order_number:['ordernumber','orderno','order#'], brand:['brand','brandname'],
  item:['item','itemname','itemdescription','product','productname','description'],
  item_id:['itemid','productid','barcode','upc','upca','ean','ean8','ean13','gtin','gtin8','gtin12','gtin13','gtin14'],
  sku:['sku','stylesku','style','productcode','itemcode'], qty:['qty','quantity'],
  amount:['amount','lineamount','linetotal','itemamount','extendedamount'],
  total:['purchasetotal','purchaseamount','receipttotal','ordertotal','totalpaid','amountpaid'],
  currency:['currency','currencycode'], order_id_pattern:['orderidpattern','orderidformat'],
  order_number_pattern:['ordernumberpattern','ordernumberformat']
};
const keys = new Map(Object.entries(aliases).flatMap(([key,names])=>names.map(name=>[name,key])));
function orderSchema(headers) {
  const schema=new Map(), duplicates=[];
  const fields=headers.map(value=>String(value??'').toLowerCase().replace(/[^a-z0-9#]/g,''));
  const hasRetailer=fields.some(header=>['retailer','source','merchant','store'].includes(header));
  fields.forEach((header,i)=>{
    if (hasRetailer && ['mall','issuer'].includes(header)) return;
    const key=keys.get(header);
    if (!key) return;
    if (schema.has(key)) duplicates.push(key);
    schema.set(key,i);
  });
  if (!(schema.has('order_id')||schema.has('order_number')) || !(schema.has('item')||schema.has('sku')||schema.has('item_id'))) return null;
  if (duplicates.length) throw new Error('Multiple order-list columns refer to '+duplicates.join(', ')+'.');
  return schema;
}
function orderRows(table,schema) {
  return table.slice(1).filter(row=>row.some(cell=> String(cell??'').trim())).map(row=>
    Object.fromEntries(Object.keys(aliases).map(key=>[key,String(row[schema.get(key)]??'').trim()])));
}

function readCSV(input) {
  const text=input.replace(/^\uFEFF/,'');
  const header=text.split(/[\r\n]/,1)[0];
  const delimiter=[',',';','\t'].sort((a,b)=>header.split(b).length-header.split(a).length)[0];
  const rows=[]; let row=[],field='',quoted=false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (ch==='"') {
      if (quoted && text[i+1]==='"') {field+='"';i++;}
      else if (quoted || field==='') quoted=!quoted;
      else field+=ch;
    } else if (!quoted && ch===delimiter) {row.push(field);field='';}
    else if (!quoted && (ch==='\n'||ch==='\r')) {
      if (ch==='\r' && text[i+1]==='\n') i++;
      row.push(field);rows.push(row); row=[];field='';
    } else field+=ch;
  }
  if (quoted) throw new Error('Unclosed quoted field in the orders CSV.');
  if (field!==''||row.length) {row.push(field);rows.push(row);}
  return rows;
}

const children = (element,name)=>Array.from(element?.children??[]).filter(node=>node.localName===name);
const child = (element,name)=>children(element,name)[0];
const descendants = (element,name)=>Array.from(element.getElementsByTagNameNS('*',name));
function zipText(node) {
  const runs = children(node,'r');
  return runs.length ? runs.map(run=>child(run,'t')?.textContent??'').join('') : child(node,'t')?.textContent??'';
}
async function xmlPart(zip,path) {
  const entry=zip.file(path);
  if (!entry) throw new Error('Missing Excel workbook part: '+path);
  // Parse only the local worksheet, style and shared-string documents required for the import.
  if ((entry._data?.uncompressedSize??0)>64000000) throw new Error('The order workbook part is too large to open in the browser.');
  const text=await entry.async('string');
  if (/<!(DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('Unsupported XML declaration in the order workbook.');
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('One worksheet contains invalid XML.');
  return doc;
}
function relativePart(base,target) {
  if (!target || /^(?:[a-z]+:|\/\/)/i.test(target)) throw new Error('Invalid Excel workbook relationship.');
  const parts=(target.startsWith('/')?target:base.substring(0,base.lastIndexOf('/')+1)+target).split('/');
  const clean=[];
  for (const p of parts) {
    if (!p || p==='.') continue;
    if (p==='..') clean.pop(); else clean.push(p);
  }
  return clean.join('/');
}
const columnIndex=cell=>{
  const m=/^([A-Z]+)\d+$/.exec(cell.getAttribute('r')??'');
  return m ? [...m[1]].reduce((v,c)=>v*26+c.charCodeAt(0)-64,0)-1 : null;
};
function cellValue(cell,strings,formats,isId) {
  const type=cell.getAttribute('t')||'n',raw=child(cell,'v')?.textContent??'';
  if (type==='e') throw new Error('Excel error in order column '+cell.getAttribute('r')+'.');
  if (child(cell,'f') && raw==='') throw new Error('Save the calculated values in the order list before importing.');
  if (type==='inlineStr') return zipText(child(cell,'is'));
  if (type==='s') return strings[Number(raw)]??'';
  if (type==='n' && isId && raw!=='') {
    if (!/^\d{1,15}$/.test(raw)) throw new Error('Store identifiers as text in cell '+cell.getAttribute('r')+'.');
    const format = formats[Number(cell.getAttribute('s')||0)]??'General';
    if (/^0+$/.test(format)) return raw.padStart(format.length,'0');
    if (!['General','@'].includes(format)) throw new Error('Store the displayed identifier as text in cell '+cell.getAttribute('r')+'.');
  }
  return raw;
}
async function openWorkbook(file) {
  const zip=await JSZip.loadAsync(await file.arrayBuffer());
  const main='xl/workbook.xml';
  const book=await xmlPart(zip,main), rels=await xmlPart(zip,'xl/_rels/workbook.xml.rels');
  const relations=descendants(rels,'Relationship');
  const part=type=>relations.find(r=>r.getAttribute('Type')?.endsWith('/'+type));
  const shared=part('sharedStrings');
  const strings=shared ? descendants(await xmlPart(zip,relativePart(main,shared.getAttribute('Target'))),'si').map(zipText):[];
  const style=part('styles'),formats=[],reviewStyles=[];
  if (style) {
    const xml=await xmlPart(zip,relativePart(main,style.getAttribute('Target')));
    const custom=new Map(descendants(xml,'numFmt').map(n=>[n.getAttribute('numFmtId'),n.getAttribute('formatCode')]));
    const fills=children(descendants(xml,'fills')[0],'fill').map(fill=>{
      const pattern=child(fill,'patternFill');
      if (pattern?.getAttribute('patternType')!=='solid') return null;
      const rgb=child(pattern,'fgColor')?.getAttribute('rgb')?.slice(-6).toUpperCase();
      return {'FDE68A':'check','FECDD3':'fix'}[rgb]??null;
    });
    const builtin={'0':'General','1':'0','49':'@'};
    for (const xf of children(descendants(xml,'cellXfs')[0],'xf')) {
      const id=xf.getAttribute('numFmtId')??'0';
      formats.push(custom.get(id)??builtin[id]??'other');
      reviewStyles.push(xf.getAttribute('applyFill')==='0' ? null : fills[Number(xf.getAttribute('fillId'))]);
    }
  }
  const sheets=descendants(book,'sheet');
  const date1904=['true','1'].includes(descendants(book,'workbookPr')[0]?.getAttribute('date1904'));
  const sheetRows=async sheet=>{
    const rid=sheet.getAttributeNS(REL,'id')??sheet.getAttribute('r:id');
    const rel=relations.find(r=>r.getAttribute('Id')===rid);
    if (!rel || !rel.getAttribute('Type')?.endsWith('/worksheet')) return [];
    const xml=await xmlPart(zip,relativePart(main,rel.getAttribute('Target')));
    return children(descendants(xml,'sheetData')[0],'row');
  };
  return {sheets,strings,formats,reviewStyles,date1904,sheetRows};
}
async function readOrderXlsx(file) {
  const {sheets,strings,formats,sheetRows}=await openWorkbook(file);
  const preferred=sheets.filter(s=>/^orders$/i.test(s.getAttribute('name')??''));
  const candidates=[];
  for (const sheet of preferred.length ? preferred : sheets) {
    const rows=await sheetRows(sheet);
    if (!rows.length) continue;
    const raw=(row,schema)=>{
      const cells=[];
      for (const cell of children(row,'c')) {
        const index=columnIndex(cell)??cells.length;
        if (index>16383) throw new Error('Invalid Excel column in the order list.');
        if (schema && ![...schema.values()].includes(index)) continue;
        const isId=schema && ['order_id','order_number','sku','item_id'].some(k=>schema.get(k)===index);
        cells[index]=cellValue(cell,strings,formats,isId);
      }
      return cells;
    };
    const headers=raw(rows[0],null), schema=orderSchema(headers);
    if (schema) candidates.push(orderRows([headers,...rows.slice(1).map(r=>raw(r,schema))],schema));
  }
  if (candidates.length>1) throw new Error('More than one worksheet has order lines. Name the intended worksheet Orders.');
  return candidates[0]??null;
}
export async function readOrderFile(file) {
  let records;
  if (/\.csv$/i.test(file.name)) {
    const rows=readCSV(await file.text()),schema=orderSchema(rows[0]??[]);
    records=schema ? orderRows(rows,schema) : null;
  } else if (/\.xlsx$/i.test(file.name)) records=await readOrderXlsx(file);
  else throw new Error('Choose an Excel (.xlsx) or CSV order list.');
  if (records===null) throw new Error('Order list needs Order ID or Order Number and an Item, Item ID or SKU header. Include Retailer and Brand for verification.');
  if (!records.length) throw new Error('The order list contains no item rows.');
  validateOrderPatterns(records);
  return records;
}

// The original "Line items" sheet has 19 columns. Its two identifiers and its
// SKU are independent text fields, even when they consist entirely of digits.
const achungColumns=receiptColumns.slice(0,receiptColumns.findIndex(c=>c[0]==='File')+1).filter(c=>c[1]!=='itemId');
const nativeReferences=new Set(['orderNumber','orderId','sku','card']);
function nativeValue(cell,column,book) {
  const key=column[1], value=cellValue(cell,book.strings,book.formats,nativeReferences.has(key));
  if (value==='') return null;
  if (column[4]) {
    const n=Number(value);
    if (!Number.isFinite(n)) throw new Error('Invalid number in receipt cell '+cell.getAttribute('r')+'.');
    return n;
  }
  if ((key==='date'||key==='time') && (cell.getAttribute('t')??'n')==='n') {
    // Achung writes these as strings. Excel can convert them to serials on save.
    const serial=Number(value);
    if (!Number.isFinite(serial) || serial<0) throw new Error('Invalid Excel date or time in '+cell.getAttribute('r')+'.');
    if (key==='time') {
      const seconds=Math.round((serial%1)*86400)%86400;
      return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,...(seconds%60?[seconds%60]:[])].map(n=>String(n).padStart(2,'0')).join(':');
    }
    const day=Math.floor(serial);
    if (!book.date1904 && day===60) throw new Error('Invalid calendar date in receipt cell '+cell.getAttribute('r')+'.');
    const epoch=Date.UTC(book.date1904?1904:1899,book.date1904?0:11,book.date1904?1:31);
    const date=new Date(epoch+(day-(!book.date1904&&day>60?1:0))*86400000);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid Excel date in '+cell.getAttribute('r')+'.');
    return date.toISOString().slice(0,10);
  }
  return value;
}

const noteClues={
  orderNumber:/order[- ]number/i, orderId:/order[- ]id/i, merchant:/merchant|source of purchase/i,
  date:/\bdate\b/i, total:/\breceipt total\b|lines add up|\btotal is missing\b/i,
  item:/item name|description|repeated row/i, amount:/line (?:total|amount)|[×]|quantity multiplied/i,
  brand:/\bbrand\b/i
};
function nativeFlags(rows) {
  const flags=[];
  function add(field,message,severity) {
    if (!flags.some(f=>f.field===field && f.message===message && f.severity===severity))
      flags.push({field,message,severity,escalate:false});
  }
  const perRow=rows.map(row=>row.note ? row.note.split('; ') : []);
  rows.forEach(({marks},i)=>{
    const messages=perRow[i], bound=new Set();
    for (const mark of marks) {
      const receiptField=!mark.field.startsWith('items.');
      // Receipt-level flags repeat on each line in the original export. Never
      // attach a line-specific note to every item on a multi-item receipt.
      const eligible=receiptField ? messages.filter(m=>perRow.every(notes=>notes.includes(m))) : messages;
      const value=String(mark.value??'').toLowerCase();
      const matches=marks.length===1 ? eligible : eligible.filter(m=>
        (value.length>=4 && m.toLowerCase().includes(value)) || noteClues[mark.key]?.test(m));
      for (const message of matches) {
        add(mark.field,message,mark.severity);
        bound.add(message);
      }
      if (!matches.length) add(mark.field,'Achung marked '+mark.title+' for review.',mark.severity);
    }
    // Some original notes (e.g. image quality) have no matching coloured cell.
    for (const message of messages) if (!bound.has(message))
      add('items.'+i+'.review',message,'check');
  });
  return flags;
}

export async function readAchungWorkbook(file) {
  if (file?.name && !/\.xlsx$/i.test(file.name)) throw new Error('Choose an Achung Excel (.xlsx) receipt workbook.');
  const book=await openWorkbook(file);
  const sheet=book.sheets.find(s=>s.getAttribute('name')?.toLowerCase()==='line items');
  if (!sheet) throw new Error('Choose an Achung Excel export with a Line items worksheet.');
  const [head,...rows]=await book.sheetRows(sheet);
  if (!head || !children(head,'c').length) throw new Error('The Line items worksheet is empty.');
  const schema=new Map(), seen=new Set();
  for (const cell of children(head,'c')) {
    const title=cellValue(cell,book.strings,book.formats,false).trim().toLowerCase();
    if (['photo check','photo check reason','order id on photo','reference finding','other possible references'].includes(title))
      throw new Error('This is a Tillroll workbook. Choose the original Excel file exported by Achung.');
    const column=achungColumns.find(c=>c[0].toLowerCase()===title);
    if (!column) continue;
    if (seen.has(column)) throw new Error('Repeated header in receipt workbook: '+column[0]+'.');
    seen.add(column);
    schema.set(columnIndex(cell)??schema.size,column);
  }
  if (seen.size!==achungColumns.length) throw new Error('Choose the Excel file exported by Achung. Missing '+achungColumns.filter(c=>!seen.has(c)).map(c=>c[0]).join(', ')+'.');
  const groups=new Map();
  for (const row of rows) {
    const values={}, cells=new Map();
    let next=0;
    for (const cell of children(row,'c')) {
      const i=columnIndex(cell)??next; next=i+1;
      const column=schema.get(i);
      if (!column) continue;
      values[column[1]]=nativeValue(cell,column,book);
      cells.set(column[1],cell);
    }
    if (!Object.values(values).some(v=>v!==null)) continue;
    const filename=values.filename;
    if (!filename) throw new Error('Missing receipt filename in workbook row '+row.getAttribute('r')+'.');
    const data={}, item={}, marks=[];
    for (const column of achungColumns) {
      const [,key,,scope='receipt']=column;
      if (scope==='receipt') data[key]=values[key]??null;
      if (scope==='line') item[key]=values[key]??null;
    }
    // Distinct purchases from photos with the same filename remain distinct.
    const signature=JSON.stringify([filename,data]);
    if (!groups.has(signature)) groups.set(signature,{filename,data:{...data,items:[]},rows:[]});
    const group=groups.get(signature), index=group.rows.length;
    group.data.items.push(item);
    for (const [title,key,,scope='receipt'] of achungColumns) {
      const cell=cells.get(key), severity=cell && book.reviewStyles[Number(cell.getAttribute('s')??0)];
      if (severity && (scope==='receipt' || scope==='line'))
        marks.push({title,key,field:scope==='line'?'items.'+index+'.'+key:key,value:values[key],severity});
    }
    group.rows.push({note:values.message??'',marks});
  }
  if (!groups.size) throw new Error('The receipt workbook contains no receipt rows.');
  return Array.from(groups.values(),({filename,data,rows})=>({
    filename,data,flags:nativeFlags(rows),sourceNotes:rows.map(row=>row.note)
  }));
}
