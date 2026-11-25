import {orderNeedsReview} from './orders.js?v=lineverify1';
import {reviewForLine} from './checks.js?v=productcodes3';
import {validateOrderPatterns} from './retail-rules.js?v=6';
import {parsePrintedItemId} from './product-code.js?v=productcodes3';
import {maskCardField} from './item-identifiers.js';
import * as zipPackage from './export-vendor/jszip.min.js';

const JSZip = zipPackage.default ?? globalThis.JSZip;
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const WORKBOOK_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const excelColumnWidth = 28;
const excelRowHeight = 32;

const receiptColumns = [
  ['Source','merchant'], ['Date','date'], ['Time','time'],
  ['Order Number','orderNumber'], ['Order ID','orderId'],
  ['Brand','brand','line'], ['Item ID','itemId','line'], ['Item','item','line'], ['Style / SKU','sku','line'],
  ['Colour','colour','line'], ['Size','size','line'], ['Qty','qty','line','number'],
  ['Unit Price','unitPrice','line','money'], ['Amount','amount','line','money'],
  ['Currency','currency'], ['Receipt Total','total','receipt','money'],
  ['Payment Type','payment'], ['Card','card'],
  ['Needs Checking','message','review'], ['File','filename','meta'],
  ['Photo check','status','photo'], ['Photo check reason','reason','photo'],
  ['Order ID on photo','idEvidence','photo'], ['Brand on photo','brandEvidence','photo'],
  ['Item on photo','itemEvidence','photo'], ['Item ID on photo','itemIdEvidence','photo'], ['Style / SKU on photo','skuEvidence','photo'],
  ['Receipt reference','receiptReference'], ['Located reference','value','reference'],
  ['Reference type','label','reference'], ['Reference evidence','evidence','reference'],
  ['Reference finding','reason','reference'], ['Suggested reference','suggested','proposal'],
  ['Other possible references','alternatives','proposal']
];
const orderColumns = [
  ['Order check','status','order'], ['Order check detail','reason','order'], ['Possible order reference','order_candidate','order'],
  ['Order record brand','order_brand','order'], ['Order record item','order_item','order'],
  ['Order record item ID','order_item_id','order'], ['Order record SKU','order_sku','order'], ['Order record qty','order_qty','order','number'],
  ['Order record line amount','order_amount','order','money'], ['Order record purchase total','order_total','order','money'],
  ['Order record currency','order_currency','order']
];
const verificationColumns = [
  ['Item verification','status','verification'], ['Verification source','source','verification'],
  ['Verification detail','reason','verification']
];
// A compact, Chinese-language export for the operational workbook. The
// detailed Tillroll columns remain hidden in this workbook so it stays linked
// to the same refresh and audit machinery.
const chinaColumns = [
  ['采购小票id','orderNumber','receipt'],
  ['采购时间','purchaseTime','receipt'],
  ['供应商','merchant','receipt'],
  ['品牌','brand','line'],
  ['品名','item','line'],
  ['品牌货号','itemId','line'],
  ['采购商品原价','unitPrice','line','money'],
  ['采购商品金额','amount','line','money'],
  ['采购商品方法','payment','receipt'],
  ['销售金额','saleAmount','derived','money']
];
const refreshReceiptHeader='Tillroll receipt key', refreshLineHeader='Tillroll line key';
const baselineHeader='Tillroll original values';
const editableColumns=receiptColumns.filter(([, ,scope='receipt'])=>scope==='receipt' || scope==='line');
function baselineParts(baseline) {
  const parts=[];
  let json=JSON.stringify(baseline);
  while (json.length>32767) {
    // Keep a surrogate pair together at Excel's text-cell limit.
    const end=/[\uD800-\uDBFF]/.test(json[32766]) ? 32766 : 32767;
    parts.push(json.slice(0,end));json=json.slice(end);
  }
  parts.push(json);
  return parts;
}
const esc = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g,'')
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const colName = n => n > 26 ? colName(Math.floor((n-1)/26)) + colName((n-1)%26+1) : String.fromCharCode(64+n);
function withoutCardDigits(value) {
  return String(value ?? '').replace(/\d[\d\s-]{11,}\d/g, ' ').replace(/\s+/g, ' ').trim();
}
function safeCardValue(value) {
  return String(maskCardField(value) ?? '').replace(/\d/g, '');
}
function exportData(receipts,includeRefresh=false) {
  const includeOrders = receipts.some(r => r.orders?.length);
  const columns = [...receiptColumns,...(includeOrders ? orderColumns : []),...verificationColumns];
  const rows = [];
  const exportKey=includeRefresh ? crypto.randomUUID() : null;
  let maxParts=0;
  for (const r of receipts) {
    if (!r.data) continue;
    const lines = r.data.items?.length ? r.data.items : [{}];
    lines.forEach((line,i) => {
      const prefix = 'items.' + i + '.';
      const {flags,messages} = reviewForLine(r,i);
      const photo = r.review?.photo?.[i] ?? {};
      const order = r.orders?.[i] ?? {};
      const verification=r.verification?.[i] ?? {};
      const verificationMismatch=verification.status!=='Manually cleared' &&
        (verification.status==='Verification error' || verification.status==='Previously flagged' || (verification.kind==='lookup' && !verification.skipped));
      const imported=r.origin==='achung';
      const originalNote=imported ? r.sourceNotes?.[i] : undefined;
      const orderIssue=orderNeedsReview(order) ? order.reason || order.status : '';
      const photoIssue=photo.status==='Needs review' ? photo.reason || photo.status : '';
      const earlierNotes=typeof originalNote==='string' ? [originalNote,photoIssue,orderIssue] : messages;
      const finalNote=verificationMismatch ? [verification.status,verification.reason].filter(Boolean).join(' · ') : '';
      const note=[...new Set([...earlierNotes,finalNote].filter(Boolean))].join('; ');
      const ref=r.reference || {};
      const suggested=ref.requiresReview ? ref.suggestion?.value : '';
      const alternatives=suggested ? [...new Set(ref.candidates.map(c=>c.value))].filter(v=>v!==suggested).join(' / ') : '';
      const sources = {
        receipt:r.record || r.data, line, photo, order, verification, meta:r,
        reference:suggested ? {...ref,reason:[ref.reason,ref.suggestion.reason].filter(Boolean).join(' ')} : ref,
        proposal:{suggested,alternatives},
        review:{message:note}
      };
      const baseline=includeRefresh ? {receipt:{},line:{},review:{},emptyReceipt:!r.data.items?.length,exportKey} : null;
      const cells=columns.map(([,key,source='receipt',type]) => {
        let value = sources[source]?.[key] ?? '';
        const numeric = type && value !== '' && Number.isFinite(Number(value));
        value = numeric ? Number(value) : String(value);
        if (key==='card') value = safeCardValue(value);
        else if (key==='payment' && !numeric) value = withoutCardDigits(value);
        if (baseline && (source==='receipt' || source==='line')) {
          const saved=numeric ? value : value.slice(0,32767).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g,'');
          baseline[source][key]=saved==='' ? null : saved;
        }
        const field = source === 'line' ? prefix+key : key;
        const fieldFlags=flags.filter(f=>f.field===field);
        if (imported && fieldFlags.length && (source==='receipt' || source==='line')) {
          const style=fieldFlags.some(f=>f.severity==='fix') ? 8 : 6;
          return {value,numeric,style:type==='money' ? style+1 : style};
        }
        if (source==='verification' && verification.status==='Verification error' && key!=='source')
          return {value,style:8};
        if (imported && source==='review' && value && !photoIssue && !orderIssue && !verificationMismatch) return {value,numeric,style:2};
        const flagged = fieldFlags.length || (source==='review' && value!=='' && (!imported || photoIssue || orderIssue || verificationMismatch))
          || (source==='verification' && verificationMismatch && key!=='source')
          || (imported && photoIssue && r.itemIdReadings?.length && source==='line' && key==='itemId')
          || (source==='proposal' && value!=='')
          || (source==='photo' && ['status','reason'].includes(key) && photo.status === 'Needs review')
          || (source==='order' && ['status','reason'].includes(key) && orderNeedsReview(order));
        if (baseline) {
          const reviewKey=source==='line' ? prefix+key : source==='verification' ? prefix+'verification.'+key : key;
          if (source==='receipt' || source==='line' || source==='verification') baseline.review[reviewKey]=Boolean(flagged);
        }
        return {value,numeric,style:flagged ? (type==='money' ? 5 : 4) : type==='money' ? 3 : 0};
      });
      if (baseline) columns.forEach(([,key,source='receipt'],index)=>{
        if (source==='receipt' || source==='line' || source==='verification') {
          const reviewKey=source==='line' ? prefix+key : source==='verification' ? prefix+'verification.'+key : key;
          if (!Object.hasOwn(baseline.review,reviewKey)) baseline.review[reviewKey]=cells[index]?.style>=4;
        }
      });
      if (includeRefresh) {
        const receiptKey=r.refreshKey??=crypto.randomUUID();
        const lineKey=r.data.items?.length ? (line.refreshKey??=crypto.randomUUID()) : (r.emptyLineRefreshKey??=crypto.randomUUID());
        const parts=baselineParts(baseline);
        maxParts=Math.max(maxParts,parts.length);
        for (const value of [receiptKey,lineKey,...parts]) cells.push({value,style:0});
      }
      rows.push(cells);
    });
  }
  if (rows.length > 1048575) throw new Error('This batch exceeds the number of item rows allowed in one Excel worksheet.');
  const visibleCount=columns.length;
  if (includeRefresh) {
    columns.push([refreshReceiptHeader],[refreshLineHeader],[baselineHeader]);
    for(let part=2;part<=maxParts;part++) columns.push([baselineHeader+' '+part]);
  }
  return {columns,rows,visibleCount};
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
  <cellXfs count="10">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>
    ${[3,4,5].map(fill=>'<xf numFmtId="0" fontId="0" fillId="'+fill+'" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="4" fontId="0" fillId="'+fill+'" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment vertical="top"/></xf>').join('')}
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
export async function buildXlsxBlob(receipts) {
  const {columns,rows,visibleCount} = exportData(receipts,true);
  const range = 'A1:'+colName(columns.length)+(rows.length+1);
  const rowXml = (number, cells) =>
    `<row r="${number}" ht="${excelRowHeight}" customHeight="1">${cells.map((cell,i)=>cellXml(number,i+1,cell)).join('')}</row>`;
  const header = rowXml(1, columns.map(([title])=>({value:title,style:1})));
  const contents = rows.map((row,i)=>rowXml(i+2,row)).join('');
  const widths = columns.map((_,i)=>
    `<col min="${i+1}" max="${i+1}" width="${excelColumnWidth}" customWidth="1"${i>=visibleCount?' hidden="1"':''}/>`).join('');
  const worksheet = XML + `<worksheet xmlns="${MAIN}"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" state="frozen" topLeftCell="A2" activePane="bottomLeft"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="${excelRowHeight}" defaultColWidth="${excelColumnWidth}"/><cols>${widths}</cols><sheetData>${header}${contents}</sheetData><autoFilter ref="${range}"/></worksheet>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml',XML+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file('_rels/.rels',XML+`<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml',XML+`<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Line items" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels',XML+`<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml',worksheet);
  zip.file('xl/styles.xml',styles);
  return new Blob([await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})],{type:WORKBOOK_MIME});
}

function purchaseTimeValue(data) {
  return [data.date,data.time].filter(Boolean).join(' ');
}
function saleAmountValue(line) {
  const unit=Number(line.unitPrice);
  if (Number.isFinite(unit)) return Math.round(unit*0.88*100)/100;
  const amount=Number(line.amount), qty=Number(line.qty);
  if (Number.isFinite(amount) && Number.isFinite(qty) && qty>0)
    return Math.round((amount/qty)*0.88*100)/100;
  return '';
}
function chinaExportData(receipts) {
  const detailed=exportData(receipts,true);
  const rows=[];
  let detailIndex=0;
  for (const r of receipts) {
    if (!r.data) continue;
    const lines=r.data.items?.length ? r.data.items : [{}];
    for (const line of lines) {
      const detail=detailed.rows[detailIndex++];
      const merchant=r.data.merchantDisplay||r.data.merchant||'';
      const receiptId=r.data.orderNumber||r.data.orderId||r.data.receiptReference||r.filename||'';
      const visible=chinaColumns.map(([title,key,scope,type])=>{
        let value='';
        if(scope==='receipt') value=key==='purchaseTime' ? purchaseTimeValue(r.data) : (key==='orderNumber' ? receiptId : r.data[key]??'');
        else if(scope==='line') value=line[key]??'';
        if(key==='payment') value=withoutCardDigits(value);
        if(key==='card') value=safeCardValue(value);
        if(scope==='derived' && key==='saleAmount') value=saleAmountValue(line);
        const numeric=type && value!=='' && Number.isFinite(Number(value));
        return {value:numeric?Number(value):String(value),numeric,style:type==='money'?3:0};
      });
      rows.push([...visible,...detail]);
    }
  }
  return {columns:[...chinaColumns,...detailed.columns],rows,visibleCount:chinaColumns.length};
}
export async function buildChinaXlsxBlob(receipts) {
  const {columns,rows,visibleCount}=chinaExportData(receipts);
  const range='A1:'+colName(columns.length)+(rows.length+1);
  const rowXml=(number,cells)=>`<row r="${number}" ht="${excelRowHeight}" customHeight="1">${cells.map((cell,i)=>cellXml(number,i+1,cell)).join('')}</row>`;
  const header=rowXml(1,columns.map(([title])=>({value:title,style:1})));
  const contents=rows.map((row,i)=>rowXml(i+2,row)).join('');
  const widths=columns.map((_,i)=>`<col min="${i+1}" max="${i+1}" width="${excelColumnWidth}" customWidth="1"${i>=visibleCount?' hidden="1"':''}/>`).join('');
  const worksheet=XML+`<worksheet xmlns="${MAIN}"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" state="frozen" topLeftCell="A2" activePane="bottomLeft"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="${excelRowHeight}" defaultColWidth="${excelColumnWidth}"/><cols>${widths}</cols><sheetData>${header}${contents}</sheetData><autoFilter ref="${range}"/></worksheet>`;
  const zip=new JSZip();
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
  return blob;
}
export function exportCSV(receipts) { return download(buildCsvBlob(receipts),'csv'); }
export async function exportExcel(receipts) { return download(await buildXlsxBlob(receipts),'xlsx'); }
export async function exportChinaExcel(receipts) { return download(await buildChinaXlsxBlob(receipts),'xlsx'); }

const aliases = {
  retailer:['retailer','source','merchant','store','mall','issuer'], order_id:['orderid','orderidentifier'],
  order_number:['ordernumber','orderno','order#'], brand:['brand','brandname'],
  item:['item','itemname','itemdescription','product','productname','description'],
  item_id:['itemid','productid','barcode','upc','upca','ean','ean8','ean13','gtin','gtin8','gtin12','gtin13','gtin14'],
  sku:['sku','stylesku','style','productcode','itemcode'], qty:['qty','quantity'],
  unit_price:['unitprice','priceperitem','priceperunit','unitamount'],
  amount:['amount','lineamount','linetotal','itemamount','extendedamount'],
  total:['purchasetotal','purchaseamount','receipttotal','ordertotal','totalpaid','amountpaid'],
  currency:['currency','currencycode'], weight:['weight','weightg','grams','grammes'],
  store_address:['storeaddress','branchaddress','address','location'], official_name:['officialname','officialitemname'],
  order_id_pattern:['orderidpattern','orderidformat'],
  order_number_pattern:['ordernumberpattern','ordernumberformat']
};
const keys = new Map(Object.entries(aliases).flatMap(([key,names])=>names.map(name=>[name,key])));
function orderSchema(headers) {
  const schema=new Map(), duplicates=[];
  const fields=headers.map(value=>String(value??'').toLowerCase().replace(/[^a-z0-9#]/g,''));
  const hasRetailer=fields.some(header=>['retailer','source','merchant','store'].includes(header));
  const catalogue=fields.some(header=>keys.get(header)==='item_id') &&
    !fields.some(header=>['order_id','order_number'].includes(keys.get(header)));
  fields.forEach((header,i)=>{
    if (hasRetailer && ['mall','issuer'].includes(header)) return;
    const key=catalogue && header==='price' ? 'unit_price' : keys.get(header);
    if (!key) return;
    if (schema.has(key)) duplicates.push(key);
    schema.set(key,i);
  });
  const orderLines=(schema.has('order_id') || schema.has('order_number')) &&
    (schema.has('item') || schema.has('sku') || schema.has('item_id'));
  const productList=schema.has('retailer') && schema.has('item_id');
  if (!orderLines && !productList) return null;
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
  if (records===null) throw new Error('Use Retailer and Item ID for a product list, or an order reference and Item, Item ID or SKU for an order list.');
  if (!records.length) throw new Error('The order list contains no item rows.');
  validateOrderPatterns(records);
  return records;
}

// The original 19 headers remain required. Some workbooks also include an item ID.
const achungColumns=receiptColumns.slice(0,receiptColumns.findIndex(c=>c[0]==='File')+1);
const achungItemId=achungColumns.find(c=>c[1]==='itemId');
const nativeReferences=new Set(['orderNumber','orderId','receiptReference','itemId','sku','card']);
function nativeValue(cell,column,book) {
  const key=column[1], value=cellValue(cell,book.strings,book.formats,nativeReferences.has(key));
  if (value==='') return null;
  if (column[3]) {
    const n=Number(value);
    if (!Number.isFinite(n)) throw new Error('Invalid number in receipt cell '+cell.getAttribute('r')+'.');
    return n;
  }
  const cellType=cell.getAttribute('t')??'n';
  if (cellType==='d' && (key==='date' || key==='time')) {
    // Some editors use an ISO date cell in place of an Excel serial.
    const iso=/^(?:(\d{4}-\d\d-\d\d)(?:T|$))?(?:(\d\d:\d\d)(?::(\d\d)(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?$/.exec(value);
    if (key==='date' && iso?.[1]) return iso[1];
    if (key==='time' && iso?.[2]) return iso[2]+(iso[3] && iso[3]!=='00'?':'+iso[3]:'');
    throw new Error('Invalid Excel date or time in '+cell.getAttribute('r')+'.');
  }
  if ((key==='date'||key==='time') && cellType==='n') {
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

const refreshColumns=[...editableColumns,['File','filename','meta'],[refreshReceiptHeader,'receiptKey','meta'],
  [refreshLineHeader,'lineKey','meta']];
// The compact export has editable Chinese labels. Its hidden detailed columns
// still provide the complete Tillroll baseline, while these descriptors let a
// user edit the visible operating table and have those values applied on
// refresh.
const chinaRefreshColumns = [
  ['采购小票id','receiptId','china'], ['采购时间','purchaseTime','china'],
  ['供应商','merchant','china'], ['品牌','brand','china'],
  ['品名','item','china'], ['品牌货号','itemId','china'],
  ['采购商品原价','unitPrice','china','money'],
  ['采购商品金额','amount','china','money'],
  ['采购商品方法','payment','china'], ['销售金额','saleAmount','derived','money']
];
const refreshUuid=/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const tillrollHeaders=new Set(['photo check','verification detail','reference finding']);
function plainReviewStyle(style,book){
  return [0,2,3].includes(style) || (style>=10 && book.reviewStyles?.[style]===null);
}

function refreshBaseline(parts,rowNumber) {
  let snapshot;
  try { snapshot=JSON.parse(parts.join('')); } catch {}
  if (typeof snapshot?.emptyReceipt!=='boolean' || !refreshUuid.test(snapshot.exportKey))
    throw new Error('Missing original receipt information in row '+rowNumber+'. Export a fresh workbook.');
  const baseline={receipt:{},line:{},review:snapshot.review && typeof snapshot.review==='object' ? snapshot.review : {},emptyReceipt:snapshot.emptyReceipt,exportKey:snapshot.exportKey};
  for (const [,key,scope='receipt',type] of editableColumns) {
    const fields=snapshot?.[scope];
    if (!fields || !Object.hasOwn(fields,key) || (fields[key]!==null &&
        (type ? !Number.isFinite(fields[key]) : typeof fields[key]!=='string'))) {
      throw new Error('The original Tillroll values in row '+rowNumber+' are damaged. Export a fresh workbook.');
    }
    baseline[scope][key]=fields[key];
  }
  return baseline;
}

export async function readTillrollEdits(file) {
  if (file?.name && !/\.xlsx$/i.test(file.name)) throw new Error('Choose an edited Tillroll Excel (.xlsx) export.');
  const book=await openWorkbook(file);
  const sheet=book.sheets.find(s=>s.getAttribute('name')?.toLowerCase()==='line items');
  if (!sheet) throw new Error('Choose a Tillroll Excel export with a Line items worksheet.');
  const [head,...rows]=await book.sheetRows(sheet);
  if (!head) throw new Error('The Line items worksheet is empty.');
  const schema=new Map(), seen=new Set(), parts=new Set();
  let tillroll=false, next=0;
  for (const cell of children(head,'c')) {
    const i=columnIndex(cell)??next; next=i+1;
    const title=cellValue(cell,book.strings,book.formats,false).trim().toLowerCase();
    if (tillrollHeaders.has(title)) tillroll=true;
    const part=/^tillroll original values(?: (\d+))?$/.exec(title);
    const column=part ? [title,Number(part[1]??1),'baseline'] : refreshColumns.find(c=>c[0].toLowerCase()===title) || chinaRefreshColumns.find(c=>c[0].toLowerCase()===title);
    if (!column) continue;
    if (schema.has(i) || seen.has(title) || (part && parts.has(column[1])))
      throw new Error('Repeated column in the Line items worksheet: '+title+'.');
    if (part) parts.add(column[1]);
    schema.set(i,column);seen.add(title);
  }
  const keyed=seen.has(refreshReceiptHeader.toLowerCase()) || seen.has(refreshLineHeader.toLowerCase()) || parts.size>0;
  if (!tillroll && !keyed) throw new Error('Choose a workbook exported by Tillroll.');
  const required=keyed ? refreshColumns : refreshColumns.filter(([title])=>title==='File' || title==='Item');
  for(const [title] of required) {
    if (!seen.has(title.toLowerCase())) throw new Error('Missing '+title+' column. Choose a complete Tillroll export.');
  }
  if (keyed && (!parts.has(1) || Math.max(...parts)!==parts.size))
    throw new Error('The workbook is missing Tillroll refresh data. Export a fresh workbook.');

  const result=[], lineKeys=new Set();
  let exportKey=null;
  for (const row of rows) {
    const rowNumber=Number(row.getAttribute('r')) || result.length+2;
    const entry={rowNumber,filename:null,receiptKey:null,lineKey:null,receipt:{},line:{},baseline:null,styles:{},clearedFields:[],china:{},chinaPresent:new Set()};
    const chunks=[], cells=new Map();
    next=0;
    for (const cell of children(row,'c')) {
      const index=columnIndex(cell)??next; next=index+1;
      if (cells.has(index)) throw new Error('Repeated cell in workbook row '+rowNumber+'.');
      cells.set(index,cell);
    }
    for (const [index,column] of schema) {
      const [,key,scope='receipt']=column;
      const cell=cells.get(index);
      const value=cell ? nativeValue(cell,column,book) : null;
      if (scope==='baseline') chunks[key-1]=value??'';
      else if (scope==='meta') entry[key]=value;
      else if (scope==='china') { entry.china[key]=value; entry.chinaPresent.add(key); entry.styles['china.'+key]=Number(cell?.getAttribute('s')||0); }
      else if (scope==='derived') { /* Recalculated on the next export. */ }
      else {
        entry[scope][key]=value;
        entry.styles[scope+'.'+key]=Number(cell?.getAttribute('s')||0);
      }
    }
    if (!entry.filename && !entry.receiptKey && !entry.lineKey && !chunks.some(Boolean) &&
        [...Object.values(entry.receipt),...Object.values(entry.line)].every(v=>v===null)) continue;
    if (!entry.filename) throw new Error('Missing receipt filename in workbook row '+rowNumber+'.');
    if (keyed) {
      if (!refreshUuid.test(entry.receiptKey) || !refreshUuid.test(entry.lineKey) || lineKeys.has(entry.lineKey))
        throw new Error('Missing, invalid or repeated Tillroll refresh key in row '+rowNumber+'. Use the original exported rows.');
      lineKeys.add(entry.lineKey);
      entry.baseline=refreshBaseline(chunks,rowNumber);
      if (exportKey && exportKey!==entry.baseline.exportKey)
        throw new Error('Row '+rowNumber+' belongs to a different Excel export. Refresh one workbook at a time.');
      exportKey=entry.baseline.exportKey;
    }
    if (entry.baseline?.review) {
      for (const [reviewKey,wasFlagged] of Object.entries(entry.baseline.review)) {
        if (!wasFlagged) continue;
        const suffix=/^items\.\d+\.(.+)$/.exec(reviewKey)?.[1];
        const style=entry.styles[reviewKey] ?? (suffix ? (entry.styles['line.'+suffix] ?? entry.styles[suffix]) : undefined);
        if (style!==undefined && plainReviewStyle(style,book)) entry.clearedFields.push(reviewKey);
      }
    }
    // Visible Chinese columns override hidden detailed values only when the
    // user changed them from the original export. This keeps edits made in
    // the hidden detailed columns intact and avoids converting a derived
    // receipt ID into an order number on every refresh.
    const originalReceipt=entry.baseline?.receipt||{};
    const originalLine=entry.baseline?.line||{};
    const originalId=originalReceipt.orderNumber||originalReceipt.orderId||originalReceipt.receiptReference||entry.filename||'';
    for (const key of entry.chinaPresent) {
      const value=entry.china[key];
      if (key==='receiptId') {
        if (String(value??'')!==String(originalId??'')) entry.receipt.orderNumber=value;
      } else if (key==='purchaseTime') {
        const originalTime=[originalReceipt.date,originalReceipt.time].filter(Boolean).join(' ');
        if (String(value??'').trim()!==String(originalTime??'').trim()) {
          const text=String(value??'').trim(), match=/^(\d{4}-\d\d-\d\d)(?:[ T]+(\d\d:\d\d(?::\d\d)?))?$/.exec(text);
          entry.receipt.date=match?.[1]??(text?'':null);
          entry.receipt.time=match?.[2]??(text?'':null);
        }
      } else if (key==='merchant' || key==='payment') {
        if (String(value??'')!==String(originalReceipt[key]??'')) entry.receipt[key]=value;
      } else if (['brand','item','itemId','unitPrice','amount'].includes(key)) {
        if (String(value??'')!==String(originalLine[key]??'')) entry.line[key]=value;
      }
    }
    if (entry.baseline?.review) {
      for (const key of entry.chinaPresent) {
        const style=entry.styles['china.'+key];
        if (style===undefined || !plainReviewStyle(style,book)) continue;
        const fields=key==='receiptId'?['orderNumber']:key==='purchaseTime'?['date','time']:
          key==='merchant'?['merchant']:key==='payment'?['payment']:
          ['brand','item','itemId','unitPrice','amount'].includes(key)
            ? Object.keys(entry.baseline.review).filter(field=>new RegExp('^items\\.\\d+\\.'+key+'$').test(field)) : [];
        for (const field of fields) if (entry.baseline.review[field]) entry.clearedFields.push(field);
      }
    }
    entry.clearedFields=[...new Set(entry.clearedFields)];
    delete entry.styles;
    delete entry.china; delete entry.chinaPresent;
    result.push(entry);
  }
  if (!result.length) throw new Error('The workbook has no receipt rows to refresh.');
  return {rows:result,exportKey};
}

const noteClues={
  orderNumber:/order[- ]number/i, orderId:/order[- ]id/i, merchant:/merchant|source of purchase/i,
  date:/\bdate\b/i, total:/\breceipt total\b|lines add up|\btotal is missing\b/i,
  item:/item name|description|repeated row/i, itemId:/item[- ]id|product[- ]id|barcode|\b(?:ean|upc|gtin)\b/i,
  amount:/line (?:total|amount)|[×]|quantity multiplied/i,
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
    const column=aliases.item_id.includes(title.replace(/[^a-z0-9]/g,''))
      ? achungItemId : achungColumns.find(c=>c[0].toLowerCase()===title);
    if (!column) continue;
    if (seen.has(column)) throw new Error('Repeated header in receipt workbook: '+column[0]+'.');
    seen.add(column);
    schema.set(columnIndex(cell)??schema.size,column);
  }
  const missing=achungColumns.filter(c=>c!==achungItemId && !seen.has(c));
  if (missing.length) throw new Error('Choose the Excel file exported by Achung. Missing '+missing.map(c=>c[0]).join(', ')+'.');
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
      const [,key,scope='receipt']=column;
      if (scope==='receipt') data[key]=values[key]??null;
      if (scope==='line') item[key]=values[key]??null;
    }
    const printed=parsePrintedItemId(item.item||'');
    let itemIdIssue='';
    if (printed) {
      const positional=printed.evidence==='position';
      // A trailing model number can belong to a description beside a separate
      // SKU. Preserve those words until the original photo provides evidence.
      const identified=!positional || !item.sku ||
        (item.item.trimStart().startsWith(printed.itemId) && item.sku!==printed.itemId);
      if (item.itemId===printed.itemId || (!item.itemId && identified)) {
        item.itemId=printed.itemId;
        item.item=printed.item;
      } else if (item.itemId && identified && printed.itemId!==item.sku) {
        itemIdIssue='Item ID '+item.itemId+' differs from the code '+printed.itemId+' beside the item name.';
      }
    }
    // Distinct purchases from photos with the same filename remain distinct.
    const signature=JSON.stringify([filename,data]);
    if (!groups.has(signature)) groups.set(signature,{filename,data:{...data,items:[]},rows:[]});
    const group=groups.get(signature), index=group.rows.length;
    group.data.items.push(item);
    for (const [title,key,scope='receipt'] of achungColumns) {
      const cell=cells.get(key), severity=cell && book.reviewStyles[Number(cell.getAttribute('s')??0)];
      if (severity && (scope==='receipt' || scope==='line'))
        marks.push({title,key,field:scope==='line'?'items.'+index+'.'+key:key,value:values[key],severity});
    }
    group.rows.push({note:values.message??'',marks,itemIdIssue});
  }
  if (!groups.size) throw new Error('The receipt workbook contains no receipt rows.');
  return Array.from(groups.values(),({filename,data,rows})=>({
    filename,data,flags:nativeFlags(rows).concat(rows.flatMap((row,i)=>row.itemIdIssue
      ? [{field:'items.'+i+'.itemId',message:row.itemIdIssue,severity:'check',escalate:false}] : [])),
    sourceNotes:rows.map(row=>[row.note,row.itemIdIssue].filter(Boolean).join('; '))
  }));
}
