(function(){
  "use strict";
  const C=window.PMSCore, F=window.PMSFolio, client=window.pmsClient;
  const dialog=document.querySelector("#folio-dialog"), body=dialog.querySelector("section");
  const status=dialog.querySelector("[role=status]"), title=dialog.querySelector("h2");
  const selector=dialog.querySelector("#folio-select"), date=dialog.querySelector("[type=date]");
  const controls=dialog.querySelector("footer");
  let mode="", request=0;
  function element(tag,text) {
    const el=document.createElement(tag);
    if(text!==undefined) el.textContent=text;
    return el;
  }
  function button(text,fn) {
    const el=element("button",text);
    el.type="button"; el.onclick=fn; return el;
  }
  function option(value,text) {
    return new Option(text,value);
  }
  function table(headers) {
    const t=element("table"), head=t.createTHead().insertRow();
    for(const h of headers) head.append(element("th",h));
    body.append(t);
    return t.createTBody();
  }
  function tr(tb,values) {
    const r=tb.insertRow();
    for(const v of values) r.insertCell().textContent=v;
    return r;
  }
  const money=n=>Number(n).toLocaleString("vi-VN")+" đ";
  async function refresh(pull=false) {
    const id=++request;
    body.replaceChildren();controls.replaceChildren();status.textContent="Đang tải…";
    const active=()=>id===request && dialog.open && client.can(mode==="folio"?"finance:ar_read":"reports:management");
    try {
      if(!C.isValidISODate(date.value)) throw Error("Chọn ngày hợp lệ.");
      if(mode==="close") {
        if(!client.dayClose) throw Error("Chốt ngày cần kết nối Supabase có migration v2.1.");
        const day=date.value;
        const res=await client.dayClose(day);
        if(!active())return;
        if(!res?.ok) throw Error(res?.error || "Chưa đọc được biên bản máy chủ.");
        const report=res.report;
        const t=table(["Quỹ","Sổ cuối ngày","Thực kiểm","Chênh lệch"]);
        for(const f of report.funds) tr(t,[f.fund==="bank_main"?"Ngân hàng":"Tiền mặt",money(f.balance),f.actual==null?"Chưa có kiểm đếm":money(f.actual),f.difference==null?"—":money(f.difference)]);
        body.append(element("p","Ca chưa hoàn tất: "+report.openShifts+" · Khoản chuyển tiếp cần đối soát: "+report.pendingLegacy));
        const total=types=>report.transactions.filter(t=>types.includes(t.txType)).reduce((n,t)=>n+Number(t.amount),0);
        body.append(element("p","Thu khách "+money(total(["customer_payment","legacy_payment"]))+" · Hoàn khách "+money(total(["customer_refund"]))+" · Trả nhà cung cấp "+money(total(["supplier_payment"]))));
        const tx=table(["Chứng từ trong ngày","Nghiệp vụ","Số tiền"]);
        const names={customer_payment:"Thu khách",legacy_payment:"Thu chuyển tiếp",customer_refund:"Hoàn khách",supplier_payment:"Trả nhà cung cấp",balance_adjustment:"Điều chỉnh quỹ",fund_transfer:"Chuyển quỹ"};
        for(const v of report.transactions) tr(tx,[v.voucherCode || v.id,names[v.txType] || v.txType,money(v.amount)]);
        status.textContent=res.closed?"Đã chốt bởi "+res.closedBy+" · "+new Date(res.closedAt).toLocaleString("vi-VN",{timeZone:"Asia/Ho_Chi_Minh"}):"Biên bản quỹ đang mở · "+report.blockers+" mục cần xử lý.";
        const review=button("Đối chiếu công nợ và sổ cái",async()=>{
          review.disabled=true;
          const info=element("p","Đang đọc dữ liệu đối chiếu…");
          body.append(info);
          try {
            const fresh=await client.pullLatest();
            if(!active())return;
            if(!fresh?.ok) throw Error(fresh?.error || "Chưa đọc được PMS.");
            const snap=client.getSnapshot(), gl=await client.refreshEnterpriseGlState();
            if(!active())return;
            if(!gl?.ok || !gl.enterpriseGlState) throw Error(gl?.error || "Chưa đọc được sổ cái máy chủ.");
            if(gl.storeVersion!=null && gl.storeVersion!==snap.storeVersion) throw Error("Dữ liệu vừa thay đổi. Bấm Tải lại.");
            const er=window.PMSEnterpriseReport;
            const ar=C.computeReceivablesReport(snap.bookings,snap.financeState,{asOfDate:day});
            const ap=C.computeSupplierPayablesReport(snap.financeState,null,{asOfDate:day});
            const period=er.period(day.slice(0,7),"month");
            const batch=er.buildPmsAutoPostEntries(snap,gl.enterpriseGlState,{...period,to:day},{asOfDate:day,sourceMode:gl.enterpriseGlState.sourceMode});
            info.textContent="Đối chiếu lại theo dữ liệu hiện tại đến "+day+" · Khách còn nợ "+money(ar.totalRemaining)+" · Nợ nhà cung cấp "+money(ap.totalRemaining)+" · "+batch.entries.length+" bút toán PMS chờ ghi từ đầu tháng · "+batch.unresolvedLegacy.length+" mục cần rà soát.";
          } catch(err) {if(active()){info.textContent=err.message;review.disabled=false;}}
        });
        controls.append(review);
        if(!res.closed) {
          const save=button("Chốt sổ quỹ ngày "+day,async()=>{
            if(!active() || day!==date.value || !window.confirm("Lưu bản đối chiếu cố định cho ngày "+day+"?")) return;
            save.disabled=true;
            try {
              const reply=await client.dayClose(day,report);
              if(!active()) return;
              if(!reply?.ok) throw Error(reply?.error || "Chốt ngày thất bại.");
              await refresh();
            } catch(err) {if(active()) {status.textContent=err.message;save.disabled=false;}}
          });
          save.disabled=report.blockers>0;
          controls.append(save);
        }
      } else {
        if(pull && client.pullLatest) {
          const fresh=await client.pullLatest();
          if(!active()) return;
          if(fresh?.ok===false) throw Error(fresh.error || "Tải lại dữ liệu thất bại.");
        }
        if(!active()) return;
        const snap=client.getSnapshot();
        if(!snap.financeState || ["error","loading"].includes(snap.financeLoadState)) throw Error("Chưa tải xong sổ tài chính.");
        const {sheets}=F.statements(snap.bookings,snap.financeState);
        const old=selector.value;
        selector.replaceChildren(...Array.from(sheets,([k,s])=>option(k,(s.entity.groupCodeDisplay || s.entity.guestName)+" · "+s.entity.roomLabel)));
        if(sheets.has(old)) selector.value=old;
        const sheet=sheets.get(selector.value);
        if(!sheet){status.textContent="Chưa có đơn đặt phòng.";return;}
        const rows=sheet.rows.filter(r=>r.date<=date.value);
        const sums=table(["Người trả","Phát sinh","Thanh toán ròng","Phí OTA đã cấn","Cọc đã cấn","Cọc còn giữ","Dư phải thu (+) / trả thừa (−)"]);
        for(const s of F.balances(sheet,date.value).values()) tr(sums,[s.who.name,...[s.charges,s.paid,s.cleared,s.applied,s.held,s.balance].map(money)]);
        const items=table(["Ngày","Phòng","Diễn giải","Phát sinh","Thu / hoàn","Phí OTA đã cấn","Biến động cọc","Người trả"]);
        for(const r of rows) tr(items,[r.date,r.b.roomId,r.memo,money(r.charge),money(r.payment),money(r.cleared||0),money(r.deposit),r.who.name]);
        status.textContent="Bảng kê theo đêm lưu trú đến "+date.value+" · "+sheet.pending.length+" phiếu chuyển tiếp theo dõi riêng.";
        for(const t of sheet.pending) body.append(element("p",(t.voucherCode || t.id)+" · "+money(t.amount)+" · "+(t.legacyStatus==="reconciled_in_opening"?"Đã gồm trong đầu kỳ":"Chưa đủ ngày hoặc quỹ")));
        if(client.can("bookings:write")) {
          const route=element("select"), who=element("select");
          route.setAttribute("aria-label","Khoản phân bổ");who.setAttribute("aria-label","Người trả");
          const choices=[];
          for(const b of sheet.entity.bookings) {
            const keys = new Map([["room","Tiền phòng"],["services","Dịch vụ mặc định"],["adjustments","Điều chỉnh mặc định"]]);
            for(const r of sheet.rows.filter(x=>x.b.id===b.id && x.key!=="room")) keys.set(r.key,r.memo);
            for(const [key,label] of keys) {route.add(option(String(choices.length),"P."+b.roomId+" · "+label));choices.push({b,key});}
          }
          who.add(option("","Dùng quy tắc mặc định"));
          for(const [k,v] of Object.entries(F.labels)) who.add(option(k,v));
          route.onchange=()=>{
            const {b,key}=choices[route.selectedIndex];
            who.value=b.folioRouting?.[key] || "";
            who.options[0].text="Mặc định · "+F.labels[F.payer({...b,folioRouting:Object.fromEntries(Object.entries(b.folioRouting || {}).filter(([k])=>k!==key))},key)];
          };
          route.onchange();
          const save=button("Lưu người trả",async()=>{
            if(!active()) return;
            const {b,key}=choices[route.selectedIndex], routing={...b.folioRouting};
            if(who.value) routing[key]=who.value; else delete routing[key];
            save.disabled=true;
            try {
              const res=await client.saveBooking({...b,folioRouting:routing},{expectedRevision:b.revision});
              if(!active()) return;
              if(!res?.ok) throw Error(res?.error || "Chưa lưu được.");
              await refresh(true);
            } catch(err){if(active()){status.textContent=err.message+" · Bấm Tải lại trước khi thử tiếp.";}}
          });
          controls.append(route,who,save);
        }
      }
      if(active()) controls.append(button("Tải lại",()=>refresh(true)),button("In / PDF",()=>window.print()));
    } catch(err){if(active()) {status.textContent=String(err.message||err);controls.append(button("Tải lại",()=>refresh(true)));}}
  }
  function open(key) {
    if(!client.can(key==="folio"?"finance:ar_read":"reports:management")) return;
    mode=key;
    title.textContent=key==="folio"?"Bảng kê phòng và đoàn":"Chốt sổ quỹ cuối ngày";
    selector.hidden=key!=="folio";date.value=C.getVietnamTodayISO();
    if(!dialog.open) dialog.showModal();
    document.body.classList.add("print-folio");
    refresh(true);
  }
  date.onchange=()=>refresh();selector.onchange=()=>refresh();
  dialog.querySelector("[data-dismiss]").onclick=()=>dialog.close();
  dialog.onclose=()=>{request++;body.replaceChildren();selector.replaceChildren();controls.replaceChildren();status.textContent="";document.body.classList.remove("print-folio");};
  client.subscribe(e=>{if(dialog.open && (e?.type==="auth_required" || e?.type==="auth_login" || !client.can(mode==="folio"?"finance:ar_read":"reports:management")))dialog.close();});
  document.querySelector("#btn-folio").onclick=()=>open("folio");
  document.querySelector("#btn-day-close").onclick=()=>open("close");
  window.PMSFolioUI={open};
})();
