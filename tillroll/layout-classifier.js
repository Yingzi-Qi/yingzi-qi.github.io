// The first printed masthead identifies the retailer. A location, a body brand,
// or a merchant supplied by a structured reader cannot identify the layout.
import { isBarcodeLine } from './receipt-rules.js';

const referenceLabel = /^(?:receipt|transaction|sales?\s+receipt|ticket)\s*(?:no\.?|number|id|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]*)\s*$/i;
const boutiqueReference = /^(?=.{4,28}$)(?=.*\d)[A-Z0-9]+(?:[-/][A-Z0-9]+)*$/i;
const layouts = [
  {layout:'harrods', retailer:'Harrods', header:/^HARRODS(?:\s+(?:LONDON|KNIGHTSBRIDGE))?$/i, id:/^NT\d{4}-\d{6}$/},
  {layout:'selfridges', retailer:'Selfridges', header:/^SELFRIDGES(?:\s+(?:&\s*CO\.?|LONDON))?$/i, id:/^\d{12,16}$/},
  {layout:'chanel-boutique', retailer:'Chanel', header:/^CHANEL(?:\s*(?:\/|-)\s*(?:LONDON|PARIS)|\s+BOUTIQUE)?$/i, id:boutiqueReference},
  {layout:'watches-of-switzerland', retailer:'Watches of Switzerland', header:/^WATCHES\s+OF\s+SWITZERLAND(?:\s+LONDON)?$/i, id:boutiqueReference},
];
export const supportedLayouts = Object.freeze(layouts.map(entry => entry.layout));
const wording = line => String(line?.text || '').trim().replace(/\s+/g, ' ');
export function validLayoutReceiptId(layout, value) {
  return typeof value === 'string' && Boolean(layouts.find(entry => entry.layout === layout)?.id.test(value));
}

function knownStructure(layout, lines) {
  const text = lines.map(wording);
  switch (layout) {
    case 'harrods': return text.some(line => /\bNT\d{4}-\d{6}\b/.test(line) || /^\d{4}\s+\d{10}\b/.test(line));
    case 'selfridges': return lines.some(line => isBarcodeLine(line)) || text.some(line => referenceLabel.test(line));
    case 'chanel-boutique': return text.some(line => /\b[A-Z]{1,3}\d{4,6}\b/.test(line) || referenceLabel.test(line));
    case 'watches-of-switzerland': return text.some(line => /\b(?:sku|style|product\s*(?:id|code)|item\s*(?:no|id)|model|ref(?:erence)?)\s*[:#]?\s*[A-Z0-9-]*\d/i.test(line) || referenceLabel.test(line));
  }
  return false;
}

export function classifyLayout(ocr) {
  const lines = ocr?.lines || [];
  const header = lines.map(wording).find(line => /\p{L}/u.test(line)) || '';
  const match = layouts.find(entry => entry.header.test(header));
  if (match && knownStructure(match.layout, lines)) return {status:'known', layout:match.layout, retailer:match.retailer, anchors:2, confidence:1};
  const reason = match ? 'The retailer masthead is present, but the receipt layout anchor is missing.' : 'The first masthead does not identify a supported retailer.';
  return {status:'unknown', layout:null, retailer:null, anchors:match ? 1 : 0, confidence:0, reason};
}

export function receiptReferenceForLayout(layout, lines) {
  const candidates = new Set();
  let doubtful = false;
  function observe(line, value) {
    const word = line?.words?.find(word => word.text === value);
    if (!validLayoutReceiptId(layout, value) || Number(word?.confidence ?? line?.confidence ?? 1) < .8) doubtful = true;
    else candidates.add(value);
  }
  for (const [index, line] of lines.entries()) {
    const text = wording(line);
    if (layout === 'harrods') {
      const dated = /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s+\d{1,2}[:.]\d{2}(?::\d{2})?\s+(.+)$/i.exec(text);
      if (dated) observe(line, dated[1]);
      // OCR frequently separates the Harrods reference from the date/time
      // line even though both are printed on the same header row. The fixed
      // NT format is safe to promote wherever it appears in the receipt.
      const separated = text.match(/\bNT\d{4}-\d{6}\b/i);
      if (separated) observe(line, separated[0]);
    } else if (layout === 'selfridges') {
      if (isBarcodeLine(line) && lines[index + 1]) observe(lines[index + 1], wording(lines[index + 1]));
    } else {
      const labelled = referenceLabel.exec(text);
      if (labelled) observe(line, labelled[1]);
    }
  }
  return !doubtful && candidates.size === 1 ? [...candidates][0] : null;
}
