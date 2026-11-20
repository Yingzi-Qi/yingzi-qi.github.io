export function isGtin(value) {
  if(typeof value!=='string')return false;
  if(!/^(?:\d{8}|\d{12,14})$/.test(value))return false;
  return [...value].reverse().reduce((sum,ch,i)=>sum+Number(ch)*(i%2?3:1),0)%10===0;
}
