const months = [
  'jan january janv janvier januar', 'feb february fev fevr fevrier februar',
  'mar march mars marz maerz', 'apr april avr avril', 'may mai', 'jun june juin juni',
  'jul july juil juillet juli', 'aug august aout', 'sep sept september septembre',
  'oct october octobre okt oktober', 'nov november novembre', 'dec december decembre dez dezember'
];
const monthNumber=new Map(months.flatMap((terms,i)=>terms.split(' ').map(s=>[s,i+1])));
const words=[...monthNumber.keys()].sort((a,b)=>b.length-a.length).join('|');
const namedDate=new RegExp('\\b(?:(\\d{1,2})[ .-]+('+words+')[., -]+((?:19|20)\\d{2})|('+words+')[ .-]+(\\d{1,2})(?:st|nd|rd|th)?[., -]+((?:19|20)\\d{2}))\\b','gi');
const weekdayNames=['sun sunday dim dimanche so sonntag','mon monday lun lundi mo montag','tue tuesday mar mardi di dienstag','wed wednesday mer mercredi mi mittwoch','thu thursday jeu jeudi do donnerstag','fri friday ven vendredi fr freitag','sat saturday sam samedi sa samstag'];
const weekdays=new Map(weekdayNames.flatMap((names,day)=>names.split(' ').map(name=>[name,day])));
// Some tills print weekday, month, day, time, then year. OCR can join the clock digits.
const tillTimestamp=new RegExp('\\b('+[...weekdays.keys()].join('|')+')\\.?\\s+('+words+')\\.?\\s+(\\d{1,2})\\s+(?:\\d{1,2}:\\d{2}(?::\\d{2})?|\\d{5,8})\\s+((?:19|20)\\d{2})\\b','gi');
const digitsDate=/(?<![\p{L}\d_/-])(?:(\d{4})([-/.])(\d{1,2})\2(\d{1,2})|(\d{1,2})([-/.])(\d{1,2})\6((?:19|20)\d{2}|\d{2}))(?![\p{L}\d_/-])/gu;
const pad=value=>String(value).padStart(2,'0');

export function validCalendarDate(value) {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10)===value;
}

function formatOn(line) {
  const sep='[ ./-]';
  if (new RegExp('\\b(?:dd|jj|tt)'+sep+'mm'+sep+'(?:yy|aa|jj)','i').test(line)) return 'day';
  if (new RegExp('\\bmm'+sep+'dd'+sep+'yy','i').test(line)) return 'month';
  return '';
}
function possibleDates(year,day,month,swap=false) {
  const y=String(year).length===2 ? (Number(year)>=70 ? '19' : '20')+year : year;
  const values=[y+'-'+pad(month)+'-'+pad(day)];
  if (swap && Number(day)!==Number(month)) values.push(y+'-'+pad(day)+'-'+pad(month));
  return values.filter(validCalendarDate);
}
const otherDate=/\b(?:return(?:s)?\s+(?:by|before|until|date|deadline)|expir\w*(?:\s+date)?|valid\s+(?:until|through)|best\s+before|use\s+by|delivery\s+date|ship(?:ping|ment)?\s+date|date\s+of\s+birth|birth\w*(?:\s+date)?|member\s+since|due\s+date|print(?:ed)?\s+(?:on|date))\b/gi;
const dateLabel=/\b(?:(?:purchase|transaction|sale|sales|invoice)\s+date|date\s+(?:of\s+(?:purchase|sale)|d'achat)|purchased\s+on|date|datum)\b/gi;
const structure=/\b(?:transaction|sale|purchase|date|datum|time|heure|ticket|receipt)\b|\b\d{1,2}:\d{2}\b/i;
const identifierPrefix=/\b(?:sku|barcode|ean|upc|style|product|item|order\s*(?:id|number|no)|lot|batch|serial)\s*[:#-]?\s*$/i;

function contextScore(line,index) {
  const prefix=line.slice(0,index);
  if (identifierPrefix.test(prefix)) return 0;
  const excluded=[...prefix.matchAll(otherDate)].at(-1);
  const labelled=[...prefix.matchAll(dateLabel)].at(-1);
  if (excluded && (!labelled || labelled.index<excluded.index+excluded[0].length)) return 0;
  if (labelled) return /^(?:date|datum)$/i.test(labelled[0]) ? 3 : 4;
  // A non-purchase date label may also follow the value.
  if (/\b(?:expir\w*|best before|return deadline|valid until)\b/i.test(line.slice(index))) return 0;
  return structure.test(line) ? 2 : 1;
}

export function readPurchaseDate(text) {
  const lines=String(text ?? '').normalize('NFD').replace(/\p{M}+/gu,'').split(/\r?\n/);
  const candidates=[];
  for (const [i,line] of lines.entries()) {
    const add=(match,values,issue=null)=>{
      const prior=lines[i-1]?.trim() || '';
      const separateLabel=match.index===line.search(/\S/) && /(?:\bdate|\bdatum|\bexpiry|\bby|\buntil)\s*[:#-]?$/i.test(prior);
      const score=separateLabel ? contextScore(prior+' '+line,prior.length+1+match.index) : contextScore(line,match.index);
      if (score) candidates.push({score,printed:match[0],values,issue});
    };
    for (const m of line.matchAll(tillTimestamp)) {
      const values=possibleDates(m[4],m[3],monthNumber.get(m[2].toLowerCase()));
      const disagree=values.length && new Date(values[0]+'T00:00:00Z').getUTCDay()!==weekdays.get(m[1].toLowerCase());
      add(m,disagree?[]:values,disagree?'The printed weekday and calendar date disagree ('+m[0]+').':null);
    }
    for (const m of line.matchAll(namedDate)) {
      const month=monthNumber.get((m[2]||m[4]).toLowerCase());
      add(m,possibleDates(m[3]||m[6],m[1]||m[5],month));
    }
    for (const m of line.matchAll(digitsDate)) {
      if (m[1]) {add(m,possibleDates(m[1],m[4],m[3]));continue;}
      const format=formatOn(line) || formatOn(lines[i-1]||'');
      add(m,format==='month' ? possibleDates(m[8],m[7],m[5]) : possibleDates(m[8],m[5],m[7],format!=='day'));
    }
  }
  if (!candidates.length) return {date:null,issue:null};
  const highest=Math.max(...candidates.map(c=>c.score));
  const chosen=candidates.filter(c=>c.score===highest);
  const issue=chosen.find(c=>c.issue)?.issue;
  if (issue) return {date:null,issue};
  const printed=[...new Set(chosen.map(c=>c.printed))].slice(0,4).join(' / ');
  if (chosen.some(c=>!c.values.length)) return {date:null,issue:'Invalid calendar date on the receipt ('+printed+').'};
  const possible=chosen[0].values.filter(v=>chosen.every(c=>c.values.includes(v)));
  if (possible.length===1) return {date:possible[0],issue:null};
  if (!possible.length) return {date:null,issue:'Different possible purchase dates were read ('+printed+').'};
  // An unambiguous rendering elsewhere on the slip can settle the order of day and month.
  const supporting=new Set(candidates.filter(c=>c.score<highest && c.values.length===1 && possible.includes(c.values[0])).map(c=>c.values[0]));
  if (supporting.size===1) return {date:[...supporting][0],issue:null};
  return {date:null,issue:'Day and month are ambiguous in the printed date ('+printed+').'};
}
