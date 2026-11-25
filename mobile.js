/* ==========================================================================
   Dongvan Ville du H'mong Hotel PMS — Dedicated Mobile Front Desk (mobile.js)
   Shares 100% of business rules via PMSCore and realtime SQLite/SSE sync via
   window.pmsClient. Zero duplicated domain calculations.
   ========================================================================== */

(() => {
  "use strict";

  const Core = window.PMSCore;
  const client = window.pmsClient;
  if (!Core || !client) return;

  const {
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
    getRoomById,
    getRemaining,
    getPaymentStatus,
    calculateVatBreakdown,
    extractPreVatFromTotal,
    detectChannelKey,
    bookingCoversDate,
    getDormSlotMapForDate,
    getDormOccupiedSlotsInRange,
    checkRegularConflict,
    computeMonthlyFinancials,
    computeCalendarFinanceKPIs,
    getVietnamTodayISO,
    normalizeGroupCode,
    computeBookingGroupSummary,
    computeAllBookingGroups,
    allocateGroupPayment,
    buildCopiedBookingPayload,
    buildGroupSyncUpdates,
    getRoleLabel,
    hasPermission,
    NAV_ICONS_SVG,
    getVisibleNavGroups,
    getHousekeepingTasksForDate,
    ISSUE_SEVERITIES,
    ISSUE_STATUSES,
    computeRoomOperationalStatus,
    computeAllRoomOperationalStatuses,
    generateCsvContent,
    generateAuditCsvContent,
    diffBookingChanges
  } = Core;

  const THEME_KEY = "ks_manual_theme_v1";
  const MOBILE_DRAFT_KEY = "ks_manual_mobile_draft_v1";

  // View mode override (?view=mobile or ?view=pc)
  const params = new URLSearchParams(window.location.search);
  const forcedView = params.get("view");
  if (forcedView === "mobile" || forcedView === "pc") {
    document.body.dataset.viewMode = forcedView;
  }

  const mState = {
    activeTab: "schedule", // schedule | bookings | report | more
    activeNavKey: "calendar",
    secondaryStatsOpen: false,
    selectedDate: getTodayISO(),
    rangeOpen: false,
    rangeActive: false,
    rangeCheckin: getTodayISO(),
    rangeCheckout: addDaysISO(getTodayISO(), 1),
    filterDrawerOpen: false,
    filters: { search: "", floor: "all", type: "all", view: "all", payment: "all", channel: "all" },
    bookingsTabFilter: "all", // all | today | upcoming | debt
    bookingsSearch: "",
    bookingsChannel: "all",
    savedScrollTop: 0,
    // Active sheets
    roomDetailId: null,
    roomDetailYear: new Date().getFullYear(),
    roomDetailMonth: new Date().getMonth(),
    dormDate: getTodayISO(),
    dormMode: "board", // board | form
    dormSelectedSlots: [],
    editingDormId: null,
    editingDormRevision: null,
    dormIdempotencyKey: null,
    dormConflictBooking: null,
    dormConfirmationPdf: null,
    // Regular booking form
    editingBookingId: null,
    editingBookingRevision: null,
    editingOriginalBooking: null,
    lastAutofilledGroupCode: "",
    bookingIdempotencyKey: null,
    bookingChannelKey: "booking",
    bookingPayStatus: "deposit",
    bookingConflictBooking: null,
    bookingConfirmationPdf: null,
    copiedBooking: null,
    isSubmitting: false,
    // History filter
    historySearch: "",
    historyAction: "all",
    historyConfirmer: "all"
  };

  const $ = (id) => document.getElementById(id);

  function newIdemKey(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function formatTimeShort(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatDateTimeVN(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatFullDateLabel(iso) {
    const parts = String(iso || getTodayISO()).split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return `${DOW_FULL_VI[d.getDay()]}, ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  let toastTimer = null;
  function showMobileToast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function getBookings() {
    return client.getBookings() || [];
  }

  function getRoomTurnsForDate(roomId, dateISO) {
    const all = getBookings();
    const staying = all.filter((b) => b.roomId === roomId && bookingCoversDate(b, dateISO));
    const checkingOut = all.filter((b) => b.roomId === roomId && b.checkout === dateISO);
    return { staying, checkingOut };
  }

  function isRoomFreeInRange(roomId, ci, co) {
    if (!ci || !co || diffNights(ci, co) <= 0) return true;
    return !checkRegularConflict(getBookings(), { roomId, checkin: ci, checkout: co }, null);
  }

  function hasScheduleFilters() {
    const f = mState.filters;
    return Boolean(f.search || f.floor !== "all" || f.type !== "all" || f.view !== "all" || f.payment !== "all" || f.channel !== "all" || mState.rangeActive);
  }

  function getEffectiveMobileRemaining(bk) {
    if (bk && bk.bookingCode) {
      const grp = computeBookingGroupSummary(getBookings(), bk.bookingCode);
      if (grp && grp.roomCount >= 2) return grp.remaining;
    }
    return getRemaining(bk);
  }

  function bookingMatchesSearchAndFilters(bk) {
    const f = mState.filters;
    if (f.channel !== "all" && bk.channelKey !== f.channel) return false;
    const effRem = getEffectiveMobileRemaining(bk);
    if (f.payment === "debt" && effRem <= 0) return false;
    if (f.payment === "paid" && effRem > 0) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      const hay = `${bk.guestName} ${bk.phone} ${bk.sourceName} ${bk.tourName || ""} ${bk.bookingCode || ""} ${bk.roomId} ${bk.confirmedBy || ""} ${bk.notes || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  /* -------------------- Build Static Mobile Shell DOM -------------------- */

  function mountMobileShell() {
    const shell = $("mobile-shell");
    if (!shell) return;
    const logoSrc = (document.querySelector(".brand-logo") && document.querySelector(".brand-logo").getAttribute("src")) || "logo.jpg";

    shell.innerHTML = `
      <header class="m-topbar">
        <div class="m-topbar-left">
          <button id="m-btn-drawer-open" class="m-menu-trigger" type="button" aria-label="Mở menu điều hướng" aria-expanded="false" aria-controls="m-nav-drawer" title="Mở menu điều hướng">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <div class="m-brand">
            <img src="${escapeHtml(logoSrc)}" alt="Dongvan Ville du H'mong Hotel" class="m-brand-logo" />
            <div class="m-brand-text">
              <div class="m-brand-title">Dongvan Ville du H'mong</div>
              <div class="m-brand-sub">26 phòng • Dorm • T5 Buffet</div>
            </div>
          </div>
        </div>
        <div id="m-sync-chip" class="m-sync-chip" role="status" aria-live="polite">
          <span class="dot"></span>
          <span id="m-sync-text">Đang kết nối...</span>
        </div>
      </header>

      <div id="m-offline-banner" class="m-offline-banner" role="alert">
        <span id="m-offline-text">Mất kết nối máy chủ — không thể lưu cho tới khi có mạng.</span>
        <button id="m-btn-retry-sync" type="button" class="m-btn" style="min-height:36px; padding:0 10px; font-size:12px;">Thử lại</button>
      </div>

      <div id="m-issue-alert-banner" class="issue-alert-banner" role="alert" aria-live="polite">
        <span id="m-issue-alert-text" style="font-size:12px;"></span>
        <button id="m-btn-issue-alert-view" type="button" class="m-btn m-btn-primary" style="min-height:34px; padding:0 10px; font-size:12px; flex-shrink:0;">Xem</button>
      </div>

      <div id="m-clipboard-bar" class="m-clipboard-bar" role="status" aria-live="polite">
        <span id="m-clipboard-text" class="m-clipboard-text"></span>
        <button id="m-clipboard-cancel" type="button" class="m-clipboard-cancel">✕ Hủy dán</button>
      </div>

      <main id="m-main" class="m-main">
        <!-- Tab 1: Daily Schedule (Default Screen) -->
        <section id="m-view-schedule" class="m-tab-view active" aria-label="Lịch phòng">
          <div class="m-schedule-action-bar">
            <button id="m-btn-schedule-new-booking" class="m-cta-booking" type="button">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span>Đặt phòng</span>
            </button>
            <div id="m-schedule-actions-wrap" class="m-actions-dropdown-wrap">
              <button id="m-btn-schedule-actions" class="m-actions-btn" type="button" aria-haspopup="menu" aria-expanded="false">
                <span>Thao tác</span>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div id="m-schedule-actions-menu" class="m-actions-popover" role="menu">
                <button id="m-schedule-export-csv" class="m-actions-popover-item" type="button" role="menuitem">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span>Xuất Excel (CSV)</span>
                </button>
                <button id="m-schedule-day-report" class="m-actions-popover-item" type="button" role="menuitem">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  <span>Báo cáo ngày</span>
                </button>
              </div>
            </div>
          </div>

          <div class="m-date-bar">
            <button id="m-btn-prev-day" class="m-date-btn" type="button" aria-label="Ngày trước">◀</button>
            <div class="m-date-picker-wrap">
              <span id="m-date-main" class="m-date-label-main">Hôm nay</span>
              <span id="m-date-sub" class="m-date-label-sub">Chạm để chọn ngày</span>
              <input id="m-date-input" class="m-date-native" type="date" aria-label="Chọn ngày xem lịch" />
            </div>
            <button id="m-btn-next-day" class="m-date-btn" type="button" aria-label="Ngày sau">▶</button>
            <button id="m-btn-today" class="m-today-btn" type="button">Hôm nay</button>
          </div>

          <div id="m-stats-grid" class="m-stats-grid"></div>

          <!-- Range Availability Finder -->
          <div class="m-range-card">
            <button id="m-range-toggle" class="m-range-toggle" type="button">
              <span id="m-range-title">🔎 Tìm phòng trống theo khoảng ngày</span>
              <span id="m-range-arrow">▾</span>
            </button>
            <div id="m-range-body" class="m-range-body">
              <div class="m-range-inputs">
                <div class="m-field">
                  <label for="m-range-ci">Ngày nhận</label>
                  <input id="m-range-ci" class="m-input" type="date" />
                </div>
                <div class="m-field">
                  <label for="m-range-co">Ngày trả</label>
                  <input id="m-range-co" class="m-input" type="date" />
                </div>
              </div>
              <div class="m-range-actions">
                <button id="m-btn-apply-range" type="button" class="m-btn m-btn-primary m-btn-block">Tìm phòng trống</button>
                <button id="m-btn-clear-range" type="button" class="m-btn" style="display:none;">Bỏ lọc</button>
              </div>
              <div id="m-range-summary" style="font-size:12px; color:var(--text-secondary); display:none;"></div>
            </div>
          </div>

          <!-- Search & Filter Bar -->
          <div class="m-search-row">
            <input id="m-search-input" class="m-input" type="search" placeholder="Tìm tên khách, SĐT, phòng, mã ĐP..." />
            <button id="m-btn-filter-toggle" class="m-filter-btn" type="button">⚙ Lọc</button>
          </div>

          <div id="m-filter-drawer" class="m-filter-drawer">
            <div class="m-filter-grid">
              <select id="m-filter-floor" class="m-select" aria-label="Lọc tầng">
                <option value="all">Tất cả tầng &amp; Dorm</option>
                <option value="dorm">Dorm nội bộ (8 chỗ)</option>
                <option value="1">Tầng 1 (5 phòng ngủ)</option>
                <option value="2">Tầng 2 (7 phòng)</option>
                <option value="3">Tầng 3 (7 phòng)</option>
                <option value="4">Tầng 4 (7 phòng)</option>
              </select>
              <select id="m-filter-type" class="m-select" aria-label="Lọc hạng phòng">
                <option value="all">Mọi hạng phòng</option>
                <option value="Double">Double</option>
                <option value="Twins">Twins</option>
                <option value="Triple">Triple</option>
                <option value="Family">Family</option>
                <option value="Dorm">Dorm nội bộ</option>
              </select>
              <select id="m-filter-view" class="m-select" aria-label="Lọc view">
                <option value="all">Mọi view</option>
                <option value="View núi">View núi</option>
                <option value="View thung lũng">View thung lũng</option>
              </select>
              <select id="m-filter-payment" class="m-select" aria-label="Lọc thanh toán">
                <option value="all">Mọi thanh toán</option>
                <option value="debt">Còn nợ / Chưa đủ</option>
                <option value="paid">Đã thanh toán hết</option>
              </select>
            </div>
            <select id="m-filter-channel" class="m-select" aria-label="Lọc kênh đặt">
              <option value="all">Tất cả nguồn đặt</option>
              ${CHANNELS.map((c) => `<option value="${c.key}">${escapeHtml(c.label)}</option>`).join("")}
            </select>
            <button id="m-btn-reset-filters" type="button" class="m-btn">Đặt lại toàn bộ bộ lọc</button>
          </div>

          <div id="m-rooms-list" style="display:flex; flex-direction:column; gap:12px;"></div>
        </section>

        <!-- Tab 2: Bookings List -->
        <section id="m-view-bookings" class="m-tab-view" aria-label="Danh sách đơn đặt">
          <div style="display:flex; gap:8px;">
            <button id="m-btn-quick-new-booking" type="button" class="m-btn m-btn-primary m-btn-block">+ Đặt phòng mới</button>
            <button id="m-btn-quick-dorm" type="button" class="m-btn">🛏️ Dorm</button>
          </div>
          <input id="m-bk-search" class="m-input" type="search" placeholder="Tìm khách, SĐT, mã ĐP, tour, phòng..." />
          <div id="m-bk-chips" class="m-chip-wrap">
            <button type="button" class="m-chip active" data-bk-filter="all">Tất cả</button>
            <button type="button" class="m-chip" data-bk-filter="today">Hôm nay</button>
            <button type="button" class="m-chip" data-bk-filter="upcoming">Sắp đến</button>
            <button type="button" class="m-chip" data-bk-filter="debt">Còn nợ</button>
          </div>
          <select id="m-bk-channel" class="m-select" aria-label="Lọc theo kênh đặt">
            <option value="all">Tất cả nguồn đặt</option>
            ${CHANNELS.map((c) => `<option value="${c.key}">${escapeHtml(c.label)}</option>`).join("")}
          </select>
          <div id="m-bookings-list" style="display:flex; flex-direction:column; gap:8px;"></div>
        </section>

        <!-- Tab 3: Daily & Monthly Report -->
        <section id="m-view-report" class="m-tab-view" aria-label="Báo cáo hoạt động">
          <div id="m-report-content" style="display:flex; flex-direction:column; gap:10px;"></div>
        </section>

        <!-- Tab 4: More / All PC Secondary Tools -->
        <section id="m-view-more" class="m-tab-view" aria-label="Tiện ích và cài đặt">
          <div class="m-section-card">
            <h3>Trạng thái đồng bộ dữ liệu</h3>
            <div id="m-more-sync-info" style="font-size:13px; color:var(--text-secondary);"></div>
            <button id="m-btn-force-sync" type="button" class="m-btn m-btn-primary m-btn-block">↻ Đồng bộ dữ liệu mới nhất</button>
          </div>

          <div class="m-menu-list">
            <button id="m-menu-hk" type="button" class="m-menu-item">
              <span>🧹 Buồng phòng &amp; Sự cố phòng<span class="m-menu-sub">Xem tiến độ dọn, ảnh hoàn tất, giao việc dọn &amp; xử lý sự cố</span></span>
              <span>›</span>
            </button>
            <button id="m-menu-accounts" type="button" class="m-menu-item" style="display:none;">
              <span>👑 Quản lý tài khoản &amp; phân quyền<span class="m-menu-sub">Cấp tài khoản &amp; mật khẩu, chặn truy cập &amp; xóa tài khoản (chỉ Tổng quản lý)</span></span>
              <span>›</span>
            </button>
            <button id="m-menu-costs" type="button" class="m-menu-item">
              <span>💰 Chi phí vận hành &amp; giá vốn<span class="m-menu-sub">Định mức theo lưu trú, chứng từ thực tế &amp; chốt chi phí tháng</span></span>
              <span>›</span>
            </button>
            <button id="m-menu-history" type="button" class="m-menu-item">
              <span>🕒 Lịch sử chỉnh sửa &amp; Sao lưu tự động<span class="m-menu-sub">Xem thay đổi Trước → Sau và khôi phục mốc cũ</span></span>
              <span>›</span>
            </button>
            <button id="m-menu-rollback" type="button" class="m-menu-item">
              <span>↩ Hoàn tác thao tác gần nhất<span class="m-menu-sub">Khôi phục trạng thái ngay trước thay đổi cuối</span></span>
              <span>›</span>
            </button>
            <button id="m-menu-export-csv" type="button" class="m-menu-item">
              <span>📊 Xuất Excel danh sách phòng (CSV)<span class="m-menu-sub">Tải file bảng tổng hợp an toàn mở trên Excel</span></span>
              <span>›</span>
            </button>
            <button id="m-menu-backup-json" type="button" class="m-menu-item">
              <span>💾 Sao lưu dữ liệu JSON<span class="m-menu-sub">Tải toàn bộ sổ đặt phòng và lịch sử về máy</span></span>
              <span>›</span>
            </button>
            <label id="m-menu-restore-json" class="m-menu-item" for="m-input-restore-json">
              <span>📥 Khôi phục dữ liệu từ file JSON<span class="m-menu-sub">Thẩm định xung đột trước khi nạp dữ liệu</span></span>
              <span>›</span>
              <input id="m-input-restore-json" type="file" accept=".json" hidden />
            </label>
            <button id="m-menu-theme" type="button" class="m-menu-item">
              <span>🌙 Đổi giao diện Sáng / Tối<span class="m-menu-sub">Tối ưu cho ca trực ban ngày và ban đêm</span></span>
              <span id="m-menu-theme-val">Sáng</span>
            </button>
            <button id="m-menu-reset-sample" type="button" class="m-menu-item">
              <span>↻ Khôi phục dữ liệu mẫu<span class="m-menu-sub">Dùng khi chạy thử nghiệm (tự lưu bản dự phòng trước)</span></span>
              <span>›</span>
            </button>
            <button id="m-menu-switch-pc" type="button" class="m-menu-item">
              <span>🖥️ Chuyển sang bảng tháng PC<span class="m-menu-sub">Dùng khi mở trên máy tính bảng màn hình lớn</span></span>
              <span>›</span>
            </button>
            <button id="m-menu-logout" type="button" class="m-menu-item" style="display:none; color:var(--status-unpaid);">
              <span>🔒 Đăng xuất tài khoản<span id="m-menu-logout-sub" class="m-menu-sub">Kết thúc phiên đăng nhập trên thiết bị này</span></span>
              <span>›</span>
            </button>
          </div>
        </section>
      </main>

      <!-- Bottom Navigation (4 Main Items) -->
      <nav class="m-bottom-nav" aria-label="Điều hướng chính">
        <button type="button" class="m-nav-item active" data-m-tab="schedule">
          <span class="m-nav-icon">📅</span><span>Lịch</span>
        </button>
        <button type="button" class="m-nav-item" data-m-tab="bookings">
          <span class="m-nav-icon">📋</span><span>Đơn đặt</span>
        </button>
        <button type="button" class="m-nav-item" data-m-tab="report">
          <span class="m-nav-icon">📊</span><span>Báo cáo</span>
        </button>
        <button type="button" class="m-nav-item" data-m-tab="more">
          <span class="m-nav-icon">⚙️</span><span>Thêm</span>
        </button>
      </nav>

      <!-- Sheet 1: Room Detail & Per-Room Month Calendar -->
      <div id="m-sheet-room" class="m-sheet" role="dialog" aria-modal="true" aria-label="Chi tiết phòng">
        <div class="m-sheet-head">
          <button id="m-room-back" type="button" class="m-date-btn" aria-label="Quay lại">←</button>
          <div style="flex:1; min-width:0;">
            <h2 id="m-room-sheet-title" class="m-sheet-title">Phòng 101</h2>
            <div id="m-room-sheet-sub" class="m-sheet-sub">Double • View thung lũng</div>
          </div>
          <button id="m-room-book-btn" type="button" class="m-btn m-btn-primary" style="padding:0 12px; font-size:13px;">+ Đặt</button>
        </div>
        <div id="m-room-sheet-body" class="m-sheet-body"></div>
      </div>

      <!-- Sheet 2: Full-Screen Regular Room Booking / Edit Form -->
      <div id="m-sheet-booking" class="m-sheet" role="dialog" aria-modal="true" aria-label="Đặt hoặc sửa phòng">
        <div class="m-sheet-head">
          <button id="m-bk-close" type="button" class="m-date-btn" aria-label="Đóng">✕</button>
          <div style="flex:1; min-width:0;">
            <h2 id="m-bk-sheet-title" class="m-sheet-title">Đặt phòng mới</h2>
            <div id="m-bk-sheet-sub" class="m-sheet-sub">Phòng 101</div>
          </div>
          <button id="m-bk-copy" type="button" class="m-btn" style="display:none; padding:0 10px; font-size:12.5px;">📋 Chép</button>
          <button id="m-bk-delete" type="button" class="m-btn m-btn-danger" style="display:none; padding:0 10px; font-size:13px;">Xóa</button>
        </div>

        <form id="m-bk-form" class="m-sheet-body" novalidate>
          <div id="m-bk-conflict-banner" class="conflict-banner" role="alert">
            <div id="m-bk-conflict-text">⚠️ Đơn này vừa được cập nhật từ thiết bị khác. Nội dung bạn đang nhập vẫn được giữ lại.</div>
            <div id="m-bk-conflict-diff" style="font-size:12px;"></div>
            <div class="conflict-banner-actions">
              <button id="m-bk-reload-latest" type="button" class="m-btn m-btn-primary" style="min-height:38px; font-size:12.5px;">Tải lại bản mới nhất</button>
              <button id="m-bk-dismiss-conflict" type="button" class="m-btn" style="min-height:38px; font-size:12.5px;">Giữ nội dung đang gõ</button>
            </div>
          </div>

          <div id="m-bk-error" class="m-form-error" role="alert"></div>
          <div id="m-room-issue-warning" class="room-issue-warning" role="alert" style="display:none;"></div>
          <div id="m-checkout-bar" class="checkout-action-bar" style="display:none;">
            <div id="m-checkout-status" class="checkout-status-text"></div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; width:100%;">
              <button id="m-btn-request-stayover" type="button" class="m-btn" style="flex:1; min-height:40px; font-size:12.5px;">🧹 Dọn trong kỳ lưu trú</button>
              <button id="m-btn-checkout-booking" type="button" class="m-btn m-btn-primary" style="flex:1; min-height:40px; font-size:12.5px;">🚪 Check-out phòng</button>
            </div>
          </div>

          <!-- Group 1: Booking Date & Stay Dates -->
          <div class="m-form-group">
            <h3 class="m-group-title">1. Ngày đặt &amp; Ngày lưu trú</h3>
            <div id="m-wrap-room" class="m-field" style="display:none;">
              <label for="m-f-room">Chọn phòng (26 phòng khách)</label>
              <select id="m-f-room" class="m-select"></select>
            </div>
            <div class="m-field">
              <label for="m-f-booking-date">Ngày đặt phòng</label>
              <input id="m-f-booking-date" class="m-input" type="date" required />
            </div>
            <div class="m-grid-2">
              <div class="m-field">
                <label for="m-f-checkin">Ngày nhận *</label>
                <input id="m-f-checkin" class="m-input" type="date" required />
              </div>
              <div class="m-field">
                <label for="m-f-checkout">Ngày trả *</label>
                <input id="m-f-checkout" class="m-input" type="date" required />
              </div>
            </div>
            <div class="m-grid-2">
              <div class="m-field">
                <label for="m-f-guests">Số khách (Buffet T5)</label>
                <input id="m-f-guests" class="m-input" type="number" inputmode="numeric" min="1" max="12" value="2" />
              </div>
              <div class="m-field">
                <label>Số đêm</label>
                <input id="m-f-nights" class="m-input" type="text" readonly value="1 đêm" />
              </div>
            </div>
          </div>

          <!-- Group 2: Guest & Source -->
          <div class="m-form-group">
            <h3 class="m-group-title">2. Khách &amp; Nguồn đặt phòng</h3>
            <div class="m-field">
              <label>Đơn vị / Nền tảng đặt phòng</label>
              <div id="m-f-channels" class="m-chip-wrap"></div>
            </div>
            <div id="m-wrap-custom-source" class="m-field" style="display:none;">
              <label for="m-f-source-custom">Tên nền tảng khác *</label>
              <input id="m-f-source-custom" class="m-input" type="text" placeholder="VD: Traveloka, Facebook..." />
            </div>
            <div id="m-wrap-tour-name" class="m-field" style="display:none;">
              <label for="m-f-tour-name">Tên tour / Công ty tour</label>
              <input id="m-f-tour-name" class="m-input" type="text" placeholder="VD: Vietravel, Saigontourist, Đoàn công ty..." />
            </div>
            <div class="m-field">
              <label for="m-f-booking-code">Mã đặt phòng</label>
              <input id="m-f-booking-code" class="m-input" type="text" placeholder="VD: 4829103847" />
            </div>
            <div class="m-field">
              <label for="m-f-guest-name">Tên khách hàng *</label>
              <input id="m-f-guest-name" class="m-input" type="text" placeholder="VD: Nguyễn Văn An" required />
            </div>
            <div class="m-field">
              <label for="m-f-phone">Số điện thoại</label>
              <input id="m-f-phone" class="m-input" type="tel" inputmode="tel" placeholder="VD: 0912 345 678" />
            </div>
          </div>

          <!-- Group 3: Payment -->
          <div class="m-form-group">
            <h3 class="m-group-title">3. Thanh toán &amp; Tiền cọc</h3>
            <div class="m-pay-tabs">
              <button type="button" class="m-pay-tab" data-m-pay="paid">Đã thu đủ</button>
              <button type="button" class="m-pay-tab active" data-m-pay="deposit">Đã đặt cọc</button>
              <button type="button" class="m-pay-tab" data-m-pay="unpaid">Chưa TT</button>
            </div>
            <div class="m-grid-2">
              <div class="m-field">
                <label for="m-f-total">Tổng tiền (VNĐ)</label>
                <input id="m-f-total" class="m-input" type="text" inputmode="numeric" placeholder="0" />
              </div>
              <div class="m-field">
                <label for="m-f-paid">Đã TT / Cọc (VNĐ)</label>
                <input id="m-f-paid" class="m-input" type="text" inputmode="numeric" placeholder="0" />
              </div>
            </div>
            <div class="vat-box" id="m-vat-box">
              <label class="vat-toggle-row" for="m-f-include-vat">
                <span class="vat-toggle-left">
                  <input id="m-f-include-vat" type="checkbox" />
                  <span><strong>Cộng thêm VAT 8%</strong> <small>(nếu khách yêu cầu)</small></span>
                </span>
                <span id="m-vat-badge" class="vat-pill" style="display:none;">+ VAT 8%</span>
              </label>
              <div id="m-vat-breakdown" class="vat-breakdown" style="display:none;">
                <div class="vat-base-row">
                  <label for="m-f-pre-vat">Giá trước VAT (VNĐ)</label>
                  <input id="m-f-pre-vat" class="m-input vat-base-input" type="text" inputmode="numeric" placeholder="0" />
                </div>
                <div class="vat-summary-line">
                  <span>VAT 8%: <strong id="m-vat-amount-display">0 đ</strong></span>
                  <span>Tổng sau VAT: <strong id="m-vat-total-display">0 đ</strong></span>
                </div>
              </div>
            </div>
            <div class="balance-banner">
              <span>Còn lại chưa thanh toán:</span>
              <span id="m-f-remaining" class="balance-amount settled">0 đ</span>
            </div>
            <button id="m-bk-mark-paid" type="button" class="m-btn m-btn-success m-btn-block" style="display:none;">✓ Điền thu đủ 100%</button>
          </div>

          <!-- Live Group Summary & Lump-Sum Payment Allocation -->
          <div id="m-group-summary-box" class="m-group-box" style="display:none;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap;">
              <strong id="m-group-title" style="font-size:13px;">👥 Tổng hợp cả đoàn</strong>
              <span id="m-group-count" class="m-group-pill"></span>
            </div>
            <div id="m-group-rooms" class="m-group-rooms"></div>
            <label id="m-group-sync-wrap" class="group-sync-toggle" style="display:none;">
              <input id="chk-m-sync-group" type="checkbox" checked />
              <span id="m-group-sync-label">Tự động cập nhật thông tin sửa (tên khách, SĐT, nguồn, mã ĐP, người XN, PDF, ghi chú) cho tất cả phòng trong đoàn khi Lưu</span>
            </label>
            <div id="m-group-autofill-wrap" style="display:none;">
              <button id="m-btn-group-autofill" type="button" class="m-btn m-btn-primary m-btn-block">⚡ Lấy thông tin khách &amp; nguồn từ đoàn</button>
            </div>
            <div class="m-group-totals">
              <div><span>Tổng đoàn</span><strong id="m-group-total">0 đ</strong></div>
              <div><span>Đã cọc/TT</span><strong id="m-group-paid" class="ok">0 đ</strong></div>
              <div><span>Còn nợ</span><strong id="m-group-remaining" class="warn">0 đ</strong></div>
            </div>
            <div id="m-group-lump-wrap" class="m-group-lump">
              <input id="m-group-lump-input" class="m-input" type="text" inputmode="numeric" placeholder="Nhập tổng tiền cọc/thu chung cả đoàn (VNĐ)..." />
              <div class="m-group-lump-btns">
                <button id="m-btn-group-allocate" type="button" class="m-btn m-btn-primary">Cập nhật TT đoàn</button>
                <button id="m-btn-group-mark-paid" type="button" class="m-btn m-btn-success">✓ Thu đủ đoàn</button>
              </div>
            </div>
          </div>

          <!-- Group 4: Room Options, Confirmer & Notes -->
          <div class="m-form-group">
            <h3 class="m-group-title">4. Ghép giường, Xác nhận &amp; Ghi chú</h3>
            <label id="m-wrap-merge" class="m-toggle-row">
              <div>
                <div style="font-size:14px; font-weight:700;">Ghép giường <span class="m-badge-g">G</span></div>
                <div id="m-merge-hint" style="font-size:12px; color:var(--text-muted);">Chỉ áp dụng cho phòng Twins</div>
              </div>
              <input id="m-f-merge-bed" type="checkbox" />
            </label>
            <div class="m-field">
              <label for="m-f-extra-bed">Extra bed (Giường phụ)</label>
              <select id="m-f-extra-bed" class="m-select">
                <option value="0">Không</option>
                <option value="1">1 giường phụ</option>
                <option value="2">2 giường phụ</option>
              </select>
            </div>
            <div class="m-grid-2">
              <div class="m-field">
                <label for="m-f-confirmed-by">Người xác nhận</label>
                <select id="m-f-confirmed-by" class="m-select"></select>
              </div>
              <div class="m-field">
                <label>Xác nhận (PDF)</label>
                <div class="confirm-export-box">
                  <button id="m-btn-export-confirm-pdf" type="button" class="btn-export-pdf">📄 Xuất PDF xác nhận đặt phòng</button>
                  <button id="m-btn-view-legacy-pdf" type="button" class="pdf-legacy-link" style="display:none;" title="Xem file PDF cũ đã đính kèm">📎</button>
                </div>
              </div>
            </div>
            <div class="m-field">
              <label for="m-f-notes">Ghi chú của khách / Lễ tân</label>
              <textarea id="m-f-notes" class="m-textarea" placeholder="Giờ check-in, yêu cầu đặc biệt, buffet sáng..."></textarea>
            </div>
          </div>
        </form>

        <div class="m-sheet-footer">
          <button id="m-bk-cancel" type="button" class="m-btn">Hủy</button>
          <button id="m-bk-save" type="submit" form="m-bk-form" class="m-btn m-btn-primary m-btn-block">Lưu thông tin</button>
        </div>
      </div>

      <!-- Sheet 3: Dedicated Mobile Dorm 8-Slot Board & Form (2-Column Grid) -->
      <div id="m-sheet-dorm" class="m-sheet" role="dialog" aria-modal="true" aria-label="Quản lý 8 slot Dorm nội bộ">
        <div class="m-sheet-head">
          <button id="m-dorm-back-btn" type="button" class="m-date-btn" aria-label="Quay lại">←</button>
          <div style="flex:1; min-width:0;">
            <h2 id="m-dorm-title" class="m-sheet-title">🛏️ Dorm nội bộ (8 slot)</h2>
            <div id="m-dorm-sub" class="m-sheet-sub">Mục riêng • 4 giường tầng (8 chỗ) cho HDV &amp; Lái xe</div>
          </div>
          <button id="m-dorm-delete" type="button" class="m-btn m-btn-danger" style="display:none; padding:0 10px; font-size:13px;">Xóa</button>
        </div>

        <!-- Dorm Board Mode -->
        <div id="m-dorm-board-pane" class="m-sheet-body">
          <div class="m-date-bar" style="grid-template-columns:44px minmax(0,1fr) 44px;">
            <button id="m-dorm-prev" class="m-date-btn" type="button">◀</button>
            <div style="text-align:center;">
              <div id="m-dorm-date-label" style="font-size:14px; font-weight:800;"></div>
              <div id="m-dorm-cap-label" style="font-size:12px; font-weight:700; color:var(--status-paid);"></div>
            </div>
            <button id="m-dorm-next" class="m-date-btn" type="button">▶</button>
          </div>
          <div id="m-dorm-grid" class="m-dorm-grid"></div>
        </div>

        <!-- Dorm Form Mode -->
        <form id="m-dorm-form-pane" class="m-sheet-body" style="display:none;" novalidate>
          <div id="m-dorm-conflict-banner" class="conflict-banner" role="alert">
            <div id="m-dorm-conflict-text">⚠️ Lượt đặt Dorm này vừa được cập nhật từ thiết bị khác. Nội dung bạn đang nhập vẫn được giữ lại.</div>
            <div class="conflict-banner-actions">
              <button id="m-dorm-reload-latest" type="button" class="m-btn m-btn-primary" style="min-height:38px; font-size:12.5px;">Tải lại bản mới nhất</button>
            </div>
          </div>
          <div id="m-dorm-error" class="m-form-error" role="alert"></div>

          <div class="m-form-group">
            <h3 class="m-group-title">1. Ngày đặt &amp; Chọn slot giường tầng</h3>
            <div class="m-field">
              <label for="m-df-booking-date">Ngày đặt phòng</label>
              <input id="m-df-booking-date" class="m-input" type="date" required />
            </div>
            <div class="m-grid-2">
              <div class="m-field">
                <label for="m-df-checkin">Ngày nhận *</label>
                <input id="m-df-checkin" class="m-input" type="date" required />
              </div>
              <div class="m-field">
                <label for="m-df-checkout">Ngày trả *</label>
                <input id="m-df-checkout" class="m-input" type="date" required />
              </div>
            </div>
            <div class="m-field">
              <label>Chọn 1 hoặc nhiều slot (đỏ = đã có người trong khoảng ngày) *</label>
              <div id="m-dorm-picker" class="m-dorm-grid"></div>
            </div>
          </div>

          <div class="m-form-group">
            <h3 class="m-group-title">2. Thông tin HDV / Lái xe</h3>
            <div class="m-field">
              <label for="m-df-source">Đơn vị / Nguồn</label>
              <select id="m-df-source" class="m-select">
                <option value="tour">Gmail / Công ty tour</option>
                <option value="walkin">Nội bộ / Khách lẻ</option>
                <option value="zalo">Zalo</option>
                <option value="other">Nguồn khác</option>
              </select>
            </div>
            <div id="m-df-tour-wrap" class="m-field">
              <label for="m-df-tour">Tên tour / Công ty</label>
              <input id="m-df-tour" class="m-input" type="text" placeholder="VD: Vietravel, Saigontourist..." />
            </div>
            <div class="m-field">
              <label for="m-df-code">Mã đặt phòng</label>
              <input id="m-df-code" class="m-input" type="text" placeholder="VD: VR-2026-204" />
            </div>
            <div class="m-field">
              <label for="m-df-guest">Tên HDV / Lái xe *</label>
              <input id="m-df-guest" class="m-input" type="text" placeholder="VD: Anh Hùng (HDV)" required />
            </div>
            <div class="m-field">
              <label for="m-df-phone">Số điện thoại</label>
              <input id="m-df-phone" class="m-input" type="tel" inputmode="tel" placeholder="VD: 0915 667 432" />
            </div>
          </div>

          <div class="m-form-group">
            <h3 class="m-group-title">3. Thanh toán, Xác nhận &amp; Ghi chú</h3>
            <div class="m-grid-2">
              <div class="m-field">
                <label for="m-df-total">Tổng tiền (0 = miễn phí)</label>
                <input id="m-df-total" class="m-input" type="text" inputmode="numeric" placeholder="0" />
              </div>
              <div class="m-field">
                <label for="m-df-paid">Đã thu / Cọc (VNĐ)</label>
                <input id="m-df-paid" class="m-input" type="text" inputmode="numeric" placeholder="0" />
              </div>
            </div>
            <div class="balance-banner">
              <span>Còn lại:</span>
              <span id="m-df-remaining" class="balance-amount settled">0 đ</span>
            </div>
            <div class="m-grid-2">
              <div class="m-field">
                <label for="m-df-confirmed-by">Người xác nhận</label>
                <select id="m-df-confirmed-by" class="m-select"></select>
              </div>
              <div class="m-field">
                <label>Xác nhận (PDF)</label>
                <div class="confirm-export-box">
                  <button id="m-dorm-btn-export-confirm-pdf" type="button" class="btn-export-pdf">📄 Xuất PDF xác nhận đặt phòng</button>
                  <button id="m-dorm-btn-view-legacy-pdf" type="button" class="pdf-legacy-link" style="display:none;" title="Xem file PDF cũ đã đính kèm">📎</button>
                </div>
              </div>
            </div>
            <div class="m-field">
              <label for="m-df-notes">Ghi chú</label>
              <textarea id="m-df-notes" class="m-textarea" placeholder="Xe đoàn, phòng đi cùng..."></textarea>
            </div>
          </div>
        </form>

        <div id="m-dorm-footer-board" class="m-sheet-footer">
          <button id="m-dorm-close-btn" type="button" class="m-btn">Đóng</button>
          <button id="m-dorm-new-btn" type="button" class="m-btn m-btn-primary m-btn-block">+ Đặt slot mới</button>
        </div>
        <div id="m-dorm-footer-form" class="m-sheet-footer" style="display:none;">
          <button id="m-dorm-cancel-form" type="button" class="m-btn">Hủy</button>
          <button id="m-dorm-save" type="submit" form="m-dorm-form-pane" class="m-btn m-btn-primary m-btn-block">Lưu slot Dorm</button>
        </div>
      </div>

      <!-- Sheet 4: Mobile Edit History & Auto-Backup -->
      <div id="m-sheet-history" class="m-sheet" role="dialog" aria-modal="true" aria-label="Lịch sử chỉnh sửa">
        <div class="m-sheet-head">
          <button id="m-hist-close" type="button" class="m-date-btn" aria-label="Đóng">←</button>
          <div style="flex:1; min-width:0;">
            <h2 class="m-sheet-title">🕒 Lịch sử chỉnh sửa</h2>
            <div id="m-hist-sub" class="m-sheet-sub">Tự động sao lưu mỗi lần chỉnh sửa</div>
          </div>
          <button id="m-hist-export" type="button" class="m-btn" style="padding:0 10px; font-size:12.5px;">Excel</button>
        </div>
        <div class="m-sheet-body">
          <input id="m-hist-search" class="m-input" type="search" placeholder="Tìm tên khách, phòng, thay đổi..." />
          <div class="m-grid-2">
            <select id="m-hist-action" class="m-select">
              <option value="all">Mọi thao tác</option>
              <option value="CREATE">Đặt mới</option>
              <option value="UPDATE">Chỉnh sửa</option>
              <option value="DELETE">Xóa đơn</option>
              <option value="RESTORE_GROUP">Khôi phục</option>
            </select>
            <select id="m-hist-confirmer" class="m-select"></select>
          </div>
          <div id="m-hist-list" class="history-list"></div>
        </div>
      </div>

      <!-- Mobile Slide-out Navigation Drawer (shared NAV_CONFIG) -->
      <div id="m-nav-backdrop" class="m-nav-backdrop" aria-hidden="true"></div>
      <aside id="m-nav-drawer" class="m-nav-drawer" role="dialog" aria-modal="true" aria-label="Menu điều hướng khách sạn">
        <div class="m-drawer-head">
          <div class="m-drawer-brand">
            <img src="${escapeHtml(logoSrc)}" alt="Dongvan Ville du H'mong Hotel" class="m-brand-logo" />
            <div>
              <div class="m-drawer-brand-title">Dongvan Ville du H'mong Hotel</div>
              <div class="m-drawer-brand-sub">Hệ thống quản lý khách sạn</div>
            </div>
          </div>
          <button id="m-btn-drawer-close" class="m-drawer-close" type="button" aria-label="Đóng menu">✕</button>
        </div>
        <nav id="m-drawer-nav" class="m-drawer-body" aria-label="Danh mục chức năng"></nav>
        <div class="m-drawer-foot">
          <div class="m-drawer-user">
            <span id="m-drawer-user-name" class="m-drawer-user-name">Tài khoản trực ca</span>
            <span id="m-drawer-user-role" class="m-drawer-user-role">Lễ tân</span>
          </div>
          <div class="m-drawer-foot-actions">
            <button id="m-drawer-theme" class="m-drawer-foot-btn" type="button">🌙 Giao diện Tối</button>
            <button id="m-drawer-logout" class="m-drawer-foot-btn danger" type="button" style="display:none;">Đăng xuất</button>
          </div>
        </div>
      </aside>
    `;
  }

  /* -------------------- Sync Status, Mobile Drawer & Visual Viewport -------------------- */

  function mRole() {
    return typeof client.getRole === "function" ? client.getRole() : "manager";
  }

  function mCan(perm) {
    return typeof client.can === "function" ? client.can(perm) : hasPermission(mRole(), perm);
  }

  function openMobileNavDrawer() {
    renderMobileNavDrawer();
    const drawer = $("m-nav-drawer");
    const backdrop = $("m-nav-backdrop");
    const btn = $("m-btn-drawer-open");
    if (drawer) drawer.classList.add("open");
    if (backdrop) backdrop.classList.add("open");
    if (btn) btn.setAttribute("aria-expanded", "true");
  }

  function closeMobileNavDrawer() {
    const drawer = $("m-nav-drawer");
    const backdrop = $("m-nav-backdrop");
    const btn = $("m-btn-drawer-open");
    if (drawer) drawer.classList.remove("open");
    if (backdrop) backdrop.classList.remove("open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function renderMobileNavDrawer() {
    const navEl = $("m-drawer-nav");
    if (!navEl) return;
    const role = mRole();
    const visibleGroups = getVisibleNavGroups(role, (p) => mCan(p));
    const groupsCount = computeAllBookingGroups(getBookings(), { minRooms: 2 }).length;
    const hkTasks = typeof client.getHousekeepingTasks === "function" ? client.getHousekeepingTasks() : [];
    const hkIssues = typeof client.getMaintenanceIssues === "function" ? client.getMaintenanceIssues() : [];
    const hkPending = getHousekeepingTasksForDate(hkTasks, getTodayISO()).filter((t) => t.status !== "cleaned").length +
      hkIssues.filter((i) => i && i.status !== "resolved").length;

    navEl.innerHTML = visibleGroups.map((grp) => `
      <div class="m-drawer-group" data-m-nav-group="${escapeHtml(grp.key)}">
        <div class="m-drawer-group-label">${escapeHtml(grp.label)}</div>
        ${grp.items.map((item) => {
          const isActive = mState.activeNavKey === item.key;
          const iconSvg = (NAV_ICONS_SVG && NAV_ICONS_SVG[item.icon]) || "";
          let badgeHtml = "";
          if (item.key === "groups" && groupsCount > 0) {
            badgeHtml = `<span class="m-drawer-badge">${groupsCount}</span>`;
          } else if (item.key === "housekeeping" && hkPending > 0) {
            badgeHtml = `<span class="m-drawer-badge warn">${hkPending}</span>`;
          }
          return `<button type="button" class="m-drawer-item ${isActive ? "active" : ""}" data-m-nav-key="${escapeHtml(item.key)}" ${isActive ? 'aria-current="page"' : ""}>
            <span class="m-drawer-icon">${iconSvg}</span>
            <span class="m-drawer-label">${escapeHtml(item.label)}</span>
            ${badgeHtml}
          </button>`;
        }).join("")}
      </div>
    `).join("");

    const status = client.getStatus ? client.getStatus() : { mode: "local" };
    const staffName = status.user && status.user.staffName ? status.user.staffName : (status.mode === "local" ? "Máy trực ca" : "Tài khoản");
    const roleLabel = getRoleLabel(status.user && status.user.role ? status.user.role : role);
    if ($("m-drawer-user-name")) $("m-drawer-user-name").textContent = staffName;
    if ($("m-drawer-user-role")) $("m-drawer-user-role").textContent = roleLabel;
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    if ($("m-drawer-theme")) $("m-drawer-theme").textContent = isDark ? "☀️ Giao diện Sáng" : "🌙 Giao diện Tối";
    const showLogout = status.mode === "server" && status.authRequired && status.authenticated;
    if ($("m-drawer-logout")) $("m-drawer-logout").style.display = showLogout ? "" : "none";
  }

  function handleMobileNavAction(key) {
    mState.activeNavKey = key || "calendar";
    closeMobileNavDrawer();
    if (key === "calendar") {
      switchTab("schedule");
      return;
    }
    if (key === "groups") {
      if (window.PMSGroupReportModal) window.PMSGroupReportModal.open();
      return;
    }
    if (key === "dorm") {
      openDormSheet(mState.selectedDate || getTodayISO());
      return;
    }
    if (key === "housekeeping") {
      if (window.PMSHousekeepingApp) window.PMSHousekeepingApp.open({ tab: "tasks", roomId: "all", dateISO: getTodayISO() });
      return;
    }
    if (key === "receivables") {
      if (!mCan("finance:ar_read")) return showMobileToast("Bạn không có quyền truy cập Thu tiền & công nợ.");
      if (window.PMSFinanceApp) window.PMSFinanceApp.openReceivables({ asOfDate: getVietnamTodayISO() });
      return;
    }
    if (key === "cashbook") {
      if (!mCan("finance:cashbook_read")) return showMobileToast("Sổ quỹ & đối soát chỉ dành cho Quản lý.");
      if (window.PMSFinanceApp) window.PMSFinanceApp.openCashbook();
      return;
    }
    if (key === "payables") {
      if (!mCan("finance:payables_read")) return showMobileToast("Hóa đơn NCC & công nợ trả chỉ dành cho Quản lý.");
      if (window.PMSFinanceApp) window.PMSFinanceApp.openPayables();
      return;
    }
    if (key === "operating_costs") {
      if (!mCan("costs:read")) return showMobileToast("Chi phí & Giá vốn chỉ dành cho Quản lý.");
      if (window.PMSOperatingCostsModal) {
        window.PMSOperatingCostsModal.open(mState.selectedDate ? mState.selectedDate.slice(0, 7) : undefined);
      }
      return;
    }
    if (key === "history") {
      renderMobileHistorySheet();
      $("m-sheet-history").classList.add("open");
      if (typeof client.pullLatest === "function" && client.getStatus().mode === "server") {
        client.pullLatest().catch(() => {});
      }
      return;
    }
    if (key === "backup_restore") {
      if (!mCan("admin:backup")) return showMobileToast("Sao lưu & khôi phục chỉ dành cho Quản lý.");
      if (window.PMSBackupRestoreModal) window.PMSBackupRestoreModal.open();
      return;
    }
    if (key === "accounts") {
      if (!mCan("accounts:manage")) return showMobileToast("Quản trị tài khoản chỉ dành cho Tổng quản lý.");
      if (window.PMSHousekeepingApp) window.PMSHousekeepingApp.openAccounts();
    }
  }

  function applyMobileRolePermissionsUI() {
    const canCosts = mCan("costs:read");
    const canAccounts = mCan("accounts:manage");
    const canBackup = mCan("admin:backup");
    const role = mRole();

    if ($("m-menu-hk")) $("m-menu-hk").style.display = role === "housekeeping" ? "none" : "";
    if ($("m-menu-accounts")) $("m-menu-accounts").style.display = canAccounts ? "" : "none";
    if ($("m-menu-costs")) $("m-menu-costs").style.display = canCosts ? "" : "none";
    if ($("m-menu-rollback")) $("m-menu-rollback").style.display = canBackup ? "" : "none";
    if ($("m-menu-export-csv")) $("m-menu-export-csv").style.display = canBackup ? "" : "none";
    if ($("m-schedule-export-csv")) $("m-schedule-export-csv").style.display = canBackup ? "" : "none";
    if ($("m-menu-backup-json")) $("m-menu-backup-json").style.display = canBackup ? "" : "none";
    if ($("m-menu-restore-json")) $("m-menu-restore-json").style.display = canBackup ? "" : "none";
    if ($("m-menu-reset-sample")) $("m-menu-reset-sample").style.display = canBackup ? "" : "none";

    renderMobileNavDrawer();
    renderMobileIssueBanner();
  }

  function renderMobileIssueBanner() {
    const banner = $("m-issue-alert-banner");
    const txt = $("m-issue-alert-text");
    if (!banner || !txt) return;
    if (mRole() === "housekeeping" || !mCan("bookings:read")) {
      banner.classList.remove("show");
      return;
    }
    const issues = typeof client.getMaintenanceIssues === "function" ? client.getMaintenanceIssues() : [];
    const openIssues = issues.filter((i) => i && i.status !== "resolved");
    if (openIssues.length === 0) {
      banner.classList.remove("show");
      return;
    }
    const blocking = openIssues.filter((i) => i.blocksRoom);
    const primary = blocking[0] || openIssues[0];
    const rName = getRoomById(primary.roomId)?.name || primary.roomId;
    txt.textContent = blocking.length > 0
      ? `🚫 P.${rName} chưa thể giao khách: ${primary.description}`
      : `⚠️ P.${rName} có sự cố: ${primary.description}`;
    banner.classList.add("show");
  }

  function renderSyncStatus() {
    const status = client.getStatus();
    const chip = $("m-sync-chip");
    const txt = $("m-sync-text");
    const offlineBanner = $("m-offline-banner");
    const offlineText = $("m-offline-text");
    const moreInfo = $("m-more-sync-info");
    if (!chip || !txt) return;

    const lastStr = status.lastSyncedAt ? formatTimeShort(status.lastSyncedAt) : "chưa có";
    chip.classList.remove("offline", "reconnecting");

    if (status.mode === "local") {
      txt.textContent = "Offline cục bộ";
      offlineBanner.classList.remove("show");
    } else if (status.connectionStatus === "auth_required") {
      chip.classList.add("offline");
      txt.textContent = "Cần đăng nhập";
      offlineBanner.classList.remove("show");
    } else if (status.connectionStatus === "connected") {
      txt.textContent = `Đồng bộ ${lastStr}`;
      offlineBanner.classList.remove("show");
    } else if (status.connectionStatus === "reconnecting") {
      chip.classList.add("reconnecting");
      txt.textContent = "Đang nối lại...";
      offlineText.textContent = `Đang kết nối lại máy chủ • Đồng bộ cuối: ${lastStr}`;
      offlineBanner.classList.add("show");
    } else {
      chip.classList.add("offline");
      txt.textContent = "Mất mạng";
      offlineText.textContent = `Mất kết nối máy chủ • Đồng bộ cuối: ${lastStr}. Nội dung đang nhập vẫn được giữ lại.`;
      offlineBanner.classList.add("show");
    }

    const ver = status.runningVersion && status.runningVersion.appVersion
      ? `v${escapeHtml(status.runningVersion.appVersion)}${status.runningVersion.buildId ? ` (${escapeHtml(status.runningVersion.buildId)})` : ""}`
      : "—";

    if (moreInfo) {
      const modeLabel = status.mode !== "server"
        ? "Bộ nhớ cục bộ trình duyệt (Offline)"
        : status.backend === "supabase"
          ? "Đám mây Supabase Realtime 2 chiều (PC & Điện thoại)"
          : "Máy chủ chung khách sạn (SQLite + SSE 2 chiều)";
      const connLabel = status.connectionStatus === "connected"
        ? (status.realtimeConnected ? "Trực tuyến tức thì (Realtime)" : "Đã kết nối trực tiếp")
        : status.connectionStatus === "auth_required"
          ? "Chờ đăng nhập"
          : status.connectionStatus === "local"
            ? "Đang chạy offline"
            : "Mất kết nối / Đang nối lại";
      moreInfo.innerHTML = `
        <div><strong>Chế độ:</strong> ${modeLabel}</div>
        <div><strong>Trạng thái:</strong> ${connLabel}</div>
        ${status.user && status.user.staffName ? `<div><strong>Tài khoản trực ca:</strong> ${escapeHtml(status.user.staffName)} (${escapeHtml(getRoleLabel(status.user.role))})</div>` : ""}
        <div><strong>Phiên bản ứng dụng:</strong> <span id="m-app-version-val">${ver}</span></div>
        <div><strong>Đồng bộ lần cuối:</strong> ${status.lastSyncedAt ? formatDateTimeVN(status.lastSyncedAt) : "—"} (rev ${status.storeVersion})</div>
      `;
    }

    const logoutBtn = $("m-menu-logout");
    if (logoutBtn) {
      const showLogout = status.mode === "server" && status.authRequired && status.authenticated;
      logoutBtn.style.display = showLogout ? "" : "none";
      const sub = $("m-menu-logout-sub");
      if (sub && status.user && status.user.staffName) {
        sub.textContent = `Đang đăng nhập: ${status.user.staffName} (${getRoleLabel(status.user.role)})`;
      }
    }

    applyMobileRolePermissionsUI();
  }

  function bindVisualViewportSupport() {
    if (!window.visualViewport) return;
    const syncHeight = () => {
      const h = `${Math.round(window.visualViewport.height)}px`;
      const shell = $("mobile-shell");
      if (shell) shell.style.height = h;
      document.querySelectorAll(".m-sheet.open").forEach((s) => { s.style.height = h; });
    };
    window.visualViewport.addEventListener("resize", syncHeight);
  }

  /* -------------------- Mobile Copy/Paste & Group Lump-Sum Helpers -------------------- */

  function updateMobileClipboardUI() {
    const bar = $("m-clipboard-bar");
    const txt = $("m-clipboard-text");
    if (!bar || !txt) return;
    const src = mState.copiedBooking;
    if (!src) {
      bar.classList.remove("show");
      return;
    }
    const nights = Math.max(1, diffNights(src.checkin, src.checkout) || 1);
    const rName = getRoomById(src.roomId)?.name || src.roomId;
    const codePart = src.bookingCode ? ` • ${src.bookingCode}` : "";
    txt.textContent = `📋 Đang chép P.${rName} (${src.guestName}, ${nights}đ${codePart}) — chạm 📋 Dán ở phòng trống`;
    bar.classList.add("show");
  }

  function copyMobileBooking(bk) {
    if (!bk || bk.roomId === "DORM") {
      showMobileToast("Chức năng sao chép áp dụng cho 26 phòng khách.");
      return;
    }
    mState.copiedBooking = {
      ...bk,
      confirmationPdf: bk.confirmationPdf ? { ...bk.confirmationPdf } : null
    };
    $("m-sheet-booking").classList.remove("open");
    updateMobileClipboardUI();
    renderMobileAll();
    showMobileToast(`📋 Đã sao chép P.${getRoomById(bk.roomId)?.name || bk.roomId} — chạm "📋 Dán" ở phòng trống`);
  }

  function clearMobileClipboard(silent = false) {
    if (!mState.copiedBooking) return;
    mState.copiedBooking = null;
    updateMobileClipboardUI();
    renderMobileAll();
    if (!silent) showMobileToast("Đã thoát chế độ dán phòng");
  }

  async function pasteMobileBookingIntoRoom(targetRoomId, targetCheckin) {
    if (!mState.copiedBooking || mState.isSubmitting) return;
    const built = buildCopiedBookingPayload(mState.copiedBooking, targetRoomId, targetCheckin, { keepGroupCode: true });
    if (!built.ok) {
      showMobileToast(built.error);
      return;
    }
    mState.isSubmitting = true;
    try {
      const res = await client.saveBooking(built.payload, { idempotencyKey: newIdemKey("mpaste") });
      if (!res.ok) {
        openMobileBookingSheet({ roomId: targetRoomId, checkin: targetCheckin, prefill: built.payload });
        showMobileBookingError(res.error);
        return;
      }
      renderMobileAll();
      const rName = getRoomById(targetRoomId)?.name || targetRoomId;
      const grpSuffix = res.booking.bookingCode ? ` • Đoàn ${res.booking.bookingCode}` : "";
      showMobileToast(`📋 Đã dán vào P.${rName}${grpSuffix}`);
    } finally {
      mState.isSubmitting = false;
    }
  }

  async function applyMobileGroupLumpSumPayment(bookingCode, targetPaidRaw) {
    if (mState.isSubmitting) return { ok: false, error: "Đang xử lý, vui lòng đợi..." };
    mState.isSubmitting = true;
    try {
      const summary = computeBookingGroupSummary(getBookings(), bookingCode);
      if (!summary) return { ok: false, error: "Không tìm thấy phòng nào trong mã đoàn này." };
      const alloc = allocateGroupPayment(summary.bookings, targetPaidRaw);
      if (!alloc.ok) return { ok: false, error: alloc.error };

      let updatedCount = 0;
      for (const item of alloc.allocations) {
        if (!item.changed) continue;
        const latestBk = getBookings().find((b) => b.id === item.id);
        if (!latestBk) continue;
        const nextStatus = item.totalAmount > 0 && item.newPaid >= item.totalAmount
          ? "paid"
          : (item.newPaid > 0 ? "deposit" : "unpaid");
        const saveRes = await client.saveBooking({
          ...latestBk,
          paidAmount: item.newPaid,
          paymentStatus: nextStatus
        }, { expectedRevision: Number(latestBk.revision) || 1 });
        if (!saveRes.ok) {
          renderMobileAll();
          return { ok: false, error: `Lỗi cập nhật P.${getRoomById(latestBk.roomId)?.name || latestBk.roomId}: ${saveRes.error}` };
        }
        updatedCount += 1;
      }

      renderMobileAll();
      return { ok: true, updatedCount, summary: computeBookingGroupSummary(getBookings(), bookingCode) };
    } finally {
      mState.isSubmitting = false;
    }
  }

  /* -------------------- Render Tab 1: Daily Schedule -------------------- */

  function renderTurnCardHtml(bk, turnLabel, turnClass, groupMap = null) {
    const room = getRoomById(bk.roomId);
    const grp = bk.bookingCode
      ? (groupMap ? groupMap.get(normalizeGroupCode(bk.bookingCode)) : computeBookingGroupSummary(getBookings(), bk.bookingCode))
      : null;
    const isMultiGroup = Boolean(grp && grp.roomCount >= 2);

    let payStatus, payText, effRem;
    if (isMultiGroup) {
      const gTotal = parseVND(grp.totalAmount);
      const gPaid = parseVND(grp.paidAmount);
      effRem = Math.max(0, parseVND(grp.remaining));
      payStatus = grp.paymentStatus || (gTotal > 0 && effRem === 0 ? "paid" : gPaid > 0 ? "deposit" : "unpaid");
      payText = gTotal === 0
        ? "Chưa nhập giá đoàn"
        : effRem === 0
          ? `✓ Đã TT đủ cả đoàn (${formatShortVND(gTotal)})`
          : gPaid > 0
            ? `Còn thiếu cả đoàn ${formatShortVND(effRem)}`
            : `Chưa TT • Nợ đoàn ${formatShortVND(gTotal)}`;
    } else {
      effRem = getRemaining(bk);
      const total = parseVND(bk.totalAmount);
      const paid = parseVND(bk.paidAmount);
      payStatus = getPaymentStatus(bk);
      payText = total === 0
        ? "Chưa nhập giá"
        : effRem === 0
          ? `✓ Đã TT đủ (${formatShortVND(total)})`
          : paid > 0
            ? `Còn thiếu ${formatShortVND(effRem)}`
            : `Chưa TT • Nợ ${formatShortVND(total)}`;
    }

    const chKey = bk.channelKey || detectChannelKey(bk.sourceName);
    return `<div class="m-turn-box ${turnClass}" data-m-edit-bk="${escapeHtml(bk.id)}">
      ${turnLabel ? `<div class="m-turn-label">${escapeHtml(turnLabel)}</div>` : ""}
      <div class="m-guest-row">
        <span class="m-guest-name">${escapeHtml(bk.guestName)}</span>
        <div class="m-badges-row">
          ${bk.mergeBed && room && room.type === "Twins" ? `<span class="m-badge-g" title="Ghép giường Twins thành Double">G</span>` : ""}
          ${Number(bk.extraBed) > 0 ? `<span class="m-badge-eb">+${bk.extraBed} EB</span>` : ""}
          ${bk.confirmationPdf && bk.confirmationPdf.name ? `<span class="pdf-mini-badge" title="Đã lưu file PDF xác nhận">📄 PDF</span>` : ""}
        </div>
      </div>
      ${isMultiGroup ? `<div class="m-badges-row"><span class="m-group-pill">👥 Đoàn ${escapeHtml(grp.code)} (${grp.roomCount} phòng)</span></div>` : ""}
      <div class="m-badges-row">
        <span class="m-channel-tag ch-${escapeHtml(chKey)}">${escapeHtml(bk.sourceName)}</span>
        <span style="font-size:11.5px; color:var(--text-muted);">${formatDateVN(bk.checkin)} → ${formatDateVN(bk.checkout)}</span>
        ${bk.confirmedBy ? `<span style="font-size:11px; color:var(--text-muted);">• XN: ${escapeHtml(bk.confirmedBy)}</span>` : ""}
      </div>
      <div class="m-pay-row">
        <span class="m-pay-pill ${payStatus}">${payText}</span>
        ${effRem > 0 ? `<span style="font-size:11px; font-weight:700; color:var(--accent-primary);">Chạm để thu/sửa ›</span>` : ""}
      </div>
    </div>`;
  }

  function renderScheduleView() {
    updateMobileClipboardUI();
    const dateISO = mState.selectedDate;
    const isToday = dateISO === getTodayISO();
    $("m-date-main").textContent = formatFullDateLabel(dateISO);
    $("m-date-sub").textContent = isToday ? "Hôm nay • Chạm để đổi ngày" : "Chạm để chọn ngày khác";
    $("m-date-input").value = dateISO;

    const allBookings = getBookings();
    const turnsByRoom = new Map();
    for (let i = 0; i < allBookings.length; i++) {
      const b = allBookings[i];
      if (!b || b.roomId === "DORM") continue;
      const isStay = bookingCoversDate(b, dateISO);
      const isOut = b.checkout === dateISO;
      if (!isStay && !isOut) continue;
      let entry = turnsByRoom.get(b.roomId);
      if (!entry) {
        entry = { staying: [], checkingOut: [] };
        turnsByRoom.set(b.roomId, entry);
      }
      if (isStay) entry.staying.push(b);
      if (isOut) entry.checkingOut.push(b);
    }
    const emptyTurns = { staying: [], checkingOut: [] };
    const getTurnsFast = (roomId) => turnsByRoom.get(roomId) || emptyTurns;

    const regularRooms = ROOMS.filter((r) => !r.isDorm);
    let occupiedCount = 0;
    let checkinsToday = 0;
    let checkoutsToday = 0;
    let mergeToday = 0;
    let ebToday = 0;
    let buffetGuests = 0;

    regularRooms.forEach((r) => {
      const { staying, checkingOut } = getTurnsFast(r.id);
      if (staying.length > 0) {
        occupiedCount += 1;
        const bk = staying[0];
        if (bk.checkin === dateISO) checkinsToday += 1;
        if (bk.mergeBed && r.type === "Twins") mergeToday += 1;
        ebToday += Number(bk.extraBed) || 0;
        buffetGuests += Number(bk.guestCount) || r.defaultGuests;
      }
      checkoutsToday += checkingOut.length;
    });

    const vacantCount = regularRooms.length - occupiedCount;
    const { map: dormMap } = getDormSlotMapForDate(allBookings, dateISO);
    const dormUsed = Object.keys(dormMap).length;
    const dormFree = Math.max(0, 8 - dormUsed);

    const [selYearStr, selMonthStr] = String(dateISO || getTodayISO()).split("-");
    const selYear = Number(selYearStr) || new Date().getFullYear();
    const selMonth = (Number(selMonthStr) || (new Date().getMonth() + 1)) - 1;
    const fState = typeof client.getFinanceState === "function" ? client.getFinanceState() : null;
    const finKpi = computeCalendarFinanceKPIs(allBookings, fState, selYear, selMonth);
    mState.lastFinYear = selYear;
    mState.lastFinMonth = selMonth;
    mState.lastArAsOfDate = finKpi.arAsOfDate;
    const nowD = new Date();
    const isSelCurrentMonth = selYear === nowD.getFullYear() && selMonth === nowD.getMonth();
    const dayTag = isToday ? "Hôm nay" : formatDateVN(dateISO).slice(0, 5);
    const monthTag = isSelCurrentMonth ? "Tháng này" : `Tháng ${selMonth + 1}/${selYear}`;
    const todayVN = getVietnamTodayISO();
    const arLbl = finKpi.arAsOfDate === todayVN ? "Công nợ đến hôm nay" : `Công nợ đến ${formatDateVN(finKpi.arAsOfDate).slice(0, 5)}`;
    const secOpen = Boolean(mState.secondaryStatsOpen);

    $("m-stats-grid").innerHTML = `
      <div class="m-kpi-panel">
        <div class="m-kpi-group-box">
          <div class="m-kpi-group-head">
            <span class="m-kpi-group-badge">${escapeHtml(dayTag)}</span>
            <button id="m-stats-more-toggle" type="button" class="m-kpi-more-btn" aria-expanded="${secOpen ? "true" : "false"}">
              ${secOpen ? "Thu gọn chỉ số phụ ▴" : "Chỉ số phụ & Tháng này ▾"}
            </button>
          </div>
          <div class="m-kpi-two-col">
            <div class="m-kpi-cell">
              <span class="m-kpi-cell-label">Phòng đang ở / trống</span>
              <span id="m-kpi-today-occ" class="m-kpi-cell-val">${occupiedCount} / 26 phòng</span>
              <span class="m-kpi-cell-sub">Còn trống ${vacantCount} • ${checkinsToday} đến / ${checkoutsToday} đi</span>
            </div>
            <div class="m-kpi-cell is-clickable" id="m-stat-dorm-card" role="button" tabindex="0" title="Chạm mở sơ đồ 8 chỗ Dorm nội bộ">
              <span class="m-kpi-cell-label">Dorm nội bộ (8 chỗ)</span>
              <span id="m-kpi-today-dorm" class="m-kpi-cell-val ${dormFree === 0 ? "warn" : "ok"}">Đặt ${dormUsed} • Còn ${dormFree}/8</span>
              <span class="m-kpi-cell-sub">Chạm để đặt slot Dorm</span>
            </div>
          </div>

          <div id="m-stats-more-body" class="m-kpi-secondary ${secOpen ? "open" : ""}">
            <div class="m-kpi-two-col">
              <div class="m-kpi-cell">
                <span class="m-kpi-cell-label">Giường ghép / Extra bed</span>
                <span id="m-kpi-today-hk" class="m-kpi-cell-val">${mergeToday} ghép • ${ebToday} EB</span>
              </div>
              <div class="m-kpi-cell">
                <span class="m-kpi-cell-label">Buffet sáng tầng 5</span>
                <span id="m-kpi-today-buffet" class="m-kpi-cell-val">${buffetGuests} khách</span>
              </div>
            </div>
          </div>
        </div>

        <div id="m-kpi-month-group" class="m-kpi-group-box m-kpi-secondary ${secOpen ? "open" : ""}">
          <div class="m-kpi-group-head">
            <span class="m-kpi-group-badge month">${escapeHtml(monthTag)}</span>
            <span style="font-size:10.5px; color:var(--text-muted);">Chạm để xem chi tiết chứng từ</span>
          </div>
          <div class="m-kpi-two-col">
            <div class="m-kpi-cell is-clickable" id="m-kpi-paid-card" role="button" tabindex="0">
              <span class="m-kpi-cell-label">Tiền thực thu</span>
              <span id="m-kpi-month-paid" class="m-kpi-cell-val ok">${formatVND(finKpi.monthlyNetReceived)}</span>
              ${finKpi.monthlyRefunds > 0 ? `<span class="m-kpi-cell-sub">Đã trừ hoàn ${formatVND(finKpi.monthlyRefunds)}</span>` : ""}
            </div>
            <div class="m-kpi-cell is-clickable" id="m-kpi-debt-card" role="button" tabindex="0">
              <span class="m-kpi-cell-label">${escapeHtml(arLbl)}</span>
              <span id="m-kpi-month-debt" class="m-kpi-cell-val ${finKpi.arAsOfTotal > 0 ? "warn" : "ok"}">${formatVND(finKpi.arAsOfTotal)}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    // Update range UI
    $("m-range-ci").value = mState.rangeCheckin;
    $("m-range-co").value = mState.rangeCheckout;
    $("m-btn-clear-range").style.display = mState.rangeActive ? "inline-flex" : "none";
    const dormRangeMap = mState.rangeActive
      ? getDormOccupiedSlotsInRange(allBookings, mState.rangeCheckin, mState.rangeCheckout, null)
      : null;
    if (mState.rangeActive) {
      const freeInRange = regularRooms.filter((r) => isRoomFreeInRange(r.id, mState.rangeCheckin, mState.rangeCheckout)).length;
      const dormOccRange = Object.keys(dormRangeMap).length;
      $("m-range-title").textContent = `🔎 Trống ${formatDateVN(mState.rangeCheckin)} → ${formatDateVN(mState.rangeCheckout)} (${freeInRange} phòng)`;
      $("m-range-summary").style.display = "block";
      $("m-range-summary").innerHTML = `Đang chỉ hiện <strong>${freeInRange}/26 phòng trống suốt kỳ</strong> (${diffNights(mState.rangeCheckin, mState.rangeCheckout)} đêm) • Dorm trống <strong>${8 - dormOccRange}/8 slot</strong>.`;
    } else {
      $("m-range-title").textContent = "🔎 Tìm phòng trống theo khoảng ngày";
      $("m-range-summary").style.display = "none";
    }

    $("m-btn-filter-toggle").classList.toggle("has-filter", hasScheduleFilters());

    // Precompute multi-room group map
    const groupMap = new Map();
    computeAllBookingGroups(allBookings, { minRooms: 2 }).forEach((g) => groupMap.set(g.normalizedCode, g));
    const pasteActive = Boolean(mState.copiedBooking);
    const roomStatuses = (typeof client.getRoomStatuses === "function" && client.getRoomStatuses())
      || computeAllRoomOperationalStatuses(
        typeof client.getHousekeepingTasks === "function" ? client.getHousekeepingTasks() : [],
        typeof client.getMaintenanceIssues === "function" ? client.getMaintenanceIssues() : [],
        getTodayISO()
      );

    // Build section-grouped room cards (Dorm separated at VERY TOP, then Floors 1-4)
    const htmlParts = [];

    for (const section of ROOM_SECTIONS) {
      if (mState.filters.floor === "dorm") {
        if (!section.isDorm) continue;
      } else if (mState.filters.floor !== "all") {
        if (section.isDorm || String(section.floor) !== mState.filters.floor) continue;
      }

      const sectionRooms = ROOMS.filter((r) => {
        if (section.isDorm ? !r.isDorm : (r.isDorm || r.floor !== section.floor)) return false;
        if (mState.filters.type !== "all" && r.type !== mState.filters.type) return false;
        if (mState.filters.view !== "all" && r.view !== mState.filters.view) return false;

        if (mState.rangeActive) {
          if (r.isDorm) {
            if (Object.keys(dormRangeMap).length >= 8) return false;
          } else if (!isRoomFreeInRange(r.id, mState.rangeCheckin, mState.rangeCheckout)) {
            return false;
          }
        }

        const hasBookingFilter = Boolean(mState.filters.search || mState.filters.payment !== "all" || mState.filters.channel !== "all");
        if (hasBookingFilter) {
          const q = mState.filters.search.toLowerCase();
          const roomNameMatches = q && (`p.${r.name} ${r.name} ${r.type} ${r.view}`).toLowerCase().includes(q);
          if (r.isDorm) {
            const dormBks = allBookings.filter((b) => b.roomId === "DORM" && (bookingCoversDate(b, dateISO) || b.checkout === dateISO));
            if (!roomNameMatches && !dormBks.some(bookingMatchesSearchAndFilters)) return false;
          } else {
            const { staying, checkingOut } = getTurnsFast(r.id);
            const allTurns = [...staying, ...checkingOut];
            if (!roomNameMatches && !allTurns.some(bookingMatchesSearchAndFilters)) return false;
          }
        }
        return true;
      });

      if (sectionRooms.length === 0) continue;

      const cardsHtml = sectionRooms.map((room) => {
        if (room.isDorm) {
          const dMap = mState.rangeActive ? dormRangeMap : dormMap;
          const used = Object.keys(dMap).length;
          const free = Math.max(0, 8 - used);
          const uniqueGuests = [...new Set(Object.values(dMap).map((b) => b.guestName))];
          return `<article class="m-room-card dorm-card" data-room-id="DORM">
            <div class="m-room-head" data-m-open-dorm="${escapeHtml(mState.rangeActive ? mState.rangeCheckin : dateISO)}">
              <div>
                <div class="m-room-title-row">
                  <span class="m-room-num">🛏️ ${escapeHtml(room.name)}</span>
                </div>
                <div class="m-room-meta">4 giường tầng (8 chỗ) • HDV &amp; Lái xe</div>
              </div>
              <span class="m-status-pill ${free === 0 ? "full" : "vacant"}">Trống ${free}/8</span>
            </div>
            ${uniqueGuests.length > 0 ? `<div style="font-size:12px; color:var(--text-secondary);">Đang ở: ${escapeHtml(uniqueGuests.slice(0, 3).join(", "))}${uniqueGuests.length > 3 ? ` (+${uniqueGuests.length - 3})` : ""}</div>` : ""}
            <div class="m-card-actions">
              <button type="button" class="m-btn m-btn-primary m-btn-block" data-m-open-dorm="${escapeHtml(mState.rangeActive ? mState.rangeCheckin : dateISO)}">Mở sơ đồ 8 slot Dorm</button>
            </div>
          </article>`;
        }

        const { staying, checkingOut } = getTurnsFast(room.id);
        const stayingBk = staying[0] || null;
        const checkoutBk = checkingOut.find((b) => !stayingBk || b.id !== stayingBk.id) || null;
        const isTurnover = Boolean(stayingBk && checkoutBk);
        const cardCls = isTurnover ? "turnover" : stayingBk ? "occupied" : "vacant";
        const pillCls = isTurnover ? "turnover" : stayingBk ? "occupied" : "vacant";
        const pillTxt = isTurnover ? "Trả & Nhận" : stayingBk ? (stayingBk.checkin === dateISO ? "Nhận hôm nay" : "Đang ở") : (checkoutBk ? "Trả phòng → Trống" : "Trống");

        const bookCi = mState.rangeActive ? mState.rangeCheckin : dateISO;
        const bookCo = mState.rangeActive ? mState.rangeCheckout : addDaysISO(dateISO, 1);

        const ops = roomStatuses[room.id] || null;
        let opsHtml = "";
        if (ops) {
          const pills = [];
          if (ops.cleanliness === "dirty") {
            pills.push(`<button type="button" class="room-hk-pill dirty" data-m-open-room-hk="${escapeHtml(room.id)}">🔴 Cần dọn</button>`);
          } else if (ops.cleanliness === "in_progress") {
            pills.push(`<button type="button" class="room-hk-pill in_progress" data-m-open-room-hk="${escapeHtml(room.id)}">🟡 Đang dọn</button>`);
          } else if (ops.cleanliness === "cleaned") {
            pills.push(`<button type="button" class="room-hk-pill cleaned" data-m-open-room-hk="${escapeHtml(room.id)}">✅ Đã dọn</button>`);
          }
          if (ops.isBlocked && ops.blockingIssues.length > 0) {
            const topIss = ops.blockingIssues[0];
            const shortDesc = topIss.description.length > 22 ? `${topIss.description.slice(0, 22)}…` : topIss.description;
            pills.push(`<button type="button" class="room-issue-pill" data-m-open-room-issues="${escapeHtml(room.id)}">🚫 Sự cố: ${escapeHtml(shortDesc)}</button>`);
          } else if (ops.hasOpenIssues) {
            pills.push(`<button type="button" class="room-issue-pill soft" data-m-open-room-issues="${escapeHtml(room.id)}">⚠️ Sự cố (${ops.activeIssues.length})</button>`);
          }
          if (pills.length > 0) opsHtml = `<div class="room-ops-badges">${pills.join("")}</div>`;
        }

        return `<article class="m-room-card ${cardCls}" data-room-id="${escapeHtml(room.id)}">
          <div class="m-room-head" data-m-open-room="${escapeHtml(room.id)}">
            <div>
              <div class="m-room-title-row">
                <span class="m-room-num">Phòng ${escapeHtml(room.name)}</span>
                ${room.type === "Twins" ? `<span style="font-size:11px; color:var(--text-muted);">(Ghép được)</span>` : ""}
              </div>
              <div class="m-room-meta">${escapeHtml(room.type)} • ${escapeHtml(room.view)}</div>
              ${opsHtml}
            </div>
            <span class="m-status-pill ${pillCls}">${pillTxt}</span>
          </div>
          ${checkoutBk ? renderTurnCardHtml(checkoutBk, "↗ Trả phòng hôm nay", "checkout-turn", groupMap) : ""}
          ${stayingBk ? renderTurnCardHtml(stayingBk, isTurnover ? "↙ Nhận phòng hôm nay" : (stayingBk.checkin === dateISO ? "↙ Nhận phòng hôm nay" : ""), isTurnover ? "checkin-turn" : "", groupMap) : ""}
          ${!stayingBk ? `<div class="m-card-actions">
            ${pasteActive ? `<button type="button" class="m-btn m-btn-primary m-btn-block" data-m-paste-room="${escapeHtml(room.id)}" data-m-ci="${escapeHtml(bookCi)}">📋 Dán vào P.${escapeHtml(room.name)}</button>` : ""}
            <button type="button" class="m-btn ${pasteActive ? "" : "m-btn-primary m-btn-block"}" data-m-book-room="${escapeHtml(room.id)}" data-m-ci="${escapeHtml(bookCi)}" data-m-co="${escapeHtml(bookCo)}">${pasteActive ? "+ Mới" : `+ Đặt phòng${mState.rangeActive ? ` (${diffNights(bookCi, bookCo)} đêm)` : ""}`}</button>
            ${!pasteActive ? `<button type="button" class="m-btn" data-m-open-room="${escapeHtml(room.id)}">Lịch phòng</button>` : ""}
          </div>` : ""}
        </article>`;
      }).join("");

      if (section.isDorm) {
        const dMap = mState.rangeActive
          ? getDormOccupiedSlotsInRange(getBookings(), mState.rangeCheckin, mState.rangeCheckout, null)
          : dormMap;
        const free = Math.max(0, 8 - Object.keys(dMap).length);
        htmlParts.push(`<div class="m-floor-section" data-m-section="dorm">
          <div class="m-floor-header is-dorm">
            <span>🛏️ Dorm nội bộ (Mục riêng • 8 chỗ)</span>
            <span>Trống ${free}/8 slot</span>
          </div>
          ${cardsHtml}
        </div>`);
      } else {
        const floorFreeCount = sectionRooms.filter((r) => getRoomTurnsForDate(r.id, dateISO).staying.length === 0).length;
        htmlParts.push(`<div class="m-floor-section" data-m-section="${section.floor}">
          <div class="m-floor-header">
            <span>Tầng ${section.floor} (${sectionRooms.length} phòng ngủ)</span>
            <span>Trống ${floorFreeCount}/${sectionRooms.length}</span>
          </div>
          ${cardsHtml}
        </div>`);
      }
    }

    $("m-rooms-list").innerHTML = htmlParts.length > 0
      ? htmlParts.join("")
      : `<div class="m-section-card" style="text-align:center; color:var(--text-muted); padding:24px 12px;">
          Không tìm thấy phòng phù hợp với bộ lọc hiện tại.
        </div>`;
  }

  /* -------------------- Render Tab 2: Bookings List -------------------- */

  function renderBookingsTab() {
    const today = getTodayISO();
    const q = mState.bookingsSearch.trim().toLowerCase();
    const groupMap = new Map();
    computeAllBookingGroups(getBookings(), { minRooms: 2 }).forEach((g) => groupMap.set(g.normalizedCode, g));

    const list = getBookings().filter((bk) => {
      const grp = bk.bookingCode ? groupMap.get(normalizeGroupCode(bk.bookingCode)) : null;
      const effRem = grp ? grp.remaining : getRemaining(bk);
      if (mState.bookingsTabFilter === "today" && !(bookingCoversDate(bk, today) || bk.checkout === today)) return false;
      if (mState.bookingsTabFilter === "upcoming" && bk.checkin <= today) return false;
      if (mState.bookingsTabFilter === "debt" && effRem <= 0) return false;
      if (mState.bookingsChannel !== "all" && bk.channelKey !== mState.bookingsChannel) return false;
      if (q) {
        const hay = `${bk.guestName} ${bk.phone} ${bk.sourceName} ${bk.tourName || ""} ${bk.bookingCode || ""} ${bk.roomId} ${bk.confirmedBy || ""} ${bk.notes || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => String(a.checkin).localeCompare(String(b.checkin)) || String(a.roomId).localeCompare(String(b.roomId)));

    $("m-bookings-list").innerHTML = list.length === 0
      ? `<div class="m-section-card" style="text-align:center; color:var(--text-muted); padding:24px;">Không có đơn đặt phòng phù hợp.</div>`
      : list.map((bk) => {
        const room = getRoomById(bk.roomId);
        const grp = bk.bookingCode ? groupMap.get(normalizeGroupCode(bk.bookingCode)) : null;
        const effRem = grp ? grp.remaining : getRemaining(bk);
        const roomLabel = room ? (room.isDorm ? `Dorm (Slot ${(bk.slots || []).join(",")})` : `Phòng ${room.name} • ${room.type}`) : bk.roomId;
        return `<div class="m-room-card ${room && room.isDorm ? "dorm-card" : "occupied"}">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
            <strong style="font-size:14px;">${escapeHtml(roomLabel)}</strong>
            <span style="font-size:11.5px; color:var(--text-muted);">${diffNights(bk.checkin, bk.checkout)} đêm</span>
          </div>
          ${renderTurnCardHtml(bk, "", "", groupMap)}
          ${effRem > 0 ? `<div class="m-card-actions">
            <button type="button" class="m-btn m-btn-success m-btn-block" data-m-edit-bk="${escapeHtml(bk.id)}">💰 Thu tiền / Cập nhật</button>
          </div>` : ""}
        </div>`;
      }).join("");
  }

  /* -------------------- Render Tab 3: Daily & Monthly Report -------------------- */

  function renderReportTab() {
    const dateISO = mState.selectedDate;
    const dParts = dateISO.split("-").map(Number);
    const year = dParts[0];
    const month0 = dParts[1] - 1;
    const regularRooms = ROOMS.filter((r) => !r.isDorm);
    const activeEntries = [], checkins = [], checkouts = [], hkTasks = [], debtRows = [];
    const seenDebtGroups = new Set();
    let buffetTotal = 0;

    regularRooms.forEach((room) => {
      const { staying, checkingOut } = getRoomTurnsForDate(room.id, dateISO);
      if (staying.length > 0) {
        const bk = staying[0];
        activeEntries.push({ room, bk });
        buffetTotal += Number(bk.guestCount) || room.defaultGuests;
        if (bk.checkin === dateISO) checkins.push({ room, bk });
        if ((bk.mergeBed && room.type === "Twins") || Number(bk.extraBed) > 0) hkTasks.push({ room, bk });

        const grp = bk.bookingCode ? computeBookingGroupSummary(getBookings(), bk.bookingCode) : null;
        if (grp && grp.roomCount >= 2) {
          if (grp.remaining > 0 && !seenDebtGroups.has(grp.normalizedCode)) {
            seenDebtGroups.add(grp.normalizedCode);
            const rLabels = grp.bookings.map((b) => b.roomId === "DORM" ? "Dorm" : `P.${getRoomById(b.roomId)?.name || b.roomId}`).join(", ");
            debtRows.push({
              bkId: bk.id,
              label: `<strong>👥 Đoàn ${escapeHtml(grp.code)}</strong> (${escapeHtml(rLabels)})`,
              remaining: grp.remaining
            });
          }
        } else if (getRemaining(bk) > 0) {
          debtRows.push({
            bkId: bk.id,
            label: `<strong>P.${room.name}</strong> — ${escapeHtml(bk.guestName)}`,
            remaining: getRemaining(bk)
          });
        }
      }
      checkingOut.forEach((bk) => checkouts.push({ room, bk }));
    });

    const { map: dormMap } = getDormSlotMapForDate(getBookings(), dateISO);
    const dormUsed = Object.keys(dormMap).length;
    const fin = computeMonthlyFinancials(getBookings(), year, month0);
    const groups = computeAllBookingGroups(getBookings(), { minRooms: 2 });
    const health = client.runHealthCheck();

    const groupsHtml = groups.length === 0
      ? `<div style="font-size:12.5px; color:var(--text-muted);">Chưa có đoàn nào có từ 2 phòng trở lên chung Mã đặt phòng.</div>`
      : groups.map((g) => `
          <div class="m-group-box" data-m-rpt-group="${escapeHtml(g.code)}">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap;">
              <strong style="font-size:13.5px;">👥 ${escapeHtml(g.code)} — ${escapeHtml(g.tourName || g.leadGuestName)}</strong>
              <span class="m-group-pill">${g.roomCount} phòng • ${g.totalNights} đêm</span>
            </div>
            <div style="font-size:11.5px; color:var(--text-muted);">${escapeHtml(g.sourceName)} • ${formatDateVN(g.earliestCheckin)} → ${formatDateVN(g.latestCheckout)}</div>
            <div class="m-group-rooms">
              ${g.bookings.map((b) => {
                const lbl = b.roomId === "DORM" ? `Dorm(${(b.slots || []).join(",")})` : `P.${getRoomById(b.roomId)?.name || b.roomId}`;
                const amt = parseVND(b.totalAmount);
                return `<button type="button" class="m-group-room-tag" data-m-edit-bk="${escapeHtml(b.id)}">${escapeHtml(lbl)} • ${amt > 0 ? formatShortVND(amt) : "0đ"}</button>`;
              }).join("")}
            </div>
            <div class="m-group-totals">
              <div><span>Tổng đoàn</span><strong>${formatVND(g.totalAmount)}</strong></div>
              <div><span>Đã thu</span><strong class="ok">${formatVND(g.paidAmount)}</strong></div>
              <div><span>Còn nợ</span><strong class="${g.remaining > 0 ? "warn" : "ok"}">${formatVND(g.remaining)}</strong></div>
            </div>
            <div class="m-group-lump">
              <input class="m-input m-rpt-group-lump-input" type="text" inputmode="numeric" value="${g.paidAmount > 0 ? formatNumberInput(g.paidAmount) : ""}" placeholder="Nhập tổng tiền cọc/TT cả đoàn (VNĐ)..." />
              <div class="m-group-lump-btns">
                <button type="button" class="m-btn m-btn-primary" data-m-rpt-group-allocate="${escapeHtml(g.code)}">Cập nhật TT đoàn</button>
                <button type="button" class="m-btn m-btn-success" data-m-rpt-group-paid="${escapeHtml(g.code)}" ${g.remaining <= 0 ? "disabled" : ""}>✓ Thu đủ đoàn</button>
              </div>
            </div>
          </div>
        `).join("");

    $("m-report-content").innerHTML = `
      <div class="m-section-card">
        <h3>👥 Tổng hợp theo Đoàn / Mã đặt phòng (${groups.length})</h3>
        ${groupsHtml}
      </div>

      <div class="m-section-card">
        <h3>📅 Báo cáo ngày ${formatDateVN(dateISO)}</h3>
        <div class="m-kv-row"><span>Phòng đang ở</span><strong>${activeEntries.length} / 26 phòng (trống ${26 - activeEntries.length})</strong></div>
        <div class="m-kv-row"><span>Dorm nội bộ (Mục riêng)</span><strong>Đã đặt ${dormUsed}/8 (còn ${8 - dormUsed} slot)</strong></div>
        <div class="m-kv-row"><span>Nhận / Trả phòng ngày này</span><strong>${checkins.length} đến • ${checkouts.length} đi</strong></div>
        <div class="m-kv-row"><span>🍽️ Buffet sáng Tầng 5 (dự kiến)</span><strong style="color:#b45309;">${buffetTotal} khách</strong></div>
      </div>

      <div class="m-section-card">
        <h3>💰 Tài chính Tháng ${month0 + 1}/${year} (theo tháng nhận phòng)</h3>
        <div class="m-kv-row"><span>Số đơn trong tháng</span><strong>${fin.bookingCount} đơn</strong></div>
        <div class="m-kv-row"><span>Tổng doanh thu</span><strong>${formatVND(fin.totalRevenue)}</strong></div>
        <div class="m-kv-row"><span>Đã thu / Đã cọc</span><strong style="color:var(--status-paid);">${formatVND(fin.totalPaid)}</strong></div>
        <div class="m-kv-row"><span>Còn phải thu</span><strong style="color:var(--status-unpaid);">${formatVND(fin.totalDebt)}</strong></div>
      </div>

      <div class="m-section-card">
        <h3>🛏️ Yêu cầu buồng phòng (${hkTasks.length})</h3>
        ${hkTasks.length === 0
          ? `<div style="font-size:12.5px; color:var(--text-muted);">Không có yêu cầu ghép giường hoặc extra bed ngày này.</div>`
          : hkTasks.map(({ room, bk }) => `<div class="m-kv-row" data-m-edit-bk="${escapeHtml(bk.id)}" style="cursor:pointer;">
              <span><strong>P.${room.name}</strong> — ${escapeHtml(bk.guestName)}</span>
              <span>${bk.mergeBed ? `<span class="m-badge-g">G</span> ` : ""}${Number(bk.extraBed) > 0 ? `<span class="m-badge-eb">+${bk.extraBed} EB</span>` : ""}</span>
            </div>`).join("")}
      </div>

      <div class="m-section-card">
        <h3>⚠️ Công nợ cần thu ngày này (${debtRows.length})</h3>
        ${debtRows.length === 0
          ? `<div style="font-size:12.5px; color:var(--status-paid);">Tất cả phòng đang ở ngày này đã thanh toán đủ.</div>`
          : debtRows.map((row) => `<div class="m-kv-row" data-m-edit-bk="${escapeHtml(row.bkId)}" style="cursor:pointer;">
              <span>${row.label}</span>
              <strong style="color:var(--status-unpaid);">Nợ ${formatVND(row.remaining)} ›</strong>
            </div>`).join("")}
      </div>

      <div class="m-section-card">
        <h3>🛡️ Sức khỏe hệ thống</h3>
        <div class="m-kv-row"><span>Toàn vẹn dữ liệu</span><strong style="color:${health.ok ? "var(--status-paid)" : "var(--status-unpaid)"};">${health.ok ? "An toàn (0 lỗi)" : `${health.consistencyErrors.length} cảnh báo`}</strong></div>
        <div class="m-kv-row"><span>Mốc sao lưu tự động</span><strong>${health.autoBackupCount || 0} mốc • ${health.auditLogCount || 0} lịch sử</strong></div>
      </div>
    `;
  }

  /* -------------------- Sheet 1: Room Detail & Per-Room Month Calendar -------------------- */

  function openRoomDetailSheet(roomId) {
    const room = getRoomById(roomId);
    if (!room) return;
    if (room.isDorm) return openDormSheet(mState.selectedDate);
    mState.savedScrollTop = $("m-main").scrollTop;
    mState.roomDetailId = roomId;
    const p = mState.selectedDate.split("-").map(Number);
    mState.roomDetailYear = p[0];
    mState.roomDetailMonth = p[1] - 1;
    renderRoomDetailSheet();
    $("m-sheet-room").classList.add("open");
  }

  function renderRoomDetailSheet() {
    const room = getRoomById(mState.roomDetailId);
    if (!room) return;
    const year = mState.roomDetailYear;
    const month0 = mState.roomDetailMonth;
    const daysCount = getDaysInMonth(year, month0);
    const firstDow = new Date(year, month0, 1).getDay();
    const today = getTodayISO();

    $("m-room-sheet-title").textContent = `Phòng ${room.name} (${room.type})`;
    $("m-room-sheet-sub").textContent = `Tầng ${room.floor} • ${room.view} • ${room.bedInfo}`;

    let calCells = DOW_VI.map((d) => `<div class="m-cal-dow">${d}</div>`).join("");
    for (let i = 0; i < firstDow; i++) calCells += `<div class="m-cal-day empty"></div>`;

    for (let day = 1; day <= daysCount; day++) {
      const iso = formatDateISO(year, month0, day);
      const { staying, checkingOut } = getRoomTurnsForDate(room.id, iso);
      const isTurn = staying.length > 0 && checkingOut.some((c) => c.id !== staying[0].id);
      const cls = [
        "m-cal-day",
        iso === today ? "today" : "",
        isTurn ? "turnover" : staying.length > 0 ? "booked" : ""
      ].filter(Boolean).join(" ");
      const dot = isTurn ? "⇄" : staying.length > 0 ? "●" : "+";
      calCells += `<button type="button" class="${cls}" data-m-room-cal-day="${iso}" data-m-room-cal-bk="${staying[0] ? escapeHtml(staying[0].id) : ""}">
        <span>${day}</span>
        <span class="m-cal-day-dot">${dot}</span>
      </button>`;
    }

    const roomBookings = getBookings()
      .filter((b) => b.roomId === room.id && b.checkout >= getTodayISO())
      .sort((a, b) => a.checkin.localeCompare(b.checkin));

    $("m-room-sheet-body").innerHTML = `
      <div class="m-section-card">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
          <button id="m-rcal-prev" type="button" class="m-date-btn">◀</button>
          <strong style="font-size:14.5px;">Lịch phòng ${room.name} — Tháng ${month0 + 1}/${year}</strong>
          <button id="m-rcal-next" type="button" class="m-date-btn">▶</button>
        </div>
        <div class="m-room-cal-grid">${calCells}</div>
        <div style="font-size:11.5px; color:var(--text-muted); text-align:center;">
          Chạm ngày trống (+) để đặt nhanh • Chạm ngày có khách (●) để xem/sửa đơn
        </div>
      </div>

      <div class="m-section-card">
        <h3>Danh sách đơn của Phòng ${room.name} (${roomBookings.length})</h3>
        ${roomBookings.length === 0
          ? `<div style="font-size:12.5px; color:var(--text-muted);">Chưa có đơn đặt sắp tới cho phòng này.</div>`
          : roomBookings.map((bk) => renderTurnCardHtml(bk, "", "")).join("")}
      </div>
    `;
  }

  /* -------------------- Sheet 2: Full-Screen Regular Booking Form -------------------- */

  function saveMobileDraft() {
    if (mState.editingBookingId) return;
    try {
      sessionStorage.setItem(MOBILE_DRAFT_KEY, JSON.stringify({
        roomId: $("m-f-room").value,
        bookingDate: $("m-f-booking-date").value,
        checkin: $("m-f-checkin").value,
        checkout: $("m-f-checkout").value,
        channelKey: mState.bookingChannelKey,
        sourceCustom: $("m-f-source-custom").value,
        tourName: $("m-f-tour-name").value,
        bookingCode: $("m-f-booking-code").value,
        guestName: $("m-f-guest-name").value,
        phone: $("m-f-phone").value,
        guestCount: $("m-f-guests").value,
        totalAmount: $("m-f-total").value,
        includeVat: $("m-f-include-vat").checked,
        preVatAmount: $("m-f-pre-vat").value,
        paidAmount: $("m-f-paid").value,
        mergeBed: $("m-f-merge-bed").checked,
        extraBed: $("m-f-extra-bed").value,
        confirmedBy: $("m-f-confirmed-by").value,
        notes: $("m-f-notes").value
      }));
    } catch {}
  }

  function clearMobileDraft() {
    try { sessionStorage.removeItem(MOBILE_DRAFT_KEY); } catch {}
  }

  function loadMobileDraftFor(roomId, checkin) {
    try {
      const raw = sessionStorage.getItem(MOBILE_DRAFT_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (d && d.roomId === roomId && d.checkin === checkin && (d.guestName || d.phone || d.notes || d.confirmedBy)) return d;
    } catch {}
    return null;
  }

  function setMobileChannel(chKey, { customText = null, tourName = null } = {}) {
    mState.bookingChannelKey = chKey;
    $("m-f-channels").querySelectorAll(".m-chip").forEach((c) => c.classList.toggle("active", c.dataset.mCh === chKey));
    $("m-wrap-custom-source").style.display = chKey === "other" ? "flex" : "none";
    $("m-wrap-tour-name").style.display = (chKey === "tour" || chKey === "zalo") ? "flex" : "none";
    $("m-f-booking-code").placeholder = CODE_PLACEHOLDERS[chKey] || "Nhập mã đặt phòng";
    if (customText !== null) $("m-f-source-custom").value = customText;
    if (tourName !== null) $("m-f-tour-name").value = tourName;
  }

  function setMobilePayTab(payStatus, syncPaid) {
    mState.bookingPayStatus = payStatus;
    document.querySelectorAll("[data-m-pay]").forEach((t) => t.classList.toggle("active", t.dataset.mPay === payStatus));
    if (syncPaid) {
      const total = parseVND($("m-f-total").value);
      if (payStatus === "paid") $("m-f-paid").value = formatNumberInput(total);
      else if (payStatus === "unpaid") $("m-f-paid").value = "";
    }
    updateMobilePaymentPreview();
  }

  function syncMobileVatDisplay() {
    const includeVat = $("m-f-include-vat").checked;
    const total = parseVND($("m-f-total").value);
    const preVat = includeVat ? Math.min(total, parseVND($("m-f-pre-vat").value)) : total;
    const vatAmt = includeVat ? Math.max(0, total - preVat) : 0;
    $("m-vat-box").classList.toggle("active", includeVat);
    $("m-vat-badge").style.display = includeVat ? "inline-flex" : "none";
    $("m-vat-breakdown").style.display = includeVat ? "flex" : "none";
    $("m-vat-amount-display").textContent = formatVND(vatAmt);
    $("m-vat-total-display").textContent = formatVND(total);
  }

  function handleMobileVatToggle() {
    const includeVat = $("m-f-include-vat").checked;
    const wasPaidFull = mState.bookingPayStatus === "paid";
    if (includeVat) {
      const currentTotal = parseVND($("m-f-total").value);
      const calc = calculateVatBreakdown(currentTotal, true);
      $("m-f-pre-vat").value = formatNumberInput(calc.preVatAmount);
      $("m-f-total").value = formatNumberInput(calc.totalAmount);
      if (wasPaidFull) $("m-f-paid").value = formatNumberInput(calc.totalAmount);
    } else {
      const base = parseVND($("m-f-pre-vat").value) || extractPreVatFromTotal($("m-f-total").value).preVatAmount;
      $("m-f-total").value = formatNumberInput(base);
      $("m-f-pre-vat").value = "";
      if (wasPaidFull) $("m-f-paid").value = formatNumberInput(base);
    }
    syncMobileVatDisplay();
    updateMobilePaymentPreview();
    saveMobileDraft();
  }

  function updateMobilePaymentPreview() {
    const total = parseVND($("m-f-total").value);
    const paid = parseVND($("m-f-paid").value);
    const remEl = $("m-f-remaining");
    if (total > 0 && paid > total) {
      remEl.textContent = `Vượt tổng ${formatVND(paid - total)}!`;
      remEl.className = "balance-amount owing";
    } else {
      const rem = Math.max(0, total - paid);
      remEl.textContent = formatVND(rem);
      remEl.className = `balance-amount ${rem > 0 ? "owing" : "settled"}`;
    }
    mState.bookingPayStatus = total > 0 && paid >= total ? "paid" : paid > 0 ? "deposit" : "unpaid";
    document.querySelectorAll("[data-m-pay]").forEach((t) => t.classList.toggle("active", t.dataset.mPay === mState.bookingPayStatus));
    syncMobileVatDisplay();
  }

  function updateMobileRoomFields() {
    const room = getRoomById($("m-f-room").value);
    if (!room) return;
    const isTwins = room.type === "Twins";
    $("m-f-merge-bed").disabled = !isTwins;
    $("m-wrap-merge").classList.toggle("disabled", !isTwins);
    if (!isTwins) {
      $("m-f-merge-bed").checked = false;
      $("m-merge-hint").textContent = "Chỉ áp dụng cho phòng Twins";
    } else {
      $("m-merge-hint").textContent = "Ghép 2 giường đơn thành 1 giường đôi";
    }
    $("m-bk-sheet-sub").textContent = `Phòng ${room.name} • ${room.type} • ${room.view}`;
  }

  function updateMobileNights() {
    const ci = $("m-f-checkin").value;
    const co = $("m-f-checkout").value;
    if (ci && co) {
      const n = diffNights(ci, co);
      $("m-f-nights").value = Number.isFinite(n) && n > 0 ? `${n} đêm` : "Ngày không hợp lệ";
    }
  }

  function showMobileBookingError(msg) {
    $("m-bk-error").textContent = msg || "";
    $("m-bk-error").classList.toggle("show", Boolean(msg));
  }

  function setMobileConfirmerSelect(selectEl, val) {
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

  function autofillMobileFormFromGroup(summary, { force = false } = {}) {
    if (!summary || !summary.bookings || summary.bookings.length === 0) return false;
    const lead = summary.bookings.find((b) => b.roomId !== "DORM") || summary.bookings[0];
    if (!lead) return false;
    if (!force && $("m-f-guest-name").value.trim()) return false;

    const chKey = lead.channelKey || detectChannelKey(lead.sourceName);
    const inferredTour = lead.tourName !== undefined ? lead.tourName : ((chKey === "tour" || chKey === "zalo") ? String(lead.sourceName || "").replace(/^(?:Tour|Gmail|Zalo)\s*/i, "") : "");
    setMobileChannel(chKey, {
      customText: chKey === "other" ? (lead.sourceName || "") : "",
      tourName: inferredTour
    });
    $("m-f-guest-name").value = lead.guestName || "";
    $("m-f-phone").value = lead.phone || "";
    if (force || !$("m-f-total").value.trim()) {
      $("m-f-total").value = formatNumberInput(lead.totalAmount);
      $("m-f-include-vat").checked = Boolean(lead.includeVat);
      $("m-f-pre-vat").value = lead.includeVat
        ? formatNumberInput(lead.preVatAmount || extractPreVatFromTotal(lead.totalAmount).preVatAmount)
        : "";
    }
    setMobileConfirmerSelect($("m-f-confirmed-by"), lead.confirmedBy || "");
    if (lead.confirmationPdf && lead.confirmationPdf.dataUrl) {
      mState.bookingConfirmationPdf = { ...lead.confirmationPdf };
      syncMobilePdfUI("m-", mState.bookingConfirmationPdf);
    }
    if (force || !$("m-f-notes").value.trim()) {
      $("m-f-notes").value = lead.notes || "";
    }
    updateMobilePaymentPreview();
    saveMobileDraft();
    return true;
  }

  function renderMobileModalGroupSummary() {
    const box = $("m-group-summary-box");
    if (!box) return;
    const code = ($("m-f-booking-code").value || "").trim();
    const norm = normalizeGroupCode(code);
    const currentId = mState.editingBookingId || "";
    const origNorm = mState.editingOriginalBooking ? normalizeGroupCode(mState.editingOriginalBooking.bookingCode) : "";

    let summary = norm ? computeBookingGroupSummary(getBookings(), norm) : null;
    const origSummary = (currentId && origNorm && origNorm !== norm) ? computeBookingGroupSummary(getBookings(), origNorm) : null;
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

    if (isJoiningNew && mState.lastAutofilledGroupCode !== summary.normalizedCode) {
      if (autofillMobileFormFromGroup(summary, { force: false })) {
        mState.lastAutofilledGroupCode = summary.normalizedCode;
        showMobileToast(`⚡ Đã tự động điền thông tin từ đoàn ${summary.code}`);
      }
    }

    box.style.display = "flex";
    $("m-group-title").textContent = isJoiningNew
      ? `👥 Đang ghép vào đoàn ${summary.code}`
      : isRenamingGroup
        ? `👥 Đổi mã cả đoàn → ${code}`
        : `👥 Tổng hợp đoàn ${summary.code}`;
    $("m-group-count").textContent = `${summary.roomCount}P • ${summary.totalNights} đêm`;

    $("m-group-rooms").innerHTML = summary.bookings.map((b) => {
      const lbl = b.roomId === "DORM" ? `Dorm(${(b.slots || []).join(",")})` : `P.${getRoomById(b.roomId)?.name || b.roomId}`;
      const isCur = b.id === currentId;
      const amt = parseVND(b.totalAmount);
      return `<button type="button" class="m-group-room-tag ${isCur ? "current" : ""}" data-m-jump-bk="${escapeHtml(b.id)}">${escapeHtml(lbl)} • ${amt > 0 ? formatShortVND(amt) : "0đ"}</button>`;
    }).join("");

    const syncWrap = $("m-group-sync-wrap");
    const syncLabel = $("m-group-sync-label");
    if (syncWrap && syncLabel) {
      const showSync = Boolean(currentId && siblingCount >= 1);
      syncWrap.style.display = showSync ? "flex" : "none";
      if (showSync) {
        syncLabel.textContent = `Tự động cập nhật thông tin sửa (tên khách, SĐT, nguồn, mã ĐP, người XN, PDF, ghi chú) cho cả ${siblingCount} phòng khác cùng mã đoàn khi Lưu`;
      }
    }

    const autofillWrap = $("m-group-autofill-wrap");
    if (autofillWrap) {
      autofillWrap.style.display = isJoiningNew ? "block" : "none";
    }

    $("m-group-total").textContent = formatVND(summary.totalAmount);
    $("m-group-paid").textContent = formatVND(summary.paidAmount);
    $("m-group-remaining").textContent = formatVND(summary.remaining);
    $("m-group-remaining").className = summary.remaining > 0 ? "warn" : "ok";

    const lumpWrap = $("m-group-lump-wrap");
    if (lumpWrap) lumpWrap.style.display = (isMultiSaved && !isRenamingGroup) ? "flex" : "none";
    if (isMultiSaved && !isRenamingGroup) {
      $("m-group-lump-input").value = summary.paidAmount > 0 ? formatNumberInput(summary.paidAmount) : "";
      $("m-btn-group-mark-paid").disabled = summary.remaining <= 0;
    }
  }

  function renderMobileBookingOperationalBars(roomId, bookingObj) {
    const warnEl = $("m-room-issue-warning");
    const coBar = $("m-checkout-bar");
    const coStatus = $("m-checkout-status");
    const coBtn = $("m-btn-checkout-booking");
    const stayBtn = $("m-btn-request-stayover");

    if (warnEl) {
      const ops = computeRoomOperationalStatus(
        roomId,
        typeof client.getHousekeepingTasks === "function" ? client.getHousekeepingTasks() : [],
        typeof client.getMaintenanceIssues === "function" ? client.getMaintenanceIssues() : [],
        getTodayISO()
      );
      if (ops && ops.activeIssues.length > 0) {
        const lines = ops.activeIssues.map((iss) => {
          const stLbl = (ISSUE_STATUSES[iss.status] || ISSUE_STATUSES.open).label;
          const blk = iss.blocksRoom ? "<strong>[Chưa thể giao khách]</strong> " : "";
          return `<div>• ${blk}${escapeHtml(iss.description)} (${escapeHtml(stLbl)})</div>`;
        }).join("");
        warnEl.innerHTML = `<div style="display:flex; flex-direction:column; gap:4px;">
          <div>${ops.isBlocked ? `🚫 CẢNH BÁO P.${escapeHtml(getRoomById(roomId)?.name || roomId)} CHƯA THỂ GIAO KHÁCH` : `⚠️ P.${escapeHtml(getRoomById(roomId)?.name || roomId)} có sự cố đang mở`}</div>
          <div style="font-weight:600;">${lines}</div>
          <button type="button" class="m-btn" style="min-height:34px; font-size:12px; align-self:flex-start;" data-m-jump-issues="${escapeHtml(roomId)}">Xem sự cố ›</button>
        </div>`;
        warnEl.style.display = "block";
      } else {
        warnEl.innerHTML = "";
        warnEl.style.display = "none";
      }
    }

    if (coBar && coStatus && coBtn && stayBtn) {
      if (bookingObj && bookingObj.id && bookingObj.roomId !== "DORM" && mCan("bookings:checkout")) {
        coBar.style.display = "flex";
        if (bookingObj.checkedOutAt) {
          coStatus.innerHTML = `<span style="color:var(--status-paid);">✓ Đã trả phòng lúc ${escapeHtml(formatDateTimeVN(bookingObj.checkedOutAt))}</span> • Đã tạo việc dọn phòng`;
          coBtn.textContent = "✓ Đã Check-out";
          coBtn.classList.remove("m-btn-primary");
          coBtn.classList.add("m-btn-success");
        } else {
          coStatus.textContent = "Khách đang ở / chưa check-out phòng này";
          coBtn.textContent = "🚪 Check-out phòng";
          coBtn.classList.add("m-btn-primary");
          coBtn.classList.remove("m-btn-success");
        }
        stayBtn.style.display = mCan("housekeeping:create") ? "inline-flex" : "none";
      } else {
        coBar.style.display = "none";
      }
    }
  }

  function openMobileBookingSheet({ bookingId = null, roomId = "101", checkin = mState.selectedDate, checkout = null, prefill = null, allowRoomSelect = false } = {}) {
    if (!mCan("bookings:read")) {
      showMobileToast("Tài khoản của bạn không có quyền xem hoặc sửa đặt phòng.");
      return;
    }
    mState.savedScrollTop = $("m-main").scrollTop;
    showMobileBookingError("");
    mState.bookingConflictBooking = null;
    $("m-bk-conflict-banner").classList.remove("show");
    mState.lastAutofilledGroupCode = "";
    if ($("chk-m-sync-group")) $("chk-m-sync-group").checked = true;

    const existing = bookingId ? getBookings().find((b) => b.id === bookingId) : null;
    if (existing && existing.roomId === "DORM") {
      return openDormSheet(existing.checkin, existing.id);
    }

    mState.bookingIdempotencyKey = newIdemKey("mbk");
    $("m-wrap-room").style.display = (allowRoomSelect && !existing) ? "flex" : "none";

    if (existing) {
      mState.editingBookingId = existing.id;
      mState.editingBookingRevision = Number(existing.revision) || 1;
      mState.editingOriginalBooking = {
        ...existing,
        confirmationPdf: existing.confirmationPdf ? { ...existing.confirmationPdf } : null
      };
      $("m-bk-sheet-title").textContent = `Sửa đơn — P.${getRoomById(existing.roomId)?.name || existing.roomId}`;
      $("m-f-room").value = existing.roomId;
      $("m-f-booking-date").value = existing.bookingDate || (typeof existing.createdAt === "string" && existing.createdAt.length >= 10 ? existing.createdAt.slice(0, 10) : getTodayISO());
      $("m-f-checkin").value = existing.checkin;
      $("m-f-checkout").value = existing.checkout;
      const chKey = existing.channelKey || detectChannelKey(existing.sourceName);
      const inferredTour = existing.tourName !== undefined ? existing.tourName : ((chKey === "tour" || chKey === "zalo") ? String(existing.sourceName || "").replace(/^(?:Tour|Gmail|Zalo)\s*/i, "") : "");
      setMobileChannel(chKey, { customText: chKey === "other" ? (existing.sourceName || "") : "", tourName: inferredTour });
      $("m-f-booking-code").value = existing.bookingCode || "";
      $("m-f-guest-name").value = existing.guestName || "";
      $("m-f-phone").value = existing.phone || "";
      $("m-f-guests").value = existing.guestCount || 2;
      $("m-f-total").value = formatNumberInput(existing.totalAmount);
      $("m-f-include-vat").checked = Boolean(existing.includeVat);
      $("m-f-pre-vat").value = existing.includeVat
        ? formatNumberInput(existing.preVatAmount || extractPreVatFromTotal(existing.totalAmount).preVatAmount)
        : "";
      $("m-f-paid").value = formatNumberInput(existing.paidAmount);
      $("m-f-merge-bed").checked = Boolean(existing.mergeBed);
      $("m-f-extra-bed").value = String(existing.extraBed || 0);
      setMobileConfirmerSelect($("m-f-confirmed-by"), existing.confirmedBy);
      mState.bookingConfirmationPdf = existing.confirmationPdf ? { ...existing.confirmationPdf } : null;
      syncMobilePdfUI("m-", mState.bookingConfirmationPdf);
      $("m-f-notes").value = existing.notes || "";
      $("m-bk-delete").style.display = "inline-flex";
      $("m-bk-copy").style.display = "inline-flex";
      $("m-bk-mark-paid").style.display = getRemaining(existing) > 0 ? "inline-flex" : "none";
    } else {
      mState.editingBookingId = null;
      mState.editingBookingRevision = null;
      mState.editingOriginalBooking = null;
      const room = getRoomById(roomId) || ROOMS[0];
      const draft = prefill || loadMobileDraftFor(room.id, checkin);
      $("m-bk-sheet-title").textContent = prefill ? `Dán phòng — P.${room.name}` : `Đặt phòng mới — P.${room.name}`;
      $("m-f-room").value = room.id;
      $("m-f-booking-date").value = (draft && draft.bookingDate) || getTodayISO();
      $("m-f-checkin").value = (prefill && prefill.checkin) || checkin;
      $("m-f-checkout").value = (draft && draft.checkout) || checkout || addDaysISO(checkin, 1);
      const chKey = (draft && draft.channelKey) || "booking";
      setMobileChannel(chKey, {
        customText: (draft && (draft.sourceCustom || (chKey === "other" ? draft.sourceName : ""))) || "",
        tourName: (draft && draft.tourName) || ""
      });
      $("m-f-booking-code").value = (draft && draft.bookingCode) || "";
      $("m-f-guest-name").value = (draft && draft.guestName) || "";
      $("m-f-phone").value = (draft && draft.phone) || "";
      $("m-f-guests").value = (draft && draft.guestCount) || room.defaultGuests;
      $("m-f-total").value = prefill ? formatNumberInput(prefill.totalAmount) : ((draft && draft.totalAmount) || "");
      const initVat = Boolean(draft && draft.includeVat);
      $("m-f-include-vat").checked = initVat;
      $("m-f-pre-vat").value = initVat
        ? (prefill ? formatNumberInput(prefill.preVatAmount || extractPreVatFromTotal(prefill.totalAmount).preVatAmount) : (draft.preVatAmount || ""))
        : "";
      $("m-f-paid").value = prefill ? formatNumberInput(prefill.paidAmount) : ((draft && draft.paidAmount) || "");
      $("m-f-merge-bed").checked = Boolean(draft && draft.mergeBed);
      $("m-f-extra-bed").value = String((draft && draft.extraBed) || "0");
      setMobileConfirmerSelect($("m-f-confirmed-by"), (draft && draft.confirmedBy) || "");
      mState.bookingConfirmationPdf = (prefill && prefill.confirmationPdf) ? { ...prefill.confirmationPdf } : null;
      syncMobilePdfUI("m-", mState.bookingConfirmationPdf);
      $("m-f-notes").value = (draft && draft.notes) || "";
      $("m-bk-delete").style.display = "none";
      $("m-bk-copy").style.display = "none";
      $("m-bk-mark-paid").style.display = "none";
      if (!prefill && draft) showMobileToast("Đã khôi phục nội dung đang nhập dở");
    }

    updateMobileRoomFields();
    updateMobileNights();
    updateMobilePaymentPreview();
    renderMobileModalGroupSummary();
    renderMobileBookingOperationalBars($("m-f-room").value, existing || null);
    $("m-sheet-booking").classList.add("open");
  }

  function syncMobilePdfUI(prefix, pdfObj) {
    const legacyBtn = $(`${prefix}btn-view-legacy-pdf`);
    if (!legacyBtn) return;
    if (pdfObj && pdfObj.dataUrl) {
      legacyBtn.style.display = "inline-flex";
      legacyBtn.title = `Xem file PDF cũ đã đính kèm: ${pdfObj.name || "xac-nhan.pdf"} (${formatFileSize(pdfObj.size || 0)})`;
    } else {
      legacyBtn.style.display = "none";
      legacyBtn.title = "Xem file PDF cũ đã đính kèm";
    }
  }

  function collectLiveMobileRegularDraftBooking() {
    const chKey = mState.bookingChannelKey;
    const chObj = CHANNELS.find((c) => c.key === chKey);
    const tourName = (chKey === "tour" || chKey === "zalo") ? $("m-f-tour-name").value.trim() : "";
    let sourceName = chObj ? chObj.label : "";
    if (chKey === "other") sourceName = $("m-f-source-custom").value.trim() || "Khác";
    else if (chKey === "tour") sourceName = tourName ? `Gmail ${tourName}` : "Gmail";
    else if (chKey === "zalo") sourceName = tourName ? `Zalo ${tourName}` : "Zalo";

    const includeVat = $("m-f-include-vat").checked;
    const checkin = $("m-f-checkin").value || getTodayISO();
    const checkout = $("m-f-checkout").value || addDaysISO(checkin, 1);

    return {
      id: mState.editingBookingId || undefined,
      roomId: $("m-f-room").value || ROOMS[0].id,
      bookingDate: $("m-f-booking-date").value || getTodayISO(),
      checkin,
      checkout,
      channelKey: chKey,
      sourceName,
      tourName,
      bookingCode: $("m-f-booking-code").value.trim(),
      guestName: $("m-f-guest-name").value.trim(),
      phone: $("m-f-phone").value.trim(),
      guestCount: parseInt($("m-f-guests").value, 10) || 2,
      totalAmount: parseVND($("m-f-total").value),
      includeVat,
      preVatAmount: includeVat ? parseVND($("m-f-pre-vat").value) : parseVND($("m-f-total").value),
      paidAmount: parseVND($("m-f-paid").value),
      paymentStatus: mState.bookingPayStatus,
      mergeBed: $("m-f-merge-bed").checked,
      extraBed: parseInt($("m-f-extra-bed").value, 10) || 0,
      confirmedBy: $("m-f-confirmed-by").value,
      notes: $("m-f-notes").value
    };
  }

  function collectLiveMobileDormDraftBooking() {
    const chKey = $("m-df-source").value;
    const tourOrCustom = $("m-df-tour").value.trim();
    let sourceName = "Dorm nội bộ", tourName = "";
    if (chKey === "tour") { tourName = tourOrCustom; sourceName = tourOrCustom ? `Gmail ${tourOrCustom}` : "Gmail"; }
    else if (chKey === "walkin") sourceName = "Nội bộ / Khách lẻ";
    else if (chKey === "zalo") { tourName = tourOrCustom; sourceName = tourOrCustom ? `Zalo ${tourOrCustom}` : "Zalo"; }
    else sourceName = tourOrCustom || "Nguồn khác";

    const checkin = $("m-df-checkin").value || mState.dormDateISO || getTodayISO();
    const checkout = $("m-df-checkout").value || addDaysISO(checkin, 1);
    const slots = mState.dormSelectedSlots && mState.dormSelectedSlots.length > 0 ? [...mState.dormSelectedSlots] : [1];

    return {
      id: mState.editingDormId || undefined,
      roomId: "DORM",
      bookingDate: $("m-df-booking-date").value || getTodayISO(),
      checkin,
      checkout,
      channelKey: chKey,
      sourceName,
      tourName,
      bookingCode: $("m-df-code").value.trim(),
      guestName: $("m-df-guest").value.trim(),
      phone: $("m-df-phone").value.trim(),
      slots,
      dormBeds: slots.length,
      guestCount: slots.length,
      totalAmount: parseVND($("m-df-total").value),
      includeVat: false,
      preVatAmount: parseVND($("m-df-total").value),
      paidAmount: parseVND($("m-df-paid").value),
      confirmedBy: $("m-df-confirmed-by").value,
      notes: $("m-df-notes").value
    };
  }

  async function handleMobileSaveBooking(e) {
    e.preventDefault();
    if (mState.isSubmitting) return;
    mState.isSubmitting = true;
    $("m-bk-save").disabled = true;

    try {
      showMobileBookingError("");
      const existingId = mState.editingBookingId || undefined;
      const previousBooking = existingId ? mState.editingOriginalBooking : null;
      const shouldSyncGroup = Boolean(existingId && (!$("chk-m-sync-group") || $("chk-m-sync-group").checked));
      const chKey = mState.bookingChannelKey;
      const chObj = CHANNELS.find((c) => c.key === chKey);
      const tourName = (chKey === "tour" || chKey === "zalo") ? $("m-f-tour-name").value.trim() : "";
      let sourceName = chObj ? chObj.label : "";
      if (chKey === "other") {
        sourceName = $("m-f-source-custom").value.trim();
        if (!sourceName) {
          showMobileBookingError("Vui lòng nhập tên nền tảng / đơn vị book.");
          return;
        }
      } else if (chKey === "tour") {
        sourceName = tourName ? `Gmail ${tourName}` : "Gmail";
      } else if (chKey === "zalo") {
        sourceName = tourName ? `Zalo ${tourName}` : "Zalo";
      }

      const payload = {
        id: existingId,
        roomId: $("m-f-room").value,
        bookingDate: $("m-f-booking-date").value || getTodayISO(),
        checkin: $("m-f-checkin").value,
        checkout: $("m-f-checkout").value,
        channelKey: chKey,
        sourceName,
        tourName,
        bookingCode: $("m-f-booking-code").value.trim(),
        guestName: $("m-f-guest-name").value.trim(),
        phone: $("m-f-phone").value.trim(),
        guestCount: $("m-f-guests").value,
        totalAmount: $("m-f-total").value,
        includeVat: $("m-f-include-vat").checked,
        preVatAmount: $("m-f-include-vat").checked ? $("m-f-pre-vat").value : $("m-f-total").value,
        paidAmount: $("m-f-paid").value,
        paymentStatus: mState.bookingPayStatus,
        mergeBed: $("m-f-merge-bed").checked,
        extraBed: $("m-f-extra-bed").value,
        confirmedBy: $("m-f-confirmed-by").value,
        confirmationPdf: mState.bookingConfirmationPdf,
        notes: $("m-f-notes").value
      };

      const res = await client.saveBooking(payload, {
        expectedRevision: existingId ? mState.editingBookingRevision : undefined,
        idempotencyKey: existingId ? undefined : mState.bookingIdempotencyKey
      });

      if (!res.ok) {
        showMobileBookingError(res.error);
        if (res.code === "CONFLICT_STALE_EDIT" && res.currentBooking) {
          showBookingConflictBanner(res.currentBooking);
        }
        // Keep typed inputs and idempotencyKey intact on offline/conflict!
        return;
      }

      // Propagate edited shared group info to ALL sibling rooms sharing this bookingCode
      let syncedSiblings = 0;
      let failedSiblings = 0;
      if (shouldSyncGroup && res.booking) {
        const sibUpdates = buildGroupSyncUpdates(previousBooking, res.booking, getBookings());
        for (const upd of sibUpdates) {
          let sibRes = await client.saveBooking(upd.payload, { expectedRevision: upd.expectedRevision });
          if (!sibRes.ok && sibRes.code === "CONFLICT_STALE_EDIT") {
            const latestSib = getBookings().find((b) => b.id === upd.id);
            if (latestSib) {
              const retryUpd = buildGroupSyncUpdates(previousBooking, res.booking, [latestSib])[0];
              if (retryUpd) {
                sibRes = await client.saveBooking(retryUpd.payload, { expectedRevision: Number(latestSib.revision) || 1 });
              }
            }
          }
          if (sibRes.ok) syncedSiblings += 1;
          else failedSiblings += 1;
        }
      }

      clearMobileDraft();
      $("m-sheet-booking").classList.remove("open");
      renderMobileAll();
      if ($("m-sheet-room").classList.contains("open")) renderRoomDetailSheet();
      restoreScrollPosition();
      const r = getRoomById(res.booking.roomId);
      if (syncedSiblings > 0 && failedSiblings > 0) {
        showMobileToast(`Đã lưu P.${r ? r.name : res.booking.roomId} & đồng bộ ${syncedSiblings} phòng (${failedSiblings} phòng cần kiểm tra lại)`);
      } else if (syncedSiblings > 0) {
        showMobileToast(`Đã lưu P.${r ? r.name : res.booking.roomId} & đồng bộ ${syncedSiblings} phòng cùng đoàn`);
      } else {
        showMobileToast(res.isUpdate ? `Đã lưu cập nhật P.${r ? r.name : res.booking.roomId}` : `Đã đặt P.${r ? r.name : res.booking.roomId} cho ${res.booking.guestName}`);
      }
    } finally {
      mState.isSubmitting = false;
      $("m-bk-save").disabled = false;
      if (typeof client.notifyIdleCheck === "function") client.notifyIdleCheck();
    }
  }

  function showBookingConflictBanner(latestBooking) {
    mState.bookingConflictBooking = latestBooking;
    const totalNum = parseVND($("m-f-total").value);
    const incVat = $("m-f-include-vat").checked;
    const preVatNum = incVat ? Math.min(totalNum, parseVND($("m-f-pre-vat").value)) : totalNum;
    const draftSnapshot = {
      roomId: $("m-f-room").value,
      checkin: $("m-f-checkin").value,
      checkout: $("m-f-checkout").value,
      sourceName: $("m-f-source-custom").value || (CHANNELS.find((c) => c.key === mState.bookingChannelKey)?.label || ""),
      tourName: $("m-f-tour-name").value,
      bookingCode: $("m-f-booking-code").value,
      guestName: $("m-f-guest-name").value,
      phone: $("m-f-phone").value,
      guestCount: Number($("m-f-guests").value) || 2,
      totalAmount: totalNum,
      includeVat: incVat,
      preVatAmount: preVatNum,
      vatAmount: incVat ? Math.max(0, totalNum - preVatNum) : 0,
      paidAmount: parseVND($("m-f-paid").value),
      mergeBed: $("m-f-merge-bed").checked,
      extraBed: Number($("m-f-extra-bed").value) || 0,
      confirmedBy: $("m-f-confirmed-by").value,
      notes: $("m-f-notes").value
    };
    const diffs = diffBookingChanges(draftSnapshot, latestBooking);
    $("m-bk-conflict-text").textContent = "⚠️ Thiết bị khác vừa cập nhật đơn này! Nội dung bạn đang gõ vẫn được giữ nguyên để đối chiếu.";
    $("m-bk-conflict-diff").innerHTML = diffs.length > 0
      ? `<strong>Bản mới trên máy chủ:</strong> ` + diffs.map((d) => `${escapeHtml(d.field)}: <strong>${escapeHtml(d.after)}</strong>`).join(" • ")
      : `<strong>Phiên bản máy chủ mới:</strong> rev ${latestBooking.revision} (${formatVND(latestBooking.paidAmount)} / ${formatVND(latestBooking.totalAmount)})`;
    $("m-bk-conflict-banner").classList.add("show");
  }

  /* -------------------- Sheet 3: Mobile Dorm 8-Slot 2-Col Board & Form -------------------- */

  function setDormSheetMode(mode) {
    mState.dormMode = mode;
    const isForm = mode === "form";
    $("m-dorm-board-pane").style.display = isForm ? "none" : "flex";
    $("m-dorm-form-pane").style.display = isForm ? "flex" : "none";
    $("m-dorm-footer-board").style.display = isForm ? "none" : "flex";
    $("m-dorm-footer-form").style.display = isForm ? "flex" : "none";
    $("m-dorm-delete").style.display = (isForm && mState.editingDormId) ? "inline-flex" : "none";
  }

  function renderMobileDormBoard() {
    const dateISO = mState.dormDate;
    const { map: slotMap } = getDormSlotMapForDate(getBookings(), dateISO);
    const used = Object.keys(slotMap).length;
    const free = Math.max(0, 8 - used);

    $("m-dorm-date-label").textContent = formatFullDateLabel(dateISO);
    $("m-dorm-cap-label").textContent = `Còn trống ${free}/8 slot (đã đặt ${used})`;
    $("m-dorm-cap-label").style.color = free === 0 ? "var(--status-unpaid)" : "var(--status-paid)";

    $("m-dorm-grid").innerHTML = DORM_SLOTS.map((s) => {
      const bk = slotMap[s.slot];
      if (!bk) {
        return `<button type="button" class="m-dorm-slot free" data-m-dorm-book="${s.slot}">
          <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:800;">
            <span>${s.label}</span><span style="color:var(--status-paid);">+ Trống</span>
          </div>
          <div style="font-size:11px; color:var(--text-muted);">${s.bunk}</div>
        </button>`;
      }
      const rem = getRemaining(bk);
      return `<button type="button" class="m-dorm-slot occupied" data-m-dorm-edit="${escapeHtml(bk.id)}">
        <div style="display:flex; justify-content:space-between; font-size:12.5px; font-weight:800;">
          <span>${s.label}</span><span style="color:${rem > 0 ? "var(--status-unpaid)" : "var(--status-paid)"};">${rem > 0 ? `Nợ ${formatShortVND(rem)}` : "✓ Đủ"}</span>
        </div>
        <div style="font-size:13px; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(bk.guestName)}</div>
        <div style="font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(bk.sourceName)} • ${formatDateVN(bk.checkin)}→${formatDateVN(bk.checkout)}</div>
      </button>`;
    }).join("");
  }

  function renderMobileDormPicker() {
    const ci = $("m-df-checkin").value;
    const co = $("m-df-checkout").value;
    const occupied = (ci && co && diffNights(ci, co) > 0)
      ? getDormOccupiedSlotsInRange(getBookings(), ci, co, mState.editingDormId)
      : {};
    mState.dormSelectedSlots = mState.dormSelectedSlots.filter((s) => !occupied[s]);

    $("m-dorm-picker").innerHTML = DORM_SLOTS.map((s) => {
      const occ = occupied[s.slot];
      const sel = mState.dormSelectedSlots.includes(s.slot);
      if (occ) {
        return `<div class="m-dorm-slot conflict">
          <div style="font-size:12.5px; font-weight:800;">${s.label} • Xung đột</div>
          <div style="font-size:11px; color:#b91c1c; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Đã đặt: ${escapeHtml(occ.guestName)}</div>
        </div>`;
      }
      return `<button type="button" class="m-dorm-slot ${sel ? "selected" : "free"}" data-m-dorm-pick="${s.slot}">
        <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:800;">
          <span>${s.label}</span><span>${sel ? "☑" : "☐"}</span>
        </div>
        <div style="font-size:11px; color:var(--text-muted);">${s.bunk}</div>
      </button>`;
    }).join("");
  }

  function syncMobileDormFormUI() {
    const src = $("m-df-source").value;
    $("m-df-tour-wrap").style.display = (src === "tour" || src === "zalo" || src === "other") ? "flex" : "none";
    $("m-df-tour").placeholder = src === "other" ? "Nhập tên đơn vị / nguồn..." : "VD: Vietravel, Saigontourist...";
    const total = parseVND($("m-df-total").value);
    const paid = parseVND($("m-df-paid").value);
    const remEl = $("m-df-remaining");
    if (total > 0 && paid > total) {
      remEl.textContent = `Vượt tổng ${formatVND(paid - total)}!`;
      remEl.className = "balance-amount owing";
    } else {
      const rem = Math.max(0, total - paid);
      remEl.textContent = total === 0 ? "0 đ (Miễn phí nội bộ)" : formatVND(rem);
      remEl.className = `balance-amount ${rem > 0 ? "owing" : "settled"}`;
    }
  }

  function openDormSheet(dateISO, editBookingId = null, preselectSlot = null) {
    mState.savedScrollTop = $("m-main").scrollTop;
    mState.dormDate = dateISO || mState.selectedDate || getTodayISO();
    $("m-dorm-error").classList.remove("show");
    $("m-dorm-conflict-banner").classList.remove("show");
    mState.dormConflictBooking = null;

    if (editBookingId || preselectSlot) {
      openMobileDormForm({ bookingId: editBookingId, preselectSlot });
    } else {
      setDormSheetMode("board");
      renderMobileDormBoard();
    }
    $("m-sheet-dorm").classList.add("open");
  }

  function openMobileDormForm({ bookingId = null, preselectSlot = null } = {}) {
    $("m-dorm-error").classList.remove("show");
    $("m-dorm-conflict-banner").classList.remove("show");
    mState.dormIdempotencyKey = newIdemKey("mdorm");
    const ex = bookingId ? getBookings().find((b) => b.id === bookingId) : null;

    if (ex) {
      mState.editingDormId = ex.id;
      mState.editingDormRevision = Number(ex.revision) || 1;
      mState.dormDate = ex.checkin;
      $("m-df-booking-date").value = ex.bookingDate || (typeof ex.createdAt === "string" && ex.createdAt.length >= 10 ? ex.createdAt.slice(0, 10) : getTodayISO());
      $("m-df-checkin").value = ex.checkin;
      $("m-df-checkout").value = ex.checkout;
      mState.dormSelectedSlots = [...(ex.slots || [1])];
      const srcKey = ["tour", "walkin", "zalo", "other"].includes(ex.channelKey) ? ex.channelKey : "tour";
      $("m-df-source").value = srcKey;
      $("m-df-tour").value = ex.tourName || (srcKey === "other" ? ex.sourceName : String(ex.sourceName || "").replace(/^(?:Tour|Gmail|Zalo)\s*/i, ""));
      $("m-df-code").value = ex.bookingCode || "";
      $("m-df-guest").value = ex.guestName || "";
      $("m-df-phone").value = ex.phone || "";
      $("m-df-total").value = formatNumberInput(ex.totalAmount);
      $("m-df-paid").value = formatNumberInput(ex.paidAmount);
      setMobileConfirmerSelect($("m-df-confirmed-by"), ex.confirmedBy);
      mState.dormConfirmationPdf = ex.confirmationPdf ? { ...ex.confirmationPdf } : null;
      syncMobilePdfUI("m-dorm-", mState.dormConfirmationPdf);
      $("m-df-notes").value = ex.notes || "";
    } else {
      mState.editingDormId = null;
      mState.editingDormRevision = null;
      const ci = mState.dormDate;
      const co = mState.rangeActive ? mState.rangeCheckout : addDaysISO(ci, 1);
      $("m-df-booking-date").value = getTodayISO();
      $("m-df-checkin").value = ci;
      $("m-df-checkout").value = co;
      const occ = getDormOccupiedSlotsInRange(getBookings(), ci, co, null);
      if (preselectSlot && !occ[preselectSlot]) mState.dormSelectedSlots = [preselectSlot];
      else {
        const free = DORM_SLOTS.find((s) => !occ[s.slot]);
        mState.dormSelectedSlots = free ? [free.slot] : [];
      }
      $("m-df-source").value = "tour";
      $("m-df-tour").value = "";
      $("m-df-code").value = "";
      $("m-df-guest").value = "";
      $("m-df-phone").value = "";
      $("m-df-total").value = "";
      $("m-df-paid").value = "";
      setMobileConfirmerSelect($("m-df-confirmed-by"), "");
      mState.dormConfirmationPdf = null;
      syncMobilePdfUI("m-dorm-", null);
      $("m-df-notes").value = "";
    }

    setDormSheetMode("form");
    syncMobileDormFormUI();
    renderMobileDormPicker();
  }

  async function handleMobileSaveDorm(e) {
    e.preventDefault();
    if (mState.isSubmitting) return;
    mState.isSubmitting = true;
    $("m-dorm-save").disabled = true;

    try {
      $("m-dorm-error").classList.remove("show");
      const chKey = $("m-df-source").value;
      const tourOrCustom = $("m-df-tour").value.trim();
      let sourceName = "Dorm nội bộ", tourName = "";
      if (chKey === "tour") { tourName = tourOrCustom; sourceName = tourOrCustom ? `Gmail ${tourOrCustom}` : "Gmail"; }
      else if (chKey === "walkin") sourceName = "Nội bộ / Khách lẻ";
      else if (chKey === "zalo") { tourName = tourOrCustom; sourceName = tourOrCustom ? `Zalo ${tourOrCustom}` : "Zalo"; }
      else sourceName = tourOrCustom || "Nguồn khác";

      const res = await client.saveBooking({
        id: mState.editingDormId || undefined,
        roomId: "DORM",
        bookingDate: $("m-df-booking-date").value || getTodayISO(),
        checkin: $("m-df-checkin").value,
        checkout: $("m-df-checkout").value,
        channelKey: chKey,
        sourceName,
        tourName,
        bookingCode: $("m-df-code").value.trim(),
        guestName: $("m-df-guest").value.trim(),
        phone: $("m-df-phone").value.trim(),
        slots: [...mState.dormSelectedSlots],
        totalAmount: $("m-df-total").value,
        paidAmount: $("m-df-paid").value,
        confirmedBy: $("m-df-confirmed-by").value,
        confirmationPdf: mState.dormConfirmationPdf,
        notes: $("m-df-notes").value
      }, {
        expectedRevision: mState.editingDormId ? mState.editingDormRevision : undefined,
        idempotencyKey: mState.editingDormId ? undefined : mState.dormIdempotencyKey
      });

      if (!res.ok) {
        $("m-dorm-error").textContent = res.error;
        $("m-dorm-error").classList.add("show");
        if (res.code === "CONFLICT_STALE_EDIT" && res.currentBooking) {
          mState.dormConflictBooking = res.currentBooking;
          $("m-dorm-conflict-banner").classList.add("show");
        }
        renderMobileDormPicker();
        return;
      }

      mState.dormDate = res.booking.checkin;
      setDormSheetMode("board");
      renderMobileDormBoard();
      renderMobileAll();
      showMobileToast(`Đã lưu Dorm Slot ${res.booking.slots.join(", ")} cho ${res.booking.guestName}`);
    } finally {
      mState.isSubmitting = false;
      $("m-dorm-save").disabled = false;
      if (typeof client.notifyIdleCheck === "function") client.notifyIdleCheck();
    }
  }

  /* -------------------- Sheet 4: Mobile Edit History & Auto-Backup -------------------- */

  function renderMobileHistorySheet() {
    const logs = client.getAuditLogs();
    const snapsById = new Map(client.getAutoBackups().map((s) => [s.id, s]));
    const q = mState.historySearch.trim().toLowerCase();

    const filtered = logs.filter((lg) => {
      if (mState.historyAction !== "all") {
        if (mState.historyAction === "RESTORE_GROUP") {
          if (!["RESTORE", "ROLLBACK", "AUTOBACKUP_RESTORE", "AUTO_RECOVER", "RESET_SAMPLE"].includes(lg.action)) return false;
        } else if (lg.action !== mState.historyAction) return false;
      }
      if (mState.historyConfirmer !== "all" && (lg.confirmedBy || "") !== mState.historyConfirmer) return false;
      if (q) {
        const diffs = Array.isArray(lg.changes) ? lg.changes.map((c) => `${c.field} ${c.before} ${c.after}`).join(" ") : "";
        const hay = `${lg.summary || ""} ${lg.guestName || ""} ${lg.roomId || ""} ${lg.confirmedBy || ""} ${diffs}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    $("m-hist-sub").textContent = `${filtered.length}/${logs.length} thao tác • ${snapsById.size} mốc sao lưu tự động`;

    $("m-hist-list").innerHTML = filtered.length === 0
      ? `<div class="m-section-card" style="text-align:center; color:var(--text-muted); padding:24px;">Chưa có lịch sử phù hợp.</div>`
      : filtered.map((lg) => {
        const hasSnap = Boolean(lg.snapshotId && snapsById.has(lg.snapshotId));
        const snap = hasSnap ? snapsById.get(lg.snapshotId) : null;
        const badgeCls = lg.action === "CREATE" ? "act-create" : lg.action === "UPDATE" ? "act-update" : lg.action === "DELETE" ? "act-delete" : "act-restore";
        const diffsHtml = Array.isArray(lg.changes) && lg.changes.length > 0
          ? `<div class="history-diffs">${lg.changes.map((c) => `<span class="diff-chip"><strong>${escapeHtml(c.field)}:</strong> <span class="diff-old">${escapeHtml(c.before)}</span> → <span class="diff-new">${escapeHtml(c.after)}</span></span>`).join("")}</div>`
          : "";
        return `<div class="history-card">
          <div class="history-card-head">
            <div class="history-meta">
              <span class="history-badge ${badgeCls}">${escapeHtml(lg.action)}</span>
              <span class="history-time">${escapeHtml(formatDateTimeVN(lg.ts))}</span>
              ${lg.confirmedBy ? `<span class="history-confirmer">✓ XN: ${escapeHtml(lg.confirmedBy)}</span>` : ""}
            </div>
          </div>
          <div class="history-summary">${escapeHtml(lg.summary || "")}</div>
          ${diffsHtml}
          ${hasSnap ? `<div class="m-card-actions" style="margin-top:4px;">
            <button type="button" class="m-btn m-btn-block" style="min-height:38px; font-size:12.5px;" data-m-restore-snap="${escapeHtml(lg.snapshotId)}">↺ Khôi phục mốc (${snap.count} đơn)</button>
          </div>` : ""}
        </div>`;
      }).join("");
  }

  /* -------------------- Master Render & Scroll Restoration -------------------- */

  function restoreScrollPosition() {
    requestAnimationFrame(() => {
      const main = $("m-main");
      if (main) main.scrollTop = mState.savedScrollTop;
    });
  }

  function isMobileViewActive() {
    const mode = document.body && document.body.dataset ? document.body.dataset.viewMode : "";
    if (mode === "mobile") return true;
    if (mode === "pc") return false;
    return window.innerWidth <= 768;
  }

  let mobileRenderDirty = false;
  let mobileRenderRafId = 0;

  function scheduleMobileRenderAll() {
    if (!isMobileViewActive()) {
      mobileRenderDirty = true;
      return;
    }
    if (mobileRenderRafId) return;
    mobileRenderRafId = requestAnimationFrame(() => {
      mobileRenderRafId = 0;
      renderMobileAll();
    });
  }

  function renderMobileAll() {
    if (!isMobileViewActive()) {
      mobileRenderDirty = true;
      return;
    }
    mobileRenderDirty = false;
    renderSyncStatus();
    updateMobileClipboardUI();
    if (mState.activeTab === "schedule") renderScheduleView();
    else if (mState.activeTab === "bookings") renderBookingsTab();
    else if (mState.activeTab === "report") renderReportTab();
    if ($("m-sheet-room").classList.contains("open")) renderRoomDetailSheet();
    if ($("m-sheet-booking").classList.contains("open")) renderMobileModalGroupSummary();
    if ($("m-sheet-dorm").classList.contains("open") && mState.dormMode === "board") renderMobileDormBoard();
    if ($("m-sheet-history").classList.contains("open")) renderMobileHistorySheet();
  }

  function switchTab(tabName) {
    mState.activeTab = tabName;
    if (tabName === "schedule") mState.activeNavKey = "calendar";
    document.querySelectorAll(".m-tab-view").forEach((v) => v.classList.remove("active"));
    const target = $(`m-view-${tabName}`);
    if (target) target.classList.add("active");
    document.querySelectorAll("[data-m-tab]").forEach((b) => b.classList.toggle("active", b.dataset.mTab === tabName));
    renderMobileAll();
  }

  /* -------------------- Event Binding & Realtime Subscription -------------------- */

  function populateMobileDropdowns() {
    $("m-f-room").innerHTML = ROOMS.filter((r) => !r.isDorm)
      .map((r) => `<option value="${r.id}">P.${r.name} — ${r.type} (${r.view})</option>`)
      .join("");
    $("m-f-channels").innerHTML = CHANNELS.map((c) => `<button type="button" class="m-chip" data-m-ch="${c.key}">${escapeHtml(c.label)}</button>`).join("");
    const confOpts = `<option value="">-- Chọn người xác nhận --</option>` +
      CONFIRMERS.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    $("m-f-confirmed-by").innerHTML = confOpts;
    $("m-df-confirmed-by").innerHTML = confOpts;
    $("m-hist-confirmer").innerHTML = `<option value="all">Mọi nhân viên</option>` +
      CONFIRMERS.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  }

  function bindMobileEvents() {
    // Mobile ☰ Navigation Drawer (shared NAV_CONFIG)
    $("m-btn-drawer-open").addEventListener("click", openMobileNavDrawer);
    $("m-btn-drawer-close").addEventListener("click", closeMobileNavDrawer);
    $("m-nav-backdrop").addEventListener("click", closeMobileNavDrawer);
    $("m-drawer-nav").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-m-nav-key]");
      if (!btn) return;
      handleMobileNavAction(btn.dataset.mNavKey);
    });
    $("m-drawer-theme").addEventListener("click", () => {
      $("m-menu-theme").click();
      renderMobileNavDrawer();
    });
    $("m-drawer-logout").addEventListener("click", () => {
      closeMobileNavDrawer();
      $("m-menu-logout").click();
    });

    // Schedule Primary "+ Đặt phòng" CTA & Contextual "Thao tác" menu
    const closeScheduleActions = () => {
      if ($("m-schedule-actions-menu")) $("m-schedule-actions-menu").classList.remove("open");
      if ($("m-btn-schedule-actions")) $("m-btn-schedule-actions").setAttribute("aria-expanded", "false");
    };
    $("m-btn-schedule-new-booking").addEventListener("click", () => {
      closeScheduleActions();
      openMobileBookingSheet({ checkin: mState.selectedDate || getTodayISO() });
    });
    $("m-btn-schedule-actions").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = $("m-schedule-actions-menu");
      const willOpen = !menu.classList.contains("open");
      menu.classList.toggle("open", willOpen);
      $("m-btn-schedule-actions").setAttribute("aria-expanded", String(willOpen));
    });
    $("m-schedule-export-csv").addEventListener("click", () => {
      closeScheduleActions();
      $("m-menu-export-csv").click();
    });
    $("m-schedule-day-report").addEventListener("click", () => {
      closeScheduleActions();
      switchTab("report");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#m-schedule-actions-wrap")) closeScheduleActions();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeScheduleActions();
        closeMobileNavDrawer();
      }
    });

    // Bottom nav
    document.querySelectorAll("[data-m-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.mTab));
    });

    // Offline retry & clipboard cancel buttons
    $("m-btn-retry-sync").addEventListener("click", () => client.pullLatest());
    $("m-clipboard-cancel").addEventListener("click", () => clearMobileClipboard(false));
    $("m-btn-force-sync").addEventListener("click", async () => {
      const res = await client.pullLatest();
      showMobileToast(res.ok ? "Đã đồng bộ dữ liệu mới nhất!" : res.error);
    });

    // Date bar
    $("m-btn-prev-day").addEventListener("click", () => { mState.selectedDate = addDaysISO(mState.selectedDate, -1); renderScheduleView(); });
    $("m-btn-next-day").addEventListener("click", () => { mState.selectedDate = addDaysISO(mState.selectedDate, 1); renderScheduleView(); });
    $("m-btn-today").addEventListener("click", () => { mState.selectedDate = getTodayISO(); renderScheduleView(); });
    $("m-date-input").addEventListener("change", (e) => {
      if (e.target.value) { mState.selectedDate = e.target.value; renderScheduleView(); }
    });

    // Range availability finder
    $("m-range-toggle").addEventListener("click", () => {
      mState.rangeOpen = !mState.rangeOpen;
      $("m-range-body").classList.toggle("open", mState.rangeOpen);
      $("m-range-arrow").textContent = mState.rangeOpen ? "▴" : "▾";
    });
    $("m-range-ci").addEventListener("change", (e) => {
      mState.rangeCheckin = e.target.value;
      if (!mState.rangeCheckout || mState.rangeCheckout <= mState.rangeCheckin) {
        mState.rangeCheckout = addDaysISO(mState.rangeCheckin, 1);
        $("m-range-co").value = mState.rangeCheckout;
      }
    });
    $("m-range-co").addEventListener("change", (e) => { mState.rangeCheckout = e.target.value; });
    $("m-btn-apply-range").addEventListener("click", () => {
      const ci = $("m-range-ci").value;
      const co = $("m-range-co").value;
      if (!ci || !co || diffNights(ci, co) <= 0) {
        showMobileToast("Ngày trả phải sau ngày nhận ít nhất 1 đêm");
        return;
      }
      mState.rangeCheckin = ci;
      mState.rangeCheckout = co;
      mState.selectedDate = ci;
      mState.rangeActive = true;
      renderScheduleView();
    });
    $("m-btn-clear-range").addEventListener("click", () => {
      mState.rangeActive = false;
      renderScheduleView();
    });

    // Search & filter drawer
    let sTimer = null;
    $("m-search-input").addEventListener("input", () => {
      clearTimeout(sTimer);
      sTimer = setTimeout(() => { mState.filters.search = $("m-search-input").value.trim(); renderScheduleView(); }, 100);
    });
    $("m-btn-filter-toggle").addEventListener("click", () => {
      mState.filterDrawerOpen = !mState.filterDrawerOpen;
      $("m-filter-drawer").classList.toggle("open", mState.filterDrawerOpen);
    });
    $("m-filter-floor").addEventListener("change", (e) => { mState.filters.floor = e.target.value; renderScheduleView(); });
    $("m-filter-type").addEventListener("change", (e) => { mState.filters.type = e.target.value; renderScheduleView(); });
    $("m-filter-view").addEventListener("change", (e) => { mState.filters.view = e.target.value; renderScheduleView(); });
    $("m-filter-payment").addEventListener("change", (e) => { mState.filters.payment = e.target.value; renderScheduleView(); });
    $("m-filter-channel").addEventListener("change", (e) => { mState.filters.channel = e.target.value; renderScheduleView(); });
    $("m-btn-reset-filters").addEventListener("click", () => {
      mState.filters = { search: "", floor: "all", type: "all", view: "all", payment: "all", channel: "all" };
      mState.rangeActive = false;
      $("m-search-input").value = "";
      $("m-filter-floor").value = "all";
      $("m-filter-type").value = "all";
      $("m-filter-view").value = "all";
      $("m-filter-payment").value = "all";
      $("m-filter-channel").value = "all";
      renderScheduleView();
    });

    // Format lump-sum inputs in Report tab
    $("m-main").addEventListener("input", (e) => {
      const inp = e.target.closest(".m-rpt-group-lump-input");
      if (!inp) return;
      const raw = parseVND(inp.value);
      inp.value = raw > 0 ? raw.toLocaleString("vi-VN") : "";
    });

    // Delegated clicks inside Schedule, Bookings, Report, and Room Detail
    $("m-main").addEventListener("click", async (e) => {
      const hkPill = e.target.closest("[data-m-open-room-hk]");
      if (hkPill) {
        e.stopPropagation();
        if (window.PMSHousekeepingApp) window.PMSHousekeepingApp.open({ tab: "tasks", roomId: hkPill.dataset.mOpenRoomHk });
        return;
      }
      const issPill = e.target.closest("[data-m-open-room-issues]");
      if (issPill) {
        e.stopPropagation();
        if (window.PMSHousekeepingApp) window.PMSHousekeepingApp.open({ tab: "issues", roomId: issPill.dataset.mOpenRoomIssues });
        return;
      }
      if (e.target.closest("#m-stats-more-toggle")) {
        mState.secondaryStatsOpen = !mState.secondaryStatsOpen;
        renderScheduleView();
        return;
      }
      if (e.target.closest("#m-kpi-paid-card")) {
        if (window.PMSFinanceApp) window.PMSFinanceApp.openMonthlyReceipts(mState.lastFinYear, mState.lastFinMonth);
        return;
      }
      if (e.target.closest("#m-kpi-debt-card")) {
        if (window.PMSFinanceApp) window.PMSFinanceApp.openReceivables({ asOfDate: mState.lastArAsOfDate || getVietnamTodayISO(), status: "debt" });
        return;
      }
      if (e.target.closest("#m-stat-dorm-card")) return openDormSheet(mState.selectedDate);
      const dormBtn = e.target.closest("[data-m-open-dorm]");
      if (dormBtn) return openDormSheet(dormBtn.dataset.mOpenDorm);
      const pasteBtn = e.target.closest("[data-m-paste-room]");
      if (pasteBtn) return pasteMobileBookingIntoRoom(pasteBtn.dataset.mPasteRoom, pasteBtn.dataset.mCi);
      const rptAllocBtn = e.target.closest("[data-m-rpt-group-allocate]");
      if (rptAllocBtn) {
        const code = rptAllocBtn.dataset.mRptGroupAllocate;
        const box = rptAllocBtn.closest("[data-m-rpt-group]");
        const inp = box ? box.querySelector(".m-rpt-group-lump-input") : null;
        const val = inp ? inp.value : 0;
        const res = await applyMobileGroupLumpSumPayment(code, val);
        if (!res.ok) return alert(res.error);
        showMobileToast(`✓ Đã chia ${formatVND(parseVND(val))} cho đoàn ${code}`);
        return;
      }
      const rptPaidBtn = e.target.closest("[data-m-rpt-group-paid]");
      if (rptPaidBtn) {
        const code = rptPaidBtn.dataset.mRptGroupPaid;
        const summary = computeBookingGroupSummary(getBookings(), code);
        if (!summary) return;
        const res = await applyMobileGroupLumpSumPayment(code, summary.totalAmount);
        if (!res.ok) return alert(res.error);
        showMobileToast(`✓ Đã thu đủ cả đoàn ${code}`);
        return;
      }
      const bookBtn = e.target.closest("[data-m-book-room]");
      if (bookBtn) return openMobileBookingSheet({ roomId: bookBtn.dataset.mBookRoom, checkin: bookBtn.dataset.mCi, checkout: bookBtn.dataset.mCo });
      const editBk = e.target.closest("[data-m-edit-bk]");
      if (editBk) return openMobileBookingSheet({ bookingId: editBk.dataset.mEditBk });
      const openRoom = e.target.closest("[data-m-open-room]");
      if (openRoom) return openRoomDetailSheet(openRoom.dataset.mOpenRoom);
    });

    // Bookings tab controls
    $("m-btn-quick-new-booking").addEventListener("click", () => openMobileBookingSheet({ roomId: "101", checkin: mState.selectedDate, allowRoomSelect: true }));
    $("m-btn-quick-dorm").addEventListener("click", () => openDormSheet(mState.selectedDate));
    $("m-bk-search").addEventListener("input", (e) => { mState.bookingsSearch = e.target.value; renderBookingsTab(); });
    $("m-bk-channel").addEventListener("change", (e) => { mState.bookingsChannel = e.target.value; renderBookingsTab(); });
    $("m-bk-chips").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-bk-filter]");
      if (!btn) return;
      mState.bookingsTabFilter = btn.dataset.bkFilter;
      $("m-bk-chips").querySelectorAll(".m-chip").forEach((c) => c.classList.toggle("active", c === btn));
      renderBookingsTab();
    });

    // Room Detail Sheet events
    $("m-room-back").addEventListener("click", () => { $("m-sheet-room").classList.remove("open"); restoreScrollPosition(); });
    $("m-room-book-btn").addEventListener("click", () => openMobileBookingSheet({ roomId: mState.roomDetailId, checkin: mState.selectedDate }));
    $("m-room-sheet-body").addEventListener("click", (e) => {
      if (e.target.closest("#m-rcal-prev")) {
        mState.roomDetailMonth -= 1;
        if (mState.roomDetailMonth < 0) { mState.roomDetailMonth = 11; mState.roomDetailYear -= 1; }
        renderRoomDetailSheet();
        return;
      }
      if (e.target.closest("#m-rcal-next")) {
        mState.roomDetailMonth += 1;
        if (mState.roomDetailMonth > 11) { mState.roomDetailMonth = 0; mState.roomDetailYear += 1; }
        renderRoomDetailSheet();
        return;
      }
      const editBk = e.target.closest("[data-m-edit-bk]");
      if (editBk) return openMobileBookingSheet({ bookingId: editBk.dataset.mEditBk });
      const calDay = e.target.closest("[data-m-room-cal-day]");
      if (calDay) {
        const bkId = calDay.dataset.mRoomCalBk;
        if (bkId) openMobileBookingSheet({ bookingId: bkId });
        else openMobileBookingSheet({ roomId: mState.roomDetailId, checkin: calDay.dataset.mRoomCalDay });
      }
    });

    // Booking Form Sheet events
    $("m-bk-close").addEventListener("click", () => {
      $("m-sheet-booking").classList.remove("open");
      restoreScrollPosition();
      if (typeof client.notifyIdleCheck === "function") client.notifyIdleCheck();
    });
    $("m-bk-cancel").addEventListener("click", () => {
      clearMobileDraft();
      $("m-sheet-booking").classList.remove("open");
      restoreScrollPosition();
      if (typeof client.notifyIdleCheck === "function") client.notifyIdleCheck();
    });
    $("m-bk-copy").addEventListener("click", () => {
      if (!mState.editingBookingId) return;
      const bk = getBookings().find((b) => b.id === mState.editingBookingId);
      if (bk) copyMobileBooking(bk);
    });
    $("m-room-issue-warning").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-m-jump-issues]");
      if (!btn) return;
      if (window.PMSHousekeepingApp) window.PMSHousekeepingApp.open({ tab: "issues", roomId: btn.dataset.mJumpIssues });
    });
    $("m-btn-checkout-booking").addEventListener("click", async () => {
      const id = mState.editingBookingId;
      if (!id || mState.isSubmitting) return;
      mState.isSubmitting = true;
      $("m-btn-checkout-booking").disabled = true;
      try {
        const res = await client.checkoutBooking(id, { serviceDate: getTodayISO() });
        if (!res || !res.ok) return showMobileBookingError((res && res.error) || "Không thể check-out phòng.");
        const latest = getBookings().find((b) => b.id === id) || res.booking;
        if (latest) {
          mState.editingBookingRevision = Number(latest.revision) || mState.editingBookingRevision;
          mState.editingOriginalBooking = { ...latest, confirmationPdf: latest.confirmationPdf ? { ...latest.confirmationPdf } : null };
          renderMobileBookingOperationalBars(latest.roomId, latest);
        }
        renderMobileAll();
        const rName = getRoomById(latest ? latest.roomId : $("m-f-room").value)?.name || $("m-f-room").value;
        showMobileToast(res.idempotentHit || res.alreadyCheckedOut || res.created === false
          ? `✓ P.${rName} đã check-out trước đó (không tạo trùng việc dọn)`
          : `🚪 Đã check-out P.${rName} → Tự động tạo việc Dọn sau trả phòng!`);
      } finally {
        mState.isSubmitting = false;
        $("m-btn-checkout-booking").disabled = false;
      }
    });
    $("m-btn-request-stayover").addEventListener("click", async () => {
      const roomId = $("m-f-room").value;
      if (!roomId || mState.isSubmitting) return;
      mState.isSubmitting = true;
      $("m-btn-request-stayover").disabled = true;
      try {
        const res = await client.createHousekeepingTask({
          roomId,
          taskType: "stayover",
          serviceDate: getTodayISO(),
          note: "Dọn trong kỳ lưu trú theo yêu cầu lễ tân"
        });
        if (!res || !res.ok) return showMobileBookingError((res && res.error) || "Không thể tạo việc dọn phòng.");
        renderMobileAll();
        showMobileToast(`🧹 Đã giao việc Dọn trong kỳ lưu trú cho P.${getRoomById(roomId)?.name || roomId}`);
      } finally {
        mState.isSubmitting = false;
        $("m-btn-request-stayover").disabled = false;
      }
    });
    $("m-f-room").addEventListener("change", () => {
      const r = getRoomById($("m-f-room").value);
      if (r && !mState.editingBookingId) $("m-bk-sheet-title").textContent = `Đặt phòng mới — P.${r.name}`;
      updateMobileRoomFields();
      const curBk = mState.editingBookingId ? getBookings().find((b) => b.id === mState.editingBookingId) : null;
      renderMobileBookingOperationalBars($("m-f-room").value, curBk || null);
      saveMobileDraft();
    });
    $("m-f-booking-date").addEventListener("change", saveMobileDraft);
    $("m-f-checkin").addEventListener("change", () => {
      if (!$("m-f-checkout").value || $("m-f-checkout").value <= $("m-f-checkin").value) {
        $("m-f-checkout").value = addDaysISO($("m-f-checkin").value, 1);
      }
      updateMobileNights();
      saveMobileDraft();
    });
    $("m-f-checkout").addEventListener("change", () => { updateMobileNights(); saveMobileDraft(); });
    $("m-f-booking-code").addEventListener("input", renderMobileModalGroupSummary);
    $("m-f-channels").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-m-ch]");
      if (!chip) return;
      setMobileChannel(chip.dataset.mCh);
      saveMobileDraft();
    });
    document.querySelectorAll("[data-m-pay]").forEach((t) => {
      t.addEventListener("click", () => { setMobilePayTab(t.dataset.mPay, true); saveMobileDraft(); });
    });
    [$("m-f-total"), $("m-f-paid")].forEach((inp) => {
      inp.addEventListener("input", () => {
        const raw = parseVND(inp.value);
        inp.value = raw > 0 ? raw.toLocaleString("vi-VN") : "";
        if (inp === $("m-f-total")) {
          if ($("m-f-include-vat").checked) {
            const rev = extractPreVatFromTotal(raw);
            $("m-f-pre-vat").value = formatNumberInput(rev.preVatAmount);
          }
          if (mState.bookingPayStatus === "paid") $("m-f-paid").value = inp.value;
        }
        updateMobilePaymentPreview();
        saveMobileDraft();
      });
    });
    $("m-f-include-vat").addEventListener("change", handleMobileVatToggle);
    $("m-f-pre-vat").addEventListener("input", () => {
      const base = parseVND($("m-f-pre-vat").value);
      $("m-f-pre-vat").value = base > 0 ? base.toLocaleString("vi-VN") : "";
      if ($("m-f-include-vat").checked) {
        const calc = calculateVatBreakdown(base, true);
        $("m-f-total").value = formatNumberInput(calc.totalAmount);
        if (mState.bookingPayStatus === "paid") $("m-f-paid").value = $("m-f-total").value;
      }
      updateMobilePaymentPreview();
      saveMobileDraft();
    });

    // Mobile Group Summary Box events inside Booking Form
    $("m-group-lump-input").addEventListener("input", (e) => {
      const raw = parseVND(e.target.value);
      e.target.value = raw > 0 ? raw.toLocaleString("vi-VN") : "";
    });
    $("m-group-rooms").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-m-jump-bk]");
      if (!btn) return;
      const targetId = btn.dataset.mJumpBk;
      if (targetId && targetId !== mState.editingBookingId) {
        openMobileBookingSheet({ bookingId: targetId });
      }
    });
    $("m-btn-group-autofill").addEventListener("click", () => {
      const code = ($("m-f-booking-code").value || "").trim();
      const summary = computeBookingGroupSummary(getBookings(), code);
      if (summary && autofillMobileFormFromGroup(summary, { force: true })) {
        showMobileToast(`⚡ Đã điền thông tin từ đoàn ${summary.code}`);
      }
    });
    $("m-btn-group-allocate").addEventListener("click", async () => {
      const code = ($("m-f-booking-code").value || "").trim();
      const val = $("m-group-lump-input").value;
      const curId = mState.editingBookingId;
      const res = await applyMobileGroupLumpSumPayment(code, val);
      if (!res.ok) return showMobileBookingError(res.error);
      showMobileBookingError("");
      if (curId) openMobileBookingSheet({ bookingId: curId });
      else renderMobileModalGroupSummary();
      showMobileToast(`✓ Đã chia ${formatVND(parseVND(val))} cho đoàn ${code}`);
    });
    $("m-btn-group-mark-paid").addEventListener("click", async () => {
      const code = ($("m-f-booking-code").value || "").trim();
      const curId = mState.editingBookingId;
      const summary = computeBookingGroupSummary(getBookings(), code);
      if (!summary) return;
      const res = await applyMobileGroupLumpSumPayment(code, summary.totalAmount);
      if (!res.ok) return showMobileBookingError(res.error);
      showMobileBookingError("");
      if (curId) openMobileBookingSheet({ bookingId: curId });
      else renderMobileModalGroupSummary();
      showMobileToast(`✓ Đã thu đủ cả đoàn ${code}`);
    });

    $("m-bk-mark-paid").addEventListener("click", () => {
      setMobilePayTab("paid", true);
      showMobileToast("Đã điền thu đủ — chạm Lưu thông tin");
    });
    $("m-bk-form").addEventListener("input", saveMobileDraft);
    $("m-bk-form").addEventListener("submit", handleMobileSaveBooking);
    $("m-bk-reload-latest").addEventListener("click", () => {
      const id = mState.editingBookingId;
      $("m-bk-conflict-banner").classList.remove("show");
      if (!id) return;
      const latest = getBookings().find((b) => b.id === id);
      if (!latest) {
        $("m-sheet-booking").classList.remove("open");
        restoreScrollPosition();
        showMobileToast("Đặt phòng này đã bị xóa từ thiết bị khác");
        return;
      }
      openMobileBookingSheet({ bookingId: id });
    });
    $("m-bk-dismiss-conflict").addEventListener("click", () => {
      // Allow user to inspect & keep editing; update revision ONLY if user explicitly reloads
      $("m-bk-conflict-banner").classList.remove("show");
    });
    $("m-bk-delete").addEventListener("click", async () => {
      if (!mState.editingBookingId || mState.isSubmitting) return;
      const bk = getBookings().find((b) => b.id === mState.editingBookingId);
      if (!bk || !confirm(`Xóa đặt phòng của "${bk.guestName}" tại P.${getRoomById(bk.roomId)?.name || bk.roomId}?`)) return;
      mState.isSubmitting = true;
      $("m-bk-delete").disabled = true;
      try {
        const res = await client.deleteBooking(bk.id, { expectedRevision: mState.editingBookingRevision });
        if (!res.ok) return showMobileBookingError(res.error);
        $("m-sheet-booking").classList.remove("open");
        renderMobileAll();
        restoreScrollPosition();
        showMobileToast("Đã xóa đặt phòng (có thể khôi phục trong Lịch sử)");
      } finally {
        mState.isSubmitting = false;
        $("m-bk-delete").disabled = false;
        if (typeof client.notifyIdleCheck === "function") client.notifyIdleCheck();
      }
    });

    // Dorm Sheet events
    $("m-dorm-back-btn").addEventListener("click", () => {
      if (mState.dormMode === "form") { setDormSheetMode("board"); renderMobileDormBoard(); }
      else { $("m-sheet-dorm").classList.remove("open"); restoreScrollPosition(); }
    });
    $("m-dorm-close-btn").addEventListener("click", () => { $("m-sheet-dorm").classList.remove("open"); restoreScrollPosition(); });
    $("m-dorm-new-btn").addEventListener("click", () => openMobileDormForm({}));
    $("m-dorm-cancel-form").addEventListener("click", () => { setDormSheetMode("board"); renderMobileDormBoard(); });
    $("m-dorm-prev").addEventListener("click", () => { mState.dormDate = addDaysISO(mState.dormDate, -1); renderMobileDormBoard(); });
    $("m-dorm-next").addEventListener("click", () => { mState.dormDate = addDaysISO(mState.dormDate, 1); renderMobileDormBoard(); });
    $("m-dorm-grid").addEventListener("click", (e) => {
      const bookBtn = e.target.closest("[data-m-dorm-book]");
      if (bookBtn) return openMobileDormForm({ preselectSlot: Number(bookBtn.dataset.mDormBook) });
      const editBtn = e.target.closest("[data-m-dorm-edit]");
      if (editBtn) return openMobileDormForm({ bookingId: editBtn.dataset.mDormEdit });
    });
    $("m-dorm-picker").addEventListener("click", (e) => {
      const pick = e.target.closest("[data-m-dorm-pick]");
      if (!pick) return;
      const num = Number(pick.dataset.mDormPick);
      if (mState.dormSelectedSlots.includes(num)) mState.dormSelectedSlots = mState.dormSelectedSlots.filter((x) => x !== num);
      else { mState.dormSelectedSlots.push(num); mState.dormSelectedSlots.sort((a, b) => a - b); }
      renderMobileDormPicker();
    });
    $("m-df-checkin").addEventListener("change", () => {
      if (!$("m-df-checkout").value || $("m-df-checkout").value <= $("m-df-checkin").value) {
        $("m-df-checkout").value = addDaysISO($("m-df-checkin").value, 1);
      }
      renderMobileDormPicker();
    });
    $("m-df-checkout").addEventListener("change", renderMobileDormPicker);
    $("m-df-source").addEventListener("change", syncMobileDormFormUI);
    [$("m-df-total"), $("m-df-paid")].forEach((inp) => {
      inp.addEventListener("input", () => {
        const raw = parseVND(inp.value);
        inp.value = raw > 0 ? raw.toLocaleString("vi-VN") : "";
        syncMobileDormFormUI();
      });
    });
    $("m-dorm-form-pane").addEventListener("submit", handleMobileSaveDorm);

    // Booking Confirmation A4 PDF Export (Mobile Regular Room + Dorm)
    $("m-btn-export-confirm-pdf").addEventListener("click", () => {
      if (window.PMSConfirmationModal) {
        window.PMSConfirmationModal.open(collectLiveMobileRegularDraftBooking(), getBookings());
      }
    });
    $("m-dorm-btn-export-confirm-pdf").addEventListener("click", () => {
      if (window.PMSConfirmationModal) {
        window.PMSConfirmationModal.open(collectLiveMobileDormDraftBooking(), getBookings());
      }
    });
    $("m-btn-view-legacy-pdf").addEventListener("click", () => {
      if (window.PMSPdfHelper) window.PMSPdfHelper.openPdfAttachment(mState.bookingConfirmationPdf);
    });
    $("m-dorm-btn-view-legacy-pdf").addEventListener("click", () => {
      if (window.PMSPdfHelper) window.PMSPdfHelper.openPdfAttachment(mState.dormConfirmationPdf);
    });

    $("m-dorm-reload-latest").addEventListener("click", () => {
      const id = mState.editingDormId;
      $("m-dorm-conflict-banner").classList.remove("show");
      if (!id) return;
      const latest = getBookings().find((b) => b.id === id);
      if (!latest) {
        setDormSheetMode("board");
        renderMobileDormBoard();
        showMobileToast("Lượt đặt Dorm này đã bị xóa từ thiết bị khác");
        return;
      }
      openMobileDormForm({ bookingId: id });
    });
    $("m-dorm-delete").addEventListener("click", async () => {
      if (!mState.editingDormId || mState.isSubmitting) return;
      const bk = getBookings().find((b) => b.id === mState.editingDormId);
      if (!bk || !confirm(`Xóa lượt đặt Dorm của "${bk.guestName}"?`)) return;
      mState.isSubmitting = true;
      $("m-dorm-delete").disabled = true;
      try {
        const res = await client.deleteBooking(bk.id, { expectedRevision: mState.editingDormRevision });
        if (!res.ok) {
          $("m-dorm-error").textContent = res.error;
          $("m-dorm-error").classList.add("show");
          return;
        }
        setDormSheetMode("board");
        renderMobileDormBoard();
        renderMobileAll();
        showMobileToast("Đã xóa lượt đặt Dorm");
      } finally {
        mState.isSubmitting = false;
        $("m-dorm-delete").disabled = false;
        if (typeof client.notifyIdleCheck === "function") client.notifyIdleCheck();
      }
    });

    // History Sheet events
    $("m-hist-close").addEventListener("click", () => $("m-sheet-history").classList.remove("open"));
    $("m-hist-search").addEventListener("input", (e) => { mState.historySearch = e.target.value; renderMobileHistorySheet(); });
    $("m-hist-action").addEventListener("change", (e) => { mState.historyAction = e.target.value; renderMobileHistorySheet(); });
    $("m-hist-confirmer").addEventListener("change", (e) => { mState.historyConfirmer = e.target.value; renderMobileHistorySheet(); });
    $("m-hist-export").addEventListener("click", () => {
      const csv = generateAuditCsvContent(client.getAuditLogs());
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `lich-su-chinh-sua-${getTodayISO()}.csv`; a.click();
      URL.revokeObjectURL(url);
      showMobileToast("Đã xuất lịch sử chỉnh sửa (CSV)");
    });
    $("m-hist-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-m-restore-snap]");
      if (!btn) return;
      if (!confirm("Khôi phục toàn bộ bảng phòng về mốc sao lưu này?")) return;
      const res = await client.restoreFromAutoBackup(btn.dataset.mRestoreSnap);
      if (!res.ok) return alert(res.error);
      renderMobileAll();
      renderMobileHistorySheet();
      showMobileToast(`Đã khôi phục mốc sao lưu (${res.bookings.length} đơn)`);
    });

    // More Tab actions (100% PC feature parity + RBAC enforcement)
    $("m-btn-issue-alert-view").addEventListener("click", () => {
      if (window.PMSHousekeepingApp) window.PMSHousekeepingApp.open({ tab: "issues", roomId: "all" });
    });
    $("m-menu-hk").addEventListener("click", () => {
      if (window.PMSHousekeepingApp) window.PMSHousekeepingApp.open({ tab: "tasks", roomId: "all", dateISO: getTodayISO() });
    });
    $("m-menu-accounts").addEventListener("click", () => {
      if (!mCan("accounts:manage")) return showMobileToast("Quản lý tài khoản chỉ dành cho Quản lý.");
      if (window.PMSHousekeepingApp) window.PMSHousekeepingApp.openAccounts();
    });
    $("m-menu-costs").addEventListener("click", () => {
      if (!mCan("costs:read")) return showMobileToast("Chi phí & Giá vốn chỉ dành cho Quản lý.");
      if (window.PMSOperatingCostsModal) {
        window.PMSOperatingCostsModal.open(mState.selectedDate ? mState.selectedDate.slice(0, 7) : undefined);
      }
    });
    $("m-menu-history").addEventListener("click", () => {
      renderMobileHistorySheet();
      $("m-sheet-history").classList.add("open");
      if (typeof client.pullLatest === "function" && client.getStatus().mode === "server") {
        client.pullLatest().catch(() => {});
      }
    });
    $("m-menu-rollback").addEventListener("click", async () => {
      if (!mCan("admin:backup")) return showMobileToast("Chỉ Quản lý mới có quyền hoàn tác dữ liệu.");
      if (!confirm("Hoàn tác dữ liệu về trạng thái ngay trước thay đổi gần nhất?")) return;
      const res = await client.rollbackLastChange();
      if (!res.ok) return alert(res.error);
      renderMobileAll();
      showMobileToast(`Đã hoàn tác (${res.bookings.length} đơn)`);
    });
    $("m-menu-export-csv").addEventListener("click", () => {
      if (!mCan("admin:backup")) return showMobileToast("Xuất Excel tổng hợp chỉ dành cho Quản lý.");
      const csv = generateCsvContent(getBookings());
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `lich-dat-phong-${getTodayISO()}.csv`; a.click();
      URL.revokeObjectURL(url);
      showMobileToast("Đã xuất file Excel (CSV)");
    });
    $("m-menu-backup-json").addEventListener("click", () => {
      if (!mCan("admin:backup")) return showMobileToast("Sao lưu JSON chỉ dành cho Quản lý.");
      const payload = {
        exportedAt: new Date().toISOString(),
        version: 3,
        hotel: "Dongvan Ville du H'mong Hotel",
        bookings: getBookings(),
        auditLogs: client.getAuditLogs(),
        operatingCosts: typeof client.getOperatingCosts === "function" ? client.getOperatingCosts() : undefined
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `backup-dongvan-hotel-${getTodayISO()}.json`; a.click();
      URL.revokeObjectURL(url);
      showMobileToast("Đã tải file sao lưu JSON (gồm lịch phòng & chi phí)");
    });
    $("m-input-restore-json").addEventListener("change", (e) => {
      if (!mCan("admin:backup")) { e.target.value = ""; return showMobileToast("Khôi phục JSON chỉ dành cho Quản lý."); }
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        let parsedCosts = null;
        let parsedCount = null;
        try {
          const parsed = JSON.parse(reader.result);
          if (parsed && typeof parsed === "object" && parsed.operatingCosts && typeof parsed.operatingCosts === "object") {
            parsedCosts = parsed.operatingCosts;
          }
          if (Array.isArray(parsed)) parsedCount = parsed.length;
          else if (parsed && Array.isArray(parsed.bookings)) parsedCount = parsed.bookings.length;
        } catch {}

        const confirmMsg = [
          `Khôi phục dữ liệu từ file "${file.name}"?`,
          parsedCount !== null ? `• File chứa ${parsedCount} lượt đặt phòng${parsedCosts ? " và chi phí vận hành" : ""}.` : "• Hệ thống sẽ kiểm tra cấu trúc file trước khi nạp.",
          `• Dữ liệu hiện tại (${getBookings().length} lượt đặt phòng) sẽ được thay thế (có lưu bản hoàn tác tự động).`,
          "",
          "Nhấn OK để khôi phục, Hủy để giữ nguyên."
        ].join("\n");
        if (!window.confirm(confirmMsg)) {
          showMobileToast("Đã hủy khôi phục — dữ liệu giữ nguyên");
          return;
        }

        const res = await client.restoreFromImport(reader.result);
        if (!res.ok) return alert("Không thể khôi phục:\n" + res.error);
        let restoredCosts = false;
        if (parsedCosts && typeof client.saveOperatingCosts === "function") {
          const cRes = await client.saveOperatingCosts(parsedCosts);
          if (cRes && cRes.ok) restoredCosts = true;
        }
        renderMobileAll();
        showMobileToast(restoredCosts
          ? `Đã khôi phục ${res.bookings.length} lượt đặt phòng & chi phí vận hành`
          : `Đã khôi phục ${res.bookings.length} lượt đặt phòng`);
      };
      reader.readAsText(file);
    });
    $("m-menu-theme").addEventListener("click", () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      if (isDark) {
        document.documentElement.removeAttribute("data-theme");
        try { localStorage.setItem(THEME_KEY, "light"); } catch {}
        $("m-menu-theme-val").textContent = "Sáng";
      } else {
        document.documentElement.setAttribute("data-theme", "dark");
        try { localStorage.setItem(THEME_KEY, "dark"); } catch {}
        $("m-menu-theme-val").textContent = "Tối";
      }
    });
    $("m-menu-reset-sample").addEventListener("click", async () => {
      if (!mCan("admin:backup")) return showMobileToast("Chỉ Quản lý mới có quyền khôi phục dữ liệu mẫu.");
      if (!confirm("Khôi phục danh sách đặt phòng mẫu?")) return;
      const res = await client.resetToSample();
      if (!res.ok) return alert(res.error);
      renderMobileAll();
      showMobileToast("Đã khôi phục dữ liệu mẫu");
    });
    $("m-menu-switch-pc").addEventListener("click", () => {
      if (mRole() === "housekeeping") return;
      document.body.dataset.viewMode = "pc";
    });
    $("m-menu-logout").addEventListener("click", async () => {
      if (!confirm("Đăng xuất tài khoản trên điện thoại này?")) return;
      await client.logout();
      renderSyncStatus();
    });

    // Expose Mobile booking sheet opener for shared modals (e.g. missing-guest jump in Operating Costs)
    window.PMSMobileApi = {
      openBooking: (bookingId) => openMobileBookingSheet({ bookingId })
    };

    // Register mobile busy check so live A -> B auto-updates NEVER interrupt active booking, Dorm, or Costs typing
    if (typeof client.registerBusyCheck === "function") {
      client.registerBusyCheck(() =>
        mState.isSubmitting ||
        $("m-sheet-booking").classList.contains("open") ||
        ($("m-sheet-dorm").classList.contains("open") && mState.dormMode === "form") ||
        Boolean($("costs-modal") && $("costs-modal").classList.contains("open"))
      );
    }

    // Realtime subscription from shared PMSClient (Supabase Realtime / SSE + reconnect catch-up)
    client.subscribe(({ type, state, remoteEvent }) => {
      if (!isMobileViewActive()) {
        mobileRenderDirty = true;
        return;
      }
      renderSyncStatus();
      if (type === "status" || type === "version" || type === "update_pending" || type === "update_applying" || type === "auth_required") return;
      if (mRole() === "housekeeping") return;

      // Check concurrent edit conflict if user has an open booking edit form!
      if (type === "remote_change" && $("m-sheet-booking").classList.contains("open") && mState.editingBookingId) {
        const latest = (state.bookings || []).find((b) => b.id === mState.editingBookingId);
        if (!latest) {
          $("m-bk-conflict-text").textContent = "⚠️ Đơn này vừa bị xóa ở thiết bị khác! Nội dung bạn đang nhập vẫn còn trên màn hình.";
          $("m-bk-conflict-diff").textContent = "";
          $("m-bk-conflict-banner").classList.add("show");
        } else if (Number(latest.revision) !== Number(mState.editingBookingRevision)) {
          showBookingConflictBanner(latest);
        }
      }

      if (type === "remote_change" && $("m-sheet-dorm").classList.contains("open") && mState.dormMode === "form" && mState.editingDormId) {
        const latest = (state.bookings || []).find((b) => b.id === mState.editingDormId);
        if (!latest || Number(latest.revision) !== Number(mState.editingDormRevision)) {
          mState.dormConflictBooking = latest || null;
          $("m-dorm-conflict-banner").classList.add("show");
        }
      }

      scheduleMobileRenderAll();

      if (type === "remote_change" && remoteEvent) {
        if (remoteEvent.action === "ISSUE_CREATE") {
          const rName = remoteEvent.roomId ? `P.${getRoomById(remoteEvent.roomId)?.name || remoteEvent.roomId}` : "phòng";
          showMobileToast(`🚨 Sự cố mới ${rName} từ ${remoteEvent.actor || "Buồng phòng"}!`);
        } else if (remoteEvent.action === "HK_COMPLETE") {
          const rName = remoteEvent.roomId ? `P.${getRoomById(remoteEvent.roomId)?.name || remoteEvent.roomId}` : "phòng";
          showMobileToast(`✅ ${remoteEvent.actor || "Buồng phòng"} đã dọn xong ${rName}`);
        } else if (["CREATE", "UPDATE", "DELETE"].includes(remoteEvent.action)) {
          const verb = remoteEvent.action === "CREATE" ? "vừa đặt mới" : remoteEvent.action === "DELETE" ? "vừa xóa" : "vừa cập nhật";
          const rName = remoteEvent.roomId ? (remoteEvent.roomId === "DORM" ? "Dorm" : `P.${getRoomById(remoteEvent.roomId)?.name || remoteEvent.roomId}`) : "sổ phòng";
          const actor = remoteEvent.actor ? `${remoteEvent.actor} ` : "Thiết bị khác ";
          showMobileToast(`🔄 ${actor}${verb} ${rName}`);
        }
      }
    });
  }

  async function bootMobile() {
    mountMobileShell();
    populateMobileDropdowns();
    bindMobileEvents();
    bindVisualViewportSupport();
    $("m-menu-theme-val").textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "Tối" : "Sáng";

    // Share the exact same single client initialization promise with app.js
    if (window.__pmsClientInitPromise) {
      await window.__pmsClientInitPromise;
    } else {
      window.__pmsClientInitPromise = client.init();
      await window.__pmsClientInitPromise;
    }
    renderMobileAll();
    if (window.matchMedia) {
      const mql = window.matchMedia("(max-width: 768px)");
      const onViewportChange = () => {
        if (mobileRenderDirty && isMobileViewActive()) renderMobileAll();
      };
      if (mql.addEventListener) mql.addEventListener("change", onViewportChange);
      else if (mql.addListener) mql.addListener(onViewportChange);
    }
  }

  bootMobile();
})();
