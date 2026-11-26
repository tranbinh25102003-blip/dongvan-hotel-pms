/* Room and group statements share the PMS booking/entity and cash ledger. */
(function (root) {
  "use strict";
  const C = root.PMSCore || require("./pms-core.js");
  const labels = { guest: "Khách", tour: "Công ty tour", ota: "OTA thu hộ" };
  function payer(b, key) {
    const routing = b.folioRouting || {};
    const defaultRoom = ["booking","agoda","airbnb","expedia","traveloka"].includes(String(b.channelKey).toLowerCase()) ? "ota" : "guest";
    const fallback = routing.room || defaultRoom;
    const selected = routing[key] || (key.startsWith("service:") ? routing.services : key.startsWith("adjustment:") ? routing.adjustments : null) || fallback;
    return Object.hasOwn(labels,selected) ? selected : defaultRoom;
  }
  function party(b, role) {
    const name = role === "guest" ? b.guestName : role === "tour" ? b.tourName : b.channelKey;
    const id = role === "guest" ? b.id : String(name || b.id).trim().toLowerCase();
    return { id: role + "/" + id, name: labels[role] + " · " + (name || b.roomId), role };
  }
  function statements(bookings, finance) {
    const {entities, bookingToEntity} = C.buildFinanceEntities(bookings);
    const byId = new Map(bookings.map(b => [b.id,b]));
    const groups = new Map(entities.filter(e=>e.groupCode).map(e=>[e.groupCode,e]));
    const sheets = new Map(entities.map(e=>[e.entityKey,{entity:e, rows:[], pending:[]}]));
    const receipts = new Map();
    function append(b, key, date, memo, charge, payment, deposit, type) {
      const sheet = sheets.get(bookingToEntity.get(b.id).entityKey);
      const who = party(b,payer(b,key));
      const row = {b,key,date,memo,charge,payment,deposit,type,who};
      sheet.rows.push(row);
      return row;
    }
    for (const b of bookings) {
      if (C.isBookingCancelled(b)) {
        const pol = b.cancelDepositPolicy || {};
        if (pol.revenueRecognized && pol.retainedAmount > 0) append(b,"room",pol.recognizedDate || String(b.cancelledAt || b.checkout).slice(0,10),"Cọc giữ theo quyết định hủy",0,0,-Number(pol.retainedAmount),"retain");
        continue;
      }
      const nights = C.diffNights(b.checkin,b.checkout);
      const amount = C.getBookingChargesBreakdown(b).roomAmount;
      for (let i=0;i<nights;i++) {
        const share = Math.round(amount*(i+1)/nights)-Math.round(amount*i/nights);
        append(b,"room",C.addDaysISO(b.checkin,i),"Tiền phòng",share,0,0,"room");
      }
      for (const s of b.services || []) if(s.status !== "cancelled") append(b,"service:"+s.id,s.serviceDate || s.dateISO || b.checkin,s.name || "Dịch vụ",Number(s.amount),0,0,"service");
      for (const a of b.adjustments || []) if(a.status !== "cancelled") append(b,"adjustment:"+a.id,a.effectiveDate || b.checkin,a.reason || "Điều chỉnh",Number(a.amount),0,0,"adjustment");
    }
    const seen = new Set();
    for (const t of finance.transactions || []) {
      if (!t.id || seen.has(t.id) || t.status === "voided" || !["customer_payment","customer_refund","legacy_payment"].includes(t.txType)) continue;
      seen.add(t.id);
      const b = byId.get(t.bookingId) || groups.get(C.normalizeGroupCode(t.groupCode))?.bookings[0];
      if (!b) continue;
      const sheet = sheets.get(bookingToEntity.get(b.id).entityKey);
      if (!C.isValidISODate(t.receivedDate) || (t.txType === "legacy_payment" && t.legacyStatus !== "reconciled")) {
        sheet.pending.push(t);
        continue;
      }
      const refund = t.txType === "customer_refund";
      const isDeposit = refund ? t.refundCategory === "cancel_refund" || t.receivedDate < b.checkin : t.receivedDate < b.checkin;
      const amt = Number(t.amount)*(refund ? -1 : 1);
      receipts.set(t.id,append(b,"receipt:"+t.id,t.receivedDate,(isDeposit ? "Cọc · " : "")+(t.voucherCode || t.txType),0,isDeposit ? 0 : amt,isDeposit ? amt : 0,"receipt"));
    }
    for (const s of sheets.values()) s.rows.sort((a,b)=>a.date.localeCompare(b.date));
    return {sheets,receipts};
  }
  function balances(sheet,date) {
    const sums = new Map();
    for (const row of sheet.rows) {
      if (row.date > date) continue;
      let s = sums.get(row.who.id);
      if (!s) { s = {who:row.who,charges:0,paid:0,deposits:0}; sums.set(row.who.id,s); }
      s.charges+=row.charge; s.paid+=row.payment; s.deposits+=row.deposit;
    }
    for (const s of sums.values()) {
      s.applied=Math.min(Math.max(0,s.deposits),Math.max(0,s.charges));
      s.held=s.deposits-s.applied;
      s.balance=s.charges-s.applied-s.paid;
    }
    return sums;
  }
  const api={payer,party,statements,balances,labels};
  root.PMSFolio=api;
  if(typeof module!=="undefined" && module.exports) module.exports=api;
})(typeof window==="undefined" ? globalThis : window);
