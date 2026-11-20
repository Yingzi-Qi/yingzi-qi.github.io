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

// A barcode detail row can contain a quantity, a currency and a tax marker.
// Discard low-confidence OCR noise only when identifying this narrow layout.
export function printedBarcodeDetail(line) {
  if (!line?.text) return null;
  const words=line.words?.length ? line.words.filter(word=>word.confidence>=.65)
    : Number(line.confidence)>=.8 ? [{text:line.text}] : [];
  const text=words.map(word=>word.text).join(' ').trim();
  const match=text.match(/^[^\p{L}\p{N}]*?(\d{8}|\d{12,14})(?=\s|$)(.*)$/u);
  if (!match || !isPrintedItemNumber(match[1]) || !isGtin(match[1])) return null;
  const rest=match[2].trim();
  if (rest && !/^(?:(?:\d{1,3}\s+)?(?:[€£$]\s*)?\d+(?:[.,]\d{2})?(?:\s*(?:EUR|USD|GBP|CAD|[€£$]))?(?:\s+[a-z*])?|[a-z*])$/i.test(rest)) return null;
  return {id:match[1],hasQuantityOrPrice:/\d/.test(rest)};
}

// Some receipts print every barcode below its description. The last pair ends
// directly at the purchase summary. This establishes the direction of the block
// even when OCR misses the price column or one of two repeated item names.
export function barcodesBelowNames(lines) {
  const summary=/^(?:(?:sub\s*)?total\b|(?:objets?\s+vendus?|items?\s+sold|number\s+of\s+items)\b)/i;
  const possibleName=line=>line && /\p{L}{2}/u.test(line.text) &&
    !notAnItem.test(line.text.trim()) && !summary.test(line.text.trim()) &&
    !/^(?:style|sku|size|brand|upc|ean|barcode)\s*[:#]/i.test(line.text.trim());
  const close=(a,b)=>a && b && (!Number.isFinite(a.y) || !Number.isFinite(b.y) ||
    b.y-a.y-a.h<=Math.min(.07,2.5*Math.max(a.h,b.h)));
  const details=lines.map(printedBarcodeDetail);
  const found=new Set();
  for(let i=1;i+1<lines.length;i++){
    if(!details[i] || !summary.test(lines[i+1].text.trim().replace(/^[^\p{L}]+/u,'')))continue;
    const block=[];
    for(let j=i;j>=1 && details[j] && possibleName(lines[j-1]) && close(lines[j-1],lines[j]);){
      block.push(j);
      let previous=j-2;
      // An unpriced description may have lost its identifier entirely.
      if(previous>0 && !details[previous] && possibleName(lines[previous]))previous--;
      if(previous<1 || !close(lines[previous],lines[previous+1]))break;
      j=previous;
    }
    if(block.length>=2)for(const j of block)found.add(j);
  }
  return found;
}
