/* ==========================================================================
   Dongvan Ville du H'mong Hotel PMS v2.5.0 — TA Contracts & Agency AR Engine
   Pure deterministic UMD module (zero DOM, integer VND exact, Asia/Ho_Chi_Minh).
   Reference: Hợp đồng Lữ hành năm 2027 (gửi các TA), Mục I–V.
   ========================================================================== */

(function (root) {
  "use strict";

  const TZ = "Asia/Ho_Chi_Minh";
  const HOLIDAY_SURCHARGE_VND = 150000;
  const EXTRA_BED_VND = 350000;
  const CHILD_6_10_VND = 250000;
  const INTERNAL_DORM_VND = 150000;
  const INTERNAL_ROOM_PCT = 70;
  const CREDIT_TERM_DAYS = 15;
  const ROSTER_LEAD_DAYS = 7;
  const DEFAULT_VAT_PCT = 8;
  const LATE_INTEREST_MONTHLY_PCT = 1.5;

  // 7 room categories mapped 1-to-1 to the 26 physical hotel rooms (Mục I, Hợp đồng 2027)
  const ROOM_CATEGORIES_2027 = Object.freeze([
    Object.freeze({
      code: "twin_balcony",
      label: "Twin balcony",
      contractLabel: "Twin room balcony",
      viewGroup: "Ban công view Thung lũng",
      roomCount: 3,
      maxGuests: 2,
      areaM2: 32,
      bedDesc: "2 giường 1m3",
      roomIds: Object.freeze(["203", "303", "403"]),
      rates: Object.freeze({ A_thu_sat: 990000, A_sun_wed: 900000, B_thu_sat: 790000, B_sun_wed: 690000 })
    }),
    Object.freeze({
      code: "double_balcony",
      label: "Double balcony",
      contractLabel: "Double room balcony",
      viewGroup: "Ban công view Thung lũng",
      roomCount: 7,
      maxGuests: 2,
      areaM2: 32,
      bedDesc: "1 giường 1m9",
      roomIds: Object.freeze(["101", "107", "207", "307", "401", "405", "407"]),
      rates: Object.freeze({ A_thu_sat: 990000, A_sun_wed: 900000, B_thu_sat: 790000, B_sun_wed: 690000 })
    }),
    Object.freeze({
      code: "family_balcony",
      label: "Family balcony",
      contractLabel: "Family room balcony",
      viewGroup: "Ban công view Thung lũng",
      roomCount: 4,
      maxGuests: 3,
      areaM2: 35,
      bedDesc: "1 giường 1m7 + 1 giường 1m2",
      roomIds: Object.freeze(["201", "205", "301", "305"]),
      rates: Object.freeze({ A_thu_sat: 1250000, A_sun_wed: 1150000, B_thu_sat: 1050000, B_sun_wed: 950000 })
    }),
    Object.freeze({
      code: "twin_garden",
      label: "Twin garden",
      contractLabel: "Twin room garden view",
      viewGroup: "Vách kính view vườn, núi đá",
      roomCount: 7,
      maxGuests: 2,
      areaM2: 32,
      bedDesc: "2 giường 1m3",
      roomIds: Object.freeze(["102", "104", "106", "202", "206", "402", "406"]),
      rates: Object.freeze({ A_thu_sat: 900000, A_sun_wed: 850000, B_thu_sat: 750000, B_sun_wed: 650000 })
    }),
    Object.freeze({
      code: "double_garden",
      label: "Double garden",
      contractLabel: "Double room garden view",
      viewGroup: "Vách kính view vườn, núi đá",
      roomCount: 2,
      maxGuests: 2,
      areaM2: 32,
      bedDesc: "1 giường 1m7",
      roomIds: Object.freeze(["302", "306"]),
      rates: Object.freeze({ A_thu_sat: 900000, A_sun_wed: 850000, B_thu_sat: 750000, B_sun_wed: 650000 })
    }),
    Object.freeze({
      code: "family_garden",
      label: "Family garden",
      contractLabel: "Family room garden view",
      viewGroup: "Vách kính view vườn, núi đá",
      roomCount: 1,
      maxGuests: 3,
      areaM2: 35,
      bedDesc: "1 giường 1m7 + 1 giường 1m2",
      roomIds: Object.freeze(["404"]),
      rates: Object.freeze({ A_thu_sat: 1150000, A_sun_wed: 1050000, B_thu_sat: 950000, B_sun_wed: 850000 })
    }),
    Object.freeze({
      code: "triple_garden",
      label: "Triple garden",
      contractLabel: "Triple room garden view",
      viewGroup: "Vách kính view vườn, núi đá",
      roomCount: 2,
      maxGuests: 3,
      areaM2: 35,
      bedDesc: "3 giường 1m2",
      roomIds: Object.freeze(["204", "304"]),
      rates: Object.freeze({ A_thu_sat: 1150000, A_sun_wed: 1050000, B_thu_sat: 950000, B_sun_wed: 850000 })
    })
  ]);

  const CATEGORY_BY_CODE = new Map(ROOM_CATEGORIES_2027.map((c) => [c.code, c]));
  const CATEGORY_BY_ROOM = new Map();
  for (const cat of ROOM_CATEGORIES_2027) {
    for (const rid of cat.roomIds) CATEGORY_BY_ROOM.set(rid, cat.code);
  }

  function isValidISO(d) {
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const t = new Date(d + "T00:00:00Z");
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  }

  function addDays(iso, delta) {
    if (!isValidISO(iso)) throw new Error("Ngày không hợp lệ: " + iso);
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + Number(delta || 0));
    return d.toISOString().slice(0, 10);
  }

  function diffDays(fromIso, toIso) {
    if (!isValidISO(fromIso) || !isValidISO(toIso)) throw new Error("Ngày không hợp lệ");
    return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86400000);
  }

  function listNights(checkin, checkout) {
    if (!isValidISO(checkin) || !isValidISO(checkout)) throw new Error("Ngày nhận/trả phòng không hợp lệ");
    const n = diffDays(checkin, checkout);
    if (n <= 0) throw new Error("Ngày trả phòng phải sau ngày nhận phòng");
    const out = [];
    for (let i = 0; i < n; i++) out.push(addDays(checkin, i));
    return out;
  }

  function getVietnamTodayISO(nowDate) {
    const dt = nowDate instanceof Date ? nowDate : new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    });
    return fmt.format(dt);
  }

  function roundVnd(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num);
  }

  // Exact integer allocation conserving sum to the last đồng
  function allocateProportional(totalAmount, weights) {
    const total = roundVnd(totalAmount);
    if (!Array.isArray(weights) || weights.length === 0) return [];
    const sumW = weights.reduce((s, w) => s + Math.max(0, Number(w) || 0), 0);
    if (sumW <= 0) {
      return weights.map((_, idx) => Math.round((total * (idx + 1)) / weights.length) - Math.round((total * idx) / weights.length));
    }
    let accW = 0;
    let prevAllocated = 0;
    return weights.map((w) => {
      accW += Math.max(0, Number(w) || 0);
      const nextAllocated = Math.round((total * accW) / sumW);
      const part = nextAllocated - prevAllocated;
      prevAllocated = nextAllocated;
      return part;
    });
  }

  function auditRoomCategoryMapping(roomsList) {
    const list = Array.isArray(roomsList) ? roomsList : [];
    const physical = list.filter((r) => r && r.id !== "DORM").map((r) => String(r.id));
    const seen = new Map();
    const duplicates = [];
    const unmapped = [];
    const countMismatches = [];

    for (const cat of ROOM_CATEGORIES_2027) {
      if (cat.roomIds.length !== cat.roomCount) {
        countMismatches.push({ code: cat.code, expected: cat.roomCount, actual: cat.roomIds.length });
      }
      for (const rid of cat.roomIds) {
        if (seen.has(rid)) duplicates.push({ roomId: rid, categories: [seen.get(rid), cat.code] });
        seen.set(rid, cat.code);
      }
    }
    for (const rid of physical) {
      if (!seen.has(rid)) unmapped.push(rid);
    }
    const extraInMapping = physical.length > 0 ? [...seen.keys()].filter((rid) => !physical.includes(rid)) : [];
    return {
      ok: duplicates.length === 0 && unmapped.length === 0 && extraInMapping.length === 0 && countMismatches.length === 0 && seen.size === 26,
      totalMappedRooms: seen.size,
      categoryCount: ROOM_CATEGORIES_2027.length,
      duplicates,
      unmapped,
      extraInMapping,
      countMismatches
    };
  }

  function defaultContract2027(overrides) {
    const o = overrides && typeof overrides === "object" ? overrides : {};
    const rates = {};
    for (const c of ROOM_CATEGORIES_2027) rates[c.code] = { ...c.rates };
    return {
      id: o.id || "CTR-2027-V1",
      agencyCode: o.agencyCode || "",
      versionNo: o.versionNo || 1,
      title: o.title || "Hợp đồng Lữ hành năm 2027 (Mục I–V)",
      effectiveFrom: o.effectiveFrom || "2027-01-01",
      effectiveTo: o.effectiveTo || "2027-12-31",
      status: o.status || "approved",
      approvedBy: o.approvedBy || "Giám đốc Trịnh Thị Lan Anh",
      approvedAt: o.approvedAt || "2026-11-26T00:00:00Z",
      vatIncluded: true,
      vatRatePct: DEFAULT_VAT_PCT,
      breakfastBuffetIncluded: true,
      commissionable: false,
      bankAccount: {
        bankName: "BIDV",
        accountNo: "8695558888",
        accountHolder: "CÔNG TY CỔ PHẦN PHÁT TRIỂN ĐẦU TƯ ABT VIỆT NAM",
        bankFeeBearer: "agency"
      },
      rates: o.rates ? { ...rates, ...o.rates } : rates,
      retailRates: o.retailRates || {},
      calendars: {
        // 3 explicitly separated manager-approved calendars
        holidaySurchargeDates: Array.isArray(o.calendars?.holidaySurchargeDates) ? [...o.calendars.holidaySurchargeDates] : [],
        holidayDepositDates: Array.isArray(o.calendars?.holidayDepositDates) ? [...o.calendars.holidayDepositDates] : [],
        peakCancelDates: Array.isArray(o.calendars?.peakCancelDates) ? [...o.calendars.peakCancelDates] : []
      },
      addenda: Array.isArray(o.addenda) ? o.addenda : [],
      clauseDecisions: o.clauseDecisions && typeof o.clauseDecisions === "object" ? { ...o.clauseDecisions } : {},
      docs: Array.isArray(o.docs) ? o.docs : []
    };
  }

  function classifySeason(isoDate) {
    const mmdd = isoDate.slice(5, 10);
    return (mmdd >= "05-15" && mmdd <= "08-28") ? "B" : "A";
  }

  function isThuFriSat(isoDate) {
    const dow = new Date(isoDate + "T00:00:00Z").getUTCDay();
    return dow === 4 || dow === 5 || dow === 6;
  }

  function priceNight(contract, categoryCode, isoDate, opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const cat = CATEGORY_BY_CODE.get(categoryCode);
    if (!cat) throw new Error("Hạng phòng không hợp lệ: " + categoryCode);
    const ctr = contract || defaultContract2027();
    const effFrom = ctr.effectiveFrom || "2027-01-01";
    const effTo = ctr.effectiveTo || "2027-12-31";
    const season = classifySeason(isoDate);
    const highDay = isThuFriSat(isoDate);
    const band = highDay ? "thu_sat" : "sun_wed";
    const rateKey = `${season}_${band}`;

    if (options.useRetailRate) {
      const retail = Number(ctr.retailRates?.[categoryCode] ?? options.retailRate ?? 0);
      if (!(retail > 0)) {
        return {
          day: isoDate,
          categoryCode,
          season,
          band,
          missingRate: true,
          missingReason: "Thiếu giá bán lẻ công bố cho đêm khách tự gia hạn / thanh toán cá nhân",
          baseRate: 0,
          holidaySurcharge: 0,
          unitRate: 0,
          vatIncluded: true,
          vatRatePct: DEFAULT_VAT_PCT,
          breakfastBuffetIncluded: true,
          commissionable: false,
          basis: "Chờ bổ sung giá bán lẻ công bố"
        };
      }
      return {
        day: isoDate,
        categoryCode,
        season,
        band,
        missingRate: false,
        baseRate: roundVnd(retail),
        holidaySurcharge: 0,
        unitRate: roundVnd(retail),
        vatIncluded: true,
        vatRatePct: DEFAULT_VAT_PCT,
        breakfastBuffetIncluded: true,
        commissionable: false,
        basis: "Giá bán lẻ công bố (khách tự gia hạn / thanh toán cá nhân — Mục II.2 & IV.1)"
      };
    }

    if (isoDate < effFrom || isoDate > effTo) {
      return {
        day: isoDate,
        categoryCode,
        season,
        band,
        missingRate: true,
        missingReason: `Đêm ${isoDate} nằm ngoài thời hạn hiệu lực hợp đồng (${effFrom} → ${effTo})`,
        baseRate: 0,
        holidaySurcharge: 0,
        unitRate: 0,
        vatIncluded: true,
        vatRatePct: DEFAULT_VAT_PCT,
        breakfastBuffetIncluded: true,
        commissionable: false,
        basis: `Ngoài hiệu lực hợp đồng (${effFrom} → ${effTo}) — cần bổ sung bảng giá`
      };
    }

    const catRates = ctr.rates?.[categoryCode] || cat.rates;
    const contractBase = roundVnd(catRates[rateKey]);
    if (!(contractBase > 0)) {
      return {
        day: isoDate,
        categoryCode,
        season,
        band,
        missingRate: true,
        missingReason: `Thiếu đơn giá hợp đồng cho ${cat.label} (${rateKey})`,
        baseRate: 0,
        holidaySurcharge: 0,
        unitRate: 0,
        vatIncluded: true,
        vatRatePct: DEFAULT_VAT_PCT,
        breakfastBuffetIncluded: true,
        commissionable: false,
        basis: "Thiếu đơn giá hợp đồng"
      };
    }

    // Check manager-approved written promo addendum covering this date & category
    let appliedBase = contractBase;
    let appliedAddendum = null;
    const addenda = Array.isArray(ctr.addenda) ? ctr.addenda : [];
    for (const ad of addenda) {
      if (ad.status !== "approved") continue;
      if (isoDate >= ad.effectiveFrom && isoDate <= ad.effectiveTo) {
        const overrideVal = ad.rates?.[categoryCode]?.[rateKey] ?? ad.flatRates?.[categoryCode];
        if (Number(overrideVal) > 0) {
          appliedBase = roundVnd(overrideVal);
          appliedAddendum = ad;
        }
      }
    }

    const holDates = new Set(ctr.calendars?.holidaySurchargeDates || []);
    const isHolidaySurcharge = holDates.has(isoDate);
    const holidaySurcharge = isHolidaySurcharge ? HOLIDAY_SURCHARGE_VND : 0;

    let unitRate = appliedBase + holidaySurcharge;
    let basis = `HĐ ${ctr.id} v${ctr.versionNo || 1} • Biểu ${season} (${highDay ? "T5–T7" : "CN–T4"}): ${appliedBase.toLocaleString("vi-VN")} đ`;
    if (appliedAddendum) basis += ` [Ưu đãi ${appliedAddendum.id}]`;
    if (isHolidaySurcharge) basis += ` + Phụ thu lễ ${HOLIDAY_SURCHARGE_VND.toLocaleString("vi-VN")} đ`;
    if (options.isInternalRoom) {
      const beforeInt = unitRate;
      unitRate = roundVnd((beforeInt * INTERNAL_ROOM_PCT) / 100);
      basis = `Phòng nội bộ (${INTERNAL_ROOM_PCT}% × ${beforeInt.toLocaleString("vi-VN")} đ = ${unitRate.toLocaleString("vi-VN")} đ — Mục II.4.3)`;
    }
    basis += " • Đã gồm VAT 8% & buffet sáng, không hoa hồng";

    return {
      day: isoDate,
      categoryCode,
      season,
      band,
      rateKey,
      missingRate: false,
      contractBase,
      baseRate: appliedBase,
      addendumId: appliedAddendum ? appliedAddendum.id : null,
      isHolidaySurcharge,
      holidaySurcharge,
      unitRate,
      vatIncluded: true,
      vatRatePct: DEFAULT_VAT_PCT,
      breakfastBuffetIncluded: true,
      commissionable: false,
      basis
    };
  }

  function evaluateSpecialItems(items, contract) {
    const ctr = contract || defaultContract2027();
    const decisions = ctr.clauseDecisions || {};
    const lines = [];
    const pendingApprovals = [];

    for (const raw of (Array.isArray(items) ? items : [])) {
      const qty = Math.max(1, roundVnd(raw.qty || 1));
      const nights = Math.max(1, roundVnd(raw.nights || 1));
      const payer = raw.payer === "guest" ? "guest" : "agency";

      if (raw.kind === "internal_dorm") {
        const amount = INTERNAL_DORM_VND * qty * nights;
        lines.push({
          ...raw, qty, nights, payer, unitRate: INTERNAL_DORM_VND, amount, paused: false,
          basis: `Dorm nội bộ (ngủ + ăn sáng): ${INTERNAL_DORM_VND.toLocaleString("vi-VN")} đ/người/đêm (Mục II.4.3)`
        });
      } else if (raw.kind === "extra_bed") {
        const roomQty = Math.max(1, roundVnd(raw.roomQty || 1));
        if (qty > roomQty) {
          pendingApprovals.push({
            code: "extra_bed_limit_exceeded",
            lineId: raw.id || "extra_bed",
            reason: `Mỗi phòng chỉ kê tối đa 1 giường phụ (yêu cầu ${qty} giường cho ${roomQty} phòng — Mục II.4.2)`
          });
        }
        const amount = EXTRA_BED_VND * qty * nights;
        lines.push({
          ...raw, qty, nights, payer, unitRate: EXTRA_BED_VND, amount, paused: qty > roomQty,
          basis: `Giường phụ (extra bed, tối đa 1/phòng): ${EXTRA_BED_VND.toLocaleString("vi-VN")} đ/đêm (Mục II.4.2)`
        });
      } else if (raw.kind === "child") {
        const age = Number(raw.age);
        if (age === 5 && !decisions.child_age_5) {
          pendingApprovals.push({
            code: "child_age_5_conflict",
            status: "Chờ quản lý duyệt",
            lineId: raw.id || "child_5",
            reason: "Chờ quản lý duyệt — Trẻ đúng 5 tuổi: Mục II.4.1 có mâu thuẫn giữa 'dưới 6 tuổi' và 'từ 5–10 tuổi'"
          });
          lines.push({
            ...raw, qty, nights, payer, unitRate: 0, amount: 0, paused: true, approvalStatus: "Chờ quản lý duyệt",
            basis: "Chờ quản lý duyệt (trẻ đúng 5 tuổi — Mục II.4.1)"
          });
        } else if (age === 5 && decisions.child_age_5) {
          const decidedRate = roundVnd(decisions.child_age_5.unitRate ?? 0);
          lines.push({
            ...raw, qty, nights, payer, unitRate: decidedRate, amount: decidedRate * qty * nights, paused: false,
            basis: `Trẻ 5 tuổi theo quyết định duyệt ${decisions.child_age_5.approvedBy || "Quản lý"} (${decisions.child_age_5.effectiveFrom || ""}): ${decidedRate.toLocaleString("vi-VN")} đ/đêm`
          });
        } else if (age < 5) {
          lines.push({
            ...raw, qty, nights, payer, unitRate: 0, amount: 0, paused: false,
            basis: "Trẻ dưới 5 tuổi ngủ ghép & ăn sáng cùng bố mẹ (tối đa 1 trẻ/phòng): Miễn phí (Mục II.4.1)"
          });
        } else if (age <= 10) {
          lines.push({
            ...raw, qty, nights, payer, unitRate: CHILD_6_10_VND, amount: CHILD_6_10_VND * qty * nights, paused: false,
            basis: `Trẻ em ${age} tuổi (ngủ ghép không kê giường phụ, tối đa 1/phòng): ${CHILD_6_10_VND.toLocaleString("vi-VN")} đ/đêm (Mục II.4.1)`
          });
        } else {
          lines.push({
            ...raw, qty, nights, payer, unitRate: EXTRA_BED_VND, amount: EXTRA_BED_VND * qty * nights, paused: false,
            basis: `Trẻ ${age} tuổi (từ 11 tuổi trở lên tính như người lớn, kê extra bed): ${EXTRA_BED_VND.toLocaleString("vi-VN")} đ/đêm (Mục II.4.1)`
          });
        }
      } else if (raw.kind === "third_adult_no_bed") {
        if (!decisions.third_adult_no_bed) {
          pendingApprovals.push({
            code: "third_adult_no_bed_3000000",
            status: "Chờ quản lý duyệt",
            lineId: raw.id || "third_adult",
            reason: "Chờ quản lý duyệt — Phụ thu người thứ 3 không kê giường phụ: hợp đồng ghi '3000.000 VND/đêm'"
          });
          lines.push({
            ...raw, qty, nights, payer, unitRate: 0, amount: 0, paused: true, approvalStatus: "Chờ quản lý duyệt",
            basis: "Chờ quản lý duyệt (người thứ 3 không kê giường — Mục II.4.2)"
          });
        } else {
          const decidedRate = roundVnd(decisions.third_adult_no_bed.unitRate);
          lines.push({
            ...raw, qty, nights, payer, unitRate: decidedRate, amount: decidedRate * qty * nights, paused: false,
            basis: `Người thứ 3 không kê giường theo duyệt ${decisions.third_adult_no_bed.approvedBy || "Quản lý"}: ${decidedRate.toLocaleString("vi-VN")} đ/đêm`
          });
        }
      } else if (raw.kind === "early_late_gap") {
        if (!decisions.checkin_checkout_gap_window) {
          pendingApprovals.push({
            code: "checkin_checkout_gap_window",
            status: "Chờ quản lý duyệt",
            lineId: raw.id || "early_late_gap",
            reason: "Chờ quản lý duyệt — Khung nhận phòng 13h–trước 14h hoặc trả phòng sau 12h–đến 14h chưa có mức phí rõ"
          });
          lines.push({
            ...raw, qty, nights, payer, unitRate: 0, amount: 0, paused: true, approvalStatus: "Chờ quản lý duyệt",
            basis: "Chờ quản lý duyệt (khung giờ 13h–14h / 12h–14h — Mục III.1)"
          });
        } else {
          const decidedRate = roundVnd(decisions.checkin_checkout_gap_window.unitRate);
          lines.push({
            ...raw, qty, nights, payer, unitRate: decidedRate, amount: decidedRate * qty, paused: false,
            basis: `Phí nhận sớm / trả muộn khung chuyển tiếp theo quyết định duyệt: ${decidedRate.toLocaleString("vi-VN")} đ`
          });
        }
      } else {
        const unitRate = roundVnd(raw.unitRate || 0);
        lines.push({
          ...raw, qty, nights, payer, unitRate, amount: unitRate * qty * nights, paused: false,
          basis: raw.basis || raw.name || "Dịch vụ bổ sung"
        });
      }
    }
    return { lines, pendingApprovals };
  }

  function computeDepositSchedule(params) {
    const {
      bookedDate, checkin, checkout, roomTotal,
      holidayDepositDates, approvedSchedule
    } = params;
    const total = roundVnd(roomTotal);
    const nights = listNights(checkin, checkout);
    const holSet = new Set(Array.isArray(holidayDepositDates) ? holidayDepositDates : []);
    const holidayNights = nights.filter((d) => holSet.has(d));
    const normalNights = nights.filter((d) => !holSet.has(d));
    const isHolidayAll = holidayNights.length === nights.length;
    const isMixed = holidayNights.length > 0 && normalNights.length > 0;

    const deposit50 = Math.round(total / 2);
    const balance50 = total - deposit50;
    const approvalReasons = [];

    let m1Due = isHolidayAll ? bookedDate : addDays(bookedDate, 3);
    let m2Due = isHolidayAll ? addDays(checkin, -5) : addDays(checkin, -3);

    if (isMixed) {
      approvalReasons.push({
        code: "mixed_holiday_normal_deposit",
        reason: `Đoàn gồm cả ${holidayNights.length} đêm lễ/Tết và ${normalNights.length} đêm thường — cần quản lý duyệt lịch cọc`
      });
    }
    if (m2Due < m1Due) {
      approvalReasons.push({
        code: "short_lead_schedule_overlap",
        reason: `Đặt sát ngày (${bookedDate} → nhận phòng ${checkin}) khiến hạn tất toán (${m2Due}) đi trước hạn cọc (${m1Due}) — cần quản lý duyệt lịch thu`
      });
    }

    const defaultMilestones = [
      {
        code: "deposit_50",
        label: isHolidayAll ? "Đợt 1: Cọc 50% ngay khi đặt (Lễ/Tết)" : "Đợt 1: Cọc 50% sau 3 ngày từ ngày đặt",
        dueDate: m1Due,
        amount: deposit50
      },
      {
        code: "balance_50",
        label: isHolidayAll ? "Đợt 2: 50% còn lại trước 5 ngày nhận phòng (Lễ/Tết)" : "Đợt 2: 50% còn lại trước 3 ngày nhận phòng",
        dueDate: m2Due,
        amount: balance50
      }
    ];

    const hasApprovedOverride = Boolean(approvedSchedule && Array.isArray(approvedSchedule.milestones) && approvedSchedule.milestones.length > 0);
    return {
      isHolidayDeposit: isHolidayAll,
      isMixedHolidayNormal: isMixed,
      needsManagerApproval: approvalReasons.length > 0 && !hasApprovedOverride,
      approvalReasons,
      milestones: hasApprovedOverride ? approvedSchedule.milestones : defaultMilestones,
      approvedOverride: hasApprovedOverride ? approvedSchedule : null,
      roomTotal: total,
      isScheduleExpectedOnly: true
    };
  }

  function quoteGroup(params) {
    const {
      contract, checkin, checkout, bookedDate,
      roomRequests, specialItems, approvedSchedule
    } = params;
    const ctr = contract || defaultContract2027();
    const nights = listNights(checkin, checkout);
    const roomBreakdown = [];
    const missingRateErrors = [];
    let roomTotal = 0;

    for (const req of (Array.isArray(roomRequests) ? roomRequests : [])) {
      const qty = Math.max(1, roundVnd(req.qty || 1));
      const cat = CATEGORY_BY_CODE.get(req.categoryCode);
      if (!cat) throw new Error("Hạng phòng không hợp lệ: " + req.categoryCode);
      const nightDetails = [];
      let lineTotal = 0;
      for (const day of nights) {
        const np = priceNight(ctr, req.categoryCode, day, {
          useRetailRate: Boolean(req.useRetailRate),
          retailRate: req.retailRate,
          isInternalRoom: Boolean(req.isInternalRoom)
        });
        if (np.missingRate) missingRateErrors.push({ categoryCode: req.categoryCode, day, reason: np.missingReason });
        const nightSubtotal = np.unitRate * qty;
        lineTotal += nightSubtotal;
        nightDetails.push({ ...np, qty, subtotal: nightSubtotal });
      }
      roomTotal += lineTotal;
      roomBreakdown.push({
        categoryCode: req.categoryCode,
        categoryLabel: cat.label,
        qty,
        payer: req.payer === "guest" ? "guest" : "agency",
        isInternalRoom: Boolean(req.isInternalRoom),
        useRetailRate: Boolean(req.useRetailRate),
        nightDetails,
        subtotal: lineTotal
      });
    }

    const specialEval = evaluateSpecialItems(specialItems, ctr);
    const agencySpecialTotal = specialEval.lines.filter((l) => l.payer === "agency" && !l.paused).reduce((s, l) => s + l.amount, 0);
    const guestSpecialTotal = specialEval.lines.filter((l) => l.payer === "guest" && !l.paused).reduce((s, l) => s + l.amount, 0);

    const depositSchedule = computeDepositSchedule({
      bookedDate: bookedDate || getVietnamTodayISO(),
      checkin,
      checkout,
      roomTotal,
      holidayDepositDates: ctr.calendars?.holidayDepositDates || [],
      approvedSchedule
    });

    const rosterDueDate = addDays(checkin, -ROSTER_LEAD_DAYS);
    const needsRateCompletion = missingRateErrors.length > 0;
    const allApprovals = [
      ...specialEval.pendingApprovals,
      ...(depositSchedule.needsManagerApproval ? depositSchedule.approvalReasons : [])
    ];

    return {
      contractId: ctr.id,
      contractVersion: ctr.versionNo || 1,
      checkin,
      checkout,
      nightsCount: nights.length,
      nights,
      roomBreakdown,
      roomTotal,
      specialLines: specialEval.lines,
      agencySpecialTotal,
      guestSpecialTotal,
      agencyTotal: roomTotal + agencySpecialTotal,
      guestTotal: guestSpecialTotal,
      grandTotal: roomTotal + agencySpecialTotal + guestSpecialTotal,
      depositSchedule,
      rosterDueDate,
      vatIncluded: true,
      vatRatePct: DEFAULT_VAT_PCT,
      breakfastBuffetIncluded: true,
      commissionable: false,
      needsRateCompletion,
      missingRateErrors,
      pendingApprovals: allApprovals,
      quoteStatus: needsRateCompletion ? "needs_rate_completion" : (allApprovals.length > 0 ? "pending_manager_approval" : "ready_to_confirm")
    };
  }

  function previewPromoAddendumImpact(groups, contract, addendum) {
    const impacted = [];
    const testContract = {
      ...contract,
      addenda: [...(contract.addenda || []), { ...addendum, status: "approved" }]
    };
    for (const g of (Array.isArray(groups) ? groups : [])) {
      if (g.contractId !== contract.id || !["confirmed", "held", "quoted"].includes(g.status)) continue;
      const oldNights = [];
      let oldTotal = 0;
      let newTotal = 0;
      const changedNights = [];
      for (const rl of (g.roomLines || [])) {
        for (const day of listNights(g.checkin, g.checkout)) {
          const pOld = priceNight(contract, rl.categoryCode, day, { isInternalRoom: rl.isInternalRoom });
          const pNew = priceNight(testContract, rl.categoryCode, day, { isInternalRoom: rl.isInternalRoom });
          const q = Math.max(1, roundVnd(rl.qty || 1));
          oldTotal += pOld.unitRate * q;
          newTotal += pNew.unitRate * q;
          if (pOld.unitRate !== pNew.unitRate) {
            changedNights.push({
              day, categoryCode: rl.categoryCode, qty: q,
              oldRate: pOld.unitRate, newRate: pNew.unitRate,
              diff: (pNew.unitRate - pOld.unitRate) * q
            });
          }
          oldNights.push(day);
        }
      }
      if (changedNights.length > 0) {
        impacted.push({
          groupId: g.id,
          groupCode: g.groupCode,
          status: g.status,
          changedNights,
          oldTotal,
          newTotal,
          diff: newTotal - oldTotal,
          requiresAdjustmentVoucher: g.status === "confirmed"
        });
      }
    }
    return impacted;
  }

  function checkResaleCap(resalePrice, publishedPrice) {
    const resale = Number(resalePrice);
    const pub = Number(publishedPrice);
    if (!(resale > 0 && pub > 0)) return { applicable: false, exceeded: false, maxAllowed: null };
    const maxAllowed = Math.round(pub * 1.3);
    return {
      applicable: true,
      exceeded: resale > maxAllowed,
      resalePrice: roundVnd(resale),
      publishedPrice: roundVnd(pub),
      maxAllowed,
      excess: Math.max(0, roundVnd(resale) - maxAllowed)
    };
  }

  function previewCancellation(params) {
    const {
      checkin, checkout, cancelDate, peakCancelDates,
      reducedRoomNights, reducedRoomAmount, reducedServiceAmount,
      isPartial, clauseDecisions
    } = params;
    const nights = isValidISO(checkin) && isValidISO(checkout) ? listNights(checkin, checkout) : [checkin];
    const peakSet = new Set(Array.isArray(peakCancelDates) ? peakCancelDates : []);
    const isPeak = nights.some((d) => peakSet.has(d));
    const daysBefore = diffDays(cancelDate, checkin);
    const decisions = clauseDecisions || {};
    const approvalReasons = [];
    let feePct = 0;

    if (isPeak) {
      if (daysBefore > 40) feePct = 0;
      else if (daysBefore > 20) feePct = 50;
      else if (daysBefore === 20) {
        if (decisions.cancel_boundary_20d) {
          feePct = Number(decisions.cancel_boundary_20d.feePct);
        } else {
          feePct = 50;
          approvalReasons.push({
            code: "cancel_boundary_20d",
            status: "Chờ quản lý duyệt",
            reason: "Chờ quản lý duyệt — Hủy đúng mốc 20 ngày trước nhận phòng (lịch Lễ/Tết/cao điểm: chồng lấn '20–40 ngày' 50% và 'trong vòng 20 ngày' 100%)"
          });
        }
      } else {
        feePct = 100;
      }
    } else {
      if (daysBefore > 30) feePct = 0;
      else if (daysBefore > 10) feePct = 50;
      else if (daysBefore === 10) {
        if (decisions.cancel_boundary_10d) {
          feePct = Number(decisions.cancel_boundary_10d.feePct);
        } else {
          feePct = 50;
          approvalReasons.push({
            code: "cancel_boundary_10d",
            status: "Chờ quản lý duyệt",
            reason: "Chờ quản lý duyệt — Hủy đúng mốc 10 ngày trước nhận phòng (lịch ngày thường: chồng lấn '10–30 ngày' 50% và 'trong vòng 10 ngày' 100%)"
          });
        }
      } else {
        feePct = 100;
      }
    }

    if (isPartial) {
      approvalReasons.push({
        code: "partial_cancel_base_decision",
        status: "Chờ quản lý duyệt",
        reason: "Chờ quản lý duyệt — Hủy một phần phòng/đêm: cần quản lý xác nhận cơ sở tính phí hủy trên phần giảm và chứng từ văn bản"
      });
    }

    const baseRoom = roundVnd(reducedRoomAmount || 0);
    const reducedSvc = roundVnd(reducedServiceAmount || 0);
    const estimatedCancelFee = roundVnd((baseRoom * feePct) / 100);
    const netReceivableDelta = -(baseRoom + reducedSvc) + estimatedCancelFee;

    return {
      isPeak,
      daysBefore,
      feePct,
      releasedRoomNights: Math.max(0, roundVnd(reducedRoomNights || 0)),
      reducedRoomAmount: baseRoom,
      reducedServiceAmount: reducedSvc,
      estimatedCancelFee,
      netReceivableDelta,
      needsManagerApproval: approvalReasons.length > 0,
      approvalStatus: approvalReasons.length > 0 ? "Chờ quản lý duyệt" : "Tự động",
      approvalReasons
    };
  }

  function computeInvoiceDue(inv, asOfDate) {
    const asOf = asOfDate || getVietnamTodayISO();
    const creditDays = Math.max(1, roundVnd(inv.creditDays || CREDIT_TERM_DAYS));
    if (!inv.receivedDate || !isValidISO(inv.receivedDate)) {
      return {
        status: "awaiting_invoice_receipt",
        label: "Chờ xác minh ngày nhận hóa đơn",
        dueDate: null,
        overdueDays: 0,
        bucket: "unknown_due"
      };
    }
    const dueDate = addDays(inv.receivedDate, creditDays);
    if (asOf > dueDate) {
      const overdueDays = diffDays(dueDate, asOf);
      const bucket = overdueDays <= 7 ? "overdue_1_7" : (overdueDays <= 30 ? "overdue_8_30" : "overdue_30_plus");
      return { status: "overdue", label: `Quá hạn ${overdueDays} ngày`, dueDate, overdueDays, bucket };
    }
    if (asOf === dueDate) {
      return { status: "due_today", label: "Đến hạn hôm nay", dueDate, overdueDays: 0, bucket: "due_today" };
    }
    return { status: "not_due", label: `Chưa đến hạn (hạn ${dueDate})`, dueDate, overdueDays: 0, bucket: "not_due" };
  }

  // Informational preview ONLY — never auto-posted to AR until policy rules are approved
  function estimateLateInterest(openAmount, overdueDays) {
    const amt = Math.max(0, roundVnd(openAmount));
    const days = Math.max(0, roundVnd(overdueDays));
    const previewAmount = days > 0 ? roundVnd((amt * (LATE_INTEREST_MONTHLY_PCT / 100) * days) / 30) : 0;
    return {
      rateMonthlyPct: LATE_INTEREST_MONTHLY_PCT,
      openAmount: amt,
      overdueDays: days,
      previewAmount,
      postedToAr: false,
      approvalStatus: "Chờ quản lý duyệt",
      note: "Chờ quản lý duyệt — Dự tính tham khảo (1,5%/tháng ÷ 30 ngày), chưa hạch toán tự động cho tới khi duyệt quy tắc tháng lẻ & làm tròn"
    };
  }

  function computeReceiptBalances(allocations, financeState, asOfDate) {
    const asOf = asOfDate || "9999-12-31";
    const txs = Array.isArray(financeState?.transactions) ? financeState.transactions : [];
    const activeAllocs = (Array.isArray(allocations) ? allocations : []).filter((a) => (a.effectiveDay || a.effective_day || "0000-01-01") <= asOf);

    const bySource = new Map();
    for (const tx of txs) {
      if (tx.status === "voided" || tx.txType !== "customer_payment") continue;
      if ((tx.businessDate || "") > asOf) continue;
      const agencyCode = tx.agencyCode || tx.meta?.agencyCode || "";
      if (!agencyCode) continue;
      bySource.set(tx.id, {
        sourceTxId: tx.id,
        agencyCode,
        businessDate: tx.businessDate,
        fundId: tx.fundId,
        amount: roundVnd(tx.amount),
        expectedAmount: roundVnd(tx.expectedAmount || tx.amount),
        bankFeeShortfall: Math.max(0, roundVnd((tx.expectedAmount || tx.amount) - tx.amount)),
        allocated: 0,
        reversed: 0,
        bankFeeResolved: 0,
        lines: []
      });
    }

    for (const a of activeAllocs) {
      const srcId = a.sourceTxId || a.source_tx_id;
      const rec = bySource.get(srcId);
      if (!rec) continue;
      const amt = roundVnd(a.amount);
      if (a.kind === "allocate") {
        rec.allocated += amt;
        rec.lines.push(a);
      } else if (a.kind === "reverse") {
        rec.allocated -= amt;
        rec.reversed += amt;
        rec.lines.push(a);
      } else if (a.kind === "bank_fee_resolve") {
        rec.bankFeeResolved += amt;
      }
    }

    const out = [];
    for (const r of bySource.values()) {
      const unallocated = r.amount - r.allocated;
      out.push({
        ...r,
        unallocated,
        unresolvedBankFee: Math.max(0, r.bankFeeShortfall - r.bankFeeResolved),
        conserved: r.allocated + unallocated === r.amount
      });
    }
    return out;
  }

  function computeAgencyLedger(params) {
    const {
      agency, groups, allocations, financeState,
      fromDate, toDate, asOfDate
    } = params;
    const asOf = asOfDate || toDate || getVietnamTodayISO();
    const from = fromDate || "2000-01-01";
    const to = toDate || asOf;
    const code = agency.code;

    const myGroups = (Array.isArray(groups) ? groups : []).filter((g) => g.agencyCode === code);
    const myAllocs = (Array.isArray(allocations) ? allocations : []).filter((a) => (a.agencyCode || a.agency_code) === code && (a.effectiveDay || a.effective_day || "0000-01-01") <= to);
    const receiptBalances = computeReceiptBalances(allocations, financeState, to).filter((r) => r.agencyCode === code);

    // Build single-obligation ledger per group (NEVER double-counting booking + deposit schedule + invoice!)
    let openingBalance = 0;
    let periodCharges = 0;
    let periodAdjPlus = 0;
    let periodAdjMinus = 0;
    let periodApplied = 0;
    let unappliedDeposit = 0;
    let unassignedCash = 0;
    let creditReserve = 0;
    let approvedRefundPending = 0;
    let totalBankFeeVariance = 0;

    const aging = {
      not_due: 0, due_today: 0, overdue_1_7: 0, overdue_8_30: 0, overdue_30_plus: 0, unknown_due: 0
    };
    const rows = [];
    const groupSummaries = [];

    // 1. Opening balances & agency-level reserve/refunds
    for (const a of myAllocs) {
      const day = a.effectiveDay || a.effective_day;
      const amt = roundVnd(a.amount);
      if (a.kind === "opening_balance") {
        if (day < from) openingBalance += amt;
        else {
          periodCharges += amt;
          rows.push({ day, kind: "opening_balance", ref: a.requestId || a.request_id, label: "Số dư chuyển tiếp đầu kỳ", debit: amt, credit: 0, detail: a.detail });
        }
      } else if (a.kind === "reserve_grant") {
        creditReserve += amt;
      } else if (a.kind === "reserve_use") {
        creditReserve -= amt;
      } else if (a.kind === "refund_approve") {
        approvedRefundPending += amt;
      } else if (a.kind === "refund_pay") {
        approvedRefundPending -= amt;
      }
    }

    // 2. Unassigned cash from receipts not yet allocated to any group
    for (const rb of receiptBalances) {
      unassignedCash += Math.max(0, rb.unallocated);
      totalBankFeeVariance += rb.unresolvedBankFee;
    }

    // 3. Per-group obligation & settlement calculation
    for (const g of myGroups) {
      if (["inquiry", "quoted"].includes(g.status)) continue;
      const gAllocs = myAllocs.filter((a) => (a.groupId || a.group_id) === g.id);
      const invoices = (Array.isArray(g.invoices) ? g.invoices : []).filter((inv) => inv.status !== "voided" && (inv.issueDate || g.checkin) <= to);
      const adjustments = (Array.isArray(g.adjustments) ? g.adjustments : []).filter((adj) => (adj.effectiveDate || adj.effective_date || to) <= to);

      // Determine agency-payer obligation ONCE:
      // If VAT/group invoices exist, use invoiced total; otherwise use confirmed agency-payer room + agency services (strictly excluding guest-payer lines like minibar!)
      const hasInvoices = invoices.length > 0;
      const billedAmount = invoices.reduce((s, inv) => s + roundVnd(inv.amount), 0);
      const agencyRoomTotal = roundVnd(g.pricingSnapshot?.roomTotal ?? g.roomTotal ?? 0);
      const agencyServiceTotal = (Array.isArray(g.serviceLines) ? g.serviceLines : [])
        .filter((s) => s.payer === "agency" && s.status !== "voided")
        .reduce((sum, s) => sum + roundVnd(s.amount), 0);
      const guestServiceTotal = (Array.isArray(g.serviceLines) ? g.serviceLines : [])
        .filter((s) => s.payer === "guest" && s.status !== "voided")
        .reduce((sum, s) => sum + roundVnd(s.amount), 0);

      const obligationDate = hasInvoices ? (invoices[0].issueDate || g.checkin) : (g.confirmedAt ? String(g.confirmedAt).slice(0, 10) : g.bookedDate || g.checkin);
      const baseObligation = hasInvoices ? billedAmount : (agencyRoomTotal + agencyServiceTotal);

      let adjNet = 0;
      for (const adj of adjustments) {
        const d = adj.effectiveDate || adj.effective_date || to;
        const val = roundVnd(adj.amount);
        adjNet += val;
        if (d < from) openingBalance += val;
        else {
          if (val >= 0) periodAdjPlus += val;
          else periodAdjMinus += Math.abs(val);
          rows.push({
            day: d, kind: "adjustment", ref: adj.code || adj.id, groupCode: g.groupCode,
            label: `Điều chỉnh ${adj.code || adj.id}: ${adj.reason || ""}`,
            debit: val > 0 ? val : 0, credit: val < 0 ? Math.abs(val) : 0,
            approvedBy: adj.approvedBy || "", effectivePeriod: adj.effectivePeriod || d.slice(0, 7)
          });
        }
      }

      // Applied payments & reserve uses for this group
      let groupAllocatedTotal = 0;
      let groupAppliedBeforeFrom = 0;
      let groupAppliedInPeriod = 0;
      for (const a of gAllocs) {
        const d = a.effectiveDay || a.effective_day || to;
        const amt = roundVnd(a.amount);
        let delta = 0;
        if (a.kind === "allocate" || a.kind === "reserve_use") delta = amt;
        else if (a.kind === "reverse") delta = -amt;
        else continue;

        groupAllocatedTotal += delta;
        if (d < from) groupAppliedBeforeFrom += delta;
        else {
          groupAppliedInPeriod += delta;
          rows.push({
            day: d, kind: a.kind, ref: a.sourceTxId || a.source_tx_id || a.requestId, groupCode: g.groupCode,
            label: a.kind === "reserve_use" ? `Cấn bảo lưu cho đoàn ${g.groupCode}` : (a.kind === "reverse" ? `Đảo phân bổ đoàn ${g.groupCode}` : `Thu/cấn cọc cho đoàn ${g.groupCode}`),
            debit: delta < 0 ? Math.abs(delta) : 0,
            credit: delta > 0 ? delta : 0
          });
        }
      }

      // If group is still only held (not confirmed & not invoiced), collected cash is unapplied deposit (advance)
      const isObligationRecognized = g.status !== "held" || hasInvoices;
      let groupOpenAr = 0;
      let groupUnappliedDeposit = 0;

      if (!isObligationRecognized) {
        groupUnappliedDeposit = Math.max(0, groupAllocatedTotal);
        unappliedDeposit += groupUnappliedDeposit;
      } else {
        if (obligationDate <= to) {
          if (obligationDate < from) openingBalance += baseObligation;
          else {
            periodCharges += baseObligation;
            rows.push({
              day: obligationDate, kind: hasInvoices ? "invoice" : "group_obligation",
              ref: hasInvoices ? invoices.map((i) => i.code || i.id).join(", ") : g.groupCode,
              groupCode: g.groupCode,
              label: hasInvoices ? `Hóa đơn đoàn ${g.groupCode}` : `Nghĩa vụ xác nhận đoàn ${g.groupCode}`,
              debit: baseObligation, credit: 0
            });
          }
          const grossObligation = Math.max(0, baseObligation + adjNet);
          const appliedToObligation = Math.min(grossObligation, Math.max(0, groupAllocatedTotal));
          groupUnappliedDeposit = Math.max(0, groupAllocatedTotal - grossObligation);
          groupOpenAr = Math.max(0, grossObligation - appliedToObligation);
          unappliedDeposit += groupUnappliedDeposit;

          // Ledger running balance components
          openingBalance -= groupAppliedBeforeFrom;
          periodApplied += groupAppliedInPeriod;

          // Aging bucket on open receivable
          if (groupOpenAr > 0) {
            if (hasInvoices) {
              const dueInfo = computeInvoiceDue(invoices[0], to);
              aging[dueInfo.bucket] += groupOpenAr;
            } else {
              const lastMilestone = (g.depositSchedule?.milestones || []).slice(-1)[0];
              if (!lastMilestone || !lastMilestone.dueDate) {
                aging.unknown_due += groupOpenAr;
              } else if (to > lastMilestone.dueDate) {
                const od = diffDays(lastMilestone.dueDate, to);
                aging[od <= 7 ? "overdue_1_7" : (od <= 30 ? "overdue_8_30" : "overdue_30_plus")] += groupOpenAr;
              } else if (to === lastMilestone.dueDate) {
                aging.due_today += groupOpenAr;
              } else {
                aging.not_due += groupOpenAr;
              }
            }
          }
        }
      }

      const invoiceDue = hasInvoices ? computeInvoiceDue(invoices[0], to) : null;
      const lateInterestPreview = (invoiceDue && invoiceDue.overdueDays > 0 && groupOpenAr > 0)
        ? estimateLateInterest(groupOpenAr, invoiceDue.overdueDays)
        : null;

      groupSummaries.push({
        groupId: g.id,
        groupCode: g.groupCode,
        status: g.status,
        checkin: g.checkin,
        checkout: g.checkout,
        baseObligation,
        adjustmentsNet: adjNet,
        guestServiceExcluded: guestServiceTotal,
        allocatedTotal: groupAllocatedTotal,
        openReceivable: groupOpenAr,
        unappliedDeposit: groupUnappliedDeposit,
        invoiceDue,
        lateInterestPreview
      });
    }

    rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const closingBalance = openingBalance + periodCharges + periodAdjPlus - periodAdjMinus - periodApplied;
    const totalOpenReceivable = groupSummaries.reduce((s, g) => s + g.openReceivable, 0);
    const creditLimit = roundVnd(agency.creditLimit || 0);
    const overLimitAmount = creditLimit > 0 ? Math.max(0, totalOpenReceivable - creditLimit) : 0;

    return {
      agencyCode: code,
      agencyName: agency.tradeName || agency.legalName || code,
      legalName: agency.legalName || "",
      taxCode: agency.taxCode || "",
      periodFrom: from,
      periodTo: to,
      asOfDate: to,
      openingStatus: agency.openingVerified === false ? "Chưa đối chiếu đầu kỳ" : "Đã xác nhận",
      openingBalance,
      periodCharges,
      periodAdjPlus,
      periodAdjMinus,
      periodApplied,
      closingBalance,
      totalOpenReceivable,
      unappliedDeposit,
      unassignedCash,
      creditReserve,
      approvedRefundPending,
      totalBankFeeVariance,
      creditLimit,
      overLimitAmount,
      aging,
      rows,
      groupSummaries
    };
  }

  function computeWorkQueue(params) {
    const { agencies, groups, allocations, financeState, asOfDate } = params;
    const today = asOfDate || getVietnamTodayISO();
    const items = [];
    const agencyByCode = new Map((agencies || []).map((a) => [a.code, a]));

    // 1. Unallocated receipts & bank fee shortfalls
    for (const rb of computeReceiptBalances(allocations, financeState, today)) {
      const ag = agencyByCode.get(rb.agencyCode);
      if (rb.unallocated > 0) {
        items.push({
          priority: 1, category: "unallocated_cash",
          label: "Tiền đã về chưa phân bổ",
          agencyCode: rb.agencyCode, agencyName: ag?.tradeName || rb.agencyCode,
          groupCode: "Chưa gán đoàn", amount: rb.unallocated, dueDate: rb.businessDate,
          owner: ag?.accountingContact || "Kế toán", ref: rb.sourceTxId
        });
      }
      if (rb.unresolvedBankFee > 0) {
        items.push({
          priority: 2, category: "bank_fee_shortfall",
          label: "Chênh lệch phí ngân hàng (đại lý chịu)",
          agencyCode: rb.agencyCode, agencyName: ag?.tradeName || rb.agencyCode,
          groupCode: "", amount: rb.unresolvedBankFee, dueDate: rb.businessDate,
          owner: ag?.accountingContact || "Quản lý", ref: rb.sourceTxId
        });
      }
    }

    // 2. Per-group deposit due, invoice receipt verification, overdue invoices, roster due, pending approvals
    for (const g of (groups || [])) {
      if (g.status === "cancelled") continue;
      const ag = agencyByCode.get(g.agencyCode);
      const ledger = computeAgencyLedger({
        agency: ag || { code: g.agencyCode },
        groups: [g], allocations, financeState, asOfDate: today
      });
      const gs = ledger.groupSummaries[0];

      // Pending approvals
      for (const ap of (g.approvalRequests || []).filter((x) => x.status === "pending")) {
        items.push({
          priority: 1, category: "pending_approval",
          label: `Cần duyệt: ${ap.reason || ap.kind}`,
          agencyCode: g.agencyCode, agencyName: ag?.tradeName || g.agencyCode,
          groupCode: g.groupCode, amount: roundVnd(ap.amount || 0), dueDate: g.checkin,
          owner: "Quản lý", ref: g.id
        });
      }

      // Invoice receipt verification & overdue
      for (const inv of (g.invoices || []).filter((i) => i.status !== "voided")) {
        const due = computeInvoiceDue(inv, today);
        if (due.status === "awaiting_invoice_receipt") {
          items.push({
            priority: 1, category: "verify_invoice_receipt",
            label: "Chờ xác minh ngày nhận hóa đơn",
            agencyCode: g.agencyCode, agencyName: ag?.tradeName || g.agencyCode,
            groupCode: g.groupCode, amount: gs ? gs.openReceivable : roundVnd(inv.amount),
            dueDate: inv.issueDate, owner: ag?.accountingContact || "Kế toán", ref: inv.code || inv.id
          });
        } else if (due.status === "overdue" && gs && gs.openReceivable > 0) {
          items.push({
            priority: 0, category: "overdue_ar",
            label: `Quá hạn ${due.overdueDays} ngày`,
            agencyCode: g.agencyCode, agencyName: ag?.tradeName || g.agencyCode,
            groupCode: g.groupCode, amount: gs.openReceivable, dueDate: due.dueDate,
            owner: ag?.accountingContact || "Quản lý", ref: inv.code || inv.id
          });
        } else if (due.status === "due_today" && gs && gs.openReceivable > 0) {
          items.push({
            priority: 1, category: "due_today",
            label: "Khoản tín dụng đến hạn hôm nay",
            agencyCode: g.agencyCode, agencyName: ag?.tradeName || g.agencyCode,
            groupCode: g.groupCode, amount: gs.openReceivable, dueDate: due.dueDate,
            owner: ag?.accountingContact || "Kế toán", ref: inv.code || inv.id
          });
        }
      }

      // Deposit schedule milestones due <= today
      let cumDue = 0;
      const paid = gs ? gs.allocatedTotal : 0;
      for (const m of (g.depositSchedule?.milestones || [])) {
        cumDue += roundVnd(m.amount);
        if (m.dueDate && m.dueDate <= today && paid < cumDue) {
          items.push({
            priority: m.dueDate < today ? 0 : 1,
            category: m.dueDate < today ? "overdue_deposit" : "deposit_due",
            label: m.label,
            agencyCode: g.agencyCode, agencyName: ag?.tradeName || g.agencyCode,
            groupCode: g.groupCode, amount: cumDue - paid, dueDate: m.dueDate,
            owner: ag?.bookingContact || "Lễ tân", ref: g.id
          });
          break;
        }
      }

      // 7-day guest roster reminder
      if (g.rosterDueDate && g.rosterDueDate <= today && g.rosterStatus !== "submitted" && g.checkin >= today) {
        items.push({
          priority: 2, category: "roster_due",
          label: "Đến hạn nhận danh sách khách (trước 7 ngày)",
          agencyCode: g.agencyCode, agencyName: ag?.tradeName || g.agencyCode,
          groupCode: g.groupCode, amount: 0, dueDate: g.rosterDueDate,
          owner: ag?.bookingContact || "Lễ tân", ref: g.id
        });
      }
    }

    items.sort((a, b) => (a.priority - b.priority) || String(a.dueDate || "").localeCompare(String(b.dueDate || "")));
    return items;
  }

  function computeCutoverPreview(params) {
    const { bookings, financeState, agencies, cutoffDate } = params;
    const cutoff = cutoffDate || getVietnamTodayISO();
    const knownByCode = new Map((agencies || []).map((a) => [String(a.code || "").toUpperCase(), a]));
    const knownByName = new Map((agencies || []).map((a) => [String(a.tradeName || "").toLowerCase().trim(), a]));

    const matchedGroups = [];
    const needsManagerMatch = [];
    const existingDeposits = [];
    let totalBookingValue = 0;
    let totalDepositValue = 0;

    const byGroup = new Map();
    for (const b of (bookings || [])) {
      if (b.status === "cancelled") continue;
      const ch = String(b.channelKey || "").toLowerCase();
      const src = String(b.tourName || b.sourceName || "").trim();
      if (ch !== "tour" && !b.agencyCode && !/^tour\b/i.test(src)) continue;
      const key = b.bookingCode || b.id;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(b);
    }

    for (const [gCode, list] of byGroup.entries()) {
      const sample = list[0];
      const rawCode = String(sample.agencyCode || "").toUpperCase();
      const rawName = String(sample.tourName || sample.sourceName || "").trim();
      const total = list.reduce((s, x) => s + roundVnd(x.totalAmount || 0), 0);
      totalBookingValue += total;
      const exactAgency = knownByCode.get(rawCode) || knownByName.get(rawName.toLowerCase());
      if (exactAgency) {
        matchedGroups.push({ groupCode: gCode, agencyCode: exactAgency.code, rooms: list.length, total, cutoffDate: cutoff });
      } else {
        needsManagerMatch.push({ groupCode: gCode, rawName, rooms: list.length, total, reason: "Tên đại lý chưa khớp mã tin cậy — cần quản lý xác nhận" });
      }
    }

    for (const tx of (financeState?.transactions || [])) {
      if (tx.status === "voided" || tx.txType !== "customer_payment") continue;
      if ((tx.businessDate || "") > cutoff) continue;
      if (tx.agencyCode || byGroup.has(tx.bookingCode || tx.bookingId)) {
        existingDeposits.push({ txId: tx.id, businessDate: tx.businessDate, amount: roundVnd(tx.amount), agencyCode: tx.agencyCode || "" });
        totalDepositValue += roundVnd(tx.amount);
      }
    }

    return {
      cutoffDate: cutoff,
      matchedGroups,
      needsManagerMatch,
      existingDeposits,
      summary: {
        matchedGroupCount: matchedGroups.length,
        ambiguousGroupCount: needsManagerMatch.length,
        existingDepositCount: existingDeposits.length,
        totalBookingValue,
        totalDepositValue
      }
    };
  }

  function buildConfirmationView(params) {
    const { group, agency, contract, audience } = params;
    const isGuest = audience === "guest";
    const base = {
      audience: isGuest ? "guest" : "agency",
      hotelName: "Dongvan Ville Du H'Mong Hotel",
      hotelContact: "Tel/Zalo: 0912.122.721 - 0912.251.169 • Email: Dongvanvilleduhmong@gmail.com",
      partyB: {
        legalName: agency?.legalName || agency?.tradeName || "",
        tradeName: agency?.tradeName || "",
        taxCode: isGuest ? "" : (agency?.taxCode || ""),
        bookingContact: agency?.bookingContact || ""
      },
      groupCode: group.groupCode,
      status: group.status,
      checkin: group.checkin,
      checkout: group.checkout,
      rosterDueDate: group.rosterDueDate,
      includedInclusions: [
        "Ăn sáng Buffet hàng ngày",
        "Trà/cà phê & 02 chai nước khoáng miễn phí mỗi ngày",
        "Wifi toàn khu, bãi đỗ xe con/xe khách tại sân"
      ],
      rooms: (group.roomLines || []).map((rl) => ({
        categoryCode: rl.categoryCode,
        categoryLabel: CATEGORY_BY_CODE.get(rl.categoryCode)?.label || rl.categoryCode,
        qty: rl.qty,
        roomIds: rl.roomIds || [],
        // Confidentiality rule: guest copy NEVER exposes contract rates!
        subtotal: isGuest ? null : rl.subtotal,
        nightDetails: isGuest ? null : rl.nightDetails
      })),
      showContractRates: !isGuest,
      contractVersionRef: isGuest ? null : `${contract?.id || group.contractId} v${contract?.versionNo || 1}`,
      agencyTotal: isGuest ? null : roundVnd(group.pricingSnapshot?.agencyTotal || 0),
      depositSchedule: isGuest ? null : group.depositSchedule,
      guestPaidServices: (group.serviceLines || []).filter((s) => s.payer === "guest").map((s) => ({
        name: s.name, amount: roundVnd(s.amount), basis: s.basis
      })),
      bankAccount: isGuest ? null : (contract?.bankAccount || defaultContract2027().bankAccount)
    };
    return base;
  }

  function csvSafeCell(v) {
    let s = String(v == null ? "" : v);
    if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  }

  function exportStatementCsv(ledger) {
    const header = [
      "Mã đại lý", "Tên đại lý", "Ngày hiệu lực", "Loại chứng từ", "Số chứng từ", "Mã đoàn",
      "Diễn giải", "Phát sinh Nợ (VND)", "Phát sinh Có (VND)", "Người duyệt", "Kỳ ảnh hưởng"
    ];
    const rows = [header];
    rows.push([
      ledger.agencyCode, ledger.agencyName, ledger.periodFrom, "opening", "", "",
      `Số dư đầu kỳ (${ledger.openingStatus})`, ledger.openingBalance > 0 ? ledger.openingBalance : 0, ledger.openingBalance < 0 ? Math.abs(ledger.openingBalance) : 0, "", ""
    ]);
    for (const r of (ledger.rows || [])) {
      rows.push([
        ledger.agencyCode, ledger.agencyName, r.day, r.kind, r.ref || "", r.groupCode || "",
        r.label || "", roundVnd(r.debit || 0), roundVnd(r.credit || 0), r.approvedBy || "", r.effectivePeriod || ""
      ]);
    }
    rows.push([
      ledger.agencyCode, ledger.agencyName, ledger.periodTo, "closing", "", "",
      "Số dư cuối kỳ (Công nợ còn phải thu)", ledger.closingBalance, 0, "", ""
    ]);
    rows.push([
      ledger.agencyCode, ledger.agencyName, ledger.periodTo, "memo", "", "",
      `Cọc chưa cấn: ${ledger.unappliedDeposit} | Tiền chưa gán đoàn: ${ledger.unassignedCash} | Bảo lưu: ${ledger.creditReserve} | Hoàn chờ chi: ${ledger.approvedRefundPending}`,
      0, 0, "", ""
    ]);
    return "\uFEFF" + rows.map((row) => row.map(csvSafeCell).join(",")).join("\r\n");
  }

  const api = {
    TZ,
    HOLIDAY_SURCHARGE_VND,
    EXTRA_BED_VND,
    CHILD_6_10_VND,
    INTERNAL_DORM_VND,
    INTERNAL_ROOM_PCT,
    CREDIT_TERM_DAYS,
    ROSTER_LEAD_DAYS,
    DEFAULT_VAT_PCT,
    LATE_INTEREST_MONTHLY_PCT,
    ROOM_CATEGORIES_2027,
    CATEGORY_BY_CODE,
    CATEGORY_BY_ROOM,
    isValidISO,
    addDays,
    diffDays,
    listNights,
    getVietnamTodayISO,
    roundVnd,
    allocateProportional,
    auditRoomCategoryMapping,
    defaultContract2027,
    classifySeason,
    isThuFriSat,
    priceNight,
    evaluateSpecialItems,
    computeDepositSchedule,
    quoteGroup,
    previewPromoAddendumImpact,
    checkResaleCap,
    previewCancellation,
    computeInvoiceDue,
    estimateLateInterest,
    computeReceiptBalances,
    computeAgencyLedger,
    computeWorkQueue,
    computeCutoverPreview,
    buildConfirmationView,
    exportStatementCsv
  };

  root.PMSTaContracts = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
