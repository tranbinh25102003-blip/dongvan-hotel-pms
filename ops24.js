(function(root){
"use strict";
function nightly(b,amount,days,add){
 const locked=b.ops24?.rates;
 if(Array.isArray(locked)&&locked.length===days && locked.every((r,i)=>r.day===add(b.checkin,i)&&Number.isSafeInteger(r.amount)&&r.amount>=0) && locked.reduce((s,r)=>s+r.amount,0)===amount)return locked;
 return Array.from({length:days},(_,i)=>({day:add(b.checkin,i),amount:Math.round(amount*(i+1)/days)-Math.round(amount*i/days)}));
}
function allocation(amount,before,total,rule){
 if(!rule || total<=0)return null;
 const den=BigInt(rule.mode==="bps"?10000:total),num=BigInt(rule.share);
 if(num<0n || num>den)throw Error("Quy tắc chia vượt tổng giá trị dòng.");
 const portion=n=>Number((2n*BigInt(n)*num+den)/(2n*den));
 const first=portion(before+amount)-portion(before);
 return [[rule.first,first],[rule.second,amount-first]];
}
function state(b,day){
 if(b.ops24?.stay==="noshow")return "Không đến";
 if(b.status==="cancelled")return "Đã hủy";
 if(b.checkedOutAt)return "Đã trả";
 if(b.ops24?.stay==="inhouse")return b.checkout<=day?"Đến hạn trả":"Đang ở";
 return b.checkin>day?"Sắp đến":b.checkin===day?"Đến hôm nay":"Chưa xác nhận đến";
}
function csv(rows){return "\uFEFF"+rows.map(row=>row.map(v=>{let s=String(v??"");if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(",")).join("\r\n");}
const api={nightly,allocation,state,csv};root.PMSOps24=api;if(typeof module!=="undefined")module.exports=api;
})(typeof window==="undefined"?globalThis:window);
