(() => {
  "use strict";
  const api = window.PMSEnterpriseReport;
  const client = window.pmsClient;
  const core = window.PMSCore;
  if (!api || !client || !core) return;

  const $ = (id) => document.getElementById(id);
  const dialog = $("enterprise-report");
  if (!dialog) return;

  const fmt = new Intl.NumberFormat("vi-VN");
  const pctFmt = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
  const fmtVnd = (n) => (typeof n === "number" ? fmt.format(n === 0 ? 0 : n) : (n ?? "—"));
  const fmtPct = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : pctFmt.format(Number(v)) + "%");

  let sections = [];
  let journal = null;
  let serial = 0;
  let rendered = "";
  let notice = "";
  let activeTab = "statements";
  let lastDrilldownMap = null;

  const allowed = () => client.can("reports:management") && (!client.getStatus().authRequired || client.getStatus().authenticated);
  const currentPeriod = () => api.period($("er-month").value, $("er-kind").value);
  const currentScope = () => [$("er-mode").value, $("er-kind").value, $("er-month").value, $("er-compare").value, activeTab].join("|");

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") node.className = v;
      else if (k === "textContent") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const ch of children) {
      if (ch === undefined || ch === null || ch === false) continue;
      node.append(typeof ch === "string" ? document.createTextNode(ch) : ch);
    }
    return node;
  }

  function closeDrilldown() {
    const box = $("er-drilldown");
    if (box) {
      box.hidden = true;
      box.replaceChildren();
    }
  }

  function openDrilldown(groupKey, titleText) {
    const box = $("er-drilldown");
    if (!box || !lastDrilldownMap) return;
    const items = lastDrilldownMap[groupKey] || [];
    box.replaceChildren();
    const head = el("div", { className: "er-drilldown-head" },
      el("strong", { textContent: `Truy nguồn: ${titleText} (${items.length} dòng hạch toán trong kỳ)` }),
      el("button", { type: "button", textContent: "Đóng truy nguồn", onClick: closeDrilldown })
    );
    box.append(head);
    if (!items.length) {
      box.append(el("p", { textContent: "Không có bút toán phát sinh trong kỳ cho khoản mục này (số dư chỉ từ đầu kỳ hoặc bằng 0)." }));
    } else {
      const tbl = el("table");
      const trH = tbl.insertRow();
      for (const h of ["Ngày", "Chứng từ", "TK", "Nguồn", "Mã sự kiện", "Nợ", "Có", "Diễn giải"]) {
        trH.append(el("th", { textContent: h }));
      }
      for (const it of items.slice(0, 120)) {
        const tr = tbl.insertRow();
        const vals = [it.postingDate, it.voucherNo, `${it.accountCode} ${it.accountName || ""}`, it.sourceType, it.sourceEventId || it.bookingId || it.invoiceId || "—", it.debit, it.credit, it.memo || it.note || "—"];
        vals.forEach((v, i) => {
          const td = el("td", { textContent: typeof v === "number" ? fmtVnd(v) : String(v ?? "—") });
          if (typeof v === "number") td.className = "er-num";
          tr.append(td);
        });
      }
      box.append(tbl);
    }
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function erase() {
    serial++;
    sections = [];
    rendered = "";
    lastDrilldownMap = null;
    closeDrilldown();
    $("er-body").replaceChildren();
    $("er-csv").disabled = true;
    if ($("er-xlsx")) $("er-xlsx").disabled = true;
    if ($("er-pdf")) $("er-pdf").disabled = true;
  }

  function section(name, headers, rows, opts = {}) {
    sections.push({ name, headers, rows });
    const area = document.createElement("section");
    const title = document.createElement("h3");
    title.textContent = name;
    const table = document.createElement("table");
    const visibleRows = rows.slice(0, 200);
    if (rows.length > visibleRows.length) {
      title.textContent = name + " · Hiển thị 200/" + rows.length + " dòng. CSV/Excel chứa toàn bộ.";
    }
    const drillKeys = Array.isArray(opts.rowDrillKeys) ? opts.rowDrillKeys : null;
    for (const [index, row] of [headers, ...visibleRows].entries()) {
      const tr = table.insertRow();
      if (index > 0 && drillKeys && drillKeys[index - 1] && lastDrilldownMap) {
        const gk = drillKeys[index - 1];
        tr.className = "er-clickable";
        tr.title = "Bấm để truy nguồn tài khoản và chứng từ gốc";
        tr.addEventListener("click", () => openDrilldown(gk, String(row[0] || gk)));
      }
      for (const value of row) {
        const cell = document.createElement(index ? "td" : "th");
        cell.textContent = typeof value === "number" ? fmtVnd(value) : (value ?? "—");
        if (typeof value === "number") cell.className = "er-num";
        tr.append(cell);
      }
    }
    area.append(title, table);
    $("er-body").append(area);
  }

  function updateTabVisibility() {
    const mode = $("er-mode").value;
    const tabBtns = document.querySelectorAll("#er-tabs .er-tab");
    tabBtns.forEach((btn) => {
      const t = btn.getAttribute("data-tab");
      const show = (t === "statements" || t === "hotel_kpi")
        || (mode === "server_gl" && (t === "gl_ops" || t === "reconcile_close" || t === "notes"))
        || (mode === "ledger" && t === "notes");
      btn.hidden = !show;
      btn.classList.toggle("active", t === activeTab);
      btn.setAttribute("aria-selected", t === activeTab ? "true" : "false");
    });
    const activeBtn = document.querySelector(`#er-tabs .er-tab[data-tab="${activeTab}"]`);
    if (activeBtn && activeBtn.hidden) {
      activeTab = "statements";
      tabBtns.forEach((btn) => {
        const isSt = btn.getAttribute("data-tab") === "statements";
        btn.classList.toggle("active", isSt);
        btn.setAttribute("aria-selected", isSt ? "true" : "false");
      });
    }
  }

  function updateLockBadge(glState, p) {
    const badge = $("er-lock-badge");
    if (!badge) return;
    if ($("er-mode").value !== "server_gl" || !glState) {
      badge.hidden = true;
      return;
    }
    const entityId = glState.activeEntityId || "ent_dongvan_main";
    const pk = p.months[0];
    const rec = glState.periods && glState.periods[api.periodStateKey(entityId, pk)];
    const st = (rec && rec.status) || "draft";
    const info = api.PERIOD_STATUSES[st] || api.PERIOD_STATUSES.draft;
    badge.className = `er-badge ${st}`;
    badge.textContent = `Kỳ ${pk}: ${info.label}${rec && rec.version ? ` (v${rec.version})` : ""}`;
    badge.hidden = false;
  }

  function hotelView(state, p) {
    const h = api.hotel(state, p);
    const cash = h.cash;
    const rows = h.months;
    section("Hoạt động lưu trú theo tháng", ["Tháng", "Tiền phòng phân bổ", "Dorm phân bổ", "Chi phí dùng tính", "Khoản thiếu căn cứ"], rows.map((m) => [m.monthKey, m.proratedRoomRevenue, m.proratedDormRevenue, m.missingBasisCount || m.missingGuestBasis ? null : m.totalMonthlyCost, m.missingBasisCount]));
    section("Căn cứ chi phí", ["Tháng", "Khoản mục", "Chi phí có chứng từ", "Số dùng tính", "Trạng thái"], rows.flatMap((m) => m.rows.map((r) => [m.monthKey, r.name, r.actualAmount, r.costBasisStatus === "missing_basis" ? null : r.usedAmount, r.costBasisLabel])));
    section("Tiền trong kỳ và số dư cuối kỳ", ["Chỉ tiêu", "VND"], [
      ["Thu khách theo phiếu thu trong kỳ", h.receipts],
      ["Hoàn khách trong kỳ", h.refunds],
      ["Chi nhà cung cấp trong kỳ", h.payouts],
      ...(h.retainedDepositRevenue > 0 ? [["Thu nhập giữ cọc đơn hủy (đã xác nhận chính sách)", h.retainedDepositRevenue]] : []),
      ...cash.activeFunds.map((f) => [f.label || f.name || f.id, f.closingBalance]),
      ["Tổng tiền tại các quỹ đã xác định", cash.totalHotelCashHeld]
    ]);
    section("Công nợ tại ngày " + p.to, ["Chỉ tiêu", "VND"], [
      ["Khách còn phải thu", h.ar.totalRemaining],
      ["Phải thu quá hạn có hạn trả", h.ar.overdueAmount],
      ["Khách trả thừa", h.ar.totalOverpaid],
      ["Tiền cọc đơn hủy đang giữ", h.ar.totalCancelledHeldDeposit],
      ["Phải trả nhà cung cấp", h.ap.totalRemaining],
      ["Phải trả quá hạn", h.ap.overdueRemaining]
    ]);
    section("Chứng từ theo ngày thực nhận hoặc chi", ["Ngày", "Mã phiếu", "Loại", "Quỹ", "Số tiền ghi phiếu"], h.txs.map((t) => [t.receivedDate, t.voucherCode, core.FINANCE_TX_TYPES[t.txType]?.label || t.txType, t.fundId, t.amount]));
    notice = "Phòng và dorm phân bổ theo đêm đặt, gồm cả lịch tương lai trong kỳ. Chi phí có thể còn ước tính. Công nợ và quỹ dựa trên dữ liệu PMS hiện có. Đơn vị VND.";
  }

  function renderHotelKpiTab(state, glState, p) {
    const kpi = api.computeHotelManagementAnalytics(state, glState || api.createDefaultEnterpriseGlState(), p);
    const grid = el("div", { className: "er-kpi-grid" },
      el("div", { className: "er-kpi-card" },
        el("div", { className: "k-label", textContent: "Công suất phòng (26 phòng)" }),
        el("div", { className: "k-val", textContent: fmtPct(kpi.rooms.occupancyPct) }),
        el("div", { className: "k-sub", textContent: `${kpi.rooms.soldRoomNights} / ${kpi.rooms.availableRoomNights} đêm phòng` })
      ),
      el("div", { className: "er-kpi-card" },
        el("div", { className: "k-label", textContent: "ADR (Giá bình quân/đêm bán)" }),
        el("div", { className: "k-val", textContent: fmtVnd(kpi.rooms.adr) + " đ" }),
        el("div", { className: "k-sub", textContent: kpi.rooms.formulas.adr })
      ),
      el("div", { className: "er-kpi-card" },
        el("div", { className: "k-label", textContent: "RevPAR (Doanh thu/phòng sẵn bán)" }),
        el("div", { className: "k-val", textContent: fmtVnd(kpi.rooms.revPar) + " đ" }),
        el("div", { className: "k-sub", textContent: kpi.rooms.formulas.revPar })
      ),
      el("div", { className: "er-kpi-card" },
        el("div", { className: "k-label", textContent: "Dorm riêng (8 giường)" }),
        el("div", { className: "k-val", textContent: fmtPct(kpi.dorm.occupancyPct) }),
        el("div", { className: "k-sub", textContent: `${kpi.dorm.soldBedNights}/${kpi.dorm.availableBedNights} đêm • DT ${fmtVnd(kpi.dorm.revenue)} đ` })
      )
    );
    $("er-body").append(grid);

    section("Chỉ số lưu trú & Công thức minh bạch (Tách 26 phòng khách và 8 giường Dorm)", ["Chỉ tiêu", "Giá trị", "Mẫu số / Công thức"], [
      ["Doanh thu phòng (26 phòng)", kpi.rooms.revenue, `${kpi.rooms.soldRoomNights} đêm bán`],
      ["Công suất phòng (%)", fmtPct(kpi.rooms.occupancyPct), kpi.rooms.formulas.occupancy],
      ["ADR (VND/đêm bán)", kpi.rooms.adr, kpi.rooms.formulas.adr],
      ["RevPAR (VND/phòng sẵn bán)", kpi.rooms.revPar, kpi.rooms.formulas.revPar],
      ["Doanh thu Dorm (8 giường)", kpi.dorm.revenue, `${kpi.dorm.soldBedNights} giường-đêm bán`],
      ["Công suất Dorm (%)", fmtPct(kpi.dorm.occupancyPct), kpi.dorm.formulas.occupancy],
      ["Giá TB giường Dorm (VND/đêm)", kpi.dorm.adrBed, "Doanh thu Dorm / Giường-đêm bán"],
      ["Doanh thu dịch vụ ngoài phòng", kpi.servicesRevenue, "Dịch vụ tách riêng khỏi tiền phòng"],
      ["Giảm trừ / chiết khấu", -kpi.discountsTotal, "Tổng điều chỉnh âm hoạt động"]
    ]);

    section("Cơ cấu theo kênh bán (Channel)", ["Kênh bán", "Số đơn", "Số đêm", "Doanh thu phân bổ (VND)", "Tỷ trọng (%)"],
      kpi.byChannel.map((c) => [c.label, c.bookingCount, c.nights, c.revenue, fmtPct(c.sharePct)])
    );

    if (kpi.byGroup.length) {
      section("Phân tích theo đoàn / công ty / tour", ["Mã đoàn", "Tên đoàn / khách", "Số phòng", "Tổng phải thu (VND)", "Đã thu (VND)", "Còn phải thu (VND)"],
        kpi.byGroup.map((g) => [g.groupCode, g.name, g.roomCount, g.totalPayable, g.netPaid, g.remaining])
      );
    }

    section("Tuổi nợ phải thu khách (AR Aging tại " + p.to + ")", ["Nhóm tuổi nợ", "Số đơn/đoàn", "Số tiền (VND)"],
      kpi.arAging.map((b) => [b.label, b.count, b.amount])
    );

    section("Tuổi nợ phải trả nhà cung cấp (AP Aging tại " + p.to + ")", ["Nhóm tuổi nợ", "Số hóa đơn", "Số tiền (VND)"],
      kpi.apAging.map((b) => [b.label, b.count, b.amount])
    );

    section("Ngân sách so với thực tế (Budget vs Actual)", ["Chỉ tiêu", "Ngân sách (VND)", "Thực tế (VND)", "Chênh lệch (VND)"], [
      ["Doanh thu lưu trú & dịch vụ", kpi.budgetVsActual.budgetRevenue, kpi.budgetVsActual.actualRevenue, kpi.budgetVsActual.revenueVariance],
      ["Chi phí vận hành & giá vốn", kpi.budgetVsActual.budgetExpense, kpi.budgetVsActual.actualExpense, kpi.budgetVsActual.expenseVariance]
    ]);

    const fc = kpi.forecast13Weeks;
    section(`Dự báo dòng tiền 13 tuần (Cập nhật: ${fc.updatedAt.slice(0, 19).replace("T", " ")} UTC)`, ["Tuần", "Từ ngày", "Đến ngày", "Thu dự kiến (VND)", "Chi dự kiến (VND)", "Dòng tiền ròng (VND)", "Số dư cuối tuần (VND)"],
      fc.weeks.map((w) => [w.weekLabel, w.from, w.to, w.inflow, w.outflow, w.netFlow, w.endingCash])
    );
    $("er-body").append(el("div", { className: "er-disclaimer", textContent: `Giả định dự báo 13 tuần: ${fc.assumptions.join(" • ")}` }));
    notice = `Báo cáo quản trị khách sạn & dự báo dòng tiền 13 tuần (${p.from} – ${p.to}). Đã tách riêng 26 phòng khách và 8 giường Dorm.`;
  }

  function ledgerView(p) {
    if (!journal) {
      notice = "Nạp nhật ký có số dư đầu kỳ và chứng từ của tất cả bộ phận. Sổ nạp chỉ dùng trong cửa sổ này.";
      return;
    }
    const r = api.statements(journal, p);
    const by = (keys, sign = 1) => keys.map((k) => [api.groups[k], sign * r.opening[k], sign * r.ending[k]]);
    if (activeTab === "notes") {
      if (journal.notes?.length) section("Thuyết minh", ["Nội dung", "Diễn giải"], journal.notes.map((n) => [n.title, n.text]));
      $("er-body").append(el("div", { className: "er-disclaimer", textContent: "Lưu ý pháp định Việt Nam: Số liệu nội bộ VND; cần kế toán trưởng xác nhận chế độ kế toán (TT200/TT133), niên độ và chữ ký trước khi nộp báo cáo pháp định." }));
      notice = journal.enterprise + " • Thuyết minh báo cáo.";
      return;
    }
    section("Kết quả kinh doanh", ["Chỉ tiêu", "VND"], [
      ...api.performance.map((k) => [api.groups[k], -r.ending[k]]),
      ["Doanh thu thuần", r.revenue],
      ["Lợi nhuận gộp", r.gross],
      ["Lợi nhuận trước thuế", r.beforeTax],
      ["Lợi nhuận sau thuế", r.net]
    ]);
    section("Tình hình tài chính", ["Khoản mục", "Đầu kỳ", "Cuối kỳ"], [
      ...by(api.assets),
      ["Tổng tài sản", api.assets.reduce((n, k) => n + r.opening[k], 0), r.assetsEnd],
      ...by(api.liabilities, -1),
      ["Tổng nợ phải trả", -api.liabilities.reduce((n, k) => n + r.opening[k], 0), r.liabilitiesEnd],
      ...by(api.equity, -1),
      ["Kết quả phát sinh kỳ này", 0, r.net],
      ["Tổng vốn chủ sở hữu", -api.equity.reduce((n, k) => n + r.opening[k], 0), r.equityEnd]
    ]);
    section("Lưu chuyển tiền", ["Chỉ tiêu", "Tiền vào", "Tiền ra", "Số dư / lưu chuyển ròng"], [
      ["Tiền đầu kỳ", null, null, r.opening.cash],
      ...Object.keys(api.flows).map((k) => [api.flows[k], r.cashIn[k], r.cashOut[k], r.cashflow[k]]),
      ["Tiền cuối kỳ", null, null, r.ending.cash]
    ]);
    section("Biến động vốn chủ sở hữu", ["Khoản mục", "Tăng / giảm trong kỳ"], [
      ...api.equity.map((k) => [api.groups[k], r.opening[k] - r.ending[k]]),
      ["Lợi nhuận sau thuế", r.net]
    ]);
    const ratio = (a, b) => (b > 0 ? pctFmt.format((100 * a) / b) + "%" : "—");
    section("Chỉ số quản trị", ["Chỉ tiêu", "Giá trị"], [
      ["Biên lợi nhuận gộp", ratio(r.gross, r.revenue)],
      ["Biên lợi nhuận sau thuế", ratio(r.net, r.revenue)],
      ["Nợ phải trả / tổng tài sản", ratio(r.liabilitiesEnd, r.assetsEnd)]
    ]);
    if (r.comparison) {
      const fields = { revenue: "Doanh thu thuần", gross: "Lợi nhuận gộp", net: "Lợi nhuận sau thuế", assetsEnd: "Tổng tài sản", liabilitiesEnd: "Nợ phải trả", equityEnd: "Vốn chủ sở hữu" };
      section("So sánh cùng kỳ năm trước", ["Chỉ tiêu", "Kỳ này", "Cùng kỳ", "Chênh lệch"], Object.entries(fields).map(([k, v]) => [v, r[k], r.comparison[k], r[k] - r.comparison[k]]));
    }
    if (journal.notes?.length) section("Thuyết minh", ["Nội dung", "Diễn giải"], journal.notes.map((n) => [n.title, n.text]));
    section("Nhật ký nguồn", ["Ngày", "Chứng từ", "Tổng phát sinh Nợ", "Tiền tăng / giảm", "Hoạt động"], r.vouchers);
    notice = journal.enterprise + " • VND. Chi phí và giảm trừ ở bảng kết quả mang dấu âm. Đã kiểm tra cân đối từng chứng từ, bảng cân đối và tiền cuối kỳ.";
  }

  function renderServerGlStatements(glState, p) {
    const compareMode = $("er-compare") ? $("er-compare").value : "none";
    const res = api.computeGlStatements(glState, p, { compare: compareMode });
    lastDrilldownMap = res.drilldownByGroup || {};
    const is = res.incomeStatement;
    const bs = res.balanceSheet;
    const cf = res.cashFlow;
    const eq = res.equityStatement;

    const kpiGrid = el("div", { className: "er-kpi-grid" },
      el("div", { className: "er-kpi-card" },
        el("div", { className: "k-label", textContent: "Doanh thu thuần" }),
        el("div", { className: "k-val", textContent: fmtVnd(is.netRevenue) + " đ" }),
        el("div", { className: "k-sub", textContent: `Lãi gộp: ${fmtVnd(is.grossProfit)} đ` })
      ),
      el("div", { className: "er-kpi-card" },
        el("div", { className: "k-label", textContent: "Lợi nhuận sau thuế" }),
        el("div", { className: "k-val", textContent: fmtVnd(is.netProfit) + " đ" }),
        el("div", { className: "k-sub", textContent: `EBT: ${fmtVnd(is.ebt)} đ` })
      ),
      el("div", { className: "er-kpi-card" },
        el("div", { className: "k-label", textContent: "Tổng tài sản cuối kỳ" }),
        el("div", { className: "k-val", textContent: fmtVnd(bs.totalAssets) + " đ" }),
        el("div", { className: "k-sub", textContent: bs.balanced ? "Cân đối: TS = Nợ + VCSH" : `LỆCH CĐKT: ${fmtVnd(bs.balanceDiff)} đ` })
      ),
      el("div", { className: "er-kpi-card" },
        el("div", { className: "k-label", textContent: "Tiền cuối kỳ" }),
        el("div", { className: "k-val", textContent: fmtVnd(cf.endingCash) + " đ" }),
        el("div", { className: "k-sub", textContent: `Đầu kỳ: ${fmtVnd(cf.openingCash)} đ • ${cf.balanced ? "Khớp 0 đ" : "LỆCH"}` })
      )
    );
    $("er-body").append(kpiGrid);

    const perfRows = api.performance.map((k) => [api.groups[k], is.lines[k]]);
    section("1. Báo cáo kết quả kinh doanh (Bấm dòng để truy nguồn)", ["Chỉ tiêu", "VND"], [
      ...perfRows,
      ["Doanh thu thuần", is.netRevenue],
      ["Lợi nhuận gộp", is.grossProfit],
      ["Lợi nhuận trước thuế (EBT)", is.ebt],
      ["Lợi nhuận sau thuế (Net Profit)", is.netProfit]
    ], { rowDrillKeys: [...api.performance, null, null, null, null] });

    const bsRows = [];
    const bsKeys = [];
    for (const k of api.assets) {
      bsRows.push([api.groups[k], bs.openingByGroup[k], bs.endingByGroup[k]]);
      bsKeys.push(k);
    }
    bsRows.push(["Tổng tài sản", api.assets.reduce((s, k) => s + bs.openingByGroup[k], 0), bs.totalAssets]);
    bsKeys.push(null);
    for (const k of api.liabilities) {
      bsRows.push([api.groups[k], bs.openingByGroup[k], bs.endingByGroup[k]]);
      bsKeys.push(k);
    }
    bsRows.push(["Tổng nợ phải trả", api.liabilities.reduce((s, k) => s + bs.openingByGroup[k], 0), bs.totalLiabilities]);
    bsKeys.push(null);
    for (const k of api.equity) {
      bsRows.push([api.groups[k], bs.openingByGroup[k], bs.endingByGroup[k]]);
      bsKeys.push(k);
    }
    bsRows.push(["Kết quả phát sinh kỳ này", 0, is.netProfit]);
    bsKeys.push(null);
    bsRows.push(["Tổng vốn chủ sở hữu", api.equity.reduce((s, k) => s + bs.openingByGroup[k], 0), bs.totalEquity]);
    bsKeys.push(null);
    section("2. Báo cáo tình hình tài chính (Bấm dòng để truy nguồn)", ["Khoản mục", "Đầu kỳ (VND)", "Cuối kỳ (VND)"], bsRows, { rowDrillKeys: bsKeys });

    section("3. Báo cáo lưu chuyển tiền tệ (Trực tiếp)", ["Hoạt động", "Tiền vào (VND)", "Tiền ra (VND)", "Lưu chuyển ròng (VND)"], [
      ["Tiền và tương đương tiền đầu kỳ", null, null, cf.openingCash],
      ...Object.keys(api.flows).map((k) => [api.flows[k], cf.cashIn[k], cf.cashOut[k], cf.cashflow[k]]),
      ["Lưu chuyển tiền thuần trong kỳ", null, null, cf.netCashChange],
      ["Tiền và tương đương tiền cuối kỳ", null, null, cf.endingCash]
    ], { rowDrillKeys: ["cash", "cash", "cash", "cash", "cash", null, "cash"] });

    section("4. Báo cáo biến động vốn chủ sở hữu", ["Khoản mục", "Đầu kỳ (VND)", "Tăng / giảm (VND)", "Cuối kỳ (VND)"], [
      ...eq.rows.map((r) => [r.label, r.opening, r.change, r.ending]),
      ["Lợi nhuận sau thuế trong kỳ", 0, eq.netProfit, eq.netProfit],
      ["Tổng vốn chủ sở hữu", eq.openingTotal, eq.endingTotal - eq.openingTotal, eq.endingTotal]
    ]);

    if (res.comparison) {
      const cmp = res.comparison;
      section(`So sánh kỳ (${cmp.label}: ${cmp.period.from} – ${cmp.period.to})`, ["Chỉ tiêu", "Kỳ này (VND)", "Kỳ so sánh (VND)", "Chênh lệch (VND)"], [
        ["Doanh thu thuần", is.netRevenue, cmp.incomeStatement.netRevenue, is.netRevenue - cmp.incomeStatement.netRevenue],
        ["Lợi nhuận gộp", is.grossProfit, cmp.incomeStatement.grossProfit, is.grossProfit - cmp.incomeStatement.grossProfit],
        ["Lợi nhuận sau thuế", is.netProfit, cmp.incomeStatement.netProfit, is.netProfit - cmp.incomeStatement.netProfit],
        ["Tổng tài sản", bs.totalAssets, cmp.balanceSheet.totalAssets, bs.totalAssets - cmp.balanceSheet.totalAssets],
        ["Tổng nợ phải trả", bs.totalLiabilities, cmp.balanceSheet.totalLiabilities, bs.totalLiabilities - cmp.balanceSheet.totalLiabilities],
        ["Tổng vốn chủ sở hữu", bs.totalEquity, cmp.balanceSheet.totalEquity, bs.totalEquity - cmp.balanceSheet.totalEquity],
        ["Tiền cuối kỳ", cf.endingCash, cmp.cashFlow.endingCash, cf.endingCash - cmp.cashFlow.endingCash]
      ]);
    }

    $("er-body").append(el("div", {
      className: "er-disclaimer",
      textContent: "Tuyên bố phạm vi: Báo cáo tài chính doanh nghiệp nội bộ (VND nguyên đồng) tổng hợp từ Sổ cái máy chủ. Trước khi nộp làm báo cáo tài chính pháp định Việt Nam, kế toán trưởng cần xác nhận chế độ kế toán (TT200/TT133), niên độ, mẫu biểu và chữ ký pháp lý."
    }));
    notice = `Sổ cái doanh nghiệp (${glState.sourceMode === "external_master" ? "Nguồn chuẩn ngoài PMS" : "PMS + Bút toán ngoài"}) • ${res.trialBalance.inPeriodEntries.length} bút toán trong kỳ • Cân đối CĐKT: ${bs.balanced ? "ĐẠT (0 đ)" : "LỆCH"}.`;
  }

  function renderGlOpsTab(glState, p) {
    const body = $("er-body");
    const entityId = glState.activeEntityId || "ent_dongvan_main";
    const isLocked = api.isPeriodLocked(glState, entityId, p.months[0]);

    // Panel 1: PMS Sync + Source Mode + Atomic Server JSON Import
    const modeSelect = el("select", { id: "er-gl-source-mode" },
      el("option", { value: "pms_plus_external", textContent: "PMS + Bút toán ngoài (tự hạch toán PMS)", selected: glState.sourceMode !== "external_master" }),
      el("option", { value: "external_master", textContent: "Nguồn kế toán ngoài làm chuẩn (chỉ liên kết đối chiếu PMS)", selected: glState.sourceMode === "external_master" })
    );
    const saveModeBtn = el("button", {
      type: "button",
      textContent: "Lưu chế độ nguồn",
      onClick: async () => {
        const r = await client.saveEnterpriseGlSetup({ sourceMode: modeSelect.value });
        $("er-status").textContent = r.ok ? `Đã lưu chế độ nguồn: ${modeSelect.value}` : (r.error || "Không lưu được.");
        if (r.ok) render(false);
      }
    });
    const syncBtn = el("button", {
      type: "button",
      className: "er-btn-primary",
      id: "er-gl-sync-pms",
      textContent: `Đồng bộ PMS → Sổ cái (${p.label})`,
      disabled: isLocked,
      onClick: async () => {
        $("er-status").textContent = "Đang đồng bộ bút toán PMS vào Sổ cái máy chủ…";
        const r = await client.syncPmsToGl({ anchor: $("er-month").value, kind: $("er-kind").value, entityId, sourceMode: modeSelect.value });
        if (!r.ok) { $("er-status").textContent = r.error || "Đồng bộ thất bại."; return; }
        $("er-status").textContent = `Đồng bộ PMS → GL hoàn tất: +${r.postedCount || 0} bút toán mới${r.skippedLocked?.length ? `, bỏ qua ${r.skippedLocked.length} do kỳ đã khóa` : ""}${r.unresolvedLegacy?.length ? `, ${r.unresolvedLegacy.length} khoản chuyển tiếp chờ đối soát` : ""}.`;
        render(false);
      }
    });

    const srvFile = el("input", { type: "file", id: "er-gl-import-file", accept: ".json,application/json" });
    srvFile.addEventListener("change", async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      try {
        if (f.size > 20 * 1024 * 1024) throw new Error("Kích thước tệp tối đa 20 MB.");
        const parsed = JSON.parse(await f.text());
        $("er-status").textContent = "Đang kiểm tra toàn bộ tệp & ghi giao dịch nguyên tử lên máy chủ…";
        const r = await client.importGlJournal({ journal: parsed, mode: "replace_external", entityId });
        if (!r.ok) {
          $("er-status").textContent = r.error || "Nhập sổ cái máy chủ thất bại (đã hoàn tác).";
          return;
        }
        $("er-status").textContent = `Đã nhập Sổ cái máy chủ thành công: +${r.insertedCount} bút toán${r.openingUpdated ? ", cập nhật số dư đầu kỳ" : ""}.`;
        render(false);
      } catch (err) {
        $("er-status").textContent = err.message || "Tệp JSON không hợp lệ.";
      } finally {
        ev.target.value = "";
      }
    });

    const panelSync = el("div", { className: "er-panel" },
      el("h4", { textContent: "1. Đồng bộ PMS & Nhập sổ nhật ký JSON lên máy chủ (Atomic all-or-nothing)" }),
      el("div", { className: "er-form-row" },
        el("label", {}, "Chế độ nguồn dữ liệu", modeSelect),
        saveModeBtn,
        syncBtn
      ),
      el("div", { className: "er-form-row" },
        el("button", { type: "button", textContent: "Tải mẫu JSON chuẩn", onClick: () => download(JSON.stringify(api.ledgerTemplate(p), null, 2), "mau-nhat-ky-" + p.from + ".json", "application/json") }),
        el("label", {}, "Nhập JSON vào Sổ cái máy chủ (lỗi 1 dòng sẽ hoàn tác 100%)", srvFile)
      )
    );
    body.append(panelSync);

    // Panel 2: Manual / External Balanced Journal Entry
    const acctOpts = () => (glState.accounts || []).map((a) => el("option", { value: a.code, textContent: `${a.code} — ${a.name}` }));
    const inDate = el("input", { type: "date", id: "er-je-date", value: p.to });
    const inVoucher = el("input", { type: "text", id: "er-je-voucher", placeholder: "VD: BT-202611-01" });
    const inSource = el("select", { id: "er-je-source" },
      ...Object.entries(api.EXTERNAL_SOURCE_TYPES || { manual: "Bút toán tay" }).map(([k, v]) => el("option", { value: k, textContent: v }))
    );
    const inDr = el("select", { id: "er-je-dr" }, ...acctOpts());
    const inCr = el("select", { id: "er-je-cr" }, ...acctOpts());
    if (inCr.options.length > 1) inCr.selectedIndex = 1;
    const inAmt = el("input", { type: "number", id: "er-je-amt", min: "1", step: "1000", placeholder: "Số tiền nguyên VND" });
    const inFlow = el("select", { id: "er-je-flow" },
      el("option", { value: "operating", textContent: "Lưu chuyển: Kinh doanh" }),
      el("option", { value: "investing", textContent: "Lưu chuyển: Đầu tư" }),
      el("option", { value: "financing", textContent: "Lưu chuyển: Tài chính" }),
      el("option", { value: "exchange", textContent: "Lưu chuyển: Tỷ giá" })
    );
    const inNote = el("input", { type: "text", id: "er-je-note", placeholder: "Diễn giải bút toán (lương, khấu hao, thuế, vay...)" });
    const postBtn = el("button", {
      type: "button",
      className: "er-btn-primary",
      id: "er-je-post",
      textContent: "Ghi bút toán cân đối Nợ/Có",
      disabled: isLocked,
      onClick: async () => {
        const amt = Math.trunc(Number(inAmt.value));
        if (!Number.isSafeInteger(amt) || amt <= 0) {
          $("er-status").textContent = "Số tiền phải là số nguyên VND dương.";
          return;
        }
        const r = await client.postGlJournalEntry({
          entityId,
          postingDate: inDate.value,
          voucherNo: inVoucher.value.trim(),
          sourceType: inSource.value,
          flow: inFlow.value,
          note: inNote.value.trim(),
          lines: [
            { accountCode: inDr.value, debit: amt },
            { accountCode: inCr.value, credit: amt }
          ]
        });
        if (!r.ok) { $("er-status").textContent = r.error || "Không ghi được bút toán."; return; }
        $("er-status").textContent = `Đã ghi bút toán ${r.entry.voucherNo} (${fmtVnd(amt)} đ).`;
        inAmt.value = "";
        inNote.value = "";
        render(false);
      }
    });

    const panelPost = el("div", { className: "er-panel" },
      el("h4", { textContent: "2. Ghi bút toán nguồn ngoài PMS / điều chỉnh (Cân đối Nợ = Có, số nguyên VND)" }),
      el("div", { className: "er-form-row" },
        el("label", {}, "Ngày hạch toán", inDate),
        el("label", {}, "Số chứng từ", inVoucher),
        el("label", {}, "Nguồn nghiệp vụ", inSource),
        el("label", {}, "Số tiền (VND)", inAmt)
      ),
      el("div", { className: "er-form-row" },
        el("label", {}, "Tài khoản Nợ (Dr)", inDr),
        el("label", {}, "Tài khoản Có (Cr)", inCr),
        el("label", {}, "Phân loại dòng tiền (nếu có TK Tiền)", inFlow)
      ),
      el("div", { className: "er-form-row" },
        el("label", { style: "flex:1;min-width:220px" }, "Diễn giải", inNote),
        postBtn
      )
    );
    body.append(panelPost);

    // Panel 3: Posted entries list with Reversal action (no deletion!)
    const inPeriod = (glState.entries || []).filter((e) => e.entityId === entityId && e.postingDate >= p.from && e.postingDate <= p.to);
    sections.push({
      name: "Nhật ký Sổ cái trong kỳ",
      headers: ["Ngày", "Chứng từ", "Nguồn", "Trạng thái", "Tổng Nợ (VND)", "Biến động tiền", "Diễn giải"],
      rows: inPeriod.map((e) => [e.postingDate, e.voucherNo, e.sourceType, e.status === "reversed" ? "Đã đảo" : "Đã ghi sổ", e.totalDebit, e.cashMovement, e.note || "—"])
    });

    const sec = el("section", {}, el("h3", { textContent: `3. Sổ nhật ký đã ghi trong kỳ (${inPeriod.length} bút toán — chỉ hủy bằng bút toán đảo)` }));
    const tbl = el("table");
    const trH = tbl.insertRow();
    for (const h of ["Ngày", "Chứng từ", "Nguồn", "Trạng thái", "Tổng Nợ (VND)", "Diễn giải", "Thao tác"]) {
      trH.append(el("th", { textContent: h }));
    }
    for (const e of inPeriod.slice(0, 200)) {
      const tr = tbl.insertRow();
      tr.append(
        el("td", { textContent: e.postingDate }),
        el("td", { textContent: e.voucherNo }),
        el("td", { textContent: e.sourceType }),
        el("td", { textContent: e.status === "reversed" ? "Đã đảo" : (e.reversesEntryId ? "Bút toán đảo" : "Đã ghi sổ") }),
        el("td", { className: "er-num", textContent: fmtVnd(e.totalDebit) }),
        el("td", { textContent: e.note || "—" })
      );
      const tdAct = el("td");
      if (e.status !== "reversed" && !e.reversesEntryId) {
        const revBtn = el("button", {
          type: "button",
          className: "er-btn-danger",
          textContent: "Đảo bút toán",
          onClick: async () => {
            const reason = window.prompt(`Nhập lý do đảo bút toán ${e.voucherNo}:`);
            if (!reason || !reason.trim()) return;
            const revDate = window.prompt("Ngày hạch toán bút toán đảo (YYYY-MM-DD, để trống = cùng ngày gốc):", e.postingDate);
            const r = await client.reverseGlJournalEntry(e.id, { reason: reason.trim(), reversalDate: (revDate || "").trim() || e.postingDate });
            $("er-status").textContent = r.ok ? `Đã tạo bút toán đảo ${r.reversalEntry.voucherNo}.` : (r.error || "Không thể đảo bút toán.");
            if (r.ok) render(false);
          }
        });
        tdAct.append(revBtn);
      } else {
        tdAct.textContent = "—";
      }
      tr.append(tdAct);
    }
    sec.append(tbl);
    body.append(sec);
    notice = `Quản trị Sổ cái máy chủ (${inPeriod.length} bút toán trong kỳ ${p.label}). Bút toán đã ghi không thể xóa — chỉ đảo bút toán có dấu vết.`;
  }

  function renderReconcileCloseTab(state, glState, p) {
    const body = $("er-body");
    const entityId = glState.activeEntityId || "ent_dongvan_main";
    const pk = p.months[0];
    const tb = api.computeTrialBalance(glState, p, { entityId });
    const recon = api.computeSubledgerReconciliation(glState, state, p, { entityId });
    const rec = (glState.periods && glState.periods[api.periodStateKey(entityId, pk)]) || { status: "draft", version: 0, history: [], unlockHistory: [] };

    // Period closing workflow controls
    const wfRow = el("div", { className: "er-form-row" });
    const reasonIn = el("input", { type: "text", id: "er-period-reason", placeholder: "Ghi chú chốt kỳ / Lý do mở khóa (bắt buộc khi mở khóa)", style: "flex:1;min-width:240px" });
    const doTransition = async (action) => {
      const r = await client.transitionGlPeriod({ entityId, periodKey: pk, action, reason: reasonIn.value.trim() });
      if (!r.ok) { $("er-status").textContent = r.error || "Không thể chuyển trạng thái kỳ."; return; }
      $("er-status").textContent = `Kỳ ${pk} đã chuyển sang: ${(api.PERIOD_STATUSES[r.periodState.status] || {}).label || r.periodState.status}${r.snapshot ? ` (chốt bản v${r.snapshot.version})` : ""}.`;
      render(false);
    };

    wfRow.append(
      reasonIn,
      el("button", { type: "button", id: "er-act-reconcile", textContent: "1. Đánh dấu Đã đối chiếu", disabled: rec.status === "locked" || !tb.endingBalanced, onClick: () => doTransition("reconcile") }),
      el("button", { type: "button", id: "er-act-approve", textContent: "2. Phê duyệt kỳ", disabled: rec.status !== "reconciled", onClick: () => doTransition("approve") }),
      el("button", { type: "button", id: "er-act-lock", className: "er-btn-primary", textContent: "3. Khóa kỳ & Chốt bản báo cáo", disabled: rec.status !== "approved", onClick: () => doTransition("lock") }),
      el("button", { type: "button", id: "er-act-unlock", className: "er-btn-danger", textContent: "Mở khóa kỳ (Cần lý do)", disabled: rec.status !== "locked", onClick: () => doTransition("unlock") })
    );
    body.append(el("div", { className: "er-panel" },
      el("h4", { textContent: `Quy trình khóa kỳ ${pk} — Trạng thái hiện tại: ${(api.PERIOD_STATUSES[rec.status] || api.PERIOD_STATUSES.draft).label}${rec.version ? ` (Đã chốt v${rec.version})` : ""}` }),
      wfRow
    ));

    // Trial Balance table
    section(
      `Bảng cân đối phát sinh (Trial Balance) — ${tb.endingBalanced && tb.periodBalanced ? "CÂN ĐỐI 0 đ" : "CHƯA CÂN ĐỐI"}`,
      ["Số TK", "Tên tài khoản", "Đầu kỳ Nợ", "Đầu kỳ Có", "Phát sinh Nợ", "Phát sinh Có", "Cuối kỳ Nợ", "Cuối kỳ Có"],
      [
        ...tb.rows.map((r) => [r.accountCode, r.accountName, r.openingDebit, r.openingCredit, r.periodDebit, r.periodCredit, r.endingDebit, r.endingCredit]),
        ["TỔNG CỘNG", tb.endingBalanced ? "Khớp Nợ = Có" : "LỆCH NỢ / CÓ", tb.totals.openingDebit, tb.totals.openingCredit, tb.totals.periodDebit, tb.totals.periodCredit, tb.totals.endingDebit, tb.totals.endingCredit]
      ]
    );

    // Cross-subledger reconciliation
    section(
      `Đối chiếu Sổ cái (GL) ↔ Sổ phụ PMS (${recon.hasIssues ? "Cần rà soát sai lệch" : "Khớp toàn bộ"})`,
      ["Sổ phụ đối chiếu", "Số liệu Sổ cái (GL)", "Số liệu Sổ phụ PMS", "Chênh lệch (GL - PMS)", "Trạng thái"],
      [
        ["Tiền mặt & Ngân hàng (Quỹ đã xác định)", recon.cash.glBalance, recon.cash.pmsBalance, recon.cash.diff, recon.cash.diff === 0 ? "Khớp" : "Lệch"],
        ["Phải thu khách hàng (AR)", recon.ar.glBalance, recon.ar.pmsBalance, recon.ar.diff, recon.ar.diff === 0 ? "Khớp" : "Lệch"],
        ["Phải trả nhà cung cấp (AP)", recon.ap.glBalance, recon.ap.pmsBalance, recon.ap.diff, recon.ap.diff === 0 ? "Khớp" : "Lệch"]
      ]
    );

    const flagRows = [
      ["Chứng từ chuyển tiếp chưa xác định quỹ", recon.flags.unresolvedLegacy.length, recon.flags.unresolvedLegacy.map((x) => x.voucherCode).join(", ") || "Không có"],
      ["Quỹ chưa có mốc đối chiếu thực tế", recon.flags.unreconciledFunds.length, recon.flags.unreconciledFunds.join(", ") || "Không có"],
      ["Phiên giao ca có chênh lệch kiểm đếm chưa xử lý", recon.flags.unreconciledShiftDiffs.length, recon.flags.unreconciledShiftDiffs.map((s) => `${s.shiftCode} (${fmtVnd(s.discrepancy)})`).join(", ") || "Không có"],
      ["Chứng từ trùng số hiệu trong Sổ cái", recon.flags.duplicateVouchers.length, recon.flags.duplicateVouchers.join(", ") || "Không có"],
      ["Chứng từ khác kỳ giữa ngày hạch toán và ngày nghiệp vụ", recon.flags.crossPeriodEntries.length, recon.flags.crossPeriodEntries.map((x) => x.voucherNo).join(", ") || "Không có"]
    ];
    section("Cảnh báo đối chiếu & tính toàn vẹn dữ liệu", ["Hạng mục kiểm tra", "Số lượng", "Chi tiết"], flagRows);
    notice = `Cân đối phát sinh: Nợ = ${fmtVnd(tb.totals.endingDebit)} đ, Có = ${fmtVnd(tb.totals.endingCredit)} đ (${tb.endingBalanced ? "Cân bằng 0 đ" : "Lệch"}).`;
  }

  function renderNotesAndSnapshotsTab(glState) {
    const body = $("er-body");
    const notes = Array.isArray(glState.notes) ? glState.notes : [];
    section("Thuyết minh báo cáo tài chính", ["Mục thuyết minh", "Nội dung"], notes.map((n) => [n.title, n.text]));

    const snaps = Array.isArray(glState.publishedSnapshots) ? glState.publishedSnapshots.slice().reverse() : [];
    section(`Lịch sử bản báo cáo đã chốt & khóa kỳ (${snaps.length} bản bất biến)`, ["Kỳ", "Phiên bản", "Thời điểm khóa", "Người khóa", "Doanh thu thuần", "LN sau thuế", "Tổng tài sản", "Tiền cuối kỳ", "Ghi chú"],
      snaps.map((s) => [
        s.periodKey,
        "v" + s.version,
        (s.lockedAt || "").slice(0, 19).replace("T", " "),
        s.lockedBy || "—",
        s.incomeStatement ? s.incomeStatement.netRevenue : null,
        s.incomeStatement ? s.incomeStatement.netProfit : null,
        s.balanceSheet ? s.balanceSheet.totalAssets : null,
        s.cashFlow ? s.cashFlow.endingCash : null,
        s.note || "—"
      ])
    );

    const logs = (glState.auditLogs || []).slice(-40).reverse();
    if (logs.length) {
      section("Nhật ký kiểm toán Sổ cái (40 thao tác gần nhất)", ["Thời gian", "Hành động", "Người thực hiện", "Tóm tắt"],
        logs.map((l) => [(l.ts || "").slice(0, 19).replace("T", " "), l.action || "", l.actor || "", l.summary || ""])
      );
    }

    body.append(el("div", {
      className: "er-disclaimer",
      textContent: "Mọi bản báo cáo đã khóa (v1, v2, ...) được lưu bất biến. Nếu phải mở khóa kỳ để điều chỉnh, hệ thống bắt buộc ghi lý do và giữ nguyên lịch sử bản đã chốt trước đó để đối chiếu kiểm toán."
    }));
    notice = `Thuyết minh & lịch sử ${snaps.length} bản báo cáo đã chốt.`;
  }

  async function render(refresh) {
    erase();
    const id = serial;
    if (!allowed()) {
      if (dialog.open) dialog.close();
      return;
    }
    const mode = $("er-mode").value;
    $("er-import").hidden = mode !== "ledger";
    updateTabVisibility();
    $("er-status").textContent = "Đang đọc số liệu…";
    try {
      const p = currentPeriod();
      if (mode === "ledger") {
        updateLockBadge(null, p);
        if (activeTab === "hotel_kpi") {
          renderHotelKpiTab(client.getSnapshot(), null, p);
        } else {
          ledgerView(p);
        }
      } else {
        const status = client.getStatus();
        if (refresh && (status.mode === "server" || status.backend === "supabase")) {
          const reply = await client.pullLatest();
          if (!reply?.ok) throw new Error(reply?.error || "Chưa đọc được số liệu máy chủ.");
        }
        if (id !== serial || !allowed() || !dialog.open) return;
        if (client.getStatus().financeLoadState && client.getStatus().financeLoadState !== "loaded") {
          throw new Error("Chưa tải được sổ tài chính.");
        }
        const snap = client.getSnapshot();
        const glState = snap.enterpriseGlState || api.createDefaultEnterpriseGlState();
        updateLockBadge(glState, p);

        if (activeTab === "hotel_kpi") {
          renderHotelKpiTab(snap, glState, p);
        } else if (mode === "hotel") {
          hotelView(snap, p);
        } else if (mode === "server_gl") {
          if (activeTab === "gl_ops") renderGlOpsTab(glState, p);
          else if (activeTab === "reconcile_close") renderReconcileCloseTab(snap, glState, p);
          else if (activeTab === "notes") renderNotesAndSnapshotsTab(glState);
          else renderServerGlStatements(glState, p);
        }
      }
      $("er-status").textContent = p.from + " – " + p.to + ". " + notice;
      rendered = currentScope();
      const hasData = sections.length > 0;
      $("er-csv").disabled = !hasData;
      if ($("er-xlsx")) $("er-xlsx").disabled = !hasData;
      if ($("er-pdf")) $("er-pdf").disabled = !hasData;
    } catch (err) {
      if (id === serial) {
        erase();
        $("er-status").textContent = err && err.message ? err.message : "Lỗi tổng hợp báo cáo.";
      }
    }
  }

  function download(body, name, type) {
    if (!allowed()) return;
    const blob = body instanceof Uint8Array ? new Blob([body], { type }) : new Blob([body], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function buildExportMeta() {
    const p = currentPeriod();
    const mode = $("er-mode").value;
    const snap = client.getSnapshot();
    const gl = snap && snap.enterpriseGlState;
    const lockBadge = $("er-lock-badge");
    return {
      title: `Báo cáo tài chính & quản trị (${p.label})`,
      enterprise: (journal && mode === "ledger" && journal.enterprise) || (gl && gl.entities && gl.entities[0] && gl.entities[0].name) || "Dongvan Ville du H'mong Hotel",
      from: p.from,
      to: p.to,
      scopeLabel: $("er-mode").options[$("er-mode").selectedIndex]?.textContent || mode,
      lockLabel: lockBadge && !lockBadge.hidden ? lockBadge.textContent : "Bản nháp / Trực tiếp",
      exportedAt: new Date().toISOString()
    };
  }

  function open() {
    if (!allowed()) return;
    $("er-month").value = core.getVietnamTodayISO().slice(0, 7);
    activeTab = "statements";
    if (!dialog.open) dialog.showModal();
    render(true);
  }

  $("btn-enterprise-report").addEventListener("click", open);
  $("er-close").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    erase();
    journal = null;
    $("er-file").value = "";
    $("er-status").textContent = "";
    if ($("er-lock-badge")) $("er-lock-badge").hidden = true;
  });

  for (const id of ["er-mode", "er-kind", "er-month", "er-compare"]) {
    const ctrl = $(id);
    if (!ctrl) continue;
    ctrl.onchange = () => {
      if (id !== "er-compare") {
        journal = null;
        $("er-file").value = "";
      }
      render(true);
    };
  }

  document.querySelectorAll("#er-tabs .er-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.getAttribute("data-tab") || "statements";
      render(false);
    });
  });

  $("er-refresh").onclick = () => render(true);
  $("er-template").onclick = () => {
    try {
      download(JSON.stringify(api.ledgerTemplate(currentPeriod()), null, 2), "mau-nhat-ky-" + currentPeriod().from + ".json", "application/json");
    } catch (err) {
      $("er-status").textContent = err.message;
    }
  };

  $("er-file").onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    erase();
    journal = null;
    const id = serial;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Kích thước tệp tối đa 20 MB.");
      const value = JSON.parse(await file.text());
      if (id !== serial || !allowed() || !dialog.open) return;
      api.statements(value, currentPeriod());
      journal = value;
      render(false);
    } catch (err) {
      if (id === serial) $("er-status").textContent = err.message;
    } finally {
      event.target.value = "";
    }
  };

  $("er-csv").onclick = () => {
    if (!sections.length || rendered !== currentScope() || !allowed()) return;
    function quote(val) {
      const raw = String(val ?? "");
      const safe = typeof val === "string" && /^\s*[=+@-]/.test(raw) ? "'" + raw : raw;
      return '"' + safe.replaceAll('"', '""') + '"';
    }
    const p = currentPeriod();
    const rows = [[p.from, p.to, notice], ...sections.flatMap((s) => [[s.name], s.headers, ...s.rows, []])];
    download("\ufeff" + rows.map((row) => row.map(quote).join(",")).join("\r\n"), "bao-cao-" + $("er-mode").value + "-" + p.from + ".csv", "text/csv;charset=utf-8");
  };

  if ($("er-xlsx")) {
    $("er-xlsx").onclick = () => {
      if (!sections.length || rendered !== currentScope() || !allowed()) return;
      const p = currentPeriod();
      const bytes = api.generateRealXlsxBytes(sections, buildExportMeta());
      download(bytes, `bao-cao-${$("er-mode").value}-${p.from}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    };
  }

  if ($("er-pdf")) {
    $("er-pdf").onclick = () => {
      if (!sections.length || rendered !== currentScope() || !allowed()) return;
      const html = api.generateReportPdfHtml(sections, buildExportMeta());
      const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const win = window.open(blobUrl, "_blank", "noopener");
      if (!win) {
        download(html, `bao-cao-a4-${$("er-mode").value}-${currentPeriod().from}.html`, "text/html;charset=utf-8");
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    };
  }

  let previousUser = "";
  function syncAccess() {
    const current = client.getStatus();
    const user = current.user?.id || current.user?.username || current.user?.staffName || "";
    $("btn-enterprise-report").hidden = !allowed();
    if (dialog.open && (!allowed() || user !== previousUser)) dialog.close();
    previousUser = user;
  }
  client.subscribe(syncAccess);
  syncAccess();
  window.PMSEnterpriseUI = { open };
})();
