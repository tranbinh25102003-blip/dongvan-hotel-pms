/* Independent source-to-ledger checks for the hotel's VND bank, OTA and stock records. */
(function(root){
"use strict";
const bankImpact=t=>{
 if (!t || t.status==="voided") return null;
 if (t.txType==="fund_transfer") return t.fromFundId==="bank_main"?-t.amount:t.toFundId==="bank_main"?t.amount:null;
 if (t.fundId!=="bank_main") return null;
 if (["customer_payment","balance_adjustment"].includes(t.txType) || t.txType==="legacy_payment" && t.legacyStatus==="reconciled") return t.amount;
 return ["customer_refund","supplier_payment"].includes(t.txType)?-t.amount:null;
};
const stockKind=r=>["issue","receipt","adjust","opening"].includes(r.kind==="reverse"?r.sourceKind:r.kind);
function opening(r){return (r.kind==="reverse"?r.sourceKind:r.kind)==="opening";}
function stockCharges(rows,month) {
 return (rows||[]).filter(r=>stockKind(r) && !opening(r) && r.day.slice(0,7)===month).map(r=>({
   itemId:r.costItemId,id:"stock:"+r.seq,amount:-r.value,sourceType:"stock_control",
   expenseDate:r.day,accountingMonth:month,voucherNo:r.ref,note:r.sku+" · "+r.ref,createdBy:r.actor
 }));
}
function balances(rows,to="9999-12-31") {
 const bySku=new Map();
 for(const r of rows||[]) {
   if(r.day>to || !stockKind(r))continue;
   const s=bySku.get(r.sku)||{sku:r.sku,unit:r.unit,qty:0,value:0};
   s.qty+=r.qty;s.value+=r.value;bySku.set(r.sku,s);
 }
 return [...bySku.values()];
}
function audit(snap,gl,from,to) {
 if(!snap.financeState || !Array.isArray(snap.financeState.controlsV23))throw Error("Thiếu sổ đối soát và kho từ máy chủ.");
 if(!/^\d{4}-\d\d-\d\d$/.test(from)||!/^\d{4}-\d\d-\d\d$/.test(to)||from>to)throw Error("Chọn kỳ đối chiếu hợp lệ.");
 const f=snap.financeState,rows=f.controlsV23.filter(r=>r.day<=to).sort((a,b)=>a.seq-b.seq);
 const active=new Set(rows.filter(r=>r.kind==="reverse").map(r=>r.sourceSeq));
 const tx=new Map(f.transactions.map(t=>[t.id,t])),invs=new Map(f.supplierInvoices.map(i=>[i.id,i]));
 const bks=new Map((snap.bookings||[]).map(b=>[b.id,b])),issues=[],coverage={bank:0,ota:0,receipt:0,issue:0};
 const statements=rows.filter(r=>r.kind==="statement"&&!active.has(r.seq));
 const matched=rows.filter(r=>r.kind==="bank"&&!active.has(r.seq));
 const notices=rows.filter(r=>r.kind==="notice"&&!active.has(r.seq));
 const netFees=(snap.bookings||[]).flatMap(b=>b.ops24?.netFees||[]).filter(a=>a.day<=to);
 const payouts=rows.filter(r=>r.kind==="ota"&&!active.has(r.seq));
 let coveredThrough="";
 for(const st of statements.filter(r=>r.from<=to && r.day>=from).sort((a,b)=>a.from.localeCompare(b.from))){
   const next=coveredThrough?new Date(Date.parse(coveredThrough+"T00:00:00Z")+86400000).toISOString().slice(0,10):from;
   if(st.from>next)flag("STATEMENT_GAP",st.ref,"Thiếu sao kê trong kỳ.");
   if(st.opening+st.lines.reduce((n,l)=>n+Number(l.amount),0)!==st.closing)flag("STATEMENT_TOTAL",st.ref,"Sai tổng cuối kỳ sao kê.");
   const prev=statements.find(x=>Date.parse(x.day)+86400000===Date.parse(st.from));
   if(prev && prev.closing!==st.opening)flag("OPENING_DIFF",st.ref,"Đầu kỳ khác cuối kỳ trước.");
   for(const l of st.lines.filter(l=>l.day>=from && l.day<=to)) {
     const hits=matched.filter(b=>b.statement===st.ref && b.lineRef===l.ref);
     if(hits.length!==1 || hits[0].amount!==Number(l.amount))flag("STATEMENT_LINE",l.ref,"Dòng sao kê chưa khớp duy nhất với sổ.");
   }
   if(globalThis.PMSCore || typeof require==="function"){
     const core=globalThis.PMSCore || require("./pms-core.js");
     const bank=core.computeCashbookReport(f,snap.bookings||[],{toDate:st.day}).activeFunds.find(x=>x.id==="bank_main");
     if(bank?.closingBalance!==st.closing)flag("BOOK_CLOSING",st.ref,"Cuối kỳ ngân hàng khác sổ quỹ PMS.");
   }
   coveredThrough=st.day;
 }
 if(coveredThrough<to)flag("NO_STATEMENT",to,"Sao kê chưa phủ đủ kỳ báo cáo.");
 for(const n of notices.filter(r=>r.day>=from))if(!payouts.some(p=>p.notice===n.ref) && netFees.filter(p=>p.notice===n.ref).reduce((sum,p)=>sum+p.fee,0)<=0)flag("OPEN_PAYOUT",n.ref,"Bảng thanh toán OTA đang chờ tiền hoặc chưa ghép.");
 for(const c of rows.filter(r=>r.kind==="count" && !active.has(r.seq) && r.difference!==0)){
   if(!rows.some(a=>a.kind==="adjust" && a.countRef===c.ref && !active.has(a.seq)))flag("COUNT_DIFF",c.ref,"Biên bản kiểm kho còn chênh lệch.");
 }
 const used=new Set(), held=new Map(), originals=new Map(), keyed=new Set(), otaBanks=new Set();
 function flag(code,ref,message){issues.push({code,ref,message});}
 if(!gl || !Array.isArray(gl.entries) || !gl.mapping || !gl.activeEntityId) flag("GL_MISSING","","Thiếu sổ cái máy chủ.");
 for(const r of rows) {
   const key=r.kind+"/"+r.ref;
   if(keyed.has(key))flag("DUPLICATE",r.ref,"Trùng mã chứng từ.");keyed.add(key);
   if(r.day>=from && Object.hasOwn(coverage,r.kind))coverage[r.kind]++;
   if(r.kind==="reverse") {
     const old=originals.get(r.sourceSeq);
     if(!old || old.kind!==r.sourceKind || old.ref!==r.sourceRef || (stockKind(r) && (r.value!==-old.value || r.qty!==-old.qty)))flag("BAD_REVERSAL",r.ref,"Chứng từ đảo lệch với bản gốc.");
   }
   originals.set(r.seq,r);
   if(r.kind==="bank" && !active.has(r.seq)) {
     let sum=0;
     for(const id of r.txIds) {
       const amt=bankImpact(tx.get(id));
       if(!Number.isSafeInteger(amt) || used.has(id))flag("BANK_SOURCE",r.ref,"Phiếu thiếu, đã hủy, sai quỹ hoặc được dùng hai lần.");
       else sum+=amt;
       used.add(id);
     }
     if(sum!==r.amount)flag("BANK_DIFF",r.ref,"Tổng phiếu khác tiền trên sao kê.");
   }
   if(r.kind==="ota" && !active.has(r.seq)) {
     const bank=rows.find(b=>b.kind==="bank" && b.ref===r.bankRef && !active.has(b.seq));
     if(!bank || otaBanks.has(r.bankRef))flag("OTA_BANK",r.ref,"Dòng sao kê bị trùng hoặc đã đảo.");
     otaBanks.add(r.bankRef);
     const notice=notices.find(n=>n.ref===r.notice);
     const breakdown=new Map();
     let gross=0,refund=0,fee=0;
     for(const id of bank?.txIds||[]) {
       const t=tx.get(id);if(!t)continue;
       if(["customer_payment","legacy_payment","customer_refund"].includes(t.txType)) {
         const b=bks.get(t.bookingId);
         if(!b || b.channelKey!==r.channel || (b.folioRouting?.["receipt:"+t.id] || b.folioRouting?.room || "ota")!=="ota")flag("OTA_PAYER",r.ref,"Người trả hoặc kênh trên đơn đã đổi.");
         const bsum=breakdown.get(t.bookingId)||{gross:0,refund:0};
         if(t.txType==="customer_refund"){refund+=t.amount;bsum.refund+=t.amount;}else{gross+=t.amount;bsum.gross+=t.amount;}
         breakdown.set(t.bookingId,bsum);
       } else if(t.txType==="supplier_payment") {
         const inv=invs.get(t.invoiceId||t.supplierInvoiceId);
         if(!inv || inv.status==="voided" || !inv.lines?.length || inv.lines.some(l=>!["ci_booking_fee","ota_commission"].includes(l.costItemId)))flag("OTA_FEE",r.ref,"Thiếu hóa đơn phí OTA hợp lệ.");
         fee+=t.amount;
       } else flag("OTA_TYPE",r.ref,"Có dòng tiền khác ngoài thu, hoàn và phí OTA.");
     }
     if(!notice || notice.channel!==r.channel || notice.gross!==gross || notice.fee!==fee || notice.refund!==refund || notice.net!==gross-fee-refund){
       flag("OTA_NOTICE",r.ref,"Số tiền theo phiếu khác bảng kê gốc.");
     }else{
       const external=new Map();
       for(const l of notice.lines||[]){
         const bal=external.get(l.bookingId)||{gross:0,refund:0};bal.gross+=Number(l.gross);bal.refund+=Number(l.refund);external.set(l.bookingId,bal);
       }
       if(external.size!==breakdown.size || [...external].some(([id,v])=>v.gross!==breakdown.get(id)?.gross || v.refund!==breakdown.get(id)?.refund))flag("OTA_BOOKING",r.ref,"Chi tiết theo booking khác bảng kê.");
     }
     if(gross!==r.gross || fee!==r.fee || refund!==r.refund || gross-fee-refund!==bank?.amount)flag("OTA_DIFF",r.ref,"Số gộp, phí, hoàn hoặc thực nhận thay đổi.");
   }
   if(!stockKind(r))continue;
   const old=held.get(r.sku)||{qty:0,value:0,unit:r.unit};
   if(!Number.isSafeInteger(r.qty)||!Number.isSafeInteger(r.value)||old.unit!==r.unit)flag("STOCK_UNIT",r.ref,"Sai đơn vị hoặc số nguyên.");
   if(r.kind==="receipt" && !active.has(r.seq)){
     const inv=invs.get(r.invoiceId), line=inv?.lines?.find(l=>l.id===r.lineId);
     if(!line || inv.status==="voided" || line.amount!==r.value || line.costItemId!==r.costItemId)flag("STOCK_INVOICE",r.ref,"Giá nhập hoặc khoản mục khác dòng hóa đơn nguồn.");
   }
   if((r.kind==="issue" || r.kind==="adjust" && r.qty<0) && old.qty>0){
     const numerator=BigInt(old.value)*BigInt(-r.qty);
     const expected=Number((numerator*2n+BigInt(old.qty))/(2n*BigInt(old.qty)));
     if(r.value!==-expected)flag("COGS_DIFF",r.ref,"Giá xuất khác bình quân di động.");
   }
   old.qty+=r.qty;old.value+=r.value;held.set(r.sku,old);
   if(old.qty<0 || old.value<0 || (!old.qty && old.value))flag("STOCK_NEGATIVE",r.ref,"Âm kho hoặc còn giá trị khi lượng bằng 0.");
   if(gl?.entries && r.value!==0 && !opening(r)) {
     const entries=gl.entries.filter(e=>e.entityId===gl.activeEntityId && e.sourceType==="pms_stock_move" && e.sourceEventId===String(r.seq) && e.postingDate<=to);
     const invCode=gl.mapping?.inventoryAccount || "1521";
     const amount=entries.flatMap(e=>e.lines||[]).filter(l=>l.accountCode===invCode).reduce((a,l)=>a+l.debit-l.credit,0);
     if(amount!==r.value || entries.some(e=>e.status==="reversed"))flag("GL_STOCK",r.ref,"Bút toán hàng tồn kho chưa khớp sổ cái.");
   }
 }
 for(const t of tx.values())if(t.receivedDate>=from && t.receivedDate<=to && bankImpact(t)!==null && !used.has(t.id))flag("UNMATCHED_BANK",t.voucherCode||t.id,"Phiếu ngân hàng trong kỳ chưa có đối ứng sao kê.");
 const recon=[];
 if(gl && Array.isArray(gl.entries) && gl.mapping && gl.activeEntityId){
   const er=globalThis.PMSEnterpriseReport || (typeof require==="function" && require("./enterprise-report.js"));
   const base=er.period(to.slice(0,7),"month"),period={...base,from,to};
   const checked=er.computeSubledgerReconciliation(gl,snap,period);
   if(!checked.trialBalance.balanced)flag("TRIAL_BALANCE",to,"Tổng phát sinh hoặc số dư Nợ/Có lệch.");
   for(const item of checked.subledgerChecks){
     recon.push({key:item.key,pms:item.subledgerAmount,gl:item.glAmount,diff:item.diff});
     if(item.diff)flag("GL_"+item.key.toUpperCase(),to,item.label+" lệch "+item.diff+" đ. Kiểm tra phạm vi, cọc và thời điểm ghi nhận.");
   }
   const stockCode=gl.mapping.inventoryAccount||"1521";
   const g=checked.trialBalance.rows.find(r=>r.accountCode===stockCode)?.endingNet || 0;
   const v=[...held.values()].reduce((n,s)=>n+s.value,0);
   recon.push({key:"inventory",pms:v,gl:g,diff:g-v});
   if(g!==v)flag("INVENTORY_BALANCE",to,"Tồn trên tài khoản kho khác giá trị thẻ kho, cần đối chiếu cả đầu kỳ.");
 }
 return {from,to,coverage,reconciliation:recon,issues,stock:[...held.values()],checkedRecords:rows.length};
}
const api={audit,stockCharges,balances,stockKind,opening,bankImpact};
root.PMSControlAudit=api;if(typeof module!=="undefined")module.exports=api;
})(typeof window!=="undefined"?window:globalThis);
