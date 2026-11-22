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
    escapeHtml,
    getRoomById,
    getRemaining,
    getPaymentStatus,
    detectChannelKey,
    bookingCoversDate,
    getDormSlotMapForDate,
    getDormOccupiedSlotsInRange,
    checkRegularConflict,
    computeMonthlyFinancials,
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
    // Regular booking form
    editingBookingId: null,
    editingBookingRevision: null,
    bookingIdempotencyKey: null,
    bookingChannelKey: "booking",
    bookingPayStatus: "deposit",
    bookingConflictBooking: null,
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

  function bookingMatchesSearchAndFilters(bk) {
    const f = mState.filters;
    if (f.channel !== "all" && bk.channelKey !== f.channel) return false;
    if (f.payment === "debt" && getRemaining(bk) <= 0) return false;
    if (f.payment === "paid" && getRemaining(bk) > 0) return false;
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
        <div class="m-brand">
          <img src="${escapeHtml(logoSrc)}" alt="Dongvan Ville du H'mong Hotel" class="m-brand-logo" />
          <div class="m-brand-text">
            <div class="m-brand-title">Dongvan Ville du H'mong</div>
            <div class="m-brand-sub">26 phòng • 1 Dorm (8 chỗ) • T5 Buffet</div>
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

      <main id="m-main" class="m-main">
        <!-- Tab 1: Daily Schedule -->
        <section id="m-view-schedule" class="m-tab-view active" aria-label="Lịch theo ngày">
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
                <option value="all">Tất cả tầng</option>
                <option value="1">Tầng 1 (5 phòng + Dorm)</option>
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
            <label class="m-menu-item" for="m-input-restore-json">
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
              <span>🔒 Đăng xuất tài khoản lễ tân<span id="m-menu-logout-sub" class="m-menu-sub">Kết thúc phiên đăng nhập trên thiết bị này</span></span>
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

          <!-- Group 1: Room & Dates -->
          <div class="m-form-group">
            <h3 class="m-group-title">1. Phòng &amp; Ngày lưu trú</h3>
            <div class="m-field">
              <label for="m-f-room">Phòng (26 phòng khách)</label>
              <select id="m-f-room" class="m-select"></select>
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
              <label for="m-f-tour-name">Tên Tour / Công ty lữ hành</label>
              <input id="m-f-tour-name" class="m-input" type="text" placeholder="VD: Vietravel, Saigontourist..." />
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
            <div class="balance-banner">
              <span>Còn lại chưa thanh toán:</span>
              <span id="m-f-remaining" class="balance-amount settled">0 đ</span>
            </div>
            <button id="m-bk-mark-paid" type="button" class="m-btn m-btn-success m-btn-block" style="display:none;">✓ Điền thu đủ 100%</button>
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
            <div class="m-field">
              <label for="m-f-confirmed-by">Người xác nhận đơn đặt phòng</label>
              <select id="m-f-confirmed-by" class="m-select"></select>
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
            <div id="m-dorm-sub" class="m-sheet-sub">Tầng 1 • 4 giường tầng cho HDV &amp; Lái xe</div>
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
            <h3 class="m-group-title">1. Ngày &amp; Chọn slot giường tầng</h3>
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
                <option value="tour">Tour / Công ty du lịch</option>
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
            <div class="m-field">
              <label for="m-df-confirmed-by">Người xác nhận đơn đặt phòng</label>
              <select id="m-df-confirmed-by" class="m-select"></select>
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
    `;
  }

  /* -------------------- Sync Status & Visual Viewport -------------------- */

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
      moreInfo.innerHTML = `
        <div><strong>Chế độ:</strong> ${status.mode === "server" ? "Máy chủ chung khách sạn (SQLite + SSE 2 chiều)" : "Bộ nhớ cục bộ trình duyệt (Offline)"}</div>
        <div><strong>Trạng thái:</strong> ${status.connectionStatus === "connected" ? "Đã kết nối trực tiếp" : status.connectionStatus === "auth_required" ? "Chờ đăng nhập" : status.connectionStatus === "local" ? "Đang chạy offline" : "Mất kết nối / Đang nối lại"}</div>
        ${status.user && status.user.staffName ? `<div><strong>Tài khoản trực ca:</strong> ${escapeHtml(status.user.staffName)}</div>` : ""}
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
        sub.textContent = `Đang đăng nhập: ${status.user.staffName}`;
      }
    }
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

  /* -------------------- Render Tab 1: Daily Schedule -------------------- */

  function renderTurnCardHtml(bk, turnLabel, turnClass) {
    const room = getRoomById(bk.roomId);
    const rem = getRemaining(bk);
    const total = parseVND(bk.totalAmount);
    const paid = parseVND(bk.paidAmount);
    const payStatus = getPaymentStatus(bk);
    const payText = total === 0
      ? "Chưa nhập giá"
      : rem === 0
        ? `✓ Đã thu đủ ${formatShortVND(total)}`
        : paid > 0
          ? `Cọc ${formatShortVND(paid)} • Nợ ${formatShortVND(rem)}`
          : `Chưa TT • Nợ ${formatShortVND(total)}`;

    const chKey = bk.channelKey || detectChannelKey(bk.sourceName);
    return `<div class="m-turn-box ${turnClass}" data-m-edit-bk="${escapeHtml(bk.id)}">
      ${turnLabel ? `<div class="m-turn-label">${escapeHtml(turnLabel)}</div>` : ""}
      <div class="m-guest-row">
        <span class="m-guest-name">${escapeHtml(bk.guestName)}</span>
        <div class="m-badges-row">
          ${bk.mergeBed && room && room.type === "Twins" ? `<span class="m-badge-g" title="Ghép giường Twins thành Double">G</span>` : ""}
          ${Number(bk.extraBed) > 0 ? `<span class="m-badge-eb">+${bk.extraBed} EB</span>` : ""}
        </div>
      </div>
      <div class="m-badges-row">
        <span class="m-channel-tag ch-${escapeHtml(chKey)}">${escapeHtml(bk.sourceName)}</span>
        <span style="font-size:11.5px; color:var(--text-muted);">${formatDateVN(bk.checkin)} → ${formatDateVN(bk.checkout)}</span>
        ${bk.confirmedBy ? `<span style="font-size:11px; color:var(--text-muted);">• XN: ${escapeHtml(bk.confirmedBy)}</span>` : ""}
      </div>
      <div class="m-pay-row">
        <span class="m-pay-pill ${payStatus}">${payText}</span>
        ${rem > 0 ? `<span style="font-size:11px; font-weight:700; color:var(--accent-primary);">Chạm để thu/sửa ›</span>` : ""}
      </div>
    </div>`;
  }

  function renderScheduleView() {
    const dateISO = mState.selectedDate;
    const isToday = dateISO === getTodayISO();
    $("m-date-main").textContent = formatFullDateLabel(dateISO);
    $("m-date-sub").textContent = isToday ? "Hôm nay • Chạm để đổi ngày" : "Chạm để chọn ngày khác";
    $("m-date-input").value = dateISO;

    const regularRooms = ROOMS.filter((r) => !r.isDorm);
    let occupiedCount = 0;
    let checkinsToday = 0;
    let checkoutsToday = 0;

    regularRooms.forEach((r) => {
      const { staying, checkingOut } = getRoomTurnsForDate(r.id, dateISO);
      if (staying.length > 0) {
        occupiedCount += 1;
        if (staying[0].checkin === dateISO) checkinsToday += 1;
      }
      checkoutsToday += checkingOut.length;
    });

    const vacantCount = regularRooms.length - occupiedCount;
    const { map: dormMap } = getDormSlotMapForDate(getBookings(), dateISO);
    const dormUsed = Object.keys(dormMap).length;
    const dormFree = Math.max(0, 8 - dormUsed);

    $("m-stats-grid").innerHTML = `
      <div class="m-stat-card">
        <span class="m-stat-label">Phòng trống</span>
        <span class="m-stat-val ok">${vacantCount} / 26 phòng</span>
      </div>
      <div class="m-stat-card">
        <span class="m-stat-label">Đang có khách</span>
        <span class="m-stat-val">${occupiedCount} / 26 phòng</span>
      </div>
      <div class="m-stat-card">
        <span class="m-stat-label">Lượt đến / đi</span>
        <span class="m-stat-val">${checkinsToday} đến • ${checkoutsToday} đi</span>
      </div>
      <div class="m-stat-card" id="m-stat-dorm-card" style="cursor:pointer;">
        <span class="m-stat-label">Dorm nội bộ trống</span>
        <span class="m-stat-val ${dormFree === 0 ? "warn" : "ok"}">${dormFree} / 8 slot</span>
      </div>
    `;

    // Update range UI
    $("m-range-ci").value = mState.rangeCheckin;
    $("m-range-co").value = mState.rangeCheckout;
    $("m-btn-clear-range").style.display = mState.rangeActive ? "inline-flex" : "none";
    if (mState.rangeActive) {
      const freeInRange = regularRooms.filter((r) => isRoomFreeInRange(r.id, mState.rangeCheckin, mState.rangeCheckout)).length;
      const dormOccRange = Object.keys(getDormOccupiedSlotsInRange(getBookings(), mState.rangeCheckin, mState.rangeCheckout, null)).length;
      $("m-range-title").textContent = `🔎 Trống ${formatDateVN(mState.rangeCheckin)} → ${formatDateVN(mState.rangeCheckout)} (${freeInRange} phòng)`;
      $("m-range-summary").style.display = "block";
      $("m-range-summary").innerHTML = `Đang chỉ hiện <strong>${freeInRange}/26 phòng trống suốt kỳ</strong> (${diffNights(mState.rangeCheckin, mState.rangeCheckout)} đêm) • Dorm trống <strong>${8 - dormOccRange}/8 slot</strong>.`;
    } else {
      $("m-range-title").textContent = "🔎 Tìm phòng trống theo khoảng ngày";
      $("m-range-summary").style.display = "none";
    }

    $("m-btn-filter-toggle").classList.toggle("has-filter", hasScheduleFilters());

    // Build floor-grouped room cards
    const floors = [1, 2, 3, 4];
    const htmlParts = [];

    for (const fl of floors) {
      if (mState.filters.floor !== "all" && String(fl) !== mState.filters.floor) continue;
      const floorRooms = ROOMS.filter((r) => {
        if (r.floor !== fl) return false;
        if (mState.filters.type !== "all" && r.type !== mState.filters.type) return false;
        if (mState.filters.view !== "all" && r.view !== mState.filters.view) return false;

        if (mState.rangeActive) {
          if (r.isDorm) {
            const occ = Object.keys(getDormOccupiedSlotsInRange(getBookings(), mState.rangeCheckin, mState.rangeCheckout, null)).length;
            if (occ >= 8) return false;
          } else if (!isRoomFreeInRange(r.id, mState.rangeCheckin, mState.rangeCheckout)) {
            return false;
          }
        }

        const hasBookingFilter = Boolean(mState.filters.search || mState.filters.payment !== "all" || mState.filters.channel !== "all");
        if (hasBookingFilter) {
          const q = mState.filters.search.toLowerCase();
          const roomNameMatches = q && (`p.${r.name} ${r.name} ${r.type} ${r.view}`).toLowerCase().includes(q);
          if (r.isDorm) {
            const dormBks = getBookings().filter((b) => b.roomId === "DORM" && (bookingCoversDate(b, dateISO) || b.checkout === dateISO));
            if (!roomNameMatches && !dormBks.some(bookingMatchesSearchAndFilters)) return false;
          } else {
            const { staying, checkingOut } = getRoomTurnsForDate(r.id, dateISO);
            const allTurns = [...staying, ...checkingOut];
            if (!roomNameMatches && !allTurns.some(bookingMatchesSearchAndFilters)) return false;
          }
        }
        return true;
      });

      if (floorRooms.length === 0) continue;

      const floorRegRooms = floorRooms.filter((r) => !r.isDorm);
      const floorFreeCount = floorRegRooms.filter((r) => getRoomTurnsForDate(r.id, dateISO).staying.length === 0).length;

      const cardsHtml = floorRooms.map((room) => {
        if (room.isDorm) {
          const dMap = mState.rangeActive
            ? getDormOccupiedSlotsInRange(getBookings(), mState.rangeCheckin, mState.rangeCheckout, null)
            : dormMap;
          const used = Object.keys(dMap).length;
          const free = Math.max(0, 8 - used);
          const uniqueGuests = [...new Set(Object.values(dMap).map((b) => b.guestName))];
          return `<article class="m-room-card dorm-card">
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

        const { staying, checkingOut } = getRoomTurnsForDate(room.id, dateISO);
        const stayingBk = staying[0] || null;
        const checkoutBk = checkingOut.find((b) => !stayingBk || b.id !== stayingBk.id) || null;
        const isTurnover = Boolean(stayingBk && checkoutBk);
        const cardCls = isTurnover ? "turnover" : stayingBk ? "occupied" : "vacant";
        const pillCls = isTurnover ? "turnover" : stayingBk ? "occupied" : "vacant";
        const pillTxt = isTurnover ? "Trả & Nhận" : stayingBk ? (stayingBk.checkin === dateISO ? "Nhận hôm nay" : "Đang ở") : (checkoutBk ? "Trả phòng → Trống" : "Trống");

        const bookCi = mState.rangeActive ? mState.rangeCheckin : dateISO;
        const bookCo = mState.rangeActive ? mState.rangeCheckout : addDaysISO(dateISO, 1);

        return `<article class="m-room-card ${cardCls}" data-room-id="${escapeHtml(room.id)}">
          <div class="m-room-head" data-m-open-room="${escapeHtml(room.id)}">
            <div>
              <div class="m-room-title-row">
                <span class="m-room-num">Phòng ${escapeHtml(room.name)}</span>
                ${room.type === "Twins" ? `<span style="font-size:11px; color:var(--text-muted);">(Ghép được)</span>` : ""}
              </div>
              <div class="m-room-meta">${escapeHtml(room.type)} • ${escapeHtml(room.view)}</div>
            </div>
            <span class="m-status-pill ${pillCls}">${pillTxt}</span>
          </div>
          ${checkoutBk ? renderTurnCardHtml(checkoutBk, "↗ Trả phòng hôm nay", "checkout-turn") : ""}
          ${stayingBk ? renderTurnCardHtml(stayingBk, isTurnover ? "↙ Nhận phòng hôm nay" : (stayingBk.checkin === dateISO ? "↙ Nhận phòng hôm nay" : ""), isTurnover ? "checkin-turn" : "") : ""}
          ${!stayingBk ? `<div class="m-card-actions">
            <button type="button" class="m-btn m-btn-primary m-btn-block" data-m-book-room="${escapeHtml(room.id)}" data-m-ci="${escapeHtml(bookCi)}" data-m-co="${escapeHtml(bookCo)}">+ Đặt phòng${mState.rangeActive ? ` (${diffNights(bookCi, bookCo)} đêm)` : ""}</button>
            <button type="button" class="m-btn" data-m-open-room="${escapeHtml(room.id)}">Lịch phòng</button>
          </div>` : ""}
        </article>`;
      }).join("");

      htmlParts.push(`<div class="m-floor-section">
        <div class="m-floor-header">
          <span>Tầng ${fl}${fl === 1 ? " (5 phòng + Dorm nội bộ)" : ` (${floorRegRooms.length} phòng)`}</span>
          <span>Trống ${floorFreeCount}/${floorRegRooms.length}</span>
        </div>
        ${cardsHtml}
      </div>`);
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
    const list = getBookings().filter((bk) => {
      if (mState.bookingsTabFilter === "today" && !(bookingCoversDate(bk, today) || bk.checkout === today)) return false;
      if (mState.bookingsTabFilter === "upcoming" && bk.checkin <= today) return false;
      if (mState.bookingsTabFilter === "debt" && getRemaining(bk) <= 0) return false;
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
        const rem = getRemaining(bk);
        const roomLabel = room ? (room.isDorm ? `Dorm (Slot ${(bk.slots || []).join(",")})` : `Phòng ${room.name} • ${room.type}`) : bk.roomId;
        return `<div class="m-room-card ${room && room.isDorm ? "dorm-card" : "occupied"}">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
            <strong style="font-size:14px;">${escapeHtml(roomLabel)}</strong>
            <span style="font-size:11.5px; color:var(--text-muted);">${diffNights(bk.checkin, bk.checkout)} đêm</span>
          </div>
          ${renderTurnCardHtml(bk, "", "")}
          ${rem > 0 ? `<div class="m-card-actions">
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
    const activeEntries = [], checkins = [], checkouts = [], hkTasks = [], debtEntries = [];
    let buffetTotal = 0;

    regularRooms.forEach((room) => {
      const { staying, checkingOut } = getRoomTurnsForDate(room.id, dateISO);
      if (staying.length > 0) {
        const bk = staying[0];
        activeEntries.push({ room, bk });
        buffetTotal += Number(bk.guestCount) || room.defaultGuests;
        if (bk.checkin === dateISO) checkins.push({ room, bk });
        if ((bk.mergeBed && room.type === "Twins") || Number(bk.extraBed) > 0) hkTasks.push({ room, bk });
        if (getRemaining(bk) > 0) debtEntries.push({ room, bk });
      }
      checkingOut.forEach((bk) => checkouts.push({ room, bk }));
    });

    const { map: dormMap } = getDormSlotMapForDate(getBookings(), dateISO);
    const dormUsed = Object.keys(dormMap).length;
    const fin = computeMonthlyFinancials(getBookings(), year, month0);
    const health = client.runHealthCheck();

    $("m-report-content").innerHTML = `
      <div class="m-section-card">
        <h3>📅 Báo cáo ngày ${formatDateVN(dateISO)}</h3>
        <div class="m-kv-row"><span>Phòng đang ở</span><strong>${activeEntries.length} / 26 phòng (trống ${26 - activeEntries.length})</strong></div>
        <div class="m-kv-row"><span>Dorm nội bộ (Tầng 1)</span><strong>Đã đặt ${dormUsed}/8 (còn ${8 - dormUsed} slot)</strong></div>
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
        <h3>⚠️ Phòng đang ở còn công nợ (${debtEntries.length})</h3>
        ${debtEntries.length === 0
          ? `<div style="font-size:12.5px; color:var(--status-paid);">Tất cả phòng đang ở ngày này đã thanh toán đủ.</div>`
          : debtEntries.map(({ room, bk }) => `<div class="m-kv-row" data-m-edit-bk="${escapeHtml(bk.id)}" style="cursor:pointer;">
              <span><strong>P.${room.name}</strong> — ${escapeHtml(bk.guestName)}</span>
              <strong style="color:var(--status-unpaid);">Nợ ${formatVND(getRemaining(bk))} ›</strong>
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
    $("m-wrap-tour-name").style.display = chKey === "tour" ? "flex" : "none";
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

  function openMobileBookingSheet({ bookingId = null, roomId = "101", checkin = mState.selectedDate, checkout = null } = {}) {
    mState.savedScrollTop = $("m-main").scrollTop;
    showMobileBookingError("");
    mState.bookingConflictBooking = null;
    $("m-bk-conflict-banner").classList.remove("show");

    const existing = bookingId ? getBookings().find((b) => b.id === bookingId) : null;
    if (existing && existing.roomId === "DORM") {
      return openDormSheet(existing.checkin, existing.id);
    }

    mState.bookingIdempotencyKey = newIdemKey("mbk");

    if (existing) {
      mState.editingBookingId = existing.id;
      mState.editingBookingRevision = Number(existing.revision) || 1;
      $("m-bk-sheet-title").textContent = `Sửa đơn — P.${getRoomById(existing.roomId)?.name || existing.roomId}`;
      $("m-f-room").value = existing.roomId;
      $("m-f-checkin").value = existing.checkin;
      $("m-f-checkout").value = existing.checkout;
      const chKey = existing.channelKey || detectChannelKey(existing.sourceName);
      const inferredTour = existing.tourName !== undefined ? existing.tourName : (chKey === "tour" ? String(existing.sourceName || "").replace(/^Tour\s*/i, "") : "");
      setMobileChannel(chKey, { customText: chKey === "other" ? (existing.sourceName || "") : "", tourName: inferredTour });
      $("m-f-booking-code").value = existing.bookingCode || "";
      $("m-f-guest-name").value = existing.guestName || "";
      $("m-f-phone").value = existing.phone || "";
      $("m-f-guests").value = existing.guestCount || 2;
      $("m-f-total").value = formatNumberInput(existing.totalAmount);
      $("m-f-paid").value = formatNumberInput(existing.paidAmount);
      $("m-f-merge-bed").checked = Boolean(existing.mergeBed);
      $("m-f-extra-bed").value = String(existing.extraBed || 0);
      setMobileConfirmerSelect($("m-f-confirmed-by"), existing.confirmedBy);
      $("m-f-notes").value = existing.notes || "";
      $("m-bk-delete").style.display = "inline-flex";
      $("m-bk-mark-paid").style.display = getRemaining(existing) > 0 ? "inline-flex" : "none";
    } else {
      mState.editingBookingId = null;
      mState.editingBookingRevision = null;
      const room = getRoomById(roomId) || ROOMS[0];
      const draft = loadMobileDraftFor(room.id, checkin);
      $("m-bk-sheet-title").textContent = `Đặt phòng mới — P.${room.name}`;
      $("m-f-room").value = room.id;
      $("m-f-checkin").value = checkin;
      $("m-f-checkout").value = (draft && draft.checkout) || checkout || addDaysISO(checkin, 1);
      setMobileChannel((draft && draft.channelKey) || "booking", {
        customText: (draft && draft.sourceCustom) || "",
        tourName: (draft && draft.tourName) || ""
      });
      $("m-f-booking-code").value = (draft && draft.bookingCode) || "";
      $("m-f-guest-name").value = (draft && draft.guestName) || "";
      $("m-f-phone").value = (draft && draft.phone) || "";
      $("m-f-guests").value = (draft && draft.guestCount) || room.defaultGuests;
      $("m-f-total").value = (draft && draft.totalAmount) || "";
      $("m-f-paid").value = (draft && draft.paidAmount) || "";
      $("m-f-merge-bed").checked = Boolean(draft && draft.mergeBed);
      $("m-f-extra-bed").value = (draft && draft.extraBed) || "0";
      setMobileConfirmerSelect($("m-f-confirmed-by"), (draft && draft.confirmedBy) || "");
      $("m-f-notes").value = (draft && draft.notes) || "";
      $("m-bk-delete").style.display = "none";
      $("m-bk-mark-paid").style.display = "none";
      if (draft) showMobileToast("Đã khôi phục nội dung đang nhập dở");
    }

    updateMobileRoomFields();
    updateMobileNights();
    updateMobilePaymentPreview();
    $("m-sheet-booking").classList.add("open");
  }

  async function handleMobileSaveBooking(e) {
    e.preventDefault();
    if (mState.isSubmitting) return;
    mState.isSubmitting = true;
    $("m-bk-save").disabled = true;

    try {
      showMobileBookingError("");
      const chKey = mState.bookingChannelKey;
      const chObj = CHANNELS.find((c) => c.key === chKey);
      const tourName = chKey === "tour" ? $("m-f-tour-name").value.trim() : "";
      let sourceName = chObj ? chObj.label : "";
      if (chKey === "other") {
        sourceName = $("m-f-source-custom").value.trim();
        if (!sourceName) {
          showMobileBookingError("Vui lòng nhập tên nền tảng / đơn vị book.");
          return;
        }
      } else if (chKey === "tour") {
        sourceName = tourName ? `Tour ${tourName}` : "Tour";
      }

      const payload = {
        id: mState.editingBookingId || undefined,
        roomId: $("m-f-room").value,
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
        paidAmount: $("m-f-paid").value,
        paymentStatus: mState.bookingPayStatus,
        mergeBed: $("m-f-merge-bed").checked,
        extraBed: $("m-f-extra-bed").value,
        confirmedBy: $("m-f-confirmed-by").value,
        notes: $("m-f-notes").value
      };

      const res = await client.saveBooking(payload, {
        expectedRevision: mState.editingBookingId ? mState.editingBookingRevision : undefined,
        idempotencyKey: mState.editingBookingId ? undefined : mState.bookingIdempotencyKey
      });

      if (!res.ok) {
        showMobileBookingError(res.error);
        if (res.code === "CONFLICT_STALE_EDIT" && res.currentBooking) {
          showBookingConflictBanner(res.currentBooking);
        }
        // Keep typed inputs and idempotencyKey intact on offline/conflict!
        return;
      }

      clearMobileDraft();
      $("m-sheet-booking").classList.remove("open");
      renderMobileAll();
      if ($("m-sheet-room").classList.contains("open")) renderRoomDetailSheet();
      restoreScrollPosition();
      const r = getRoomById(res.booking.roomId);
      showMobileToast(res.isUpdate ? `Đã lưu cập nhật P.${r ? r.name : res.booking.roomId}` : `Đã đặt P.${r ? r.name : res.booking.roomId} cho ${res.booking.guestName}`);
    } finally {
      mState.isSubmitting = false;
      $("m-bk-save").disabled = false;
      if (typeof client.notifyIdleCheck === "function") client.notifyIdleCheck();
    }
  }

  function showBookingConflictBanner(latestBooking) {
    mState.bookingConflictBooking = latestBooking;
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
      totalAmount: parseVND($("m-f-total").value),
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
    $("m-df-tour-wrap").style.display = (src === "tour" || src === "other") ? "flex" : "none";
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
      $("m-df-checkin").value = ex.checkin;
      $("m-df-checkout").value = ex.checkout;
      mState.dormSelectedSlots = [...(ex.slots || [1])];
      const srcKey = ["tour", "walkin", "zalo", "other"].includes(ex.channelKey) ? ex.channelKey : "tour";
      $("m-df-source").value = srcKey;
      $("m-df-tour").value = ex.tourName || (srcKey === "other" ? ex.sourceName : String(ex.sourceName || "").replace(/^Tour\s*/i, ""));
      $("m-df-code").value = ex.bookingCode || "";
      $("m-df-guest").value = ex.guestName || "";
      $("m-df-phone").value = ex.phone || "";
      $("m-df-total").value = formatNumberInput(ex.totalAmount);
      $("m-df-paid").value = formatNumberInput(ex.paidAmount);
      setMobileConfirmerSelect($("m-df-confirmed-by"), ex.confirmedBy);
      $("m-df-notes").value = ex.notes || "";
    } else {
      mState.editingDormId = null;
      mState.editingDormRevision = null;
      const ci = mState.dormDate;
      const co = mState.rangeActive ? mState.rangeCheckout : addDaysISO(ci, 1);
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
      if (chKey === "tour") { tourName = tourOrCustom; sourceName = tourOrCustom ? `Tour ${tourOrCustom}` : "Tour"; }
      else if (chKey === "walkin") sourceName = "Nội bộ / Khách lẻ";
      else if (chKey === "zalo") sourceName = "Zalo";
      else sourceName = tourOrCustom || "Nguồn khác";

      const res = await client.saveBooking({
        id: mState.editingDormId || undefined,
        roomId: "DORM",
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

  function renderMobileAll() {
    renderSyncStatus();
    if (mState.activeTab === "schedule") renderScheduleView();
    else if (mState.activeTab === "bookings") renderBookingsTab();
    else if (mState.activeTab === "report") renderReportTab();
    if ($("m-sheet-room").classList.contains("open")) renderRoomDetailSheet();
    if ($("m-sheet-dorm").classList.contains("open") && mState.dormMode === "board") renderMobileDormBoard();
    if ($("m-sheet-history").classList.contains("open")) renderMobileHistorySheet();
  }

  function switchTab(tabName) {
    mState.activeTab = tabName;
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
    // Bottom nav
    document.querySelectorAll("[data-m-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.mTab));
    });

    // Offline retry button
    $("m-btn-retry-sync").addEventListener("click", () => client.pullLatest());
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

    // Delegated clicks inside Schedule, Bookings, Report, and Room Detail
    $("m-main").addEventListener("click", (e) => {
      if (e.target.closest("#m-stat-dorm-card")) return openDormSheet(mState.selectedDate);
      const dormBtn = e.target.closest("[data-m-open-dorm]");
      if (dormBtn) return openDormSheet(dormBtn.dataset.mOpenDorm);
      const bookBtn = e.target.closest("[data-m-book-room]");
      if (bookBtn) return openMobileBookingSheet({ roomId: bookBtn.dataset.mBookRoom, checkin: bookBtn.dataset.mCi, checkout: bookBtn.dataset.mCo });
      const editBk = e.target.closest("[data-m-edit-bk]");
      if (editBk) return openMobileBookingSheet({ bookingId: editBk.dataset.mEditBk });
      const openRoom = e.target.closest("[data-m-open-room]");
      if (openRoom) return openRoomDetailSheet(openRoom.dataset.mOpenRoom);
    });

    // Bookings tab controls
    $("m-btn-quick-new-booking").addEventListener("click", () => openMobileBookingSheet({ roomId: "101", checkin: mState.selectedDate }));
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
    $("m-f-room").addEventListener("change", () => { updateMobileRoomFields(); saveMobileDraft(); });
    $("m-f-checkin").addEventListener("change", () => {
      if (!$("m-f-checkout").value || $("m-f-checkout").value <= $("m-f-checkin").value) {
        $("m-f-checkout").value = addDaysISO($("m-f-checkin").value, 1);
      }
      updateMobileNights();
      saveMobileDraft();
    });
    $("m-f-checkout").addEventListener("change", () => { updateMobileNights(); saveMobileDraft(); });
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
        if (inp === $("m-f-total") && mState.bookingPayStatus === "paid") $("m-f-paid").value = inp.value;
        updateMobilePaymentPreview();
        saveMobileDraft();
      });
    });
    $("m-bk-mark-paid").addEventListener("click", () => {
      setMobilePayTab("paid", true);
      showMobileToast("Đã điền thu đủ — chạm Lưu thông tin");
    });
    $("m-bk-form").addEventListener("input", saveMobileDraft);
    $("m-bk-form").addEventListener("submit", handleMobileSaveBooking);
    $("m-bk-reload-latest").addEventListener("click", () => {
      if (mState.editingBookingId) openMobileBookingSheet({ bookingId: mState.editingBookingId });
    });
    $("m-bk-dismiss-conflict").addEventListener("click", () => {
      // Allow user to inspect & keep editing; update revision ONLY if user explicitly reloads
      $("m-bk-conflict-banner").classList.remove("show");
    });
    $("m-bk-delete").addEventListener("click", async () => {
      if (!mState.editingBookingId) return;
      const bk = getBookings().find((b) => b.id === mState.editingBookingId);
      if (!bk || !confirm(`Xóa đặt phòng của "${bk.guestName}" tại P.${getRoomById(bk.roomId)?.name || bk.roomId}?`)) return;
      const res = await client.deleteBooking(bk.id, { expectedRevision: mState.editingBookingRevision });
      if (!res.ok) return showMobileBookingError(res.error);
      $("m-sheet-booking").classList.remove("open");
      renderMobileAll();
      restoreScrollPosition();
      showMobileToast("Đã xóa đặt phòng (có thể khôi phục trong Lịch sử)");
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
    $("m-dorm-reload-latest").addEventListener("click", () => {
      if (mState.editingDormId) openMobileDormForm({ bookingId: mState.editingDormId });
    });
    $("m-dorm-delete").addEventListener("click", async () => {
      if (!mState.editingDormId) return;
      const bk = getBookings().find((b) => b.id === mState.editingDormId);
      if (!bk || !confirm(`Xóa lượt đặt Dorm của "${bk.guestName}"?`)) return;
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

    // More Tab actions (100% PC feature parity)
    $("m-menu-history").addEventListener("click", () => { renderMobileHistorySheet(); $("m-sheet-history").classList.add("open"); });
    $("m-menu-rollback").addEventListener("click", async () => {
      if (!confirm("Hoàn tác dữ liệu về trạng thái ngay trước thay đổi gần nhất?")) return;
      const res = await client.rollbackLastChange();
      if (!res.ok) return alert(res.error);
      renderMobileAll();
      showMobileToast(`Đã hoàn tác (${res.bookings.length} đơn)`);
    });
    $("m-menu-export-csv").addEventListener("click", () => {
      const csv = generateCsvContent(getBookings());
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `lich-dat-phong-${getTodayISO()}.csv`; a.click();
      URL.revokeObjectURL(url);
      showMobileToast("Đã xuất file Excel (CSV)");
    });
    $("m-menu-backup-json").addEventListener("click", () => {
      const payload = { exportedAt: new Date().toISOString(), version: 2, hotel: "Dongvan Ville du H'mong Hotel", bookings: getBookings(), auditLogs: client.getAuditLogs() };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `backup-dongvan-hotel-${getTodayISO()}.json`; a.click();
      URL.revokeObjectURL(url);
      showMobileToast("Đã tải file sao lưu JSON");
    });
    $("m-input-restore-json").addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const res = await client.restoreFromImport(reader.result);
        if (!res.ok) return alert("Không thể khôi phục:\n" + res.error);
        renderMobileAll();
        showMobileToast(`Đã khôi phục ${res.bookings.length} lượt đặt phòng`);
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
      if (!confirm("Khôi phục danh sách đặt phòng mẫu?")) return;
      const res = await client.resetToSample();
      if (!res.ok) return alert(res.error);
      renderMobileAll();
      showMobileToast("Đã khôi phục dữ liệu mẫu");
    });
    $("m-menu-switch-pc").addEventListener("click", () => {
      document.body.dataset.viewMode = "pc";
    });
    $("m-menu-logout").addEventListener("click", async () => {
      if (!confirm("Đăng xuất tài khoản lễ tân trên điện thoại này?")) return;
      await client.logout();
      renderSyncStatus();
    });

    // Register mobile busy check so live A -> B auto-updates NEVER interrupt active booking or Dorm typing
    if (typeof client.registerBusyCheck === "function") {
      client.registerBusyCheck(() =>
        mState.isSubmitting ||
        $("m-sheet-booking").classList.contains("open") ||
        ($("m-sheet-dorm").classList.contains("open") && mState.dormMode === "form")
      );
    }

    // Realtime subscription from shared PMSClient (SSE + reconnect catch-up)
    client.subscribe(({ type, state }) => {
      renderSyncStatus();
      if (type === "status" || type === "version" || type === "update_pending" || type === "update_applying" || type === "auth_required") return;

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

      renderMobileAll();
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
  }

  bootMobile();
})();
