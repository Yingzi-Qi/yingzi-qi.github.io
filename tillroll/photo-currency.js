export function currencyMarks(text) {
  const iso=text.toUpperCase().match(/\b(?:GBP|EUR|USD|CAD|AUD|NZD|CHF|CNY|JPY|SGD|MYR)\b/g) || [];
  if(text.includes('£'))iso.push('GBP');
  if(text.includes('€'))iso.push('EUR');
  if(/\bRM\s*\d/i.test(text))iso.push('MYR');
  if(/\bS\$\s*\d/i.test(text))iso.push('SGD');
  return [...new Set(iso)];
}
export function receiptCurrency(lines) {
  const all=lines.join('\n');
  const codes=currencyMarks(all);
  if(codes.length===1)return codes[0];
  // Only resolve a shared dollar symbol when the header includes a local postal address.
  if(!codes.length && all.includes('$') && lines.slice(0,10).some(line=>
    /\bSingapore\s+\d{6}\b/i.test(line)))return 'SGD';
  if(!codes.length && all.includes('$') && lines.slice(0,10).some(line=>
    /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+\d{5}(?:-\d{4})?\b/.test(line)))return 'USD';
  return null;
}
