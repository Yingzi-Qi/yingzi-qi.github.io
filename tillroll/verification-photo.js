import {currencyMarks,receiptCurrency} from './photo-currency.js';
import {readPrintedProductRows,readPrintedAmounts,nearbyPrintedRows} from './extract.js?v=discounts1';

const fields=['item','brand','amount','unitPrice','qty','currency'];
const fold=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const tokenText=value=>fold(value).replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const includesPhrase=(haystack,needle)=>Boolean(needle && (' '+tokenText(haystack)+' ').includes(' '+tokenText(needle)+' '));
const unique=values=>[...new Set(values)];
const has=value=>value!==null && value!==undefined && value!=='';

function readLine(line) {
  const words=line.words?.length ? line.words : [{text:line.text,confidence:line.confidence}];
  return {
    text:words.map(w=>w.text).join(' '),
    clear:words.map(w=>w.confidence>=.80 ? w.text : '�'.repeat(w.text.length)).join(' ')
  };
}
function visiblePrices(line) {
  return readPrintedAmounts(line.text).map(({value,start,end})=>
    line.clear.slice(start,end)===line.text.slice(start,end) ? value : null);
}
function idEvidence(ocr,lines,entry) {
  const {item,nameLine,priceLine,idLine}=entry;
  const escaped=item.itemId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const code=new RegExp('(?<![\\p{L}\\p{N}/-])'+escaped+'(?![\\p{L}\\p{N}/-])','u');
  const nearby=unique([idLine,priceLine,nameLine,Math.min(nameLine,priceLine)-1,Math.max(nameLine,priceLine)+1])
    .filter(i=>Number.isInteger(i) && i>=0 && i<lines.length);
  // Recovered adjoining codes may have no heading. Never use digits from other
  // product or transaction lines just because they also appear on the receipt.
  for(const i of nearby){
    const clear=lines[i].clear.trim();
    if(!code.test(clear))continue;
    if(i===idLine || i===nameLine || i===priceLine)return i;
    if(clear!==item.itemId)continue;
    const anchor=i<nameLine ? Math.min(nameLine,priceLine) : Math.max(nameLine,priceLine);
    if(nearbyPrintedRows(ocr.lines[Math.min(i,anchor)],ocr.lines[Math.max(i,anchor)]))return i;
  }
  return null;
}
function readPhoto(ocr) {
  if(!ocr?.lines?.length)return [];
  const lines=ocr.lines.map(readLine), defaultCurrency=receiptCurrency(lines.map(line=>line.clear)), rows=[];
  for(const entry of readPrintedProductRows(ocr)){
    const {item:product,nameLine,priceLine,unitLine,header}=entry;
    if(!product.itemId)continue;
    const idAt=idEvidence(ocr,lines,entry);
    if(idAt===null)continue;
    const description=lines[nameLine], price=lines[priceLine], unit=lines[unitLine];
    let item=includesPhrase(description.clear,product.item) ? product.item : null;
    const heading=lines[header]?.clear || '';
    // A shop logo and a word separated by whitespace do not establish a brand.
    let brand=/\bbrand\b/i.test(heading) && includesPhrase(description.clear,product.brand) ? product.brand : null;
    const named=description.clear.match(/\bbrand\s*:\s*([^|:]+?)\s+(?:[|–-]\s*)?(?:item(?: name)?|description)\s*:\s*(.+)$/i);
    if(named){
      const beforePrice=named[2].slice(0,readPrintedAmounts(named[2])[0]?.start).trim();
      const cleaned=beforePrice.split(/\s+/).filter(t=>t!==product.itemId).join(' ').trim();
      if(!/[�]/.test(named[1]) && !/[�]/.test(cleaned) && cleaned){
        brand=named[1].trim();
        item=cleaned;
      }
    }
    const money=visiblePrices(price), unitMoney=unit===price ? money : visiblePrices(unit);
    // Use the exact position on the price line, even if a neighbouring monetary
    // token has the same value. A poorly read total cannot borrow its confidence.
    const ambiguousPrice=product.qty>1 && /\bprice\b/i.test(heading) && !/\b(?:amount|total)\b/i.test(heading) && money.length===1;
    const amount=!ambiguousPrice && product.amount!=null && product.amount===money.at(-1) ? product.amount : null;
    const unitSlot=unit!==price ? unitMoney[0] : unitMoney.at(-2);
    const unitPrice=product.unitPrice!=null && product.unitPrice===unitSlot ? product.unitPrice : null;
    const unitText=unit.clear;
    const qtyMatch=unitText.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*[@×x](?:\s|$)/i);
    const hasQtyHeading=/\b(qty|quantity)\b/i.test(heading);
    const qty=product.qty!=null && (qtyMatch && Number(qtyMatch[1].replace(',','.'))===product.qty ||
      hasQtyHeading && includesPhrase(unitText,String(product.qty))) ? product.qty : null;
    const here=currencyMarks(price.clear+' '+unit.clear);
    let currency=here.length===1 ? here[0] : here.length ? null : defaultCurrency;
    if((price.clear+unit.clear).includes('$') && !['USD','CAD','AUD','NZD','SGD'].includes(currency))currency=null;
    const evidence=unique([idAt,nameLine,priceLine,unitLine]).sort((a,b)=>a-b).map(i=>lines[i].text).join(' | ');
    rows.push({itemId:product.itemId,item,brand,amount,unitPrice,qty,currency,evidence});
  }
  return rows;
}

// Reads from the same receipt can corroborate the printing; they cannot certify a retailer's records.
export function photoVerificationRows(readings,{requireAgreement=false}={}) {
  const passes=unique((readings || []).filter(r=>r?.lines?.length));
  if(requireAgreement && passes.length<2)return [];
  const grouped=new Map();
  for(const [pass,ocr] of passes.entries()){
    for(const row of readPhoto(ocr)){
      if(!grouped.has(row.itemId))grouped.set(row.itemId,[]);
      grouped.get(row.itemId).push({row,pass});
    }
  }
  const joined=[];
  for(const [itemId,matches] of grouped){
    if(requireAgreement && new Set(matches.map(m=>m.pass)).size<2)continue;
    const result={itemId,source:'Receipt photo',evidence:unique(matches.map(m=>m.row.evidence)).join(' / '),conflicts:[]};
    for(const field of fields){
      const present=matches.filter(m=>has(m.row[field]));
      const alternatives=unique(present.map(m=>fold(m.row[field])));
      const corroborated=!requireAgreement || new Set(present.map(m=>m.pass)).size>=2;
      result[field]=alternatives.length===1 && corroborated ? present[0].row[field] : null;
      if(alternatives.length>1)result.conflicts.push(field);
    }
    joined.push(result);
  }
  return joined;
}
