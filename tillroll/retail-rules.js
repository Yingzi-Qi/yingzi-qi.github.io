// The original Tillroll demonstration uses these order numbers in its example data.
const demoNumbers = {
  'harrods':'HRD########', 'selfridges':'SLF-#########', 'harvey nichols':'HN#######',
  'liberty london':'LIB#######', 'liberty':'LIB#######', 'fortnum & mason':'FM-########',
  'flannels':'FL#########', 'net-a-porter':'####-######-####', 'bicester village':'BV########'
};
const fields = {orderId:'order_id_pattern',orderNumber:'order_number_pattern'};
const issuer = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g,' ');

export function validateOrderPatterns(rows) {
  for (const row of rows) {
    for (const column of Object.values(fields)) {
      const pattern=String(row[column] ?? '').trim();
      if (!pattern) continue;
      if (!issuer(row.retailer)) throw new Error('A retailer or mall is required for each reference pattern.');
      if (pattern.length>80 || !/^[A-Za-z0-9#./_-]+$/.test(pattern) || !pattern.includes('#'))
        throw new Error('Invalid '+column.replaceAll('_',' ')+' for '+row.retailer+'. Use # for each digit and literal letters, numbers or separators, for example WEB-######.');
    }
  }
}

function matchesTemplate(value, template) {
  return value.length===template.length && [...template].every((char,i)=>
    char==='#' ? /[0-9]/.test(value[i]) : char===value[i]);
}

// A retailer can issue multiple formats. An explicit rule for one field never applies to the other.
export function referenceFormat(merchant, field, orders, demo=false) {
  const key=issuer(merchant);
  if (!key || !Object.hasOwn(fields,field)) return null;
  const patterns=new Set();
  for (const row of orders || []) {
    const p=String(row[fields[field]] ?? '').trim();
    if (p && issuer(row.retailer)===key) patterns.add(p);
  }
  let source='imported';
  if (!patterns.size && demo && field==='orderNumber' && Object.hasOwn(demoNumbers,key)) {
    patterns.add(demoNumbers[key]);source='demo';
  }
  if (!patterns.size) return null;
  const templates=[...patterns];
  return {source,description:templates.join(' or '),test:value=>templates.some(p=>matchesTemplate(value,p))};
}
