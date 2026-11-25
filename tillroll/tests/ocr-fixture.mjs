// Build Tesseract-shaped OCR ({text, confidence, lines:[{text,x,y,w,h,confidence,words}]})
// from plain rows. Each row is a string or {text, x, h, confidence, gap}. Word boxes
// are laid out by character offset so that spatial rules can be exercised in tests.
export function makeOcr(rows, {charWidth = 0.018, lineHeight = 0.022, spacing = 0.012} = {}) {
  let y = 0.04;
  const lines = rows.map(row => {
    const spec = typeof row === 'string' ? {text: row} : row;
    const h = spec.h ?? lineHeight, confidence = spec.confidence ?? 0.95;
    y += spec.gap ?? 0;
    const x0 = spec.x ?? 0.06;
    const words = [];
    let offset = 0;
    for (const m of spec.text.matchAll(/\S+/g)) {
      offset = m.index;
      words.push({text: m[0], x: x0 + offset * charWidth, y, w: m[0].length * charWidth, h,
        confidence: spec.wordConfidence?.[m[0]] ?? confidence});
    }
    const line = {text: spec.text, x: x0, y, w: spec.text.length * charWidth, h, confidence, words};
    y += h + spacing;
    return line;
  });
  return {text: lines.map(l => l.text).join('\n'), confidence: 0.93, lines};
}
