// Operational rules for the two-stage receipt workflow.
export const reviewKinds = Object.freeze({reading:'reading',lookup:'lookup'});

const aliases = new Map([
  ['vca','Van Cleef & Arpels'],
  ['van cleef and arpels','Van Cleef & Arpels'],
  ['van cleef & arpels','Van Cleef & Arpels'],
  ['chanel accessory','Chanel'],
]);

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g,' ').trim();
const folded = value => clean(value).toLowerCase();

export function officialBrand(value) {
  const text=clean(value), known=aliases.get(folded(text));
  if (known) return known;
  if (/^chanel\s+(?:accessory|accessories)$/i.test(text)) return 'Chanel';
  return text;
}

export function removeBrandRedundancy(brand,item) {
  const original=clean(brand), canonical=officialBrand(original), description=clean(item);
  if (!canonical || !description) return description;
  const prefixes=[canonical,original].filter(Boolean).map(value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const prefix=new RegExp('^(?:'+prefixes.join('|')+')(?:\\s*[:|/-]\\s*|\\s+)', 'i');
  return description.replace(prefix,'').trim() || description;
}

export function normalizeReceiptData(data) {
  const next={...data};
  next.items=(data?.items || []).map(item=>{
    const row={...item};
    const originalBrand=clean(row.brand), canonical=officialBrand(originalBrand);
    const originalItem=clean(row.item), cleanedItem=removeBrandRedundancy(originalBrand,originalItem);
    if(originalBrand && canonical!==originalBrand)row.receiptBrand ??= originalBrand;
    if(originalItem && cleanedItem!==originalItem)row.receiptItem ??= originalItem;
    row.brand=canonical;
    row.item=cleanedItem;
    return row;
  });
  return next;
}

export function referenceHint(merchant) {
  const name=folded(merchant);
  if (name.includes('selfridges')) return 'For Selfridges, inspect the receipt number printed below the barcode.';
  if (name.includes('harrods')) return 'For Harrods, inspect the receipt or transaction reference beside the date and time on the right-hand side.';
  return '';
}

export function kindForFlag(flag) {
  if (flag?.kind==='reading' || flag?.kind==='lookup') return flag.kind;
  if (flag?.category==='lookup') return reviewKinds.lookup;
  if (flag?.category==='reading') return reviewKinds.reading;
  if (flag?.stage==='Order comparison' || flag?.stage==='Product lookup' || flag?.stage==='Independent reference') return reviewKinds.lookup;
  const message=folded(flag?.message);
  if (/lookup|catalogue|order list|independent reference|official name|near[- ]price|candidate brand|candidate item|retailer has no configured/.test(message)) return reviewKinds.lookup;
  return reviewKinds.reading;
}

export function kindForVerification(result) {
  if (result?.kind==='reading' || result?.kind==='lookup') return result.kind;
  const source=folded(result?.source);
  return source.includes('receipt photo') ? reviewKinds.reading : reviewKinds.lookup;
}
