/* ==========================================================================
   Dongvan Ville du H'mong Hotel — PMS Core Domain Engine (pms-core.js)
   Dual-mode UMD module: works directly in browser (<script>) and Node.js tests.
   Enforces booking integrity, Dorm 8-slot constraints, payment invariants,
   optimistic concurrency locking, idempotency, CSV/XSS sanitization & rollback.
   ========================================================================== */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PMSCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "ks_manual_bookings_v1";
  const BACKUP_KEY = "ks_manual_bookings_rollback_v1";
  const AUTOBACKUP_KEY = "ks_manual_autobackups_v1";
  const AUDIT_KEY = "ks_manual_audit_v1";
  const META_KEY = "ks_manual_meta_v1";
  const QUARANTINE_KEY = "ks_manual_corrupt_quarantine_v1";
  const LOCK_KEY = "ks_manual_pms_lock_v1";
  const OPERATING_COSTS_KEY = "ks_pms_operating_costs_v1";
  const FINANCE_KEY = "ks_pms_finance_v1";
  const HOUSEKEEPING_KEY = "ks_pms_housekeeping_v1";
  const ISSUES_KEY = "ks_pms_issues_v1";
  const ACCOUNTS_KEY = "ks_pms_accounts_v1";
  const MAX_AUDIT_ENTRIES = 300;
  const MAX_AUTOBACKUPS = 30;
  const MAX_AMOUNT_VND = 10000000000; // 10 billion VND safety cap
  const MAX_NIGHTS = 365;
  const MAX_TX_RETRIES = 4;

  const ROOMS = Object.freeze([
    // Tầng 1: 2 Double view thung lũng (101, 107) + 3 Twins view núi (102, 104, 106) + 1 Dorm nội bộ (8 chỗ)
    { id: "101", name: "101", floor: 1, type: "Double", view: "View thung lũng", bedInfo: "1 giường đôi", defaultGuests: 2, isDorm: false },
    { id: "102", name: "102", floor: 1, type: "Twins", view: "View núi", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "104", name: "104", floor: 1, type: "Twins", view: "View núi", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "106", name: "106", floor: 1, type: "Twins", view: "View núi", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "107", name: "107", floor: 1, type: "Double", view: "View thung lũng", bedInfo: "1 giường đôi", defaultGuests: 2, isDorm: false },
    { id: "DORM", name: "Dorm nội bộ", floor: 1, type: "Dorm", view: "HDV & Lái xe", bedInfo: "4 giường tầng (8 chỗ)", defaultGuests: 1, isDorm: true, capacity: 8 },

    // Tầng 2: 2 Family thung lũng (201, 205) + 2 Twins núi (202, 206) + 1 Twins thung lũng (203) + 1 Triple núi (204) + 1 Double thung lũng (207)
    { id: "201", name: "201", floor: 2, type: "Family", view: "View thung lũng", bedInfo: "1 đôi + 1 đơn", defaultGuests: 3, isDorm: false },
    { id: "202", name: "202", floor: 2, type: "Twins", view: "View núi", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "203", name: "203", floor: 2, type: "Twins", view: "View thung lũng", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "204", name: "204", floor: 2, type: "Triple", view: "View núi", bedInfo: "3 giường đơn", defaultGuests: 3, isDorm: false },
    { id: "205", name: "205", floor: 2, type: "Family", view: "View thung lũng", bedInfo: "1 đôi + 1 đơn", defaultGuests: 3, isDorm: false },
    { id: "206", name: "206", floor: 2, type: "Twins", view: "View núi", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "207", name: "207", floor: 2, type: "Double", view: "View thung lũng", bedInfo: "1 giường đôi", defaultGuests: 2, isDorm: false },

    // Tầng 3: 2 Family thung lũng (301, 305) + 2 Double núi (302, 306) + 1 Twins thung lũng (303) + 1 Triple núi (304) + 1 Double thung lũng (307)
    { id: "301", name: "301", floor: 3, type: "Family", view: "View thung lũng", bedInfo: "1 đôi + 1 đơn", defaultGuests: 3, isDorm: false },
    { id: "302", name: "302", floor: 3, type: "Double", view: "View núi", bedInfo: "1 giường đôi", defaultGuests: 2, isDorm: false },
    { id: "303", name: "303", floor: 3, type: "Twins", view: "View thung lũng", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "304", name: "304", floor: 3, type: "Triple", view: "View núi", bedInfo: "3 giường đơn", defaultGuests: 3, isDorm: false },
    { id: "305", name: "305", floor: 3, type: "Family", view: "View thung lũng", bedInfo: "1 đôi + 1 đơn", defaultGuests: 3, isDorm: false },
    { id: "306", name: "306", floor: 3, type: "Double", view: "View núi", bedInfo: "1 giường đôi", defaultGuests: 2, isDorm: false },
    { id: "307", name: "307", floor: 3, type: "Double", view: "View thung lũng", bedInfo: "1 giường đôi", defaultGuests: 2, isDorm: false },

    // Tầng 4: 3 Double thung lũng (401, 405, 407) + 2 Twins núi (402, 406) + 1 Twins thung lũng (403) + 1 Family núi (404)
    { id: "401", name: "401", floor: 4, type: "Double", view: "View thung lũng", bedInfo: "1 giường đôi", defaultGuests: 2, isDorm: false },
    { id: "402", name: "402", floor: 4, type: "Twins", view: "View núi", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "403", name: "403", floor: 4, type: "Twins", view: "View thung lũng", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "404", name: "404", floor: 4, type: "Family", view: "View núi", bedInfo: "1 đôi + 1 đơn", defaultGuests: 3, isDorm: false },
    { id: "405", name: "405", floor: 4, type: "Double", view: "View thung lũng", bedInfo: "1 giường đôi", defaultGuests: 2, isDorm: false },
    { id: "406", name: "406", floor: 4, type: "Twins", view: "View núi", bedInfo: "2 giường đơn", defaultGuests: 2, isDorm: false },
    { id: "407", name: "407", floor: 4, type: "Double", view: "View thung lũng", bedInfo: "1 giường đôi", defaultGuests: 2, isDorm: false }
  ]);

  const ROOM_BY_ID = Object.freeze(Object.fromEntries(ROOMS.map((r) => [r.id, r])));

  // Display section order: Dorm nội bộ is separated into its own section at the VERY TOP, followed by Floors 1–4
  const ROOM_SECTIONS = Object.freeze([
    { key: "dorm", label: "Dorm nội bộ (4 giường tầng • 8 chỗ)", shortLabel: "Dorm nội bộ (8 chỗ)", isDorm: true, floor: null },
    { key: "1", label: "Tầng 1 (5 phòng ngủ)", shortLabel: "Tầng 1 (5 phòng)", isDorm: false, floor: 1 },
    { key: "2", label: "Tầng 2 (7 phòng ngủ)", shortLabel: "Tầng 2 (7 phòng)", isDorm: false, floor: 2 },
    { key: "3", label: "Tầng 3 (7 phòng ngủ)", shortLabel: "Tầng 3 (7 phòng)", isDorm: false, floor: 3 },
    { key: "4", label: "Tầng 4 (7 phòng ngủ)", shortLabel: "Tầng 4 (7 phòng)", isDorm: false, floor: 4 }
  ]);

  const DORM_SLOTS = Object.freeze([
    { slot: 1, label: "Slot 1", bunk: "Giường tầng 1 • Dưới" },
    { slot: 2, label: "Slot 2", bunk: "Giường tầng 1 • Trên" },
    { slot: 3, label: "Slot 3", bunk: "Giường tầng 2 • Dưới" },
    { slot: 4, label: "Slot 4", bunk: "Giường tầng 2 • Trên" },
    { slot: 5, label: "Slot 5", bunk: "Giường tầng 3 • Dưới" },
    { slot: 6, label: "Slot 6", bunk: "Giường tầng 3 • Trên" },
    { slot: 7, label: "Slot 7", bunk: "Giường tầng 4 • Dưới" },
    { slot: 8, label: "Slot 8", bunk: "Giường tầng 4 • Trên" }
  ]);

  const CHANNELS = Object.freeze([
    { key: "booking", label: "Booking.com", short: "Booking", hex: "#2563eb", colorVar: "var(--ch-booking-solid)", bgVar: "var(--ch-booking-bg)", fgVar: "var(--ch-booking-fg)" },
    { key: "agoda", label: "Agoda", short: "Agoda", hex: "#ea580c", colorVar: "var(--ch-agoda-solid)", bgVar: "var(--ch-agoda-bg)", fgVar: "var(--ch-agoda-fg)" },
    { key: "airbnb", label: "Airbnb", short: "Airbnb", hex: "#e11d48", colorVar: "var(--ch-airbnb-solid)", bgVar: "var(--ch-airbnb-bg)", fgVar: "var(--ch-airbnb-fg)" },
    { key: "walkin", label: "Khách lẻ", short: "Khách lẻ", hex: "#059669", colorVar: "var(--ch-walkin-solid)", bgVar: "var(--ch-walkin-bg)", fgVar: "var(--ch-walkin-fg)" },
    { key: "tour", label: "Gmail", short: "Gmail", hex: "#d97706", colorVar: "var(--ch-tour-solid)", bgVar: "var(--ch-tour-bg)", fgVar: "var(--ch-tour-fg)" },
    { key: "zalo", label: "Zalo", short: "Zalo", hex: "#0284c7", colorVar: "var(--ch-zalo-solid)", bgVar: "var(--ch-zalo-bg)", fgVar: "var(--ch-zalo-fg)" },
    { key: "other", label: "Nền tảng khác", short: "Khác", hex: "#6366f1", colorVar: "var(--ch-other-solid)", bgVar: "var(--ch-other-bg)", fgVar: "var(--ch-other-fg)" }
  ]);

  const VALID_CHANNEL_KEYS = new Set(CHANNELS.map((c) => c.key));

  const CODE_PLACEHOLDERS = Object.freeze({
    booking: "VD: 4829103847",
    agoda: "VD: 129384756",
    airbnb: "VD: HM4K9X2P8Q",
    walkin: "VD: KL-2111-01 (không bắt buộc)",
    tour: "VD: VR-2026-204",
    zalo: "VD: ZL-2111-01",
    other: "VD: Mã xác nhận / Booking ID"
  });

  const CONFIRMERS = Object.freeze([
    "Ngọc",
    "Tường Vi",
    "Trần Bình",
    "Lan Anh",
    "Trần Minh"
  ]);

  const DOW_VI = Object.freeze(["CN", "T2", "T3", "T4", "T5", "T6", "T7"]);
  const DOW_FULL_VI = Object.freeze(["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"]);

  /* -------------------- Strict Date & Formatting Utilities -------------------- */

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDateISO(y, m0, d) {
    return `${y}-${pad2(m0 + 1)}-${pad2(d)}`;
  }

  function isValidISODate(iso) {
    if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const [y, m, d] = iso.split("-").map(Number);
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function getTodayISO(nowDate) {
    const d = nowDate instanceof Date ? nowDate : new Date();
    return formatDateISO(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDaysISO(iso, deltaDays) {
    if (!isValidISODate(iso)) return "";
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + Math.trunc(Number(deltaDays) || 0)));
    return formatDateISO(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  }

  function diffNights(checkin, checkout) {
    if (!isValidISODate(checkin) || !isValidISODate(checkout)) return NaN;
    const [y1, m1, d1] = checkin.split("-").map(Number);
    const [y2, m2, d2] = checkout.split("-").map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  }

  function formatDateVN(iso) {
    if (!isValidISODate(iso)) return "—";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }

  function getDaysInMonth(year, month0) {
    return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  }

  /* -------------------- Currency & Security Sanitization -------------------- */

  function parseVND(v) {
    if (typeof v === "number") {
      if (!Number.isFinite(v) || v < 0) return 0;
      return Math.min(MAX_AMOUNT_VND, Math.round(v));
    }
    const str = String(v || "").trim();
    if (!str || str.startsWith("-")) return 0;
    const cleaned = str.replace(/[^\d]/g, "");
    if (!cleaned) return 0;
    const parsed = parseInt(cleaned, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(MAX_AMOUNT_VND, parsed);
  }

  function formatVND(n) {
    const v = parseVND(n);
    return v.toLocaleString("vi-VN") + " đ";
  }

  function formatShortVND(n) {
    const v = parseVND(n);
    if (v >= 1000000) {
      const m = v / 1000000;
      const formatted = Number.isInteger(m) ? String(m) : m.toFixed(2).replace(/\.?0+$/, "").replace(".", ",");
      return `${formatted}tr`;
    }
    if (v >= 1000) return `${Math.round(v / 1000)}k`;
    return `${v}đ`;
  }

  const HOTEL_TIMEZONE = "Asia/Ho_Chi_Minh";
  const HOTEL_TZ_OFFSET_MINUTES = 7 * 60; // Vietnam ICT = UTC+7 (no DST)

  function toVietnamParts(input) {
    let dt;
    if (input instanceof Date) {
      dt = input;
    } else if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
      const [y, m, d] = input.trim().split("-").map(Number);
      return {
        year: y, month: m, day: d, hours: 12, minutes: 0, seconds: 0,
        dateISO: `${y}-${pad2(m)}-${pad2(d)}`,
        monthKey: `${y}-${pad2(m)}`,
        isoWithOffset: `${y}-${pad2(m)}-${pad2(d)}T12:00:00+07:00`
      };
    } else if (typeof input === "string" && input.trim()) {
      const s = input.trim();
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
        dt = new Date(s.length === 16 ? `${s}:00+07:00` : `${s}+07:00`);
      } else {
        dt = new Date(s);
      }
    } else {
      dt = new Date();
    }
    if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) dt = new Date();
    const vnMs = dt.getTime() + HOTEL_TZ_OFFSET_MINUTES * 60000;
    const v = new Date(vnMs);
    const y = v.getUTCFullYear();
    const m = v.getUTCMonth() + 1;
    const d = v.getUTCDate();
    const hh = v.getUTCHours();
    const mm = v.getUTCMinutes();
    const ss = v.getUTCSeconds();
    const dateISO = `${y}-${pad2(m)}-${pad2(d)}`;
    return {
      year: y, month: m, day: d, hours: hh, minutes: mm, seconds: ss,
      dateISO,
      monthKey: `${y}-${pad2(m)}`,
      isoWithOffset: `${dateISO}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}+07:00`
    };
  }

  function getVietnamTodayISO(nowDate) {
    return toVietnamParts(nowDate instanceof Date ? nowDate : new Date()).dateISO;
  }

  function getVietnamNowISO(nowDate) {
    return toVietnamParts(nowDate instanceof Date ? nowDate : new Date()).isoWithOffset;
  }

  function normalizeFinanceDateISO(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (isValidISODate(s)) return s;
    const dt = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s) ? (s.length === 16 ? `${s}:00+07:00` : `${s}+07:00`) : s);
    if (Number.isNaN(dt.getTime())) return null;
    const parts = toVietnamParts(dt);
    return isValidISODate(parts.dateISO) ? parts.dateISO : null;
  }

  function normalizeFinanceTimestamp(raw, fallbackNow) {
    const s = String(raw || "").trim();
    if (!s) {
      const p = toVietnamParts(fallbackNow instanceof Date ? fallbackNow : new Date());
      return { receivedAt: p.isoWithOffset, receivedDate: p.dateISO };
    }
    if (isValidISODate(s)) {
      return { receivedAt: `${s}T12:00:00+07:00`, receivedDate: s };
    }
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)
      ? (s.length === 16 ? `${s}:00+07:00` : `${s}+07:00`)
      : s;
    const dt = new Date(normalized);
    if (Number.isNaN(dt.getTime())) {
      const p = toVietnamParts(fallbackNow instanceof Date ? fallbackNow : new Date());
      return { receivedAt: p.isoWithOffset, receivedDate: p.dateISO };
    }
    const p = toVietnamParts(dt);
    return { receivedAt: p.isoWithOffset, receivedDate: p.dateISO };
  }

  function roundVND(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) return 0;
    const r = Math.round(num);
    return Math.max(-MAX_AMOUNT_VND, Math.min(MAX_AMOUNT_VND, r));
  }

  function parseSignedVND(v) {
    if (typeof v === "number") return roundVND(v);
    const str = String(v || "").trim();
    if (!str) return 0;
    const neg = str.startsWith("-");
    const cleaned = str.replace(/[^\d]/g, "");
    if (!cleaned) return 0;
    const parsed = parseInt(cleaned, 10);
    if (!Number.isFinite(parsed)) return 0;
    return roundVND(neg ? -parsed : parsed);
  }

  function formatSignedVND(n) {
    const v = roundVND(n);
    if (v < 0) return `-${Math.abs(v).toLocaleString("vi-VN")} đ`;
    return `${v.toLocaleString("vi-VN")} đ`;
  }

  function formatNumberInput(n) {
    const v = parseVND(n);
    return v > 0 ? v.toLocaleString("vi-VN") : "";
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Neutralize Excel/Sheets CSV Formula Injection (CWE-1236)
  function sanitizeCsvCell(val) {
    if (typeof val === "number" && Number.isFinite(val)) {
      return `"${val}"`;
    }
    let str = String(val ?? "");
    if (/^[\t\r\n ]*[=+\-@]/.test(str)) {
      str = "'" + str;
    }
    return `"${str.replace(/"/g, '""')}"`;
  }

  function sanitizeText(val, maxLen) {
    const s = String(val ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    return maxLen ? s.slice(0, maxLen) : s;
  }

  function stripDangerousKeys(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
    const clean = Object.create(null);
    for (const key of Object.keys(obj)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      clean[key] = obj[key];
    }
    return Object.assign({}, clean);
  }

  /* -------------------- Room & Payment Helpers -------------------- */

  function getRoomById(id) {
    return ROOM_BY_ID[id] || null;
  }

  function getRemaining(bk) {
    return Math.max(0, parseVND(bk.totalAmount) - parseVND(bk.paidAmount));
  }

  function getPaymentStatus(bk) {
    const t = parseVND(bk.totalAmount);
    const p = parseVND(bk.paidAmount);
    if (t === 0 && (bk.roomId === "DORM" || bk.paymentStatus === "paid")) return "paid";
    if (t > 0 && p >= t) return "paid";
    if (p > 0) return "deposit";
    return "unpaid";
  }

  function validatePaymentAmounts(totalAmount, paidAmount) {
    const t = parseVND(totalAmount);
    const p = parseVND(paidAmount);
    if (t > 0 && p > t) {
      return `Số tiền đã thanh toán/cọc (${formatVND(p)}) không được lớn hơn tổng tiền phòng (${formatVND(t)}).`;
    }
    if (t === 0 && p > 0) {
      return "Vui lòng nhập Tổng tiền phòng lớn hơn hoặc bằng số tiền đã thanh toán/cọc.";
    }
    return null;
  }

  const VAT_RATE = 0.08;

  function calculateVatBreakdown(baseAmount, includeVat) {
    const preVatAmount = parseVND(baseAmount);
    if (!includeVat) {
      return {
        includeVat: false,
        vatRate: 0,
        preVatAmount,
        vatAmount: 0,
        totalAmount: preVatAmount
      };
    }
    const vatAmount = Math.round(preVatAmount * VAT_RATE);
    return {
      includeVat: true,
      vatRate: 8,
      preVatAmount,
      vatAmount,
      totalAmount: preVatAmount + vatAmount
    };
  }

  function extractPreVatFromTotal(totalAmount) {
    const total = parseVND(totalAmount);
    const preVatAmount = Math.round(total / (1 + VAT_RATE));
    const vatAmount = Math.max(0, total - preVatAmount);
    return { preVatAmount, vatAmount, totalAmount: total };
  }

  // Unified final payment badge for EVERY day of a single-room or multi-night stay.
  // Matches getGroupCellPaymentBadge: never splits deposit on day 1 vs remaining debt on day 2+.
  function getCellPaymentBadge(bk) {
    const total = parseVND(bk.totalAmount);
    const paid = parseVND(bk.paidAmount);
    const rem = getRemaining(bk);
    const status = getPaymentStatus(bk);

    if (status === "paid") {
      return {
        cls: "paid",
        text: total > 0 ? `✓ Đủ ${formatShortVND(total)}` : "✓ Đã TT",
        title: total > 0 ? `Đã thanh toán hết (${formatVND(paid)})` : "Miễn phí / Đã thanh toán"
      };
    }
    if (status === "deposit") {
      return {
        cls: "deposit",
        text: `Cọc -${formatShortVND(rem)}`,
        title: `Tổng ${formatVND(total)} • Đã cọc ${formatVND(paid)} • Còn thiếu ${formatVND(rem)}`
      };
    }
    return {
      cls: "unpaid",
      text: total > 0 ? `Nợ ${formatShortVND(total)}` : "Chưa TT",
      title: `Chưa thanh toán (${formatVND(total)})`
    };
  }

  // Unified final payment badge for ALL cells belonging to a multi-room group.
  // Never displays per-room split amounts; every room cell in the group shows the
  // exact same final group payment status and total group remaining balance.
  function getGroupCellPaymentBadge(groupSummary) {
    if (!groupSummary) return null;
    const total = parseVND(groupSummary.totalAmount);
    const paid = parseVND(groupSummary.paidAmount);
    const rem = Math.max(0, parseVND(groupSummary.remaining));
    const status = groupSummary.paymentStatus || (total > 0 && rem === 0 ? "paid" : paid > 0 ? "deposit" : "unpaid");
    const countLabel = `${groupSummary.roomCount} phòng`;

    if (status === "paid") {
      return {
        cls: "paid",
        text: total > 0 ? `✓ Đủ ${formatShortVND(total)}` : "✓ Đã TT",
        title: `Đoàn ${groupSummary.code} (${countLabel}): Đã thanh toán đủ ${formatVND(total)}`
      };
    }
    if (status === "deposit") {
      return {
        cls: "deposit",
        text: `Cọc -${formatShortVND(rem)}`,
        title: `Đoàn ${groupSummary.code} (${countLabel}): Tổng ${formatVND(total)} • Đã cọc ${formatVND(paid)} • Còn nợ cả đoàn ${formatVND(rem)}`
      };
    }
    return {
      cls: "unpaid",
      text: total > 0 ? `Nợ ${formatShortVND(total)}` : "Chưa TT",
      title: `Đoàn ${groupSummary.code} (${countLabel}): Chưa thanh toán (${formatVND(total)})`
    };
  }

  function detectChannelKey(src, fallback = "other") {
    const s = String(src || "").trim().toLowerCase();
    if (!s) return fallback;
    if (s.includes("booking")) return "booking";
    if (s.includes("agoda")) return "agoda";
    if (s.includes("airbnb")) return "airbnb";
    if (s.includes("khách lẻ") || s.includes("khach le") || s.includes("nội bộ")) return "walkin";
    if (s.includes("zalo")) return "zalo";
    if (s.includes("gmail") || s.includes("mail") || s.includes("tour") || s.includes("đoàn")) return "tour";
    return fallback;
  }

  /* -------------------- Conflict Detection & Consistency Audit -------------------- */

  function bookingCoversDate(bk, iso) {
    if (!bk || isBookingCancelled(bk)) return false;
    return isValidISODate(bk.checkin) && isValidISODate(bk.checkout) && bk.checkin <= iso && iso < bk.checkout;
  }

  function datesOverlap(aCheckin, aCheckout, bCheckin, bCheckout) {
    return aCheckin < bCheckout && bCheckin < aCheckout;
  }

  function getDormSlotMapForDate(bookings, dateISO) {
    const map = {};
    const conflicts = [];
    for (const bk of bookings) {
      if (!bk || isBookingCancelled(bk)) continue;
      if (bk.roomId !== "DORM" || !bookingCoversDate(bk, dateISO)) continue;
      const slots = Array.isArray(bk.slots) ? bk.slots : [];
      for (const s of slots) {
        if (s < 1 || s > 8) continue;
        if (map[s] && map[s].id !== bk.id) {
          conflicts.push({ date: dateISO, slot: s, existingId: map[s].id, duplicateId: bk.id });
        } else {
          map[s] = bk;
        }
      }
    }
    return { map, conflicts };
  }

  function getDormOccupiedSlotsInRange(bookings, checkin, checkout, excludeId = null) {
    const occupied = {};
    if (diffNights(checkin, checkout) <= 0) return occupied;
    for (const bk of bookings) {
      if (!bk || isBookingCancelled(bk)) continue;
      if (bk.roomId !== "DORM" || bk.id === excludeId) continue;
      if (datesOverlap(bk.checkin, bk.checkout, checkin, checkout)) {
        for (const s of (bk.slots || [])) {
          if (s >= 1 && s <= 8) occupied[s] = bk;
        }
      }
    }
    return occupied;
  }

  function checkRegularConflict(bookings, candidate, excludeId = null) {
    const room = getRoomById(candidate.roomId);
    if (!room || room.isDorm) return "Phòng không hợp lệ cho đặt phòng thường.";
    const nights = diffNights(candidate.checkin, candidate.checkout);
    if (!Number.isFinite(nights) || nights <= 0) return "Ngày trả phòng phải sau ngày nhận phòng ít nhất 1 đêm.";
    if (nights > MAX_NIGHTS) return `Thời gian lưu trú vượt quá giới hạn ${MAX_NIGHTS} đêm.`;
    if (isBookingCancelled(candidate)) return null;

    for (const b of bookings) {
      if (!b || isBookingCancelled(b)) continue;
      if (b.id === excludeId || b.roomId !== candidate.roomId) continue;
      if (datesOverlap(candidate.checkin, candidate.checkout, b.checkin, b.checkout)) {
        const overlapStart = candidate.checkin > b.checkin ? candidate.checkin : b.checkin;
        return `Phòng ${room.name} đã có khách (${b.guestName} - ${b.sourceName}) vào đêm ${formatDateVN(overlapStart)}.`;
      }
    }
    return null;
  }

  function checkDormSlotConflict(bookings, candidate, excludeId = null) {
    if (candidate.roomId !== "DORM") return "Không phải lượt đặt Dorm.";
    const nights = diffNights(candidate.checkin, candidate.checkout);
    if (!Number.isFinite(nights) || nights <= 0) return "Ngày trả chỗ phải sau ngày nhận chỗ ít nhất 1 đêm.";
    if (nights > MAX_NIGHTS) return `Thời gian lưu trú vượt quá giới hạn ${MAX_NIGHTS} đêm.`;
    if (!Array.isArray(candidate.slots) || candidate.slots.length === 0) {
      return "Vui lòng chọn ít nhất 1 slot giường tầng (1–8).";
    }
    const occ = getDormOccupiedSlotsInRange(bookings, candidate.checkin, candidate.checkout, excludeId);
    for (const s of candidate.slots) {
      if (!Number.isInteger(s) || s < 1 || s > 8) return `Slot Dorm không hợp lệ: ${s}.`;
      if (occ[s]) {
        return `Slot ${s} đã có ${occ[s].guestName} đặt trong khoảng ${formatDateVN(occ[s].checkin)} → ${formatDateVN(occ[s].checkout)}.`;
      }
    }
    return null;
  }

  // Safely assign explicit slots to legacy Dorm bookings without EVER overwriting an occupied slot
  function normalizeDormSlots(list) {
    const warnings = [];
    const dormList = list.filter((b) => b && b.roomId === "DORM");
    for (const bk of dormList) {
      if (Array.isArray(bk.slots) && bk.slots.length > 0) {
        bk.slots = [...new Set(bk.slots.map(Number).filter((s) => Number.isInteger(s) && s >= 1 && s <= 8))].sort((a, b) => a - b);
        bk.dormBeds = bk.slots.length;
        bk.guestCount = bk.slots.length;
        continue;
      }
      const need = Math.min(8, Math.max(1, parseInt(bk.dormBeds, 10) || 1));
      const used = new Set();
      for (const other of dormList) {
        if (other.id === bk.id || !Array.isArray(other.slots)) continue;
        if (datesOverlap(other.checkin, other.checkout, bk.checkin, bk.checkout)) {
          other.slots.forEach((s) => used.add(s));
        }
      }
      const assigned = [];
      for (let s = 1; s <= 8 && assigned.length < need; s++) {
        if (!used.has(s)) assigned.push(s);
      }
      if (assigned.length < need) {
        warnings.push(`Dorm booking ${bk.id} (${bk.guestName}) yêu cầu ${need} chỗ nhưng chỉ còn ${assigned.length} chỗ trống.`);
      }
      bk.slots = assigned;
      bk.dormBeds = assigned.length;
      bk.guestCount = assigned.length;
    }
    return warnings;
  }

  const MAX_CONFIRMATION_PDF_BYTES = 2 * 1024 * 1024; // 2MB raw PDF limit for fast PC/Mobile sync
  const MAX_CONFIRMATION_PDF_B64_CHARS = Math.ceil((MAX_CONFIRMATION_PDF_BYTES * 4) / 3) + 256;

  function formatFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "0 KB";
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function sanitizeConfirmationPdf(rawPdf) {
    if (rawPdf === null || rawPdf === undefined || rawPdf === "") {
      return { ok: true, value: null };
    }
    const obj = stripDangerousKeys(rawPdf);
    if (!obj || typeof obj !== "object") {
      return { ok: false, error: "File xác nhận PDF không hợp lệ." };
    }
    const dataUrl = typeof obj.dataUrl === "string" ? obj.dataUrl.trim() : "";
    if (!dataUrl.startsWith("data:application/pdf;base64,")) {
      return { ok: false, error: "Chỉ chấp nhận file định dạng PDF (.pdf)." };
    }
    if (dataUrl.length > MAX_CONFIRMATION_PDF_B64_CHARS) {
      return { ok: false, error: "File PDF xác nhận vượt quá dung lượng tối đa 2 MB." };
    }
    const b64Part = dataUrl.slice("data:application/pdf;base64,".length);
    if (!b64Part || !/^[A-Za-z0-9+/=\s]+$/.test(b64Part)) {
      return { ok: false, error: "Nội dung file PDF không hợp lệ." };
    }
    const approxBytes = Math.floor((b64Part.replace(/\s+/g, "").length * 3) / 4);
    const size = Number.isFinite(Number(obj.size)) && Number(obj.size) > 0
      ? Math.min(MAX_CONFIRMATION_PDF_BYTES, Math.round(Number(obj.size)))
      : approxBytes;
    if (approxBytes > MAX_CONFIRMATION_PDF_BYTES + 1024) {
      return { ok: false, error: "File PDF xác nhận vượt quá dung lượng tối đa 2 MB." };
    }
    let name = sanitizeText(obj.name, 140) || "xac-nhan-dat-phong.pdf";
    if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
    const uploadedAt = sanitizeText(obj.uploadedAt, 40) || new Date().toISOString();
    return {
      ok: true,
      value: {
        name,
        size,
        type: "application/pdf",
        dataUrl: `data:application/pdf;base64,${b64Part.replace(/\s+/g, "")}`,
        uploadedAt
      }
    };
  }

  function sanitizeBookingRecord(raw, existingRecord) {
    const obj = stripDangerousKeys(raw);
    if (!obj || typeof obj !== "object") {
      return { ok: false, error: "Dữ liệu đặt phòng không hợp lệ." };
    }

    const roomId = sanitizeText(obj.roomId, 16);
    const room = getRoomById(roomId);
    if (!room) {
      return { ok: false, error: `Mã phòng không tồn tại trong hệ thống: "${roomId}".` };
    }

    const checkin = sanitizeText(obj.checkin, 10);
    const checkout = sanitizeText(obj.checkout, 10);
    if (!isValidISODate(checkin) || !isValidISODate(checkout)) {
      return { ok: false, error: "Định dạng ngày nhận/trả phòng không hợp lệ (cần YYYY-MM-DD)." };
    }
    const nights = diffNights(checkin, checkout);
    if (!Number.isFinite(nights) || nights <= 0) {
      return { ok: false, error: "Ngày trả phòng phải sau ngày nhận phòng ít nhất 1 đêm." };
    }
    if (nights > MAX_NIGHTS) {
      return { ok: false, error: `Số đêm lưu trú tối đa là ${MAX_NIGHTS} đêm.` };
    }

    const guestName = sanitizeText(obj.guestName, 120);
    if (!guestName) {
      return { ok: false, error: room.isDorm ? "Vui lòng nhập tên HDV / Lái xe." : "Vui lòng nhập tên khách hàng." };
    }

    let channelKey = sanitizeText(obj.channelKey, 20);
    if (!VALID_CHANNEL_KEYS.has(channelKey)) {
      channelKey = detectChannelKey(obj.sourceName, "other");
    }

    const tourName = (channelKey === "tour" || channelKey === "zalo") ? sanitizeText(obj.tourName, 100) : "";
    const bookingCode = sanitizeText(obj.bookingCode, 60);
    let sourceName = sanitizeText(obj.sourceName, 100);
    if (!sourceName) {
      const ch = CHANNELS.find((c) => c.key === channelKey);
      if (channelKey === "tour") sourceName = tourName ? `Gmail ${tourName}` : "Gmail";
      else if (channelKey === "zalo") sourceName = tourName ? `Zalo ${tourName}` : "Zalo";
      else sourceName = ch ? ch.label : "Khác";
    }

    const rawServices = obj.services !== undefined ? obj.services : (existingRecord && existingRecord.services);
    const services = Array.isArray(rawServices)
      ? rawServices.map((sv, idx) => {
          const sObj = stripDangerousKeys(sv) || {};
          const qty = Math.max(1, Math.min(999, Math.round(Number(sObj.qty) || 1)));
          const unitPrice = parseVND(sObj.unitPrice !== undefined ? sObj.unitPrice : sObj.amount);
          const amount = sObj.amount !== undefined && sObj.unitPrice === undefined
            ? parseVND(sObj.amount)
            : roundVND(qty * unitPrice);
          return {
            id: sanitizeText(sObj.id, 64) || `sv_${Date.now().toString(36)}_${idx}`,
            name: sanitizeText(sObj.name, 120) || "Dịch vụ phát sinh",
            qty,
            unitPrice: unitPrice || amount,
            amount: Math.max(0, amount),
            dateISO: normalizeFinanceDateISO(sObj.dateISO) || checkin,
            note: sanitizeText(sObj.note, 300),
            addedBy: sanitizeText(sObj.addedBy, 60),
            addedAt: sanitizeText(sObj.addedAt, 40) || new Date().toISOString()
          };
        })
      : [];

    const rawAdjustments = obj.adjustments !== undefined ? obj.adjustments : (existingRecord && existingRecord.adjustments);
    const adjustments = Array.isArray(rawAdjustments)
      ? rawAdjustments.map((adj, idx) => {
          const aObj = stripDangerousKeys(adj) || {};
          return {
            id: sanitizeText(aObj.id, 64) || `adj_${Date.now().toString(36)}_${idx}`,
            amount: parseSignedVND(aObj.amount),
            reason: sanitizeText(aObj.reason, 300) || "Điều chỉnh giá trị đơn",
            kind: sanitizeText(aObj.kind, 40) || "other",
            effectiveDate: normalizeFinanceDateISO(aObj.effectiveDate) || getVietnamTodayISO(),
            approvedBy: sanitizeText(aObj.approvedBy, 60),
            createdAt: sanitizeText(aObj.createdAt, 40) || new Date().toISOString()
          };
        }).filter((a) => a.amount !== 0)
      : [];

    const servicesTotal = services.reduce((s, it) => s + parseVND(it.amount), 0);
    const adjustmentsTotal = adjustments.reduce((s, it) => s + parseSignedVND(it.amount), 0);
    const statusRaw = String(obj.status !== undefined ? obj.status : (existingRecord && existingRecord.status) || "active").trim().toLowerCase();
    const status = (statusRaw === "cancelled" || statusRaw === "canceled") ? "cancelled" : "active";
    const cancelledAt = status === "cancelled"
      ? (sanitizeText(obj.cancelledAt !== undefined ? obj.cancelledAt : (existingRecord && existingRecord.cancelledAt) || "", 40) || getVietnamNowISO())
      : "";
    const cancelledBy = status === "cancelled"
      ? sanitizeText(obj.cancelledBy !== undefined ? obj.cancelledBy : (existingRecord && existingRecord.cancelledBy) || "", 60)
      : "";
    const cancelReason = status === "cancelled"
      ? sanitizeText(obj.cancelReason !== undefined ? obj.cancelReason : (existingRecord && existingRecord.cancelReason) || "", 300)
      : "";
    const depDispRaw = String(obj.depositDisposition !== undefined ? obj.depositDisposition : (existingRecord && existingRecord.depositDisposition) || (status === "cancelled" ? "pending" : "none")).trim().toLowerCase();
    const depositDisposition = ["none", "pending", "refunded", "retained"].includes(depDispRaw) ? depDispRaw : (status === "cancelled" ? "pending" : "none");
    const retainedDepositAmount = status === "cancelled" && depositDisposition === "retained"
      ? parseVND(obj.retainedDepositAmount !== undefined ? obj.retainedDepositAmount : (existingRecord && existingRecord.retainedDepositAmount) || 0)
      : 0;

    let roomAmount;
    let totalAmount;
    if (obj.roomAmount !== undefined && obj.roomAmount !== null && String(obj.roomAmount).trim() !== "") {
      roomAmount = parseVND(obj.roomAmount);
      totalAmount = status === "cancelled"
        ? retainedDepositAmount
        : Math.max(0, roundVND(roomAmount + servicesTotal + adjustmentsTotal));
    } else if (services.length > 0 || adjustments.length > 0) {
      const explicitTotal = obj.totalAmount !== undefined ? parseVND(obj.totalAmount) : null;
      const prevRoom = existingRecord && existingRecord.roomAmount !== undefined
        ? parseVND(existingRecord.roomAmount)
        : (explicitTotal !== null ? Math.max(0, explicitTotal - servicesTotal - adjustmentsTotal) : 0);
      roomAmount = prevRoom;
      totalAmount = status === "cancelled"
        ? retainedDepositAmount
        : Math.max(0, roundVND(roomAmount + servicesTotal + adjustmentsTotal));
    } else {
      roomAmount = parseVND(obj.totalAmount);
      totalAmount = status === "cancelled" ? retainedDepositAmount : roomAmount;
    }

    const paidAmount = parseVND(obj.paidAmount);
    const allowOverpaid = Boolean(obj.allowOverpaid || status === "cancelled" || (existingRecord && existingRecord.ledgerManaged) || obj.ledgerManaged);
    if (!allowOverpaid) {
      const payErr = validatePaymentAmounts(totalAmount, paidAmount);
      if (payErr) {
        return { ok: false, error: payErr };
      }
    }

    const includeVat = Boolean(obj.includeVat);
    const vatRate = includeVat ? 8 : 0;
    let preVatAmount = roomAmount;
    let vatAmount = 0;
    if (includeVat) {
      const hasExplicitPreVat = obj.preVatAmount !== undefined && obj.preVatAmount !== null && String(obj.preVatAmount).trim() !== "";
      const parsedPre = hasExplicitPreVat ? parseVND(obj.preVatAmount) : extractPreVatFromTotal(roomAmount).preVatAmount;
      preVatAmount = Math.min(roomAmount, parsedPre);
      vatAmount = Math.max(0, roomAmount - preVatAmount);
    }

    let slots = [];
    let dormBeds = 0;
    let guestCount = room.defaultGuests;
    if (room.isDorm) {
      if (Array.isArray(obj.slots)) {
        slots = [...new Set(obj.slots.map(Number).filter((s) => Number.isInteger(s) && s >= 1 && s <= 8))].sort((a, b) => a - b);
      }
      if (slots.length === 0) {
        return { ok: false, error: "Vui lòng chọn ít nhất 1 slot giường tầng (Slot 1–8)." };
      }
      dormBeds = slots.length;
      guestCount = slots.length;
    } else {
      guestCount = Math.min(12, Math.max(1, parseInt(obj.guestCount, 10) || room.defaultGuests));
    }

    const extraBed = room.isDorm ? 0 : Math.min(2, Math.max(0, parseInt(obj.extraBed, 10) || 0));
    const mergeBed = room.type === "Twins" ? Boolean(obj.mergeBed) : false;

    const paymentStatus = status === "cancelled"
      ? (paidAmount > retainedDepositAmount ? "overpaid" : "cancelled")
      : totalAmount === 0
        ? (room.isDorm || obj.paymentStatus === "paid" ? "paid" : "unpaid")
        : (paidAmount > totalAmount ? "overpaid" : paidAmount >= totalAmount ? "paid" : paidAmount > 0 ? "deposit" : "unpaid");

    let confirmationPdf = null;
    if (obj.confirmationPdf === undefined) {
      if (existingRecord && existingRecord.confirmationPdf) {
        const prevCheck = sanitizeConfirmationPdf(existingRecord.confirmationPdf);
        confirmationPdf = prevCheck.ok ? prevCheck.value : null;
      }
    } else {
      const pdfCheck = sanitizeConfirmationPdf(obj.confirmationPdf);
      if (!pdfCheck.ok) {
        return { ok: false, error: pdfCheck.error };
      }
      confirmationPdf = pdfCheck.value;
    }

    const nowISO = new Date().toISOString();
    const id = sanitizeText(obj.id, 64) || `${room.isDorm ? "dorm" : "bk"}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fallbackBookingDate = (existingRecord && isValidISODate(existingRecord.bookingDate))
      ? existingRecord.bookingDate
      : (existingRecord && typeof existingRecord.createdAt === "string" && isValidISODate(existingRecord.createdAt.slice(0, 10)))
        ? existingRecord.createdAt.slice(0, 10)
        : getTodayISO();
    const bookingDate = isValidISODate(obj.bookingDate) ? obj.bookingDate : fallbackBookingDate;
    const depositDueDate = obj.depositDueDate !== undefined
      ? (normalizeFinanceDateISO(obj.depositDueDate) || "")
      : (existingRecord && normalizeFinanceDateISO(existingRecord.depositDueDate)) || "";
    const paymentDueDate = obj.paymentDueDate !== undefined
      ? (normalizeFinanceDateISO(obj.paymentDueDate) || "")
      : (existingRecord && normalizeFinanceDateISO(existingRecord.paymentDueDate)) || "";

    const existingChargeHistory = Array.isArray(obj.chargeHistory)
      ? obj.chargeHistory
      : (existingRecord && Array.isArray(existingRecord.chargeHistory) ? existingRecord.chargeHistory : []);
    const chargeHistory = existingChargeHistory.slice(-40).map((ch) => ({
      effectiveDate: normalizeFinanceDateISO(ch.effectiveDate) || bookingDate,
      totalPayable: parseVND(ch.totalPayable),
      roomAmount: parseVND(ch.roomAmount),
      servicesTotal: parseVND(ch.servicesTotal),
      adjustmentsTotal: parseSignedVND(ch.adjustmentsTotal),
      status: ch.status === "cancelled" ? "cancelled" : "active",
      recordedAt: sanitizeText(ch.recordedAt, 40) || nowISO,
      reason: sanitizeText(ch.reason, 200)
    }));
    const lastHist = chargeHistory[chargeHistory.length - 1];
    const effectiveChangeDate = normalizeFinanceDateISO(obj.chargeEffectiveDate)
      || (existingRecord ? getVietnamTodayISO() : bookingDate);
    if (!lastHist || lastHist.totalPayable !== totalAmount || lastHist.status !== status) {
      chargeHistory.push({
        effectiveDate: effectiveChangeDate,
        totalPayable: totalAmount,
        roomAmount,
        servicesTotal,
        adjustmentsTotal,
        status,
        recordedAt: nowISO,
        reason: sanitizeText(obj.chargeChangeReason, 200) || (existingRecord ? "Cập nhật giá trị đơn" : "Tạo đơn")
      });
    }

    const record = {
      id,
      roomId: room.id,
      bookingDate,
      checkin,
      checkout,
      depositDueDate,
      paymentDueDate,
      channelKey,
      sourceName,
      tourName,
      bookingCode,
      guestName,
      phone: sanitizeText(obj.phone, 40),
      guestCount,
      dormBeds,
      slots: room.isDorm ? slots : undefined,
      status,
      cancelledAt,
      cancelledBy,
      cancelReason,
      depositDisposition,
      retainedDepositAmount,
      roomAmount,
      services,
      adjustments,
      chargeHistory,
      totalAmount,
      includeVat,
      vatRate,
      preVatAmount,
      vatAmount,
      paidAmount,
      paymentStatus,
      ledgerManaged: Boolean(obj.ledgerManaged || (existingRecord && existingRecord.ledgerManaged)),
      mergeBed,
      extraBed,
      confirmedBy: sanitizeText(obj.confirmedBy, 60),
      confirmationPdf,
      notes: sanitizeText(obj.notes, 2000),
      checkedOutAt: sanitizeText(obj.checkedOutAt !== undefined ? obj.checkedOutAt : (existingRecord && existingRecord.checkedOutAt) || "", 40) || "",
      checkedOutBy: sanitizeText(obj.checkedOutBy !== undefined ? obj.checkedOutBy : (existingRecord && existingRecord.checkedOutBy) || "", 60) || "",
      idempotencyKey: sanitizeText(obj.idempotencyKey, 80) || undefined,
      revision: existingRecord ? (Number(existingRecord.revision) || 1) + 1 : 1,
      createdAt: existingRecord && existingRecord.createdAt ? existingRecord.createdAt : (sanitizeText(obj.createdAt, 40) || nowISO),
      updatedAt: nowISO
    };

    return { ok: true, record };
  }

  function auditBookingConsistency(bookings) {
    const errors = [];
    const seenIds = new Set();
    const regularByRoom = {};
    const dormBookings = [];

    for (const bk of bookings) {
      if (!bk || typeof bk !== "object") {
        errors.push("Phát hiện bản ghi đặt phòng rỗng hoặc sai kiểu.");
        continue;
      }
      if (!bk.id || seenIds.has(bk.id)) {
        errors.push(`Trùng hoặc thiếu mã bản ghi (id): ${bk.id}`);
      } else {
        seenIds.add(bk.id);
      }

      const room = getRoomById(bk.roomId);
      if (!room) {
        errors.push(`Bản ghi ${bk.id} trỏ tới phòng không tồn tại: ${bk.roomId}`);
        continue;
      }

      if (!isValidISODate(bk.checkin) || !isValidISODate(bk.checkout) || diffNights(bk.checkin, bk.checkout) <= 0) {
        errors.push(`Bản ghi ${bk.id} (P.${room.name}) có ngày lưu trú không hợp lệ: ${bk.checkin} → ${bk.checkout}`);
        continue;
      }

      const isCancelled = isBookingCancelled(bk);
      if (!isCancelled && !bk.ledgerManaged) {
        const payErr = validatePaymentAmounts(bk.totalAmount, bk.paidAmount);
        if (payErr) {
          errors.push(`Bản ghi ${bk.id} (P.${room.name}): ${payErr}`);
        }
      }

      if (isCancelled) continue;

      if (room.isDorm) {
        if (!Array.isArray(bk.slots) || bk.slots.length === 0) {
          errors.push(`Lượt Dorm ${bk.id} (${bk.guestName}) không có slot giường tầng hợp lệ.`);
        } else {
          dormBookings.push(bk);
        }
      } else {
        regularByRoom[room.id] = regularByRoom[room.id] || [];
        regularByRoom[room.id].push(bk);
      }
    }

    // Check pairwise overlaps per regular room
    for (const [roomId, list] of Object.entries(regularByRoom)) {
      list.sort((a, b) => a.checkin.localeCompare(b.checkin));
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        const curr = list[i];
        if (datesOverlap(prev.checkin, prev.checkout, curr.checkin, curr.checkout)) {
          errors.push(`Trùng lịch phòng ${roomId}: "${prev.guestName}" (${prev.checkin}→${prev.checkout}) và "${curr.guestName}" (${curr.checkin}→${curr.checkout}).`);
        }
      }
    }

    // Check pairwise slot overlaps for Dorm
    for (let i = 0; i < dormBookings.length; i++) {
      for (let j = i + 1; j < dormBookings.length; j++) {
        const a = dormBookings[i], b = dormBookings[j];
        if (!datesOverlap(a.checkin, a.checkout, b.checkin, b.checkout)) continue;
        const setA = new Set(a.slots || []);
        const overlapSlots = (b.slots || []).filter((s) => setA.has(s));
        if (overlapSlots.length > 0) {
          errors.push(`Trùng Slot ${overlapSlots.join(", ")} Dorm giữa "${a.guestName}" và "${b.guestName}".`);
        }
      }
    }

    return { ok: errors.length === 0, errors };
  }

  function validateAndSanitizeImport(rawPayload) {
    let parsed = rawPayload;
    if (typeof rawPayload === "string") {
      try {
        parsed = JSON.parse(rawPayload);
      } catch (e) {
        return { ok: false, error: "File JSON bị lỗi cú pháp: " + e.message };
      }
    }

    const rawList = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bookings) ? parsed.bookings : null);
    if (!rawList) {
      return { ok: false, error: "File sao lưu không chứa danh sách bookings hợp lệ." };
    }

    const sanitized = [];
    const seenIds = new Set();

    // First pre-assign legacy dorm slots on a copy if needed
    const clonedList = rawList.map((item) => stripDangerousKeys(item));
    const dormWarnings = normalizeDormSlots(clonedList);
    if (dormWarnings.length > 0) {
      return { ok: false, error: "Dữ liệu Dorm trong file sao lưu bị quá tải slot: " + dormWarnings[0] };
    }

    for (let i = 0; i < clonedList.length; i++) {
      const res = sanitizeBookingRecord(clonedList[i], null);
      if (!res.ok) {
        return { ok: false, error: `Lỗi tại bản ghi #${i + 1}: ${res.error}` };
      }
      if (seenIds.has(res.record.id)) {
        return { ok: false, error: `File sao lưu chứa mã đặt phòng bị trùng (id: ${res.record.id}).` };
      }
      seenIds.add(res.record.id);
      sanitized.push(res.record);
    }

    const audit = auditBookingConsistency(sanitized);
    if (!audit.ok) {
      return { ok: false, error: "Dữ liệu sao lưu có xung đột lịch phòng: " + audit.errors[0], details: audit.errors };
    }

    return { ok: true, bookings: sanitized };
  }

  /* -------------------- Financial & Export Calculations -------------------- */

  // Attribute revenue/paid/debt strictly by check-in month to prevent double-counting cross-month stays
  function computeMonthlyFinancials(bookings, year, month0) {
    const daysCount = getDaysInMonth(year, month0);
    const monthStart = formatDateISO(year, month0, 1);
    const monthNextStart = addDaysISO(formatDateISO(year, month0, daysCount), 1);

    const attributed = bookings.filter((b) => isValidISODate(b.checkin) && b.checkin >= monthStart && b.checkin < monthNextStart);
    const totalRevenue = attributed.reduce((sum, b) => sum + parseVND(b.totalAmount), 0);
    const totalPaid = attributed.reduce((sum, b) => sum + parseVND(b.paidAmount), 0);
    const totalDebt = attributed.reduce((sum, b) => sum + getRemaining(b), 0);

    return {
      bookingCount: attributed.length,
      totalRevenue,
      totalPaid,
      totalDebt
    };
  }

  /* -------------------- Group / Multi-Room Aggregation & Copy-Paste -------------------- */

  function normalizeGroupCode(code) {
    return sanitizeText(code, 60).toUpperCase();
  }

  function computeBookingGroupSummary(bookings, bookingCode) {
    const normalizedCode = normalizeGroupCode(bookingCode);
    if (!normalizedCode) return null;
    const list = (Array.isArray(bookings) ? bookings : [])
      .filter((b) => b && normalizeGroupCode(b.bookingCode) === normalizedCode)
      .slice()
      .sort((a, b) => String(a.checkin || "").localeCompare(String(b.checkin || "")) || String(a.roomId || "").localeCompare(String(b.roomId || "")));

    if (list.length === 0) return null;

    let totalAmount = 0;
    let paidAmount = 0;
    let remaining = 0;
    let totalNights = 0;
    let totalGuests = 0;
    let regularRoomCount = 0;
    let dormBookingCount = 0;
    let earliestCheckin = list[0].checkin || "";
    let latestCheckout = list[0].checkout || "";

    for (const b of list) {
      totalAmount += parseVND(b.totalAmount);
      paidAmount += parseVND(b.paidAmount);
      remaining += getRemaining(b);
      totalNights += Math.max(0, diffNights(b.checkin, b.checkout) || 0);
      totalGuests += Number(b.guestCount) || 0;
      if (b.roomId === "DORM") dormBookingCount += 1;
      else regularRoomCount += 1;
      if (b.checkin && (!earliestCheckin || b.checkin < earliestCheckin)) earliestCheckin = b.checkin;
      if (b.checkout && (!latestCheckout || b.checkout > latestCheckout)) latestCheckout = b.checkout;
    }

    const paymentStatus = totalAmount === 0
      ? (list.every((b) => getPaymentStatus(b) === "paid") ? "paid" : "unpaid")
      : (remaining === 0 ? "paid" : paidAmount > 0 ? "deposit" : "unpaid");

    return {
      code: sanitizeText(list[0].bookingCode, 60),
      normalizedCode,
      bookings: list,
      roomCount: list.length,
      regularRoomCount,
      dormBookingCount,
      totalNights,
      totalGuests,
      totalAmount,
      paidAmount,
      remaining,
      paymentStatus,
      earliestCheckin,
      latestCheckout,
      leadGuestName: list[0].guestName || "",
      sourceName: list[0].sourceName || "",
      tourName: list.find((b) => b.tourName)?.tourName || ""
    };
  }

  function computeAllBookingGroups(bookings, options = {}) {
    const minRooms = Number.isInteger(options.minRooms) && options.minRooms >= 1 ? options.minRooms : 2;
    const codeSet = new Set();
    for (const b of Array.isArray(bookings) ? bookings : []) {
      const norm = normalizeGroupCode(b && b.bookingCode);
      if (norm) codeSet.add(norm);
    }
    const groups = [];
    for (const norm of codeSet) {
      const summary = computeBookingGroupSummary(bookings, norm);
      if (summary && summary.roomCount >= minRooms) {
        groups.push(summary);
      }
    }
    groups.sort((a, b) =>
      String(b.earliestCheckin || "").localeCompare(String(a.earliestCheckin || "")) ||
      b.remaining - a.remaining ||
      a.code.localeCompare(b.code)
    );
    return groups;
  }

  // Distribute ONE lump-sum deposit/payment cleanly across all rooms in a group without exceeding any room's totalAmount
  function allocateGroupPayment(groupBookings, targetGroupPaidRaw) {
    const list = (Array.isArray(groupBookings) ? groupBookings : [])
      .slice()
      .sort((a, b) => String(a.checkin || "").localeCompare(String(b.checkin || "")) || String(a.roomId || "").localeCompare(String(b.roomId || "")));

    if (list.length === 0) {
      return { ok: false, error: "Không tìm thấy phòng nào trong đoàn này." };
    }
    const groupTotal = list.reduce((s, b) => s + parseVND(b.totalAmount), 0);
    if (typeof targetGroupPaidRaw === "number" && targetGroupPaidRaw < 0) {
      return { ok: false, error: "Số tiền thu của đoàn không được âm." };
    }
    if (typeof targetGroupPaidRaw === "string" && targetGroupPaidRaw.trim().startsWith("-")) {
      return { ok: false, error: "Số tiền thu của đoàn không được âm." };
    }
    const targetPaid = parseVND(targetGroupPaidRaw);

    if (targetPaid < 0) {
      return { ok: false, error: "Số tiền thu của đoàn không được âm." };
    }
    if (groupTotal === 0 && targetPaid > 0) {
      return { ok: false, error: "Tổng tiền cả đoàn đang là 0 đ — vui lòng nhập tiền phòng trước khi thu tiền chung." };
    }
    if (targetPaid > groupTotal) {
      return { ok: false, error: `Số tiền thu chung (${formatVND(targetPaid)}) vượt quá tổng tiền cả đoàn (${formatVND(groupTotal)}).` };
    }

    let pool = targetPaid;
    const allocations = list.map((bk) => {
      const roomTotal = parseVND(bk.totalAmount);
      const oldPaid = parseVND(bk.paidAmount);
      const newPaid = Math.min(roomTotal, pool);
      pool = Math.max(0, pool - newPaid);
      return {
        id: bk.id,
        roomId: bk.roomId,
        guestName: bk.guestName,
        totalAmount: roomTotal,
        oldPaid,
        newPaid,
        changed: newPaid !== oldPaid,
        revision: Number(bk.revision) || 1
      };
    });

    return { ok: true, groupTotal, targetPaid, allocations };
  }

  // Build safe copy-paste payload preserving stay length, group code, guest & PDF, enforcing Twins-only mergeBed, and zeroing deposit to prevent double-counting
  function buildCopiedBookingPayload(sourceBooking, targetRoomId, targetCheckin, options = {}) {
    if (!sourceBooking || typeof sourceBooking !== "object") {
      return { ok: false, error: "Không có dữ liệu đặt phòng để dán." };
    }
    const targetRoom = getRoomById(targetRoomId);
    if (!targetRoom) {
      return { ok: false, error: `Phòng đích không hợp lệ: ${targetRoomId}` };
    }
    if (targetRoom.isDorm) {
      return { ok: false, error: "Vui lòng dùng sơ đồ 8 slot Dorm để đặt phòng Dorm nội bộ." };
    }
    if (!isValidISODate(targetCheckin)) {
      return { ok: false, error: "Ngày nhận phòng đích không hợp lệ." };
    }

    const nights = Math.max(1, diffNights(sourceBooking.checkin, sourceBooking.checkout) || 1);
    const targetCheckout = addDaysISO(targetCheckin, nights);
    const keepGroupCode = options.keepGroupCode !== false;
    const keepPaidAmount = options.keepPaidAmount === true;

    const payload = {
      roomId: targetRoom.id,
      bookingDate: isValidISODate(sourceBooking.bookingDate) ? sourceBooking.bookingDate : getTodayISO(),
      checkin: targetCheckin,
      checkout: targetCheckout,
      channelKey: sourceBooking.channelKey || detectChannelKey(sourceBooking.sourceName),
      sourceName: sourceBooking.sourceName || "",
      tourName: sourceBooking.tourName || "",
      bookingCode: keepGroupCode ? (sourceBooking.bookingCode || "") : "",
      guestName: sourceBooking.guestName || "",
      phone: sourceBooking.phone || "",
      guestCount: Math.min(12, Math.max(1, Number(sourceBooking.guestCount) || targetRoom.defaultGuests)),
      totalAmount: parseVND(sourceBooking.totalAmount),
      includeVat: Boolean(sourceBooking.includeVat),
      vatRate: sourceBooking.includeVat ? 8 : 0,
      preVatAmount: sourceBooking.includeVat ? parseVND(sourceBooking.preVatAmount || extractPreVatFromTotal(sourceBooking.totalAmount).preVatAmount) : parseVND(sourceBooking.totalAmount),
      vatAmount: sourceBooking.includeVat ? parseVND(sourceBooking.vatAmount || extractPreVatFromTotal(sourceBooking.totalAmount).vatAmount) : 0,
      paidAmount: keepPaidAmount ? parseVND(sourceBooking.paidAmount) : 0,
      paymentStatus: keepPaidAmount ? getPaymentStatus(sourceBooking) : "unpaid",
      mergeBed: targetRoom.type === "Twins" ? Boolean(sourceBooking.mergeBed) : false,
      extraBed: Math.min(2, Math.max(0, Number(sourceBooking.extraBed) || 0)),
      confirmedBy: sourceBooking.confirmedBy || "",
      confirmationPdf: sourceBooking.confirmationPdf ? { ...sourceBooking.confirmationPdf } : null,
      notes: sourceBooking.notes || ""
    };

    return { ok: true, payload, nights, targetRoom };
  }

  function samePdfAttachment(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.name === b.name && a.size === b.size && a.dataUrl === b.dataUrl;
  }

  // Build updated sibling payloads when any room in a group is edited.
  // Propagates all shared group info (bookingDate, bookingCode, channel/source/tour, guestName, phone, confirmedBy,
  // confirmationPdf, notes) to every sibling in the group while preserving each room's roomId, dates,
  // room pricing, deposit allocation, and bed options (and preserving separate Dorm driver name/phone unless matching).
  function buildGroupSyncUpdates(previousBooking, updatedBooking, allBookings) {
    if (!updatedBooking || typeof updatedBooking !== "object") return [];
    const newCodeNorm = normalizeGroupCode(updatedBooking.bookingCode);
    const oldCodeNorm = previousBooking ? normalizeGroupCode(previousBooking.bookingCode) : "";

    // If bookingCode was cleared to detach this room from the group, leave former siblings untouched
    if (!newCodeNorm) return [];

    const matchCode = oldCodeNorm || newCodeNorm;
    const list = Array.isArray(allBookings) ? allBookings : [];
    const updates = [];

    for (const sib of list) {
      if (!sib || sib.id === updatedBooking.id) continue;
      const sibNorm = normalizeGroupCode(sib.bookingCode);
      if (!sibNorm || (sibNorm !== matchCode && sibNorm !== newCodeNorm)) continue;

      const isDormSib = sib.roomId === "DORM";
      const next = {
        ...sib,
        bookingDate: isValidISODate(updatedBooking.bookingDate) ? updatedBooking.bookingDate : (sib.bookingDate || getTodayISO()),
        bookingCode: updatedBooking.bookingCode || "",
        channelKey: updatedBooking.channelKey || sib.channelKey,
        sourceName: updatedBooking.sourceName || sib.sourceName,
        tourName: updatedBooking.tourName !== undefined ? updatedBooking.tourName : (sib.tourName || ""),
        confirmedBy: updatedBooking.confirmedBy !== undefined ? updatedBooking.confirmedBy : (sib.confirmedBy || ""),
        confirmationPdf: updatedBooking.confirmationPdf ? { ...updatedBooking.confirmationPdf } : null
      };

      if (!isDormSib) {
        next.guestName = updatedBooking.guestName || sib.guestName;
        next.phone = updatedBooking.phone !== undefined ? updatedBooking.phone : (sib.phone || "");
        next.notes = updatedBooking.notes !== undefined ? updatedBooking.notes : (sib.notes || "");
      } else {
        // For Dorm siblings (HDV/driver), preserve separate driver name/phone/notes unless they previously matched the edited room
        if (previousBooking && sib.guestName === previousBooking.guestName && updatedBooking.guestName) {
          next.guestName = updatedBooking.guestName;
        }
        if (previousBooking && sib.phone === previousBooking.phone) {
          next.phone = updatedBooking.phone || "";
        }
        if (previousBooking && sib.notes === previousBooking.notes) {
          next.notes = updatedBooking.notes || "";
        }
      }

      const changed =
        next.bookingDate !== (sib.bookingDate || "") ||
        next.bookingCode !== (sib.bookingCode || "") ||
        next.channelKey !== (sib.channelKey || "") ||
        next.sourceName !== (sib.sourceName || "") ||
        next.tourName !== (sib.tourName || "") ||
        next.guestName !== (sib.guestName || "") ||
        next.phone !== (sib.phone || "") ||
        next.confirmedBy !== (sib.confirmedBy || "") ||
        next.notes !== (sib.notes || "") ||
        !samePdfAttachment(next.confirmationPdf, sib.confirmationPdf);

      if (changed) {
        updates.push({
          id: sib.id,
          roomId: sib.roomId,
          expectedRevision: Number(sib.revision) || 1,
          payload: next
        });
      }
    }

    return updates;
  }

  /* -------------------- Official Booking Confirmation (A4 PDF) Engine -------------------- */

  const CONFIRMATION_ROOM_ORDER = Object.freeze({
    "Double with balcony": 1,
    "Double with garden view": 2,
    "Twin with balcony": 3,
    "Twin with garden view": 4,
    "Family with balcony": 5,
    "Family with garden view": 6,
    "Triple room garden view": 7,
    "Extra Bed": 8,
    "Nội bộ ngủ Dorm": 9
  });

  function getConfirmationRoomCategoryName(room) {
    if (!room) return "Double with balcony";
    if (room.isDorm || room.id === "DORM") return "Nội bộ ngủ Dorm";
    const isValley = String(room.view || "").toLowerCase().includes("thung lũng");
    if (room.type === "Double") return isValley ? "Double with balcony" : "Double with garden view";
    if (room.type === "Twins") return isValley ? "Twin with balcony" : "Twin with garden view";
    if (room.type === "Family") return isValley ? "Family with balcony" : "Family with garden view";
    if (room.type === "Triple") return "Triple room garden view";
    return `${room.type || "Room"}${room.view ? ` (${room.view})` : ""}`;
  }

  function formatSenderNameForConfirmation(name) {
    const clean = String(name || "").trim();
    if (!clean) return "Mr. Trần Minh";
    if (/^(Mr|Ms|Mrs|Anh|Chị)\.?\s+/i.test(clean)) return clean;
    const female = ["Ngọc", "Tường Vi", "Lan Anh"];
    const male = ["Trần Minh", "Trần Bình"];
    if (female.includes(clean)) return `Ms. ${clean}`;
    if (male.includes(clean)) return `Mr. ${clean}`;
    return clean;
  }

  function formatConfirmationNumber(amount) {
    const num = Math.round(Number(amount) || 0);
    return num.toLocaleString("vi-VN");
  }

  function buildBookingConfirmationData(targetBooking, allBookings = [], options = {}) {
    if (!targetBooking || typeof targetBooking !== "object") return null;

    const discountPercent = Math.min(100, Math.max(0, Number(options.discountPercent) || 0));
    const extraBedRate = Math.max(0, parseVND(options.extraBedRate || 0));
    const vatOverride = options.vatOverride === 0 || options.vatOverride === 8 ? options.vatOverride : null;

    // Merge the latest live targetBooking into the bookings snapshot so unsaved edits appear immediately
    const baseList = Array.isArray(allBookings) ? allBookings.filter(Boolean) : [];
    const mergedList = targetBooking.id
      ? [
          targetBooking,
          ...baseList.filter((b) => b.id !== targetBooking.id)
        ]
      : [targetBooking, ...baseList];

    const normCode = normalizeGroupCode(targetBooking.bookingCode);
    const groupSiblings = normCode
      ? mergedList.filter((b) => normalizeGroupCode(b.bookingCode) === normCode)
      : [targetBooking];
    const isMultiRoomGroup = groupSiblings.length >= 2;
    const includeGroup = options.includeGroup !== undefined ? Boolean(options.includeGroup) : isMultiRoomGroup;
    const scopeBookings = (includeGroup && normCode) ? groupSiblings : [targetBooking];

    const leadRegular = targetBooking.roomId !== "DORM"
      ? targetBooking
      : (scopeBookings.find((b) => b.roomId !== "DORM") || targetBooking);
    const issueDateISO = isValidISODate(options.issueDateISO)
      ? options.issueDateISO
      : isValidISODate(targetBooking.bookingDate)
        ? targetBooking.bookingDate
        : isValidISODate(leadRegular && leadRegular.bookingDate)
          ? leadRegular.bookingDate
          : getTodayISO();
    const regularBookings = scopeBookings.filter((b) => b.roomId !== "DORM");
    const dormBookings = scopeBookings.filter((b) => b.roomId === "DORM");

    // Aggregate regular rooms by (checkin, checkout, roomCategory, unitPreVatRate)
    const regularGroups = new Map();
    let rawPreVatSum = 0;
    let rawVatSum = 0;
    let anyHasVat = false;
    let totalPaid = 0;
    let totalExtraBeds = 0;
    const extraBedGroups = new Map();

    for (const bk of regularBookings) {
      const room = getRoomById(bk.roomId) || { id: bk.roomId, type: "Double", view: "View thung lũng", defaultGuests: 2, isDorm: false };
      const category = getConfirmationRoomCategoryName(room);
      const nights = Math.max(1, diffNights(bk.checkin, bk.checkout) || 1);
      const totalAmt = parseVND(bk.totalAmount);
      const hasVat = Boolean(bk.includeVat);
      if (hasVat) anyHasVat = true;
      const preVat = hasVat
        ? Math.min(totalAmt, parseVND(bk.preVatAmount || extractPreVatFromTotal(totalAmt).preVatAmount))
        : totalAmt;
      const vatAmt = hasVat ? Math.max(0, totalAmt - preVat) : 0;
      const unitRate = Math.round(preVat / nights);
      const pax = Math.max(1, parseInt(bk.guestCount, 10) || room.defaultGuests || 2);
      const eb = Math.max(0, parseInt(bk.extraBed, 10) || 0);

      rawPreVatSum += preVat;
      rawVatSum += vatAmt;
      totalPaid += parseVND(bk.paidAmount);

      if (eb > 0) {
        totalExtraBeds += eb;
        const ebKey = `${bk.checkin}|${bk.checkout}`;
        if (!extraBedGroups.has(ebKey)) {
          extraBedGroups.set(ebKey, { checkin: bk.checkin, checkout: bk.checkout, nights, count: 0 });
        }
        extraBedGroups.get(ebKey).count += eb;
      }

      const key = `${bk.checkin}|${bk.checkout}|${category}|${unitRate}`;
      if (!regularGroups.has(key)) {
        regularGroups.set(key, {
          isDorm: false,
          isExtraBed: false,
          checkin: bk.checkin,
          checkout: bk.checkout,
          roomCategory: category,
          noOfRooms: 0,
          noOfNights: nights,
          noOfPax: 0,
          roomRate: unitRate,
          totalAmount: 0
        });
      }
      const row = regularGroups.get(key);
      row.noOfRooms += 1;
      row.noOfPax += pax;
      row.totalAmount += preVat;
    }

    const rows = [...regularGroups.values()].sort((a, b) =>
      String(a.checkin || "").localeCompare(String(b.checkin || "")) ||
      (CONFIRMATION_ROOM_ORDER[a.roomCategory] || 99) - (CONFIRMATION_ROOM_ORDER[b.roomCategory] || 99)
    );

    // Optional Extra Bed rows when extraBedRate > 0 (never double-counts by default when extraBedRate === 0)
    let extraBedSubtotal = 0;
    if (extraBedRate > 0 && extraBedGroups.size > 0) {
      for (const eb of extraBedGroups.values()) {
        const ebTotal = eb.count * eb.nights * extraBedRate;
        extraBedSubtotal += ebTotal;
        rows.push({
          isDorm: false,
          isExtraBed: true,
          checkin: eb.checkin,
          checkout: eb.checkout,
          roomCategory: "Extra Bed",
          noOfRooms: "",
          noOfNights: eb.nights,
          noOfPax: eb.count,
          roomRate: extraBedRate,
          totalAmount: ebTotal
        });
      }
    }

    // Dorm rows (Nội bộ ngủ Dorm)
    for (const bk of dormBookings) {
      const nights = Math.max(1, diffNights(bk.checkin, bk.checkout) || 1);
      const slotsCount = Array.isArray(bk.slots) && bk.slots.length > 0 ? bk.slots.length : Math.max(1, parseInt(bk.dormBeds, 10) || 1);
      const totalAmt = parseVND(bk.totalAmount);
      const hasVat = Boolean(bk.includeVat);
      if (hasVat) anyHasVat = true;
      const preVat = hasVat
        ? Math.min(totalAmt, parseVND(bk.preVatAmount || extractPreVatFromTotal(totalAmt).preVatAmount))
        : totalAmt;
      const vatAmt = hasVat ? Math.max(0, totalAmt - preVat) : 0;
      const unitRate = Math.round(preVat / (slotsCount * nights));

      rawPreVatSum += preVat;
      rawVatSum += vatAmt;
      totalPaid += parseVND(bk.paidAmount);

      rows.push({
        isDorm: true,
        isExtraBed: false,
        checkin: bk.checkin,
        checkout: bk.checkout,
        roomCategory: "Nội bộ ngủ Dorm",
        noOfRooms: "",
        noOfNights: nights,
        noOfPax: slotsCount,
        roomRate: unitRate,
        totalAmount: preVat
      });
    }

    rows.forEach((r, idx) => {
      r.stt = idx + 1;
      r.arrivalVN = formatDateVN(r.checkin);
      r.departureVN = formatDateVN(r.checkout);
    });

    const totalRooms = rows.reduce((s, r) => s + (typeof r.noOfRooms === "number" ? r.noOfRooms : 0), 0);
    const totalPax = rows.reduce((s, r) => s + (Number(r.noOfPax) || 0), 0);
    const subtotalAmount = rawPreVatSum + extraBedSubtotal;
    const discountAmount = discountPercent > 0 ? Math.round((subtotalAmount * discountPercent) / 100) : 0;
    const afterDiscount = Math.max(0, subtotalAmount - discountAmount);

    const vatPercent = vatOverride !== null ? vatOverride : (anyHasVat ? 8 : 0);
    let vatAmount = 0;
    if (vatPercent > 0) {
      vatAmount = (discountPercent === 0 && extraBedSubtotal === 0 && vatOverride === null && anyHasVat)
        ? rawVatSum
        : Math.round((afterDiscount * vatPercent) / 100);
    }

    const grandTotal = afterDiscount + vatAmount;
    const depositAmount = totalPaid;
    const depositPercent = grandTotal > 0 ? Math.round((depositAmount / grandTotal) * 100) : 0;
    const paymentLeft = Math.max(0, grandTotal - depositAmount);

    const recipientName = String(leadRegular.guestName || "").trim() || "Ms/Mr";
    const unitName = String(
      leadRegular.tourName ||
      (leadRegular.channelKey === "walkin" ? "" : (leadRegular.sourceName || ""))
    ).trim();
    const bookingCode = String(leadRegular.bookingCode || "").trim();
    const senderName = formatSenderNameForConfirmation(options.senderName !== undefined ? options.senderName : leadRegular.confirmedBy);

    return {
      issueDateISO,
      issueDateVN: formatDateVN(issueDateISO),
      recipientName,
      unitName,
      bookingCode,
      transferNote: bookingCode || recipientName,
      senderName,
      isMultiRoomGroup,
      includeGroup,
      groupRoomCount: groupSiblings.length,
      totalExtraBeds,
      extraBedRate,
      rows,
      totalRooms,
      totalPax,
      subtotalAmount,
      discountPercent,
      discountAmount,
      vatPercent,
      vatAmount,
      grandTotal,
      depositPercent,
      depositAmount,
      paymentLeft
    };
  }

  function renderBookingConfirmationHtml(data, options = {}) {
    if (!data) return "";
    const rowsHtml = data.rows.map((r) => `
      <tr>
        <td class="c-center">${r.stt}</td>
        <td class="c-center">${escapeHtml(r.arrivalVN)}</td>
        <td class="c-center">${escapeHtml(r.departureVN)}</td>
        <td class="c-center">${escapeHtml(r.roomCategory)}</td>
        <td class="c-center">${r.noOfRooms === "" ? "" : r.noOfRooms}</td>
        <td class="c-center">${r.noOfNights}</td>
        <td class="c-center">${r.noOfPax}</td>
        <td class="c-right">${formatConfirmationNumber(r.roomRate)}</td>
        <td class="c-right">${formatConfirmationNumber(r.totalAmount)}</td>
      </tr>`).join("");

    const vatClause = data.vatPercent > 0
      ? "Giá phòng đã bao gồm VAT, đã bao gồm phí phục vụ/ Rates includes VAT, include service charge."
      : "Giá phòng chưa bao gồm VAT, đã bao gồm phí phục vụ/ Rates excludes VAT, includes service charge.";

    const sheetInner = `
    <div class="bc-sheet">
      <div class="bc-top-head">
        <div class="bc-hotel-brand">DONGVAN VILLE DU H'MONG HOTEL</div>
        <div class="bc-hotel-stars">------***------</div>
        <div class="bc-hotel-line"><strong>Địa chỉ (Address):</strong> Tổ 5, xã Đồng Văn, tỉnh Tuyên Quang/Group 5, Dong Van Town, Tuyen Quang Province</div>
        <div class="bc-hotel-line"><strong>Điện thoại (Tel):</strong> 0219.3856885 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <strong>Email:</strong> Dongvanvilleduhmong@gmail.com</div>
      </div>

      <div class="bc-date-line">Hà Nội, ngày &nbsp;&nbsp;${escapeHtml(data.issueDateVN)}</div>
      <div class="bc-doc-title">XÁC NHẬN ĐẶT PHÒNG (BOOKING CONFIRMATION)</div>

      <table class="bc-meta-table">
        <tr>
          <td class="bc-meta-lbl">Người nhận:</td>
          <td class="bc-meta-val"><strong>${escapeHtml(data.recipientName)}</strong></td>
          <td class="bc-meta-lbl-r">Người gửi: <strong>${escapeHtml(data.senderName)}</strong></td>
        </tr>
        <tr>
          <td class="bc-meta-lbl">Đơn vị:</td>
          <td class="bc-meta-val">${escapeHtml(data.unitName)}</td>
          <td class="bc-meta-lbl-r">Điện thoại: 0912122721 - 0912251169</td>
        </tr>
        <tr>
          <td class="bc-meta-lbl">Mã số đặt phòng/Code:</td>
          <td class="bc-meta-val"><strong>${escapeHtml(data.bookingCode)}</strong></td>
          <td class="bc-meta-lbl-r">Email: Dongvanvilleduhmong@gmail.com</td>
        </tr>
      </table>

      <div class="bc-greet-vi">LỜI CHÀO NỒNG NHIỆT NHẤT TỪ DONGVAN VILLE DU H'MONG HOTEL</div>
      <div class="bc-greet-en">WARMEST GREETINGS FROM DONGVAN VILLE DU H'MONG HOTEL</div>

      <div class="bc-salutation">Kính gửi: &nbsp;${escapeHtml(data.recipientName)}</div>
      <div class="bc-intro">
        Xin chân thành cảm ơn sự quan tâm của Quý khách đến với DongVan Ville Du H'Mong Hotel. Chúng tôi xin xác nhận đặt phòng của Quý đơn vị như sau/We sincerely thank you for your interest in DongVan Ville Du H'Mong Hotel. We are to confirm your reservation as below:
      </div>
      <div class="bc-unit">ĐVT: VNĐ</div>

      <table class="bc-price-table">
        <thead>
          <tr>
            <th style="width:4.5%;">STT</th>
            <th style="width:11.5%;">Arrival date<br><i>Ngày đến</i></th>
            <th style="width:11.5%;">Departure date<br><i>Ngày đi</i></th>
            <th style="width:23.5%;">Room category<br><i>Loại phòng</i></th>
            <th style="width:9.5%;">No of rooms<br><i>Số lượng</i></th>
            <th style="width:8.5%;">No of nights<br><i>Số đêm</i></th>
            <th style="width:8.5%;">No of pax<br><i>Số khách</i></th>
            <th style="width:11%;">Room rate<br><i>Đơn giá</i></th>
            <th style="width:11.5%;">Total amount<br><i>Thành tiền</i></th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
          <tr class="bc-sum-row">
            <td colspan="4" class="c-center"><strong><i>Total amount/ Tổng</i></strong></td>
            <td class="c-center"><strong>${data.totalRooms || ""}</strong></td>
            <td></td>
            <td class="c-center"><strong>${data.totalPax}</strong></td>
            <td></td>
            <td class="c-right"><strong>${formatConfirmationNumber(data.subtotalAmount)}</strong></td>
          </tr>
          <tr class="bc-sum-row">
            <td colspan="4" class="c-center"><i>Discount/ Chiết khấu</i></td>
            <td class="c-center"><i>${data.discountPercent}%</i></td>
            <td></td>
            <td></td>
            <td></td>
            <td class="c-right">${formatConfirmationNumber(data.discountAmount)}</td>
          </tr>
          <tr class="bc-sum-row">
            <td colspan="4" class="c-center"><i>Tax VAT/ VAT</i></td>
            <td class="c-center"><i>${data.vatPercent}%</i></td>
            <td></td>
            <td></td>
            <td></td>
            <td class="c-right">${formatConfirmationNumber(data.vatAmount)}</td>
          </tr>
          <tr class="bc-sum-row">
            <td colspan="4" class="c-center">Total amount/ Tổng</td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td class="c-right"><strong>${formatConfirmationNumber(data.grandTotal)}</strong></td>
          </tr>
          <tr class="bc-sum-row">
            <td colspan="4" class="c-center"><i>Deposit/ Đặt cọc</i></td>
            <td class="c-center"><i>${data.depositPercent}%</i></td>
            <td></td>
            <td></td>
            <td></td>
            <td class="c-right">${formatConfirmationNumber(data.depositAmount)}</td>
          </tr>
          <tr class="bc-payleft-row">
            <td colspan="4" class="c-center"><strong>Payment left/ Còn phải thanh toán</strong></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td class="c-right"><strong>${formatConfirmationNumber(data.paymentLeft)}</strong></td>
          </tr>
        </tbody>
      </table>

      <div class="bc-section">
        <div class="bc-sec-title">1. Đặt cọc, thanh toán/Deposit, Payment:</div>
        <p class="bc-p">Quý khách hàng vui lòng thanh toán tiền đặt cọc phòng khi nhận được Xác nhận đặt phòng ngày ${escapeHtml(data.issueDateVN)}. Đề nghị thanh toán 100% giá trị phòng trước khi nhận phòng tại khách sạn/Please settle all amount of room rates before arrival date.</p>
        <table class="bc-bank-table">
          <tr>
            <td style="width:28%;">- Ngân hàng (Bank):</td>
            <td colspan="3">Ngân hàng Thương mại Cổ phần Đầu tư và Phát triển Việt Nam (BIDV)</td>
          </tr>
          <tr>
            <td>- Chủ tài khoản (Account holder):</td>
            <td colspan="3" class="bc-red"><strong>Công ty cổ phần phát triển đầu tư ABT Việt Nam</strong></td>
          </tr>
          <tr>
            <td>- Số tài khoản (Account number):</td>
            <td class="bc-red" style="width:24%;"><strong>8695558888</strong></td>
            <td style="width:17%;">- Nội dung CK:</td>
            <td class="bc-red"><strong>${escapeHtml(data.transferNote)}</strong></td>
          </tr>
        </table>
        <p class="bc-p bc-red"><strong><i>* Sau 01 ngày kể từ ngày xác nhận đặt phòng Quý khách chưa hoàn tất thanh toán tiền đặt cọc, DVM Hotel xin phép không xếp phòng theo Xác nhận đặt phòng đã gửi!</i></strong></p>
      </div>

      <div class="bc-section">
        <div class="bc-sec-title">2. Giá phòng bao gồm/Room rate includes:</div>
        <p class="bc-p">- ${escapeHtml(vatClause)}</p>
        <p class="bc-p">- Miễn phí: (i) Nước chào mừng khi làm thủ tục nhận phòng/Welcome drink upon check-in. (ii) Hỗ trợ ăn sáng, 2 chai nước lọc, trà hoặc cà phê mỗi ngày/Daily complimentary breakfast, 2 bottles of mineral water, tea or coffee.</p>
        <p class="bc-p">- Miễn phí tiền phòng và ăn sáng cho trẻ em dưới 6 tuổi lưu trú cùng bố mẹ, tối đa 1 trẻ/phòng - không đặt thêm giường phụ/Free accomodation and breakfast for children under 6 years old sharing with parents, maximum 1 children/room.- No extra bed required.</p>
        <p class="bc-p">- Thu phí 100.000 VNĐ cho Trẻ em từ 6 tuổi đến 12 tuổi lưu trú cùng bố mẹ, tối đa 1 trẻ/phòng - không đặt thêm giường phụ/Fee of 100.000 VND for Children from 6 years old to 12 years old staying with parents, maximum 1 child/room - no extra bed required</p>
      </div>

      <div class="bc-section">
        <div class="bc-sec-title">3. Lưu ý/Remarks:</div>
        <p class="bc-p">- Lễ tân Khách sạn: 0972647172 - 0219.3856885</p>
        <p class="bc-p">- Thời gian nhận phòng là 14:00pm và thời gian trả phòng là 12:00pm/Kindly note that the check-in time is 14:00pm and check-out time is 12:00pm.</p>
        <p class="bc-p">- Thời gian ăn sáng tại Tầng 5 từ 6:30am đến 9:00am/Breakfast time is from 6:30am to 9:00am (on 5 Floor).</p>
        <p class="bc-p">- Hủy phòng: Báo hủy 40 ngày trước ngày check in: Miễn phí; Báo hủy từ 20 đến 40 ngày trước ngày check in: Phí hủy bằng 50% giá phòng hủy; Báo hủy trước 20 ngày checkin: Phí hủy bằng 100% giá phòng hủy.</p>
      </div>

      <div class="bc-footer-sign">
        <div class="bc-red"><strong>DONGVAN VILLE DU H'MONG HOTEL</strong></div>
        <div><strong>Rất hân hạnh được chào đón Quý khách!</strong></div>
      </div>
    </div>`;

    if (!options.standalone) return sheetInner;

    const titleCode = data.bookingCode || data.recipientName || "Dongvan-Hotel";
    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Xac-nhan-dat-phong-${escapeHtml(titleCode)}</title>
<style>
  @page { size: A4 portrait; margin: 7mm 9mm; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px; background: #f3f4f6; font-family: "Times New Roman", Times, Georgia, serif; color: #111; }
  .bc-standalone-bar { max-width: 210mm; margin: 0 auto 10px; display: flex; justify-content: flex-end; gap: 8px; }
  .bc-standalone-btn { padding: 8px 14px; border-radius: 6px; border: 0; background: #1d4ed8; color: #fff; font-weight: 700; cursor: pointer; font-family: system-ui, sans-serif; }
  .bc-sheet { width: 100%; max-width: 210mm; margin: 0 auto; background: #fff; padding: 8mm 10mm; font-family: "Times New Roman", Times, Georgia, serif; font-size: 9.3pt; line-height: 1.24; color: #000; box-shadow: 0 2px 12px rgba(0,0,0,0.12); }
  .bc-top-head { max-width: 68%; }
  .bc-hotel-brand { text-align: center; color: #c00000; font-weight: 700; font-size: 10.8pt; letter-spacing: 0.2px; }
  .bc-hotel-stars { text-align: center; color: #c00000; font-weight: 700; font-size: 9.2pt; margin-bottom: 2px; }
  .bc-hotel-line { font-size: 8.8pt; line-height: 1.24; }
  .bc-date-line { text-align: right; font-style: italic; font-size: 9pt; margin: 1px 0 3px; }
  .bc-doc-title { text-align: center; font-weight: 700; font-size: 10.8pt; margin: 1px 0 4px; }
  .bc-meta-table { width: 100%; border-collapse: collapse; font-size: 9.2pt; margin-bottom: 4px; }
  .bc-meta-table td { padding: 1px 4px; vertical-align: top; }
  .bc-meta-lbl { width: 22%; }
  .bc-meta-val { width: 38%; }
  .bc-meta-lbl-r { width: 40%; }
  .bc-greet-vi { text-align: center; font-weight: 700; font-size: 9.8pt; margin-top: 1px; }
  .bc-greet-en { text-align: center; font-style: italic; font-size: 9pt; margin-bottom: 3px; }
  .bc-salutation { font-weight: 700; margin: 2px 0 2px 14px; }
  .bc-intro { text-indent: 14px; margin-bottom: 1px; }
  .bc-unit { text-align: right; font-style: italic; font-size: 8.6pt; margin-bottom: 2px; }
  .bc-price-table { width: 100%; border-collapse: collapse; font-size: 8.8pt; margin-bottom: 4px; }
  .bc-price-table th, .bc-price-table td { border: 1px solid #000; padding: 2px 4px; }
  .bc-price-table thead th { background: #ffc000; font-weight: 700; text-align: center; vertical-align: middle; line-height: 1.2; }
  .bc-price-table .c-center { text-align: center; }
  .bc-price-table .c-right { text-align: right; font-variant-numeric: tabular-nums; }
  .bc-sum-row td { background: #e2efda; }
  .bc-payleft-row td { background: #ffc000; font-weight: 700; }
  .bc-section { margin-top: 4px; }
  .bc-sec-title { font-weight: 700; margin-left: 14px; margin-bottom: 1px; }
  .bc-p { margin: 1.2px 0; text-align: justify; }
  .bc-bank-table { width: 100%; border-collapse: collapse; margin: 2px 0; font-size: 9pt; }
  .bc-bank-table td { padding: 1px 4px; vertical-align: top; }
  .bc-red { color: #c00000; }
  .bc-footer-sign { margin-top: 6px; text-align: center; width: 42%; margin-left: auto; font-size: 9.5pt; line-height: 1.28; }
  @media print {
    body { background: #fff; padding: 0; }
    .bc-standalone-bar { display: none !important; }
    .bc-sheet { box-shadow: none; padding: 0; max-width: none; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  }
</style>
</head>
<body>
  <div class="bc-standalone-bar">
    <button class="bc-standalone-btn" onclick="window.print()">🖨️ In / Lưu thành PDF (A4)</button>
  </div>
  ${sheetInner}
</body>
</html>`;
  }

  function generateCsvContent(bookings) {
    const headers = [
      "Phòng", "Tầng", "Hạng phòng", "View", "Ngày đặt", "Ngày nhận", "Ngày trả", "Số đêm",
      "Đơn vị book", "Tên tour", "Mã đặt phòng", "Tên khách", "Số điện thoại",
      "Số khách / Slot Dorm", "Tổng tiền (VNĐ)", "VAT 8%", "Đã thanh toán/Cọc (VNĐ)", "Còn lại (VNĐ)",
      "Ghép giường", "Extra bed", "Người xác nhận", "Xác nhận PDF", "Ghi chú"
    ];

    const rows = bookings
      .slice()
      .sort((a, b) => String(a.checkin || "").localeCompare(String(b.checkin || "")) || String(a.roomId || "").localeCompare(String(b.roomId || "")))
      .map((b) => {
        const r = getRoomById(b.roomId) || { name: b.roomId, floor: "", type: "", view: "", isDorm: false };
        const slotDesc = r.isDorm ? `Slot ${(b.slots || []).join(", ")} (${b.dormBeds || (b.slots || []).length} chỗ)` : b.guestCount;
        const pdfLabel = b.confirmationPdf && b.confirmationPdf.name ? b.confirmationPdf.name : "";
        const vatLabel = b.includeVat ? `Có (+${parseVND(b.vatAmount)})` : "Không";
        return [
          r.name, r.floor, r.type, r.view, b.bookingDate || "", b.checkin, b.checkout, diffNights(b.checkin, b.checkout),
          b.sourceName, b.tourName || "", b.bookingCode || "", b.guestName, b.phone,
          slotDesc, parseVND(b.totalAmount), vatLabel, parseVND(b.paidAmount), getRemaining(b),
          b.mergeBed ? "Có" : "Không", b.extraBed || 0, b.confirmedBy || "", pdfLabel, b.notes || ""
        ];
      });

    const csvLines = [headers, ...rows].map((row) => row.map(sanitizeCsvCell).join(","));
    return "\uFEFF" + csvLines.join("\r\n");
  }

  function diffBookingChanges(before, after) {
    if (!before || !after) return [];
    const changes = [];
    const pushIfDiff = (label, oldVal, newVal) => {
      const a = String(oldVal ?? "");
      const b = String(newVal ?? "");
      if (a !== b) changes.push({ field: label, before: a || "(trống)", after: b || "(trống)" });
    };

    const oldRoom = getRoomById(before.roomId);
    const newRoom = getRoomById(after.roomId);
    pushIfDiff("Phòng", oldRoom ? oldRoom.name : before.roomId, newRoom ? newRoom.name : after.roomId);
    pushIfDiff("Ngày đặt", formatDateVN(before.bookingDate), formatDateVN(after.bookingDate));
    pushIfDiff("Ngày nhận", formatDateVN(before.checkin), formatDateVN(after.checkin));
    pushIfDiff("Ngày trả", formatDateVN(before.checkout), formatDateVN(after.checkout));
    pushIfDiff("Nguồn đặt", before.sourceName || "", after.sourceName || "");
    pushIfDiff("Tên tour", before.tourName || "", after.tourName || "");
    pushIfDiff("Mã đặt phòng", before.bookingCode || "", after.bookingCode || "");
    pushIfDiff("Khách", before.guestName || "", after.guestName || "");
    pushIfDiff("SĐT", before.phone || "", after.phone || "");
    if (before.roomId === "DORM" || after.roomId === "DORM") {
      pushIfDiff("Slot Dorm", (before.slots || []).join(", "), (after.slots || []).join(", "));
    } else {
      pushIfDiff("Số khách", Number(before.guestCount) || 0, Number(after.guestCount) || 0);
      pushIfDiff("Ghép giường", before.mergeBed ? "Có" : "Không", after.mergeBed ? "Có" : "Không");
      pushIfDiff("Extra bed", Number(before.extraBed) || 0, Number(after.extraBed) || 0);
    }
    pushIfDiff("Tổng tiền", formatVND(before.totalAmount), formatVND(after.totalAmount));
    pushIfDiff("VAT 8%", before.includeVat ? `Có (+${formatVND(before.vatAmount)})` : "Không", after.includeVat ? `Có (+${formatVND(after.vatAmount)})` : "Không");
    pushIfDiff("Đã TT/Cọc", formatVND(before.paidAmount), formatVND(after.paidAmount));
    pushIfDiff("Người xác nhận", before.confirmedBy || "", after.confirmedBy || "");
    const oldPdf = before.confirmationPdf && before.confirmationPdf.name ? `${before.confirmationPdf.name} (${formatFileSize(before.confirmationPdf.size)})` : "";
    const newPdf = after.confirmationPdf && after.confirmationPdf.name ? `${after.confirmationPdf.name} (${formatFileSize(after.confirmationPdf.size)})` : "";
    pushIfDiff("Xác nhận PDF", oldPdf, newPdf);
    pushIfDiff("Ghi chú", before.notes || "", after.notes || "");
    return changes;
  }

  function generateAuditCsvContent(auditLogs) {
    const headers = [
      "Thời gian", "Thao tác", "Phòng", "Khách hàng", "Người xác nhận",
      "Tóm tắt", "Chi tiết thay đổi", "Mã sao lưu tự động"
    ];
    const rows = (Array.isArray(auditLogs) ? auditLogs : []).map((log) => {
      const diffStr = Array.isArray(log.changes) && log.changes.length > 0
        ? log.changes.map((c) => `${c.field}: ${c.before} -> ${c.after}`).join(" | ")
        : "";
      return [
        log.ts || "",
        log.action || "",
        log.roomId || "",
        log.guestName || "",
        log.confirmedBy || "",
        log.summary || "",
        diffStr,
        log.snapshotId || ""
      ];
    });
    const csvLines = [headers, ...rows].map((row) => row.map(sanitizeCsvCell).join(","));
    return "\uFEFF" + csvLines.join("\r\n");
  }

  function createSampleBookings(baseDateISO) {
    const base = isValidISODate(baseDateISO) ? baseDateISO : getTodayISO();
    const nowISO = new Date().toISOString();
    return [
      { id: "bk_sample_1", roomId: "102", checkin: addDaysISO(base, -1), checkout: addDaysISO(base, 2), channelKey: "booking", sourceName: "Booking.com", tourName: "", bookingCode: "4829103847", guestName: "Nguyễn Minh Quân", phone: "0912 456 789", guestCount: 2, dormBeds: 0, totalAmount: 2700000, paidAmount: 2700000, paymentStatus: "paid", mergeBed: true, extraBed: 0, confirmedBy: "Ngọc", notes: "Khách yêu cầu ghép 2 giường đơn thành 1 giường đôi. Ăn buffet sáng tầng 5 lúc 7h30.", revision: 1, createdAt: nowISO, updatedAt: nowISO },
      { id: "bk_sample_2", roomId: "101", checkin: base, checkout: addDaysISO(base, 3), channelKey: "agoda", sourceName: "Agoda", tourName: "", bookingCode: "129384756", guestName: "Trần Thị Mai Hương", phone: "0988 221 334", guestCount: 2, dormBeds: 0, totalAmount: 2850000, paidAmount: 1000000, paymentStatus: "deposit", mergeBed: false, extraBed: 0, confirmedBy: "Tường Vi", notes: "Đã chuyển khoản cọc 1 triệu, thu phần còn lại khi check-in.", revision: 1, createdAt: nowISO, updatedAt: nowISO },
      { id: "bk_sample_3", roomId: "201", checkin: base, checkout: addDaysISO(base, 2), channelKey: "zalo", sourceName: "Zalo", tourName: "", bookingCode: "ZL-2111-01", guestName: "Gia đình anh Hoàng Nam", phone: "0904 778 912", guestCount: 4, dormBeds: 0, totalAmount: 3200000, paidAmount: 1500000, paymentStatus: "deposit", mergeBed: false, extraBed: 1, confirmedBy: "Trần Bình", notes: "Kê thêm 1 extra bed cho bé lớn. Có trẻ em 6 tuổi ăn buffet sáng.", revision: 1, createdAt: nowISO, updatedAt: nowISO },
      { id: "bk_sample_4", roomId: "204", checkin: addDaysISO(base, 1), checkout: addDaysISO(base, 4), channelKey: "tour", sourceName: "Gmail Vietravel", tourName: "Vietravel", bookingCode: "VR-2026-204", guestName: "Đoàn chị Lan Anh (3 khách)", phone: "0977 112 889", guestCount: 3, dormBeds: 0, totalAmount: 4200000, paidAmount: 4200000, paymentStatus: "paid", mergeBed: false, extraBed: 0, confirmedBy: "Lan Anh", notes: "Công ty tour đã thanh toán chuyển khoản công ty. Xuất hóa đơn VAT.", revision: 1, createdAt: nowISO, updatedAt: nowISO },
      { id: "bk_sample_5", roomId: "303", checkin: addDaysISO(base, -2), checkout: addDaysISO(base, 1), channelKey: "airbnb", sourceName: "Airbnb", tourName: "", bookingCode: "HM4K9X2P8Q", guestName: "David Miller", phone: "+84 934 556 771", guestCount: 2, dormBeds: 0, totalAmount: 2900000, paidAmount: 2900000, paymentStatus: "paid", mergeBed: true, extraBed: 0, confirmedBy: "Trần Minh", notes: "Vegetarian breakfast request at Floor 5. Late check-out 13:00.", revision: 1, createdAt: nowISO, updatedAt: nowISO },
      { id: "bk_sample_6", roomId: "404", checkin: base, checkout: addDaysISO(base, 2), channelKey: "walkin", sourceName: "Khách lẻ", tourName: "", bookingCode: "KL-2111-04", guestName: "Lê Quốc Bảo", phone: "0963 880 124", guestCount: 3, dormBeds: 0, totalAmount: 3000000, paidAmount: 0, paymentStatus: "unpaid", mergeBed: false, extraBed: 0, confirmedBy: "Ngọc", notes: "Khách đi xe riêng, check-in khoảng 18h tối. Thanh toán tiền mặt khi nhận phòng.", revision: 1, createdAt: nowISO, updatedAt: nowISO },
      { id: "bk_sample_7", roomId: "402", checkin: addDaysISO(base, 2), checkout: addDaysISO(base, 5), channelKey: "other", sourceName: "Traveloka", tourName: "", bookingCode: "TVK-993812", guestName: "Phạm Thu Hà", phone: "0919 332 456", guestCount: 2, dormBeds: 0, totalAmount: 2650000, paidAmount: 1000000, paymentStatus: "deposit", mergeBed: false, extraBed: 0, confirmedBy: "Tường Vi", notes: "Giữ nguyên 2 giường đơn, cần thêm gối mềm.", revision: 1, createdAt: nowISO, updatedAt: nowISO },
      { id: "bk_sample_8", roomId: "DORM", checkin: base, checkout: addDaysISO(base, 3), channelKey: "tour", sourceName: "Gmail Vietravel", tourName: "Vietravel", bookingCode: "VR-2026-204", guestName: "Anh Hùng (HDV) + Anh Tuấn (Lái xe)", phone: "0915 667 432", guestCount: 2, dormBeds: 2, slots: [1, 3], totalAmount: 600000, paidAmount: 600000, paymentStatus: "paid", mergeBed: false, extraBed: 0, confirmedBy: "Trần Bình", notes: "2 chỗ giường tầng dưới cho HDV và lái xe đoàn 204.", revision: 1, createdAt: nowISO, updatedAt: nowISO },
      { id: "bk_sample_9", roomId: "DORM", checkin: base, checkout: addDaysISO(base, 2), channelKey: "tour", sourceName: "Gmail Saigontourist", tourName: "Saigontourist", bookingCode: "SGT-1121-09", guestName: "Anh Phong (Lái xe 45 chỗ)", phone: "0908 119 220", guestCount: 1, dormBeds: 1, slots: [5], totalAmount: 200000, paidAmount: 0, paymentStatus: "unpaid", mergeBed: false, extraBed: 0, confirmedBy: "Lan Anh", notes: "Đỗ xe bãi trước sảnh, thanh toán sáng hôm sau.", revision: 1, createdAt: nowISO, updatedAt: nowISO }
    ];
  }

  /* -------------------- Transactional Store (CAS + Read-Back Verify + Strict Read + Corruption Safe-Mode + Audit) -------------------- */

  function runWithCrossTabLock(fn, lockName = LOCK_KEY) {
    if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
      return navigator.locks.request(lockName, async () => fn());
    }
    return Promise.resolve().then(() => fn());
  }

  /* -------------------- Operating Costs & COGS Engine (Chi phí vận hành & Giá vốn) -------------------- */

  const COST_CALC_MODES = Object.freeze({
    guest_night: Object.freeze({ key: "guest_night", label: "Theo khách-đêm", unitLabel: "đ / khách-đêm" }),
    room_night: Object.freeze({ key: "room_night", label: "Theo đêm phòng", unitLabel: "đ / đêm phòng" }),
    monthly: Object.freeze({ key: "monthly", label: "Theo tháng", unitLabel: "đ / tháng" })
  });

  const DEFAULT_COST_ITEMS = Object.freeze([
    { id: "ci_room_amenities", name: "Đồ dùng phòng", calcMode: "room_night", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_minibar_free", name: "Minibar miễn phí", calcMode: "guest_night", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_breakfast", name: "Ăn sáng", calcMode: "guest_night", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_laundry", name: "Giặt là", calcMode: "room_night", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_booking_fee", name: "Phí Booking", calcMode: "monthly", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_electricity", name: "Điện", calcMode: "monthly", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_water", name: "Nước", calcMode: "monthly", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_internet", name: "Internet", calcMode: "monthly", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_salary", name: "Lương", calcMode: "monthly", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_maintenance", name: "Sửa chữa", calcMode: "monthly", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_depreciation", name: "Khấu hao", calcMode: "monthly", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] },
    { id: "ci_tools", name: "Công cụ dụng cụ", calcMode: "monthly", active: true, rateHistory: [{ effectiveMonth: "2020-01", rate: 0 }] }
  ]);

  function isValidMonthKey(val) {
    return typeof val === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(val.trim());
  }

  function formatMonthVN(monthKey) {
    if (!isValidMonthKey(monthKey)) return String(monthKey || "");
    const [y, m] = monthKey.split("-");
    return `${m}/${y}`;
  }

  function getCurrentMonthKey() {
    return getTodayISO().slice(0, 7);
  }

  function createDefaultOperatingCostsState() {
    return {
      version: 1,
      items: DEFAULT_COST_ITEMS.map((it) => ({
        id: it.id,
        name: it.name,
        calcMode: it.calcMode,
        active: true,
        isDefault: true,
        rateHistory: it.rateHistory.map((r) => ({ effectiveMonth: r.effectiveMonth, rate: r.rate }))
      })),
      actualEntries: [],
      monthlyFinalized: {},
      updatedAt: new Date().toISOString()
    };
  }

  function sanitizeRateHistory(rawHistory) {
    const byMonth = new Map();
    if (Array.isArray(rawHistory)) {
      for (const h of rawHistory) {
        if (!h || typeof h !== "object") continue;
        const em = String(h.effectiveMonth || "").trim();
        if (!isValidMonthKey(em)) continue;
        const rate = Math.min(MAX_AMOUNT_VND, Math.max(0, parseVND(h.rate)));
        byMonth.set(em, { effectiveMonth: em, rate });
      }
    }
    if (byMonth.size === 0) {
      byMonth.set("2020-01", { effectiveMonth: "2020-01", rate: 0 });
    }
    return [...byMonth.values()].sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth));
  }

  function sanitizeOperatingCostsState(raw) {
    const fallback = createDefaultOperatingCostsState();
    if (!raw || typeof raw !== "object") return fallback;
    const obj = stripDangerousKeys(raw);

    const seenItemIds = new Set();
    const items = [];
    if (Array.isArray(obj.items) && obj.items.length > 0) {
      for (const it of obj.items) {
        if (!it || typeof it !== "object") continue;
        const id = sanitizeText(it.id, 64);
        const name = sanitizeText(it.name, 100);
        if (!id || !name || seenItemIds.has(id)) continue;
        const calcMode = COST_CALC_MODES[it.calcMode] ? it.calcMode : "monthly";
        seenItemIds.add(id);
        items.push({
          id,
          name,
          calcMode,
          active: it.active !== false,
          isDefault: Boolean(it.isDefault),
          rateHistory: sanitizeRateHistory(it.rateHistory)
        });
      }
    }
    // Ensure all 12 default items exist if items array was empty
    if (items.length === 0) {
      for (const def of fallback.items) {
        seenItemIds.add(def.id);
        items.push(def);
      }
    }

    const actualEntries = [];
    const seenEntryIds = new Set();
    if (Array.isArray(obj.actualEntries)) {
      for (const ent of obj.actualEntries) {
        if (!ent || typeof ent !== "object") continue;
        const id = sanitizeText(ent.id, 64) || `ce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        if (seenEntryIds.has(id)) continue;
        const itemId = sanitizeText(ent.itemId, 64);
        const accountingMonth = String(ent.accountingMonth || "").trim();
        if (!itemId || !isValidMonthKey(accountingMonth)) continue;
        const expenseDate = isValidISODate(ent.expenseDate) ? ent.expenseDate : `${accountingMonth}-01`;
        const amount = Math.min(MAX_AMOUNT_VND, Math.max(0, parseVND(ent.amount)));
        seenEntryIds.add(id);
        actualEntries.push({
          id,
          itemId,
          expenseDate,
          accountingMonth,
          amount,
          note: sanitizeText(ent.note, 240),
          createdBy: sanitizeText(ent.createdBy, 60),
          createdAt: typeof ent.createdAt === "string" ? ent.createdAt : new Date().toISOString(),
          ...(typeof ent.updatedAt === "string" ? { updatedAt: ent.updatedAt } : {})
        });
      }
    }

    const monthlyFinalized = {};
    if (obj.monthlyFinalized && typeof obj.monthlyFinalized === "object") {
      for (const [mKey, itemMap] of Object.entries(obj.monthlyFinalized)) {
        if (!isValidMonthKey(mKey) || !itemMap || typeof itemMap !== "object") continue;
        const cleanMap = {};
        for (const [iId, meta] of Object.entries(itemMap)) {
          const cleanId = sanitizeText(iId, 64);
          if (!cleanId || !meta || typeof meta !== "object") continue;
          if (meta.finalized) {
            cleanMap[cleanId] = {
              finalized: true,
              finalizedAt: typeof meta.finalizedAt === "string" ? meta.finalizedAt : new Date().toISOString(),
              finalizedBy: sanitizeText(meta.finalizedBy, 60)
            };
          }
        }
        if (Object.keys(cleanMap).length > 0) monthlyFinalized[mKey] = cleanMap;
      }
    }

    return {
      version: 1,
      items,
      actualEntries,
      monthlyFinalized,
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString()
    };
  }

  function getEffectiveCostRate(item, monthKey) {
    if (!item || !Array.isArray(item.rateHistory) || !isValidMonthKey(monthKey)) {
      return { rate: 0, effectiveMonth: null, hasRate: false };
    }
    const sorted = sanitizeRateHistory(item.rateHistory);
    let chosen = null;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].effectiveMonth <= monthKey) chosen = sorted[i];
      else break;
    }
    if (!chosen) return { rate: 0, effectiveMonth: null, hasRate: false };
    return {
      rate: chosen.rate,
      effectiveMonth: chosen.effectiveMonth,
      hasRate: chosen.rate > 0
    };
  }

  function upsertCostItem(costState, rawInput) {
    const clean = sanitizeOperatingCostsState(costState);
    if (!rawInput || typeof rawInput !== "object") {
      return { ok: false, error: "Dữ liệu khoản mục không hợp lệ." };
    }
    const name = sanitizeText(rawInput.name, 100);
    if (!name) return { ok: false, error: "Vui lòng nhập tên khoản mục chi phí." };
    const calcMode = COST_CALC_MODES[rawInput.calcMode] ? rawInput.calcMode : "monthly";
    const effectiveMonth = isValidMonthKey(rawInput.effectiveMonth) ? rawInput.effectiveMonth : getCurrentMonthKey();
    const rate = Math.min(MAX_AMOUNT_VND, Math.max(0, parseVND(rawInput.rate)));
    const existingId = sanitizeText(rawInput.id, 64);

    const nextItems = clean.items.map((it) => ({
      ...it,
      rateHistory: it.rateHistory.map((r) => ({ ...r }))
    }));

    const idx = existingId ? nextItems.findIndex((it) => it.id === existingId) : -1;
    let savedItem;
    if (idx >= 0) {
      const target = nextItems[idx];
      target.name = name;
      target.calcMode = calcMode;
      if (rawInput.active !== undefined) target.active = Boolean(rawInput.active);
      if (rawInput.updateRate !== false) {
        const histMap = new Map(target.rateHistory.map((r) => [r.effectiveMonth, r]));
        histMap.set(effectiveMonth, { effectiveMonth, rate });
        target.rateHistory = [...histMap.values()].sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth));
      }
      savedItem = target;
    } else {
      const newId = existingId || `ci_custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      savedItem = {
        id: newId,
        name,
        calcMode,
        active: true,
        isDefault: false,
        rateHistory: [{ effectiveMonth, rate }]
      };
      nextItems.push(savedItem);
    }

    return {
      ok: true,
      item: savedItem,
      state: {
        ...clean,
        items: nextItems,
        updatedAt: new Date().toISOString()
      }
    };
  }

  function deleteCostRateHistoryEntry(costState, itemId, effectiveMonth) {
    const clean = sanitizeOperatingCostsState(costState);
    const cleanId = sanitizeText(itemId, 64);
    const cleanMonth = String(effectiveMonth || "").trim();
    if (!cleanId || !isValidMonthKey(cleanMonth)) {
      return { ok: false, error: "Mốc định mức cần xóa không hợp lệ." };
    }
    const nextItems = clean.items.map((it) => ({
      ...it,
      rateHistory: it.rateHistory.map((r) => ({ ...r }))
    }));
    const target = nextItems.find((it) => it.id === cleanId);
    if (!target) return { ok: false, error: "Khoản mục chi phí không tồn tại." };
    if (target.rateHistory.length <= 1) {
      return { ok: false, error: "Mỗi khoản mục phải giữ lại ít nhất 1 mốc định mức áp dụng." };
    }
    const filtered = target.rateHistory.filter((r) => r.effectiveMonth !== cleanMonth);
    if (filtered.length === target.rateHistory.length) {
      return { ok: false, error: "Không tìm thấy mốc định mức cần xóa." };
    }
    target.rateHistory = filtered;
    return {
      ok: true,
      item: target,
      state: {
        ...clean,
        items: nextItems,
        updatedAt: new Date().toISOString()
      }
    };
  }

  function toggleCostItemActive(costState, itemId, active) {
    const clean = sanitizeOperatingCostsState(costState);
    const cleanId = sanitizeText(itemId, 64);
    const nextItems = clean.items.map((it) => ({
      ...it,
      rateHistory: it.rateHistory.map((r) => ({ ...r }))
    }));
    const target = nextItems.find((it) => it.id === cleanId);
    if (!target) return { ok: false, error: "Khoản mục chi phí không tồn tại." };
    target.active = Boolean(active);
    return {
      ok: true,
      item: target,
      state: {
        ...clean,
        items: nextItems,
        updatedAt: new Date().toISOString()
      }
    };
  }

  function addActualCostEntry(costState, rawEntry) {
    const clean = sanitizeOperatingCostsState(costState);
    if (!rawEntry || typeof rawEntry !== "object") {
      return { ok: false, error: "Dữ liệu chứng từ không hợp lệ." };
    }
    const itemId = sanitizeText(rawEntry.itemId, 64);
    const item = clean.items.find((it) => it.id === itemId);
    if (!item) return { ok: false, error: "Khoản mục chi phí không tồn tại." };
    const accountingMonth = String(rawEntry.accountingMonth || "").trim();
    if (!isValidMonthKey(accountingMonth)) {
      return { ok: false, error: "Tháng ghi nhận chi phí không hợp lệ (YYYY-MM)." };
    }
    const expenseDate = isValidISODate(rawEntry.expenseDate) ? rawEntry.expenseDate : getTodayISO();
    const rawAmtStr = String(rawEntry.amount ?? "").trim();
    if (rawAmtStr === "") {
      return { ok: false, error: "Vui lòng nhập số tiền chứng từ (VNĐ)." };
    }
    const amount = Math.min(MAX_AMOUNT_VND, Math.max(0, parseVND(rawEntry.amount)));
    const incomingId = sanitizeText(rawEntry.id, 64);
    const existing = incomingId ? clean.actualEntries.find((e) => e.id === incomingId) : null;
    const nowIso = new Date().toISOString();
    const entry = {
      id: incomingId || `ce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      itemId,
      expenseDate,
      accountingMonth,
      amount,
      note: sanitizeText(rawEntry.note, 240),
      createdBy: sanitizeText(rawEntry.createdBy, 60) || (existing ? existing.createdBy : ""),
      createdAt: existing && typeof existing.createdAt === "string" ? existing.createdAt : nowIso,
      ...(existing ? { updatedAt: nowIso } : {})
    };

    const nextEntries = [entry, ...clean.actualEntries.filter((e) => e.id !== entry.id)];
    return {
      ok: true,
      isUpdate: Boolean(existing),
      entry,
      state: {
        ...clean,
        actualEntries: nextEntries,
        updatedAt: nowIso
      }
    };
  }

  function deleteActualCostEntry(costState, entryId) {
    const clean = sanitizeOperatingCostsState(costState);
    const id = sanitizeText(entryId, 64);
    const nextEntries = clean.actualEntries.filter((e) => e.id !== id);
    if (nextEntries.length === clean.actualEntries.length) {
      return { ok: false, error: "Không tìm thấy chứng từ cần xóa." };
    }
    return {
      ok: true,
      state: {
        ...clean,
        actualEntries: nextEntries,
        updatedAt: new Date().toISOString()
      }
    };
  }

  function setCostItemFinalized(costState, monthKey, itemId, finalized, actor = "") {
    const clean = sanitizeOperatingCostsState(costState);
    if (!isValidMonthKey(monthKey)) return { ok: false, error: "Tháng chốt không hợp lệ." };
    const cleanId = sanitizeText(itemId, 64);
    if (!clean.items.some((it) => it.id === cleanId)) {
      return { ok: false, error: "Khoản mục không tồn tại." };
    }
    const nextFinalized = { ...clean.monthlyFinalized };
    const monthMap = { ...(nextFinalized[monthKey] || {}) };
    if (finalized) {
      monthMap[cleanId] = {
        finalized: true,
        finalizedAt: new Date().toISOString(),
        finalizedBy: sanitizeText(actor, 60)
      };
      nextFinalized[monthKey] = monthMap;
    } else {
      delete monthMap[cleanId];
      if (Object.keys(monthMap).length > 0) nextFinalized[monthKey] = monthMap;
      else delete nextFinalized[monthKey];
    }
    return {
      ok: true,
      state: {
        ...clean,
        monthlyFinalized: nextFinalized,
        updatedAt: new Date().toISOString()
      }
    };
  }

  function isBookingCancelled(bk) {
    if (!bk || typeof bk !== "object") return true;
    const st = String(bk.status || bk.bookingStatus || "").trim().toLowerCase();
    return Boolean(bk.cancelled || bk.canceled || bk.deleted || st === "cancelled" || st === "canceled" || st === "huy" || st === "đã hủy");
  }

  function computeMonthlyStayMetrics(bookings, monthKey) {
    if (!isValidMonthKey(monthKey)) {
      return {
        monthKey: "",
        soldRoomNights: 0,
        guestNights: 0,
        dormNights: 0,
        missingGuestBookings: [],
        missingGuestRoomNights: 0
      };
    }
    const [yStr, mStr] = monthKey.split("-");
    const year = parseInt(yStr, 10);
    const monthIdx = parseInt(mStr, 10) - 1;
    const daysCount = getDaysInMonth(year, monthIdx);
    const monthStart = `${monthKey}-01`;
    const monthEnd = `${monthKey}-${pad2(daysCount)}`;
    const nextMonthStart = addDaysISO(monthEnd, 1);

    let soldRoomNights = 0;
    let guestNights = 0;
    let dormNights = 0;
    let missingGuestRoomNights = 0;
    const missingGuestBookings = [];

    const list = Array.isArray(bookings) ? bookings : [];
    for (let i = 0; i < list.length; i++) {
      const bk = list[i];
      if (!bk || isBookingCancelled(bk)) continue;
      if (!isValidISODate(bk.checkin) || !isValidISODate(bk.checkout) || bk.checkout <= bk.checkin) continue;
      // Overlap check: night d satisfies checkin <= d < checkout AND monthStart <= d < nextMonthStart
      if (bk.checkout <= monthStart || bk.checkin >= nextMonthStart) continue;

      const effStart = bk.checkin < monthStart ? monthStart : bk.checkin;
      const effEnd = bk.checkout > nextMonthStart ? nextMonthStart : bk.checkout;
      const nightsInMonth = Math.max(0, diffNights(effStart, effEnd));
      if (nightsInMonth <= 0) continue;

      if (bk.roomId === "DORM") {
        const slotsCount = Array.isArray(bk.slots) && bk.slots.length > 0 ? bk.slots.length : Math.max(1, parseInt(bk.dormBeds, 10) || 1);
        dormNights += nightsInMonth * slotsCount;
        continue;
      }

      soldRoomNights += nightsInMonth;
      const rawGuests = bk.guestCount;
      const parsedGuests = (rawGuests === null || rawGuests === undefined || String(rawGuests).trim() === "")
        ? NaN
        : Number(rawGuests);
      if (Number.isFinite(parsedGuests) && parsedGuests > 0) {
        guestNights += nightsInMonth * Math.floor(parsedGuests);
      } else {
        missingGuestRoomNights += nightsInMonth;
        missingGuestBookings.push({
          id: bk.id || "",
          roomId: bk.roomId || "",
          guestName: bk.guestName || "(Chưa rõ tên)",
          checkin: bk.checkin,
          checkout: bk.checkout,
          nightsInMonth
        });
      }
    }

    return {
      monthKey,
      soldRoomNights,
      guestNights,
      dormNights,
      missingGuestBookings,
      missingGuestRoomNights
    };
  }

  function computeMonthlyProratedRevenue(bookings, monthKey) {
    if (!isValidMonthKey(monthKey)) {
      return { monthKey: "", proratedRoomRevenue: 0, proratedDormRevenue: 0 };
    }
    const [yStr, mStr] = monthKey.split("-");
    const year = parseInt(yStr, 10);
    const monthIdx = parseInt(mStr, 10) - 1;
    const daysCount = getDaysInMonth(year, monthIdx);
    const monthStart = `${monthKey}-01`;
    const monthEnd = `${monthKey}-${pad2(daysCount)}`;
    const nextMonthStart = addDaysISO(monthEnd, 1);

    let proratedRoomRevenue = 0;
    let proratedDormRevenue = 0;

    const list = Array.isArray(bookings) ? bookings : [];
    for (let i = 0; i < list.length; i++) {
      const bk = list[i];
      if (!bk || isBookingCancelled(bk)) continue;
      if (!isValidISODate(bk.checkin) || !isValidISODate(bk.checkout) || bk.checkout <= bk.checkin) continue;
      if (bk.checkout <= monthStart || bk.checkin >= nextMonthStart) continue;

      const totalNights = Math.max(1, diffNights(bk.checkin, bk.checkout));
      const effStart = bk.checkin < monthStart ? monthStart : bk.checkin;
      const effEnd = bk.checkout > nextMonthStart ? nextMonthStart : bk.checkout;
      const nightsInMonth = Math.max(0, diffNights(effStart, effEnd));
      if (nightsInMonth <= 0) continue;

      const totalAmt = parseVND(bk.totalAmount);
      const share = Math.round((totalAmt * nightsInMonth) / totalNights);
      if (bk.roomId === "DORM") proratedDormRevenue += share;
      else proratedRoomRevenue += share;
    }

    return { monthKey, proratedRoomRevenue, proratedDormRevenue };
  }

  function computeMonthlyOperatingCosts(costState, bookings, monthKey, financeState = null) {
    const clean = sanitizeOperatingCostsState(costState);
    const targetMonth = isValidMonthKey(monthKey) ? monthKey : getCurrentMonthKey();
    const stay = computeMonthlyStayMetrics(bookings, targetMonth);
    const rev = computeMonthlyProratedRevenue(bookings, targetMonth);

    // Collect supplier invoices & map linked legacy actualEntries to prevent double-counting
    const invoices = financeState && Array.isArray(financeState.supplierInvoices)
      ? financeState.supplierInvoices
      : [];
    const linkedLegacyMap = new Map(); // legacyEntryId -> { invoiceId, voucherNo, supplierName }
    const invoiceLinesByItem = new Map();

    for (const inv of invoices) {
      if (!inv || !inv.id) continue;
      for (const legId of (inv.linkedLegacyEntryIds || [])) {
        if (legId) {
          linkedLegacyMap.set(legId, {
            invoiceId: inv.id,
            voucherNo: inv.voucherNo || inv.invoiceCode || inv.id,
            supplierName: inv.supplierName || ""
          });
        }
      }
      if (inv.accountingMonth !== targetMonth) continue;
      for (const line of (inv.lines || [])) {
        if (!line || !line.costItemId) continue;
        const amt = parseVND(line.amount);
        if (amt <= 0) continue;
        let arr = invoiceLinesByItem.get(line.costItemId);
        if (!arr) {
          arr = [];
          invoiceLinesByItem.set(line.costItemId, arr);
        }
        arr.push({
          id: `invline_${inv.id}_${line.id}`,
          sourceType: "supplier_invoice",
          invoiceId: inv.id,
          voucherNo: inv.voucherNo || inv.invoiceCode || "",
          supplierName: inv.supplierName || "",
          itemId: line.costItemId,
          expenseDate: inv.invoiceDate || `${targetMonth}-01`,
          accountingMonth: inv.accountingMonth,
          amount: amt,
          note: `${inv.supplierName || "NCC"} • HĐ ${inv.voucherNo || inv.invoiceCode || inv.id}${line.description ? ` — ${line.description}` : ""}`,
          createdBy: inv.createdBy || "",
          createdAt: inv.createdAt || ""
        });
      }
    }

    const monthFinalizedMap = clean.monthlyFinalized[targetMonth] || {};
    const entriesByItem = new Map();
    const linkedLegacyByItem = new Map();
    for (const ent of clean.actualEntries) {
      if (ent.accountingMonth !== targetMonth) continue;
      const linkedInv = linkedLegacyMap.get(ent.id);
      if (linkedInv) {
        let lArr = linkedLegacyByItem.get(ent.itemId);
        if (!lArr) {
          lArr = [];
          linkedLegacyByItem.set(ent.itemId, lArr);
        }
        lArr.push({
          ...ent,
          sourceType: "legacy_linked",
          linkedInvoiceId: linkedInv.invoiceId,
          linkedInvoiceVoucherNo: linkedInv.voucherNo,
          linkedSupplierName: linkedInv.supplierName
        });
        continue;
      }
      let arr = entriesByItem.get(ent.itemId);
      if (!arr) {
        arr = [];
        entriesByItem.set(ent.itemId, arr);
      }
      arr.push({ ...ent, sourceType: "manual_voucher" });
    }

    const rows = [];
    let totalMonthlyCost = 0;
    let totalActualPortion = 0;
    let totalEstimatedPortion = 0;
    let totalEnteredActual = 0;
    let finalizedCount = 0;
    let finalizedZeroCount = 0;
    let estimatedCount = 0;
    let partialActualCount = 0;
    let missingBasisCount = 0;
    const missingBasisItems = [];

    for (const item of clean.items) {
      const manualEntries = entriesByItem.get(item.id) || [];
      const invEntries = invoiceLinesByItem.get(item.id) || [];
      const linkedLegacyEntries = linkedLegacyByItem.get(item.id) || [];
      const entries = [...invEntries, ...manualEntries].sort((a, b) => String(b.expenseDate).localeCompare(String(a.expenseDate)));
      const finalizedMeta = monthFinalizedMap[item.id] || null;
      const isFinalized = Boolean(finalizedMeta && finalizedMeta.finalized);
      if (!item.active && entries.length === 0 && linkedLegacyEntries.length === 0 && !isFinalized) continue;

      const modeMeta = COST_CALC_MODES[item.calcMode] || COST_CALC_MODES.monthly;
      const rateInfo = getEffectiveCostRate(item, targetMonth);

      let quantity = 1;
      let quantityLabel = "1 tháng";
      if (item.calcMode === "guest_night") {
        quantity = stay.guestNights;
        quantityLabel = `${stay.guestNights} khách-đêm`;
      } else if (item.calcMode === "room_night") {
        quantity = stay.soldRoomNights;
        quantityLabel = `${stay.soldRoomNights} đêm phòng`;
      }

      const estimatedAmount = rateInfo.hasRate ? Math.round(quantity * rateInfo.rate) : 0;
      const actualAmount = entries.reduce((sum, e) => sum + parseVND(e.amount), 0);
      const supplierInvoiceAmount = invEntries.reduce((sum, e) => sum + parseVND(e.amount), 0);
      const manualActualAmount = manualEntries.reduce((sum, e) => sum + parseVND(e.amount), 0);
      const hasActualEntries = entries.length > 0;
      const isPartialActual = !isFinalized && hasActualEntries;
      const usedAmount = isFinalized ? actualAmount : estimatedAmount;
      const usedSource = isFinalized ? "actual" : "estimated";

      // Clear 4-way distinction: missing_basis | estimated | finalized_zero | finalized_actual
      let costBasisStatus = "estimated";
      let costBasisLabel = "Có ước tính";
      if (isFinalized) {
        if (actualAmount === 0) {
          costBasisStatus = "finalized_zero";
          costBasisLabel = "Đã chốt thực tế = 0 đ";
          finalizedZeroCount += 1;
        } else {
          costBasisStatus = "finalized_actual";
          costBasisLabel = "Đã chốt thực tế";
        }
      } else if (!rateInfo.hasRate) {
        costBasisStatus = "missing_basis";
        costBasisLabel = hasActualEntries ? "Chưa nhập định mức (chưa chốt thực tế)" : "Chưa nhập định mức";
        missingBasisCount += 1;
        missingBasisItems.push({ itemId: item.id, name: item.name, hasActualEntries, actualAmount });
      } else {
        costBasisStatus = "estimated";
        costBasisLabel = "Có ước tính";
        estimatedCount += 1;
      }

      const formulaText = rateInfo.hasRate
        ? `${quantityLabel} × ${formatVND(rateInfo.rate)} = ${formatVND(estimatedAmount)}`
        : "Chưa cấu hình định mức — nhập chứng từ/hóa đơn NCC hoặc chốt thực tế (= 0 đ nếu tháng này không phát sinh)";

      totalMonthlyCost += usedAmount;
      totalEnteredActual += actualAmount;
      if (isFinalized) {
        totalActualPortion += usedAmount;
        finalizedCount += 1;
      } else {
        totalEstimatedPortion += usedAmount;
        if (isPartialActual) partialActualCount += 1;
      }

      rows.push({
        itemId: item.id,
        name: item.name,
        calcMode: item.calcMode,
        calcModeLabel: modeMeta.label,
        unitLabel: modeMeta.unitLabel,
        quantity,
        quantityLabel,
        rate: rateInfo.rate,
        rateEffectiveMonth: rateInfo.effectiveMonth,
        hasRate: rateInfo.hasRate,
        estimatedAmount,
        formulaText,
        actualAmount,
        supplierInvoiceAmount,
        manualActualAmount,
        entries,
        linkedLegacyEntries,
        entriesCount: entries.length,
        invoiceLinesCount: invEntries.length,
        isFinalized,
        finalizedMeta,
        isPartialActual,
        costBasisStatus,
        costBasisLabel,
        usedAmount,
        usedSource,
        variance: actualAmount - estimatedAmount
      });
    }

    const costPerRoomNight = stay.soldRoomNights > 0
      ? Math.round(totalMonthlyCost / stay.soldRoomNights)
      : null;
    const proratedRoomRevenue = rev.proratedRoomRevenue;
    const estimatedGrossProfit = proratedRoomRevenue - totalMonthlyCost;
    const costToRevenuePercent = proratedRoomRevenue > 0
      ? Math.round((totalMonthlyCost / proratedRoomRevenue) * 1000) / 10
      : null;

    const missingGuestBasis = stay.missingGuestBookings.length > 0 && rows.some((r) => r.calcMode === "guest_night" && !r.isFinalized && r.hasRate);
    const profitBasisSufficient = missingBasisCount === 0 && !missingGuestBasis;
    const profitStatusLabel = profitBasisSufficient
      ? "Đủ căn cứ tính lãi"
      : "Chưa đủ dữ liệu tính lãi";

    return {
      monthKey: targetMonth,
      monthLabelVN: formatMonthVN(targetMonth),
      stay,
      rows,
      totalMonthlyCost,
      totalActualPortion,
      totalEstimatedPortion,
      totalEnteredActual,
      finalizedCount,
      finalizedZeroCount,
      estimatedCount,
      partialActualCount,
      missingBasisCount,
      missingBasisItems,
      missingGuestBasis,
      profitBasisSufficient,
      profitStatusLabel,
      soldRoomNights: stay.soldRoomNights,
      guestNights: stay.guestNights,
      costPerRoomNight,
      proratedRoomRevenue,
      proratedDormRevenue: rev.proratedDormRevenue,
      estimatedGrossProfit,
      costToRevenuePercent
    };
  }

  function generateOperatingCostsCsvContent(report) {
    if (!report || typeof report !== "object") return "\uFEFF";
    const lines = [];
    const pushRow = (arr) => lines.push(arr.map(sanitizeCsvCell).join(","));

    pushRow([`BÁO CÁO CHI PHÍ VẬN HÀNH & GIÁ VỐN — THÁNG ${report.monthLabelVN || report.monthKey || ""}`]);
    pushRow(["Chỉ tiêu tổng hợp", "Giá trị"]);
    pushRow(["Tổng chi phí tháng (VNĐ)", report.totalMonthlyCost || 0]);
    pushRow(["Phần đã chốt theo thực tế (VNĐ)", report.totalActualPortion || 0]);
    pushRow(["Phần còn dùng ước tính (VNĐ)", report.totalEstimatedPortion || 0]);
    pushRow(["Số khoản mục thiếu định mức / chưa chốt", report.missingBasisCount || 0]);
    pushRow(["Trạng thái căn cứ tính lãi", report.profitStatusLabel || ""]);
    pushRow(["Số đêm phòng đã bán", report.soldRoomNights || 0]);
    pushRow(["Số khách-đêm", report.guestNights || 0]);
    pushRow(["Chi phí bình quân / đêm phòng (VNĐ)", report.costPerRoomNight !== null && report.costPerRoomNight !== undefined ? report.costPerRoomNight : "Chưa có đêm phòng"]);
    pushRow(["Doanh thu phòng phân bổ tháng (VNĐ)", report.proratedRoomRevenue || 0]);
    pushRow(["Lãi gộp ước tính sau chi phí (VNĐ)", report.estimatedGrossProfit || 0]);
    pushRow(["Tỷ lệ Chi phí / Doanh thu (%)", report.costToRevenuePercent !== null && report.costToRevenuePercent !== undefined ? `${report.costToRevenuePercent}%` : "Chưa có doanh thu"]);
    pushRow([]);

    pushRow([
      "Khoản mục",
      "Cách tính",
      "Số lượng",
      "Đơn giá áp dụng (VNĐ)",
      "Ước tính (VNĐ)",
      "Thực tế (VNĐ)",
      "Số dùng tính tổng (VNĐ)",
      "Trạng thái",
      "Chênh lệch TT - ƯT (VNĐ)"
    ]);
    for (const r of (report.rows || [])) {
      const statusTxt = r.costBasisLabel || (r.isFinalized
        ? (r.actualAmount === 0 ? "Đã chốt thực tế = 0 đ" : "Đã chốt thực tế")
        : (r.isPartialActual ? "Mới nhập 1 phần (đang dùng ước tính)" : "Ước tính"));
      pushRow([
        r.name,
        r.calcModeLabel,
        r.quantityLabel,
        r.hasRate ? r.rate : 0,
        r.estimatedAmount,
        r.actualAmount,
        r.usedAmount,
        statusTxt,
        r.variance
      ]);
    }
    pushRow([]);

    pushRow(["CHI TIẾT CHỨNG TỪ & HÓA ĐƠN NHÀ CUNG CẤP TRONG THÁNG"]);
    pushRow(["Nguồn", "Ngày phát sinh / HĐ", "Tháng ghi nhận", "Khoản mục", "Số tiền (VNĐ)", "Ghi chú / Số HĐ", "Người nhập"]);
    const allVouchers = [];
    for (const r of (report.rows || [])) {
      for (const e of (r.entries || [])) {
        allVouchers.push({ ...e, itemName: r.name });
      }
    }
    allVouchers.sort((a, b) => String(b.expenseDate || "").localeCompare(String(a.expenseDate || "")));
    for (const v of allVouchers) {
      pushRow([
        v.sourceType === "supplier_invoice" ? "Hóa đơn NCC" : "Chứng từ chi",
        v.expenseDate,
        v.accountingMonth,
        v.itemName,
        v.amount,
        v.note || "",
        v.createdBy || ""
      ]);
    }

    return "\uFEFF" + lines.join("\r\n");
  }

  /* -------------------- Accounts, RBAC Permissions, Housekeeping & Maintenance Engine -------------------- */

  const SUPER_ADMIN_USERNAME = "tranbinh25102003";
  const SUPER_ADMIN_DISPLAY_NAME = "Trần Bình";
  const SUPER_ADMIN_DEFAULT_PASSCODE = "2510";

  const STAFF_ROLES = Object.freeze({
    super_admin: Object.freeze({ key: "super_admin", label: "Tổng quản lý" }),
    manager: Object.freeze({ key: "manager", label: "Quản lý" }),
    reception: Object.freeze({ key: "reception", label: "Lễ tân" }),
    housekeeping: Object.freeze({ key: "housekeeping", label: "Buồng phòng" })
  });

  const ROLE_PERMISSIONS = Object.freeze({
    super_admin: Object.freeze(new Set([
      "bookings:read", "bookings:write", "bookings:checkout", "bookings:pdf", "bookings:export",
      "housekeeping:read", "housekeeping:create", "housekeeping:execute",
      "issues:read", "issues:create", "issues:manage",
      "photos:upload", "photos:read",
      "costs:read", "costs:write",
      "finance:collect", "finance:ar_read", "finance:shift_read", "finance:shift_write", "finance:shift_manage",
      "finance:cashbook_read", "finance:approve_refund", "finance:approve_adjustment",
      "finance:transfer", "finance:reconcile", "finance:opening_balance", "finance:export",
      "finance:payables_read", "finance:payables_write", "finance:payables_pay",
      "accounts:manage", "accounts:create", "accounts:lock", "accounts:delete",
      "reports:daily", "reports:management",
      "admin:backup", "admin:restore", "admin:reset"
    ])),
    manager: Object.freeze(new Set([
      "bookings:read", "bookings:write", "bookings:checkout", "bookings:pdf", "bookings:export",
      "housekeeping:read", "housekeeping:create", "housekeeping:execute",
      "issues:read", "issues:create", "issues:manage",
      "photos:upload", "photos:read",
      "costs:read", "costs:write",
      "finance:collect", "finance:ar_read", "finance:shift_read", "finance:shift_write", "finance:shift_manage",
      "finance:cashbook_read", "finance:approve_refund", "finance:approve_adjustment",
      "finance:transfer", "finance:reconcile", "finance:opening_balance", "finance:export",
      "finance:payables_read", "finance:payables_write", "finance:payables_pay",
      "reports:daily", "reports:management",
      "admin:backup", "admin:restore", "admin:reset"
    ])),
    reception: Object.freeze(new Set([
      "bookings:read", "bookings:write", "bookings:checkout", "bookings:pdf",
      "housekeeping:read", "housekeeping:create", "housekeeping:execute",
      "issues:read", "issues:create", "issues:manage",
      "photos:upload", "photos:read",
      "finance:collect", "finance:ar_read", "finance:shift_read", "finance:shift_write",
      "reports:daily"
    ])),
    housekeeping: Object.freeze(new Set([
      "housekeeping:read", "housekeeping:execute",
      "issues:read", "issues:create",
      "photos:upload", "photos:read"
    ]))
  });

  function normalizeRole(raw) {
    const val = String(raw || "").trim().toLowerCase();
    if (val === "super_admin" || val === "superadmin" || val === "tongquanly" || val === "tổng quản lý") return "super_admin";
    if (val === "manager" || val === "admin" || val === "quanly" || val === "quản lý") return "manager";
    if (val === "housekeeping" || val === "hk" || val === "buongphong" || val === "buồng phòng") return "housekeeping";
    return "reception";
  }

  function isSuperAdminRole(role) {
    return normalizeRole(role) === "super_admin";
  }

  function getRoleLabel(role) {
    const norm = normalizeRole(role);
    return (STAFF_ROLES[norm] && STAFF_ROLES[norm].label) || "Lễ tân";
  }

  function hasPermission(role, permission) {
    const norm = normalizeRole(role);
    const set = ROLE_PERMISSIONS[norm];
    return Boolean(set && set.has(permission));
  }

  // Unified inline SVG icon set (16px/18px stroke-1.8) shared across PC Sidebar, Topbar, KPIs & Mobile Drawer
  const NAV_ICONS_SVG = Object.freeze({
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    bed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M16 12h5v4h-5a2 2 0 0 1 0-4z"/></svg>',
    receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/></svg>',
    handover: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    file_text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    trending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    coffee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>',
    door: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h20"/><path d="M13 20V4a1 1 0 0 0-1-1H6a2 2 0 0 0-2 2v15"/><circle cx="10" cy="12" r="1"/></svg>'
  });

  // Single source of truth for PC left sidebar & Mobile ☰ drawer navigation.
  // Only items with implemented: true AND permitted for the active user role are shown.
  // Groups with 0 visible items are automatically hidden.
  const NAV_CONFIG = Object.freeze([
    Object.freeze({
      key: "reception",
      label: "Lễ tân",
      items: Object.freeze([
        Object.freeze({ key: "calendar", label: "Lịch phòng", id: "btn-nav-calendar", icon: "calendar", permission: "bookings:read", implemented: true }),
        Object.freeze({ key: "groups", label: "Khách đoàn", id: "btn-open-groups", badgeId: "groups-count-pill", icon: "users", permission: "bookings:read", implemented: true }),
        Object.freeze({ key: "dorm", label: "Dorm nội bộ", id: "btn-open-dorm-today", icon: "bed", permission: "bookings:read", implemented: true }),
        Object.freeze({ key: "housekeeping", label: "Buồng phòng", id: "btn-open-hk", badgeId: "hk-badge-pill", icon: "sparkles", permission: "housekeeping:read", excludeRoles: Object.freeze(["housekeeping"]), implemented: true })
      ])
    }),
    Object.freeze({
      key: "finance",
      label: "Tài chính",
      items: Object.freeze([
        Object.freeze({ key: "receivables", label: "Thu tiền & công nợ", id: "btn-open-receivables", badgeId: "ar-badge-pill", icon: "receipt", permission: "finance:ar_read", implemented: true }),
        Object.freeze({ key: "cash_shifts", label: "Giao ca lễ tân", id: "btn-open-shifts", badgeId: "shifts-badge-pill", icon: "handover", permission: "finance:shift_read", implemented: true }),
        Object.freeze({ key: "cashbook", label: "Sổ quỹ & đối soát", id: "btn-open-cashbook", icon: "book", permission: "finance:cashbook_read", implemented: true }),
        Object.freeze({ key: "payables", label: "Hóa đơn NCC & công nợ trả", id: "btn-open-payables", badgeId: "ap-badge-pill", icon: "file_text", permission: "finance:payables_read", implemented: true }),
        Object.freeze({ key: "operating_costs", label: "Chi phí & giá vốn", id: "btn-open-costs", icon: "wallet", permission: "costs:read", implemented: true })
      ])
    }),
    Object.freeze({
      key: "sales",
      label: "Kinh doanh",
      items: Object.freeze([
        Object.freeze({ key: "rate_plan", label: "Bảng giá phòng", id: "btn-nav-rates", icon: "tag", permission: "costs:read", implemented: false }),
        Object.freeze({ key: "extra_services", label: "Dịch vụ ngoài phòng", id: "btn-nav-services", icon: "bag", permission: "bookings:read", implemented: false })
      ])
    }),
    Object.freeze({
      key: "hr",
      label: "Nhân sự",
      items: Object.freeze([
        Object.freeze({ key: "shifts_payroll", label: "Ca làm & bảng lương", id: "btn-nav-payroll", icon: "clock", permission: "costs:read", implemented: false })
      ])
    }),
    Object.freeze({
      key: "reports",
      label: "Báo cáo",
      items: Object.freeze([
        Object.freeze({ key: "occupancy_report", label: "Công suất phòng", id: "btn-nav-occ-report", icon: "chart", permission: "reports:management", implemented: false }),
        Object.freeze({ key: "pnl_report", label: "Doanh thu & lãi/lỗ", id: "btn-nav-pnl-report", icon: "trending", permission: "reports:management", implemented: false }),
        Object.freeze({ key: "budget_forecast", label: "Dự toán", id: "btn-nav-budget", icon: "target", permission: "reports:management", implemented: false })
      ])
    }),
    Object.freeze({
      key: "system",
      label: "Hệ thống",
      items: Object.freeze([
        Object.freeze({ key: "history", label: "Lịch sử thao tác", id: "btn-open-history", icon: "history", permission: "bookings:read", implemented: true }),
        Object.freeze({ key: "backup_restore", label: "Sao lưu & khôi phục", id: "btn-open-backup-restore", icon: "database", permission: "admin:backup", implemented: true }),
        Object.freeze({ key: "accounts", label: "Quản trị tài khoản", id: "btn-open-accounts", icon: "shield", permission: "accounts:manage", implemented: true })
      ])
    })
  ]);

  function getVisibleNavGroups(role, canFn) {
    const normRole = normalizeRole(role);
    const check = typeof canFn === "function" ? canFn : (perm) => hasPermission(normRole, perm);
    const result = [];
    for (const group of NAV_CONFIG) {
      const visibleItems = group.items.filter((item) => {
        if (!item.implemented) return false;
        if (Array.isArray(item.excludeRoles) && item.excludeRoles.includes(normRole)) return false;
        if (item.permission && !check(item.permission)) return false;
        return true;
      });
      if (visibleItems.length > 0) {
        result.push({ key: group.key, label: group.label, items: visibleItems });
      }
    }
    return result;
  }

  const HK_TASK_TYPES = Object.freeze({
    checkout: Object.freeze({ key: "checkout", label: "Dọn sau trả phòng", shortLabel: "Sau trả phòng" }),
    stayover: Object.freeze({ key: "stayover", label: "Dọn trong kỳ lưu trú", shortLabel: "Trong kỳ lưu trú" })
  });

  const HK_TASK_STATUSES = Object.freeze({
    dirty: Object.freeze({ key: "dirty", label: "Cần dọn" }),
    in_progress: Object.freeze({ key: "in_progress", label: "Đang dọn" }),
    cleaned: Object.freeze({ key: "cleaned", label: "Đã dọn" })
  });

  const ISSUE_SEVERITIES = Object.freeze({
    low: Object.freeze({ key: "low", label: "Thấp" }),
    medium: Object.freeze({ key: "medium", label: "Trung bình" }),
    high: Object.freeze({ key: "high", label: "Cao" }),
    urgent: Object.freeze({ key: "urgent", label: "Khẩn cấp" })
  });

  const ISSUE_STATUSES = Object.freeze({
    open: Object.freeze({ key: "open", label: "Mới báo" }),
    in_progress: Object.freeze({ key: "in_progress", label: "Đang xử lý" }),
    resolved: Object.freeze({ key: "resolved", label: "Đã xử lý" })
  });

  function sanitizePhotoRef(raw) {
    if (!raw || typeof raw !== "object") return null;
    const obj = stripDangerousKeys(raw);
    const id = sanitizeText(obj.id, 80);
    const rawUrl = String(obj.url || "").trim();
    const isSafeUrl = rawUrl.startsWith("/api/photos/") || rawUrl.startsWith("data:image/");
    if (!id && !isSafeUrl) return null;
    return {
      id: id || `ph_${Date.now().toString(36)}`,
      url: isSafeUrl ? rawUrl : `/api/photos/${encodeURIComponent(id)}`,
      mimeType: sanitizeText(obj.mimeType, 40) || "image/jpeg",
      uploadedBy: sanitizeText(obj.uploadedBy, 60),
      uploadedAt: sanitizeText(obj.uploadedAt, 40) || new Date().toISOString()
    };
  }

  function sanitizePhotoList(rawList) {
    if (!Array.isArray(rawList)) return [];
    const out = [];
    const seen = new Set();
    for (const item of rawList) {
      const clean = sanitizePhotoRef(item);
      if (!clean || seen.has(clean.id)) continue;
      seen.add(clean.id);
      out.push(clean);
      if (out.length >= 6) break;
    }
    return out;
  }

  function buildCheckoutHousekeepingNote(booking) {
    if (!booking || typeof booking !== "object") {
      return "Khách vừa trả phòng — cần dọn chuẩn bị đón khách mới.";
    }
    const parts = ["Khách vừa trả phòng"];
    const room = getRoomById(booking.roomId);
    if (room && room.type === "Twins" && booking.mergeBed) {
      parts.push("lưu ý đã ghép giường trước đó");
    }
    if (Number(booking.extraBed) > 0) {
      parts.push(`có ${Number(booking.extraBed)} Extra bed cần thu dọn`);
    }
    return parts.join(" • ") + ".";
  }

  function sanitizeHousekeepingTask(raw) {
    if (!raw || typeof raw !== "object") return null;
    const obj = stripDangerousKeys(raw);
    const room = getRoomById(obj.roomId);
    if (!room) return null;
    const taskType = HK_TASK_TYPES[obj.taskType] ? obj.taskType : "checkout";
    const status = HK_TASK_STATUSES[obj.status] ? obj.status : "dirty";
    const serviceDate = isValidISODate(obj.serviceDate) ? obj.serviceDate : getTodayISO();
    const nowIso = new Date().toISOString();
    // STRICT PII ISOLATION: housekeeping tasks NEVER carry guestName, phone, totalAmount, paidAmount, or bookingCode
    return {
      id: sanitizeText(obj.id, 64) || `hk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      roomId: room.id,
      roomName: room.name,
      floor: room.floor,
      roomType: room.type,
      taskType,
      status,
      serviceDate,
      sourceBookingId: sanitizeText(obj.sourceBookingId, 64) || "",
      idempotencyKey: sanitizeText(obj.idempotencyKey, 96) || "",
      note: sanitizeText(obj.note, 300),
      startedBy: sanitizeText(obj.startedBy, 60),
      startedAt: sanitizeText(obj.startedAt, 40),
      completedBy: sanitizeText(obj.completedBy, 60),
      completedAt: sanitizeText(obj.completedAt, 40),
      photos: sanitizePhotoList(obj.photos),
      createdBy: sanitizeText(obj.createdBy, 60),
      createdAt: sanitizeText(obj.createdAt, 40) || nowIso,
      updatedAt: sanitizeText(obj.updatedAt, 40) || nowIso
    };
  }

  function sanitizeMaintenanceIssue(raw) {
    if (!raw || typeof raw !== "object") return null;
    const obj = stripDangerousKeys(raw);
    const room = getRoomById(obj.roomId);
    if (!room) return null;
    const description = sanitizeText(obj.description, 500);
    if (!description) return null;
    const severity = ISSUE_SEVERITIES[obj.severity] ? obj.severity : "medium";
    const status = ISSUE_STATUSES[obj.status] ? obj.status : "open";
    const nowIso = new Date().toISOString();
    return {
      id: sanitizeText(obj.id, 64) || `iss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      roomId: room.id,
      roomName: room.name,
      floor: room.floor,
      taskId: sanitizeText(obj.taskId, 64),
      description,
      severity,
      blocksRoom: obj.blocksRoom !== undefined ? Boolean(obj.blocksRoom) : (severity === "high" || severity === "urgent"),
      status,
      photos: sanitizePhotoList(obj.photos),
      reportedBy: sanitizeText(obj.reportedBy, 60) || "Nhân viên",
      reportedAt: sanitizeText(obj.reportedAt, 40) || nowIso,
      resolvedBy: sanitizeText(obj.resolvedBy, 60),
      resolvedAt: sanitizeText(obj.resolvedAt, 40),
      resolutionNote: sanitizeText(obj.resolutionNote, 300),
      updatedAt: sanitizeText(obj.updatedAt, 40) || nowIso
    };
  }

  function sanitizeStaffAccountPublic(raw) {
    if (!raw || typeof raw !== "object") return null;
    const obj = stripDangerousKeys(raw);
    const id = sanitizeText(obj.id, 64);
    const username = sanitizeText(obj.username, 60).toLowerCase();
    const staffName = sanitizeText(obj.staffName, 80);
    if (!id || !username || !staffName) return null;
    return {
      id,
      username,
      staffName,
      role: normalizeRole(obj.role),
      active: obj.active !== false,
      createdAt: sanitizeText(obj.createdAt, 40),
      updatedAt: sanitizeText(obj.updatedAt, 40)
    };
  }

  function getHousekeepingTasksForDate(tasks, dateISO) {
    const targetDate = isValidISODate(dateISO) ? dateISO : getTodayISO();
    const list = Array.isArray(tasks) ? tasks : [];
    const matched = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      const isTargetDay = t.serviceDate === targetDate;
      const isCarryover = t.serviceDate < targetDate && t.status !== "cleaned";
      if (isTargetDay || isCarryover) {
        matched.push({
          ...t,
          isCarryover
        });
      }
    }
    const statusOrder = { dirty: 0, in_progress: 1, cleaned: 2 };
    matched.sort((a, b) => {
      if (a.isCarryover !== b.isCarryover) return a.isCarryover ? -1 : 1;
      const sDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
      if (sDiff !== 0) return sDiff;
      const dDiff = String(a.serviceDate || "").localeCompare(String(b.serviceDate || ""));
      if (dDiff !== 0) return dDiff;
      return String(a.roomId || "").localeCompare(String(b.roomId || ""));
    });
    return matched;
  }

  function computeRoomOperationalStatus(roomId, tasks, issues, dateISO) {
    const targetDate = isValidISODate(dateISO) ? dateISO : getTodayISO();
    const taskList = Array.isArray(tasks) ? tasks : [];
    const issueList = Array.isArray(issues) ? issues : [];

    const roomTasks = taskList.filter((t) => t && t.roomId === roomId);
    const openTasks = roomTasks.filter((t) => t.status !== "cleaned" && t.serviceDate <= targetDate);
    const inProgressTask = openTasks.find((t) => t.status === "in_progress") || null;
    const dirtyTask = openTasks.find((t) => t.status === "dirty") || null;
    const todayCompleted = roomTasks
      .filter((t) => t.status === "cleaned" && (t.serviceDate === targetDate || String(t.completedAt || "").slice(0, 10) === targetDate))
      .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")))[0] || null;

    let cleanliness = "clean";
    let cleanlinessLabel = "Sạch";
    let activeTask = null;
    if (inProgressTask) {
      cleanliness = "in_progress";
      cleanlinessLabel = "Đang dọn";
      activeTask = inProgressTask;
    } else if (dirtyTask) {
      cleanliness = "dirty";
      cleanlinessLabel = "Cần dọn";
      activeTask = dirtyTask;
    } else if (todayCompleted) {
      cleanliness = "cleaned";
      cleanlinessLabel = "Đã dọn";
      activeTask = todayCompleted;
    }

    // Maintenance issues are STRICTLY independent of cleaning completion!
    const activeIssues = issueList.filter((iss) => iss && iss.roomId === roomId && iss.status !== "resolved");
    const blockingIssues = activeIssues.filter((iss) => Boolean(iss.blocksRoom));

    return {
      roomId,
      cleanliness,
      cleanlinessLabel,
      activeTask,
      lastCleanedTask: todayCompleted,
      openTaskCount: openTasks.length,
      activeIssues,
      blockingIssues,
      hasOpenIssues: activeIssues.length > 0,
      isBlocked: blockingIssues.length > 0
    };
  }

  function computeAllRoomOperationalStatuses(tasks, issues, dateISO) {
    const map = {};
    for (let i = 0; i < ROOMS.length; i++) {
      const r = ROOMS[i];
      map[r.id] = computeRoomOperationalStatus(r.id, tasks, issues, dateISO);
    }
    return map;
  }

  function createBookingStore(storageAdapter, options = {}) {
    const keys = {
      data: options.storageKey || STORAGE_KEY,
      backup: options.backupKey || BACKUP_KEY,
      autobackups: options.autoBackupKey || AUTOBACKUP_KEY,
      audit: options.auditKey || AUDIT_KEY,
      meta: options.metaKey || META_KEY,
      quarantine: options.quarantineKey || QUARANTINE_KEY
    };
    const maxAutoBackups = Number.isInteger(options.maxAutoBackups) && options.maxAutoBackups >= 1 ? options.maxAutoBackups : MAX_AUTOBACKUPS;
    const seedOnEmpty = options.seedOnEmpty !== false;
    const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 1 ? options.maxRetries : MAX_TX_RETRIES;
    const instanceId = `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    let txSeq = 0;
    let cachedBookings = [];
    let cachedAudit = [];
    let storageBlocked = false;
    let lastStorageError = null;

    function nextTxId() {
      txSeq += 1;
      return `${instanceId}_${txSeq}_${Math.random().toString(36).slice(2, 6)}`;
    }

    function readMetaSnapshot() {
      try {
        const metaRaw = storageAdapter.getItem(keys.meta);
        if (metaRaw === null || metaRaw === undefined) {
          return { ok: true, exists: false, metaRaw: null, storeVersion: 0, txId: null };
        }
        const parsed = JSON.parse(metaRaw);
        return {
          ok: true,
          exists: true,
          metaRaw,
          storeVersion: Number(parsed && parsed.storeVersion) || 0,
          txId: parsed && typeof parsed.txId === "string" ? parsed.txId : null
        };
      } catch {
        return { ok: false, exists: true, metaRaw: "__META_CORRUPT__", storeVersion: 0, txId: null };
      }
    }

    function readRawState() {
      let raw;
      try {
        raw = storageAdapter.getItem(keys.data);
      } catch (err) {
        return {
          ok: false,
          code: "STORAGE_READ_FAILED",
          raw: null,
          error: "Không thể đọc dữ liệu từ bộ nhớ trình duyệt" + (err && err.message ? ` (${err.message})` : ".")
        };
      }

      const metaSnap = readMetaSnapshot();

      if (raw === null || raw === undefined) {
        return {
          ok: true,
          exists: false,
          raw: null,
          list: null,
          metaRaw: metaSnap.metaRaw,
          metaExists: metaSnap.exists,
          storeVersion: metaSnap.storeVersion
        };
      }

      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          return {
            ok: false,
            code: "STORAGE_CORRUPTED",
            raw,
            error: "Dữ liệu sổ đặt phòng chính bị hỏng (không phải mảng JSON hợp lệ)."
          };
        }
        return {
          ok: true,
          exists: true,
          raw,
          list: parsed,
          metaRaw: metaSnap.metaRaw,
          metaExists: metaSnap.exists,
          storeVersion: metaSnap.storeVersion
        };
      } catch {
        return {
          ok: false,
          code: "STORAGE_CORRUPTED",
          raw,
          error: "Dữ liệu sổ đặt phòng chính bị hỏng (lỗi cú pháp JSON)."
        };
      }
    }

    function readValidatedBackup() {
      let bkRaw;
      try {
        bkRaw = storageAdapter.getItem(keys.backup);
      } catch (err) {
        return { ok: false, exists: false, code: "STORAGE_READ_FAILED", error: err && err.message ? err.message : "Lỗi đọc bản dự phòng" };
      }
      if (bkRaw === null || bkRaw === undefined) {
        return { ok: false, exists: false, code: "NO_BACKUP", error: "Không có bản dự phòng." };
      }
      try {
        const parsedBk = JSON.parse(bkRaw);
        const candidate = Array.isArray(parsedBk) ? parsedBk : (parsedBk && Array.isArray(parsedBk.bookings) ? parsedBk.bookings : null);
        if (!Array.isArray(candidate)) {
          return { ok: false, exists: true, code: "BACKUP_CORRUPTED", error: "Bản dự phòng không phải danh sách đặt phòng hợp lệ." };
        }
        const validated = validateAndSanitizeImport(candidate);
        if (!validated.ok) {
          return { ok: false, exists: true, code: "BACKUP_CORRUPTED", error: "Bản dự phòng bị lỗi dữ liệu: " + validated.error };
        }
        return { ok: true, exists: true, bookings: validated.bookings };
      } catch {
        return { ok: false, exists: true, code: "BACKUP_CORRUPTED", error: "Bản dự phòng bị hỏng cú pháp JSON." };
      }
    }

    function quarantineRawCorrupt(rawText, reason) {
      if (rawText === null || rawText === undefined) return;
      try {
        storageAdapter.setItem(keys.quarantine, JSON.stringify({
          quarantinedAt: new Date().toISOString(),
          reason,
          raw: rawText
        }));
      } catch {
        // Best-effort forensic quarantine
      }
    }

    function readAudit() {
      try {
        const raw = storageAdapter.getItem(keys.audit);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function appendAudit(entry) {
      const logs = readAudit();
      const logEntry = {
        id: `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        ts: new Date().toISOString(),
        ...entry
      };
      logs.unshift(logEntry);
      if (logs.length > MAX_AUDIT_ENTRIES) logs.length = MAX_AUDIT_ENTRIES;
      cachedAudit = logs;
      try {
        storageAdapter.setItem(keys.audit, JSON.stringify(logs));
      } catch {
        // Audit log failure must not corrupt primary booking commit
      }
      return logEntry;
    }

    function readAutoBackups() {
      try {
        const raw = storageAdapter.getItem(keys.autobackups);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function recordAutoBackup(action, summary, nextBookings, meta = {}) {
      const snapshotId = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const entry = {
        id: snapshotId,
        ts: new Date().toISOString(),
        action,
        summary,
        roomId: meta.roomId || "",
        guestName: meta.guestName || "",
        confirmedBy: meta.confirmedBy || "",
        count: Array.isArray(nextBookings) ? nextBookings.length : 0,
        bookings: Array.isArray(nextBookings) ? nextBookings : []
      };
      const list = readAutoBackups();
      list.unshift(entry);
      if (list.length > maxAutoBackups) list.length = maxAutoBackups;

      // Gracefully trim older snapshots if browser quota is tight (never fail primary commit)
      while (list.length > 0) {
        try {
          storageAdapter.setItem(keys.autobackups, JSON.stringify(list));
          return snapshotId;
        } catch {
          list.pop();
        }
      }
      return null;
    }

    function persistListCAS(nextBookings, previousBookings, expectedSnapshot, verifyCommitted) {
      const txId = nextTxId();
      const nextStoreVersion = ((expectedSnapshot && expectedSnapshot.storeVersion) || 0) + 1;
      const serializedNext = JSON.stringify(nextBookings);
      const nextMetaStr = JSON.stringify({
        updatedAt: new Date().toISOString(),
        count: nextBookings.length,
        txId,
        storeVersion: nextStoreVersion
      });

      try {
        if (Array.isArray(previousBookings)) {
          storageAdapter.setItem(keys.backup, JSON.stringify({
            savedAt: new Date().toISOString(),
            bookings: previousBookings
          }));
        }

        // Pre-write CAS guard: ensure no concurrent tab modified storage between read and write
        if (expectedSnapshot) {
          const preRaw = storageAdapter.getItem(keys.data);
          const preMeta = storageAdapter.getItem(keys.meta);
          const expectedRaw = expectedSnapshot.raw === undefined ? null : expectedSnapshot.raw;
          const expectedMeta = expectedSnapshot.metaRaw === undefined ? null : expectedSnapshot.metaRaw;
          if (preRaw !== expectedRaw || preMeta !== expectedMeta) {
            return {
              ok: false,
              retryable: true,
              code: "CONFLICT_CONCURRENT_WRITE",
              error: "Dữ liệu vừa thay đổi ở tab/cửa sổ khác trước khi ghi."
            };
          }
        }

        storageAdapter.setItem(keys.data, serializedNext);
        storageAdapter.setItem(keys.meta, nextMetaStr);

        // Post-write read-back verification: ensure our commit wasn't clobbered by a concurrent tab
        const afterDataRaw = storageAdapter.getItem(keys.data);
        const afterMetaRaw = storageAdapter.getItem(keys.meta);
        if (afterDataRaw === null || afterDataRaw === undefined) {
          return {
            ok: false,
            retryable: false,
            code: "STORAGE_WRITE_FAILED",
            error: "Ghi dữ liệu không thành công (không đọc lại được dữ liệu vừa lưu)."
          };
        }

        let afterMeta = null;
        try { afterMeta = afterMetaRaw ? JSON.parse(afterMetaRaw) : null; } catch { afterMeta = null; }
        let afterList = null;
        try { afterList = JSON.parse(afterDataRaw); } catch { afterList = null; }

        const metaMatches = Boolean(afterMeta && afterMeta.txId === txId);
        const dataMatches = Array.isArray(afterList) && (typeof verifyCommitted === "function" ? verifyCommitted(afterList) : afterDataRaw === serializedNext);

        if (!metaMatches || !dataMatches) {
          return {
            ok: false,
            retryable: true,
            code: "CONFLICT_CONCURRENT_WRITE",
            error: "Phát hiện ghi đồng thời từ cửa sổ/tab khác làm lệch bản ghi."
          };
        }

        cachedBookings = nextBookings;
        storageBlocked = false;
        lastStorageError = null;
        return { ok: true, txId, storeVersion: nextStoreVersion };
      } catch {
        return {
          ok: false,
          retryable: false,
          code: "STORAGE_WRITE_FAILED",
          error: "Không thể lưu dữ liệu vào bộ nhớ trình duyệt (có thể đầy dung lượng hoặc đang ở chế độ ẩn danh). Dữ liệu cũ vẫn được giữ nguyên."
        };
      }
    }

    function readLatestStrict() {
      const rawState = readRawState();
      if (!rawState.ok) {
        storageBlocked = true;
        lastStorageError = rawState.error;
        return {
          ok: false,
          code: rawState.code,
          error: `${rawState.error} Đã hủy thao tác để tránh ghi đè dữ liệu cũ hoặc dữ liệu từ tab khác.`
        };
      }

      if (!rawState.exists) {
        if (storageBlocked) {
          return {
            ok: false,
            code: "STORAGE_CORRUPTED",
            error: lastStorageError || "Bộ nhớ đang ở chế độ khóa bảo vệ dữ liệu. Vui lòng Khôi phục JSON hoặc chủ động Đặt lại dữ liệu mẫu."
          };
        }
        return {
          ok: true,
          bookings: [],
          snapshot: { raw: null, metaRaw: rawState.metaRaw, storeVersion: rawState.storeVersion }
        };
      }

      normalizeDormSlots(rawState.list);
      cachedBookings = rawState.list;
      storageBlocked = false;
      lastStorageError = null;
      return {
        ok: true,
        bookings: rawState.list,
        snapshot: { raw: rawState.raw, metaRaw: rawState.metaRaw, storeVersion: rawState.storeVersion }
      };
    }

    function load() {
      const rawState = readRawState();

      // Case 1: Primary storage readable & exists
      if (rawState.ok && rawState.exists) {
        normalizeDormSlots(rawState.list);
        cachedBookings = rawState.list;
        cachedAudit = readAudit();
        storageBlocked = false;
        lastStorageError = null;
        return { ok: true, bookings: cachedBookings, recoveredFromBackup: false };
      }

      // Case 2: Storage threw a read exception — NEVER overwrite or seed sample data
      if (!rawState.ok && rawState.code === "STORAGE_READ_FAILED") {
        storageBlocked = true;
        lastStorageError = rawState.error;
        cachedBookings = [];
        cachedAudit = [];
        return {
          ok: false,
          code: "STORAGE_READ_FAILED",
          corrupted: false,
          recoveredFromBackup: false,
          error: rawState.error + " Ứng dụng đã tạm khóa ghi để bảo vệ dữ liệu hiện có.",
          bookings: []
        };
      }

      // Case 3: Primary storage is corrupted — attempt validated recovery from backup ONLY
      if (!rawState.ok && rawState.code === "STORAGE_CORRUPTED") {
        const bkRes = readValidatedBackup();
        if (bkRes.ok) {
          quarantineRawCorrupt(rawState.raw, rawState.error);
          const recovered = bkRes.bookings;
          normalizeDormSlots(recovered);
          const persistRes = persistListCAS(recovered, null, null, (list) => list.length === recovered.length);
          if (!persistRes.ok) {
            storageBlocked = true;
            lastStorageError = persistRes.error;
            return {
              ok: false,
              code: persistRes.code,
              corrupted: true,
              recoveredFromBackup: false,
              error: "Đã đọc được bản dự phòng nhưng không thể ghi khôi phục: " + persistRes.error,
              bookings: recovered
            };
          }
          appendAudit({ action: "AUTO_RECOVER", summary: `Khôi phục tự động ${recovered.length} booking từ bản dự phòng sau lỗi đọc sổ chính.` });
          cachedAudit = readAudit();
          return { ok: true, bookings: cachedBookings, recoveredFromBackup: true };
        }

        // BOTH primary and backup are missing/corrupted — DO NOT overwrite primary, DO NOT seed sample!
        storageBlocked = true;
        lastStorageError = "Cả sổ đặt phòng chính và bản dự phòng đều bị hỏng. Đã giữ nguyên bộ nhớ gốc và khóa ghi để tránh mất dữ liệu.";
        cachedBookings = [];
        cachedAudit = readAudit();
        return {
          ok: false,
          code: "STORAGE_CORRUPTED",
          corrupted: true,
          recoveredFromBackup: false,
          error: lastStorageError + " Vui lòng dùng 'Khôi phục JSON' từ file sao lưu hoặc chủ động bấm 'Dữ liệu mẫu'.",
          bookings: []
        };
      }

      // Case 4: Primary key does not exist (raw === null)
      const bkRes = readValidatedBackup();
      if (bkRes.ok) {
        const recovered = bkRes.bookings;
        normalizeDormSlots(recovered);
        const persistRes = persistListCAS(recovered, null, null, (list) => list.length === recovered.length);
        if (!persistRes.ok) {
          storageBlocked = true;
          lastStorageError = persistRes.error;
          return { ok: false, code: persistRes.code, corrupted: true, recoveredFromBackup: false, error: persistRes.error, bookings: recovered };
        }
        appendAudit({ action: "AUTO_RECOVER", summary: `Khôi phục tự động ${recovered.length} booking từ bản dự phòng khi sổ chính bị trống.` });
        cachedAudit = readAudit();
        return { ok: true, bookings: cachedBookings, recoveredFromBackup: true };
      }

      // If backup or meta existed but backup is corrupted -> NOT a clean first run! Refuse to seed sample data.
      if (bkRes.exists || rawState.metaExists) {
        storageBlocked = true;
        lastStorageError = "Sổ đặt phòng chính bị mất và bản dự phòng không hợp lệ. Đã khóa ghi để bảo vệ dữ liệu.";
        cachedBookings = [];
        cachedAudit = readAudit();
        return {
          ok: false,
          code: "STORAGE_CORRUPTED",
          corrupted: true,
          recoveredFromBackup: false,
          error: lastStorageError + " Vui lòng dùng 'Khôi phục JSON' hoặc chủ động bấm 'Dữ liệu mẫu'.",
          bookings: []
        };
      }

      // True clean first-run (no primary, no backup, no meta)
      if (seedOnEmpty) {
        const sample = createSampleBookings();
        normalizeDormSlots(sample);
        const persistRes = persistListCAS(sample, null, { raw: null, metaRaw: null, storeVersion: 0 }, (list) => list.length === sample.length);
        if (!persistRes.ok) {
          storageBlocked = true;
          lastStorageError = persistRes.error;
          cachedBookings = [];
          return {
            ok: false,
            code: persistRes.code,
            corrupted: false,
            recoveredFromBackup: false,
            error: "Không thể khởi tạo dữ liệu mẫu vào bộ nhớ: " + persistRes.error,
            bookings: []
          };
        }
      } else {
        cachedBookings = [];
        storageBlocked = false;
        lastStorageError = null;
      }
      cachedAudit = readAudit();
      return { ok: true, bookings: cachedBookings, recoveredFromBackup: false };
    }

    // Read-only UI refresh: never mutates storage; tracks read errors for health check
    function refreshLatest() {
      const rawState = readRawState();
      if (rawState.ok) {
        if (rawState.exists) {
          normalizeDormSlots(rawState.list);
          cachedBookings = rawState.list;
          storageBlocked = false;
          lastStorageError = null;
        } else if (!storageBlocked) {
          cachedBookings = [];
        }
      } else {
        storageBlocked = true;
        lastStorageError = rawState.error;
      }
      return cachedBookings;
    }

    function saveBooking(rawInput, opts = {}) {
      const idempotencyKey = sanitizeText(opts.idempotencyKey || rawInput.idempotencyKey, 80);

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const latestRes = readLatestStrict();
        if (!latestRes.ok) {
          return { ok: false, code: latestRes.code, error: latestRes.error };
        }
        const latest = latestRes.bookings.slice();

        // Idempotency guard: prevent duplicate creation from double-clicks / retried submits
        if (idempotencyKey) {
          const dup = latest.find((b) => b.idempotencyKey && b.idempotencyKey === idempotencyKey);
          if (dup) {
            return { ok: true, idempotentHit: true, booking: dup, bookings: latest };
          }
        }

        const existingIdx = rawInput.id ? latest.findIndex((b) => b.id === rawInput.id) : -1;
        const existingRecord = existingIdx >= 0 ? latest[existingIdx] : null;

        // Optimistic concurrency lock: reject stale overwrite if edited concurrently in another tab
        if (existingRecord && opts.expectedRevision !== undefined && opts.expectedRevision !== null) {
          const currentRev = Number(existingRecord.revision) || 1;
          if (currentRev !== Number(opts.expectedRevision)) {
            return {
              ok: false,
              code: "CONFLICT_STALE_EDIT",
              error: "Đặt phòng này vừa được cập nhật ở cửa sổ/tab khác. Vui lòng mở lại để xem dữ liệu mới nhất trước khi lưu."
            };
          }
        }

        const sanitized = sanitizeBookingRecord({ ...rawInput, idempotencyKey }, existingRecord);
        if (!sanitized.ok) {
          return { ok: false, code: "VALIDATION_ERROR", error: sanitized.error };
        }

        const record = sanitized.record;
        const room = getRoomById(record.roomId);

        // Conflict check against LATEST persisted bookings
        const conflictErr = room.isDorm
          ? checkDormSlotConflict(latest, record, existingRecord ? existingRecord.id : null)
          : checkRegularConflict(latest, record, existingRecord ? existingRecord.id : null);

        if (conflictErr) {
          return { ok: false, code: "CONFLICT_OVERBOOKING", error: conflictErr };
        }

        const nextBookings = latest.slice();
        if (existingIdx >= 0) {
          nextBookings[existingIdx] = record;
        } else {
          nextBookings.push(record);
        }

        const persistRes = persistListCAS(
          nextBookings,
          latest,
          latestRes.snapshot,
          (committedList) => committedList.some((b) => b && b.id === record.id && Number(b.revision) === Number(record.revision) && b.updatedAt === record.updatedAt)
        );

        if (!persistRes.ok) {
          if (persistRes.retryable && attempt + 1 < maxRetries) {
            continue;
          }
          return { ok: false, code: persistRes.code, error: persistRes.error };
        }

        const action = existingRecord ? "UPDATE" : "CREATE";
        const summary = `${existingRecord ? "Cập nhật" : "Đặt mới"} P.${room.name} (${formatDateVN(record.checkin)} → ${formatDateVN(record.checkout)}) — ${record.guestName}${record.confirmedBy ? ` • XN: ${record.confirmedBy}` : ""}`;
        const changes = existingRecord ? diffBookingChanges(existingRecord, record) : [];
        const snapshotId = recordAutoBackup(action, summary, nextBookings, {
          roomId: record.roomId,
          guestName: record.guestName,
          confirmedBy: record.confirmedBy || ""
        });

        appendAudit({
          action,
          bookingId: record.id,
          roomId: record.roomId,
          guestName: record.guestName,
          confirmedBy: record.confirmedBy || "",
          totalAmount: record.totalAmount,
          paidAmount: record.paidAmount,
          remaining: getRemaining(record),
          changes,
          snapshotId,
          summary
        });

        return { ok: true, isUpdate: Boolean(existingRecord), booking: record, bookings: nextBookings, snapshotId };
      }

      return {
        ok: false,
        code: "CONFLICT_CONCURRENT_WRITE",
        error: "Phát hiện nhiều tab cùng lưu dữ liệu liên tục. Dữ liệu chưa được ghi nhận — vui lòng bấm Lưu lại."
      };
    }

    function deleteBooking(bookingId, opts = {}) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const latestRes = readLatestStrict();
        if (!latestRes.ok) {
          return { ok: false, code: latestRes.code, error: latestRes.error };
        }
        const latest = latestRes.bookings.slice();
        const idx = latest.findIndex((b) => b.id === bookingId);
        if (idx < 0) {
          return { ok: false, code: "NOT_FOUND", error: "Đặt phòng không tồn tại hoặc đã bị xóa ở cửa sổ khác." };
        }
        const target = latest[idx];
        if (opts.expectedRevision !== undefined && opts.expectedRevision !== null) {
          const currentRev = Number(target.revision) || 1;
          if (currentRev !== Number(opts.expectedRevision)) {
            return {
              ok: false,
              code: "CONFLICT_STALE_EDIT",
              error: "Đặt phòng này vừa được chỉnh sửa ở cửa sổ khác. Vui lòng tải lại trước khi xóa."
            };
          }
        }

        const nextBookings = latest.filter((b) => b.id !== bookingId);
        const persistRes = persistListCAS(
          nextBookings,
          latest,
          latestRes.snapshot,
          (committedList) => !committedList.some((b) => b && b.id === bookingId)
        );

        if (!persistRes.ok) {
          if (persistRes.retryable && attempt + 1 < maxRetries) {
            continue;
          }
          return { ok: false, code: persistRes.code, error: persistRes.error };
        }

        const room = getRoomById(target.roomId);
        const summary = `Xóa đặt phòng P.${room ? room.name : target.roomId} (${formatDateVN(target.checkin)} → ${formatDateVN(target.checkout)}) — ${target.guestName}${target.confirmedBy ? ` • XN: ${target.confirmedBy}` : ""}`;
        const snapshotId = recordAutoBackup("DELETE", summary, nextBookings, {
          roomId: target.roomId,
          guestName: target.guestName,
          confirmedBy: target.confirmedBy || ""
        });
        appendAudit({
          action: "DELETE",
          bookingId: target.id,
          roomId: target.roomId,
          guestName: target.guestName,
          confirmedBy: target.confirmedBy || "",
          totalAmount: target.totalAmount,
          paidAmount: target.paidAmount,
          remaining: getRemaining(target),
          changes: [
            { field: "Trạng thái", before: `Đã đặt (${formatVND(target.totalAmount)})`, after: "Đã xóa khỏi lịch" }
          ],
          snapshotId,
          summary
        });

        return { ok: true, deleted: target, bookings: nextBookings, snapshotId };
      }

      return {
        ok: false,
        code: "CONFLICT_CONCURRENT_WRITE",
        error: "Phát hiện nhiều tab cùng ghi dữ liệu liên tục. Vui lòng thử xóa lại."
      };
    }

    function restoreFromImport(rawPayload) {
      const inspected = inspectBackupPayload(rawPayload);
      if (!inspected.ok) return { ok: false, code: inspected.code || "INVALID_IMPORT", error: inspected.error, details: inspected.details };

      const rawState = readRawState();
      if (!rawState.ok && rawState.code === "STORAGE_READ_FAILED") {
        return { ok: false, code: "STORAGE_READ_FAILED", error: rawState.error + " Không thể khôi phục khi bộ nhớ không đọc được." };
      }
      if (!rawState.ok && rawState.code === "STORAGE_CORRUPTED") {
        quarantineRawCorrupt(rawState.raw, "Trước khi khôi phục JSON thủ công");
      }

      const preExisting = {
        bookings: rawState.ok && rawState.exists ? rawState.list.slice() : [],
        financeState: getFinanceState(),
        operatingCosts: getOperatingCosts(),
        housekeepingTasks: getHousekeepingTasks(),
        maintenanceIssues: getMaintenanceIssues()
      };

      const previousList = rawState.ok && rawState.exists ? rawState.list.slice() : null;
      const expectedSnap = rawState.ok ? { raw: rawState.raw, metaRaw: rawState.metaRaw, storeVersion: rawState.storeVersion } : null;
      const persistRes = persistListCAS(inspected.sanitized.bookings, previousList, expectedSnap, (list) => list.length === inspected.sanitized.bookings.length);
      if (!persistRes.ok) return { ok: false, code: persistRes.code, error: persistRes.error };

      try {
        if (inspected.hasFinanceState && inspected.sanitized.financeState) {
          const fRes = saveFinanceState(inspected.sanitized.financeState);
          if (!fRes.ok) throw new Error(fRes.error || "Không thể ghi sổ tài chính.");
        }
        if (inspected.hasOperatingCosts && inspected.sanitized.operatingCosts) {
          const cRes = saveOperatingCosts(inspected.sanitized.operatingCosts);
          if (!cRes.ok) throw new Error(cRes.error || "Không thể ghi chi phí vận hành.");
        }
        if (inspected.hasHousekeepingTasks && inspected.sanitized.housekeepingTasks) {
          const hkRes = saveHousekeepingTasks(inspected.sanitized.housekeepingTasks);
          if (!hkRes.ok) throw new Error(hkRes.error || "Không thể ghi danh sách buồng phòng.");
        }
        if (inspected.hasMaintenanceIssues && inspected.sanitized.maintenanceIssues) {
          const issRes = saveMaintenanceIssues(inspected.sanitized.maintenanceIssues);
          if (!issRes.ok) throw new Error(issRes.error || "Không thể ghi danh sách sự cố.");
        }
      } catch (err) {
        // Rollback local storage to pre-existing snapshot
        try {
          if (previousList) persistListCAS(previousList, null, null);
          saveFinanceState(preExisting.financeState);
          saveOperatingCosts(preExisting.operatingCosts);
          saveHousekeepingTasks(preExisting.housekeepingTasks);
          saveMaintenanceIssues(preExisting.maintenanceIssues);
        } catch {}
        return {
          ok: false,
          code: "RESTORE_ROLLED_BACK",
          error: `Khôi phục bị gián đoạn và đã tự hoàn tác toàn bộ dữ liệu gốc: ${err && err.message ? err.message : "lỗi ghi dữ liệu"}`
        };
      }

      const actualState = {
        bookings: getBookings(),
        financeState: getFinanceState(),
        operatingCosts: getOperatingCosts(),
        housekeepingTasks: getHousekeepingTasks(),
        maintenanceIssues: getMaintenanceIssues()
      };
      const verification = verifyRestoredState(inspected, actualState, preExisting);
      const restoredSections = inspected.presentSections.slice();
      const preservedSections = inspected.missingSections.slice();

      const summary = `Khôi phục ${actualState.bookings.length} lượt đặt phòng${inspected.hasFinanceState ? `, ${actualState.financeState.transactions.length} chứng từ tài chính` : " (giữ nguyên sổ tài chính hiện có)"} từ file JSON v${inspected.version}.`;
      const snapshotId = recordAutoBackup("RESTORE", summary, actualState.bookings);
      appendAudit({ action: "RESTORE", snapshotId, summary });

      return {
        ok: true,
        bookings: actualState.bookings,
        financeState: actualState.financeState,
        operatingCosts: actualState.operatingCosts,
        housekeepingTasks: actualState.housekeepingTasks,
        maintenanceIssues: actualState.maintenanceIssues,
        restoredSections,
        preservedSections,
        mediaInventory: inspected.mediaInventory,
        verification,
        snapshotId
      };
    }

    function rollbackLastChange() {
      const bkRes = readValidatedBackup();
      if (!bkRes.ok) {
        return { ok: false, code: bkRes.code, error: bkRes.error };
      }
      const rawState = readRawState();
      if (!rawState.ok && rawState.code === "STORAGE_READ_FAILED") {
        return { ok: false, code: "STORAGE_READ_FAILED", error: rawState.error };
      }
      if (!rawState.ok && rawState.code === "STORAGE_CORRUPTED") {
        quarantineRawCorrupt(rawState.raw, "Trước khi hoàn tác từ bản dự phòng");
      }
      const current = rawState.ok && rawState.exists ? rawState.list.slice() : null;
      const expectedSnap = rawState.ok ? { raw: rawState.raw, metaRaw: rawState.metaRaw, storeVersion: rawState.storeVersion } : null;
      const persistRes = persistListCAS(bkRes.bookings, current, expectedSnap, (list) => list.length === bkRes.bookings.length);
      if (!persistRes.ok) return { ok: false, code: persistRes.code, error: persistRes.error };

      const summary = `Hoàn tác dữ liệu về bản dự phòng (${bkRes.bookings.length} lượt đặt phòng).`;
      const snapshotId = recordAutoBackup("ROLLBACK", summary, bkRes.bookings);
      appendAudit({ action: "ROLLBACK", snapshotId, summary });
      return { ok: true, bookings: bkRes.bookings, snapshotId };
    }

    function getAutoBackups() {
      return readAutoBackups();
    }

    function restoreFromAutoBackup(snapshotId) {
      const snaps = readAutoBackups();
      const targetSnap = snaps.find((s) => s && s.id === snapshotId);
      if (!targetSnap || !Array.isArray(targetSnap.bookings)) {
        return { ok: false, code: "NOT_FOUND", error: "Không tìm thấy mốc sao lưu tự động tương ứng." };
      }
      const validated = validateAndSanitizeImport(targetSnap.bookings);
      if (!validated.ok) {
        return { ok: false, code: "INVALID_IMPORT", error: "Mốc sao lưu không hợp lệ: " + validated.error };
      }
      const rawState = readRawState();
      if (!rawState.ok && rawState.code === "STORAGE_READ_FAILED") {
        return { ok: false, code: "STORAGE_READ_FAILED", error: rawState.error };
      }
      if (!rawState.ok && rawState.code === "STORAGE_CORRUPTED") {
        quarantineRawCorrupt(rawState.raw, "Trước khi khôi phục mốc sao lưu tự động");
      }
      const current = rawState.ok && rawState.exists ? rawState.list.slice() : null;
      const expectedSnap = rawState.ok ? { raw: rawState.raw, metaRaw: rawState.metaRaw, storeVersion: rawState.storeVersion } : null;
      const persistRes = persistListCAS(validated.bookings, current, expectedSnap, (list) => list.length === validated.bookings.length);
      if (!persistRes.ok) return { ok: false, code: persistRes.code, error: persistRes.error };

      const summary = `Khôi phục về mốc sao lưu tự động (${validated.bookings.length} đơn — ${targetSnap.summary || targetSnap.ts}).`;
      const newSnapId = recordAutoBackup("AUTOBACKUP_RESTORE", summary, validated.bookings);
      appendAudit({ action: "AUTOBACKUP_RESTORE", restoredFromSnapshotId: snapshotId, snapshotId: newSnapId, summary });
      return { ok: true, bookings: validated.bookings, snapshotId: newSnapId };
    }

    function resetToSample(baseDateISO) {
      const rawState = readRawState();
      if (!rawState.ok && rawState.code === "STORAGE_READ_FAILED") {
        return { ok: false, code: "STORAGE_READ_FAILED", error: rawState.error };
      }
      if (!rawState.ok && rawState.code === "STORAGE_CORRUPTED") {
        quarantineRawCorrupt(rawState.raw, "Trước khi đặt lại dữ liệu mẫu thủ công");
      }
      const latest = rawState.ok && rawState.exists ? rawState.list.slice() : null;
      const sample = createSampleBookings(baseDateISO);
      normalizeDormSlots(sample);
      const expectedSnap = rawState.ok ? { raw: rawState.raw, metaRaw: rawState.metaRaw, storeVersion: rawState.storeVersion } : null;
      const persistRes = persistListCAS(sample, latest, expectedSnap, (list) => list.length === sample.length);
      if (!persistRes.ok) return { ok: false, code: persistRes.code, error: persistRes.error };
      const summary = "Khôi phục danh sách đặt phòng mẫu.";
      const snapshotId = recordAutoBackup("RESET_SAMPLE", summary, sample);
      appendAudit({ action: "RESET_SAMPLE", snapshotId, summary });
      return { ok: true, bookings: sample, snapshotId };
    }

    function getBookings() {
      return cachedBookings;
    }

    function getAuditLogs() {
      cachedAudit = readAudit();
      return cachedAudit;
    }

    function hasRollbackBackup() {
      return readValidatedBackup().ok;
    }

    function getStorageStatus() {
      return {
        blocked: storageBlocked,
        lastError: lastStorageError
      };
    }

    function runHealthCheck() {
      const rawState = readRawState();
      let storageWritable = true;
      try {
        const probeKey = "__ks_health_probe__";
        storageAdapter.setItem(probeKey, "1");
        if (typeof storageAdapter.removeItem === "function") storageAdapter.removeItem(probeKey);
      } catch {
        storageWritable = false;
      }

      if (!rawState.ok) {
        return {
          ok: false,
          storageReadable: rawState.code !== "STORAGE_READ_FAILED",
          storageCorrupted: rawState.code === "STORAGE_CORRUPTED",
          storageWritable,
          consistencyErrors: [rawState.error],
          bookingCount: cachedBookings.length,
          hasRollbackBackup: hasRollbackBackup(),
          autoBackupCount: readAutoBackups().length,
          auditLogCount: getAuditLogs().length,
          checkedAt: new Date().toISOString()
        };
      }

      const list = rawState.exists ? rawState.list : [];
      const consistency = auditBookingConsistency(list);
      return {
        ok: consistency.ok && storageWritable && !storageBlocked,
        storageReadable: true,
        storageCorrupted: false,
        storageWritable,
        consistencyErrors: storageBlocked && lastStorageError ? [lastStorageError, ...consistency.errors] : consistency.errors,
        bookingCount: list.length,
        hasRollbackBackup: hasRollbackBackup(),
        autoBackupCount: readAutoBackups().length,
        auditLogCount: getAuditLogs().length,
        checkedAt: new Date().toISOString()
      };
    }

    function getOperatingCosts() {
      try {
        const raw = storageAdapter.getItem(OPERATING_COSTS_KEY);
        if (!raw) return createDefaultOperatingCostsState();
        return sanitizeOperatingCostsState(JSON.parse(raw));
      } catch {
        return createDefaultOperatingCostsState();
      }
    }

    function saveOperatingCosts(nextState) {
      const clean = sanitizeOperatingCostsState(nextState);
      clean.updatedAt = new Date().toISOString();
      try {
        storageAdapter.setItem(OPERATING_COSTS_KEY, JSON.stringify(clean));
        return { ok: true, operatingCosts: clean };
      } catch (err) {
        return { ok: false, error: `Không thể lưu chi phí vận hành: ${err && err.message ? err.message : "lỗi bộ nhớ"}` };
      }
    }

    function getFinanceState() {
      try {
        const raw = storageAdapter.getItem(FINANCE_KEY);
        if (!raw) return createDefaultFinanceState();
        return sanitizeFinanceState(JSON.parse(raw));
      } catch {
        return createDefaultFinanceState();
      }
    }

    function saveFinanceState(nextState) {
      const clean = sanitizeFinanceState(nextState);
      clean.updatedAt = new Date().toISOString();
      try {
        storageAdapter.setItem(FINANCE_KEY, JSON.stringify(clean));
        return { ok: true, financeState: clean };
      } catch (err) {
        return { ok: false, error: `Không thể lưu sổ quỹ & tài chính: ${err && err.message ? err.message : "lỗi bộ nhớ"}` };
      }
    }

    function getHousekeepingTasks() {
      try {
        const raw = storageAdapter.getItem(HOUSEKEEPING_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(sanitizeHousekeepingTask).filter(Boolean) : [];
      } catch {
        return [];
      }
    }

    function saveHousekeepingTasks(tasks) {
      const clean = (Array.isArray(tasks) ? tasks : []).map(sanitizeHousekeepingTask).filter(Boolean);
      try {
        storageAdapter.setItem(HOUSEKEEPING_KEY, JSON.stringify(clean));
        return { ok: true, housekeepingTasks: clean };
      } catch (err) {
        return { ok: false, error: `Không thể lưu danh sách buồng phòng: ${err && err.message ? err.message : "lỗi bộ nhớ"}` };
      }
    }

    function getMaintenanceIssues() {
      try {
        const raw = storageAdapter.getItem(ISSUES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(sanitizeMaintenanceIssue).filter(Boolean) : [];
      } catch {
        return [];
      }
    }

    function saveMaintenanceIssues(issues) {
      const clean = (Array.isArray(issues) ? issues : []).map(sanitizeMaintenanceIssue).filter(Boolean);
      try {
        storageAdapter.setItem(ISSUES_KEY, JSON.stringify(clean));
        return { ok: true, maintenanceIssues: clean };
      } catch (err) {
        return { ok: false, error: `Không thể lưu danh sách sự cố: ${err && err.message ? err.message : "lỗi bộ nhớ"}` };
      }
    }

    function checkoutBooking(bookingId, actorName = "Lễ tân", serviceDate = "") {
      const latest = refreshLatest();
      const target = latest.find((b) => b.id === bookingId);
      if (!target) return { ok: false, code: "NOT_FOUND", error: "Không tìm thấy đặt phòng để check-out." };
      const tasks = getHousekeepingTasks();
      const idemKey = `checkout:${target.id}`;
      const existingTask = tasks.find((t) => t.idempotencyKey === idemKey);
      let updatedBooking = target;
      if (!target.checkedOutAt) {
        const saveRes = saveBooking({
          ...target,
          checkedOutAt: new Date().toISOString(),
          checkedOutBy: sanitizeText(actorName, 60) || "Lễ tân"
        });
        if (!saveRes.ok) return saveRes;
        updatedBooking = saveRes.booking;
      }
      if (existingTask) {
        return { ok: true, idempotentHit: true, booking: updatedBooking, bookings: getBookings(), task: existingTask, housekeepingTasks: tasks };
      }
      const newTask = sanitizeHousekeepingTask({
        roomId: target.roomId,
        taskType: "checkout",
        status: "dirty",
        serviceDate: isValidISODate(serviceDate) ? serviceDate : getTodayISO(),
        sourceBookingId: target.id,
        idempotencyKey: idemKey,
        note: buildCheckoutHousekeepingNote(target),
        createdBy: sanitizeText(actorName, 60) || "Lễ tân"
      });
      const nextTasks = [newTask, ...tasks];
      const saveTaskRes = saveHousekeepingTasks(nextTasks);
      if (!saveTaskRes.ok) return saveTaskRes;
      return { ok: true, idempotentHit: false, booking: updatedBooking, bookings: getBookings(), task: newTask, housekeepingTasks: saveTaskRes.housekeepingTasks };
    }

    function ensureSuperAdminInList(list) {
      const clean = (Array.isArray(list) ? list : [])
        .map((a) => {
          const pub = sanitizeStaffAccountPublic(a);
          if (!pub) return null;
          return { ...pub, passHash: typeof a.passHash === "string" ? a.passHash : "" };
        })
        .filter(Boolean);
      const hasSuper = clean.some((a) => a.role === "super_admin");
      if (!hasSuper) {
        const nowIso = new Date().toISOString();
        clean.unshift({
          id: "acc_super_admin",
          username: SUPER_ADMIN_USERNAME,
          staffName: SUPER_ADMIN_DISPLAY_NAME,
          role: "super_admin",
          active: true,
          passHash: "",
          createdAt: nowIso,
          updatedAt: nowIso
        });
      }
      return clean;
    }

    function getStaffAccounts() {
      try {
        const raw = storageAdapter.getItem(ACCOUNTS_KEY);
        if (!raw) return ensureSuperAdminInList([]);
        const parsed = JSON.parse(raw);
        return ensureSuperAdminInList(parsed);
      } catch {
        return ensureSuperAdminInList([]);
      }
    }

    function saveStaffAccounts(accounts) {
      const next = ensureSuperAdminInList(accounts);
      try {
        storageAdapter.setItem(ACCOUNTS_KEY, JSON.stringify(next));
        return { ok: true, accounts: next.map((a) => sanitizeStaffAccountPublic(a)) };
      } catch (err) {
        return { ok: false, error: "Không lưu được danh sách tài khoản cục bộ" + (err && err.message ? ` (${err.message})` : ".") };
      }
    }

    return {
      load,
      refreshLatest,
      getBookings,
      getAuditLogs,
      getAutoBackups,
      hasRollbackBackup,
      getStorageStatus,
      getOperatingCosts,
      saveOperatingCosts,
      getFinanceState,
      saveFinanceState,
      getHousekeepingTasks,
      saveHousekeepingTasks,
      getMaintenanceIssues,
      saveMaintenanceIssues,
      getStaffAccounts,
      saveStaffAccounts,
      checkoutBooking,
      saveBooking,
      deleteBooking,
      restoreFromImport,
      restoreFromAutoBackup,
      rollbackLastChange,
      resetToSample,
      runHealthCheck
    };
  }

  /* -------------------- Phase 1 Finance & Accounting Engine (Thu tiền, Công nợ & Sổ quỹ) -------------------- */

  const FINANCE_FUNDS = Object.freeze([
    Object.freeze({ id: "cash_frontdesk", name: "Quỹ tiền mặt lễ tân", shortName: "Tiền mặt", kind: "cash", isLegacyBucket: false }),
    Object.freeze({ id: "bank_main", name: "Tài khoản ngân hàng khách sạn", shortName: "Ngân hàng", kind: "bank", isLegacyBucket: false }),
    Object.freeze({ id: "unassigned_legacy", name: "Dữ liệu chuyển tiếp – chưa xác định quỹ", shortName: "Chuyển tiếp (chưa gán quỹ)", kind: "legacy", isLegacyBucket: true })
  ]);

  const PAYMENT_METHODS = Object.freeze([
    Object.freeze({ key: "cash", label: "Tiền mặt", defaultFundId: "cash_frontdesk" }),
    Object.freeze({ key: "bank_transfer", label: "Chuyển khoản ngân hàng", defaultFundId: "bank_main" }),
    Object.freeze({ key: "card", label: "Quẹt thẻ / POS", defaultFundId: "bank_main" }),
    Object.freeze({ key: "ota_payout", label: "OTA đối soát chuyển khoản", defaultFundId: "bank_main" }),
    Object.freeze({ key: "other", label: "Phương thức khác", defaultFundId: "cash_frontdesk" })
  ]);

  const FINANCE_TX_TYPES = Object.freeze({
    customer_payment: Object.freeze({ key: "customer_payment", label: "Thu tiền khách", shortLabel: "Thu khách", prefix: "PT" }),
    customer_refund: Object.freeze({ key: "customer_refund", label: "Hoàn tiền khách", shortLabel: "Hoàn khách", prefix: "PH" }),
    supplier_payment: Object.freeze({ key: "supplier_payment", label: "Chi trả nhà cung cấp", shortLabel: "Chi NCC", prefix: "PC" }),
    fund_transfer: Object.freeze({ key: "fund_transfer", label: "Chuyển quỹ nội bộ", shortLabel: "Chuyển quỹ", prefix: "CK" }),
    opening_balance: Object.freeze({ key: "opening_balance", label: "Số dư đầu kỳ", shortLabel: "Đầu kỳ", prefix: "DK" }),
    balance_adjustment: Object.freeze({ key: "balance_adjustment", label: "Điều chỉnh số dư quỹ", shortLabel: "Điều chỉnh quỹ", prefix: "DC" }),
    legacy_payment: Object.freeze({ key: "legacy_payment", label: "Dữ liệu chuyển tiếp – cần đối soát", shortLabel: "Chuyển tiếp", prefix: "CT" })
  });

  const SUPPLIER_INVOICE_STATUSES = Object.freeze({
    unpaid: Object.freeze({ key: "unpaid", label: "Chưa trả" }),
    partial: Object.freeze({ key: "partial", label: "Trả một phần" }),
    paid: Object.freeze({ key: "paid", label: "Đã trả" }),
    overdue: Object.freeze({ key: "overdue", label: "Quá hạn" })
  });

  const REFUND_CATEGORIES = Object.freeze({
    overpayment: Object.freeze({ key: "overpayment", label: "Hoàn tiền do khách trả thừa" }),
    cancel_deposit: Object.freeze({ key: "cancel_deposit", label: "Hoàn cọc do hủy đơn" }),
    service_reduction: Object.freeze({ key: "service_reduction", label: "Hoàn do giảm/hủy dịch vụ" }),
    other: Object.freeze({ key: "other", label: "Hoàn tiền lý do khác" })
  });

  function getFinanceFundById(fundId) {
    return FINANCE_FUNDS.find((f) => f.id === fundId) || FINANCE_FUNDS[0];
  }

  function getPaymentMethodMeta(methodKey) {
    return PAYMENT_METHODS.find((m) => m.key === methodKey) || PAYMENT_METHODS[0];
  }

  const SHIFT_STATUSES = Object.freeze({
    open: Object.freeze({ key: "open", label: "Đang trong ca" }),
    pending_handover: Object.freeze({ key: "pending_handover", label: "Chờ nhận bàn giao" }),
    confirmed: Object.freeze({ key: "confirmed", label: "Đã bàn giao" })
  });

  function createDefaultFinanceState() {
    return {
      version: 3,
      ledgerVersion: 0,
      voucherSeq: 0,
      transactions: [],
      supplierInvoices: [],
      cashShifts: [],
      openingBalances: [],
      reconciliationChecks: [],
      syncLogs: [],
      migrationHistory: [],
      updatedAt: new Date().toISOString()
    };
  }

  function sanitizeCashShift(raw, idx = 0) {
    const obj = stripDangerousKeys(raw);
    if (!obj || typeof obj !== "object") return null;
    const id = sanitizeText(obj.id, 80) || `shift_${Date.now().toString(36)}_${idx}`;
    const fundId = FINANCE_FUNDS.some((f) => f.id === obj.fundId && !f.isLegacyBucket)
      ? obj.fundId
      : "cash_frontdesk";
    const status = SHIFT_STATUSES[obj.status] ? obj.status : "open";
    const openedAt = sanitizeText(obj.openedAt, 40) || getVietnamNowISO();
    const openParts = toVietnamParts(openedAt);
    const shiftDate = isValidISODate(obj.shiftDate)
      ? obj.shiftDate
      : (openParts ? formatDateISO(openParts.year, openParts.month - 1, openParts.day) : getVietnamTodayISO());
    const shiftCode = sanitizeText(obj.shiftCode, 48)
      || `CA-${shiftDate.replace(/-/g, "")}-${String(idx + 1).padStart(2, "0")}`;

    const openingBasisType = ["previous_shift", "opening_balance", "opening_count", "unestablished"].includes(obj.openingBasisType)
      ? obj.openingBasisType
      : "unestablished";
    const openingCash = parseSignedVND(obj.openingCash);
    const expectedCash = obj.expectedCash !== undefined && obj.expectedCash !== null && obj.expectedCash !== ""
      ? parseSignedVND(obj.expectedCash)
      : openingCash;
    const countedCash = obj.countedCash !== undefined && obj.countedCash !== null && obj.countedCash !== ""
      ? parseSignedVND(obj.countedCash)
      : null;
    const discrepancy = countedCash !== null
      ? roundVND(countedCash - expectedCash)
      : (obj.discrepancy !== undefined && obj.discrepancy !== null && obj.discrepancy !== "" ? parseSignedVND(obj.discrepancy) : 0);
    const receivedCash = obj.receivedCash !== undefined && obj.receivedCash !== null && obj.receivedCash !== ""
      ? parseSignedVND(obj.receivedCash)
      : null;
    const handoverCountDiff = (receivedCash !== null && countedCash !== null)
      ? roundVND(receivedCash - countedCash)
      : 0;
    const hasAnyDiff = (countedCash !== null && discrepancy !== 0) || (receivedCash !== null && handoverCountDiff !== 0);
    const rawDiscStatus = String(obj.discrepancyStatus || "").trim();
    const discrepancyStatus = rawDiscStatus === "resolved"
      ? "resolved"
      : (rawDiscStatus === "pending_review" || hasAnyDiff ? "pending_review" : "none");

    const includedTxIds = Array.isArray(obj.includedTxIds)
      ? [...new Set(obj.includedTxIds.map((x) => sanitizeText(x, 80)).filter(Boolean))]
      : [];
    const bankRefTxIds = Array.isArray(obj.bankRefTxIds)
      ? [...new Set(obj.bankRefTxIds.map((x) => sanitizeText(x, 80)).filter(Boolean))]
      : [];
    const includedTxSnapshot = Array.isArray(obj.includedTxSnapshot)
      ? obj.includedTxSnapshot.slice(0, 500).map((s) => {
          const it = stripDangerousKeys(s) || {};
          return {
            id: sanitizeText(it.id, 80),
            voucherCode: sanitizeText(it.voucherCode, 48),
            txType: sanitizeText(it.txType, 32),
            txTypeLabel: sanitizeText(it.txTypeLabel, 60),
            fundId: sanitizeText(it.fundId, 48),
            receivedDate: sanitizeText(it.receivedDate, 20),
            recordedAt: sanitizeText(it.recordedAt, 40),
            signedCashImpact: parseSignedVND(it.signedCashImpact),
            amount: parseVND(it.amount),
            bookingId: sanitizeText(it.bookingId, 80),
            groupCodeDisplay: sanitizeText(it.groupCodeDisplay, 60),
            invoiceId: sanitizeText(it.invoiceId, 80),
            invoiceVoucherNo: sanitizeText(it.invoiceVoucherNo, 80),
            supplierName: sanitizeText(it.supplierName, 120),
            guestName: sanitizeText(it.guestName, 120),
            roomLabel: sanitizeText(it.roomLabel, 80),
            operator: sanitizeText(it.operator, 60),
            note: sanitizeText(it.note, 300)
          };
        })
      : [];
    const adjustmentHistory = Array.isArray(obj.adjustmentHistory)
      ? obj.adjustmentHistory.slice(0, 50).map((ah) => {
          const a = stripDangerousKeys(ah) || {};
          return {
            id: sanitizeText(a.id, 64) || `sadj_${Date.now().toString(36)}`,
            ts: sanitizeText(a.ts, 40) || new Date().toISOString(),
            operator: sanitizeText(a.operator, 60) || "Quản lý",
            action: sanitizeText(a.action, 40) || "resolve",
            adjustmentAmount: parseSignedVND(a.adjustmentAmount),
            voucherId: sanitizeText(a.voucherId, 80),
            voucherCode: sanitizeText(a.voucherCode, 48),
            reason: sanitizeText(a.reason, 300),
            note: sanitizeText(a.note, 500)
          };
        })
      : [];

    const nowISO = new Date().toISOString();
    return {
      id,
      shiftCode,
      fundId,
      shiftDate,
      shiftLabel: sanitizeText(obj.shiftLabel, 80),
      status,
      previousShiftId: sanitizeText(obj.previousShiftId, 80),
      previousShiftCode: sanitizeText(obj.previousShiftCode, 48),
      txWindowStart: sanitizeText(obj.txWindowStart, 40) || openedAt,
      openingBasisType,
      openingBasisRef: sanitizeText(obj.openingBasisRef, 200),
      openingCash,
      handedOverBy: sanitizeText(obj.handedOverBy, 60),
      outgoingStaffName: sanitizeText(obj.outgoingStaffName, 60) || "Lễ tân",
      outgoingUsername: sanitizeText(obj.outgoingUsername, 60),
      openedAt,
      openedBy: sanitizeText(obj.openedBy, 60) || sanitizeText(obj.outgoingStaffName, 60) || "Lễ tân",
      openNote: sanitizeText(obj.openNote, 400),
      openIdempotencyKey: sanitizeText(obj.openIdempotencyKey, 120) || id,
      // Close / handover submission fields (frozen at close)
      closedAt: sanitizeText(obj.closedAt, 40),
      closedBy: sanitizeText(obj.closedBy, 60),
      closeIdempotencyKey: sanitizeText(obj.closeIdempotencyKey, 120),
      cashInTotal: parseVND(obj.cashInTotal),
      cashOutTotal: parseVND(obj.cashOutTotal),
      bankRefTotal: parseVND(obj.bankRefTotal),
      expectedCash,
      countedCash,
      discrepancy,
      discrepancyExplanation: sanitizeText(obj.discrepancyExplanation, 500),
      closeNote: sanitizeText(obj.closeNote, 500),
      lastTxId: sanitizeText(obj.lastTxId, 80),
      lastTxRecordedAt: sanitizeText(obj.lastTxRecordedAt, 40),
      includedTxIds,
      bankRefTxIds,
      includedTxSnapshot,
      // Incoming receiver confirmation fields
      targetIncomingStaffName: sanitizeText(obj.targetIncomingStaffName, 60),
      incomingStaffName: sanitizeText(obj.incomingStaffName, 60),
      incomingUsername: sanitizeText(obj.incomingUsername, 60),
      receivedCash,
      handoverCountDiff,
      confirmedAt: sanitizeText(obj.confirmedAt, 40),
      confirmNote: sanitizeText(obj.confirmNote, 500),
      confirmIdempotencyKey: sanitizeText(obj.confirmIdempotencyKey, 120),
      nextShiftId: sanitizeText(obj.nextShiftId, 80),
      // Manager discrepancy resolution & post-close adjustment history
      discrepancyStatus,
      resolvedBy: sanitizeText(obj.resolvedBy, 60),
      resolvedAt: sanitizeText(obj.resolvedAt, 40),
      resolutionNote: sanitizeText(obj.resolutionNote, 500),
      adjustmentHistory,
      createdAt: sanitizeText(obj.createdAt, 40) || nowISO,
      updatedAt: sanitizeText(obj.updatedAt, 40) || nowISO,
      revision: Math.max(1, Math.trunc(Number(obj.revision) || 1))
    };
  }

  function sanitizeSupplierInvoiceAttachment(raw) {
    if (!raw || typeof raw !== "object") return null;
    const obj = stripDangerousKeys(raw);
    const name = sanitizeText(obj.name, 120);
    const rawUrl = String(obj.url || obj.dataUrl || "").trim();
    const isSafe = rawUrl.startsWith("/api/photos/") || rawUrl.startsWith("data:image/") || rawUrl.startsWith("data:application/pdf");
    if (!isSafe || rawUrl.length > 3 * 1024 * 1024) return null;
    return {
      id: sanitizeText(obj.id, 80) || `att_${Date.now().toString(36)}`,
      name: name || "chung-tu",
      mimeType: sanitizeText(obj.mimeType, 60) || "image/jpeg",
      size: Math.max(0, Math.trunc(Number(obj.size) || 0)),
      url: rawUrl
    };
  }

  function sanitizeSupplierInvoiceLine(raw, idx = 0) {
    const obj = stripDangerousKeys(raw);
    if (!obj || typeof obj !== "object") return null;
    const amount = parseVND(obj.amount);
    if (amount <= 0) return null;
    const costItemId = sanitizeText(obj.costItemId, 64) || "ci_other";
    const costItemName = sanitizeText(obj.costItemName, 100);
    const description = sanitizeText(obj.description, 240);
    return {
      id: sanitizeText(obj.id, 64) || `sline_${Date.now().toString(36)}_${idx}`,
      costItemId,
      costItemName,
      description,
      amount
    };
  }

  function sanitizeSupplierInvoice(raw, idx = 0) {
    const obj = stripDangerousKeys(raw);
    if (!obj || typeof obj !== "object") return null;
    const supplierName = sanitizeText(obj.supplierName, 120);
    if (!supplierName) return null;
    const lines = Array.isArray(obj.lines)
      ? obj.lines.map((l, i) => sanitizeSupplierInvoiceLine(l, i)).filter(Boolean)
      : [];
    const totalFromLines = lines.reduce((s, l) => s + parseVND(l.amount), 0);
    const totalAmount = lines.length > 0 ? roundVND(totalFromLines) : parseVND(obj.totalAmount);
    if (totalAmount <= 0) return null;

    const invoiceDate = normalizeFinanceDateISO(obj.invoiceDate) || getVietnamTodayISO();
    const accountingMonth = isValidMonthKey(obj.accountingMonth)
      ? obj.accountingMonth
      : invoiceDate.slice(0, 7);
    const dueDate = obj.dueDate !== undefined && String(obj.dueDate || "").trim()
      ? (normalizeFinanceDateISO(obj.dueDate) || "")
      : "";
    const id = sanitizeText(obj.id, 80) || `sinv_${Date.now().toString(36)}_${idx}`;
    const voucherNo = sanitizeText(obj.voucherNo, 80) || `HD-${accountingMonth.replace("-", "")}-${String(idx + 1).padStart(3, "0")}`;
    const linkedLegacyEntryIds = Array.isArray(obj.linkedLegacyEntryIds)
      ? [...new Set(obj.linkedLegacyEntryIds.map((x) => sanitizeText(x, 80)).filter(Boolean))]
      : [];
    const nowISO = new Date().toISOString();

    return {
      id,
      voucherNo,
      supplierName,
      invoiceDate,
      accountingMonth,
      dueDate,
      lines,
      totalAmount,
      attachment: sanitizeSupplierInvoiceAttachment(obj.attachment),
      linkedLegacyEntryIds,
      note: sanitizeText(obj.note, 500),
      createdBy: sanitizeText(obj.createdBy, 60) || "Quản lý",
      createdAt: sanitizeText(obj.createdAt, 40) || nowISO,
      updatedAt: sanitizeText(obj.updatedAt, 40) || nowISO,
      revision: Math.max(1, Math.trunc(Number(obj.revision) || 1))
    };
  }

  function sanitizeFinanceTransaction(raw, idx = 0) {
    const obj = stripDangerousKeys(raw);
    if (!obj || typeof obj !== "object") return null;
    const txType = FINANCE_TX_TYPES[obj.txType] ? obj.txType : "customer_payment";
    const id = sanitizeText(obj.id, 80) || `ftx_${Date.now().toString(36)}_${idx}`;
    const voucherCode = sanitizeText(obj.voucherCode, 48) || `${FINANCE_TX_TYPES[txType].prefix}-${String(idx + 1).padStart(4, "0")}`;
    const amount = txType === "balance_adjustment" ? parseSignedVND(obj.amount) : parseVND(obj.amount);
    const isLegacyMigrated = Boolean(obj.isLegacyMigrated || txType === "legacy_payment");
    const hasExplicitDate = obj.receivedDate !== null && obj.receivedDate !== undefined && String(obj.receivedDate).trim() !== "";
    let receivedDate = hasExplicitDate ? normalizeFinanceDateISO(obj.receivedDate) : null;
    let receivedAt = sanitizeText(obj.receivedAt, 40) || "";
    if (!isLegacyMigrated && !receivedDate) {
      const ts = normalizeFinanceTimestamp(receivedAt || obj.recordedAt);
      receivedDate = ts.receivedDate;
      receivedAt = ts.receivedAt;
    } else if (receivedDate && !receivedAt) {
      receivedAt = `${receivedDate}T12:00:00+07:00`;
    }
    const rawFund = sanitizeText(obj.fundId, 48);
    const fundId = FINANCE_FUNDS.some((f) => f.id === rawFund)
      ? rawFund
      : (isLegacyMigrated ? "unassigned_legacy" : "cash_frontdesk");
    const fromFundId = txType === "fund_transfer" && FINANCE_FUNDS.some((f) => f.id === obj.fromFundId)
      ? obj.fromFundId
      : (txType === "fund_transfer" ? fundId : "");
    const toFundId = txType === "fund_transfer" && FINANCE_FUNDS.some((f) => f.id === obj.toFundId)
      ? obj.toFundId
      : "";
    const entityType = obj.entityType === "group"
      ? "group"
      : (obj.entityType === "booking" ? "booking" : (obj.entityType === "supplier_invoice" || txType === "supplier_payment" ? "supplier_invoice" : "fund"));
    const methodKey = PAYMENT_METHODS.some((m) => m.key === obj.paymentMethod) ? obj.paymentMethod : (fundId === "bank_main" ? "bank_transfer" : "cash");
    const refundCategory = txType === "customer_refund"
      ? (REFUND_CATEGORIES[obj.refundCategory] ? obj.refundCategory : "other")
      : "";
    const rawLegacyStatus = String(obj.legacyStatus || "").trim();
    const legacyStatus = isLegacyMigrated
      ? (rawLegacyStatus === "reconciled_in_opening" ? "reconciled_in_opening" : (rawLegacyStatus === "reconciled" ? "reconciled" : "needs_reconciliation"))
      : "";
    const rawLegRes = String(obj.legacyResolution || "").trim();
    const legacyResolution = isLegacyMigrated
      ? (rawLegRes === "included_in_opening" || legacyStatus === "reconciled_in_opening"
          ? "included_in_opening"
          : (rawLegRes === "record_to_fund" || legacyStatus === "reconciled" ? "record_to_fund" : ""))
      : "";

    return {
      id,
      voucherCode,
      txType,
      entityType,
      bookingId: sanitizeText(obj.bookingId, 80),
      groupCode: normalizeGroupCode(obj.groupCode),
      groupCodeDisplay: sanitizeText(obj.groupCodeDisplay || obj.groupCode, 60),
      invoiceId: sanitizeText(obj.invoiceId, 80),
      invoiceVoucherNo: sanitizeText(obj.invoiceVoucherNo, 80),
      supplierName: sanitizeText(obj.supplierName, 120),
      amount,
      receivedDate,
      receivedAt,
      recordedAt: sanitizeText(obj.recordedAt, 40) || new Date().toISOString(),
      paymentMethod: methodKey,
      fundId,
      fromFundId,
      toFundId,
      operator: sanitizeText(obj.operator, 60) || "Hệ thống",
      approvedBy: sanitizeText(obj.approvedBy, 60),
      linkedVoucherId: sanitizeText(obj.linkedVoucherId, 80),
      linkedVoucherCode: sanitizeText(obj.linkedVoucherCode, 48),
      refundCategory,
      reason: sanitizeText(obj.reason, 300),
      note: sanitizeText(obj.note, 500),
      idempotencyKey: sanitizeText(obj.idempotencyKey, 120) || id,
      reconciled: Boolean(obj.reconciled),
      reconciledAt: sanitizeText(obj.reconciledAt, 40),
      reconciledBy: sanitizeText(obj.reconciledBy, 60),
      reconcileNote: sanitizeText(obj.reconcileNote, 300),
      reconcileEvidence: sanitizeText(obj.reconcileEvidence, 300),
      isLegacyMigrated,
      legacyStatus,
      legacyResolution,
      voucherRef: sanitizeText(obj.voucherRef, 80),
      shiftId: sanitizeText(obj.shiftId, 80)
    };
  }

  function sanitizeFinanceState(raw) {
    const base = createDefaultFinanceState();
    const obj = stripDangerousKeys(raw);
    if (!obj || typeof obj !== "object") return base;
    const transactions = Array.isArray(obj.transactions)
      ? obj.transactions.map((t, i) => sanitizeFinanceTransaction(t, i)).filter(Boolean)
      : [];
    const supplierInvoices = Array.isArray(obj.supplierInvoices)
      ? obj.supplierInvoices.map((inv, i) => sanitizeSupplierInvoice(inv, i)).filter(Boolean)
      : [];
    const cashShifts = Array.isArray(obj.cashShifts)
      ? obj.cashShifts.map((sh, i) => sanitizeCashShift(sh, i)).filter(Boolean)
      : [];
    const openingBalances = Array.isArray(obj.openingBalances)
      ? obj.openingBalances.map((ob, i) => {
          const o = stripDangerousKeys(ob) || {};
          const fundId = FINANCE_FUNDS.some((f) => f.id === o.fundId && !f.isLegacyBucket) ? o.fundId : "cash_frontdesk";
          return {
            id: sanitizeText(o.id, 64) || `ob_${fundId}_${i}`,
            fundId,
            amount: parseSignedVND(o.amount),
            asOfDate: normalizeFinanceDateISO(o.asOfDate) || getVietnamTodayISO(),
            voucherRef: sanitizeText(o.voucherRef, 80),
            note: sanitizeText(o.note, 300),
            recordedBy: sanitizeText(o.recordedBy, 60),
            recordedAt: sanitizeText(o.recordedAt, 40) || new Date().toISOString()
          };
        })
      : [];
    const reconciliationChecks = Array.isArray(obj.reconciliationChecks)
      ? obj.reconciliationChecks.map((rc, i) => {
          const r = stripDangerousKeys(rc) || {};
          const fundId = FINANCE_FUNDS.some((f) => f.id === r.fundId && !f.isLegacyBucket) ? r.fundId : "cash_frontdesk";
          return {
            id: sanitizeText(r.id, 64) || `rec_${fundId}_${i}`,
            fundId,
            asOfDate: normalizeFinanceDateISO(r.asOfDate) || getVietnamTodayISO(),
            actualBalance: parseSignedVND(r.actualBalance),
            bookBalanceAtCheck: parseSignedVND(r.bookBalanceAtCheck),
            discrepancy: parseSignedVND(r.discrepancy),
            note: sanitizeText(r.note, 300),
            checkedBy: sanitizeText(r.checkedBy, 60),
            checkedAt: sanitizeText(r.checkedAt, 40) || new Date().toISOString()
          };
        })
      : [];
    const syncLogs = Array.isArray(obj.syncLogs)
      ? obj.syncLogs.slice(0, 120).map((lg) => {
          const l = stripDangerousKeys(lg) || {};
          return {
            id: sanitizeText(l.id, 64) || `slog_${Date.now().toString(36)}`,
            ts: sanitizeText(l.ts, 40) || new Date().toISOString(),
            level: sanitizeText(l.level, 20) || "info",
            category: sanitizeText(l.category, 40) || "sync",
            message: sanitizeText(l.message, 400),
            idempotencyKey: sanitizeText(l.idempotencyKey, 120),
            operator: sanitizeText(l.operator, 60)
          };
        })
      : [];
    const migrationHistory = Array.isArray(obj.migrationHistory) ? obj.migrationHistory.slice(0, 20) : [];

    return {
      version: 3,
      ledgerVersion: Math.max(0, Math.trunc(Number(obj.ledgerVersion) || 0)),
      voucherSeq: Math.max(transactions.length, Math.trunc(Number(obj.voucherSeq) || 0)),
      transactions,
      supplierInvoices,
      cashShifts,
      openingBalances,
      reconciliationChecks,
      syncLogs,
      migrationHistory,
      updatedAt: sanitizeText(obj.updatedAt, 40) || new Date().toISOString()
    };
  }

  function getBookingChargesBreakdown(bk, asOfDateISO = null) {
    if (!bk || typeof bk !== "object") {
      return { roomAmount: 0, servicesTotal: 0, adjustmentsTotal: 0, totalPayable: 0, status: "active", effectiveOnDate: false };
    }
    const bookingDate = normalizeFinanceDateISO(bk.bookingDate)
      || (typeof bk.createdAt === "string" ? normalizeFinanceDateISO(bk.createdAt) : null)
      || normalizeFinanceDateISO(bk.checkin)
      || getVietnamTodayISO();

    if (asOfDateISO && isValidISODate(asOfDateISO)) {
      const history = Array.isArray(bk.chargeHistory) ? bk.chargeHistory : [];
      if (history.length > 0) {
        const eligible = history.filter((h) => h && isValidISODate(h.effectiveDate) && h.effectiveDate <= asOfDateISO);
        if (eligible.length > 0) {
          const latest = eligible[eligible.length - 1];
          return {
            roomAmount: parseVND(latest.roomAmount),
            servicesTotal: parseVND(latest.servicesTotal),
            adjustmentsTotal: parseSignedVND(latest.adjustmentsTotal),
            totalPayable: parseVND(latest.totalPayable),
            status: latest.status === "cancelled" ? "cancelled" : "active",
            effectiveOnDate: true
          };
        }
        // Booking's first charge snapshot is AFTER asOfDateISO -> booking did not exist yet
        return { roomAmount: 0, servicesTotal: 0, adjustmentsTotal: 0, totalPayable: 0, status: "active", effectiveOnDate: false };
      }
      if (bookingDate > asOfDateISO) {
        return { roomAmount: 0, servicesTotal: 0, adjustmentsTotal: 0, totalPayable: 0, status: "active", effectiveOnDate: false };
      }
    }

    const services = Array.isArray(bk.services) ? bk.services : [];
    const adjustments = Array.isArray(bk.adjustments) ? bk.adjustments : [];
    const servicesTotal = services.reduce((s, it) => s + parseVND(it.amount), 0);
    const adjustmentsTotal = adjustments.reduce((s, it) => s + parseSignedVND(it.amount), 0);
    const isCancelled = isBookingCancelled(bk);
    const roomAmount = bk.roomAmount !== undefined && bk.roomAmount !== null
      ? parseVND(bk.roomAmount)
      : Math.max(0, parseVND(bk.totalAmount) - servicesTotal - adjustmentsTotal);
    const retained = isCancelled && bk.depositDisposition === "retained" ? parseVND(bk.retainedDepositAmount) : 0;
    const totalPayable = isCancelled
      ? retained
      : (bk.roomAmount !== undefined && bk.roomAmount !== null
        ? Math.max(0, roundVND(roomAmount + servicesTotal + adjustmentsTotal))
        : parseVND(bk.totalAmount));
    return {
      roomAmount,
      servicesTotal,
      adjustmentsTotal,
      totalPayable,
      status: isCancelled ? "cancelled" : "active",
      effectiveOnDate: true
    };
  }

  // Group bookings into authoritative AR entities (multi-room group = 1 entity; single room = 1 entity)
  function buildFinanceEntities(bookings) {
    const list = Array.isArray(bookings) ? bookings.filter(Boolean) : [];
    const byNormCode = new Map();
    for (const bk of list) {
      const nc = normalizeGroupCode(bk.bookingCode);
      if (!nc) continue;
      if (!byNormCode.has(nc)) byNormCode.set(nc, []);
      byNormCode.get(nc).push(bk);
    }

    const entities = [];
    const bookingToEntity = new Map();

    for (const [normCode, members] of byNormCode.entries()) {
      if (members.length < 2) continue;
      const sorted = [...members].sort((a, b) => a.checkin.localeCompare(b.checkin) || a.roomId.localeCompare(b.roomId));
      const lead = sorted[0];
      const entity = {
        entityKey: `group:${normCode}`,
        entityType: "group",
        groupCode: normCode,
        groupCodeDisplay: lead.bookingCode || normCode,
        bookingId: lead.id,
        bookings: sorted,
        memberIds: new Set(sorted.map((m) => m.id)),
        guestName: lead.guestName || "",
        phone: lead.phone || "",
        tourName: sorted.map((m) => m.tourName).find(Boolean) || "",
        sourceName: lead.sourceName || "",
        channelKey: lead.channelKey || "direct",
        roomLabel: sorted.map((m) => (m.roomId === "DORM" ? "Dorm" : `P.${m.roomId}`)).join(", "),
        minCheckin: sorted.reduce((min, m) => (m.checkin < min ? m.checkin : min), sorted[0].checkin),
        maxCheckout: sorted.reduce((max, m) => (m.checkout > max ? m.checkout : max), sorted[0].checkout),
        earliestBookingDate: sorted.reduce((min, m) => {
          const bd = normalizeFinanceDateISO(m.bookingDate) || m.checkin;
          return bd < min ? bd : min;
        }, normalizeFinanceDateISO(sorted[0].bookingDate) || sorted[0].checkin)
      };
      entities.push(entity);
      sorted.forEach((m) => bookingToEntity.set(m.id, entity));
    }

    for (const bk of list) {
      if (bookingToEntity.has(bk.id)) continue;
      const entity = {
        entityKey: `booking:${bk.id}`,
        entityType: "booking",
        groupCode: normalizeGroupCode(bk.bookingCode),
        groupCodeDisplay: bk.bookingCode || "",
        bookingId: bk.id,
        bookings: [bk],
        memberIds: new Set([bk.id]),
        guestName: bk.guestName || "",
        phone: bk.phone || "",
        tourName: bk.tourName || "",
        sourceName: bk.sourceName || "",
        channelKey: bk.channelKey || "direct",
        roomLabel: bk.roomId === "DORM" ? `Dorm (${(bk.slots || []).join(",")})` : `P.${bk.roomId}`,
        minCheckin: bk.checkin,
        maxCheckout: bk.checkout,
        earliestBookingDate: normalizeFinanceDateISO(bk.bookingDate) || bk.checkin
      };
      entities.push(entity);
      bookingToEntity.set(bk.id, entity);
    }

    return { entities, bookingToEntity };
  }

  function computeEntityFinancials(entity, financeState, asOfDateISO = null) {
    const fState = financeState && Array.isArray(financeState.transactions) ? financeState : createDefaultFinanceState();
    const effectiveAsOf = asOfDateISO && isValidISODate(asOfDateISO) ? asOfDateISO : null;

    let roomAmount = 0;
    let servicesTotal = 0;
    let adjustmentsTotal = 0;
    let totalPayable = 0;
    let effectiveRoomCount = 0;
    let allCancelled = true;
    let hasCancelled = false;
    let retainedDepositAmount = 0;
    let legacyBookingPaidFallback = 0;

    for (const bk of entity.bookings) {
      const ch = getBookingChargesBreakdown(bk, effectiveAsOf);
      if (ch.effectiveOnDate) {
        effectiveRoomCount += 1;
        roomAmount += ch.roomAmount;
        servicesTotal += ch.servicesTotal;
        adjustmentsTotal += ch.adjustmentsTotal;
        totalPayable += ch.totalPayable;
        if (ch.status === "cancelled") {
          hasCancelled = true;
          if (bk.depositDisposition === "retained") retainedDepositAmount += parseVND(bk.retainedDepositAmount);
        } else {
          allCancelled = false;
        }
        legacyBookingPaidFallback += parseVND(bk.paidAmount);
      }
    }

    // Match authoritative ledger transactions ONCE by unique tx.id (no double-counting across group rooms!)
    const matchedTxAll = [];
    const seenTxIds = new Set();
    for (const tx of fState.transactions) {
      if (!tx || seenTxIds.has(tx.id)) continue;
      if (tx.txType !== "customer_payment" && tx.txType !== "customer_refund" && tx.txType !== "legacy_payment") continue;
      const hitByGroup = entity.entityType === "group" && entity.groupCode && tx.groupCode === entity.groupCode;
      const hitByBooking = tx.bookingId && entity.memberIds.has(tx.bookingId);
      if (!hitByGroup && !hitByBooking) continue;
      seenTxIds.add(tx.id);
      matchedTxAll.push(tx);
    }

    const matchedTx = matchedTxAll.filter((tx) => {
      if (!effectiveAsOf) return true;
      if (tx.txType === "legacy_payment" && !tx.receivedDate) {
        return effectiveRoomCount > 0;
      }
      return Boolean(tx.receivedDate && tx.receivedDate <= effectiveAsOf);
    });

    matchedTx.sort((a, b) => {
      const da = a.receivedAt || a.recordedAt || "";
      const db = b.receivedAt || b.recordedAt || "";
      return da.localeCompare(db) || a.voucherCode.localeCompare(b.voucherCode);
    });

    let grossPaid = 0;
    let totalRefunded = 0;
    let confirmedFundGrossPaid = 0;
    let openingIncludedLegacyPaid = 0;
    let unassignedLegacyMigratedPaid = 0;
    let legacyMigratedPaid = 0;
    let legacyNeedsReconcileCount = 0;

    for (const tx of matchedTx) {
      if (tx.txType === "customer_payment") {
        const a = parseVND(tx.amount);
        grossPaid += a;
        confirmedFundGrossPaid += a;
      } else if (tx.txType === "legacy_payment") {
        const a = parseVND(tx.amount);
        grossPaid += a;
        legacyMigratedPaid += a;
        if (tx.legacyStatus === "reconciled") {
          confirmedFundGrossPaid += a;
        } else if (tx.legacyStatus === "reconciled_in_opening") {
          openingIncludedLegacyPaid += a;
        } else {
          unassignedLegacyMigratedPaid += a;
          legacyNeedsReconcileCount += 1;
        }
      } else if (tx.txType === "customer_refund") {
        totalRefunded += parseVND(tx.amount);
      }
    }

    // Backward-compatible fallback ONLY when zero ledger rows exist for an un-migrated legacy booking
    let unmigratedLegacyPaid = 0;
    if (matchedTxAll.length === 0 && legacyBookingPaidFallback > 0 && effectiveRoomCount > 0) {
      unmigratedLegacyPaid = legacyBookingPaidFallback;
      grossPaid = legacyBookingPaidFallback;
    }

    const effectiveOnDate = effectiveRoomCount > 0 || matchedTx.length > 0;
    const netPaid = roundVND(grossPaid - totalRefunded);
    const confirmedFundNetPaid = roundVND(confirmedFundGrossPaid - totalRefunded);
    const unassignedLegacyPaid = roundVND(unassignedLegacyMigratedPaid + unmigratedLegacyPaid);
    const remaining = Math.max(0, roundVND(totalPayable - netPaid));
    const overpaid = Math.max(0, roundVND(netPaid - totalPayable));
    const cancelledHeldDeposit = allCancelled && effectiveRoomCount > 0 && overpaid > 0 ? overpaid : 0;

    // Determine effective due date from booking depositDueDate / paymentDueDate (never fabricate if legacy missing!)
    const depositDueCandidates = entity.bookings.map((b) => normalizeFinanceDateISO(b.depositDueDate)).filter(Boolean).sort();
    const paymentDueCandidates = entity.bookings.map((b) => normalizeFinanceDateISO(b.paymentDueDate)).filter(Boolean).sort();
    const depositDueDate = depositDueCandidates[0] || "";
    const paymentDueDate = paymentDueCandidates[0] || "";
    const effectiveDueDate = (netPaid === 0 && depositDueDate)
      ? depositDueDate
      : (paymentDueDate || depositDueDate || "");
    const dueBasisType = (netPaid === 0 && depositDueDate)
      ? "deposit_due"
      : (paymentDueDate ? "payment_due" : (depositDueDate ? "deposit_due" : "none"));
    const refDate = effectiveAsOf || getVietnamTodayISO();

    let dueBucket = "settled";
    let dueBucketLabel = "Đã hoàn tất";
    if (remaining > 0) {
      if (!effectiveDueDate) {
        dueBucket = "no_due_date";
        dueBucketLabel = "Chưa xác định hạn";
      } else if (effectiveDueDate < refDate) {
        dueBucket = "overdue";
        dueBucketLabel = "Quá hạn";
      } else if (effectiveDueDate === refDate) {
        dueBucket = "due";
        dueBucketLabel = "Đến hạn";
      } else {
        dueBucket = "not_due";
        dueBucketLabel = "Chưa đến hạn";
      }
    }

    let arStatus = "unpaid";
    if (allCancelled && effectiveRoomCount > 0) {
      arStatus = cancelledHeldDeposit > 0 ? "cancelled_deposit" : "cancelled_settled";
    } else if (overpaid > 0) {
      arStatus = "overpaid";
    } else if (remaining === 0 && totalPayable > 0) {
      arStatus = "paid";
    } else if (remaining === 0 && totalPayable === 0) {
      arStatus = netPaid > 0 ? "overpaid" : "paid";
    } else if (netPaid > 0) {
      arStatus = "partial";
    }

    return {
      ...entity,
      effectiveOnDate,
      roomCount: entity.bookings.length,
      roomAmount: roundVND(roomAmount),
      servicesTotal: roundVND(servicesTotal),
      adjustmentsTotal: roundVND(adjustmentsTotal),
      totalPayable: roundVND(totalPayable),
      grossPaid: roundVND(grossPaid),
      totalRefunded: roundVND(totalRefunded),
      netPaid,
      confirmedFundNetPaid,
      openingIncludedLegacyPaid: roundVND(openingIncludedLegacyPaid),
      unassignedLegacyPaid,
      remaining,
      overpaid,
      cancelledHeldDeposit,
      retainedDepositAmount: roundVND(retainedDepositAmount),
      depositDueDate,
      paymentDueDate,
      effectiveDueDate,
      dueBasisType,
      dueBucket,
      dueBucketLabel,
      allCancelled: allCancelled && effectiveRoomCount > 0,
      hasCancelled,
      arStatus,
      transactions: matchedTx,
      allTransactions: matchedTxAll,
      legacyMigratedPaid: roundVND(legacyMigratedPaid),
      unmigratedLegacyPaid: roundVND(unmigratedLegacyPaid),
      hasLegacyNeedsReconcile: legacyNeedsReconcileCount > 0 || unmigratedLegacyPaid > 0
    };
  }

  function computeBookingFinancialSummary(booking, allBookings, financeState, asOfDateISO = null) {
    if (!booking) return null;
    const { bookingToEntity } = buildFinanceEntities(allBookings || [booking]);
    const entity = bookingToEntity.get(booking.id);
    if (!entity) return null;
    const summary = computeEntityFinancials(entity, financeState, asOfDateISO);
    const roomBreakdown = getBookingChargesBreakdown(booking, asOfDateISO);
    return {
      ...summary,
      currentRoomId: booking.roomId,
      currentBookingId: booking.id,
      currentRoomBreakdown: roomBreakdown,
      isGroupSharedLedger: entity.entityType === "group"
    };
  }

  function computeReceivablesReport(bookings, financeState, filters = {}) {
    const asOfDate = normalizeFinanceDateISO(filters.asOfDate) || null;
    const search = String(filters.search || "").trim().toLowerCase();
    const statusFilter = String(filters.status || "all");
    const dueFilter = String(filters.dueFilter || "all"); // all | debt | overdue | due | not_due | no_due_date
    const entityTypeFilter = String(filters.entityType || "all"); // all | group | booking
    const tourFilter = String(filters.tour || "").trim().toLowerCase();

    const { entities } = buildFinanceEntities(bookings);
    const allComputed = entities
      .map((ent) => computeEntityFinancials(ent, financeState, asOfDate))
      .filter((row) => row.effectiveOnDate);

    // Compute due-date & paid-source breakdown BEFORE dueFilter so KPI bucket cards always show accurate clickable numbers
    const baseFiltered = allComputed.filter((row) => {
      if (entityTypeFilter !== "all" && row.entityType !== entityTypeFilter) return false;
      if (statusFilter === "debt" && row.remaining <= 0) return false;
      if (statusFilter === "overpaid" && row.overpaid <= 0) return false;
      if (statusFilter === "paid" && (row.remaining > 0 || row.overpaid > 0 || row.allCancelled)) return false;
      if (statusFilter === "cancelled_deposit" && row.cancelledHeldDeposit <= 0) return false;
      if (statusFilter === "legacy" && !row.hasLegacyNeedsReconcile) return false;
      if (tourFilter && !(row.tourName || "").toLowerCase().includes(tourFilter)) return false;
      if (search) {
        const hay = [
          row.guestName,
          row.phone,
          row.groupCodeDisplay,
          row.tourName,
          row.sourceName,
          row.roomLabel,
          row.bookingId,
          ...row.bookings.map((b) => `${b.guestName} ${b.roomId} ${b.bookingCode || ""} ${b.tourName || ""}`)
        ].join(" ").toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const dueBuckets = baseFiltered.reduce((acc, r) => {
      if (r.remaining > 0) {
        acc.allDebtAmount += r.remaining;
        acc.allDebtCount += 1;
        if (r.dueBucket === "overdue") { acc.overdueAmount += r.remaining; acc.overdueCount += 1; }
        else if (r.dueBucket === "due") { acc.dueAmount += r.remaining; acc.dueCount += 1; }
        else if (r.dueBucket === "not_due") { acc.notDueAmount += r.remaining; acc.notDueCount += 1; }
        else { acc.noDueDateAmount += r.remaining; acc.noDueDateCount += 1; }
      }
      return acc;
    }, {
      allDebtAmount: 0, allDebtCount: 0,
      overdueAmount: 0, overdueCount: 0,
      dueAmount: 0, dueCount: 0,
      notDueAmount: 0, notDueCount: 0,
      noDueDateAmount: 0, noDueDateCount: 0
    });

    const filtered = baseFiltered.filter((row) => {
      if (dueFilter === "debt") return row.remaining > 0;
      if (dueFilter === "overdue") return row.remaining > 0 && row.dueBucket === "overdue";
      if (dueFilter === "due") return row.remaining > 0 && row.dueBucket === "due";
      if (dueFilter === "not_due") return row.remaining > 0 && row.dueBucket === "not_due";
      if (dueFilter === "no_due_date") return row.remaining > 0 && row.dueBucket === "no_due_date";
      return true;
    });

    filtered.sort((a, b) => {
      // Prioritize overdue -> due -> cancelled-deposit -> remaining -> overpaid -> paid
      const prio = (r) => (
        r.dueBucket === "overdue" ? 0 :
        r.dueBucket === "due" ? 1 :
        r.cancelledHeldDeposit > 0 ? 2 :
        r.remaining > 0 ? 3 :
        r.overpaid > 0 ? 4 : 5
      );
      return prio(a) - prio(b) || b.remaining - a.remaining || a.minCheckin.localeCompare(b.minCheckin);
    });

    const totals = filtered.reduce((acc, r) => {
      acc.totalPayable += r.totalPayable;
      acc.totalGrossPaid += r.grossPaid;
      acc.totalRefunded += r.totalRefunded;
      acc.totalNetPaid += r.netPaid;
      acc.totalConfirmedFundNetPaid += r.confirmedFundNetPaid;
      acc.totalOpeningIncludedLegacyPaid += r.openingIncludedLegacyPaid;
      acc.totalUnassignedLegacyPaid += r.unassignedLegacyPaid;
      acc.totalRemaining += r.remaining;
      acc.totalOverpaid += r.overpaid;
      acc.totalCancelledHeldDeposit += r.cancelledHeldDeposit;
      if (r.remaining > 0) acc.debtCount += 1;
      if (r.overpaid > 0) acc.overpaidCount += 1;
      if (r.hasLegacyNeedsReconcile) {
        acc.legacyCount += 1;
        acc.legacyTotal += r.unassignedLegacyPaid;
      }
      return acc;
    }, {
      totalPayable: 0,
      totalGrossPaid: 0,
      totalRefunded: 0,
      totalNetPaid: 0,
      totalConfirmedFundNetPaid: 0,
      totalOpeningIncludedLegacyPaid: 0,
      totalUnassignedLegacyPaid: 0,
      totalRemaining: 0,
      totalOverpaid: 0,
      totalCancelledHeldDeposit: 0,
      debtCount: 0,
      overpaidCount: 0,
      legacyCount: 0,
      legacyTotal: 0
    });

    const fState = financeState && Array.isArray(financeState.transactions) ? financeState : createDefaultFinanceState();
    const legacyTransactions = fState.transactions.filter(
      (tx) => tx && tx.txType === "legacy_payment" && tx.legacyStatus === "needs_reconciliation"
    );

    return {
      asOfDate: asOfDate || getVietnamTodayISO(),
      dueFilter,
      rows: filtered,
      allRowsCount: allComputed.length,
      ...totals,
      ...dueBuckets,
      legacyTransactions
    };
  }

  function computeCashbookReport(financeState, bookings, filters = {}) {
    const fState = financeState && Array.isArray(financeState.transactions) ? financeState : createDefaultFinanceState();
    const fromDate = normalizeFinanceDateISO(filters.fromDate) || null;
    const toDate = normalizeFinanceDateISO(filters.toDate) || null;
    const fundFilter = String(filters.fundId || "all");
    const typeFilter = String(filters.txType || "all");
    const reconcileFilter = String(filters.reconcile || "all"); // all | reconciled | unreconciled

    const { bookingToEntity } = buildFinanceEntities(bookings || []);
    const bookingMap = new Map((bookings || []).map((b) => [b.id, b]));
    const invoiceMap = new Map((fState.supplierInvoices || []).map((inv) => [inv.id, inv]));

    // Build per-fund balances up to toDate (or all-time if toDate omitted)
    const fundMap = {};
    for (const f of FINANCE_FUNDS) {
      fundMap[f.id] = {
        ...f,
        openingBalance: 0,
        openingAsOfDate: null,
        openingVoucherRef: "",
        customerIn: 0,
        customerRefund: 0,
        supplierOut: 0,
        transferIn: 0,
        transferOut: 0,
        adjustments: 0,
        closingBalance: 0,
        reconciledCount: 0,
        unreconciledCount: 0,
        unreconciledNetAmount: 0,
        latestCheck: null,
        reconciliationStatus: "unreconciled",
        reconciliationLabel: "Chưa đối chiếu"
      };
    }

    // Apply latest declared opening balance per fund (effective <= toDate if toDate specified)
    for (const ob of (fState.openingBalances || [])) {
      const bucket = fundMap[ob.fundId];
      if (!bucket || bucket.isLegacyBucket) continue;
      if (toDate && ob.asOfDate > toDate) continue;
      if (!bucket.openingAsOfDate || ob.asOfDate >= bucket.openingAsOfDate) {
        bucket.openingBalance = parseSignedVND(ob.amount);
        bucket.openingAsOfDate = ob.asOfDate;
        bucket.openingVoucherRef = ob.voucherRef || "";
      }
    }

    // Attach latest physical/statement reconciliation check per fund
    for (const chk of (fState.reconciliationChecks || [])) {
      const bucket = fundMap[chk.fundId];
      if (!bucket || bucket.isLegacyBucket) continue;
      if (toDate && chk.asOfDate > toDate) continue;
      if (!bucket.latestCheck || chk.checkedAt >= bucket.latestCheck.checkedAt) {
        bucket.latestCheck = chk;
      }
    }

    const allTxSorted = [...fState.transactions].sort((a, b) => {
      const da = a.receivedDate || "0000-00-00";
      const db = b.receivedDate || "0000-00-00";
      return db.localeCompare(da) || (b.recordedAt || "").localeCompare(a.recordedAt || "");
    });

    let totalCustomerNetCollected = 0;
    let totalCustomerGrossIn = 0;
    let totalCustomerRefunded = 0;
    let totalSupplierPaid = 0;
    const legacyUnreconciled = [];
    const resolvedOpeningLegacy = [];
    const ledgerLines = [];

    for (const tx of allTxSorted) {
      if (!tx) continue;
      if (tx.txType === "legacy_payment") {
        if (tx.legacyStatus === "reconciled_in_opening") {
          // Resolved as already included inside opening balance: NEVER add to fund balance again!
          resolvedOpeningLegacy.push(tx);
          continue;
        }
        if (tx.legacyStatus !== "reconciled") {
          legacyUnreconciled.push(tx);
          const legBucket = fundMap.unassigned_legacy;
          legBucket.customerIn += parseVND(tx.amount);
          legBucket.closingBalance += parseVND(tx.amount);
          legBucket.unreconciledCount += 1;
          continue;
        }
      }

      const txDate = tx.receivedDate;
      if (toDate && txDate && txDate > toDate) continue;

      const amt = tx.txType === "balance_adjustment" ? parseSignedVND(tx.amount) : parseVND(tx.amount);

      // Update cumulative fund balances (respecting opening balance cutoff date when present)
      if (tx.txType === "customer_payment" || (tx.txType === "legacy_payment" && tx.legacyStatus === "reconciled")) {
        const b = fundMap[tx.fundId];
        if (b && !b.isLegacyBucket) {
          if (!b.openingAsOfDate || !txDate || txDate >= b.openingAsOfDate) {
            b.customerIn += amt;
            if (tx.reconciled) b.reconciledCount += 1;
            else { b.unreconciledCount += 1; b.unreconciledNetAmount += amt; }
          }
        }
        totalCustomerGrossIn += amt;
        totalCustomerNetCollected += amt;
      } else if (tx.txType === "customer_refund") {
        const b = fundMap[tx.fundId];
        if (b && !b.isLegacyBucket) {
          if (!b.openingAsOfDate || !txDate || txDate >= b.openingAsOfDate) {
            b.customerRefund += amt;
            if (tx.reconciled) b.reconciledCount += 1;
            else { b.unreconciledCount += 1; b.unreconciledNetAmount -= amt; }
          }
        }
        totalCustomerRefunded += amt;
        totalCustomerNetCollected -= amt;
      } else if (tx.txType === "supplier_payment") {
        const b = fundMap[tx.fundId];
        if (b && !b.isLegacyBucket) {
          if (!b.openingAsOfDate || !txDate || txDate >= b.openingAsOfDate) {
            b.supplierOut += amt;
            if (tx.reconciled) b.reconciledCount += 1;
            else { b.unreconciledCount += 1; b.unreconciledNetAmount -= amt; }
          }
        }
        totalSupplierPaid += amt;
      } else if (tx.txType === "fund_transfer") {
        const src = fundMap[tx.fromFundId];
        const dst = fundMap[tx.toFundId];
        if (src && !src.isLegacyBucket && (!src.openingAsOfDate || !txDate || txDate >= src.openingAsOfDate)) {
          src.transferOut += amt;
          if (tx.reconciled) src.reconciledCount += 1;
          else { src.unreconciledCount += 1; src.unreconciledNetAmount -= amt; }
        }
        if (dst && !dst.isLegacyBucket && (!dst.openingAsOfDate || !txDate || txDate >= dst.openingAsOfDate)) {
          dst.transferIn += amt;
          if (tx.reconciled) dst.reconciledCount += 1;
          else { dst.unreconciledCount += 1; dst.unreconciledNetAmount += amt; }
        }
      } else if (tx.txType === "balance_adjustment") {
        const b = fundMap[tx.fundId];
        if (b && !b.isLegacyBucket && (!b.openingAsOfDate || !txDate || txDate >= b.openingAsOfDate)) {
          b.adjustments += amt;
          if (tx.reconciled) b.reconciledCount += 1;
          else { b.unreconciledCount += 1; b.unreconciledNetAmount += amt; }
        }
      }

      // Period / UI filters for the visible ledger table
      if (fromDate && txDate && txDate < fromDate) continue;
      if (typeFilter !== "all" && tx.txType !== typeFilter) continue;
      if (reconcileFilter === "reconciled" && !tx.reconciled) continue;
      if (reconcileFilter === "unreconciled" && tx.reconciled) continue;
      if (fundFilter !== "all") {
        const touchesFund = tx.txType === "fund_transfer"
          ? (tx.fromFundId === fundFilter || tx.toFundId === fundFilter)
          : tx.fundId === fundFilter;
        if (!touchesFund) continue;
      }

      const bk = tx.bookingId ? bookingMap.get(tx.bookingId) : null;
      const ent = tx.bookingId ? bookingToEntity.get(tx.bookingId) : null;
      const inv = tx.invoiceId ? invoiceMap.get(tx.invoiceId) : null;
      const signedImpactForFund = tx.txType === "fund_transfer"
        ? (fundFilter === tx.fromFundId ? -amt : fundFilter === tx.toFundId ? amt : 0)
        : (tx.txType === "customer_refund" || tx.txType === "supplier_payment" ? -amt : amt);

      ledgerLines.push({
        ...tx,
        txTypeLabel: (FINANCE_TX_TYPES[tx.txType] && FINANCE_TX_TYPES[tx.txType].label) || tx.txType,
        fundName: getFinanceFundById(tx.fundId).shortName,
        fromFundName: tx.fromFundId ? getFinanceFundById(tx.fromFundId).shortName : "",
        toFundName: tx.toFundId ? getFinanceFundById(tx.toFundId).shortName : "",
        paymentMethodLabel: getPaymentMethodMeta(tx.paymentMethod).label,
        guestName: (ent && ent.guestName) || (bk && bk.guestName) || "",
        roomLabel: (ent && ent.roomLabel) || (bk ? (bk.roomId === "DORM" ? "Dorm" : `P.${bk.roomId}`) : ""),
        supplierName: tx.supplierName || (inv && inv.supplierName) || "",
        invoiceVoucherNo: tx.invoiceVoucherNo || (inv && inv.voucherNo) || "",
        signedImpactForFund
      });
    }

    const funds = FINANCE_FUNDS.map((f) => {
      const b = fundMap[f.id];
      if (!b.isLegacyBucket) {
        b.closingBalance = roundVND(b.openingBalance + b.customerIn - b.customerRefund - b.supplierOut + b.transferIn - b.transferOut + b.adjustments);
        b.liveDiscrepancy = b.latestCheck ? roundVND(b.latestCheck.actualBalance - b.closingBalance) : null;
        // STRICT RECONCILIATION RULE: NEVER claim "Đã đối chiếu" unless a real count/statement check exists!
        if (!b.latestCheck) {
          b.reconciliationStatus = "unreconciled";
          b.reconciliationLabel = "Chưa đối chiếu";
        } else if (b.liveDiscrepancy === 0) {
          b.reconciliationStatus = "reconciled_exact";
          b.reconciliationLabel = "Đã đối chiếu";
        } else {
          b.reconciliationStatus = "reconciled_discrepancy";
          b.reconciliationLabel = "Đã đối chiếu (Lệch)";
        }
      }
      return b;
    });

    const activeFunds = funds.filter((f) => !f.isLegacyBucket);
    const totalHotelCashHeld = activeFunds.reduce((s, f) => s + f.closingBalance, 0);
    const totalUnreconciledCount = activeFunds.reduce((s, f) => s + f.unreconciledCount, 0);

    return {
      fromDate,
      toDate: toDate || getVietnamTodayISO(),
      funds,
      activeFunds,
      totalHotelCashHeld: roundVND(totalHotelCashHeld),
      totalCustomerGrossIn: roundVND(totalCustomerGrossIn),
      totalCustomerRefunded: roundVND(totalCustomerRefunded),
      totalCustomerNetCollected: roundVND(totalCustomerNetCollected),
      totalSupplierPaid: roundVND(totalSupplierPaid),
      totalUnreconciledCount,
      ledgerLines,
      legacyUnreconciled,
      resolvedOpeningLegacy,
      syncLogs: fState.syncLogs || []
    };
  }

  function computeCalendarFinanceKPIs(bookings, financeState, year, month0, customAsOfDateISO = null) {
    const fState = financeState && Array.isArray(financeState.transactions) ? financeState : createDefaultFinanceState();
    const daysCount = getDaysInMonth(year, month0);
    const monthStart = formatDateISO(year, month0, 1);
    const monthEnd = formatDateISO(year, month0, daysCount);
    const monthKey = `${year}-${pad2(month0 + 1)}`;

    const todayVN = getVietnamTodayISO();
    const todayMonthKey = todayVN.slice(0, 7);
    const arAsOfDate = normalizeFinanceDateISO(customAsOfDateISO)
      || (monthKey === todayMonthKey ? todayVN : monthEnd);

    const { bookingToEntity } = buildFinanceEntities(bookings || []);
    const bookingMap = new Map((bookings || []).map((b) => [b.id, b]));

    const monthlyTxList = [];
    let monthlyGrossIn = 0;
    let monthlyRefunds = 0;

    for (const tx of fState.transactions) {
      if (!tx || !tx.receivedDate) continue;
      if (tx.receivedDate < monthStart || tx.receivedDate > monthEnd) continue;
      if (tx.txType === "customer_payment" || (tx.txType === "legacy_payment" && tx.legacyStatus === "reconciled")) {
        const amt = parseVND(tx.amount);
        monthlyGrossIn += amt;
        const bk = tx.bookingId ? bookingMap.get(tx.bookingId) : null;
        const ent = tx.bookingId ? bookingToEntity.get(tx.bookingId) : null;
        monthlyTxList.push({
          ...tx,
          signedAmount: amt,
          fundName: getFinanceFundById(tx.fundId).shortName,
          paymentMethodLabel: getPaymentMethodMeta(tx.paymentMethod).label,
          guestName: (ent && ent.guestName) || (bk && bk.guestName) || "",
          roomLabel: (ent && ent.roomLabel) || (bk ? (bk.roomId === "DORM" ? "Dorm" : `P.${bk.roomId}`) : "")
        });
      } else if (tx.txType === "customer_refund") {
        const amt = parseVND(tx.amount);
        monthlyRefunds += amt;
        const bk = tx.bookingId ? bookingMap.get(tx.bookingId) : null;
        const ent = tx.bookingId ? bookingToEntity.get(tx.bookingId) : null;
        monthlyTxList.push({
          ...tx,
          signedAmount: -amt,
          fundName: getFinanceFundById(tx.fundId).shortName,
          paymentMethodLabel: getPaymentMethodMeta(tx.paymentMethod).label,
          guestName: (ent && ent.guestName) || (bk && bk.guestName) || "",
          roomLabel: (ent && ent.roomLabel) || (bk ? (bk.roomId === "DORM" ? "Dorm" : `P.${bk.roomId}`) : "")
        });
      }
    }

    monthlyTxList.sort((a, b) => (b.receivedAt || b.receivedDate).localeCompare(a.receivedAt || a.receivedDate));
    const monthlyNetReceived = roundVND(monthlyGrossIn - monthlyRefunds);

    const arReport = computeReceivablesReport(bookings || [], fState, { asOfDate: arAsOfDate });

    return {
      monthKey,
      monthStart,
      monthEnd,
      monthlyGrossIn: roundVND(monthlyGrossIn),
      monthlyRefunds: roundVND(monthlyRefunds),
      monthlyNetReceived,
      monthlyTxCount: monthlyTxList.length,
      monthlyTxList,
      arAsOfDate,
      arAsOfTotal: arReport.totalRemaining,
      arAsOfOverpaid: arReport.totalOverpaid,
      arAsOfCancelledHeldDeposit: arReport.totalCancelledHeldDeposit,
      arAsOfRows: arReport.rows.filter((r) => r.remaining > 0 || r.overpaid > 0 || r.cancelledHeldDeposit > 0),
      legacyCount: arReport.legacyCount,
      legacyTotal: arReport.legacyTotal
    };
  }

  // Strictly idempotent legacy migration builder (preserves exact paidAmount & remaining; never guesses date or fund!)
  function buildLegacyMigrationPlan(bookings, financeState, operator = "Hệ thống") {
    const fState = sanitizeFinanceState(financeState);
    const existingIdemKeys = new Set(fState.transactions.map((t) => t.idempotencyKey));
    const txByBookingOrGroup = new Set();
    for (const tx of fState.transactions) {
      if (tx.txType !== "customer_payment" && tx.txType !== "legacy_payment" && tx.txType !== "customer_refund") continue;
      if (tx.bookingId) txByBookingOrGroup.add(`b:${tx.bookingId}`);
      if (tx.groupCode) txByBookingOrGroup.add(`g:${tx.groupCode}`);
    }

    const newTransactions = [];
    const comparisonRows = [];
    let seq = fState.voucherSeq || fState.transactions.length;
    const nowISO = new Date().toISOString();

    for (const bk of (bookings || [])) {
      if (!bk || !bk.id) continue;
      const beforePaid = parseVND(bk.paidAmount);
      const beforeTotal = getBookingChargesBreakdown(bk).totalPayable;
      const beforeDebt = Math.max(0, beforeTotal - beforePaid);
      const normCode = normalizeGroupCode(bk.bookingCode);
      const idemKey = `legacy_mig_${bk.id}`;

      const alreadyHasLedger = existingIdemKeys.has(idemKey)
        || txByBookingOrGroup.has(`b:${bk.id}`)
        || (normCode && txByBookingOrGroup.has(`g:${normCode}`));

      let createdTx = null;
      if (beforePaid > 0 && !alreadyHasLedger) {
        seq += 1;
        createdTx = sanitizeFinanceTransaction({
          id: `ftx_leg_${bk.id}`,
          voucherCode: `CT-${String(seq).padStart(4, "0")}`,
          txType: "legacy_payment",
          entityType: "booking",
          bookingId: bk.id,
          groupCode: normCode,
          groupCodeDisplay: bk.bookingCode || "",
          amount: beforePaid,
          receivedDate: null,
          receivedAt: "",
          recordedAt: nowISO,
          paymentMethod: "other",
          fundId: "unassigned_legacy",
          operator,
          note: `Dữ liệu chuyển tiếp từ đơn cũ P.${bk.roomId} (${bk.guestName || "Khách"}) — thiếu ngày thu & quỹ nhận, cần quản lý đối soát.`,
          idempotencyKey: idemKey,
          reconciled: false,
          isLegacyMigrated: true,
          legacyStatus: "needs_reconciliation"
        }, seq);
        newTransactions.push(createdTx);
      }

      comparisonRows.push({
        bookingId: bk.id,
        roomId: bk.roomId,
        guestName: bk.guestName || "",
        bookingCode: bk.bookingCode || "",
        beforeTotal,
        beforePaid,
        beforeDebt,
        migratedTxCreated: Boolean(createdTx),
        migratedVoucherCode: createdTx ? createdTx.voucherCode : ""
      });
    }

    const nextFinanceState = {
      ...fState,
      voucherSeq: seq,
      transactions: [...fState.transactions, ...newTransactions],
      updatedAt: nowISO
    };

    // Verify per-entity exact 0-VND preservation AFTER migration
    const { entities } = buildFinanceEntities(bookings || []);
    const entityDiffs = entities.map((ent) => {
      const beforePaid = ent.bookings.reduce((s, b) => s + parseVND(b.paidAmount), 0);
      const beforeTotal = ent.bookings.reduce((s, b) => s + getBookingChargesBreakdown(b).totalPayable, 0);
      const beforeDebt = Math.max(0, beforeTotal - beforePaid);
      const after = computeEntityFinancials(ent, nextFinanceState);
      return {
        entityKey: ent.entityKey,
        label: ent.entityType === "group" ? `Đoàn ${ent.groupCodeDisplay}` : `${ent.roomLabel} - ${ent.guestName}`,
        beforePaid,
        afterPaid: after.netPaid,
        paidDiff: after.netPaid - beforePaid,
        beforeDebt,
        afterDebt: after.remaining,
        debtDiff: after.remaining - beforeDebt
      };
    });

    return {
      newTransactions,
      createdCount: newTransactions.length,
      migratedTotalAmount: newTransactions.reduce((s, t) => s + parseVND(t.amount), 0),
      comparisonRows,
      entityDiffs,
      nextFinanceState
    };
  }

  function computeSupplierPayablesReport(financeState, operatingCostsState = null, filters = {}) {
    const fState = financeState && typeof financeState === "object" ? financeState : createDefaultFinanceState();
    const invoices = Array.isArray(fState.supplierInvoices) ? fState.supplierInvoices : [];
    const transactions = Array.isArray(fState.transactions) ? fState.transactions : [];
    const costState = operatingCostsState ? sanitizeOperatingCostsState(operatingCostsState) : createDefaultOperatingCostsState();
    const costItemMap = new Map((costState.items || []).map((it) => [it.id, it.name]));
    const legacyEntryMap = new Map((costState.actualEntries || []).map((e) => [e.id, e]));

    const asOfDate = normalizeFinanceDateISO(filters.asOfDate) || null;
    const refDate = asOfDate || getVietnamTodayISO();
    const search = String(filters.search || "").trim().toLowerCase();
    const supplierFilter = String(filters.supplier || "all").trim();
    const monthFilter = String(filters.accountingMonth || "").trim();
    const statusFilter = String(filters.status || "all").trim();

    // Group supplier_payment transactions by invoiceId
    const paymentsByInvoice = new Map();
    for (const tx of transactions) {
      if (!tx || tx.txType !== "supplier_payment" || !tx.invoiceId) continue;
      let arr = paymentsByInvoice.get(tx.invoiceId);
      if (!arr) {
        arr = [];
        paymentsByInvoice.set(tx.invoiceId, arr);
      }
      arr.push(tx);
    }

    const supplierSet = new Set();
    const computedAll = [];

    for (const inv of invoices) {
      if (!inv || !inv.id) continue;
      supplierSet.add(inv.supplierName);
      // Historical as-of date filter: invoice exists if invoiceDate <= asOfDate (when asOfDate provided)
      if (asOfDate && inv.invoiceDate && inv.invoiceDate > asOfDate) continue;

      const allPays = (paymentsByInvoice.get(inv.id) || []).slice().sort((a, b) =>
        (a.receivedDate || "").localeCompare(b.receivedDate || "") || (a.recordedAt || "").localeCompare(b.recordedAt || "")
      );
      const effectivePays = asOfDate
        ? allPays.filter((p) => p.receivedDate && p.receivedDate <= asOfDate)
        : allPays;

      const paidAmount = roundVND(effectivePays.reduce((s, p) => s + parseVND(p.amount), 0));
      const allTimePaidAmount = roundVND(allPays.reduce((s, p) => s + parseVND(p.amount), 0));
      const totalAmount = parseVND(inv.totalAmount);
      const remainingAmount = Math.max(0, roundVND(totalAmount - paidAmount));
      const allTimeRemainingAmount = Math.max(0, roundVND(totalAmount - allTimePaidAmount));
      const isOverdue = remainingAmount > 0 && Boolean(inv.dueDate && inv.dueDate < refDate);
      const isDueToday = remainingAmount > 0 && Boolean(inv.dueDate && inv.dueDate === refDate);

      let status = "unpaid";
      let statusLabel = "Chưa trả";
      if (remainingAmount === 0 && totalAmount > 0) {
        status = "paid";
        statusLabel = "Đã trả";
      } else if (isOverdue) {
        status = "overdue";
        statusLabel = "Quá hạn";
      } else if (paidAmount > 0) {
        status = "partial";
        statusLabel = "Trả một phần";
      }

      const enrichedLines = (inv.lines || []).map((l) => ({
        ...l,
        costItemName: l.costItemName || costItemMap.get(l.costItemId) || l.costItemId
      }));

      const linkedLegacyEntries = (inv.linkedLegacyEntryIds || [])
        .map((eid) => legacyEntryMap.get(eid))
        .filter(Boolean);

      computedAll.push({
        ...inv,
        lines: enrichedLines,
        totalAmount,
        paidAmount,
        remainingAmount,
        allTimePaidAmount,
        allTimeRemainingAmount,
        isOverdue,
        isDueToday,
        status,
        statusLabel,
        payments: effectivePays.map((p) => ({
          ...p,
          fundName: getFinanceFundById(p.fundId).shortName,
          paymentMethodLabel: getPaymentMethodMeta(p.paymentMethod).label
        })),
        allPaymentsCount: allPays.length,
        linkedLegacyEntries
      });
    }

    const filtered = computedAll.filter((inv) => {
      if (supplierFilter && supplierFilter !== "all" && inv.supplierName !== supplierFilter) return false;
      if (monthFilter && inv.accountingMonth !== monthFilter) return false;
      if (statusFilter === "unpaid" && !(inv.remainingAmount > 0 && inv.paidAmount === 0)) return false;
      if (statusFilter === "partial" && !(inv.remainingAmount > 0 && inv.paidAmount > 0)) return false;
      if (statusFilter === "paid" && inv.remainingAmount > 0) return false;
      if (statusFilter === "overdue" && !inv.isOverdue) return false;
      if (search) {
        const hay = [
          inv.supplierName,
          inv.voucherNo,
          inv.accountingMonth,
          inv.note,
          ...inv.lines.map((l) => `${l.costItemName} ${l.description}`)
        ].join(" ").toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const prio = (x) => (x.isOverdue ? 0 : x.remainingAmount > 0 ? 1 : 2);
      return prio(a) - prio(b) || String(a.dueDate || "9999-99-99").localeCompare(String(b.dueDate || "9999-99-99")) || String(b.invoiceDate).localeCompare(String(a.invoiceDate));
    });

    const totals = filtered.reduce((acc, inv) => {
      acc.totalInvoiced += inv.totalAmount;
      acc.totalPaid += inv.paidAmount;
      acc.totalRemaining += inv.remainingAmount;
      if (inv.remainingAmount === 0) acc.paidCount += 1;
      else if (inv.paidAmount > 0) acc.partialCount += 1;
      else acc.unpaidCount += 1;
      if (inv.isOverdue) {
        acc.overdueCount += 1;
        acc.overdueRemaining += inv.remainingAmount;
      }
      return acc;
    }, {
      totalInvoiced: 0,
      totalPaid: 0,
      totalRemaining: 0,
      overdueRemaining: 0,
      unpaidCount: 0,
      partialCount: 0,
      paidCount: 0,
      overdueCount: 0
    });

    return {
      asOfDate: asOfDate || getVietnamTodayISO(),
      rows: filtered,
      allCount: computedAll.length,
      suppliers: [...supplierSet].sort((a, b) => a.localeCompare(b, "vi")),
      ...totals
    };
  }

  function generateSupplierPayablesCsvContent(report) {
    const headers = [
      "Số chứng từ / HĐ", "Nhà cung cấp", "Ngày hóa đơn", "Kỳ ghi nhận chi phí", "Hạn thanh toán",
      "Các khoản mục", "Tổng tiền (VNĐ)", "Đã trả (VNĐ)", "Còn phải trả (VNĐ)",
      "Trạng thái", "Số phiếu chi", "Tính đến ngày", "Ghi chú"
    ];
    const rows = (report && report.rows ? report.rows : []).map((inv) => [
      inv.voucherNo,
      inv.supplierName,
      inv.invoiceDate,
      inv.accountingMonth,
      inv.dueDate || "Chưa xác định hạn",
      (inv.lines || []).map((l) => `${l.costItemName}: ${l.amount}`).join("; "),
      inv.totalAmount,
      inv.paidAmount,
      inv.remainingAmount,
      inv.statusLabel,
      (inv.payments || []).map((p) => p.voucherCode).join("; "),
      report.asOfDate || "",
      inv.note || ""
    ]);
    return "\uFEFF" + [headers, ...rows].map((row) => row.map(sanitizeCsvCell).join(",")).join("\r\n");
  }

  function generateReceivablesCsvContent(report) {
    const headers = [
      "Loại", "Mã đoàn / Đơn", "Phòng", "Khách hàng", "Công ty tour / Nguồn",
      "Nhận phòng", "Trả phòng", "Hạn thanh toán / cọc", "Phân loại hạn",
      "Tiền phòng (VNĐ)", "Dịch vụ (VNĐ)", "Điều chỉnh (VNĐ)",
      "Tổng phải thu (VNĐ)", "Đã thu ròng (VNĐ)", "Đã xác định quỹ (VNĐ)",
      "Chuyển tiếp trong đầu kỳ (VNĐ)", "Chuyển tiếp chưa gán quỹ (VNĐ)",
      "Còn phải thu (VNĐ)", "Trả thừa / Cọc giữ (VNĐ)",
      "Trạng thái", "Tính đến ngày"
    ];
    const statusLabel = {
      paid: "Đã thu đủ",
      partial: "Còn nợ",
      unpaid: "Chưa thu",
      overpaid: "Khách trả thừa",
      cancelled_deposit: "Đơn hủy còn cọc",
      cancelled_settled: "Đơn hủy đã xử lý"
    };
    const rows = (report && report.rows ? report.rows : []).map((r) => [
      r.entityType === "group" ? `Đoàn (${r.roomCount} phòng)` : "Đơn lẻ",
      r.entityType === "group" ? r.groupCodeDisplay : r.bookingId,
      r.roomLabel,
      r.guestName,
      r.tourName || r.sourceName,
      r.minCheckin,
      r.maxCheckout,
      r.effectiveDueDate || "Chưa xác định hạn",
      r.dueBucketLabel || "",
      r.roomAmount,
      r.servicesTotal,
      r.adjustmentsTotal,
      r.totalPayable,
      r.netPaid,
      r.confirmedFundNetPaid || 0,
      r.openingIncludedLegacyPaid || 0,
      r.unassignedLegacyPaid || 0,
      r.remaining,
      r.overpaid,
      statusLabel[r.arStatus] || r.arStatus,
      report.asOfDate || ""
    ]);
    return "\uFEFF" + [headers, ...rows].map((row) => row.map(sanitizeCsvCell).join(",")).join("\r\n");
  }

  function generateCashbookCsvContent(report) {
    const headers = [
      "Mã chứng từ", "Ngày thực nhận / chi", "Giờ ghi sổ", "Loại giao dịch", "Quỹ / Tài khoản",
      "Từ quỹ -> Đến quỹ", "Phương thức", "Số tiền (VNĐ)", "Đơn / Nhà cung cấp liên kết",
      "Chứng từ gốc", "Người thao tác", "Người duyệt", "Đối chiếu", "Ghi chú"
    ];
    const rows = (report && report.ledgerLines ? report.ledgerLines : []).map((t) => {
      const signedAmt = (t.txType === "customer_refund" || t.txType === "supplier_payment")
        ? -parseVND(t.amount)
        : t.amount;
      const linkedLabel = t.txType === "supplier_payment"
        ? `HĐ ${t.invoiceVoucherNo || t.invoiceId} — ${t.supplierName || "NCC"}`
        : (t.groupCodeDisplay ? `Đoàn ${t.groupCodeDisplay} (${t.guestName})` : `${t.roomLabel} ${t.guestName}`.trim());
      return [
        t.voucherCode,
        t.receivedDate || "Chưa xác định (chuyển tiếp)",
        t.recordedAt || "",
        t.txTypeLabel || t.txType,
        t.txType === "fund_transfer" ? `${t.fromFundName} -> ${t.toFundName}` : t.fundName,
        t.txType === "fund_transfer" ? `${t.fromFundId} -> ${t.toFundId}` : t.fundId,
        t.paymentMethodLabel || t.paymentMethod,
        signedAmt,
        linkedLabel,
        t.linkedVoucherCode || t.invoiceVoucherNo || "",
        t.operator || "",
        t.approvedBy || "",
        t.reconciled ? "Đã đối chiếu" : "Chưa đối chiếu",
        t.reason ? `${t.reason}${t.note ? ` — ${t.note}` : ""}` : (t.note || "")
      ];
    });
    return "\uFEFF" + [headers, ...rows].map((row) => row.map(sanitizeCsvCell).join(",")).join("\r\n");
  }

  /* -------------------- Front Desk Cash Shift Handover Engine (v1.8.0) -------------------- */

  function formatVietnamDateTime(isoStr) {
    if (!isoStr) return "—";
    const p = toVietnamParts(isoStr);
    if (!p) return String(isoStr);
    return `${pad2(p.day)}/${pad2(p.month)}/${p.year} ${pad2(p.hours)}:${pad2(p.minutes)}`;
  }

  function getVietnamDateFromISO(isoStr) {
    if (!isoStr) return "";
    const p = toVietnamParts(isoStr);
    if (!p) return "";
    return formatDateISO(p.year, p.month - 1, p.day);
  }

  function getShiftCashImpact(tx, fundId = "cash_frontdesk") {
    if (!tx || typeof tx !== "object") return null;
    if (!fundId || tx.fundId === "unassigned_legacy") return null;
    if (tx.txType === "legacy_payment") {
      // Unassigned legacy receipts or receipts already inside opening balance NEVER enter shift drawer cash
      if (tx.legacyStatus !== "reconciled") return null;
      return tx.fundId === fundId ? parseVND(tx.amount) : null;
    }
    if (tx.txType === "customer_payment") {
      return tx.fundId === fundId ? parseVND(tx.amount) : null;
    }
    if (tx.txType === "customer_refund") {
      return tx.fundId === fundId ? -parseVND(tx.amount) : null;
    }
    if (tx.txType === "supplier_payment") {
      return tx.fundId === fundId ? -parseVND(tx.amount) : null;
    }
    if (tx.txType === "fund_transfer") {
      if (tx.fromFundId === fundId && tx.toFundId !== fundId) return -parseVND(tx.amount);
      if (tx.toFundId === fundId && tx.fromFundId !== fundId) return parseVND(tx.amount);
      return null;
    }
    if (tx.txType === "balance_adjustment") {
      return tx.fundId === fundId ? parseSignedVND(tx.amount) : null;
    }
    return null;
  }

  function getShiftOpeningBasis(financeState, fundId = "cash_frontdesk") {
    const fState = financeState && typeof financeState === "object" ? financeState : createDefaultFinanceState();
    const targetFund = FINANCE_FUNDS.some((f) => f.id === fundId && !f.isLegacyBucket) ? fundId : "cash_frontdesk";
    const shifts = (Array.isArray(fState.cashShifts) ? fState.cashShifts : [])
      .filter((s) => s && s.fundId === targetFund && s.status === "confirmed" && s.receivedCash !== null && s.receivedCash !== undefined)
      .slice()
      .sort((a, b) => String(b.confirmedAt || b.closedAt || b.openedAt).localeCompare(String(a.confirmedAt || a.closedAt || a.openedAt)));

    if (shifts.length > 0) {
      const prev = shifts[0];
      return {
        established: true,
        openingBasisType: "previous_shift",
        openingCash: parseSignedVND(prev.receivedCash),
        previousShiftId: prev.id,
        previousShiftCode: prev.shiftCode || "",
        handedOverBy: prev.outgoingStaffName || "",
        txWindowStart: prev.closedAt || prev.openedAt || "",
        openingBasisRef: `Từ ca trước ${prev.shiftCode} (${prev.outgoingStaffName || "Lễ tân"} bàn giao ${formatVND(prev.receivedCash)})`
      };
    }

    const checks = (Array.isArray(fState.reconciliationChecks) ? fState.reconciliationChecks : [])
      .filter((c) => c && c.fundId === targetFund && c.actualBalance !== null && c.actualBalance !== undefined && c.asOfDate)
      .slice()
      .sort((a, b) => String(b.asOfDate || "").localeCompare(String(a.asOfDate || "")) || String(b.recordedAt || "").localeCompare(String(a.recordedAt || "")));

    const obs = (Array.isArray(fState.openingBalances) ? fState.openingBalances : [])
      .filter((o) => o && o.fundId === targetFund && o.asOfDate)
      .slice()
      .sort((a, b) => String(b.asOfDate || "").localeCompare(String(a.asOfDate || "")) || String(b.recordedAt || "").localeCompare(String(a.recordedAt || "")));

    const latestCheck = checks[0] || null;
    const latestOb = obs[0] || null;

    if (latestCheck && (!latestOb || String(latestCheck.asOfDate) > String(latestOb.asOfDate) || (String(latestCheck.asOfDate) === String(latestOb.asOfDate) && String(latestCheck.recordedAt || "") >= String(latestOb.recordedAt || "")))) {
      return {
        established: true,
        openingBasisType: "opening_count",
        openingCash: parseSignedVND(latestCheck.actualBalance),
        previousShiftId: "",
        previousShiftCode: "",
        handedOverBy: latestCheck.operator || "Quản lý",
        txWindowStart: "",
        openingBasisRef: `Biên bản kiểm đếm mở đầu ngày ${formatDateVN(latestCheck.asOfDate)} (${latestCheck.operator || "Quản lý"})`
      };
    }

    if (latestOb) {
      return {
        established: true,
        openingBasisType: "opening_balance",
        openingCash: parseSignedVND(latestOb.amount),
        previousShiftId: "",
        previousShiftCode: "",
        handedOverBy: latestOb.operator || "Quản lý",
        txWindowStart: "",
        openingBasisRef: `Số dư đầu kỳ đã xác minh ngày ${formatDateVN(latestOb.asOfDate)} (${latestOb.operator || "Quản lý"})`
      };
    }

    return {
      established: false,
      openingBasisType: "unestablished",
      openingCash: 0,
      previousShiftId: "",
      previousShiftCode: "",
      handedOverBy: "",
      txWindowStart: "",
      openingBasisRef: "Chưa xác lập số đầu ca — cần số dư đầu kỳ đã xác minh hoặc biên bản kiểm đếm mở đầu"
    };
  }

  function enrichShiftTransactionItem(tx, fundId, bookingMap, invoiceMap) {
    const impact = getShiftCashImpact(tx, fundId);
    const bk = tx.bookingId ? bookingMap.get(tx.bookingId) : null;
    const inv = tx.invoiceId ? invoiceMap.get(tx.invoiceId) : null;
    const meta = FINANCE_TX_TYPES[tx.txType] || { label: tx.txType };
    return {
      id: tx.id,
      voucherCode: tx.voucherCode || tx.id,
      txType: tx.txType,
      txTypeLabel: meta.label,
      fundId: tx.fundId,
      fundName: getFinanceFundById(tx.fundId).shortName,
      fromFundId: tx.fromFundId || "",
      toFundId: tx.toFundId || "",
      fromFundName: tx.fromFundId ? getFinanceFundById(tx.fromFundId).shortName : "",
      toFundName: tx.toFundId ? getFinanceFundById(tx.toFundId).shortName : "",
      paymentMethod: tx.paymentMethod || "",
      paymentMethodLabel: getPaymentMethodMeta(tx.paymentMethod).label,
      receivedDate: tx.receivedDate || "",
      recordedAt: tx.recordedAt || "",
      amount: parseVND(tx.amount),
      signedCashImpact: impact !== null ? impact : (tx.txType === "customer_refund" ? -parseVND(tx.amount) : parseVND(tx.amount)),
      bookingId: tx.bookingId || "",
      groupCode: tx.groupCode || "",
      groupCodeDisplay: tx.groupCodeDisplay || (bk && bk.bookingCode) || "",
      roomLabel: bk ? (bk.roomId === "DORM" ? "Dorm" : `P.${bk.roomId}`) : "",
      guestName: bk ? (bk.guestName || "") : "",
      invoiceId: tx.invoiceId || "",
      invoiceVoucherNo: tx.invoiceVoucherNo || (inv && inv.voucherNo) || "",
      supplierName: tx.supplierName || (inv && inv.supplierName) || "",
      linkedVoucherCode: tx.linkedVoucherCode || "",
      operator: tx.operator || "",
      approvedBy: tx.approvedBy || "",
      reason: tx.reason || "",
      note: tx.note || "",
      shiftId: tx.shiftId || ""
    };
  }

  function computeShiftLiveSummary(shift, financeState, bookings = []) {
    const cleanShift = sanitizeCashShift(shift);
    if (!cleanShift) return null;
    const fState = financeState && typeof financeState === "object" ? financeState : createDefaultFinanceState();
    const allTxs = Array.isArray(fState.transactions) ? fState.transactions : [];
    const allShifts = Array.isArray(fState.cashShifts) ? fState.cashShifts : [];
    const invoices = Array.isArray(fState.supplierInvoices) ? fState.supplierInvoices : [];

    const bookingMap = new Map((Array.isArray(bookings) ? bookings : []).filter((b) => b && b.id).map((b) => [b.id, b]));
    const invoiceMap = new Map(invoices.filter((i) => i && i.id).map((i) => [i.id, i]));
    const txById = new Map(allTxs.filter((t) => t && t.id).map((t) => [t.id, t]));

    const txWindowStart = cleanShift.txWindowStart || cleanShift.openedAt;
    let cashTransactions = [];
    let bankRefTransactions = [];

    if (cleanShift.status === "open") {
      // Collect transactions already locked into ANY closed/confirmed shift on the same fund -> zero double count
      const claimedTxIds = new Set();
      for (const s of allShifts) {
        if (!s || s.id === cleanShift.id || s.fundId !== cleanShift.fundId || s.status === "open") continue;
        for (const tid of (s.includedTxIds || [])) {
          if (tid) claimedTxIds.add(tid);
        }
      }

      for (const tx of allTxs) {
        if (!tx || !tx.id) continue;
        if (claimedTxIds.has(tx.id)) continue;

        const impact = getShiftCashImpact(tx, cleanShift.fundId);
        if (impact !== null) {
          // Post-close manager adjustments targeting a different historical shift MUST NOT distort the active drawer
          if (tx.txType === "balance_adjustment" && tx.shiftId && tx.shiftId !== cleanShift.id) continue;
          const belongsByTag = tx.shiftId === cleanShift.id;
          const belongsByWindow = !tx.shiftId && String(tx.recordedAt || "") >= String(txWindowStart || "");
          if (belongsByTag || belongsByWindow) {
            cashTransactions.push(enrichShiftTransactionItem(tx, cleanShift.fundId, bookingMap, invoiceMap));
          }
          continue;
        }

        // Bank transfers from/to guests during this shift: READ-ONLY reference only, NEVER added to counter cash!
        if (tx.fundId === "bank_main" && (tx.txType === "customer_payment" || tx.txType === "customer_refund")) {
          if (String(tx.recordedAt || "") >= String(txWindowStart || "")) {
            bankRefTransactions.push(enrichShiftTransactionItem(tx, "bank_main", bookingMap, invoiceMap));
          }
        }
      }

      cashTransactions.sort((a, b) => String(a.recordedAt || "").localeCompare(String(b.recordedAt || "")) || String(a.id).localeCompare(String(b.id)));
      bankRefTransactions.sort((a, b) => String(a.recordedAt || "").localeCompare(String(b.recordedAt || "")) || String(a.id).localeCompare(String(b.id)));
    } else {
      // Closed or confirmed shift: strictly use frozen includedTxIds & snapshot so signed minutes are immutable!
      const snapshotById = new Map((cleanShift.includedTxSnapshot || []).map((s) => [s.id, s]));
      for (const tid of (cleanShift.includedTxIds || [])) {
        const liveTx = txById.get(tid);
        if (liveTx) {
          cashTransactions.push(enrichShiftTransactionItem(liveTx, cleanShift.fundId, bookingMap, invoiceMap));
        } else if (snapshotById.has(tid)) {
          cashTransactions.push({ ...snapshotById.get(tid) });
        }
      }
      if (cashTransactions.length === 0 && (cleanShift.includedTxSnapshot || []).length > 0) {
        cashTransactions = cleanShift.includedTxSnapshot.map((s) => ({ ...s }));
      }
      for (const tid of (cleanShift.bankRefTxIds || [])) {
        const liveTx = txById.get(tid);
        if (liveTx) bankRefTransactions.push(enrichShiftTransactionItem(liveTx, "bank_main", bookingMap, invoiceMap));
      }
    }

    const computedCashIn = roundVND(cashTransactions.reduce((s, t) => s + (t.signedCashImpact > 0 ? t.signedCashImpact : 0), 0));
    const computedCashOut = roundVND(cashTransactions.reduce((s, t) => s + (t.signedCashImpact < 0 ? Math.abs(t.signedCashImpact) : 0), 0));
    const computedNetCashFlow = roundVND(computedCashIn - computedCashOut);
    const computedExpectedCash = roundVND(cleanShift.openingCash + computedNetCashFlow);
    const computedBankRefTotal = roundVND(bankRefTransactions.reduce((s, t) => s + (t.txType === "customer_refund" ? -t.amount : t.amount), 0));

    const cashInTotal = cleanShift.status === "open" ? computedCashIn : cleanShift.cashInTotal;
    const cashOutTotal = cleanShift.status === "open" ? computedCashOut : cleanShift.cashOutTotal;
    const expectedCash = cleanShift.status === "open" ? computedExpectedCash : cleanShift.expectedCash;
    const bankRefTotal = cleanShift.status === "open" ? computedBankRefTotal : cleanShift.bankRefTotal;

    const lastTx = cashTransactions.length > 0 ? cashTransactions[cashTransactions.length - 1] : null;
    const lastTxId = cleanShift.status === "open" ? (lastTx ? lastTx.id : "") : cleanShift.lastTxId;
    const lastTxRecordedAt = cleanShift.status === "open" ? (lastTx ? lastTx.recordedAt : "") : cleanShift.lastTxRecordedAt;

    const discrepancy = cleanShift.countedCash !== null
      ? roundVND(cleanShift.countedCash - expectedCash)
      : 0;
    const discrepancyType = cleanShift.countedCash === null
      ? "uncounted"
      : (discrepancy > 0 ? "over" : discrepancy < 0 ? "short" : "matched");
    const discrepancyLabel = discrepancyType === "over"
      ? "Thừa"
      : discrepancyType === "short"
        ? "Thiếu"
        : discrepancyType === "matched"
          ? "Khớp"
          : "Chưa đếm";

    const openDateVN = getVietnamDateFromISO(cleanShift.openedAt);
    const closeDateVN = cleanShift.closedAt ? getVietnamDateFromISO(cleanShift.closedAt) : getVietnamTodayISO();
    const isOvernight = Boolean(openDateVN && closeDateVN && closeDateVN > openDateVN);
    const statusMeta = SHIFT_STATUSES[cleanShift.status] || SHIFT_STATUSES.open;

    return {
      ...cleanShift,
      fundName: getFinanceFundById(cleanShift.fundId).name,
      fundShortName: getFinanceFundById(cleanShift.fundId).shortName,
      statusLabel: statusMeta.label,
      cashInTotal,
      cashOutTotal,
      netCashFlow: roundVND(cashInTotal - cashOutTotal),
      expectedCash,
      bankRefTotal,
      discrepancy,
      discrepancyType,
      discrepancyLabel,
      hasDiscrepancy: (cleanShift.countedCash !== null && discrepancy !== 0) || (cleanShift.receivedCash !== null && cleanShift.handoverCountDiff !== 0),
      lastTxId,
      lastTxRecordedAt,
      txCount: cashTransactions.length,
      cashTransactions,
      bankRefTransactions,
      openDateVN,
      closeDateVN,
      isOvernight,
      openedAtVN: formatVietnamDateTime(cleanShift.openedAt),
      closedAtVN: cleanShift.closedAt ? formatVietnamDateTime(cleanShift.closedAt) : "—",
      confirmedAtVN: cleanShift.confirmedAt ? formatVietnamDateTime(cleanShift.confirmedAt) : "—"
    };
  }

  function computeShiftsReport(financeState, bookings = [], filters = {}) {
    const fState = financeState && typeof financeState === "object" ? financeState : createDefaultFinanceState();
    const rawShifts = Array.isArray(fState.cashShifts) ? fState.cashShifts : [];
    const targetFund = filters.fundId && filters.fundId !== "all" ? filters.fundId : "cash_frontdesk";
    const fundFilter = String(filters.fundId || "all").trim();
    const statusFilter = String(filters.status || "all").trim();
    const staffFilter = String(filters.staff || "all").trim();
    const dateFrom = normalizeFinanceDateISO(filters.dateFrom) || "";
    const dateTo = normalizeFinanceDateISO(filters.dateTo) || "";
    const search = String(filters.search || "").trim().toLowerCase();

    const summaries = rawShifts
      .map((s) => computeShiftLiveSummary(s, fState, bookings))
      .filter(Boolean);

    const staffSet = new Set();
    for (const s of summaries) {
      if (s.outgoingStaffName) staffSet.add(s.outgoingStaffName);
      if (s.incomingStaffName) staffSet.add(s.incomingStaffName);
    }

    const activeOpenShift = summaries.find((s) => s.fundId === targetFund && s.status === "open") || null;
    const pendingHandoverShifts = summaries
      .filter((s) => s.status === "pending_handover")
      .sort((a, b) => String(b.closedAt || b.openedAt).localeCompare(String(a.closedAt || a.openedAt)));
    const pendingDiscrepancyShifts = summaries
      .filter((s) => s.discrepancyStatus === "pending_review")
      .sort((a, b) => String(b.closedAt || b.openedAt).localeCompare(String(a.closedAt || a.openedAt)));

    const filtered = summaries.filter((s) => {
      if (fundFilter && fundFilter !== "all" && s.fundId !== fundFilter) return false;
      if (statusFilter === "discrepancy") {
        if (s.discrepancyStatus !== "pending_review") return false;
      } else if (statusFilter && statusFilter !== "all" && s.status !== statusFilter) {
        return false;
      }
      if (staffFilter && staffFilter !== "all") {
        if (s.outgoingStaffName !== staffFilter && s.incomingStaffName !== staffFilter && s.targetIncomingStaffName !== staffFilter) {
          return false;
        }
      }
      if (dateFrom && s.shiftDate && s.shiftDate < dateFrom) return false;
      if (dateTo && s.shiftDate && s.shiftDate > dateTo) return false;
      if (search) {
        const hay = [
          s.shiftCode,
          s.shiftLabel,
          s.outgoingStaffName,
          s.incomingStaffName,
          s.targetIncomingStaffName,
          s.discrepancyExplanation,
          s.closeNote,
          s.confirmNote,
          s.resolutionNote
        ].join(" ").toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    // Pin pending_handover and unresolved discrepancy shifts to the top for Manager attention
    const sortPriority = (s) => {
      if (s.status === "pending_handover") return 0;
      if (s.discrepancyStatus === "pending_review") return 1;
      if (s.status === "open") return 2;
      return 3;
    };
    filtered.sort((a, b) => {
      const pDiff = sortPriority(a) - sortPriority(b);
      if (pDiff !== 0) return pDiff;
      return String(b.openedAt || "").localeCompare(String(a.openedAt || ""));
    });

    const unassignedLegacyTxs = (Array.isArray(fState.transactions) ? fState.transactions : [])
      .filter((t) => t && t.txType === "legacy_payment" && t.legacyStatus === "needs_reconciliation");
    const unassignedLegacyAmount = roundVND(unassignedLegacyTxs.reduce((s, t) => s + parseVND(t.amount), 0));

    return {
      rows: filtered,
      allRows: summaries,
      allCount: summaries.length,
      activeOpenShift,
      pendingHandoverShifts,
      pendingDiscrepancyShifts,
      pendingHandoverCount: pendingHandoverShifts.length,
      pendingDiscrepancyCount: pendingDiscrepancyShifts.length,
      openingBasis: getShiftOpeningBasis(fState, targetFund),
      staffList: [...staffSet].sort((a, b) => a.localeCompare(b, "vi")),
      unassignedLegacyCount: unassignedLegacyTxs.length,
      unassignedLegacyAmount
    };
  }

  function generateShiftsCsvContent(report) {
    const headers = [
      "Mã ca", "Ngày ca", "Quỹ tại quầy", "Trạng thái", "Qua đêm",
      "Người giao ca", "Người nhận ca", "Giờ mở ca", "Giờ kết ca", "Giờ nhận bàn giao",
      "Căn cứ đầu ca", "Đầu ca (VNĐ)", "Tiền mặt vào (VNĐ)", "Tiền mặt ra (VNĐ)",
      "Dự kiến tại két (VNĐ)", "Thực đếm khi giao (VNĐ)", "Chênh lệch giao ca (VNĐ)", "Phân loại",
      "Thực nhận ca sau (VNĐ)", "Chênh lệch nhận - giao (VNĐ)", "Trạng thái chênh lệch",
      "Giải trình chênh lệch", "Chứng từ trong ca", "CK ngân hàng tham khảo (VNĐ)",
      "Ghi chú xử lý quản lý"
    ];
    const discStatusMap = {
      none: "Khớp",
      pending_review: "Cần quản lý xử lý",
      resolved: "Đã xử lý"
    };
    const rows = (report && report.rows ? report.rows : []).map((s) => [
      s.shiftCode,
      s.shiftDate,
      s.fundName,
      s.statusLabel,
      s.isOvernight ? "Ca qua đêm" : "Trong ngày",
      s.outgoingStaffName,
      s.incomingStaffName || s.targetIncomingStaffName || "",
      s.openedAtVN || s.openedAt,
      s.closedAtVN || "",
      s.confirmedAtVN || "",
      s.openingBasisRef,
      s.openingCash,
      s.cashInTotal,
      s.cashOutTotal,
      s.expectedCash,
      s.countedCash !== null ? s.countedCash : "",
      s.countedCash !== null ? s.discrepancy : "",
      s.discrepancyLabel,
      s.receivedCash !== null ? s.receivedCash : "",
      s.receivedCash !== null ? s.handoverCountDiff : "",
      discStatusMap[s.discrepancyStatus] || s.discrepancyStatus,
      s.discrepancyExplanation || "",
      (s.cashTransactions || []).map((t) => `${t.voucherCode}(${t.signedCashImpact >= 0 ? "+" : ""}${t.signedCashImpact})`).join("; "),
      s.bankRefTotal || 0,
      s.resolutionNote || ""
    ]);
    return "\uFEFF" + [headers, ...rows].map((row) => row.map(sanitizeCsvCell).join(",")).join("\r\n");
  }

  function generateShiftHandoverHtml(summary) {
    if (!summary || typeof summary !== "object") return "";
    const esc = escapeHtml;
    const cashRows = (summary.cashTransactions || []).map((t, idx) => {
      const target = t.txType === "supplier_payment"
        ? `HĐ ${t.invoiceVoucherNo || t.invoiceId} — ${t.supplierName || "NCC"}`
        : t.txType === "fund_transfer"
          ? `${t.fromFundName || t.fromFundId} → ${t.toFundName || t.toFundId}`
          : (t.groupCodeDisplay ? `Đoàn ${t.groupCodeDisplay} (${t.guestName || ""})` : `${t.roomLabel || ""} ${t.guestName || ""}`.trim() || t.note || "—");
      return `<tr>
        <td>${idx + 1}</td>
        <td><strong>${esc(t.voucherCode)}</strong></td>
        <td>${esc(formatVietnamDateTime(t.recordedAt))}</td>
        <td>${esc(t.txTypeLabel || t.txType)}</td>
        <td>${esc(target)}</td>
        <td style="text-align:right;font-weight:600;color:${t.signedCashImpact < 0 ? "#b91c1c" : "#15803d"}">${esc(formatSignedVND(t.signedCashImpact))}</td>
        <td>${esc(t.operator || "")}</td>
      </tr>`;
    }).join("");

    const bankRows = (summary.bankRefTransactions || []).map((t, idx) => {
      const target = t.groupCodeDisplay ? `Đoàn ${t.groupCodeDisplay} (${t.guestName || ""})` : `${t.roomLabel || ""} ${t.guestName || ""}`.trim() || t.note || "—";
      return `<tr>
        <td>${idx + 1}</td>
        <td>${esc(t.voucherCode)}</td>
        <td>${esc(formatVietnamDateTime(t.recordedAt))}</td>
        <td>${esc(target)}</td>
        <td style="text-align:right">${esc(formatSignedVND(t.txType === "customer_refund" ? -t.amount : t.amount))}</td>
      </tr>`;
    }).join("");

    const adjRows = (summary.adjustmentHistory || []).map((a) => `<li><strong>${esc(formatVietnamDateTime(a.ts))}</strong> — ${esc(a.operator)}: ${esc(a.reason || a.action)}${a.voucherCode ? ` (Chứng từ ${esc(a.voucherCode)}: ${esc(formatSignedVND(a.adjustmentAmount))})` : ""}${a.note ? ` • ${esc(a.note)}` : ""}</li>`).join("");

    return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>Biên bản bàn giao ca ${esc(summary.shiftCode)} — Dongvan Ville du H'mong Hotel</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1e293b; margin: 24px; font-size: 13px; line-height: 1.45; }
  h1 { font-size: 18px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.4px; }
  .sub { color: #475569; margin: 0 0 16px; font-size: 12px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin-bottom: 16px; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc; }
  .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
  .kpi { border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; }
  .kpi span { display: block; font-size: 11px; color: #64748b; }
  .kpi strong { font-size: 15px; display: block; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; font-size: 12px; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
  th { background: #f1f5f9; }
  .alert { padding: 10px 12px; border-radius: 6px; border: 1px solid #f59e0b; background: #fffbeb; margin-bottom: 14px; }
  .sigs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 28px; text-align: center; }
  .sig-box { min-height: 80px; }
  @media print { .no-print { display: none; } body { margin: 10px; } }
</style>
</head>
<body>
  <div class="no-print" style="margin-bottom:12px;text-align:right">
    <button onclick="window.print()" style="padding:7px 14px;font-weight:600;cursor:pointer">In biên bản</button>
  </div>
  <h1>Biên bản bàn giao ca lễ tân — ${esc(summary.shiftCode)}</h1>
  <p class="sub">Dongvan Ville du H'mong Hotel • Quỹ: ${esc(summary.fundName)} • Trạng thái: ${esc(summary.statusLabel)}${summary.isOvernight ? " • Ca qua đêm" : ""}</p>
  <div class="grid">
    <div><strong>Người giao ca:</strong> ${esc(summary.outgoingStaffName)}</div>
    <div><strong>Người nhận ca:</strong> ${esc(summary.incomingStaffName || summary.targetIncomingStaffName || "Chưa xác nhận")}</div>
    <div><strong>Giờ mở ca:</strong> ${esc(summary.openedAtVN)}</div>
    <div><strong>Giờ kết ca:</strong> ${esc(summary.closedAtVN)}</div>
    <div><strong>Căn cứ đầu ca:</strong> ${esc(summary.openingBasisRef)}</div>
    <div><strong>Giờ xác nhận nhận:</strong> ${esc(summary.confirmedAtVN)}</div>
  </div>
  <div class="kpi-row">
    <div class="kpi"><span>Số đầu ca</span><strong>${esc(formatVND(summary.openingCash))}</strong></div>
    <div class="kpi"><span>Tiền mặt vào / ra</span><strong>+${esc(formatVND(summary.cashInTotal))} / -${esc(formatVND(summary.cashOutTotal))}</strong></div>
    <div class="kpi"><span>Dự kiến tại két</span><strong>${esc(formatVND(summary.expectedCash))}</strong></div>
    <div class="kpi"><span>Thực đếm giao / Thực nhận</span><strong>${summary.countedCash !== null ? esc(formatVND(summary.countedCash)) : "—"} / ${summary.receivedCash !== null ? esc(formatVND(summary.receivedCash)) : "—"}</strong></div>
  </div>
  ${summary.hasDiscrepancy ? `<div class="alert">
    <strong>Chênh lệch giao ca: ${esc(summary.discrepancyLabel)} (${esc(formatSignedVND(summary.discrepancy))})</strong>
    ${summary.handoverCountDiff ? ` • <strong>Chênh lệch người nhận đếm lại: ${esc(formatSignedVND(summary.handoverCountDiff))}</strong>` : ""}
    ${summary.discrepancyExplanation ? `<div>Giải trình: ${esc(summary.discrepancyExplanation)}</div>` : ""}
    ${summary.confirmNote ? `<div>Ghi chú người nhận: ${esc(summary.confirmNote)}</div>` : ""}
  </div>` : ""}
  <h3>1. Chứng từ tiền mặt tính trong ca (${(summary.cashTransactions || []).length} chứng từ)</h3>
  <table>
    <thead><tr><th>#</th><th>Mã CT</th><th>Thời điểm</th><th>Loại</th><th>Đơn / NCC / Quỹ</th><th style="text-align:right">Tiền mặt két</th><th>Người ghi</th></tr></thead>
    <tbody>${cashRows || '<tr><td colspan="7" style="text-align:center;color:#64748b">Không có phát sinh tiền mặt tại quầy trong ca này.</td></tr>'}</tbody>
  </table>
  <h3>2. Khách chuyển khoản ngân hàng trong ca — chỉ tham khảo, KHÔNG cộng vào tiền mặt bàn giao (${(summary.bankRefTransactions || []).length} giao dịch • ${esc(formatVND(summary.bankRefTotal))})</h3>
  <table>
    <thead><tr><th>#</th><th>Mã CT</th><th>Thời điểm</th><th>Đơn / Khách</th><th style="text-align:right">Số tiền CK</th></tr></thead>
    <tbody>${bankRows || '<tr><td colspan="5" style="text-align:center;color:#64748b">Không có giao dịch chuyển khoản ngân hàng trong ca.</td></tr>'}</tbody>
  </table>
  ${adjRows ? `<h3>3. Lịch sử xử lý / điều chỉnh sau kết ca của Quản lý</h3><ul>${adjRows}</ul>` : ""}
  <div class="sigs">
    <div class="sig-box"><strong>Người giao ca</strong><br/><small>(Ký, ghi rõ họ tên)</small><br/><br/><br/>${esc(summary.outgoingStaffName)}</div>
    <div class="sig-box"><strong>Người nhận ca</strong><br/><small>(Ký, ghi rõ họ tên)</small><br/><br/><br/>${esc(summary.incomingStaffName || "")}</div>
    <div class="sig-box"><strong>Quản lý kiểm tra</strong><br/><small>(Ký, ghi rõ họ tên)</small><br/><br/><br/>${esc(summary.resolvedBy || "")}</div>
  </div>
</body>
</html>`;
  }

  /* -------------------- Unified Versioned Backup & Atomic Restore Verification (v1.9.0) -------------------- */

  const BACKUP_SCHEMA_VERSION = 5;
  const BACKUP_SCHEMA_NAME = "dongvan-pms-backup-v5";

  const BACKUP_SECRET_KEYS = new Set([
    "staffaccounts",
    "staff_accounts",
    "accounts",
    "sessions",
    "staff_sessions",
    "password",
    "passwordhash",
    "password_hash",
    "passhash",
    "passcode",
    "sessiontoken",
    "session_token",
    "anonkey",
    "anon_key",
    "access_token",
    "accesstoken",
    "refresh_token",
    "refreshtoken",
    "service_role_key",
    "servicerolekey",
    "supabasekey",
    "supabase_key",
    "apikey",
    "api_key",
    "secret",
    "token"
  ]);

  function stripSecretsDeep(value, depth = 0) {
    if (depth > 14 || value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((item) => stripSecretsDeep(item, depth + 1));
    if (typeof value !== "object") return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (BACKUP_SECRET_KEYS.has(String(k).toLowerCase())) continue;
      out[k] = stripSecretsDeep(v, depth + 1);
    }
    return out;
  }

  function extractPhotoIdFromRef(ref) {
    const s = String(ref || "").trim();
    const m = s.match(/\/api\/photos\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : "";
  }

  function collectBackupMediaInventory(payload, existingPhotoIds = null) {
    const existingSet = existingPhotoIds
      ? (existingPhotoIds instanceof Set ? existingPhotoIds : new Set(Array.isArray(existingPhotoIds) ? existingPhotoIds : []))
      : null;
    const items = [];
    const pushItem = (source, label, ref, extra = {}) => {
      if (!ref || typeof ref !== "string") return;
      const trimmed = ref.trim();
      if (!trimmed) return;
      const isInline = trimmed.startsWith("data:");
      const photoId = extractPhotoIdFromRef(trimmed);
      let availability = isInline ? "inline_restorable" : (photoId ? "server_local_ref" : "external_url");
      if (!isInline && photoId && existingSet) {
        availability = existingSet.has(photoId) ? "available_on_target" : "missing_on_target";
      }
      items.push({
        source,
        label: sanitizeText(label, 120) || source,
        kind: extra.kind || (trimmed.startsWith("data:application/pdf") ? "pdf" : "image"),
        inline: isInline,
        photoId: photoId || "",
        refPreview: isInline ? `${trimmed.slice(0, 32)}... (${trimmed.length} chars)` : trimmed.slice(0, 180),
        availability
      });
    };

    const bookings = Array.isArray(payload && payload.bookings) ? payload.bookings : [];
    for (const b of bookings) {
      if (b && b.confirmationPdf && b.confirmationPdf.dataUrl) {
        pushItem("booking_pdf", `${b.roomId || ""} - ${b.guestName || b.id} (${b.confirmationPdf.name || "PDF"})`, b.confirmationPdf.dataUrl, { kind: "pdf" });
      }
    }

    const fState = payload && payload.financeState && typeof payload.financeState === "object" ? payload.financeState : null;
    if (fState && Array.isArray(fState.supplierInvoices)) {
      for (const inv of fState.supplierInvoices) {
        if (inv && inv.attachment && inv.attachment.dataUrl) {
          pushItem("supplier_invoice", `${inv.voucherNo || inv.id} (${inv.attachment.name || "Chứng từ NCC"})`, inv.attachment.dataUrl, {
            kind: inv.attachment.mimeType === "application/pdf" ? "pdf" : "image"
          });
        }
      }
    }

    const hkTasks = Array.isArray(payload && payload.housekeepingTasks) ? payload.housekeepingTasks : [];
    for (const t of hkTasks) {
      if (t && Array.isArray(t.photos)) {
        t.photos.forEach((p, idx) => {
          const ref = typeof p === "string" ? p : (p && (p.url || p.dataUrl || p.src));
          if (ref) pushItem("housekeeping_photo", `Buồng phòng ${t.roomId || ""} #${idx + 1}`, ref, { kind: "image" });
        });
      }
    }

    const issues = Array.isArray(payload && payload.maintenanceIssues) ? payload.maintenanceIssues : [];
    for (const iss of issues) {
      if (iss && Array.isArray(iss.photos)) {
        iss.photos.forEach((p, idx) => {
          const ref = typeof p === "string" ? p : (p && (p.url || p.dataUrl || p.src));
          if (ref) pushItem("issue_photo", `Sự cố ${iss.roomId || ""} - ${iss.title || ""} #${idx + 1}`, ref, { kind: "image" });
        });
      }
    }

    const inlineRestorableCount = items.filter((i) => i.inline).length;
    const serverLocalRefs = items.filter((i) => !i.inline && i.photoId);
    const externalUrlRefs = items.filter((i) => !i.inline && !i.photoId);
    const availableOnTargetCount = existingSet
      ? inlineRestorableCount + serverLocalRefs.filter((i) => i.availability === "available_on_target").length
      : inlineRestorableCount;
    const missingOnTargetRefs = existingSet
      ? serverLocalRefs.filter((i) => i.availability === "missing_on_target")
      : serverLocalRefs;

    return {
      totalCount: items.length,
      inlineRestorableCount,
      serverLocalRefCount: serverLocalRefs.length,
      externalUrlCount: externalUrlRefs.length,
      availableOnTargetCount,
      missingOnTargetCount: missingOnTargetRefs.length,
      missingRefs: missingOnTargetRefs.map((i) => ({ source: i.source, label: i.label, photoId: i.photoId, ref: i.refPreview })),
      items
    };
  }

  function buildUnifiedBackupPayload(stateInput = {}, meta = {}) {
    const src = stateInput && typeof stateInput === "object" ? stateInput : {};
    const bookingsRaw = Array.isArray(src.bookings) ? src.bookings : [];
    const bookings = bookingsRaw
      .map((b) => {
        const res = sanitizeBookingRecord(b, null);
        return res && res.ok ? res.record : null;
      })
      .filter(Boolean);
    normalizeDormSlots(bookings);

    const operatingCosts = src.operatingCosts && typeof src.operatingCosts === "object"
      ? sanitizeOperatingCostsState(src.operatingCosts)
      : createDefaultOperatingCostsState();

    const financeState = src.financeState && typeof src.financeState === "object"
      ? sanitizeFinanceState(src.financeState)
      : createDefaultFinanceState();

    const housekeepingTasks = (Array.isArray(src.housekeepingTasks) ? src.housekeepingTasks : [])
      .map(sanitizeHousekeepingTask)
      .filter(Boolean);

    const maintenanceIssues = (Array.isArray(src.maintenanceIssues) ? src.maintenanceIssues : [])
      .map(sanitizeMaintenanceIssue)
      .filter(Boolean);

    const auditLogs = (Array.isArray(src.auditLogs) ? src.auditLogs : []).slice(0, 500);

    const rawPayload = {
      schema: BACKUP_SCHEMA_NAME,
      version: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      source: sanitizeText(meta.source || (meta.autoBackup ? "auto" : "desktop"), 30) || "desktop",
      exportedBy: sanitizeText(meta.exportedBy || "", 60),
      autoBackup: Boolean(meta.autoBackup),
      hotel: "Dongvan Ville du H'mong Hotel",
      bookings,
      operatingCosts,
      financeState,
      housekeepingTasks,
      maintenanceIssues,
      auditLogs
    };
    const scrubbed = stripSecretsDeep(rawPayload);
    scrubbed.mediaInventory = collectBackupMediaInventory(scrubbed);
    return scrubbed;
  }

  function computeFinanceSnapshotMetrics(bookings, financeState) {
    const fState = sanitizeFinanceState(financeState);
    const txs = fState.transactions || [];
    const byType = {
      customer_payment: 0,
      customer_refund: 0,
      supplier_payment: 0,
      fund_transfer: 0,
      balance_adjustment: 0,
      legacy_opening: 0
    };
    for (const tx of txs) {
      if (byType[tx.txType] !== undefined) byType[tx.txType] += 1;
      else byType[tx.txType] = 1;
    }
    const cb = computeCashbookReport(fState, bookings, {});
    const ar = computeReceivablesReport(bookings, fState, {});
    const ap = computeSupplierPayablesReport(fState, null, {});
    const fundMap = {};
    for (const f of (cb.funds || [])) {
      fundMap[f.id] = f.closingBalance || 0;
    }
    const confirmedShifts = (fState.cashShifts || []).filter((s) => s.status === "confirmed" || s.status === "resolved");
    return {
      totalTransactions: txs.length,
      voucherCodes: txs.map((t) => t.voucherCode || t.voucherNo).filter(Boolean).sort(),
      byType,
      supplierInvoiceCount: (fState.supplierInvoices || []).length,
      cashShiftCount: (fState.cashShifts || []).length,
      confirmedShiftCount: confirmedShifts.length,
      confirmedShiftTotals: confirmedShifts
        .map((s) => ({
          shiftCode: s.shiftCode,
          status: s.status,
          expectedCash: s.expectedCash,
          countedCash: s.countedCash,
          receivedCash: s.receivedCash,
          discrepancy: s.discrepancy
        }))
        .sort((a, b) => String(a.shiftCode).localeCompare(String(b.shiftCode))),
      openingBalanceCount: (fState.openingBalances || []).length,
      reconciliationCheckCount: (fState.reconciliationChecks || []).length,
      fundBalances: {
        cash_frontdesk: fundMap.cash_frontdesk || 0,
        bank_main: fundMap.bank_main || 0,
        unassigned_legacy: fundMap.unassigned_legacy || 0,
        totalConfirmedBalance: cb.totalHotelCashHeld || 0
      },
      customerReceivablesTotal: ar.totalRemaining || 0,
      customerNetPaidTotal: ar.totalNetPaid || 0,
      supplierPayablesTotal: ap.totalRemaining || 0,
      supplierPaidTotal: ap.totalPaid || 0
    };
  }

  function inspectBackupPayload(rawPayload, options = {}) {
    let parsed = rawPayload;
    if (typeof rawPayload === "string") {
      try {
        parsed = JSON.parse(rawPayload);
      } catch {
        return { ok: false, code: "INVALID_JSON", error: "File sao lưu không phải JSON hợp lệ." };
      }
    }
    if (!parsed || (typeof parsed !== "object" && !Array.isArray(parsed))) {
      return { ok: false, code: "INVALID_FORMAT", error: "Cấu trúc file sao lưu không hợp lệ." };
    }

    const validated = validateAndSanitizeImport(parsed);
    if (!validated.ok) {
      return { ok: false, code: "INVALID_IMPORT", error: validated.error, details: validated.details };
    }

    const isObj = !Array.isArray(parsed) && typeof parsed === "object";
    const version = isObj && Number.isFinite(Number(parsed.version)) ? Number(parsed.version) : 1;
    const schema = isObj && typeof parsed.schema === "string" ? parsed.schema : `legacy-v${version}`;
    const exportedAt = isObj && typeof parsed.exportedAt === "string" ? parsed.exportedAt : "";
    const source = isObj && typeof parsed.source === "string" ? parsed.source : "legacy";
    const hotel = isObj && typeof parsed.hotel === "string" ? parsed.hotel : "Dongvan Ville du H'mong Hotel";

    const hasFinanceState = Boolean(isObj && Object.prototype.hasOwnProperty.call(parsed, "financeState") && parsed.financeState && typeof parsed.financeState === "object");
    const hasOperatingCosts = Boolean(isObj && Object.prototype.hasOwnProperty.call(parsed, "operatingCosts") && parsed.operatingCosts && typeof parsed.operatingCosts === "object");
    const hasHousekeepingTasks = Boolean(isObj && Object.prototype.hasOwnProperty.call(parsed, "housekeepingTasks") && Array.isArray(parsed.housekeepingTasks));
    const hasMaintenanceIssues = Boolean(isObj && Object.prototype.hasOwnProperty.call(parsed, "maintenanceIssues") && Array.isArray(parsed.maintenanceIssues));
    const hasAuditLogs = Boolean(isObj && Object.prototype.hasOwnProperty.call(parsed, "auditLogs") && Array.isArray(parsed.auditLogs));

    const financeState = hasFinanceState ? sanitizeFinanceState(parsed.financeState) : null;
    const operatingCosts = hasOperatingCosts ? sanitizeOperatingCostsState(parsed.operatingCosts) : null;
    const housekeepingTasks = hasHousekeepingTasks
      ? parsed.housekeepingTasks.map(sanitizeHousekeepingTask).filter(Boolean)
      : null;
    const maintenanceIssues = hasMaintenanceIssues
      ? parsed.maintenanceIssues.map(sanitizeMaintenanceIssue).filter(Boolean)
      : null;

    const presentSections = ["bookings"];
    const missingSections = [];
    if (hasFinanceState) presentSections.push("financeState"); else missingSections.push("financeState");
    if (hasOperatingCosts) presentSections.push("operatingCosts"); else missingSections.push("operatingCosts");
    if (hasHousekeepingTasks) presentSections.push("housekeepingTasks"); else missingSections.push("housekeepingTasks");
    if (hasMaintenanceIssues) presentSections.push("maintenanceIssues"); else missingSections.push("maintenanceIssues");

    const warnings = [];
    const isLegacyWithoutFinance = !hasFinanceState;
    if (isLegacyWithoutFinance) {
      warnings.push(
        `File sao lưu phiên bản v${version} không có sổ tài chính (financeState). Hệ thống sẽ GIỮ NGUYÊN sổ tài chính, hóa đơn NCC và sổ giao ca hiện có — KHÔNG xóa trắng.`
      );
    }
    if (!hasOperatingCosts) {
      warnings.push("File sao lưu không có dữ liệu Chi phí vận hành (operatingCosts) — hệ thống sẽ giữ nguyên dữ liệu chi phí hiện có.");
    }

    const bookings = validated.bookings;
    const groupSet = new Set(bookings.map((b) => normalizeGroupCode(b.groupCode)).filter(Boolean));
    const activeBookingCount = bookings.filter((b) => !isBookingCancelled(b)).length;
    const cancelledBookingCount = bookings.length - activeBookingCount;

    const financeSummary = hasFinanceState ? computeFinanceSnapshotMetrics(bookings, financeState) : null;
    const costsSummary = hasOperatingCosts
      ? {
          itemCount: (operatingCosts.items || []).length,
          actualEntryCount: (operatingCosts.actualEntries || []).length,
          finalizedMonthCount: Object.keys(operatingCosts.monthlyFinalized || {}).length
        }
      : null;

    const mediaInventory = collectBackupMediaInventory(
      { bookings, financeState, housekeepingTasks, maintenanceIssues },
      options.existingPhotoIds || null
    );
    if (mediaInventory.missingOnTargetCount > 0) {
      warnings.push(
        `Có ${mediaInventory.missingOnTargetCount} tệp ảnh lưu cục bộ trên máy chủ cũ (/api/photos/...) không đi kèm trong file JSON (các chứng từ/PDF nhúng inline: ${mediaInventory.inlineRestorableCount} tệp vẫn khôi phục đầy đủ).`
      );
    }

    return {
      ok: true,
      version,
      schema,
      exportedAt,
      source,
      hotel,
      hasBookings: true,
      hasFinanceState,
      hasOperatingCosts,
      hasHousekeepingTasks,
      hasMaintenanceIssues,
      hasAuditLogs,
      isLegacyWithoutFinance,
      presentSections,
      missingSections,
      warnings,
      sanitized: {
        bookings,
        financeState,
        operatingCosts,
        housekeepingTasks,
        maintenanceIssues
      },
      summary: {
        bookingCount: bookings.length,
        activeBookingCount,
        cancelledBookingCount,
        groupCount: groupSet.size,
        finance: financeSummary,
        operatingCosts: costsSummary,
        housekeepingTaskCount: housekeepingTasks ? housekeepingTasks.length : null,
        maintenanceIssueCount: maintenanceIssues ? maintenanceIssues.length : null
      },
      mediaInventory
    };
  }

  function verifyRestoredState(expectedInput, actualState, preExistingState = null) {
    const inspected = expectedInput && expectedInput.ok && expectedInput.sanitized
      ? expectedInput
      : inspectBackupPayload(expectedInput);
    if (!inspected.ok) {
      return { ok: false, allMatched: false, error: inspected.error, diffs: [] };
    }
    const actualBookings = Array.isArray(actualState && actualState.bookings) ? actualState.bookings : [];
    const actualFinance = actualState && actualState.financeState ? sanitizeFinanceState(actualState.financeState) : createDefaultFinanceState();
    const checks = [];
    const diffs = [];
    const addCheck = (key, label, expectedVal, actualVal) => {
      const diff = typeof expectedVal === "number" && typeof actualVal === "number"
        ? actualVal - expectedVal
        : (JSON.stringify(expectedVal) === JSON.stringify(actualVal) ? 0 : 1);
      const ok = diff === 0;
      const entry = { key, label, expected: expectedVal, actual: actualVal, diff, ok };
      checks.push(entry);
      if (!ok) diffs.push(entry);
    };

    addCheck("bookingCount", "Số lượng đơn đặt phòng", inspected.summary.bookingCount, actualBookings.length);

    if (inspected.hasFinanceState && inspected.summary.finance) {
      const expF = inspected.summary.finance;
      const actF = computeFinanceSnapshotMetrics(actualBookings, actualFinance);
      addCheck("txCount", "Tổng số chứng từ tài chính", expF.totalTransactions, actF.totalTransactions);
      addCheck("voucherCodes", "Danh sách mã chứng từ", expF.voucherCodes, actF.voucherCodes);
      addCheck("fund_cash_frontdesk", "Số dư quỹ tiền mặt lễ tân", expF.fundBalances.cash_frontdesk, actF.fundBalances.cash_frontdesk);
      addCheck("fund_bank_main", "Số dư tài khoản ngân hàng", expF.fundBalances.bank_main, actF.fundBalances.bank_main);
      addCheck("fund_unassigned_legacy", "Dữ liệu chuyển tiếp chưa gán quỹ", expF.fundBalances.unassigned_legacy, actF.fundBalances.unassigned_legacy);
      addCheck("fund_total_confirmed", "Tổng số dư đã xác định quỹ", expF.fundBalances.totalConfirmedBalance, actF.fundBalances.totalConfirmedBalance);
      addCheck("customerReceivables", "Công nợ khách còn phải thu", expF.customerReceivablesTotal, actF.customerReceivablesTotal);
      addCheck("supplierPayables", "Công nợ NCC còn phải trả", expF.supplierPayablesTotal, actF.supplierPayablesTotal);
      addCheck("cashShiftCount", "Số phiên giao ca tiền mặt", expF.cashShiftCount, actF.cashShiftCount);
      addCheck("confirmedShifts", "Số liệu ca đã xác nhận", expF.confirmedShiftTotals, actF.confirmedShiftTotals);
    } else if (preExistingState && preExistingState.financeState) {
      const preF = sanitizeFinanceState(preExistingState.financeState);
      const preCodes = (preF.transactions || []).map((t) => t.voucherCode || t.voucherNo).filter(Boolean).sort();
      const actCodes = (actualFinance.transactions || []).map((t) => t.voucherCode || t.voucherNo).filter(Boolean).sort();
      addCheck("preservedFinanceTxCount", "Giữ nguyên số chứng từ hiện có (file cũ thiếu tài chính)", preF.transactions.length, actualFinance.transactions.length);
      addCheck("preservedVoucherCodes", "Giữ nguyên mã chứng từ hiện có", preCodes, actCodes);
    }

    return {
      ok: diffs.length === 0,
      allMatched: diffs.length === 0,
      checks,
      diffs
    };
  }

  return {
    BACKUP_SCHEMA_VERSION,
    BACKUP_SCHEMA_NAME,
    stripSecretsDeep,
    collectBackupMediaInventory,
    buildUnifiedBackupPayload,
    computeFinanceSnapshotMetrics,
    inspectBackupPayload,
    verifyRestoredState,
    STORAGE_KEY,
    BACKUP_KEY,
    AUTOBACKUP_KEY,
    AUDIT_KEY,
    META_KEY,
    QUARANTINE_KEY,
    LOCK_KEY,
    OPERATING_COSTS_KEY,
    HOUSEKEEPING_KEY,
    ISSUES_KEY,
    ACCOUNTS_KEY,
    FINANCE_KEY,
    MAX_AUTOBACKUPS,
    MAX_CONFIRMATION_PDF_BYTES,
    HOTEL_TIMEZONE,
    ROOMS,
    ROOM_SECTIONS,
    DORM_SLOTS,
    CHANNELS,
    CODE_PLACEHOLDERS,
    CONFIRMERS,
    DOW_VI,
    DOW_FULL_VI,
    pad2,
    formatDateISO,
    isValidISODate,
    isValidMonthKey,
    formatMonthVN,
    getCurrentMonthKey,
    getTodayISO,
    toVietnamParts,
    getVietnamTodayISO,
    getVietnamNowISO,
    formatVietnamDateTime,
    getVietnamDateFromISO,
    normalizeFinanceDateISO,
    normalizeFinanceTimestamp,
    addDaysISO,
    diffNights,
    formatDateVN,
    getDaysInMonth,
    parseVND,
    roundVND,
    parseSignedVND,
    formatVND,
    formatSignedVND,
    formatShortVND,
    formatNumberInput,
    formatFileSize,
    escapeHtml,
    sanitizeCsvCell,
    sanitizeText,
    sanitizeConfirmationPdf,
    stripDangerousKeys,
    getRoomById,
    getRemaining,
    getPaymentStatus,
    validatePaymentAmounts,
    VAT_RATE,
    calculateVatBreakdown,
    extractPreVatFromTotal,
    getCellPaymentBadge,
    getGroupCellPaymentBadge,
    detectChannelKey,
    isBookingCancelled,
    bookingCoversDate,
    datesOverlap,
    getDormSlotMapForDate,
    getDormOccupiedSlotsInRange,
    checkRegularConflict,
    checkDormSlotConflict,
    normalizeDormSlots,
    sanitizeBookingRecord,
    auditBookingConsistency,
    validateAndSanitizeImport,
    computeMonthlyFinancials,
    normalizeGroupCode,
    computeBookingGroupSummary,
    computeAllBookingGroups,
    allocateGroupPayment,
    buildCopiedBookingPayload,
    buildGroupSyncUpdates,
    getConfirmationRoomCategoryName,
    buildBookingConfirmationData,
    renderBookingConfirmationHtml,
    COST_CALC_MODES,
    DEFAULT_COST_ITEMS,
    createDefaultOperatingCostsState,
    sanitizeOperatingCostsState,
    getEffectiveCostRate,
    upsertCostItem,
    deleteCostRateHistoryEntry,
    toggleCostItemActive,
    addActualCostEntry,
    deleteActualCostEntry,
    setCostItemFinalized,
    computeMonthlyStayMetrics,
    computeMonthlyProratedRevenue,
    computeMonthlyOperatingCosts,
    generateOperatingCostsCsvContent,
    SUPER_ADMIN_USERNAME,
    SUPER_ADMIN_DISPLAY_NAME,
    SUPER_ADMIN_DEFAULT_PASSCODE,
    STAFF_ROLES,
    normalizeRole,
    isSuperAdminRole,
    getRoleLabel,
    hasPermission,
    NAV_ICONS_SVG,
    NAV_CONFIG,
    getVisibleNavGroups,
    HK_TASK_TYPES,
    HK_TASK_STATUSES,
    ISSUE_SEVERITIES,
    ISSUE_STATUSES,
    sanitizePhotoRef,
    sanitizePhotoList,
    buildCheckoutHousekeepingNote,
    sanitizeHousekeepingTask,
    sanitizeMaintenanceIssue,
    sanitizeStaffAccountPublic,
    getHousekeepingTasksForDate,
    computeRoomOperationalStatus,
    computeAllRoomOperationalStatuses,
    FINANCE_FUNDS,
    PAYMENT_METHODS,
    FINANCE_TX_TYPES,
    SUPPLIER_INVOICE_STATUSES,
    REFUND_CATEGORIES,
    SHIFT_STATUSES,
    getFinanceFundById,
    getPaymentMethodMeta,
    createDefaultFinanceState,
    sanitizeSupplierInvoiceAttachment,
    sanitizeSupplierInvoiceLine,
    sanitizeSupplierInvoice,
    sanitizeCashShift,
    sanitizeFinanceTransaction,
    sanitizeFinanceState,
    getBookingChargesBreakdown,
    buildFinanceEntities,
    computeEntityFinancials,
    computeBookingFinancialSummary,
    computeReceivablesReport,
    computeCashbookReport,
    computeSupplierPayablesReport,
    computeCalendarFinanceKPIs,
    buildLegacyMigrationPlan,
    getShiftCashImpact,
    getShiftOpeningBasis,
    computeShiftLiveSummary,
    computeShiftsReport,
    generateReceivablesCsvContent,
    generateCashbookCsvContent,
    generateSupplierPayablesCsvContent,
    generateShiftsCsvContent,
    generateShiftHandoverHtml,
    generateCsvContent,
    diffBookingChanges,
    generateAuditCsvContent,
    createSampleBookings,
    runWithCrossTabLock,
    createBookingStore
  };
});
