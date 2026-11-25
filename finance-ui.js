/* ============================================================================
   DONGVAN VILLE DU H'MONG HOTEL — PHASE 1 FINANCE & ACCOUNTING UI MODULE
   Handles:
   1. In-Booking Authoritative Finance Panel (Charges breakdown, multi-payment
      collection, group shared ledger, services, adjustments, manager-approved
      refunds, cancel-with-deposit handling, pending-sync & stale-balance UX)
   2. Thu tiền & Công nợ khách (#receivables-modal) — AR filters, as-of date,
      drilldown, legacy migration & dry-run verification, CSV export
   3. Sổ quỹ & Đối soát (#cashbook-modal) — Per-fund balances, fund transfers,
      opening balances, physical/statement reconciliation checks (zero plug),
      voucher reconciliation, legacy fund/date assignment, sync log, CSV export
   4. Tiền thực thu trong tháng (#monthly-receipts-modal) — Calendar KPI drilldown
   ============================================================================ */

(function initHotelFinanceUI(root) {
  "use strict";

  const Core = root.PMSCore;
  if (!Core) {
    console.error("PMSCore must be loaded before finance-ui.js");
    return;
  }

  const store = root.pmsClient || (root.PMSClient && root.PMSClient.createUnifiedClient());
  if (!store) return;

  const {
    FINANCE_FUNDS,
    PAYMENT_METHODS,
    REFUND_CATEGORIES,
    getVietnamTodayISO,
    formatDateVN,
    parseVND,
    parseSignedVND,
    formatVND,
    formatSignedVND,
    formatNumberInput,
    escapeHtml,
    computeBookingFinancialSummary,
    computeReceivablesReport,
    computeCashbookReport,
    computeCalendarFinanceKPIs,
    computeSupplierPayablesReport,
    generateReceivablesCsvContent,
    generateCashbookCsvContent,
    generateSupplierPayablesCsvContent,
    getFinanceFundById,
    getPaymentMethodMeta
  } = Core;

  const uiState = {
    currentBookingId: null,
    bookingInlineForm: null, // null | "collect" | "service" | "adjust" | "refund" | "cancel"
    bookingStaleConflict: null, // { message, currentBalance, pendingPayload }
    arTab: "list", // "list" | "legacy"
    arDueFilter: "all", // "all" | "debt" | "due" | "overdue" | "no_due_date"
    arExpandedKeys: new Set(),
    arQuickCollectKey: null,
    arLastMigrationResult: null,
    cbTab: "ledger", // "ledger" | "legacy" | "logs"
    cbDrawer: null, // null | "transfer" | "opening" | "reconcile" | "adjust"
    monthlyReceiptsYear: null,
    monthlyReceiptsMonth0: null,
    // Phase 2: Supplier Invoices & Accounts Payable
    apFormOpen: false,
    apEditId: null,
    apFormAttachment: null,
    apExpandedIds: new Set(),
    apPayInvoiceId: null,
    apFocusInvoiceId: null,
    apStaleConflict: null // { invoiceId, code, message, currentRemaining, pendingPayload }
  };

  const $ = (id) => document.getElementById(id);

  function can(permission) {
    return typeof store.can === "function" ? store.can(permission) : true;
  }

  function showToast(msg, type = "info") {
    const toastEl = $("toast");
    if (!toastEl) return;
    toastEl.textContent = String(msg || "");
    toastEl.className = "toast open" + (type === "error" ? " error" : type === "success" ? " success" : "");
    clearTimeout(toastEl._finTimer);
    toastEl._finTimer = setTimeout(() => {
      toastEl.classList.remove("open");
    }, 3600);
  }

  function getBookings() {
    return typeof store.getBookings === "function" ? store.getBookings() : [];
  }

  function getFinanceState() {
    const f = typeof store.getFinanceState === "function" ? store.getFinanceState() : null;
    return f || Core.createDefaultFinanceState();
  }

  function getOperatingCostsState() {
    const c = typeof store.getOperatingCosts === "function" ? store.getOperatingCosts() : null;
    return c || Core.createDefaultOperatingCostsState();
  }

  function formatDateTimeVN(iso) {
    if (!iso) return "—";
    const parts = Core.toVietnamParts(iso);
    if (!parts) return String(iso).slice(0, 16);
    return `${Core.pad2(parts.day)}/${Core.pad2(parts.month)}/${parts.year} ${Core.pad2(parts.hours)}:${Core.pad2(parts.minutes)}`;
  }

  function makeIdempotencyKey(prefix) {
    return `ftx_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function triggerDownloadCsv(filename, csvText) {
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 150);
  }

  function jumpToBooking(bookingId) {
    if (!bookingId) return;
    closeReceivables();
    closeCashbook();
    closePayables();
    closeMonthlyReceipts();
    const isMobile = document.body.classList.contains("is-mobile-ui") || window.innerWidth <= 768;
    if (isMobile && root.PMSMobileApi && typeof root.PMSMobileApi.openBooking === "function") {
      root.PMSMobileApi.openBooking(bookingId);
      return;
    }
    if (root.PMSPcApi && typeof root.PMSPcApi.openBooking === "function") {
      root.PMSPcApi.openBooking(bookingId);
    }
  }

  function notifyHostUI() {
    if (root.PMSPcApi && typeof root.PMSPcApi.syncFromStore === "function") {
      root.PMSPcApi.syncFromStore();
    }
    updateSidebarBadges();
  }

  /* ============================================================================
     0. PENDING UNCONFIRMED INTENTS BAR (Offline / Dropped Response Safety)
     ============================================================================ */

  function renderPendingIntentsMarkup() {
    const pending = typeof store.getPendingFinanceIntents === "function" ? store.getPendingFinanceIntents() : [];
    if (!pending.length) return "";
    const rowsHtml = pending.map((item) => `
      <div class="fin-pending-row">
        <div>
          <strong>Chưa xác nhận — chờ đồng bộ:</strong> ${escapeHtml(item.label || item.idempotencyKey)}
          <span style="opacity:0.8; font-size:11px;">(${escapeHtml(formatDateTimeVN(item.createdAt))} • mã ${escapeHtml(item.idempotencyKey.slice(-10))})</span>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" type="button" data-fin-retry-key="${escapeHtml(item.idempotencyKey)}">↻ Kiểm tra &amp; đồng bộ lại</button>
          <button class="btn btn-sm" type="button" data-fin-dismiss-key="${escapeHtml(item.idempotencyKey)}">Bỏ nhắc</button>
        </div>
      </div>
    `).join("");
    return `
      <div style="font-weight:800;">⚠️ Có ${pending.length} giao dịch chưa nhận phản hồi từ máy chủ (KHÔNG tự ghi nhận hoàn tất để tránh tạo chứng từ trùng)</div>
      ${rowsHtml}
    `;
  }

  function syncPendingBars() {
    const html = renderPendingIntentsMarkup();
    ["ar-pending-intents-bar", "cb-pending-intents-bar", "ap-pending-intents-bar"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (html) {
        el.innerHTML = html;
        el.style.display = "flex";
      } else {
        el.innerHTML = "";
        el.style.display = "none";
      }
    });
  }

  async function handleRetryPendingIntent(idemKey) {
    if (!idemKey || typeof store.retryPendingFinanceIntent !== "function") return;
    showToast("Đang kiểm tra trạng thái chứng từ trên máy chủ...", "info");
    const res = await store.retryPendingFinanceIntent(idemKey);
    if (res && res.ok) {
      if (res.alreadyCommitted || res.idempotentReplay) {
        showToast(`Máy chủ đã ghi nhận chứng từ ${res.transaction ? res.transaction.voucherCode : ""} trước đó — không tạo trùng!`, "success");
      } else {
        showToast(`Đã đồng bộ thành công chứng từ ${res.transaction ? res.transaction.voucherCode : ""}.`, "success");
      }
      notifyHostUI();
      refreshOpenModals();
      return;
    }
    showToast((res && res.error) || "Chưa kết nối lại được máy chủ — giao dịch vẫn ở trạng thái Chưa xác nhận.", "error");
    syncPendingBars();
    if (uiState.currentBookingId) renderBookingFinancePanel(uiState.currentBookingId);
  }

  /* ============================================================================
     1. IN-BOOKING AUTHORITATIVE FINANCE PANEL (#pc-booking-finance-panel)
     ============================================================================ */

  function hideBookingFinancePanel() {
    uiState.currentBookingId = null;
    uiState.bookingInlineForm = null;
    uiState.bookingStaleConflict = null;
    const panel = $("pc-booking-finance-panel");
    if (panel) {
      panel.style.display = "none";
      panel.innerHTML = "";
    }
  }

  function renderBookingFinancePanel(bookingId) {
    const panel = $("pc-booking-finance-panel");
    if (!panel) return;
    if (!bookingId || !can("finance:ar_read")) {
      hideBookingFinancePanel();
      return;
    }

    const bookings = getBookings();
    const booking = bookings.find((b) => b.id === bookingId);
    if (!booking) {
      hideBookingFinancePanel();
      return;
    }

    if (uiState.currentBookingId !== bookingId) {
      uiState.currentBookingId = bookingId;
      uiState.bookingInlineForm = null;
      uiState.bookingStaleConflict = null;
    }

    const fState = getFinanceState();
    const summary = computeBookingFinancialSummary(booking, bookings, fState);
    if (!summary) {
      hideBookingFinancePanel();
      return;
    }

    // Keep legacy paidAmount/totalAmount fields visually synced when booking modal stays open after a ledger action
    const fieldTotal = $("field-total-amount");
    const fieldPaid = $("field-paid-amount");
    if (fieldTotal && document.activeElement !== fieldTotal) {
      fieldTotal.value = formatNumberInput(booking.totalAmount);
    }
    if (fieldPaid && document.activeElement !== fieldPaid) {
      fieldPaid.value = formatNumberInput(booking.paidAmount);
    }

    const isManager = can("finance:approve_refund");
    const canCollect = can("finance:collect");
    const canWriteBooking = can("bookings:write");
    const isCancelled = Core.isBookingCancelled(booking);
    const pendingHtml = renderPendingIntentsMarkup();
    const stale = uiState.bookingStaleConflict;

    const statusBadge = summary.arStatus === "paid"
      ? '<span class="fin-pill ok">✓ Đã thu đủ</span>'
      : summary.arStatus === "overpaid"
        ? `<span class="fin-pill info">Khách trả thừa ${escapeHtml(formatVND(summary.overpaid))}</span>`
        : summary.arStatus === "cancelled_deposit"
          ? `<span class="fin-pill amber">Đơn hủy • Đang giữ cọc ${escapeHtml(formatVND(summary.cancelledHeldDeposit))}</span>`
          : summary.arStatus === "cancelled_settled"
            ? '<span class="fin-pill muted">Đơn đã hủy</span>'
            : `<span class="fin-pill warn">Còn phải thu ${escapeHtml(formatVND(summary.remaining))}</span>`;

    const groupBanner = summary.isGroupSharedLedger
      ? `<div class="fin-group-shared-note">
          👥 <strong>Sổ thu tiền dùng chung cả đoàn ${escapeHtml(summary.groupCodeDisplay)}</strong> (${summary.roomCount} phòng: ${escapeHtml(summary.roomLabel)}) — mọi lần thu/hoàn tiền ghi đúng 1 lần cho cả đoàn, không nhân bản vào từng phòng.
         </div>`
      : "";

    const cancelledBanner = isCancelled
      ? `<div class="fin-cancelled-banner">
          <div>
            <strong>🚫 Đơn đặt phòng này đã HỦY</strong> (phòng đã được giải phóng trên Lịch phòng).
            ${booking.cancelReason ? ` Lý do: <em>${escapeHtml(booking.cancelReason)}</em>.` : ""}
          </div>
          ${summary.cancelledHeldDeposit > 0 ? `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
              <span>💰 Đang giữ cọc của khách: <strong>${escapeHtml(formatVND(summary.cancelledHeldDeposit))}</strong> — cần quyết định hoàn cọc hay giữ cọc.</span>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                ${isManager ? `
                  <button type="button" class="btn btn-sm btn-primary" data-fin-panel-action="refund">↩ Hoàn cọc cho khách</button>
                  <button type="button" class="btn btn-sm" data-fin-retain-deposit="1">🔒 Giữ cọc theo chính sách</button>
                ` : `<span style="font-size:11.5px;">(Cần Quản lý duyệt hoàn/giữ cọc)</span>`}
              </div>
            </div>
          ` : (booking.retainedDepositAmount > 0 ? `<div>🔒 Đã quyết định giữ cọc theo chính sách: <strong>${escapeHtml(formatVND(booking.retainedDepositAmount))}</strong>.</div>` : "")}
         </div>`
      : "";

    const staleBanner = stale
      ? `<div class="fin-stale-banner" id="fin-stale-conflict-banner">
          <div><strong>⚠️ Dữ liệu số dư vừa thay đổi từ thiết bị khác!</strong> ${escapeHtml(stale.message)}</div>
          <div>Số dư công nợ mới nhất hiện tại: <strong>${escapeHtml(formatVND(stale.currentBalance))}</strong></div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-primary" id="btn-fin-confirm-stale-retry">✓ Xác nhận thu tiếp với số dư mới (${escapeHtml(formatVND(stale.pendingPayload.amount))})</button>
            <button type="button" class="btn btn-sm" id="btn-fin-cancel-stale">Hủy thao tác</button>
          </div>
         </div>`
      : "";

    const servicesListHtml = (booking.services || []).length > 0
      ? `<div style="font-size:11.5px; color:var(--text-secondary);">
          <strong>Dịch vụ P.${escapeHtml(booking.roomId)}:</strong>
          ${(booking.services || []).map((sv, idx) => `
            <span class="fin-pill muted" style="margin:2px 4px 2px 0;">
              ${escapeHtml(sv.name)} (${escapeHtml(formatVND(sv.amount))})
              ${canWriteBooking ? `<button type="button" data-fin-remove-service="${idx}" style="border:none;background:none;color:inherit;cursor:pointer;font-weight:800;padding:0 2px;" title="Xóa dịch vụ">✕</button>` : ""}
            </span>
          `).join("")}
         </div>`
      : "";

    const adjustmentsListHtml = (booking.adjustments || []).length > 0
      ? `<div style="font-size:11.5px; color:var(--text-secondary);">
          <strong>Điều chỉnh giá trị P.${escapeHtml(booking.roomId)}:</strong>
          ${(booking.adjustments || []).map((adj) => `
            <span class="fin-pill amber" style="margin:2px 4px 2px 0;">
              ${escapeHtml(formatSignedVND(adj.amount))} — ${escapeHtml(adj.reason)} ${adj.approvedBy ? `(Duyệt: ${escapeHtml(adj.approvedBy)})` : ""}
            </span>
          `).join("")}
         </div>`
      : "";

    const inlineFormHtml = renderBookingInlineForm(booking, summary, isManager);

    const txRowsHtml = summary.allTransactions.length > 0
      ? `<div class="fin-table-wrap">
          <table class="fin-tx-table">
            <thead>
              <tr>
                <th>Mã CT</th>
                <th>Ngày thực nhận</th>
                <th>Loại / Hình thức</th>
                <th>Quỹ</th>
                <th class="num">Số tiền</th>
                <th>Người thu / Duyệt</th>
                <th>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              ${summary.allTransactions.map((tx) => {
                const isRef = tx.txType === "customer_refund";
                const isLeg = tx.txType === "legacy_payment";
                const signedAmt = isRef ? -parseVND(tx.amount) : parseVND(tx.amount);
                const typeBadge = isRef
                  ? '<span class="fin-pill warn">Hoàn tiền</span>'
                  : isLeg
                    ? '<span class="fin-pill amber">Chuyển tiếp</span>'
                    : '<span class="fin-pill ok">Thu tiền</span>';
                const dateDisplay = tx.receivedDate
                  ? `${escapeHtml(formatDateVN(tx.receivedDate))}<div style="font-size:10.5px;color:var(--text-muted);">Ghi sổ: ${escapeHtml(formatDateTimeVN(tx.recordedAt))}</div>`
                  : '<span class="fin-pill amber">Cần đối soát ngày</span>';
                return `
                  <tr>
                    <td>
                      <span class="fin-voucher-code">${escapeHtml(tx.voucherCode)}</span>
                      ${tx.linkedVoucherCode ? `<div style="font-size:10.5px;color:var(--text-muted);">Gốc: ${escapeHtml(tx.linkedVoucherCode)}</div>` : ""}
                    </td>
                    <td>${dateDisplay}</td>
                    <td>${typeBadge} <span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(getPaymentMethodMeta(tx.paymentMethod).label)}</span></td>
                    <td>${escapeHtml(getFinanceFundById(tx.fundId).shortName)}</td>
                    <td class="num" style="font-weight:800; color:${isRef ? "var(--status-unpaid,#dc2626)" : "var(--status-paid,#15803d)"};">${escapeHtml(formatSignedVND(signedAmt))}</td>
                    <td>
                      ${escapeHtml(tx.operator || "—")}
                      ${tx.approvedBy ? `<div style="font-size:10.5px;color:var(--text-muted);">Duyệt: ${escapeHtml(tx.approvedBy)}</div>` : ""}
                    </td>
                    <td>${escapeHtml(tx.reason ? `${tx.reason}${tx.note ? ` — ${tx.note}` : ""}` : (tx.note || "—"))}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
         </div>`
      : `<div class="fin-empty" style="padding:10px;">Chưa có phiếu thu nào trong sổ giao dịch cho ${summary.isGroupSharedLedger ? "đoàn" : "đơn"} này.</div>`;

    panel.innerHTML = `
      <div class="fin-panel-head">
        <div class="fin-panel-title">
          <span>💳 Sổ thu tiền &amp; Công nợ ${summary.isGroupSharedLedger ? `Đoàn ${escapeHtml(summary.groupCodeDisplay)}` : `P.${escapeHtml(booking.roomId)}`}</span>
          ${statusBadge}
        </div>
        <button type="button" class="btn btn-sm" data-fin-open-ar-search="${escapeHtml(summary.groupCodeDisplay || booking.guestName || "")}">Xem trong Công nợ ↗</button>
      </div>
      ${pendingHtml ? `<div class="fin-pending-bar">${pendingHtml}</div>` : ""}
      ${staleBanner}
      ${groupBanner}
      ${cancelledBanner}
      <div class="fin-breakdown-grid">
        <div class="fin-stat-box">
          <span class="fin-stat-lbl">Tiền phòng</span>
          <span class="fin-stat-val">${escapeHtml(formatVND(summary.roomAmount))}</span>
        </div>
        <div class="fin-stat-box">
          <span class="fin-stat-lbl">Dịch vụ / Phụ thu</span>
          <span class="fin-stat-val">${escapeHtml(formatVND(summary.servicesTotal))}</span>
        </div>
        <div class="fin-stat-box">
          <span class="fin-stat-lbl">Điều chỉnh giảm/tăng</span>
          <span class="fin-stat-val">${escapeHtml(formatSignedVND(summary.adjustmentsTotal))}</span>
        </div>
        <div class="fin-stat-box accent">
          <span class="fin-stat-lbl">Tổng phải thanh toán</span>
          <span class="fin-stat-val" id="fin-bk-total-payable">${escapeHtml(formatVND(summary.totalPayable))}</span>
        </div>
        <div class="fin-stat-box">
          <span class="fin-stat-lbl">Đã thu ròng (${summary.allTransactions.length} phiếu)</span>
          <span class="fin-stat-val ok" id="fin-bk-net-paid">${escapeHtml(formatVND(summary.netPaid))}</span>
          ${summary.totalRefunded > 0 ? `<span class="fin-stat-sub">Thu ${escapeHtml(formatVND(summary.grossPaid))} • Hoàn ${escapeHtml(formatVND(summary.totalRefunded))}</span>` : ""}
        </div>
        <div class="fin-stat-box">
          <span class="fin-stat-lbl">${summary.overpaid > 0 ? (isCancelled ? "Cọc đang giữ" : "Khách trả thừa") : "Còn phải thu"}</span>
          <span class="fin-stat-val ${summary.overpaid > 0 ? "info" : (summary.remaining > 0 ? "warn" : "ok")}" id="fin-bk-remaining">
            ${escapeHtml(formatVND(summary.overpaid > 0 ? summary.overpaid : summary.remaining))}
          </span>
        </div>
      </div>
      ${servicesListHtml}
      ${adjustmentsListHtml}
      <div class="fin-panel-actions">
        ${canCollect && !isCancelled ? `<button type="button" class="btn btn-sm btn-primary" id="btn-fin-open-collect" data-fin-panel-action="collect">+ Thu tiền / Cọc</button>` : ""}
        ${canWriteBooking && !isCancelled ? `<button type="button" class="btn btn-sm" id="btn-fin-open-service" data-fin-panel-action="service">+ Dịch vụ</button>` : ""}
        ${isManager && !isCancelled ? `<button type="button" class="btn btn-sm" id="btn-fin-open-adjust" data-fin-panel-action="adjust">± Điều chỉnh giá trị</button>` : ""}
        ${isManager && summary.netPaid > 0 ? `<button type="button" class="btn btn-sm" id="btn-fin-open-refund" data-fin-panel-action="refund">↩ Hoàn tiền</button>` : ""}
        ${canWriteBooking && !isCancelled ? `<button type="button" class="btn btn-sm btn-danger" id="btn-fin-open-cancel" data-fin-panel-action="cancel">✕ Hủy đơn</button>` : ""}
      </div>
      ${inlineFormHtml}
      ${txRowsHtml}
    `;

    panel.style.display = "flex";
  }

  function renderBookingInlineForm(booking, summary, isManager) {
    const mode = uiState.bookingInlineForm;
    if (!mode) return "";
    const todayVN = getVietnamTodayISO();

    if (mode === "collect") {
      const defaultAmt = summary.remaining > 0 ? formatNumberInput(summary.remaining) : "";
      return `
        <div class="fin-inline-form" id="fin-inline-collect-form">
          <div class="fin-inline-form-title">
            <span>💰 Ghi nhận phiếu thu ${summary.isGroupSharedLedger ? `cho cả đoàn ${escapeHtml(summary.groupCodeDisplay)}` : `P.${escapeHtml(booking.roomId)}`}</span>
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Đóng</button>
          </div>
          <div id="fin-inline-error" class="form-error"></div>
          <div class="form-grid-3">
            <div class="field">
              <label for="fin-pay-amount">Số tiền thu (VNĐ) *</label>
              <input id="fin-pay-amount" class="input" type="text" inputmode="numeric" value="${escapeHtml(defaultAmt)}" placeholder="VD: 3.000.000" />
            </div>
            <div class="field">
              <label for="fin-pay-date">Ngày thực nhận (VN) *</label>
              <input id="fin-pay-date" class="input" type="date" value="${escapeHtml(todayVN)}" />
            </div>
            <div class="field">
              <label for="fin-pay-method">Hình thức thanh toán *</label>
              <select id="fin-pay-method" class="select">
                ${PAYMENT_METHODS.map((m) => `<option value="${escapeHtml(m.key)}">${escapeHtml(m.label)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="fin-pay-fund">Quỹ / Tài khoản nhận tiền *</label>
              <select id="fin-pay-fund" class="select">
                ${FINANCE_FUNDS.filter((f) => !f.isLegacyBucket).map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="fin-pay-note">Ghi chú (số lệnh CK, đặt cọc đợt 1...)</label>
              <input id="fin-pay-note" class="input" type="text" placeholder="VD: Cọc lần 1 qua VietinBank..." />
            </div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Hủy</button>
            <button type="button" class="btn btn-sm btn-primary" id="btn-fin-submit-collect">✓ Xác nhận thu tiền</button>
          </div>
        </div>
      `;
    }

    if (mode === "service") {
      return `
        <div class="fin-inline-form" id="fin-inline-service-form">
          <div class="fin-inline-form-title">
            <span>🛍️ Thêm dịch vụ phát sinh (P.${escapeHtml(booking.roomId)})</span>
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Đóng</button>
          </div>
          <div id="fin-inline-error" class="form-error"></div>
          <div class="form-grid-3">
            <div class="field">
              <label for="fin-svc-name">Tên dịch vụ *</label>
              <input id="fin-svc-name" class="input" type="text" placeholder="VD: Thuê xe máy, Giặt là, Minibar..." />
            </div>
            <div class="field">
              <label for="fin-svc-amount">Thành tiền (VNĐ) *</label>
              <input id="fin-svc-amount" class="input" type="text" inputmode="numeric" placeholder="VD: 200.000" />
            </div>
            <div class="field">
              <label for="fin-svc-date">Ngày phát sinh</label>
              <input id="fin-svc-date" class="input" type="date" value="${escapeHtml(todayVN)}" />
            </div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Hủy</button>
            <button type="button" class="btn btn-sm btn-primary" id="btn-fin-submit-service">✓ Lưu dịch vụ</button>
          </div>
        </div>
      `;
    }

    if (mode === "adjust" && isManager) {
      return `
        <div class="fin-inline-form" id="fin-inline-adjust-form">
          <div class="fin-inline-form-title">
            <span>± Điều chỉnh giá trị đơn P.${escapeHtml(booking.roomId)} (Quyền Quản lý)</span>
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Đóng</button>
          </div>
          <div id="fin-inline-error" class="form-error"></div>
          <div class="form-grid-3">
            <div class="field">
              <label for="fin-adj-amount">Số tiền điều chỉnh (âm = giảm giá) *</label>
              <input id="fin-adj-amount" class="input" type="text" placeholder="VD: -300.000 hoặc 200.000" />
            </div>
            <div class="field">
              <label for="fin-adj-date">Ngày hiệu lực</label>
              <input id="fin-adj-date" class="input" type="date" value="${escapeHtml(todayVN)}" />
            </div>
            <div class="field">
              <label for="fin-adj-reason">Lý do điều chỉnh *</label>
              <input id="fin-adj-reason" class="input" type="text" placeholder="VD: Giảm dịch vụ / Chiết khấu khách quen..." />
            </div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Hủy</button>
            <button type="button" class="btn btn-sm btn-primary" id="btn-fin-submit-adjust">✓ Duyệt &amp; Áp dụng điều chỉnh</button>
          </div>
        </div>
      `;
    }

    if (mode === "refund" && isManager) {
      const paymentVouchers = summary.allTransactions.filter((t) => t.txType === "customer_payment" || t.txType === "legacy_payment");
      const defaultRefund = summary.overpaid > 0 ? formatNumberInput(summary.overpaid) : "";
      return `
        <div class="fin-inline-form" id="fin-inline-refund-form">
          <div class="fin-inline-form-title">
            <span>↩ Lập phiếu hoàn tiền khách (Quyền Quản lý duyệt)</span>
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Đóng</button>
          </div>
          <div id="fin-inline-error" class="form-error"></div>
          <div class="form-grid-3">
            <div class="field">
              <label for="fin-ref-amount">Số tiền hoàn (VNĐ) *</label>
              <input id="fin-ref-amount" class="input" type="text" inputmode="numeric" value="${escapeHtml(defaultRefund)}" placeholder="VD: 500.000" />
            </div>
            <div class="field">
              <label for="fin-ref-date">Ngày chi hoàn (VN) *</label>
              <input id="fin-ref-date" class="input" type="date" value="${escapeHtml(todayVN)}" />
            </div>
            <div class="field">
              <label for="fin-ref-category">Phân loại hoàn tiền *</label>
              <select id="fin-ref-category" class="select">
                ${Object.values(REFUND_CATEGORIES).map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="form-grid-3">
            <div class="field">
              <label for="fin-ref-linked">Liên kết chứng từ gốc</label>
              <select id="fin-ref-linked" class="select">
                <option value="">-- Chọn phiếu thu gốc --</option>
                ${paymentVouchers.map((v) => `<option value="${escapeHtml(v.id)}" data-vcode="${escapeHtml(v.voucherCode)}">${escapeHtml(v.voucherCode)} (${escapeHtml(formatVND(v.amount))})</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="fin-ref-fund">Chi từ quỹ *</label>
              <select id="fin-ref-fund" class="select">
                ${FINANCE_FUNDS.filter((f) => !f.isLegacyBucket).map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="fin-ref-reason">Lý do hoàn tiền *</label>
              <input id="fin-ref-reason" class="input" type="text" placeholder="VD: Khách hủy sớm / Trả thừa..." />
            </div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Hủy</button>
            <button type="button" class="btn btn-sm btn-danger" id="btn-fin-submit-refund">✓ Duyệt &amp; Lập phiếu hoàn tiền</button>
          </div>
        </div>
      `;
    }

    if (mode === "cancel") {
      return `
        <div class="fin-inline-form" id="fin-inline-cancel-form" style="border-color:#dc2626;">
          <div class="fin-inline-form-title">
            <span>🚫 Hủy đơn P.${escapeHtml(booking.roomId)} (Giải phóng phòng &amp; giữ vết lịch sử cọc)</span>
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Đóng</button>
          </div>
          <div id="fin-inline-error" class="form-error"></div>
          <div style="font-size:12px; color:var(--text-secondary);">
            Phòng P.${escapeHtml(booking.roomId)} sẽ lập tức trống trên Lịch phòng.
            ${summary.netPaid > 0 ? `Số tiền đã thu <strong>${escapeHtml(formatVND(summary.netPaid))}</strong> được giữ nguyên trong lịch sử để Quản lý hoàn cọc hoặc giữ cọc theo chính sách.` : ""}
          </div>
          <div class="field">
            <label for="fin-cancel-reason">Lý do hủy đặt phòng *</label>
            <input id="fin-cancel-reason" class="input" type="text" placeholder="VD: Khách báo hủy do thay đổi lịch trình..." />
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="btn btn-sm" data-fin-panel-action="close">Quay lại</button>
            <button type="button" class="btn btn-sm btn-danger" id="btn-fin-submit-cancel">✓ Xác nhận hủy đơn</button>
          </div>
        </div>
      `;
    }

    return "";
  }

  function showInlineError(msg) {
    const errEl = $("fin-inline-error");
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.add("open");
    } else {
      showToast(msg, "error");
    }
  }

  async function submitBookingCollect(overridePayload = null) {
    const bookingId = uiState.currentBookingId;
    const bookings = getBookings();
    const booking = bookings.find((b) => b.id === bookingId);
    if (!booking) return;
    const summary = computeBookingFinancialSummary(booking, bookings, getFinanceState());

    let payload = overridePayload;
    if (!payload) {
      const amount = parseVND($("fin-pay-amount") && $("fin-pay-amount").value);
      if (amount <= 0) {
        showInlineError("Vui lòng nhập số tiền thu lớn hơn 0 đ.");
        return;
      }
      const receivedDate = ($("fin-pay-date") && $("fin-pay-date").value) || getVietnamTodayISO();
      const paymentMethod = ($("fin-pay-method") && $("fin-pay-method").value) || "cash";
      const fundId = ($("fin-pay-fund") && $("fin-pay-fund").value) || getPaymentMethodMeta(paymentMethod).defaultFundId;
      const note = ($("fin-pay-note") && $("fin-pay-note").value.trim()) || "";
      payload = {
        txType: "customer_payment",
        entityType: summary.isGroupSharedLedger ? "group" : "booking",
        bookingId: booking.id,
        groupCode: summary.groupCode || "",
        groupCodeDisplay: summary.groupCodeDisplay || "",
        amount,
        receivedDate,
        paymentMethod,
        fundId,
        note,
        expectedBalance: summary.remaining,
        idempotencyKey: makeIdempotencyKey("pay")
      };
    }

    const res = await store.recordFinanceTransaction(payload);
    if (res && res.ok) {
      uiState.bookingInlineForm = null;
      uiState.bookingStaleConflict = null;
      showToast(
        res.idempotentReplay
          ? `Chứng từ ${res.transaction.voucherCode} đã được ghi nhận trước đó.`
          : `Đã thu ${formatVND(payload.amount)} • Phiếu ${res.transaction.voucherCode}`,
        "success"
      );
      notifyHostUI();
      renderBookingFinancePanel(bookingId);
      refreshOpenModals();
      return;
    }

    if (res && res.code === "STALE_BALANCE") {
      // Two-device concurrent protection: show fresh server balance and let staff confirm distinct 2nd payment!
      const freshBookings = getBookings();
      const freshBooking = freshBookings.find((b) => b.id === bookingId) || booking;
      const freshSummary = computeBookingFinancialSummary(freshBooking, freshBookings, getFinanceState());
      const freshBalance = res.currentBalance !== undefined ? res.currentBalance : (freshSummary ? freshSummary.remaining : 0);
      uiState.bookingStaleConflict = {
        message: res.error || "Số dư đã được cập nhật từ một thiết bị khác.",
        currentBalance: freshBalance,
        pendingPayload: {
          ...payload,
          expectedBalance: freshBalance,
          idempotencyKey: makeIdempotencyKey("pay")
        }
      };
      renderBookingFinancePanel(bookingId);
      return;
    }

    if (res && res.unconfirmed) {
      uiState.bookingInlineForm = null;
      showToast(res.error || "Chưa xác nhận phản hồi máy chủ — đang chờ đồng bộ.", "error");
      syncPendingBars();
      renderBookingFinancePanel(bookingId);
      return;
    }

    showInlineError((res && res.error) || "Không thể ghi nhận phiếu thu.");
  }

  async function submitBookingService() {
    const bookingId = uiState.currentBookingId;
    const booking = getBookings().find((b) => b.id === bookingId);
    if (!booking) return;
    const name = ($("fin-svc-name") && $("fin-svc-name").value.trim()) || "";
    const amount = parseVND($("fin-svc-amount") && $("fin-svc-amount").value);
    const date = ($("fin-svc-date") && $("fin-svc-date").value) || getVietnamTodayISO();
    if (!name) return showInlineError("Vui lòng nhập tên dịch vụ.");
    if (amount <= 0) return showInlineError("Số tiền dịch vụ phải lớn hơn 0 đ.");

    const nextServices = [
      ...(booking.services || []),
      { id: `svc_${Date.now().toString(36)}`, name, amount, date }
    ];
    const res = await store.updateBookingCharges(bookingId, {
      services: nextServices,
      effectiveDate: date,
      reason: `Thêm dịch vụ: ${name} (${formatVND(amount)})`
    });
    if (res && res.ok) {
      uiState.bookingInlineForm = null;
      showToast(`Đã thêm dịch vụ "${name}" (${formatVND(amount)}).`, "success");
      notifyHostUI();
      renderBookingFinancePanel(bookingId);
      refreshOpenModals();
    } else {
      showInlineError((res && res.error) || "Không thể cập nhật dịch vụ.");
    }
  }

  async function removeBookingService(idx) {
    const bookingId = uiState.currentBookingId;
    const booking = getBookings().find((b) => b.id === bookingId);
    if (!booking || !Array.isArray(booking.services) || !booking.services[idx]) return;
    const removed = booking.services[idx];
    const nextServices = booking.services.filter((_, i) => i !== idx);
    const res = await store.updateBookingCharges(bookingId, {
      services: nextServices,
      effectiveDate: getVietnamTodayISO(),
      reason: `Gỡ dịch vụ: ${removed.name}`
    });
    if (res && res.ok) {
      showToast(`Đã gỡ dịch vụ "${removed.name}".`, "success");
      notifyHostUI();
      renderBookingFinancePanel(bookingId);
      refreshOpenModals();
    } else {
      showToast((res && res.error) || "Không thể gỡ dịch vụ.", "error");
    }
  }

  async function submitBookingAdjustment() {
    const bookingId = uiState.currentBookingId;
    const booking = getBookings().find((b) => b.id === bookingId);
    if (!booking) return;
    const amount = parseSignedVND($("fin-adj-amount") && $("fin-adj-amount").value);
    const date = ($("fin-adj-date") && $("fin-adj-date").value) || getVietnamTodayISO();
    const reason = ($("fin-adj-reason") && $("fin-adj-reason").value.trim()) || "";
    if (amount === 0) return showInlineError("Số tiền điều chỉnh phải khác 0 (nhập số âm để giảm giá).");
    if (!reason) return showInlineError("Bắt buộc phải nhập lý do điều chỉnh.");

    const nextAdjustments = [
      ...(booking.adjustments || []),
      { id: `adj_${Date.now().toString(36)}`, amount, reason, date }
    ];
    const res = await store.updateBookingCharges(bookingId, {
      adjustments: nextAdjustments,
      effectiveDate: date,
      reason: `Điều chỉnh ${formatSignedVND(amount)}: ${reason}`
    });
    if (res && res.ok) {
      uiState.bookingInlineForm = null;
      showToast(`Đã áp dụng điều chỉnh ${formatSignedVND(amount)}.`, "success");
      notifyHostUI();
      renderBookingFinancePanel(bookingId);
      refreshOpenModals();
    } else {
      showInlineError((res && res.error) || "Không thể áp dụng điều chỉnh.");
    }
  }

  async function submitBookingRefund() {
    const bookingId = uiState.currentBookingId;
    const bookings = getBookings();
    const booking = bookings.find((b) => b.id === bookingId);
    if (!booking) return;
    const summary = computeBookingFinancialSummary(booking, bookings, getFinanceState());

    const amount = parseVND($("fin-ref-amount") && $("fin-ref-amount").value);
    const receivedDate = ($("fin-ref-date") && $("fin-ref-date").value) || getVietnamTodayISO();
    const refundCategory = ($("fin-ref-category") && $("fin-ref-category").value) || "overpayment";
    const linkedSelect = $("fin-ref-linked");
    const linkedTxId = (linkedSelect && linkedSelect.value) || "";
    const linkedVoucherCode = (linkedSelect && linkedSelect.selectedOptions[0] && linkedSelect.selectedOptions[0].dataset.vcode) || "";
    const fundId = ($("fin-ref-fund") && $("fin-ref-fund").value) || "cash_frontdesk";
    const reason = ($("fin-ref-reason") && $("fin-ref-reason").value.trim()) || "";

    if (amount <= 0) return showInlineError("Số tiền hoàn phải lớn hơn 0 đ.");
    if (!reason) return showInlineError("Bắt buộc phải nhập lý do hoàn tiền.");

    const res = await store.recordFinanceTransaction({
      txType: "customer_refund",
      entityType: summary.isGroupSharedLedger ? "group" : "booking",
      bookingId: booking.id,
      groupCode: summary.groupCode || "",
      groupCodeDisplay: summary.groupCodeDisplay || "",
      amount,
      receivedDate,
      paymentMethod: fundId === "bank_main" ? "bank_transfer" : "cash",
      fundId,
      refundCategory,
      linkedTxId,
      linkedVoucherCode,
      reason,
      idempotencyKey: makeIdempotencyKey("ref")
    });
    if (res && res.ok) {
      uiState.bookingInlineForm = null;
      showToast(`Đã lập phiếu hoàn tiền ${res.transaction.voucherCode} (${formatVND(amount)}).`, "success");
      notifyHostUI();
      renderBookingFinancePanel(bookingId);
      refreshOpenModals();
    } else {
      showInlineError((res && res.error) || "Không thể lập phiếu hoàn tiền.");
    }
  }

  async function submitBookingCancel(retainDeposit = false) {
    const bookingId = uiState.currentBookingId;
    const booking = getBookings().find((b) => b.id === bookingId);
    if (!booking) return;
    const reason = retainDeposit
      ? (booking.cancelReason || "Giữ tiền cọc theo chính sách hủy phòng")
      : (($("fin-cancel-reason") && $("fin-cancel-reason").value.trim()) || "");
    if (!retainDeposit && !reason) return showInlineError("Vui lòng nhập lý do hủy đơn.");

    const payload = retainDeposit
      ? { reason, depositDisposition: "retained" }
      : { reason, depositDisposition: "pending" };
    const res = await store.cancelBookingWithDeposit(bookingId, payload);
    if (res && res.ok) {
      uiState.bookingInlineForm = null;
      showToast(
        retainDeposit
          ? "Đã ghi nhận giữ tiền cọc theo chính sách."
          : `Đã hủy đơn P.${booking.roomId} — phòng đã giải phóng trên lịch.`,
        "success"
      );
      notifyHostUI();
      renderBookingFinancePanel(bookingId);
      refreshOpenModals();
    } else {
      showInlineError((res && res.error) || "Không thể hủy đặt phòng.");
    }
  }

  /* ============================================================================
     2. RECEIVABLES MODAL (#receivables-modal — Thu tiền & Công nợ khách)
     ============================================================================ */

  function openReceivables(opts = {}) {
    if (!can("finance:ar_read")) {
      showToast("Bạn không có quyền truy cập mục Thu tiền & công nợ.", "error");
      return;
    }
    const modal = $("receivables-modal");
    if (!modal) return;

    if (opts.tab) uiState.arTab = opts.tab;
    if (opts.dueFilter !== undefined) uiState.arDueFilter = opts.dueFilter || "all";
    if (opts.asOfDate !== undefined && $("ar-filter-asof")) {
      $("ar-filter-asof").value = opts.asOfDate || getVietnamTodayISO();
    } else if ($("ar-filter-asof") && !$("ar-filter-asof").value) {
      $("ar-filter-asof").value = getVietnamTodayISO();
    }
    if (opts.status !== undefined && $("ar-filter-status")) {
      $("ar-filter-status").value = opts.status;
    }
    if (opts.search !== undefined && $("ar-filter-search")) {
      $("ar-filter-search").value = opts.search;
    }

    // RBAC on Manager-only action buttons
    const isManager = can("finance:export");
    if ($("btn-ar-export-csv")) $("btn-ar-export-csv").style.display = isManager ? "" : "none";
    if ($("btn-ar-migrate-legacy")) $("btn-ar-migrate-legacy").style.display = can("admin:backup") ? "" : "none";

    modal.classList.add("open");
    renderReceivables();
    if (root.PMSPcApi && typeof root.PMSPcApi.syncActiveNav === "function") {
      root.PMSPcApi.syncActiveNav();
    }
  }

  function closeReceivables() {
    const modal = $("receivables-modal");
    if (modal) modal.classList.remove("open");
    uiState.arQuickCollectKey = null;
    if (root.PMSPcApi && typeof root.PMSPcApi.syncActiveNav === "function") {
      root.PMSPcApi.syncActiveNav();
    }
  }

  function getReceivablesFilters() {
    return {
      search: ($("ar-filter-search") && $("ar-filter-search").value) || "",
      entityType: ($("ar-filter-entity") && $("ar-filter-entity").value) || "all",
      status: ($("ar-filter-status") && $("ar-filter-status").value) || "all",
      dueFilter: uiState.arDueFilter || "all",
      asOfDate: ($("ar-filter-asof") && $("ar-filter-asof").value) || getVietnamTodayISO()
    };
  }

  function renderReceivables() {
    const modal = $("receivables-modal");
    if (!modal || !modal.classList.contains("open")) return;

    syncPendingBars();
    const bookings = getBookings();
    const fState = getFinanceState();
    const filters = getReceivablesFilters();
    const report = computeReceivablesReport(bookings, fState, filters);
    const allReportForBadge = computeReceivablesReport(bookings, fState, { asOfDate: filters.asOfDate });

    // Tabs state & legacy badge
    if ($("btn-ar-tab-list")) $("btn-ar-tab-list").classList.toggle("active", uiState.arTab === "list");
    if ($("btn-ar-tab-legacy")) $("btn-ar-tab-legacy").classList.toggle("active", uiState.arTab === "legacy");
    const legBadge = $("ar-legacy-tab-badge");
    const legCount = allReportForBadge.legacyCount;
    if (legBadge) {
      legBadge.textContent = String(legCount);
      legBadge.style.display = legCount > 0 ? "" : "none";
    }

    // KPI Summary Strip (explicitly splits Đã thu ròng into confirmed fund vs opening-included vs unassigned legacy)
    const strip = $("ar-summary-strip");
    if (strip) {
      const paidSourceParts = [
        `Đã xác định quỹ: <strong id="ar-kpi-paid-confirmed">${escapeHtml(formatVND(report.totalConfirmedFundNetPaid))}</strong>`
      ];
      if (report.totalOpeningIncludedLegacyPaid > 0) {
        paidSourceParts.push(`Trong số dư đầu kỳ: <strong id="ar-kpi-paid-opening">${escapeHtml(formatVND(report.totalOpeningIncludedLegacyPaid))}</strong>`);
      }
      paidSourceParts.push(`Chuyển tiếp chưa xác định quỹ: <strong id="ar-kpi-paid-legacy" style="color:${report.totalUnassignedLegacyPaid > 0 ? "#b45309" : "inherit"};">${escapeHtml(formatVND(report.totalUnassignedLegacyPaid))}</strong>`);

      strip.innerHTML = `
        <div class="fin-kpi-card">
          <span class="fin-stat-lbl">Tổng giá trị đơn (đến ${escapeHtml(formatDateVN(report.asOfDate))})</span>
          <span class="fin-stat-val">${escapeHtml(formatVND(report.totalPayable))}</span>
          <span class="fin-stat-sub">${report.rows.length} mục đang hiển thị</span>
        </div>
        <div class="fin-kpi-card success">
          <span class="fin-stat-lbl">Đã thu ròng</span>
          <span class="fin-stat-val ok" id="ar-kpi-net-paid">${escapeHtml(formatVND(report.totalNetPaid))}</span>
          <div class="fin-paid-source-line">${paidSourceParts.join("<br/>")}</div>
          ${report.totalRefunded > 0 ? `<span class="fin-stat-sub">Đã hoàn: ${escapeHtml(formatVND(report.totalRefunded))}</span>` : ""}
        </div>
        <div class="fin-kpi-card danger">
          <span class="fin-stat-lbl">Tổng công nợ còn phải thu</span>
          <span class="fin-stat-val warn" id="ar-kpi-total-debt">${escapeHtml(formatVND(report.totalRemaining))}</span>
          <span class="fin-stat-sub">${report.debtCount} đơn/đoàn còn nợ${uiState.arDueFilter !== "all" ? " (đang lọc theo hạn)" : ""}</span>
        </div>
        <div class="fin-kpi-card highlight">
          <span class="fin-stat-lbl">Trả thừa / Cọc đơn hủy</span>
          <span class="fin-stat-val info">${escapeHtml(formatVND(report.totalOverpaid))}</span>
          <span class="fin-stat-sub">${report.totalCancelledHeldDeposit > 0 ? `Gồm ${escapeHtml(formatVND(report.totalCancelledHeldDeposit))} cọc đơn hủy` : `${report.overpaidCount} mục trả thừa`}</span>
        </div>
      `;
    }

    // Phase 2: Clickable Due-Date Buckets Strip (each card clicks to filter exact constituent bookings)
    const dueStrip = $("ar-due-buckets-strip");
    if (dueStrip) {
      if (uiState.arTab === "legacy") {
        dueStrip.style.display = "none";
        dueStrip.innerHTML = "";
      } else {
        dueStrip.style.display = "grid";
        const curDue = uiState.arDueFilter || "all";
        dueStrip.innerHTML = `
          <button type="button" class="fin-due-card all_debt ${curDue === "debt" ? "active" : ""}" id="btn-ar-bucket-all-debt" data-ar-due-filter="debt" title="Bấm để xem toàn bộ đơn còn nợ">
            <span class="fin-due-label">Còn lại (tất cả đơn)</span>
            <span class="fin-due-val" id="ar-bucket-all-debt-val">${escapeHtml(formatVND(report.allDebtAmount))}</span>
            <span class="fin-due-sub">${report.allDebtCount} đơn/đoàn • ${curDue === "debt" ? "Đang lọc (bấm để bỏ)" : "Bấm xem danh sách"}</span>
          </button>
          <button type="button" class="fin-due-card due ${curDue === "due" ? "active" : ""}" id="btn-ar-bucket-due" data-ar-due-filter="due" title="Bấm để xem danh sách đơn đến hạn thanh toán / hạn cọc">
            <span class="fin-due-label">Đến hạn thanh toán</span>
            <span class="fin-due-val amber" id="ar-bucket-due-val">${escapeHtml(formatVND(report.dueAmount))}</span>
            <span class="fin-due-sub">${report.dueCount} đơn/đoàn • ${curDue === "due" ? "Đang lọc (bấm để bỏ)" : "Bấm xem danh sách"}</span>
          </button>
          <button type="button" class="fin-due-card overdue ${curDue === "overdue" ? "active" : ""}" id="btn-ar-bucket-overdue" data-ar-due-filter="overdue" title="Bấm để xem danh sách đơn quá hạn thanh toán / hạn cọc">
            <span class="fin-due-label">Quá hạn thanh toán</span>
            <span class="fin-due-val warn" id="ar-bucket-overdue-val">${escapeHtml(formatVND(report.overdueAmount))}</span>
            <span class="fin-due-sub">${report.overdueCount} đơn/đoàn • ${curDue === "overdue" ? "Đang lọc (bấm để bỏ)" : "Bấm xem danh sách"}</span>
          </button>
          <button type="button" class="fin-due-card no_due_date ${curDue === "no_due_date" ? "active" : ""}" id="btn-ar-bucket-nodue" data-ar-due-filter="no_due_date" title="Bấm để xem đơn cũ chưa khai báo hạn cọc / hạn thanh toán">
            <span class="fin-due-label">Chưa xác định hạn</span>
            <span class="fin-due-val" id="ar-bucket-nodue-val">${escapeHtml(formatVND(report.noDueDateAmount))}</span>
            <span class="fin-due-sub">${report.noDueDateCount} đơn/đoàn • ${curDue === "no_due_date" ? "Đang lọc (bấm để bỏ)" : "Bấm xem danh sách"}</span>
          </button>
        `;
      }
    }

    // Optional Migration Preview/Result Box
    const migBox = $("ar-migration-report");
    if (migBox) {
      if (uiState.arLastMigrationResult) {
        const mr = uiState.arLastMigrationResult;
        const maxDiff = (mr.entityDiffs || []).reduce((m, r) => Math.max(m, Math.abs(r.paidDiff || 0), Math.abs(r.debtDiff || 0)), 0);
        migBox.style.display = "block";
        migBox.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
            <strong>${mr.dryRun ? "🔍 Kết quả xem thử chuyển tiếp đơn cũ (Dry-run)" : "✅ Đã chuyển tiếp đơn cũ vào sổ giao dịch"}</strong>
            <div style="display:flex; gap:6px;">
              ${mr.dryRun && mr.createdCount > 0 ? `<button type="button" class="btn btn-sm btn-primary" id="btn-ar-commit-migration">✓ Xác nhận chạy chuyển tiếp (${mr.createdCount} đơn)</button>` : ""}
              <button type="button" class="btn btn-sm" id="btn-ar-close-mig-box">Ẩn</button>
            </div>
          </div>
          <div>
            Số phiếu chuyển tiếp ${mr.dryRun ? "sẽ tạo" : "vừa tạo"}: <strong>${mr.createdCount}</strong> •
            Tổng tiền bảo toàn: <strong>${escapeHtml(formatVND(mr.migratedTotalAmount || 0))}</strong> •
            Chênh lệch đối soát lớn nhất: <strong style="color:${maxDiff === 0 ? "var(--status-paid,#15803d)" : "#dc2626"};">${escapeHtml(formatVND(maxDiff))}</strong>
          </div>
          ${(mr.entityDiffs || []).length > 0 ? `
            <div class="fin-table-wrap" style="margin-top:8px; max-height:190px; overflow-y:auto;">
              <table class="fin-tx-table">
                <thead><tr><th>Đơn / Đoàn</th><th class="num">Đã thu trước</th><th class="num">Đã thu sau</th><th class="num">Nợ trước</th><th class="num">Nợ sau</th><th class="num">Chênh lệch</th></tr></thead>
                <tbody>
                  ${mr.entityDiffs.slice(0, 30).map((d) => `
                    <tr>
                      <td>${escapeHtml(d.label)}</td>
                      <td class="num">${escapeHtml(formatVND(d.beforePaid))}</td>
                      <td class="num">${escapeHtml(formatVND(d.afterPaid))}</td>
                      <td class="num">${escapeHtml(formatVND(d.beforeDebt))}</td>
                      <td class="num">${escapeHtml(formatVND(d.afterDebt))}</td>
                      <td class="num" style="font-weight:800; color:${d.paidDiff === 0 && d.debtDiff === 0 ? "var(--status-paid,#15803d)" : "#dc2626"};">${escapeHtml(formatVND(Math.abs(d.paidDiff) + Math.abs(d.debtDiff)))}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          ` : ""}
        `;
      } else {
        migBox.style.display = "none";
        migBox.innerHTML = "";
      }
    }

    const content = $("ar-content-area");
    if (!content) return;

    if (uiState.arTab === "legacy") {
      renderReceivablesLegacyTab(content, allReportForBadge, fState);
      return;
    }

    if (report.rows.length === 0) {
      content.innerHTML = `<div class="fin-empty">Không có đơn hoặc đoàn nào khớp bộ lọc hiện tại (tính đến ${escapeHtml(formatDateVN(report.asOfDate))}).${uiState.arDueFilter !== "all" ? ` <button type="button" class="fin-link-btn" data-ar-due-filter="all">Xem tất cả hạn</button>` : ""}</div>`;
      return;
    }

    const canCollect = can("finance:collect");
    content.innerHTML = report.rows.map((row) => {
      const expanded = uiState.arExpandedKeys.has(row.entityKey);
      const quickOpen = uiState.arQuickCollectKey === row.entityKey;
      const cardClass = row.cancelledHeldDeposit > 0
        ? "cancelled_deposit"
        : row.remaining > 0
          ? "debt"
          : row.overpaid > 0
            ? "overpaid"
            : "paid";
      const statusPill = row.cancelledHeldDeposit > 0
        ? `<span class="fin-pill amber">Đơn hủy • Giữ cọc ${escapeHtml(formatVND(row.cancelledHeldDeposit))}</span>`
        : row.remaining > 0
          ? `<span class="fin-pill warn">Còn nợ ${escapeHtml(formatVND(row.remaining))}</span>`
          : row.overpaid > 0
            ? `<span class="fin-pill info">Trả thừa ${escapeHtml(formatVND(row.overpaid))}</span>`
            : '<span class="fin-pill ok">Đã thu đủ</span>';
      const dueBadge = row.remaining > 0
        ? (row.dueBucket === "overdue"
            ? `<span class="fin-pill warn">Quá hạn ${escapeHtml(formatDateVN(row.effectiveDueDate))}</span>`
            : row.dueBucket === "due"
              ? `<span class="fin-pill amber">Đến hạn ${escapeHtml(formatDateVN(row.effectiveDueDate))}</span>`
              : row.dueBucket === "not_due"
                ? `<span class="fin-pill muted">Hạn ${escapeHtml(formatDateVN(row.effectiveDueDate))}</span>`
                : `<span class="fin-pill muted">Chưa xác định hạn</span>`)
        : "";
      const title = row.entityType === "group"
        ? `👥 Đoàn ${escapeHtml(row.groupCodeDisplay)} (${row.roomCount} phòng: ${escapeHtml(row.roomLabel)})`
        : `🚪 ${escapeHtml(row.roomLabel)} • ${escapeHtml(row.guestName)}`;
      const primaryBkId = row.bookingId || (row.bookings[0] && row.bookings[0].id) || "";

      return `
        <div class="fin-ar-card ${cardClass}" data-ar-entity="${escapeHtml(row.entityKey)}" data-ar-due-bucket="${escapeHtml(row.dueBucket || "")}">
          <div class="fin-ar-card-head" data-ar-toggle="${escapeHtml(row.entityKey)}">
            <div style="min-width:0; flex:1;">
              <div style="font-weight:800; font-size:13px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span>${title}</span>
                ${statusPill}
                ${dueBadge}
                ${row.hasLegacyNeedsReconcile ? '<span class="fin-pill amber">Chuyển tiếp – cần đối soát</span>' : ""}
                ${row.openingIncludedLegacyPaid > 0 ? `<span class="fin-pill info">Đầu kỳ ${escapeHtml(formatVND(row.openingIncludedLegacyPaid))}</span>` : ""}
              </div>
              <div style="font-size:11.5px; color:var(--text-secondary); margin-top:3px;">
                ${escapeHtml(row.guestName)} ${row.phone ? `• ${escapeHtml(row.phone)}` : ""}
                ${row.tourName ? `• Tour: <strong>${escapeHtml(row.tourName)}</strong>` : `• ${escapeHtml(row.sourceName)}`}
                • ${escapeHtml(formatDateVN(row.minCheckin))} → ${escapeHtml(formatDateVN(row.maxCheckout))}
              </div>
            </div>
            <div style="text-align:right; font-variant-numeric:tabular-nums; font-size:12px;">
              <div>Phải thu: <strong>${escapeHtml(formatVND(row.totalPayable))}</strong></div>
              <div>Đã thu: <strong style="color:var(--status-paid,#15803d);">${escapeHtml(formatVND(row.netPaid))}</strong> • Còn: <strong style="color:${row.remaining > 0 ? "#dc2626" : "var(--text-primary)"};">${escapeHtml(formatVND(row.remaining))}</strong></div>
            </div>
          </div>
          ${expanded ? `
            <div class="fin-ar-card-body">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
                <div style="font-size:11.5px; color:var(--text-secondary);">
                  Tiền phòng: <strong>${escapeHtml(formatVND(row.roomAmount))}</strong> •
                  Dịch vụ: <strong>${escapeHtml(formatVND(row.servicesTotal))}</strong> •
                  Điều chỉnh: <strong>${escapeHtml(formatSignedVND(row.adjustmentsTotal))}</strong> •
                  Đã xác định quỹ: <strong>${escapeHtml(formatVND(row.confirmedFundNetPaid))}</strong>
                  ${row.openingIncludedLegacyPaid > 0 ? ` • Trong đầu kỳ: <strong>${escapeHtml(formatVND(row.openingIncludedLegacyPaid))}</strong>` : ""}
                  ${row.unassignedLegacyPaid > 0 ? ` • Chuyển tiếp chưa gán quỹ: <strong style="color:#b45309;">${escapeHtml(formatVND(row.unassignedLegacyPaid))}</strong>` : ""}
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                  ${canCollect && !row.allCancelled ? `<button type="button" class="btn btn-sm btn-primary" data-ar-quick-collect="${escapeHtml(row.entityKey)}">+ Thu tiền nhanh</button>` : ""}
                  <button type="button" class="btn btn-sm" data-fin-jump-booking="${escapeHtml(primaryBkId)}">Mở chi tiết đơn ↗</button>
                </div>
              </div>
              ${quickOpen ? renderArQuickCollectForm(row) : ""}
              ${row.transactions.length > 0 ? `
                <div class="fin-table-wrap">
                  <table class="fin-tx-table">
                    <thead><tr><th>Mã CT</th><th>Ngày thực nhận</th><th>Loại</th><th>Quỹ / Nguồn</th><th class="num">Số tiền</th><th>Người thao tác</th><th>Ghi chú / Căn cứ</th></tr></thead>
                    <tbody>
                      ${row.transactions.map((tx) => {
                        const isRef = tx.txType === "customer_refund";
                        const isOpeningLeg = tx.txType === "legacy_payment" && tx.legacyStatus === "reconciled_in_opening";
                        const amt = isRef ? -parseVND(tx.amount) : parseVND(tx.amount);
                        const fundText = isOpeningLeg ? "Đã nằm trong số dư đầu kỳ" : getFinanceFundById(tx.fundId).shortName;
                        return `
                          <tr>
                            <td><span class="fin-voucher-code">${escapeHtml(tx.voucherCode)}</span></td>
                            <td>${tx.receivedDate ? escapeHtml(formatDateVN(tx.receivedDate)) : (isOpeningLeg ? '<span class="fin-pill info">Trong đầu kỳ</span>' : '<span class="fin-pill amber">Cần đối soát</span>')}</td>
                            <td>${isRef ? '<span class="fin-pill warn">Hoàn tiền</span>' : isOpeningLeg ? '<span class="fin-pill info">Chuyển tiếp (Đầu kỳ)</span>' : tx.txType === "legacy_payment" ? '<span class="fin-pill amber">Chuyển tiếp</span>' : '<span class="fin-pill ok">Thu tiền</span>'}</td>
                            <td>${escapeHtml(fundText)}</td>
                            <td class="num" style="font-weight:800;">${escapeHtml(formatSignedVND(amt))}</td>
                            <td>${escapeHtml(tx.operator || "—")}</td>
                            <td>${escapeHtml(tx.reconcileEvidence ? `Căn cứ: ${tx.reconcileEvidence}` : (tx.reason || tx.note || "—"))}</td>
                          </tr>
                        `;
                      }).join("")}
                    </tbody>
                  </table>
                </div>
              ` : `<div style="font-size:11.5px; color:var(--text-muted);">Chưa có phiếu thu nào tính đến ${escapeHtml(formatDateVN(report.asOfDate))}.</div>`}
            </div>
          ` : ""}
        </div>
      `;
    }).join("");
  }

  function renderArQuickCollectForm(row) {
    const todayVN = getVietnamTodayISO();
    const defaultAmt = row.remaining > 0 ? formatNumberInput(row.remaining) : "";
    return `
      <div class="fin-inline-form" data-ar-qc-form="${escapeHtml(row.entityKey)}">
        <div class="fin-inline-form-title">
          <span>💰 Thu tiền nhanh (${row.entityType === "group" ? `Đoàn ${escapeHtml(row.groupCodeDisplay)}` : escapeHtml(row.roomLabel)})</span>
          <button type="button" class="btn btn-sm" data-ar-qc-close="1">Đóng</button>
        </div>
        <div class="form-grid-3">
          <div class="field">
            <label>Số tiền (VNĐ) *</label>
            <input class="input" data-qc-field="amount" type="text" inputmode="numeric" value="${escapeHtml(defaultAmt)}" />
          </div>
          <div class="field">
            <label>Ngày thực nhận (VN) *</label>
            <input class="input" data-qc-field="date" type="date" value="${escapeHtml(todayVN)}" />
          </div>
          <div class="field">
            <label>Quỹ nhận *</label>
            <select class="select" data-qc-field="fundId">
              ${FINANCE_FUNDS.filter((f) => !f.isLegacyBucket).map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label>Hình thức</label>
            <select class="select" data-qc-field="method">
              ${PAYMENT_METHODS.map((m) => `<option value="${escapeHtml(m.key)}">${escapeHtml(m.label)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Ghi chú</label>
            <input class="input" data-qc-field="note" type="text" placeholder="VD: Khách thanh toán tại quầy..." />
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button type="button" class="btn btn-sm" data-ar-qc-close="1">Hủy</button>
          <button type="button" class="btn btn-sm btn-primary" data-ar-qc-submit="${escapeHtml(row.entityKey)}">✓ Xác nhận thu tiền</button>
        </div>
      </div>
    `;
  }

  function renderReceivablesLegacyTab(content, report, fState) {
    const legRows = report.rows.filter((r) => r.hasLegacyNeedsReconcile);
    const legTxs = (report.legacyTransactions || []);
    const isManager = can("admin:backup");
    const canVerify = can("finance:reconcile");
    const headerHtml = `
      <div class="fin-panel-head" style="margin-bottom:8px;">
        <div style="font-size:12px; color:var(--text-secondary);">
          Các đơn cũ có tổng "đã thu" nhưng thiếu ngày thực nhận hoặc quỹ nhận được tách riêng thành <strong>"Chuyển tiếp chưa xác định quỹ"</strong>.
          Khi Quản lý xác minh, cần chọn rõ khoản này <strong>đã nằm trong số dư đầu kỳ</strong> (không cộng lại vào quỹ) hay <strong>ghi bổ sung vào quỹ</strong> kèm căn cứ đối soát.
        </div>
        ${isManager ? `
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button type="button" class="btn btn-sm" id="btn-ar-dryrun-legacy">🔍 Xem thử chuyển tiếp (Dry-run)</button>
            <button type="button" class="btn btn-sm btn-primary" id="btn-ar-run-legacy">↺ Chạy chuyển tiếp đơn cũ</button>
          </div>
        ` : ""}
      </div>
    `;

    if (legRows.length === 0 && legTxs.length === 0) {
      content.innerHTML = `${headerHtml}<div class="fin-empty">✅ Hiện không có dữ liệu chuyển tiếp nào cần đối soát.</div>`;
      return;
    }

    const todayVN = getVietnamTodayISO();
    const verifyTxTable = (canVerify && legTxs.length > 0) ? `
      <div style="font-weight:800; font-size:12.5px; margin:10px 0 6px;">Xác minh chứng từ chuyển tiếp (${legTxs.length} phiếu)</div>
      <div class="fin-table-wrap" style="margin-bottom:12px;">
        <table class="fin-tx-table">
          <thead>
            <tr>
              <th>Mã CT</th>
              <th class="num">Số tiền</th>
              <th>Cách xử lý quỹ *</th>
              <th>Ngày / Quỹ (nếu ghi bổ sung)</th>
              <th>Căn cứ đối soát *</th>
              <th>Xác minh</th>
            </tr>
          </thead>
          <tbody>
            ${legTxs.map((tx) => `
              <tr data-legacy-verify-row="${escapeHtml(tx.id)}">
                <td>
                  <span class="fin-voucher-code">${escapeHtml(tx.voucherCode)}</span>
                  <div style="font-size:10.5px; color:var(--text-muted);">${escapeHtml(tx.note || "")}</div>
                </td>
                <td class="num" style="font-weight:800;">${escapeHtml(formatVND(tx.amount))}</td>
                <td>
                  <select class="select" data-leg-resolution style="min-width:190px;">
                    <option value="included_in_opening">Đã nằm trong số dư đầu kỳ (không cộng quỹ)</option>
                    <option value="record_to_fund">Ghi bổ sung vào quỹ thực tế</option>
                  </select>
                </td>
                <td>
                  <div style="display:flex; gap:4px; flex-wrap:wrap;">
                    <input class="input" data-leg-date type="date" value="${escapeHtml(tx.receivedDate || todayVN)}" style="min-width:128px;" disabled />
                    <select class="select" data-leg-fund style="min-width:130px;" disabled>
                      ${FINANCE_FUNDS.filter((f) => !f.isLegacyBucket).map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.shortName)}</option>`).join("")}
                    </select>
                  </div>
                </td>
                <td>
                  <input class="input" data-leg-evidence type="text" placeholder="VD: BBKK đầu kỳ 01/11, Sao kê NH..." style="min-width:165px;" />
                </td>
                <td>
                  <button type="button" class="btn btn-sm btn-primary" data-leg-verify-submit="${escapeHtml(tx.id)}">✓ Xác minh</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : "";

    content.innerHTML = `
      ${headerHtml}
      ${verifyTxTable}
      ${legRows.length > 0 ? `
        <div class="fin-table-wrap">
          <table class="fin-tx-table">
            <thead>
              <tr>
                <th>Đơn / Đoàn</th>
                <th>Khách hàng</th>
                <th class="num">Chuyển tiếp chưa gán quỹ</th>
                <th class="num">Còn nợ</th>
                <th>Trạng thái</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              ${legRows.map((r) => {
                const primaryBkId = r.bookingId || (r.bookings[0] && r.bookings[0].id) || "";
                return `
                  <tr>
                    <td><strong>${r.entityType === "group" ? `Đoàn ${escapeHtml(r.groupCodeDisplay)}` : escapeHtml(r.roomLabel)}</strong></td>
                    <td>${escapeHtml(r.guestName)}</td>
                    <td class="num" style="font-weight:800;">${escapeHtml(formatVND(r.unassignedLegacyPaid))}</td>
                    <td class="num">${escapeHtml(formatVND(r.remaining))}</td>
                    <td><span class="fin-pill amber">Dữ liệu chuyển tiếp – cần đối soát</span></td>
                    <td>
                      <button type="button" class="fin-link-btn" data-fin-jump-booking="${escapeHtml(primaryBkId)}">Mở đơn</button>
                      ${can("finance:cashbook_read") ? ` • <button type="button" class="fin-link-btn" data-fin-goto-cb-legacy="1">Xác minh ở Sổ quỹ</button>` : ""}
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      ` : ""}
    `;
  }

  /* ============================================================================
     3. CASHBOOK & RECONCILIATION MODAL (#cashbook-modal — Manager / Super Admin)
     ============================================================================ */

  function openCashbook(opts = {}) {
    if (!can("finance:cashbook_read")) {
      showToast("Sổ quỹ & đối soát thuộc quyền Quản lý / Tổng quản lý.", "error");
      return;
    }
    const modal = $("cashbook-modal");
    if (!modal) return;
    if (opts.tab) uiState.cbTab = opts.tab;
    if (opts.fromDate !== undefined && $("cb-filter-from")) $("cb-filter-from").value = opts.fromDate;
    if (opts.toDate !== undefined && $("cb-filter-to")) $("cb-filter-to").value = opts.toDate;
    if (opts.fundId !== undefined && $("cb-filter-fund")) $("cb-filter-fund").value = opts.fundId;
    if (opts.txType !== undefined && $("cb-filter-type")) $("cb-filter-type").value = opts.txType;
    modal.classList.add("open");
    renderCashbook();
    if (root.PMSPcApi && typeof root.PMSPcApi.syncActiveNav === "function") {
      root.PMSPcApi.syncActiveNav();
    }
  }

  function closeCashbook() {
    const modal = $("cashbook-modal");
    if (modal) modal.classList.remove("open");
    uiState.cbDrawer = null;
    if (root.PMSPcApi && typeof root.PMSPcApi.syncActiveNav === "function") {
      root.PMSPcApi.syncActiveNav();
    }
  }

  function getCashbookFilters() {
    return {
      fromDate: ($("cb-filter-from") && $("cb-filter-from").value) || "",
      toDate: ($("cb-filter-to") && $("cb-filter-to").value) || "",
      fundId: ($("cb-filter-fund") && $("cb-filter-fund").value) || "all",
      txType: ($("cb-filter-type") && $("cb-filter-type").value) || "all",
      reconcile: ($("cb-filter-reconcile") && $("cb-filter-reconcile").value) || "all"
    };
  }

  function renderCashbook() {
    const modal = $("cashbook-modal");
    if (!modal || !modal.classList.contains("open")) return;

    syncPendingBars();
    const fState = getFinanceState();
    const bookings = getBookings();
    const filters = getCashbookFilters();
    const report = computeCashbookReport(fState, bookings, filters);

    // Fund Summary Cards (STRICT: ONLY display "Đã đối chiếu" when latestCheck exists!)
    const fundsGrid = $("cb-funds-grid");
    if (fundsGrid) {
      const fundCards = report.activeFunds.map((f) => {
        const chk = f.latestCheck;
        const statusPillCls = f.reconciliationStatus === "reconciled_exact"
          ? "ok"
          : f.reconciliationStatus === "reconciled_discrepancy"
            ? "warn"
            : "amber";
        let checkHtml = `<div class="fin-fund-check-pill unverified" data-cb-fund-check-status="unreconciled">Chưa đối chiếu — chưa có mốc kiểm đếm tiền mặt hoặc sao kê ngân hàng</div>`;
        if (chk) {
          const liveDiff = f.liveDiscrepancy || 0;
          const resultText = liveDiff === 0 ? "Khớp 0 đ" : `Chênh lệch ${formatSignedVND(liveDiff)}`;
          checkHtml = `
            <div class="fin-fund-check-pill ${liveDiff === 0 ? "exact" : "diff"}" data-cb-fund-check-status="${liveDiff === 0 ? "exact" : "diff"}">
              <strong>${escapeHtml(f.reconciliationLabel)}</strong> ngày ${escapeHtml(formatDateVN(chk.asOfDate))} (${escapeHtml(formatDateTimeVN(chk.checkedAt))}) •
              Người đối chiếu: <strong>${escapeHtml(chk.checkedBy || "—")}</strong> •
              Thực tế: <strong>${escapeHtml(formatVND(chk.actualBalance))}</strong> •
              Kết quả: <strong>${escapeHtml(resultText)}</strong>
            </div>
          `;
        }
        return `
          <div class="fin-fund-card" data-cb-fund-card="${escapeHtml(f.id)}">
            <div class="fin-fund-head">
              <span class="fin-fund-name">${escapeHtml(f.name)}</span>
              <span class="fin-pill ${statusPillCls}" id="cb-rec-status-${escapeHtml(f.id)}">${escapeHtml(f.reconciliationLabel)}</span>
            </div>
            <div class="fin-fund-balance" id="cb-bal-${escapeHtml(f.id)}">${escapeHtml(formatVND(f.closingBalance))}</div>
            <div class="fin-fund-meta">
              <span>Đầu kỳ: <strong>${escapeHtml(formatVND(f.openingBalance))}</strong></span>
              <span>Thu khách: <strong style="color:var(--status-paid,#15803d);">+${escapeHtml(formatVND(f.customerIn))}</strong></span>
              <span>Hoàn khách: <strong style="color:#dc2626;">-${escapeHtml(formatVND(f.customerRefund))}</strong></span>
              <span>Chi trả NCC: <strong style="color:#dc2626;">-${escapeHtml(formatVND(f.supplierOut || 0))}</strong></span>
              <span>Chuyển quỹ: <strong>${escapeHtml(formatSignedVND(f.transferIn - f.transferOut))}</strong></span>
              <span>Phiếu chưa tick: <strong>${f.unreconciledCount}</strong></span>
              ${f.adjustments !== 0 ? `<span>Điều chỉnh: <strong>${escapeHtml(formatSignedVND(f.adjustments))}</strong></span>` : ""}
            </div>
            ${checkHtml}
          </div>
        `;
      }).join("");

      const totalCard = `
        <div class="fin-fund-card" style="border-color:var(--accent-primary);">
          <div class="fin-fund-head">
            <span class="fin-fund-name">Tổng tiền các quỹ khách sạn</span>
            <span class="fin-pill info">Gộp Tiền mặt + Ngân hàng</span>
          </div>
          <div class="fin-fund-balance" id="cb-bal-total-hotel">${escapeHtml(formatVND(report.totalHotelCashHeld))}</div>
          <div class="fin-fund-meta">
            <span>Thu khách ròng: <strong id="cb-total-customer-net">${escapeHtml(formatVND(report.totalCustomerNetCollected))}</strong></span>
            <span>Chi trả NCC: <strong id="cb-total-supplier-paid" style="color:#dc2626;">-${escapeHtml(formatVND(report.totalSupplierPaid || 0))}</strong></span>
            <span>Thu gộp: <strong>${escapeHtml(formatVND(report.totalCustomerGrossIn))}</strong></span>
            <span>Hoàn khách: <strong>${escapeHtml(formatVND(report.totalCustomerRefunded))}</strong></span>
          </div>
          ${report.legacyUnreconciled.length > 0 ? `
            <div class="fin-fund-check-pill diff">
              ⚠️ Còn ${report.legacyUnreconciled.length} phiếu chuyển tiếp chưa gán quỹ (${escapeHtml(formatVND(report.funds.find((x) => x.isLegacyBucket)?.closingBalance || 0))}) — tách riêng khỏi số dư quỹ thực tế.
            </div>
          ` : `<div class="fin-fund-check-pill exact">✓ Chuyển quỹ nội bộ không làm đổi tổng tiền khách sạn &amp; không làm đổi tổng đã thu của khách.</div>`}
        </div>
      `;
      fundsGrid.innerHTML = fundCards + totalCard;
    }

    // Tabs state
    if ($("btn-cb-tab-ledger")) $("btn-cb-tab-ledger").classList.toggle("active", uiState.cbTab === "ledger");
    if ($("btn-cb-tab-legacy")) $("btn-cb-tab-legacy").classList.toggle("active", uiState.cbTab === "legacy");
    if ($("btn-cb-tab-logs")) $("btn-cb-tab-logs").classList.toggle("active", uiState.cbTab === "logs");
    const cbLegBadge = $("cb-legacy-tab-badge");
    if (cbLegBadge) {
      cbLegBadge.textContent = String(report.legacyUnreconciled.length);
      cbLegBadge.style.display = report.legacyUnreconciled.length > 0 ? "" : "none";
    }

    // Inline Drawer
    renderCashbookDrawer(report);

    const content = $("cb-content-area");
    if (!content) return;

    if (uiState.cbTab === "legacy") {
      renderCashbookLegacyTab(content, report);
      return;
    }
    if (uiState.cbTab === "logs") {
      renderCashbookLogsTab(content, fState, report);
      return;
    }

    if (report.ledgerLines.length === 0) {
      content.innerHTML = `<div class="fin-empty">Chưa có giao dịch sổ quỹ nào khớp bộ lọc.</div>`;
      return;
    }

    content.innerHTML = `
      <div class="fin-table-wrap">
        <table class="fin-tx-table">
          <thead>
            <tr>
              <th>Mã CT</th>
              <th>Ngày thực nhận / chi</th>
              <th>Loại giao dịch</th>
              <th>Quỹ / Chuyển quỹ</th>
              <th>Đơn / Hóa đơn liên kết</th>
              <th class="num">Số tiền</th>
              <th>Người thao tác</th>
              <th>Đối chiếu</th>
            </tr>
          </thead>
          <tbody>
            ${report.ledgerLines.map((t) => {
              const isTransfer = t.txType === "fund_transfer";
              const isRefund = t.txType === "customer_refund";
              const isSupplier = t.txType === "supplier_payment";
              const isAdj = t.txType === "balance_adjustment";
              const pillCls = isTransfer ? "info" : (isRefund || isSupplier) ? "warn" : isAdj ? "amber" : "ok";
              const fundCol = isTransfer
                ? `<strong>${escapeHtml(t.fromFundName)} → ${escapeHtml(t.toFundName)}</strong>`
                : escapeHtml(t.fundName);
              const amtDisplay = isTransfer
                ? escapeHtml(formatVND(t.amount))
                : (isRefund || isSupplier)
                  ? escapeHtml(formatSignedVND(-parseVND(t.amount)))
                  : isAdj
                    ? escapeHtml(formatSignedVND(t.amount))
                    : `+${escapeHtml(formatVND(t.amount))}`;
              const linkedCol = isSupplier && t.invoiceId
                ? `<button type="button" class="fin-link-btn" data-fin-jump-invoice="${escapeHtml(t.invoiceId)}">HĐ ${escapeHtml(t.invoiceVoucherNo || t.invoiceId)} • ${escapeHtml(t.supplierName || "Nhà cung cấp")} ↗</button>`
                : t.bookingId
                  ? `<button type="button" class="fin-link-btn" data-fin-jump-booking="${escapeHtml(t.bookingId)}">${t.groupCodeDisplay ? `Đoàn ${escapeHtml(t.groupCodeDisplay)}` : escapeHtml(t.roomLabel)} • ${escapeHtml(t.guestName)}</button>`
                  : (t.note || t.reason ? escapeHtml(t.reason || t.note) : "—");
              return `
                <tr data-cb-voucher="${escapeHtml(t.voucherCode)}">
                  <td>
                    <span class="fin-voucher-code">${escapeHtml(t.voucherCode)}</span>
                    ${t.linkedVoucherCode ? `<div style="font-size:10.5px;color:var(--text-muted);">Gốc: ${escapeHtml(t.linkedVoucherCode)}</div>` : ""}
                  </td>
                  <td>
                    ${t.receivedDate ? escapeHtml(formatDateVN(t.receivedDate)) : "—"}
                    <div style="font-size:10.5px;color:var(--text-muted);">Ghi: ${escapeHtml(formatDateTimeVN(t.recordedAt))}</div>
                  </td>
                  <td><span class="fin-pill ${pillCls}">${escapeHtml(t.txTypeLabel)}</span></td>
                  <td>${fundCol}</td>
                  <td>
                    ${linkedCol}
                    ${t.note && (t.bookingId || t.invoiceId) ? `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(t.note)}</div>` : ""}
                  </td>
                  <td class="num" style="font-weight:800; color:${(isRefund || isSupplier) ? "#dc2626" : "inherit"};">${amtDisplay}</td>
                  <td>
                    ${escapeHtml(t.operator || "—")}
                    ${t.approvedBy ? `<div style="font-size:10.5px;color:var(--text-muted);">Duyệt: ${escapeHtml(t.approvedBy)}</div>` : ""}
                  </td>
                  <td>
                    <button type="button" class="btn btn-sm ${t.reconciled ? "btn-success" : ""}" data-cb-toggle-rec="${escapeHtml(t.id)}" data-cb-rec-next="${t.reconciled ? "0" : "1"}">
                      ${t.reconciled ? "✓ Đã đối chiếu" : "Chưa đối chiếu"}
                    </button>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderCashbookDrawer(report) {
    const drawer = $("cb-action-drawer");
    if (!drawer) return;
    if (!uiState.cbDrawer) {
      drawer.style.display = "none";
      drawer.innerHTML = "";
      return;
    }

    const todayVN = getVietnamTodayISO();
    const activeFundOptions = FINANCE_FUNDS.filter((f) => !f.isLegacyBucket)
      .map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join("");

    if (uiState.cbDrawer === "transfer") {
      drawer.innerHTML = `
        <div class="fin-inline-form-title" style="margin-bottom:8px;">
          <span>⇄ Chuyển quỹ nội bộ (Tiền mặt ↔ Ngân hàng — không ảnh hưởng công nợ khách)</span>
          <button type="button" class="btn btn-sm" data-cb-close-drawer="1">Đóng</button>
        </div>
        <div id="cb-drawer-error" class="form-error"></div>
        <div class="form-grid-3">
          <div class="field">
            <label for="cb-trf-from">Từ quỹ *</label>
            <select id="cb-trf-from" class="select">${activeFundOptions}</select>
          </div>
          <div class="field">
            <label for="cb-trf-to">Sang quỹ *</label>
            <select id="cb-trf-to" class="select">
              ${FINANCE_FUNDS.filter((f) => !f.isLegacyBucket).map((f, i) => `<option value="${escapeHtml(f.id)}" ${i === 1 ? "selected" : ""}>${escapeHtml(f.name)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="cb-trf-amount">Số tiền chuyển (VNĐ) *</label>
            <input id="cb-trf-amount" class="input" type="text" inputmode="numeric" placeholder="VD: 2.000.000" />
          </div>
        </div>
        <div class="form-grid" style="margin-top:8px;">
          <div class="field">
            <label for="cb-trf-date">Ngày chuyển quỹ (VN) *</label>
            <input id="cb-trf-date" class="input" type="date" value="${escapeHtml(todayVN)}" />
          </div>
          <div class="field">
            <label for="cb-trf-note">Ghi chú (nộp tiền mặt vào ngân hàng...)</label>
            <input id="cb-trf-note" class="input" type="text" placeholder="VD: Nộp tiền mặt ca sáng vào TK VietinBank..." />
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">
          <button type="button" class="btn btn-sm" data-cb-close-drawer="1">Hủy</button>
          <button type="button" class="btn btn-sm btn-primary" id="btn-cb-submit-transfer">✓ Xác nhận chuyển quỹ</button>
        </div>
      `;
    } else if (uiState.cbDrawer === "opening") {
      drawer.innerHTML = `
        <div class="fin-inline-form-title" style="margin-bottom:8px;">
          <span>📌 Khai báo số dư đầu kỳ quỹ (có ngày mốc &amp; chứng từ kiểm kê)</span>
          <button type="button" class="btn btn-sm" data-cb-close-drawer="1">Đóng</button>
        </div>
        <div id="cb-drawer-error" class="form-error"></div>
        <div class="form-grid-3">
          <div class="field">
            <label for="cb-ob-fund">Quỹ / Tài khoản *</label>
            <select id="cb-ob-fund" class="select">${activeFundOptions}</select>
          </div>
          <div class="field">
            <label for="cb-ob-date">Ngày mốc đầu kỳ *</label>
            <input id="cb-ob-date" class="input" type="date" value="${escapeHtml(todayVN)}" />
          </div>
          <div class="field">
            <label for="cb-ob-amount">Số dư đầu kỳ (VNĐ) *</label>
            <input id="cb-ob-amount" class="input" type="text" inputmode="numeric" placeholder="VD: 5.000.000" />
          </div>
        </div>
        <div class="form-grid" style="margin-top:8px;">
          <div class="field">
            <label for="cb-ob-ref">Số biên bản / Chứng từ tham chiếu</label>
            <input id="cb-ob-ref" class="input" type="text" placeholder="VD: BBKK-01/11" />
          </div>
          <div class="field">
            <label for="cb-ob-note">Ghi chú</label>
            <input id="cb-ob-note" class="input" type="text" placeholder="VD: Kiểm kê bàn giao đầu tháng..." />
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">
          <button type="button" class="btn btn-sm" data-cb-close-drawer="1">Hủy</button>
          <button type="button" class="btn btn-sm btn-primary" id="btn-cb-submit-opening">✓ Lưu số dư đầu kỳ</button>
        </div>
      `;
    } else if (uiState.cbDrawer === "reconcile") {
      const cashBal = report.activeFunds.find((f) => f.id === "cash_frontdesk")?.closingBalance || 0;
      const bankBal = report.activeFunds.find((f) => f.id === "bank_main")?.closingBalance || 0;
      drawer.innerHTML = `
        <div class="fin-inline-form-title" style="margin-bottom:8px;">
          <span>✓ Đối chiếu tiền thực đếm / sao kê ngân hàng (ghi nhận chênh lệch, KHÔNG tự tạo phiếu bù)</span>
          <button type="button" class="btn btn-sm" data-cb-close-drawer="1">Đóng</button>
        </div>
        <div id="cb-drawer-error" class="form-error"></div>
        <div style="font-size:12px; color:var(--text-secondary); margin-bottom:8px;">
          Số dư theo sổ hiện tại: Tiền mặt <strong>${escapeHtml(formatVND(cashBal))}</strong> • Ngân hàng <strong>${escapeHtml(formatVND(bankBal))}</strong>
        </div>
        <div class="form-grid-3">
          <div class="field">
            <label for="cb-rec-fund">Quỹ đối chiếu *</label>
            <select id="cb-rec-fund" class="select">${activeFundOptions}</select>
          </div>
          <div class="field">
            <label for="cb-rec-date">Ngày kiểm kê / sao kê *</label>
            <input id="cb-rec-date" class="input" type="date" value="${escapeHtml(todayVN)}" />
          </div>
          <div class="field">
            <label for="cb-rec-actual">Số tiền thực tế đếm / sao kê (VNĐ) *</label>
            <input id="cb-rec-actual" class="input" type="text" inputmode="numeric" placeholder="VD: 2.000.000" />
          </div>
        </div>
        <div class="field" style="margin-top:8px;">
          <label for="cb-rec-note">Ghi chú kiểm kê / giải trình chênh lệch</label>
          <input id="cb-rec-note" class="input" type="text" placeholder="VD: Kiểm kê cuối ca chiều, thiếu 50.000đ đang rà soát..." />
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">
          <button type="button" class="btn btn-sm" data-cb-close-drawer="1">Hủy</button>
          <button type="button" class="btn btn-sm btn-primary" id="btn-cb-submit-reconcile">✓ Ghi nhận mốc đối chiếu</button>
        </div>
      `;
    } else if (uiState.cbDrawer === "adjust") {
      drawer.innerHTML = `
        <div class="fin-inline-form-title" style="margin-bottom:8px;">
          <span>± Điều chỉnh số dư quỹ có lý do &amp; người duyệt (tách biệt với Thu khách)</span>
          <button type="button" class="btn btn-sm" data-cb-close-drawer="1">Đóng</button>
        </div>
        <div id="cb-drawer-error" class="form-error"></div>
        <div class="form-grid-3">
          <div class="field">
            <label for="cb-adj-fund">Quỹ điều chỉnh *</label>
            <select id="cb-adj-fund" class="select">${activeFundOptions}</select>
          </div>
          <div class="field">
            <label for="cb-adj-amount">Số tiền điều chỉnh (âm = giảm) *</label>
            <input id="cb-adj-amount" class="input" type="text" placeholder="VD: -50.000 hoặc 100.000" />
          </div>
          <div class="field">
            <label for="cb-adj-date">Ngày điều chỉnh *</label>
            <input id="cb-adj-date" class="input" type="date" value="${escapeHtml(todayVN)}" />
          </div>
        </div>
        <div class="field" style="margin-top:8px;">
          <label for="cb-adj-reason">Lý do điều chỉnh quỹ *</label>
          <input id="cb-adj-reason" class="input" type="text" placeholder="VD: Bù lệch lẻ tiền mặt đã xác minh..." />
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">
          <button type="button" class="btn btn-sm" data-cb-close-drawer="1">Hủy</button>
          <button type="button" class="btn btn-sm btn-primary" id="btn-cb-submit-adjust">✓ Duyệt điều chỉnh quỹ</button>
        </div>
      `;
    }

    drawer.style.display = "block";
  }

  function renderCashbookLegacyTab(content, report) {
    const items = report.legacyUnreconciled || [];
    const resolvedOpening = report.resolvedOpeningLegacy || [];
    if (items.length === 0 && resolvedOpening.length === 0) {
      content.innerHTML = `<div class="fin-empty">✅ Không có khoản chuyển tiếp nào chưa xác minh.</div>`;
      return;
    }
    const todayVN = getVietnamTodayISO();
    content.innerHTML = `
      <div style="font-size:12px; color:var(--text-secondary); margin-bottom:8px;">
        Khi xác minh từng khoản chuyển tiếp từ đơn cũ, chọn rõ khoản tiền đó <strong>đã nằm trong số dư đầu kỳ</strong> (hệ thống xóa treo &amp; KHÔNG cộng lại vào quỹ) hay <strong>cần ghi bổ sung vào quỹ</strong> (kèm ngày thực nhận, quỹ nhận và căn cứ đối soát).
      </div>
      ${items.length > 0 ? `
        <div class="fin-table-wrap" style="margin-bottom:12px;">
          <table class="fin-tx-table">
            <thead>
              <tr>
                <th>Mã CT</th>
                <th class="num">Số tiền</th>
                <th>Cách xử lý quỹ *</th>
                <th>Ngày / Quỹ (khi ghi bổ sung)</th>
                <th>Căn cứ đối soát *</th>
                <th>Xác minh</th>
              </tr>
            </thead>
            <tbody>
              ${items.map((tx) => `
                <tr data-legacy-verify-row="${escapeHtml(tx.id)}">
                  <td>
                    <span class="fin-voucher-code">${escapeHtml(tx.voucherCode)}</span>
                    <div style="font-size:10.5px; color:var(--text-muted);">${escapeHtml(tx.note || "")}</div>
                  </td>
                  <td class="num" style="font-weight:800;">${escapeHtml(formatVND(tx.amount))}</td>
                  <td>
                    <select class="select" data-leg-resolution style="min-width:190px;">
                      <option value="included_in_opening">Đã nằm trong số dư đầu kỳ (không cộng quỹ)</option>
                      <option value="record_to_fund">Ghi bổ sung vào quỹ thực tế</option>
                    </select>
                  </td>
                  <td>
                    <div style="display:flex; gap:4px; flex-wrap:wrap;">
                      <input class="input" data-leg-date type="date" value="${escapeHtml(tx.receivedDate || todayVN)}" style="min-width:128px;" disabled />
                      <select class="select" data-leg-fund style="min-width:130px;" disabled>
                        ${FINANCE_FUNDS.filter((f) => !f.isLegacyBucket).map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.shortName)}</option>`).join("")}
                      </select>
                    </div>
                  </td>
                  <td>
                    <input class="input" data-leg-evidence type="text" placeholder="VD: BBKK đầu kỳ 01/11, Sao kê NH..." style="min-width:165px;" />
                  </td>
                  <td>
                    <button type="button" class="btn btn-sm btn-primary" data-leg-verify-submit="${escapeHtml(tx.id)}">✓ Xác minh</button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `<div class="fin-empty" style="margin-bottom:12px;">✅ Không còn khoản chuyển tiếp treo chưa xác minh.</div>`}
      ${resolvedOpening.length > 0 ? `
        <div style="font-weight:800; font-size:12.5px; margin-bottom:6px;">📌 Khoản chuyển tiếp đã xác minh nằm trong số dư đầu kỳ (${resolvedOpening.length} phiếu — không cộng trùng quỹ)</div>
        <div class="fin-table-wrap">
          <table class="fin-tx-table">
            <thead><tr><th>Mã CT</th><th class="num">Số tiền</th><th>Căn cứ đối soát</th><th>Người xác minh</th><th>Thời điểm</th></tr></thead>
            <tbody>
              ${resolvedOpening.map((tx) => `
                <tr>
                  <td><span class="fin-voucher-code">${escapeHtml(tx.voucherCode)}</span></td>
                  <td class="num" style="font-weight:800;">${escapeHtml(formatVND(tx.amount))}</td>
                  <td>${escapeHtml(tx.reconcileEvidence || tx.reconcileNote || "—")}</td>
                  <td>${escapeHtml(tx.reconciledBy || "—")}</td>
                  <td>${escapeHtml(formatDateTimeVN(tx.reconciledAt))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : ""}
    `;
  }

  function renderCashbookLogsTab(content, fState, report) {
    const checks = (fState.reconciliationChecks || []).slice().reverse();
    const resolvedOpening = report.resolvedOpeningLegacy || [];
    const syncLogs = (report.syncLogs || []).slice(0, 50);
    const migLogs = (fState.migrationHistory || []).slice(0, 20);

    content.innerHTML = `
      <div style="font-weight:800; font-size:12.5px; margin-bottom:6px;">📋 Lịch sử đối chiếu kiểm kê tiền mặt / sao kê (${checks.length})</div>
      ${checks.length > 0 ? `
        <div class="fin-table-wrap" style="margin-bottom:12px;">
          <table class="fin-tx-table">
            <thead><tr><th>Ngày kiểm kê</th><th>Thời điểm</th><th>Quỹ</th><th class="num">Số dư sổ</th><th class="num">Thực tế</th><th class="num">Chênh lệch</th><th>Người kiểm</th><th>Ghi chú</th></tr></thead>
            <tbody>
              ${checks.map((c) => `
                <tr>
                  <td>${escapeHtml(formatDateVN(c.asOfDate))}</td>
                  <td>${escapeHtml(formatDateTimeVN(c.checkedAt))}</td>
                  <td>${escapeHtml(getFinanceFundById(c.fundId).shortName)}</td>
                  <td class="num">${escapeHtml(formatVND(c.bookBalanceAtCheck))}</td>
                  <td class="num">${escapeHtml(formatVND(c.actualBalance))}</td>
                  <td class="num" style="font-weight:800; color:${c.discrepancy === 0 ? "var(--status-paid,#15803d)" : "#dc2626"};">${escapeHtml(formatSignedVND(c.discrepancy))}</td>
                  <td>${escapeHtml(c.checkedBy || "—")}</td>
                  <td>${escapeHtml(c.note || "—")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `<div class="fin-empty" style="margin-bottom:12px;">Chưa có biên bản đối chiếu quỹ nào.</div>`}

      ${resolvedOpening.length > 0 ? `
        <div style="font-weight:800; font-size:12.5px; margin-bottom:6px;">📌 Xác minh khoản chuyển tiếp đã nằm trong số dư đầu kỳ (${resolvedOpening.length})</div>
        <div class="fin-table-wrap" style="margin-bottom:12px;">
          <table class="fin-tx-table">
            <thead><tr><th>Mã CT</th><th class="num">Số tiền</th><th>Căn cứ đối soát</th><th>Người xác minh</th><th>Thời điểm</th></tr></thead>
            <tbody>
              ${resolvedOpening.map((tx) => `
                <tr>
                  <td><span class="fin-voucher-code">${escapeHtml(tx.voucherCode)}</span></td>
                  <td class="num" style="font-weight:800;">${escapeHtml(formatVND(tx.amount))}</td>
                  <td>${escapeHtml(tx.reconcileEvidence || tx.reconcileNote || "—")}</td>
                  <td>${escapeHtml(tx.reconciledBy || "—")}</td>
                  <td>${escapeHtml(formatDateTimeVN(tx.reconciledAt))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : ""}

      <div style="font-weight:800; font-size:12.5px; margin-bottom:6px;">🔄 Nhật ký đồng bộ &amp; chuyển đổi dữ liệu (${syncLogs.length + migLogs.length})</div>
      ${(syncLogs.length + migLogs.length) > 0 ? `
        <div class="fin-table-wrap">
          <table class="fin-tx-table">
            <thead><tr><th>Thời gian (VN)</th><th>Loại</th><th>Chi tiết</th><th>Người thao tác</th></tr></thead>
            <tbody>
              ${migLogs.map((m) => `
                <tr>
                  <td>${escapeHtml(formatDateTimeVN(m.ts))}</td>
                  <td><span class="fin-pill amber">Chuyển tiếp đơn cũ</span></td>
                  <td>Tạo ${m.createdCount} phiếu chuyển tiếp • Tổng ${escapeHtml(formatVND(m.migratedTotalAmount || 0))}</td>
                  <td>${escapeHtml(m.operator || "—")}</td>
                </tr>
              `).join("")}
              ${syncLogs.map((l) => `
                <tr>
                  <td>${escapeHtml(formatDateTimeVN(l.ts))}</td>
                  <td><span class="fin-pill muted">${escapeHtml(l.category || "sync")}</span></td>
                  <td>${escapeHtml(l.message || "—")}</td>
                  <td>${escapeHtml(l.operator || "—")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `<div class="fin-empty">Chưa ghi nhận cảnh báo đồng bộ nào.</div>`}
    `;
  }

  function showDrawerError(msg) {
    const err = $("cb-drawer-error");
    if (err) {
      err.textContent = msg;
      err.classList.add("open");
    } else {
      showToast(msg, "error");
    }
  }

  /* ============================================================================
     4. MONTHLY RECEIPTS DRILLDOWN MODAL (#monthly-receipts-modal)
     ============================================================================ */

  function openMonthlyReceipts(year, month0) {
    if (!can("finance:ar_read")) {
      showToast("Bạn không có quyền xem chi tiết thu tiền.", "error");
      return;
    }
    const modal = $("monthly-receipts-modal");
    if (!modal) return;
    uiState.monthlyReceiptsYear = year;
    uiState.monthlyReceiptsMonth0 = month0;
    modal.classList.add("open");
    renderMonthlyReceipts();
  }

  function closeMonthlyReceipts() {
    const modal = $("monthly-receipts-modal");
    if (modal) modal.classList.remove("open");
  }

  function renderMonthlyReceipts() {
    const modal = $("monthly-receipts-modal");
    if (!modal || !modal.classList.contains("open")) return;
    const nowParts = Core.toVietnamParts(new Date()) || { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
    const year = Number.isInteger(uiState.monthlyReceiptsYear) ? uiState.monthlyReceiptsYear : nowParts.year;
    const month0 = Number.isInteger(uiState.monthlyReceiptsMonth0) ? uiState.monthlyReceiptsMonth0 : (nowParts.month - 1);

    const kpi = computeCalendarFinanceKPIs(getBookings(), getFinanceState(), year, month0);
    if ($("mr-modal-title")) {
      $("mr-modal-title").textContent = `Tiền thực thu Tháng ${month0 + 1} / ${year}`;
    }
    if ($("mr-summary-strip")) {
      $("mr-summary-strip").innerHTML = `
        <div class="fin-kpi-card success">
          <span class="fin-stat-lbl">Tiền thực thu ròng tháng ${month0 + 1}/${year}</span>
          <span class="fin-stat-val ok" id="mr-kpi-net">${escapeHtml(formatVND(kpi.monthlyNetReceived))}</span>
          <span class="fin-stat-sub">${kpi.monthlyTxCount} giao dịch trong tháng</span>
        </div>
        <div class="fin-kpi-card">
          <span class="fin-stat-lbl">Tổng thu khách (Gross)</span>
          <span class="fin-stat-val">${escapeHtml(formatVND(kpi.monthlyGrossIn))}</span>
        </div>
        <div class="fin-kpi-card ${kpi.monthlyRefunds > 0 ? "danger" : ""}">
          <span class="fin-stat-lbl">Đã hoàn tiền trong tháng</span>
          <span class="fin-stat-val ${kpi.monthlyRefunds > 0 ? "warn" : ""}">${escapeHtml(formatVND(kpi.monthlyRefunds))}</span>
        </div>
      `;
    }

    const listArea = $("mr-list-area");
    if (!listArea) return;
    if (kpi.monthlyTxList.length === 0) {
      listArea.innerHTML = `<div class="fin-empty">Chưa có giao dịch thu / hoàn tiền nào có ngày thực nhận trong Tháng ${month0 + 1}/${year}.</div>`;
      return;
    }

    listArea.innerHTML = `
      <div class="fin-table-wrap">
        <table class="fin-tx-table">
          <thead>
            <tr>
              <th>Mã CT</th>
              <th>Ngày thực nhận</th>
              <th>Loại</th>
              <th>Quỹ</th>
              <th>Đơn / Khách</th>
              <th class="num">Số tiền</th>
              <th>Người thao tác</th>
            </tr>
          </thead>
          <tbody>
            ${kpi.monthlyTxList.map((tx) => {
              const isRef = tx.txType === "customer_refund";
              return `
                <tr>
                  <td><span class="fin-voucher-code">${escapeHtml(tx.voucherCode)}</span></td>
                  <td>${escapeHtml(formatDateVN(tx.receivedDate))}</td>
                  <td>${isRef ? '<span class="fin-pill warn">Hoàn tiền</span>' : '<span class="fin-pill ok">Thu tiền</span>'}</td>
                  <td>${escapeHtml(tx.fundName)}</td>
                  <td>
                    ${tx.bookingId
                      ? `<button type="button" class="fin-link-btn" data-fin-jump-booking="${escapeHtml(tx.bookingId)}">${tx.groupCodeDisplay ? `Đoàn ${escapeHtml(tx.groupCodeDisplay)}` : escapeHtml(tx.roomLabel)} • ${escapeHtml(tx.guestName)}</button>`
                      : escapeHtml(tx.guestName || "—")}
                  </td>
                  <td class="num" style="font-weight:800; color:${isRef ? "#dc2626" : "var(--status-paid,#15803d)"};">${escapeHtml(formatSignedVND(tx.signedAmount))}</td>
                  <td>${escapeHtml(tx.operator || "—")}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  /* ============================================================================
     5. SUPPLIER INVOICES & ACCOUNTS PAYABLE (#payables-modal — Manager / Super Admin)
     ============================================================================ */

  function openPayables(opts = {}) {
    if (!can("finance:payables_read")) {
      showToast("Hóa đơn nhà cung cấp & công nợ phải trả thuộc quyền Quản lý / Tổng quản lý.", "error");
      return;
    }
    const modal = $("payables-modal");
    if (!modal) return;
    if (opts.accountingMonth !== undefined && $("ap-filter-month")) {
      $("ap-filter-month").value = opts.accountingMonth || "";
    }
    if (opts.asOfDate !== undefined && $("ap-filter-asof")) {
      $("ap-filter-asof").value = opts.asOfDate || "";
    }
    if (opts.status !== undefined && $("ap-filter-status")) {
      $("ap-filter-status").value = opts.status || "all";
    }
    if (opts.search !== undefined && $("ap-filter-search")) {
      $("ap-filter-search").value = opts.search || "";
    }
    if (opts.focusInvoiceId) {
      uiState.apFocusInvoiceId = opts.focusInvoiceId;
      uiState.apExpandedIds.add(opts.focusInvoiceId);
      // Clear restrictive filters so the focused invoice is guaranteed visible
      if ($("ap-filter-search")) $("ap-filter-search").value = "";
      if ($("ap-filter-supplier")) $("ap-filter-supplier").value = "all";
      if ($("ap-filter-month")) $("ap-filter-month").value = "";
      if ($("ap-filter-asof")) $("ap-filter-asof").value = "";
      if ($("ap-filter-status")) $("ap-filter-status").value = "all";
    }
    if (opts.newInvoice) {
      openPayablesForm(null, opts.accountingMonth || "");
    }
    modal.classList.add("open");
    renderPayables();
    if (root.PMSPcApi && typeof root.PMSPcApi.syncActiveNav === "function") {
      root.PMSPcApi.syncActiveNav();
    }
  }

  function closePayables() {
    const modal = $("payables-modal");
    if (modal) modal.classList.remove("open");
    uiState.apFormOpen = false;
    uiState.apEditId = null;
    uiState.apPayInvoiceId = null;
    uiState.apFocusInvoiceId = null;
    uiState.apStaleConflict = null;
    if (root.PMSPcApi && typeof root.PMSPcApi.syncActiveNav === "function") {
      root.PMSPcApi.syncActiveNav();
    }
  }

  function getPayablesFilters() {
    return {
      search: ($("ap-filter-search") && $("ap-filter-search").value) || "",
      supplier: ($("ap-filter-supplier") && $("ap-filter-supplier").value) || "all",
      accountingMonth: ($("ap-filter-month") && $("ap-filter-month").value) || "",
      asOfDate: ($("ap-filter-asof") && $("ap-filter-asof").value) || "",
      status: ($("ap-filter-status") && $("ap-filter-status").value) || "all"
    };
  }

  function openPayablesForm(editInvoiceId = null, defaultMonth = "") {
    if (!can("finance:payables_write")) {
      showToast("Bạn không có quyền tạo/sửa hóa đơn nhà cung cấp.", "error");
      return;
    }
    uiState.apFormOpen = true;
    uiState.apEditId = editInvoiceId || null;
    const fState = getFinanceState();
    const existing = editInvoiceId ? (fState.supplierInvoices || []).find((x) => x.id === editInvoiceId) : null;
    uiState.apFormAttachment = existing && existing.attachment ? { ...existing.attachment } : null;
    renderPayablesFormDrawer(existing, defaultMonth);
  }

  function closePayablesForm() {
    uiState.apFormOpen = false;
    uiState.apEditId = null;
    uiState.apFormAttachment = null;
    const drawer = $("ap-form-drawer");
    if (drawer) {
      drawer.style.display = "none";
      drawer.innerHTML = "";
    }
  }

  function buildApLineRowHtml(costItems, line = {}) {
    const selectedId = line.costItemId || (costItems[0] && costItems[0].id) || "";
    const optionsHtml = costItems.map((it) => `
      <option value="${escapeHtml(it.id)}" ${it.id === selectedId ? "selected" : ""}>${escapeHtml(it.name)}</option>
    `).join("");
    return `
      <div class="ap-line-row" data-ap-line-row="1">
        <select class="select" data-ap-line-item aria-label="Khoản mục chi phí">${optionsHtml}</select>
        <input class="input" data-ap-line-desc type="text" value="${escapeHtml(line.description || "")}" placeholder="Diễn giải (VD: Tiền điện tháng 10)..." />
        <input class="input" data-ap-line-amt type="text" inputmode="numeric" value="${line.amount ? escapeHtml(formatNumberInput(line.amount)) : ""}" placeholder="Số tiền (VNĐ)" />
        <button type="button" class="btn btn-sm btn-danger" data-ap-remove-line="1" title="Xóa dòng">✕</button>
      </div>
    `;
  }

  function renderApLegacyLinkSection(monthKey, selectedIds = [], editInvoiceId = null) {
    const costState = getOperatingCostsState();
    const fState = getFinanceState();
    const alreadyLinkedByOther = new Set();
    for (const inv of (fState.supplierInvoices || [])) {
      if (editInvoiceId && inv.id === editInvoiceId) continue;
      for (const eid of (inv.linkedLegacyEntryIds || [])) alreadyLinkedByOther.add(eid);
    }
    const candidates = (costState.actualEntries || []).filter((e) =>
      e.accountingMonth === monthKey && !alreadyLinkedByOther.has(e.id)
    );
    if (candidates.length === 0) return "";
    const costItemMap = new Map((costState.items || []).map((it) => [it.id, it.name]));
    const selectedSet = new Set(selectedIds || []);
    return `
      <div class="ap-legacy-link-box" style="margin-top:8px;">
        <strong>🔗 Liên kết chứng từ chi tay cũ trong kỳ ${escapeHtml(monthKey)} (tùy chọn — tránh cộng trùng chi phí):</strong>
        <div style="font-size:11px; color:var(--text-secondary);">Nếu khoản chi này trước đây đã nhập tay ở màn Chi phí, hãy tick chọn bên dưới để hệ thống giữ nguyên lịch sử cũ nhưng KHÔNG cộng trùng số tiền.</div>
        ${candidates.map((e) => `
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" data-ap-legacy-chk value="${escapeHtml(e.id)}" ${selectedSet.has(e.id) ? "checked" : ""} />
            <span><strong>${escapeHtml(costItemMap.get(e.itemId) || e.itemId)}</strong> • ${escapeHtml(formatVND(e.amount))} • Ngày ${escapeHtml(formatDateVN(e.expenseDate))} ${e.note ? `(${escapeHtml(e.note)})` : ""}</span>
          </label>
        `).join("")}
      </div>
    `;
  }

  function renderPayablesFormDrawer(existing = null, defaultMonth = "") {
    const drawer = $("ap-form-drawer");
    if (!drawer) return;
    if (!uiState.apFormOpen) {
      drawer.style.display = "none";
      drawer.innerHTML = "";
      return;
    }
    const costState = getOperatingCostsState();
    const costItems = (costState.items || []).filter((it) => it.active !== false);
    const todayVN = getVietnamTodayISO();
    const invDate = (existing && existing.invoiceDate) || todayVN;
    const accMonth = (existing && existing.accountingMonth) || defaultMonth || invDate.slice(0, 7);
    const dueDate = (existing && existing.dueDate) || "";
    const lines = existing && Array.isArray(existing.lines) && existing.lines.length > 0
      ? existing.lines
      : [{ costItemId: (costItems[0] && costItems[0].id) || "", description: "", amount: 0 }];
    const initialSum = lines.reduce((s, l) => s + parseVND(l.amount), 0);
    const att = uiState.apFormAttachment;

    drawer.innerHTML = `
      <div class="fin-inline-form-title" style="margin-bottom:8px;">
        <span>${existing ? `✏️ Sửa hóa đơn NCC (${escapeHtml(existing.voucherNo)})` : "🧾 Tạo hóa đơn nhà cung cấp mới"}</span>
        <button type="button" class="btn btn-sm" id="btn-ap-close-form">Đóng</button>
      </div>
      <div id="ap-form-error" class="form-error"></div>
      <div class="form-grid-3">
        <div class="field">
          <label for="ap-f-supplier">Nhà cung cấp *</label>
          <input id="ap-f-supplier" class="input" type="text" value="${escapeHtml(existing ? existing.supplierName : "")}" placeholder="VD: Điện lực Đồng Văn (EVN)..." />
        </div>
        <div class="field">
          <label for="ap-f-voucher">Số chứng từ / Số hóa đơn *</label>
          <input id="ap-f-voucher" class="input" type="text" value="${escapeHtml(existing ? existing.voucherNo : "")}" placeholder="VD: HD-DIEN-202610" />
        </div>
        <div class="field">
          <label for="ap-f-invoice-date">Ngày hóa đơn *</label>
          <input id="ap-f-invoice-date" class="input" type="date" value="${escapeHtml(invDate)}" />
        </div>
      </div>
      <div class="form-grid-3" style="margin-top:8px;">
        <div class="field">
          <label for="ap-f-acc-month">Kỳ ghi nhận chi phí (tháng) *</label>
          <input id="ap-f-acc-month" class="input" type="month" value="${escapeHtml(accMonth)}" />
        </div>
        <div class="field">
          <label for="ap-f-due-date">Hạn thanh toán</label>
          <input id="ap-f-due-date" class="input" type="date" value="${escapeHtml(dueDate)}" />
        </div>
        <div class="field">
          <label for="ap-f-note">Ghi chú</label>
          <input id="ap-f-note" class="input" type="text" value="${escapeHtml(existing ? existing.note : "")}" placeholder="VD: Tiền điện kỳ T10, thanh toán 2 đợt..." />
        </div>
      </div>
      <div style="margin-top:10px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">
          <strong style="font-size:12.5px;">Các dòng khoản mục chi phí (tự liên kết màn Chi phí &amp; giá vốn theo kỳ) *</strong>
          <button type="button" class="btn btn-sm" id="btn-ap-add-line">+ Thêm dòng khoản mục</button>
        </div>
        <div id="ap-lines-container">
          ${lines.map((l) => buildApLineRowHtml(costItems, l)).join("")}
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-top:6px; font-size:12.5px;">
          <div>
            <label class="btn btn-sm" for="ap-f-attachment" style="cursor:pointer;">
              📎 Đính kèm ảnh / PDF chứng từ
              <input id="ap-f-attachment" type="file" accept="image/*,.pdf,application/pdf" hidden />
            </label>
            <span id="ap-f-att-status" style="margin-left:6px; font-size:11.5px; color:var(--text-secondary);">
              ${att ? `Đã đính kèm: <strong>${escapeHtml(att.name)}</strong> <button type="button" class="fin-link-btn" id="btn-ap-clear-att">Gỡ tệp</button>` : "Chưa đính kèm tệp (tùy chọn)"}
            </span>
          </div>
          <div>Tổng tiền hóa đơn: <strong id="ap-f-total-preview" style="font-size:14px; color:var(--accent-primary);">${escapeHtml(formatVND(initialSum))}</strong></div>
        </div>
      </div>
      <div id="ap-legacy-link-wrap">
        ${renderApLegacyLinkSection(accMonth, existing ? existing.linkedLegacyEntryIds : [], existing ? existing.id : null)}
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">
        <button type="button" class="btn btn-sm" id="btn-ap-cancel-form">Hủy</button>
        <button type="button" class="btn btn-sm btn-primary" id="btn-ap-save-invoice">✓ Lưu hóa đơn nhà cung cấp</button>
      </div>
    `;
    drawer.style.display = "block";
  }

  function updateApFormTotalPreview() {
    const container = $("ap-lines-container");
    const preview = $("ap-f-total-preview");
    if (!container || !preview) return;
    let sum = 0;
    container.querySelectorAll("[data-ap-line-amt]").forEach((inp) => {
      sum += parseVND(inp.value);
    });
    preview.textContent = formatVND(sum);
  }

  function showApFormError(msg) {
    const el = $("ap-form-error");
    if (el) {
      el.textContent = msg;
      el.classList.add("open");
    } else {
      showToast(msg, "error");
    }
  }

  async function submitSupplierInvoiceForm() {
    const supplierName = ($("ap-f-supplier") && $("ap-f-supplier").value.trim()) || "";
    const voucherNo = ($("ap-f-voucher") && $("ap-f-voucher").value.trim()) || "";
    const invoiceDate = ($("ap-f-invoice-date") && $("ap-f-invoice-date").value) || "";
    const accountingMonth = ($("ap-f-acc-month") && $("ap-f-acc-month").value) || "";
    const dueDate = ($("ap-f-due-date") && $("ap-f-due-date").value) || "";
    const note = ($("ap-f-note") && $("ap-f-note").value.trim()) || "";

    if (!supplierName) return showApFormError("Vui lòng nhập tên nhà cung cấp.");
    if (!voucherNo) return showApFormError("Vui lòng nhập số chứng từ / số hóa đơn.");
    if (!invoiceDate) return showApFormError("Vui lòng chọn ngày hóa đơn.");
    if (!accountingMonth) return showApFormError("Vui lòng chọn kỳ ghi nhận chi phí (tháng).");

    const costState = getOperatingCostsState();
    const costItemMap = new Map((costState.items || []).map((it) => [it.id, it.name]));
    const lines = [];
    const container = $("ap-lines-container");
    if (container) {
      container.querySelectorAll("[data-ap-line-row]").forEach((row) => {
        const costItemId = row.querySelector("[data-ap-line-item]")?.value || "";
        const description = row.querySelector("[data-ap-line-desc]")?.value.trim() || "";
        const amount = parseVND(row.querySelector("[data-ap-line-amt]")?.value);
        if (costItemId && amount > 0) {
          lines.push({
            costItemId,
            costItemName: costItemMap.get(costItemId) || costItemId,
            description,
            amount
          });
        }
      });
    }
    if (lines.length === 0) {
      return showApFormError("Hóa đơn phải có ít nhất 1 dòng khoản mục với số tiền lớn hơn 0 đ.");
    }

    const linkedLegacyEntryIds = [];
    const legacyWrap = $("ap-legacy-link-wrap");
    if (legacyWrap) {
      legacyWrap.querySelectorAll("[data-ap-legacy-chk]:checked").forEach((chk) => {
        if (chk.value) linkedLegacyEntryIds.push(chk.value);
      });
    }

    const payload = {
      id: uiState.apEditId || undefined,
      supplierName,
      voucherNo,
      invoiceDate,
      accountingMonth,
      dueDate,
      lines,
      attachment: uiState.apFormAttachment || null,
      linkedLegacyEntryIds,
      note
    };

    const res = await store.saveSupplierInvoice(payload);
    if (res && res.ok) {
      const savedId = res.invoice && res.invoice.id;
      closePayablesForm();
      if (savedId) {
        uiState.apExpandedIds.add(savedId);
        uiState.apFocusInvoiceId = savedId;
      }
      showToast(`Đã lưu hóa đơn ${voucherNo} (${formatVND(res.invoice ? res.invoice.totalAmount : 0)}).`, "success");
      notifyHostUI();
      renderPayables();
    } else {
      showApFormError((res && res.error) || "Không thể lưu hóa đơn nhà cung cấp.");
    }
  }

  async function submitSupplierPayment(invoiceId, overridePayload = null) {
    const fState = getFinanceState();
    const report = computeSupplierPayablesReport(fState, getOperatingCostsState(), {});
    const inv = report.rows.find((r) => r.id === invoiceId);
    if (!inv) return;

    let payload = overridePayload;
    if (!payload) {
      const formEl = document.querySelector(`[data-ap-pay-form="${CSS.escape(invoiceId)}"]`);
      if (!formEl) return;
      const amount = parseVND(formEl.querySelector('[data-ap-pay-field="amount"]')?.value);
      const paymentDate = formEl.querySelector('[data-ap-pay-field="date"]')?.value || getVietnamTodayISO();
      const fundId = formEl.querySelector('[data-ap-pay-field="fundId"]')?.value || "bank_main";
      const note = formEl.querySelector('[data-ap-pay-field="note"]')?.value.trim() || "";
      if (amount <= 0) {
        showToast("Số tiền thanh toán phải lớn hơn 0 đ.", "error");
        return;
      }
      if (amount > inv.allTimeRemainingAmount) {
        showToast(`Số tiền thanh toán (${formatVND(amount)}) vượt quá số còn phải trả (${formatVND(inv.allTimeRemainingAmount)}).`, "error");
        return;
      }
      payload = {
        amount,
        receivedDate: paymentDate,
        paymentDate,
        fundId,
        paymentMethod: fundId === "bank_main" ? "bank_transfer" : "cash",
        note,
        expectedRemaining: inv.allTimeRemainingAmount,
        idempotencyKey: makeIdempotencyKey("spay")
      };
    }

    const res = await store.paySupplierInvoice(invoiceId, payload);
    if (res && res.ok) {
      uiState.apPayInvoiceId = null;
      uiState.apStaleConflict = null;
      showToast(
        res.idempotentReplay
          ? `Phiếu chi ${res.transaction.voucherCode} đã được ghi nhận trước đó.`
          : `Đã chi ${formatVND(payload.amount)} • Phiếu ${res.transaction.voucherCode}`,
        "success"
      );
      notifyHostUI();
      renderPayables();
      return;
    }

    if (res && (res.code === "INVOICE_ALREADY_PAID" || res.code === "STALE_INVOICE_BALANCE")) {
      const freshRemaining = res.currentRemaining !== undefined ? res.currentRemaining : 0;
      uiState.apStaleConflict = {
        invoiceId,
        code: res.code,
        message: res.error || "Công nợ hóa đơn vừa được cập nhật từ người dùng khác.",
        currentRemaining: freshRemaining,
        pendingPayload: freshRemaining > 0 && payload.amount <= freshRemaining
          ? { ...payload, expectedRemaining: freshRemaining, idempotencyKey: makeIdempotencyKey("spay") }
          : null
      };
      renderPayables();
      return;
    }

    if (res && res.unconfirmed) {
      uiState.apPayInvoiceId = null;
      showToast(res.error || "Chưa xác nhận phản hồi máy chủ — đang chờ đồng bộ.", "error");
      syncPendingBars();
      renderPayables();
      return;
    }

    showToast((res && res.error) || "Không thể thanh toán hóa đơn nhà cung cấp.", "error");
  }

  function renderPayables() {
    const modal = $("payables-modal");
    if (!modal || !modal.classList.contains("open")) return;

    syncPendingBars();
    const fState = getFinanceState();
    const costState = getOperatingCostsState();
    const filters = getPayablesFilters();
    const report = computeSupplierPayablesReport(fState, costState, filters);

    // Populate Supplier dropdown preserving selection
    const supSel = $("ap-filter-supplier");
    if (supSel) {
      const curVal = supSel.value || "all";
      const allRep = computeSupplierPayablesReport(fState, costState, {});
      supSel.innerHTML = `<option value="all">Tất cả nhà cung cấp (${allRep.suppliers.length})</option>` +
        allRep.suppliers.map((s) => `<option value="${escapeHtml(s)}" ${s === curVal ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");
    }

    // KPI Summary Strip
    const strip = $("ap-summary-strip");
    if (strip) {
      strip.innerHTML = `
        <div class="fin-kpi-card">
          <span class="fin-stat-lbl">Tổng hóa đơn (${report.rows.length} HĐ)</span>
          <span class="fin-stat-val" id="ap-kpi-total-invoiced">${escapeHtml(formatVND(report.totalInvoiced))}</span>
          <span class="fin-stat-sub">Tính đến ${escapeHtml(formatDateVN(report.asOfDate))}</span>
        </div>
        <div class="fin-kpi-card success">
          <span class="fin-stat-lbl">Đã thanh toán NCC</span>
          <span class="fin-stat-val ok" id="ap-kpi-total-paid">${escapeHtml(formatVND(report.totalPaid))}</span>
          <span class="fin-stat-sub">${report.paidCount} HĐ đã trả đủ • ${report.partialCount} trả một phần</span>
        </div>
        <div class="fin-kpi-card danger">
          <span class="fin-stat-lbl">Công nợ còn phải trả</span>
          <span class="fin-stat-val warn" id="ap-kpi-total-remaining">${escapeHtml(formatVND(report.totalRemaining))}</span>
          <span class="fin-stat-sub">${report.unpaidCount + report.partialCount} HĐ chưa tất toán</span>
        </div>
        <div class="fin-kpi-card ${report.overdueRemaining > 0 ? "danger" : "highlight"}">
          <span class="fin-stat-lbl">Quá hạn thanh toán</span>
          <span class="fin-stat-val ${report.overdueRemaining > 0 ? "warn" : ""}" id="ap-kpi-overdue">${escapeHtml(formatVND(report.overdueRemaining))}</span>
          <span class="fin-stat-sub">${report.overdueCount} hóa đơn quá hạn</span>
        </div>
      `;
    }

    const content = $("ap-content-area");
    if (!content) return;

    const stale = uiState.apStaleConflict;
    const staleBanner = stale ? `
      <div class="fin-stale-banner" id="ap-stale-conflict-banner" style="margin-bottom:10px;">
        <div><strong>⚠️ Xung đột thanh toán đồng thời!</strong> ${escapeHtml(stale.message)}</div>
        <div>Số còn phải trả mới nhất trên máy chủ: <strong>${escapeHtml(formatVND(stale.currentRemaining))}</strong></div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${stale.pendingPayload ? `<button type="button" class="btn btn-sm btn-primary" id="btn-ap-confirm-stale-retry">✓ Thanh toán lại với số dư mới (${escapeHtml(formatVND(stale.pendingPayload.amount))})</button>` : ""}
          <button type="button" class="btn btn-sm" id="btn-ap-dismiss-stale">Đã hiểu</button>
        </div>
      </div>
    ` : "";

    if (report.rows.length === 0) {
      content.innerHTML = `${staleBanner}<div class="fin-empty">Chưa có hóa đơn nhà cung cấp nào khớp bộ lọc. Nhấn <strong>+ Thêm hóa đơn NCC</strong> để ghi nhận hóa đơn mới.</div>`;
      return;
    }

    const todayVN = getVietnamTodayISO();
    const canWrite = can("finance:payables_write");
    const canPay = can("finance:payables_pay");

    content.innerHTML = staleBanner + report.rows.map((inv) => {
      const expanded = uiState.apExpandedIds.has(inv.id);
      const payOpen = uiState.apPayInvoiceId === inv.id;
      const isFocused = uiState.apFocusInvoiceId === inv.id;
      const statusPillCls = inv.status === "paid" ? "ok" : inv.status === "overdue" ? "warn" : inv.status === "partial" ? "info" : "amber";
      return `
        <div class="ap-invoice-card ${escapeHtml(inv.status)} ${isFocused ? "focused" : ""}" data-ap-invoice-id="${escapeHtml(inv.id)}">
          <div class="fin-ar-card-head" data-ap-toggle="${escapeHtml(inv.id)}">
            <div style="min-width:0; flex:1;">
              <div style="font-weight:800; font-size:13px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span>🧾 ${escapeHtml(inv.voucherNo)} — ${escapeHtml(inv.supplierName)}</span>
                <span class="fin-pill ${statusPillCls}">${escapeHtml(inv.statusLabel)}</span>
                <span class="fin-pill muted">Kỳ CP: ${escapeHtml(inv.accountingMonth)}</span>
                ${inv.attachment ? '<span class="fin-pill info">📎 Có chứng từ</span>' : ""}
              </div>
              <div style="font-size:11.5px; color:var(--text-secondary); margin-top:3px;">
                Ngày HĐ: <strong>${escapeHtml(formatDateVN(inv.invoiceDate))}</strong> •
                Hạn trả: <strong>${inv.dueDate ? escapeHtml(formatDateVN(inv.dueDate)) : "Chưa xác định"}</strong> •
                Khoản mục: ${escapeHtml((inv.lines || []).map((l) => l.costItemName).join(", "))}
              </div>
            </div>
            <div style="text-align:right; font-variant-numeric:tabular-nums; font-size:12px;">
              <div>Tổng HĐ: <strong>${escapeHtml(formatVND(inv.totalAmount))}</strong></div>
              <div>Đã trả: <strong style="color:var(--status-paid,#15803d);">${escapeHtml(formatVND(inv.paidAmount))}</strong> • Còn: <strong style="color:${inv.remainingAmount > 0 ? "#dc2626" : "var(--text-primary)"};" data-ap-card-remaining="${escapeHtml(inv.id)}">${escapeHtml(formatVND(inv.remainingAmount))}</strong></div>
            </div>
          </div>
          ${expanded ? `
            <div class="fin-ar-card-body">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
                <div style="font-size:11.5px; color:var(--text-secondary);">
                  ${inv.note ? `Ghi chú: <em>${escapeHtml(inv.note)}</em> • ` : ""}
                  Người tạo: <strong>${escapeHtml(inv.createdBy || "—")}</strong>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                  ${canPay && inv.allTimeRemainingAmount > 0 ? `<button type="button" class="btn btn-sm btn-primary" data-ap-open-pay="${escapeHtml(inv.id)}">💸 Thanh toán hóa đơn</button>` : ""}
                  <button type="button" class="btn btn-sm" data-fin-jump-costs-month="${escapeHtml(inv.accountingMonth)}">Xem Chi phí ${escapeHtml(inv.accountingMonth)} ↗</button>
                  ${inv.attachment ? `<button type="button" class="btn btn-sm" data-ap-view-att="${escapeHtml(inv.id)}">📎 Xem chứng từ</button>` : ""}
                  ${canWrite ? `<button type="button" class="btn btn-sm" data-ap-edit-inv="${escapeHtml(inv.id)}">Sửa</button>` : ""}
                  ${canWrite && inv.allPaymentsCount === 0 ? `<button type="button" class="btn btn-sm btn-danger" data-ap-delete-inv="${escapeHtml(inv.id)}">Xóa</button>` : ""}
                </div>
              </div>

              ${payOpen ? `
                <div class="fin-inline-form" data-ap-pay-form="${escapeHtml(inv.id)}">
                  <div class="fin-inline-form-title">
                    <span>💸 Lập phiếu chi thanh toán HĐ ${escapeHtml(inv.voucherNo)} (còn phải trả: ${escapeHtml(formatVND(inv.allTimeRemainingAmount))})</span>
                    <button type="button" class="btn btn-sm" data-ap-close-pay="1">Đóng</button>
                  </div>
                  <div class="form-grid-3">
                    <div class="field">
                      <label>Số tiền thanh toán (VNĐ) *</label>
                      <input class="input" data-ap-pay-field="amount" type="text" inputmode="numeric" value="${escapeHtml(formatNumberInput(inv.allTimeRemainingAmount))}" />
                    </div>
                    <div class="field">
                      <label>Ngày thanh toán thực tế (VN) *</label>
                      <input class="input" data-ap-pay-field="date" type="date" value="${escapeHtml(todayVN)}" />
                    </div>
                    <div class="field">
                      <label>Chi từ quỹ *</label>
                      <select class="select" data-ap-pay-field="fundId">
                        ${FINANCE_FUNDS.filter((f) => !f.isLegacyBucket).map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join("")}
                      </select>
                    </div>
                  </div>
                  <div class="field">
                    <label>Ghi chú phiếu chi</label>
                    <input class="input" data-ap-pay-field="note" type="text" placeholder="VD: Thanh toán đợt 1 tiền điện qua ngân hàng..." />
                  </div>
                  <div style="display:flex; justify-content:flex-end; gap:8px;">
                    <button type="button" class="btn btn-sm" data-ap-close-pay="1">Hủy</button>
                    <button type="button" class="btn btn-sm btn-primary" data-ap-submit-pay="${escapeHtml(inv.id)}">✓ Xác nhận lập phiếu chi (PC)</button>
                  </div>
                </div>
              ` : ""}

              <div class="fin-table-wrap">
                <table class="fin-tx-table">
                  <thead><tr><th>Khoản mục chi phí</th><th>Diễn giải</th><th class="num">Số tiền (VNĐ)</th></tr></thead>
                  <tbody>
                    ${(inv.lines || []).map((l) => `
                      <tr>
                        <td><strong>${escapeHtml(l.costItemName)}</strong></td>
                        <td>${escapeHtml(l.description || "—")}</td>
                        <td class="num" style="font-weight:700;">${escapeHtml(formatVND(l.amount))}</td>
                      </tr>
                    `).join("")}
                  </tbody>
                </table>
              </div>

              ${(inv.linkedLegacyEntries || []).length > 0 ? `
                <div class="costs-legacy-linked">
                  <strong>🔗 Đã liên kết ${inv.linkedLegacyEntries.length} chứng từ chi tay cũ (tự loại trừ để không cộng trùng ở màn Chi phí):</strong>
                  ${inv.linkedLegacyEntries.map((e) => `${escapeHtml(formatDateVN(e.expenseDate))} — ${escapeHtml(formatVND(e.amount))} ${e.note ? `(${escapeHtml(e.note)})` : ""}`).join("; ")}
                </div>
              ` : ""}

              <div style="font-weight:700; font-size:12px;">Lịch sử thanh toán từ Sổ quỹ (${inv.payments.length} phiếu chi${filters.asOfDate ? ` đến ${formatDateVN(filters.asOfDate)}` : ""})</div>
              ${inv.payments.length > 0 ? `
                <div class="fin-table-wrap">
                  <table class="fin-tx-table">
                    <thead><tr><th>Mã phiếu chi</th><th>Ngày chi thực tế</th><th>Quỹ chi</th><th class="num">Số tiền</th><th>Người chi</th><th>Ghi chú</th><th>Sổ quỹ</th></tr></thead>
                    <tbody>
                      ${inv.payments.map((p) => `
                        <tr>
                          <td><span class="fin-voucher-code">${escapeHtml(p.voucherCode)}</span></td>
                          <td>${escapeHtml(formatDateVN(p.receivedDate))}</td>
                          <td>${escapeHtml(p.fundName)}</td>
                          <td class="num" style="font-weight:800; color:#dc2626;">-${escapeHtml(formatVND(p.amount))}</td>
                          <td>${escapeHtml(p.operator || "—")}</td>
                          <td>${escapeHtml(p.note || "—")}</td>
                          <td><button type="button" class="fin-link-btn" data-fin-jump-cashbook-supplier="1">Xem Sổ quỹ ↗</button></td>
                        </tr>
                      `).join("")}
                    </tbody>
                  </table>
                </div>
              ` : `<div style="font-size:11.5px; color:var(--text-muted);">Chưa có phiếu chi thanh toán nào cho hóa đơn này.</div>`}
            </div>
          ` : ""}
        </div>
      `;
    }).join("");
  }

  async function handleExportPayablesCsv() {
    if (!can("finance:export") || !can("finance:payables_read")) {
      showToast("Chỉ Quản lý / Tổng quản lý được xuất danh sách Hóa đơn NCC.", "error");
      return;
    }
    const filters = getPayablesFilters();
    const status = typeof store.getStatus === "function" ? store.getStatus() : {};
    if (status.mode === "server") {
      const qs = new URLSearchParams({
        asOfDate: filters.asOfDate,
        supplier: filters.supplier,
        accountingMonth: filters.accountingMonth,
        status: filters.status,
        search: filters.search
      });
      window.location.href = `/api/finance/export/payables?${qs.toString()}`;
      showToast("Đang tải file CSV Hóa đơn NCC & Công nợ phải trả...", "success");
      return;
    }
    const report = computeSupplierPayablesReport(getFinanceState(), getOperatingCostsState(), filters);
    triggerDownloadCsv(`hoa-don-ncc-cong-no-tra-${report.asOfDate}.csv`, generateSupplierPayablesCsvContent(report));
    showToast("Đã xuất file CSV Hóa đơn NCC & Công nợ phải trả.", "success");
  }

  /* ============================================================================
     6. SIDEBAR BADGES & GLOBAL EVENT DELEGATION
     ============================================================================ */

  function updateSidebarBadges() {
    const arPill = $("ar-badge-pill");
    if (arPill) {
      if (!can("finance:ar_read")) {
        arPill.style.display = "none";
      } else {
        const report = computeReceivablesReport(getBookings(), getFinanceState(), { asOfDate: getVietnamTodayISO() });
        if (report.debtCount > 0) {
          arPill.textContent = String(report.debtCount);
          arPill.style.display = "";
        } else {
          arPill.style.display = "none";
        }
      }
    }

    const apPill = $("ap-badge-pill");
    if (apPill) {
      if (!can("finance:payables_read")) {
        apPill.style.display = "none";
      } else {
        const apReport = computeSupplierPayablesReport(getFinanceState(), getOperatingCostsState(), {});
        const openCount = apReport.unpaidCount + apReport.partialCount;
        if (openCount > 0) {
          apPill.textContent = String(openCount);
          apPill.style.display = "";
        } else {
          apPill.style.display = "none";
        }
      }
    }
  }

  function refreshOpenModals() {
    syncPendingBars();
    updateSidebarBadges();
    if (uiState.currentBookingId && $("booking-modal") && $("booking-modal").classList.contains("open")) {
      renderBookingFinancePanel(uiState.currentBookingId);
    }
    if ($("receivables-modal") && $("receivables-modal").classList.contains("open")) {
      renderReceivables();
    }
    if ($("cashbook-modal") && $("cashbook-modal").classList.contains("open")) {
      renderCashbook();
    }
    if ($("payables-modal") && $("payables-modal").classList.contains("open")) {
      renderPayables();
    }
    if ($("monthly-receipts-modal") && $("monthly-receipts-modal").classList.contains("open")) {
      renderMonthlyReceipts();
    }
  }

  async function handleExportReceivablesCsv() {
    if (!can("finance:export")) {
      showToast("Chỉ Quản lý / Tổng quản lý được xuất báo cáo tài chính.", "error");
      return;
    }
    const filters = getReceivablesFilters();
    const status = typeof store.getStatus === "function" ? store.getStatus() : {};
    if (status.mode === "server") {
      const qs = new URLSearchParams({
        asOfDate: filters.asOfDate,
        status: filters.status,
        dueFilter: filters.dueFilter,
        entityType: filters.entityType,
        search: filters.search
      });
      window.location.href = `/api/finance/export/receivables?${qs.toString()}`;
      showToast("Đang tải file CSV Công nợ khách...", "success");
      return;
    }
    const report = computeReceivablesReport(getBookings(), getFinanceState(), filters);
    triggerDownloadCsv(`cong-no-khach-${filters.asOfDate}.csv`, generateReceivablesCsvContent(report));
    showToast("Đã xuất file CSV Công nợ khách.", "success");
  }

  async function handleExportCashbookCsv() {
    if (!can("finance:export")) {
      showToast("Chỉ Quản lý / Tổng quản lý được xuất Sổ quỹ.", "error");
      return;
    }
    const filters = getCashbookFilters();
    const status = typeof store.getStatus === "function" ? store.getStatus() : {};
    if (status.mode === "server") {
      const qs = new URLSearchParams({
        fromDate: filters.fromDate,
        toDate: filters.toDate,
        fundId: filters.fundId,
        txType: filters.txType,
        reconcile: filters.reconcile
      });
      window.location.href = `/api/finance/export/cashbook?${qs.toString()}`;
      showToast("Đang tải file CSV Sổ quỹ...", "success");
      return;
    }
    const report = computeCashbookReport(getFinanceState(), getBookings(), filters);
    triggerDownloadCsv(`so-quy-${getVietnamTodayISO()}.csv`, generateCashbookCsvContent(report));
    showToast("Đã xuất file CSV Sổ quỹ.", "success");
  }

  function bindEvents() {
    // Modal close buttons & backdrop clicks
    ["btn-close-receivables", "btn-close-receivables-2"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", closeReceivables);
    });
    ["btn-close-cashbook", "btn-close-cashbook-2"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", closeCashbook);
    });
    ["btn-close-payables", "btn-close-payables-2"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", closePayables);
    });
    ["btn-close-monthly-receipts", "btn-close-monthly-receipts-2"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", closeMonthlyReceipts);
    });

    [$("receivables-modal"), $("cashbook-modal"), $("payables-modal"), $("monthly-receipts-modal")].forEach((backdrop) => {
      if (!backdrop) return;
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) {
          backdrop.classList.remove("open");
          if (root.PMSPcApi && typeof root.PMSPcApi.syncActiveNav === "function") {
            root.PMSPcApi.syncActiveNav();
          }
        }
      });
    });

    // Receivables filters & tabs
    ["ar-filter-search", "ar-filter-entity", "ar-filter-status", "ar-filter-asof"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener(id === "ar-filter-search" ? "input" : "change", renderReceivables);
    });
    if ($("btn-ar-tab-list")) $("btn-ar-tab-list").addEventListener("click", () => { uiState.arTab = "list"; renderReceivables(); });
    if ($("btn-ar-tab-legacy")) $("btn-ar-tab-legacy").addEventListener("click", () => { uiState.arTab = "legacy"; renderReceivables(); });
    if ($("btn-ar-export-csv")) $("btn-ar-export-csv").addEventListener("click", handleExportReceivablesCsv);
    if ($("btn-ar-migrate-legacy")) {
      $("btn-ar-migrate-legacy").addEventListener("click", async () => {
        const res = await store.migrateLegacyPayments({ dryRun: true });
        if (res && res.ok) {
          uiState.arLastMigrationResult = res;
          uiState.arTab = "legacy";
          renderReceivables();
        } else {
          showToast((res && res.error) || "Không thể chạy xem thử chuyển tiếp.", "error");
        }
      });
    }

    // Cashbook filters, tabs & drawers
    ["cb-filter-from", "cb-filter-to", "cb-filter-fund", "cb-filter-type", "cb-filter-reconcile"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("change", renderCashbook);
    });
    if ($("btn-cb-tab-ledger")) $("btn-cb-tab-ledger").addEventListener("click", () => { uiState.cbTab = "ledger"; renderCashbook(); });
    if ($("btn-cb-tab-legacy")) $("btn-cb-tab-legacy").addEventListener("click", () => { uiState.cbTab = "legacy"; renderCashbook(); });
    if ($("btn-cb-tab-logs")) $("btn-cb-tab-logs").addEventListener("click", () => { uiState.cbTab = "logs"; renderCashbook(); });
    if ($("btn-cb-export-csv")) $("btn-cb-export-csv").addEventListener("click", handleExportCashbookCsv);

    if ($("btn-cb-open-transfer")) $("btn-cb-open-transfer").addEventListener("click", () => { uiState.cbDrawer = uiState.cbDrawer === "transfer" ? null : "transfer"; renderCashbook(); });
    if ($("btn-cb-open-opening")) $("btn-cb-open-opening").addEventListener("click", () => { uiState.cbDrawer = uiState.cbDrawer === "opening" ? null : "opening"; renderCashbook(); });
    if ($("btn-cb-open-reconcile")) $("btn-cb-open-reconcile").addEventListener("click", () => { uiState.cbDrawer = uiState.cbDrawer === "reconcile" ? null : "reconcile"; renderCashbook(); });
    if ($("btn-cb-open-adjust")) $("btn-cb-open-adjust").addEventListener("click", () => { uiState.cbDrawer = uiState.cbDrawer === "adjust" ? null : "adjust"; renderCashbook(); });

    // Payables filters & header actions
    ["ap-filter-search", "ap-filter-supplier", "ap-filter-month", "ap-filter-asof", "ap-filter-status"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener(id === "ap-filter-search" ? "input" : "change", renderPayables);
    });
    if ($("btn-ap-new-invoice")) {
      $("btn-ap-new-invoice").addEventListener("click", () => {
        if (uiState.apFormOpen && !uiState.apEditId) closePayablesForm();
        else openPayablesForm(null, ($("ap-filter-month") && $("ap-filter-month").value) || "");
      });
    }
    if ($("btn-ap-export-csv")) $("btn-ap-export-csv").addEventListener("click", handleExportPayablesCsv);

    // Delegated input & change handlers
    document.addEventListener("input", (e) => {
      if (e.target && e.target.matches("[data-ap-line-amt]")) {
        updateApFormTotalPreview();
      }
    });

    document.addEventListener("change", (e) => {
      if (e.target && e.target.id === "fin-pay-method") {
        const fundSel = $("fin-pay-fund");
        if (fundSel) fundSel.value = getPaymentMethodMeta(e.target.value).defaultFundId;
      }
      if (e.target && e.target.matches("[data-leg-resolution]")) {
        const row = e.target.closest("[data-legacy-verify-row]");
        if (row) {
          const isOpening = e.target.value === "included_in_opening";
          const dateInp = row.querySelector("[data-leg-date]");
          const fundSel = row.querySelector("[data-leg-fund]");
          if (dateInp) dateInp.disabled = isOpening;
          if (fundSel) fundSel.disabled = isOpening;
        }
      }
      if (e.target && e.target.id === "ap-f-acc-month") {
        const wrap = $("ap-legacy-link-wrap");
        if (wrap) {
          wrap.innerHTML = renderApLegacyLinkSection(e.target.value, [], uiState.apEditId);
        }
      }
      if (e.target && e.target.id === "ap-f-attachment") {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > 4 * 1024 * 1024) {
          showToast("Tệp chứng từ vượt quá 4MB — vui lòng chọn tệp nhỏ hơn.", "error");
          e.target.value = "";
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          uiState.apFormAttachment = {
            name: file.name,
            type: file.type || "application/octet-stream",
            size: file.size,
            dataUrl: String(reader.result || "")
          };
          const st = $("ap-f-att-status");
          if (st) {
            st.innerHTML = `Đã đính kèm: <strong>${escapeHtml(file.name)}</strong> <button type="button" class="fin-link-btn" id="btn-ap-clear-att">Gỡ tệp</button>`;
          }
        };
        reader.readAsDataURL(file);
      }
    });

    // Global delegated clicks for dynamic Finance UI buttons
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("button, [data-ar-toggle], [data-ap-toggle]");
      if (!btn) return;

      // Retry / dismiss pending unconfirmed intents
      if (btn.dataset.finRetryKey) {
        await handleRetryPendingIntent(btn.dataset.finRetryKey);
        return;
      }
      if (btn.dataset.finDismissKey) {
        if (typeof store.dismissPendingFinanceIntent === "function") {
          store.dismissPendingFinanceIntent(btn.dataset.finDismissKey);
          syncPendingBars();
          if (uiState.currentBookingId) renderBookingFinancePanel(uiState.currentBookingId);
        }
        return;
      }

      // Cross-module jumps
      if (btn.dataset.finJumpBooking) {
        jumpToBooking(btn.dataset.finJumpBooking);
        return;
      }
      if (btn.dataset.finJumpInvoice) {
        closeCashbook();
        openPayables({ focusInvoiceId: btn.dataset.finJumpInvoice });
        return;
      }
      if (btn.dataset.finJumpCashbookSupplier) {
        closePayables();
        openCashbook({ tab: "ledger", txType: "supplier_payment", fundId: "all", fromDate: "", toDate: "" });
        return;
      }
      if (btn.dataset.finJumpCostsMonth) {
        const mk = btn.dataset.finJumpCostsMonth;
        closePayables();
        if (root.PMSPcApi && typeof root.PMSPcApi.openOperatingCosts === "function") {
          root.PMSPcApi.openOperatingCosts(mk);
        }
        return;
      }
      if (btn.dataset.finOpenArSearch !== undefined) {
        const bookingModal = $("booking-modal");
        if (bookingModal) bookingModal.classList.remove("open");
        openReceivables({ search: btn.dataset.finOpenArSearch });
        return;
      }
      if (btn.dataset.finGotoCbLegacy) {
        closeReceivables();
        openCashbook({ tab: "legacy" });
        return;
      }

      // Clickable AR Due-Date Bucket filter cards
      if (btn.dataset.arDueFilter !== undefined) {
        const nextDue = btn.dataset.arDueFilter;
        uiState.arDueFilter = (nextDue !== "all" && uiState.arDueFilter === nextDue) ? "all" : nextDue;
        uiState.arTab = "list";
        renderReceivables();
        return;
      }

      // Unified Legacy Verification (works from BOTH Receivables Legacy Tab and Cashbook Legacy Tab!)
      if (btn.dataset.legVerifySubmit) {
        const txId = btn.dataset.legVerifySubmit;
        const tr = btn.closest("[data-legacy-verify-row]");
        if (!tr) return;
        const resolution = tr.querySelector("[data-leg-resolution]")?.value || "included_in_opening";
        const evidence = tr.querySelector("[data-leg-evidence]")?.value.trim() || "";
        if (!evidence) {
          showToast("Bắt buộc phải nhập căn cứ đối soát trước khi xác minh.", "error");
          return;
        }
        let payload;
        if (resolution === "included_in_opening") {
          payload = {
            reconciled: true,
            legacyResolution: "included_in_opening",
            reconcileEvidence: evidence,
            reconcileNote: `Đã xác minh nằm trong số dư đầu kỳ (${evidence})`
          };
        } else {
          const receivedDate = tr.querySelector("[data-leg-date]")?.value;
          const fundId = tr.querySelector("[data-leg-fund]")?.value;
          if (!receivedDate || !fundId) {
            showToast("Vui lòng chọn đầy đủ ngày thực nhận và quỹ nhận để ghi bổ sung.", "error");
            return;
          }
          payload = {
            reconciled: true,
            legacyResolution: "record_to_fund",
            receivedDate,
            fundId,
            reconcileEvidence: evidence,
            reconcileNote: `Ghi bổ sung vào quỹ (${evidence})`
          };
        }
        const res = await store.reconcileFinanceTransaction(txId, payload);
        if (res && res.ok) {
          showToast(
            resolution === "included_in_opening"
              ? "Đã xác minh khoản cũ nằm trong số dư đầu kỳ (KHÔNG cộng trùng quỹ)."
              : "Đã xác minh & ghi bổ sung khoản cũ vào quỹ thực tế.",
            "success"
          );
          notifyHostUI();
          refreshOpenModals();
        } else {
          showToast((res && res.error) || "Không thể xác minh chứng từ chuyển tiếp.", "error");
        }
        return;
      }

      // In-Booking Panel actions
      if (btn.dataset.finPanelAction) {
        const act = btn.dataset.finPanelAction;
        uiState.bookingInlineForm = (act === "close" || uiState.bookingInlineForm === act) ? null : act;
        renderBookingFinancePanel(uiState.currentBookingId);
        return;
      }
      if (btn.dataset.finRemoveService !== undefined) {
        await removeBookingService(Number(btn.dataset.finRemoveService));
        return;
      }
      if (btn.dataset.finRetainDeposit) {
        await submitBookingCancel(true);
        return;
      }
      if (btn.id === "btn-fin-submit-collect") {
        await submitBookingCollect();
        return;
      }
      if (btn.id === "btn-fin-confirm-stale-retry" && uiState.bookingStaleConflict) {
        await submitBookingCollect(uiState.bookingStaleConflict.pendingPayload);
        return;
      }
      if (btn.id === "btn-fin-cancel-stale") {
        uiState.bookingStaleConflict = null;
        renderBookingFinancePanel(uiState.currentBookingId);
        return;
      }
      if (btn.id === "btn-fin-submit-service") {
        await submitBookingService();
        return;
      }
      if (btn.id === "btn-fin-submit-adjust") {
        await submitBookingAdjustment();
        return;
      }
      if (btn.id === "btn-fin-submit-refund") {
        await submitBookingRefund();
        return;
      }
      if (btn.id === "btn-fin-submit-cancel") {
        await submitBookingCancel(false);
        return;
      }

      // Receivables expand / quick collect / migration
      if (btn.dataset.arToggle) {
        const key = btn.dataset.arToggle;
        if (uiState.arExpandedKeys.has(key)) uiState.arExpandedKeys.delete(key);
        else uiState.arExpandedKeys.add(key);
        renderReceivables();
        return;
      }
      if (btn.dataset.arQuickCollect) {
        const key = btn.dataset.arQuickCollect;
        uiState.arQuickCollectKey = uiState.arQuickCollectKey === key ? null : key;
        renderReceivables();
        return;
      }
      if (btn.dataset.arQcClose) {
        uiState.arQuickCollectKey = null;
        renderReceivables();
        return;
      }
      if (btn.dataset.arQcSubmit) {
        const key = btn.dataset.arQcSubmit;
        const formEl = btn.closest("[data-ar-qc-form]");
        if (!formEl) return;
        const report = computeReceivablesReport(getBookings(), getFinanceState(), getReceivablesFilters());
        const row = report.rows.find((r) => r.entityKey === key);
        if (!row) return;
        const amount = parseVND(formEl.querySelector('[data-qc-field="amount"]').value);
        const receivedDate = formEl.querySelector('[data-qc-field="date"]').value || getVietnamTodayISO();
        const fundId = formEl.querySelector('[data-qc-field="fundId"]').value || "cash_frontdesk";
        const paymentMethod = formEl.querySelector('[data-qc-field="method"]').value || "cash";
        const note = formEl.querySelector('[data-qc-field="note"]').value.trim();
        if (amount <= 0) {
          showToast("Số tiền thu phải lớn hơn 0 đ.", "error");
          return;
        }
        const primaryBkId = row.bookingId || (row.bookings[0] && row.bookings[0].id) || "";
        const res = await store.recordFinanceTransaction({
          txType: "customer_payment",
          entityType: row.entityType,
          bookingId: primaryBkId,
          groupCode: row.groupCode || "",
          groupCodeDisplay: row.groupCodeDisplay || "",
          amount,
          receivedDate,
          paymentMethod,
          fundId,
          note,
          expectedBalance: row.remaining,
          idempotencyKey: makeIdempotencyKey("pay")
        });
        if (res && res.ok) {
          uiState.arQuickCollectKey = null;
          showToast(`Đã thu ${formatVND(amount)} • Phiếu ${res.transaction.voucherCode}`, "success");
          notifyHostUI();
          renderReceivables();
        } else {
          showToast((res && res.error) || "Không thể ghi nhận thu tiền.", "error");
          renderReceivables();
        }
        return;
      }
      if (btn.id === "btn-ar-dryrun-legacy") {
        const res = await store.migrateLegacyPayments({ dryRun: true });
        if (res && res.ok) {
          uiState.arLastMigrationResult = res;
          renderReceivables();
        } else {
          showToast((res && res.error) || "Không thể xem thử chuyển tiếp.", "error");
        }
        return;
      }
      if (btn.id === "btn-ar-run-legacy" || btn.id === "btn-ar-commit-migration") {
        const res = await store.migrateLegacyPayments({ dryRun: false });
        if (res && res.ok) {
          uiState.arLastMigrationResult = res;
          showToast(
            res.createdCount > 0
              ? `Đã chuyển tiếp ${res.createdCount} đơn cũ (tổng ${formatVND(res.migratedTotalAmount || 0)}, chênh lệch 0 đ).`
              : "Không còn đơn cũ nào cần chuyển tiếp (0 bản ghi trùng).",
            "success"
          );
          notifyHostUI();
          renderReceivables();
        } else {
          showToast((res && res.error) || "Chuyển tiếp thất bại.", "error");
        }
        return;
      }
      if (btn.id === "btn-ar-close-mig-box") {
        uiState.arLastMigrationResult = null;
        renderReceivables();
        return;
      }

      // Cashbook actions
      if (btn.dataset.cbCloseDrawer) {
        uiState.cbDrawer = null;
        renderCashbook();
        return;
      }
      if (btn.id === "btn-cb-submit-transfer") {
        const fromFundId = $("cb-trf-from").value;
        const toFundId = $("cb-trf-to").value;
        const amount = parseVND($("cb-trf-amount").value);
        const receivedDate = $("cb-trf-date").value || getVietnamTodayISO();
        const note = $("cb-trf-note").value.trim();
        if (fromFundId === toFundId) return showDrawerError("Quỹ nguồn và quỹ đích phải khác nhau.");
        if (amount <= 0) return showDrawerError("Số tiền chuyển quỹ phải lớn hơn 0 đ.");
        const res = await store.transferBetweenFunds({
          fromFundId,
          toFundId,
          amount,
          receivedDate,
          note,
          idempotencyKey: makeIdempotencyKey("trf")
        });
        if (res && res.ok) {
          uiState.cbDrawer = null;
          showToast(`Đã chuyển quỹ ${formatVND(amount)} (${res.transaction.voucherCode}).`, "success");
          notifyHostUI();
          renderCashbook();
        } else {
          showDrawerError((res && res.error) || "Chuyển quỹ thất bại.");
        }
        return;
      }
      if (btn.id === "btn-cb-submit-opening") {
        const fundId = $("cb-ob-fund").value;
        const asOfDate = $("cb-ob-date").value || getVietnamTodayISO();
        const amount = parseSignedVND($("cb-ob-amount").value);
        const voucherRef = $("cb-ob-ref").value.trim();
        const note = $("cb-ob-note").value.trim();
        const res = await store.setFundOpeningBalance({ fundId, asOfDate, amount, voucherRef, note });
        if (res && res.ok) {
          uiState.cbDrawer = null;
          showToast(`Đã lưu số dư đầu kỳ ${formatVND(amount)} cho ${getFinanceFundById(fundId).shortName}.`, "success");
          notifyHostUI();
          renderCashbook();
        } else {
          showDrawerError((res && res.error) || "Không thể lưu số dư đầu kỳ.");
        }
        return;
      }
      if (btn.id === "btn-cb-submit-reconcile") {
        const fundId = $("cb-rec-fund").value;
        const asOfDate = $("cb-rec-date").value || getVietnamTodayISO();
        const rawActual = $("cb-rec-actual").value.trim();
        if (!rawActual) return showDrawerError("Vui lòng nhập số tiền thực tế đếm / sao kê.");
        const actualBalance = parseSignedVND(rawActual);
        const note = $("cb-rec-note").value.trim();
        const res = await store.saveFundReconciliationCheck({ fundId, asOfDate, actualBalance, note });
        if (res && res.ok) {
          uiState.cbDrawer = null;
          const diff = res.check ? res.check.discrepancy : 0;
          showToast(
            diff === 0
              ? `Đối chiếu ${getFinanceFundById(fundId).shortName}: Khớp tuyệt đối (chênh lệch 0 đ).`
              : `Đã ghi nhận đối chiếu ${getFinanceFundById(fundId).shortName} — chênh lệch ${formatSignedVND(diff)} (không tạo phiếu bù).`,
            diff === 0 ? "success" : "info"
          );
          notifyHostUI();
          renderCashbook();
        } else {
          showDrawerError((res && res.error) || "Không thể ghi nhận đối chiếu.");
        }
        return;
      }
      if (btn.id === "btn-cb-submit-adjust") {
        const fundId = $("cb-adj-fund").value;
        const amount = parseSignedVND($("cb-adj-amount").value);
        const receivedDate = $("cb-adj-date").value || getVietnamTodayISO();
        const reason = $("cb-adj-reason").value.trim();
        if (amount === 0) return showDrawerError("Số tiền điều chỉnh phải khác 0.");
        if (!reason) return showDrawerError("Bắt buộc phải nhập lý do điều chỉnh quỹ.");
        const res = await store.recordFinanceTransaction({
          txType: "balance_adjustment",
          entityType: "fund",
          fundId,
          amount,
          receivedDate,
          reason,
          idempotencyKey: makeIdempotencyKey("adj")
        });
        if (res && res.ok) {
          uiState.cbDrawer = null;
          showToast(`Đã điều chỉnh số dư quỹ ${formatSignedVND(amount)} (${res.transaction.voucherCode}).`, "success");
          notifyHostUI();
          renderCashbook();
        } else {
          showDrawerError((res && res.error) || "Không thể điều chỉnh quỹ.");
        }
        return;
      }
      if (btn.dataset.cbToggleRec) {
        const txId = btn.dataset.cbToggleRec;
        const nextRec = btn.dataset.cbRecNext === "1";
        const res = await store.reconcileFinanceTransaction(txId, { reconciled: nextRec });
        if (res && res.ok) {
          showToast(nextRec ? "Đã đánh dấu đối chiếu chứng từ." : "Đã bỏ đánh dấu đối chiếu.", "success");
          renderCashbook();
        } else {
          showToast((res && res.error) || "Không thể cập nhật đối chiếu.", "error");
        }
        return;
      }

      // Payables (Supplier Invoices) dynamic actions
      if (btn.id === "btn-ap-close-form" || btn.id === "btn-ap-cancel-form") {
        closePayablesForm();
        return;
      }
      if (btn.id === "btn-ap-add-line") {
        const container = $("ap-lines-container");
        if (container) {
          const costItems = (getOperatingCostsState().items || []).filter((it) => it.active !== false);
          container.insertAdjacentHTML("beforeend", buildApLineRowHtml(costItems, {}));
        }
        return;
      }
      if (btn.dataset.apRemoveLine) {
        const container = $("ap-lines-container");
        const row = btn.closest("[data-ap-line-row]");
        if (container && row && container.querySelectorAll("[data-ap-line-row]").length > 1) {
          row.remove();
          updateApFormTotalPreview();
        } else {
          showToast("Hóa đơn cần giữ lại ít nhất 1 dòng khoản mục.", "error");
        }
        return;
      }
      if (btn.id === "btn-ap-clear-att") {
        uiState.apFormAttachment = null;
        const inp = $("ap-f-attachment");
        if (inp) inp.value = "";
        const st = $("ap-f-att-status");
        if (st) st.textContent = "Chưa đính kèm tệp (tùy chọn)";
        return;
      }
      if (btn.id === "btn-ap-save-invoice") {
        await submitSupplierInvoiceForm();
        return;
      }
      if (btn.dataset.apToggle) {
        const id = btn.dataset.apToggle;
        if (uiState.apExpandedIds.has(id)) uiState.apExpandedIds.delete(id);
        else uiState.apExpandedIds.add(id);
        renderPayables();
        return;
      }
      if (btn.dataset.apOpenPay) {
        const id = btn.dataset.apOpenPay;
        uiState.apExpandedIds.add(id);
        uiState.apPayInvoiceId = uiState.apPayInvoiceId === id ? null : id;
        renderPayables();
        return;
      }
      if (btn.dataset.apClosePay) {
        uiState.apPayInvoiceId = null;
        renderPayables();
        return;
      }
      if (btn.dataset.apSubmitPay) {
        await submitSupplierPayment(btn.dataset.apSubmitPay);
        return;
      }
      if (btn.id === "btn-ap-confirm-stale-retry" && uiState.apStaleConflict && uiState.apStaleConflict.pendingPayload) {
        await submitSupplierPayment(uiState.apStaleConflict.invoiceId, uiState.apStaleConflict.pendingPayload);
        return;
      }
      if (btn.id === "btn-ap-dismiss-stale") {
        uiState.apStaleConflict = null;
        renderPayables();
        return;
      }
      if (btn.dataset.apEditInv) {
        openPayablesForm(btn.dataset.apEditInv);
        return;
      }
      if (btn.dataset.apDeleteInv) {
        const id = btn.dataset.apDeleteInv;
        if (!window.confirm("Bạn chắc chắn muốn xóa hóa đơn nhà cung cấp này?")) return;
        const res = await store.deleteSupplierInvoice(id);
        if (res && res.ok) {
          showToast("Đã xóa hóa đơn nhà cung cấp.", "success");
          notifyHostUI();
          renderPayables();
        } else {
          showToast((res && res.error) || "Không thể xóa hóa đơn này.", "error");
        }
        return;
      }
      if (btn.dataset.apViewAtt) {
        const id = btn.dataset.apViewAtt;
        const inv = (getFinanceState().supplierInvoices || []).find((x) => x.id === id);
        if (!inv || !inv.attachment || !inv.attachment.dataUrl) return;
        if ((inv.attachment.type || "").startsWith("image/")) {
          const lb = $("photo-lightbox-modal");
          const img = $("photo-lightbox-img");
          const cap = $("photo-lightbox-caption");
          if (lb && img) {
            img.src = inv.attachment.dataUrl;
            if (cap) cap.textContent = `${inv.voucherNo} — ${inv.attachment.name}`;
            lb.classList.add("open");
            return;
          }
        }
        try {
          const resp = await fetch(inv.attachment.dataUrl);
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const opened = window.open(url, "_blank", "noopener");
          if (!opened) {
            const a = document.createElement("a");
            a.href = url;
            a.download = inv.attachment.name || "chung-tu.pdf";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch {
          showToast("Không thể mở tệp chứng từ đính kèm.", "error");
        }
      }
    });

    // Auto-reconcile pending unconfirmed intents when network comes back online
    window.addEventListener("online", () => {
      if (typeof store.reconcilePendingFinanceIntents === "function") {
        store.reconcilePendingFinanceIntents().then((res) => {
          if (res && res.resolved && res.resolved.length > 0) {
            showToast(`Đã tự động xác nhận ${res.resolved.length} giao dịch chờ đồng bộ từ máy chủ!`, "success");
            notifyHostUI();
            refreshOpenModals();
          }
        });
      }
    });

    if (typeof store.subscribe === "function") {
      store.subscribe(() => {
        refreshOpenModals();
      });
    }
  }

  bindEvents();

  root.PMSFinanceApp = {
    openReceivables,
    closeReceivables,
    openCashbook,
    closeCashbook,
    openPayables,
    closePayables,
    openMonthlyReceipts,
    closeMonthlyReceipts,
    renderBookingFinancePanel,
    hideBookingFinancePanel,
    refreshOpenModals,
    updateSidebarBadges
  };
})(typeof window !== "undefined" ? window : globalThis);
