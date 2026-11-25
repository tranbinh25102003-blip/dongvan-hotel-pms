/* ==========================================================================
   Dongvan Ville du H'mong Hotel — Front Desk Calendar UI Controller (app.js)
   Backed by PMSCore (pms-core.js) for transactional safety, optimistic locking,
   idempotent writes, CSV/XSS hardening, rollback & consistency health checks.
   ========================================================================== */

(() => {
  "use strict";

  const Core = window.PMSCore;
  if (!Core) {
    throw new Error("PMSCore (pms-core.js) failed to load.");
  }

  const THEME_KEY = "ks_manual_theme_v1";
  const DRAFT_KEY = "ks_manual_draft_v1";
  const AUTO_DL_BACKUP_KEY = "ks_manual_auto_download_backup_v1";
  const {
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
    sanitizeConfirmationPdf,
    getRoomById,
    getRemaining,
    getPaymentStatus,
    calculateVatBreakdown,
    extractPreVatFromTotal,
    getCellPaymentBadge,
    getGroupCellPaymentBadge,
    detectChannelKey,
    bookingCoversDate,
    getDormSlotMapForDate,
    getDormOccupiedSlotsInRange,
    computeMonthlyFinancials,
    computeCalendarFinanceKPIs,
    getVietnamTodayISO,
    normalizeGroupCode,
    computeBookingGroupSummary,
    computeAllBookingGroups,
    allocateGroupPayment,
    buildCopiedBookingPayload,
    buildGroupSyncUpdates,
    buildBookingConfirmationData,
    renderBookingConfirmationHtml,
    isValidMonthKey,
    formatMonthVN,
    getCurrentMonthKey,
    COST_CALC_MODES,
    createDefaultOperatingCostsState,
    upsertCostItem,
    deleteCostRateHistoryEntry,
    toggleCostItemActive,
    addActualCostEntry,
    deleteActualCostEntry,
    setCostItemFinalized,
    computeMonthlyOperatingCosts,
    generateOperatingCostsCsvContent,
    STAFF_ROLES,
    normalizeRole,
    getRoleLabel,
    hasPermission,
    getVisibleNavGroups,
    HK_TASK_TYPES,
    HK_TASK_STATUSES,
    ISSUE_SEVERITIES,
    ISSUE_STATUSES,
    getHousekeepingTasksForDate,
    computeRoomOperationalStatus,
    computeAllRoomOperationalStatuses,
    generateCsvContent,
    generateAuditCsvContent,
    diffBookingChanges
  } = Core;

  const store = window.pmsClient || window.PMSClient.createUnifiedClient();

  // Structured diagnostic ring-buffer logger
  const runtimeErrors = [];
  function logDiagnostic(level, message, detail) {
    const entry = { ts: new Date().toISOString(), level, message, detail: detail ? String(detail) : "" };
    runtimeErrors.unshift(entry);
    if (runtimeErrors.length > 50) runtimeErrors.length = 50;
    if (level === "error") console.error("[PMS]", message, detail || "");
  }

  const todayObj = new Date();
  const state = {
    year: todayObj.getFullYear(),
    month: todayObj.getMonth(),
    lastKnownTodayISO: getTodayISO(),
    bookings: [],
    collapsedFloors: {},
    filters: { search: "", floor: "all", type: "all", view: "all", payment: "all", channel: "all" },
    activeChannelKey: "booking",
    activePayStatus: "deposit",
    activeDormDate: null,
    dormSelectedSlots: [],
    editingBookingRevision: null,
    editingOriginalBooking: null,
    lastAutofilledGroupCode: "",
    editingDormRevision: null,
    activeIdempotencyKey: null,
    activeDormIdempotencyKey: null,
    activeConfirmationPdf: null,
    activeDormConfirmationPdf: null,
    activeDayReportDate: null,
    copiedBooking: null,
    isSubmitting: false
  };

  const $ = (id) => document.getElementById(id);

  function newIdempotencyKey(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function getBookingsForRoomDate(roomId, iso) {
    return state.bookings.filter((b) => b.roomId === roomId && bookingCoversDate(b, iso));
  }

  function hasActiveBookingFilters() {
    return !!(state.filters.search || state.filters.payment !== "all" || state.filters.channel !== "all");
  }

  function getEffectiveRemaining(booking) {
    if (booking && booking.bookingCode) {
      const grp = computeBookingGroupSummary(state.bookings, booking.bookingCode);
      if (grp && grp.roomCount >= 2) return grp.remaining;
    }
    return getRemaining(booking);
  }

  function matchesBookingFilter(booking) {
    const { search, payment, channel } = state.filters;
    if (channel !== "all" && booking.channelKey !== channel) return false;
    const effRem = getEffectiveRemaining(booking);
    if (payment === "debt" && effRem <= 0) return false;
    if (payment === "paid" && effRem > 0) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${booking.guestName} ${booking.phone} ${booking.sourceName} ${booking.tourName || ""} ${booking.bookingCode || ""} ${booking.roomId} ${booking.notes}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function getFilteredRooms() {
    const { floor, type, view, search } = state.filters;
    return ROOMS.filter((room) => {
      if (floor === "dorm") {
        if (!room.isDorm) return false;
      } else if (floor !== "all") {
        if (room.isDorm || String(room.floor) !== floor) return false;
      }
      if (type !== "all" && room.type !== type) return false;
      if (view !== "all" && room.view !== view) return false;
      if (search) {
        const q = search.toLowerCase();
        const roomMatches = `${room.name} ${room.type} ${room.view}`.toLowerCase().includes(q);
        if (!roomMatches) {
          const mStart = formatDateISO(state.year, state.month, 1);
          const mEnd = formatDateISO(state.year, state.month, getDaysInMonth(state.year, state.month));
          const hasMatching = state.bookings.some((b) => b.roomId === room.id && b.checkout > mStart && b.checkin <= mEnd && matchesBookingFilter(b));
          if (!hasMatching) return false;
        }
      }
      return true;
    });
  }

  /* -------------------- Rendering -------------------- */

  function updateTodayDateLabel() {
    const d = new Date();
    const fullText = `Hôm nay: ${DOW_FULL_VI[d.getDay()]}, ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    $("today-date-label").textContent = `Hôm nay • ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
    const btn = $("btn-today");
    if (btn) {
      btn.title = `${fullText} — nhấn để về ngày hôm nay`;
      btn.setAttribute("aria-label", fullText);
    }
  }

  function scrollToToday(smooth = true) {
    const wrap = $("cal-scroll-wrap");
    const th = $("calendar-thead").querySelector('[data-is-today="1"]');
    if (!wrap || !th) return;
    const targetLeft = Math.max(0, th.offsetLeft - 230);
    wrap.scrollTo({ left: targetLeft, behavior: smooth ? "smooth" : "auto" });
  }

  function renderFilterNotice() {
    const parts = [];
    if (state.filters.channel !== "all") {
      const ch = CHANNELS.find((c) => c.key === state.filters.channel);
      parts.push(`Nguồn: ${ch ? ch.label : state.filters.channel}`);
    }
    if (state.filters.payment === "debt") parts.push("Thanh toán: Còn nợ / Cọc");
    if (state.filters.payment === "paid") parts.push("Thanh toán: Đã trả đủ");
    if (state.filters.search) parts.push(`Từ khóa: "${state.filters.search}"`);
    if (parts.length) {
      $("active-filter-text").textContent = `Đang áp dụng bộ lọc (${parts.join(" • ")})`;
      $("active-filter-bar").classList.add("show");
    } else {
      $("active-filter-bar").classList.remove("show");
    }
  }

  function renderLegend() {
    $("legend-strip").innerHTML = CHANNELS.map((ch) => {
      const active = state.filters.channel === ch.key;
      const dimmed = state.filters.channel !== "all" && !active;
      return `<button type="button" class="legend-pill ${dimmed ? "dimmed" : ""}" data-channel="${ch.key}" style="background:${ch.bgVar}; color:${ch.fgVar}; border-color:${active ? ch.colorVar : "transparent"};">
        <span class="legend-dot" style="background:${ch.colorVar};"></span>${ch.short}
      </button>`;
    }).join("");
  }

  function renderKPIs() {
    const today = getTodayISO();
    const regularRooms = ROOMS.filter((r) => !r.isDorm);
    let occRooms = 0, mergeToday = 0, ebToday = 0, buffetGuests = 0;

    regularRooms.forEach((room) => {
      const bks = getBookingsForRoomDate(room.id, today);
      if (bks.length > 0) {
        occRooms += 1;
        const bk = bks[0];
        if (bk.mergeBed && room.type === "Twins") mergeToday += 1;
        ebToday += Number(bk.extraBed) || 0;
        buffetGuests += Number(bk.guestCount) || room.defaultGuests;
      }
    });

    const { map: dormMap } = getDormSlotMapForDate(state.bookings, today);
    const dormUsed = Object.keys(dormMap).length;
    const dormFree = Math.max(0, 8 - dormUsed);

    const fLoad = typeof store.getFinanceLoadState === "function" ? store.getFinanceLoadState() : { status: "loaded", loaded: true };
    const fState = typeof store.getFinanceState === "function" ? store.getFinanceState() : null;
    const finKpi = computeCalendarFinanceKPIs(state.bookings, fState, state.year, state.month);
    state.lastArAsOfDate = finKpi.arAsOfDate;

    $("kpi-today-occ").textContent = `${occRooms} / 26 (trống ${26 - occRooms})`;
    $("kpi-today-dorm").textContent = `Đặt ${dormUsed} • Còn ${dormFree}/8`;
    $("kpi-today-hk").textContent = `${mergeToday} ghép • ${ebToday} EB`;
    $("kpi-today-buffet").textContent = `${buffetGuests} khách`;
    if (fLoad && !fLoad.loaded) {
      const loadText = fLoad.status === "error" ? "Không tải được sổ" : "Đang tải sổ...";
      $("kpi-month-paid").textContent = loadText;
      $("kpi-month-debt").textContent = loadText;
      const refundNote = $("kpi-month-refund-note");
      if (refundNote) { refundNote.textContent = ""; refundNote.style.display = "none"; }
    } else {
      $("kpi-month-paid").textContent = formatVND(finKpi.monthlyNetReceived);
      const refundNote = $("kpi-month-refund-note");
      if (refundNote) {
        if (finKpi.monthlyRefunds > 0) {
          refundNote.textContent = `(đã trừ hoàn ${formatVND(finKpi.monthlyRefunds)})`;
          refundNote.style.display = "inline-block";
        } else {
          refundNote.textContent = "";
          refundNote.style.display = "none";
        }
      }
      const arLabel = $("kpi-ar-asof-label");
      if (arLabel) {
        const todayVN = getVietnamTodayISO();
        arLabel.textContent = finKpi.arAsOfDate === todayVN
          ? "Công nợ đến hôm nay"
          : `Công nợ đến ${formatDateVN(finKpi.arAsOfDate).slice(0, 5)}`;
      }
      $("kpi-month-debt").textContent = formatVND(finKpi.arAsOfTotal);
    }
    $("kpi-month-debt").className = `kpi-value ${finKpi.arAsOfTotal > 0 ? "warn" : "ok"}`;
    const monthTag = $("kpi-month-tag");
    if (monthTag) {
      const nowD = new Date();
      const isCurrentMonth = state.year === nowD.getFullYear() && state.month === nowD.getMonth();
      monthTag.textContent = isCurrentMonth ? "Tháng này" : `Tháng ${state.month + 1}/${state.year}`;
      const grp = $("kpi-group-month");
      if (grp) grp.title = `Tiền thực thu theo ngày nhận trong tháng ${state.month + 1}/${state.year} & Tổng công nợ khách tính đến ${formatDateVN(finKpi.arAsOfDate)} — nhấn để xem chứng từ chi tiết`;
    }
  }

  function updateHeaderGroupPill() {
    const groups = computeAllBookingGroups(state.bookings, { minRooms: 2 });
    const pill = $("groups-count-pill");
    if (!pill) return;
    if (groups.length > 0) {
      pill.textContent = String(groups.length);
      pill.style.display = "inline-flex";
    } else {
      pill.style.display = "none";
    }
  }

  function updateClipboardUI() {
    const bar = $("pc-clipboard-bar");
    const txt = $("pc-clipboard-text");
    const tbl = $("calendar-table");
    if (!bar || !txt || !tbl) return;
    const src = state.copiedBooking;
    if (!src) {
      bar.classList.remove("show");
      tbl.classList.remove("paste-mode");
      return;
    }
    const nights = Math.max(1, diffNights(src.checkin, src.checkout) || 1);
    const room = getRoomById(src.roomId);
    const codePart = src.bookingCode ? ` • Mã ĐP: ${src.bookingCode}` : "";
    txt.innerHTML = `📋 <strong>Đang sao chép:</strong> P.${escapeHtml(room ? room.name : src.roomId)} — ${escapeHtml(src.guestName)} (${nights} đêm${escapeHtml(codePart)}). Nhấn vào bất kỳ ô trống nào để dán (cọc mặc định 0 đ để tránh tính trùng).`;
    bar.classList.add("show");
    tbl.classList.add("paste-mode");
  }

  function copyBookingToClipboard(bk) {
    if (!bk || bk.roomId === "DORM") {
      showToast("Chức năng sao chép áp dụng cho các ô phòng nghỉ (26 phòng).");
      return;
    }
    state.copiedBooking = {
      ...bk,
      confirmationPdf: bk.confirmationPdf ? { ...bk.confirmationPdf } : null
    };
    $("booking-modal").classList.remove("open");
    updateClipboardUI();
    renderCalendar();
    showToast(`📋 Đã sao chép P.${getRoomById(bk.roomId)?.name || bk.roomId} (${bk.guestName}) — nhấn ô trống để dán`);
  }

  function clearClipboard(silent = false) {
    if (!state.copiedBooking) return;
    state.copiedBooking = null;
    updateClipboardUI();
    renderCalendar();
    if (!silent) showToast("Đã thoát chế độ dán phòng");
  }

  async function pasteBookingIntoCell(targetRoomId, targetDateISO) {
    if (!state.copiedBooking || state.isSubmitting) return;
    const keepGroupCode = $("chk-paste-keep-group") ? $("chk-paste-keep-group").checked : true;
    const built = buildCopiedBookingPayload(state.copiedBooking, targetRoomId, targetDateISO, { keepGroupCode });
    if (!built.ok) {
      showToast(built.error);
      return;
    }

    state.isSubmitting = true;
    try {
      const res = await store.saveBooking(built.payload, { idempotencyKey: newIdempotencyKey("paste") });
      if (!res.ok) {
        // On date overlap or validation issue, open modal prefilled so staff can adjust nights/room
        openBookingModal({ roomId: targetRoomId, checkin: targetDateISO, prefill: built.payload });
        showFormError(res.error);
        return;
      }
      state.bookings = res.bookings;
      renderAll();
      onDataMutated("save");
      const roomName = getRoomById(targetRoomId)?.name || targetRoomId;
      const grpSuffix = res.booking.bookingCode ? ` • Đoàn ${res.booking.bookingCode}` : "";
      showToast(`📋 Đã dán P.${roomName} (${formatDateVN(res.booking.checkin)} → ${formatDateVN(res.booking.checkout)})${grpSuffix}`);
    } finally {
      state.isSubmitting = false;
    }
  }

  function isPcViewActive() {
    const mode = document.body && document.body.dataset ? document.body.dataset.viewMode : "";
    if (mode === "pc") return true;
    if (mode === "mobile") return false;
    return window.innerWidth > 768;
  }

  let pcRenderDirty = false;
  let pcRenderRafId = 0;

  function scheduleRenderAll() {
    if (!isPcViewActive()) {
      pcRenderDirty = true;
      return;
    }
    if (pcRenderRafId) return;
    pcRenderRafId = requestAnimationFrame(() => {
      pcRenderRafId = 0;
      renderAll();
    });
  }

  function buildMonthBookingIndex(bookings, year, month, daysCount) {
    const monthStart = formatDateISO(year, month, 1);
    const monthEnd = formatDateISO(year, month, daysCount);
    const cellMap = new Map();
    const dormSlotsByDate = new Map();
    const occupiedRoomsByDay = Array.from({ length: daysCount }, () => new Set());
    const bookingById = new Map();

    for (let i = 0; i < bookings.length; i++) {
      const b = bookings[i];
      if (!b) continue;
      bookingById.set(b.id, b);
      if (!b.checkin || !b.checkout || b.checkout <= monthStart || b.checkin > monthEnd) continue;

      const startDay = b.checkin <= monthStart ? 1 : parseInt(b.checkin.slice(8, 10), 10);
      const endISO = b.checkout > monthEnd ? addDaysISO(monthEnd, 1) : b.checkout;
      const lastDay = endISO > monthEnd ? daysCount : Math.min(daysCount, parseInt(endISO.slice(8, 10), 10) - 1);

      for (let d = startDay; d <= lastDay; d++) {
        const iso = formatDateISO(year, month, d);
        const key = `${b.roomId}|${iso}`;
        let arr = cellMap.get(key);
        if (!arr) {
          arr = [];
          cellMap.set(key, arr);
        }
        arr.push(b);

        if (b.roomId === "DORM") {
          let slotSet = dormSlotsByDate.get(iso);
          if (!slotSet) {
            slotSet = new Set();
            dormSlotsByDate.set(iso, slotSet);
          }
          const slots = Array.isArray(b.slots) ? b.slots : [];
          for (let s = 0; s < slots.length; s++) slotSet.add(slots[s]);
        } else {
          occupiedRoomsByDay[d - 1].add(b.roomId);
        }
      }
    }

    return { cellMap, dormSlotsByDate, occupiedRoomsByDay, bookingById };
  }

  function renderCalendar() {
    renderFilterNotice();
    const daysCount = getDaysInMonth(state.year, state.month);
    const today = getTodayISO();
    $("month-label").textContent = `Tháng ${state.month + 1} / ${state.year}`;

    const dates = [];
    for (let d = 1; d <= daysCount; d++) {
      const iso = formatDateISO(state.year, state.month, d);
      const dowIdx = new Date(state.year, state.month, d).getDay();
      dates.push({ day: d, iso, dow: DOW_VI[dowIdx], isWeekend: dowIdx === 0 || dowIdx === 6, isToday: iso === today });
    }

    // Single-pass O(N) month index -> O(1) lookup per cell (eliminates ~1,674 full array scans/render)
    const { cellMap, dormSlotsByDate, occupiedRoomsByDay, bookingById } = buildMonthBookingIndex(state.bookings, state.year, state.month, daysCount);
    state.lastBookingById = bookingById;
    const availPerDay = occupiedRoomsByDay.map((set) => 26 - set.size);

    // Precompute multi-room group map for O(1) lookup per cell & hover tooltip
    const groupMap = new Map();
    computeAllBookingGroups(state.bookings, { minRooms: 2 }).forEach((g) => {
      groupMap.set(g.normalizedCode, g);
    });
    state.lastGroupMap = groupMap;
    const pasteMode = Boolean(state.copiedBooking);
    const roomStatuses = (typeof store.getRoomStatuses === "function" && store.getRoomStatuses())
      || computeAllRoomOperationalStatuses(
        typeof store.getHousekeepingTasks === "function" ? store.getHousekeepingTasks() : [],
        typeof store.getMaintenanceIssues === "function" ? store.getMaintenanceIssues() : [],
        today
      );

    const headParts = [`<tr><th class="corner-cell">
      <div style="font-weight:700; font-size:13px;">Phòng / Hạng / View</div>
      <div style="font-size:11px; color:var(--text-muted); font-weight:500;">Nhấn đặt • Chuột phải ô để sao chép</div>
    </th>`];
    dates.forEach((dt, idx) => {
      const cls = ["day-header", dt.isWeekend ? "is-weekend" : "", dt.isToday ? "is-today" : ""].filter(Boolean).join(" ");
      headParts.push(`<th class="${cls}" data-report-date="${dt.iso}" ${dt.isToday ? 'data-is-today="1" style="box-shadow: inset 0 3px 0 var(--accent-primary);"' : ""} title="Nhấn xem báo cáo ngày ${formatDateVN(dt.iso)}">
        <span class="day-dow" style="${dt.isToday ? "color:var(--accent-primary); font-weight:800;" : ""}">${dt.isToday ? `${dt.dow} • Hôm nay` : dt.dow}</span>
        <span class="day-num" style="${dt.isToday ? "color:var(--accent-primary);" : ""}">${dt.day}/${state.month + 1}</span>
        <span class="day-avail-mini">${availPerDay[idx]} trống</span>
      </th>`);
    });
    headParts.push(`</tr>`);
    $("calendar-thead").innerHTML = headParts.join("");

    const filteredRooms = getFilteredRooms();
    const filterOn = hasActiveBookingFilters();
    const canWriteBookings = userCan("bookings:write");
    const bodyParts = [];

    ROOM_SECTIONS.forEach((section) => {
      const sectionRooms = filteredRooms.filter((r) => (section.isDorm ? r.isDorm : (!r.isDorm && r.floor === section.floor)));
      if (sectionRooms.length === 0) return;

      const isCollapsed = !!state.collapsedFloors[section.key];
      const sectionTitle = section.isDorm
        ? "Dorm (8 chỗ)"
        : `Tầng ${section.floor} (${sectionRooms.length} phòng ngủ)`;

      bodyParts.push(`<tr class="floor-row ${section.isDorm ? "is-dorm-section" : ""}" data-section-key="${section.key}">
        <td class="floor-sticky">
          <div class="floor-row-inner floor-label-inner" style="justify-content:space-between; gap:6px;">
            <button type="button" class="floor-toggle" data-floor-toggle="${section.key}" style="white-space:nowrap;">
              <span>${isCollapsed ? "▸" : "▾"}</span>
              <span>${escapeHtml(sectionTitle)}</span>
            </button>
            ${section.isDorm && canWriteBookings ? `<button type="button" class="btn-inline-dorm" data-inline-dorm-today="1" title="Mở sơ đồ 8 chỗ Dorm hôm nay để đặt slot ngay trên lịch">+ Đặt slot</button>` : ""}
          </div>
        </td>
        <td colspan="${daysCount}"></td>
      </tr>`);

      if (isCollapsed) return;

      sectionRooms.forEach((room) => {
        const ops = !room.isDorm ? roomStatuses[room.id] : null;
        let opsHtml = "";
        if (ops) {
          const pills = [];
          if (ops.cleanliness === "dirty") {
            pills.push(`<button type="button" class="room-hk-pill dirty" data-open-room-hk="${escapeHtml(room.id)}" title="Phòng đang Cần dọn — nhấn xem việc buồng phòng">🔴 Cần dọn</button>`);
          } else if (ops.cleanliness === "in_progress") {
            const who = ops.activeTask && ops.activeTask.startedBy ? ` (${ops.activeTask.startedBy})` : "";
            pills.push(`<button type="button" class="room-hk-pill in_progress" data-open-room-hk="${escapeHtml(room.id)}" title="Đang dọn${escapeHtml(who)} — nhấn xem tiến độ">🟡 Đang dọn</button>`);
          } else if (ops.cleanliness === "cleaned") {
            const who = ops.lastCleanedTask && ops.lastCleanedTask.completedBy ? ` bởi ${ops.lastCleanedTask.completedBy}` : "";
            pills.push(`<button type="button" class="room-hk-pill cleaned" data-open-room-hk="${escapeHtml(room.id)}" title="Đã dọn${escapeHtml(who)} — nhấn xem ảnh hoàn tất">✅ Đã dọn</button>`);
          }
          if (ops.isBlocked && ops.blockingIssues.length > 0) {
            const topIss = ops.blockingIssues[0];
            const shortDesc = topIss.description.length > 18 ? `${topIss.description.slice(0, 18)}…` : topIss.description;
            pills.push(`<button type="button" class="room-issue-pill" data-open-room-issues="${escapeHtml(room.id)}" title="Phòng chưa thể giao khách: ${escapeHtml(topIss.description)}">🚫 Sự cố: ${escapeHtml(shortDesc)}</button>`);
          } else if (ops.hasOpenIssues) {
            const topIss = ops.activeIssues[0];
            pills.push(`<button type="button" class="room-issue-pill soft" data-open-room-issues="${escapeHtml(room.id)}" title="Sự cố đang mở: ${escapeHtml(topIss.description)}">⚠️ Sự cố (${ops.activeIssues.length})</button>`);
          }
          if (pills.length > 0) {
            opsHtml = `<div class="room-ops-badges">${pills.join("")}</div>`;
          }
        }

        bodyParts.push(`<tr class="room-row" data-room-id="${room.id}">
          <td class="room-cell">
            <div class="room-top">
              <span class="room-number">${escapeHtml(room.name)}</span>
              <span class="room-type-tag type-${room.type}">${escapeHtml(room.type)}</span>
            </div>
            <div class="room-meta" title="${escapeHtml(room.view)} • ${escapeHtml(room.bedInfo)}">
              ${escapeHtml(room.view)} • ${escapeHtml(room.bedInfo)}
            </div>
            ${opsHtml}
          </td>`);

        dates.forEach((dt) => {
          const bksAll = cellMap.get(`${room.id}|${dt.iso}`) || [];
          const baseCls = ["grid-cell", dt.isWeekend ? "is-weekend" : "", dt.isToday ? "is-today" : ""].filter(Boolean);

          if (room.isDorm) {
            const slotSet = dormSlotsByDate.get(dt.iso);
            const used = slotSet ? slotSet.size : 0;
            const free = Math.max(0, room.capacity - used);
            if (used === 0) {
              bodyParts.push(`<td class="${baseCls.concat("is-vacant").join(" ")}" data-room="${room.id}" data-date="${dt.iso}" title="Dorm ngày ${formatDateVN(dt.iso)}: Trống 8/8 chỗ — Nhấn đặt slot">
                <div class="vacant-inner">
                  <span class="vacant-plus">+</span>
                  <span class="vacant-label" style="color:var(--status-paid);">Trống 8/8</span>
                </div>
              </td>`);
            } else {
              const totalDebt = bksAll.reduce((s, b) => s + getRemaining(b), 0);
              const isFull = free === 0;
              const vis = !filterOn || bksAll.some(matchesBookingFilter);
              const dormPayCls = totalDebt > 0 ? "unpaid" : "paid";
              const dormPayText = totalDebt > 0 ? `Nợ ${formatShortVND(totalDebt)}` : "✓ Đã TT";
              bodyParts.push(`<td class="${baseCls.join(" ")}" data-room="${room.id}" data-date="${dt.iso}" data-dorm-day="1">
                <div class="dorm-pill ${isFull ? "is-full" : ""} ${vis ? "" : "bk-dimmed"}">
                  <span class="dorm-count">${isFull ? "Hết 0/8 chỗ" : `Trống ${free}/8`}</span>
                  <span class="dorm-sub">Đã đặt ${used}/8</span>
                  <span class="booking-pay ${dormPayCls}" style="margin-top:1px;">${dormPayText}</span>
                </div>
              </td>`);
            }
            return;
          }

          if (bksAll.length === 0) {
            bodyParts.push(`<td class="${baseCls.concat("is-vacant").join(" ")}" data-room="${room.id}" data-date="${dt.iso}" title="${pasteMode ? `Nhấn để DÁN đặt phòng vào P.${room.name} (${formatDateVN(dt.iso)})` : `Phòng ${room.name} ngày ${formatDateVN(dt.iso)} còn trống — Nhấn để đặt`}">
              <div class="vacant-inner">
                <span class="vacant-plus">${pasteMode ? "📋" : "+"}</span>
                <span class="vacant-label">${pasteMode ? "Dán" : "Trống"}</span>
              </div>
            </td>`);
          } else {
            const bk = bksAll[0];
            const vis = !filterOn || matchesBookingFilter(bk);
            const hasPrev = dt.day > 1 && bk.checkin < dt.iso;
            const hasNext = dt.day < daysCount && bk.checkout > addDaysISO(dt.iso, 1);
            let segCls = "";
            if (!hasPrev && hasNext) segCls = "seg-start";
            else if (hasPrev && hasNext) segCls = "seg-mid";
            else if (hasPrev && !hasNext) segCls = "seg-end";

            const chKey = bk.channelKey || detectChannelKey(bk.sourceName);
            const showLabel = !hasPrev;
            const shortSource = bk.sourceName.replace(/\.com$/i, "");
            const shortGuest = bk.guestName.split(" ").slice(-2).join(" ");
            const groupInfo = bk.bookingCode ? groupMap.get(normalizeGroupCode(bk.bookingCode)) : null;
            const payBadge = groupInfo ? getGroupCellPaymentBadge(groupInfo) : getCellPaymentBadge(bk);

            const badgesHtml = `<div class="booking-badges">
              ${groupInfo ? `<span class="group-mini-badge" title="Đoàn ${escapeHtml(groupInfo.code)} (${groupInfo.roomCount} phòng) • Tổng ${formatVND(groupInfo.totalAmount)}">👥${groupInfo.roomCount}</span>` : ""}
              ${bk.mergeBed && room.type === "Twins" ? `<span class="badge-merge-red" title="Ghép giường (Twins → Double)">G</span>` : ""}
              ${Number(bk.extraBed) > 0 ? `<span class="badge-mini" title="Extra bed">+${bk.extraBed}</span>` : ""}
            </div>`;

            bodyParts.push(`<td class="${baseCls.join(" ")}" data-room="${room.id}" data-date="${dt.iso}" data-booking-id="${bk.id}">
              <div class="booking-block ch-${chKey} ${segCls} ${vis ? "" : "bk-dimmed"}">
                <div class="booking-top-row">
                  <div class="booking-source">${showLabel ? escapeHtml(shortSource) : escapeHtml(shortGuest)}</div>
                  ${!hasNext ? badgesHtml : ""}
                </div>
                <div class="booking-guest" style="${showLabel ? "" : "opacity:0.72;"}">${showLabel ? escapeHtml(shortGuest) : escapeHtml(shortSource)}</div>
                <div class="booking-pay ${payBadge.cls}" title="${escapeHtml(payBadge.title)}">${escapeHtml(payBadge.text)}</div>
              </div>
            </td>`);
          }
        });

        bodyParts.push(`</tr>`);
      });
    });

    $("calendar-tbody").innerHTML = bodyParts.length ? bodyParts.join("") : `<tr><td colspan="${daysCount + 1}" style="padding:32px; text-align:center; color:var(--text-muted);">Không tìm thấy phòng phù hợp với bộ lọc hiện tại.</td></tr>`;

    const footParts = [`<tr><td class="foot-sticky">Tổng trống (26 phòng) • T5 Buffet</td>`];
    dates.forEach((dt, idx) => {
      const avail = availPerDay[idx];
      const color = avail === 0 ? "color: var(--status-unpaid);" : avail <= 5 ? "color: var(--status-deposit);" : "";
      footParts.push(`<td style="${color}" title="Ngày ${formatDateVN(dt.iso)}: Đã đặt ${26 - avail}/26 phòng, còn trống ${avail} phòng">${avail}/26</td>`);
    });
    footParts.push(`</tr>`);
    $("calendar-tfoot").innerHTML = footParts.join("");
  }

  function renderAll() {
    if (!isPcViewActive()) {
      pcRenderDirty = true;
      return;
    }
    pcRenderDirty = false;
    updateTodayDateLabel();
    updateHeaderGroupPill();
    updateHkHeaderBadge();
    updateClipboardUI();
    renderLegend();
    renderKPIs();
    renderCalendar();
    if (window.PMSFinanceApp && typeof window.PMSFinanceApp.updateSidebarBadges === "function") {
      window.PMSFinanceApp.updateSidebarBadges();
    }
  }

  /* -------------------- Delegated Table & Legend Listeners (Zero Listener Churn) -------------------- */

  function bindDelegatedCalendarEvents() {
    $("legend-strip").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-channel]");
      if (!btn) return;
      const ch = btn.dataset.channel;
      state.filters.channel = state.filters.channel === ch ? "all" : ch;
      renderAll();
    });

    $("calendar-thead").addEventListener("click", (e) => {
      const th = e.target.closest("[data-report-date]");
      if (th) openDailyReportModal(th.dataset.reportDate);
    });

    $("calendar-tbody").addEventListener("click", (e) => {
      const inlineDorm = e.target.closest("[data-inline-dorm-today]");
      if (inlineDorm) {
        e.stopPropagation();
        hideTooltip();
        openDormBoard(getTodayISO());
        return;
      }
      const hkPill = e.target.closest("[data-open-room-hk]");
      if (hkPill) {
        e.stopPropagation();
        openHousekeepingWorkspace({ tab: "tasks", roomId: hkPill.dataset.openRoomHk });
        return;
      }
      const issPill = e.target.closest("[data-open-room-issues]");
      if (issPill) {
        e.stopPropagation();
        openHousekeepingWorkspace({ tab: "issues", roomId: issPill.dataset.openRoomIssues });
        return;
      }
      const floorBtn = e.target.closest("[data-floor-toggle]");
      if (floorBtn) {
        const fl = floorBtn.dataset.floorToggle;
        state.collapsedFloors[fl] = !state.collapsedFloors[fl];
        renderCalendar();
        return;
      }
      const td = e.target.closest("td.grid-cell");
      if (!td) return;
      hideTooltip();
      const roomId = td.dataset.room, dateISO = td.dataset.date, bookingId = td.dataset.bookingId;
      if (roomId === "DORM") openDormBoard(dateISO);
      else if (bookingId) openBookingModal({ bookingId });
      else if (state.copiedBooking) pasteBookingIntoCell(roomId, dateISO);
      else openBookingModal({ roomId, checkin: dateISO });
    });

    // Right-click on any regular booked cell to copy immediately
    $("calendar-tbody").addEventListener("contextmenu", (e) => {
      const td = e.target.closest("td.grid-cell[data-booking-id]");
      if (!td) return;
      const bk = state.bookings.find((b) => b.id === td.dataset.bookingId);
      if (!bk || bk.roomId === "DORM") return;
      e.preventDefault();
      hideTooltip();
      copyBookingToClipboard(bk);
    });

    let hoveredCell = null;
    let hoverTimer = 0;
    let tipRafId = 0;
    let tipMouseX = 0;
    let tipMouseY = 0;
    let tipVisible = false;
    let tipCachedH = 180;
    const tooltipEl = $("cell-tooltip");

    const flushTooltipPos = () => {
      tipRafId = 0;
      if (!tipVisible) return;
      const pad = 14, w = 265, h = tipCachedH;
      let left = tipMouseX + pad, top = tipMouseY + pad;
      if (left + w > window.innerWidth - 10) left = tipMouseX - w - pad;
      if (top + h > window.innerHeight - 10) top = tipMouseY - h - pad;
      tooltipEl.style.transform = `translate3d(${Math.max(8, left)}px, ${Math.max(8, top)}px, 0)`;
    };

    const scheduleTooltipPos = (x, y) => {
      tipMouseX = x;
      tipMouseY = y;
      if (!tipRafId) tipRafId = requestAnimationFrame(flushTooltipPos);
    };

    $("calendar-tbody").addEventListener("mouseover", (e) => {
      const td = e.target.closest("td.grid-cell");
      if (td === hoveredCell) return;
      hoveredCell = td;
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
      if (!td) { hideTooltip(); return; }
      const roomId = td.dataset.room, dateISO = td.dataset.date, bookingId = td.dataset.bookingId;
      if (roomId !== "DORM" && !bookingId) { hideTooltip(); return; }

      const cx = e.clientX, cy = e.clientY;
      hoverTimer = setTimeout(() => {
        hoverTimer = 0;
        if (hoveredCell !== td) return;
        const evLike = { clientX: tipMouseX || cx, clientY: tipMouseY || cy };
        if (roomId === "DORM") {
          const list = getBookingsForRoomDate("DORM", dateISO);
          if (list.length > 0) showDormTooltip(evLike, dateISO, list);
          else hideTooltip();
        } else if (bookingId) {
          const bk = (state.lastBookingById && state.lastBookingById.get(bookingId)) || state.bookings.find((b) => b.id === bookingId);
          if (bk) showBookingTooltip(evLike, bk);
          else hideTooltip();
        }
      }, 65);
    });

    $("calendar-tbody").addEventListener("mousemove", (e) => {
      tipMouseX = e.clientX;
      tipMouseY = e.clientY;
      if (tipVisible) scheduleTooltipPos(e.clientX, e.clientY);
    }, { passive: true });

    $("calendar-tbody").addEventListener("mouseleave", () => {
      hoveredCell = null;
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
      hideTooltip();
    });

    state._setTipState = (visible, e) => {
      tipVisible = visible;
      if (visible) {
        tooltipEl.classList.add("visible");
        // Measure tooltip height ONCE on content update (never inside mousemove!)
        tipCachedH = tooltipEl.offsetHeight || 180;
        tipMouseX = e.clientX;
        tipMouseY = e.clientY;
        flushTooltipPos();
      } else {
        tooltipEl.classList.remove("visible");
        if (tipRafId) { cancelAnimationFrame(tipRafId); tipRafId = 0; }
      }
    };
  }

  /* -------------------- Tooltips -------------------- */

  function showBookingTooltip(e, bk) {
    const room = getRoomById(bk.roomId), rem = getRemaining(bk), nights = diffNights(bk.checkin, bk.checkout);
    const statusLabel = rem === 0 && parseVND(bk.totalAmount) > 0 ? "Đã thanh toán hết" : parseVND(bk.paidAmount) > 0 ? "Đã đặt cọc" : "Chưa thanh toán";
    const extras = [];
    if (bk.mergeBed && room && room.type === "Twins") extras.push("Ghép giường (→ Double)");
    if (Number(bk.extraBed) > 0) extras.push(`+${bk.extraBed} Extra bed`);
    const normCode = bk.bookingCode ? normalizeGroupCode(bk.bookingCode) : "";
    const groupSummary = normCode
      ? ((state.lastGroupMap && state.lastGroupMap.get(normCode)) || computeBookingGroupSummary(state.bookings, bk.bookingCode))
      : null;
    const isGroup = Boolean(groupSummary && groupSummary.roomCount >= 2);
    const grpStatusLabel = isGroup
      ? (groupSummary.remaining === 0 && groupSummary.totalAmount > 0 ? "Đã thanh toán đủ cả đoàn" : groupSummary.paidAmount > 0 ? "Đã đặt cọc (cả đoàn)" : "Chưa thanh toán (cả đoàn)")
      : "";

    $("cell-tooltip").innerHTML = `
      <div class="tt-head">
        <span class="tt-title">P.${escapeHtml(room ? room.name : bk.roomId)} • ${escapeHtml(bk.sourceName)}</span>
        <span style="font-size:11px; color:var(--text-muted);">${nights} đêm</span>
      </div>
      ${bk.tourName ? `<div class="tt-row"><span class="tt-label">Tên tour:</span><span class="tt-val">${escapeHtml(bk.tourName)}</span></div>` : ""}
      ${bk.bookingCode ? `<div class="tt-row"><span class="tt-label">Mã đặt phòng:</span><span class="tt-val" style="font-family:monospace;">${escapeHtml(bk.bookingCode)}</span></div>` : ""}
      <div class="tt-row"><span class="tt-label">Khách:</span><span class="tt-val">${escapeHtml(bk.guestName)}</span></div>
      ${bk.phone ? `<div class="tt-row"><span class="tt-label">SĐT:</span><span class="tt-val">${escapeHtml(bk.phone)}</span></div>` : ""}
      <div class="tt-row"><span class="tt-label">Lưu trú:</span><span class="tt-val">${formatDateVN(bk.checkin)} → ${formatDateVN(bk.checkout)}</span></div>
      ${isGroup ? `
        <div class="tt-row"><span class="tt-label">Giá phòng này:</span><span class="tt-val">${formatVND(bk.totalAmount)}${bk.includeVat ? ' <span class="vat-mini-tag">+VAT 8%</span>' : ""}</span></div>
        <div style="margin-top:6px; padding:6px 7px; border-radius:6px; background:rgba(79,70,229,0.1); border:1px solid rgba(79,70,229,0.28); font-size:11px;">
          <div style="font-weight:800; color:#4338ca; margin-bottom:2px;">👥 Thanh toán gộp cả đoàn (${groupSummary.roomCount} phòng)</div>
          <div>Tổng tiền đoàn: <strong>${formatVND(groupSummary.totalAmount)}</strong></div>
          <div>${grpStatusLabel}: <strong style="color:var(--status-paid);">${formatVND(groupSummary.paidAmount)}</strong></div>
          <div>Còn nợ cả đoàn: <strong style="color:${groupSummary.remaining > 0 ? "var(--status-unpaid)" : "var(--status-paid)"};">${formatVND(groupSummary.remaining)}</strong></div>
        </div>` : `
        <div class="tt-row"><span class="tt-label">Tổng tiền:</span><span class="tt-val">${formatVND(bk.totalAmount)}${bk.includeVat ? ' <span class="vat-mini-tag">+VAT 8%</span>' : ""}</span></div>
        <div class="tt-row"><span class="tt-label">${statusLabel}:</span><span class="tt-val" style="color:var(--status-paid);">${formatVND(bk.paidAmount)}</span></div>
        <div class="tt-row"><span class="tt-label">Còn nợ:</span><span class="tt-val" style="color:${rem > 0 ? "var(--status-unpaid)" : "var(--status-paid)"};">${formatVND(rem)}</span></div>`}
      ${extras.length ? `<div class="tt-row"><span class="tt-label">Yêu cầu:</span><span class="tt-val">${escapeHtml(extras.join(", "))}</span></div>` : ""}
      ${bk.confirmedBy ? `<div class="tt-row"><span class="tt-label">Người xác nhận:</span><span class="tt-val">${escapeHtml(bk.confirmedBy)}</span></div>` : ""}
      ${bk.confirmationPdf && bk.confirmationPdf.name ? `<div class="tt-row"><span class="tt-label">Xác nhận PDF:</span><span class="tt-val" style="color:var(--status-paid);">📄 ${escapeHtml(bk.confirmationPdf.name)}</span></div>` : ""}
      ${bk.notes ? `<div style="margin-top:6px; padding-top:6px; border-top:1px dashed var(--border-subtle); color:var(--text-secondary); font-size:11.5px;">📝 ${escapeHtml(bk.notes)}</div>` : ""}
      <div style="margin-top:5px; font-size:10.5px; color:var(--text-muted);">Chuột phải để sao chép nhanh ô này</div>
    `;
    if (state._setTipState) state._setTipState(true, e);
  }

  function showDormTooltip(e, dateISO, list) {
    const { map: slotMap } = getDormSlotMapForDate(state.bookings, dateISO);
    const used = Object.keys(slotMap).length;
    const free = Math.max(0, 8 - used);
    $("cell-tooltip").innerHTML = `
      <div class="tt-head">
        <span class="tt-title">Dorm nội bộ • ${formatDateVN(dateISO)}</span>
        <span style="font-weight:700; color:${free === 0 ? "var(--status-unpaid)" : "var(--status-paid)"};">Trống ${free}/8</span>
      </div>
      ${list.map((b) => `<div class="tt-row"><span class="tt-label">Slot ${(b.slots || []).join(",")}: ${escapeHtml(b.guestName)}</span><span class="tt-val">${escapeHtml(b.sourceName)}</span></div>`).join("")}
      <div style="margin-top:6px; font-size:11px; color:var(--text-muted);">Nhấn để mở sơ đồ 8 slot giường tầng</div>
    `;
    if (state._setTipState) state._setTipState(true, e);
  }

  const hideTooltip = () => {
    if (state._setTipState) state._setTipState(false);
    else $("cell-tooltip").classList.remove("visible");
  };

  /* -------------------- Session Draft Preservation (New Booking Form) -------------------- */

  function saveDraft() {
    if ($("field-booking-id").value) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        roomId: $("field-room").value,
        bookingDate: $("field-booking-date").value,
        checkin: $("field-checkin").value,
        checkout: $("field-checkout").value,
        channelKey: state.activeChannelKey,
        sourceCustom: $("field-source-custom").value,
        tourName: $("field-tour-name").value,
        bookingCode: $("field-booking-code").value,
        guestName: $("field-guest-name").value,
        phone: $("field-phone").value,
        guestCount: $("field-guest-count").value,
        totalAmount: $("field-total-amount").value,
        includeVat: $("field-include-vat").checked,
        preVatAmount: $("field-pre-vat-amount").value,
        paidAmount: $("field-paid-amount").value,
        mergeBed: $("field-merge-bed").checked,
        extraBed: $("field-extra-bed").value,
        confirmedBy: $("field-confirmed-by").value,
        notes: $("field-notes").value
      }));
    } catch {}
  }

  function clearDraft() {
    try { sessionStorage.removeItem(DRAFT_KEY); } catch {}
  }

  function loadDraftFor(roomId, checkin) {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (d && d.roomId === roomId && d.checkin === checkin && (d.guestName || d.phone || d.confirmedBy || d.notes)) {
        return d;
      }
    } catch {}
    return null;
  }

  /* -------------------- Regular Room Modal Logic -------------------- */

  function initRoomDropdown() {
    $("field-room").innerHTML = ROOMS.filter((r) => !r.isDorm).map((r) => `<option value="${r.id}">${r.name} — ${r.type} (${r.view})</option>`).join("");
  }

  function initConfirmersDropdown() {
    const optionsHtml = `<option value="">-- Chọn người xác nhận --</option>` +
      CONFIRMERS.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    $("field-confirmed-by").innerHTML = optionsHtml;
    $("dorm-confirmed-by").innerHTML = optionsHtml;
    $("history-filter-confirmer").innerHTML = `<option value="all">Tất cả người xác nhận</option>` +
      CONFIRMERS.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  }

  function setConfirmerValue(selectEl, val) {
    const clean = String(val || "").trim();
    selectEl.querySelectorAll('option[data-legacy="1"]').forEach((o) => o.remove());
    if (clean && !CONFIRMERS.includes(clean)) {
      const opt = document.createElement("option");
      opt.value = clean;
      opt.textContent = clean;
      opt.dataset.legacy = "1";
      selectEl.appendChild(opt);
    }
    selectEl.value = clean;
  }

  function initPlatformChips() {
    $("platform-chips").innerHTML = CHANNELS.map((ch) => `<button type="button" class="chip-btn" data-ch="${ch.key}">${ch.label}</button>`).join("");
    $("platform-chips").querySelectorAll(".chip-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.ch;
        setChannelSelection(key, { focus: key === "other" || key === "tour" || key === "zalo" });
        saveDraft();
      });
    });
  }

  function setChannelSelection(chKey, { customText = null, tourName = null, focus = false } = {}) {
    state.activeChannelKey = chKey;
    $("platform-chips").querySelectorAll(".chip-btn").forEach((b) => b.classList.toggle("active", b.dataset.ch === chKey));
    const isOther = chKey === "other", hasTourField = chKey === "tour" || chKey === "zalo";
    $("wrap-source-custom").style.display = isOther ? "flex" : "none";
    $("wrap-tour-name").style.display = hasTourField ? "flex" : "none";
    $("wrap-booking-code").classList.toggle("full", !isOther && !hasTourField);
    $("field-booking-code").placeholder = CODE_PLACEHOLDERS[chKey] || "Nhập mã đặt phòng";
    if (customText !== null) $("field-source-custom").value = customText;
    if (tourName !== null) $("field-tour-name").value = tourName;
    if (focus) {
      if (isOther) $("field-source-custom").focus();
      else if (hasTourField) $("field-tour-name").focus();
    }
  }

  function setPaymentStatusTab(payStatus, syncPaidField = true) {
    state.activePayStatus = payStatus;
    document.querySelectorAll(".pay-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.pay === payStatus));
    if (syncPaidField) {
      const total = parseVND($("field-total-amount").value);
      if (payStatus === "paid") $("field-paid-amount").value = formatNumberInput(total);
      else if (payStatus === "unpaid") $("field-paid-amount").value = "";
    }
    updatePaymentPreview();
  }

  function syncPcVatDisplay() {
    const includeVat = $("field-include-vat").checked;
    const total = parseVND($("field-total-amount").value);
    const preVat = includeVat ? Math.min(total, parseVND($("field-pre-vat-amount").value)) : total;
    const vatAmt = includeVat ? Math.max(0, total - preVat) : 0;
    $("pc-vat-box").classList.toggle("active", includeVat);
    $("pc-vat-badge").style.display = includeVat ? "inline-flex" : "none";
    $("pc-vat-breakdown").style.display = includeVat ? "flex" : "none";
    $("pc-vat-amount-display").textContent = formatVND(vatAmt);
    $("pc-vat-total-display").textContent = formatVND(total);
  }

  function handlePcVatToggle() {
    const includeVat = $("field-include-vat").checked;
    const wasPaidFull = state.activePayStatus === "paid";
    if (includeVat) {
      const currentTotal = parseVND($("field-total-amount").value);
      const calc = calculateVatBreakdown(currentTotal, true);
      $("field-pre-vat-amount").value = formatNumberInput(calc.preVatAmount);
      $("field-total-amount").value = formatNumberInput(calc.totalAmount);
      if (wasPaidFull) $("field-paid-amount").value = formatNumberInput(calc.totalAmount);
    } else {
      const base = parseVND($("field-pre-vat-amount").value) || extractPreVatFromTotal($("field-total-amount").value).preVatAmount;
      $("field-total-amount").value = formatNumberInput(base);
      $("field-pre-vat-amount").value = "";
      if (wasPaidFull) $("field-paid-amount").value = formatNumberInput(base);
    }
    syncPcVatDisplay();
    updatePaymentPreview();
    saveDraft();
  }

  function updatePaymentPreview() {
    const total = parseVND($("field-total-amount").value), paid = parseVND($("field-paid-amount").value);
    const overpaid = total > 0 && paid > total;
    const rem = Math.max(0, total - paid);
    if (overpaid) {
      $("display-remaining").textContent = `Vượt tổng ${formatVND(paid - total)}!`;
      $("display-remaining").className = "balance-amount owing";
    } else {
      $("display-remaining").textContent = formatVND(rem);
      $("display-remaining").className = `balance-amount ${rem > 0 ? "owing" : "settled"}`;
    }
    state.activePayStatus = total > 0 && paid >= total ? "paid" : paid > 0 ? "deposit" : "unpaid";
    document.querySelectorAll(".pay-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.pay === state.activePayStatus));
    syncPcVatDisplay();
  }

  function updateRoomSpecificFields() {
    const room = getRoomById($("field-room").value);
    if (!room) return;
    $("modal-room-info").textContent = `Phòng ${room.name} • ${room.type} • ${room.view} (${room.bedInfo})`;
    const isTwins = room.type === "Twins";
    $("field-merge-bed").disabled = !isTwins;
    $("card-merge-bed").classList.toggle("disabled", !isTwins);
    if (!isTwins) {
      $("field-merge-bed").checked = false;
      $("merge-bed-hint").textContent = "Chỉ áp dụng cho phòng Twins";
    } else {
      $("merge-bed-hint").textContent = "Ghép 2 giường đơn thành 1 giường đôi";
    }
    if (!$("field-booking-id").value) $("field-guest-count").value = room.defaultGuests;
  }

  function updateNightsDisplay() {
    if ($("field-checkin").value && $("field-checkout").value) {
      const n = diffNights($("field-checkin").value, $("field-checkout").value);
      $("field-nights-readonly").value = Number.isFinite(n) && n > 0 ? `${n} đêm` : "Ngày không hợp lệ";
    }
  }

  function readPdfFileInput(file) {
    return new Promise((resolve) => {
      if (!file) return resolve({ ok: false, error: "Chưa chọn file PDF." });
      const name = String(file.name || "");
      const isPdfType = file.type === "application/pdf" || name.toLowerCase().endsWith(".pdf");
      if (!isPdfType) {
        return resolve({ ok: false, error: "Vui lòng chỉ chọn file định dạng PDF (.pdf)." });
      }
      if (file.size > MAX_CONFIRMATION_PDF_BYTES) {
        return resolve({ ok: false, error: `File PDF quá lớn (${formatFileSize(file.size)}). Dung lượng tối đa là ${formatFileSize(MAX_CONFIRMATION_PDF_BYTES)}.` });
      }
      const reader = new FileReader();
      reader.onload = () => {
        const rawUrl = String(reader.result || "");
        let normalizedUrl = rawUrl;
        if (!normalizedUrl.startsWith("data:application/pdf;base64,")) {
          const commaIdx = normalizedUrl.indexOf(",");
          if (commaIdx > 0) {
            normalizedUrl = `data:application/pdf;base64,${normalizedUrl.slice(commaIdx + 1)}`;
          }
        }
        const checked = sanitizeConfirmationPdf({
          name: name || "xac-nhan-dat-phong.pdf",
          size: file.size,
          dataUrl: normalizedUrl,
          uploadedAt: new Date().toISOString()
        });
        if (!checked.ok) return resolve({ ok: false, error: checked.error });
        resolve({ ok: true, pdf: checked.value });
      };
      reader.onerror = () => resolve({ ok: false, error: "Không thể đọc file PDF. Vui lòng thử lại." });
      reader.readAsDataURL(file);
    });
  }

  function openPdfAttachment(pdfObj) {
    if (!pdfObj || !pdfObj.dataUrl) return;
    try {
      const b64 = pdfObj.dataUrl.slice("data:application/pdf;base64,".length);
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const fileName = pdfObj.name || "xac-nhan-dat-phong.pdf";
      const blobUrl = URL.createObjectURL(blob);

      // Prefer opening in new tab on desktop/Safari; fallback to direct download if popup blocked
      const win = window.open(blobUrl, "_blank", "noopener");
      if (!win) {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch {
      alert("Không thể mở file PDF này trên trình duyệt hiện tại.");
    }
  }

  window.PMSPdfHelper = { readPdfFileInput, openPdfAttachment };

  function syncPdfFieldUI(prefix, pdfObj) {
    const legacyBtn = $(`${prefix}btn-view-legacy-pdf`);
    if (!legacyBtn) return;
    if (pdfObj && pdfObj.dataUrl) {
      legacyBtn.style.display = "inline-flex";
      legacyBtn.title = `Xem file PDF cũ đã đính kèm: ${pdfObj.name || "xac-nhan.pdf"} (${formatFileSize(pdfObj.size || 0)})`;
    } else {
      legacyBtn.style.display = "none";
      legacyBtn.title = "Xem file PDF cũ đã đính kèm trước đây";
    }
  }

  // Shared Booking Confirmation A4 Preview & PDF Export Controller (PC + Mobile)
  const confirmPdfState = {
    targetBooking: null,
    allBookings: [],
    lastData: null
  };

  function collectLivePcRegularDraftBooking() {
    const existingId = $("field-booking-id").value || undefined;
    const chKey = state.activeChannelKey;
    const chObj = CHANNELS.find((c) => c.key === chKey);
    const tourName = (chKey === "tour" || chKey === "zalo") ? $("field-tour-name").value.trim() : "";
    let sourceName = chObj ? chObj.label : "";
    if (chKey === "other") sourceName = $("field-source-custom").value.trim() || "Khác";
    else if (chKey === "tour") sourceName = tourName ? `Gmail ${tourName}` : "Gmail";
    else if (chKey === "zalo") sourceName = tourName ? `Zalo ${tourName}` : "Zalo";

    const includeVat = $("field-include-vat").checked;
    const checkin = $("field-checkin").value || getTodayISO();
    const checkout = $("field-checkout").value || addDaysISO(checkin, 1);

    return {
      id: existingId,
      roomId: $("field-room").value || ROOMS[0].id,
      bookingDate: $("field-booking-date").value || getTodayISO(),
      checkin,
      checkout,
      channelKey: chKey,
      sourceName,
      tourName,
      bookingCode: $("field-booking-code").value.trim(),
      guestName: $("field-guest-name").value.trim(),
      phone: $("field-phone").value.trim(),
      guestCount: parseInt($("field-guest-count").value, 10) || 2,
      totalAmount: parseVND($("field-total-amount").value),
      includeVat,
      preVatAmount: includeVat ? parseVND($("field-pre-vat-amount").value) : parseVND($("field-total-amount").value),
      paidAmount: parseVND($("field-paid-amount").value),
      depositDueDate: ($("field-deposit-due-date") && $("field-deposit-due-date").value) || "",
      paymentDueDate: ($("field-payment-due-date") && $("field-payment-due-date").value) || "",
      paymentStatus: state.activePayStatus,
      mergeBed: $("field-merge-bed").checked,
      extraBed: parseInt($("field-extra-bed").value, 10) || 0,
      confirmedBy: $("field-confirmed-by").value,
      notes: $("field-notes").value
    };
  }

  function collectLivePcDormDraftBooking() {
    const existingId = $("dorm-field-id").value || undefined;
    const chKey = $("dorm-source-type").value;
    const tourOrCustom = $("dorm-tour-name").value.trim();
    let sourceName = "Dorm nội bộ", tourName = "";
    if (chKey === "tour") { tourName = tourOrCustom; sourceName = tourOrCustom ? `Gmail ${tourOrCustom}` : "Gmail"; }
    else if (chKey === "walkin") sourceName = "Nội bộ / Khách lẻ";
    else if (chKey === "zalo") { tourName = tourOrCustom; sourceName = tourOrCustom ? `Zalo ${tourOrCustom}` : "Zalo"; }
    else sourceName = tourOrCustom || "Nguồn khác";

    const checkin = $("dorm-checkin").value || state.activeDormDate || getTodayISO();
    const checkout = $("dorm-checkout").value || addDaysISO(checkin, 1);
    const slots = state.dormSelectedSlots && state.dormSelectedSlots.length > 0 ? [...state.dormSelectedSlots] : [1];

    return {
      id: existingId,
      roomId: "DORM",
      bookingDate: $("dorm-booking-date").value || getTodayISO(),
      checkin,
      checkout,
      channelKey: chKey,
      sourceName,
      tourName,
      bookingCode: $("dorm-booking-code").value.trim(),
      guestName: $("dorm-guest-name").value.trim(),
      phone: $("dorm-phone").value.trim(),
      slots,
      dormBeds: slots.length,
      guestCount: slots.length,
      totalAmount: parseVND($("dorm-total-amount").value),
      includeVat: false,
      preVatAmount: parseVND($("dorm-total-amount").value),
      paidAmount: parseVND($("dorm-paid-amount").value),
      confirmedBy: $("dorm-confirmed-by").value,
      notes: $("dorm-notes").value
    };
  }

  function buildConfirmationSlug(data) {
    const raw = (data && (data.bookingCode || data.recipientName)) || "booking";
    const ascii = String(raw)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return ascii || "booking";
  }

  function renderConfirmationPdfPreview() {
    if (!confirmPdfState.targetBooking) return;
    const scopeVal = $("cpdf-scope").value;
    const discountPercent = Math.min(100, Math.max(0, Number($("cpdf-discount").value) || 0));
    const vatVal = $("cpdf-vat").value;
    const vatOverride = vatVal === "0" ? 0 : (vatVal === "8" ? 8 : null);
    const extraBedRate = parseVND($("cpdf-eb-rate").value);

    const data = buildBookingConfirmationData(confirmPdfState.targetBooking, confirmPdfState.allBookings, {
      includeGroup: scopeVal !== "single",
      discountPercent,
      vatOverride,
      extraBedRate
    });
    confirmPdfState.lastData = data;
    if (!data) return;

    const scopeWrap = $("cpdf-scope-wrap");
    if (scopeWrap) {
      scopeWrap.style.display = data.isMultiRoomGroup ? "inline-flex" : "none";
      const grpOpt = $("cpdf-scope").querySelector('option[value="group"]');
      if (grpOpt) grpOpt.textContent = `Cả đoàn (${data.groupRoomCount} phòng)`;
    }

    const ebWrap = $("cpdf-eb-wrap");
    if (ebWrap) {
      ebWrap.style.display = data.totalExtraBeds > 0 ? "inline-flex" : "none";
    }

    $("confirm-pdf-sub").textContent = data.isMultiRoomGroup && data.includeGroup
      ? `Mã ${data.bookingCode || "(chưa nhập mã)"} • Gộp ${data.groupRoomCount} phòng • Tổng thanh toán: ${formatVND(data.grandTotal)}`
      : `Khách: ${data.recipientName} • Tổng thanh toán: ${formatVND(data.grandTotal)} • Còn lại: ${formatVND(data.paymentLeft)}`;

    $("confirm-pdf-preview").innerHTML = renderBookingConfirmationHtml(data, { standalone: false });
  }

  function openConfirmationPdfModal(targetBooking, allBookingsList) {
    if (!userCan("bookings:pdf")) {
      showToast("Tài khoản của bạn không có quyền xuất phiếu xác nhận đặt phòng.");
      return;
    }
    if (!targetBooking) return;
    const latestBookings = Array.isArray(allBookingsList) && allBookingsList.length
      ? allBookingsList
      : store.refreshLatest();

    confirmPdfState.targetBooking = { ...targetBooking };
    confirmPdfState.allBookings = latestBookings;

    $("cpdf-scope").value = "group";
    $("cpdf-discount").value = "0";
    $("cpdf-vat").value = "auto";
    $("cpdf-eb-rate").value = "";

    renderConfirmationPdfPreview();
    $("confirm-pdf-modal").classList.add("open");
  }

  function printConfirmationPdf() {
    renderConfirmationPdfPreview();
    const data = confirmPdfState.lastData;
    if (!data) return;

    const printRoot = $("confirm-pdf-print-root");
    const prevTitle = document.title;
    const filenameSlug = buildConfirmationSlug(data);
    printRoot.innerHTML = renderBookingConfirmationHtml(data, { standalone: false });
    document.body.classList.add("printing-confirmation");
    document.title = `Xac-nhan-dat-phong-${filenameSlug}`;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.body.classList.remove("printing-confirmation");
      printRoot.innerHTML = "";
      document.title = prevTitle;
    };

    window.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(() => {
      try {
        window.print();
      } catch (err) {
        logDiagnostic("error", "Print confirmation failed", err);
        cleanup();
        showToast("Không mở được hộp thoại in PDF trên trình duyệt này — hãy dùng nút Tải file phiếu (.html).");
        return;
      }
      setTimeout(cleanup, 1500);
    }, 60);
  }

  function downloadConfirmationHtml() {
    renderConfirmationPdfPreview();
    const data = confirmPdfState.lastData;
    if (!data) return;
    const html = renderBookingConfirmationHtml(data, { standalone: true });
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Xac-nhan-dat-phong-${buildConfirmationSlug(data)}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    showToast("Đã tải file phiếu xác nhận (.html) — mở file và nhấn In → Lưu PDF bất cứ lúc nào");
  }

  window.PMSConfirmationModal = {
    open: openConfirmationPdfModal
  };

  /* -------------------- Operating Costs & COGS Controller (Shared PC & Mobile) -------------------- */

  const costsState = {
    monthKey: getCurrentMonthKey(),
    activeTab: "overview", // "overview" | "voucher" | "items"
    expandedItems: new Set(),
    isSaving: false
  };

  function getActorStaffName() {
    const st = typeof store.getStatus === "function" ? store.getStatus() : null;
    return (st && st.user && st.user.staffName) || "Quản lý";
  }

  function shiftMonthKey(monthKey, deltaMonths) {
    const base = isValidMonthKey(monthKey) ? monthKey : getCurrentMonthKey();
    const [y, m] = base.split("-").map(Number);
    const d = new Date(y, m - 1 + deltaMonths, 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  function getCurrentOperatingCosts() {
    if (typeof store.getOperatingCosts === "function") {
      return store.getOperatingCosts();
    }
    return createDefaultOperatingCostsState();
  }

  function setCostsTab(tabName) {
    costsState.activeTab = tabName;
    $("costs-pane-overview").style.display = tabName === "overview" ? "block" : "none";
    $("costs-pane-voucher").style.display = tabName === "voucher" ? "block" : "none";
    $("costs-pane-items").style.display = tabName === "items" ? "block" : "none";
    $("btn-costs-tab-overview").classList.toggle("active", tabName === "overview");
    $("btn-costs-tab-voucher").classList.toggle("active", tabName === "voucher");
    $("btn-costs-tab-items").classList.toggle("active", tabName === "items");
  }

  function showCostVoucherError(msg) {
    $("cv-error").textContent = msg || "";
    $("cv-error").classList.toggle("show", Boolean(msg));
  }

  function showCostItemError(msg) {
    $("ci-error").textContent = msg || "";
    $("ci-error").classList.toggle("show", Boolean(msg));
  }

  function populateCostVoucherItemOptions(preselectItemId = "") {
    const costData = getCurrentOperatingCosts();
    const prevVal = preselectItemId || $("cv-item-id").value;
    const selectableItems = costData.items.filter((it) => it.active !== false || it.id === prevVal);
    $("cv-item-id").innerHTML = selectableItems
      .map((it) => `<option value="${escapeHtml(it.id)}">${escapeHtml(it.name)}${it.active === false ? " [Đã ẩn]" : ""} (${escapeHtml((COST_CALC_MODES[it.calcMode] || COST_CALC_MODES.monthly).label)})</option>`)
      .join("");
    if (prevVal && selectableItems.some((it) => it.id === prevVal)) {
      $("cv-item-id").value = prevVal;
    }
  }

  function resetCostVoucherForm(editVoucher = null, preselectItemId = "") {
    showCostVoucherError("");
    if (editVoucher) {
      populateCostVoucherItemOptions(editVoucher.itemId);
      $("cv-id").value = editVoucher.id;
      $("cv-form-title").textContent = "✏️ Sửa chứng từ chi phí thực tế";
      $("btn-cv-reset").style.display = "inline-flex";
      $("btn-cv-save").textContent = "💾 Cập nhật chứng từ";
      $("cv-item-id").value = editVoucher.itemId;
      $("cv-expense-date").value = editVoucher.expenseDate || getTodayISO();
      $("cv-accounting-month").value = editVoucher.accountingMonth || costsState.monthKey;
      $("cv-amount").value = formatNumberInput(editVoucher.amount);
      $("cv-note").value = editVoucher.note || "";
    } else {
      populateCostVoucherItemOptions(preselectItemId);
      $("cv-id").value = "";
      $("cv-form-title").textContent = "🧾 Ghi nhận chứng từ chi phí thực tế";
      $("btn-cv-reset").style.display = "none";
      $("btn-cv-save").textContent = "💾 Lưu chứng từ thực tế";
      $("cv-expense-date").value = getTodayISO();
      $("cv-accounting-month").value = costsState.monthKey;
      $("cv-amount").value = "";
      $("cv-note").value = "";
    }
  }

  function resetCostItemForm(editItem = null) {
    showCostItemError("");
    if (editItem) {
      $("ci-id").value = editItem.id;
      $("ci-form-title").textContent = `✏️ Sửa khoản mục & định mức — ${editItem.name}`;
      $("ci-name").value = editItem.name;
      $("ci-calc-mode").value = editItem.calcMode || "monthly";
      const eff = Core.getEffectiveCostRate(editItem, costsState.monthKey);
      $("ci-rate").value = eff.rate > 0 ? formatNumberInput(eff.rate) : "";
      $("ci-effective-month").value = costsState.monthKey;
    } else {
      $("ci-id").value = "";
      $("ci-form-title").textContent = "⚙️ Thêm khoản mục mới & cấu hình định mức";
      $("ci-name").value = "";
      $("ci-calc-mode").value = "guest_night";
      $("ci-rate").value = "";
      $("ci-effective-month").value = costsState.monthKey;
    }
  }

  function exportOperatingCostsCSV() {
    const costData = getCurrentOperatingCosts();
    const bookings = typeof store.getBookings === "function" ? store.getBookings() : state.bookings;
    const fState = typeof store.getFinanceState === "function" ? store.getFinanceState() : null;
    const report = computeMonthlyOperatingCosts(costData, bookings, costsState.monthKey, fState);
    const csv = generateOperatingCostsCsvContent(report);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chi-phi-van-hanh-${report.monthKey}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Đã xuất báo cáo chi phí tháng ${report.monthLabelVN} ra Excel (CSV)`);
  }

  function renderOperatingCostsModal() {
    const costData = getCurrentOperatingCosts();
    const bookings = typeof store.getBookings === "function" ? store.getBookings() : state.bookings;
    const fState = typeof store.getFinanceState === "function" ? store.getFinanceState() : null;
    const report = computeMonthlyOperatingCosts(costData, bookings, costsState.monthKey, fState);

    $("costs-month-picker").value = report.monthKey;
    const staffName = getActorStaffName();
    $("costs-modal-sub").textContent = `Tháng ${report.monthLabelVN} • Người thao tác: ${staffName} • Đồng bộ từ lưu trú & Hóa đơn nhà cung cấp`;

    // 5 Monthly KPI Cards
    $("costs-kpi-total").textContent = formatVND(report.totalMonthlyCost);
    $("costs-kpi-total-sub").textContent = report.missingBasisCount > 0
      ? `${report.rows.length} khoản mục • ${report.missingBasisCount} khoản chưa có định mức`
      : `${report.rows.length} khoản mục đang theo dõi`;
    $("costs-kpi-actual").textContent = formatVND(report.totalActualPortion);
    $("costs-kpi-actual-sub").textContent = report.totalEnteredActual > report.totalActualPortion
      ? `${report.finalizedCount} khoản đã chốt${report.finalizedZeroCount > 0 ? ` (${report.finalizedZeroCount} chốt 0 đ)` : ""} • Tổng chứng từ: ${formatVND(report.totalEnteredActual)}`
      : `${report.finalizedCount} khoản mục đã chốt${report.finalizedZeroCount > 0 ? ` (${report.finalizedZeroCount} chốt 0 đ)` : ""}`;
    $("costs-kpi-estimated").textContent = formatVND(report.totalEstimatedPortion);
    $("costs-kpi-estimated-sub").textContent = `${report.estimatedCount} ước tính • ${report.missingBasisCount} chưa có ĐM`;
    $("costs-kpi-nights").textContent = `${report.soldRoomNights} đêm phòng`;
    $("costs-kpi-guests").textContent = `${report.guestNights} khách-đêm`;
    $("costs-kpi-avg").textContent = report.costPerRoomNight !== null ? formatVND(report.costPerRoomNight) : "Chưa có đêm phòng";

    // Compact Prorated Room Revenue & Margin Strip + Strict Profit Readiness Check
    const profitNum = Math.round(Number(report.estimatedGrossProfit) || 0);
    const profitCls = profitNum >= 0 ? "pos" : "neg";
    const profitText = profitNum < 0
      ? `-${formatVND(Math.abs(profitNum))}`
      : (profitNum > 0 ? `+${formatVND(profitNum)}` : formatVND(0));
    const ratioText = report.costToRevenuePercent !== null ? `${report.costToRevenuePercent}%` : "Chưa có doanh thu";
    const missingItemsHint = (report.missingBasisItems || []).map((m) => m.name).join(", ");
    const pnlReadinessBanner = !report.profitBasisSufficient
      ? `<div class="costs-pnl-warn" id="costs-profit-status-banner" data-profit-sufficient="0">
           <span>⚠️ <strong>${escapeHtml(report.profitStatusLabel)}</strong> — còn <strong>${report.missingBasisCount}</strong> khoản mục thiếu định mức/chưa chốt thực tế${missingItemsHint ? ` (${escapeHtml(missingItemsHint)})` : ""}${report.missingGuestBasis ? " và có đơn thiếu số khách ở" : ""}.</span>
           <span style="font-size:11px; font-weight:600;">Hãy nhập định mức, tạo hóa đơn NCC hoặc bấm "Chốt theo thực tế" (= 0 đ nếu không phát sinh).</span>
         </div>`
      : `<span class="costs-status-badge actual" id="costs-profit-status-banner" data-profit-sufficient="1">✓ ${escapeHtml(report.profitStatusLabel)}</span>`;
    $("costs-pnl-strip").innerHTML = `
      <span class="costs-pnl-item">Doanh thu phòng (phân bổ T${escapeHtml(report.monthLabelVN)}): <span class="costs-pnl-val">${formatVND(report.proratedRoomRevenue)}</span></span>
      <span class="costs-pnl-item">${report.profitBasisSufficient ? "Lãi gộp tạm tính:" : "Chênh lệch tạm (chưa đủ dữ liệu):"} <span class="costs-pnl-val ${profitCls}">${profitText}</span></span>
      <span class="costs-pnl-item">Tỷ lệ Chi phí / Doanh thu: <span class="costs-pnl-val">${escapeHtml(ratioText)}</span></span>
      ${pnlReadinessBanner}
    `;

    // Missing guest count warning banner with clickable booking chips
    const missBanner = $("costs-missing-guests-banner");
    if (report.stay.missingGuestBookings.length > 0) {
      const chipsHtml = report.stay.missingGuestBookings.map((m) =>
        m.id
          ? `<button type="button" class="costs-miss-btn" data-cost-jump-booking="${escapeHtml(m.id)}" title="Mở đơn để bổ sung số khách thực ở">P.${escapeHtml(m.roomId)} • ${escapeHtml(m.guestName)} (${formatDateVN(m.checkin)}→${formatDateVN(m.checkout)}, ${m.nightsInMonth} đêm) ↗</button>`
          : `<span class="costs-miss-btn">P.${escapeHtml(m.roomId)} • ${escapeHtml(m.guestName)} (${m.nightsInMonth} đêm)</span>`
      ).join("");
      missBanner.innerHTML = `<div>⚠️ <strong>Thiếu số khách thực ở</strong> ở ${report.stay.missingGuestBookings.length} đơn (${report.stay.missingGuestRoomNights} đêm phòng) nên các khoản tính <em>Theo khách-đêm</em> chưa cộng đủ. Nhấn vào đơn bên dưới để mở và bổ sung ngay:</div><div style="margin-top:4px;">${chipsHtml}</div>`;
      missBanner.classList.add("show");
    } else {
      missBanner.innerHTML = "";
      missBanner.classList.remove("show");
    }

    // Main Table Rows (Expandable with 4-way costBasisStatus)
    const tbodyParts = [];
    for (const r of report.rows) {
      const expanded = costsState.expandedItems.has(r.itemId);
      const estDisplay = r.hasRate ? formatVND(r.estimatedAmount) : `<span style="color:#b91c1c; font-weight:600;">Chưa nhập ĐM</span>`;
      const actDisplay = (r.entriesCount > 0 || r.isFinalized)
        ? `${formatVND(r.actualAmount)}${r.entriesCount > 0 ? `<div style="font-size:10.5px; color:var(--text-muted);">${r.entriesCount} chứng từ${r.invoiceLinesCount > 0 ? ` (${r.invoiceLinesCount} HĐ NCC)` : ""}</div>` : ""}`
        : `<span style="color:var(--text-muted);">—</span>`;
      let usedBadge = `<span class="costs-status-badge estimated">Có ước tính</span>`;
      if (r.costBasisStatus === "finalized_zero") {
        usedBadge = `<span class="costs-status-badge zero">✓ Thực tế = 0 đ</span>`;
      } else if (r.costBasisStatus === "finalized_actual") {
        usedBadge = `<span class="costs-status-badge actual">✓ Đã chốt thực tế</span>`;
      } else if (r.costBasisStatus === "missing_basis") {
        usedBadge = `<span class="costs-status-badge missing">Chưa nhập định mức</span>`;
      }
      const partialPill = r.isPartialActual
        ? `<span class="costs-status-badge partial" title="Đã có chứng từ / hóa đơn NCC nhưng chưa chốt thực tế">Mới nhập 1 phần • Chưa chốt</span>`
        : "";

      tbodyParts.push(`
        <tr class="costs-row-main" data-cost-expand="${escapeHtml(r.itemId)}" data-cost-basis-status="${escapeHtml(r.costBasisStatus)}">
          <td>
            <div class="costs-item-title">
              <span>${expanded ? "▾" : "▸"}</span>
              <span>${escapeHtml(r.name)}</span>
              <span class="costs-mode-pill">${escapeHtml(r.calcModeLabel)}</span>
              ${partialPill}
            </div>
          </td>
          <td class="num">${estDisplay}</td>
          <td class="num">${actDisplay}</td>
          <td class="num">
            <div style="font-weight:800;">${r.costBasisStatus === "missing_basis" ? "—" : formatVND(r.usedAmount)}</div>
            <div>${usedBadge}</div>
          </td>
          <td style="text-align:center;">
            <button type="button" class="btn btn-sm ${r.isFinalized ? "btn-success" : ""}" data-cost-finalize="${escapeHtml(r.itemId)}" data-next-finalized="${r.isFinalized ? "0" : "1"}">
              ${r.isFinalized ? "✓ Đã chốt" : "Chốt theo thực tế"}
            </button>
          </td>
        </tr>`);

      if (expanded) {
        const rateInfoTxt = r.hasRate
          ? `${formatVND(r.rate)} (${escapeHtml(r.unitLabel)} • áp dụng từ ${formatMonthVN(r.rateEffectiveMonth)})`
          : "Chưa nhập định mức (hãy nhập định mức, gắn hóa đơn NCC hoặc chốt thực tế = 0 đ)";
        const vouchersHtml = r.entries.length > 0
          ? r.entries.map((v) => {
              if (v.sourceType === "supplier_invoice") {
                return `
                  <div class="costs-voucher-item">
                    <div>
                      <span class="fin-pill info" style="margin-right:4px;">Hóa đơn NCC</span>
                      <strong>${formatVND(v.amount)}</strong>
                      <span style="color:var(--text-muted); margin-left:6px;">HĐ ${escapeHtml(v.voucherNo || "")} • ${escapeHtml(v.supplierName || "")} • Ngày HĐ: ${formatDateVN(v.expenseDate)}</span>
                      ${v.note ? `<div style="color:var(--text-secondary); margin-top:2px;">📝 ${escapeHtml(v.note)}</div>` : ""}
                    </div>
                    <div class="costs-voucher-actions">
                      <button type="button" class="btn btn-sm" data-cost-jump-invoice="${escapeHtml(v.invoiceId)}">Mở HĐ ${escapeHtml(v.voucherNo || "")} ↗</button>
                    </div>
                  </div>`;
              }
              return `
                <div class="costs-voucher-item">
                  <div>
                    <strong>${formatVND(v.amount)}</strong>
                    <span style="color:var(--text-muted); margin-left:6px;">Ngày PS: ${formatDateVN(v.expenseDate)} • Ghi nhận T${formatMonthVN(v.accountingMonth)}</span>
                    ${v.note ? `<div style="color:var(--text-secondary); margin-top:2px;">📝 ${escapeHtml(v.note)}</div>` : ""}
                  </div>
                  <div class="costs-voucher-actions">
                    <button type="button" class="btn btn-sm" data-cost-edit-voucher="${escapeHtml(v.id)}">✏️ Sửa</button>
                    <button type="button" class="btn btn-sm btn-danger" data-cost-del-voucher="${escapeHtml(v.id)}">Xóa</button>
                  </div>
                </div>`;
            }).join("")
          : `<div style="font-size:11.5px; color:var(--text-muted);">Chưa có chứng từ thực tế hoặc hóa đơn NCC nào cho khoản mục này trong tháng ${report.monthLabelVN}.</div>`;

        const linkedLegacyHtml = (r.linkedLegacyEntries || []).length > 0
          ? `<div style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">
               ${r.linkedLegacyEntries.map((lv) => `
                 <div class="costs-legacy-linked">
                   🔗 <strong>Lịch sử chi tay cũ đã liên kết HĐ ${escapeHtml(lv.linkedInvoiceVoucherNo || "")} (KHÔNG cộng trùng):</strong>
                   ${formatVND(lv.amount)} • Ngày ${formatDateVN(lv.expenseDate)} ${lv.note ? `• ${escapeHtml(lv.note)}` : ""}
                 </div>
               `).join("")}
             </div>`
          : "";

        tbodyParts.push(`
          <tr class="costs-detail-row">
            <td colspan="5">
              <div class="costs-detail-box">
                <div class="costs-detail-meta">
                  <span><strong>Số lượng:</strong> ${escapeHtml(r.quantityLabel)}</span>
                  <span><strong>Đơn giá áp dụng:</strong> ${rateInfoTxt}</span>
                  <span><strong>Cách tính ước tính:</strong> ${escapeHtml(r.formulaText)}</span>
                </div>
                ${r.isPartialActual ? `<div style="color:#c2410c; font-weight:600;">⚠️ Đối chiếu: Đã có ${r.entriesCount} chứng từ/HĐ NCC thực tế (${formatVND(r.actualAmount)}) so với ước tính (${r.hasRate ? formatVND(r.estimatedAmount) : "Chưa nhập ĐM"}). Khi đủ chứng từ, bấm "Chốt theo thực tế".</div>` : ""}
                ${r.isFinalized && r.finalizedMeta ? `<div style="color:var(--status-paid); font-weight:600;">✓ Đã chốt dùng số thực tế (${formatVND(r.actualAmount)})${r.finalizedMeta.finalizedBy ? ` bởi ${escapeHtml(r.finalizedMeta.finalizedBy)}` : ""}.</div>` : ""}
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-top:2px;">
                  <strong>Chứng từ &amp; Hóa đơn NCC tháng ${report.monthLabelVN} (${r.entries.length}):</strong>
                  <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button type="button" class="btn btn-sm" data-cost-add-voucher="${escapeHtml(r.itemId)}">+ Thêm chi tay</button>
                    <button type="button" class="btn btn-sm" data-cost-edit-item="${escapeHtml(r.itemId)}">✏️ Sửa định mức</button>
                  </div>
                </div>
                <div class="costs-voucher-list">${vouchersHtml}</div>
                ${linkedLegacyHtml}
              </div>
            </td>
          </tr>`);
      }
    }

    $("costs-table-body").innerHTML = tbodyParts.join("") || `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">Chưa có khoản mục chi phí nào.</td></tr>`;

    // Sync Voucher Tab dropdown & list (preserve active voucher edit fields if user is editing)
    populateCostVoucherItemOptions();
    if (!$("cv-id").value) {
      $("cv-accounting-month").value = report.monthKey;
      if (!$("cv-expense-date").value) $("cv-expense-date").value = getTodayISO();
    }
    const monthVouchers = costData.actualEntries
      .filter((e) => e.accountingMonth === report.monthKey)
      .sort((a, b) => String(b.expenseDate).localeCompare(String(a.expenseDate)));
    const itemNameMap = new Map(costData.items.map((it) => [it.id, it.name]));
    const linkedLegacyIdsSet = new Set();
    if (fState && Array.isArray(fState.supplierInvoices)) {
      for (const inv of fState.supplierInvoices) {
        for (const eid of (inv.linkedLegacyEntryIds || [])) linkedLegacyIdsSet.add(eid);
      }
    }
    $("costs-vouchers-heading").textContent = `Chứng từ thực tế ghi nhận cho tháng ${report.monthLabelVN} (${monthVouchers.length} chứng từ tay • Tổng hiệu lực gồm HĐ NCC: ${formatVND(report.totalEnteredActual)})`;
    $("costs-month-vouchers-list").innerHTML = monthVouchers.length > 0
      ? monthVouchers.map((v) => {
          const isLinked = linkedLegacyIdsSet.has(v.id);
          return `
            <div class="costs-voucher-item ${isLinked ? "costs-legacy-linked" : ""}">
              <div>
                <strong>${escapeHtml(itemNameMap.get(v.itemId) || v.itemId)}</strong> — <strong style="color:var(--accent-primary);">${formatVND(v.amount)}</strong>
                ${isLinked ? '<span class="fin-pill muted" style="margin-left:4px;">Đã liên kết HĐ NCC (không cộng trùng)</span>' : ""}
                <span style="color:var(--text-muted); margin-left:6px;">Ngày PS: ${formatDateVN(v.expenseDate)} • Tháng ghi nhận: ${formatMonthVN(v.accountingMonth)}</span>
                ${v.note ? `<div style="color:var(--text-secondary); margin-top:2px;">📝 ${escapeHtml(v.note)}</div>` : ""}
              </div>
              <div class="costs-voucher-actions">
                <button type="button" class="btn btn-sm" data-cost-edit-voucher="${escapeHtml(v.id)}">✏️ Sửa</button>
                <button type="button" class="btn btn-sm btn-danger" data-cost-del-voucher="${escapeHtml(v.id)}">Xóa</button>
              </div>
            </div>`;
        }).join("")
      : `<div style="font-size:12px; color:var(--text-muted); padding:10px; border:1px dashed var(--border-strong); border-radius:var(--radius-sm);">Chưa có chứng từ chi tay nào cho tháng ${report.monthLabelVN} (hóa đơn NCC được đồng bộ tự động ở tab Bảng chi phí tháng).</div>`;

    // Sync Items & Rates Config Tab list
    $("costs-items-list").innerHTML = costData.items.map((it) => {
      const modeMeta = COST_CALC_MODES[it.calcMode] || COST_CALC_MODES.monthly;
      const eff = Core.getEffectiveCostRate(it, report.monthKey);
      const canDelRate = (it.rateHistory || []).length > 1;
      const histHtml = (it.rateHistory || []).map((h) => `
        <span class="costs-rate-pill">
          <span>Từ ${formatMonthVN(h.effectiveMonth)}: <strong>${h.rate > 0 ? formatVND(h.rate) : "0 đ (nhập thực tế)"}</strong></span>
          ${canDelRate ? `<button type="button" class="costs-rate-del" data-cost-del-rate-item="${escapeHtml(it.id)}" data-cost-del-rate-month="${escapeHtml(h.effectiveMonth)}" title="Xóa mốc định mức từ ${formatMonthVN(h.effectiveMonth)}">✕</button>` : ""}
        </span>`).join("");
      const isInactive = it.active === false;
      return `
        <div class="costs-item-cfg-row ${isInactive ? "inactive" : ""}">
          <div>
            <div style="font-weight:700;">
              ${escapeHtml(it.name)}
              <span class="costs-mode-pill">${escapeHtml(modeMeta.label)}</span>
              ${isInactive ? `<span class="costs-mode-pill">Đã ẩn</span>` : ""}
            </div>
            <div style="font-size:11.5px; color:var(--text-secondary); margin-top:2px;">
              Mức áp dụng T${report.monthLabelVN}: <strong>${eff.hasRate ? `${formatVND(eff.rate)} (${escapeHtml(modeMeta.unitLabel)})` : "Chưa có định mức"}</strong>
            </div>
            <div class="costs-rate-hist">${histHtml}</div>
          </div>
          <div class="costs-item-actions">
            <button type="button" class="btn btn-sm" data-cost-edit-item="${escapeHtml(it.id)}">✏️ Sửa / Đổi định mức</button>
            <button type="button" class="btn btn-sm" data-cost-toggle-active="${escapeHtml(it.id)}" data-next-active="${isInactive ? "1" : "0"}">${isInactive ? "Hiện lại" : "Ẩn"}</button>
          </div>
        </div>`;
    }).join("");
  }

  async function persistOperatingCosts(nextState, toastMsg) {
    if (costsState.isSaving) return { ok: false, error: "Đang lưu dữ liệu chi phí..." };
    costsState.isSaving = true;
    try {
      if (typeof store.saveOperatingCosts !== "function") {
        return { ok: false, error: "Bộ lưu trữ chi phí chưa sẵn sàng." };
      }
      const res = await store.saveOperatingCosts(nextState);
      if (!res || !res.ok) {
        const errMsg = (res && res.error) || "Lưu chi phí vận hành thất bại.";
        showToast(errMsg);
        return { ...(res || {}), ok: false, error: errMsg };
      }
      renderOperatingCostsModal();
      if (toastMsg) showToast(toastMsg);
      return res;
    } finally {
      costsState.isSaving = false;
      if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
    }
  }

  function openOperatingCostsModal(monthKeyOpt) {
    if (!userCan("costs:read")) {
      showToast("Chức năng Chi phí vận hành & giá vốn chỉ dành cho Quản lý.");
      return;
    }
    if (isValidMonthKey(monthKeyOpt)) {
      costsState.monthKey = monthKeyOpt;
    } else if (isPcViewActive()) {
      costsState.monthKey = `${state.year}-${pad2(state.month + 1)}`;
    } else {
      costsState.monthKey = getCurrentMonthKey();
    }
    setCostsTab("overview");
    resetCostItemForm(null);
    resetCostVoucherForm(null);
    renderOperatingCostsModal();
    $("costs-modal").classList.add("open");
  }

  window.PMSOperatingCostsModal = {
    open: openOperatingCostsModal
  };

  function showFormError(msg) {
    $("form-error").textContent = msg || "";
    $("form-error").classList.toggle("show", !!msg);
  }

  async function applyGroupLumpSumPayment(bookingCode, targetPaidRaw) {
    if (state.isSubmitting) return { ok: false, error: "Đang xử lý lưu dữ liệu, vui lòng đợi..." };
    state.isSubmitting = true;
    try {
      state.bookings = store.refreshLatest();
      const summary = computeBookingGroupSummary(state.bookings, bookingCode);
      if (!summary) return { ok: false, error: "Không tìm thấy phòng nào trong mã đoàn này." };
      const alloc = allocateGroupPayment(summary.bookings, targetPaidRaw);
      if (!alloc.ok) return { ok: false, error: alloc.error };

      let updatedCount = 0;
      for (const item of alloc.allocations) {
        if (!item.changed) continue;
        const latestBk = state.bookings.find((b) => b.id === item.id);
        if (!latestBk) continue;
        const nextStatus = item.totalAmount > 0 && item.newPaid >= item.totalAmount
          ? "paid"
          : (item.newPaid > 0 ? "deposit" : "unpaid");
        const saveRes = await store.saveBooking({
          ...latestBk,
          paidAmount: item.newPaid,
          paymentStatus: nextStatus
        }, { expectedRevision: Number(latestBk.revision) || 1 });
        if (!saveRes.ok) {
          state.bookings = store.refreshLatest();
          renderAll();
          return { ok: false, error: `Lỗi cập nhật P.${getRoomById(latestBk.roomId)?.name || latestBk.roomId}: ${saveRes.error}` };
        }
        state.bookings = saveRes.bookings;
        updatedCount += 1;
      }

      renderAll();
      if (updatedCount > 0) onDataMutated("save");
      const freshSummary = computeBookingGroupSummary(state.bookings, bookingCode);
      return { ok: true, updatedCount, summary: freshSummary };
    } finally {
      state.isSubmitting = false;
    }
  }

  function autofillPcFormFromGroup(summary, { force = false } = {}) {
    if (!summary || !summary.bookings || summary.bookings.length === 0) return false;
    const lead = summary.bookings.find((b) => b.roomId !== "DORM") || summary.bookings[0];
    if (!lead) return false;
    if (!force && $("field-guest-name").value.trim()) return false;

    const chKey = lead.channelKey || detectChannelKey(lead.sourceName);
    const inferredTour = lead.tourName !== undefined ? lead.tourName : ((chKey === "tour" || chKey === "zalo") ? String(lead.sourceName || "").replace(/^(?:Tour|Gmail|Zalo)\s*/i, "") : "");
    setChannelSelection(chKey, {
      customText: chKey === "other" ? (lead.sourceName || "") : "",
      tourName: inferredTour
    });
    $("field-guest-name").value = lead.guestName || "";
    $("field-phone").value = lead.phone || "";
    if (force || !$("field-total-amount").value.trim()) {
      $("field-total-amount").value = formatNumberInput(lead.totalAmount);
      $("field-include-vat").checked = Boolean(lead.includeVat);
      $("field-pre-vat-amount").value = lead.includeVat
        ? formatNumberInput(lead.preVatAmount || extractPreVatFromTotal(lead.totalAmount).preVatAmount)
        : "";
    }
    setConfirmerValue($("field-confirmed-by"), lead.confirmedBy || "");
    if (lead.confirmationPdf && lead.confirmationPdf.dataUrl) {
      state.activeConfirmationPdf = { ...lead.confirmationPdf };
      syncPdfFieldUI("", state.activeConfirmationPdf);
    }
    if (force || !$("field-notes").value.trim()) {
      $("field-notes").value = lead.notes || "";
    }
    updatePaymentPreview();
    saveDraft();
    return true;
  }

  function renderModalGroupSummary() {
    const box = $("pc-group-summary-box");
    if (!box) return;
    const code = ($("field-booking-code").value || "").trim();
    const currentId = $("field-booking-id").value || "";
    const norm = normalizeGroupCode(code);
    const origNorm = state.editingOriginalBooking ? normalizeGroupCode(state.editingOriginalBooking.bookingCode) : "";

    // Look up group by typed code first, or fallback to original group code when user is renaming the group's bookingCode!
    let summary = norm ? computeBookingGroupSummary(state.bookings, norm) : null;
    const origSummary = (currentId && origNorm && origNorm !== norm) ? computeBookingGroupSummary(state.bookings, origNorm) : null;
    const isRenamingGroup = Boolean(currentId && origSummary && origSummary.roomCount >= 2 && norm);
    if (!summary && isRenamingGroup) summary = origSummary;

    if (!norm || !summary) {
      box.style.display = "none";
      return;
    }

    const isExistingMember = Boolean(currentId && (summary.bookings.some((b) => b.id === currentId) || isRenamingGroup));
    const siblingCount = summary.bookings.filter((b) => b.id !== currentId).length;
    const isJoiningNew = !currentId && summary.roomCount >= 1;
    const isMultiSaved = isExistingMember && siblingCount >= 1;

    if (!isJoiningNew && !isMultiSaved && !(currentId && siblingCount >= 1)) {
      box.style.display = "none";
      return;
    }

    // Auto-fill empty new booking fields immediately when typed bookingCode matches an existing group
    if (isJoiningNew && state.lastAutofilledGroupCode !== summary.normalizedCode) {
      if (autofillPcFormFromGroup(summary, { force: false })) {
        state.lastAutofilledGroupCode = summary.normalizedCode;
        showToast(`⚡ Đã tự động điền thông tin từ đoàn ${summary.code}`);
      }
    }

    box.style.display = "flex";
    $("pc-group-title").textContent = isJoiningNew
      ? `👥 Đang ghép vào đoàn ${summary.code} (lưu để tự động gom)`
      : isRenamingGroup
        ? `👥 Đổi mã cả đoàn → ${code} (${summary.roomCount} phòng)`
        : `👥 Tổng hợp cả đoàn — Mã ${summary.code}`;
    $("pc-group-rooms-count").textContent = `${summary.roomCount} phòng • ${summary.totalNights} đêm phòng • ${summary.totalGuests} khách`;

    $("pc-group-rooms-list").innerHTML = summary.bookings.map((b) => {
      const rName = b.roomId === "DORM" ? `Dorm (${(b.slots || []).join(",")})` : `P.${getRoomById(b.roomId)?.name || b.roomId}`;
      const isCur = b.id === currentId;
      const amt = parseVND(b.totalAmount);
      return `<button type="button" class="group-room-chip ${isCur ? "is-current" : ""}" data-jump-booking="${b.id}" title="Nhấn để mở phòng này">
        ${escapeHtml(rName)} (${formatDateVN(b.checkin).slice(0, 5)}→${formatDateVN(b.checkout).slice(0, 5)}) • ${amt > 0 ? formatShortVND(amt) : "0đ"}
      </button>`;
    }).join("");

    const syncWrap = $("pc-group-sync-wrap");
    const syncLabel = $("pc-group-sync-label");
    if (syncWrap && syncLabel) {
      const showSyncToggle = Boolean(currentId && siblingCount >= 1);
      syncWrap.style.display = showSyncToggle ? "flex" : "none";
      if (showSyncToggle) {
        syncLabel.textContent = `Tự động cập nhật thông tin sửa (tên khách, SĐT, nguồn, mã ĐP, người XN, PDF, ghi chú) cho cả ${siblingCount} phòng khác cùng mã đoàn khi Lưu`;
      }
    }

    const autofillWrap = $("pc-group-autofill-wrap");
    if (autofillWrap) {
      autofillWrap.style.display = isJoiningNew ? "block" : "none";
    }

    $("pc-group-total").textContent = formatVND(summary.totalAmount);
    $("pc-group-paid").textContent = formatVND(summary.paidAmount);
    $("pc-group-remaining").textContent = formatVND(summary.remaining);
    $("pc-group-remaining").className = summary.remaining > 0 ? "warn" : "ok";

    // Only show lump-sum payment bar when editing an existing multi-room group (NOT while creating a new unsaved room)
    const lumpRow = box.querySelector(".group-lump-row");
    if (lumpRow) lumpRow.style.display = (isMultiSaved && !isRenamingGroup) ? "flex" : "none";
    if (isMultiSaved && !isRenamingGroup) {
      $("pc-group-lump-input").value = summary.paidAmount > 0 ? formatNumberInput(summary.paidAmount) : "";
      $("btn-pc-group-mark-paid").disabled = summary.remaining <= 0;
    }
  }

  function openGroupReportModal() {
    state.bookings = store.refreshLatest();
    renderGroupReportModal();
    $("group-report-modal").classList.add("open");
  }

  window.PMSGroupReportModal = {
    open: () => openGroupReportModal()
  };

  function renderGroupReportModal() {
    const body = $("group-report-body");
    const summaryEl = $("group-report-summary");
    if (!body || !summaryEl) return;

    const q = ($("group-report-search") ? $("group-report-search").value : "").trim().toLowerCase();
    const allGroups = computeAllBookingGroups(state.bookings, { minRooms: 2 });
    const filtered = allGroups.filter((g) => {
      if (!q) return true;
      const hay = [
        g.code,
        g.leadGuestName,
        g.tourName,
        g.sourceName,
        ...g.bookings.map((b) => `${b.roomId} ${b.guestName} ${b.phone || ""}`)
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });

    const grandDebt = filtered.reduce((s, g) => s + g.remaining, 0);
    summaryEl.textContent = `${filtered.length} đoàn • Còn nợ: ${formatVND(grandDebt)}`;

    if (filtered.length === 0) {
      body.innerHTML = `<div style="padding:28px; text-align:center; color:var(--text-muted); font-size:13px;">
        ${allGroups.length === 0
          ? "Chưa có đoàn nhiều phòng nào. Hãy nhập chung 1 <strong>Mã đặt phòng</strong> cho các phòng trong cùng đoàn (hoặc dùng nút <strong>📋 Sao chép</strong> để dán nhanh)."
          : "Không tìm thấy đoàn nào khớp với từ khóa tìm kiếm."}
      </div>`;
      return;
    }

    body.innerHTML = filtered.map((g) => {
      const rangeStr = `${formatDateVN(g.earliestCheckin)} → ${formatDateVN(g.latestCheckout)}`;
      const statusBadge = g.remaining === 0 && g.totalAmount > 0
        ? `<span class="booking-pay paid">✓ Đã thanh toán đủ cả đoàn</span>`
        : g.paidAmount > 0
          ? `<span class="booking-pay deposit">Đã cọc ${formatShortVND(g.paidAmount)} • Nợ ${formatShortVND(g.remaining)}</span>`
          : `<span class="booking-pay unpaid">Chưa thanh toán • Nợ ${formatShortVND(g.remaining)}</span>`;

      return `<div class="group-card" data-group-code="${escapeHtml(g.code)}">
        <div class="group-card-head">
          <div>
            <div class="group-card-title">👥 Mã đoàn: <span style="font-family:monospace;">${escapeHtml(g.code)}</span> — ${escapeHtml(g.tourName || g.leadGuestName)}</div>
            <div class="group-card-meta">${escapeHtml(g.sourceName)} • ${g.roomCount} phòng (${g.totalNights} đêm phòng • ${g.totalGuests} khách) • ${rangeStr}</div>
          </div>
          <div>${statusBadge}</div>
        </div>

        <table class="group-room-table">
          <thead>
            <tr>
              <th>Phòng</th>
              <th>Khách / Ghi chú</th>
              <th>Nhận → Trả</th>
              <th>Giá phòng</th>
            </tr>
          </thead>
          <tbody>
            ${g.bookings.map((b) => {
              const rLabel = b.roomId === "DORM" ? `Dorm (Slot ${(b.slots || []).join(",")})` : `P.${getRoomById(b.roomId)?.name || b.roomId}`;
              return `<tr>
                <td><button type="button" class="group-room-link" data-group-open-bk="${b.id}">${escapeHtml(rLabel)}</button></td>
                <td>${escapeHtml(b.guestName)}</td>
                <td>${formatDateVN(b.checkin).slice(0, 5)} → ${formatDateVN(b.checkout).slice(0, 5)}</td>
                <td style="font-weight:700;">${formatVND(b.totalAmount)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>

        <div class="group-totals-grid">
          <div><span>Tổng tiền cả đoàn</span><strong>${formatVND(g.totalAmount)}</strong></div>
          <div><span>Đã cọc / Thanh toán</span><strong class="ok">${formatVND(g.paidAmount)}</strong></div>
          <div><span>Còn phải thu cả đoàn</span><strong class="${g.remaining > 0 ? "warn" : "ok"}">${formatVND(g.remaining)}</strong></div>
        </div>

        <div class="group-lump-row">
          <input class="input group-lump-input" type="text" inputmode="numeric" value="${g.paidAmount > 0 ? formatNumberInput(g.paidAmount) : ""}" placeholder="Nhập tổng tiền cọc / thanh toán cả đoàn (VNĐ)..." />
          <button type="button" class="btn btn-sm btn-primary" data-group-allocate="${escapeHtml(g.code)}">Cập nhật TT đoàn</button>
          <button type="button" class="btn btn-sm btn-success" data-group-mark-paid="${escapeHtml(g.code)}" ${g.remaining <= 0 ? "disabled" : ""}>✓ Thu đủ đoàn</button>
        </div>
      </div>`;
    }).join("");
  }

  function renderPcBookingOperationalBars(roomId, bookingObj) {
    const warnEl = $("pc-room-issue-warning");
    const coBar = $("pc-checkout-bar");
    const coStatus = $("pc-checkout-status");
    const coBtn = $("btn-checkout-booking");
    const stayBtn = $("btn-request-stayover");

    if (warnEl) {
      const ops = computeRoomOperationalStatus(
        roomId,
        typeof store.getHousekeepingTasks === "function" ? store.getHousekeepingTasks() : [],
        typeof store.getMaintenanceIssues === "function" ? store.getMaintenanceIssues() : [],
        getTodayISO()
      );
      if (ops && ops.activeIssues.length > 0) {
        const lines = ops.activeIssues.map((iss) => {
          const sev = (ISSUE_SEVERITIES[iss.severity] || ISSUE_SEVERITIES.medium).label;
          const stLbl = (ISSUE_STATUSES[iss.status] || ISSUE_STATUSES.open).label;
          const blk = iss.blocksRoom ? "<strong>[Chưa thể giao khách]</strong> " : "";
          return `<div>• ${blk}${escapeHtml(iss.description)} <span style="opacity:0.85;">(${escapeHtml(sev)} • ${escapeHtml(stLbl)})</span></div>`;
        }).join("");
        const headerTxt = ops.isBlocked
          ? `🚫 CẢNH BÁO PHÒNG ${escapeHtml(getRoomById(roomId)?.name || roomId)} CHƯA THỂ GIAO KHÁCH MỚI (${ops.blockingIssues.length} sự cố đang mở)`
          : `⚠️ Phòng ${escapeHtml(getRoomById(roomId)?.name || roomId)} đang có ${ops.activeIssues.length} sự cố cần lưu ý`;
        warnEl.innerHTML = `<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px; flex-wrap:wrap;">
          <div><div>${headerTxt}</div><div style="margin-top:3px; font-weight:600;">${lines}</div></div>
          <button type="button" class="btn btn-sm" data-pc-jump-issues="${escapeHtml(roomId)}">Xem sự cố</button>
        </div>`;
        warnEl.style.display = "block";
      } else {
        warnEl.innerHTML = "";
        warnEl.style.display = "none";
      }
    }

    if (coBar && coStatus && coBtn && stayBtn) {
      if (bookingObj && bookingObj.id && bookingObj.roomId !== "DORM" && userCan("bookings:checkout")) {
        coBar.style.display = "flex";
        if (bookingObj.checkedOutAt) {
          coStatus.innerHTML = `<span style="color:var(--status-paid);">✓ Đã xác nhận trả phòng lúc ${escapeHtml(formatTimestampVN(bookingObj.checkedOutAt))}${bookingObj.checkedOutBy ? ` (${escapeHtml(bookingObj.checkedOutBy)})` : ""}</span> • Đã tạo việc Dọn sau trả phòng`;
          coBtn.textContent = "✓ Đã Check-out";
          coBtn.classList.remove("btn-primary");
          coBtn.classList.add("btn-success");
        } else {
          coStatus.textContent = "Khách đang ở / chưa check-out phòng này";
          coBtn.textContent = "🚪 Xác nhận trả phòng (Check-out)";
          coBtn.classList.add("btn-primary");
          coBtn.classList.remove("btn-success");
        }
        stayBtn.style.display = userCan("housekeeping:create") ? "inline-flex" : "none";
      } else {
        coBar.style.display = "none";
      }
    }
  }

  function openBookingModal({ bookingId = null, roomId = "101", checkin = getTodayISO(), prefill = null, allowRoomSelect = false } = {}) {
    if (!userCan("bookings:read")) {
      showToast("Tài khoản của bạn không có quyền xem hoặc chỉnh sửa đặt phòng.");
      return;
    }
    showFormError("");
    state.bookings = store.refreshLatest();
    const existing = bookingId ? state.bookings.find((b) => b.id === bookingId) : null;
    state.activeIdempotencyKey = newIdempotencyKey("bk_sub");
    state.lastAutofilledGroupCode = "";
    if ($("chk-pc-sync-group")) $("chk-pc-sync-group").checked = true;
    $("wrap-field-room").style.display = (allowRoomSelect && !existing) ? "flex" : "none";

    if (existing) {
      if (existing.roomId === "DORM") return openDormSlotForm({ bookingId: existing.id });
      state.editingBookingRevision = Number(existing.revision) || 1;
      state.editingOriginalBooking = {
        ...existing,
        confirmationPdf: existing.confirmationPdf ? { ...existing.confirmationPdf } : null
      };
      $("modal-heading").textContent = `Chi tiết đặt phòng — P.${getRoomById(existing.roomId)?.name || existing.roomId}`;
      $("field-booking-id").value = existing.id;
      $("field-room").value = existing.roomId;
      $("field-booking-date").value = existing.bookingDate || (typeof existing.createdAt === "string" && existing.createdAt.length >= 10 ? existing.createdAt.slice(0, 10) : getTodayISO());
      $("field-checkin").value = existing.checkin;
      $("field-checkout").value = existing.checkout;
      const chKey = existing.channelKey || detectChannelKey(existing.sourceName);
      const inferredTour = existing.tourName !== undefined ? existing.tourName : ((chKey === "tour" || chKey === "zalo") ? String(existing.sourceName || "").replace(/^(?:Tour|Gmail|Zalo)\s*/i, "") : "");
      setChannelSelection(chKey, { customText: chKey === "other" ? (existing.sourceName || "") : "", tourName: inferredTour });
      $("field-booking-code").value = existing.bookingCode || "";
      $("field-guest-name").value = existing.guestName || "";
      $("field-phone").value = existing.phone || "";
      $("field-guest-count").value = existing.guestCount || 2;
      $("field-total-amount").value = formatNumberInput(existing.totalAmount);
      $("field-include-vat").checked = Boolean(existing.includeVat);
      $("field-pre-vat-amount").value = existing.includeVat
        ? formatNumberInput(existing.preVatAmount || extractPreVatFromTotal(existing.totalAmount).preVatAmount)
        : "";
      $("field-paid-amount").value = formatNumberInput(existing.paidAmount);
      if ($("field-deposit-due-date")) $("field-deposit-due-date").value = existing.depositDueDate || "";
      if ($("field-payment-due-date")) $("field-payment-due-date").value = existing.paymentDueDate || "";
      setPaymentStatusTab(getPaymentStatus(existing), false);
      $("field-merge-bed").checked = !!existing.mergeBed;
      $("field-extra-bed").value = String(existing.extraBed || 0);
      setConfirmerValue($("field-confirmed-by"), existing.confirmedBy);
      state.activeConfirmationPdf = existing.confirmationPdf ? { ...existing.confirmationPdf } : null;
      syncPdfFieldUI("", state.activeConfirmationPdf);
      $("field-notes").value = existing.notes || "";
      $("btn-delete-booking").style.display = "inline-flex";
      $("btn-copy-booking").style.display = "inline-flex";
      $("btn-mark-paid").style.display = getRemaining(existing) > 0 ? "inline-flex" : "none";
    } else {
      state.editingBookingRevision = null;
      state.editingOriginalBooking = null;
      const room = getRoomById(roomId) || ROOMS[0];
      const draft = prefill || loadDraftFor(room.id, checkin);
      $("modal-heading").textContent = prefill ? `Dán đặt phòng — P.${room.name}` : `Đặt phòng mới — P.${room.name}`;
      $("field-booking-id").value = "";
      $("field-room").value = room.id;
      $("field-booking-date").value = (draft && draft.bookingDate) || getTodayISO();
      $("field-checkin").value = (prefill && prefill.checkin) || checkin;
      $("field-checkout").value = (draft && draft.checkout) || addDaysISO(checkin, 1);
      const chKey = (draft && draft.channelKey) || "booking";
      setChannelSelection(chKey, {
        customText: (draft && (draft.sourceCustom || (chKey === "other" ? draft.sourceName : ""))) || "",
        tourName: (draft && draft.tourName) || ""
      });
      $("field-booking-code").value = (draft && draft.bookingCode) || "";
      $("field-guest-name").value = (draft && draft.guestName) || "";
      $("field-phone").value = (draft && draft.phone) || "";
      $("field-guest-count").value = (draft && draft.guestCount) || room.defaultGuests;
      $("field-total-amount").value = prefill ? formatNumberInput(prefill.totalAmount) : ((draft && draft.totalAmount) || "");
      const initVat = Boolean(draft && draft.includeVat);
      $("field-include-vat").checked = initVat;
      $("field-pre-vat-amount").value = initVat
        ? (prefill ? formatNumberInput(prefill.preVatAmount || extractPreVatFromTotal(prefill.totalAmount).preVatAmount) : (draft.preVatAmount || ""))
        : "";
      $("field-paid-amount").value = prefill ? formatNumberInput(prefill.paidAmount) : ((draft && draft.paidAmount) || "");
      if ($("field-deposit-due-date")) $("field-deposit-due-date").value = (draft && draft.depositDueDate) || "";
      if ($("field-payment-due-date")) $("field-payment-due-date").value = (draft && draft.paymentDueDate) || "";
      setPaymentStatusTab(prefill ? getPaymentStatus(prefill) : "deposit", false);
      $("field-merge-bed").checked = Boolean(draft && draft.mergeBed);
      $("field-extra-bed").value = String((draft && draft.extraBed) || "0");
      setConfirmerValue($("field-confirmed-by"), (draft && draft.confirmedBy) || "");
      state.activeConfirmationPdf = (prefill && prefill.confirmationPdf) ? { ...prefill.confirmationPdf } : null;
      syncPdfFieldUI("", state.activeConfirmationPdf);
      $("field-notes").value = (draft && draft.notes) || "";
      $("btn-delete-booking").style.display = "none";
      $("btn-copy-booking").style.display = "none";
      $("btn-mark-paid").style.display = "none";
      if (!prefill && draft) showToast("Đã khôi phục bản nháp chưa lưu của phòng này");
    }

    updateRoomSpecificFields();
    updateNightsDisplay();
    updatePaymentPreview();
    renderModalGroupSummary();
    renderPcBookingOperationalBars($("field-room").value, existing || null);
    if (window.PMSFinanceApp) {
      if (existing) window.PMSFinanceApp.renderBookingFinancePanel(existing.id);
      else window.PMSFinanceApp.hideBookingFinancePanel();
    }
    $("booking-modal").classList.add("open");
    setTimeout(() => {
      if ($("booking-modal").classList.contains("open") && document.activeElement !== $("field-booking-code")) {
        $("field-guest-name").focus();
      }
    }, 60);
  }

  async function handleSaveBooking(e) {
    e.preventDefault();
    if (state.isSubmitting) return;
    state.isSubmitting = true;
    $("btn-save-booking").disabled = true;

    try {
      showFormError("");
      const existingId = $("field-booking-id").value || undefined;
      const previousBooking = existingId ? state.editingOriginalBooking : null;
      const shouldSyncGroup = Boolean(existingId && (!$("chk-pc-sync-group") || $("chk-pc-sync-group").checked));
      const roomId = $("field-room").value;
      const room = getRoomById(roomId);
      const chKey = state.activeChannelKey;
      const chObj = CHANNELS.find((c) => c.key === chKey);
      const tourName = (chKey === "tour" || chKey === "zalo") ? $("field-tour-name").value.trim() : "";

      let sourceName = chObj ? chObj.label : "";
      if (chKey === "other") {
        sourceName = $("field-source-custom").value.trim();
        if (!sourceName) {
          showFormError("Vui lòng nhập tên nền tảng / đơn vị book.");
          return;
        }
      } else if (chKey === "tour") {
        sourceName = tourName ? `Gmail ${tourName}` : "Gmail";
      } else if (chKey === "zalo") {
        sourceName = tourName ? `Zalo ${tourName}` : "Zalo";
      }

      const payload = {
        id: existingId,
        roomId,
        bookingDate: $("field-booking-date").value || getTodayISO(),
        checkin: $("field-checkin").value,
        checkout: $("field-checkout").value,
        channelKey: chKey,
        sourceName,
        tourName,
        bookingCode: $("field-booking-code").value.trim(),
        guestName: $("field-guest-name").value.trim(),
        phone: $("field-phone").value.trim(),
        guestCount: $("field-guest-count").value,
        totalAmount: $("field-total-amount").value,
        includeVat: $("field-include-vat").checked,
        preVatAmount: $("field-include-vat").checked ? $("field-pre-vat-amount").value : $("field-total-amount").value,
        paidAmount: $("field-paid-amount").value,
        depositDueDate: ($("field-deposit-due-date") && $("field-deposit-due-date").value) || "",
        paymentDueDate: ($("field-payment-due-date") && $("field-payment-due-date").value) || "",
        paymentStatus: state.activePayStatus,
        mergeBed: $("field-merge-bed").checked,
        extraBed: $("field-extra-bed").value,
        confirmedBy: $("field-confirmed-by").value,
        confirmationPdf: state.activeConfirmationPdf,
        notes: $("field-notes").value
      };
      const saveOpts = {
        expectedRevision: existingId ? state.editingBookingRevision : undefined,
        idempotencyKey: existingId ? undefined : state.activeIdempotencyKey
      };

      const res = await store.saveBooking(payload, saveOpts);

      if (!res.ok) {
        showFormError(res.error);
        if (res.code === "CONFLICT_STALE_EDIT") {
          showPcBookingConflict(res.currentBooking);
        }
        if (res.code === "CONFLICT_STALE_EDIT" || res.code === "CONFLICT_OVERBOOKING" || res.code === "CONFLICT_CONCURRENT_WRITE") {
          state.bookings = store.getBookings();
          renderAll();
        }
        return;
      }

      state.bookings = res.bookings;

      // Propagate edited shared group info to ALL sibling rooms sharing this bookingCode
      let syncedSiblings = 0;
      let failedSiblings = 0;
      if (shouldSyncGroup && res.booking) {
        const sibUpdates = buildGroupSyncUpdates(previousBooking, res.booking, state.bookings);
        for (const upd of sibUpdates) {
          let sibRes = await store.saveBooking(upd.payload, { expectedRevision: upd.expectedRevision });
          if (!sibRes.ok && sibRes.code === "CONFLICT_STALE_EDIT") {
            const latestSib = (store.getBookings() || []).find((b) => b.id === upd.id);
            if (latestSib) {
              const retryUpd = buildGroupSyncUpdates(previousBooking, res.booking, [latestSib])[0];
              if (retryUpd) {
                sibRes = await store.saveBooking(retryUpd.payload, { expectedRevision: Number(latestSib.revision) || 1 });
              }
            }
          }
          if (sibRes.ok) {
            state.bookings = sibRes.bookings;
            syncedSiblings += 1;
          } else {
            failedSiblings += 1;
            logDiagnostic("warn", `Group sync skipped for room ${upd.roomId}`, sibRes.error);
          }
        }
      }

      clearDraft();

      if (hasActiveBookingFilters() && !matchesBookingFilter(res.booking)) {
        state.filters.channel = "all";
        state.filters.payment = "all";
        state.filters.search = "";
        $("filter-search").value = "";
        $("filter-payment").value = "all";
      }

      $("booking-modal").classList.remove("open");
      renderAll();
      onDataMutated("save");
      if (syncedSiblings > 0 && failedSiblings > 0) {
        showToast(`Đã lưu P.${room.name} & đồng bộ ${syncedSiblings} phòng (${failedSiblings} phòng cần kiểm tra lại)`);
      } else if (syncedSiblings > 0) {
        showToast(`Đã lưu P.${room.name} & tự động đồng bộ cho ${syncedSiblings} phòng khác trong đoàn ${res.booking.bookingCode}`);
      } else {
        showToast(res.isUpdate ? `Đã cập nhật phòng ${room.name} (đã sao lưu tự động)` : `Đã đặt phòng ${room.name} cho ${res.booking.guestName} (đã sao lưu tự động)`);
      }
      if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
    } finally {
      state.isSubmitting = false;
      $("btn-save-booking").disabled = false;
    }
  }

  /* -------------------- DEDICATED DORM 8-SLOT MANAGER -------------------- */

  function setDormModalMode(mode) {
    const isForm = mode === "form";
    $("dorm-board-view").style.display = isForm ? "none" : "flex";
    $("dorm-slot-form").style.display = isForm ? "flex" : "none";
    $("dorm-date-bar").style.display = isForm ? "none" : "flex";
    $("dorm-footer-board").style.display = isForm ? "none" : "flex";
    $("dorm-footer-form").style.display = isForm ? "flex" : "none";
  }

  function renderDormBoard() {
    state.bookings = store.refreshLatest();
    const dateISO = state.activeDormDate || getTodayISO();
    const { map: slotMap } = getDormSlotMapForDate(state.bookings, dateISO);
    const used = Object.keys(slotMap).length;
    const free = Math.max(0, 8 - used);

    $("dorm-current-date-label").textContent = formatDateVN(dateISO);
    $("dorm-modal-remain").textContent = free > 0 ? `Còn trống ${free}/8 chỗ (đã đặt ${used})` : "Đã kín 8/8 chỗ (hết chỗ)";
    $("dorm-modal-remain").style.background = free === 0 ? "var(--status-unpaid-bg)" : "var(--status-paid-bg)";
    $("dorm-modal-remain").style.color = free === 0 ? "var(--status-unpaid)" : "var(--status-paid)";
    $("btn-add-dorm-slot").disabled = free === 0;

    $("dorm-slot-grid").innerHTML = DORM_SLOTS.map((s) => {
      const bk = slotMap[s.slot];
      if (!bk) {
        return `<div class="dorm-slot-card free" data-book-slot="${s.slot}">
          <div>
            <div style="font-size:12.5px; font-weight:800;">${s.label} <span style="font-weight:500; color:var(--text-muted);">• ${s.bunk}</span></div>
            <div style="font-size:12px; font-weight:700; color:var(--status-paid); margin-top:4px;">● Còn trống</div>
          </div>
          <span class="btn btn-sm">+ Đặt chỗ</span>
        </div>`;
      }
      const debt = getRemaining(bk);
      const total = parseVND(bk.totalAmount);
      const payCls = debt > 0 ? "unpaid" : "paid";
      const payTxt = total === 0 ? "Miễn phí nội bộ" : debt > 0 ? `Nợ ${formatShortVND(debt)}` : `✓ Đủ ${formatShortVND(total)}`;
      return `<div class="dorm-slot-card booked" data-edit-dorm-id="${bk.id}">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:4px;">
          <strong style="font-size:12px;">${s.label} <span style="font-weight:500; opacity:0.8;">(${s.bunk})</span></strong>
          <span class="booking-pay ${payCls}">${payTxt}</span>
        </div>
        <div style="font-size:13px; font-weight:700;">${escapeHtml(bk.guestName)}</div>
        <div style="font-size:11.5px; opacity:0.88; margin-top:2px;">
          ${escapeHtml(bk.sourceName)}${bk.bookingCode ? ` • <span style="font-family:monospace; font-weight:700;">${escapeHtml(bk.bookingCode)}</span>` : ""} • ${formatDateVN(bk.checkin)} → ${formatDateVN(bk.checkout)}
        </div>
        ${bk.confirmedBy || bk.phone || bk.notes ? `<div style="font-size:11px; opacity:0.82; margin-top:2px;">${[bk.confirmedBy ? `✓ XN: ${escapeHtml(bk.confirmedBy)}` : "", bk.phone ? `📞 ${escapeHtml(bk.phone)}` : "", bk.notes ? `📝 ${escapeHtml(bk.notes)}` : ""].filter(Boolean).join(" • ")}</div>` : ""}
      </div>`;
    }).join("");
  }

  function openDormBoard(dateISO) {
    state.activeDormDate = dateISO || getTodayISO();
    setDormModalMode("board");
    renderDormBoard();
    $("dorm-modal").classList.add("open");
  }

  function renderDormSlotPicker() {
    const ci = $("dorm-checkin").value, co = $("dorm-checkout").value;
    const excludeId = $("dorm-field-id").value || null;
    const occupied = (ci && co && diffNights(ci, co) > 0) ? getDormOccupiedSlotsInRange(state.bookings, ci, co, excludeId) : {};
    state.dormSelectedSlots = state.dormSelectedSlots.filter((s) => !occupied[s]);

    $("dorm-slot-picker").innerHTML = DORM_SLOTS.map((s) => {
      const occBk = occupied[s.slot];
      const checked = state.dormSelectedSlots.includes(s.slot);
      if (occBk) {
        return `<div class="dorm-pick-btn occupied" title="Đã có ${escapeHtml(occBk.guestName)} đặt">
          <strong>${s.label}</strong>
          <div style="font-size:10.5px; color:var(--status-unpaid); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Đã đặt: ${escapeHtml(occBk.guestName)}</div>
        </div>`;
      }
      return `<button type="button" class="dorm-pick-btn ${checked ? "selected" : ""}" data-pick-slot="${s.slot}">
        <div style="display:flex; justify-content:space-between; font-weight:700;"><span>${s.label}</span><span>${checked ? "☑" : "☐"}</span></div>
        <div style="font-size:10.5px; color:var(--text-muted);">${s.bunk.replace("Giường ", "")}</div>
      </button>`;
    }).join("");
  }

  function syncDormFormUI() {
    const ci = $("dorm-checkin").value, co = $("dorm-checkout").value;
    if (ci && co) {
      const n = diffNights(ci, co);
      $("dorm-nights-readonly").value = Number.isFinite(n) && n > 0 ? `${n} đêm` : "Ngày không hợp lệ";
    }
    const src = $("dorm-source-type").value;
    $("dorm-wrap-tour").style.display = (src === "tour" || src === "zalo" || src === "other") ? "flex" : "none";
    $("dorm-tour-name").placeholder = src === "other" ? "Nhập tên đơn vị / nguồn..." : "VD: Vietravel, Saigontourist...";

    const total = parseVND($("dorm-total-amount").value), paid = parseVND($("dorm-paid-amount").value);
    if (total > 0 && paid > total) {
      $("dorm-display-remaining").textContent = `Vượt tổng ${formatVND(paid - total)}!`;
      $("dorm-display-remaining").className = "balance-amount owing";
    } else {
      const rem = Math.max(0, total - paid);
      $("dorm-display-remaining").textContent = total === 0 ? "0 đ (Miễn phí nội bộ)" : formatVND(rem);
      $("dorm-display-remaining").className = `balance-amount ${rem > 0 ? "owing" : "settled"}`;
    }
  }

  function showDormError(msg) {
    $("dorm-form-error").textContent = msg || "";
    $("dorm-form-error").classList.toggle("show", !!msg);
  }

  function openDormSlotForm({ bookingId = null, dateISO = null, preselectSlot = null } = {}) {
    showDormError("");
    state.bookings = store.refreshLatest();
    state.activeDormIdempotencyKey = newIdempotencyKey("dorm_sub");
    const ex = bookingId ? state.bookings.find((b) => b.id === bookingId) : null;

    if (ex) {
      state.editingDormRevision = Number(ex.revision) || 1;
      state.activeDormDate = ex.checkin;
      $("dorm-form-mode-label").textContent = `Chỉnh sửa lượt đặt Dorm (Slot ${(ex.slots || []).join(", ")})`;
      $("dorm-field-id").value = ex.id;
      $("dorm-booking-date").value = ex.bookingDate || (typeof ex.createdAt === "string" && ex.createdAt.length >= 10 ? ex.createdAt.slice(0, 10) : getTodayISO());
      $("dorm-checkin").value = ex.checkin;
      $("dorm-checkout").value = ex.checkout;
      state.dormSelectedSlots = [...(ex.slots || [1])];
      const srcKey = ["tour", "walkin", "zalo", "other"].includes(ex.channelKey) ? ex.channelKey : "tour";
      $("dorm-source-type").value = srcKey;
      $("dorm-tour-name").value = ex.tourName || (srcKey === "other" ? ex.sourceName : String(ex.sourceName || "").replace(/^(?:Tour|Gmail|Zalo)\s*/i, ""));
      $("dorm-booking-code").value = ex.bookingCode || "";
      $("dorm-guest-name").value = ex.guestName || "";
      $("dorm-phone").value = ex.phone || "";
      $("dorm-total-amount").value = formatNumberInput(ex.totalAmount);
      $("dorm-paid-amount").value = formatNumberInput(ex.paidAmount);
      setConfirmerValue($("dorm-confirmed-by"), ex.confirmedBy);
      state.activeDormConfirmationPdf = ex.confirmationPdf ? { ...ex.confirmationPdf } : null;
      syncPdfFieldUI("dorm-", state.activeDormConfirmationPdf);
      $("dorm-notes").value = ex.notes || "";
      $("btn-dorm-delete").style.display = "inline-flex";
      $("btn-dorm-mark-paid").style.display = getRemaining(ex) > 0 ? "inline-flex" : "none";
    } else {
      state.editingDormRevision = null;
      const ci = dateISO || state.activeDormDate || getTodayISO();
      state.activeDormDate = ci;
      $("dorm-form-mode-label").textContent = preselectSlot ? `Đặt nhanh Slot ${preselectSlot} — Dorm nội bộ` : "Đặt slot Dorm mới";
      $("dorm-field-id").value = "";
      $("dorm-booking-date").value = getTodayISO();
      $("dorm-checkin").value = ci;
      $("dorm-checkout").value = addDaysISO(ci, 1);
      const occ = getDormOccupiedSlotsInRange(state.bookings, ci, addDaysISO(ci, 1), null);
      if (preselectSlot && !occ[preselectSlot]) state.dormSelectedSlots = [preselectSlot];
      else {
        const firstFree = DORM_SLOTS.find((s) => !occ[s.slot]);
        state.dormSelectedSlots = firstFree ? [firstFree.slot] : [];
      }
      $("dorm-source-type").value = "tour";
      $("dorm-tour-name").value = "";
      $("dorm-booking-code").value = "";
      $("dorm-guest-name").value = "";
      $("dorm-phone").value = "";
      $("dorm-total-amount").value = "";
      $("dorm-paid-amount").value = "";
      setConfirmerValue($("dorm-confirmed-by"), "");
      state.activeDormConfirmationPdf = null;
      syncPdfFieldUI("dorm-", null);
      $("dorm-notes").value = "";
      $("btn-dorm-delete").style.display = "none";
      $("btn-dorm-mark-paid").style.display = "none";
    }
    setDormModalMode("form");
    syncDormFormUI();
    renderDormSlotPicker();
    $("dorm-modal").classList.add("open");
    setTimeout(() => $("dorm-guest-name").focus(), 60);
  }

  /* -------------------- Daily Report, Health Check & Audit Trail -------------------- */

  function openDailyReportModal(dateISO) {
    state.activeDayReportDate = dateISO;
    state.bookings = store.refreshLatest();
    const regularRooms = ROOMS.filter((r) => !r.isDorm);
    const activeEntries = [], checkinsToday = [], checkoutsToday = [], housekeepingTasks = [], unpaidRows = [];
    const seenDebtGroups = new Set();
    let buffetTotal = 0;

    regularRooms.forEach((room) => {
      const staying = getBookingsForRoomDate(room.id, dateISO);
      if (staying.length > 0) {
        const bk = staying[0];
        activeEntries.push({ room, bk });
        buffetTotal += Number(bk.guestCount) || room.defaultGuests;
        if (bk.checkin === dateISO) checkinsToday.push({ room, bk });
        if ((bk.mergeBed && room.type === "Twins") || Number(bk.extraBed) > 0) housekeepingTasks.push({ room, bk });

        const grp = bk.bookingCode ? computeBookingGroupSummary(state.bookings, bk.bookingCode) : null;
        if (grp && grp.roomCount >= 2) {
          if (grp.remaining > 0 && !seenDebtGroups.has(grp.normalizedCode)) {
            seenDebtGroups.add(grp.normalizedCode);
            const roomLabels = grp.bookings.map((b) => b.roomId === "DORM" ? "Dorm" : `P.${getRoomById(b.roomId)?.name || b.roomId}`).join(", ");
            unpaidRows.push({
              label: `<strong>👥 Đoàn ${escapeHtml(grp.code)}</strong> (${escapeHtml(roomLabels)}) • ${escapeHtml(grp.tourName || grp.leadGuestName)}`,
              remaining: grp.remaining
            });
          }
        } else if (getRemaining(bk) > 0) {
          unpaidRows.push({
            label: `<strong>P.${room.name}</strong> • ${escapeHtml(bk.guestName)} (${escapeHtml(bk.sourceName)})`,
            remaining: getRemaining(bk)
          });
        }
      }
      state.bookings.forEach((bk) => { if (bk.roomId === room.id && bk.checkout === dateISO) checkoutsToday.push({ room, bk }); });
    });

    const { map: dormMap } = getDormSlotMapForDate(state.bookings, dateISO);
    const dormUsed = Object.keys(dormMap).length;
    const dormFree = Math.max(0, 8 - dormUsed);
    const health = store.runHealthCheck();
    const recentLogs = store.getAuditLogs().slice(0, 5);

    $("day-report-title").textContent = `Báo cáo hoạt động ngày ${formatDateVN(dateISO)}`;
    $("day-report-sub").textContent = `Đang ở: ${activeEntries.length}/26 phòng • Trống: ${26 - activeEntries.length} • Dorm nội bộ: còn trống ${dormFree}/8 chỗ`;
    $("btn-rollback-last").disabled = !health.hasRollbackBackup;

    $("day-report-body").innerHTML = `
      <div class="report-section">
        <h4>🍽️ Tầng 5 — Dự kiến Buffet sáng (${buffetTotal} khách từ ${activeEntries.length} phòng)</h4>
        <div style="font-size:12.5px; color:var(--text-secondary);">
          Nhận phòng hôm nay: <strong>${checkinsToday.length}</strong> phòng • Trả phòng hôm nay: <strong>${checkoutsToday.length}</strong> phòng • Dorm nội bộ: <strong>đã đặt ${dormUsed}/8 (còn ${dormFree})</strong>.
        </div>
      </div>
      <div class="report-section">
        <h4>🛏️ Lưu ý Buồng phòng — Ghép giường &amp; Extra bed (${housekeepingTasks.length})</h4>
        <div class="report-list">
          ${housekeepingTasks.length === 0
            ? `<div style="font-size:12px; color:var(--text-muted);">Không có yêu cầu ghép giường hoặc extra bed trong ngày này.</div>`
            : housekeepingTasks.map(({ room, bk }) => `
              <div class="report-row">
                <span><strong>P.${room.name}</strong> (${room.type}) — ${escapeHtml(bk.guestName)}</span>
                <span style="font-weight:700; color:#dc2626;">${[bk.mergeBed && room.type === "Twins" ? "Ghép giường" : "", Number(bk.extraBed) > 0 ? `+${bk.extraBed} Extra bed` : ""].filter(Boolean).join(" • ")}</span>
              </div>`).join("")}
        </div>
      </div>
      <div class="report-section">
        <h4>💰 Công nợ cần thu trong ngày (${unpaidRows.length})</h4>
        <div class="report-list">
          ${unpaidRows.length === 0
            ? `<div style="font-size:12px; color:var(--status-paid);">Tất cả phòng lưu trú ngày này đã thanh toán đủ!</div>`
            : unpaidRows.map((row) => `
              <div class="report-row">
                <span>${row.label}</span>
                <strong style="color:var(--status-unpaid);">Còn ${formatVND(row.remaining)}</strong>
              </div>`).join("")}
        </div>
      </div>
      <div class="report-section">
        <h4>🛡️ Sức khỏe dữ liệu &amp; Nhật ký thao tác gần nhất</h4>
        <div style="font-size:12px; color:${health.ok ? "var(--status-paid)" : "var(--status-unpaid)"}; font-weight:700; margin-bottom:6px;">
          ${health.ok ? `✓ Toàn vẹn 100% — 0 trùng phòng, 0 lỗi thanh toán (${health.bookingCount} đơn)` : `⚠ Phát hiện ${health.consistencyErrors.length} lỗi: ${escapeHtml(health.consistencyErrors[0] || "Lỗi lưu trữ")}`}
        </div>
        <div class="report-list">
          ${recentLogs.length === 0
            ? `<div style="font-size:11.5px; color:var(--text-muted);">Chưa có lịch sử thao tác trong phiên này.</div>`
            : recentLogs.map((lg) => `
              <div class="report-row" style="font-size:11.5px;">
                <span><strong>[${escapeHtml(lg.action)}]</strong> ${escapeHtml(lg.summary)}</span>
                <span style="color:var(--text-muted); white-space:nowrap;">${escapeHtml(String(lg.ts || "").slice(11, 16))}</span>
              </div>`).join("")}
        </div>
      </div>
    `;
    $("day-report-modal").classList.add("open");
  }

  /* -------------------- Export CSV / Backup & Validated Restore -------------------- */

  function exportCSV() {
    if (!userCan("admin:backup")) {
      showToast("Chức năng Xuất Excel tổng hợp chỉ dành cho Quản lý.");
      return;
    }
    const csv = generateCsvContent(state.bookings);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `lich-dat-phong-T${state.month + 1}-${state.year}.csv`; a.click();
    URL.revokeObjectURL(url);
    showToast("Đã xuất file Excel (CSV) an toàn");
  }

  async function backupJSON() {
    if (!userCan("admin:backup")) {
      showToast("Chức năng Sao lưu dữ liệu chỉ dành cho Quản lý.");
      return;
    }
    let payload = null;
    if (typeof store.exportUnifiedBackup === "function") {
      const expRes = await store.exportUnifiedBackup({ source: "desktop" });
      if (!expRes || !expRes.ok || !expRes.backup) {
        showToast((expRes && expRes.error) || "Không thể xuất bản sao lưu đầy đủ.");
        return;
      }
      payload = expRes.backup;
    } else {
      payload = buildFullBackupPayload({ source: "desktop" });
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backup-dongvan-hotel-v${payload.version || 5}-${getTodayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    const txCount = (payload.financeState && Array.isArray(payload.financeState.transactions)) ? payload.financeState.transactions.length : 0;
    showToast(`Đã tải sao lưu JSON v${payload.version || 5} (${(payload.bookings || []).length} đơn, ${txCount} chứng từ tài chính & chi phí)`);
  }

  /* -------------------- Shared Restore Preview Modal (PC & Mobile) -------------------- */
  let activeRestorePreviewState = null;

  function closeRestorePreviewModal() {
    const modal = $("restore-preview-modal");
    if (modal) modal.classList.remove("open");
    activeRestorePreviewState = null;
  }

  function renderRestorePreviewBody(fileName, preview) {
    const sum = preview.summary || {};
    const fin = sum.finance || null;
    const costs = sum.operatingCosts || null;
    const media = preview.mediaInventory || { totalCount: 0, inlineRestorableCount: 0, serverLocalRefCount: 0, missingOnTargetCount: 0, missingRefs: [] };

    const sectionLabels = {
      bookings: "Đặt phòng (lẻ / đoàn / dorm)",
      financeState: "Sổ tài chính, quỹ, công nợ & giao ca",
      operatingCosts: "Chi phí vận hành & giá vốn",
      housekeepingTasks: "Buồng phòng (Housekeeping)",
      maintenanceIssues: "Báo hỏng / sự cố"
    };

    const presentHtml = (preview.presentSections || [])
      .map((s) => `<span class="restore-preview-chip ok">✓ Khôi phục: ${escapeHtml(sectionLabels[s] || s)}</span>`)
      .join("");
    const missingHtml = (preview.missingSections || [])
      .map((s) => `<span class="restore-preview-chip preserve">🛡 Giữ nguyên hiện có: ${escapeHtml(sectionLabels[s] || s)}</span>`)
      .join("");

    const warningsHtml = (preview.warnings || []).length > 0
      ? (preview.warnings || []).map((w) => `<div class="restore-preview-warning">⚠️ ${escapeHtml(w)}</div>`).join("")
      : "";

    const financeHtml = fin
      ? `
        <div class="restore-preview-section">
          <h4>💰 Sổ tài chính trong file sao lưu</h4>
          <div class="restore-preview-grid">
            <div class="restore-preview-stat"><span class="lbl">Tổng chứng từ</span><span class="val" id="rp-tx-count">${fin.totalTransactions} phiếu</span></div>
            <div class="restore-preview-stat"><span class="lbl">Quỹ tiền mặt lễ tân</span><span class="val" id="rp-fund-cash">${escapeHtml(formatVND(fin.fundBalances.cash_frontdesk))}</span></div>
            <div class="restore-preview-stat"><span class="lbl">Tài khoản ngân hàng</span><span class="val" id="rp-fund-bank">${escapeHtml(formatVND(fin.fundBalances.bank_main))}</span></div>
            <div class="restore-preview-stat"><span class="lbl">Công nợ khách (AR)</span><span class="val" id="rp-ar-total">${escapeHtml(formatVND(fin.customerReceivablesTotal))}</span></div>
            <div class="restore-preview-stat"><span class="lbl">Công nợ NCC (AP)</span><span class="val" id="rp-ap-total">${escapeHtml(formatVND(fin.supplierPayablesTotal))}</span></div>
            <div class="restore-preview-stat"><span class="lbl">HĐ NCC / Phiên giao ca</span><span class="val" id="rp-inv-shifts">${fin.supplierInvoiceCount} HĐ • ${fin.cashShiftCount} ca</span></div>
          </div>
          <div style="font-size:12px; color:var(--text-muted);">
            Chi tiết loại phiếu: Thu khách <strong>${fin.byType.customer_payment || 0}</strong> •
            Hoàn khách <strong>${fin.byType.customer_refund || 0}</strong> •
            Chi NCC <strong>${fin.byType.supplier_payment || 0}</strong> •
            Chuyển quỹ <strong>${fin.byType.fund_transfer || 0}</strong> •
            Điều chỉnh <strong>${fin.byType.balance_adjustment || 0}</strong> •
            Chuyển tiếp <strong>${(fin.byType.legacy_opening || 0) + (fin.byType.legacy_payment || 0)}</strong>
          </div>
        </div>
      `
      : `
        <div class="restore-preview-section">
          <h4>🛡 Sổ tài chính: KHÔNG có trong file này (Bản v${preview.version})</h4>
          <p style="margin:0; color:var(--text-muted);">Hệ thống sẽ <strong>giữ nguyên 100%</strong> sổ tài chính, công nợ, hóa đơn NCC và lịch sử giao ca đang có trên máy chủ — không ghi đè rỗng.</p>
        </div>
      `;

    const mediaHtml = `
      <div class="restore-preview-section">
        <h4>📎 Kiểm kê tệp đính kèm &amp; ảnh (${media.totalCount} tệp)</h4>
        <div style="font-size:12px;">
          • Khôi phục đầy đủ (PDF/chứng từ nhúng trong file): <strong>${media.inlineRestorableCount}</strong> tệp<br/>
          • Ảnh tham chiếu trên máy chủ (/api/photos/...): <strong>${media.serverLocalRefCount}</strong> tệp
          ${media.missingOnTargetCount > 0 ? ` — <strong style="color:#b45309;">${media.missingOnTargetCount} tệp chưa có trên môi trường đích</strong>` : " (không thiếu tệp nào)"}
        </div>
      </div>
    `;

    return `
      ${warningsHtml}
      <div class="restore-preview-grid">
        <div class="restore-preview-stat">
          <span class="lbl">Phiên bản / Nguồn</span>
          <span class="val" id="rp-version">v${escapeHtml(String(preview.version))} (${escapeHtml(preview.source || "legacy")})</span>
        </div>
        <div class="restore-preview-stat">
          <span class="lbl">Đơn đặt phòng</span>
          <span class="val" id="rp-booking-count">${sum.bookingCount || 0} đơn (${sum.groupCount || 0} đoàn)</span>
        </div>
        <div class="restore-preview-stat">
          <span class="lbl">Chi phí vận hành</span>
          <span class="val">${costs ? `${costs.itemCount} khoản • ${costs.actualEntryCount} phiếu` : "Giữ nguyên hiện có"}</span>
        </div>
      </div>
      ${financeHtml}
      <div class="restore-preview-section">
        <h4>📦 Phạm vi dữ liệu sẽ áp dụng (1 giao dịch nguyên tử, có tự hoàn tác nếu lỗi)</h4>
        <div class="restore-preview-chips">${presentHtml}${missingHtml}</div>
      </div>
      ${mediaHtml}
      <div style="font-size:12px; color:var(--text-muted);">
        File: <strong>${escapeHtml(fileName || "backup.json")}</strong>${preview.exportedAt ? ` • Xuất lúc ${escapeHtml(formatTimestampVN(preview.exportedAt))}` : ""}
      </div>
    `;
  }

  function bindRestorePreviewModalOnce() {
    const modal = $("restore-preview-modal");
    if (!modal || modal.dataset.bound === "1") return;
    modal.dataset.bound = "1";
    const closeBtn = $("btn-close-restore-preview");
    const cancelBtn = $("btn-cancel-restore-preview");
    const confirmBtn = $("btn-confirm-restore-preview");

    const handleCancel = () => {
      const cb = activeRestorePreviewState && activeRestorePreviewState.onCancel;
      closeRestorePreviewModal();
      if (typeof cb === "function") cb();
    };
    if (closeBtn) closeBtn.addEventListener("click", handleCancel);
    if (cancelBtn) cancelBtn.addEventListener("click", handleCancel);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) handleCancel();
    });

    if (confirmBtn) {
      confirmBtn.addEventListener("click", async () => {
        if (!activeRestorePreviewState) return;
        const { rawText, onRestored, notifyToast } = activeRestorePreviewState;
        confirmBtn.disabled = true;
        const origText = confirmBtn.textContent;
        confirmBtn.textContent = "⏳ Đang khôi phục & đối soát số dư...";
        try {
          const res = await store.restoreFromImport(rawText);
          if (!res || !res.ok) {
            alert("Không thể khôi phục dữ liệu (dữ liệu hiện tại đã được bảo toàn):\n" + ((res && res.error) || "Lỗi không xác định"));
            confirmBtn.disabled = false;
            confirmBtn.textContent = origText;
            return;
          }
          closeRestorePreviewModal();
          state.bookings = res.bookings || store.getBookings();
          renderAll();
          if ($("costs-modal") && $("costs-modal").classList.contains("open")) renderOperatingCostsModal();
          if (window.PMSFinanceApp) window.PMSFinanceApp.refreshOpenModals();
          onDataMutated("restore");
          if (typeof onRestored === "function") onRestored(res);
          const vOk = !res.verification || res.verification.ok;
          const msg = `✓ Đã khôi phục ${state.bookings.length} đơn${
            (res.restoredSections || []).includes("financeState") ? " & sổ tài chính" : " (giữ nguyên sổ tài chính hiện có)"
          }${vOk ? " — đối soát khớp 0 đ!" : ""}`;
          if (typeof notifyToast === "function") notifyToast(msg);
          else showToast(msg);
        } catch (err) {
          alert("Lỗi khi khôi phục: " + (err && err.message ? err.message : "lỗi không xác định"));
        } finally {
          confirmBtn.disabled = false;
          confirmBtn.textContent = origText;
        }
      });
    }
  }

  async function openRestorePreviewForText(rawText, fileName, opts = {}) {
    bindRestorePreviewModalOnce();
    const preview = typeof store.inspectImportPreview === "function"
      ? await store.inspectImportPreview(rawText)
      : window.PMSCore.inspectBackupPayload(rawText);
    if (!preview || !preview.ok) {
      alert("File sao lưu không hợp lệ:\n" + ((preview && preview.error) || "Không thể đọc cấu trúc JSON."));
      return;
    }
    const modal = $("restore-preview-modal");
    const sub = $("restore-preview-subtitle");
    const body = $("restore-preview-body");
    if (!modal || !body) return;
    if (sub) {
      sub.textContent = `File "${fileName || "backup.json"}" — Bản v${preview.version}${preview.isLegacyWithoutFinance ? " (thiếu sổ tài chính — sẽ giữ nguyên sổ hiện có)" : " (đầy đủ sổ tài chính)"}`;
    }
    body.innerHTML = renderRestorePreviewBody(fileName, preview);
    activeRestorePreviewState = {
      rawText,
      fileName,
      preview,
      onRestored: opts.onRestored,
      onCancel: opts.onCancel,
      notifyToast: opts.notifyToast
    };
    modal.classList.add("open");
  }

  window.PMSRestoreDialog = {
    openForFile(file, opts = {}) {
      if (!file) return;
      if (file.size > 12 * 1024 * 1024) {
        alert("File JSON quá lớn (> 12MB). Vui lòng kiểm tra lại file sao lưu.");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => openRestorePreviewForText(reader.result, file.name, opts);
      reader.readAsText(file);
    },
    openForText: openRestorePreviewForText,
    close: closeRestorePreviewModal
  };

  function restoreJSON(file) {
    if (!userCan("admin:backup")) {
      showToast("Chức năng Khôi phục dữ liệu chỉ dành cho Quản lý.");
      return;
    }
    window.PMSRestoreDialog.openForFile(file, {
      onCancel: () => showToast("Đã hủy khôi phục — dữ liệu giữ nguyên"),
      notifyToast: (msg) => showToast(msg)
    });
  }

  /* -------------------- Auto-Backup Engine & Edit History Center -------------------- */

  let autoBackupFileHandle = null;
  let lastAutoFileSavedAt = null;

  function isAutoDownloadBackupEnabled() {
    try { return localStorage.getItem(AUTO_DL_BACKUP_KEY) === "1"; } catch { return false; }
  }

  function setAutoDownloadBackupEnabled(enabled) {
    try { localStorage.setItem(AUTO_DL_BACKUP_KEY, enabled ? "1" : "0"); } catch {}
  }

  function formatTimestampVN(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function buildFullBackupPayload(extra = {}) {
    const fState = typeof store.getFinanceState === "function" ? store.getFinanceState() : null;
    const hkTasks = typeof store.getHousekeepingTasks === "function" ? store.getHousekeepingTasks() : [];
    const issues = typeof store.getMaintenanceIssues === "function" ? store.getMaintenanceIssues() : [];
    return window.PMSCore.buildUnifiedBackupPayload(
      {
        bookings: state.bookings,
        auditLogs: store.getAuditLogs(),
        operatingCosts: getCurrentOperatingCosts(),
        financeState: fState,
        housekeepingTasks: hkTasks,
        maintenanceIssues: issues
      },
      {
        source: extra.autoBackup ? "auto" : (extra.source || "desktop"),
        autoBackup: Boolean(extra.autoBackup)
      }
    );
  }

  function updateAutoBackupUI() {
    const snaps = store.getAutoBackups();
    const count = snaps.length;
    const pill = $("autobackup-status-pill");
    if (pill) {
      pill.textContent = autoBackupFileHandle ? `Auto • File (${count})` : `Auto (${count})`;
    }

    const infoEl = $("autobackup-info-text");
    if (infoEl) {
      const latestText = snaps[0] ? `Mốc gần nhất: ${formatTimestampVN(snaps[0].ts)} (${snaps[0].count} đơn).` : "Chưa có thao tác chỉnh sửa nào được ghi nhận.";
      infoEl.textContent = `Đã tự động sao lưu ${count}/${MAX_AUTOBACKUPS} mốc trong bộ nhớ trình duyệt. ${latestText}`;
    }

    const fileStatus = $("autobackup-file-status");
    if (fileStatus) {
      if (autoBackupFileHandle) {
        fileStatus.textContent = `✓ Đang tự động ghi ra file: ${autoBackupFileHandle.name}${lastAutoFileSavedAt ? ` (lưu lúc ${lastAutoFileSavedAt})` : ""}`;
        fileStatus.style.color = "var(--status-paid)";
      } else if (typeof window.showSaveFilePicker !== "function") {
        fileStatus.textContent = "Trình duyệt hiện tại dùng sao lưu nội bộ 30 mốc (bật nút tải JSON tự động nếu cần).";
        fileStatus.style.color = "var(--text-muted)";
      } else {
        fileStatus.textContent = "Chưa liên kết file ổ cứng (đang lưu tự động 30 mốc trong trình duyệt)";
        fileStatus.style.color = "var(--text-muted)";
      }
    }

    const chk = $("chk-auto-download-backup");
    if (chk) chk.checked = isAutoDownloadBackupEnabled();

    const modalSummary = $("backup-modal-auto-summary");
    if (modalSummary) {
      const latestText = snaps[0] ? `Mốc gần nhất: ${formatTimestampVN(snaps[0].ts)} (${snaps[0].count} đơn).` : "Chưa có mốc sao lưu tự động nào.";
      modalSummary.textContent = `Đã tự động sao lưu ${count}/${MAX_AUTOBACKUPS} mốc sau mỗi thao tác lưu/sửa/xóa. ${latestText}`;
    }
    const modalRollback = $("btn-backup-rollback-last");
    if (modalRollback && typeof store.hasRollbackBackup === "function") modalRollback.disabled = !store.hasRollbackBackup();
  }

  async function writeToLinkedBackupFile() {
    if (!autoBackupFileHandle) return false;
    try {
      const writable = await autoBackupFileHandle.createWritable();
      await writable.write(JSON.stringify(buildFullBackupPayload({ autoBackup: true }), null, 2));
      await writable.close();
      const now = new Date();
      lastAutoFileSavedAt = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
      updateAutoBackupUI();
      return true;
    } catch {
      return false;
    }
  }

  async function linkAutoBackupFile() {
    if (typeof window.showSaveFilePicker !== "function") {
      alert("Trình duyệt này chưa hỗ trợ ghi trực tiếp ra file ổ cứng. Bạn có thể dùng Chrome/Edge trên máy tính hoặc bật ô 'Tự động tải file backup JSON sau mỗi lần lưu'.");
      return;
    }
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `autobackup-dongvan-hotel.json`,
        types: [{ description: "JSON Backup File", accept: { "application/json": [".json"] } }]
      });
      autoBackupFileHandle = handle;
      const ok = await writeToLinkedBackupFile();
      updateAutoBackupUI();
      showToast(ok ? `Đã bật sao lưu tự động ra file "${handle.name}"!` : "Đã liên kết file sao lưu.");
    } catch (err) {
      if (err && err.name !== "AbortError") {
        alert("Không thể liên kết file sao lưu tự động: " + err.message);
      }
    }
  }

  function onDataMutated(reason = "edit") {
    updateAutoBackupUI();
    if (autoBackupFileHandle) {
      writeToLinkedBackupFile();
    } else if (isAutoDownloadBackupEnabled() && reason !== "restore") {
      const now = new Date();
      const stamp = `${getTodayISO()}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
      const blob = new Blob([JSON.stringify(buildFullBackupPayload({ autoBackup: true }), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `autobackup-dongvan-hotel-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
    if ($("history-modal").classList.contains("open")) {
      renderHistoryModal();
    }
  }

  function downloadSnapshotJSON(snapshotId) {
    const snap = store.getAutoBackups().find((s) => s && s.id === snapshotId);
    if (!snap) return alert("Không tìm thấy mốc sao lưu này.");
    const payload = {
      exportedAt: new Date().toISOString(),
      snapshotSavedAt: snap.ts,
      snapshotSummary: snap.summary,
      version: 2,
      hotel: "Dongvan Ville du H'mong Hotel",
      bookings: snap.bookings
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snapshot-dongvan-${String(snap.ts || "").replace(/[:.]/g, "-").slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Đã tải file JSON của mốc sao lưu");
  }

  function exportAuditCSV() {
    const csv = generateAuditCsvContent(store.getAuditLogs());
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lich-su-chinh-sua-dongvan-${getTodayISO()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Đã xuất lịch sử chỉnh sửa ra Excel (CSV)");
  }

  function getActionBadgeMeta(action) {
    switch (action) {
      case "CREATE": return { cls: "act-create", label: "+ Đặt mới" };
      case "UPDATE": return { cls: "act-update", label: "✎ Chỉnh sửa" };
      case "DELETE": return { cls: "act-delete", label: "🗑 Xóa đơn" };
      case "RESTORE": return { cls: "act-restore", label: "📥 Khôi phục JSON" };
      case "ROLLBACK": return { cls: "act-restore", label: "↩ Hoàn tác" };
      case "AUTOBACKUP_RESTORE": return { cls: "act-restore", label: "↺ Khôi phục mốc" };
      case "AUTO_RECOVER": return { cls: "act-restore", label: "🛡️ Tự phục hồi" };
      case "RESET_SAMPLE": return { cls: "act-other", label: "↻ Dữ liệu mẫu" };
      default: return { cls: "act-other", label: action || "Thao tác" };
    }
  }

  function renderHistoryModal() {
    updateAutoBackupUI();
    const logs = store.getAuditLogs();
    const snapsById = new Map(store.getAutoBackups().map((s) => [s.id, s]));
    const q = ($("history-search").value || "").trim().toLowerCase();
    const actFilter = $("history-filter-action").value;
    const confFilter = $("history-filter-confirmer").value;

    const filtered = logs.filter((lg) => {
      if (actFilter !== "all") {
        if (actFilter === "RESTORE_GROUP") {
          if (!["RESTORE", "ROLLBACK", "AUTOBACKUP_RESTORE", "AUTO_RECOVER", "RESET_SAMPLE"].includes(lg.action)) return false;
        } else if (lg.action !== actFilter) {
          return false;
        }
      }
      if (confFilter !== "all" && (lg.confirmedBy || "") !== confFilter) return false;
      if (q) {
        const diffText = Array.isArray(lg.changes) ? lg.changes.map((c) => `${c.field} ${c.before} ${c.after}`).join(" ") : "";
        const hay = `${lg.summary || ""} ${lg.guestName || ""} ${lg.roomId || ""} ${lg.confirmedBy || ""} ${diffText}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    $("history-count-label").textContent = `Hiển thị ${filtered.length} / ${logs.length} thao tác • ${snapsById.size} mốc sao lưu sẵn sàng`;
    $("btn-history-rollback-last").disabled = !store.hasRollbackBackup();

    if (filtered.length === 0) {
      $("history-list").innerHTML = `<div style="text-align:center; padding:28px 16px; color:var(--text-muted); font-size:13px;">
        Chưa có lịch sử chỉnh sửa nào khớp bộ lọc. Mọi thao tác đặt mới, sửa, xóa trên bảng sẽ tự động hiển thị tại đây.
      </div>`;
      return;
    }

    $("history-list").innerHTML = filtered.map((lg) => {
      const meta = getActionBadgeMeta(lg.action);
      const hasSnap = Boolean(lg.snapshotId && snapsById.has(lg.snapshotId));
      const snap = hasSnap ? snapsById.get(lg.snapshotId) : null;
      const changesHtml = Array.isArray(lg.changes) && lg.changes.length > 0
        ? `<div class="history-diffs">${lg.changes.map((c) => `<span class="diff-chip"><strong>${escapeHtml(c.field)}:</strong> <span class="diff-old">${escapeHtml(c.before)}</span> → <span class="diff-new">${escapeHtml(c.after)}</span></span>`).join("")}</div>`
        : "";
      return `<div class="history-card">
        <div class="history-card-head">
          <div class="history-meta">
            <span class="history-badge ${meta.cls}">${escapeHtml(meta.label)}</span>
            <span class="history-time">${escapeHtml(formatTimestampVN(lg.ts))}</span>
            ${lg.confirmedBy ? `<span class="history-confirmer">✓ XN: ${escapeHtml(lg.confirmedBy)}</span>` : ""}
          </div>
          ${hasSnap ? `<div class="history-actions">
            <button type="button" class="btn btn-sm" data-restore-snap="${escapeHtml(lg.snapshotId)}" title="Khôi phục toàn bộ bảng về trạng thái tại mốc này (${snap.count} đơn)">↺ Khôi phục mốc này (${snap.count} đơn)</button>
            <button type="button" class="btn btn-sm" data-download-snap="${escapeHtml(lg.snapshotId)}" title="Tải file JSON tại mốc này">⬇ JSON</button>
          </div>` : ""}
        </div>
        <div class="history-summary">${escapeHtml(lg.summary || "")}</div>
        ${changesHtml}
      </div>`;
    }).join("");
  }

  function openHistoryModal() {
    renderHistoryModal();
    $("history-modal").classList.add("open");
    if (typeof store.pullLatest === "function" && store.getStatus && store.getStatus().mode === "server") {
      store.pullLatest().catch(() => {});
    }
  }

  /* -------------------- Theme, Toast, Filters, Cross-Tab Sync & Midnight Watcher -------------------- */

  let toastTimer = null;
  function showToast(msg) {
    $("toast").textContent = msg;
    $("toast").classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2800);
  }

  function clearAllFilters() {
    state.filters = { search: "", floor: "all", type: "all", view: "all", payment: "all", channel: "all" };
    $("filter-search").value = "";
    $("filter-floor").value = "all";
    $("filter-type").value = "all";
    $("filter-view").value = "all";
    $("filter-payment").value = "all";
    renderAll();
  }

  function syncThemeToggleLabel() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const icon = $("pc-theme-icon");
    const label = $("pc-theme-label");
    if (icon) icon.textContent = isDark ? "☀️" : "🌙";
    if (label) label.textContent = isDark ? "Chuyển giao diện Sáng" : "Chuyển giao diện Tối";
  }

  function initTheme() {
    try {
      if (localStorage.getItem(THEME_KEY) === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
      }
    } catch {}
    syncThemeToggleLabel();
    $("btn-theme-toggle").addEventListener("click", () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      if (isDark) {
        document.documentElement.removeAttribute("data-theme");
        try { localStorage.setItem(THEME_KEY, "light"); } catch {}
      } else {
        document.documentElement.setAttribute("data-theme", "dark");
        try { localStorage.setItem(THEME_KEY, "dark"); } catch {}
      }
      syncThemeToggleLabel();
    });
  }

  function checkMidnightRollover() {
    const nowToday = getTodayISO();
    if (nowToday !== state.lastKnownTodayISO) {
      state.lastKnownTodayISO = nowToday;
      renderAll();
      showToast(`Đã sang ngày mới: ${formatDateVN(nowToday)}`);
    }
  }

  function getUserRole() {
    if (typeof store.getRole === "function") return normalizeRole(store.getRole());
    const auth = typeof store.getAuthState === "function" ? store.getAuthState() : null;
    if (auth && auth.authRequired && auth.user && auth.user.role) return normalizeRole(auth.user.role);
    return "manager";
  }

  function userCan(permission) {
    if (typeof store.can === "function") return store.can(permission);
    return hasPermission(getUserRole(), permission);
  }

  function updatePcSyncPill() {
    const status = store.getStatus ? store.getStatus() : { mode: "local", connectionStatus: "local", lastSyncedAt: null };
    const pill = $("pc-sync-status");
    const txt = $("pc-sync-text");
    const hkPill = $("hk-sync-pill");
    const hkTxt = $("hk-sync-text");
    const t = status.lastSyncedAt ? formatTimestampVN(status.lastSyncedAt).slice(11) : "";
    const ver = status.runningVersion && status.runningVersion.appVersion
      ? `v${status.runningVersion.appVersion} (${status.runningVersion.buildId || ""})`
      : "";
    const staff = status.user && status.user.staffName
      ? ` • ${status.user.staffName} (${getRoleLabel(status.user.role)})`
      : "";

    let labelText = "Đã đồng bộ";
    let statusCls = "";
    if (status.mode === "local") {
      labelText = "Offline cục bộ";
    } else if (status.connectionStatus === "auth_required") {
      statusCls = "offline";
      labelText = "Cần đăng nhập";
    } else if (status.connectionStatus === "connected") {
      labelText = t ? `Đồng bộ ${t}` : "Đã đồng bộ";
    } else if (status.connectionStatus === "reconnecting") {
      statusCls = "reconnecting";
      labelText = "Đang nối lại...";
    } else {
      statusCls = "offline";
      labelText = t ? `Mất mạng (${t})` : "Mất mạng";
    }

    if (pill && txt) {
      pill.classList.remove("offline", "reconnecting");
      if (statusCls) pill.classList.add(statusCls);
      pill.title = `Trạng thái đồng bộ dữ liệu${ver ? ` • ${ver}` : ""}${staff}`;
      txt.textContent = labelText;
    }
    if (hkPill && hkTxt) {
      hkPill.classList.remove("offline", "reconnecting");
      if (statusCls) hkPill.classList.add(statusCls);
      hkTxt.textContent = labelText;
    }

    const logoutBtn = $("btn-pc-logout");
    if (logoutBtn) {
      logoutBtn.style.display = status.mode === "server" && status.authRequired && status.authenticated ? "" : "none";
      if (status.user && status.user.staffName) {
        logoutBtn.title = `Đăng xuất (${status.user.staffName} • ${getRoleLabel(status.user.role)})`;
      }
    }

    const staffName = status.user && status.user.staffName ? String(status.user.staffName) : "";
    const roleLabel = getRoleLabel(status.user && status.user.role ? status.user.role : getUserRole());
    const displayName = staffName || (status.mode === "local" ? "Máy trực ca" : "Tài khoản");
    const initials = displayName.split(/\s+/).filter(Boolean).slice(-2).map((w) => w[0]).join("").toUpperCase() || "NV";
    if ($("pc-user-avatar")) $("pc-user-avatar").textContent = initials;
    if ($("pc-user-name")) $("pc-user-name").textContent = displayName;
    if ($("pc-user-full")) $("pc-user-full").textContent = staffName || (status.mode === "local" ? "Máy trực ca (chế độ cục bộ)" : "Tài khoản trực ca");
    if ($("pc-user-role-badge")) $("pc-user-role-badge").textContent = roleLabel;
    if ($("btn-user-menu")) $("btn-user-menu").title = `${displayName} • ${roleLabel} — Giao diện & Đăng xuất`;
    if ($("sidebar-version-label")) {
      $("sidebar-version-label").textContent = status.runningVersion && status.runningVersion.appVersion
        ? `Dongvan PMS v${status.runningVersion.appVersion}`
        : "Dongvan PMS";
    }
  }

  /* -------------------- Housekeeping, Maintenance Issues, Photo Proof & Accounts (v1.4.0) -------------------- */

  const hkState = {
    activeTab: "tasks", // "tasks" | "issues"
    filterDate: getTodayISO(),
    filterRoom: "all",
    filterStatus: "all",
    issueFilterStatus: "active",
    issueFilterRoom: "all",
    completingTaskId: "",
    completePhotos: [], // [{ localId, dataUrl, uploadedPhoto }]
    issuePhotos: [],
    isSubmitting: false,
    dismissedAlertIssueId: ""
  };

  function populateHousekeepingRoomDropdowns() {
    const regularRooms = ROOMS.filter((r) => !r.isDorm);
    const allOpts = `<option value="all">Tất cả phòng</option>` +
      regularRooms.map((r) => `<option value="${escapeHtml(r.id)}">Phòng ${escapeHtml(r.name)} (${escapeHtml(r.type)})</option>`).join("");
    const roomOnlyOpts = regularRooms
      .map((r) => `<option value="${escapeHtml(r.id)}">Phòng ${escapeHtml(r.name)} — Tầng ${r.floor} (${escapeHtml(r.type)})</option>`)
      .join("");
    if ($("hk-filter-room")) $("hk-filter-room").innerHTML = allOpts;
    if ($("hk-issue-filter-room")) $("hk-issue-filter-room").innerHTML = allOpts;
    if ($("hk-new-room")) $("hk-new-room").innerHTML = roomOnlyOpts;
    if ($("issue-room-id")) $("issue-room-id").innerHTML = roomOnlyOpts;
  }

  function updateHkHeaderBadge() {
    const pill = $("hk-badge-pill");
    if (!pill) return;
    const tasks = typeof store.getHousekeepingTasks === "function" ? store.getHousekeepingTasks() : [];
    const issues = typeof store.getMaintenanceIssues === "function" ? store.getMaintenanceIssues() : [];
    const todayTasks = getHousekeepingTasksForDate(tasks, getTodayISO());
    const pendingTasks = todayTasks.filter((t) => t.status !== "cleaned").length;
    const activeIssues = issues.filter((i) => i && i.status !== "resolved").length;
    const totalPending = pendingTasks + activeIssues;
    if (totalPending > 0) {
      pill.textContent = String(totalPending);
      pill.style.display = "inline-flex";
    } else {
      pill.style.display = "none";
    }
  }

  function renderIssueBanner() {
    const banner = $("issue-alert-banner");
    const txt = $("issue-alert-text");
    if (!banner || !txt) return;
    const role = getUserRole();
    const auth = typeof store.getAuthState === "function" ? store.getAuthState() : { authRequired: false, authenticated: true };
    if ((auth.authRequired && !auth.authenticated) || role === "housekeeping" || !userCan("bookings:read")) {
      banner.classList.remove("show");
      return;
    }
    const issues = typeof store.getMaintenanceIssues === "function" ? store.getMaintenanceIssues() : [];
    const openIssues = issues.filter((i) => i && i.status !== "resolved");
    if (openIssues.length === 0) {
      banner.classList.remove("show");
      return;
    }
    const blocking = openIssues.filter((i) => i.blocksRoom);
    const primary = blocking[0] || openIssues[0];
    if (hkState.dismissedAlertIssueId && hkState.dismissedAlertIssueId === primary.id) {
      banner.classList.remove("show");
      return;
    }
    const roomName = getRoomById(primary.roomId)?.name || primary.roomId;
    const prefix = blocking.length > 0
      ? `🚫 ${blocking.length} phòng chưa thể giao khách do sự cố:`
      : `⚠️ Có ${openIssues.length} sự cố phòng đang mở:`;
    txt.textContent = `${prefix} P.${roomName} — ${primary.description} (Báo bởi ${primary.reportedBy || "Buồng phòng"})`;
    banner.classList.add("show");
  }

  /* -------------------- Left Sidebar Navigation, Dropdown Menus & Backup Modal (v1.5.0) -------------------- */

  const SIDEBAR_COLLAPSED_KEY = "ks_pms_sidebar_collapsed_v1";
  // Workspace/modal element -> nav key. Order = priority when several are open (top-most child first).
  const NAV_SURFACES = [
    ["backup-restore-modal", "backup_restore"],
    ["accounts-modal", "accounts"],
    ["history-modal", "history"],
    ["payables-modal", "payables"],
    ["cashbook-modal", "cashbook"],
    ["shifts-modal", "cash_shifts"],
    ["receivables-modal", "receivables"],
    ["costs-modal", "operating_costs"],
    ["dorm-modal", "dorm"],
    ["group-report-modal", "groups"],
    ["hk-workspace", "housekeeping"]
  ];

  function syncSidebarVisibilityFromConfig(role) {
    const visibleGroups = getVisibleNavGroups(role || getUserRole(), (p) => userCan(p));
    const visibleIds = new Set();
    const visibleGroupKeys = new Set();
    visibleGroups.forEach((g) => {
      visibleGroupKeys.add(g.key);
      g.items.forEach((it) => visibleIds.add(it.id));
    });
    document.querySelectorAll("#sidebar-nav [data-nav-key]").forEach((btn) => {
      btn.style.display = visibleIds.has(btn.id) ? "" : "none";
    });
    document.querySelectorAll("#sidebar-nav [data-nav-group]").forEach((grp) => {
      grp.style.display = visibleGroupKeys.has(grp.dataset.navGroup) ? "" : "none";
    });
    // Hide the contextual "Thao tác" menu entirely if none of its items are permitted
    const actionsMenu = $("calendar-actions-menu");
    if (actionsMenu && $("calendar-actions-wrap")) {
      const anyAction = Array.from(actionsMenu.querySelectorAll(".dropdown-item")).some((it) => it.style.display !== "none");
      $("calendar-actions-wrap").style.display = anyAction ? "" : "none";
    }
    refreshActiveSidebarNav();
  }

  function setActiveSidebarNav(key) {
    const activeKey = key || "calendar";
    document.querySelectorAll("#sidebar-nav [data-nav-key]").forEach((btn) => {
      const on = btn.dataset.navKey === activeKey;
      btn.classList.toggle("active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    document.body.dataset.activeNav = activeKey;
  }

  function refreshActiveSidebarNav() {
    let key = "calendar";
    for (const [id, navKey] of NAV_SURFACES) {
      const el = $(id);
      if (el && el.classList.contains("open")) { key = navKey; break; }
    }
    setActiveSidebarNav(key);
  }

  function initSidebarNavigation() {
    const sb = $("app-sidebar");
    const toggle = $("btn-sidebar-toggle");
    const applyCollapsed = (collapsed) => {
      sb.classList.toggle("collapsed", collapsed);
      document.body.classList.toggle("sidebar-collapsed", collapsed);
      toggle.setAttribute("aria-expanded", String(!collapsed));
      const label = collapsed ? "Mở rộng menu bên trái" : "Thu gọn menu để mở rộng lịch phòng";
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
    };
    let collapsed = false;
    try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch {}
    applyCollapsed(collapsed);
    toggle.addEventListener("click", () => {
      const next = !sb.classList.contains("collapsed");
      applyCollapsed(next);
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0"); } catch {}
      hideTooltip();
    });

    $("btn-nav-calendar").addEventListener("click", () => {
      if (getUserRole() !== "housekeeping" && $("hk-workspace").classList.contains("open")) {
        $("hk-workspace").classList.remove("open");
      }
      refreshActiveSidebarNav();
    });

    // Keep the active highlight truthful no matter which code path opens/closes a workspace
    const observer = new MutationObserver(() => refreshActiveSidebarNav());
    NAV_SURFACES.forEach(([id]) => {
      const el = $(id);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    });
    refreshActiveSidebarNav();
  }

  function initDropdownMenus() {
    const pairs = [["btn-calendar-actions", "calendar-actions-menu"], ["btn-user-menu", "user-menu-popover"]];
    const closeAll = (exceptMenuId) => {
      pairs.forEach(([btnId, menuId]) => {
        if (menuId === exceptMenuId) return;
        $(menuId).classList.remove("open");
        $(btnId).setAttribute("aria-expanded", "false");
      });
    };
    pairs.forEach(([btnId, menuId]) => {
      $(btnId).addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = !$(menuId).classList.contains("open");
        closeAll(menuId);
        $(menuId).classList.toggle("open", willOpen);
        $(btnId).setAttribute("aria-expanded", String(willOpen));
      });
      $(menuId).addEventListener("click", (e) => {
        if (e.target.closest(".dropdown-item")) closeAll();
      });
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".dropdown-wrap")) closeAll();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAll();
    });
  }

  function openBackupRestoreModal() {
    if (!userCan("admin:backup")) {
      showToast("Chức năng Sao lưu & khôi phục chỉ dành cho Quản lý.");
      return;
    }
    updateAutoBackupUI();
    $("backup-restore-modal").classList.add("open");
  }

  window.PMSBackupRestoreModal = {
    open: () => openBackupRestoreModal()
  };

  window.PMSPcApi = {
    openBooking: (bookingId) => openBookingModal({ bookingId }),
    openOperatingCosts: (monthKey) => openOperatingCostsModal(monthKey),
    syncFromStore: () => {
      state.bookings = store.getBookings() || state.bookings;
      renderAll();
    },
    syncActiveNav: () => refreshActiveSidebarNav()
  };

  function applyRolePermissionsUI() {
    const auth = typeof store.getAuthState === "function" ? store.getAuthState() : { authRequired: false, authenticated: true };
    const isAuthed = !auth.authRequired || auth.authenticated;
    if (!isAuthed) {
      delete document.body.dataset.userRole;
      if ($("hk-workspace")) $("hk-workspace").classList.remove("open");
      if ($("issue-alert-banner")) $("issue-alert-banner").classList.remove("show");
      return;
    }

    const role = getUserRole();
    document.body.dataset.userRole = role;

    const canCosts = userCan("costs:read");
    const canAccounts = userCan("accounts:manage");
    const canBackup = userCan("admin:backup");
    const canHkCreate = userCan("housekeeping:create");
    const canArRead = userCan("finance:ar_read");
    const canShiftRead = userCan("finance:shift_read");
    const canCashbookRead = userCan("finance:cashbook_read");
    const canPayablesRead = userCan("finance:payables_read");

    if ($("btn-open-costs")) $("btn-open-costs").style.display = canCosts ? "" : "none";
    if ($("btn-open-receivables")) $("btn-open-receivables").style.display = canArRead ? "" : "none";
    if ($("btn-open-shifts")) $("btn-open-shifts").style.display = canShiftRead ? "" : "none";
    if ($("btn-open-cashbook")) $("btn-open-cashbook").style.display = canCashbookRead ? "" : "none";
    if ($("btn-open-payables")) $("btn-open-payables").style.display = canPayablesRead ? "" : "none";
    if ($("btn-open-accounts")) $("btn-open-accounts").style.display = canAccounts ? "" : "none";
    if ($("btn-backup-json")) $("btn-backup-json").style.display = canBackup ? "" : "none";
    if ($("lbl-restore-json")) $("lbl-restore-json").style.display = canBackup ? "" : "none";
    if ($("btn-export-csv")) $("btn-export-csv").style.display = canBackup ? "" : "none";
    if ($("btn-reset-sample")) $("btn-reset-sample").style.display = canBackup ? "" : "none";
    if ($("btn-rollback-last")) $("btn-rollback-last").style.display = canBackup ? "" : "none";
    if ($("btn-history-rollback-last")) $("btn-history-rollback-last").style.display = canBackup ? "" : "none";
    if ($("btn-backup-rollback-last")) $("btn-backup-rollback-last").style.display = canBackup ? "" : "none";
    if ($("btn-open-hk")) $("btn-open-hk").style.display = role === "housekeeping" ? "none" : "";
    syncSidebarVisibilityFromConfig(role);
    if (!canBackup && $("backup-restore-modal")) $("backup-restore-modal").classList.remove("open");
    if (!canArRead && $("receivables-modal")) $("receivables-modal").classList.remove("open");
    if (!canArRead && $("monthly-receipts-modal")) $("monthly-receipts-modal").classList.remove("open");
    if (!canShiftRead && $("shifts-modal")) $("shifts-modal").classList.remove("open");
    if (!canShiftRead && $("shift-minutes-modal")) $("shift-minutes-modal").classList.remove("open");
    if (!canCashbookRead && $("cashbook-modal")) $("cashbook-modal").classList.remove("open");
    if (!canPayablesRead && $("payables-modal")) $("payables-modal").classList.remove("open");

    if (role === "housekeeping") {
      // Strictly lock out calendar, booking modals, PDF, costs, finance, and accounts even if ?view=pc was passed
      delete document.body.dataset.viewMode;
      ["booking-modal", "dorm-modal", "day-report-modal", "group-report-modal", "history-modal", "backup-restore-modal", "confirm-pdf-modal", "costs-modal", "accounts-modal", "receivables-modal", "shifts-modal", "shift-minutes-modal", "cashbook-modal", "payables-modal", "monthly-receipts-modal"].forEach((id) => {
        if ($(id)) $(id).classList.remove("open");
      });
      if ($("btn-hk-close")) $("btn-hk-close").style.display = "none";
      if ($("btn-hk-logout")) $("btn-hk-logout").style.display = "";
      if ($("btn-hk-toggle-create")) $("btn-hk-toggle-create").style.display = "none";
      if ($("hk-create-form")) $("hk-create-form").style.display = "none";
      if ($("hk-workspace")) {
        $("hk-workspace").classList.add("open");
        renderHousekeepingWorkspace();
      }
      renderIssueBanner();
    } else {
      if ($("btn-hk-close")) $("btn-hk-close").style.display = "";
      if ($("btn-hk-logout")) $("btn-hk-logout").style.display = "none";
      if ($("btn-hk-toggle-create")) $("btn-hk-toggle-create").style.display = canHkCreate ? "" : "none";
      if (!canCosts && $("costs-modal")) $("costs-modal").classList.remove("open");
      if (!canAccounts && $("accounts-modal")) $("accounts-modal").classList.remove("open");
      updateHkHeaderBadge();
      renderIssueBanner();
      if ($("hk-workspace") && $("hk-workspace").classList.contains("open")) {
        renderHousekeepingWorkspace();
      }
    }
  }

  function compressImageFileToDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) return resolve({ ok: false, error: "Chưa chọn ảnh." });
      if (file.size > 15 * 1024 * 1024) {
        return resolve({ ok: false, error: "Ảnh quá lớn (> 15MB). Vui lòng chọn ảnh nhẹ hơn." });
      }
      const reader = new FileReader();
      reader.onerror = () => resolve({ ok: false, error: "Không đọc được file ảnh từ thiết bị." });
      reader.onload = () => {
        const rawUrl = String(reader.result || "");
        if (!rawUrl.startsWith("data:image/")) {
          return resolve({ ok: false, error: "Vui lòng chỉ chọn định dạng hình ảnh (JPG/PNG/WebP)." });
        }
        // Keep tiny images as-is (fast and safe for tests & already-compressed images)
        if (file.size <= 180 * 1024) {
          return resolve({ ok: true, dataUrl: rawUrl });
        }
        const img = new Image();
        img.onerror = () => resolve({ ok: true, dataUrl: rawUrl });
        img.onload = () => {
          try {
            const maxDim = 1280;
            let w = img.naturalWidth || img.width || 0;
            let h = img.naturalHeight || img.height || 0;
            if (!w || !h) return resolve({ ok: true, dataUrl: rawUrl });
            if (w > maxDim || h > maxDim) {
              const scale = maxDim / Math.max(w, h);
              w = Math.max(1, Math.round(w * scale));
              h = Math.max(1, Math.round(h * scale));
            }
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) return resolve({ ok: true, dataUrl: rawUrl });
            ctx.drawImage(img, 0, 0, w, h);
            const compressed = canvas.toDataURL("image/jpeg", 0.8);
            resolve({ ok: true, dataUrl: compressed && compressed.length < rawUrl.length ? compressed : rawUrl });
          } catch {
            resolve({ ok: true, dataUrl: rawUrl });
          }
        };
        img.src = rawUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  function openPhotoLightbox(src, caption = "") {
    if (!src) return;
    $("photo-lightbox-img").src = src;
    $("photo-lightbox-caption").textContent = caption || "Ảnh kiểm tra phòng";
    $("photo-lightbox-modal").classList.add("open");
  }

  function setHousekeepingTab(tabName) {
    hkState.activeTab = tabName === "issues" ? "issues" : "tasks";
    $("hk-pane-tasks").style.display = hkState.activeTab === "tasks" ? "block" : "none";
    $("hk-pane-issues").style.display = hkState.activeTab === "issues" ? "block" : "none";
    $("btn-hk-tab-tasks").classList.toggle("active", hkState.activeTab === "tasks");
    $("btn-hk-tab-issues").classList.toggle("active", hkState.activeTab === "issues");
  }

  function openHousekeepingWorkspace({ tab = "tasks", roomId = "all", dateISO = null } = {}) {
    if (!userCan("housekeeping:read")) {
      showToast("Bạn không có quyền truy cập mục Buồng phòng.");
      return;
    }
    hkState.filterDate = dateISO || hkState.filterDate || getTodayISO();
    hkState.filterRoom = roomId || "all";
    hkState.issueFilterRoom = tab === "issues" ? (roomId || "all") : "all";
    setHousekeepingTab(tab);
    renderHousekeepingWorkspace();
    $("hk-workspace").classList.add("open");
    if (typeof store.pullLatest === "function" && store.getStatus && store.getStatus().mode === "server") {
      store.pullLatest().catch(() => {});
    }
  }

  function renderHousekeepingWorkspace() {
    const role = getUserRole();
    const status = typeof store.getStatus === "function" ? store.getStatus() : {};
    const staffName = (status.user && status.user.staffName) || "Nhân viên";
    const allTasks = typeof store.getHousekeepingTasks === "function" ? store.getHousekeepingTasks() : [];
    const allIssues = typeof store.getMaintenanceIssues === "function" ? store.getMaintenanceIssues() : [];

    $("hk-ws-title").textContent = role === "housekeeping" ? "🧹 Công việc Buồng phòng" : "🧹 Buồng phòng & Sự cố phòng";
    $("hk-ws-sub").textContent = `${staffName} (${getRoleLabel(role)}) • Dongvan Ville du H'mong Hotel`;

    $("hk-filter-date").value = hkState.filterDate;
    if ($("hk-filter-room").value !== hkState.filterRoom) $("hk-filter-room").value = hkState.filterRoom;
    if ($("hk-filter-status").value !== hkState.filterStatus) $("hk-filter-status").value = hkState.filterStatus;
    if ($("hk-issue-filter-status").value !== hkState.issueFilterStatus) $("hk-issue-filter-status").value = hkState.issueFilterStatus;
    if ($("hk-issue-filter-room").value !== hkState.issueFilterRoom) $("hk-issue-filter-room").value = hkState.issueFilterRoom;

    // Tasks for selected date (includes unfinished carryover from previous days!)
    const dayTasks = getHousekeepingTasksForDate(allTasks, hkState.filterDate);
    const dirtyCnt = dayTasks.filter((t) => t.status === "dirty").length;
    const inProgCnt = dayTasks.filter((t) => t.status === "in_progress").length;
    const cleanedCnt = dayTasks.filter((t) => t.status === "cleaned").length;
    const openIssuesAll = allIssues.filter((i) => i && i.status !== "resolved");

    $("hk-tab-tasks-cnt").textContent = String(dirtyCnt + inProgCnt);
    $("hk-tab-issues-cnt").textContent = String(openIssuesAll.length);

    $("hk-kpi-strip").innerHTML = `
      <div class="hk-kpi-box"><strong style="color:#b91c1c;">${dirtyCnt}</strong><span>🔴 Cần dọn</span></div>
      <div class="hk-kpi-box"><strong style="color:#b45309;">${inProgCnt}</strong><span>🟡 Đang dọn</span></div>
      <div class="hk-kpi-box"><strong style="color:#15803d;">${cleanedCnt}</strong><span>✅ Đã dọn (${formatDateVN(hkState.filterDate).slice(0, 5)})</span></div>
      <div class="hk-kpi-box"><strong style="color:${openIssuesAll.length > 0 ? "#dc2626" : "var(--text-primary)"};">${openIssuesAll.length}</strong><span>⚠️ Sự cố đang mở</span></div>
    `;

    const filteredTasks = dayTasks.filter((t) => {
      if (hkState.filterRoom !== "all" && t.roomId !== hkState.filterRoom) return false;
      if (hkState.filterStatus !== "all" && t.status !== hkState.filterStatus) return false;
      return true;
    });

    const canAct = userCan("housekeeping:execute");
    const canReportIssue = userCan("issues:create");
    const activeIssuesByRoom = new Map();
    openIssuesAll.forEach((iss) => {
      const arr = activeIssuesByRoom.get(iss.roomId) || [];
      arr.push(iss);
      activeIssuesByRoom.set(iss.roomId, arr);
    });

    if (filteredTasks.length === 0) {
      $("hk-tasks-list").innerHTML = `<div style="text-align:center; padding:28px 14px; color:var(--text-muted); font-size:13px; border:1px dashed var(--border-strong); border-radius:var(--radius-md);">
        Không có công việc dọn phòng nào cho ngày ${escapeHtml(formatDateVN(hkState.filterDate))}${hkState.filterRoom !== "all" ? ` tại P.${escapeHtml(hkState.filterRoom)}` : ""}.
      </div>`;
    } else {
      $("hk-tasks-list").innerHTML = filteredTasks.map((t) => {
        const room = getRoomById(t.roomId);
        const typeMeta = HK_TASK_TYPES[t.taskType] || HK_TASK_TYPES.checkout;
        const stMeta = HK_TASK_STATUSES[t.status] || HK_TASK_STATUSES.dirty;
        const roomIssues = activeIssuesByRoom.get(t.roomId) || [];
        const hasBlocking = roomIssues.some((i) => i.blocksRoom);
        const photosHtml = Array.isArray(t.photos) && t.photos.length > 0
          ? `<div class="hk-photos-row">${t.photos.map((p, idx) => `<img class="hk-photo-thumb" src="${escapeHtml(p.url)}" alt="Ảnh dọn P.${escapeHtml(t.roomName || t.roomId)} #${idx + 1}" data-lightbox-src="${escapeHtml(p.url)}" data-lightbox-cap="P.${escapeHtml(t.roomName || t.roomId)} • Hoàn tất bởi ${escapeHtml(t.completedBy || "Buồng phòng")} (${escapeHtml(formatTimestampVN(t.completedAt))})" />`).join("")}</div>`
          : "";

        let primaryBtn = "";
        if (canAct && t.status === "dirty") {
          primaryBtn = `<button type="button" class="btn btn-primary hk-touch-btn" data-hk-start="${escapeHtml(t.id)}">▶ Bắt đầu dọn</button>`;
        } else if (canAct && t.status === "in_progress") {
          primaryBtn = `<button type="button" class="btn btn-success hk-touch-btn" data-hk-open-complete="${escapeHtml(t.id)}">📷 Chụp/Chọn ảnh &amp; Hoàn tất</button>`;
        }

        const issueBtn = canReportIssue
          ? `<button type="button" class="btn btn-sm" data-hk-report-issue-room="${escapeHtml(t.roomId)}" data-hk-report-issue-task="${escapeHtml(t.id)}">⚠️ Báo sự cố</button>`
          : "";

        const timelineLines = [];
        if (t.startedBy) {
          timelineLines.push(`Bắt đầu: <strong>${escapeHtml(t.startedBy)}</strong> lúc ${escapeHtml(formatTimestampVN(t.startedAt))}`);
        }
        if (t.completedBy) {
          timelineLines.push(`Hoàn tất: <strong>${escapeHtml(t.completedBy)}</strong> lúc ${escapeHtml(formatTimestampVN(t.completedAt))} (${(t.photos || []).length} ảnh)`);
        }

        return `<article class="hk-card ${escapeHtml(t.status)}" data-hk-task-id="${escapeHtml(t.id)}">
          <div class="hk-card-top">
            <div>
              <div class="hk-room-title">
                <span>Phòng ${escapeHtml(room ? room.name : t.roomId)}</span>
                <span class="hk-type-pill">${escapeHtml(typeMeta.label)}</span>
                ${t.isCarryover ? `<span class="hk-carryover-pill">⚠️ Tồn từ ${escapeHtml(formatDateVN(t.serviceDate).slice(0, 5))}</span>` : ""}
                ${hasBlocking ? `<span class="room-issue-pill">🚫 Có sự cố chặn phòng</span>` : (roomIssues.length > 0 ? `<span class="room-issue-pill soft">⚠️ ${roomIssues.length} sự cố mở</span>` : "")}
              </div>
              <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
                ${room ? `Tầng ${room.floor} • ${escapeHtml(room.type)} • ${escapeHtml(room.bedInfo)}` : ""} • Ngày việc: ${escapeHtml(formatDateVN(t.serviceDate))}
              </div>
            </div>
            <span class="hk-status-badge ${escapeHtml(t.status)}">${escapeHtml(stMeta.label)}</span>
          </div>
          ${t.note ? `<div class="hk-card-meta">📝 ${escapeHtml(t.note)}</div>` : ""}
          ${timelineLines.length > 0 ? `<div class="hk-card-meta">${timelineLines.join(" • ")}</div>` : ""}
          ${photosHtml}
          <div class="hk-card-actions">
            <div>${primaryBtn}</div>
            <div>${issueBtn}</div>
          </div>
        </article>`;
      }).join("");
    }

    // Render Issues List
    const filteredIssues = allIssues.filter((iss) => {
      if (!iss) return false;
      if (hkState.issueFilterStatus === "active" && iss.status === "resolved") return false;
      if (["open", "in_progress", "resolved"].includes(hkState.issueFilterStatus) && iss.status !== hkState.issueFilterStatus) return false;
      if (hkState.issueFilterRoom !== "all" && iss.roomId !== hkState.issueFilterRoom) return false;
      return true;
    });

    const canUpdateIssues = userCan("issues:manage");
    if (filteredIssues.length === 0) {
      $("hk-issues-list").innerHTML = `<div style="text-align:center; padding:28px 14px; color:var(--text-muted); font-size:13px; border:1px dashed var(--border-strong); border-radius:var(--radius-md);">
        Không có sự cố phòng nào phù hợp bộ lọc hiện tại.
      </div>`;
    } else {
      $("hk-issues-list").innerHTML = filteredIssues.map((iss) => {
        const room = getRoomById(iss.roomId);
        const sevMeta = ISSUE_SEVERITIES[iss.severity] || ISSUE_SEVERITIES.medium;
        const stMeta = ISSUE_STATUSES[iss.status] || ISSUE_STATUSES.open;
        const stBadgeCls = iss.status === "resolved" ? "cleaned" : (iss.status === "in_progress" ? "in_progress" : "dirty");
        const photosHtml = Array.isArray(iss.photos) && iss.photos.length > 0
          ? `<div class="hk-photos-row">${iss.photos.map((p, idx) => `<img class="hk-photo-thumb" src="${escapeHtml(p.url)}" alt="Ảnh sự cố P.${escapeHtml(iss.roomName || iss.roomId)} #${idx + 1}" data-lightbox-src="${escapeHtml(p.url)}" data-lightbox-cap="Sự cố P.${escapeHtml(iss.roomName || iss.roomId)}: ${escapeHtml(iss.description)}" />`).join("")}</div>`
          : "";

        let statusActions = "";
        if (canUpdateIssues) {
          const btns = [];
          if (iss.status === "open") {
            btns.push(`<button type="button" class="btn btn-sm" data-issue-set-status="${escapeHtml(iss.id)}" data-next-status="in_progress">🔧 Chuyển Đang xử lý</button>`);
          }
          if (iss.status !== "resolved") {
            btns.push(`<button type="button" class="btn btn-sm btn-success" data-issue-set-status="${escapeHtml(iss.id)}" data-next-status="resolved">✓ Đánh dấu Đã xử lý</button>`);
          } else {
            btns.push(`<button type="button" class="btn btn-sm" data-issue-set-status="${escapeHtml(iss.id)}" data-next-status="open">↺ Mở lại sự cố</button>`);
          }
          statusActions = `<div class="hk-card-actions"><div style="display:flex; gap:6px; flex-wrap:wrap;">${btns.join("")}</div></div>`;
        }

        return `<article class="hk-card issue-${escapeHtml(iss.status)}" data-issue-id="${escapeHtml(iss.id)}">
          <div class="hk-card-top">
            <div>
              <div class="hk-room-title">
                <span>Phòng ${escapeHtml(room ? room.name : iss.roomId)}</span>
                <span class="hk-type-pill">Mức: ${escapeHtml(sevMeta.label)}</span>
                ${iss.blocksRoom && iss.status !== "resolved" ? `<span class="room-issue-pill">🚫 Chưa thể giao khách</span>` : ""}
              </div>
              <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
                Người báo: <strong>${escapeHtml(iss.reportedBy || "Nhân viên")}</strong> • ${escapeHtml(formatTimestampVN(iss.reportedAt))}
              </div>
            </div>
            <span class="hk-status-badge ${stBadgeCls}">${escapeHtml(stMeta.label)}</span>
          </div>
          <div style="font-size:13px; font-weight:700; color:var(--text-primary);">${escapeHtml(iss.description)}</div>
          ${iss.resolvedAt ? `<div class="hk-card-meta" style="color:var(--status-paid);">✓ Đã xử lý bởi <strong>${escapeHtml(iss.resolvedBy || "Quản lý")}</strong> lúc ${escapeHtml(formatTimestampVN(iss.resolvedAt))}</div>` : ""}
          ${photosHtml}
          ${statusActions}
        </article>`;
      }).join("");
    }
  }

  function showHkCompleteError(msg) {
    $("hk-complete-error").textContent = msg || "";
    $("hk-complete-error").classList.toggle("show", Boolean(msg));
  }

  function renderHkCompletePhotoPreviews() {
    const grid = $("hk-photo-preview-list");
    if (!grid) return;
    if (hkState.completePhotos.length === 0) {
      grid.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:8px; border:1px dashed var(--border-strong); border-radius:var(--radius-sm); width:100%;">Chưa có ảnh nào. Hãy chụp bằng camera hoặc chọn ảnh từ điện thoại (bắt buộc tối thiểu 1 ảnh).</div>`;
      return;
    }
    grid.innerHTML = hkState.completePhotos.map((item, idx) => `
      <div class="hk-preview-item" data-preview-id="${escapeHtml(item.localId)}">
        <img src="${escapeHtml(item.dataUrl)}" alt="Ảnh dọn phòng #${idx + 1}" data-lightbox-src="${escapeHtml(item.dataUrl)}" data-lightbox-cap="Ảnh hoàn tất dọn phòng #${idx + 1}" />
        <div class="hk-preview-item-bar">
          <span style="font-size:10px; font-weight:700; color:${item.uploadedPhoto ? "var(--status-paid)" : "var(--text-muted)"};">${item.uploadedPhoto ? "✓ Đã tải" : "Chờ gửi"}</span>
          <button type="button" class="btn btn-sm" style="padding:1px 6px; font-size:10.5px;" data-remove-hk-photo="${escapeHtml(item.localId)}">✕</button>
        </div>
      </div>`).join("");
  }

  function openHkCompleteModal(taskId) {
    const tasks = typeof store.getHousekeepingTasks === "function" ? store.getHousekeepingTasks() : [];
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    hkState.completingTaskId = task.id;
    hkState.completePhotos = [];
    $("hk-complete-task-id").value = task.id;
    $("hk-complete-title").textContent = `📷 Hoàn tất dọn Phòng ${task.roomName || task.roomId}`;
    $("hk-complete-sub").textContent = "Yêu cầu ít nhất 1 ảnh chụp phòng sau khi dọn của chính lượt dọn này";
    $("hk-complete-note").value = task.note || "";
    $("btn-hk-confirm-complete").textContent = "✓ Xác nhận Đã dọn";
    $("btn-hk-confirm-complete").disabled = false;
    showHkCompleteError("");
    renderHkCompletePhotoPreviews();
    $("hk-complete-modal").classList.add("open");
  }

  async function addFilesToPhotoDraft(files, targetArray, onUpdated, errFn) {
    if (!files || files.length === 0) return;
    errFn("");
    for (const f of Array.from(files)) {
      if (targetArray.length >= 6) {
        errFn("Tối đa 6 ảnh cho mỗi lượt.");
        break;
      }
      const res = await compressImageFileToDataUrl(f);
      if (!res.ok) {
        errFn(res.error);
        continue;
      }
      targetArray.push({
        localId: `loc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        dataUrl: res.dataUrl,
        uploadedPhoto: null
      });
    }
    onUpdated();
  }

  async function submitHkTaskCompletion() {
    if (hkState.isSubmitting) return;
    const taskId = $("hk-complete-task-id").value;
    if (!taskId) return;
    showHkCompleteError("");

    if (hkState.completePhotos.length === 0) {
      showHkCompleteError("Bắt buộc chụp hoặc chọn ít nhất 1 ảnh hoàn tất của chính lượt dọn này trước khi chuyển sang Đã dọn.");
      return;
    }

    hkState.isSubmitting = true;
    const btn = $("btn-hk-confirm-complete");
    btn.disabled = true;
    btn.textContent = "⏳ Đang tải ảnh lên máy chủ...";
    try {
      // 1. Upload every pending photo FIRST; if any fails, keep task strictly in_progress and preserve photos for retry!
      for (const item of hkState.completePhotos) {
        if (item.uploadedPhoto) continue;
        const upRes = await store.uploadPhoto(item.dataUrl, "housekeeping");
        if (!upRes || !upRes.ok || !upRes.photo) {
          showHkCompleteError((upRes && upRes.error) || "Tải ảnh thất bại — công việc vẫn giữ ở trạng thái Đang dọn. Vui lòng thử lại.");
          btn.textContent = "↻ Thử tải lại ảnh & Hoàn tất";
          renderHkCompletePhotoPreviews();
          return;
        }
        item.uploadedPhoto = upRes.photo;
        renderHkCompletePhotoPreviews();
      }

      btn.textContent = "⏳ Đang xác nhận Đã dọn...";
      const uploadedList = hkState.completePhotos.map((p) => p.uploadedPhoto).filter(Boolean);
      const photoIds = uploadedList.map((p) => p.id);
      const note = $("hk-complete-note").value.trim();

      const res = await store.completeHousekeepingTask(taskId, { photoIds, photos: uploadedList, note });
      if (!res || !res.ok) {
        showHkCompleteError((res && res.error) || "Chưa thể hoàn tất công việc — vui lòng thử lại.");
        btn.textContent = "↻ Thử lại hoàn tất";
        return;
      }

      $("hk-complete-modal").classList.remove("open");
      hkState.completePhotos = [];
      hkState.completingTaskId = "";
      renderHousekeepingWorkspace();
      updateHkHeaderBadge();
      if (isPcViewActive() && userCan("bookings:read")) renderCalendar();
      showToast(`✅ Đã hoàn tất dọn phòng P.${(res.task && res.task.roomName) || ""}!`);
    } finally {
      hkState.isSubmitting = false;
      btn.disabled = false;
      if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
    }
  }

  function showIssueError(msg) {
    $("issue-error").textContent = msg || "";
    $("issue-error").classList.toggle("show", Boolean(msg));
  }

  function renderIssuePhotoPreviews() {
    const grid = $("issue-photo-preview-list");
    if (!grid) return;
    if (hkState.issuePhotos.length === 0) {
      grid.innerHTML = "";
      return;
    }
    grid.innerHTML = hkState.issuePhotos.map((item, idx) => `
      <div class="hk-preview-item">
        <img src="${escapeHtml(item.dataUrl)}" alt="Ảnh sự cố #${idx + 1}" data-lightbox-src="${escapeHtml(item.dataUrl)}" data-lightbox-cap="Ảnh minh họa sự cố #${idx + 1}" />
        <div class="hk-preview-item-bar">
          <span style="font-size:10px; color:var(--text-muted);">${item.uploadedPhoto ? "✓ Đã tải" : "Ảnh"}</span>
          <button type="button" class="btn btn-sm" style="padding:1px 6px; font-size:10.5px;" data-remove-issue-photo="${escapeHtml(item.localId)}">✕</button>
        </div>
      </div>`).join("");
  }

  function openReportIssueModal({ roomId = "101", taskId = "" } = {}) {
    if (!userCan("issues:create")) {
      showToast("Bạn không có quyền báo sự cố.");
      return;
    }
    hkState.issuePhotos = [];
    showIssueError("");
    $("issue-task-id").value = taskId || "";
    if ($("issue-room-id") && roomId) $("issue-room-id").value = roomId;
    $("issue-severity").value = "high";
    $("issue-description").value = "";
    $("issue-blocks-room").checked = true;
    const status = typeof store.getStatus === "function" ? store.getStatus() : {};
    const reporter = (status.user && status.user.staffName) || "Nhân viên";
    $("issue-reporter-meta").textContent = `Người báo: ${reporter} • Thời gian: ${formatTimestampVN(new Date().toISOString())}`;
    renderIssuePhotoPreviews();
    $("issue-modal").classList.add("open");
    setTimeout(() => { if ($("issue-description")) $("issue-description").focus(); }, 40);
  }

  /* -------------------- Staff Accounts & Roles Manager (Manager ONLY) -------------------- */

  function showAccountError(msg) {
    $("acc-error").textContent = msg || "";
    $("acc-error").classList.toggle("show", Boolean(msg));
  }

  function resetAccountForm(editAcc = null) {
    showAccountError("");
    const roleSelect = $("acc-role");
    const existingTempSuper = roleSelect.querySelector("option[data-temp-super='1']");
    if (existingTempSuper) existingTempSuper.remove();

    if (editAcc) {
      const normRole = normalizeRole(editAcc.role);
      $("acc-id").value = editAcc.id;
      $("acc-form-title").textContent = `✏️ Sửa tài khoản — ${editAcc.staffName} (@${editAcc.username})`;
      $("btn-acc-reset").style.display = "inline-flex";
      $("acc-staff-name").value = editAcc.staffName || "";
      $("acc-username").value = editAcc.username || "";
      $("acc-username").disabled = true;
      if (normRole === "super_admin") {
        const opt = document.createElement("option");
        opt.value = "super_admin";
        opt.dataset.tempSuper = "1";
        opt.textContent = "👑 Tổng quản lý (Quyền hạn cao nhất — duy nhất)";
        roleSelect.insertBefore(opt, roleSelect.firstChild);
        roleSelect.value = "super_admin";
        roleSelect.disabled = true;
      } else {
        roleSelect.disabled = false;
        roleSelect.value = normRole;
      }
      $("acc-passcode").value = "";
      $("acc-passcode-label").textContent = "Đổi mật khẩu mới (để trống nếu giữ nguyên)";
      $("btn-acc-save").textContent = "💾 Cập nhật tài khoản";
    } else {
      $("acc-id").value = "";
      $("acc-form-title").textContent = "➕ Cấp tài khoản & mật khẩu nhân viên mới";
      $("btn-acc-reset").style.display = "none";
      $("acc-staff-name").value = "";
      $("acc-username").value = "";
      $("acc-username").disabled = false;
      roleSelect.disabled = false;
      roleSelect.value = "reception";
      $("acc-passcode").value = "";
      $("acc-passcode-label").textContent = "Mật khẩu (tối thiểu 4 ký tự) *";
      $("btn-acc-save").textContent = "💾 Cấp tài khoản";
    }
  }

  function renderAccountsList(accounts) {
    const list = Array.isArray(accounts) ? accounts : [];
    if (list.length === 0) {
      $("accounts-list").innerHTML = `<div style="padding:14px; font-size:12.5px; color:var(--text-muted); text-align:center;">Chưa có tài khoản nhân viên nào trong cơ sở dữ liệu. Hãy cấp tài khoản mới ở biểu mẫu phía trên.</div>`;
      return;
    }
    $("accounts-list").innerHTML = list.map((acc) => {
      const normRole = normalizeRole(acc.role);
      const isSuper = normRole === "super_admin";
      const statusBadge = acc.active
        ? `<span class="costs-status-badge actual">Đang hoạt động</span>`
        : `<span class="costs-status-badge partial">🚫 Đã chặn truy cập</span>`;
      const roleLabelHtml = isSuper
        ? `<span class="role-badge super_admin">👑 ${escapeHtml(getRoleLabel(normRole))}</span>`
        : `<span class="role-badge ${escapeHtml(normRole)}">${escapeHtml(getRoleLabel(normRole))}</span>`;
      const metaText = isSuper
        ? `Tạo lúc: ${escapeHtml(formatTimestampVN(acc.createdAt))} • Tài khoản quyền hạn cao nhất duy nhất (được bảo vệ)`
        : `Tạo lúc: ${escapeHtml(formatTimestampVN(acc.createdAt))}`;
      const actionButtons = isSuper
        ? `<button type="button" class="btn btn-sm" data-acc-edit="${escapeHtml(acc.id)}">✏️ Sửa / Đổi MK</button>`
        : `<button type="button" class="btn btn-sm" data-acc-edit="${escapeHtml(acc.id)}">✏️ Sửa / Đổi MK</button>
           <button type="button" class="btn btn-sm ${acc.active ? "btn-danger" : "btn-success"}" data-acc-toggle-active="${escapeHtml(acc.id)}" data-next-active="${acc.active ? "0" : "1"}">${acc.active ? "🚫 Chặn truy cập" : "🔓 Mở chặn"}</button>
           <button type="button" class="btn btn-sm btn-danger" data-acc-delete="${escapeHtml(acc.id)}" data-acc-label="${escapeHtml(`${acc.staffName} (@${acc.username})`)}">🗑️ Xóa</button>`;
      return `<div class="costs-item-cfg-row ${acc.active ? "" : "inactive"}">
        <div>
          <div style="font-weight:800; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <span>${escapeHtml(acc.staffName)}</span>
            <span style="font-family:monospace; font-size:11.5px; color:var(--text-muted);">@${escapeHtml(acc.username)}</span>
            ${roleLabelHtml}
            ${statusBadge}
          </div>
          <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">${metaText}</div>
        </div>
        <div class="costs-item-actions">${actionButtons}</div>
      </div>`;
    }).join("");
  }

  async function openAccountsModal() {
    if (!userCan("accounts:manage")) {
      showToast("Chức năng quản trị tài khoản chỉ dành riêng cho Tổng quản lý.");
      return;
    }
    resetAccountForm(null);
    $("accounts-modal").classList.add("open");
    const res = await store.listAccounts();
    if (!res || !res.ok) {
      showAccountError((res && res.error) || "Không tải được danh sách tài khoản.");
      renderAccountsList(store.getAccounts ? store.getAccounts() : []);
      return;
    }
    renderAccountsList(res.accounts || []);
  }

  window.PMSHousekeepingApp = {
    open: openHousekeepingWorkspace,
    openIssues: (roomId = "all") => openHousekeepingWorkspace({ tab: "issues", roomId }),
    openReportIssue: openReportIssueModal,
    openAccounts: openAccountsModal,
    applyRolePermissionsUI,
    renderIssueBanner
  };

  function syncAuthOverlay(errorMessage) {
    const overlay = $("auth-overlay");
    if (!overlay || typeof store.getAuthState !== "function") return;
    const auth = store.getAuthState();
    const ver = store.getVersionInfo ? store.getVersionInfo() : {};
    const verEl = $("auth-version-label");
    if (verEl) {
      verEl.textContent = ver.appVersion ? `v${ver.appVersion}${ver.buildId ? ` • ${ver.buildId}` : ""}` : "";
    }

    const staffSelect = $("auth-staff");
    if (staffSelect) {
      const prev = staffSelect.value;
      const pub = Array.isArray(auth.accountsPublic) ? auth.accountsPublic : [];
      if (pub.length > 0) {
        staffSelect.innerHTML = pub
          .map((acc) => {
            const normRole = normalizeRole(acc.role);
            const prefix = normRole === "super_admin" ? "👑 " : "";
            return `<option value="${escapeHtml(acc.username)}">${prefix}${escapeHtml(acc.staffName)} — ${escapeHtml(getRoleLabel(normRole))}</option>`;
          })
          .join("");
        if (prev && pub.some((a) => a.username === prev)) staffSelect.value = prev;
      } else if (Array.isArray(auth.staffList) && auth.staffList.length > 0) {
        staffSelect.innerHTML = auth.staffList.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
        if (prev && auth.staffList.includes(prev)) staffSelect.value = prev;
      }
    }

    const errEl = $("auth-error");
    if (errEl) {
      if (errorMessage) {
        errEl.textContent = errorMessage;
        errEl.classList.add("show");
      } else if (!auth.authConfigured) {
        errEl.textContent = "Máy chủ chưa được cấu hình mật khẩu vận hành (PMS_AUTH_PASSCODE).";
        errEl.classList.add("show");
      } else {
        errEl.textContent = "";
        errEl.classList.remove("show");
      }
    }

    const shouldShow = auth.authRequired && !auth.authenticated;
    overlay.classList.toggle("open", shouldShow);
  }

  function syncAppUpdateBanner(type, pending) {
    const banner = $("app-update-banner");
    const txt = $("app-update-text");
    if (!banner || !txt) return;
    const ver = pending && pending.appVersion ? `v${pending.appVersion}` : "mới";
    if (type === "update_applying") {
      txt.textContent = `🔄 Đang cập nhật ứng dụng lên phiên bản ${ver}...`;
      banner.classList.add("show");
      $("btn-app-update-now").style.display = "none";
    } else if (type === "update_pending" && pending) {
      txt.textContent = `🔄 Đã có phiên bản mới (${ver}) — nội dung bạn đang nhập vẫn được giữ, sẽ tự cập nhật ngay sau khi lưu/đóng.`;
      $("btn-app-update-now").style.display = "";
      banner.classList.add("show");
    } else {
      banner.classList.remove("show");
    }
  }

  function showPcBookingConflict(latestBooking) {
    const banner = $("pc-edit-conflict-banner");
    const textEl = $("pc-conflict-text");
    if (!banner || !textEl) return;
    if (!latestBooking) {
      textEl.textContent = "⚠️ Đặt phòng này vừa bị xóa từ thiết bị khác. Nội dung bạn đang nhập vẫn được giữ lại để đối chiếu.";
    } else {
      textEl.textContent = `⚠️ Đặt phòng này vừa được cập nhật từ thiết bị khác (rev ${latestBooking.revision}, đã TT ${formatVND(latestBooking.paidAmount)} / ${formatVND(latestBooking.totalAmount)}). Nội dung bạn đang gõ vẫn được giữ nguyên.`;
    }
    banner.classList.add("show");
  }

  /* -------------------- Event Binding & Boot -------------------- */

  function bindEvents() {
    bindDelegatedCalendarEvents();

    // Register PC busy check so live A -> B auto-updates NEVER interrupt open forms or photo uploads
    if (typeof store.registerBusyCheck === "function") {
      store.registerBusyCheck(() =>
        state.isSubmitting ||
        costsState.isSaving ||
        hkState.isSubmitting ||
        $("booking-modal").classList.contains("open") ||
        $("dorm-modal").classList.contains("open") ||
        $("costs-modal").classList.contains("open") ||
        $("hk-complete-modal").classList.contains("open") ||
        $("issue-modal").classList.contains("open") ||
        $("accounts-modal").classList.contains("open") ||
        $("backup-restore-modal").classList.contains("open") ||
        $("receivables-modal").classList.contains("open") ||
        $("cashbook-modal").classList.contains("open") ||
        ($("shifts-modal") && $("shifts-modal").classList.contains("open")) ||
        ($("payables-modal") && $("payables-modal").classList.contains("open"))
      );
    }

    // Unified Login Overlay & Update Banner handlers (shared by PC and Mobile)
    $("auth-staff").addEventListener("change", () => {
      if ($("auth-username")) $("auth-username").value = "";
    });
    $("auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("auth-submit");
      const manualUser = ($("auth-username").value || "").trim();
      const loginId = manualUser || $("auth-staff").value;
      const passcode = $("auth-passcode").value;
      btn.disabled = true;
      btn.textContent = "Đang xác thực...";
      try {
        const res = await store.login(loginId, passcode);
        if (!res.ok) {
          syncAuthOverlay(res.error || "Đăng nhập thất bại.");
          return;
        }
        $("auth-passcode").value = "";
        $("auth-username").value = "";
        syncAuthOverlay("");
        state.bookings = res.bookings || store.getBookings() || [];
        applyRolePermissionsUI();
        if (getUserRole() !== "housekeeping") {
          renderAll();
          updateAutoBackupUI();
        }
        updatePcSyncPill();
        showToast(`Xin chào ${res.user.staffName} (${getRoleLabel(res.user.role)})!`);
      } finally {
        btn.disabled = false;
        btn.textContent = "Đăng nhập";
      }
    });

    const handleLogoutClick = async () => {
      if (!confirm("Đăng xuất tài khoản trên thiết bị này?")) return;
      await store.logout();
      applyRolePermissionsUI();
      syncAuthOverlay("");
      updatePcSyncPill();
    };

    $("btn-pc-logout").addEventListener("click", handleLogoutClick);
    $("btn-hk-logout").addEventListener("click", handleLogoutClick);

    $("btn-app-update-now").addEventListener("click", () => {
      if (typeof store.applyPendingUpdateNow === "function") {
        store.applyPendingUpdateNow();
      }
    });

    // Realtime bidirectional sync from Supabase Realtime / SQLite SSE / BroadcastChannel
    if (typeof store.subscribe === "function") {
      store.subscribe((ev) => {
        const { type, state: snap, remoteEvent } = ev;
        updatePcSyncPill();
        if (type === "auth_required") {
          applyRolePermissionsUI();
          syncAuthOverlay(ev.error || "");
          return;
        }
        if (type === "auth_login") {
          syncAuthOverlay("");
          applyRolePermissionsUI();
        }
        if (type === "update_pending" || type === "update_applying") {
          syncAppUpdateBanner(type, ev.pendingUpdate);
          return;
        }
        if (type === "version") {
          syncAuthOverlay("");
          return;
        }
        if (type === "status") {
          if (getUserRole() !== "housekeeping") renderKPIs();
          return;
        }
        if (!snap) return;
        state.bookings = snap.bookings || [];

        if (type === "remote_change" && remoteEvent && remoteEvent.action === "ISSUE_CREATE") {
          hkState.dismissedAlertIssueId = "";
          if (getUserRole() !== "housekeeping") {
            const rName = remoteEvent.roomId ? `P.${getRoomById(remoteEvent.roomId)?.name || remoteEvent.roomId}` : "phòng";
            showToast(`🚨 Sự cố mới ${rName} từ ${remoteEvent.actor || "Buồng phòng"}!`);
          }
        }
        if (type === "remote_change" && remoteEvent && remoteEvent.action === "HK_COMPLETE" && getUserRole() !== "housekeeping") {
          const rName = remoteEvent.roomId ? `P.${getRoomById(remoteEvent.roomId)?.name || remoteEvent.roomId}` : "phòng";
          showToast(`✅ ${remoteEvent.actor || "Buồng phòng"} đã dọn xong ${rName}`);
        }

        updateHkHeaderBadge();
        renderIssueBanner();
        if ($("hk-workspace").classList.contains("open")) {
          renderHousekeepingWorkspace();
        }
        if ($("accounts-modal").classList.contains("open") && Array.isArray(snap.accounts)) {
          renderAccountsList(snap.accounts);
        }

        if (getUserRole() === "housekeeping") {
          return;
        }

        if (type === "remote_change") {
          const openBkId = $("booking-modal").classList.contains("open") ? $("field-booking-id").value : "";
          if (openBkId) {
            const latest = state.bookings.find((b) => b.id === openBkId);
            if (!latest || Number(latest.revision) !== Number(state.editingBookingRevision)) {
              showPcBookingConflict(latest);
            }
          }
          const openDormId = ($("dorm-modal").classList.contains("open") && $("dorm-slot-form").style.display !== "none") ? $("dorm-field-id").value : "";
          if (openDormId) {
            const latestDorm = state.bookings.find((b) => b.id === openDormId);
            if (!latestDorm || Number(latestDorm.revision) !== Number(state.editingDormRevision)) {
              $("pc-dorm-conflict-banner").classList.add("show");
            }
          }
        }

        if ($("costs-modal").classList.contains("open")) {
          renderOperatingCostsModal();
        }

        if (!isPcViewActive()) {
          pcRenderDirty = true;
          return;
        }

        scheduleRenderAll();
        updateAutoBackupUI();
        if ($("dorm-modal").classList.contains("open") && $("dorm-board-view").style.display !== "none") {
          renderDormBoard();
        }
        if ($("history-modal").classList.contains("open")) {
          renderHistoryModal();
        }
        if ($("group-report-modal").classList.contains("open")) {
          renderGroupReportModal();
        }
        if ($("day-report-modal").classList.contains("open") && state.activeDayReportDate) {
          openDailyReportModal(state.activeDayReportDate);
        }
        if ($("booking-modal").classList.contains("open")) {
          renderModalGroupSummary();
          const curBk = $("field-booking-id").value ? state.bookings.find((b) => b.id === $("field-booking-id").value) : null;
          renderPcBookingOperationalBars($("field-room").value, curBk || null);
        }

        if (type === "remote_change" && remoteEvent && ["CREATE", "UPDATE", "DELETE"].includes(remoteEvent.action)) {
          const verb = remoteEvent.action === "CREATE" ? "vừa đặt mới" : remoteEvent.action === "DELETE" ? "vừa xóa" : "vừa cập nhật";
          const rName = remoteEvent.roomId ? (remoteEvent.roomId === "DORM" ? "Dorm" : `P.${getRoomById(remoteEvent.roomId)?.name || remoteEvent.roomId}`) : "sổ phòng";
          const actor = remoteEvent.actor ? `${remoteEvent.actor} ` : "Thiết bị khác ";
          showToast(`🔄 ${actor}${verb} ${rName}`);
        }
      });
    }

    const pcSyncPill = $("pc-sync-status");
    if (pcSyncPill && typeof store.pullLatest === "function") {
      pcSyncPill.style.cursor = "pointer";
      pcSyncPill.addEventListener("click", async () => {
        const res = await store.pullLatest();
        showToast(res && res.ok ? "✓ Đã đồng bộ dữ liệu mới nhất!" : ((res && res.error) || "Đang kiểm tra kết nối..."));
      });
    }

    $("btn-pc-reload-latest").addEventListener("click", () => {
      const id = $("field-booking-id").value;
      $("pc-edit-conflict-banner").classList.remove("show");
      if (!id) return;
      const latest = (store.getBookings() || []).find((b) => b.id === id);
      if (!latest) {
        $("booking-modal").classList.remove("open");
        showToast("Đặt phòng này đã bị xóa từ thiết bị khác");
        return;
      }
      openBookingModal({ bookingId: id });
    });
    $("btn-pc-dorm-reload-latest").addEventListener("click", () => {
      const id = $("dorm-field-id").value;
      $("pc-dorm-conflict-banner").classList.remove("show");
      if (!id) return;
      const latest = (store.getBookings() || []).find((b) => b.id === id);
      if (!latest) {
        setDormModalMode("board");
        renderDormBoard();
        showToast("Lượt đặt Dorm này đã bị xóa từ thiết bị khác");
        return;
      }
      openDormSlotForm({ bookingId: id });
    });

    // Global error boundary
    window.addEventListener("error", (ev) => {
      logDiagnostic("error", ev.message || "Unhandled error", ev.filename);
    });
    window.addEventListener("unhandledrejection", (ev) => {
      logDiagnostic("error", "Unhandled promise rejection", ev.reason);
    });

    // Midnight rollover watcher (for 24/7 reception screens)
    setInterval(checkMidnightRollover, 30000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkMidnightRollover();
    });

    $("btn-prev-month").addEventListener("click", () => { if (--state.month < 0) { state.month = 11; state.year -= 1; } renderAll(); });
    $("btn-next-month").addEventListener("click", () => { if (++state.month > 11) { state.month = 0; state.year += 1; } renderAll(); });
    $("btn-today").addEventListener("click", () => { const now = new Date(); state.year = now.getFullYear(); state.month = now.getMonth(); renderAll(); setTimeout(() => scrollToToday(true), 30); });
    $("btn-new-booking").addEventListener("click", () => openBookingModal({ roomId: "101", checkin: getTodayISO(), allowRoomSelect: true }));
    $("btn-open-dorm-today").addEventListener("click", () => openDormBoard(getTodayISO()));
    $("btn-open-groups").addEventListener("click", openGroupReportModal);
    $("btn-open-hk").addEventListener("click", () => openHousekeepingWorkspace({ tab: "tasks", roomId: "all", dateISO: getTodayISO() }));
    $("btn-open-receivables").addEventListener("click", () => {
      if (window.PMSFinanceApp) window.PMSFinanceApp.openReceivables({ asOfDate: state.lastArAsOfDate || getVietnamTodayISO() });
    });
    if ($("btn-open-shifts")) {
      $("btn-open-shifts").addEventListener("click", () => {
        if (window.PMSFinanceApp) window.PMSFinanceApp.openShifts();
      });
    }
    $("btn-open-cashbook").addEventListener("click", () => {
      if (window.PMSFinanceApp) window.PMSFinanceApp.openCashbook();
    });
    if ($("btn-open-payables")) {
      $("btn-open-payables").addEventListener("click", () => {
        if (window.PMSFinanceApp) window.PMSFinanceApp.openPayables();
      });
    }
    $("btn-open-costs").addEventListener("click", () => openOperatingCostsModal());
    $("btn-open-accounts").addEventListener("click", openAccountsModal);
    $("btn-open-history").addEventListener("click", openHistoryModal);
    $("btn-open-backup-restore").addEventListener("click", openBackupRestoreModal);
    $("btn-open-day-report-today").addEventListener("click", () => openDailyReportModal(getTodayISO()));
    $("kpi-dorm-quick-btn").addEventListener("click", () => openDormBoard(getTodayISO()));
    $("kpi-month-paid-btn").addEventListener("click", () => {
      if (window.PMSFinanceApp) window.PMSFinanceApp.openMonthlyReceipts(state.year, state.month);
    });
    $("kpi-month-debt-btn").addEventListener("click", () => {
      if (window.PMSFinanceApp) window.PMSFinanceApp.openReceivables({ asOfDate: state.lastArAsOfDate || getVietnamTodayISO(), status: "debt" });
    });
    initSidebarNavigation();
    initDropdownMenus();
    $("btn-cancel-clipboard").addEventListener("click", () => clearClipboard(false));
    $("btn-export-csv").addEventListener("click", exportCSV);
    $("btn-backup-json").addEventListener("click", backupJSON);
    $("input-restore-json").addEventListener("change", (e) => { restoreJSON(e.target.files[0]); e.target.value = ""; });

    // Live Issue Alert Banner actions
    $("btn-issue-alert-view").addEventListener("click", () => openHousekeepingWorkspace({ tab: "issues", roomId: "all" }));
    $("btn-issue-alert-dismiss").addEventListener("click", () => {
      const issues = typeof store.getMaintenanceIssues === "function" ? store.getMaintenanceIssues() : [];
      const openIssues = issues.filter((i) => i && i.status !== "resolved");
      const primary = openIssues.find((i) => i.blocksRoom) || openIssues[0];
      if (primary) hkState.dismissedAlertIssueId = primary.id;
      $("issue-alert-banner").classList.remove("show");
    });

    // PC Booking Modal: Room Issue jump + Check-out + Stayover cleaning actions
    $("pc-room-issue-warning").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pc-jump-issues]");
      if (!btn) return;
      openHousekeepingWorkspace({ tab: "issues", roomId: btn.dataset.pcJumpIssues });
    });

    $("btn-checkout-booking").addEventListener("click", async () => {
      const id = $("field-booking-id").value;
      if (!id || state.isSubmitting) return;
      state.isSubmitting = true;
      $("btn-checkout-booking").disabled = true;
      try {
        const res = await store.checkoutBooking(id, { serviceDate: getTodayISO() });
        if (!res || !res.ok) {
          showFormError((res && res.error) || "Không thể xác nhận trả phòng.");
          return;
        }
        state.bookings = store.getBookings() || state.bookings;
        const latest = state.bookings.find((b) => b.id === id) || res.booking;
        if (latest) {
          state.editingBookingRevision = Number(latest.revision) || state.editingBookingRevision;
          state.editingOriginalBooking = { ...latest, confirmationPdf: latest.confirmationPdf ? { ...latest.confirmationPdf } : null };
          renderPcBookingOperationalBars(latest.roomId, latest);
        }
        renderAll();
        const rName = getRoomById(latest ? latest.roomId : $("field-room").value)?.name || $("field-room").value;
        showToast(res.idempotentHit || res.alreadyCheckedOut || res.created === false
          ? `✓ P.${rName} đã trả phòng trước đó — việc dọn phòng đã tồn tại (không tạo trùng).`
          : `🚪 Đã check-out P.${rName} → Tự động tạo việc Dọn sau trả phòng!`);
      } finally {
        state.isSubmitting = false;
        $("btn-checkout-booking").disabled = false;
      }
    });

    $("btn-request-stayover").addEventListener("click", async () => {
      const roomId = $("field-room").value;
      if (!roomId || state.isSubmitting) return;
      state.isSubmitting = true;
      $("btn-request-stayover").disabled = true;
      try {
        const res = await store.createHousekeepingTask({
          roomId,
          taskType: "stayover",
          serviceDate: getTodayISO(),
          note: "Dọn trong kỳ lưu trú theo yêu cầu lễ tân"
        });
        if (!res || !res.ok) {
          showFormError((res && res.error) || "Không thể tạo việc dọn phòng.");
          return;
        }
        renderAll();
        showToast(`🧹 Đã tạo việc Dọn trong kỳ lưu trú cho P.${getRoomById(roomId)?.name || roomId} (khách vẫn đang ở)`);
      } finally {
        state.isSubmitting = false;
        $("btn-request-stayover").disabled = false;
      }
    });

    // Housekeeping Workspace events
    $("btn-hk-close").addEventListener("click", () => {
      if (getUserRole() === "housekeeping") return;
      $("hk-workspace").classList.remove("open");
    });
    $("hk-workspace").addEventListener("click", (e) => {
      if (e.target === $("hk-workspace") && getUserRole() !== "housekeeping") {
        $("hk-workspace").classList.remove("open");
      }
    });
    $("btn-hk-tab-tasks").addEventListener("click", () => { setHousekeepingTab("tasks"); renderHousekeepingWorkspace(); });
    $("btn-hk-tab-issues").addEventListener("click", () => { setHousekeepingTab("issues"); renderHousekeepingWorkspace(); });
    $("hk-filter-date").addEventListener("change", () => {
      hkState.filterDate = $("hk-filter-date").value || getTodayISO();
      renderHousekeepingWorkspace();
    });
    $("hk-filter-room").addEventListener("change", () => {
      hkState.filterRoom = $("hk-filter-room").value || "all";
      renderHousekeepingWorkspace();
    });
    $("hk-filter-status").addEventListener("change", () => {
      hkState.filterStatus = $("hk-filter-status").value || "all";
      renderHousekeepingWorkspace();
    });
    $("btn-hk-today").addEventListener("click", () => {
      hkState.filterDate = getTodayISO();
      hkState.filterRoom = "all";
      hkState.filterStatus = "all";
      renderHousekeepingWorkspace();
    });
    $("btn-hk-toggle-create").addEventListener("click", () => {
      const f = $("hk-create-form");
      const show = f.style.display === "none";
      f.style.display = show ? "block" : "none";
      if (show) {
        $("hk-new-date").value = hkState.filterDate || getTodayISO();
        $("hk-new-type").value = "stayover";
        $("hk-new-note").value = "";
        $("hk-create-error").textContent = "";
        $("hk-create-error").classList.remove("show");
      }
    });
    $("btn-hk-create-cancel").addEventListener("click", () => { $("hk-create-form").style.display = "none"; });
    $("hk-create-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (hkState.isSubmitting) return;
      $("hk-create-error").textContent = "";
      $("hk-create-error").classList.remove("show");
      hkState.isSubmitting = true;
      $("btn-hk-create-submit").disabled = true;
      try {
        const res = await store.createHousekeepingTask({
          roomId: $("hk-new-room").value,
          taskType: $("hk-new-type").value,
          serviceDate: $("hk-new-date").value || getTodayISO(),
          note: $("hk-new-note").value.trim()
        });
        if (!res || !res.ok) {
          $("hk-create-error").textContent = (res && res.error) || "Không thể tạo việc dọn phòng.";
          $("hk-create-error").classList.add("show");
          return;
        }
        $("hk-create-form").style.display = "none";
        hkState.filterDate = res.task.serviceDate;
        renderHousekeepingWorkspace();
        updateHkHeaderBadge();
        if (isPcViewActive() && userCan("bookings:read")) renderCalendar();
        showToast(`🧹 Đã giao việc ${(HK_TASK_TYPES[res.task.taskType] || HK_TASK_TYPES.stayover).label} cho P.${res.task.roomName}`);
      } finally {
        hkState.isSubmitting = false;
        $("btn-hk-create-submit").disabled = false;
      }
    });

    $("hk-tasks-list").addEventListener("click", async (e) => {
      const img = e.target.closest("[data-lightbox-src]");
      if (img) return openPhotoLightbox(img.dataset.lightboxSrc, img.dataset.lightboxCap);

      const startBtn = e.target.closest("[data-hk-start]");
      if (startBtn) {
        if (hkState.isSubmitting) return;
        hkState.isSubmitting = true;
        startBtn.disabled = true;
        try {
          const res = await store.startHousekeepingTask(startBtn.dataset.hkStart);
          if (!res || !res.ok) return showToast((res && res.error) || "Không thể bắt đầu dọn.");
          renderHousekeepingWorkspace();
          if (isPcViewActive() && userCan("bookings:read")) renderCalendar();
          showToast(`🟡 Đang dọn P.${(res.task && res.task.roomName) || ""}`);
        } finally {
          hkState.isSubmitting = false;
          startBtn.disabled = false;
        }
        return;
      }

      const compBtn = e.target.closest("[data-hk-open-complete]");
      if (compBtn) {
        openHkCompleteModal(compBtn.dataset.hkOpenComplete);
        return;
      }

      const issBtn = e.target.closest("[data-hk-report-issue-room]");
      if (issBtn) {
        openReportIssueModal({
          roomId: issBtn.dataset.hkReportIssueRoom,
          taskId: issBtn.dataset.hkReportIssueTask || ""
        });
      }
    });

    // Photo Proof Completion Modal events
    $("hk-photo-camera").addEventListener("change", async (e) => {
      await addFilesToPhotoDraft(e.target.files, hkState.completePhotos, renderHkCompletePhotoPreviews, showHkCompleteError);
      e.target.value = "";
    });
    $("hk-photo-gallery").addEventListener("change", async (e) => {
      await addFilesToPhotoDraft(e.target.files, hkState.completePhotos, renderHkCompletePhotoPreviews, showHkCompleteError);
      e.target.value = "";
    });
    $("hk-photo-preview-list").addEventListener("click", (e) => {
      const remBtn = e.target.closest("[data-remove-hk-photo]");
      if (remBtn) {
        hkState.completePhotos = hkState.completePhotos.filter((p) => p.localId !== remBtn.dataset.removeHkPhoto);
        renderHkCompletePhotoPreviews();
        return;
      }
      const img = e.target.closest("[data-lightbox-src]");
      if (img) openPhotoLightbox(img.dataset.lightboxSrc, img.dataset.lightboxCap);
    });
    $("btn-hk-confirm-complete").addEventListener("click", submitHkTaskCompletion);
    $("btn-close-hk-complete").onclick = $("btn-cancel-hk-complete").onclick = () => {
      $("hk-complete-modal").classList.remove("open");
      if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
    };

    // Issues Tab & Report Issue Modal events
    $("hk-issue-filter-status").addEventListener("change", () => {
      hkState.issueFilterStatus = $("hk-issue-filter-status").value || "active";
      renderHousekeepingWorkspace();
    });
    $("hk-issue-filter-room").addEventListener("change", () => {
      hkState.issueFilterRoom = $("hk-issue-filter-room").value || "all";
      renderHousekeepingWorkspace();
    });
    $("btn-open-report-issue").addEventListener("click", () => {
      const targetRoom = hkState.issueFilterRoom !== "all" ? hkState.issueFilterRoom : (hkState.filterRoom !== "all" ? hkState.filterRoom : "101");
      openReportIssueModal({ roomId: targetRoom });
    });
    $("hk-issues-list").addEventListener("click", async (e) => {
      const img = e.target.closest("[data-lightbox-src]");
      if (img) return openPhotoLightbox(img.dataset.lightboxSrc, img.dataset.lightboxCap);

      const stBtn = e.target.closest("[data-issue-set-status]");
      if (stBtn) {
        if (hkState.isSubmitting) return;
        hkState.isSubmitting = true;
        stBtn.disabled = true;
        try {
          const res = await store.updateMaintenanceIssue(stBtn.dataset.issueSetStatus, { status: stBtn.dataset.nextStatus });
          if (!res || !res.ok) return showToast((res && res.error) || "Không thể cập nhật trạng thái sự cố.");
          renderHousekeepingWorkspace();
          updateHkHeaderBadge();
          renderIssueBanner();
          if (isPcViewActive() && userCan("bookings:read")) renderCalendar();
          showToast(`✓ Đã cập nhật sự cố sang ${(ISSUE_STATUSES[stBtn.dataset.nextStatus] || ISSUE_STATUSES.open).label}`);
        } finally {
          hkState.isSubmitting = false;
          stBtn.disabled = false;
        }
      }
    });

    $("issue-photo-camera").addEventListener("change", async (e) => {
      await addFilesToPhotoDraft(e.target.files, hkState.issuePhotos, renderIssuePhotoPreviews, showIssueError);
      e.target.value = "";
    });
    $("issue-photo-gallery").addEventListener("change", async (e) => {
      await addFilesToPhotoDraft(e.target.files, hkState.issuePhotos, renderIssuePhotoPreviews, showIssueError);
      e.target.value = "";
    });
    $("issue-photo-preview-list").addEventListener("click", (e) => {
      const remBtn = e.target.closest("[data-remove-issue-photo]");
      if (remBtn) {
        hkState.issuePhotos = hkState.issuePhotos.filter((p) => p.localId !== remBtn.dataset.removeIssuePhoto);
        renderIssuePhotoPreviews();
        return;
      }
      const img = e.target.closest("[data-lightbox-src]");
      if (img) openPhotoLightbox(img.dataset.lightboxSrc, img.dataset.lightboxCap);
    });
    $("issue-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (hkState.isSubmitting) return;
      showIssueError("");
      const description = $("issue-description").value.trim();
      if (!description) {
        showIssueError("Vui lòng nhập mô tả sự cố trong phòng.");
        return;
      }
      hkState.isSubmitting = true;
      $("btn-submit-issue").disabled = true;
      try {
        for (const item of hkState.issuePhotos) {
          if (item.uploadedPhoto) continue;
          const upRes = await store.uploadPhoto(item.dataUrl, "issue");
          if (!upRes || !upRes.ok || !upRes.photo) {
            showIssueError((upRes && upRes.error) || "Tải ảnh sự cố thất bại — vui lòng thử lại.");
            return;
          }
          item.uploadedPhoto = upRes.photo;
        }
        const uploadedList = hkState.issuePhotos.map((p) => p.uploadedPhoto).filter(Boolean);
        const res = await store.reportMaintenanceIssue({
          roomId: $("issue-room-id").value,
          taskId: $("issue-task-id").value || "",
          severity: $("issue-severity").value,
          description,
          blocksRoom: $("issue-blocks-room").checked,
          photoIds: uploadedList.map((p) => p.id),
          photos: uploadedList
        });
        if (!res || !res.ok) {
          showIssueError((res && res.error) || "Không thể gửi báo cáo sự cố.");
          return;
        }
        $("issue-modal").classList.remove("open");
        hkState.issuePhotos = [];
        hkState.dismissedAlertIssueId = "";
        renderHousekeepingWorkspace();
        updateHkHeaderBadge();
        renderIssueBanner();
        if (isPcViewActive() && userCan("bookings:read")) renderCalendar();
        showToast(`🚨 Đã báo sự cố P.${(res.issue && res.issue.roomName) || $("issue-room-id").value}!`);
      } finally {
        hkState.isSubmitting = false;
        $("btn-submit-issue").disabled = false;
        if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
      }
    });
    $("btn-close-issue").onclick = $("btn-cancel-issue").onclick = () => {
      $("issue-modal").classList.remove("open");
      if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
    };

    // Staff Accounts Manager Modal events
    $("btn-acc-reset").addEventListener("click", () => resetAccountForm(null));
    $("accounts-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      showAccountError("");
      const editId = $("acc-id").value;
      const staffName = $("acc-staff-name").value.trim();
      const username = $("acc-username").value.trim();
      const role = $("acc-role").value;
      const passcode = $("acc-passcode").value;

      if (!staffName) return showAccountError("Vui lòng nhập họ tên hiển thị.");
      if (!editId && !username) return showAccountError("Vui lòng nhập tên đăng nhập.");
      if (!editId && passcode.length < 4) return showAccountError("Mật khẩu phải có ít nhất 4 ký tự.");

      $("btn-acc-save").disabled = true;
      try {
        const res = editId
          ? await store.updateAccount(editId, {
              staffName,
              role,
              ...(passcode ? { passcode } : {})
            })
          : await store.createAccount({ staffName, username, role, passcode });

        if (!res || !res.ok) {
          showAccountError((res && res.error) || "Không thể lưu tài khoản.");
          return;
        }
        renderAccountsList(res.accounts || []);
        resetAccountForm(null);
        showToast(editId ? `✓ Đã cập nhật tài khoản ${staffName}` : `✓ Đã tạo tài khoản @${username} (${getRoleLabel(role)})`);
      } finally {
        $("btn-acc-save").disabled = false;
      }
    });

    $("accounts-list").addEventListener("click", async (e) => {
      const editBtn = e.target.closest("[data-acc-edit]");
      if (editBtn) {
        const found = (store.getAccounts ? store.getAccounts() : []).find((a) => a.id === editBtn.dataset.accEdit);
        if (found) resetAccountForm(found);
        return;
      }
      const toggleBtn = e.target.closest("[data-acc-toggle-active]");
      if (toggleBtn) {
        showAccountError("");
        const id = toggleBtn.dataset.accToggleActive;
        const nextActive = toggleBtn.dataset.nextActive === "1";
        const res = await store.updateAccount(id, { active: nextActive });
        if (!res || !res.ok) {
          showAccountError((res && res.error) || "Không thể cập nhật trạng thái tài khoản.");
          return;
        }
        renderAccountsList(res.accounts || []);
        showToast(nextActive ? "🔓 Đã mở chặn truy cập tài khoản nhân viên" : "🚫 Đã chặn truy cập & thu hồi phiên đăng nhập");
        return;
      }
      const deleteBtn = e.target.closest("[data-acc-delete]");
      if (deleteBtn) {
        showAccountError("");
        const id = deleteBtn.dataset.accDelete;
        const label = deleteBtn.dataset.accLabel || id;
        if (!window.confirm(`Xác nhận XÓA VĨNH VIỄN tài khoản ${label}?\n\nNhân viên này sẽ bị đăng xuất ngay lập tức và không thể đăng nhập lại.`)) {
          return;
        }
        const res = await store.deleteAccount(id);
        if (!res || !res.ok) {
          showAccountError((res && res.error) || "Không thể xóa tài khoản.");
          return;
        }
        if ($("acc-id").value === id) resetAccountForm(null);
        renderAccountsList(res.accounts || []);
        showToast(`🗑️ Đã xóa vĩnh viễn tài khoản ${label}`);
      }
    });

    $("btn-close-accounts").onclick = $("btn-close-accounts-2").onclick = () => {
      $("accounts-modal").classList.remove("open");
      if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
    };
    $("accounts-modal").addEventListener("click", (e) => {
      if (e.target === $("accounts-modal")) {
        $("accounts-modal").classList.remove("open");
        if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
      }
    });

    // Photo Lightbox close
    $("btn-close-lightbox").onclick = () => $("photo-lightbox-modal").classList.remove("open");
    $("photo-lightbox-modal").addEventListener("click", (e) => {
      if (e.target === $("photo-lightbox-modal")) $("photo-lightbox-modal").classList.remove("open");
    });

    // Group Report Modal interactions
    let grpSearchTimer = null;
    $("group-report-search").addEventListener("input", () => {
      clearTimeout(grpSearchTimer);
      grpSearchTimer = setTimeout(renderGroupReportModal, 100);
    });
    $("group-report-body").addEventListener("input", (e) => {
      const inp = e.target.closest(".group-lump-input");
      if (!inp) return;
      const raw = parseVND(inp.value);
      inp.value = raw > 0 ? raw.toLocaleString("vi-VN") : "";
    });
    $("group-report-body").addEventListener("click", async (e) => {
      const openBtn = e.target.closest("[data-group-open-bk]");
      if (openBtn) {
        const bkId = openBtn.dataset.groupOpenBk;
        $("group-report-modal").classList.remove("open");
        if (isPcViewActive()) {
          openBookingModal({ bookingId: bkId });
        } else if (window.PMSMobileApi && typeof window.PMSMobileApi.openBooking === "function") {
          window.PMSMobileApi.openBooking(bkId);
        } else {
          openBookingModal({ bookingId: bkId });
        }
        return;
      }
      const allocBtn = e.target.closest("[data-group-allocate]");
      if (allocBtn) {
        const code = allocBtn.dataset.groupAllocate;
        const card = allocBtn.closest(".group-card");
        const inp = card ? card.querySelector(".group-lump-input") : null;
        const val = inp ? inp.value : 0;
        const res = await applyGroupLumpSumPayment(code, val);
        if (!res.ok) return alert(res.error);
        renderGroupReportModal();
        showToast(`✓ Đã phân bổ ${formatVND(parseVND(val))} cho đoàn ${code} (${res.updatedCount} phòng cập nhật)`);
        return;
      }
      const paidBtn = e.target.closest("[data-group-mark-paid]");
      if (paidBtn) {
        const code = paidBtn.dataset.groupMarkPaid;
        const summary = computeBookingGroupSummary(state.bookings, code);
        if (!summary) return;
        const res = await applyGroupLumpSumPayment(code, summary.totalAmount);
        if (!res.ok) return alert(res.error);
        renderGroupReportModal();
        showToast(`✓ Đã thu đủ cả đoàn ${code} (${formatVND(summary.totalAmount)})`);
      }
    });

    // History & Auto-Backup modal controls
    $("btn-link-backup-file").addEventListener("click", linkAutoBackupFile);
    $("btn-export-audit-csv").addEventListener("click", exportAuditCSV);
    $("chk-auto-download-backup").addEventListener("change", (e) => {
      setAutoDownloadBackupEnabled(e.target.checked);
      showToast(e.target.checked ? "Đã bật tự động tải file backup JSON sau mỗi lần sửa" : "Đã tắt tự động tải file backup JSON");
    });
    let histSearchTimer = null;
    $("history-search").addEventListener("input", () => {
      clearTimeout(histSearchTimer);
      histSearchTimer = setTimeout(renderHistoryModal, 100);
    });
    $("history-filter-action").addEventListener("change", renderHistoryModal);
    $("history-filter-confirmer").addEventListener("change", renderHistoryModal);
    $("history-list").addEventListener("click", async (e) => {
      const restoreBtn = e.target.closest("[data-restore-snap]");
      if (restoreBtn) {
        const snapId = restoreBtn.dataset.restoreSnap;
        if (!confirm("Khôi phục toàn bộ bảng đặt phòng về đúng trạng thái tại mốc lịch sử này? (Trạng thái hiện tại sẽ tự động được sao lưu trước khi khôi phục)")) return;
        const res = await store.restoreFromAutoBackup(snapId);
        if (!res.ok) return alert(res.error);
        state.bookings = res.bookings;
        renderAll();
        onDataMutated("restore");
        renderHistoryModal();
        showToast(`Đã khôi phục về mốc sao lưu (${res.bookings.length} đơn)`);
        return;
      }
      const dlBtn = e.target.closest("[data-download-snap]");
      if (dlBtn) {
        downloadSnapshotJSON(dlBtn.dataset.downloadSnap);
      }
    });

    let searchDebounce = null;
    $("filter-search").addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        state.filters.search = $("filter-search").value.trim();
        renderCalendar();
      }, 110);
    });
    $("filter-floor").addEventListener("change", () => { state.filters.floor = $("filter-floor").value; renderCalendar(); });
    $("filter-type").addEventListener("change", () => { state.filters.type = $("filter-type").value; renderCalendar(); });
    $("filter-view").addEventListener("change", () => { state.filters.view = $("filter-view").value; renderCalendar(); });
    $("filter-payment").addEventListener("change", () => { state.filters.payment = $("filter-payment").value; renderCalendar(); });
    $("btn-reset-filters").addEventListener("click", clearAllFilters);
    $("btn-clear-filter-bar").addEventListener("click", clearAllFilters);

    $("field-room").addEventListener("change", () => {
      const r = getRoomById($("field-room").value);
      if (r && !$("field-booking-id").value) $("modal-heading").textContent = `Đặt phòng mới — P.${r.name}`;
      updateRoomSpecificFields();
      const curBk = $("field-booking-id").value ? state.bookings.find((b) => b.id === $("field-booking-id").value) : null;
      renderPcBookingOperationalBars($("field-room").value, curBk || null);
      saveDraft();
    });
    $("field-booking-date").addEventListener("change", saveDraft);
    $("field-checkin").addEventListener("change", () => { if (!$("field-checkout").value || $("field-checkout").value <= $("field-checkin").value) $("field-checkout").value = addDaysISO($("field-checkin").value, 1); updateNightsDisplay(); saveDraft(); });
    $("field-checkout").addEventListener("change", () => { updateNightsDisplay(); saveDraft(); });
    $("field-booking-code").addEventListener("input", renderModalGroupSummary);
    document.querySelectorAll(".pay-tab").forEach((tab) => tab.addEventListener("click", () => { setPaymentStatusTab(tab.dataset.pay, true); saveDraft(); }));
    [$("field-total-amount"), $("field-paid-amount")].forEach((inp) => {
      inp.addEventListener("input", () => {
        const raw = parseVND(inp.value);
        inp.value = raw > 0 ? raw.toLocaleString("vi-VN") : "";
        if (inp === $("field-total-amount")) {
          if ($("field-include-vat").checked) {
            const rev = extractPreVatFromTotal(raw);
            $("field-pre-vat-amount").value = formatNumberInput(rev.preVatAmount);
          }
          if (state.activePayStatus === "paid") $("field-paid-amount").value = inp.value;
        }
        updatePaymentPreview();
        saveDraft();
      });
    });
    $("field-include-vat").addEventListener("change", handlePcVatToggle);
    $("field-pre-vat-amount").addEventListener("input", () => {
      const base = parseVND($("field-pre-vat-amount").value);
      $("field-pre-vat-amount").value = base > 0 ? base.toLocaleString("vi-VN") : "";
      if ($("field-include-vat").checked) {
        const calc = calculateVatBreakdown(base, true);
        $("field-total-amount").value = formatNumberInput(calc.totalAmount);
        if (state.activePayStatus === "paid") $("field-paid-amount").value = $("field-total-amount").value;
      }
      updatePaymentPreview();
      saveDraft();
    });

    // Live Group Lump-Sum Controls inside Booking Modal
    $("pc-group-lump-input").addEventListener("input", (e) => {
      const raw = parseVND(e.target.value);
      e.target.value = raw > 0 ? raw.toLocaleString("vi-VN") : "";
    });
    $("pc-group-rooms-list").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-jump-booking]");
      if (!chip) return;
      const targetId = chip.dataset.jumpBooking;
      if (targetId && targetId !== $("field-booking-id").value) {
        openBookingModal({ bookingId: targetId });
      }
    });
    $("btn-pc-group-autofill").addEventListener("click", () => {
      const code = ($("field-booking-code").value || "").trim();
      const summary = computeBookingGroupSummary(state.bookings, code);
      if (summary && autofillPcFormFromGroup(summary, { force: true })) {
        showToast(`⚡ Đã điền thông tin từ đoàn ${summary.code}`);
      }
    });
    $("btn-pc-group-allocate").addEventListener("click", async () => {
      const code = ($("field-booking-code").value || "").trim();
      const val = $("pc-group-lump-input").value;
      const currentId = $("field-booking-id").value;
      const res = await applyGroupLumpSumPayment(code, val);
      if (!res.ok) return showFormError(res.error);
      showFormError("");
      if (currentId) openBookingModal({ bookingId: currentId });
      else renderModalGroupSummary();
      showToast(res.updatedCount > 0
        ? `✓ Đã chia tự động ${formatVND(parseVND(val))} cho cả đoàn ${code} (${res.updatedCount} phòng)`
        : `Số tiền thanh toán đoàn ${code} đã khớp — không có thay đổi`);
    });
    $("btn-pc-group-mark-paid").addEventListener("click", async () => {
      const code = ($("field-booking-code").value || "").trim();
      const currentId = $("field-booking-id").value;
      const summary = computeBookingGroupSummary(state.bookings, code);
      if (!summary) return;
      const res = await applyGroupLumpSumPayment(code, summary.totalAmount);
      if (!res.ok) return showFormError(res.error);
      showFormError("");
      if (currentId) openBookingModal({ bookingId: currentId });
      else renderModalGroupSummary();
      showToast(`✓ Đã thu đủ cả đoàn ${code} (${formatVND(summary.totalAmount)})`);
    });

    $("booking-form").addEventListener("input", saveDraft);

    $("booking-form").addEventListener("submit", handleSaveBooking);
    $("btn-copy-booking").addEventListener("click", () => {
      const id = $("field-booking-id").value;
      const bk = state.bookings.find((b) => b.id === id);
      if (bk) copyBookingToClipboard(bk);
    });
    $("btn-delete-booking").addEventListener("click", async () => {
      if (state.isSubmitting) return;
      const id = $("field-booking-id").value;
      const bk = state.bookings.find((b) => b.id === id);
      if (!bk || !confirm(`Xác nhận xóa đặt phòng của "${bk.guestName}" tại phòng ${getRoomById(bk.roomId)?.name || bk.roomId}?`)) return;
      state.isSubmitting = true;
      $("btn-delete-booking").disabled = true;
      try {
        const res = await store.deleteBooking(id, { expectedRevision: state.editingBookingRevision });
        if (!res.ok) return showFormError(res.error);
        state.bookings = res.bookings;
        $("pc-edit-conflict-banner").classList.remove("show");
        $("booking-modal").classList.remove("open");
        renderAll();
        onDataMutated("delete");
        showToast("Đã xóa đặt phòng (đã sao lưu tự động — có thể khôi phục trong Lịch sử)");
      } finally {
        state.isSubmitting = false;
        $("btn-delete-booking").disabled = false;
        if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
      }
    });
    $("btn-mark-paid").addEventListener("click", () => { setPaymentStatusTab("paid", true); showToast("Đã điền thu đủ — nhấn Lưu thông tin"); });

    // Delegated Dorm Board & Slot Picker events
    $("dorm-slot-grid").addEventListener("click", (e) => {
      const bookCard = e.target.closest("[data-book-slot]");
      if (bookCard) return openDormSlotForm({ dateISO: state.activeDormDate, preselectSlot: Number(bookCard.dataset.bookSlot) });
      const editCard = e.target.closest("[data-edit-dorm-id]");
      if (editCard) return openDormSlotForm({ bookingId: editCard.dataset.editDormId });
    });

    $("dorm-slot-picker").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pick-slot]");
      if (!btn) return;
      const num = Number(btn.dataset.pickSlot);
      if (state.dormSelectedSlots.includes(num)) state.dormSelectedSlots = state.dormSelectedSlots.filter((x) => x !== num);
      else { state.dormSelectedSlots.push(num); state.dormSelectedSlots.sort((a, b) => a - b); }
      renderDormSlotPicker();
    });

    $("btn-dorm-prev-day").addEventListener("click", () => { state.activeDormDate = addDaysISO(state.activeDormDate || getTodayISO(), -1); renderDormBoard(); });
    $("btn-dorm-next-day").addEventListener("click", () => { state.activeDormDate = addDaysISO(state.activeDormDate || getTodayISO(), 1); renderDormBoard(); });
    $("btn-add-dorm-slot").addEventListener("click", () => openDormSlotForm({ dateISO: state.activeDormDate }));
    $("btn-dorm-back").addEventListener("click", () => { setDormModalMode("board"); renderDormBoard(); });
    $("btn-dorm-cancel-form").addEventListener("click", () => { setDormModalMode("board"); renderDormBoard(); });

    $("dorm-checkin").addEventListener("change", () => {
      if (!$("dorm-checkout").value || $("dorm-checkout").value <= $("dorm-checkin").value) $("dorm-checkout").value = addDaysISO($("dorm-checkin").value, 1);
      syncDormFormUI();
      renderDormSlotPicker();
    });
    $("dorm-checkout").addEventListener("change", () => { syncDormFormUI(); renderDormSlotPicker(); });
    $("dorm-source-type").addEventListener("change", syncDormFormUI);
    [$("dorm-total-amount"), $("dorm-paid-amount")].forEach((inp) => {
      inp.addEventListener("input", () => {
        const raw = parseVND(inp.value);
        inp.value = raw > 0 ? raw.toLocaleString("vi-VN") : "";
        syncDormFormUI();
      });
    });

    $("btn-dorm-mark-paid").addEventListener("click", () => {
      $("dorm-paid-amount").value = $("dorm-total-amount").value;
      syncDormFormUI();
      showToast("Đã điền thu đủ — nhấn Lưu slot Dorm");
    });

    $("btn-dorm-delete").addEventListener("click", async () => {
      if (state.isSubmitting) return;
      const id = $("dorm-field-id").value;
      const bk = state.bookings.find((b) => b.id === id);
      if (!bk || !confirm(`Xóa lượt đặt Dorm của "${bk.guestName}" (Slot ${(bk.slots || []).join(", ")})?`)) return;
      state.isSubmitting = true;
      $("btn-dorm-delete").disabled = true;
      try {
        const res = await store.deleteBooking(id, { expectedRevision: state.editingDormRevision });
        if (!res.ok) return showDormError(res.error);
        state.bookings = res.bookings;
        $("pc-dorm-conflict-banner").classList.remove("show");
        setDormModalMode("board");
        renderDormBoard();
        renderAll();
        onDataMutated("delete");
        showToast("Đã xóa lượt đặt Dorm (đã sao lưu tự động)");
      } finally {
        state.isSubmitting = false;
        $("btn-dorm-delete").disabled = false;
        if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
      }
    });

    $("dorm-slot-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (state.isSubmitting) return;
      state.isSubmitting = true;
      $("btn-dorm-save").disabled = true;

      try {
        showDormError("");
        const existingId = $("dorm-field-id").value || undefined;
        const chKey = $("dorm-source-type").value;
        const tourOrCustom = $("dorm-tour-name").value.trim();
        let sourceName = "Dorm nội bộ", tourName = "";
        if (chKey === "tour") { tourName = tourOrCustom; sourceName = tourOrCustom ? `Gmail ${tourOrCustom}` : "Gmail"; }
        else if (chKey === "walkin") sourceName = "Nội bộ / Khách lẻ";
        else if (chKey === "zalo") { tourName = tourOrCustom; sourceName = tourOrCustom ? `Zalo ${tourOrCustom}` : "Zalo"; }
        else sourceName = tourOrCustom || "Nguồn khác";

        const payload = {
          id: existingId,
          roomId: "DORM",
          bookingDate: $("dorm-booking-date").value || getTodayISO(),
          checkin: $("dorm-checkin").value,
          checkout: $("dorm-checkout").value,
          channelKey: chKey,
          sourceName,
          tourName,
          bookingCode: $("dorm-booking-code").value.trim(),
          guestName: $("dorm-guest-name").value.trim(),
          phone: $("dorm-phone").value.trim(),
          slots: [...state.dormSelectedSlots],
          totalAmount: $("dorm-total-amount").value,
          paidAmount: $("dorm-paid-amount").value,
          confirmedBy: $("dorm-confirmed-by").value,
          confirmationPdf: state.activeDormConfirmationPdf,
          notes: $("dorm-notes").value
        };
        const saveOpts = {
          expectedRevision: existingId ? state.editingDormRevision : undefined,
          idempotencyKey: existingId ? undefined : state.activeDormIdempotencyKey
        };

        const res = await store.saveBooking(payload, saveOpts);

        if (!res.ok) {
          showDormError(res.error);
          if (res.code === "CONFLICT_STALE_EDIT") {
            $("pc-dorm-conflict-banner").classList.add("show");
          }
          if (res.code === "CONFLICT_STALE_EDIT" || res.code === "CONFLICT_OVERBOOKING" || res.code === "CONFLICT_CONCURRENT_WRITE") {
            state.bookings = store.getBookings();
            renderDormSlotPicker();
            renderAll();
          }
          return;
        }

        state.bookings = res.bookings;
        state.activeDormDate = res.booking.checkin;
        $("pc-dorm-conflict-banner").classList.remove("show");
        setDormModalMode("board");
        renderDormBoard();
        renderAll();
        onDataMutated("save");
        showToast(res.isUpdate ? `Đã cập nhật Slot ${res.booking.slots.join(", ")} Dorm (đã sao lưu tự động)` : `Đã đặt Slot ${res.booking.slots.join(", ")} Dorm cho ${res.booking.guestName} (đã sao lưu tự động)`);
      } finally {
        state.isSubmitting = false;
        $("btn-dorm-save").disabled = false;
        if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
      }
    });

    // Booking Confirmation A4 PDF Export (PC Regular Room + Dorm + Shared Preview Modal)
    $("btn-export-confirm-pdf").addEventListener("click", () => {
      openConfirmationPdfModal(collectLivePcRegularDraftBooking(), store.refreshLatest());
    });
    $("dorm-btn-export-confirm-pdf").addEventListener("click", () => {
      openConfirmationPdfModal(collectLivePcDormDraftBooking(), store.refreshLatest());
    });
    $("btn-view-legacy-pdf").addEventListener("click", () => openPdfAttachment(state.activeConfirmationPdf));
    $("dorm-btn-view-legacy-pdf").addEventListener("click", () => openPdfAttachment(state.activeDormConfirmationPdf));

    $("cpdf-scope").addEventListener("change", renderConfirmationPdfPreview);
    $("cpdf-discount").addEventListener("input", renderConfirmationPdfPreview);
    $("cpdf-vat").addEventListener("change", renderConfirmationPdfPreview);
    $("cpdf-eb-rate").addEventListener("input", (e) => {
      const cleaned = formatNumberInput(e.target.value);
      if (e.target.value !== cleaned) e.target.value = cleaned;
      renderConfirmationPdfPreview();
    });
    $("btn-print-confirm-pdf").addEventListener("click", printConfirmationPdf);
    $("btn-download-confirm-html").addEventListener("click", downloadConfirmationHtml);

    const closeModal = (id) => {
      $(id).classList.remove("open");
      if (id === "booking-modal") $("pc-edit-conflict-banner").classList.remove("show");
      if (id === "dorm-modal") $("pc-dorm-conflict-banner").classList.remove("show");
      if (typeof store.notifyIdleCheck === "function") store.notifyIdleCheck();
    };
    // Operating Costs & COGS Modal Interactions (Shared PC & Mobile)
    $("btn-costs-prev-month").addEventListener("click", () => {
      costsState.monthKey = shiftMonthKey(costsState.monthKey, -1);
      renderOperatingCostsModal();
    });
    $("btn-costs-next-month").addEventListener("click", () => {
      costsState.monthKey = shiftMonthKey(costsState.monthKey, 1);
      renderOperatingCostsModal();
    });
    $("costs-month-picker").addEventListener("change", () => {
      if (isValidMonthKey($("costs-month-picker").value)) {
        costsState.monthKey = $("costs-month-picker").value;
        renderOperatingCostsModal();
      }
    });
    $("btn-costs-tab-overview").addEventListener("click", () => setCostsTab("overview"));
    $("btn-costs-tab-voucher").addEventListener("click", () => {
      if (!$("cv-id").value) resetCostVoucherForm(null);
      else populateCostVoucherItemOptions();
      showCostVoucherError("");
      setCostsTab("voucher");
    });
    $("btn-costs-tab-items").addEventListener("click", () => {
      if (!$("ci-effective-month").value) $("ci-effective-month").value = costsState.monthKey;
      setCostsTab("items");
    });
    $("btn-cv-cancel").addEventListener("click", () => {
      resetCostVoucherForm(null);
      setCostsTab("overview");
    });
    $("btn-cv-reset").addEventListener("click", () => resetCostVoucherForm(null));
    $("btn-ci-reset").addEventListener("click", () => resetCostItemForm(null));
    $("btn-costs-export-csv").addEventListener("click", exportOperatingCostsCSV);

    $("costs-missing-guests-banner").addEventListener("click", (e) => {
      const jumpBtn = e.target.closest("[data-cost-jump-booking]");
      if (!jumpBtn) return;
      const bkId = jumpBtn.dataset.costJumpBooking;
      if (!bkId) return;
      closeModal("costs-modal");
      if (isPcViewActive()) {
        openBookingModal({ bookingId: bkId });
      } else if (window.PMSMobileApi && typeof window.PMSMobileApi.openBooking === "function") {
        window.PMSMobileApi.openBooking(bkId);
      } else {
        openBookingModal({ bookingId: bkId });
      }
    });

    [$("cv-amount"), $("ci-rate")].forEach((inp) => {
      inp.addEventListener("input", () => {
        const cleaned = formatNumberInput(inp.value);
        if (inp.value !== cleaned) inp.value = cleaned;
      });
    });

    const handleEditCostVoucher = (voucherId) => {
      if (!voucherId) return;
      const cur = getCurrentOperatingCosts();
      const found = cur.actualEntries.find((v) => v.id === voucherId);
      if (!found) return;
      resetCostVoucherForm(found);
      setCostsTab("voucher");
      setTimeout(() => $("cv-amount").focus(), 40);
    };

    const handleDeleteCostVoucher = async (voucherId) => {
      if (!voucherId) return;
      const cur = getCurrentOperatingCosts();
      const delRes = deleteActualCostEntry(cur, voucherId);
      if (!delRes.ok) return showToast(delRes.error);
      const saved = await persistOperatingCosts(delRes.state, "Đã xóa chứng từ chi phí thực tế");
      if (saved && saved.ok && $("cv-id").value === voucherId) {
        resetCostVoucherForm(null);
      }
    };

    $("costs-table-body").addEventListener("click", async (e) => {
      const finBtn = e.target.closest("[data-cost-finalize]");
      if (finBtn) {
        e.stopPropagation();
        const itemId = finBtn.dataset.costFinalize;
        const nextFin = finBtn.dataset.nextFinalized === "1";
        const cur = getCurrentOperatingCosts();
        const upd = setCostItemFinalized(cur, costsState.monthKey, itemId, nextFin, getActorStaffName());
        if (!upd.ok) return showToast(upd.error);
        await persistOperatingCosts(
          upd.state,
          nextFin ? "✓ Đã chốt dùng số thực tế cho khoản mục này" : "Đã bỏ chốt — quay về dùng số ước tính"
        );
        return;
      }

      const addVBtn = e.target.closest("[data-cost-add-voucher]");
      if (addVBtn) {
        e.stopPropagation();
        resetCostVoucherForm(null, addVBtn.dataset.costAddVoucher);
        setCostsTab("voucher");
        setTimeout(() => $("cv-amount").focus(), 40);
        return;
      }

      const editItemBtn = e.target.closest("[data-cost-edit-item]");
      if (editItemBtn) {
        e.stopPropagation();
        const cur = getCurrentOperatingCosts();
        const found = cur.items.find((it) => it.id === editItemBtn.dataset.costEditItem);
        if (found) {
          resetCostItemForm(found);
          setCostsTab("items");
          setTimeout(() => $("ci-rate").focus(), 40);
        }
        return;
      }

      const jumpInvBtn = e.target.closest("[data-cost-jump-invoice]");
      if (jumpInvBtn) {
        e.stopPropagation();
        closeModal("costs-modal");
        if (window.PMSFinanceApp) {
          window.PMSFinanceApp.openPayables({ focusInvoiceId: jumpInvBtn.dataset.costJumpInvoice });
        }
        return;
      }

      const editVBtn = e.target.closest("[data-cost-edit-voucher]");
      if (editVBtn) {
        e.stopPropagation();
        handleEditCostVoucher(editVBtn.dataset.costEditVoucher);
        return;
      }

      const delVBtn = e.target.closest("[data-cost-del-voucher]");
      if (delVBtn) {
        e.stopPropagation();
        await handleDeleteCostVoucher(delVBtn.dataset.costDelVoucher);
        return;
      }

      const rowMain = e.target.closest("tr[data-cost-expand]");
      if (rowMain) {
        const id = rowMain.dataset.costExpand;
        if (costsState.expandedItems.has(id)) costsState.expandedItems.delete(id);
        else costsState.expandedItems.add(id);
        renderOperatingCostsModal();
      }
    });

    $("costs-month-vouchers-list").addEventListener("click", async (e) => {
      const editVBtn = e.target.closest("[data-cost-edit-voucher]");
      if (editVBtn) {
        handleEditCostVoucher(editVBtn.dataset.costEditVoucher);
        return;
      }
      const delVBtn = e.target.closest("[data-cost-del-voucher]");
      if (delVBtn) await handleDeleteCostVoucher(delVBtn.dataset.costDelVoucher);
    });

    $("costs-items-list").addEventListener("click", async (e) => {
      const delRateBtn = e.target.closest("[data-cost-del-rate-item]");
      if (delRateBtn) {
        const itemId = delRateBtn.dataset.costDelRateItem;
        const effMonth = delRateBtn.dataset.costDelRateMonth;
        const cur = getCurrentOperatingCosts();
        const delRes = deleteCostRateHistoryEntry(cur, itemId, effMonth);
        if (!delRes.ok) return showToast(delRes.error);
        await persistOperatingCosts(delRes.state, `Đã xóa mốc định mức từ T${formatMonthVN(effMonth)}`);
        return;
      }

      const toggleBtn = e.target.closest("[data-cost-toggle-active]");
      if (toggleBtn) {
        const itemId = toggleBtn.dataset.costToggleActive;
        const nextActive = toggleBtn.dataset.nextActive === "1";
        const cur = getCurrentOperatingCosts();
        const togRes = toggleCostItemActive(cur, itemId, nextActive);
        if (!togRes.ok) return showToast(togRes.error);
        await persistOperatingCosts(
          togRes.state,
          nextActive ? `Đã hiện lại khoản mục "${togRes.item.name}"` : `Đã ẩn khoản mục "${togRes.item.name}" khỏi bảng tháng`
        );
        return;
      }

      const editBtn = e.target.closest("[data-cost-edit-item]");
      if (!editBtn) return;
      const cur = getCurrentOperatingCosts();
      const found = cur.items.find((it) => it.id === editBtn.dataset.costEditItem);
      if (found) {
        resetCostItemForm(found);
        $("ci-rate").focus();
      }
    });

    $("costs-voucher-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      showCostVoucherError("");
      const cur = getCurrentOperatingCosts();
      const editingId = $("cv-id").value || undefined;
      const res = addActualCostEntry(cur, {
        id: editingId,
        itemId: $("cv-item-id").value,
        expenseDate: $("cv-expense-date").value,
        accountingMonth: $("cv-accounting-month").value,
        amount: $("cv-amount").value,
        note: $("cv-note").value,
        createdBy: getActorStaffName()
      });
      if (!res.ok) {
        showCostVoucherError(res.error);
        return;
      }
      const saved = await persistOperatingCosts(
        res.state,
        res.isUpdate
          ? `Đã cập nhật chứng từ ${formatVND(res.entry.amount)} cho tháng ${formatMonthVN(res.entry.accountingMonth)}`
          : `Đã lưu chứng từ ${formatVND(res.entry.amount)} cho tháng ${formatMonthVN(res.entry.accountingMonth)}`
      );
      if (saved && saved.ok) {
        costsState.monthKey = res.entry.accountingMonth;
        costsState.expandedItems.add(res.entry.itemId);
        resetCostVoucherForm(null, res.entry.itemId);
        renderOperatingCostsModal();
      } else {
        showCostVoucherError((saved && saved.error) || "Lưu chứng từ thất bại. Vui lòng thử lại.");
      }
    });

    $("costs-item-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      showCostItemError("");
      const cur = getCurrentOperatingCosts();
      const res = upsertCostItem(cur, {
        id: $("ci-id").value || undefined,
        name: $("ci-name").value,
        calcMode: $("ci-calc-mode").value,
        rate: $("ci-rate").value,
        effectiveMonth: $("ci-effective-month").value
      });
      if (!res.ok) {
        showCostItemError(res.error);
        return;
      }
      const saved = await persistOperatingCosts(res.state, `Đã lưu định mức "${res.item.name}" áp dụng từ T${formatMonthVN($("ci-effective-month").value)}`);
      if (saved && saved.ok) {
        resetCostItemForm(null);
        renderOperatingCostsModal();
      } else {
        showCostItemError((saved && saved.error) || "Lưu định mức thất bại. Vui lòng thử lại.");
      }
    });

    $("btn-close-confirm-pdf").onclick = $("btn-close-confirm-pdf-2").onclick = () => closeModal("confirm-pdf-modal");
    $("confirm-pdf-modal").addEventListener("click", (e) => { if (e.target === $("confirm-pdf-modal")) closeModal("confirm-pdf-modal"); });
    $("btn-close-costs").onclick = $("btn-close-costs-2").onclick = () => closeModal("costs-modal");
    $("costs-modal").addEventListener("click", (e) => { if (e.target === $("costs-modal")) closeModal("costs-modal"); });
    $("btn-close-modal").onclick = $("btn-cancel-modal").onclick = () => { clearDraft(); closeModal("booking-modal"); };
    $("booking-modal").addEventListener("click", (e) => { if (e.target === $("booking-modal")) closeModal("booking-modal"); });
    $("btn-close-dorm").onclick = $("btn-close-dorm-2").onclick = () => closeModal("dorm-modal");
    $("dorm-modal").addEventListener("click", (e) => { if (e.target === $("dorm-modal")) closeModal("dorm-modal"); });
    $("btn-close-report").onclick = $("btn-close-report-2").onclick = () => closeModal("day-report-modal");
    $("day-report-modal").addEventListener("click", (e) => { if (e.target === $("day-report-modal")) closeModal("day-report-modal"); });
    $("btn-close-group-report").onclick = $("btn-close-group-report-2").onclick = () => closeModal("group-report-modal");
    $("group-report-modal").addEventListener("click", (e) => { if (e.target === $("group-report-modal")) closeModal("group-report-modal"); });
    $("btn-close-history").onclick = $("btn-close-history-2").onclick = () => closeModal("history-modal");
    $("history-modal").addEventListener("click", (e) => { if (e.target === $("history-modal")) closeModal("history-modal"); });

    const doRollbackLast = async (modalToClose) => {
      if (!confirm("Hoàn tác dữ liệu về trạng thái ngay trước thay đổi gần nhất?")) return;
      const res = await store.rollbackLastChange();
      if (!res.ok) return alert(res.error);
      state.bookings = res.bookings;
      if (modalToClose) closeModal(modalToClose);
      renderAll();
      onDataMutated("rollback");
      showToast(`Đã hoàn tác về bản dự phòng (${res.bookings.length} đơn)`);
    };

    $("btn-rollback-last").onclick = () => doRollbackLast("day-report-modal");
    $("btn-history-rollback-last").onclick = () => doRollbackLast(null);
    $("btn-backup-rollback-last").onclick = () => doRollbackLast(null);

    // System -> Backup & Restore modal
    $("btn-close-backup-restore").addEventListener("click", () => closeModal("backup-restore-modal"));
    $("btn-close-backup-restore-2").addEventListener("click", () => closeModal("backup-restore-modal"));
    $("backup-restore-modal").addEventListener("click", (e) => { if (e.target === $("backup-restore-modal")) closeModal("backup-restore-modal"); });
    $("btn-backup-open-history").addEventListener("click", () => {
      closeModal("backup-restore-modal");
      openHistoryModal();
    });

    $("btn-reset-sample").onclick = async () => {
      if (!confirm("Khôi phục lại danh sách đặt phòng mẫu ban đầu? (Hệ thống tự lưu bản dự phòng trước khi đặt lại)")) return;
      const res = await store.resetToSample();
      if (!res.ok) return alert(res.error);
      state.bookings = res.bookings;
      closeModal("day-report-modal");
      renderAll();
      onDataMutated("reset");
      showToast("Đã khôi phục dữ liệu mẫu");
    };

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("photo-lightbox-modal").classList.contains("open")) $("photo-lightbox-modal").classList.remove("open");
        else if ($("hk-complete-modal").classList.contains("open")) closeModal("hk-complete-modal");
        else if ($("issue-modal").classList.contains("open")) closeModal("issue-modal");
        else if ($("accounts-modal").classList.contains("open")) closeModal("accounts-modal");
        else if ($("hk-workspace").classList.contains("open") && getUserRole() !== "housekeeping") $("hk-workspace").classList.remove("open");
        else if ($("confirm-pdf-modal").classList.contains("open")) closeModal("confirm-pdf-modal");
        else if ($("monthly-receipts-modal").classList.contains("open")) closeModal("monthly-receipts-modal");
        else if ($("shift-minutes-modal") && $("shift-minutes-modal").classList.contains("open")) {
          if (window.PMSFinanceApp) window.PMSFinanceApp.closeShiftMinutes();
          else closeModal("shift-minutes-modal");
        }
        else if ($("shifts-modal") && $("shifts-modal").classList.contains("open")) {
          if (window.PMSFinanceApp) window.PMSFinanceApp.closeShifts();
          else closeModal("shifts-modal");
        }
        else if ($("payables-modal") && $("payables-modal").classList.contains("open")) closeModal("payables-modal");
        else if ($("cashbook-modal").classList.contains("open")) closeModal("cashbook-modal");
        else if ($("receivables-modal").classList.contains("open")) closeModal("receivables-modal");
        else if ($("costs-modal").classList.contains("open")) closeModal("costs-modal");
        else if ($("booking-modal").classList.contains("open")) closeModal("booking-modal");
        else if ($("dorm-modal").classList.contains("open")) {
          if ($("dorm-slot-form").style.display !== "none") { setDormModalMode("board"); renderDormBoard(); }
          else closeModal("dorm-modal");
        } else if ($("group-report-modal").classList.contains("open")) closeModal("group-report-modal");
        else if ($("backup-restore-modal").classList.contains("open")) closeModal("backup-restore-modal");
        else if ($("history-modal").classList.contains("open")) closeModal("history-modal");
        else if ($("day-report-modal").classList.contains("open")) closeModal("day-report-modal");
        else if (state.copiedBooking) clearClipboard(false);
      }
    });
  }

  function registerAutoUpdateServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "https:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") return;

    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((reg) => {
      const checkUpdate = () => {
        reg.update().catch(() => {});
        if (typeof store.checkAppVersion === "function") store.checkAppVersion();
      };
      setInterval(checkUpdate, 2 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) checkUpdate();
      });
    }).catch(() => {});
  }

  async function boot() {
    initTheme();
    initRoomDropdown();
    populateHousekeepingRoomDropdowns();
    initConfirmersDropdown();
    initPlatformChips();
    bindEvents();

    if (!window.__pmsClientInitPromise) {
      window.__pmsClientInitPromise = store.init();
    }
    const loadRes = await window.__pmsClientInitPromise;
    state.bookings = (loadRes && loadRes.bookings) || store.getBookings() || [];
    applyRolePermissionsUI();
    if (getUserRole() !== "housekeeping") {
      renderAll();
      updateAutoBackupUI();
    }
    updatePcSyncPill();
    syncAuthOverlay("");
    registerAutoUpdateServiceWorker();
    if (loadRes && !loadRes.ok && !loadRes.offline) {
      alert("CẢNH BÁO AN TOÀN DỮ LIỆU:\n" + loadRes.error);
      showToast("Lỗi bộ nhớ trình duyệt — đã khóa ghi để bảo vệ dữ liệu gốc!");
    } else if (loadRes && loadRes.offline) {
      showToast("Đang mất kết nối tới máy chủ khách sạn — chờ kết nối lại.");
    } else if (loadRes && loadRes.recoveredFromBackup) {
      showToast("Phát hiện lỗi bộ nhớ — đã tự động khôi phục từ bản dự phòng!");
    }
    if (window.matchMedia) {
      const mql = window.matchMedia("(max-width: 768px)");
      const onViewportChange = () => {
        if (pcRenderDirty && isPcViewActive()) {
          state.bookings = store.getBookings() || state.bookings;
          renderAll();
          setTimeout(() => scrollToToday(false), 30);
        }
      };
      if (mql.addEventListener) mql.addEventListener("change", onViewportChange);
      else if (mql.addListener) mql.addListener(onViewportChange);
    }
    setTimeout(() => { if (isPcViewActive()) scrollToToday(false); }, 60);
  }

  boot();
})();
