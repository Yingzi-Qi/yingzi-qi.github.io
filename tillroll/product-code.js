export function isGtin(value) {
  if(typeof value!=='string')return false;
  if(!/^(?:\d{8}|\d{12,14})$/.test(value))return false;
  return [...value].reverse().reduce((sum,ch,i)=>sum+Number(ch)*(i%2?3:1),0)%10===0;
}

// Retailer item numbers need not be GTINs. Restrict unlabelled numbers to whole
// tokens and leave likely years, counts, measurements and card/date fragments alone.
export function isPrintedItemNumber(value) {
  return typeof value==='string' && /^\d{4,14}$/.test(value) && !/^0+$/.test(value) &&
    !/^(?:19|20)\d{2}$/.test(value);
}
const codeLabel='(?:item\\s*(?:id|code|no\\.?|number|#)|product\\s*(?:id|code)|article\\s*(?:id|code)|upc|ean|gtin|barcode)';
const labelledPrefix=new RegExp('^'+codeLabel+'\\s*[:#=]?\\s*([\\w./-]+)\\s+(.*)$','i');
const labelledSuffix=new RegExp('^(.+?)\\s+'+codeLabel+'\\s*[:#=]?\\s*([\\w./-]+)$','i');
const edgeDivider=/^[\s|:;–—#-]+|[\s|:;–—#-]+$/g;
const notAnItem=/^(?:order|reference|ref|receipt|invoice|transaction|terminal|register|member(?:ship)?|loyalty|card|visa|payment|tax|total|sub\s*total|cash|date|time|qty|quantity|price|amount|discount)\b/i;
const measure=/^(?:x|pcs?|pack|pieces?|count|mah|ml|cl|l|g|kg|mg|oz|mm|cm|gb|tb|w|v|dpi|lumens?|watts?)\b/i;
const describesNumber=/(?:^|\s)(?:sku|style|model|series|size|qty|quantity|shade|colour|color|spf|capacity|year|vintage|lot|order|ref|reference|tel|card|ending)(?:\s*(?:no\.?|number|id|in))?\s*[:#-]?$/i;
const hasName=item=>/\p{L}{2}/u.test(item) && !notAnItem.test(item) &&
  !/^[A-Z]{1,6}[-/]?\d+(?:[-/]\d+)*$/.test(item);
function parsed(code,item,evidence) {
  const description=item.replace(edgeDivider,'').trim();
  return hasName(description) ? {itemId:code,item:description,evidence} : null;
}
export function parsePrintedItemId(value) {
  const text=String(value??'').trim();
  const prefix=labelledPrefix.exec(text), suffix=labelledSuffix.exec(text);
  if(prefix && (/\d/.test(prefix[1]) || /[:#=]/.test(text) && /^[A-Z]{2,}$/.test(prefix[1])))
    return parsed(prefix[1],prefix[2],'label');
  if(suffix && (/\d/.test(suffix[2]) || /[:#=]/.test(text) && /^[A-Z]{2,}$/.test(suffix[2])))
    return parsed(suffix[2],suffix[1],'label');
  const start=/^(?:([0-9]{1,2})\s+)?(\d{4,14})(\s+[|:;–—-]\s*|\s+|[|:;–—]\s*)(.+)$/u.exec(text);
  const end=/^(.+?)(\s+[|:;–—-]\s*|\s+|[|:;–—]\s*)(\d{4,14})$/u.exec(text);
  const leading=start && isPrintedItemNumber(start[2]) && !measure.test(start[4]) &&
    !/^\d+[.,]\d/.test(start[4]) && parsed(start[2],start[4],edgeEvidence(start[2],start[3]));
  const trailing=end && isPrintedItemNumber(end[3]) && !describesNumber.test(end[1]) &&
    !/\d[/.:,-]$/.test(end[1]) && parsed(end[3],end[1],edgeEvidence(end[3],end[2]));
  if(leading && trailing) return leading.itemId===trailing.itemId
    ? parsed(leading.itemId,end[1].slice(start[0].length-start[4].length),'position') : null;
  return leading || trailing || null;
}
function edgeEvidence(value,separator) {
  if(isGtin(value))return 'barcode';
  return /[^\s]|\s{2}/.test(separator) ? 'separator' : 'position';
}
