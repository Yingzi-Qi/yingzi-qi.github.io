import {validCalendarDate} from './purchase-date.js?v=8';

const calendar = new Intl.DateTimeFormat('en-GB', {
  day:'numeric', month:'short', year:'numeric', timeZone:'UTC'
});

function purchaseDay(data) {
  return !data?.dateIssue && validCalendarDate(data?.date) ? data.date : '';
}

export function purchaseDateText(data) {
  const day=purchaseDay(data);
  if(day)return calendar.format(new Date(day+'T00:00:00Z'));
  return data?.dateIssue || data?.date ? 'Check date' : 'Date unknown';
}

function secondsAfterMidnight(value) {
  const parts=/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*(AM|PM)?$/i.exec(String(value??'').trim());
  if(!parts)return Infinity;
  let hour=Number(parts[1]);
  if(parts[4]){
    if(hour<1 || hour>12)return Infinity;
    hour=hour%12 + (parts[4].toUpperCase()==='PM'?12:0);
  }else if(hour>23)return Infinity;
  return hour*3600+Number(parts[2])*60+Number(parts[3]||0);
}

export function oldestPurchaseFirst(a,b) {
  const first=purchaseDay(a.data), second=purchaseDay(b.data);
  if(first!==second){
    if(!first)return 1;
    if(!second)return -1;
    return first.localeCompare(second);
  }
  if(first){
    const times=secondsAfterMidnight(a.data.time)-secondsAfterMidnight(b.data.time);
    if(times)return times;
  }
  return a.id-b.id;
}
