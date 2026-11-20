// Capture line warnings once, before the post-output check or any later reference upload.
export function captureLineWarnings(receipt) {
  return receipt.data.items.map((_,index)=>{
    const prefix='items.'+index+'.';
    const warnings=[];
    for (const flag of receipt.review.flags) {
      if (flag.severity==='info' || !flag.field.startsWith(prefix) || flag.field===prefix+'photo') continue;
      let stage=flag.stage || 'Receipt checks';
      if (receipt.origin==='achung') stage='Achung workbook';
      else if (receipt.readingConflicts?.some(f=>f.field===flag.field && f.message===flag.message)) stage='Comparison of the two readings';
      else if (flag.message.startsWith('Hard to read')) stage='Photo reader';
      else if (flag.message.startsWith('Quantity multiplied')) stage='Receipt arithmetic';
      warnings.push({stage,message:flag.message});
    }
    const photo=receipt.review.photo[index];
    const photoIssue=receipt.origin==='achung' && photo?.status==='Needs review' ? photo.reason : photo?.lineIssue;
    if (photoIssue) warnings.push({stage:'Photo check',message:photoIssue});
    const orderIssue=receipt.orders?.[index]?.lineIssue;
    if (orderIssue) warnings.push({stage:'Order comparison',message:orderIssue});
    return warnings;
  });
}

const labels={verified:'Verified',partial:'Partially verified',unchecked:'Not verified'};

export function classifyVerification(result,earlier=[]) {
  if (result.status!=='mismatch') return {...result,status:labels[result.status]};
  const history=earlier.length
    ? 'Earlier warnings on this line: '+[...new Set(earlier.map(w=>w.stage+' — '+w.message))].join(' ')
    : 'The earlier checks raised no warning on this line.';
  return {...result,status:earlier.length?'Previously flagged':'Verification error',reason:result.reason+' '+history};
}

export const hasVerificationMismatch=line=>line?.status==='Verification error' || line?.status==='Previously flagged';
