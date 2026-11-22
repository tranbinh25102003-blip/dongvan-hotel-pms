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
    normalizeGroupCode,
    computeBookingGroupSummary,
    computeAllBookingGroups,
    allocateGroupPayment,
    buildCopiedBookingPayload,
    buildGroupSyncUpdates,
    buildBookingConfirmationData,
    renderBookingConfirmationHtml,
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
    $("today-date-label").textContent = `Hôm nay: ${DOW_FULL_VI[d.getDay()]}, ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
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

    // Strictly check-in-month attribution prevents double-counting stays spanning two months
    const fin = computeMonthlyFinancials(state.bookings, state.year, state.month);

    $("kpi-today-occ").textContent = `${occRooms} / 26 phòng (trống ${26 - occRooms})`;
    $("kpi-today-dorm").textContent = `Còn ${dormFree}/8 chỗ (đặt ${dormUsed})`;
    $("kpi-today-hk").textContent = `${mergeToday} ghép • ${ebToday} EB`;
    $("kpi-today-buffet").textContent = `${buffetGuests} khách`;
    $("kpi-month-paid").textContent = formatVND(fin.totalPaid);
    $("kpi-month-debt").textContent = formatVND(fin.totalDebt);
    $("kpi-month-debt").className = `kpi-value ${fin.totalDebt > 0 ? "warn" : "ok"}`;
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

    const regularRooms = ROOMS.filter((r) => !r.isDorm);
    const availPerDay = dates.map((dt) => 26 - regularRooms.filter((r) => getBookingsForRoomDate(r.id, dt.iso).length > 0).length);

    // Precompute multi-room group map for O(1) lookup per cell
    const groupMap = new Map();
    computeAllBookingGroups(state.bookings, { minRooms: 2 }).forEach((g) => {
      groupMap.set(g.normalizedCode, g);
    });
    const pasteMode = Boolean(state.copiedBooking);

    let headHtml = `<tr><th class="corner-cell">
      <div style="font-weight:700; font-size:13px;">Phòng / Hạng / View</div>
      <div style="font-size:11px; color:var(--text-muted); font-weight:500;">Nhấn đặt • Chuột phải ô để sao chép</div>
    </th>`;
    dates.forEach((dt, idx) => {
      const cls = ["day-header", dt.isWeekend ? "is-weekend" : "", dt.isToday ? "is-today" : ""].filter(Boolean).join(" ");
      headHtml += `<th class="${cls}" data-report-date="${dt.iso}" ${dt.isToday ? 'data-is-today="1" style="box-shadow: inset 0 3px 0 var(--accent-primary);"' : ""} title="Nhấn xem báo cáo ngày ${formatDateVN(dt.iso)}">
        <span class="day-dow" style="${dt.isToday ? "color:var(--accent-primary); font-weight:800;" : ""}">${dt.isToday ? `${dt.dow} • Hôm nay` : dt.dow}</span>
        <span class="day-num" style="${dt.isToday ? "color:var(--accent-primary);" : ""}">${dt.day}/${state.month + 1}</span>
        <span class="day-avail-mini">${availPerDay[idx]} trống</span>
      </th>`;
    });
    headHtml += `</tr>`;
    $("calendar-thead").innerHTML = headHtml;

    const filteredRooms = getFilteredRooms();
    const filterOn = hasActiveBookingFilters();
    let bodyHtml = "";

    ROOM_SECTIONS.forEach((section) => {
      const sectionRooms = filteredRooms.filter((r) => (section.isDorm ? r.isDorm : (!r.isDorm && r.floor === section.floor)));
      if (sectionRooms.length === 0) return;

      const isCollapsed = !!state.collapsedFloors[section.key];
      const sectionTitle = section.isDorm
        ? section.label
        : `Tầng ${section.floor} (${sectionRooms.length} phòng ngủ)`;

      bodyHtml += `<tr class="floor-row ${section.isDorm ? "is-dorm-section" : ""}" data-section-key="${section.key}">
        <td class="floor-sticky">
          <div class="floor-row-inner floor-label-inner">
            <button type="button" class="floor-toggle" data-floor-toggle="${section.key}">
              <span>${isCollapsed ? "▸" : "▾"}</span>
              <span>${escapeHtml(sectionTitle)}</span>
            </button>
          </div>
        </td>
        <td colspan="${daysCount}"></td>
      </tr>`;

      if (isCollapsed) return;

      sectionRooms.forEach((room) => {
        bodyHtml += `<tr class="room-row" data-room-id="${room.id}">
          <td class="room-cell">
            <div class="room-top">
              <span class="room-number">${escapeHtml(room.name)}</span>
              <span class="room-type-tag type-${room.type}">${escapeHtml(room.type)}</span>
            </div>
            <div class="room-meta" title="${escapeHtml(room.view)} • ${escapeHtml(room.bedInfo)}">
              ${escapeHtml(room.view)} • ${escapeHtml(room.bedInfo)}
            </div>
          </td>`;

        dates.forEach((dt) => {
          const bksAll = getBookingsForRoomDate(room.id, dt.iso);
          const baseCls = ["grid-cell", dt.isWeekend ? "is-weekend" : "", dt.isToday ? "is-today" : ""].filter(Boolean);

          if (room.isDorm) {
            const { map: slotMap } = getDormSlotMapForDate(state.bookings, dt.iso);
            const used = Object.keys(slotMap).length;
            const free = Math.max(0, room.capacity - used);
            if (used === 0) {
              bodyHtml += `<td class="${baseCls.concat("is-vacant").join(" ")}" data-room="${room.id}" data-date="${dt.iso}" title="Dorm ngày ${formatDateVN(dt.iso)}: Trống 8/8 chỗ — Nhấn đặt slot">
                <div class="vacant-inner">
                  <span class="vacant-plus">+</span>
                  <span class="vacant-label" style="color:var(--status-paid);">Trống 8/8</span>
                </div>
              </td>`;
            } else {
              const totalDebt = bksAll.reduce((s, b) => s + getRemaining(b), 0);
              const isFull = free === 0;
              const vis = !filterOn || bksAll.some(matchesBookingFilter);
              const dormPayCls = totalDebt > 0 ? "unpaid" : "paid";
              const dormPayText = totalDebt > 0 ? `Nợ ${formatShortVND(totalDebt)}` : "✓ Đã TT";
              bodyHtml += `<td class="${baseCls.join(" ")}" data-room="${room.id}" data-date="${dt.iso}" data-dorm-day="1">
                <div class="dorm-pill ${isFull ? "is-full" : ""} ${vis ? "" : "bk-dimmed"}">
                  <span class="dorm-count">${isFull ? "Hết 0/8 chỗ" : `Trống ${free}/8`}</span>
                  <span class="dorm-sub">Đã đặt ${used}/8</span>
                  <span class="booking-pay ${dormPayCls}" style="margin-top:1px;">${dormPayText}</span>
                </div>
              </td>`;
            }
            return;
          }

          if (bksAll.length === 0) {
            bodyHtml += `<td class="${baseCls.concat("is-vacant").join(" ")}" data-room="${room.id}" data-date="${dt.iso}" title="${pasteMode ? `Nhấn để DÁN đặt phòng vào P.${room.name} (${formatDateVN(dt.iso)})` : `Phòng ${room.name} ngày ${formatDateVN(dt.iso)} còn trống — Nhấn để đặt`}">
              <div class="vacant-inner">
                <span class="vacant-plus">${pasteMode ? "📋" : "+"}</span>
                <span class="vacant-label">${pasteMode ? "Dán" : "Trống"}</span>
              </div>
            </td>`;
          } else {
            const bk = bksAll[0];
            const vis = !filterOn || matchesBookingFilter(bk);
            const hasPrev = bookingCoversDate(bk, addDaysISO(dt.iso, -1)) && dt.day > 1;
            const hasNext = bookingCoversDate(bk, addDaysISO(dt.iso, 1)) && dt.day < daysCount;
            let segCls = "";
            if (!hasPrev && hasNext) segCls = "seg-start";
            else if (hasPrev && hasNext) segCls = "seg-mid";
            else if (hasPrev && !hasNext) segCls = "seg-end";

            const chKey = bk.channelKey || detectChannelKey(bk.sourceName);
            const showLabel = !hasPrev;
            const shortSource = bk.sourceName.replace(/\.com$/i, "");
            const shortGuest = bk.guestName.split(" ").slice(-2).join(" ");
            const groupInfo = bk.bookingCode ? groupMap.get(normalizeGroupCode(bk.bookingCode)) : null;
            const payBadge = groupInfo ? getGroupCellPaymentBadge(groupInfo) : getCellPaymentBadge(bk, showLabel, hasNext);

            const badgesHtml = `<div class="booking-badges">
              ${groupInfo ? `<span class="group-mini-badge" title="Đoàn ${escapeHtml(groupInfo.code)} (${groupInfo.roomCount} phòng) • Tổng ${formatVND(groupInfo.totalAmount)}">👥${groupInfo.roomCount}</span>` : ""}
              ${bk.mergeBed && room.type === "Twins" ? `<span class="badge-merge-red" title="Ghép giường (Twins → Double)">G</span>` : ""}
              ${Number(bk.extraBed) > 0 ? `<span class="badge-mini" title="Extra bed">+${bk.extraBed}</span>` : ""}
            </div>`;

            bodyHtml += `<td class="${baseCls.join(" ")}" data-room="${room.id}" data-date="${dt.iso}" data-booking-id="${bk.id}">
              <div class="booking-block ch-${chKey} ${segCls} ${vis ? "" : "bk-dimmed"}">
                <div class="booking-top-row">
                  <div class="booking-source">${showLabel ? escapeHtml(shortSource) : escapeHtml(shortGuest)}</div>
                  ${!hasNext ? badgesHtml : ""}
                </div>
                <div class="booking-guest" style="${showLabel ? "" : "opacity:0.72;"}">${showLabel ? escapeHtml(shortGuest) : escapeHtml(shortSource)}</div>
                <div class="booking-pay ${payBadge.cls}" title="${escapeHtml(payBadge.title)}">${escapeHtml(payBadge.text)}</div>
              </div>
            </td>`;
          }
        });

        bodyHtml += `</tr>`;
      });
    });

    $("calendar-tbody").innerHTML = bodyHtml || `<tr><td colspan="${daysCount + 1}" style="padding:32px; text-align:center; color:var(--text-muted);">Không tìm thấy phòng phù hợp với bộ lọc hiện tại.</td></tr>`;

    let footHtml = `<tr><td class="foot-sticky">Tổng trống (26 phòng) • T5 Buffet</td>`;
    dates.forEach((dt, idx) => {
      const avail = availPerDay[idx];
      const color = avail === 0 ? "color: var(--status-unpaid);" : avail <= 5 ? "color: var(--status-deposit);" : "";
      footHtml += `<td style="${color}" title="Ngày ${formatDateVN(dt.iso)}: Đã đặt ${26 - avail}/26 phòng, còn trống ${avail} phòng">${avail}/26</td>`;
    });
    footHtml += `</tr>`;
    $("calendar-tfoot").innerHTML = footHtml;
  }

  function renderAll() {
    updateTodayDateLabel();
    updateHeaderGroupPill();
    updateClipboardUI();
    renderLegend();
    renderKPIs();
    renderCalendar();
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
    $("calendar-tbody").addEventListener("mouseover", (e) => {
      const td = e.target.closest("td.grid-cell");
      if (td === hoveredCell) return;
      hoveredCell = td;
      if (!td) { hideTooltip(); return; }
      const roomId = td.dataset.room, dateISO = td.dataset.date, bookingId = td.dataset.bookingId;
      if (roomId === "DORM") {
        const list = getBookingsForRoomDate("DORM", dateISO);
        if (list.length > 0) showDormTooltip(e, dateISO, list);
        else hideTooltip();
      } else if (bookingId) {
        const bk = state.bookings.find((b) => b.id === bookingId);
        if (bk) showBookingTooltip(e, bk);
        else hideTooltip();
      } else {
        hideTooltip();
      }
    });

    $("calendar-tbody").addEventListener("mousemove", (e) => {
      if ($("cell-tooltip").classList.contains("visible")) positionTooltip(e);
    });

    $("calendar-tbody").addEventListener("mouseleave", () => {
      hoveredCell = null;
      hideTooltip();
    });
  }

  /* -------------------- Tooltips -------------------- */

  function showBookingTooltip(e, bk) {
    const room = getRoomById(bk.roomId), rem = getRemaining(bk), nights = diffNights(bk.checkin, bk.checkout);
    const statusLabel = rem === 0 && parseVND(bk.totalAmount) > 0 ? "Đã thanh toán hết" : parseVND(bk.paidAmount) > 0 ? "Đã đặt cọc" : "Chưa thanh toán";
    const extras = [];
    if (bk.mergeBed && room && room.type === "Twins") extras.push("Ghép giường (→ Double)");
    if (Number(bk.extraBed) > 0) extras.push(`+${bk.extraBed} Extra bed`);
    const groupSummary = bk.bookingCode ? computeBookingGroupSummary(state.bookings, bk.bookingCode) : null;
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
    $("cell-tooltip").classList.add("visible");
    positionTooltip(e);
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
    $("cell-tooltip").classList.add("visible");
    positionTooltip(e);
  }

  function positionTooltip(e) {
    const pad = 14, w = 265, h = $("cell-tooltip").offsetHeight || 180;
    let left = e.clientX + pad, top = e.clientY + pad;
    if (left + w > window.innerWidth - 10) left = e.clientX - w - pad;
    if (top + h > window.innerHeight - 10) top = e.clientY - h - pad;
    $("cell-tooltip").style.left = `${Math.max(8, left)}px`;
    $("cell-tooltip").style.top = `${Math.max(8, top)}px`;
  }

  const hideTooltip = () => $("cell-tooltip").classList.remove("visible");

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

  function openBookingModal({ bookingId = null, roomId = "101", checkin = getTodayISO(), prefill = null, allowRoomSelect = false } = {}) {
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
    const csv = generateCsvContent(state.bookings);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `lich-dat-phong-T${state.month + 1}-${state.year}.csv`; a.click();
    URL.revokeObjectURL(url);
    showToast("Đã xuất file Excel (CSV) an toàn");
  }

  function backupJSON() {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 2,
      hotel: "Dongvan Ville du H'mong Hotel",
      bookings: state.bookings,
      auditLogs: store.getAuditLogs()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `backup-dongvan-hotel-${getTodayISO()}.json`; a.click();
    URL.revokeObjectURL(url);
    showToast("Đã tải file sao lưu JSON");
  }

  function restoreJSON(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("File JSON quá lớn (> 5MB). Vui lòng kiểm tra lại file sao lưu.");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const res = await store.restoreFromImport(reader.result);
      if (!res.ok) {
        alert("Không thể khôi phục dữ liệu (dữ liệu hiện tại vẫn an toàn):\n" + res.error);
        return;
      }
      state.bookings = res.bookings;
      renderAll();
      onDataMutated("restore");
      showToast(`Đã khôi phục ${res.bookings.length} lượt đặt phòng (đã lưu bản hoàn tác)`);
    };
    reader.readAsText(file);
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
    return {
      exportedAt: new Date().toISOString(),
      version: 2,
      hotel: "Dongvan Ville du H'mong Hotel",
      ...extra,
      bookings: state.bookings,
      auditLogs: store.getAuditLogs()
    };
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

  function initTheme() {
    try {
      if (localStorage.getItem(THEME_KEY) === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
        $("btn-theme-toggle").textContent = "☀️";
      }
    } catch {}
    $("btn-theme-toggle").addEventListener("click", () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      if (isDark) {
        document.documentElement.removeAttribute("data-theme");
        try { localStorage.setItem(THEME_KEY, "light"); } catch {}
        $("btn-theme-toggle").textContent = "🌙";
      } else {
        document.documentElement.setAttribute("data-theme", "dark");
        try { localStorage.setItem(THEME_KEY, "dark"); } catch {}
        $("btn-theme-toggle").textContent = "☀️";
      }
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

  function updatePcSyncPill() {
    const status = store.getStatus ? store.getStatus() : { mode: "local", connectionStatus: "local", lastSyncedAt: null };
    const pill = $("pc-sync-status");
    const txt = $("pc-sync-text");
    if (!pill || !txt) return;
    pill.classList.remove("offline", "reconnecting");
    const t = status.lastSyncedAt ? formatTimestampVN(status.lastSyncedAt).slice(11) : "";
    const ver = status.runningVersion && status.runningVersion.appVersion
      ? `v${status.runningVersion.appVersion} (${status.runningVersion.buildId || ""})`
      : "";
    const staff = status.user && status.user.staffName ? ` • ${status.user.staffName}` : "";
    pill.title = `Trạng thái đồng bộ dữ liệu${ver ? ` • ${ver}` : ""}${staff}`;
    if (status.mode === "local") {
      txt.textContent = "Offline cục bộ";
    } else if (status.connectionStatus === "auth_required") {
      pill.classList.add("offline");
      txt.textContent = "Cần đăng nhập";
    } else if (status.connectionStatus === "connected") {
      txt.textContent = t ? `Đồng bộ ${t}` : "Đã đồng bộ";
    } else if (status.connectionStatus === "reconnecting") {
      pill.classList.add("reconnecting");
      txt.textContent = "Đang nối lại...";
    } else {
      pill.classList.add("offline");
      txt.textContent = t ? `Mất mạng (${t})` : "Mất mạng";
    }

    const logoutBtn = $("btn-pc-logout");
    if (logoutBtn) {
      logoutBtn.style.display = status.mode === "server" && status.authRequired && status.authenticated ? "" : "none";
      if (status.user && status.user.staffName) {
        logoutBtn.title = `Đăng xuất (${status.user.staffName})`;
      }
    }
  }

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
    if (staffSelect && Array.isArray(auth.staffList) && auth.staffList.length > 0) {
      const prev = staffSelect.value;
      staffSelect.innerHTML = auth.staffList.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
      if (prev && auth.staffList.includes(prev)) staffSelect.value = prev;
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

    // Register PC busy check so live A -> B auto-updates NEVER interrupt an open booking/Dorm form
    if (typeof store.registerBusyCheck === "function") {
      store.registerBusyCheck(() =>
        state.isSubmitting ||
        $("booking-modal").classList.contains("open") ||
        $("dorm-modal").classList.contains("open")
      );
    }

    // Unified Login Overlay & Update Banner handlers (shared by PC and Mobile)
    $("auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("auth-submit");
      const staffName = $("auth-staff").value;
      const passcode = $("auth-passcode").value;
      btn.disabled = true;
      btn.textContent = "Đang xác thực...";
      try {
        const res = await store.login(staffName, passcode);
        if (!res.ok) {
          syncAuthOverlay(res.error || "Đăng nhập thất bại.");
          return;
        }
        $("auth-passcode").value = "";
        syncAuthOverlay("");
        state.bookings = res.bookings || store.getBookings() || [];
        renderAll();
        updateAutoBackupUI();
        updatePcSyncPill();
        showToast(`Xin chào ${res.user.staffName} — đã kết nối sổ đặt phòng!`);
      } finally {
        btn.disabled = false;
        btn.textContent = "Đăng nhập vào sổ phòng";
      }
    });

    $("btn-pc-logout").addEventListener("click", async () => {
      if (!confirm("Đăng xuất tài khoản lễ tân trên thiết bị này?")) return;
      await store.logout();
      syncAuthOverlay("");
      updatePcSyncPill();
    });

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
          syncAuthOverlay(ev.error || "");
          return;
        }
        if (type === "auth_login") {
          syncAuthOverlay("");
        }
        if (type === "update_pending" || type === "update_applying") {
          syncAppUpdateBanner(type, ev.pendingUpdate);
          return;
        }
        if (type === "version") {
          syncAuthOverlay("");
          return;
        }
        if (type === "status" || !snap) return;
        state.bookings = snap.bookings || [];

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

        renderAll();
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
    $("btn-open-history").addEventListener("click", openHistoryModal);
    $("btn-cancel-clipboard").addEventListener("click", () => clearClipboard(false));
    $("btn-export-csv").addEventListener("click", exportCSV);
    $("btn-backup-json").addEventListener("click", backupJSON);
    $("input-restore-json").addEventListener("change", (e) => { restoreJSON(e.target.files[0]); e.target.value = ""; });

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
        openBookingModal({ bookingId: bkId });
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
    $("btn-close-confirm-pdf").onclick = $("btn-close-confirm-pdf-2").onclick = () => closeModal("confirm-pdf-modal");
    $("confirm-pdf-modal").addEventListener("click", (e) => { if (e.target === $("confirm-pdf-modal")) closeModal("confirm-pdf-modal"); });
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
        if ($("confirm-pdf-modal").classList.contains("open")) closeModal("confirm-pdf-modal");
        else if ($("booking-modal").classList.contains("open")) closeModal("booking-modal");
        else if ($("dorm-modal").classList.contains("open")) {
          if ($("dorm-slot-form").style.display !== "none") { setDormModalMode("board"); renderDormBoard(); }
          else closeModal("dorm-modal");
        } else if ($("group-report-modal").classList.contains("open")) closeModal("group-report-modal");
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
    initConfirmersDropdown();
    initPlatformChips();
    bindEvents();

    if (!window.__pmsClientInitPromise) {
      window.__pmsClientInitPromise = store.init();
    }
    const loadRes = await window.__pmsClientInitPromise;
    state.bookings = (loadRes && loadRes.bookings) || store.getBookings() || [];
    renderAll();
    updateAutoBackupUI();
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
    setTimeout(() => scrollToToday(false), 60);
  }

  boot();
})();
