(function(){
"use strict";
const c=window.pmsClient,C=window.PMSCore,O=window.PMSOps24,dlg=document.querySelector("#ops24-dialog");
const main=dlg.querySelector("main"),msg=dlg.querySelector("[role=status]"),nav=dlg.querySelector("nav");
const today=()=>C.getVietnamTodayISO(),money=n=>Number(n).toLocaleString("vi-VN")+" đ";
let snap,data,rev=0,mode="board",chosenDay=today();
const tabs={board:"Lễ tân",rooms:"Kiểm phòng",rates:"Giá và người trả",guests:"Khách và dịch vụ",store:"Kho theo điểm",night:"Chốt ngày"};
const manager=()=>c.can("reports:management");
function el(tag,text){const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;}
function button(t,fn){const e=el("button",t);e.type="button";e.onclick=fn;return e;}
function select(items){const e=el("select");for(const [v,t] of items)e.add(new Option(t,v));return e;}
function input(value="",type="text"){const e=el("input");e.type=type;e.value=value;return e;}
function label(p,t,n){const w=el("label",t);n.setAttribute("aria-label",t);w.append(n);p.append(w);return n;}
function table(p,heads,rows){const wrap=el("div"),t=el("table"),h=t.createTHead().insertRow();wrap.className="ops-scroll";heads.forEach(v=>h.append(el("th",v)));const body=t.createTBody();rows.forEach(vals=>{const r=body.insertRow();vals.forEach(v=>r.insertCell().textContent=v??"");});wrap.append(t);p.append(wrap);}
function download(name,text,type){const u=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement("a");a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
const ops={arrive:"Xác nhận nhận phòng",depart:"Trả phòng và giao dọn",noshow:"Khách không đến",move:"Chuyển phòng giữa kỳ",resize:"Đổi ngày trả",inspect:"Kiểm đạt, cho giao phòng",reclean:"Yêu cầu dọn lại",plan:"Lập bảng giá",quote:"Áp giá và lưu giá từng đêm",split:"Chia một dòng cho hai bên",net_ota:"Cấn phí OTA thu ròng",net_ota_reverse:"Đảo cấn phí OTA",service:"Ghi buffet / minibar / dịch vụ",roster:"Lưu danh sách khách",invoice:"Theo dõi hóa đơn điện tử",transfer:"Chuyển vật tư giữa các điểm",conversion:"Khai quy đổi đơn vị",local_issue:"Xuất dùng tại điểm",delivery:"Nhận từng phần theo hóa đơn",night_preview:"Kiểm tra cuối ngày"};
async function load(note){
 const n=++rev;main.replaceChildren();msg.textContent="Đang đọc dữ liệu…";
 try{if(!c.ops24Read)throw Error("Cần Supabase staging đã cài migration v2.4.");
 const fresh=await c.pullLatest();if(!fresh?.ok)throw Error(fresh?.error||"Chưa đọc được lịch.");
 const s=c.getSnapshot(),r=await c.ops24Read(chosenDay);if(n!==rev||!dlg.open)return;
 if(!r?.ok||r.version!==s.storeVersion)throw Error(r?.error||"Dữ liệu đã đổi. Bấm Tải lại.");
 snap=s;data=r;msg.textContent=note||"";render();
 }catch(e){if(n===rev)msg.textContent=e.message;}
}
function render(){
 main.replaceChildren();const day=label(main,"Ngày vận hành",input(chosenDay,"date"));day.onchange=()=>{if(day.value){chosenDay=day.value;load();}};
 const list=snap.bookings||[],rs=data.rooms||[],events=data.events||[],fin=snap.financeState;
 const roomopts=C.ROOMS.map(r=>[r.id,r.name]);
 if(mode==="board"){
   const ar=C.computeReceivablesReport(list,fin,{asOfDate:chosenDay});
   const relevant=list.filter(b=>b.checkin<=chosenDay&&b.checkout>=chosenDay && (b.status!=="cancelled"||b.ops24?.stay==="noshow"));
   table(main,["Phòng","Khách / đoàn","Tình trạng","Giao phòng","Còn phải thu theo đơn/đoàn"],relevant.map(b=>{
     const row=ar.rows.find(e=>e.memberIds?.has(b.id)||e.bookingId===b.id);
     return [b.roomId,[b.guestName,b.bookingCode].filter(Boolean).join(" · "),O.state(b,chosenDay),rs.find(r=>r.room===b.roomId)?.label,row?money(row.remaining):"Chưa xác định"];
   }));
 }else if(mode==="rooms")table(main,["Phòng","Tình trạng sẵn sàng"],rs.map(r=>[r.room,r.label]));
 else if(mode==="rates")table(main,["Mã giá","Hiệu lực","Tour / phòng","Đêm thường","T6–T7"],events.filter(e=>e.kind==="plan").slice(-20).reverse().map(e=>{const p=e.result;return [p.code,p.from+" → "+p.through,[p.tour,p.room].filter(Boolean).join(" · ")||"Chung",money(p.weekday),money(p.weekend)];}));
 else if(mode==="store") {
  const lots=new Map();
  for(const b of window.PMSControlAudit.balances(fin.controlsV23,chosenDay))lots.set(JSON.stringify([b.sku,"MAIN",b.unit]),b.qty);
  function shift(r,loc,n){const key=JSON.stringify([r.sku,loc,r.unit]);lots.set(key,(lots.get(key)||0)+n);}
  for(const e of events.filter(e=>e.day<=chosenDay)){
    const r=e.result;if(e.kind==="transfer"){shift(r,r.fromLoc,-r.qty);shift(r,r.toLoc,r.qty);}
    if(e.kind==="local_issue" && r.fromLoc!=="MAIN"){shift(r,"MAIN",r.qty);shift(r,r.fromLoc,-r.qty);}
  }
  table(main,["Vật tư","Điểm giữ","Đơn vị","Tồn"],[...lots].map(([k,n])=>[...JSON.parse(k),n]));
 }else if(mode==="guests"){
   const guests=new Map();for(const e of events.filter(e=>e.kind==="roster"))guests.set(e.booking,e.result.guests);
   const exportRows=[["Mã booking","Phòng","Họ tên","Quốc tịch","Số giấy tờ","Ngày đến","Ngày trả"]];
   for(const b of list.filter(b=>b.checkin<=chosenDay&&b.checkout>chosenDay&&b.status!=="cancelled"))for(const g of guests.get(b.id)||guests.get(b.ops24?.origin)||[])exportRows.push([b.id,b.roomId,g.name,g.country,g.document,b.checkin,b.checkout]);
   main.append(button("Xuất danh sách lưu trú CSV",()=>download("luu-tru-"+chosenDay+".csv",O.csv(exportRows),"text/csv")));
   const serviceRows=list.flatMap(b=>(b.services||[]).filter(s=>(s.serviceDate||s.dateISO)===chosenDay && s.status!=="cancelled").map(s=>[b.roomId,s.name,s.qty,money(s.amount)]));
   table(main,["Phòng","Dịch vụ trong ngày","Lượng","Thành tiền"],serviceRows);
   if(manager())table(main,["Phiếu xuất theo dịch vụ","Booking","Dòng dịch vụ","Giá vốn thực xuất"],events.filter(e=>e.kind==="local_issue"&&e.day===chosenDay&&e.result.serviceId).map(e=>[e.seq,e.booking,e.result.serviceId,money(e.result.costValue)]));
   table(main,["Booking","Hóa đơn","Nhà cung cấp","Trạng thái"],events.filter(e=>e.kind==="invoice").slice(-10).reverse().map(e=>[e.booking,e.result.externalId,e.result.provider,e.result.state]));
 }
 const menus={board:["arrive","depart","resize","move","noshow"],rooms:["inspect","reclean"],rates:["plan","quote","split","net_ota","net_ota_reverse"],guests:["service","roster","invoice"],store:["conversion","delivery","transfer","local_issue"],night:["night_preview"]};
 const available=menus[mode].filter(k=>manager()||!["plan","net_ota","net_ota_reverse","inspect","reclean","night_preview","conversion","delivery","transfer","local_issue"].includes(k));
 const kind=label(main,"Nghiệp vụ",select(available.map(k=>[k,ops[k]]))),form=el("form"),preview=el("div");main.append(form,preview);form.onsubmit=e=>e.preventDefault();
 function fields(){
   const k=kind.value,n=++rev;form.replaceChildren();preview.replaceChildren();const f={};let intent="";
   function add(key,text,node){f[key]=label(form,text,node||input());return f[key];}
   if(["arrive","depart","resize","move","noshow","quote","split","service","roster","invoice","net_ota","net_ota_reverse"].includes(k))add("booking","Đơn phòng",select(list.map(b=>[b.id,b.roomId+" · "+b.guestName+" · "+b.checkin+" · "+b.id])));
   function booking(){return list.find(b=>b.id===f.booking?.value);}
   if(k==="inspect"||k==="reclean"){add("room","Phòng",select(roomopts));add("note","Kết quả kiểm thực tế / lý do dọn lại");}
   if(k==="noshow")add("reason","Lý do");
   if(k==="move")add("target","Phòng chuyển đến",select(roomopts));
   if(k==="resize"||k==="depart"){if(k==="resize")add("departure","Ngày trả mới",input(chosenDay,"date"));add("extraRate","Giá mỗi đêm thêm nếu gia hạn (đ)",input("0","number"));}
   if(k==="plan"){add("code","Mã bảng giá");add("tour","Tên tour áp dụng (để trống nếu chung)");add("room","Phòng áp dụng",select([["","Mọi phòng"],...roomopts]));add("from","Từ đêm",input(chosenDay,"date"));add("through","Đến hết đêm",input(chosenDay,"date"));add("weekday","Giá Chủ nhật–Thứ năm (đ)",input("","number"));add("weekend","Giá Thứ sáu–Thứ bảy (đ)",input("","number"));add("special","Giá lễ hoặc ngày riêng, mỗi dòng YYYY-MM-DD | số tiền",el("textarea"));}
   if(k==="quote"){add("code","Mã bảng giá",select([...new Set(events.filter(e=>e.kind==="plan").map(e=>e.result.code))].map(x=>[x,x])));add("reason","Lý do nếu miễn phí");}
   if(k==="split"){const line=add("line","Khoản chia",select([]));const set=()=>{line.replaceChildren(new Option("Tiền phòng","room"));for(const s of booking()?.services||[])if(s.status!=="cancelled")line.add(new Option(s.name,"service:"+s.id));};set();f.booking.onchange=set;
     const pay=[["guest","Khách"],["tour","Tour"],["ota","OTA"]];add("first","Bên thứ nhất",select(pay));add("second","Bên thứ hai",select(pay)).value="tour";add("mode","Cách chia",select([["vnd","Số tiền VND"],["bps","Phần trăm (%)"]]));add("share","Phần bên thứ nhất",input("","number"));}
   if(k==="net_ota_reverse"){const source=add("original","Phiếu cấn phí còn hiệu lực",select([]));const set=()=>{const all=booking()?.ops24?.netFees||[];source.replaceChildren();for(const x of all.filter(a=>a.fee>0&&!all.some(r=>r.original===a.id)))source.add(new Option(x.notice+" · "+money(x.fee),x.id));};set();f.booking.onchange=set;add("reason","Lý do đảo");}
   if(k==="net_ota"){const a=fin.controlsV23||[];for(const [key,t,type] of [["notice","Bảng kê OTA","notice"],["bankRef","Phiếu ghép ngân hàng","bank"]])add(key,t,select(a.filter(r=>r.kind===type).map(r=>[r.ref,r.ref])));add("evidence","Mã chứng từ phí");add("noExistingFee","Đã kiểm tra khoản phí chưa được ghi ở hóa đơn khác",input("","checkbox"));}
   if(k==="service"){add("category","Loại",select([["buffet","Buffet"],["minibar","Minibar"],["other","Dịch vụ khác"]]));add("name","Tên dịch vụ");add("qty","Số lượng thực phục vụ",input("1","number"));add("unitPrice","Đơn giá (0 nếu đã gồm trong phòng)",input("0","number"));add("payer","Người trả",select([["guest","Khách"],["tour","Tour"],["ota","OTA"]]));}
   if(k==="roster"){const area=add("guests","Mỗi dòng: họ tên | quốc tịch | giấy tờ",el("textarea"));const show=()=>{const saved=events.filter(e=>e.kind==="roster"&&e.booking===f.booking.value).at(-1)||events.filter(e=>e.kind==="roster"&&e.booking===booking()?.ops24?.origin).at(-1);area.value=(saved?.result.guests||[]).map(g=>[g.name,g.country,g.document].join(" | ")).join("\n");};show();f.booking.onchange=show;}
   if(k==="invoice"){add("state","Trạng thái hóa đơn",select([["draft","Chuẩn bị"],["issued","Đã phát hành ngoài hệ thống"],["adjusted","Đã điều chỉnh"],["replaced","Đã thay thế"]]));add("provider","Nhà cung cấp");add("externalId","Mã hóa đơn / tra cứu");add("previous","Mã hóa đơn gốc nếu điều chỉnh");}
   if(mode==="store"){add("sku","Mã vật tư");add("unit","Đơn vị cơ sở");add("pack","Đơn vị nhập (bỏ trống nếu dùng đơn vị cơ sở)");if(k==="conversion")add("factor","Một đơn vị nhập bằng bao nhiêu đơn vị cơ sở",input("","number"));else add("qty","Số lượng nhập hoặc chuyển",input("","number"));
    if(k==="transfer"||k==="local_issue")add("fromLoc","Từ điểm",input("MAIN"));if(k==="transfer")add("toLoc","Đến điểm");
    if(k==="local_issue"){add("costItemId","Khoản mục",select(C.sanitizeOperatingCostsState(snap.operatingCosts).items.map(i=>[i.id,i.name])));add("purpose","Mục đích");
     const bookingField=add("booking","Booking dùng dịch vụ (nếu xuất kho theo phòng)",select([["","Dùng chung"],...list.map(b=>[b.id,b.roomId+" · "+b.guestName])]));
     const serviceField=add("serviceId","Dịch vụ được tính giá vốn",select([]));
     function sourceServices(){serviceField.replaceChildren(new Option("Dùng chung",""));for(const sv of booking()?.services||[])if(sv.status!=="cancelled")serviceField.add(new Option(sv.name,sv.id));}
     sourceServices();bookingField.onchange=sourceServices;}
    if(k==="delivery"){const inv=add("invoiceId","Hóa đơn",select(fin.supplierInvoices.map(i=>[i.id,i.voucherNo]))),line=add("lineId","Dòng hóa đơn",select([]));const set=()=>{line.replaceChildren();for(const l of fin.supplierInvoices.find(i=>i.id===inv.value)?.lines||[])line.add(new Option(l.description||l.id,l.id));};set();inv.onchange=set;add("totalQty","Tổng lượng đặt theo đơn vị cơ sở",input("","number"));}}
   function payload(){const item={kind:k,day:chosenDay};for(const [key,node] of Object.entries(f))item[key]=node.type==="checkbox"?node.checked:node.value.trim();if(k==="split"&&item.mode==="bps")item.share=Math.round(Number(item.share)*100);if(k==="plan"){const special={};for(const line of item.special.split("\n").filter(v=>v.trim())){const parts=line.split("|").map(v=>v.trim());if(parts.length!==2||!C.isValidISODate(parts[0])||!/^\d+$/.test(parts[1])||Object.hasOwn(special,parts[0]))throw Error("Kiểm tra ngày, số tiền và ngày trùng trong giá ngoại lệ.");special[parts[0]]=parts[1];}item.special=special;}if(k==="roster")item.guests=item.guests.split(/\r?\n/).filter(x=>x.trim()).map(s=>{const [name,country="",document=""]=s.split("|").map(v=>v.trim());return {name,country,document};});return item;}
   form.oninput=()=>{intent="";preview.replaceChildren();};
   const submit=button(k==="night_preview"?"Đối chiếu ngày":"Kiểm tra và ghi",async()=>{
     let body;try{body=payload();}catch(e){msg.textContent=e.message;return;}if(k!=="night_preview"&&!confirm(ops[k]+" · "+(booking()?.guestName||body.room||body.sku||body.code||chosenDay)+"?"))return;
     if(!intent)intent=crypto.randomUUID();submit.disabled=true;
     try{const r=await c.ops24Apply(body,data.version,intent);if(n!==rev||!dlg.open)return;if(!r?.ok)throw Error(r?.error||"Ghi thất bại.");
       if(k!=="night_preview"){await load("Đã ghi và đọc lại từ máy chủ.");return;}
       const t=r.result;preview.replaceChildren();table(preview,["Đêm phòng","Tiền phòng trong ngày","Dịch vụ thực tế","Quỹ"],[[t.roomNights,money(t.roomRevenue),money(t.serviceRevenue),t.cashClosed?"Đã chốt":"Chưa chốt"]]);for(const issue of t.issues)preview.append(el("p",issue));
       if(r.closed)preview.append(el("p","Biên bản ngày đã chốt."));else if(!t.issues.length)preview.append(button("Xác nhận chốt ngày",async()=>{if(!confirm("Chốt ngày "+chosenDay+"?"))return;try{const z=await c.ops24Apply({...body,kind:"night_close",expected:t},data.version,crypto.randomUUID());if(!z?.ok)throw Error(z?.error||"Chưa chốt được.");await load("Đã chốt ngày.");}catch(e){msg.textContent=e.message;}}));
     }catch(e){if(n===rev)msg.textContent=e.message+" · Tải lại nếu dữ liệu đã thay đổi.";}finally{submit.disabled=false;}
   });form.append(submit);
 }kind.onchange=fields;fields();
}
function open(){if(!c.can("bookings:read"))return;mode="board";chosenDay=today();if(!dlg.open)dlg.showModal();nav.replaceChildren();for(const [key,name] of Object.entries(tabs))if(manager()||!["store","night","rooms"].includes(key))nav.append(button(name,()=>{mode=key;load();}));nav.append(button("Tải lại",()=>load()));load();}
dlg.querySelector("[data-exit]").onclick=()=>dlg.close();dlg.onclose=()=>{rev++;main.replaceChildren();msg.textContent="";snap=data=null;};
c.subscribe(e=>{if(dlg.open&&(e?.type==="auth_login"||e?.type==="auth_required"||!c.can("bookings:read")))dlg.close();});document.querySelector("#btn-ops24").onclick=open;window.DongvanOps={open};
})();
