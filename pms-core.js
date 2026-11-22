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

  function getCellPaymentBadge(bk, isStart, hasNext) {
    const total = parseVND(bk.totalAmount);
    const paid = parseVND(bk.paidAmount);
    const rem = getRemaining(bk);
    const status = getPaymentStatus(bk);

    if (status === "paid") {
      return {
        cls: "paid",
        text: isStart && total > 0 ? `✓ Đủ ${formatShortVND(total)}` : "✓ Đã TT",
        title: total > 0 ? `Đã thanh toán hết (${formatVND(paid)})` : "Miễn phí / Đã thanh toán"
      };
    }
    if (status === "deposit") {
      if (isStart && hasNext) {
        return { cls: "deposit", text: `Cọc ${formatShortVND(paid)}`, title: `Đã cọc ${formatVND(paid)}, còn nợ ${formatVND(rem)}` };
      }
      if (!isStart) {
        return { cls: "unpaid", text: `Nợ ${formatShortVND(rem)}`, title: `Đã cọc ${formatVND(paid)}, còn nợ ${formatVND(rem)}` };
      }
      return { cls: "deposit", text: `Cọc -${formatShortVND(rem)}`, title: `Đã cọc ${formatVND(paid)}, còn nợ ${formatVND(rem)}` };
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
    return isValidISODate(bk.checkin) && isValidISODate(bk.checkout) && bk.checkin <= iso && iso < bk.checkout;
  }

  function datesOverlap(aCheckin, aCheckout, bCheckin, bCheckout) {
    return aCheckin < bCheckout && bCheckin < aCheckout;
  }

  function getDormSlotMapForDate(bookings, dateISO) {
    const map = {};
    const conflicts = [];
    for (const bk of bookings) {
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

    for (const b of bookings) {
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

    const totalAmount = parseVND(obj.totalAmount);
    const paidAmount = parseVND(obj.paidAmount);
    const payErr = validatePaymentAmounts(totalAmount, paidAmount);
    if (payErr) {
      return { ok: false, error: payErr };
    }

    const includeVat = Boolean(obj.includeVat);
    const vatRate = includeVat ? 8 : 0;
    let preVatAmount = totalAmount;
    let vatAmount = 0;
    if (includeVat) {
      const hasExplicitPreVat = obj.preVatAmount !== undefined && obj.preVatAmount !== null && String(obj.preVatAmount).trim() !== "";
      const parsedPre = hasExplicitPreVat ? parseVND(obj.preVatAmount) : extractPreVatFromTotal(totalAmount).preVatAmount;
      preVatAmount = Math.min(totalAmount, parsedPre);
      vatAmount = Math.max(0, totalAmount - preVatAmount);
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

    const paymentStatus = totalAmount === 0
      ? (room.isDorm || obj.paymentStatus === "paid" ? "paid" : "unpaid")
      : (paidAmount >= totalAmount ? "paid" : paidAmount > 0 ? "deposit" : "unpaid");

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

    const record = {
      id,
      roomId: room.id,
      checkin,
      checkout,
      channelKey,
      sourceName,
      tourName,
      bookingCode,
      guestName,
      phone: sanitizeText(obj.phone, 40),
      guestCount,
      dormBeds,
      slots: room.isDorm ? slots : undefined,
      totalAmount,
      includeVat,
      vatRate,
      preVatAmount,
      vatAmount,
      paidAmount,
      paymentStatus,
      mergeBed,
      extraBed,
      confirmedBy: sanitizeText(obj.confirmedBy, 60),
      confirmationPdf,
      notes: sanitizeText(obj.notes, 2000),
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

      const payErr = validatePaymentAmounts(bk.totalAmount, bk.paidAmount);
      if (payErr) {
        errors.push(`Bản ghi ${bk.id} (P.${room.name}): ${payErr}`);
      }

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
  // Propagates all shared group info (bookingCode, channel/source/tour, guestName, phone, confirmedBy,
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

    const issueDateISO = isValidISODate(options.issueDateISO) ? options.issueDateISO : getTodayISO();
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
      "Phòng", "Tầng", "Hạng phòng", "View", "Ngày nhận", "Ngày trả", "Số đêm",
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
          r.name, r.floor, r.type, r.view, b.checkin, b.checkout, diffNights(b.checkin, b.checkout),
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
      const validated = validateAndSanitizeImport(rawPayload);
      if (!validated.ok) return { ok: false, code: "INVALID_IMPORT", error: validated.error, details: validated.details };

      const rawState = readRawState();
      if (!rawState.ok && rawState.code === "STORAGE_READ_FAILED") {
        return { ok: false, code: "STORAGE_READ_FAILED", error: rawState.error + " Không thể khôi phục khi bộ nhớ không đọc được." };
      }
      if (!rawState.ok && rawState.code === "STORAGE_CORRUPTED") {
        quarantineRawCorrupt(rawState.raw, "Trước khi khôi phục JSON thủ công");
      }

      const previousList = rawState.ok && rawState.exists ? rawState.list.slice() : null;
      const expectedSnap = rawState.ok ? { raw: rawState.raw, metaRaw: rawState.metaRaw, storeVersion: rawState.storeVersion } : null;
      const persistRes = persistListCAS(validated.bookings, previousList, expectedSnap, (list) => list.length === validated.bookings.length);
      if (!persistRes.ok) return { ok: false, code: persistRes.code, error: persistRes.error };

      const summary = `Khôi phục ${validated.bookings.length} lượt đặt phòng từ file JSON.`;
      const snapshotId = recordAutoBackup("RESTORE", summary, validated.bookings);
      appendAudit({ action: "RESTORE", snapshotId, summary });

      return { ok: true, bookings: validated.bookings, snapshotId };
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

    return {
      load,
      refreshLatest,
      getBookings,
      getAuditLogs,
      getAutoBackups,
      hasRollbackBackup,
      getStorageStatus,
      saveBooking,
      deleteBooking,
      restoreFromImport,
      restoreFromAutoBackup,
      rollbackLastChange,
      resetToSample,
      runHealthCheck
    };
  }

  return {
    STORAGE_KEY,
    BACKUP_KEY,
    AUTOBACKUP_KEY,
    AUDIT_KEY,
    META_KEY,
    QUARANTINE_KEY,
    LOCK_KEY,
    MAX_AUTOBACKUPS,
    MAX_CONFIRMATION_PDF_BYTES,
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
    getTodayISO,
    addDaysISO,
    diffNights,
    formatDateVN,
    getDaysInMonth,
    parseVND,
    formatVND,
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
    generateCsvContent,
    diffBookingChanges,
    generateAuditCsvContent,
    createSampleBookings,
    runWithCrossTabLock,
    createBookingStore
  };
});
