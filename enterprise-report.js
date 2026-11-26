/* ============================================================================
   DONGVAN VILLE DU H'MONG HOTEL — ENTERPRISE ACCOUNTING, MANAGEMENT ANALYTICS,
   RECONCILIATION, PERIOD CLOSING & REAL XLSX/PDF EXPORT ENGINE (v2.0.0)
   Preserves 100% v1.9.2 API (groups, period, ledgerTemplate, statements, hotel)
   while adding MỐC 3–5 Server GL, Trial Balance, Hotel KPIs, 13-Week Cash
   Forecast, Subledger Reconciliation, Real OpenXML XLSX & Printable A4 HTML.
   ============================================================================ */
(function (root) {
  "use strict";
  const C = root.PMSCore || (typeof require === "function" && require("./pms-core.js"));

  const F = root.PMSFolio || (typeof require === "function" && require("./folio.js"));
  const groups = {
    cash: "Tiền và tương đương tiền",
    ar: "Phải thu ngắn hạn",
    inventory: "Hàng tồn kho",
    otherCurrent: "Tài sản ngắn hạn khác",
    fixed: "Nguyên giá tài sản cố định",
    depreciation: "Hao mòn lũy kế",
    longAssets: "Tài sản dài hạn khác",
    ap: "Phải trả nhà cung cấp",
    deposits: "Khách trả trước và tiền cọc",
    taxes: "Thuế phải nộp",
    wages: "Phải trả người lao động",
    shortDebt: "Vay và nợ ngắn hạn khác",
    longDebt: "Nợ dài hạn",
    capital: "Vốn góp",
    retained: "Lợi nhuận giữ lại đầu kỳ và phân phối",
    otherEquity: "Vốn chủ sở hữu khác",
    room: "Doanh thu phòng",
    dorm: "Doanh thu dorm",
    service: "Doanh thu dịch vụ",
    salesOther: "Doanh thu bán hàng khác",
    discounts: "Giảm trừ doanh thu",
    cogs: "Giá vốn",
    selling: "Chi phí bán hàng",
    admin: "Chi phí quản lý",
    finIncome: "Doanh thu tài chính",
    finExpense: "Chi phí tài chính",
    otherIncome: "Thu nhập khác",
    otherExpense: "Chi phí khác",
    incomeTax: "Chi phí thuế thu nhập doanh nghiệp"
  };

  const assets = ["cash", "ar", "inventory", "otherCurrent", "fixed", "depreciation", "longAssets"];
  const liabilities = ["ap", "deposits", "taxes", "wages", "shortDebt", "longDebt"];
  const equity = ["capital", "retained", "otherEquity"];
  const balanceSheetKeys = [...assets, ...liabilities, ...equity];
  const performance = Object.keys(groups).filter((k) => !balanceSheetKeys.includes(k));
  const flows = { operating: "Kinh doanh", investing: "Đầu tư", financing: "Tài chính", exchange: "Ảnh hưởng tỷ giá" };

  const PERIOD_STATUSES = Object.freeze({
    draft: { key: "draft", label: "Nháp (Đang mở)", editable: true },
    reconciled: { key: "reconciled", label: "Đã đối chiếu", editable: true },
    approved: { key: "approved", label: "Đã duyệt", editable: true },
    locked: { key: "locked", label: "Đã khóa kỳ", editable: false }
  });

  const EXTERNAL_SOURCE_TYPES = Object.freeze([
    { key: "payroll", label: "Tiền lương & bảo hiểm", defaultDr: "6421", defaultCr: "3341", defaultFlow: "operating" },
    { key: "inventory", label: "Hàng tồn kho & xuất dùng", defaultDr: "6321", defaultCr: "1521", defaultFlow: "operating" },
    { key: "prepaid_tools", label: "Công cụ dụng cụ & chi phí trả trước", defaultDr: "6421", defaultCr: "1421", defaultFlow: "operating" },
    { key: "fixed_asset_depreciation", label: "Tài sản cố định & khấu hao", defaultDr: "6421", defaultCr: "2141", defaultFlow: "investing" },
    { key: "loan_interest", label: "Vay & chi phí lãi vay", defaultDr: "6351", defaultCr: "3411", defaultFlow: "financing" },
    { key: "equity_capital", label: "Vốn góp & phân phối lợi nhuận", defaultDr: "1121", defaultCr: "4111", defaultFlow: "financing" },
    { key: "tax_provision", label: "Thuế & nghĩa vụ ngân sách", defaultDr: "8211", defaultCr: "3331", defaultFlow: "operating" },
    { key: "accrual", label: "Chi phí dồn tích & trả trước khác", defaultDr: "6421", defaultCr: "3351", defaultFlow: "operating" },
    { key: "manual", label: "Bút toán tổng hợp thủ công", defaultDr: "6421", defaultCr: "1111", defaultFlow: "operating" }
  ]);

  const DEFAULT_CHART_OF_ACCOUNTS = Object.freeze([
    { code: "1111", name: "Tiền mặt tại quầy lễ tân", groupKey: "cash", normalSide: "debit", fundId: "cash_frontdesk", active: true },
    { code: "1121", name: "Tiền gửi ngân hàng", groupKey: "cash", normalSide: "debit", fundId: "bank_main", active: true },
    { code: "1311", name: "Phải thu khách lưu trú & đoàn", groupKey: "ar", normalSide: "debit", active: true },
    { code: "1312", name: "Phải thu kênh OTA", groupKey: "ar", normalSide: "debit", active: true },
    { code: "1521", name: "Hàng tồn kho & vật tư khách sạn", groupKey: "inventory", normalSide: "debit", active: true },
    { code: "1421", name: "Chi phí trả trước & công cụ phân bổ", groupKey: "otherCurrent", normalSide: "debit", active: true },
    { code: "2111", name: "Nguyên giá tài sản cố định", groupKey: "fixed", normalSide: "debit", active: true },
    { code: "2141", name: "Hao mòn lũy kế TSCĐ", groupKey: "depreciation", normalSide: "credit", active: true },
    { code: "2421", name: "Tài sản dài hạn khác", groupKey: "longAssets", normalSide: "debit", active: true },
    { code: "3311", name: "Phải trả nhà cung cấp", groupKey: "ap", normalSide: "credit", active: true },
    { code: "131C", name: "Khách trả trước & tiền cọc đặt phòng", groupKey: "deposits", normalSide: "credit", active: true },
    { code: "3331", name: "Thuế và các khoản phải nộp Nhà nước", groupKey: "taxes", normalSide: "credit", active: true },
    { code: "3341", name: "Phải trả người lao động & BHXH", groupKey: "wages", normalSide: "credit", active: true },
    { code: "3351", name: "Chi phí phải trả / vay ngắn hạn khác", groupKey: "shortDebt", normalSide: "credit", active: true },
    { code: "3411", name: "Vay và nợ thuê tài chính ngắn hạn", groupKey: "shortDebt", normalSide: "credit", active: true },
    { code: "3412", name: "Vay và nợ dài hạn", groupKey: "longDebt", normalSide: "credit", active: true },
    { code: "4111", name: "Vốn góp của chủ sở hữu", groupKey: "capital", normalSide: "credit", active: true },
    { code: "4211", name: "Lợi nhuận sau thuế chưa phân phối", groupKey: "retained", normalSide: "credit", active: true },
    { code: "4181", name: "Quỹ & vốn chủ sở hữu khác", groupKey: "otherEquity", normalSide: "credit", active: true },
    { code: "5111", name: "Doanh thu dịch vụ phòng nghỉ", groupKey: "room", normalSide: "credit", active: true },
    { code: "5112", name: "Doanh thu Dorm nội bộ", groupKey: "dorm", normalSide: "credit", active: true },
    { code: "5113", name: "Doanh thu dịch vụ ngoài phòng (ăn sáng, giặt là, minibar, xe)", groupKey: "service", normalSide: "credit", active: true },
    { code: "5118", name: "Doanh thu bán hàng khác", groupKey: "salesOther", normalSide: "credit", active: true },
    { code: "5211", name: "Chiết khấu & giảm trừ doanh thu", groupKey: "discounts", normalSide: "debit", active: true },
    { code: "6321", name: "Giá vốn dịch vụ lưu trú (giặt là, ăn sáng, tiện ích phòng)", groupKey: "cogs", normalSide: "debit", active: true },
    { code: "6411", name: "Chi phí bán hàng & hoa hồng OTA", groupKey: "selling", normalSide: "debit", active: true },
    { code: "6421", name: "Chi phí quản lý doanh nghiệp", groupKey: "admin", normalSide: "debit", active: true },
    { code: "5151", name: "Doanh thu hoạt động tài chính", groupKey: "finIncome", normalSide: "credit", active: true },
    { code: "6351", name: "Chi phí tài chính & phí ngân hàng", groupKey: "finExpense", normalSide: "debit", active: true },
    { code: "7111", name: "Thu nhập khác (giữ cọc hủy phòng theo chính sách)", groupKey: "otherIncome", normalSide: "credit", active: true },
    { code: "8111", name: "Chi phí khác & chênh lệch kiểm kê đã duyệt", groupKey: "otherExpense", normalSide: "debit", active: true },
    { code: "8211", name: "Chi phí thuế thu nhập doanh nghiệp", groupKey: "incomeTax", normalSide: "debit", active: true }
  ]);

  const DEFAULT_PMS_MAPPING = Object.freeze({
    roomRevenue: "5111",
    dormRevenue: "5112",
    serviceRevenue: "5113",
    discounts: "5211",
    arCustomer: "1311",
    arOta: "1312",
    customerDeposit: "131C",
    cashFrontdesk: "1111",
    bankMain: "1121",
    apSupplier: "3311",
    retainedCancelDeposit: "7111",
    otaCommission: "6411",
    bankFee: "6351",
    cashDiscrepancy: "8111",
    costItemAccounts: {
      breakfast: "6321",
      laundry: "6321",
      amenities: "6321",
      housekeeping_supplies: "6321",
      electricity: "6321",
      water: "6321",
      internet_tv: "6421",
      maintenance: "6421",
      staff_salary: "6421",
      ota_commission: "6411",
      marketing: "6411",
      other_operating: "6421"
    }
  });

  function check(condition, message) {
    if (!condition) throw new Error(message);
  }
  function add(a, b) {
    const result = a + b;
    check(Number.isSafeInteger(result), "Giá trị vượt giới hạn số nguyên VND.");
    return result;
  }
  function total(values) {
    return values.reduce(add, 0);
  }
  function toSafeInt(v) {
    const n = Math.round(Number(v) || 0);
    return Number.isSafeInteger(n) ? n : 0;
  }
  function cleanText(v, maxLen = 240) {
    if (C && typeof C.sanitizeText === "function") return C.sanitizeText(v, maxLen);
    return String(v == null ? "" : v).trim().slice(0, maxLen);
  }
  function isValidDate(d) {
    if (C && typeof C.isValidISODate === "function") return C.isValidISODate(d);
    return /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
  }
  function daysInRange(fromISO, toISO) {
    if (!isValidDate(fromISO) || !isValidDate(toISO) || toISO < fromISO) return 0;
    const a = Date.parse(fromISO + "T00:00:00Z");
    const b = Date.parse(toISO + "T00:00:00Z");
    return Math.round((b - a) / 86400000) + 1;
  }
  function addDaysISO(iso, days) {
    const dt = new Date(iso + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  function period(month, kind) {
    check(/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && ["month", "quarter", "year", "ytd"].includes(kind), "Kỳ không hợp lệ.");
    const year = Number(month.slice(0, 4));
    const mNum = Number(month.slice(5));
    let months = [];
    if (kind === "ytd") {
      months = Array.from({ length: mNum }, (_, i) => year + "-" + String(i + 1).padStart(2, "0"));
    } else {
      const size = { month: 1, quarter: 3, year: 12 }[kind];
      const start = Math.floor((mNum - 1) / size) * size + 1;
      months = Array.from({ length: size }, (_, i) => year + "-" + String(start + i).padStart(2, "0"));
    }
    const lastM = Number(months[months.length - 1].slice(5));
    const lastDay = String(new Date(Date.UTC(year, lastM, 0)).getUTCDate()).padStart(2, "0");
    return {
      kind,
      anchorMonth: month,
      key: kind === "month" ? month : `${kind}:${months[0]}..${months[months.length - 1]}`,
      months,
      from: months[0] + "-01",
      to: months[months.length - 1] + "-" + lastDay
    };
  }

  function previousPeriod(p, mode = "yoy") {
    const firstMonth = p.months[0];
    const year = Number(firstMonth.slice(0, 4));
    const mNum = Number(firstMonth.slice(5));
    if (mode === "prev_period") {
      const len = p.months.length;
      const totalMonths = year * 12 + (mNum - 1) - len;
      if (totalMonths < 0) return null;
      const py = Math.floor(totalMonths / 12);
      const pm = (totalMonths % 12) + 1;
      const anchor = `${py}-${String(pm).padStart(2, "0")}`;
      if (p.kind === "ytd") return period(`${year - 1}-${p.anchorMonth.slice(5)}`, "ytd");
      return period(anchor, p.kind);
    }
    // YoY (same period prior year)
    const anchor = `${year - 1}-${(p.anchorMonth || firstMonth).slice(5)}`;
    return period(anchor, p.kind || ({ 1: "month", 3: "quarter", 12: "year" }[p.months.length] || "month"));
  }

  function ledgerTemplate(p) {
    return {
      format: "dongvan-journal-v1",
      enterprise: "",
      from: p.from,
      to: p.to,
      currency: "VND",
      complete: false,
      notes: [],
      opening: Object.fromEntries(balanceSheetKeys.map((k) => [k, 0])),
      entries: []
    };
  }

  // ===================== v1.9.2 IN-MEMORY JOURNAL STATEMENTS (100% PRESERVED) =====================
  function statements(file, p) {
    check(file && file.format === "dongvan-journal-v1" && file.currency === "VND" && file.from === p.from && file.to === p.to, "Sai mẫu, đơn vị tiền hoặc kỳ báo cáo.");
    check(typeof file.enterprise === "string" && file.enterprise.trim() && file.complete === true, "Cần tên doanh nghiệp và xác nhận sổ đã đủ dữ liệu cho kỳ.");
    check(file.opening && !Array.isArray(file.opening) && Array.isArray(file.entries), "Thiếu số dư đầu kỳ hoặc nhật ký.");
    check(file.notes === undefined || (Array.isArray(file.notes) && file.notes.every((n) => n && typeof n.title === "string" && typeof n.text === "string")), "Thuyết minh cần có title và text.");
    const opening = { ...ledgerTemplate(p).opening };
    for (const key of Object.keys(opening)) check(Object.hasOwn(file.opening, key), "Thiếu số dư đầu kỳ " + groups[key]);
    for (const [key, value] of Object.entries(file.opening)) {
      check(Object.hasOwn(opening, key) && Number.isSafeInteger(value), "Số dư đầu kỳ không hợp lệ ở " + key);
      opening[key] = value;
    }
    check(total(Object.values(opening)) === 0, "Đầu kỳ lệch Nợ và Có.");
    const ending = { ...opening, ...Object.fromEntries(performance.map((k) => [k, 0])) };
    const cashflow = Object.fromEntries(Object.keys(flows).map((k) => [k, 0]));
    const cashIn = { ...cashflow };
    const cashOut = { ...cashflow };
    const ids = new Set();
    const vouchers = [];
    for (const e of file.entries) {
      check(e && typeof e.id === "string" && e.id.trim() && !ids.has(e.id.trim()), "Chứng từ thiếu hoặc trùng mã.");
      ids.add(e.id.trim());
      check(isValidDate(e.date) && e.date >= p.from && e.date <= p.to && Array.isArray(e.lines) && e.lines.length >= 2, "Ngày hoặc số dòng không hợp lệ ở " + e.id);
      let balance = 0, movement = 0, debit = 0;
      for (const line of e.lines) {
        check(line && Object.hasOwn(ending, line.account), "Mã tài khoản chưa ánh xạ ở " + e.id);
        const dr = line.debit ?? 0, cr = line.credit ?? 0;
        check(Number.isSafeInteger(dr) && Number.isSafeInteger(cr) && dr >= 0 && cr >= 0 && ((dr > 0) !== (cr > 0)), "Số Nợ/Có sai ở " + e.id);
        const net = dr - cr;
        ending[line.account] = add(ending[line.account], net);
        debit = add(debit, dr);
        balance = add(balance, net);
        if (line.account === "cash") movement = add(movement, net);
      }
      check(balance === 0, "Chứng từ lệch Nợ/Có ở " + e.id);
      if (movement) {
        if (Array.isArray(e.flowAllocations) && e.flowAllocations.length > 0) {
          let allocSum = 0;
          for (const al of e.flowAllocations) {
            check(al && Object.hasOwn(flows, al.flow) && Number.isSafeInteger(al.amount) && al.amount !== 0, "Phân bổ lưu chuyển tiền sai ở " + e.id);
            allocSum = add(allocSum, al.amount);
            cashflow[al.flow] = add(cashflow[al.flow], al.amount);
            if (al.amount > 0) cashIn[al.flow] = add(cashIn[al.flow], al.amount);
            else cashOut[al.flow] = add(cashOut[al.flow], -al.amount);
          }
          check(allocSum === movement, "Tổng phân bổ lưu chuyển tiền khác biến động tiền ở " + e.id);
        } else {
          check(Object.hasOwn(flows, e.flow), "Thiếu phân loại lưu chuyển tiền ở " + e.id);
          cashflow[e.flow] = add(cashflow[e.flow], movement);
          if (movement > 0) cashIn[e.flow] = add(cashIn[e.flow], movement);
          else cashOut[e.flow] = add(cashOut[e.flow], -movement);
        }
      }
      vouchers.push([e.date, e.id, debit, movement, flows[e.flow] || (Array.isArray(e.flowAllocations) ? "Phân bổ nhiều hoạt động" : "")]);
    }
    const sum = (keys, book = ending) => total(keys.map((k) => book[k]));
    const revenue = 0 - sum(["room", "dorm", "service", "salesOther", "discounts"]);
    const gross = add(revenue, -ending.cogs);
    const beforeTax = -sum(performance.filter((k) => k !== "incomeTax"));
    const net = add(beforeTax, -ending.incomeTax);
    const assetsEnd = sum(assets), liabilitiesEnd = -sum(liabilities), equityEnd = add(-sum(equity), net);
    check(assetsEnd === add(liabilitiesEnd, equityEnd), "Bảng cân đối cuối kỳ lệch.");
    check(add(opening.cash, total(Object.values(cashflow))) === ending.cash, "Lưu chuyển tiền lệch với số dư cuối kỳ.");
    let comparison = null;
    if (file.comparison) {
      const month = String(Number(p.from.slice(0, 4)) - 1) + p.from.slice(4, 7);
      const earlier = period(month, ({ 1: "month", 3: "quarter", 12: "year" })[p.months.length] || "month");
      check(file.comparison.enterprise === file.enterprise && !file.comparison.comparison, "Sổ so sánh phải thuộc cùng doanh nghiệp và chỉ một kỳ.");
      comparison = statements(file.comparison, earlier);
    }
    return { comparison, opening, ending, cashIn, cashOut, cashflow, vouchers, revenue, gross, beforeTax, net, assetsEnd, liabilitiesEnd, equityEnd };
  }

  // ===================== v1.9.2 PMS HOTEL SUMMARY (100% PRESERVED + RETAINED DEPOSIT) =====================
  function hotel(state, p) {
    check(state && Array.isArray(state.bookings) && state.financeState && Array.isArray(state.financeState.transactions) && state.operatingCosts, "Chưa tải đủ sổ tiền, chi phí và đặt phòng.");
    const b = state.bookings, f = state.financeState;
    const months = p.months.map((m) => C.computeMonthlyOperatingCosts(state.operatingCosts, b, m, f));
    const ar = C.computeReceivablesReport(b, f, { asOfDate: p.to });
    const ap = C.computeSupplierPayablesReport(f, state.operatingCosts, { asOfDate: p.to });
    const cash = C.computeCashbookReport(f, b, { toDate: p.to });
    const txs = f.transactions.filter((t) => t.receivedDate >= p.from && t.receivedDate <= p.to);
    const txTotal = (type) => total(txs.filter((t) => t.txType === type).map((t) => t.amount));
    const retainedDepositRevenue = total(b.filter((x) => {
      const pol = x && x.cancelDepositPolicy;
      if (!pol || !pol.revenueRecognized || !pol.retainedAmount) return false;
      const dt = pol.recognizedDate || (x.cancelledAt ? String(x.cancelledAt).slice(0, 10) : "");
      return dt >= p.from && dt <= p.to;
    }).map((x) => C.parseVND(x.cancelDepositPolicy.retainedAmount)));
    return {
      months,
      ar,
      ap,
      cash,
      txs,
      receipts: txTotal("customer_payment"),
      refunds: txTotal("customer_refund"),
      payouts: txTotal("supplier_payment"),
      retainedDepositRevenue
    };
  }

  // ===================== MỐC 3: SERVER-AUTHORITATIVE ENTERPRISE GENERAL LEDGER =====================
  function createDefaultEnterpriseGlState() {
    const nowISO = new Date().toISOString();
    return {
      schemaVersion: 1,
      glVersion: 0,
      entities: [
        {
          id: "ent_dongvan_main",
          name: "Dongvan Ville du H'mong Hotel",
          taxCode: "",
          currency: "VND",
          regimeNote: "Chế độ kế toán nội bộ — cần kế toán trưởng xác nhận chế độ/niên độ/người ký trước khi xuất báo cáo pháp định.",
          properties: [{ id: "prop_dongvan_1", name: "Cơ sở Đồng Văn (26 phòng + 8 giường Dorm)" }],
          active: true
        }
      ],
      activeEntityId: "ent_dongvan_main",
      accounts: DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({ ...a, approvedBy: "Mặc định hệ thống", approvedAt: nowISO })),
      mapping: JSON.parse(JSON.stringify(DEFAULT_PMS_MAPPING)),
      openingBalances: [], // [{ id, entityId, propertyId, periodKey, voucherNo, asOfDate, lines: [{ accountCode, groupKey, amount (signed Dr+ / Cr-) }], approvedBy, approvedAt, note }]
      entries: [], // Posted & reversed double-entry journal vouchers
      periods: {}, // { [entityId + ':' + periodKey]: { entityId, periodKey, status, sourceMode, version, updatedBy, updatedAt, note, publishedSnapshots: [], auditLog: [] } }
      budgets: {}, // { [periodKey]: { room: 0, dorm: 0, service: 0, cogs: 0, operating: 0 } }
      notes: [
        { title: "Phạm vi báo cáo", text: "Áp dụng cho Dongvan Ville du H'mong Hotel (đơn vị tiền tệ: VND nguyên đồng)." },
        { title: "Chính sách doanh thu & cọc", text: "Doanh thu phòng và dorm phân bổ theo đêm lưu trú tách biệt dịch vụ; tiền cọc khách chỉ ghi doanh thu/thu nhập khác khi có xác nhận chính sách hủy phòng." },
        { title: "Báo cáo pháp định Việt Nam", text: "Trước khi sử dụng làm báo cáo pháp định, kế toán trưởng cần xác nhận chế độ kế toán (TT200/TT133), niên độ, mẫu biểu và người ký." }
      ],
      auditLogs: [],
      publishedSnapshots: [],
      sourceMode: "pms_plus_external",
      updatedAt: nowISO
    };
  }

  function sanitizeEnterpriseGlState(raw) {
    const def = createDefaultEnterpriseGlState();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return def;
    const accounts = Array.isArray(raw.accounts) && raw.accounts.length > 0
      ? raw.accounts.filter((a) => a && a.code && Object.hasOwn(groups, a.groupKey)).map((a) => ({
          code: cleanText(a.code, 24),
          name: cleanText(a.name, 140) || groups[a.groupKey],
          groupKey: a.groupKey,
          normalSide: a.normalSide === "credit" ? "credit" : "debit",
          fundId: cleanText(a.fundId, 48),
          approvedBy: cleanText(a.approvedBy, 60),
          approvedAt: cleanText(a.approvedAt, 40),
          active: a.active !== false
        }))
      : def.accounts;
    const entities = Array.isArray(raw.entities) && raw.entities.length > 0
      ? raw.entities.filter((e) => e && e.id).map((e) => ({
          id: cleanText(e.id, 64),
          name: cleanText(e.name, 140) || "Doanh nghiệp",
          taxCode: cleanText(e.taxCode, 40),
          currency: "VND",
          regimeNote: cleanText(e.regimeNote, 400),
          properties: Array.isArray(e.properties) && e.properties.length > 0
            ? e.properties.map((pr) => ({ id: cleanText(pr.id, 64) || "prop_1", name: cleanText(pr.name, 120) || "Cơ sở chính" }))
            : [{ id: "prop_1", name: "Cơ sở chính" }],
          active: e.active !== false
        }))
      : def.entities;
    const activeEntityId = entities.some((e) => e.id === raw.activeEntityId) ? raw.activeEntityId : entities[0].id;
    const openingBalances = Array.isArray(raw.openingBalances) ? raw.openingBalances.filter((o) => o && typeof o === "object") : [];
    const entries = Array.isArray(raw.entries) ? raw.entries.filter((e) => e && typeof e === "object" && Array.isArray(e.lines)) : [];
    const periods = raw.periods && typeof raw.periods === "object" && !Array.isArray(raw.periods) ? { ...raw.periods } : {};
    const budgets = raw.budgets && typeof raw.budgets === "object" && !Array.isArray(raw.budgets) ? { ...raw.budgets } : {};
    const notes = Array.isArray(raw.notes)
      ? raw.notes.filter((n) => n && typeof n.title === "string" && typeof n.text === "string").map((n) => ({ title: cleanText(n.title, 160), text: cleanText(n.text, 1000) }))
      : def.notes;
    const auditLogs = Array.isArray(raw.auditLogs) ? raw.auditLogs.slice(-300) : [];
    const mapping = raw.mapping && typeof raw.mapping === "object"
      ? { ...def.mapping, ...raw.mapping, costItemAccounts: { ...def.mapping.costItemAccounts, ...(raw.mapping.costItemAccounts || {}) } }
      : def.mapping;
    return {
      schemaVersion: 1,
      glVersion: Math.max(0, Math.trunc(Number(raw.glVersion) || 0)),
      entities,
      activeEntityId,
      accounts,
      mapping,
      openingBalances,
      entries,
      periods,
      budgets,
      notes,
      auditLogs,
      publishedSnapshots: Array.isArray(raw.publishedSnapshots) ? raw.publishedSnapshots.slice(-120) : [],
      sourceMode: raw.sourceMode === "external_master" ? "external_master" : "pms_plus_external",
      updatedAt: cleanText(raw.updatedAt, 40) || new Date().toISOString()
    };
  }

  function buildAccountLookup(glState) {
    const byCode = new Map();
    const firstByGroup = new Map();
    for (const acc of (glState.accounts || DEFAULT_CHART_OF_ACCOUNTS)) {
      byCode.set(acc.code, acc);
      if (!firstByGroup.has(acc.groupKey)) firstByGroup.set(acc.groupKey, acc);
    }
    return { byCode, firstByGroup };
  }

  function resolveAccount(line, lookup) {
    const rawAcc = String(line.accountCode || line.account || "").trim();
    if (lookup.byCode.has(rawAcc)) {
      const acc = lookup.byCode.get(rawAcc);
      return { accountCode: acc.code, groupKey: acc.groupKey, accountName: acc.name };
    }
    if (Object.hasOwn(groups, rawAcc)) {
      const acc = lookup.firstByGroup.get(rawAcc);
      return { accountCode: acc ? acc.code : rawAcc, groupKey: rawAcc, accountName: acc ? acc.name : groups[rawAcc] };
    }
    return null;
  }

  function validateJournalEntry(entry, glState) {
    const st = sanitizeEnterpriseGlState(glState);
    const lookup = buildAccountLookup(st);
    check(entry && typeof entry === "object", "Thiếu dữ liệu chứng từ.");
    const postingDate = cleanText(entry.postingDate || entry.date, 20);
    const businessDate = cleanText(entry.businessDate || postingDate, 20);
    check(isValidDate(postingDate), "Ngày hạch toán không hợp lệ.");
    check(isValidDate(businessDate), "Ngày nghiệp vụ không hợp lệ.");
    check(Array.isArray(entry.lines) && entry.lines.length >= 2, "Chứng từ phải có ít nhất 2 dòng Nợ/Có.");

    let sumDr = 0, sumCr = 0, cashNet = 0;
    const cleanLines = [];
    for (const ln of entry.lines) {
      check(ln && typeof ln === "object", "Dòng hạch toán không hợp lệ.");
      const resolved = resolveAccount(ln, lookup);
      check(resolved, "Tài khoản chưa được khai báo/ánh xạ: " + (ln.accountCode || ln.account || ""));
      const dr = ln.debit === undefined || ln.debit === null || ln.debit === "" ? 0 : Number(ln.debit);
      const cr = ln.credit === undefined || ln.credit === null || ln.credit === "" ? 0 : Number(ln.credit);
      check(Number.isSafeInteger(dr) && Number.isSafeInteger(cr) && dr >= 0 && cr >= 0 && ((dr > 0) !== (cr > 0)), "Số tiền Nợ/Có phải là số nguyên VND dương ở đúng một bên.");
      sumDr = add(sumDr, dr);
      sumCr = add(sumCr, cr);
      if (resolved.groupKey === "cash") cashNet = add(cashNet, dr - cr);
      cleanLines.push({
        accountCode: resolved.accountCode,
        groupKey: resolved.groupKey,
        accountName: resolved.accountName,
        debit: dr,
        credit: cr,
        department: cleanText(ln.department || entry.department, 40) || "general",
        partner: cleanText(ln.partner || entry.partnerName, 120),
        memo: cleanText(ln.memo || entry.note, 240)
      });
    }
    check(sumDr > 0 && sumDr === sumCr, `Chứng từ lệch Nợ (${sumDr}) ≠ Có (${sumCr}).`);

    let cleanFlow = cleanText(entry.flow, 24);
    let cleanFlowAllocations = null;
    if (cashNet !== 0) {
      if (Array.isArray(entry.flowAllocations) && entry.flowAllocations.length > 0) {
        let allocSum = 0;
        cleanFlowAllocations = entry.flowAllocations.map((a) => {
          check(a && Object.hasOwn(flows, a.flow) && Number.isSafeInteger(Number(a.amount)) && Number(a.amount) !== 0, "Phân bổ lưu chuyển tiền không hợp lệ.");
          const amt = Number(a.amount);
          allocSum = add(allocSum, amt);
          return { flow: a.flow, amount: amt, note: cleanText(a.note, 160) };
        });
        check(allocSum === cashNet, `Tổng phân bổ lưu chuyển tiền (${allocSum}) khác biến động tiền ròng (${cashNet}).`);
        cleanFlow = cleanFlowAllocations[0].flow;
      } else {
        check(Object.hasOwn(flows, cleanFlow), "Chứng từ thay đổi tiền ròng bắt buộc có phân loại lưu chuyển tiền (operating/investing/financing/exchange).");
      }
    }

    const nowISO = new Date().toISOString();
    const periodKey = postingDate.slice(0, 7);
    const entityId = cleanText(entry.entityId, 64) || st.activeEntityId;
    const propertyId = cleanText(entry.propertyId, 64) || ((st.entities.find((e) => e.id === entityId) || st.entities[0]).properties[0].id);
    const id = cleanText(entry.id, 96) || `gle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const voucherNo = cleanText(entry.voucherNo || entry.id, 64) || `CT-${postingDate.replace(/-/g, "")}-${id.slice(-4).toUpperCase()}`;

    return {
      id,
      voucherNo,
      entityId,
      propertyId,
      periodKey,
      postingDate,
      businessDate,
      currency: "VND",
      sourceType: cleanText(entry.sourceType, 48) || "manual",
      sourceEventId: cleanText(entry.sourceEventId, 120),
      eventType: cleanText(entry.eventType, 48) || "post",
      department: cleanText(entry.department, 40) || "general",
      partnerName: cleanText(entry.partnerName, 120),
      invoiceId: cleanText(entry.invoiceId, 80),
      bookingId: cleanText(entry.bookingId, 80),
      groupCode: cleanText(entry.groupCode, 60),
      intercompany: Boolean(entry.intercompany),
      isElimination: Boolean(entry.isElimination || entry.sourceType === "elimination"),
      flow: cashNet !== 0 ? cleanFlow : "",
      flowAllocations: cleanFlowAllocations,
      totalDebit: sumDr,
      cashMovement: cashNet,
      status: entry.status === "reversed" ? "reversed" : "posted",
      reversesEntryId: cleanText(entry.reversesEntryId, 96),
      reversedByEntryId: cleanText(entry.reversedByEntryId, 96),
      approvedBy: cleanText(entry.approvedBy, 60),
      note: cleanText(entry.note, 400),
      lines: cleanLines,
      createdAt: cleanText(entry.createdAt, 40) || nowISO
    };
  }

  function periodStateKey(entityId, periodKey) {
    return `${entityId || "ent_dongvan_main"}:${periodKey}`;
  }

  function isPeriodLocked(glState, entityId, periodKey) {
    const rec = glState && glState.periods && glState.periods[periodStateKey(entityId, periodKey)];
    return Boolean(rec && rec.status === "locked");
  }

  // ===================== PMS -> GL AUTO-POSTING MATRIX =====================
  function buildPmsAutoPostEntries(pmsSnapshot, glState, p, opts = {}) {
    const st = sanitizeEnterpriseGlState(glState);
    const map = st.mapping;
    const entityId = opts.entityId || st.activeEntityId;
    const propertyId = opts.propertyId || ((st.entities.find((e) => e.id === entityId) || st.entities[0]).properties[0].id);
    const actor = cleanText(opts.actorName, 60) || "Hệ thống PMS";
    const bookings = Array.isArray(pmsSnapshot && pmsSnapshot.bookings) ? pmsSnapshot.bookings : [];
    const fin = (pmsSnapshot && pmsSnapshot.financeState) || (C ? C.createDefaultFinanceState() : { transactions: [], supplierInvoices: [] });
    const txs = Array.isArray(fin.transactions) ? fin.transactions : [];
    const invoices = Array.isArray(fin.supplierInvoices) ? fin.supplierInvoices : [];

    const periodRec = st.periods[periodStateKey(entityId, p.months[0])];
    const sourceMode = (opts.sourceMode || (periodRec && periodRec.sourceMode) || "pms_plus_external");
    const entries = [];
    const unresolvedLegacy = [];
    const reconciledExternalLinks = [];

    const asOf = opts.asOfDate || C.getVietnamTodayISO();
    const folios = F.statements(bookings,fin);
    const history = new Map();
    const targetKeys = new Set();
    const sourceKey = e => e.sourceType + "|" + e.sourceEventId;
    for (const e of st.entries) {
      if (e.entityId !== entityId || e.propertyId !== propertyId || !e.sourceEventId) continue;
      const key = sourceKey(e);
      if (!history.has(key)) history.set(key,[]);
      history.get(key).push(e);
    }
    function pushIfNew(draft) {
      const key = sourceKey(draft);
      if (targetKeys.has(key)) return;
      targetKeys.add(key);
      if (draft.postingDate>asOf) return;
      if (sourceMode === "external_master") {
        reconciledExternalLinks.push({sourceType:draft.sourceType,sourceEventId:draft.sourceEventId,amount:draft.lines.reduce((s,l)=>s+(l.debit||0),0),date:draft.postingDate});
        return;
      }
      const prior = history.get(key) || [];
      if (prior.length) {
        const delta = new Map();
        function accumulate(lines,sign,partner) {
          for (const l of lines) {
            const party = l.partner || partner || "";
            const k = JSON.stringify([l.accountCode,party]);
            delta.set(k,(delta.get(k)||0)+sign*((l.debit||0)-(l.credit||0)));
          }
        }
        // Explicit reversals and re-dating across closed months require accounting review.
        if (prior.some(e=>e.status==="reversed" || e.reversesEntryId || e.periodKey!==draft.postingDate.slice(0,7))) {
          unresolvedLegacy.push({id:key,reason:"Chứng từ đã đảo hoặc đổi kỳ, cần kế toán kiểm tra."});
          return;
        }
        accumulate(draft.lines,1,draft.partnerName);
        for(const e of prior) accumulate(e.lines,-1,e.partnerName);
        const lines = [];
        for(const [k,n] of delta) {
          const [accountCode,partner]=JSON.parse(k);
          if(n) lines.push({accountCode,partner,debit:Math.max(n,0),credit:Math.max(-n,0)});
        }
        if (!lines.length) return;
        draft={...draft,lines,eventType:"adjust_"+prior.length,voucherNo:"DC-"+draft.voucherNo+"-"+prior.length,note:"Điều chỉnh theo chứng từ nguồn · "+draft.note};
      }
      if (isPeriodLocked(st,entityId,draft.postingDate.slice(0,7))) {
        unresolvedLegacy.push({id:key,reason:"Kỳ đã khóa, cần xử lý theo quy trình điều chỉnh."});
        return;
      }
      entries.push(validateJournalEntry({...draft,entityId,propertyId,approvedBy:actor},st));
    }
    const arFor = role => role==="ota" ? map.arOta : map.arCustomer;
    function payerDebits(b,key,month){
      const rows=[...folios.sheets.values()].find(s=>s.entity.memberIds.has(b.id))?.rows||[];
      const sums=new Map();
      for(const row of rows)if(row.b.id===b.id && row.key===key && (!month || row.date.startsWith(month))){
        const id=row.who.id;sums.set(id,{who:row.who,amount:(sums.get(id)?.amount||0)+row.charge});
      }
      return [...sums.values()].filter(x=>x.amount>0).map(x=>({accountCode:arFor(x.who.role),partner:x.who.name,debit:x.amount}));
    }
    // 1. Booking room/dorm revenue (prorated per month in period), active services, discounts, retained cancel deposits
    for (const bk of bookings) {
      if (!bk || !bk.id) continue;
      const isCancelled = C ? C.isBookingCancelled(bk) : bk.status === "cancelled";
      const arAcct = arFor(F.payer(bk,"room"));

      for(const fee of bk.ops24?.netFees||[])if(fee.day>=p.from && fee.day<=p.to)pushIfNew({
        sourceType:"pms_ota_net_fee",sourceEventId:fee.id,eventType:"settle_commission",postingDate:fee.day,businessDate:fee.day,
        partnerName:F.party(bk,"ota").name,bookingId:bk.id,groupCode:bk.bookingCode||"",voucherNo:"OTA-"+fee.id,
        note:"Cấn phí bảng kê "+fee.notice,lines:[{accountCode:map.otaCommission,debit:Math.max(fee.fee,0),credit:Math.max(-fee.fee,0)},{accountCode:map.arOta,credit:Math.max(fee.fee,0),debit:Math.max(-fee.fee,0)}]
      });
      if (isCancelled) {
        const pol = bk.cancelDepositPolicy;
        if (pol && pol.revenueRecognized && toSafeInt(pol.retainedAmount) > 0) {
          const recDate = pol.recognizedDate || (bk.cancelledAt ? String(bk.cancelledAt).slice(0, 10) : p.from);
          if (recDate >= p.from && recDate <= p.to) {
            pushIfNew({
              voucherNo: `GL-COC-${bk.id.slice(-6).toUpperCase()}`,
              postingDate: recDate,
              businessDate: recDate,
              sourceType: "pms_cancel_retain",
              sourceEventId: bk.id,
              eventType: "retain_deposit",
              department: bk.roomId === "DORM" ? "dorm" : "rooms",
              partnerName: F.party(bk,F.payer(bk,"room")).name,
              bookingId: bk.id,
              groupCode: bk.bookingCode || "",
              note: `Ghi nhận giữ cọc hủy phòng P.${bk.roomId} (${bk.guestName || ""})`,
              lines: [
                { accountCode: map.customerDeposit, debit: toSafeInt(pol.retainedAmount) },
                { accountCode: map.retainedCancelDeposit, credit: toSafeInt(pol.retainedAmount) }
              ]
            });
          }
        }
        continue;
      }

      // Prorated room/dorm revenue per month in period (exact last-VND conservation from PMSCore!)
      for (const mKey of p.months) {
        const pr = C.computeMonthlyProratedRevenue([bk], mKey);
        const revAmt = bk.roomId === "DORM" ? pr.proratedDormRevenue : pr.proratedRoomRevenue;
        if (revAmt > 0) {
          const mEnd = period(mKey, "month").to;
          const postDate = bk.checkout && bk.checkout <= mEnd && bk.checkout >= `${mKey}-01` ? bk.checkout : mEnd;
          pushIfNew({
            voucherNo: `GL-DT-${mKey.replace("-", "")}-${bk.id.slice(-5).toUpperCase()}`,
            postingDate: postDate,
            businessDate: bk.checkin || postDate,
            sourceType: "pms_booking_revenue",
            sourceEventId: `${bk.id}:${mKey}`,
            eventType: "accrue_room_revenue",
            department: bk.roomId === "DORM" ? "dorm" : "rooms",
            partnerName: F.party(bk,F.payer(bk,"room")).name,
            bookingId: bk.id,
            groupCode: bk.bookingCode || "",
            note: `Doanh thu lưu trú P.${bk.roomId} (${mKey})`,
            lines: [
              ...payerDebits(bk,"room",mKey),
              { accountCode: bk.roomId === "DORM" ? map.dormRevenue : map.roomRevenue, credit: revAmt }
            ]
          });
        }
      }

      // Active line-level services in period
      for (const sv of (Array.isArray(bk.services) ? bk.services : [])) {
        if (!sv || sv.status === "cancelled") continue;
        const role = F.payer(bk,"service:"+sv.id);
        const arAcct = arFor(role);
        const amt = toSafeInt(sv.amount);
        const dt = sv.serviceDate || sv.dateISO || bk.checkin;
        if (amt <= 0 || !isValidDate(dt) || dt < p.from || dt > p.to) continue;
        pushIfNew({
          voucherNo: `GL-DV-${String(sv.id || "1").slice(-6).toUpperCase()}`,
          postingDate: dt,
          businessDate: dt,
          sourceType: "pms_booking_service",
          sourceEventId: `${bk.id}:${sv.id}`,
          eventType: "accrue_service",
          department: "fnb",
          partnerName: F.party(bk,role).name,
          bookingId: bk.id,
          groupCode: bk.bookingCode || "",
          note: `Dịch vụ ${sv.name || ""} — P.${bk.roomId}`,
          lines: [
            ...payerDebits(bk,"service:"+sv.id),
            { accountCode: map.serviceRevenue, credit: amt }
          ]
        });
      }

      // Active adjustments (negative = discount -> Dr 5211 / Cr AR; positive = surcharge -> Dr AR / Cr 5113)
      for (const adj of (Array.isArray(bk.adjustments) ? bk.adjustments : [])) {
        if (!adj || adj.status === "cancelled") continue;
        const role = F.payer(bk,"adjustment:"+adj.id);
        const arAcct = arFor(role);
        const amt = toSafeInt(adj.amount);
        const dt = adj.effectiveDate || bk.checkin;
        if (amt === 0 || !isValidDate(dt) || dt < p.from || dt > p.to) continue;
        const lines = amt < 0
          ? [{ accountCode: map.discounts, debit: Math.abs(amt) }, { accountCode: arAcct, credit: Math.abs(amt) }]
          : [{ accountCode: arAcct, debit: amt }, { accountCode: map.serviceRevenue, credit: amt }];
        pushIfNew({
          voucherNo: `GL-DC-${String(adj.id || "1").slice(-6).toUpperCase()}`,
          postingDate: dt,
          businessDate: dt,
          sourceType: "pms_booking_adjustment",
          sourceEventId: `${bk.id}:${adj.id}`,
          eventType: amt < 0 ? "discount" : "surcharge",
          department: "rooms",
          partnerName: F.party(bk,role).name,
          bookingId: bk.id,
          groupCode: bk.bookingCode || "",
          note: `Điều chỉnh ${adj.reason || ""} — P.${bk.roomId}`,
          lines
        });
      }
    }

    // 2. Supplier invoices (accrual: Dr Expense/COGS -> Cr AP 3311)
    for (const inv of invoices) {
      if (!inv || !inv.id || inv.status === "voided") continue;
      const dt = inv.invoiceDate || inv.dueDate;
      if (!isValidDate(dt) || dt < p.from || dt > p.to) continue;
      const invLines = Array.isArray(inv.lines) && inv.lines.length > 0
        ? inv.lines
        : [{ costItemId: inv.costItemId || "other_operating", amount: toSafeInt(inv.totalAmount) }];
      const glLines = [];
      let sumInv = 0;
      for (const il of invLines) {
        const amt = toSafeInt(il.amount);
        if (amt <= 0) continue;
        sumInv = add(sumInv, amt);
        const expCode = map.costItemAccounts?.[il.costItemId] || (il.costItemId==="ci_booking_fee" ? map.otaCommission : "6421");
        glLines.push({ accountCode: expCode, debit: amt, memo: il.description || inv.supplierName || "" });
      }
      if (sumInv > 0) {
        glLines.push({ accountCode: map.apSupplier, credit: sumInv, partner: inv.supplierName || "" });
        pushIfNew({
          voucherNo: inv.voucherNo || `GL-NCC-${inv.id.slice(-5).toUpperCase()}`,
          postingDate: dt,
          businessDate: dt,
          sourceType: "pms_supplier_invoice",
          sourceEventId: inv.id,
          eventType: "accrue_ap",
          department: "admin",
          partnerName: inv.supplierName || "",
          invoiceId: inv.id,
          note: `Hóa đơn NCC ${inv.supplierName || ""} (${inv.voucherNo || ""})`,
          lines: glLines
        });
      }
    }

    // 3. Cashbook transactions (receipts, refunds, AP payments, internal transfers, adjustments, legacy flags)
    const bkById = new Map(bookings.map((b) => [b.id, b]));
    for (const tx of txs) {
      if (!tx || !tx.id || tx.status === "voided") continue;
      if (tx.txType === "legacy_payment" && tx.legacyStatus !== "reconciled") {
        if (tx.legacyStatus !== "reconciled_in_opening") {
          unresolvedLegacy.push({ id: tx.id, voucherCode: tx.voucherCode, amount: toSafeInt(tx.amount), reason: "Khoản chuyển tiếp chưa xác định quỹ / ngày thực nhận" });
        }
        continue;
      }
      const dt = tx.receivedDate;
      if (!isValidDate(dt) || dt < p.from || dt > p.to) continue;
      const amt = toSafeInt(tx.amount);
      if (amt === 0) continue;
      const cashAcct = tx.fundId === "bank_main" ? map.bankMain : map.cashFrontdesk;

      if (tx.txType === "customer_payment" || (tx.txType === "legacy_payment" && tx.legacyStatus === "reconciled")) {
        const receipt = folios.receipts.get(tx.id);
        if (!receipt) { unresolvedLegacy.push({id:tx.id,reason:"Chưa gắn người trả."}); continue; }
        const isPreStayDeposit = receipt.deposit !== 0;
        const crAcct = isPreStayDeposit ? map.customerDeposit : arFor(receipt.who.role);
        pushIfNew({
          voucherNo: tx.voucherCode || `GL-PT-${tx.id.slice(-5).toUpperCase()}`,
          postingDate: dt,
          businessDate: dt,
          sourceType: "pms_customer_payment",
          sourceEventId: tx.id,
          eventType: isPreStayDeposit ? "collect_deposit" : "collect_ar",
          department: "rooms",
          partnerName: receipt.who.name,
          bookingId: tx.bookingId || "",
          groupCode: tx.groupCode || "",
          flow: "operating",
          note: tx.note || `Thu tiền khách ${tx.voucherCode || ""}`,
          lines: [
            { accountCode: cashAcct, debit: amt },
            { accountCode: crAcct, credit: amt }
          ]
        });
      } else if (tx.txType === "customer_refund") {
        const receipt = folios.receipts.get(tx.id);
        if (!receipt) { unresolvedLegacy.push({id:tx.id,reason:"Hoàn tiền chưa gắn người trả."}); continue; }
        const drAcct = receipt.deposit !== 0 ? map.customerDeposit : arFor(receipt.who.role);
        pushIfNew({
          voucherNo: tx.voucherCode || `GL-HT-${tx.id.slice(-5).toUpperCase()}`,
          postingDate: dt,
          businessDate: dt,
          sourceType: "pms_customer_refund",
          sourceEventId: tx.id,
          eventType: "refund_customer",
          department: "rooms",
          partnerName: receipt.who.name,
          bookingId: tx.bookingId || "",
          groupCode: tx.groupCode || "",
          flow: "operating",
          note: tx.reason || tx.note || `Hoàn tiền khách ${tx.voucherCode || ""}`,
          lines: [
            { accountCode: drAcct, debit: amt },
            { accountCode: cashAcct, credit: amt }
          ]
        });
      } else if (tx.txType === "supplier_payment") {
        pushIfNew({
          voucherNo: tx.voucherCode || `GL-PC-${tx.id.slice(-5).toUpperCase()}`,
          postingDate: dt,
          businessDate: dt,
          sourceType: "pms_supplier_payment",
          sourceEventId: tx.id,
          eventType: "pay_ap",
          department: "admin",
          partnerName: tx.supplierName || "",
          invoiceId: tx.invoiceId || tx.supplierInvoiceId || "",
          flow: "operating",
          note: tx.note || `Thanh toán NCC ${tx.supplierName || ""}`,
          lines: [
            { accountCode: map.apSupplier, debit: amt },
            { accountCode: cashAcct, credit: amt }
          ]
        });
      } else if (tx.txType === "fund_transfer") {
        const fromAcct = tx.fromFundId === "bank_main" ? map.bankMain : map.cashFrontdesk;
        const toAcct = tx.toFundId === "bank_main" ? map.bankMain : map.cashFrontdesk;
        if (fromAcct !== toAcct) {
          pushIfNew({
            voucherNo: tx.voucherCode || `GL-CQ-${tx.id.slice(-5).toUpperCase()}`,
            postingDate: dt,
            businessDate: dt,
            sourceType: "pms_fund_transfer",
            sourceEventId: tx.id,
            eventType: "internal_transfer",
            department: "finance",
            note: tx.reason || tx.note || "Chuyển quỹ nội bộ (không ảnh hưởng tổng dòng tiền)",
            lines: [
              { accountCode: toAcct, debit: amt },
              { accountCode: fromAcct, credit: amt }
            ]
          });
        }
      } else if (tx.txType === "balance_adjustment") {
        const absAmt = Math.abs(amt);
        const lines = amt > 0
          ? [{ accountCode: cashAcct, debit: absAmt }, { accountCode: map.retainedCancelDeposit, credit: absAmt }]
          : [{ accountCode: map.cashDiscrepancy, debit: absAmt }, { accountCode: cashAcct, credit: absAmt }];
        pushIfNew({
          voucherNo: tx.voucherCode || `GL-ADJ-${tx.id.slice(-5).toUpperCase()}`,
          postingDate: dt,
          businessDate: dt,
          sourceType: "pms_balance_adjustment",
          sourceEventId: tx.id,
          eventType: "cash_adjustment",
          department: "finance",
          flow: "operating",
          note: tx.reason || tx.note || "Điều chỉnh chênh lệch quỹ đã duyệt",
          lines
        });
      }
    }

    for (const sheet of folios.sheets.values()) {
      // Recognize a room share at the same checkout/month-end date as its GL revenue.
      const events = new Map();
      for (const r of sheet.rows) {
        if (!r.charge && !r.deposit) continue;
        const monthEnd = r.type==="room" ? period(r.date.slice(0,7),"month").to : r.date;
        const date = r.type==="room" && r.b.checkout<monthEnd ? r.b.checkout : monthEnd;
        if (date>p.to || date>asOf) continue;
        if (!events.has(date)) events.set(date,[]);
        events.get(date).push(r);
      }
      const state = new Map();
      for (const date of [...events.keys()].sort()) {
        const deltas=new Map();
        for (const r of events.get(date)) {
          const bal=state.get(r.who.id) || {charges:0,deposits:0,applied:0};
          bal.charges+=r.charge; bal.deposits+=r.deposit;
          const applied=Math.min(Math.max(0,bal.charges),Math.max(0,bal.deposits));
          deltas.set(r.who.id,{who:r.who,amount:(deltas.get(r.who.id)?.amount || 0)+applied-bal.applied});
          bal.applied=applied;state.set(r.who.id,bal);
        }
        if (date<p.from) continue;
        const lines=[];
        for(const {who,amount} of deltas.values()) {
          if(!amount) continue;
          lines.push({accountCode:map.customerDeposit,partner:who.name,debit:Math.max(amount,0),credit:Math.max(-amount,0)},
            {accountCode:arFor(who.role),partner:who.name,credit:Math.max(amount,0),debit:Math.max(-amount,0)});
        }
        if(lines.length) pushIfNew({sourceType:"pms_deposit_apply",sourceEventId:sheet.entity.entityKey+":"+date,eventType:"apply_deposit",
          postingDate:date,businessDate:date,bookingId:sheet.entity.bookingId,groupCode:sheet.entity.groupCode,
          voucherNo:"CC-"+sheet.entity.bookingId+"-"+date,note:"Cấn cọc theo người trả",lines});
      }
    }
    // Reclassify voided source vouchers only when the void itself is present in the ledger.
    const voidTx = new Set(txs.filter(t=>t?.status==="voided").map(t=>t.id));
    const voidInvoice = new Set(invoices.filter(t=>t?.status==="voided").map(t=>t.id));
    for(const [key,prior] of history) {
      const e=prior[0];
      if(targetKeys.has(key) || e.postingDate<p.from || e.postingDate>p.to) continue;
      const isVoided=e.sourceType==="pms_supplier_invoice" ? voidInvoice.has(e.sourceEventId) :
        ["pms_supplier_payment","pms_customer_payment","pms_customer_refund","pms_fund_transfer","pms_balance_adjustment"].includes(e.sourceType) && voidTx.has(e.sourceEventId);
      if(isVoided) pushIfNew({...e,id:undefined,createdAt:undefined,lines:[]});
    }
    // Only clear missing charges when the corresponding source booking still exists.
    for (const [key, prior] of history) {
      const e=prior[0];
      if (targetKeys.has(key) || e.postingDate<p.from || e.postingDate>p.to || !bkById.has(e.bookingId)) continue;
      if (!["pms_booking_revenue","pms_booking_service","pms_booking_adjustment","pms_deposit_apply","pms_cancel_retain"].includes(e.sourceType)) continue;
      const b=bkById.get(e.bookingId);
      const row = e.sourceType==="pms_booking_service" ? (b.services||[]).find(x=>b.id+":"+x.id===e.sourceEventId) :
        e.sourceType==="pms_booking_adjustment" ? (b.adjustments||[]).find(x=>b.id+":"+x.id===e.sourceEventId) : null;
      if(row && row.status!=="cancelled" && !C.isBookingCancelled(b) && (row.serviceDate || row.dateISO || row.effectiveDate || b.checkin).slice(0,7)!==e.periodKey) {
        unresolvedLegacy.push({id:key,reason:"Ngày chứng từ đã chuyển kỳ, cần kế toán kiểm tra."});
        continue;
      }
      pushIfNew({...e,id:undefined,createdAt:undefined,lines:[]});
    }
    const controls = root.PMSControlAudit || (typeof require==="function" && require("./control-audit.js"));
    for(const row of fin.controlsV23 || []) {
      if(!controls.stockKind(row) || controls.opening(row) || !row.value || row.day<p.from || row.day>p.to)continue;
      const isIntake=(row.kind==="reverse"?row.sourceKind:row.kind)==="receipt";
      const directCost=["ci_room_amenities","ci_minibar_free","ci_breakfast","ci_laundry"].includes(row.costItemId);
      const fallback=row.costItemId==="ci_booking_fee"?map.otaCommission:!isIntake && directCost?"6321":"6421";
      const expense=map.costItemAccounts?.[row.costItemId] || fallback;
      const stock=map.inventoryAccount || "1521";
      pushIfNew({sourceType:"pms_stock_move",sourceEventId:String(row.seq),eventType:"stock_movement",
        postingDate:row.day,businessDate:row.day,voucherNo:row.ref,
        department:"operations",note:row.sku+" · "+row.ref,
        lines:[{accountCode:stock,debit:Math.max(0,row.value),credit:Math.max(0,-row.value)},
               {accountCode:expense,credit:Math.max(0,row.value),debit:Math.max(0,-row.value)}]});
    }
    return { entries, unresolvedLegacy, reconciledExternalLinks, sourceMode };
  }

  // ===================== MỐC 5: TRIAL BALANCE & FULL GL STATEMENTS =====================
  function computeTrialBalance(glState, p, opts = {}) {
    const st = sanitizeEnterpriseGlState(glState);
    const entityId = opts.entityId || st.activeEntityId;
    const includeEliminations = opts.consolidated === true;
    const lookup = buildAccountLookup(st);
    const acctMap = new Map();

    const ensureAcct = (code, groupKey, name) => {
      if (!acctMap.has(code)) {
        acctMap.set(code, {
          accountCode: code,
          groupKey,
          accountName: name || groups[groupKey] || code,
          openingNet: 0,
          periodDebit: 0,
          periodCredit: 0,
          endingNet: 0
        });
      }
      return acctMap.get(code);
    };

    for (const acc of st.accounts) ensureAcct(acc.code, acc.groupKey, acc.name);

    // 1. Apply explicit opening balance vouchers on or before p.from (use latest opening per entity if multiple)
    const obList = st.openingBalances
      .filter((o) => (!opts.consolidated ? o.entityId === entityId : true) && isValidDate(o.asOfDate) && o.asOfDate <= p.from)
      .sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
    const latestObByEntity = new Map();
    for (const o of obList) latestObByEntity.set(o.entityId || entityId, o);

    const obCutoffByEntity = new Map();
    for (const [eid, ob] of latestObByEntity.entries()) {
      obCutoffByEntity.set(eid, ob.asOfDate);
      for (const ln of (Array.isArray(ob.lines) ? ob.lines : [])) {
        const res = resolveAccount(ln, lookup);
        if (!res) continue;
        const row = ensureAcct(res.accountCode, res.groupKey, res.accountName);
        row.openingNet = add(row.openingNet, toSafeInt(ln.amount !== undefined ? ln.amount : (toSafeInt(ln.debit) - toSafeInt(ln.credit))));
      }
    }

    // 2. Roll forward prior-period posted entries (after opening balance date and < p.from) into openingNet
    const inPeriodEntries = [];
    for (const e of st.entries) {
      if (!e || !Array.isArray(e.lines)) continue;
      if (!opts.consolidated && e.entityId !== entityId) continue;
      if (!includeEliminations && e.isElimination) continue;
      if (!isValidDate(e.postingDate) || e.postingDate > p.to) continue;

      const cutoff = obCutoffByEntity.get(e.entityId || entityId) || "";
      if (e.postingDate < p.from) {
        if (cutoff && e.postingDate <= cutoff) continue;
        for (const ln of e.lines) {
          const res = resolveAccount(ln, lookup);
          if (!res) continue;
          const row = ensureAcct(res.accountCode, res.groupKey, res.accountName);
          const net = toSafeInt(ln.debit) - toSafeInt(ln.credit);
          if (balanceSheetKeys.includes(res.groupKey)) {
            row.openingNet = add(row.openingNet, net);
          } else {
            // Prior-period income/expense rolls into retained earnings (4211)
            const retAcc = lookup.firstByGroup.get("retained");
            const retRow = ensureAcct(retAcc ? retAcc.code : "4211", "retained", retAcc ? retAcc.name : groups.retained);
            retRow.openingNet = add(retRow.openingNet, net);
          }
        }
      } else {
        inPeriodEntries.push(e);
        for (const ln of e.lines) {
          const res = resolveAccount(ln, lookup);
          if (!res) continue;
          const row = ensureAcct(res.accountCode, res.groupKey, res.accountName);
          row.periodDebit = add(row.periodDebit, toSafeInt(ln.debit));
          row.periodCredit = add(row.periodCredit, toSafeInt(ln.credit));
        }
      }
    }

    const rows = [];
    let totalOpeningDr = 0, totalOpeningCr = 0, totalPeriodDr = 0, totalPeriodCr = 0, totalEndingDr = 0, totalEndingCr = 0;
    for (const r of acctMap.values()) {
      r.endingNet = add(r.openingNet, r.periodDebit - r.periodCredit);
      const openDr = r.openingNet > 0 ? r.openingNet : 0;
      const openCr = r.openingNet < 0 ? -r.openingNet : 0;
      const endDr = r.endingNet > 0 ? r.endingNet : 0;
      const endCr = r.endingNet < 0 ? -r.endingNet : 0;
      totalOpeningDr = add(totalOpeningDr, openDr);
      totalOpeningCr = add(totalOpeningCr, openCr);
      totalPeriodDr = add(totalPeriodDr, r.periodDebit);
      totalPeriodCr = add(totalPeriodCr, r.periodCredit);
      totalEndingDr = add(totalEndingDr, endDr);
      totalEndingCr = add(totalEndingCr, endCr);
      if (openDr || openCr || r.periodDebit || r.periodCredit || endDr || endCr) {
        rows.push({
          ...r,
          openingDebit: openDr,
          openingCredit: openCr,
          endingDebit: endDr,
          endingCredit: endCr
        });
      }
    }
    rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    return {
      period: p,
      rows,
      inPeriodEntries,
      totals: {
        openingDebit: totalOpeningDr,
        openingCredit: totalOpeningCr,
        periodDebit: totalPeriodDr,
        periodCredit: totalPeriodCr,
        endingDebit: totalEndingDr,
        endingCredit: totalEndingCr
      },
      openingBalanced: totalOpeningDr === totalOpeningCr,
      periodBalanced: totalPeriodDr === totalPeriodCr,
      endingBalanced: totalEndingDr === totalEndingCr,
      balanced: totalOpeningDr === totalOpeningCr && totalPeriodDr === totalPeriodCr && totalEndingDr === totalEndingCr
    };
  }

  function computeGlStatements(glState, p, opts = {}) {
    const st = sanitizeEnterpriseGlState(glState);
    const tb = computeTrialBalance(st, p, opts);
    const opening = Object.fromEntries(balanceSheetKeys.map((k) => [k, 0]));
    const ending = Object.fromEntries([...balanceSheetKeys, ...performance].map((k) => [k, 0]));
    const drilldownByGroup = Object.fromEntries(Object.keys(groups).map((k) => [k, []]));

    for (const r of tb.rows) {
      if (Object.hasOwn(opening, r.groupKey)) opening[r.groupKey] = add(opening[r.groupKey], r.openingNet);
      if (Object.hasOwn(ending, r.groupKey)) ending[r.groupKey] = add(ending[r.groupKey], r.endingNet);
    }

    const cashflow = Object.fromEntries(Object.keys(flows).map((k) => [k, 0]));
    const cashIn = { ...cashflow };
    const cashOut = { ...cashflow };
    const vouchers = [];

    for (const e of tb.inPeriodEntries) {
      let debit = 0, cashMove = 0;
      for (const ln of e.lines) {
        const dr = toSafeInt(ln.debit), cr = toSafeInt(ln.credit);
        debit = add(debit, dr);
        if (ln.groupKey === "cash") cashMove = add(cashMove, dr - cr);
        if (ln.groupKey && Object.hasOwn(drilldownByGroup, ln.groupKey)) {
          drilldownByGroup[ln.groupKey].push({
            entryId: e.id,
            voucherNo: e.voucherNo,
            postingDate: e.postingDate,
            accountCode: ln.accountCode,
            accountName: ln.accountName || groups[ln.groupKey] || ln.accountCode,
            sourceType: e.sourceType,
            sourceEventId: e.sourceEventId || "",
            partnerName: ln.partner || e.partnerName || "",
            bookingId: e.bookingId || "",
            invoiceId: e.invoiceId || "",
            status: e.status,
            debit: dr,
            credit: cr,
            netAmount: dr - cr,
            memo: ln.memo || e.note || "",
            note: e.note || ""
          });
        }
      }
      if (cashMove !== 0) {
        if (Array.isArray(e.flowAllocations) && e.flowAllocations.length > 0) {
          for (const al of e.flowAllocations) {
            if (!Object.hasOwn(flows, al.flow)) continue;
            const amt = toSafeInt(al.amount);
            cashflow[al.flow] = add(cashflow[al.flow], amt);
            if (amt > 0) cashIn[al.flow] = add(cashIn[al.flow], amt);
            else cashOut[al.flow] = add(cashOut[al.flow], -amt);
          }
        } else {
          const fl = Object.hasOwn(flows, e.flow) ? e.flow : "operating";
          cashflow[fl] = add(cashflow[fl], cashMove);
          if (cashMove > 0) cashIn[fl] = add(cashIn[fl], cashMove);
          else cashOut[fl] = add(cashOut[fl], -cashMove);
        }
      }
      vouchers.push([e.postingDate, e.voucherNo, debit, cashMove, flows[e.flow] || (e.flowAllocations ? "Phân bổ nhiều hoạt động" : "Nội bộ / Phi tiền mặt")]);
    }

    const sum = (keys, book = ending) => total(keys.map((k) => book[k]));
    const revenue = 0 - sum(["room", "dorm", "service", "salesOther", "discounts"]);
    const gross = add(revenue, -ending.cogs);
    const beforeTax = -sum(performance.filter((k) => k !== "incomeTax"));
    const net = add(beforeTax, -ending.incomeTax);
    const assetsEnd = sum(assets);
    const liabilitiesEnd = -sum(liabilities);
    const equityEnd = add(-sum(equity), net);
    const balanceDiff = assetsEnd - add(liabilitiesEnd, equityEnd);
    const balanceSheetBalanced = balanceDiff === 0;
    const netCashChange = total(Object.values(cashflow));
    const cashFlowBalanced = add(opening.cash, netCashChange) === ending.cash;

    const cmpOpt = opts.compareMode || opts.compare || "none";
    let comparison = null;
    if (cmpOpt === "yoy" || cmpOpt === "prev_period") {
      const prevP = previousPeriod(p, cmpOpt);
      if (prevP) {
        const cmpRes = computeGlStatements(st, prevP, { ...opts, compareMode: "none", compare: "none" });
        comparison = {
          ...cmpRes,
          mode: cmpOpt,
          label: cmpOpt === "yoy" ? "Cùng kỳ năm trước" : "Kỳ trước"
        };
      }
    }

    const entity = st.entities.find((e) => e.id === (opts.entityId || st.activeEntityId)) || st.entities[0];
    const pRec = st.periods[periodStateKey(entity.id, p.months[0])] || { status: "draft", version: 0 };

    const isLines = Object.fromEntries(performance.map((k) => [k, -ending[k]]));
    const openingByGroup = {};
    const endingByGroup = {};
    for (const k of assets) { openingByGroup[k] = opening[k]; endingByGroup[k] = ending[k]; }
    for (const k of liabilities) { openingByGroup[k] = -opening[k]; endingByGroup[k] = -ending[k]; }
    for (const k of equity) { openingByGroup[k] = -opening[k]; endingByGroup[k] = -ending[k]; }

    const incomeStatement = {
      lines: isLines,
      netRevenue: revenue,
      grossProfit: gross,
      ebt: beforeTax,
      netProfit: net
    };
    const balanceSheet = {
      openingByGroup,
      endingByGroup,
      totalAssets: assetsEnd,
      totalLiabilities: liabilitiesEnd,
      totalEquity: equityEnd,
      balanced: balanceSheetBalanced,
      balanceDiff
    };
    const cashFlow = {
      openingCash: opening.cash,
      cashIn,
      cashOut,
      cashflow,
      netCashChange,
      endingCash: ending.cash,
      balanced: cashFlowBalanced
    };
    const equityRows = equity.map((k) => ({
      key: k,
      label: groups[k],
      opening: -opening[k],
      change: opening[k] - ending[k],
      ending: -ending[k]
    }));
    const equityStatement = {
      rows: equityRows,
      netProfit: net,
      openingTotal: -sum(equity, opening),
      endingTotal: equityEnd
    };

    return {
      entity,
      period: p,
      periodState: pRec,
      trialBalance: tb,
      opening,
      ending,
      cashIn,
      cashOut,
      cashflow,
      vouchers,
      drilldownByGroup,
      revenue,
      gross,
      beforeTax,
      net,
      assetsEnd,
      liabilitiesEnd,
      equityEnd,
      balanceSheetBalanced,
      cashFlowBalanced,
      incomeStatement,
      balanceSheet,
      cashFlow,
      equityStatement,
      comparison,
      notes: st.notes
    };
  }

  // ===================== MỐC 5: CROSS-SUBLEDGER RECONCILIATION =====================
  function computeSubledgerReconciliation(glState, pmsSnapshot, p, opts = {}) {
    const st = sanitizeEnterpriseGlState(glState);
    const glStmt = computeGlStatements(st, p, opts);
    const flagList = [];
    const unresolvedLegacy = [];
    const unreconciledFunds = [];
    const unreconciledShiftDiffs = [];
    const duplicateVouchers = [];
    const crossPeriodEntries = [];

    if (!glStmt.trialBalance.balanced) {
      flagList.push({ severity: "error", code: "TRIAL_BALANCE_UNBALANCED", message: "Bảng cân đối phát sinh lệch tổng Nợ và tổng Có." });
    }
    if (!glStmt.balanceSheetBalanced) {
      flagList.push({ severity: "error", code: "BALANCE_SHEET_UNBALANCED", message: "Bảng cân đối kế toán lệch: Tài sản ≠ Nợ phải trả + Vốn chủ sở hữu." });
    }
    if (!glStmt.cashFlowBalanced) {
      flagList.push({ severity: "error", code: "CASHFLOW_UNBALANCED", message: "Lưu chuyển tiền tệ không khớp số dư tiền cuối kỳ." });
    }

    const glCash = glStmt.ending.cash;
    const glAr = glStmt.ending.ar;
    const glAp = -glStmt.ending.ap;
    let pmsCash = 0, pmsAr = 0, pmsAp = 0;
    const subledgerChecks = [];

    if (pmsSnapshot && Array.isArray(pmsSnapshot.bookings) && pmsSnapshot.financeState) {
      const ar = C.computeReceivablesReport(pmsSnapshot.bookings, pmsSnapshot.financeState, { asOfDate: p.to });
      const ap = C.computeSupplierPayablesReport(pmsSnapshot.financeState, pmsSnapshot.operatingCosts || null, { asOfDate: p.to });
      const cash = C.computeCashbookReport(pmsSnapshot.financeState, pmsSnapshot.bookings, { toDate: p.to });

      pmsCash = toSafeInt(cash.totalHotelCashHeld);
      pmsAr = toSafeInt(ar.totalRemaining);
      pmsAp = toSafeInt(ap.totalRemaining);

      subledgerChecks.push(
        { key: "cash", label: "Quỹ tiền mặt & ngân hàng (GL vs Sổ quỹ PMS)", glAmount: glCash, subledgerAmount: pmsCash, diff: glCash - pmsCash },
        { key: "ar", label: "Công nợ phải thu khách (GL vs Sổ công nợ AR)", glAmount: glAr, subledgerAmount: pmsAr, diff: glAr - pmsAr },
        { key: "ap", label: "Công nợ phải trả NCC (GL vs Sổ công nợ AP)", glAmount: glAp, subledgerAmount: pmsAp, diff: glAp - pmsAp }
      );
      for (const sc of subledgerChecks) {
        if (sc.diff !== 0) {
          flagList.push({ severity: "warn", code: `SUBLEDGER_DIFF_${sc.key.toUpperCase()}`, message: `${sc.label} chênh lệch ${sc.diff} đ.` });
        }
      }

      for (const f of (cash.activeFunds || [])) {
        if (f.reconciliationStatus === "unreconciled") {
          unreconciledFunds.push(f.name || f.id);
          flagList.push({ severity: "warn", code: "FUND_UNRECONCILED", message: `Quỹ "${f.name || f.id}" chưa có mốc đối chiếu sao kê/kiểm đếm.` });
        } else if (f.latestCheck?.asOfDate < p.to) {
          flagList.push({severity:"warn",code:"FUND_COUNT_OLDER",message:`Quỹ "${f.label || f.id}" kiểm gần nhất ngày ${f.latestCheck.asOfDate}, trước ngày báo cáo.`});
        } else if (toSafeInt(f.liveDiscrepancy) !== 0) {
          flagList.push({ severity: "warn", code: "FUND_COUNT_DIFF", message: `Quỹ "${f.name || f.id}" có chênh lệch kiểm kê ${f.liveDiscrepancy} đ.` });
        }
      }
      for (const sh of (pmsSnapshot.financeState.cashShifts || [])) {
        if (sh && toSafeInt(sh.discrepancy) !== 0 && sh.discrepancyStatus !== "resolved") {
          unreconciledShiftDiffs.push({ shiftCode: sh.shiftCode, discrepancy: toSafeInt(sh.discrepancy) });
          flagList.push({ severity: "warn", code: "SHIFT_DIFF_UNRESOLVED", message: `Ca ${sh.shiftCode} có chênh lệch ${sh.discrepancy} đ chưa xử lý.` });
        }
      }
      for (const t of (pmsSnapshot.financeState.transactions || [])) {
        if (t && t.txType === "legacy_payment" && t.legacyStatus !== "reconciled" && t.legacyStatus !== "reconciled_in_opening") {
          unresolvedLegacy.push({ id: t.id, voucherCode: t.voucherCode || t.id, amount: toSafeInt(t.amount) });
        }
      }
      if (unresolvedLegacy.length > 0) {
        flagList.push({ severity: "warn", code: "LEGACY_UNASSIGNED", message: `Còn ${unresolvedLegacy.length} chứng từ chuyển tiếp chưa gán quỹ/ngày.` });
      }
    }

    const seenNos = new Map();
    for (const e of glStmt.trialBalance.inPeriodEntries) {
      if (seenNos.has(e.voucherNo)) {
        duplicateVouchers.push(e.voucherNo);
        flagList.push({ severity: "warn", code: "DUPLICATE_VOUCHER_NO", message: `Trùng số chứng từ ${e.voucherNo} trong kỳ.` });
      }
      seenNos.set(e.voucherNo, e.id);
      if (e.businessDate && (e.businessDate < p.from || e.businessDate > p.to)) {
        crossPeriodEntries.push({ voucherNo: e.voucherNo, businessDate: e.businessDate, postingDate: e.postingDate });
        flagList.push({ severity: "info", code: "CROSS_PERIOD_ENTRY", message: `Chứng từ ${e.voucherNo} có ngày nghiệp vụ (${e.businessDate}) khác kỳ hạch toán (${e.postingDate}).` });
      }
    }

    const hasBlockingErrors = flagList.some((f) => f.severity === "error");
    const hasIssues = hasBlockingErrors || flagList.some((f) => f.severity === "warn");
    return {
      period: p,
      trialBalance: glStmt.trialBalance,
      cash: { glBalance: glCash, pmsBalance: pmsCash, diff: glCash - pmsCash },
      ar: { glBalance: glAr, pmsBalance: pmsAr, diff: glAr - pmsAr },
      ap: { glBalance: glAp, pmsBalance: pmsAp, diff: glAp - pmsAp },
      subledgerChecks,
      flagList,
      flags: {
        unresolvedLegacy,
        unreconciledFunds,
        unreconciledShiftDiffs,
        duplicateVouchers,
        crossPeriodEntries
      },
      hasIssues,
      hasBlockingErrors,
      readyToLock: !hasBlockingErrors
    };
  }

  // ===================== MỐC 4: HOTEL MANAGEMENT ANALYTICS & 13-WEEK FORECAST =====================
  function computeHotelManagementAnalytics(pmsSnapshot, glState, p, opts = {}) {
    const bookings = Array.isArray(pmsSnapshot && pmsSnapshot.bookings) ? pmsSnapshot.bookings : [];
    const fin = (pmsSnapshot && pmsSnapshot.financeState) || (C ? C.createDefaultFinanceState() : { transactions: [], supplierInvoices: [] });
    const costs = (pmsSnapshot && pmsSnapshot.operatingCosts) || (C ? C.createDefaultOperatingCostsState() : null);
    const totalDays = Math.max(1, daysInRange(p.from, p.to));
    const regularRoomsCount = 26;
    const dormBedsCount = 8;
    const availableRoomNights = regularRoomsCount * totalDays;
    const availableDormBedNights = dormBedsCount * totalDays;

    let roomNightsSold = 0, dormBedNightsSold = 0;
    let roomRevenue = 0, dormRevenue = 0, serviceRevenue = 0, discountTotal = 0;
    const byChannel = new Map(), byTour = new Map();
    const bump = (map, key, label, rev, nights) => {
      if (!map.has(key)) map.set(key, { key, label, revenue: 0, nights: 0, bookingCount: 0, bookings: 0 });
      const r = map.get(key);
      r.revenue = add(r.revenue, rev);
      r.nights += nights;
      r.bookingCount += 1;
      r.bookings += 1;
    };

    for (const bk of bookings) {
      if (!bk || (C && C.isBookingCancelled(bk))) continue;
      let bkNights = 0, bkRev = 0;
      for (const mKey of p.months) {
        const mP = period(mKey, "month");
        const effStart = bk.checkin > mP.from ? bk.checkin : mP.from;
        const mEndNext = addDaysISO(mP.to, 1);
        const effEnd = bk.checkout < mEndNext ? bk.checkout : mEndNext;
        const nInMonth = effEnd > effStart ? Math.max(0, Math.round((Date.parse(effEnd + "T00:00:00Z") - Date.parse(effStart + "T00:00:00Z")) / 86400000)) : 0;
        if (nInMonth > 0) {
          const pr = C.computeMonthlyProratedRevenue([bk], mKey);
          if (bk.roomId === "DORM") {
            const slots = Array.isArray(bk.slots) && bk.slots.length > 0 ? bk.slots.length : Math.max(1, Number(bk.dormBeds) || 1);
            dormBedNightsSold += nInMonth * slots;
            dormRevenue = add(dormRevenue, pr.proratedDormRevenue);
            bkRev = add(bkRev, pr.proratedDormRevenue);
          } else {
            roomNightsSold += nInMonth;
            roomRevenue = add(roomRevenue, pr.proratedRoomRevenue);
            bkRev = add(bkRev, pr.proratedRoomRevenue);
          }
          bkNights += nInMonth;
        }
      }
      for (const sv of (Array.isArray(bk.services) ? bk.services : [])) {
        if (!sv || sv.status === "cancelled") continue;
        const sd = sv.serviceDate || sv.dateISO || bk.checkin;
        if (sd >= p.from && sd <= p.to) serviceRevenue = add(serviceRevenue, toSafeInt(sv.amount));
      }
      for (const adj of (Array.isArray(bk.adjustments) ? bk.adjustments : [])) {
        if (!adj || adj.status === "cancelled") continue;
        const ed = adj.effectiveDate || bk.checkin;
        if (ed >= p.from && ed <= p.to && toSafeInt(adj.amount) < 0) discountTotal = add(discountTotal, Math.abs(toSafeInt(adj.amount)));
      }
      if (bkNights > 0) {
        const ch = bk.channelKey || "direct";
        const chMeta = C && C.CHANNELS && C.CHANNELS[ch];
        bump(byChannel, ch, bk.sourceName || (chMeta && chMeta.label) || ch, bkRev, bkNights);
        if (bk.tourName) bump(byTour, bk.tourName, bk.tourName, bkRev, bkNights);
      }
    }

    const totalChannelRev = add(roomRevenue, dormRevenue);
    const channelList = [...byChannel.values()]
      .map((c) => ({ ...c, sharePct: totalChannelRev > 0 ? Number(((c.revenue / totalChannelRev) * 100).toFixed(1)) : 0 }))
      .sort((a, b) => b.revenue - a.revenue);

    const occRate = availableRoomNights > 0 ? Number(((roomNightsSold / availableRoomNights) * 100).toFixed(2)) : 0;
    const dormOccRate = availableDormBedNights > 0 ? Number(((dormBedNightsSold / availableDormBedNights) * 100).toFixed(2)) : 0;
    const adr = roomNightsSold > 0 ? Math.round(roomRevenue / roomNightsSold) : 0;
    const revpar = availableRoomNights > 0 ? Math.round(roomRevenue / availableRoomNights) : 0;
    const dormAdrBed = dormBedNightsSold > 0 ? Math.round(dormRevenue / dormBedNightsSold) : 0;

    const monthCostReports = costs ? p.months.map((m) => C.computeMonthlyOperatingCosts(costs, bookings, m, fin)) : [];
    const totalCostUsed = total(monthCostReports.map((m) => toSafeInt(m.totalMonthlyCost)));
    const missingBasisCount = monthCostReports.reduce((s, m) => s + (m.missingBasisCount || 0), 0);
    const costPerRoomNight = roomNightsSold > 0 && missingBasisCount === 0 ? Math.round(totalCostUsed / roomNightsSold) : null;

    // AR & AP Aging buckets as of p.to (both structured array & bucket map)
    const arRep = C.computeReceivablesReport(bookings, fin, { asOfDate: p.to });
    const apRep = C.computeSupplierPayablesReport(fin, costs, { asOfDate: p.to });
    const makeAgingObj = () => ({
      current: { key: "current", label: "Trong hạn", count: 0, amount: 0 },
      d1_7: { key: "d1_7", label: "Quá hạn 1–7 ngày", count: 0, amount: 0 },
      d8_30: { key: "d8_30", label: "Quá hạn 8–30 ngày", count: 0, amount: 0 },
      d31_60: { key: "d31_60", label: "Quá hạn 31–60 ngày", count: 0, amount: 0 },
      over60: { key: "over60", label: "Quá hạn >60 ngày", count: 0, amount: 0 },
      noDueDate: { key: "noDueDate", label: "Chưa xác định hạn", count: 0, amount: 0 }
    });
    const arBuckets = makeAgingObj();
    const apBuckets = makeAgingObj();
    const bucketize = (buckets, rem, due) => {
      if (rem <= 0) return;
      let b;
      if (!due || !isValidDate(due)) b = buckets.noDueDate;
      else {
        const diff = daysInRange(due, p.to) - 1;
        if (diff <= 0) b = buckets.current;
        else if (diff <= 7) b = buckets.d1_7;
        else if (diff <= 30) b = buckets.d8_30;
        else if (diff <= 60) b = buckets.d31_60;
        else b = buckets.over60;
      }
      b.count += 1;
      b.amount = add(b.amount, rem);
    };
    for (const r of (arRep.rows || [])) bucketize(arBuckets, toSafeInt(r.remaining), r.effectiveDueDate);
    for (const inv of (apRep.rows || [])) bucketize(apBuckets, toSafeInt(inv.remaining), inv.dueDate);

    // Group breakdown from authoritative finance entities
    const groupList = (arRep.rows || [])
      .filter((r) => r.entityType === "group" || (r.groupCode && r.groupCode.trim()))
      .map((r) => ({
        groupCode: r.groupCodeDisplay || r.groupCode || "",
        name: r.guestName || r.label || "",
        roomCount: r.roomCount || 1,
        totalPayable: toSafeInt(r.totalPayable),
        netPaid: toSafeInt(r.netPaid),
        remaining: toSafeInt(r.remaining)
      }));

    // Budget vs Actual (from glState.budgets[month])
    const st = sanitizeEnterpriseGlState(glState);
    let budgetRevenue = 0, budgetExpense = 0;
    for (const mKey of p.months) {
      const bm = st.budgets && st.budgets[mKey];
      if (bm) {
        budgetRevenue = add(budgetRevenue, toSafeInt(bm.revenue || bm.room));
        budgetExpense = add(budgetExpense, toSafeInt(bm.expense || bm.operating || bm.cogs));
      }
    }
    const actualRevenue = add(add(roomRevenue, dormRevenue), add(serviceRevenue, -discountTotal));
    const actualExpense = missingBasisCount === 0 ? totalCostUsed : null;

    // 13-Week Cash Flow Forecast starting from p.to (with explicit assumptions & updatedAt)
    const cashRep = C.computeCashbookReport(fin, bookings, { toDate: p.to });
    let rollingCash = toSafeInt(cashRep.totalHotelCashHeld);
    const forecastStart = opts.forecastStartDate && isValidDate(opts.forecastStartDate) ? opts.forecastStartDate : p.to;
    const weeks = [];
    for (let w = 0; w < 13; w++) {
      const wStart = addDaysISO(forecastStart, w * 7);
      const wEnd = addDaysISO(wStart, 6);
      let inflow = 0, outflow = 0;
      for (const r of (arRep.rows || [])) {
        if (toSafeInt(r.remaining) <= 0) continue;
        const dt = r.effectiveDueDate || r.maxCheckout || r.minCheckin;
        if (dt && dt >= wStart && dt <= wEnd) inflow = add(inflow, toSafeInt(r.remaining));
      }
      for (const inv of (apRep.rows || [])) {
        if (toSafeInt(inv.remaining) <= 0) continue;
        const dt = inv.dueDate || inv.invoiceDate;
        if (dt && dt >= wStart && dt <= wEnd) outflow = add(outflow, toSafeInt(inv.remaining));
      }
      const netFlow = inflow - outflow;
      rollingCash = add(rollingCash, netFlow);
      weeks.push({ week: w + 1, weekLabel: `Tuần ${w + 1}`, from: wStart, to: wEnd, inflow, outflow, netFlow, expectedIn: inflow, expectedOut: outflow, netCash: netFlow, endingCash: rollingCash });
    }

    return {
      period: p,
      rooms: {
        totalRooms: regularRoomsCount,
        totalDays,
        availableRoomNights,
        soldRoomNights: roomNightsSold,
        occupancyPct: occRate,
        revenue: roomRevenue,
        adr,
        revPar: revpar,
        formulas: {
          occupancy: "Đêm phòng bán / (26 phòng × Số ngày trong kỳ) — tách riêng 8 giường Dorm",
          adr: "Doanh thu phòng / Đêm phòng bán (chỉ 26 phòng khách)",
          revPar: "Doanh thu phòng / (26 phòng × Số ngày trong kỳ)"
        }
      },
      dorm: {
        totalBeds: dormBedsCount,
        availableBedNights: availableDormBedNights,
        soldBedNights: dormBedNightsSold,
        occupancyPct: dormOccRate,
        revenue: dormRevenue,
        adrBed: dormAdrBed,
        formulas: {
          occupancy: "Giường-đêm bán / (8 giường Dorm × Số ngày trong kỳ)"
        }
      },
      servicesRevenue: serviceRevenue,
      discountsTotal: discountTotal,
      costPerRoomNight,
      missingBasisCount,
      byChannel: channelList,
      byGroup: groupList,
      byTour: [...byTour.values()].sort((a, b) => b.revenue - a.revenue),
      arAging: Object.values(arBuckets),
      apAging: Object.values(apBuckets),
      arAgingMap: arBuckets,
      apAgingMap: apBuckets,
      unreconciledFunds: (cashRep.activeFunds || []).filter((f) => f.reconciliationStatus === "unreconciled"),
      budgetVsActual: {
        budgetRevenue,
        actualRevenue,
        revenueVariance: actualRevenue - budgetRevenue,
        budgetExpense,
        actualExpense,
        expenseVariance: actualExpense !== null ? actualExpense - budgetExpense : null
      },
      forecast13Weeks: {
        updatedAt: new Date().toISOString(),
        openingCash: toSafeInt(cashRep.totalHotelCashHeld),
        assumptions: [
          `Số dư đầu kỳ lấy từ tổng quỹ đã xác định tại ${p.to} (${toSafeInt(cashRep.totalHotelCashHeld)} VND)`,
          "Dòng tiền vào dự kiến theo hạn thanh toán / ngày trả phòng của các đơn hiện hữu còn công nợ",
          "Dòng tiền ra dự kiến theo hạn thanh toán của các hóa đơn nhà cung cấp chưa trả hết",
          "Chưa tính đơn đặt mới hoặc chi phí phát sinh mới sau thời điểm lập dự báo"
        ],
        weeks
      }
    };
  }

  // ===================== ZERO-DEPENDENCY REAL OPENXML (.XLSX) GENERATOR =====================
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function xmlEsc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function colLetters(idx0) {
    let n = idx0 + 1, s = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function buildSheetXml(rows) {
    const rowXml = rows.map((row, rIdx) => {
      const rNum = rIdx + 1;
      const cells = row.map((val, cIdx) => {
        const ref = `${colLetters(cIdx)}${rNum}`;
        if (val === null || val === undefined || val === "") return "";
        if (typeof val === "number" && Number.isFinite(val)) {
          return `<c r="${ref}" t="n"><v>${val}</v></c>`;
        }
        const raw = String(val);
        const safe = /^\s*[=+@-]/.test(raw) ? "'" + raw : raw;
        return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(safe)}</t></is></c>`;
      }).join("");
      return `<row r="${rNum}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  }

  function buildStoredZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const dataBytes = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32(dataBytes);

      const lh = new Uint8Array(30 + nameBytes.length);
      const lhv = new DataView(lh.buffer);
      lhv.setUint32(0, 0x04034b50, true);
      lhv.setUint16(4, 20, true);
      lhv.setUint16(6, 0x0800, true); // UTF-8 filename flag
      lhv.setUint16(8, 0, true); // STORE
      lhv.setUint32(14, crc, true);
      lhv.setUint32(18, dataBytes.length, true);
      lhv.setUint32(22, dataBytes.length, true);
      lhv.setUint16(26, nameBytes.length, true);
      lh.set(nameBytes, 30);
      parts.push(lh, dataBytes);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cd.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, dataBytes.length, true);
      cdv.setUint32(24, dataBytes.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += lh.length + dataBytes.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { parts.push(c); cdSize += c.length; }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    parts.push(eocd);

    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }

  function generateRealXlsxBytes(sheetsInput) {
    const sheets = (Array.isArray(sheetsInput) && sheetsInput.length > 0 ? sheetsInput : [{ name: "BaoCao", rows: [] }]).map((sh, idx) => ({
      name: cleanText(sh.name || `Sheet${idx + 1}`, 31).replace(/[\\/*?:[\]]/g, "_") || `Sheet${idx + 1}`,
      rows: Array.isArray(sh.rows) ? sh.rows : []
    }));

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
      + `</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
      + `</Relationships>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
      + sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
      + `</sheets></workbook>`;

    const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
      + `</Relationships>`;

    const files = [
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: rootRels },
      { name: "xl/workbook.xml", data: workbookXml },
      { name: "xl/_rels/workbook.xml.rels", data: wbRels },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: buildSheetXml(s.rows) }))
    ];
    return buildStoredZip(files);
  }

  function generateReportPdfHtml(sections, meta = {}) {
    const esc = (v) => xmlEsc(v);
    const fmt = new Intl.NumberFormat("vi-VN");
    const tablesHtml = (sections || []).map((sec) => {
      const head = `<tr>${(sec.headers || []).map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
      const body = (sec.rows || []).map((r) => `<tr>${r.map((v) => {
        const isNum = typeof v === "number";
        const txt = isNum ? fmt.format(v === 0 ? 0 : v) : (v == null ? "—" : String(v));
        return `<td${isNum ? ' class="num"' : ""}>${esc(txt)}</td>`;
      }).join("")}</tr>`).join("");
      return `<section><h3>${esc(sec.name)}</h3><table><thead>${head}</thead><tbody>${body}</tbody></table></section>`;
    }).join("");

    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(meta.title || "Báo cáo tài chính")}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: Arial, sans-serif; color: #1b241f; font-size: 11px; line-height: 1.4; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .meta { font-size: 10.5px; color: #4a554f; margin-bottom: 12px; border-bottom: 1px solid #cbd5cf; padding-bottom: 8px; }
  h3 { font-size: 12.5px; margin: 14px 0 6px; color: #164e36; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
  th, td { border: 1px solid #cfd8d3; padding: 4px 6px; text-align: left; }
  th { background: #f1f5f3; font-weight: 700; }
  td.num { text-align: right; white-space: nowrap; }
  .foot { margin-top: 16px; font-size: 10px; color: #55615b; border-top: 1px dashed #cbd5cf; padding-top: 8px; }
</style></head><body>
<h1>${esc(meta.title || "BÁO CÁO TÀI CHÍNH & QUẢN TRỊ")}</h1>
<div class="meta">
  <strong>Đơn vị:</strong> ${esc(meta.enterprise || "Dongvan Ville du H'mong Hotel")} •
  <strong>Kỳ:</strong> ${esc(meta.from || "")} – ${esc(meta.to || "")} •
  <strong>Phạm vi:</strong> ${esc(meta.scopeLabel || "")} •
  <strong>Trạng thái kỳ:</strong> ${esc(meta.lockLabel || "Bản nháp")} •
  <strong>Đơn vị tiền:</strong> VND •
  <strong>Xuất lúc:</strong> ${esc(meta.exportedAt || new Date().toISOString())}
</div>
${tablesHtml}
<div class="foot">Lưu ý: Báo cáo quản trị nội bộ Dongvan PMS (VND). Trước khi nộp làm báo cáo pháp định Việt Nam, kế toán trưởng cần xác nhận chế độ kế toán, niên độ, mẫu biểu và chữ ký pháp lý.</div>
</body></html>`;
  }

  const api = {
    groups,
    assets,
    liabilities,
    equity,
    balanceSheetKeys,
    performance,
    flows,
    PERIOD_STATUSES,
    EXTERNAL_SOURCE_TYPES,
    DEFAULT_CHART_OF_ACCOUNTS,
    DEFAULT_PMS_MAPPING,
    period,
    previousPeriod,
    ledgerTemplate,
    statements,
    hotel,
    createDefaultEnterpriseGlState,
    sanitizeEnterpriseGlState,
    validateJournalEntry,
    periodStateKey,
    isPeriodLocked,
    buildPmsAutoPostEntries,
    computeTrialBalance,
    computeGlStatements,
    computeSubledgerReconciliation,
    computeHotelManagementAnalytics,
    generateRealXlsxBytes,
    generateReportPdfHtml
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PMSEnterpriseReport = api;
})(typeof window === "undefined" ? globalThis : window);
