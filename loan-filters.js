export function loanStatus(x,today){if(x.remaining===0)return '已歸還';if(x.dueDate<today)return '逾期';if(x.remaining<x.quantity)return '部分歸還';return '未歸還'}
export function filterLoans(rows,f,today){const q=(f.search||'').trim().toLowerCase();return rows.filter(x=>{
 if(q&&![x.id,x.itemId,x.itemName,x.name,x.studentId,x.phone,x.unit].join(' ').toLowerCase().includes(q))return false;
 if(f.status==='open'&&x.remaining<=0)return false;
 if(f.status==='returned'&&x.remaining!==0)return false;
 if(f.status==='partial'&&!(x.remaining>0&&x.remaining<x.quantity))return false;
 if(f.status==='overdue'&&!(x.remaining>0&&x.dueDate<today))return false;
 if(f.category&&x.category!==f.category)return false;
 if(f.unit&&x.unit!==f.unit)return false;
 if(f.identity&&x.identity!==f.identity)return false;
 const borrowedDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(x.borrowedAt));
 return !(f.from&&borrowedDate<f.from||f.to&&borrowedDate>f.to);
})}
