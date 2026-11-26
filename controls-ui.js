(function(){
"use strict";
const C=window.PMSCore,A=window.PMSControlAudit,client=window.pmsClient,dlg=document.querySelector("#controls-dialog");
const nav=dlg.querySelector("nav"),panel=dlg.querySelector("section"),status=dlg.querySelector("[role=status]");
const today=()=>C.getVietnamTodayISO();
const fmt=v=>Number(v).toLocaleString("vi-VN");
const names={opening:"Tồn đầu kỳ",statement:"Nhập sao kê",bank:"Ghép phiếu ngân hàng",notice:"Nhập bảng kê OTA",ota:"Đối chiếu OTA",receipt:"Nhập kho",issue:"Xuất dùng",count:"Kiểm kê",adjust:"Xử lý chênh kho",reverse:"Đảo chứng từ"};
const tabs={banking:"Ngân hàng và OTA",stock:"Kho và giá vốn",audit:"Tự đối chiếu"};
let view,epoch=0,snap;
function el(tag,text){const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;}
function btn(text,fn){const e=el("button",text);e.type="button";e.onclick=fn;return e;}
function select(values){const e=el("select");for(const [value,text] of values)e.add(new Option(text,value));return e;}
function input(value="",type="text"){const e=el("input");e.type=type;e.value=value;return e;}
function field(parent,name,node){node.setAttribute("aria-label",name);const l=el("label",name);l.append(node);parent.append(l);return node;}
function table(parent,headers,rows){
 const t=el("table"),h=t.createTHead().insertRow();headers.forEach(x=>h.append(el("th",x)));
 const b=t.createTBody();for(const row of rows){const r=b.insertRow();row.forEach(v=>r.insertCell().textContent=v??"—");}
 const wrap=el("div");wrap.className="control-scroll";wrap.append(t);parent.append(wrap);
}
function integer(v){if(!/^-?\d+$/.test(String(v).trim())||!Number.isSafeInteger(Number(v)))throw Error("Số tiền và số lượng phải là số nguyên, không dùng dấu phân cách hàng nghìn.");return Number(v);}
function download(name,value,type){const url=URL.createObjectURL(new Blob([value],{type}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function csvLines(text,header){
 const lines=text.replace(/^\uFEFF/,"").trim().split(/\r?\n/);
 const sep=lines[0]?.includes(";")?";":",";
 if(lines.shift()?.trim()!==header.join(sep))throw Error("Tiêu đề cần là "+header.join(sep));
 return lines.filter(x=>x.trim()).map((line,i)=>{
   const v=line.split(sep).map(x=>x.trim());
   if(v.length!==header.length || v.some(x=>x.includes('"')))throw Error("Dòng "+(i+2)+" sai định dạng mẫu.");
   return Object.fromEntries(header.map((k,j)=>[k,v[j]]));
 });
}
function activeRows(){const rows=snap.financeState.controlsV23,off=new Set(rows.filter(r=>r.kind==="reverse").map(r=>r.sourceSeq));return rows.filter(r=>r.kind!=="reverse"&&!off.has(r.seq));}
function render(){
 const my=++epoch;panel.replaceChildren();status.textContent="";
 for(const b of nav.children)b.setAttribute("aria-pressed",String(b.dataset.key===view));
 if(view==="audit"){renderAudit(my);return;}
 const stock=view==="stock",f=snap.financeState,rs=activeRows();
 const kind=select((stock?["opening","receipt","issue","count","adjust","reverse"]:["statement","bank","notice","ota","reverse"]).map(k=>[k,names[k]]));
 field(panel,"Nghiệp vụ",kind);const form=el("form"),log=el("div");panel.append(form,log);
 function change(){
   const editId=++epoch;form.replaceChildren();log.replaceChildren();status.textContent="";
   const k=kind.value,refs={};let proposal=null;
   const add=(key,label,n)=>refs[key]=field(form,label,n);
   const recordSelect=(key,label,arr)=>add(key,label,select([["","Chọn chứng từ"],...arr.map(r=>[r.ref,r.ref+" · "+r.day])]));
   add("ref","Mã chứng từ",input());add("day","Ngày nghiệp vụ",input(today(),"date"));
   if(k==="statement"){
     add("from","Từ ngày",input(today(),"date"));add("opening","Số dư đầu kỳ (đ)",input());add("closing","Số dư cuối kỳ (đ)",input());
     const area=el("textarea");area.rows=5;area.placeholder="day,ref,amount";add("lines","Dòng sao kê ngân hàng (VND có dấu)",area);
     const file=add("file","Mở CSV theo mẫu",input("","file"));file.accept=".csv,text/csv";
     file.onchange=async()=>{try{if(file.files[0])area.value=await file.files[0].text();invalidate();}catch(e){status.textContent=e.message;}};
     form.append(btn("Tải mẫu sao kê CSV",()=>download("sao-ke-mau.csv","day,ref,amount\n"+today()+",GD001,100000\n","text/csv")));
   } else if(k==="bank"){
     const st=recordSelect("statement","Sao kê",rs.filter(r=>r.kind==="statement"));
     const line=add("lineRef","Dòng cần ghép",select([]));
     const txs=add("txIds","Phiếu sổ quỹ (chọn một hoặc nhiều)",select(f.transactions.filter(t=>A.bankImpact(t)!==null && !rs.some(r=>r.kind==="bank" && r.txIds.includes(t.id))).map(t=>[t.id,(t.voucherCode||t.id)+" · "+t.receivedDate+" · "+fmt(A.bankImpact(t))+" đ"])));
     txs.multiple=true;txs.size=5;
     st.onchange=()=>{line.replaceChildren();for(const l of rs.find(r=>r.kind==="statement"&&r.ref===st.value)?.lines||[]){if(!rs.some(r=>r.kind==="bank" && r.statement===st.value && r.lineRef===l.ref))line.add(new Option(l.ref+" · "+fmt(l.amount)+" đ",l.ref));}line.dispatchEvent(new Event("change"));};
     line.onchange=()=>{const l=rs.find(r=>r.kind==="statement" && r.ref===st.value)?.lines.find(l=>l.ref===line.value);if(l)refs.day.value=l.day;};
   } else if(k==="notice"){
     add("channel","Kênh thu hộ",select(["booking","agoda","airbnb","expedia","traveloka"].map(x=>[x,x])));
     for(const [key,label] of [["gross","Tổng thu gộp"],["fee","Phí OTA"],["refund","Hoàn tiền"],["net","Thực nhận theo bảng kê"]])add(key,label+" (đ)",input());
     const area=el("textarea");area.rows=4;area.placeholder="otaRef,bookingId,gross,fee,refund";add("lines","Chi tiết từng đơn theo bảng kê OTA (CSV)",area);
     const keys=snap.bookings.filter(b=>["booking","agoda","airbnb","expedia","traveloka"].includes(b.channelKey));
     const look=el("details");look.append(el("summary","Tra mã đơn PMS để ghép với mã đặt phòng OTA"));table(look,["Mã đơn PMS","Phòng","Ngày đến","Khách"],keys.map(b=>[b.id,b.roomId,b.checkin,b.guestName]));form.append(look);
     const up=add("file","Mở CSV chi tiết OTA",input("","file"));up.accept=".csv";up.onchange=async()=>{try{if(up.files[0])area.value=await up.files[0].text();invalidate();}catch(e){status.textContent=e.message;}};
     form.append(btn("Tải mẫu chi tiết OTA",()=>download("chi-tiet-ota.csv","otaRef,bookingId,gross,fee,refund\nOTA001,MA_DON_PMS,2000000,300000,0\n","text/csv")));
   } else if(k==="ota"){
     recordSelect("notice","Bảng kê OTA",rs.filter(r=>r.kind==="notice"&&!rs.some(a=>a.kind==="ota"&&a.notice===r.ref)));
     recordSelect("bankRef","Dòng ngân hàng đã ghép",rs.filter(r=>r.kind==="bank"&&!rs.some(a=>a.kind==="ota"&&a.bankRef===r.ref)));
   } else if(k==="reverse"){
     const opts=rs.filter(r=>stock?["opening","receipt","issue","count","adjust"].includes(r.kind):["bank","ota","statement","notice"].includes(r.kind));
     add("source","Chứng từ cần đảo",select([["","Chọn chứng từ"],...opts.map(r=>[r.seq,names[r.kind]+" · "+r.ref])]));add("reason","Lý do đảo",input());
   } else {
     if(k==="opening"||k==="receipt"){
       add("sku","Mã vật tư",input());add("unit","Đơn vị cơ sở (chai, gam…)",input());
       if(k==="opening"){
         add("value","Giá trị tồn đầu đã ghi sổ cái (đ)",input());
         add("basis","Biên bản kiểm và chứng từ số dư đầu",input());
       }else{
       const opts=[];
       for(const i of f.supplierInvoices.filter(i=>i.status!=="voided"))for(const l of i.lines||[])
         if(!rs.some(r=>r.kind==="receipt" && r.invoiceId===i.id && r.lineId===l.id)) opts.push([JSON.stringify([i.id,l.id]),i.voucherNo+" · "+(l.description||l.costItemName||l.costItemId)+" · "+fmt(l.amount)+" đ"]);
       const invoice=add("source","Dòng hóa đơn nguồn",select([["","Chọn dòng hóa đơn"],...opts]));
       invoice.onchange=()=>{if(invoice.value)refs.day.value=f.supplierInvoices.find(i=>i.id===JSON.parse(invoice.value)[0]).invoiceDate;};
       }
     } else {
       const bal=A.balances(f.controlsV23);add("sku","Vật tư",select(bal.map(b=>[b.sku,b.sku+" · "+fmt(b.qty)+" "+b.unit])));
       if(k==="issue"||k==="adjust"){
         const costs=C.sanitizeOperatingCostsState(snap.operatingCosts);
         add("costItemId","Khoản mục tính chi phí",select(costs.items.filter(i=>i.active).map(i=>[i.id,i.name])));
         add(k==="issue"?"purpose":"reason",k==="issue"?"Bộ phận / mục đích xuất":"Lý do xử lý",input());
       }
       if(k==="adjust")recordSelect("countRef","Biên bản kiểm",rs.filter(r=>r.kind==="count"&&r.difference!==0));
     }
     if(k!=="adjust")add("qty",k==="count"?"Số lượng thực đếm":"Số lượng theo đơn vị cơ sở",input());
   }
   const preview=btn("Xem trước và đối chiếu",()=>run(true)),save=btn("Xác nhận ghi",()=>run(false));save.disabled=true;form.append(preview,save);
   function invalidate(){proposal=null;save.disabled=true;log.replaceChildren();}
   form.oninput=invalidate;form.onchange=invalidate;form.onsubmit=e=>e.preventDefault();
   function build(){
     const item={kind:k};for(const [key,n] of Object.entries(refs)){if(["source","file","lines","txIds"].includes(key))continue;item[key]=["opening","closing","value","qty","gross","fee","refund","net"].includes(key)?integer(n.value):n.value.trim();}
     if(k==="statement")item.lines=csvLines(refs.lines.value,["day","ref","amount"]).map(l=>({...l,amount:integer(l.amount)}));
     if(k==="notice")item.lines=csvLines(refs.lines.value,["otaRef","bookingId","gross","fee","refund"]).map(l=>({...l,gross:integer(l.gross),fee:integer(l.fee),refund:integer(l.refund)}));
     if(k==="bank"){
       item.txIds=[...refs.txIds.selectedOptions].map(o=>o.value);
       item.amount=rs.find(r=>r.kind==="statement" && r.ref===item.statement)?.lines.find(l=>l.ref===item.lineRef)?.amount;
     }
     if(k==="receipt"){[item.invoiceId,item.lineId]=JSON.parse(refs.source.value||"[]");}
     if(k==="reverse"){const src=rs.find(r=>String(r.seq)===refs.source.value);item.sourceRef=src?.ref;item.sourceKind=src?.kind;}
     if(["adjust","issue","count"].includes(k))item.unit=A.balances(f.controlsV23).find(r=>r.sku===item.sku)?.unit;
     return item;
   }
   async function run(dry){
     let item;try{item=build();}catch(e){status.textContent=e.message;return;}
     const sign=JSON.stringify(item);
     if(!dry && sign!==proposal)return;
     preview.disabled=true;save.disabled=true;status.textContent="Đang đối chiếu trên máy chủ…";
     try{
       const res=await client.commitControls([item],snap.storeVersion,dry);
       if(epoch!==editId||!dlg.open)return;
       if(!res?.ok)throw Error(res?.error || "Ghi dữ liệu thất bại.");
       if(!dry){await load("Đã lưu và tải lại sổ từ máy chủ.");return;}
       if(JSON.stringify(build())!==sign){invalidate();status.textContent="Dữ liệu nhập đã đổi. Xem trước lại.";return;}
       proposal=sign;save.disabled=false;
       const r=res.rows[0];log.replaceChildren();
       const summary=[["Chứng từ",r.ref],["Nghiệp vụ",names[r.kind]]];
       for(const [key,label] of [["amount","Tiền ngân hàng"],["gross","Gộp"],["fee","Phí"],["refund","Hoàn"],["opening","Đầu kỳ"],["closing","Cuối kỳ"],["qty","Biến động lượng"],["value","Biến động giá trị"],["observed","Thực đếm"],["difference","Lệch lượng"]])if(r[key]!=null)summary.push([label,fmt(r[key])]);
       table(log,["Nội dung","Giá trị xem trước"],summary);status.textContent=r.existing?"Chứng từ đã tồn tại và trùng nội dung.":"Đã đối chiếu. Kiểm tra giá trị trước khi ghi.";
     }catch(e){if(epoch===editId){proposal=null;status.textContent=e.message+" · Có thể chọn Tải lại để nhận số mới.";}}
     finally{if(epoch===editId)preview.disabled=false;}
   }
   if(stock)table(log,["Vật tư","Tồn","Đơn vị","Giá trị (đ)"],A.balances(f.controlsV23).map(x=>[x.sku,fmt(x.qty),x.unit,fmt(x.value)]));
   else table(log,["Nghiệp vụ","Mã","Ngày"],[...rs].reverse().filter(r=>["statement","notice","bank","ota"].includes(r.kind)).slice(0,40).map(r=>[names[r.kind],r.ref,r.day]));
 }
 kind.onchange=change;change();
}
function renderAudit(ticket){
 const start=field(panel,"Từ ngày",input(today().slice(0,7)+"-01","date")),end=field(panel,"Đến ngày",input(today(),"date"));
 const out=el("div");panel.append(btn("Chạy tự đối chiếu",async()=>{
   const begin=start.value,until=end.value;out.replaceChildren();status.textContent="Đang đọc PMS và sổ cái máy chủ…";
   try{
     const latest=await client.pullLatest();if(!latest?.ok)throw Error(latest?.error || "Chưa đọc PMS.");
     const s=client.getSnapshot();const g=await client.refreshEnterpriseGlState();if(!g?.ok)throw Error(g?.error || "Chưa đọc sổ cái.");
     if(ticket!==epoch||!dlg.open)return;
     if(s.storeVersion!==client.getSnapshot().storeVersion)throw Error("Dữ liệu thay đổi trong khi kiểm tra. Chạy lại.");
     const report=A.audit(s,g.enterpriseGlState,begin,until);
     const labels={cash:"Tiền và ngân hàng",ar:"Khách phải thu",ap:"Nợ nhà cung cấp",inventory:"Tồn kho"};
     table(out,["Khoản đối chiếu","PMS (đ)","Sổ cái (đ)","Chênh (đ)"],report.reconciliation.map(c=>[labels[c.key]||c.key,fmt(c.pms),fmt(c.gl),fmt(c.diff)]));
     table(out,["Mã kiểm tra","Chứng từ","Điểm cần xử lý"],report.issues.map(x=>[x.code,x.ref,x.message]));
     status.textContent=report.issues.length?report.issues.length+" ngoại lệ cần kiểm tra.":"Đã khớp các dữ liệu có trong kỳ. Nghiệm thu phát hành dùng thêm hồ sơ kiểm thử và phục hồi.";
     out.append(btn("Tải kết quả đối chiếu JSON",()=>download("doi-chieu-"+until+".json",JSON.stringify({...report,storeVersion:s.storeVersion},null,2),"application/json")));
   }catch(e){if(ticket===epoch)status.textContent=e.message;}
 }),out);
}
async function load(note=""){
 const ticket=++epoch;panel.replaceChildren();status.textContent="Đang tải sổ…";
 try{
   if(!client.commitControls)throw Error("Phân hệ này cần kết nối Supabase có migration v2.3.");
   const res=await client.pullLatest();if(ticket!==epoch||!dlg.open)return;
   if(!res?.ok)throw Error(res?.error||"Chưa tải được sổ.");
   snap=client.getSnapshot();if(!client.can("reports:management")||!Array.isArray(snap.financeState?.controlsV23))throw Error("Thiếu dữ liệu đối soát hoặc quyền quản lý.");
   render();if(note)status.textContent=note;
 }catch(e){if(ticket===epoch)status.textContent=e.message;}
}
function open(){
 if(!client.can("reports:management"))return;view="banking";if(!dlg.open)dlg.showModal();nav.replaceChildren();
 for(const [key,title] of Object.entries(tabs)){const b=btn(title,()=>{view=key;load();});b.dataset.key=key;nav.append(b);}
 nav.append(btn("Tải lại",()=>load()));load();
}
dlg.querySelector("[data-close]").onclick=()=>dlg.close();dlg.onclose=()=>{epoch++;snap=null;panel.replaceChildren();status.textContent="";};
client.subscribe(e=>{if(dlg.open && (e?.type==="auth_required"||e?.type==="auth_login"||!client.can("reports:management")))dlg.close();});
document.querySelector("#btn-controls").onclick=open;window.PMSControlsUI={open};
})();
