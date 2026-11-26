/* ==========================================================================
   Dongvan Ville du H'mong Hotel PMS v2.5.0 — TA Contracts & Agency AR UI
   Works identically against authoritative Supabase RPCs (pms_ta_get_state /
   pms_ta_apply) AND in standalone offline staging preview mode.
   ========================================================================== */

(function () {
  "use strict";

  const T = window.PMSTaContracts;
  const C = window.PMSCore;
  const c = window.pmsClient;
  const dlg = document.getElementById("ta-dialog");
  if (!dlg || !T || !C) return;

  const main = dlg.querySelector("main");
  const msg = dlg.querySelector("[role=status]");
  const nav = dlg.querySelector("nav");

  const money = (n) => Number(n || 0).toLocaleString("vi-VN") + " đ";
  const todayISO = () => (C.getVietnamTodayISO ? C.getVietnamTodayISO() : T.getVietnamTodayISO());
  const isMgr = () => Boolean(c && c.can && c.can("reports:management"));
  const isRecOrMgr = () => Boolean(c && c.can && (c.can("bookings:write") || c.can("reports:management")));

  let state = {
    storeVersion: 0,
    agencies: [],
    contracts: [],
    groups: [],
    allocations: [],
    statements: [],
    auditEvents: [],
    snap: null
  };
  let activeTab = "queue";
  let filterAgency = "";
  let filterGroup = "";
  let filterAsOf = todayISO();
  let busy = false;
  let lastReqKey = "";

  // Standalone local staging store fallback (used only when no Supabase taRead RPC exists)
  const LOCAL_KEY = "dongvan_pms_v25_local_ta_v1";
  function seedLocalIfEmpty() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch { raw = null; }
    if (raw && Array.isArray(raw.agencies) && raw.agencies.length > 0) return raw;
    const sampleAgency = {
      code: "TA-HA-GIANG-01",
      legalName: "Công ty TNHH Du lịch Cao nguyên Đá Hà Giang",
      tradeName: "Hà Giang Discovery Tour",
      taxCode: "5100456789",
      bookingContact: "Ms. Lan (0912.345.678)",
      accountingContact: "Ms. Hoa (kt@hagiangtour.vn)",
      creditLimit: 50000000,
      creditApprovedUntil: "2027-12-31",
      creditStatus: "active",
      openingVerified: true,
      docs: [
        { id: "DOC-GPKD-01", label: "Giấy chứng nhận ĐKDN", status: "verified" },
        { id: "DOC-GPLH-01", label: "Giấy phép kinh doanh lữ hành", status: "verified" },
        { id: "DOC-HD2027-01", label: "Hợp đồng Lữ hành 2027 đã ký đóng dấu 2 bên", status: "verified" }
      ]
    };
    const sampleContract = T.defaultContract2027({
      id: "CTR-2027-HG01-V1",
      agencyCode: "TA-HA-GIANG-01",
      versionNo: 1,
      calendars: {
        holidaySurchargeDates: ["2027-04-30", "2027-05-01", "2027-09-02"],
        holidayDepositDates: ["2027-04-30", "2027-05-01", "2027-09-02"],
        peakCancelDates: ["2027-04-30", "2027-05-01", "2027-09-02"]
      }
    });
    const seeded = {
      storeVersion: 1,
      agencies: [sampleAgency],
      contracts: [sampleContract],
      groups: [],
      allocations: [],
      statements: [],
      auditEvents: [],
      localTransactions: []
    };
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(seeded)); } catch {}
    return seeded;
  }

  function saveLocal(data) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); } catch {}
  }

  function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }

  function btn(text, fn, cls) {
    const b = el("button", text, cls || "btn btn-sm");
    b.type = "button";
    b.onclick = fn;
    return b;
  }

  function makeTable(parent, headers, rows) {
    const wrap = el("div", null, "ops-scroll");
    const t = el("table");
    const trH = t.createTHead().insertRow();
    headers.forEach((h) => trH.append(el("th", h)));
    const tb = t.createTBody();
    if (!rows.length) {
      const r = tb.insertRow();
      const td = r.insertCell();
      td.colSpan = headers.length;
      td.textContent = "Chưa có dữ liệu.";
    } else {
      rows.forEach((vals) => {
        const r = tb.insertRow();
        vals.forEach((v) => {
          const td = r.insertCell();
          if (v instanceof Node) td.append(v);
          else td.textContent = v == null ? "" : String(v);
        });
      });
    }
    wrap.append(t);
    parent.append(wrap);
    return t;
  }

  function downloadFile(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function newRequestId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function getFinanceState() {
    if (c && c.taRead) return state.snap?.financeState || { transactions: [] };
    const local = seedLocalIfEmpty();
    const baseFin = (c && c.getSnapshot && c.getSnapshot()?.financeState) || { transactions: [] };
    const mergedTxs = [...(baseFin.transactions || []), ...(local.localTransactions || [])];
    return { ...baseFin, transactions: mergedTxs };
  }

  async function loadState(note) {
    msg.textContent = "Đang tải dữ liệu Đại lý & Công nợ v2.5…";
    try {
      if (c && typeof c.taRead === "function") {
        if (c.pullLatest) await c.pullLatest();
        const snap = c.getSnapshot ? c.getSnapshot() : {};
        const r = await c.taRead();
        if (!r || !r.ok) throw new Error(r?.error || "Không tải được dữ liệu Đại lý v2.5.");
        state = {
          storeVersion: r.storeVersion || snap.storeVersion || 0,
          agencies: r.agencies || [],
          contracts: r.contracts || [],
          groups: r.groups || [],
          allocations: r.allocations || [],
          statements: r.statements || [],
          auditEvents: r.auditEvents || [],
          snap
        };
      } else {
        const local = seedLocalIfEmpty();
        state = {
          ...local,
          snap: (c && c.getSnapshot) ? c.getSnapshot() : { bookings: [], financeState: { transactions: [] } }
        };
      }
      msg.textContent = note || (c && c.taRead ? "Đã đồng bộ máy chủ v2.5." : "Chế độ chạy thử cục bộ v2.5 (dữ liệu mẫu 2027).");
      render();
    } catch (err) {
      msg.textContent = "Lỗi: " + (err?.message || err);
    }
  }

  async function applyOp(body, reqId) {
    if (busy) return null;
    busy = true;
    const rid = reqId || newRequestId(body.kind || "ta");
    lastReqKey = rid;
    try {
      if (c && typeof c.taApply === "function") {
        const res = await c.taApply(body, state.storeVersion, rid);
        if (!res || !res.ok) throw new Error(res?.error || "Ghi máy chủ thất bại");
        await loadState(res.replay ? "Đã nhận lại kết quả giao dịch cũ (chống ghi trùng)." : "Đã ghi máy chủ thành công.");
        return res;
      }
      // Local standalone staging executor (for direct offline/preview trial!)
      const local = seedLocalIfEmpty();
      if (local.auditEvents.some((e) => e.requestId === rid)) {
        await loadState("Giao dịch trùng mã đã được bảo vệ chống ghi lặp.");
        return { ok: true, replay: true };
      }
      const nowIso = new Date().toISOString();
      if (body.kind === "upsert_agency") {
        const code = String(body.code || "").trim().toUpperCase();
        const idx = local.agencies.findIndex((a) => a.code === code);
        const rec = { ...(idx >= 0 ? local.agencies[idx] : {}), ...body, code };
        delete rec.kind;
        if (idx >= 0) local.agencies[idx] = rec; else local.agencies.push(rec);
      } else if (body.kind === "upsert_contract") {
        const idx = local.contracts.findIndex((x) => x.id === body.id);
        const rec = { ...T.defaultContract2027(body), ...body };
        delete rec.kind;
        if (idx >= 0) local.contracts[idx] = rec; else local.contracts.push(rec);
      } else if (body.kind === "save_group_quote" || body.kind === "hold_group" || body.kind === "confirm_group") {
        const idx = local.groups.findIndex((g) => g.id === body.id);
        const st = body.kind === "save_group_quote" ? (body.status || "quoted") : (body.kind === "hold_group" ? "held" : "confirmed");
        const rec = {
          ...(idx >= 0 ? local.groups[idx] : { serviceLines: [], invoices: [], adjustments: [], approvalRequests: [] }),
          ...body, status: st, confirmedAt: st === "confirmed" ? nowIso : undefined
        };
        delete rec.kind;
        if (idx >= 0) local.groups[idx] = rec; else local.groups.unshift(rec);
      } else if (body.kind === "add_group_service") {
        const g = local.groups.find((x) => x.id === body.groupId);
        if (g) { g.serviceLines = g.serviceLines || []; g.serviceLines.push(body.service); }
      } else if (body.kind === "record_invoice") {
        const g = local.groups.find((x) => x.id === body.groupId);
        if (g) { g.invoices = g.invoices || []; g.invoices.push(body.invoice); }
      } else if (body.kind === "update_invoice_receipt") {
        const g = local.groups.find((x) => x.id === body.groupId);
        const inv = g && (g.invoices || []).find((i) => i.id === body.invoiceId);
        if (inv) { inv.receivedDate = body.receivedDate || null; inv.deliveryProof = body.deliveryProof || ""; }
      } else if (body.kind === "record_ta_receipt") {
        const txId = body.sourceTxId || ("PT-TA-" + Date.now().toString(36).toUpperCase());
        local.localTransactions.push({
          id: txId, voucherNo: txId, txType: "customer_payment", status: "posted",
          fundId: body.fundId || "bank_main", amount: T.roundVnd(body.amount),
          expectedAmount: T.roundVnd(body.expectedAmount || body.amount),
          businessDate: body.businessDate || todayISO(), agencyCode: body.agencyCode,
          bankRef: body.bankRef || "", note: body.note || ""
        });
        for (const al of (body.allocations || [])) {
          local.allocations.push({
            seq: local.allocations.length + 1, requestId: rid + ":" + al.groupId,
            sourceTxId: txId, agencyCode: body.agencyCode, groupId: al.groupId,
            kind: "allocate", amount: T.roundVnd(al.amount), effectiveDay: body.businessDate || todayISO(),
            detail: al.detail || {}, actor: "Thử nghiệm v2.5"
          });
        }
      } else if (body.kind === "allocate_receipt") {
        const fin = getFinanceState();
        const rbs = T.computeReceiptBalances(local.allocations, fin);
        const rb = rbs.find((x) => x.sourceTxId === body.sourceTxId);
        if (!rb || T.roundVnd(body.amount) > rb.unallocated) throw new Error("Số tiền chưa phân bổ không đủ");
        local.allocations.push({
          seq: local.allocations.length + 1, requestId: rid,
          sourceTxId: body.sourceTxId, agencyCode: rb.agencyCode, groupId: body.groupId,
          kind: "allocate", amount: T.roundVnd(body.amount), effectiveDay: body.effectiveDay || todayISO(),
          detail: body.detail || {}, actor: "Thử nghiệm v2.5"
        });
      } else if (body.kind === "approve_force_majeure") {
        const half = Math.floor(T.roundVnd(body.paidAmount) / 2);
        local.allocations.push(
          { seq: local.allocations.length + 1, requestId: rid + ":rf", sourceTxId: body.sourceTxId || body.groupId, agencyCode: body.agencyCode, groupId: body.groupId, kind: "refund_approve", amount: half, effectiveDay: body.effectiveDay || todayISO(), detail: { reason: body.reason }, actor: "Quản lý" },
          { seq: local.allocations.length + 2, requestId: rid + ":rs", sourceTxId: body.sourceTxId || body.groupId, agencyCode: body.agencyCode, groupId: body.groupId, kind: "reserve_grant", amount: T.roundVnd(body.paidAmount) - half, effectiveDay: body.effectiveDay || todayISO(), detail: { reason: body.reason }, actor: "Quản lý" }
        );
      } else if (body.kind === "pay_approved_refund") {
        const txId = "PC-TA-" + Date.now().toString(36).toUpperCase();
        local.localTransactions.push({
          id: txId, voucherNo: txId, txType: "customer_refund", status: "posted",
          fundId: body.fundId || "bank_main", amount: T.roundVnd(body.amount),
          businessDate: body.effectiveDay || todayISO(), agencyCode: body.agencyCode, note: body.reason || "Hoàn bất khả kháng"
        });
        local.allocations.push({
          seq: local.allocations.length + 1, requestId: rid, sourceTxId: txId, agencyCode: body.agencyCode, groupId: body.groupId,
          kind: "refund_pay", amount: T.roundVnd(body.amount), effectiveDay: body.effectiveDay || todayISO(), detail: { reason: body.reason }, actor: "Quản lý"
        });
      } else if (body.kind === "apply_credit_reserve") {
        local.allocations.push({
          seq: local.allocations.length + 1, requestId: rid, sourceTxId: "RESERVE-" + body.agencyCode, agencyCode: body.agencyCode, groupId: body.groupId,
          kind: "reserve_use", amount: T.roundVnd(body.amount), effectiveDay: body.effectiveDay || todayISO(), detail: { reason: body.reason }, actor: "Quản lý"
        });
      } else if (body.kind === "post_adjustment") {
        const g = local.groups.find((x) => x.id === body.groupId);
        if (g) {
          g.adjustments = g.adjustments || [];
          g.adjustments.push({
            id: body.adjCode || ("ADJ-" + Date.now().toString(36)),
            code: body.adjCode || ("ADJ-" + Date.now().toString(36)),
            amount: T.roundVnd(body.amount),
            effectiveDate: body.effectiveDate || todayISO(),
            effectivePeriod: body.effectivePeriod || (body.effectiveDate || todayISO()).slice(0, 7),
            reason: body.reason || "",
            approvedBy: "Quản lý"
          });
        }
      } else if (body.kind === "send_statement") {
        local.statements.unshift({
          id: body.statementId || ("STMT-" + Date.now().toString(36).toUpperCase()),
          agencyCode: body.agencyCode, periodFrom: body.periodFrom, periodTo: body.periodTo,
          status: "sent", snapshot: body.snapshot, sentBy: "Quản lý", sentAt: nowIso
        });
      }
      local.storeVersion += 1;
      local.auditEvents.unshift({ seq: local.auditEvents.length + 1, requestId: rid, kind: body.kind, entityId: body.id || body.groupId || body.agencyCode || "", actor: "Thử nghiệm v2.5", reason: body.reason || "", createdAt: nowIso });
      saveLocal(local);
      await loadState("Đã lưu thành công trên bản chạy thử v2.5.");
      return { ok: true, replay: false };
    } catch (err) {
      msg.textContent = "Không ghi được: " + (err?.message || err);
      return null;
    } finally {
      busy = false;
    }
  }

  function computeAvailableRoomsByCategory(checkin, checkout) {
    const bookings = state.snap?.bookings || [];
    const occupied = new Set();
    for (const b of bookings) {
      if (b.status === "cancelled") continue;
      if (b.checkin < checkout && b.checkout > checkin) occupied.add(String(b.roomId));
    }
    // Also count locally confirmed/held rooms in offline preview mode
    if (!c || !c.taRead) {
      for (const g of state.groups) {
        if (!["held", "confirmed", "partially_cancelled"].includes(g.status)) continue;
        if (g.checkin < checkout && g.checkout > checkin) {
          for (const rid of (g.assignedRoomIds || [])) occupied.add(String(rid));
        }
      }
    }
    return T.ROOM_CATEGORIES_2027.map((cat) => {
      const freeIds = cat.roomIds.filter((rid) => !occupied.has(rid));
      return { ...cat, freeIds, freeCount: freeIds.length };
    });
  }

  function renderTabs() {
    nav.replaceChildren();
    const tabs = isMgr()
      ? [
          ["queue", "Việc cần làm hôm nay"],
          ["groups", "Đoàn & Báo giá (HĐ 2027)"],
          ["agencies", "Hợp đồng & Đại lý"],
          ["payments", "Thu cọc & Phân bổ"],
          ["statements", "Đối chiếu & Chuyển tiếp"]
        ]
      : [
          ["groups", "Khách đoàn & Báo giá (HĐ 2027)"],
          ["payments", "Ghi nhận thu cọc"]
        ];
    if (!tabs.some(([k]) => k === activeTab)) activeTab = tabs[0][0];
    for (const [k, labelText] of tabs) {
      const b = btn(labelText, () => { activeTab = k; render(); }, k === activeTab ? "btn btn-sm btn-primary" : "btn btn-sm");
      b.dataset.taTab = k;
      nav.append(b);
    }
  }

  function renderQueueTab() {
    const fin = getFinanceState();
    const bar = el("div", null, "ta-filter-bar");
    const selAg = el("select");
    selAg.add(new Option("Tất cả đại lý", ""));
    state.agencies.forEach((a) => selAg.add(new Option(`${a.code} — ${a.tradeName || a.legalName}`, a.code)));
    selAg.value = filterAgency;
    selAg.onchange = () => { filterAgency = selAg.value; render(); };

    const inpGrp = el("input");
    inpGrp.placeholder = "Lọc mã đoàn…";
    inpGrp.value = filterGroup;
    inpGrp.oninput = () => { filterGroup = inpGrp.value.trim(); render(); };

    const inpDate = el("input");
    inpDate.type = "date";
    inpDate.value = filterAsOf;
    inpDate.onchange = () => { if (inpDate.value) { filterAsOf = inpDate.value; render(); } };

    bar.append(el("label", "Đại lý: "), selAg, el("label", "Đoàn: "), inpGrp, el("label", "Ngày chốt: "), inpDate);
    main.append(bar);

    const queue = T.computeWorkQueue({
      agencies: state.agencies,
      groups: state.groups,
      allocations: state.allocations,
      financeState: fin,
      asOfDate: filterAsOf
    }).filter((it) =>
      (!filterAgency || it.agencyCode === filterAgency) &&
      (!filterGroup || String(it.groupCode || "").toLowerCase().includes(filterGroup.toLowerCase()))
    );

    const summary = el("p", `Có ${queue.length} đầu việc ưu tiên tại ngày ${filterAsOf}. Tổng số tiền cần theo dõi: ${money(queue.reduce((s, i) => s + i.amount, 0))}.`);
    main.append(summary);

    makeTable(
      main,
      ["Ưu tiên", "Đại lý", "Đoàn", "Hạng mục", "Số tiền", "Hạn", "Phụ trách", "Thao tác"],
      queue.map((it) => [
        it.priority === 0 ? "Quá hạn" : (it.priority === 1 ? "Hôm nay" : "Nhắc việc"),
        `${it.agencyCode} (${it.agencyName})`,
        it.groupCode || "—",
        it.label,
        it.amount > 0 ? money(it.amount) : "—",
        it.dueDate || "Chờ xác minh",
        it.owner,
        btn("Mở hồ sơ", () => {
          filterAgency = it.agencyCode;
          activeTab = it.category === "unallocated_cash" ? "payments" : (it.category === "overdue_ar" || it.category === "verify_invoice_receipt" ? "statements" : "groups");
          render();
        })
      ])
    );
  }

  function renderGroupsTab() {
    const agencies = state.agencies;
    if (!agencies.length) {
      main.append(el("p", "Chưa có đại lý nào. Vào mục Hợp đồng & Đại lý để tạo hồ sơ đại lý trước."));
      return;
    }

    const box = el("section", null, "ta-card");
    box.append(el("h3", "Lập báo giá / Giữ chỗ / Xác nhận đoàn theo Hợp đồng 2027"));

    const selAg = el("select");
    agencies.forEach((a) => selAg.add(new Option(`${a.code} — ${a.tradeName || a.legalName}`, a.code)));
    if (filterAgency && agencies.some((a) => a.code === filterAgency)) selAg.value = filterAgency;

    const selCtr = el("select");
    const refreshContracts = () => {
      selCtr.replaceChildren();
      const list = state.contracts.filter((x) => x.agencyCode === selAg.value);
      list.forEach((ct) => selCtr.add(new Option(`${ct.id} (v${ct.versionNo} • ${ct.effectiveFrom} → ${ct.effectiveTo})`, ct.id)));
    };
    refreshContracts();

    const inpCode = el("input"); inpCode.value = "DOAN-" + String(state.groups.length + 1).padStart(3, "0");
    const inpName = el("input"); inpName.value = "Đoàn khách Lữ hành 2027";
    const inpBookDate = el("input"); inpBookDate.type = "date"; inpBookDate.value = todayISO();
    const inpCi = el("input"); inpCi.type = "date"; inpCi.value = "2027-05-14";
    const inpCo = el("input"); inpCo.type = "date"; inpCo.value = "2027-05-16";
    const selCat = el("select");
    T.ROOM_CATEGORIES_2027.forEach((cat) => selCat.add(new Option(`${cat.label} (tổng ${cat.roomCount} phòng)`, cat.code)));
    const inpQty = el("input"); inpQty.type = "number"; inpQty.min = "1"; inpQty.max = "26"; inpQty.value = "2";
    const inpDoc = el("input"); inpDoc.placeholder = "VD: Zalo 0912.122.721 / Email xác nhận ngày…"; inpDoc.value = "Zalo xác nhận đặt đoàn từ điều hành TA";
    const chkDorm = el("input"); chkDorm.type = "number"; chkDorm.min = "0"; chkDorm.value = "0";
    const chkExtra = el("input"); chkExtra.type = "number"; chkExtra.min = "0"; chkExtra.value = "0";

    const formGrid = el("div", null, "ta-form-grid");
    const addField = (lbl, ctrl) => { const w = el("label", lbl); w.append(ctrl); formGrid.append(w); };
    addField("Đại lý (Mã thống nhất)", selAg);
    addField("Phiên bản hợp đồng", selCtr);
    addField("Mã đoàn", inpCode);
    addField("Tên đoàn", inpName);
    addField("Ngày đặt", inpBookDate);
    addField("Nhận phòng", inpCi);
    addField("Trả phòng", inpCo);
    addField("Hạng phòng (7 hạng HĐ 2027)", selCat);
    addField("Số phòng", inpQty);
    addField("Dorm nội bộ (150k/người)", chkDorm);
    addField("Extra bed (350k/đêm, tối đa 1/phòng)", chkExtra);
    addField("Căn cứ văn bản (Zalo/Email)", inpDoc);
    box.append(formGrid);

    const previewBox = el("div", null, "ta-preview");
    box.append(previewBox);

    let lastQuote = null;
    let lastAvail = [];
    const renderPreview = () => {
      previewBox.replaceChildren();
      try {
        const ctr = state.contracts.find((x) => x.id === selCtr.value) || T.defaultContract2027();
        lastAvail = computeAvailableRoomsByCategory(inpCi.value, inpCo.value);
        const catAvail = lastAvail.find((a) => a.code === selCat.value);
        const specialItems = [];
        const nightsCount = T.listNights(inpCi.value, inpCo.value).length;
        if (Number(chkDorm.value) > 0) specialItems.push({ kind: "internal_dorm", qty: Number(chkDorm.value), nights: nightsCount, payer: "agency" });
        if (Number(chkExtra.value) > 0) specialItems.push({ kind: "extra_bed", qty: Number(chkExtra.value), roomQty: Number(inpQty.value), nights: nightsCount, payer: "agency" });

        lastQuote = T.quoteGroup({
          contract: ctr,
          checkin: inpCi.value,
          checkout: inpCo.value,
          bookedDate: inpBookDate.value,
          roomRequests: [{ categoryCode: selCat.value, qty: Number(inpQty.value), payer: "agency" }],
          specialItems
        });

        const availLine = el("p", `Phòng trống hạng ${catAvail?.label}: ${catAvail?.freeCount || 0}/${catAvail?.roomCount || 0} phòng (${(catAvail?.freeIds || []).join(", ") || "Hết phòng"})`);
        previewBox.append(availLine);
        previewBox.append(el("p", `Tổng tiền phòng: ${money(lastQuote.roomTotal)} • Tổng đại lý trả (đã gồm VAT 8% & buffet sáng, không hoa hồng): ${money(lastQuote.agencyTotal)} • Hạn danh sách khách: ${lastQuote.rosterDueDate}`));

        makeTable(
          previewBox,
          ["Đêm", "Mùa / Nhóm thứ", "Đơn giá", "Số phòng", "Thành tiền", "Căn cứ giá"],
          lastQuote.roomBreakdown[0].nightDetails.map((nd) => [
            nd.day, `Biểu ${nd.season} (${nd.band === "thu_sat" ? "T5–T7" : "CN–T4"})`,
            money(nd.unitRate), nd.qty, money(nd.subtotal), nd.basis
          ])
        );

        makeTable(
          previewBox,
          ["Lịch cọc dự kiến (không cộng thành nợ riêng)", "Hạn thu", "Số tiền"],
          lastQuote.depositSchedule.milestones.map((m) => [m.label, m.dueDate, money(m.amount)])
        );

        if (lastQuote.needsRateCompletion) {
          previewBox.append(el("p", "CẦN BỔ SUNG GIÁ: " + lastQuote.missingRateErrors.map((e) => e.reason).join("; "), "ta-warn"));
        }
        if (lastQuote.pendingApprovals.length > 0) {
          previewBox.append(el("p", "CẦN QUẢN LÝ DUYỆT: " + lastQuote.pendingApprovals.map((e) => e.reason).join("; "), "ta-warn"));
        }
      } catch (err) {
        lastQuote = null;
        previewBox.append(el("p", "Kiểm tra lại ngày nhận/trả: " + err.message, "ta-warn"));
      }
    };

    selAg.onchange = () => { refreshContracts(); renderPreview(); };
    [selCtr, inpCi, inpCo, inpBookDate, selCat, inpQty, chkDorm, chkExtra].forEach((elx) => { elx.onchange = renderPreview; });
    renderPreview();

    const buildGroupPayload = (kind) => {
      if (!lastQuote) throw new Error("Chưa có báo giá hợp lệ");
      const qty = Math.max(1, T.roundVnd(inpQty.value));
      const catAvail = lastAvail.find((a) => a.code === selCat.value);
      const chosenRoomIds = (catAvail?.freeIds || []).slice(0, qty);
      if (kind !== "save_group_quote" && chosenRoomIds.length < qty) {
        throw new Error(`Không đủ phòng trống hạng ${catAvail?.label} (cần ${qty}, còn ${chosenRoomIds.length})`);
      }
      const perRoomNights = lastQuote.roomBreakdown[0].nightDetails.map((nd) => ({ day: nd.day, amount: nd.unitRate }));
      const perRoomTotal = perRoomNights.reduce((s, r) => s + r.amount, 0);
      const ag = state.agencies.find((a) => a.code === selAg.value);
      return {
        kind,
        id: "GRP-" + inpCode.value.trim().replace(/[^A-Za-z0-9_-]/g, ""),
        groupCode: inpCode.value.trim(),
        groupName: inpName.value.trim() || inpCode.value.trim(),
        agencyCode: selAg.value,
        agencyName: ag?.tradeName || selAg.value,
        contractId: selCtr.value,
        bookedDate: inpBookDate.value,
        checkin: inpCi.value,
        checkout: inpCo.value,
        writtenRequestRef: inpDoc.value.trim(),
        rosterDueDate: lastQuote.rosterDueDate,
        rosterStatus: "pending",
        roomLines: [{ ...lastQuote.roomBreakdown[0], roomIds: chosenRoomIds }],
        assignedRoomIds: chosenRoomIds,
        assignedRooms: chosenRoomIds.map((rid) => ({ roomId: rid, totalAmount: perRoomTotal, rates: perRoomNights, payer: "agency" })),
        pricingSnapshot: lastQuote,
        depositSchedule: lastQuote.depositSchedule,
        serviceLines: lastQuote.specialLines.map((l, idx) => ({ id: "SVC-" + (idx + 1), name: l.basis, amount: l.amount, payer: l.payer, basis: l.basis }))
      };
    };

    const actions = el("div", null, "ta-actions");
    actions.append(
      btn("Lưu Báo giá", async () => { try { await applyOp(buildGroupPayload("save_group_quote")); } catch (e) { msg.textContent = e.message; } }),
      btn("Giữ chỗ (Hold)", async () => { try { await applyOp(buildGroupPayload("hold_group")); } catch (e) { msg.textContent = e.message; } }),
      btn("Xác nhận đoàn & Ghi lịch phòng", async () => { try { await applyOp(buildGroupPayload("confirm_group")); } catch (e) { msg.textContent = e.message; } }, "btn btn-sm btn-primary")
    );
    box.append(actions);
    main.append(box);

    // Existing groups list
    const listTitle = el("h3", "Danh sách đoàn đại lý");
    main.append(listTitle);
    const fin = getFinanceState();
    const rows = state.groups.map((g) => {
      const ag = state.agencies.find((a) => a.code === g.agencyCode) || { code: g.agencyCode };
      const ctr = state.contracts.find((ct) => ct.id === g.contractId);
      const ledger = T.computeAgencyLedger({ agency: ag, groups: [g], allocations: state.allocations, financeState: fin, asOfDate: filterAsOf });
      const gs = ledger.groupSummaries[0];
      const actWrap = el("div", null, "ta-actions");
      actWrap.append(
        btn("Bản gửi ĐL", () => {
          const view = T.buildConfirmationView({ group: g, agency: ag, contract: ctr, audience: "agency" });
          downloadFile(`xac-nhan-dai-ly-${g.groupCode}.json`, JSON.stringify(view, null, 2), "application/json");
        }),
        btn("Bản gửi Khách (ẩn giá)", () => {
          const view = T.buildConfirmationView({ group: g, agency: ag, contract: ctr, audience: "guest" });
          downloadFile(`xac-nhan-khach-${g.groupCode}.json`, JSON.stringify(view, null, 2), "application/json");
        }),
        btn("+ Thu cọc", () => { filterAgency = g.agencyCode; filterGroup = g.id; activeTab = "payments"; render(); }, "btn btn-sm btn-primary")
      );
      return [
        g.groupCode,
        g.agencyCode,
        `${g.checkin} → ${g.checkout}`,
        g.status,
        money(g.pricingSnapshot?.agencyTotal || 0),
        money(gs ? gs.allocatedTotal : 0),
        money(gs ? gs.openReceivable : 0),
        g.rosterDueDate || "—",
        actWrap
      ];
    });
    makeTable(main, ["Mã đoàn", "Đại lý", "Lưu trú", "Trạng thái", "Tổng HĐ", "Đã thu/cấn", "Còn phải thu", "Hạn DS khách", "Thao tác"], rows);
  }

  function renderAgenciesTab() {
    const form = el("section", null, "ta-card");
    form.append(el("h3", "Hồ sơ Đại lý & Hợp đồng 2027"));
    const inpCode = el("input"); inpCode.placeholder = "VD: TA-VIETRAVEL";
    const inpLegal = el("input"); inpLegal.placeholder = "Tên pháp nhân đầy đủ";
    const inpTrade = el("input"); inpTrade.placeholder = "Tên giao dịch";
    const inpTax = el("input"); inpTax.placeholder = "Mã số thuế";
    const inpLimit = el("input"); inpLimit.type = "number"; inpLimit.value = "50000000";
    const grid = el("div", null, "ta-form-grid");
    const addF = (l, i) => { const w = el("label", l); w.append(i); grid.append(w); };
    addF("Mã đại lý thống nhất", inpCode);
    addF("Pháp nhân", inpLegal);
    addF("Tên giao dịch", inpTrade);
    addF("Mã số thuế", inpTax);
    addF("Hạn mức tín dụng (VNĐ)", inpLimit);
    form.append(grid);
    form.append(btn("Lưu Đại lý & Tạo Hợp đồng 2027 mặc định", async () => {
      const code = inpCode.value.trim().toUpperCase();
      if (!code) { msg.textContent = "Cần nhập mã đại lý thống nhất."; return; }
      const r1 = await applyOp({
        kind: "upsert_agency", code,
        legalName: inpLegal.value.trim() || code,
        tradeName: inpTrade.value.trim() || code,
        taxCode: inpTax.value.trim(),
        creditLimit: T.roundVnd(inpLimit.value),
        creditApprovedUntil: "2027-12-31",
        creditStatus: "active",
        openingVerified: true
      });
      if (r1) {
        const ctr = T.defaultContract2027({ id: `CTR-2027-${code}-V1`, agencyCode: code, versionNo: 1 });
        await applyOp({ kind: "upsert_contract", ...ctr });
      }
    }, "btn btn-sm btn-primary"));
    main.append(form);

    makeTable(
      main,
      ["Mã ĐL", "Tên giao dịch / Pháp nhân", "MST", "Hạn mức tín dụng", "Hợp đồng đang hiệu lực"],
      state.agencies.map((a) => {
        const ctrs = state.contracts.filter((ct) => ct.agencyCode === a.code);
        return [
          a.code,
          `${a.tradeName || ""} (${a.legalName || ""})`,
          a.taxCode || "—",
          money(a.creditLimit || 0),
          ctrs.map((ct) => `${ct.id} v${ct.versionNo} (${ct.effectiveFrom}→${ct.effectiveTo})`).join(", ") || "Chưa có"
        ];
      })
    );

    main.append(el("h3", "Bảng giá nhập sẵn Mục I — Hợp đồng Lữ hành 2027 (VND/phòng/đêm, đã gồm VAT 8% & buffet sáng)"));
    makeTable(
      main,
      ["Hạng phòng", "SL phòng (Ánh xạ 26 phòng)", "A: T5–T7", "A: CN–T4", "B: T5–T7", "B: CN–T4"],
      T.ROOM_CATEGORIES_2027.map((cat) => [
        cat.label,
        `${cat.roomCount} (${cat.roomIds.join(", ")})`,
        money(cat.rates.A_thu_sat),
        money(cat.rates.A_sun_wed),
        money(cat.rates.B_thu_sat),
        money(cat.rates.B_sun_wed)
      ])
    );
  }

  function renderPaymentsTab() {
    const fin = getFinanceState();
    const box = el("section", null, "ta-card");
    box.append(el("h3", "Thu tiền ngân hàng / Cọc đại lý (1 phiếu nguồn → phân bổ nhiều đoàn)"));
    const selAg = el("select");
    state.agencies.forEach((a) => selAg.add(new Option(`${a.code} — ${a.tradeName || a.legalName}`, a.code)));
    if (filterAgency && state.agencies.some((a) => a.code === filterAgency)) selAg.value = filterAgency;

    const selGrp = el("select");
    const fillGroups = () => {
      selGrp.replaceChildren();
      selGrp.add(new Option("Chưa gán đoàn (treo chưa phân bổ)", ""));
      state.groups.filter((g) => g.agencyCode === selAg.value).forEach((g) => selGrp.add(new Option(`${g.groupCode} (${g.checkin})`, g.id)));
      if (filterGroup) selGrp.value = filterGroup;
    };
    fillGroups();
    selAg.onchange = fillGroups;

    const inpDate = el("input"); inpDate.type = "date"; inpDate.value = todayISO();
    const inpAmt = el("input"); inpAmt.type = "number"; inpAmt.value = "1780000";
    const inpExp = el("input"); inpExp.type = "number"; inpExp.placeholder = "Bằng số thực nhận nếu không trừ phí NH";
    const inpRef = el("input"); inpRef.placeholder = "Mã giao dịch BIDV 8695558888 / Mã tham chiếu cổng TT (không lưu CVV)";

    const grid = el("div", null, "ta-form-grid");
    const addF = (l, i) => { const w = el("label", l); w.append(i); grid.append(w); };
    addF("Đại lý", selAg);
    addF("Phân bổ ngay cho đoàn (tùy chọn)", selGrp);
    addF("Ngày tiền về", inpDate);
    addF("Tiền thực nhận (VNĐ)", inpAmt);
    addF("Số tiền kỳ vọng (nếu trừ phí NH)", inpExp);
    addF("Mã giao dịch / Sao kê", inpRef);
    box.append(grid);

    box.append(btn("Ghi nhận phiếu thu & Phân bổ", async () => {
      const amt = T.roundVnd(inpAmt.value);
      if (!(amt > 0)) { msg.textContent = "Số tiền thực nhận phải > 0."; return; }
      const allocations = selGrp.value ? [{ groupId: selGrp.value, amount: amt }] : [];
      await applyOp({
        kind: "record_ta_receipt",
        agencyCode: selAg.value,
        amount: amt,
        expectedAmount: T.roundVnd(inpExp.value || amt),
        businessDate: inpDate.value,
        fundId: "bank_main",
        bankRef: inpRef.value.trim(),
        allocations
      });
    }, "btn btn-sm btn-primary"));
    main.append(box);

    // Existing receipts & unallocated balances
    const rbs = T.computeReceiptBalances(state.allocations, fin);
    main.append(el("h3", "Phiếu thu đại lý & trạng thái phân bổ"));
    makeTable(
      main,
      ["Mã phiếu nguồn", "Đại lý", "Ngày", "Thực nhận", "Đã phân bổ", "Chưa phân bổ", "Chênh phí NH", "Phân bổ thêm"],
      rbs.map((rb) => {
        const cell = el("div", null, "ta-actions");
        if (rb.unallocated > 0 && isMgr()) {
          const gSel = el("select");
          state.groups.filter((g) => g.agencyCode === rb.agencyCode).forEach((g) => gSel.add(new Option(g.groupCode, g.id)));
          const aInp = el("input"); aInp.type = "number"; aInp.value = String(rb.unallocated); aInp.style.width = "100px";
          cell.append(gSel, aInp, btn("Gán", async () => {
            if (!gSel.value) { msg.textContent = "Chọn đoàn cần phân bổ."; return; }
            await applyOp({ kind: "allocate_receipt", sourceTxId: rb.sourceTxId, groupId: gSel.value, amount: T.roundVnd(aInp.value), effectiveDay: todayISO() });
          }, "btn btn-sm btn-primary"));
        } else {
          cell.textContent = rb.unallocated === 0 ? "Đã phân bổ hết" : "Chờ quản lý phân bổ";
        }
        return [
          rb.sourceTxId, rb.agencyCode, rb.businessDate, money(rb.amount),
          money(rb.allocated), money(rb.unallocated), money(rb.unresolvedBankFee), cell
        ];
      })
    );
  }

  function renderStatementsTab() {
    if (!state.agencies.length) { main.append(el("p", "Chưa có đại lý.")); return; }
    const fin = getFinanceState();
    const selAg = el("select");
    state.agencies.forEach((a) => selAg.add(new Option(`${a.code} — ${a.tradeName || a.legalName}`, a.code)));
    if (filterAgency && state.agencies.some((a) => a.code === filterAgency)) selAg.value = filterAgency;

    const inpFrom = el("input"); inpFrom.type = "date"; inpFrom.value = todayISO().slice(0, 7) + "-01";
    const inpTo = el("input"); inpTo.type = "date"; inpTo.value = filterAsOf;

    const bar = el("div", null, "ta-filter-bar");
    bar.append(el("label", "Đại lý: "), selAg, el("label", "Từ ngày: "), inpFrom, el("label", "Đến ngày chốt: "), inpTo);
    main.append(bar);

    const reportArea = el("div");
    main.append(reportArea);

    const drawReport = () => {
      reportArea.replaceChildren();
      const ag = state.agencies.find((a) => a.code === selAg.value) || state.agencies[0];
      const ledger = T.computeAgencyLedger({
        agency: ag,
        groups: state.groups,
        allocations: state.allocations,
        financeState: fin,
        fromDate: inpFrom.value,
        toDate: inpTo.value,
        asOfDate: inpTo.value
      });

      const kpis = el("div", null, "ta-kpi-grid");
      [
        ["Số dư đầu kỳ", money(ledger.openingBalance)],
        ["Phát sinh phải thu", money(ledger.periodCharges)],
        ["Điều chỉnh (+/-)", `${money(ledger.periodAdjPlus)} / -${money(ledger.periodAdjMinus)}`],
        ["Đã cấn trừ", money(ledger.periodApplied)],
        ["Số dư cuối kỳ (AR)", money(ledger.closingBalance)],
        ["Cọc chưa cấn", money(ledger.unappliedDeposit)],
        ["Tiền chưa gán đoàn", money(ledger.unassignedCash)],
        ["Tiền bảo lưu", money(ledger.creditReserve)],
        ["Hoàn đã duyệt chưa chi", money(ledger.approvedRefundPending)]
      ].forEach(([lbl, val]) => {
        const card = el("div", null, "ta-kpi");
        card.append(el("small", lbl), el("strong", val));
        kpis.append(card);
      });
      reportArea.append(kpis);

      if (ledger.overLimitAmount > 0) {
        reportArea.append(el("p", `CẢNH BÁO VƯỢT HẠN MỨC TÍN DỤNG: Vượt ${money(ledger.overLimitAmount)} so với hạn mức ${money(ledger.creditLimit)}.`, "ta-warn"));
      }

      makeTable(
        reportArea,
        ["Chưa đến hạn", "Đến hạn hôm nay", "Quá hạn 1–7 ngày", "Quá hạn 8–30 ngày", "Quá hạn >30 ngày", "Chưa xác định hạn"],
        [[
          money(ledger.aging.not_due), money(ledger.aging.due_today), money(ledger.aging.overdue_1_7),
          money(ledger.aging.overdue_8_30), money(ledger.aging.overdue_30_plus), money(ledger.aging.unknown_due)
        ]]
      );

      makeTable(
        reportArea,
        ["Ngày hiệu lực", "Chứng từ", "Mã đoàn", "Diễn giải", "Phát sinh Nợ", "Phát sinh Có", "Người duyệt"],
        ledger.rows.map((r) => [r.day, r.ref || r.kind, r.groupCode || "—", r.label, r.debit ? money(r.debit) : "", r.credit ? money(r.credit) : "", r.approvedBy || "—"])
      );

      const act = el("div", null, "ta-actions");
      act.append(
        btn("Chốt & Lưu bản đối chiếu đã gửi (bất biến)", async () => {
          await applyOp({
            kind: "send_statement",
            agencyCode: ag.code,
            periodFrom: inpFrom.value,
            periodTo: inpTo.value,
            snapshot: ledger
          });
        }, "btn btn-sm btn-primary"),
        btn("Xuất Excel / CSV đối chiếu", () => {
          const csv = T.exportStatementCsv(ledger);
          downloadFile(`doi-chieu-${ag.code}-${inpTo.value}.csv`, csv, "text/csv;charset=utf-8");
        })
      );
      reportArea.append(act);

      const myStmts = state.statements.filter((s) => s.agencyCode === ag.code);
      if (myStmts.length) {
        reportArea.append(el("h3", "Lịch sử bản đối chiếu đã gửi (bản in lại giữ nguyên số cũ)"));
        makeTable(
          reportArea,
          ["Mã bản đối chiếu", "Kỳ", "Trạng thái", "Số dư cuối đã chốt", "Người gửi", "In lại bản gốc"],
          myStmts.map((s) => [
            s.id, `${s.periodFrom} → ${s.periodTo}`, s.status,
            money(s.snapshot?.closingBalance || 0), s.sentBy,
            btn("Tải lại bản đã gửi", () => {
              downloadFile(`ban-goc-${s.id}.json`, JSON.stringify(s.snapshot, null, 2), "application/json");
            })
          ])
        );
      }
    };

    selAg.onchange = () => { filterAgency = selAg.value; drawReport(); };
    inpFrom.onchange = drawReport;
    inpTo.onchange = () => { filterAsOf = inpTo.value; drawReport(); };
    drawReport();
  }

  function render() {
    renderTabs();
    main.replaceChildren();
    if (activeTab === "queue") renderQueueTab();
    else if (activeTab === "groups") renderGroupsTab();
    else if (activeTab === "agencies") renderAgenciesTab();
    else if (activeTab === "payments") renderPaymentsTab();
    else if (activeTab === "statements") renderStatementsTab();
  }

  function open(tab) {
    if (!isRecOrMgr() && c && c.getRole && c.getRole() === "housekeeping") {
      if (window.alert) alert("Tài khoản buồng phòng không có quyền truy cập Hợp đồng & Công nợ đại lý.");
      return;
    }
    activeTab = tab || (isMgr() ? "queue" : "groups");
    if (!dlg.open) dlg.showModal();
    loadState();
  }

  const btnClose = dlg.querySelector("[data-ta-close]");
  if (btnClose) btnClose.onclick = () => dlg.close();

  const btnNavAr = document.getElementById("btn-ta-ar");
  if (btnNavAr) btnNavAr.addEventListener("click", () => open("queue"));

  const btnOpenTaGroups = document.getElementById("btn-open-ta-groups");
  if (btnOpenTaGroups) {
    btnOpenTaGroups.addEventListener("click", () => {
      const grpModal = document.getElementById("group-report-modal");
      if (grpModal) grpModal.classList.remove("open");
      open("groups");
    });
  }

  window.PMSTaUI = { open, loadState, getLastRequestKey: () => lastReqKey };
})();
