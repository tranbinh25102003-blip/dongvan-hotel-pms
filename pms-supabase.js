/* ==========================================================================
   Dongvan Ville du H'mong Hotel — Supabase Cloud Realtime Adapter (v2)
   Zero external CDN dependencies. Uses standard Supabase Auth REST,
   Transactional PostgreSQL RPCs (with RLS), and Triple-Layer Realtime Sync:
     Layer 1 (<80ms):  Phoenix WebSocket Broadcast + same-device BroadcastChannel
     Layer 2 (DB WAL): Supabase Realtime postgres_changes on pms_meta
     Layer 3 (Guard):  15s Heartbeat ACK Watchdog (detects silent half-open iOS/Wi-Fi
                       sockets in 5s) + lightweight 120B store_version probe
   - Instant local commit application (uses RPC response directly — zero redundant
     multi-MB full-state pulls on every save/delete).
   - Single-flight token refresh lock + coalesced pulls + monotonic storeVersion guard.
   - STRICT cloud-only mode: NEVER silently falls back to localStorage ledger
     and NEVER claims "Đã lưu" before PostgreSQL commits.
   ========================================================================== */

(function (root) {
  "use strict";

  const Core = root.PMSCore;
  if (!Core) {
    throw new Error("PMSCore (pms-core.js) must load before pms-supabase.js");
  }

  const SESSION_STORAGE_KEY = "ks_pms_supabase_session_v1";
  const BROADCAST_CHANNEL_NAME = "dongvan_pms_sync_v1";
  const HEARTBEAT_INTERVAL_MS = 15000;
  const HEARTBEAT_TIMEOUT_MS = 5000;
  const DEGRADED_PROBE_MS = 3500;
  const HEALTHY_PROBE_MS = 12000;

  function normalizeBaseUrl(rawUrl) {
    return String(rawUrl || "")
      .trim()
      .replace(/\/+(rest|auth)\/v1\/?$/i, "")
      .replace(/\/+$/, "");
  }

  function createSupabaseClient(config) {
    const baseUrl = normalizeBaseUrl(config && config.url);
    const anonKey = String((config && config.anonKey) || "").trim();
    const hotelEmail = String((config && config.hotelEmail) || "letan@dongvanhotel.vn").trim();
    const legacyStaffList = (Core.CONFIRMERS || []).filter((n) => n !== Core.SUPER_ADMIN_DISPLAY_NAME);
    const clientId = `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    const listeners = new Set();
    const busyChecks = new Set();

    let connectionStatus = "connecting"; // "connected" | "reconnecting" | "offline" | "auth_required"
    let lastSyncedAt = null;
    let storeVersion = 0;
    let lastOperatingCostsUpdatedAt = "";
    let lastFinanceUpdatedAt = "";
    let lastFinanceLedgerVersion = -1;
    let lastHousekeepingUpdatedAt = "";
    let lastIssuesUpdatedAt = "";
    let lastAccountsUpdatedAt = "";
    let financeLoadState = "loading"; // "loading" | "loaded" | "error"
    let financeLoadError = "";
    let staffAuthAvailable = null; // null = unknown, true = pgcrypto RPCs installed, false = legacy Supabase Auth only
    let publicAccountsCache = null; // real active accounts fetched from pms_public_accounts()
    const PENDING_FINANCE_KEY = "dongvan_pms_pending_finance_cloud_v1";

    let session = null; // { authMode: "staff_session", sessionToken, expires_at, accountId, username, staffName, role } OR legacy { access_token, refresh_token, expires_at, ... }
    let refreshInFlight = null;
    let inFlightPull = null;
    let queuedPullMeta = null;
    let inFlightVersionProbe = null;
    let watchersBound = false;

    let ws = null;
    let wsJoined = false;
    let wsConnecting = false;
    let wsRef = 1;
    let wsJoinRef = null;
    let wsHeartbeatTimer = null;
    let wsHeartbeatWatchdog = null;
    let pendingHeartbeatRef = null;
    let wsReconnectTimer = null;
    let wsReconnectAttempt = 0;
    let syncProbeTimer = null;
    let lastProbeAt = 0;
    let versionCheckTimer = null;
    let idleUpdateTimer = null;
    let applyingUpdate = false;
    let bc = null;

    let runningVersion = { appVersion: null, buildId: null };
    let pendingUpdate = null;

    function isStaffSession(s = session) {
      return Boolean(s && s.authMode === "staff_session" && s.sessionToken);
    }

    function isSessionActive(s = session) {
      return Boolean(s && (isStaffSession(s) || s.access_token));
    }

    function ensureSuperAdminAccounts(rawList) {
      const clean = (Array.isArray(rawList) ? rawList : [])
        .map((a) => Core.sanitizeStaffAccountPublic(a))
        .filter(Boolean);
      const hasSuper = clean.some((a) => a.role === "super_admin");
      if (!hasSuper) {
        const nowIso = new Date().toISOString();
        clean.unshift({
          id: "acc_super_admin",
          username: Core.SUPER_ADMIN_USERNAME,
          staffName: Core.SUPER_ADMIN_DISPLAY_NAME,
          role: "super_admin",
          active: true,
          createdAt: nowIso,
          updatedAt: nowIso
        });
      }
      clean.sort((a, b) => {
        const rank = (r) => (r === "super_admin" ? 0 : r === "manager" ? 1 : r === "reception" ? 2 : 3);
        const diff = rank(a.role) - rank(b.role);
        return diff !== 0 ? diff : a.staffName.localeCompare(b.staffName);
      });
      return clean;
    }

    let stateCache = {
      bookings: [],
      auditLogs: [],
      autoBackups: [],
      hasRollbackBackup: false,
      operatingCosts: Core.createDefaultOperatingCostsState(),
      financeState: null, // Strictly null until server confirms authoritative load!
      enterpriseGlState: null,
      housekeepingTasks: [],
      maintenanceIssues: [],
      roomStatuses: Core.computeAllRoomOperationalStatuses([], [], Core.getTodayISO()),
      accounts: ensureSuperAdminAccounts([])
    };

    function findSessionAccount() {
      if (!session) return null;
      const u = String(session.username || "").trim().toLowerCase();
      const s = String(session.staffName || "").trim().toLowerCase();
      return stateCache.accounts.find((a) =>
        (session.accountId && a.id === session.accountId)
        || (u && a.username.toLowerCase() === u)
        || (s && (a.username.toLowerCase() === s || a.staffName.toLowerCase() === s))
      ) || null;
    }

    function getCurrentRole() {
      if (!session) return "reception";
      if (isStaffSession() && session.role) return Core.normalizeRole(session.role);
      const u = String(session.username || "").trim().toLowerCase();
      const nm = String(session.staffName || "").trim().toLowerCase();
      if (u === Core.SUPER_ADMIN_USERNAME || nm === Core.SUPER_ADMIN_USERNAME || nm === Core.SUPER_ADMIN_DISPLAY_NAME.toLowerCase()) {
        return "super_admin";
      }
      const matched = findSessionAccount();
      if (matched) return Core.normalizeRole(matched.role);
      if (session.role) return Core.normalizeRole(session.role);
      if (nm.includes("buồng phòng") || nm.includes("buongphong")) return "housekeeping";
      if (nm.includes("lễ tân") || nm.includes("letan")) return "reception";
      return "manager";
    }

    function can(permission) {
      return Core.hasPermission(getCurrentRole(), permission);
    }

    function emit(payload) {
      for (const fn of [...listeners]) {
        try { fn(payload); } catch (err) { console.error("[PMSSupabase listener error]", err); }
      }
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    function registerBusyCheck(fn) {
      if (typeof fn === "function") busyChecks.add(fn);
      return () => busyChecks.delete(fn);
    }

    function isUiBusy() {
      for (const fn of [...busyChecks]) {
        try { if (fn() === true) return true; } catch {}
      }
      return false;
    }

    function loadStoredSession() {
      try {
        const raw = root.localStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.authMode === "staff_session" && parsed.sessionToken) return parsed;
        if (parsed && parsed.access_token && parsed.refresh_token) return parsed;
      } catch {}
      return null;
    }

    function saveStoredSession(next) {
      session = next;
      try {
        if (next) root.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(next));
        else root.localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch {}
    }

    function getPublicAccountsList() {
      if (staffAuthAvailable === true && Array.isArray(publicAccountsCache) && publicAccountsCache.length > 0) {
        return publicAccountsCache.map((a) => ({
          id: a.id,
          username: a.username,
          staffName: a.staffName,
          role: Core.normalizeRole(a.role)
        }));
      }
      const out = [];
      const seen = new Set();
      for (const acc of stateCache.accounts) {
        if (!acc.active) {
          seen.add(acc.username.toLowerCase());
          seen.add(acc.staffName.toLowerCase());
          continue;
        }
        seen.add(acc.username.toLowerCase());
        seen.add(acc.staffName.toLowerCase());
        out.push({ id: acc.id, username: acc.username, staffName: acc.staffName, role: Core.normalizeRole(acc.role) });
      }
      for (const n of legacyStaffList) {
        const low = n.toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        out.push({ id: `sb_${low}`, username: n, staffName: n, role: "reception" });
      }
      if (!seen.has("buồng phòng") && !seen.has("buongphong")) {
        out.push({ id: "sb_hk", username: "Buồng phòng", staffName: "Buồng phòng", role: "housekeeping" });
      }
      return out;
    }

    function getAuthState() {
      const pub = getPublicAccountsList();
      const matched = findSessionAccount();
      return {
        authRequired: true,
        authConfigured: Boolean(baseUrl && anonKey),
        authenticated: isSessionActive(),
        user: isSessionActive() ? {
          id: session.accountId || (matched && matched.id) || (getCurrentRole() === "super_admin" ? "acc_super_admin" : ""),
          username: session.username || (matched && matched.username) || session.staffName || "Lễ tân",
          staffName: session.staffName || (matched && matched.staffName) || "Lễ tân",
          role: getCurrentRole()
        } : null,
        staffList: pub.map((a) => a.staffName),
        accountsPublic: pub
      };
    }

    function getVersionInfo() {
      return {
        appVersion: runningVersion.appVersion,
        buildId: runningVersion.buildId,
        pendingUpdate: pendingUpdate ? { ...pendingUpdate } : null
      };
    }

    function getFinanceLoadState() {
      const f = stateCache.financeState;
      const txCount = f && Array.isArray(f.transactions) ? f.transactions.length : 0;
      return {
        status: financeLoadState,
        error: financeLoadError,
        loaded: financeLoadState === "loaded",
        hasTransactions: txCount > 0,
        txCount,
        updatedAt: lastFinanceUpdatedAt,
        ledgerVersion: lastFinanceLedgerVersion
      };
    }

    function getStatus() {
      const authNow = getAuthState();
      return {
        mode: "server",
        backend: "supabase",
        connectionStatus,
        realtimeConnected: wsJoined,
        lastSyncedAt,
        storeVersion,
        isOnline: connectionStatus === "connected",
        authRequired: true,
        authenticated: isSessionActive(),
        user: authNow.user,
        role: getCurrentRole(),
        financeLoadState,
        financeLoadError,
        runningVersion: { ...runningVersion },
        pendingUpdate: pendingUpdate ? { ...pendingUpdate } : null
      };
    }

    function getSnapshot() {
      const isHk = getCurrentRole() === "housekeeping";
      return {
        bookings: isHk ? [] : stateCache.bookings,
        auditLogs: isHk ? [] : stateCache.auditLogs,
        autoBackups: isHk ? [] : stateCache.autoBackups,
        hasRollbackBackup: isHk ? false : stateCache.hasRollbackBackup,
        operatingCosts: can("costs:read") ? stateCache.operatingCosts : null,
        financeState: getFinanceStateForCurrentRole(),
        enterpriseGlState: can("reports:management") ? stateCache.enterpriseGlState : null,
        financeLoadState,
        financeLoadError,
        housekeepingTasks: stateCache.housekeepingTasks,
        maintenanceIssues: stateCache.maintenanceIssues,
        roomStatuses: stateCache.roomStatuses,
        accounts: can("accounts:manage") ? stateCache.accounts : [],
        storeVersion
      };
    }

    /* -------------------- Safe Live A -> B Auto-Update -------------------- */

    async function notifyServiceWorkerCacheClear() {
      try {
        if (!("serviceWorker" in navigator)) return;
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          reg.update().catch(() => {});
          if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
          if (reg.active) reg.active.postMessage({ type: "CLEAR_APP_CACHE" });
        }
        if (root.caches && typeof root.caches.keys === "function") {
          const keys = await root.caches.keys();
          await Promise.all(keys.map((k) => root.caches.delete(k).catch(() => {})));
        }
      } catch {}
    }

    async function applyPendingUpdateNow() {
      if (applyingUpdate || !pendingUpdate) return;
      applyingUpdate = true;
      if (idleUpdateTimer) { clearInterval(idleUpdateTimer); idleUpdateTimer = null; }
      emit({ type: "update_applying", pendingUpdate: { ...pendingUpdate }, status: getStatus() });
      await notifyServiceWorkerCacheClear();
      setTimeout(() => { try { root.location.reload(); } catch {} }, 350);
    }

    function attemptSafeUpdate() {
      if (!pendingUpdate || applyingUpdate) return;
      if (!isUiBusy()) {
        applyPendingUpdateNow();
        return;
      }
      if (!idleUpdateTimer) {
        idleUpdateTimer = setInterval(() => {
          if (!pendingUpdate || applyingUpdate) {
            clearInterval(idleUpdateTimer);
            idleUpdateTimer = null;
            return;
          }
          if (!isUiBusy()) applyPendingUpdateNow();
        }, 650);
      }
    }

    function notifyIdleCheck() {
      if (pendingUpdate && !applyingUpdate) {
        setTimeout(() => attemptSafeUpdate(), 120);
      }
    }

    function recordOrCheckVersion(appVersion, buildId) {
      if (!buildId) return;
      if (!runningVersion.buildId) {
        runningVersion = { appVersion: appVersion || null, buildId };
        emit({ type: "version", version: getVersionInfo(), status: getStatus() });
        return;
      }
      if (runningVersion.buildId !== buildId) {
        const nextInfo = { appVersion: appVersion || runningVersion.appVersion, buildId };
        if (!pendingUpdate || pendingUpdate.buildId !== buildId) {
          pendingUpdate = nextInfo;
          notifyServiceWorkerCacheClear();
          emit({ type: "update_pending", pendingUpdate: { ...pendingUpdate }, status: getStatus() });
        }
        attemptSafeUpdate();
      }
    }

    async function checkAppVersion() {
      if (navigator.onLine === false) return null;
      try {
        const res = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.buildId) {
          recordOrCheckVersion(data.appVersion, data.buildId);
          return { appVersion: data.appVersion, buildId: data.buildId };
        }
      } catch {}
      return null;
    }

    /* -------------------- HTTP & Single-Flight Supabase Auth -------------------- */

    async function rawFetchJson(url, options = {}) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 12000) : null;
      try {
        const res = await fetch(url, {
          method: options.method || "GET",
          headers: {
            "Accept": "application/json",
            "apikey": anonKey,
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          cache: "no-store",
          signal: controller ? controller.signal : undefined
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        return { httpOk: res.ok, status: res.status, data };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    async function fetchPublicAccounts() {
      if (!baseUrl || !anonKey || navigator.onLine === false) return null;
      try {
        const res = await rawFetchJson(`${baseUrl}/rest/v1/rpc/pms_public_accounts`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${anonKey}` },
          body: {},
          timeoutMs: 6000
        });
        if (res.httpOk && res.data && res.data.ok && Array.isArray(res.data.accounts)) {
          staffAuthAvailable = true;
          publicAccountsCache = res.data.accounts;
          if (!isSessionActive()) {
            emit({ type: "auth_required", auth: getAuthState(), status: getStatus() });
          }
          return publicAccountsCache;
        }
        if (res.status === 404 || (res.data && res.data.code === "PGRST202")) {
          staffAuthAvailable = false;
        }
      } catch {}
      return null;
    }

    function handleAuthExpired(errorMsg) {
      closeRealtime();
      saveStoredSession(null);
      connectionStatus = "auth_required";
      fetchPublicAccounts();
      emit({
        type: "auth_required",
        error: errorMsg || "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại (nội dung đang nhập vẫn được giữ).",
        auth: getAuthState(),
        status: getStatus()
      });
    }

    // Single-flight token refresh prevents concurrent RPCs from racing refresh-token rotation!
    async function ensureValidAccessToken(forceRefresh = false) {
      if (!isSessionActive()) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      if (isStaffSession()) {
        if (session.expires_at && nowSec >= session.expires_at) {
          handleAuthExpired("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
          return null;
        }
        return anonKey;
      }
      if (!forceRefresh && session.expires_at && session.expires_at - nowSec > 120) {
        return session.access_token;
      }
      if (!session.refresh_token) return session.access_token;
      if (refreshInFlight) return refreshInFlight;

      const refreshTok = session.refresh_token;
      const prevMeta = {
        username: session.username || "",
        staffName: session.staffName || "Lễ tân",
        role: session.role || "",
        accountId: session.accountId || ""
      };
      refreshInFlight = (async () => {
        try {
          const res = await rawFetchJson(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
            method: "POST",
            body: { refresh_token: refreshTok },
            timeoutMs: 8000
          });
          if (res.httpOk && res.data && res.data.access_token) {
            const next = {
              ...prevMeta,
              access_token: res.data.access_token,
              refresh_token: res.data.refresh_token || refreshTok,
              expires_at: Math.floor(Date.now() / 1000) + (Number(res.data.expires_in) || 3600)
            };
            saveStoredSession(next);
            pushAccessTokenToRealtime(next.access_token);
            return next.access_token;
          }
          if (res.status === 400 || res.status === 401) {
            handleAuthExpired("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
            return null;
          }
        } catch {}
        return session ? session.access_token : null;
      })().finally(() => {
        refreshInFlight = null;
      });

      return refreshInFlight;
    }

    async function callRpc(rpcName, params = {}, allowRetry = true) {
      if (navigator.onLine === false) {
        connectionStatus = "offline";
        emit({ type: "status", status: getStatus() });
        return {
          ok: false,
          offline: true,
          code: "NETWORK_OFFLINE",
          error: "Đang mất kết nối mạng — dữ liệu CHƯA được lưu lên máy chủ. Nội dung bạn đang nhập vẫn được giữ nguyên."
        };
      }
      const requestOwner = session && (session.sessionToken || session.accountId || session.username || session.email);
      const token = await ensureValidAccessToken(false);
      if (!token) {
        return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "Vui lòng đăng nhập tài khoản Dongvan Hotel." };
      }
      const reqBody = isStaffSession()
        ? { ...params, p_session_token: session.sessionToken }
        : params;
      try {
        const res = await rawFetchJson(`${baseUrl}/rest/v1/rpc/${rpcName}`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}` },
          body: reqBody,
          timeoutMs: 12000
        });
        if (!session || requestOwner !== (session.sessionToken || session.accountId || session.username || session.email)) {
          return { ok: false, code: "SESSION_CHANGED", error: "Đã đổi tài khoản. Hãy xác minh giao dịch trong phiên ban đầu." };
        }
        const errMsg = res.data && String(res.data.message || res.data.error || "");
        if (res.status === 401 || errMsg.includes("AUTH_REQUIRED")) {
          if (allowRetry && !isStaffSession() && session && session.refresh_token) {
            const refreshed = await ensureValidAccessToken(true);
            if (refreshed) return callRpc(rpcName, params, false);
          }
          handleAuthExpired(
            isStaffSession()
              ? "Phiên đăng nhập đã hết hạn hoặc tài khoản đã bị chặn/xóa. Vui lòng đăng nhập lại."
              : "Phiên đăng nhập đã hết hạn — nội dung đang nhập vẫn được giữ nguyên."
          );
          return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại rồi bấm Lưu." };
        }
        if (res.status === 403 || errMsg.includes("FORBIDDEN")) {
          return { ok: false, status: 403, code: "FORBIDDEN", error: "Tài khoản của bạn không có quyền thực hiện thao tác hoặc xem dữ liệu này." };
        }
        if (!res.httpOk) {
          return {
            ...(res.data && typeof res.data === "object" ? res.data : {}),
            ok: false,
            status: res.status,
            code: (res.data && res.data.code) || "SERVER_ERROR",
            error: (res.data && (res.data.error || res.data.message)) || `Lỗi máy chủ Supabase (${res.status}).`
          };
        }
        return res.data || { ok: false, code: "EMPTY_RESPONSE", error: "Máy chủ không trả về dữ liệu." };
      } catch {
        connectionStatus = navigator.onLine === false ? "offline" : "reconnecting";
        emit({ type: "status", status: getStatus() });
        return {
          ok: false,
          offline: true,
          code: "NETWORK_OFFLINE",
          error: "Không kết nối được tới máy chủ đám mây — dữ liệu CHƯA được lưu. Nội dung đang nhập vẫn được giữ nguyên."
        };
      }
    }

    /* -------------------- Monotonic State Application & Coalesced Pulls -------------------- */

    function applyCloudState(data, meta = {}) {
      if (!data || !Array.isArray(data.bookings)) return false;
      const incomingVer = typeof data.storeVersion === "number" ? data.storeVersion : null;
      const allowReset = meta.type === "auth_login" && storeVersion === 0;
      // Prevent out-of-order stale responses from overwriting a newer committed version
      if (!allowReset && incomingVer !== null && incomingVer < storeVersion) {
        return false;
      }

      if (data.financeState && Number(data.financeState.ledgerVersion || 0) < lastFinanceLedgerVersion) return false;

      if (data.user && isStaffSession() && session) {
        const nextRole = Core.normalizeRole(data.user.role);
        if (session.role !== nextRole || session.staffName !== data.user.staffName) {
          saveStoredSession({
            ...session,
            accountId: data.user.id || session.accountId,
            username: data.user.username || session.username,
            staffName: data.user.staffName || session.staffName,
            role: nextRole
          });
        }
      }

      Core.normalizeDormSlots(data.bookings);
      stateCache.bookings = data.bookings;
      if (Array.isArray(data.auditLogs)) stateCache.auditLogs = data.auditLogs;
      if (Array.isArray(data.autoBackups)) stateCache.autoBackups = data.autoBackups;
      if (typeof data.hasRollbackBackup === "boolean") stateCache.hasRollbackBackup = data.hasRollbackBackup;
      if (data.operatingCosts && typeof data.operatingCosts === "object") {
        stateCache.operatingCosts = Core.sanitizeOperatingCostsState(data.operatingCosts);
        lastOperatingCostsUpdatedAt = stateCache.operatingCosts.updatedAt || lastOperatingCostsUpdatedAt;
      } else if (data.operatingCosts === null) {
        stateCache.operatingCosts = can("costs:read") ? Core.createDefaultOperatingCostsState() : null;
      }

      // v1.9.0: Authoritative financeState application with explicit 3-state tracking ("loading" | "loaded" | "error")
      const curRole = getCurrentRole();
      if (curRole === "housekeeping") {
        stateCache.financeState = null;
        financeLoadState = "loaded";
        financeLoadError = "";
      } else if (Object.prototype.hasOwnProperty.call(data, "financeState")) {
        if (data.financeState && Array.isArray(data.financeState.transactions)) {
          stateCache.financeState = Core.sanitizeFinanceState(data.financeState);
          lastFinanceUpdatedAt = stateCache.financeState.updatedAt || lastFinanceUpdatedAt;
          lastFinanceLedgerVersion = Number(stateCache.financeState.ledgerVersion) || 0;
          financeLoadState = "loaded";
          financeLoadError = "";
        } else {
          financeLoadState = "error";
          financeLoadError = "Máy chủ chưa trả về sổ tài chính hợp lệ.";
        }
      } else {
        financeLoadState = "error";
        financeLoadError = "Máy chủ chưa trả về sổ tài chính (cần cập nhật supabase/schema.sql bản v1.9.0).";
      }

      if (!can("reports:management")) {
        stateCache.enterpriseGlState = null;
      } else if (Object.prototype.hasOwnProperty.call(data, "enterpriseGlState")) {
        const ER = root.PMSEnterpriseReport;
        stateCache.enterpriseGlState = data.enterpriseGlState && typeof data.enterpriseGlState === "object"
          ? (ER && typeof ER.sanitizeEnterpriseGlState === "function" ? ER.sanitizeEnterpriseGlState(data.enterpriseGlState) : data.enterpriseGlState)
          : (ER && typeof ER.createDefaultEnterpriseGlState === "function" ? ER.createDefaultEnterpriseGlState() : null);
      }

      if (Array.isArray(data.housekeepingTasks)) {
        stateCache.housekeepingTasks = data.housekeepingTasks.map((t) => Core.sanitizeHousekeepingTask(t)).filter(Boolean);
      }
      if (Array.isArray(data.maintenanceIssues)) {
        stateCache.maintenanceIssues = data.maintenanceIssues.map((i) => Core.sanitizeMaintenanceIssue(i)).filter(Boolean);
      }
      stateCache.roomStatuses = Core.computeAllRoomOperationalStatuses(stateCache.housekeepingTasks, stateCache.maintenanceIssues, Core.getTodayISO());
      if (Array.isArray(data.accounts) && can("accounts:manage")) {
        stateCache.accounts = ensureSuperAdminAccounts(data.accounts);
      }
      if (incomingVer !== null) storeVersion = incomingVer;
      lastSyncedAt = new Date().toISOString();
      connectionStatus = "connected";
      emit({
        type: meta.type || "state",
        remoteEvent: meta.remoteEvent || null,
        state: getSnapshot(),
        status: getStatus()
      });
      return true;
    }

    function applyMutationCommit(rpcRes, broadcastMeta = {}) {
      if (!rpcRes || !rpcRes.ok) return false;
      const incomingVer = typeof rpcRes.storeVersion === "number" ? rpcRes.storeVersion : storeVersion;
      if (Array.isArray(rpcRes.bookings)) {
        Core.normalizeDormSlots(rpcRes.bookings);
        stateCache.bookings = rpcRes.bookings;
      }
      if (rpcRes.auditEntry && typeof rpcRes.auditEntry === "object") {
        stateCache.auditLogs = [
          rpcRes.auditEntry,
          ...stateCache.auditLogs.filter((l) => l && l.id !== rpcRes.auditEntry.id)
        ].slice(0, 300);
      }
      stateCache.hasRollbackBackup = true;
      if (incomingVer > storeVersion) storeVersion = incomingVer;
      lastSyncedAt = new Date().toISOString();
      connectionStatus = "connected";

      emit({
        type: "local_commit",
        remoteEvent: null,
        state: getSnapshot(),
        status: getStatus()
      });

      // Push instant <80ms delta to all peer devices (WebSocket Broadcast) & local tabs (BroadcastChannel)
      if (!rpcRes.idempotentHit) {
        broadcastDeltaToPeers({
          senderId: clientId,
          storeVersion,
          action: broadcastMeta.action || "UPDATE",
          booking: rpcRes.booking || null,
          deletedId: broadcastMeta.deletedId || null,
          roomId: (rpcRes.booking && rpcRes.booking.roomId) || broadcastMeta.roomId || "",
          guestName: (rpcRes.booking && rpcRes.booking.guestName) || broadcastMeta.guestName || "",
          auditEntry: rpcRes.auditEntry || null,
          actor: (session && session.staffName) || "",
          ts: lastSyncedAt,
          bulkReplace: Boolean(broadcastMeta.bulkReplace)
        });
      }
      return true;
    }

    function broadcastDeltaToPeers(delta) {
      const payload = { senderId: clientId, action: "STATE_CHANGED", storeVersion: delta.storeVersion, ts: new Date().toISOString() };
      // 1. Sub-100ms cross-device push via Supabase Realtime Phoenix Broadcast
      if (ws && ws.readyState === 1 && wsJoined) {
        try {
          ws.send(JSON.stringify({
            topic: "realtime:pms-sync",
            event: "broadcast",
            payload: {
              type: "broadcast",
              event: "pms_sync",
              payload
            },
            ref: String(++wsRef)
          }));
        } catch {}
      }
      // 2. Sub-5ms same-device multi-tab push via BroadcastChannel
      if (bc) {
        try { bc.postMessage({ type: "pms_sync", payload }); } catch {}
      }
    }

    function applyAccountsUpdate(rawAccounts, updatedAt) {
      if (!Array.isArray(rawAccounts)) return;
      stateCache.accounts = ensureSuperAdminAccounts(rawAccounts);
      if (updatedAt) lastAccountsUpdatedAt = updatedAt;
      // Live revocation check: if current non-super-admin session account was blocked or deleted, sign out immediately!
      if (session && getCurrentRole() !== "super_admin") {
        const matched = findSessionAccount();
        if (matched && !matched.active) {
          handleAuthExpired("Tài khoản của bạn đã bị Tổng quản lý chặn truy cập.");
        } else if (session.accountId && !matched) {
          handleAuthExpired("Tài khoản của bạn đã bị Tổng quản lý xóa khỏi hệ thống.");
        }
      }
    }

    function applyIncomingPeerDelta(delta) {
      if (!delta || delta.senderId === clientId || !isSessionActive()) return;
      // The RPC applies the recipient's current role and returns its authoritative view.
      pullLatestFromCloud({ type: "remote_change", remoteEvent: { action: "REMOTE_CHANGE" } });
    }

    async function pullLatestFromCloud(meta = {}) {
      if (!isSessionActive()) {
        return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
      }

      // Coalesce concurrent pulls so rapid bursts never cause out-of-order overwrites or N duplicate RPCs
      if (inFlightPull) {
        queuedPullMeta = meta;
        return inFlightPull;
      }

      const runOnePull = async (currentMeta) => {
        if (currentMeta.type === "init" || currentMeta.type === "auth_login") {
          financeLoadState = "loading";
          financeLoadError = "";
          emit({ type: "status", status: getStatus() });
        }
        const res = await callRpc("pms_control_get_state", {});
        if (!res || !res.ok) {
          if (financeLoadState !== "loaded" || currentMeta.type === "init" || currentMeta.type === "auth_login") {
            financeLoadState = "error";
            financeLoadError = (res && res.error) || "Không tải được sổ tài chính từ máy chủ.";
            emit({ type: "status", status: getStatus() });
          }
          return res || { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Không thể tải dữ liệu." };
        }
        connectionStatus = "connected";
        applyCloudState(res, currentMeta);
        if (financeLoadState === "loaded" && readPendingFinanceIntents().length > 0 && !currentMeta._skipIntentReconcile) {
          reconcilePendingFinanceIntents().catch(() => {});
        }
        return { ok: true, bookings: stateCache.bookings, financeState: getFinanceStateForCurrentRole(), financeLoadState, storeVersion };
      };

      inFlightPull = (async () => {
        let lastResult = await runOnePull(meta);
        while (queuedPullMeta && isSessionActive()) {
          const nextMeta = queuedPullMeta;
          queuedPullMeta = null;
          lastResult = await runOnePull(nextMeta);
        }
        return lastResult;
      })().finally(() => {
        inFlightPull = null;
      });

      return inFlightPull;
    }

    // Ultra-lightweight version probe & live session revocation check
    async function checkRemoteVersionAndSync(reason = "VERSION_PROBE") {
      if (!isSessionActive() || navigator.onLine === false) return false;
      if (inFlightPull || inFlightVersionProbe) return false;

      inFlightVersionProbe = (async () => {
        lastProbeAt = Date.now();
        if (isStaffSession()) {
          const syncRes = await callRpc("pms_check_sync", {});
          if (!syncRes || !syncRes.ok) return false;
          const remoteVer = typeof syncRes.storeVersion === "number" ? syncRes.storeVersion : null;
          const remoteCostsTs = syncRes.operatingCostsUpdatedAt || "";
          const remoteFinTs = syncRes.financeUpdatedAt || "";
          const remoteFinVer = typeof syncRes.financeLedgerVersion === "number" ? syncRes.financeLedgerVersion : -1;
          const remoteHkTs = syncRes.housekeepingUpdatedAt || "";
          const remoteIssTs = syncRes.issuesUpdatedAt || "";
          const remoteAccTs = syncRes.accountsUpdatedAt || "";
          const financeChanged = getCurrentRole() !== "housekeeping" && (
            financeLoadState !== "loaded"
            || (remoteFinTs && remoteFinTs !== lastFinanceUpdatedAt)
            || (remoteFinVer >= 0 && remoteFinVer > lastFinanceLedgerVersion)
          );
          const needsPull = (remoteVer !== null && remoteVer > storeVersion)
            || financeChanged
            || (can("costs:read") && remoteCostsTs && remoteCostsTs !== lastOperatingCostsUpdatedAt)
            || (remoteHkTs && remoteHkTs !== lastHousekeepingUpdatedAt)
            || (remoteIssTs && remoteIssTs !== lastIssuesUpdatedAt)
            || (can("accounts:manage") && remoteAccTs && remoteAccTs !== lastAccountsUpdatedAt);

          if (remoteCostsTs) lastOperatingCostsUpdatedAt = remoteCostsTs;
          if (remoteHkTs) lastHousekeepingUpdatedAt = remoteHkTs;
          if (remoteIssTs) lastIssuesUpdatedAt = remoteIssTs;
          if (remoteAccTs) lastAccountsUpdatedAt = remoteAccTs;

          if (needsPull) {
            await pullLatestFromCloud({
              type: "remote_change",
              remoteEvent: { ...(syncRes.storeMeta || {}), action: (syncRes.storeMeta && syncRes.storeMeta.action) || reason },
              force: true
            });
            return true;
          }
          if (connectionStatus !== "connected") {
            connectionStatus = "connected";
            lastSyncedAt = new Date().toISOString();
            emit({ type: "status", status: getStatus() });
          }
          return false;
        }

        const token = await ensureValidAccessToken(false);
        if (!token) return false;
        try {
          const res = await rawFetchJson(`${baseUrl}/rest/v1/pms_meta?key=in.(store_version,operating_costs_v1,staff_accounts_v1)&select=key,value,updated_at`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${token}` },
            timeoutMs: 6000
          });
          if (res.status === 401) {
            const refreshed = await ensureValidAccessToken(true);
            if (!refreshed) return false;
            return false;
          }
          if (!res.httpOk || !Array.isArray(res.data) || res.data.length === 0) return false;

          const svRow = res.data.find((r) => r && r.key === "store_version") || (!res.data[0].key ? res.data[0] : null);
          const costRow = res.data.find((r) => r && r.key === "operating_costs_v1") || null;
          const accRow = res.data.find((r) => r && r.key === "staff_accounts_v1") || null;

          if (accRow && accRow.value && Array.isArray(accRow.value.accounts)) {
            const remoteAccTs = (accRow.value && accRow.value.updatedAt) || accRow.updated_at || "";
            if (!lastAccountsUpdatedAt || (remoteAccTs && remoteAccTs > lastAccountsUpdatedAt)) {
              applyAccountsUpdate(accRow.value.accounts, remoteAccTs);
            }
          }

          let costsSynced = false;
          if (costRow && costRow.value) {
            const remoteCostTs = (costRow.value && costRow.value.updatedAt) || costRow.updated_at || "";
            const shouldApplyCosts = !lastOperatingCostsUpdatedAt || (remoteCostTs && remoteCostTs > lastOperatingCostsUpdatedAt);
            if (shouldApplyCosts) {
              stateCache.operatingCosts = Core.sanitizeOperatingCostsState(costRow.value);
              lastOperatingCostsUpdatedAt = remoteCostTs || stateCache.operatingCosts.updatedAt || "";
              lastSyncedAt = new Date().toISOString();
              connectionStatus = "connected";
              costsSynced = true;
              emit({
                type: "remote_change",
                remoteEvent: { action: "COSTS_UPDATE", reason, ts: lastSyncedAt },
                state: getSnapshot(),
                status: getStatus()
              });
            }
          }

          const val = svRow && svRow.value;
          const remoteVer = val && typeof val.version === "number" ? val.version : null;
          if (remoteVer !== null && remoteVer > storeVersion) {
            await pullLatestFromCloud({
              type: "remote_change",
              remoteEvent: { ...(val || {}), action: (val && val.action) || reason }
            });
            return true;
          }
          if (connectionStatus !== "connected") {
            connectionStatus = "connected";
            lastSyncedAt = new Date().toISOString();
            emit({ type: "status", status: getStatus() });
          }
          return costsSynced;
        } catch {
          return false;
        }
      })().finally(() => {
        inFlightVersionProbe = null;
      });

      return inFlightVersionProbe;
    }

    /* -------------------- Supabase Realtime WebSocket + Watchdog -------------------- */

    function clearHeartbeatTimers() {
      if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
      if (wsHeartbeatWatchdog) { clearTimeout(wsHeartbeatWatchdog); wsHeartbeatWatchdog = null; }
      pendingHeartbeatRef = null;
    }

    function closeRealtime() {
      wsJoined = false;
      wsConnecting = false;
      wsJoinRef = null;
      clearHeartbeatTimers();
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
      if (ws) {
        try {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onclose = null;
          ws.onerror = null;
          ws.close();
        } catch {}
        ws = null;
      }
    }

    function pushAccessTokenToRealtime(accessToken) {
      if (!ws || ws.readyState !== 1 || !accessToken) return;
      try {
        ws.send(JSON.stringify({
          topic: "realtime:pms-sync",
          event: "access_token",
          payload: { access_token: accessToken },
          ref: String(++wsRef)
        }));
      } catch {}
    }

    function scheduleRealtimeReconnect() {
      if (wsReconnectTimer || !isSessionActive() || navigator.onLine === false) return;
      const delay = Math.min(4000, 450 * Math.pow(1.5, wsReconnectAttempt));
      wsReconnectAttempt += 1;
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectRealtime();
      }, delay);
    }

    async function connectRealtime() {
      if (!isSessionActive() || typeof root.WebSocket !== "function" || navigator.onLine === false) return;
      if (wsConnecting) return;
      wsConnecting = true;

      let accessToken = null;
      try {
        accessToken = await ensureValidAccessToken(false);
      } finally {
        wsConnecting = false;
      }
      if (!accessToken || !isSessionActive() || navigator.onLine === false) return;

      closeRealtime();
      const wsBase = baseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
      const wsUrl = `${wsBase}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;

      try {
        const socket = new root.WebSocket(wsUrl);
        ws = socket;

        socket.onopen = () => {
          if (ws !== socket) return;
          wsReconnectAttempt = 0;
          wsJoinRef = String(++wsRef);
          const joinConfig = isStaffSession()
            ? { broadcast: { ack: false, self: false }, presence: { key: "" } }
            : {
                broadcast: { ack: false, self: false },
                presence: { key: "" },
                postgres_changes: [{ event: "*", schema: "public", table: "pms_meta" }]
              };
          socket.send(JSON.stringify({
            topic: "realtime:pms-sync",
            event: "phx_join",
            payload: {
              config: joinConfig,
              access_token: (session && session.access_token) || accessToken
            },
            ref: wsJoinRef
          }));

          // Heartbeat + 5s ACK Watchdog detects silently dropped iOS / Wi-Fi sockets!
          wsHeartbeatTimer = setInterval(() => {
            if (ws !== socket || socket.readyState !== 1) return;
            const hbRef = String(++wsRef);
            pendingHeartbeatRef = hbRef;
            try {
              socket.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: hbRef }));
            } catch {
              forceReconnectRealtime("HEARTBEAT_SEND_FAIL");
              return;
            }
            if (wsHeartbeatWatchdog) clearTimeout(wsHeartbeatWatchdog);
            wsHeartbeatWatchdog = setTimeout(() => {
              if (pendingHeartbeatRef === hbRef && ws === socket) {
                forceReconnectRealtime("HEARTBEAT_TIMEOUT");
              }
            }, HEARTBEAT_TIMEOUT_MS);
          }, HEARTBEAT_INTERVAL_MS);
        };

        socket.onmessage = (ev) => {
          if (ws !== socket) return;
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }

          // Heartbeat ACK received -> connection is genuinely alive!
          if (msg.event === "phx_reply" && msg.topic === "phoenix") {
            if (pendingHeartbeatRef && String(msg.ref) === pendingHeartbeatRef) {
              pendingHeartbeatRef = null;
              if (wsHeartbeatWatchdog) { clearTimeout(wsHeartbeatWatchdog); wsHeartbeatWatchdog = null; }
            }
            return;
          }

          if (msg.event === "phx_reply" && msg.topic === "realtime:pms-sync") {
            if (msg.payload && msg.payload.status === "ok") {
              wsJoined = true;
              connectionStatus = "connected";
              emit({ type: "status", status: getStatus() });
              // Catch up immediately on (re)join in case events happened during disconnect
              checkRemoteVersionAndSync("SYNC_CATCHUP");
            } else if (wsJoinRef && String(msg.ref) === wsJoinRef) {
              // Join failed (often stale JWT after sleep) -> refresh token & reconnect!
              wsJoined = false;
              ensureValidAccessToken(true).then((tok) => {
                if (tok) forceReconnectRealtime("REJOIN_AFTER_REFRESH");
              });
            }
            return;
          }

          // Layer 1 (<80ms): Instant Broadcast delta from peer device
          if (msg.event === "broadcast") {
            const p = msg.payload && (msg.payload.event === "pms_sync" ? msg.payload.payload : msg.payload);
            if (p && typeof p === "object") {
              applyIncomingPeerDelta(p);
            }
            return;
          }

          // Layer 2 (Authoritative DB WAL): postgres_changes on pms_meta
          if (msg.event === "postgres_changes") {
            const rec = msg.payload && msg.payload.data && msg.payload.data.record;
            if (rec && rec.key === "operating_costs_v1" && rec.value) {
              const remoteCostTs = (rec.value && rec.value.updatedAt) || rec.updated_at || "";
              if (!lastOperatingCostsUpdatedAt || !remoteCostTs || remoteCostTs > lastOperatingCostsUpdatedAt) {
                stateCache.operatingCosts = Core.sanitizeOperatingCostsState(rec.value);
                lastOperatingCostsUpdatedAt = remoteCostTs || stateCache.operatingCosts.updatedAt || "";
                lastSyncedAt = new Date().toISOString();
                connectionStatus = "connected";
                emit({
                  type: "remote_change",
                  remoteEvent: { action: "COSTS_UPDATE", ts: lastSyncedAt },
                  state: getSnapshot(),
                  status: getStatus()
                });
              }
              return;
            }
            if (rec && rec.key === "staff_accounts_v1" && rec.value && Array.isArray(rec.value.accounts)) {
              const remoteAccTs = (rec.value && rec.value.updatedAt) || rec.updated_at || "";
              applyAccountsUpdate(rec.value.accounts, remoteAccTs);
              lastSyncedAt = new Date().toISOString();
              emit({
                type: "remote_change",
                remoteEvent: { action: "ACCOUNTS_UPDATE", ts: lastSyncedAt },
                state: getSnapshot(),
                status: getStatus()
              });
              return;
            }
            if (rec && rec.key === "housekeeping_v1" && rec.value && Array.isArray(rec.value.tasks)) {
              stateCache.housekeepingTasks = rec.value.tasks.map((t) => Core.sanitizeHousekeepingTask(t)).filter(Boolean);
              stateCache.roomStatuses = Core.computeAllRoomOperationalStatuses(stateCache.housekeepingTasks, stateCache.maintenanceIssues, Core.getTodayISO());
              lastSyncedAt = new Date().toISOString();
              emit({ type: "remote_change", remoteEvent: { action: "HK_UPDATE", ts: lastSyncedAt }, state: getSnapshot(), status: getStatus() });
              return;
            }
            if (rec && rec.key === "issues_v1" && rec.value && Array.isArray(rec.value.issues)) {
              stateCache.maintenanceIssues = rec.value.issues.map((i) => Core.sanitizeMaintenanceIssue(i)).filter(Boolean);
              stateCache.roomStatuses = Core.computeAllRoomOperationalStatuses(stateCache.housekeepingTasks, stateCache.maintenanceIssues, Core.getTodayISO());
              lastSyncedAt = new Date().toISOString();
              emit({ type: "remote_change", remoteEvent: { action: "ISSUE_UPDATE", ts: lastSyncedAt }, state: getSnapshot(), status: getStatus() });
              return;
            }
            const metaVal = rec && rec.key === "store_version" ? rec.value : null;
            const remoteVer = metaVal && typeof metaVal.version === "number" ? metaVal.version : null;
            if (remoteVer === null || remoteVer > storeVersion) {
              pullLatestFromCloud({
                type: "remote_change",
                remoteEvent: metaVal || { action: "REMOTE_CHANGE" }
              });
            }
          }
        };

        socket.onerror = () => {
          if (ws !== socket) return;
          wsJoined = false;
        };

        socket.onclose = () => {
          if (ws !== socket) return;
          wsJoined = false;
          clearHeartbeatTimers();
          if (navigator.onLine === false) {
            connectionStatus = "offline";
          } else if (isSessionActive()) {
            connectionStatus = "reconnecting";
          }
          emit({ type: "status", status: getStatus() });
          scheduleRealtimeReconnect();
        };
      } catch {
        connectionStatus = "reconnecting";
        emit({ type: "status", status: getStatus() });
        scheduleRealtimeReconnect();
      }
    }

    function forceReconnectRealtime(reason) {
      closeRealtime();
      if (!isSessionActive() || navigator.onLine === false) return;
      connectionStatus = "reconnecting";
      emit({ type: "status", status: getStatus() });
      checkRemoteVersionAndSync(reason || "RECONNECT_SYNC");
      connectRealtime();
    }

    function handleAppResume(reason) {
      checkAppVersion();
      if (!isSessionActive() || navigator.onLine === false) return;
      checkRemoteVersionAndSync(reason);
      if (!ws || ws.readyState !== 1 || !wsJoined) {
        connectRealtime();
      }
    }

    function bindWatchers() {
      if (watchersBound) return;
      watchersBound = true;

      // Same-device multi-tab instant sync (<5ms)
      if (typeof root.BroadcastChannel === "function") {
        try {
          bc = new root.BroadcastChannel(BROADCAST_CHANNEL_NAME);
          bc.onmessage = (ev) => {
            if (ev && ev.data && ev.data.type === "pms_sync" && ev.data.payload) {
              applyIncomingPeerDelta(ev.data.payload);
            }
          };
        } catch {
          bc = null;
        }
      }

      root.addEventListener("offline", () => {
        closeRealtime();
        connectionStatus = "offline";
        emit({ type: "status", status: getStatus() });
      });

      root.addEventListener("online", () => {
        checkAppVersion();
        if (!isSessionActive()) return;
        connectionStatus = "reconnecting";
        emit({ type: "status", status: getStatus() });
        if (financeLoadState !== "loaded" || readPendingFinanceIntents().length > 0) {
          pullLatestFromCloud({ type: "remote_change", force: true }).catch(() => {});
        } else {
          checkRemoteVersionAndSync("RECONNECT_SYNC");
        }
        connectRealtime();
      });

      root.document.addEventListener("visibilitychange", () => {
        if (!root.document.hidden) handleAppResume("RESUME_SYNC");
      });

      // Critical for iOS Safari standalone PWA bfcache & app-switcher resume!
      root.addEventListener("pageshow", () => handleAppResume("PAGESHOW_SYNC"));
      root.addEventListener("focus", () => {
        if (Date.now() - lastProbeAt > 2000) handleAppResume("FOCUS_SYNC");
      });

      // Layer 3 adaptive lightweight probe: 3.5s when WS degraded, 12s safety check when WS healthy
      if (!syncProbeTimer) {
        syncProbeTimer = setInterval(() => {
          if (root.document.hidden || navigator.onLine === false || !isSessionActive()) return;
          const intervalNeeded = wsJoined ? HEALTHY_PROBE_MS : DEGRADED_PROBE_MS;
          if (Date.now() - lastProbeAt >= intervalNeeded) {
            checkRemoteVersionAndSync(wsJoined ? "SAFETY_PROBE" : "DEGRADED_PROBE");
          }
          if (!wsJoined && !wsConnecting && !wsReconnectTimer) {
            connectRealtime();
          }
        }, 2000);
      }

      if (!versionCheckTimer) {
        versionCheckTimer = setInterval(() => {
          if (!root.document.hidden && navigator.onLine !== false) {
            checkAppVersion();
          }
        }, 45000);
      }
    }

    /* -------------------- Public Unified Client API -------------------- */

    async function init() {
      bindWatchers();
      checkAppVersion();
      const stored = loadStoredSession();
      if (!stored) {
        connectionStatus = "auth_required";
        await fetchPublicAccounts();
        emit({ type: "auth_required", auth: getAuthState(), status: getStatus() });
        return { ok: true, mode: "server", authRequired: true, authenticated: false, bookings: [] };
      }

      session = stored;
      const pulled = await pullLatestFromCloud({ type: "init", force: true });
      if (pulled.ok) {
        connectRealtime();
        return { ok: true, mode: "server", bookings: stateCache.bookings, recoveredFromBackup: false };
      }
      if (pulled.code === "AUTH_REQUIRED") {
        return { ok: true, mode: "server", authRequired: true, authenticated: false, bookings: [] };
      }
      return { ok: false, mode: "server", offline: true, code: "NETWORK_OFFLINE", error: pulled.error, bookings: [] };
    }

    async function login(staffName, passcode) {
      const cleanLogin = String(staffName || "").trim() || "Lễ tân";
      const cleanPass = String(passcode || "");
      if (!cleanPass) {
        return { ok: false, code: "MISSING_CREDENTIALS", error: "Vui lòng nhập mật khẩu tài khoản." };
      }
      try {
        // 1. Primary authentication: per-account pgcrypto bcrypt RPC (pms_staff_login)
        const rpcLogin = await rawFetchJson(`${baseUrl}/rest/v1/rpc/pms_staff_login`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${anonKey}` },
          body: { p_login: cleanLogin, p_passcode: cleanPass },
          timeoutMs: 12000
        });
        const rpcNotInstalled = !rpcLogin.httpOk
          && !(rpcLogin.data && rpcLogin.data.ok === false && rpcLogin.data.code && rpcLogin.data.code !== "PGRST202" && rpcLogin.data.code !== "42501");

        if (!rpcNotInstalled) {
          staffAuthAvailable = true;
          if (!rpcLogin.httpOk || !rpcLogin.data || !rpcLogin.data.ok) {
            return {
              ok: false,
              code: (rpcLogin.data && rpcLogin.data.code) || "INVALID_CREDENTIALS",
              error: (rpcLogin.data && (rpcLogin.data.error || rpcLogin.data.message)) || "Sai tên đăng nhập hoặc mật khẩu."
            };
          }
          const u = rpcLogin.data.user || {};
          saveStoredSession({
            authMode: "staff_session",
            sessionToken: rpcLogin.data.sessionToken,
            expires_at: Number(rpcLogin.data.expiresAt) || (Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60),
            accountId: u.id || "",
            username: u.username || cleanLogin,
            staffName: u.staffName || cleanLogin,
            role: Core.normalizeRole(u.role)
          });
          const pulled = await pullLatestFromCloud({ type: "auth_login", force: true });
          if (!pulled.ok) {
            return { ok: false, code: pulled.code, error: pulled.error };
          }
          connectRealtime();
          emit({ type: "auth_login", auth: getAuthState(), state: getSnapshot(), status: getStatus() });
          return { ok: true, user: getAuthState().user, bookings: stateCache.bookings };
        }

        // 2. Fallback ONLY when Supabase SQL upgrade (v1.4.2) has not been executed yet
        staffAuthAvailable = false;
        let res = await rawFetchJson(`${baseUrl}/auth/v1/token?grant_type=password`, {
          method: "POST",
          body: { email: hotelEmail, password: cleanPass },
          timeoutMs: 12000
        });
        if ((!res.httpOk || !res.data || !res.data.access_token) && /^[a-z0-9._-]{3,60}$/i.test(cleanLogin)) {
          const emailDomain = hotelEmail.includes("@") ? hotelEmail.split("@")[1] : "dongvanhotel.vn";
          res = await rawFetchJson(`${baseUrl}/auth/v1/token?grant_type=password`, {
            method: "POST",
            body: { email: `${cleanLogin.toLowerCase()}@${emailDomain}`, password: cleanPass },
            timeoutMs: 12000
          });
        }
        if (!res.httpOk || !res.data || !res.data.access_token) {
          const hint = cleanPass.length < 6
            ? "Mật khẩu riêng (4 ký tự) cần chạy 1 lần file supabase/schema.sql trong Supabase → SQL Editor. Nếu chưa chạy SQL, hãy tạm nhập mật khẩu khách sạn Supabase."
            : "Sai mật khẩu khách sạn (hoặc tài khoản chưa được tạo trên Supabase).";
          return { ok: false, code: "INVALID_CREDENTIALS", error: hint };
        }
        const isSuper = cleanLogin.toLowerCase() === Core.SUPER_ADMIN_USERNAME
          || cleanLogin.toLowerCase() === Core.SUPER_ADMIN_DISPLAY_NAME.toLowerCase();
        saveStoredSession({
          access_token: res.data.access_token,
          refresh_token: res.data.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + (Number(res.data.expires_in) || 3600),
          username: isSuper ? Core.SUPER_ADMIN_USERNAME : cleanLogin,
          staffName: isSuper ? Core.SUPER_ADMIN_DISPLAY_NAME : cleanLogin,
          role: isSuper ? "super_admin" : ""
        });
        const pulled = await pullLatestFromCloud({ type: "auth_login", force: true });
        if (!pulled.ok) {
          return { ok: false, code: pulled.code, error: pulled.error };
        }
        const matched = findSessionAccount();
        if (matched && !matched.active) {
          saveStoredSession(null);
          connectionStatus = "auth_required";
          return { ok: false, code: "ACCOUNT_LOCKED", error: "Tài khoản này đã bị Tổng quản lý chặn truy cập." };
        }
        if (matched && session) {
          saveStoredSession({
            ...session,
            accountId: matched.id,
            username: matched.username,
            staffName: matched.staffName,
            role: Core.normalizeRole(matched.role)
          });
        }
        connectRealtime();
        emit({ type: "auth_login", auth: getAuthState(), state: getSnapshot(), status: getStatus() });
        return { ok: true, user: getAuthState().user, bookings: stateCache.bookings };
      } catch {
        return { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Không kết nối được tới Supabase để đăng nhập." };
      }
    }

    async function logout() {
      const wasStaff = isStaffSession();
      const staffTok = session && session.sessionToken;
      const jwtTok = session && session.access_token;
      closeRealtime();
      if (wasStaff && staffTok) {
        try {
          await rawFetchJson(`${baseUrl}/rest/v1/rpc/pms_staff_logout`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${anonKey}` },
            body: { p_session_token: staffTok },
            timeoutMs: 5000
          });
        } catch {}
      } else if (jwtTok) {
        try {
          await rawFetchJson(`${baseUrl}/auth/v1/logout`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${jwtTok}` },
            body: {},
            timeoutMs: 5000
          });
        } catch {}
      }
      saveStoredSession(null);
      stateCache = {
        bookings: [],
        auditLogs: [],
        autoBackups: [],
        hasRollbackBackup: false,
        operatingCosts: Core.createDefaultOperatingCostsState(),
        financeState: null,
        enterpriseGlState: null,
        housekeepingTasks: [],
        maintenanceIssues: [],
        roomStatuses: Core.computeAllRoomOperationalStatuses([], [], Core.getTodayISO()),
        accounts: ensureSuperAdminAccounts([])
      };
      storeVersion = 0;
      lastOperatingCostsUpdatedAt = "";
      lastFinanceUpdatedAt = "";
      lastFinanceLedgerVersion = -1;
      financeLoadState = "loading";
      financeLoadError = "";
      lastHousekeepingUpdatedAt = "";
      lastIssuesUpdatedAt = "";
      lastAccountsUpdatedAt = "";
      connectionStatus = "auth_required";
      await fetchPublicAccounts();
      emit({ type: "auth_required", auth: getAuthState(), state: getSnapshot(), status: getStatus() });
      return { ok: true };
    }

    async function saveBooking(payload, opts = {}) {
      const existing = payload && payload.id
        ? stateCache.bookings.find((b) => b.id === payload.id) || null
        : null;
      const sanitized = Core.sanitizeBookingRecord({ ...payload, idempotencyKey: opts.idempotencyKey }, existing);
      if (!sanitized.ok) {
        return { ok: false, code: "VALIDATION_ERROR", error: sanitized.error };
      }
      const rec = sanitized.record;
      const room = Core.getRoomById(rec.roomId);
      const summary = `${existing ? "Cập nhật" : "Đặt mới"} P.${room ? room.name : rec.roomId} (${Core.formatDateVN(rec.checkin)} → ${Core.formatDateVN(rec.checkout)}) — ${rec.guestName}${rec.confirmedBy ? ` • XN: ${rec.confirmedBy}` : ""}`;
      const changes = existing ? Core.diffBookingChanges(existing, rec) : [];

      const rpcRes = await callRpc("pms_save_booking", {
        p_booking: payload && payload.id ? rec : { ...rec, id: undefined },
        p_expected_revision: opts.expectedRevision !== undefined ? Number(opts.expectedRevision) : null,
        p_idempotency_key: opts.idempotencyKey || null,
        p_actor_name: (session && session.staffName) || "",
        p_audit_summary: summary,
        p_audit_changes: changes
      });
      if (!rpcRes || !rpcRes.ok) {
        if (rpcRes && (rpcRes.code === "CONFLICT_STALE_EDIT" || rpcRes.code === "CONFLICT_OVERBOOKING")) {
          await pullLatestFromCloud({ type: "conflict_refresh" });
        }
        return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Lưu thất bại." };
      }
      // Instant local commit application + <80ms peer broadcast (ZERO extra pms_get_state round-trip!)
      if (Array.isArray(rpcRes.bookings)) {
        applyMutationCommit(rpcRes, { action: rpcRes.isUpdate ? "UPDATE" : "CREATE" });
      } else {
        await pullLatestFromCloud({ type: "local_commit" });
      }
      return { ...rpcRes, bookings: stateCache.bookings };
    }

    async function deleteBooking(bookingId, opts = {}) {
      const target = stateCache.bookings.find((b) => b.id === bookingId);
      const room = target ? Core.getRoomById(target.roomId) : null;
      const summary = target
        ? `Xóa đặt phòng P.${room ? room.name : target.roomId} (${Core.formatDateVN(target.checkin)} → ${Core.formatDateVN(target.checkout)}) — ${target.guestName}`
        : `Xóa đặt phòng ${bookingId}`;

      const rpcRes = await callRpc("pms_delete_booking", {
        p_booking_id: bookingId,
        p_expected_revision: opts.expectedRevision !== undefined ? Number(opts.expectedRevision) : null,
        p_actor_name: (session && session.staffName) || "",
        p_audit_summary: summary
      });
      if (!rpcRes || !rpcRes.ok) {
        if (rpcRes && (rpcRes.code === "CONFLICT_STALE_EDIT" || rpcRes.code === "NOT_FOUND")) {
          await pullLatestFromCloud({ type: "conflict_refresh" });
        }
        return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Xóa thất bại." };
      }
      if (Array.isArray(rpcRes.bookings)) {
        applyMutationCommit(rpcRes, {
          action: "DELETE",
          deletedId: bookingId,
          roomId: target ? target.roomId : "",
          guestName: target ? target.guestName : ""
        });
      } else {
        await pullLatestFromCloud({ type: "local_commit" });
      }
      return { ...rpcRes, bookings: stateCache.bookings };
    }

    async function inspectImportPreview(rawPayload) {
      const inspected = Core.inspectBackupPayload(rawPayload);
      if (!inspected.ok) {
        return { ok: false, code: inspected.code || "INVALID_IMPORT", error: inspected.error, details: inspected.details };
      }
      return {
        ok: true,
        version: inspected.version,
        schema: inspected.schema,
        exportedAt: inspected.exportedAt,
        source: inspected.source,
        hotel: inspected.hotel,
        hasBookings: inspected.hasBookings,
        hasFinanceState: inspected.hasFinanceState,
        hasOperatingCosts: inspected.hasOperatingCosts,
        hasHousekeepingTasks: inspected.hasHousekeepingTasks,
        hasMaintenanceIssues: inspected.hasMaintenanceIssues,
        hasAuditLogs: inspected.hasAuditLogs,
        isLegacyWithoutFinance: inspected.isLegacyWithoutFinance,
        presentSections: inspected.presentSections,
        missingSections: inspected.missingSections,
        warnings: inspected.warnings,
        summary: inspected.summary,
        mediaInventory: inspected.mediaInventory
      };
    }

    async function exportUnifiedBackup(meta = {}) {
      if (!can("admin:backup")) return { ok: false, status: 403, code: "FORBIDDEN", error: "Chức năng sao lưu chỉ dành cho Quản lý." };
      const owner = session && (session.sessionToken || session.access_token);
      const snapshot = await callRpc("pms_control_get_state", {});
      if (!snapshot || !snapshot.ok) return snapshot || { ok: false, error: "Không đọc được dữ liệu máy chủ." };
      if (!session || owner !== (session.sessionToken || session.access_token) || !can("admin:backup") ||
          !snapshot.user || !Core.hasPermission(snapshot.user.role, "admin:backup")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Phiên đăng nhập hoặc quyền sao lưu đã thay đổi." };
      }
      try {
        const backup = Core.buildUnifiedBackupPayload(snapshot, { ...meta, exportedBy: snapshot.user.staffName });
        return { ok: true, backup };
      } catch (err) {
        return { ok: false, code: "INVALID_BACKUP_STATE", error: err.message };
      }
    }

    async function restoreFromImport(rawPayload) {
      if (!can("admin:restore")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Chức năng khôi phục dữ liệu chỉ dành cho Quản lý." };
      }
      const inspected = Core.inspectBackupPayload(rawPayload);
      if (!inspected.ok) {
        return { ok: false, code: inspected.code || "INVALID_IMPORT", error: inspected.error, details: inspected.details };
      }
      const preExisting = {
        bookings: stateCache.bookings.slice(),
        financeState: stateCache.financeState ? Core.sanitizeFinanceState(stateCache.financeState) : null,
        operatingCosts: stateCache.operatingCosts,
        enterpriseGlState: stateCache.enterpriseGlState
      };

      // Construct atomic RPC payload containing ONLY explicitly present sections (omitted v3/v5 sections stay untouched on server!)
      const backupForRpc = {
        version: inspected.version,
        bookings: inspected.sanitized.bookings
      };
      if (inspected.hasFinanceState && inspected.sanitized.financeState) {
        backupForRpc.financeState = inspected.rawFinanceState;
      }
      if (inspected.hasOperatingCosts && inspected.sanitized.operatingCosts) {
        backupForRpc.operatingCosts = inspected.sanitized.operatingCosts;
      }
      if (inspected.hasEnterpriseGlState && inspected.sanitized.enterpriseGlState) {
        backupForRpc.enterpriseGlState = inspected.sanitized.enterpriseGlState;
      }
      if (inspected.hasHousekeepingTasks && inspected.sanitized.housekeepingTasks) {
        backupForRpc.housekeepingTasks = inspected.sanitized.housekeepingTasks;
      }
      if (inspected.hasMaintenanceIssues && inspected.sanitized.maintenanceIssues) {
        backupForRpc.maintenanceIssues = inspected.sanitized.maintenanceIssues;
      }

      const rpcRes = await callRpc("pms_control_restore", {
        p_backup: backupForRpc,
        p_actor_name: (session && session.staffName) || ""
      });
      if (!rpcRes || !rpcRes.ok) {
        return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Khôi phục dữ liệu thất bại." };
      }

      // Read back persisted state directly from authoritative server BEFORE declaring success
      const readBack = await pullLatestFromCloud({ type: "local_commit", force: true });
      if (!readBack || !readBack.ok || financeLoadState !== "loaded" || !stateCache.financeState) {
        return {
          ok: false,
          code: "READBACK_FAILED",
          error: "Máy chủ đã nhận lệnh khôi phục nhưng chưa đọc lại được để đối soát số dư. Vui lòng tải lại trang kiểm tra."
        };
      }
      const actualState = {
        bookings: stateCache.bookings,
        financeState: stateCache.financeState,
        operatingCosts: stateCache.operatingCosts,
        enterpriseGlState: stateCache.enterpriseGlState,
        housekeepingTasks: stateCache.housekeepingTasks,
        maintenanceIssues: stateCache.maintenanceIssues
      };
      // The restore RPC returns the ledger captured under the database lock.
      const committedBaseline = {
        ...preExisting,
        ...(!inspected.hasFinanceState && rpcRes.financeState ? { financeState: rpcRes.financeState } : {}),
        ...(!inspected.hasEnterpriseGlState && rpcRes.enterpriseGlState ? { enterpriseGlState: rpcRes.enterpriseGlState } : {})
      };
      const verification = Core.verifyRestoredState(inspected, actualState, committedBaseline);
      if (!verification.ok) {
        return {
          ok: false,
          code: "VERIFY_MISMATCH",
          error: "Đối soát sau khôi phục phát hiện sai lệch: " + verification.diffs.map((d) => `${d.label} (lệch ${d.diff})`).join("; "),
          verification
        };
      }

      broadcastDeltaToPeers({ senderId: clientId, storeVersion, action: "RESTORE", bulkReplace: true, actor: (session && session.staffName) || "", ts: lastSyncedAt });
      broadcastDeltaToPeers({ senderId: clientId, storeVersion, action: "FINANCE_CHANGED", ledgerVersion: lastFinanceLedgerVersion, actor: (session && session.staffName) || "", ts: lastSyncedAt });

      return {
        ...rpcRes,
        ok: true,
        bookings: stateCache.bookings,
        financeState: getFinanceStateForCurrentRole(),
        operatingCosts: stateCache.operatingCosts,
        housekeepingTasks: stateCache.housekeepingTasks,
        maintenanceIssues: stateCache.maintenanceIssues,
        restoredSections: inspected.presentSections.slice(),
        preservedSections: inspected.missingSections.slice(),
        mediaInventory: inspected.mediaInventory,
        verification
      };
    }

    async function rollbackLastChange() {
      const rpcRes = await callRpc("pms_rollback_last", {
        p_actor_name: (session && session.staffName) || ""
      });
      if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Hoàn tác thất bại." };
      await pullLatestFromCloud({ type: "local_commit", force: true });
      broadcastDeltaToPeers({ senderId: clientId, storeVersion, action: "ROLLBACK", bulkReplace: true, actor: (session && session.staffName) || "", ts: lastSyncedAt });
      broadcastDeltaToPeers({ senderId: clientId, storeVersion, action: "FINANCE_CHANGED", ledgerVersion: lastFinanceLedgerVersion, actor: (session && session.staffName) || "", ts: lastSyncedAt });
      return {
        ...rpcRes,
        bookings: stateCache.bookings,
        financeState: getFinanceStateForCurrentRole(),
        operatingCosts: stateCache.operatingCosts
      };
    }

    async function restoreFromAutoBackup(snapshotId) {
      const rpcRes = await callRpc("pms_restore_autobackup", {
        p_snapshot_id: snapshotId,
        p_actor_name: (session && session.staffName) || ""
      });
      if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Khôi phục mốc sao lưu thất bại." };
      applyMutationCommit(rpcRes, { action: "AUTOBACKUP_RESTORE", bulkReplace: true });
      pullLatestFromCloud({ type: "local_commit" });
      return { ...rpcRes, bookings: stateCache.bookings };
    }

    async function resetToSample(baseDateISO) {
      const sample = Core.createSampleBookings(baseDateISO);
      Core.normalizeDormSlots(sample);
      const rpcRes = await callRpc("pms_replace_all", {
        p_bookings: sample,
        p_action: "RESET_SAMPLE",
        p_summary: "Khôi phục danh sách đặt phòng mẫu.",
        p_actor_name: (session && session.staffName) || ""
      });
      if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Khôi phục mẫu thất bại." };
      applyMutationCommit(rpcRes, { action: "RESET_SAMPLE", bulkReplace: true });
      pullLatestFromCloud({ type: "local_commit" });
      return { ...rpcRes, bookings: stateCache.bookings };
    }

    async function saveOperatingCosts(nextState) {
      if (navigator.onLine === false) {
        return { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Đang mất kết nối mạng — không thể lưu chi phí vận hành." };
      }
      if (!can("costs:write")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Tài khoản của bạn không có quyền chỉnh sửa chi phí vận hành." };
      }
      const clean = Core.sanitizeOperatingCostsState(nextState);
      clean.updatedAt = new Date().toISOString();

      if (isStaffSession()) {
        const rpcRes = await callRpc("pms_save_meta", { p_key: "operating_costs_v1", p_value: clean });
        if (!rpcRes || !rpcRes.ok) {
          return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Không thể lưu chi phí vận hành lên Supabase." };
        }
        stateCache.operatingCosts = clean;
        lastOperatingCostsUpdatedAt = clean.updatedAt;
        lastSyncedAt = clean.updatedAt;
        connectionStatus = "connected";
        emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        broadcastDeltaToPeers({
          senderId: clientId,
          storeVersion,
          action: "COSTS_UPDATE",
          operatingCosts: clean,
          actor: (session && session.staffName) || "",
          ts: clean.updatedAt
        });
        return { ok: true, operatingCosts: clean };
      }

      const token = await ensureValidAccessToken(false);
      if (!token) {
        return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "Vui lòng đăng nhập để lưu chi phí vận hành." };
      }
      try {
        const res = await rawFetchJson(`${baseUrl}/rest/v1/pms_meta?on_conflict=key`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Prefer": "resolution=merge-duplicates,return=representation"
          },
          body: {
            key: "operating_costs_v1",
            value: clean,
            updated_at: clean.updatedAt
          },
          timeoutMs: 10000
        });
        if (res.status === 401) {
          handleAuthExpired("Phiên đăng nhập hết hạn khi lưu chi phí.");
          return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "Phiên đăng nhập đã hết hạn." };
        }
        if (!res.httpOk) {
          return { ok: false, code: "SERVER_ERROR", error: "Không thể lưu chi phí vận hành lên Supabase." };
        }
        stateCache.operatingCosts = clean;
        lastOperatingCostsUpdatedAt = clean.updatedAt;
        lastSyncedAt = clean.updatedAt;
        connectionStatus = "connected";
        emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        broadcastDeltaToPeers({
          senderId: clientId,
          storeVersion,
          action: "COSTS_UPDATE",
          operatingCosts: clean,
          actor: (session && session.staffName) || "",
          ts: clean.updatedAt
        });
        return { ok: true, operatingCosts: clean };
      } catch {
        return { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Mất kết nối khi lưu chi phí vận hành." };
      }
    }

    async function upsertPmsMetaKey(key, valueObj, broadcastAction) {
      if (navigator.onLine === false) {
        return { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Đang mất kết nối mạng — không thể lưu dữ liệu." };
      }
      const updatedAt = (valueObj && valueObj.updatedAt) || new Date().toISOString();

      if (isStaffSession()) {
        const rpcRes = await callRpc("pms_save_meta", { p_key: key, p_value: valueObj });
        if (!rpcRes || !rpcRes.ok) {
          return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Không thể lưu dữ liệu lên Supabase." };
        }
        if (key === "housekeeping_v1") lastHousekeepingUpdatedAt = updatedAt;
        if (key === "issues_v1") lastIssuesUpdatedAt = updatedAt;
        lastSyncedAt = updatedAt;
        connectionStatus = "connected";
        stateCache.roomStatuses = Core.computeAllRoomOperationalStatuses(stateCache.housekeepingTasks, stateCache.maintenanceIssues, Core.getTodayISO());
        emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        broadcastDeltaToPeers({
          senderId: clientId,
          storeVersion,
          action: broadcastAction,
          actor: (session && session.staffName) || "",
          ts: updatedAt
        });
        return { ok: true, updatedAt };
      }

      const token = await ensureValidAccessToken(false);
      if (!token) {
        return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "Vui lòng đăng nhập lại." };
      }
      try {
        const res = await rawFetchJson(`${baseUrl}/rest/v1/pms_meta?on_conflict=key`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Prefer": "resolution=merge-duplicates,return=representation"
          },
          body: { key, value: valueObj, updated_at: updatedAt },
          timeoutMs: 12000
        });
        if (res.status === 401) {
          handleAuthExpired("Phiên đăng nhập hết hạn.");
          return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "Phiên đăng nhập đã hết hạn." };
        }
        if (!res.httpOk) {
          return { ok: false, code: "SERVER_ERROR", error: "Không thể lưu dữ liệu lên Supabase." };
        }
        lastSyncedAt = updatedAt;
        connectionStatus = "connected";
        stateCache.roomStatuses = Core.computeAllRoomOperationalStatuses(stateCache.housekeepingTasks, stateCache.maintenanceIssues, Core.getTodayISO());
        emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        broadcastDeltaToPeers({
          senderId: clientId,
          storeVersion,
          action: broadcastAction,
          actor: (session && session.staffName) || "",
          ts: updatedAt
        });
        return { ok: true, updatedAt };
      } catch {
        return { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Mất kết nối khi lưu lên Supabase." };
      }
    }

    async function checkoutBooking(bookingId, opts = {}) {
      if (!can("bookings:checkout")) return { ok: false, status: 403, code: "FORBIDDEN", error: "Tài khoản không có quyền check-out." };
      const target = stateCache.bookings.find((b) => b.id === bookingId);
      if (!target) return { ok: false, code: "NOT_FOUND", error: "Không tìm thấy đặt phòng." };
      const actor = (session && session.staffName) || "Lễ tân";
      if(target.ops24?.stay==="inhouse"){
        const res=await callRpc("pms_ops24_apply",{p_body:{kind:"depart",booking:target.id,day:Core.getVietnamTodayISO()},p_version:storeVersion,p_request:"depart-"+target.id});
        if(res?.ok)await pullLatestFromCloud({type:"local_commit",force:true});
        return res;
      }
      const idemKey = `checkout:${target.id}`;
      const existingTask = stateCache.housekeepingTasks.find((t) => t.idempotencyKey === idemKey);
      let updatedBooking = target;
      if (!target.checkedOutAt) {
        const saveRes = await saveBooking({ ...target, checkedOutAt: new Date().toISOString(), checkedOutBy: actor }, { expectedRevision: target.revision });
        if (!saveRes || !saveRes.ok) return saveRes;
        updatedBooking = saveRes.booking || target;
      }
      if (existingTask) {
        return { ok: true, idempotentHit: true, booking: updatedBooking, task: existingTask, bookings: stateCache.bookings, housekeepingTasks: stateCache.housekeepingTasks };
      }
      const newTask = Core.sanitizeHousekeepingTask({
        roomId: target.roomId,
        taskType: "checkout",
        status: "dirty",
        serviceDate: (opts && opts.serviceDate) || Core.getTodayISO(),
        sourceBookingId: target.id,
        idempotencyKey: idemKey,
        note: Core.buildCheckoutHousekeepingNote(target),
        createdBy: actor
      });
      const nextTasks = [newTask, ...stateCache.housekeepingTasks];
      stateCache.housekeepingTasks = nextTasks;
      const metaRes = await upsertPmsMetaKey("housekeeping_v1", { tasks: nextTasks, updatedAt: new Date().toISOString() }, "CHECKOUT");
      if (!metaRes.ok) return metaRes;
      return { ok: true, idempotentHit: false, booking: updatedBooking, task: newTask, bookings: stateCache.bookings, housekeepingTasks: nextTasks };
    }

    async function createHousekeepingTask(payload) {
      if (!can("housekeeping:create")) return { ok: false, status: 403, code: "FORBIDDEN", error: "Không có quyền tạo yêu cầu dọn phòng." };
      const actor = (session && session.staffName) || "Lễ tân";
      const task = Core.sanitizeHousekeepingTask({ ...payload, status: "dirty", createdBy: actor });
      if (!task) return { ok: false, error: "Thông tin phòng không hợp lệ." };
      const nextTasks = [task, ...stateCache.housekeepingTasks];
      stateCache.housekeepingTasks = nextTasks;
      const metaRes = await upsertPmsMetaKey("housekeeping_v1", { tasks: nextTasks, updatedAt: new Date().toISOString() }, "HK_TASK_CREATE");
      return metaRes.ok ? { ok: true, task, housekeepingTasks: nextTasks } : metaRes;
    }

    async function startHousekeepingTask(taskId) {
      if (!can("housekeeping:execute")) return { ok: false, status: 403, code: "FORBIDDEN", error: "Không có quyền thực hiện dọn phòng." };
      const idx = stateCache.housekeepingTasks.findIndex((t) => t.id === taskId);
      if (idx < 0) return { ok: false, error: "Không tìm thấy công việc." };
      const actor = (session && session.staffName) || "Buồng phòng";
      const nowIso = new Date().toISOString();
      const updated = { ...stateCache.housekeepingTasks[idx], status: "in_progress", startedBy: stateCache.housekeepingTasks[idx].startedBy || actor, startedAt: stateCache.housekeepingTasks[idx].startedAt || nowIso, updatedAt: nowIso };
      const nextTasks = stateCache.housekeepingTasks.slice();
      nextTasks[idx] = updated;
      stateCache.housekeepingTasks = nextTasks;
      const metaRes = await upsertPmsMetaKey("housekeeping_v1", { tasks: nextTasks, updatedAt: nowIso }, "HK_TASK_START");
      return metaRes.ok ? { ok: true, task: updated, housekeepingTasks: nextTasks } : metaRes;
    }

    async function uploadPhoto(dataUrl, kind = "housekeeping") {
      if (navigator.onLine === false) {
        return { ok: false, offline: true, error: "Đang mất mạng — chưa tải được ảnh." };
      }
      if (!String(dataUrl || "").startsWith("data:image/")) {
        return { ok: false, error: "Dữ liệu ảnh không hợp lệ." };
      }
      const photo = Core.sanitizePhotoRef({
        id: `ph_sb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        url: dataUrl,
        uploadedBy: (session && session.staffName) || "Nhân viên",
        uploadedAt: new Date().toISOString()
      });
      return { ok: true, photo };
    }

    async function completeHousekeepingTask(taskId, { photos = [], note = "" } = {}) {
      if (!can("housekeeping:execute")) return { ok: false, status: 403, code: "FORBIDDEN", error: "Không có quyền hoàn tất dọn phòng." };
      const idx = stateCache.housekeepingTasks.findIndex((t) => t.id === taskId);
      if (idx < 0) return { ok: false, error: "Không tìm thấy công việc." };
      const cleanPhotos = Core.sanitizePhotoList(photos);
      if (cleanPhotos.length === 0) return { ok: false, code: "PHOTO_REQUIRED", error: "Cần ít nhất 1 ảnh chụp sau khi dọn." };
      const actor = (session && session.staffName) || "Buồng phòng";
      const nowIso = new Date().toISOString();
      const updated = { ...stateCache.housekeepingTasks[idx], status: "cleaned", completedBy: actor, completedAt: nowIso, photos: cleanPhotos, note: note || stateCache.housekeepingTasks[idx].note, updatedAt: nowIso };
      const nextTasks = stateCache.housekeepingTasks.slice();
      nextTasks[idx] = updated;
      stateCache.housekeepingTasks = nextTasks;
      const metaRes = await upsertPmsMetaKey("housekeeping_v1", { tasks: nextTasks, updatedAt: nowIso }, "HK_TASK_COMPLETE");
      return metaRes.ok ? { ok: true, task: updated, housekeepingTasks: nextTasks } : metaRes;
    }

    async function reportMaintenanceIssue(payload) {
      if (!can("issues:create")) return { ok: false, status: 403, code: "FORBIDDEN", error: "Không có quyền báo sự cố." };
      const actor = (session && session.staffName) || "Nhân viên";
      const issue = Core.sanitizeMaintenanceIssue({ ...payload, reportedBy: actor });
      if (!issue) return { ok: false, error: "Vui lòng nhập đầy đủ số phòng và mô tả sự cố." };
      const nextIssues = [issue, ...stateCache.maintenanceIssues];
      stateCache.maintenanceIssues = nextIssues;
      const metaRes = await upsertPmsMetaKey("issues_v1", { issues: nextIssues, updatedAt: new Date().toISOString() }, "ISSUE_CREATE");
      return metaRes.ok ? { ok: true, issue, maintenanceIssues: nextIssues } : metaRes;
    }

    async function updateMaintenanceIssue(issueId, patch) {
      if (!can("issues:manage")) return { ok: false, status: 403, code: "FORBIDDEN", error: "Không có quyền xử lý sự cố." };
      const idx = stateCache.maintenanceIssues.findIndex((i) => i.id === issueId);
      if (idx < 0) return { ok: false, error: "Không tìm thấy sự cố." };
      const actor = (session && session.staffName) || "Quản lý";
      const nowIso = new Date().toISOString();
      const nextStatus = Core.ISSUE_STATUSES[patch.status] ? patch.status : stateCache.maintenanceIssues[idx].status;
      const updated = { ...stateCache.maintenanceIssues[idx], ...patch, status: nextStatus, resolvedBy: nextStatus === "resolved" ? actor : "", resolvedAt: nextStatus === "resolved" ? nowIso : "", updatedAt: nowIso };
      const nextIssues = stateCache.maintenanceIssues.slice();
      nextIssues[idx] = updated;
      stateCache.maintenanceIssues = nextIssues;
      const metaRes = await upsertPmsMetaKey("issues_v1", { issues: nextIssues, updatedAt: nowIso }, "ISSUE_UPDATE");
      return metaRes.ok ? { ok: true, issue: updated, maintenanceIssues: nextIssues } : metaRes;
    }

    async function listAccounts() {
      if (!can("accounts:manage")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Chỉ Tổng quản lý mới có quyền xem và quản trị tài khoản." };
      }
      if (isStaffSession()) {
        const rpcRes = await callRpc("pms_list_accounts", {});
        if (!rpcRes || !rpcRes.ok) {
          return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Không tải được danh sách tài khoản." };
        }
        stateCache.accounts = ensureSuperAdminAccounts(rpcRes.accounts || []);
        return { ok: true, accounts: stateCache.accounts };
      }
      return { ok: true, accounts: stateCache.accounts };
    }

    async function persistCloudAccounts(nextAccounts, revokedAccountId = "") {
      const normalized = ensureSuperAdminAccounts(nextAccounts);
      const nowIso = new Date().toISOString();
      const metaRes = await upsertPmsMetaKey("staff_accounts_v1", { accounts: normalized, updatedAt: nowIso }, "ACCOUNTS_UPDATE");
      if (!metaRes.ok) return metaRes;
      stateCache.accounts = normalized;
      lastAccountsUpdatedAt = nowIso;
      broadcastDeltaToPeers({
        senderId: clientId,
        storeVersion,
        action: "ACCOUNTS_UPDATE",
        accounts: normalized,
        revokedAccountId: revokedAccountId || undefined,
        actor: (session && session.staffName) || "",
        ts: nowIso
      });
      return { ok: true, accounts: normalized };
    }

    async function createAccount(payload) {
      if (!can("accounts:create")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Chỉ Tổng quản lý mới có quyền cấp tài khoản mới." };
      }
      if (isStaffSession()) {
        const rpcRes = await callRpc("pms_create_account", {
          p_username: String((payload && payload.username) || "").trim(),
          p_staff_name: String((payload && payload.staffName) || "").trim(),
          p_role: String((payload && payload.role) || "reception").trim(),
          p_passcode: String((payload && payload.passcode) || "").trim()
        });
        if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, error: "Không thể tạo tài khoản mới." };
        if (Array.isArray(rpcRes.accounts)) {
          stateCache.accounts = ensureSuperAdminAccounts(rpcRes.accounts);
        }
        const nowIso = new Date().toISOString();
        lastAccountsUpdatedAt = nowIso;
        await fetchPublicAccounts();
        emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        broadcastDeltaToPeers({
          senderId: clientId,
          storeVersion,
          action: "ACCOUNTS_UPDATE",
          accounts: stateCache.accounts,
          actor: (session && session.staffName) || "",
          ts: nowIso
        });
        return { ...rpcRes, accounts: stateCache.accounts };
      }

      const cleanUser = Core.sanitizeText(payload && payload.username, 60).toLowerCase().replace(/\s+/g, "");
      const cleanName = Core.sanitizeText(payload && payload.staffName, 80);
      const normRole = Core.normalizeRole(payload && payload.role);
      const rawPass = String((payload && payload.passcode) || "").trim();
      if (!cleanUser || !/^[a-z0-9._-]{3,60}$/.test(cleanUser)) {
        return { ok: false, code: "INVALID_USERNAME", error: "Tên đăng nhập phải từ 3–60 ký tự (chữ không dấu, số, ., _, -)." };
      }
      if (!cleanName) return { ok: false, code: "INVALID_NAME", error: "Vui lòng nhập họ tên nhân viên." };
      if (rawPass.length < 4) return { ok: false, code: "WEAK_PASSWORD", error: "Mật khẩu phải có ít nhất 4 ký tự." };
      if (normRole === "super_admin") {
        return { ok: false, code: "SUPER_ADMIN_UNIQUE", error: "Hệ thống chỉ cho phép duy nhất 1 tài khoản Tổng quản lý." };
      }
      if (stateCache.accounts.some((a) => a.username.toLowerCase() === cleanUser)) {
        return { ok: false, code: "DUPLICATE_USERNAME", error: `Tên đăng nhập "${cleanUser}" đã tồn tại.` };
      }
      const nowIso = new Date().toISOString();
      const newAcc = {
        id: `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        username: cleanUser,
        staffName: cleanName,
        role: normRole,
        active: true,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      const saved = await persistCloudAccounts([...stateCache.accounts, newAcc]);
      return saved.ok ? { ok: true, account: newAcc, accounts: saved.accounts } : saved;
    }

    async function updateAccount(accountId, patch) {
      if (!can("accounts:manage")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Chỉ Tổng quản lý mới có quyền chỉnh sửa tài khoản." };
      }
      if (isStaffSession()) {
        const rpcRes = await callRpc("pms_update_account", {
          p_account_id: accountId,
          p_staff_name: patch && patch.staffName !== undefined ? String(patch.staffName) : null,
          p_role: patch && patch.role !== undefined ? String(patch.role) : null,
          p_active: patch && patch.active !== undefined ? Boolean(patch.active) : null,
          p_passcode: patch && patch.passcode !== undefined && String(patch.passcode).trim() !== "" ? String(patch.passcode).trim() : null
        });
        if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, error: "Không thể cập nhật tài khoản." };
        if (Array.isArray(rpcRes.accounts)) {
          stateCache.accounts = ensureSuperAdminAccounts(rpcRes.accounts);
        }
        const nowIso = new Date().toISOString();
        lastAccountsUpdatedAt = nowIso;
        await fetchPublicAccounts();
        emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        broadcastDeltaToPeers({
          senderId: clientId,
          storeVersion,
          action: "ACCOUNTS_UPDATE",
          accounts: stateCache.accounts,
          revokedAccountId: (patch && patch.active === false) ? accountId : undefined,
          actor: (session && session.staffName) || "",
          ts: nowIso
        });
        return { ...rpcRes, accounts: stateCache.accounts };
      }

      const idx = stateCache.accounts.findIndex((a) => a.id === accountId);
      if (idx < 0) return { ok: false, code: "NOT_FOUND", error: "Không tìm thấy tài khoản nhân viên." };
      const cur = stateCache.accounts[idx];
      const curRole = Core.normalizeRole(cur.role);
      const nextRole = patch && patch.role !== undefined ? Core.normalizeRole(patch.role) : curRole;
      const nextActive = patch && patch.active !== undefined ? Boolean(patch.active) : Boolean(cur.active);
      if (curRole === "super_admin") {
        if (!nextActive) return { ok: false, code: "SUPER_ADMIN_PROTECTED", error: "Không thể chặn truy cập hoặc khóa tài khoản Tổng quản lý duy nhất." };
        if (nextRole !== "super_admin") return { ok: false, code: "SUPER_ADMIN_PROTECTED", error: "Không thể thay đổi vai trò của tài khoản Tổng quản lý duy nhất." };
      } else if (nextRole === "super_admin") {
        return { ok: false, code: "SUPER_ADMIN_UNIQUE", error: "Hệ thống chỉ cho phép duy nhất 1 tài khoản Tổng quản lý." };
      }
      const nextName = patch && patch.staffName !== undefined ? Core.sanitizeText(patch.staffName, 80) : cur.staffName;
      if (!nextName) return { ok: false, code: "INVALID_NAME", error: "Họ tên nhân viên không được để trống." };
      const updated = {
        ...cur,
        staffName: nextName,
        role: nextRole,
        active: nextActive,
        updatedAt: new Date().toISOString()
      };
      const nextList = stateCache.accounts.slice();
      nextList[idx] = updated;
      const saved = await persistCloudAccounts(nextList, !nextActive ? accountId : "");
      return saved.ok ? { ok: true, account: updated, accounts: saved.accounts } : saved;
    }

    async function deleteAccount(accountId) {
      if (!can("accounts:delete")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Chỉ Tổng quản lý mới có quyền xóa tài khoản." };
      }
      if (isStaffSession()) {
        const rpcRes = await callRpc("pms_delete_account", { p_account_id: accountId });
        if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, error: "Không thể xóa tài khoản." };
        if (Array.isArray(rpcRes.accounts)) {
          stateCache.accounts = ensureSuperAdminAccounts(rpcRes.accounts);
        }
        const nowIso = new Date().toISOString();
        lastAccountsUpdatedAt = nowIso;
        await fetchPublicAccounts();
        emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        broadcastDeltaToPeers({
          senderId: clientId,
          storeVersion,
          action: "ACCOUNTS_UPDATE",
          accounts: stateCache.accounts,
          revokedAccountId: accountId,
          actor: (session && session.staffName) || "",
          ts: nowIso
        });
        return { ...rpcRes, accounts: stateCache.accounts };
      }

      const target = stateCache.accounts.find((a) => a.id === accountId);
      if (!target) return { ok: false, code: "NOT_FOUND", error: "Không tìm thấy tài khoản cần xóa." };
      if (Core.normalizeRole(target.role) === "super_admin") {
        return { ok: false, code: "SUPER_ADMIN_PROTECTED", error: "Không thể xóa tài khoản Tổng quản lý duy nhất." };
      }
      const nextList = stateCache.accounts.filter((a) => a.id !== accountId);
      const saved = await persistCloudAccounts(nextList, accountId);
      return saved.ok ? { ok: true, deleted: target, accounts: saved.accounts } : saved;
    }

    /* -------------------- Persistent Pending Finance Intents (Survives Reload/Offline) -------------------- */

    function intentPrefix() {
      const owner = session && (session.accountId || session.username || session.email);
      return owner ? "dongvan_pms_finance_v2:" + encodeURIComponent(baseUrl) + ":" + encodeURIComponent(owner) + ":" : "";
    }

    function oldFinanceIntents() {
      try {
        const all = JSON.parse(root.localStorage.getItem(PENDING_FINANCE_KEY) || "[]");
        return Array.isArray(all) ? all.filter(item => item && item.idempotencyKey) : [];
      } catch { return []; }
    }

    function readPendingFinanceIntents() {
      const prefix = intentPrefix();
      if (!prefix) return [];
      const entries = new Map();
      // Earlier versions stored a single queue on this browser without an account identifier.
      if (can("admin:backup")) for (const item of oldFinanceIntents()) entries.set(item.idempotencyKey, item);
      try {
        const storage = root.localStorage;
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !key.startsWith(prefix)) continue;
          const item = JSON.parse(storage.getItem(key));
          if (item && item.idempotencyKey) entries.set(item.idempotencyKey, item);
        }
      } catch {}
      return Array.from(entries.values()).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    function notifyPendingIntents() {
      const pendingIntents = readPendingFinanceIntents();
      emit({ type: "pending_finance_intents", pendingIntents, status: getStatus() });
      return pendingIntents;
    }

    function upsertPendingFinanceIntent(intent) {
      const prefix = intentPrefix();
      if (prefix && intent && intent.idempotencyKey) {
        try { root.localStorage.setItem(prefix + intent.idempotencyKey, JSON.stringify(intent)); } catch {}
      }
      return notifyPendingIntents();
    }

    function removePendingFinanceIntent(key) {
      const prefix = intentPrefix();
      if (!prefix) return [];
      try {
        root.localStorage.removeItem(prefix + key);
        if (can("admin:backup")) {
          const old = oldFinanceIntents();
          if (old.some(item => item.idempotencyKey === key)) {
            root.localStorage.setItem(PENDING_FINANCE_KEY, JSON.stringify(old.filter(item => item.idempotencyKey !== key)));
          }
        }
      } catch {}
      return notifyPendingIntents();
    }

    function acceptsFinanceResponse(result) {
      return result && result.financeState && Array.isArray(result.financeState.transactions)
        && Number(result.financeState.ledgerVersion || 0) >= lastFinanceLedgerVersion
        && (typeof result.storeVersion !== "number" || result.storeVersion >= storeVersion);
    }

    function applyFinanceRpcResult(rpcRes, actionName) {
      if (!rpcRes || typeof rpcRes !== "object") return;
      if (acceptsFinanceResponse(rpcRes)) {
        stateCache.financeState = Core.sanitizeFinanceState({...rpcRes.financeState,controlsV23:stateCache.financeState?.controlsV23});
        lastFinanceUpdatedAt = stateCache.financeState.updatedAt || new Date().toISOString();
        lastFinanceLedgerVersion = Number(stateCache.financeState.ledgerVersion) || lastFinanceLedgerVersion;
        financeLoadState = "loaded";
        financeLoadError = "";
      }
      if (Array.isArray(rpcRes.bookings) && typeof rpcRes.storeVersion === "number" && rpcRes.storeVersion >= storeVersion && (!rpcRes.financeState || acceptsFinanceResponse(rpcRes))) {
        Core.normalizeDormSlots(rpcRes.bookings);
        stateCache.bookings = rpcRes.bookings;
      }
      if (typeof rpcRes.storeVersion === "number" && rpcRes.storeVersion > storeVersion) {
        storeVersion = rpcRes.storeVersion;
      }
      lastSyncedAt = new Date().toISOString();
      connectionStatus = "connected";
      emit({
        type: "local_commit",
        remoteEvent: null,
        state: getSnapshot(),
        status: getStatus()
      });
      // SECURITY (v1.9.0): Lightweight notification ONLY — zero financeState blob in peer broadcast!
      if (!rpcRes.idempotentHit) {
        broadcastDeltaToPeers({
          senderId: clientId,
          storeVersion,
          action: "FINANCE_CHANGED",
          subAction: actionName || "FINANCE_OP",
          ledgerVersion: lastFinanceLedgerVersion,
          actor: (session && session.staffName) || "",
          ts: lastSyncedAt
        });
      }
    }

    async function callAuthoritativeFinanceRpc(rpcName, rpcParams, opts = {}) {
      if (financeLoadState !== "loaded" && !opts.allowBeforeLoaded) {
        return {
          ok: false,
          code: "FINANCE_NOT_LOADED",
          error: financeLoadState === "error"
            ? "Không tải được sổ tài chính từ máy chủ — tạm khóa ghi sổ. Vui lòng thử tải lại sổ."
            : "Đang tải sổ tài chính từ máy chủ — vui lòng chờ tải xong trước khi ghi sổ."
        };
      }
      if (navigator.onLine === false) {
        return {
          ok: false,
          offline: true,
          unconfirmed: true,
          code: "NETWORK_OFFLINE",
          error: "Đang mất kết nối mạng — giao dịch CHƯA được xác nhận. Nội dung đang nhập được giữ nguyên."
        };
      }

      const idemKey = opts.idempotencyKey ? Core.sanitizeText(opts.idempotencyKey, 120) : "";
      const intentKind = opts.intentKind || "tx"; // "tx" | "shift"
      let intentRecord = null;
      if (idemKey) {
        intentRecord = {
          idempotencyKey: idemKey,
          kind: intentKind,
          op: opts.op || rpcName,
          rpcName,
          rpcParams,
          label: opts.label || "Giao dịch tài chính",
          amount: Number(opts.amount) || 0,
          status: "verifying",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        upsertPendingFinanceIntent(intentRecord);
        if (!readPendingFinanceIntents().some(x => x.idempotencyKey === idemKey)) {
          return { ok: false, code: "INTENT_NOT_SAVED", error: "Chưa lưu được mã chống trùng trên thiết bị. Giao dịch chưa gửi." };
        }
      }

      const requestScope = intentPrefix();
      const rpcRes = await callRpc(rpcName, rpcParams);
      if (requestScope !== intentPrefix() || (rpcRes && rpcRes.code === "SESSION_CHANGED")) {
        return { ok: false, code: "SESSION_CHANGED", error: "Đã đổi tài khoản. Kiểm tra giao dịch trong phiên ban đầu." };
      }
      if (rpcRes && rpcRes.ok) {
        if (idemKey) removePendingFinanceIntent(idemKey);
        applyFinanceRpcResult(rpcRes, opts.op || rpcName);
        return {
          ...rpcRes,
          financeState: getFinanceStateForCurrentRole(),
          bookings: stateCache.bookings
        };
      }

      // Deterministic server rejection (400/403/404/409) — NOT ambiguous, clear pending intent & sync fresh state if returned
      if (rpcRes && !rpcRes.offline && rpcRes.status && rpcRes.status >= 400 && rpcRes.status < 500) {
        if (idemKey) removePendingFinanceIntent(idemKey);
        if (acceptsFinanceResponse(rpcRes)) {
          stateCache.financeState = Core.sanitizeFinanceState({...rpcRes.financeState,controlsV23:stateCache.financeState?.controlsV23});
          lastFinanceUpdatedAt = stateCache.financeState.updatedAt || lastFinanceUpdatedAt;
          lastFinanceLedgerVersion = Number(stateCache.financeState.ledgerVersion) || lastFinanceLedgerVersion;
          emit({ type: "remote_change", state: getSnapshot(), status: getStatus() });
        }
        return rpcRes;
      }

      // Network drop / timeout / 5xx — server may or may not have committed!
      // KEEP intent persisted in localStorage and mark as "Đang xác minh giao dịch" — NEVER claim "Đã thu"!
      if (idemKey && intentRecord) {
        upsertPendingFinanceIntent({
          ...intentRecord,
          status: "unconfirmed_network",
          lastError: (rpcRes && rpcRes.error) || "Mất phản hồi từ máy chủ",
          updatedAt: new Date().toISOString()
        });
      }
      return {
        ...(rpcRes || {}),
        ok: false,
        offline: true,
        unconfirmed: true,
        verifying: true,
        code: "VERIFYING_TRANSACTION",
        idempotencyKey: idemKey,
        error: "Đang xác minh giao dịch — mất phản hồi từ máy chủ trước khi nhận xác nhận. Hệ thống sẽ tự kiểm tra theo mã giao dịch khi có mạng để tránh ghi trùng."
      };
    }

    async function lookupFinanceByIdempotency(key) {
      const cleanKey = Core.sanitizeText(key, 120);
      if (!cleanKey) return { ok: true, found: false, transaction: null };
      const res = await callRpc("pms_finance_lookup_idempotency", { p_key: cleanKey, p_kind: "tx" });
      if (res && res.ok) {
        if (acceptsFinanceResponse(res)) {
          stateCache.financeState = Core.sanitizeFinanceState({...res.financeState,controlsV23:stateCache.financeState?.controlsV23});
          lastFinanceUpdatedAt = stateCache.financeState.updatedAt || lastFinanceUpdatedAt;
          lastFinanceLedgerVersion = Number(stateCache.financeState.ledgerVersion) || lastFinanceLedgerVersion;
          financeLoadState = "loaded";
          financeLoadError = "";
        }
        return { ok: true, found: Boolean(res.found && res.transaction), transaction: res.transaction || null };
      }
      return { ok: false, offline: Boolean(res && res.offline), found: false, error: (res && res.error) || "Không thể tra cứu mã giao dịch." };
    }

    async function lookupShiftByIdempotency(key) {
      const cleanKey = Core.sanitizeText(key, 120);
      if (!cleanKey) return { ok: true, found: false, shift: null };
      const res = await callRpc("pms_finance_lookup_idempotency", { p_key: cleanKey, p_kind: "shift" });
      if (res && res.ok) {
        if (acceptsFinanceResponse(res)) {
          stateCache.financeState = Core.sanitizeFinanceState({...res.financeState,controlsV23:stateCache.financeState?.controlsV23});
          lastFinanceUpdatedAt = stateCache.financeState.updatedAt || lastFinanceUpdatedAt;
          lastFinanceLedgerVersion = Number(stateCache.financeState.ledgerVersion) || lastFinanceLedgerVersion;
          financeLoadState = "loaded";
          financeLoadError = "";
        }
        return { ok: true, found: Boolean(res.found && res.shift), shift: res.shift || null };
      }
      return { ok: false, offline: Boolean(res && res.offline), found: false, error: (res && res.error) || "Không thể tra cứu mã giao ca." };
    }

    async function reconcilePendingFinanceIntents() {
      const intents = readPendingFinanceIntents();
      if (!intents.length || !isSessionActive() || navigator.onLine === false) {
        return { ok: true, resolved: [], remaining: intents };
      }
      const resolved = [];
      for (const intent of intents) {
        const lookup = intent.kind === "shift"
          ? await lookupShiftByIdempotency(intent.idempotencyKey)
          : await lookupFinanceByIdempotency(intent.idempotencyKey);
        if (!lookup.ok) {
          continue;
        }
        if (lookup.found) {
          removePendingFinanceIntent(intent.idempotencyKey);
          resolved.push({
            idempotencyKey: intent.idempotencyKey,
            status: "committed_on_server",
            transaction: lookup.transaction || null,
            shift: lookup.shift || null
          });
        } else {
          const latest = readPendingFinanceIntents().find(x => x.idempotencyKey === intent.idempotencyKey);
          if (latest && latest.updatedAt === intent.updatedAt) upsertPendingFinanceIntent({ ...latest, status: "ready_to_retry", updatedAt: new Date().toISOString() });
        }
      }
      const remaining = readPendingFinanceIntents();
      if (resolved.length > 0) {
        await pullLatestFromCloud({ type: "remote_change", force: true, _skipIntentReconcile: true });
      }
      emit({ type: "pending_finance_intents", pendingIntents: remaining, resolved, status: getStatus() });
      return { ok: true, resolved, remaining };
    }

    async function retryPendingFinanceIntent(idempotencyKey) {
      const cleanKey = Core.sanitizeText(idempotencyKey, 120);
      const intent = readPendingFinanceIntents().find((x) => x.idempotencyKey === cleanKey);
      if (!intent) return { ok: false, code: "NOT_FOUND", error: "Không tìm thấy lệnh chờ tương ứng." };
      // ALWAYS check server by idempotencyKey FIRST before resending!
      const lookup = intent.kind === "shift"
        ? await lookupShiftByIdempotency(cleanKey)
        : await lookupFinanceByIdempotency(cleanKey);
      if (!lookup.ok) {
        return { ok: false, offline: true, unconfirmed: true, error: lookup.error || "Chưa thể xác minh giao dịch trên máy chủ." };
      }
      if (lookup.found) {
        removePendingFinanceIntent(cleanKey);
        await pullLatestFromCloud({ type: "local_commit", force: true, _skipIntentReconcile: true });
        return {
          ok: true,
          idempotentHit: true,
          alreadyCommitted: true,
          transaction: lookup.transaction || null,
          shift: lookup.shift || null,
          financeState: getFinanceStateForCurrentRole(),
          bookings: stateCache.bookings
        };
      }
      // Confirmed NOT on server yet -> safe to resend with the EXACT SAME idempotencyKey!
      return callAuthoritativeFinanceRpc(intent.rpcName, intent.rpcParams, {
        idempotencyKey: cleanKey,
        intentKind: intent.kind,
        op: intent.op,
        label: intent.label,
        amount: intent.amount
      });
    }

    function getFinanceStateForCurrentRole() {
      const r = getCurrentRole();
      if (r === "housekeeping") return null;
      if (!stateCache.financeState) return null;
      const full = Core.sanitizeFinanceState(stateCache.financeState);
      if (r === "reception") {
        // Mirror server/db.js & supabase/schema.sql exact rules:
        // Reception sees guest payments/refunds/legacy AND ALL cash_frontdesk counter transactions/openings/checks + active/own cashShifts!
        const actorUser = String((session && session.username) || "").trim().toLowerCase();
        const actorName = String((session && session.staffName) || "").trim().toLowerCase();
        const cashShiftsAll = (full.cashShifts || []).filter((s) => s && s.fundId === "cash_frontdesk");
        const latestConfirmed = cashShiftsAll
          .filter((s) => s.status === "confirmed")
          .sort((a, b) => String(b.confirmedAt || b.closedAt || b.openedAt).localeCompare(String(a.confirmedAt || a.closedAt || a.openedAt)))[0] || null;
        const visibleShifts = cashShiftsAll.filter((s) => (
          s.status === "open"
          || s.status === "pending_handover"
          || (latestConfirmed && s.id === latestConfirmed.id)
          || (actorUser && (String(s.outgoingUsername || "").toLowerCase() === actorUser || String(s.incomingUsername || "").toLowerCase() === actorUser))
          || (actorName && (String(s.outgoingStaffName || "").toLowerCase() === actorName || String(s.incomingStaffName || "").toLowerCase() === actorName || String(s.targetIncomingStaffName || "").toLowerCase() === actorName))
        ));
        return {
          ...full,
          transactions: full.transactions.filter((t) => (
            t.txType === "customer_payment"
            || t.txType === "customer_refund"
            || t.txType === "legacy_payment"
            || t.txType === "legacy_opening"
            || t.fundId === "cash_frontdesk"
            || t.fromFundId === "cash_frontdesk"
            || t.toFundId === "cash_frontdesk"
          )),
          controlsV23:undefined,
          supplierInvoices: [],
          cashShifts: visibleShifts,
          openingBalances: (full.openingBalances || []).filter((o) => o && o.fundId === "cash_frontdesk"),
          reconciliationChecks: (full.reconciliationChecks || []).filter((c) => c && c.fundId === "cash_frontdesk"),
          syncLogs: [],
          migrationHistory: []
        };
      }
      return full;
    }

    function runHealthCheck() {
      const consistency = Core.auditBookingConsistency(stateCache.bookings);
      return {
        ok: consistency.ok && connectionStatus === "connected",
        backend: "supabase",
        realtimeConnected: wsJoined,
        financeLoadState,
        storageReadable: connectionStatus === "connected",
        storageWritable: connectionStatus === "connected",
        storageCorrupted: false,
        consistencyErrors: connectionStatus === "connected"
          ? consistency.errors
          : ["Đang mất kết nối tới cơ sở dữ liệu Supabase.", ...consistency.errors],
        bookingCount: stateCache.bookings.length,
        hasRollbackBackup: stateCache.hasRollbackBackup,
        autoBackupCount: stateCache.autoBackups.length,
        auditLogCount: stateCache.auditLogs.length,
        appVersion: runningVersion.appVersion,
        buildId: runningVersion.buildId,
        checkedAt: new Date().toISOString()
      };
    }

    async function callGlRpc(rpcName, rpcArgs = {}, actionLabel = "GL_CHANGED") {
      if (!can("reports:management")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Chỉ Quản lý / Kế toán trưởng mới có quyền thao tác Sổ cái doanh nghiệp." };
      }
      const res = await callRpc(rpcName, rpcArgs);
      if (!res || !res.ok) {
        return res || { ok: false, code: "SERVER_ERROR", error: "Không thể thực hiện thao tác Sổ cái trên máy chủ." };
      }
      if (res.enterpriseGlState && typeof res.enterpriseGlState === "object") {
        const ER = root.PMSEnterpriseReport;
        stateCache.enterpriseGlState = (ER && typeof ER.sanitizeEnterpriseGlState === "function")
          ? ER.sanitizeEnterpriseGlState(res.enterpriseGlState)
          : res.enterpriseGlState;
      }
      if (typeof res.storeVersion === "number" && res.storeVersion >= storeVersion) {
        storeVersion = res.storeVersion;
      }
      if (res.auditEntry) {
        stateCache.auditLogs = [res.auditEntry, ...stateCache.auditLogs.filter((a) => a.id !== res.auditEntry.id)].slice(0, 300);
      }
      lastSyncedAt = new Date().toISOString();
      if (actionLabel !== "GL_READ") {
        broadcastDeltaToPeers({ senderId: clientId, storeVersion, action: actionLabel, actor: (session && session.staffName) || "", ts: lastSyncedAt });
      }
      emit({ type: actionLabel === "GL_READ" ? "state" : "local_commit", state: getSnapshot(), status: getStatus() });
      return res;
    }

    async function syncPmsToGlCloud(payload = {}) {
      if (!can("reports:management")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Chỉ Quản lý / Kế toán trưởng mới được đồng bộ PMS vào Sổ cái." };
      }
      const ER = root.PMSEnterpriseReport;
      if (!ER || typeof ER.buildPmsAutoPostEntries !== "function") {
        return { ok: false, code: "MODULE_MISSING", error: "Thiếu mô-đun enterprise-report.js." };
      }
      const freshPms = await pullLatestFromCloud({type:"manual_refresh",force:true});
      if (!freshPms?.ok || financeLoadState !== "loaded") return freshPms?.ok ? {ok:false,error:"Chưa tải được sổ tài chính."} : freshPms;
      // Pull freshest state before computing auto-post batch
      const latestGlRes = await callGlRpc("pms_gl_get_state", {}, "GL_READ");
      if (!latestGlRes || !latestGlRes.ok) return latestGlRes;
      const gl = stateCache.enterpriseGlState || ER.createDefaultEnterpriseGlState();
      const entityId = payload.entityId || gl.activeEntityId;
      const anchor = payload.anchor || payload.month || Core.getVietnamTodayISO().slice(0, 7);
      const kind = ["month", "quarter", "year", "ytd"].includes(payload.kind) ? payload.kind : "month";
      const p = ER.period(anchor, kind);
      const built = ER.buildPmsAutoPostEntries(
        { bookings: stateCache.bookings, financeState: stateCache.financeState, operatingCosts: stateCache.operatingCosts },
        gl,
        p,
        {
          entityId,
          actorName: (session && session.staffName) || "Quản lý",
          sourceMode: payload.sourceMode || gl.sourceMode,
          ...(payload.asOfDate ? { asOfDate: payload.asOfDate } : {})
        }
      );
      const rpcRes = await callGlRpc("pms_gl_sync_checked", {
        p_expected_store:freshPms.storeVersion,p_expected_gl:latestGlRes.enterpriseGlState,
        p_payload: {
          entityId,
          periodLabel: p.label,
          sourceMode: built.sourceMode,
          entries: built.entries
        }
      }, "GL_SYNC_PMS");
      if (!rpcRes || !rpcRes.ok) return rpcRes;
      return {
        ...rpcRes,
        period: p,
        sourceMode: built.sourceMode,
        unresolvedLegacy: built.unresolvedLegacy,
        reconciledExternalLinks: built.reconciledExternalLinks
      };
    }

    async function transitionGlPeriodCloud(payload = {}) {
      if (!can("reports:management")) {
        return { ok: false, status: 403, code: "FORBIDDEN", error: "Chỉ Quản lý / Kế toán trưởng mới được khóa / mở khóa kỳ kế toán." };
      }
      const ER = root.PMSEnterpriseReport;
      const body = { ...(payload || {}) };
      if (ER && body.action === "lock" && /^\d{4}-\d{2}$/.test(String(body.periodKey || body.month || ""))) {
        const gl = stateCache.enterpriseGlState || ER.createDefaultEnterpriseGlState();
        const pk = String(body.periodKey || body.month);
        const entityId = body.entityId || gl.activeEntityId;
        const p = ER.period(pk, "month");
        const computed = ER.computeGlStatements(gl, p, { entityId });
        const recon = ER.computeSubledgerReconciliation(gl, {
          bookings: stateCache.bookings,
          financeState: stateCache.financeState,
          operatingCosts: stateCache.operatingCosts
        }, p, { entityId });
        body.snapshotPayload = {
          periodLabel: p.label,
          trialBalanceTotals: computed.trialBalance.totals,
          incomeStatement: computed.incomeStatement,
          balanceSheet: computed.balanceSheet,
          cashFlow: computed.cashFlow,
          equityStatement: computed.equityStatement,
          reconciliationSummary: {
            hasIssues: recon.hasIssues,
            cashDiff: recon.cash.diff,
            arDiff: recon.ar.diff,
            apDiff: recon.ap.diff,
            unresolvedLegacyCount: recon.flags.unresolvedLegacy.length
          }
        };
      }
      return callGlRpc("pms_gl_transition_period", { p_payload: body }, "GL_PERIOD_TRANSITION");
    }

    return {
      init,
      subscribe,
      registerBusyCheck,
      notifyIdleCheck,
      applyPendingUpdateNow,
      checkAppVersion,
      getVersionInfo,
      getAuthState,
      commitControls:(items,version,preview=true)=>callRpc("pms_control_commit",{p_items:items,p_version:version,p_preview:preview}),
      ops24Read:(day)=>callRpc("pms_ops24_state",{p_day:day}),
      ops24Apply:(body,version,id)=>callRpc("pms_ops24_apply",{p_body:body,p_version:version,p_request:id}),
      taRead:()=>callRpc("pms_ta_get_state",{}),
      taApply:(body,version,id)=>callRpc("pms_ta_apply",{p_body:body,p_version:version,p_request:id}),
      taVerifyDoc:(token)=>callRpc("pms_ta_verify_doc_token",{p_token:token}),
      dayClose: (day,expected=null) => callRpc("pms_day_close",{p_day:day,p_expected:expected}),
      getEnterpriseGlState: () => (can("reports:management") ? stateCache.enterpriseGlState : null),
      refreshEnterpriseGlState: () => callGlRpc("pms_gl_get_state", {}, "GL_READ"),
      saveEnterpriseGlSetup: (payload = {}) => callGlRpc("pms_gl_save_setup", { p_payload: payload }, "GL_SETUP_SAVE"),
      postGlJournalEntry: (payload = {}) => callGlRpc("pms_gl_post_entry", { p_payload: payload }, "GL_POST_ENTRY"),
      reverseGlJournalEntry: (entryId, payload = {}) => callGlRpc("pms_gl_reverse_entry", { p_entry_id: entryId, p_payload: payload }, "GL_REVERSE_ENTRY"),
      importGlJournal: (payload = {}) => callGlRpc("pms_gl_import_journal", { p_payload: payload }, "GL_IMPORT_JOURNAL"),
      syncPmsToGl: syncPmsToGlCloud,
      transitionGlPeriod: transitionGlPeriodCloud,
      getRole: getCurrentRole,
      can,
      login,
      logout,
      getStatus,
      getSnapshot,
      getBookings: () => (getCurrentRole() === "housekeeping" ? [] : stateCache.bookings),
      getAuditLogs: () => (getCurrentRole() === "housekeeping" ? [] : stateCache.auditLogs),
      getAutoBackups: () => (getCurrentRole() === "housekeeping" ? [] : stateCache.autoBackups),
      hasRollbackBackup: () => (getCurrentRole() === "housekeeping" ? false : stateCache.hasRollbackBackup),
      getOperatingCosts: () => (can("costs:read") ? stateCache.operatingCosts : null),
      saveOperatingCosts,
      getFinanceState: getFinanceStateForCurrentRole,
      getFinanceLoadState,
      getPendingFinanceIntents: readPendingFinanceIntents,
      dismissPendingFinanceIntent: removePendingFinanceIntent,
      lookupFinanceByIdempotency,
      lookupShiftByIdempotency,
      reconcilePendingFinanceIntents,
      retryPendingFinanceIntent,
      recordFinanceTransaction: (payload = {}) => {
        const txType = Core.FINANCE_TX_TYPES[payload.txType] ? payload.txType : "customer_payment";
        if (txType === "customer_refund" && !can("finance:approve_refund")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Hoàn tiền cần quyền Quản lý." });
        }
        if (txType === "balance_adjustment" && !can("finance:approve_adjustment")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Điều chỉnh quỹ cần quyền Quản lý." });
        }
        const idemKey = Core.sanitizeText(payload.idempotencyKey, 120)
          || `ftx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const cleanPayload = { ...payload, txType, idempotencyKey: idemKey };
        return callAuthoritativeFinanceRpc(
          "pms_finance_record_tx",
          { p_payload: cleanPayload, p_idempotency_key: idemKey },
          {
            idempotencyKey: idemKey,
            intentKind: "tx",
            op: txType,
            label: txType === "customer_refund" ? "Hoàn tiền khách" : (txType === "balance_adjustment" ? "Điều chỉnh quỹ" : "Thu tiền khách"),
            amount: Core.parseSignedVND(payload.amount)
          }
        );
      },
      transferBetweenFunds: (payload = {}) => {
        if (!can("finance:transfer")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Chuyển quỹ chỉ dành cho Quản lý." });
        }
        const idemKey = Core.sanitizeText(payload.idempotencyKey, 120)
          || `ftx_trf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const cleanPayload = { ...payload, idempotencyKey: idemKey };
        return callAuthoritativeFinanceRpc(
          "pms_finance_transfer",
          { p_payload: cleanPayload, p_idempotency_key: idemKey },
          { idempotencyKey: idemKey, intentKind: "tx", op: "fund_transfer", label: "Chuyển quỹ", amount: Core.parseVND(payload.amount) }
        );
      },
      setFundOpeningBalance: (payload = {}) => {
        if (!can("finance:opening_balance")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Khai báo số dư đầu kỳ chỉ dành cho Quản lý." });
        }
        return callAuthoritativeFinanceRpc("pms_finance_set_opening_balance", { p_payload: payload }, { op: "opening_balance" });
      },
      reconcileFinanceTransaction: (txId, payload = {}) => {
        if (!can("finance:reconcile")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Đối chiếu chỉ dành cho Quản lý." });
        }
        return callAuthoritativeFinanceRpc("pms_finance_reconcile_tx", { p_tx_id: txId, p_payload: payload }, { op: "reconcile_tx" });
      },
      saveFundReconciliationCheck: (payload = {}) => {
        if (!can("finance:reconcile")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Đối chiếu chỉ dành cho Quản lý." });
        }
        return callAuthoritativeFinanceRpc("pms_finance_save_reconcile_check", { p_payload: payload }, { op: "reconcile_check" });
      },
      cancelBookingWithDeposit: (bookingId, payload = {}) => {
        const key = (payload && (payload.idempotencyKey || payload.cancelIdempotencyKey)) || `cancel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        return callAuthoritativeFinanceRpc(
          "pms_finance_cancel_booking_deposit",
          { p_booking_id: bookingId, p_payload: { ...payload, idempotencyKey: key } },
          { op: "cancel_booking_deposit", idempotencyKey: key, label: "Hủy phòng & xử lý cọc", amount: Number(payload.refundAmount) || 0 }
        );
      },
      updateBookingCharges: (bookingId, payload = {}) => {
        return callAuthoritativeFinanceRpc("pms_finance_update_booking_charges", { p_booking_id: bookingId, p_payload: payload }, { op: "update_booking_charges" });
      },
      migrateLegacyPayments: (opts = {}) => {
        if (!can("finance:reconcile")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Chuyển đổi dữ liệu chỉ dành cho Quản lý." });
        }
        return callAuthoritativeFinanceRpc("pms_finance_migrate_legacy", { p_dry_run: Boolean(opts.dryRun) }, { op: "migrate_legacy" });
      },
      saveSupplierInvoice: (payload = {}) => {
        if (!can("finance:payables_write")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Quản lý hóa đơn NCC chỉ dành cho Quản lý." });
        }
        return callAuthoritativeFinanceRpc("pms_finance_save_supplier_invoice", { p_payload: payload }, { op: "save_supplier_invoice" });
      },
      deleteSupplierInvoice: (invoiceId) => {
        if (!can("finance:payables_write")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Chỉ Quản lý được xóa hóa đơn NCC." });
        }
        return callAuthoritativeFinanceRpc("pms_finance_delete_supplier_invoice", { p_invoice_id: invoiceId }, { op: "delete_supplier_invoice" });
      },
      paySupplierInvoice: (invoiceId, payload = {}) => {
        if (!can("finance:payables_pay")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Thanh toán hóa đơn NCC chỉ dành cho Quản lý." });
        }
        const idemKey = Core.sanitizeText(payload.idempotencyKey, 120)
          || `ftx_spay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const cleanPayload = { ...payload, idempotencyKey: idemKey };
        return callAuthoritativeFinanceRpc(
          "pms_finance_pay_supplier_invoice",
          { p_invoice_id: invoiceId, p_payload: cleanPayload, p_idempotency_key: idemKey },
          { idempotencyKey: idemKey, intentKind: "tx", op: "supplier_payment", label: "Chi trả nhà cung cấp", amount: Core.parseVND(payload.amount) }
        );
      },
      openCashShift: (payload = {}) => {
        if (!can("finance:shift_write")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Bạn không có quyền mở ca lễ tân." });
        }
        const idemKey = Core.sanitizeText(payload.idempotencyKey, 120)
          || `shift_open_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return callAuthoritativeFinanceRpc(
          "pms_finance_shift_open",
          { p_payload: { ...payload, idempotencyKey: idemKey }, p_idempotency_key: idemKey },
          { idempotencyKey: idemKey, intentKind: "shift", op: "shift_open", label: "Mở ca giao nhận tiền mặt" }
        );
      },
      closeCashShift: (shiftId, payload = {}) => {
        if (!can("finance:shift_write")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Bạn không có quyền kết ca." });
        }
        const idemKey = Core.sanitizeText(payload.idempotencyKey, 120)
          || `shift_close_${shiftId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return callAuthoritativeFinanceRpc(
          "pms_finance_shift_close",
          { p_shift_id: shiftId, p_payload: { ...payload, idempotencyKey: idemKey }, p_idempotency_key: idemKey },
          { idempotencyKey: idemKey, intentKind: "shift", op: "shift_close", label: "Kết ca & bàn giao két" }
        );
      },
      confirmCashShift: (shiftId, payload = {}) => {
        if (!can("finance:shift_write")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Bạn không có quyền xác nhận nhận bàn giao." });
        }
        const idemKey = Core.sanitizeText(payload.idempotencyKey, 120)
          || `shift_confirm_${shiftId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return callAuthoritativeFinanceRpc(
          "pms_finance_shift_confirm",
          { p_shift_id: shiftId, p_payload: { ...payload, idempotencyKey: idemKey }, p_idempotency_key: idemKey },
          { idempotencyKey: idemKey, intentKind: "shift", op: "shift_confirm", label: "Xác nhận nhận ca" }
        );
      },
      resolveCashShiftDiscrepancy: (shiftId, payload = {}) => {
        if (!can("finance:shift_manage")) {
          return Promise.resolve({ ok: false, code: "FORBIDDEN", error: "Chỉ Quản lý được xử lý chênh lệch ca." });
        }
        const idemKey = Core.sanitizeText(payload.idempotencyKey, 120)
          || `shift_res_${shiftId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return callAuthoritativeFinanceRpc(
          "pms_finance_shift_resolve",
          { p_shift_id: shiftId, p_payload: { ...payload, idempotencyKey: idemKey }, p_idempotency_key: idemKey },
          { idempotencyKey: idemKey, intentKind: "shift", op: "shift_resolve", label: "Xử lý chênh lệch ca" }
        );
      },
      appendFinanceSyncLog: async () => ({ ok: true }),
      getHousekeepingTasks: () => stateCache.housekeepingTasks,
      getMaintenanceIssues: () => stateCache.maintenanceIssues,
      getRoomStatuses: () => stateCache.roomStatuses,
      getAccounts: () => (can("accounts:manage") ? stateCache.accounts : []),
      checkoutBooking,
      createHousekeepingTask,
      startHousekeepingTask,
      completeHousekeepingTask,
      uploadPhoto,
      reportMaintenanceIssue,
      updateMaintenanceIssue,
      listAccounts,
      createAccount,
      updateAccount,
      deleteAccount,
      refreshLatest: () => (getCurrentRole() === "housekeeping" ? [] : stateCache.bookings),
      pullLatest: () => pullLatestFromCloud({ type: "manual_refresh", force: true }),
      saveBooking,
      deleteBooking,
      inspectImportPreview,
      exportUnifiedBackup,
      restoreFromImport,
      rollbackLastChange,
      restoreFromAutoBackup,
      resetToSample,
      runHealthCheck
    };
  }

  root.PMSSupabase = { createSupabaseClient };
})(typeof window !== "undefined" ? window : globalThis);
