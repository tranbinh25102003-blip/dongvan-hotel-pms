/* ==========================================================================
   Dongvan Ville du H'mong Hotel — Unified Realtime PMS Client (pms-client.js)
   Shared by BOTH PC (app.js) and Mobile (mobile.js).
   - Hosted Server Mode (http/https): STRICT server-only mode — NEVER silently
     falls back to a separate localStorage ledger and NEVER reports "Đã lưu"
     before the SQLite server commits. Supports HttpOnly session auth for both
     API & SSE (/api/events), reconnect catch-up, and safe A -> B live updates.
   - Standalone Offline File Mode (file:// or __PMS_STANDALONE_LOCAL__):
     delegates cleanly to PMSCore.createBookingStore(localStorage).
   ========================================================================== */

(function (root) {
  "use strict";

  const Core = root.PMSCore;
  if (!Core) {
    throw new Error("PMSCore (pms-core.js) must load before pms-client.js");
  }

  function createUnifiedClient() {
    const isStandaloneLocal = Boolean(
      root.__PMS_STANDALONE_LOCAL__ === true ||
      (root.location && root.location.protocol === "file:")
    );
    const sbCfg = root.PMS_SUPABASE_CONFIG;
    if (!isStandaloneLocal && sbCfg && sbCfg.url && sbCfg.anonKey && root.PMSSupabase && typeof root.PMSSupabase.createSupabaseClient === "function") {
      return root.PMSSupabase.createSupabaseClient(sbCfg);
    }
    const localStore = isStandaloneLocal
      ? Core.createBookingStore(root.localStorage, { seedOnEmpty: true })
      : null;

    const listeners = new Set();
    const busyChecks = new Set();

    let mode = isStandaloneLocal ? "local" : "server"; // "server" | "local"
    let connectionStatus = isStandaloneLocal ? "local" : "connecting"; // "connected" | "reconnecting" | "offline" | "auth_required" | "local"
    let lastSyncedAt = null;
    let storeVersion = 0;
    let eventSource = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let inFlightPull = null;
    let queuedPullMeta = null;
    let versionCheckTimer = null;
    let idleUpdateTimer = null;
    let applyingUpdate = false;

    let authState = {
      authRequired: false,
      authConfigured: true,
      authenticated: true,
      user: isStandaloneLocal
        ? { id: "acc_super_admin", username: Core.SUPER_ADMIN_USERNAME, staffName: Core.SUPER_ADMIN_DISPLAY_NAME, role: "super_admin" }
        : null,
      staffList: [Core.SUPER_ADMIN_DISPLAY_NAME, ...(Core.CONFIRMERS || []).filter((n) => n !== Core.SUPER_ADMIN_DISPLAY_NAME)],
      accountsPublic: []
    };

    let runningVersion = { appVersion: null, buildId: null };
    let pendingUpdate = null;

    let stateCache = {
      bookings: [],
      auditLogs: [],
      autoBackups: [],
      hasRollbackBackup: false,
      operatingCosts: Core.createDefaultOperatingCostsState(),
      financeState: Core.createDefaultFinanceState(),
      housekeepingTasks: [],
      maintenanceIssues: [],
      roomStatuses: Core.computeAllRoomOperationalStatuses([], [], Core.getTodayISO()),
      accounts: []
    };

    function getCurrentRole() {
      if (mode === "local") return "super_admin";
      if (!authState.authRequired) return "super_admin";
      if (authState.user && authState.user.role) return Core.normalizeRole(authState.user.role);
      return "reception";
    }

    function can(permission) {
      return Core.hasPermission(getCurrentRole(), permission);
    }

    function emit(payload) {
      for (const fn of [...listeners]) {
        try { fn(payload); } catch (err) { console.error("[PMSClient listener error]", err); }
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
        try {
          if (fn() === true) return true;
        } catch {}
      }
      return false;
    }

    function getStatus() {
      return {
        mode,
        backend: mode === "local" ? "local" : "sqlite",
        connectionStatus,
        realtimeConnected: mode === "server" && Boolean(eventSource && eventSource.readyState === 1),
        lastSyncedAt,
        storeVersion,
        isOnline: mode === "local" ? true : connectionStatus === "connected",
        authRequired: authState.authRequired,
        authenticated: authState.authenticated,
        user: authState.user,
        role: getCurrentRole(),
        runningVersion: { ...runningVersion },
        pendingUpdate: pendingUpdate ? { ...pendingUpdate } : null
      };
    }

    function getAuthState() {
      return {
        ...authState,
        user: authState.user ? { ...authState.user } : null,
        staffList: [...authState.staffList],
        accountsPublic: Array.isArray(authState.accountsPublic) ? authState.accountsPublic.map((a) => ({ ...a })) : []
      };
    }

    function getVersionInfo() {
      return {
        appVersion: runningVersion.appVersion,
        buildId: runningVersion.buildId,
        pendingUpdate: pendingUpdate ? { ...pendingUpdate } : null
      };
    }

    function getSnapshot() {
      return {
        bookings: stateCache.bookings,
        auditLogs: stateCache.auditLogs,
        autoBackups: stateCache.autoBackups,
        hasRollbackBackup: stateCache.hasRollbackBackup,
        operatingCosts: stateCache.operatingCosts,
        financeState: stateCache.financeState,
        housekeepingTasks: stateCache.housekeepingTasks,
        maintenanceIssues: stateCache.maintenanceIssues,
        roomStatuses: stateCache.roomStatuses,
        accounts: stateCache.accounts,
        storeVersion
      };
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
      if (idleUpdateTimer) {
        clearInterval(idleUpdateTimer);
        idleUpdateTimer = null;
      }
      emit({ type: "update_applying", pendingUpdate: { ...pendingUpdate }, status: getStatus() });
      await notifyServiceWorkerCacheClear();
      setTimeout(() => {
        try { root.location.reload(); } catch {}
      }, 350);
    }

    function attemptSafeUpdate() {
      if (!pendingUpdate || applyingUpdate) return;
      if (!isUiBusy()) {
        applyPendingUpdateNow();
        return;
      }
      // Busy (receptionist/housekeeper is editing a form): wait safely without losing input
      if (!idleUpdateTimer) {
        idleUpdateTimer = setInterval(() => {
          if (!pendingUpdate || applyingUpdate) {
            clearInterval(idleUpdateTimer);
            idleUpdateTimer = null;
            return;
          }
          if (!isUiBusy()) {
            applyPendingUpdateNow();
          }
        }, 650);
      }
    }

    function notifyIdleCheck() {
      if (pendingUpdate && !applyingUpdate) {
        setTimeout(() => attemptSafeUpdate(), 120);
      }
    }

    function applyServerState(data, meta = {}) {
      if (!data || !Array.isArray(data.bookings)) return;
      const incomingVer = typeof data.storeVersion === "number" ? data.storeVersion : null;
      const allowReset = meta.type === "init" || meta.type === "auth_login" || meta.force === true;
      if (!allowReset && incomingVer !== null && incomingVer < storeVersion) return;

      stateCache.bookings = data.bookings;
      if (Array.isArray(data.auditLogs)) stateCache.auditLogs = data.auditLogs;
      if (Array.isArray(data.autoBackups)) stateCache.autoBackups = data.autoBackups;
      if (typeof data.hasRollbackBackup === "boolean") stateCache.hasRollbackBackup = data.hasRollbackBackup;
      if (data.operatingCosts && typeof data.operatingCosts === "object") {
        stateCache.operatingCosts = Core.sanitizeOperatingCostsState(data.operatingCosts);
      } else if (data.operatingCosts === null) {
        stateCache.operatingCosts = null;
      }
      if (data.financeState && typeof data.financeState === "object") {
        stateCache.financeState = Core.sanitizeFinanceState(data.financeState);
        // Auto-clear any pending unconfirmed intent whose idempotencyKey is now confirmed on server!
        try {
          const rawPend = localStorage.getItem("ks_pms_pending_fin_intents_v1");
          if (rawPend) {
            const pend = JSON.parse(rawPend);
            if (Array.isArray(pend) && pend.length > 0) {
              const committedKeys = new Set(stateCache.financeState.transactions.map((t) => t.idempotencyKey));
              const remaining = pend.filter((it) => it && !committedKeys.has(it.idempotencyKey));
              if (remaining.length !== pend.length) {
                localStorage.setItem("ks_pms_pending_fin_intents_v1", JSON.stringify(remaining));
              }
            }
          }
        } catch {}
      } else if (data.financeState === null) {
        stateCache.financeState = null;
      }
      if (Array.isArray(data.housekeepingTasks)) {
        stateCache.housekeepingTasks = data.housekeepingTasks;
      }
      if (Array.isArray(data.maintenanceIssues)) {
        stateCache.maintenanceIssues = data.maintenanceIssues;
      }
      stateCache.roomStatuses = (data.roomStatuses && typeof data.roomStatuses === "object")
        ? data.roomStatuses
        : Core.computeAllRoomOperationalStatuses(stateCache.housekeepingTasks, stateCache.maintenanceIssues, Core.getTodayISO());
      if (Array.isArray(data.accounts)) {
        stateCache.accounts = data.accounts;
      }
      if (incomingVer !== null) storeVersion = incomingVer;
      if (data.user) authState.user = data.user;
      if (data.appVersion || data.buildId) {
        recordOrCheckVersion(data.appVersion, data.buildId);
      }
      lastSyncedAt = new Date().toISOString();
      emit({
        type: meta.type || "state",
        remoteEvent: meta.remoteEvent || null,
        state: getSnapshot(),
        status: getStatus()
      });
    }

    function syncFromLocalCache(type = "state") {
      if (!localStore) return;
      stateCache.bookings = localStore.getBookings();
      stateCache.auditLogs = localStore.getAuditLogs();
      stateCache.autoBackups = localStore.getAutoBackups();
      stateCache.hasRollbackBackup = localStore.hasRollbackBackup();
      if (typeof localStore.getOperatingCosts === "function") {
        stateCache.operatingCosts = localStore.getOperatingCosts();
      }
      if (typeof localStore.getFinanceState === "function") {
        stateCache.financeState = localStore.getFinanceState();
      }
      if (typeof localStore.getHousekeepingTasks === "function") {
        stateCache.housekeepingTasks = localStore.getHousekeepingTasks();
      }
      if (typeof localStore.getMaintenanceIssues === "function") {
        stateCache.maintenanceIssues = localStore.getMaintenanceIssues();
      }
      if (typeof localStore.getStaffAccounts === "function") {
        stateCache.accounts = localStore.getStaffAccounts().map((a) => Core.sanitizeStaffAccountPublic(a)).filter(Boolean);
      }
      stateCache.roomStatuses = Core.computeAllRoomOperationalStatuses(stateCache.housekeepingTasks, stateCache.maintenanceIssues, Core.getTodayISO());
      lastSyncedAt = new Date().toISOString();
      emit({ type, state: getSnapshot(), status: getStatus() });
    }

    async function fetchJson(url, options = {}) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 10000) : null;
      try {
        const res = await fetch(url, {
          method: options.method || "GET",
          credentials: "same-origin",
          headers: {
            "Accept": "application/json",
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

    function handleAuthExpired(errorMsg) {
      closeEventSource();
      authState.authenticated = false;
      authState.user = null;
      connectionStatus = "auth_required";
      emit({
        type: "auth_required",
        error: errorMsg || "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại (nội dung đang nhập vẫn được giữ).",
        auth: getAuthState(),
        status: getStatus()
      });
    }

    async function checkAppVersion() {
      if (mode !== "server" || navigator.onLine === false) return null;
      try {
        const res = await fetchJson("/api/version", { timeoutMs: 5000 });
        if (res.httpOk && res.data && res.data.ok && res.data.buildId) {
          recordOrCheckVersion(res.data.appVersion, res.data.buildId);
          return { appVersion: res.data.appVersion, buildId: res.data.buildId };
        }
      } catch {}
      return null;
    }

    async function pullLatestFromServer(meta = {}) {
      if (mode !== "server") {
        if (localStore) {
          localStore.refreshLatest();
          syncFromLocalCache(meta.type || "state");
        }
        return { ok: true, bookings: stateCache.bookings };
      }
      if (authState.authRequired && !authState.authenticated) {
        return { ok: false, code: "AUTH_REQUIRED", error: "Vui lòng đăng nhập để đồng bộ dữ liệu." };
      }
      if (inFlightPull) {
        queuedPullMeta = meta;
        return inFlightPull;
      }

      const runOnePull = async (currentMeta) => {
        try {
          const res = await fetchJson("/api/state", { timeoutMs: 8000 });
          if (res.status === 401) {
            handleAuthExpired(res.data && res.data.error);
            return { ok: false, code: "AUTH_REQUIRED", error: (res.data && res.data.error) || "Cần đăng nhập." };
          }
          if (res.status === 503 && res.data && res.data.code === "AUTH_NOT_CONFIGURED") {
            authState.authRequired = true;
            authState.authConfigured = false;
            handleAuthExpired(res.data.error);
            return { ok: false, code: "AUTH_NOT_CONFIGURED", error: res.data.error };
          }
          if (!res.httpOk || !res.data || !res.data.ok) {
            throw new Error("Server returned invalid state");
          }
          if (connectionStatus !== "connected") {
            connectionStatus = "connected";
          }
          applyServerState(res.data, currentMeta);
          return { ok: true, bookings: stateCache.bookings, storeVersion };
        } catch {
          connectionStatus = navigator.onLine === false ? "offline" : "reconnecting";
          emit({ type: "status", status: getStatus() });
          return { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Mất kết nối tới máy chủ khách sạn." };
        }
      };

      inFlightPull = (async () => {
        let lastRes = await runOnePull(meta);
        while (queuedPullMeta && (!authState.authRequired || authState.authenticated)) {
          const nextMeta = queuedPullMeta;
          queuedPullMeta = null;
          lastRes = await runOnePull(nextMeta);
        }
        return lastRes;
      })().finally(() => {
        inFlightPull = null;
      });

      return inFlightPull;
    }

    function closeEventSource() {
      if (eventSource) {
        try { eventSource.close(); } catch {}
        eventSource = null;
      }
    }

    function scheduleReconnect() {
      if (mode !== "server" || reconnectTimer) return;
      if (authState.authRequired && !authState.authenticated) return;
      const delay = Math.min(4000, 600 * Math.pow(1.5, reconnectAttempt));
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSSE();
      }, delay);
    }

    function connectSSE() {
      if (mode !== "server" || typeof root.EventSource !== "function") return;
      if (authState.authRequired && !authState.authenticated) return;
      closeEventSource();
      try {
        const es = new root.EventSource("/api/events", { withCredentials: true });
        eventSource = es;

        es.addEventListener("connected", (ev) => {
          reconnectAttempt = 0;
          connectionStatus = "connected";
          emit({ type: "status", status: getStatus() });
          try {
            const payload = JSON.parse(ev.data || "{}");
            if (payload.appVersion || payload.buildId) {
              recordOrCheckVersion(payload.appVersion, payload.buildId);
            }
            if (typeof payload.storeVersion === "number" && payload.storeVersion > storeVersion) {
              pullLatestFromServer({ type: "remote_change", remoteEvent: { action: "SYNC_CATCHUP", storeVersion: payload.storeVersion } });
            }
          } catch {}
        });

        es.addEventListener("state_changed", (ev) => {
          let payload = {};
          try { payload = JSON.parse(ev.data || "{}"); } catch {}
          if (typeof payload.storeVersion === "number" && payload.storeVersion <= storeVersion) {
            return;
          }
          pullLatestFromServer({ type: "remote_change", remoteEvent: payload });
        });

        es.addEventListener("app_update", (ev) => {
          let payload = {};
          try { payload = JSON.parse(ev.data || "{}"); } catch {}
          if (payload.buildId) {
            recordOrCheckVersion(payload.appVersion, payload.buildId);
          } else {
            checkAppVersion();
          }
        });

        es.onerror = async () => {
          closeEventSource();
          if (navigator.onLine === false) {
            connectionStatus = "offline";
            emit({ type: "status", status: getStatus() });
            scheduleReconnect();
            return;
          }
          // Check if SSE dropped because of auth expiry or server restart with new version
          try {
            const statusRes = await fetchJson("/api/auth/status", { timeoutMs: 4000 });
            if (statusRes.httpOk && statusRes.data) {
              if (statusRes.data.buildId) {
                recordOrCheckVersion(statusRes.data.appVersion, statusRes.data.buildId);
              }
              if (statusRes.data.authRequired && !statusRes.data.authenticated) {
                handleAuthExpired("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
                return;
              }
            }
          } catch {}
          connectionStatus = navigator.onLine === false ? "offline" : "reconnecting";
          emit({ type: "status", status: getStatus() });
          scheduleReconnect();
        };
      } catch {
        connectionStatus = "offline";
        emit({ type: "status", status: getStatus() });
        scheduleReconnect();
      }
    }

    function bindNetworkWatchers() {
      root.addEventListener("offline", () => {
        if (mode !== "server") return;
        closeEventSource();
        connectionStatus = "offline";
        emit({ type: "status", status: getStatus() });
      });

      root.addEventListener("online", () => {
        if (mode !== "server") return;
        if (authState.authRequired && !authState.authenticated) {
          checkAppVersion();
          return;
        }
        connectionStatus = "reconnecting";
        emit({ type: "status", status: getStatus() });
        checkAppVersion();
        pullLatestFromServer({ type: "remote_change", remoteEvent: { action: "RECONNECT_SYNC" } });
        connectSSE();
      });

      const handleResume = () => {
        if (mode !== "server" || root.document.hidden) return;
        checkAppVersion();
        if (authState.authRequired && !authState.authenticated) return;
        pullLatestFromServer({ type: "remote_change", remoteEvent: { action: "RESUME_SYNC" } });
        if (!eventSource || eventSource.readyState === 2) {
          connectSSE();
        }
      };

      root.document.addEventListener("visibilitychange", handleResume);
      root.addEventListener("pageshow", handleResume);

      // Periodic lightweight version check while app stays open on PC/phone
      if (mode === "server" && !versionCheckTimer) {
        versionCheckTimer = setInterval(() => {
          if (!root.document.hidden && navigator.onLine !== false) {
            checkAppVersion();
          }
        }, 45000);
      }

      // Standalone local-file-only cross-tab storage sync
      root.addEventListener("storage", (e) => {
        if (mode !== "local" || !localStore) return;
        if (e.key === Core.STORAGE_KEY || e.key === Core.BACKUP_KEY || e.key === Core.AUTOBACKUP_KEY) {
          localStore.refreshLatest();
          syncFromLocalCache("remote_change");
        }
      });
    }

    async function init() {
      bindNetworkWatchers();

      if (mode === "local" && localStore) {
        connectionStatus = "local";
        const loadRes = localStore.load();
        syncFromLocalCache("init");
        return { ...loadRes, mode: "local" };
      }

      // STRICT HOSTED SERVER MODE: never silently fall back to localStorage
      mode = "server";
      try {
        const authRes = await fetchJson("/api/auth/status", { timeoutMs: 6000 });
        if (authRes.httpOk && authRes.data && authRes.data.ok) {
          authState = {
            authRequired: Boolean(authRes.data.authRequired),
            authConfigured: authRes.data.authConfigured !== false,
            authenticated: Boolean(authRes.data.authenticated),
            user: authRes.data.user || null,
            staffList: Array.isArray(authRes.data.staffList) && authRes.data.staffList.length
              ? authRes.data.staffList
              : authState.staffList,
            accountsPublic: Array.isArray(authRes.data.accountsPublic) ? authRes.data.accountsPublic : []
          };
          if (authRes.data.appVersion || authRes.data.buildId) {
            recordOrCheckVersion(authRes.data.appVersion, authRes.data.buildId);
          }

          if (authState.authRequired && !authState.authenticated) {
            connectionStatus = "auth_required";
            emit({ type: "auth_required", auth: getAuthState(), status: getStatus() });
            return { ok: true, mode: "server", authRequired: true, authenticated: false, bookings: [] };
          }
        }

        const stateRes = await pullLatestFromServer({ type: "init" });
        if (stateRes.ok) {
          connectSSE();
          return { ok: true, mode: "server", bookings: stateCache.bookings, recoveredFromBackup: false };
        }
        if (stateRes.code === "AUTH_REQUIRED" || stateRes.code === "AUTH_NOT_CONFIGURED") {
          return { ok: true, mode: "server", authRequired: true, authenticated: false, bookings: [] };
        }
        return { ok: false, mode: "server", offline: true, code: "NETWORK_OFFLINE", error: stateRes.error, bookings: [] };
      } catch {
        connectionStatus = navigator.onLine === false ? "offline" : "reconnecting";
        emit({ type: "status", status: getStatus() });
        scheduleReconnect();
        return {
          ok: false,
          mode: "server",
          offline: true,
          code: "NETWORK_OFFLINE",
          error: "Không kết nối được tới máy chủ Dongvan Hotel. App sẽ tự động đồng bộ ngay khi có mạng trở lại (không ghi tách ra bộ nhớ máy riêng).",
          bookings: []
        };
      }
    }

    async function refreshAuthPublicList() {
      if (mode !== "server") return;
      try {
        const authRes = await fetchJson("/api/auth/status", { timeoutMs: 5000 });
        if (authRes.httpOk && authRes.data && authRes.data.ok) {
          if (Array.isArray(authRes.data.staffList) && authRes.data.staffList.length) {
            authState.staffList = authRes.data.staffList;
          }
          if (Array.isArray(authRes.data.accountsPublic)) {
            authState.accountsPublic = authRes.data.accountsPublic;
          }
        }
      } catch {}
    }

    async function login(staffNameOrUsername, passcode) {
      if (mode !== "server") {
        return {
          ok: true,
          user: {
            id: "acc_super_admin",
            username: Core.SUPER_ADMIN_USERNAME,
            staffName: staffNameOrUsername || Core.SUPER_ADMIN_DISPLAY_NAME,
            role: "super_admin"
          }
        };
      }
      try {
        const res = await fetchJson("/api/auth/login", {
          method: "POST",
          body: { username: staffNameOrUsername, staffName: staffNameOrUsername, passcode },
          timeoutMs: 10000
        });
        if (!res.httpOk || !res.data || !res.data.ok) {
          return {
            ok: false,
            code: (res.data && res.data.code) || "LOGIN_FAILED",
            error: (res.data && res.data.error) || "Đăng nhập không thành công."
          };
        }
        authState.authenticated = true;
        authState.user = res.data.user || { username: staffNameOrUsername, staffName: staffNameOrUsername, role: "reception" };
        if (res.data.appVersion || res.data.buildId) {
          recordOrCheckVersion(res.data.appVersion, res.data.buildId);
        }
        const pulled = await pullLatestFromServer({ type: "auth_login", force: true });
        connectSSE();
        emit({ type: "auth_login", auth: getAuthState(), state: getSnapshot(), status: getStatus() });
        return { ok: true, user: authState.user, bookings: pulled.bookings || stateCache.bookings };
      } catch {
        return { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Không kết nối được tới máy chủ để đăng nhập." };
      }
    }

    async function logout() {
      if (mode !== "server") return { ok: true };
      closeEventSource();
      try { await fetchJson("/api/auth/logout", { method: "POST", body: {}, timeoutMs: 6000 }); } catch {}
      stateCache = {
        bookings: [],
        auditLogs: [],
        autoBackups: [],
        hasRollbackBackup: false,
        operatingCosts: null,
        housekeepingTasks: [],
        maintenanceIssues: [],
        roomStatuses: Core.computeAllRoomOperationalStatuses([], [], Core.getTodayISO()),
        accounts: []
      };
      storeVersion = 0;
      authState.authenticated = false;
      authState.user = null;
      connectionStatus = "auth_required";
      await refreshAuthPublicList();
      emit({ type: "auth_required", auth: getAuthState(), state: getSnapshot(), status: getStatus() });
      return { ok: true };
    }

    async function serverMutate(url, method, body) {
      if (navigator.onLine === false) {
        connectionStatus = "offline";
        emit({ type: "status", status: getStatus() });
        return {
          ok: false,
          offline: true,
          code: "NETWORK_OFFLINE",
          error: "Đang mất kết nối mạng — dữ liệu CHƯA được lưu lên máy chủ. Nội dung bạn đang nhập vẫn được giữ nguyên, hãy bấm Lưu lại khi có mạng."
        };
      }
      try {
        const res = await fetchJson(url, { method, body, timeoutMs: 12000 });
        if (res.status === 401) {
          handleAuthExpired((res.data && res.data.error) || "Phiên đăng nhập đã hết hạn — hãy đăng nhập lại rồi bấm Lưu.");
          return {
            ok: false,
            code: "AUTH_REQUIRED",
            error: "Phiên đăng nhập đã hết hạn — dữ liệu chưa lưu. Hãy đăng nhập lại, nội dung đang nhập vẫn được giữ nguyên."
          };
        }
        if (!res.data) {
          return { ok: false, code: "SERVER_ERROR", error: `Máy chủ phản hồi lỗi (${res.status}).` };
        }
        if (res.data.ok) {
          connectionStatus = "connected";
          await pullLatestFromServer({ type: "local_commit" });
          return { ...res.data, bookings: stateCache.bookings };
        }
        if (res.data.code === "CONFLICT_STALE_EDIT" || res.data.code === "CONFLICT_OVERBOOKING") {
          await pullLatestFromServer({ type: "conflict_refresh" });
        }
        return res.data;
      } catch {
        connectionStatus = navigator.onLine === false ? "offline" : "reconnecting";
        emit({ type: "status", status: getStatus() });
        return {
          ok: false,
          offline: true,
          code: "NETWORK_OFFLINE",
          error: "Không kết nối được tới máy chủ khách sạn — dữ liệu CHƯA được lưu. Nội dung đang nhập vẫn được giữ nguyên, vui lòng thử lại khi kết nối ổn định."
        };
      }
    }

    async function saveBooking(payload, opts = {}) {
      if (mode === "server") {
        return serverMutate("/api/bookings", "POST", {
          booking: payload,
          expectedRevision: opts.expectedRevision,
          idempotencyKey: opts.idempotencyKey
        });
      }
      const res = await Core.runWithCrossTabLock(() => localStore.saveBooking(payload, opts));
      if (res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function deleteBooking(bookingId, opts = {}) {
      if (mode === "server") {
        return serverMutate(`/api/bookings/${encodeURIComponent(bookingId)}`, "DELETE", {
          expectedRevision: opts.expectedRevision
        });
      }
      const res = await Core.runWithCrossTabLock(() => localStore.deleteBooking(bookingId, opts));
      if (res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function restoreFromImport(rawPayload) {
      if (mode === "server") {
        return serverMutate("/api/import", "POST", { rawPayload });
      }
      const res = await Core.runWithCrossTabLock(() => localStore.restoreFromImport(rawPayload));
      if (res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function rollbackLastChange() {
      if (mode === "server") {
        return serverMutate("/api/rollback", "POST", {});
      }
      const res = await Core.runWithCrossTabLock(() => localStore.rollbackLastChange());
      if (res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function restoreFromAutoBackup(snapshotId) {
      if (mode === "server") {
        return serverMutate(`/api/autobackups/${encodeURIComponent(snapshotId)}/restore`, "POST", {});
      }
      const res = await Core.runWithCrossTabLock(() => localStore.restoreFromAutoBackup(snapshotId));
      if (res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function resetToSample(baseDateISO) {
      if (mode === "server") {
        return serverMutate("/api/reset-sample", "POST", { baseDateISO });
      }
      const res = await Core.runWithCrossTabLock(() => localStore.resetToSample(baseDateISO));
      if (res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function saveOperatingCosts(nextState) {
      const clean = Core.sanitizeOperatingCostsState(nextState);
      if (mode === "server") {
        const res = await serverMutate("/api/operating-costs", "PUT", { operatingCosts: clean });
        if (res && res.ok && res.operatingCosts) {
          stateCache.operatingCosts = Core.sanitizeOperatingCostsState(res.operatingCosts);
          emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        }
        return res;
      }
      const res = await Core.runWithCrossTabLock(() => localStore.saveOperatingCosts(clean));
      if (res && res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function checkoutBooking(bookingId, opts = {}) {
      if (mode === "server") {
        return serverMutate(`/api/bookings/${encodeURIComponent(bookingId)}/checkout`, "POST", {
          serviceDate: opts.serviceDate || Core.getTodayISO()
        });
      }
      const res = await Core.runWithCrossTabLock(() =>
        localStore.checkoutBooking(bookingId, (authState.user && authState.user.staffName) || "Lễ tân", opts.serviceDate)
      );
      if (res && res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function createHousekeepingTask(payload) {
      if (mode === "server") {
        return serverMutate("/api/housekeeping/tasks", "POST", payload);
      }
      const res = await Core.runWithCrossTabLock(() => {
        const tasks = localStore.getHousekeepingTasks();
        const task = Core.sanitizeHousekeepingTask({
          ...payload,
          status: "dirty",
          createdBy: (authState.user && authState.user.staffName) || "Lễ tân"
        });
        if (!task) return { ok: false, error: "Thông tin phòng không hợp lệ." };
        const saved = localStore.saveHousekeepingTasks([task, ...tasks]);
        return saved.ok ? { ok: true, task, housekeepingTasks: saved.housekeepingTasks } : saved;
      });
      if (res && res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function startHousekeepingTask(taskId) {
      if (mode === "server") {
        return serverMutate(`/api/housekeeping/tasks/${encodeURIComponent(taskId)}/start`, "POST", {});
      }
      const res = await Core.runWithCrossTabLock(() => {
        const tasks = localStore.getHousekeepingTasks();
        const idx = tasks.findIndex((t) => t.id === taskId);
        if (idx < 0) return { ok: false, error: "Không tìm thấy công việc dọn phòng." };
        const actor = (authState.user && authState.user.staffName) || "Buồng phòng";
        const nowIso = new Date().toISOString();
        const updated = { ...tasks[idx], status: "in_progress", startedBy: tasks[idx].startedBy || actor, startedAt: tasks[idx].startedAt || nowIso, updatedAt: nowIso };
        const next = tasks.slice();
        next[idx] = updated;
        const saved = localStore.saveHousekeepingTasks(next);
        return saved.ok ? { ok: true, task: updated, housekeepingTasks: saved.housekeepingTasks } : saved;
      });
      if (res && res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function uploadPhoto(dataUrl, kind = "housekeeping") {
      if (mode !== "server") {
        if (!String(dataUrl || "").startsWith("data:image/")) {
          return { ok: false, error: "Dữ liệu ảnh không hợp lệ." };
        }
        const photo = Core.sanitizePhotoRef({
          id: `ph_local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          url: dataUrl,
          uploadedBy: (authState.user && authState.user.staffName) || "Nhân viên",
          uploadedAt: new Date().toISOString()
        });
        return { ok: true, photo };
      }
      if (navigator.onLine === false) {
        return { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Đang mất mạng — chưa tải được ảnh lên máy chủ. Vui lòng thử lại khi có mạng." };
      }
      try {
        const res = await fetchJson("/api/photos", {
          method: "POST",
          body: { dataUrl, kind },
          timeoutMs: 20000
        });
        if (res.status === 401) {
          handleAuthExpired((res.data && res.data.error) || "Phiên đăng nhập đã hết hạn.");
          return { ok: false, code: "AUTH_REQUIRED", error: "Phiên đăng nhập đã hết hạn." };
        }
        if (!res.httpOk || !res.data || !res.data.ok) {
          return {
            ok: false,
            code: (res.data && res.data.code) || "UPLOAD_FAILED",
            error: (res.data && res.data.error) || `Tải ảnh thất bại (mã ${res.status}). Vui lòng thử lại.`
          };
        }
        return res.data;
      } catch {
        return { ok: false, offline: true, code: "UPLOAD_NETWORK_ERROR", error: "Lỗi mạng khi tải ảnh lên máy chủ — công việc vẫn giữ ở trạng thái Đang dọn. Vui lòng thử lại." };
      }
    }

    async function completeHousekeepingTask(taskId, { photoIds = [], photos = [], note = "" } = {}) {
      if (mode === "server") {
        return serverMutate(`/api/housekeeping/tasks/${encodeURIComponent(taskId)}/complete`, "POST", { photoIds, note });
      }
      const res = await Core.runWithCrossTabLock(() => {
        const tasks = localStore.getHousekeepingTasks();
        const idx = tasks.findIndex((t) => t.id === taskId);
        if (idx < 0) return { ok: false, error: "Không tìm thấy công việc dọn phòng." };
        const cleanPhotos = Core.sanitizePhotoList(photos);
        if (cleanPhotos.length === 0) {
          return { ok: false, code: "PHOTO_REQUIRED", error: "Bắt buộc phải có ít nhất 1 ảnh chụp sau khi dọn." };
        }
        const actor = (authState.user && authState.user.staffName) || "Buồng phòng";
        const nowIso = new Date().toISOString();
        const updated = {
          ...tasks[idx],
          status: "cleaned",
          completedBy: actor,
          completedAt: nowIso,
          photos: cleanPhotos,
          note: note || tasks[idx].note,
          updatedAt: nowIso
        };
        const next = tasks.slice();
        next[idx] = updated;
        const saved = localStore.saveHousekeepingTasks(next);
        return saved.ok ? { ok: true, task: updated, housekeepingTasks: saved.housekeepingTasks } : saved;
      });
      if (res && res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function reportMaintenanceIssue(payload) {
      if (mode === "server") {
        return serverMutate("/api/issues", "POST", payload);
      }
      const res = await Core.runWithCrossTabLock(() => {
        const issues = localStore.getMaintenanceIssues();
        const issue = Core.sanitizeMaintenanceIssue({
          ...payload,
          reportedBy: (authState.user && authState.user.staffName) || "Nhân viên"
        });
        if (!issue) return { ok: false, error: "Vui lòng nhập đầy đủ số phòng và mô tả sự cố." };
        const saved = localStore.saveMaintenanceIssues([issue, ...issues]);
        return saved.ok ? { ok: true, issue, maintenanceIssues: saved.maintenanceIssues } : saved;
      });
      if (res && res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function updateMaintenanceIssue(issueId, patch) {
      if (mode === "server") {
        return serverMutate(`/api/issues/${encodeURIComponent(issueId)}`, "PATCH", patch);
      }
      const res = await Core.runWithCrossTabLock(() => {
        const issues = localStore.getMaintenanceIssues();
        const idx = issues.findIndex((i) => i.id === issueId);
        if (idx < 0) return { ok: false, error: "Không tìm thấy sự cố." };
        const actor = (authState.user && authState.user.staffName) || "Quản lý";
        const nowIso = new Date().toISOString();
        const nextStatus = Core.ISSUE_STATUSES[patch.status] ? patch.status : issues[idx].status;
        const updated = {
          ...issues[idx],
          ...patch,
          status: nextStatus,
          resolvedBy: nextStatus === "resolved" ? actor : "",
          resolvedAt: nextStatus === "resolved" ? nowIso : "",
          updatedAt: nowIso
        };
        const next = issues.slice();
        next[idx] = updated;
        const saved = localStore.saveMaintenanceIssues(next);
        return saved.ok ? { ok: true, issue: updated, maintenanceIssues: saved.maintenanceIssues } : saved;
      });
      if (res && res.ok) syncFromLocalCache("local_commit");
      return res;
    }

    async function listAccounts() {
      if (mode !== "server") {
        if (localStore && typeof localStore.getStaffAccounts === "function") {
          stateCache.accounts = localStore.getStaffAccounts().map((a) => Core.sanitizeStaffAccountPublic(a)).filter(Boolean);
        }
        return { ok: true, accounts: stateCache.accounts };
      }
      try {
        const res = await fetchJson("/api/accounts", { timeoutMs: 8000 });
        if (res.status === 401) {
          handleAuthExpired((res.data && res.data.error) || "Phiên đăng nhập đã hết hạn.");
          return { ok: false, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
        }
        if (!res.httpOk || !res.data || !res.data.ok) {
          return { ok: false, code: (res.data && res.data.code) || "FORBIDDEN", error: (res.data && res.data.error) || "Không thể tải danh sách tài khoản." };
        }
        stateCache.accounts = res.data.accounts || [];
        return res.data;
      } catch {
        return { ok: false, offline: true, error: "Không kết nối được tới máy chủ." };
      }
    }

    async function createAccount(payload) {
      if (mode !== "server") {
        if (!localStore || typeof localStore.getStaffAccounts !== "function") {
          return { ok: false, error: "Không hỗ trợ quản lý tài khoản trên bộ nhớ hiện tại." };
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
        const list = localStore.getStaffAccounts();
        if (list.some((a) => a.username.toLowerCase() === cleanUser)) {
          return { ok: false, code: "DUPLICATE_USERNAME", error: `Tên đăng nhập "${cleanUser}" đã tồn tại.` };
        }
        const nowIso = new Date().toISOString();
        const newAcc = {
          id: `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          username: cleanUser,
          staffName: cleanName,
          role: normRole,
          active: true,
          passHash: rawPass,
          createdAt: nowIso,
          updatedAt: nowIso
        };
        const saved = localStore.saveStaffAccounts([...list, newAcc]);
        if (!saved.ok) return saved;
        syncFromLocalCache("local_commit");
        return { ok: true, account: Core.sanitizeStaffAccountPublic(newAcc), accounts: saved.accounts };
      }
      try {
        const res = await fetchJson("/api/accounts", { method: "POST", body: payload, timeoutMs: 10000 });
        if (res.status === 401) {
          handleAuthExpired((res.data && res.data.error) || "Phiên đăng nhập đã hết hạn.");
          return { ok: false, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
        }
        if (!res.data) return { ok: false, error: `Lỗi máy chủ (${res.status}).` };
        if (res.data.ok && Array.isArray(res.data.accounts)) {
          stateCache.accounts = res.data.accounts;
          await refreshAuthPublicList();
          emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        }
        return res.data;
      } catch {
        return { ok: false, offline: true, error: "Không kết nối được tới máy chủ." };
      }
    }

    async function updateAccount(accountId, patch) {
      if (mode !== "server") {
        if (!localStore || typeof localStore.getStaffAccounts !== "function") {
          return { ok: false, error: "Không hỗ trợ quản lý tài khoản trên bộ nhớ hiện tại." };
        }
        const list = localStore.getStaffAccounts();
        const idx = list.findIndex((a) => a.id === accountId);
        if (idx < 0) return { ok: false, code: "NOT_FOUND", error: "Không tìm thấy tài khoản nhân viên." };
        const cur = list[idx];
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
          passHash: patch && patch.passcode ? String(patch.passcode).trim() : cur.passHash,
          updatedAt: new Date().toISOString()
        };
        const nextList = list.slice();
        nextList[idx] = updated;
        const saved = localStore.saveStaffAccounts(nextList);
        if (!saved.ok) return saved;
        syncFromLocalCache("local_commit");
        return { ok: true, account: Core.sanitizeStaffAccountPublic(updated), accounts: saved.accounts };
      }
      try {
        const res = await fetchJson(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: patch, timeoutMs: 10000 });
        if (res.status === 401) {
          handleAuthExpired((res.data && res.data.error) || "Phiên đăng nhập đã hết hạn.");
          return { ok: false, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
        }
        if (!res.data) return { ok: false, error: `Lỗi máy chủ (${res.status}).` };
        if (res.data.ok && Array.isArray(res.data.accounts)) {
          stateCache.accounts = res.data.accounts;
          await refreshAuthPublicList();
          emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        }
        return res.data;
      } catch {
        return { ok: false, offline: true, error: "Không kết nối được tới máy chủ." };
      }
    }

    async function deleteAccount(accountId) {
      if (mode !== "server") {
        if (!localStore || typeof localStore.getStaffAccounts !== "function") {
          return { ok: false, error: "Không hỗ trợ quản lý tài khoản trên bộ nhớ hiện tại." };
        }
        const list = localStore.getStaffAccounts();
        const target = list.find((a) => a.id === accountId);
        if (!target) return { ok: false, code: "NOT_FOUND", error: "Không tìm thấy tài khoản cần xóa." };
        if (Core.normalizeRole(target.role) === "super_admin") {
          return { ok: false, code: "SUPER_ADMIN_PROTECTED", error: "Không thể xóa tài khoản Tổng quản lý duy nhất." };
        }
        const saved = localStore.saveStaffAccounts(list.filter((a) => a.id !== accountId));
        if (!saved.ok) return saved;
        syncFromLocalCache("local_commit");
        return { ok: true, deleted: Core.sanitizeStaffAccountPublic(target), accounts: saved.accounts };
      }
      try {
        const res = await fetchJson(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE", body: {}, timeoutMs: 10000 });
        if (res.status === 401) {
          handleAuthExpired((res.data && res.data.error) || "Phiên đăng nhập đã hết hạn.");
          return { ok: false, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
        }
        if (!res.data) return { ok: false, error: `Lỗi máy chủ (${res.status}).` };
        if (res.data.ok && Array.isArray(res.data.accounts)) {
          stateCache.accounts = res.data.accounts;
          await refreshAuthPublicList();
          emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        }
        return res.data;
      } catch {
        return { ok: false, offline: true, error: "Không kết nối được tới máy chủ." };
      }
    }

    /* -------------------- Phase 1 Finance & Accounting Client + Pending Intent Recovery -------------------- */

    const PENDING_FIN_KEY = "ks_pms_pending_fin_intents_v1";

    function readPendingFinanceIntents() {
      try {
        const raw = localStorage.getItem(PENDING_FIN_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function writePendingFinanceIntents(list) {
      try {
        localStorage.setItem(PENDING_FIN_KEY, JSON.stringify((list || []).slice(0, 40)));
      } catch {}
    }

    function upsertPendingFinanceIntent(intent) {
      const list = readPendingFinanceIntents().filter((it) => it && it.idempotencyKey !== intent.idempotencyKey);
      list.unshift(intent);
      writePendingFinanceIntents(list);
      emit({ type: "finance_pending", pendingIntents: list, state: getSnapshot(), status: getStatus() });
      return list;
    }

    function removePendingFinanceIntent(idempotencyKey) {
      const list = readPendingFinanceIntents().filter((it) => it && it.idempotencyKey !== idempotencyKey);
      writePendingFinanceIntents(list);
      emit({ type: "finance_pending", pendingIntents: list, state: getSnapshot(), status: getStatus() });
      return list;
    }

    async function lookupFinanceByIdempotency(idempotencyKey) {
      const key = Core.sanitizeText(idempotencyKey, 120);
      if (!key) return { ok: true, found: false };
      if (mode !== "server") {
        const fState = (stateCache.financeState && Array.isArray(stateCache.financeState.transactions))
          ? stateCache.financeState
          : Core.createDefaultFinanceState();
        const foundTx = fState.transactions.find((t) => t.idempotencyKey === key) || null;
        return { ok: true, found: Boolean(foundTx), transaction: foundTx };
      }
      try {
        const res = await fetchJson(`/api/finance/idempotency/${encodeURIComponent(key)}`, { timeoutMs: 8000 });
        if (res.status === 401) {
          handleAuthExpired(res.data && res.data.error);
          return { ok: false, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
        }
        return (res.data && typeof res.data === "object") ? res.data : { ok: false, error: `Lỗi tra cứu (${res.status}).` };
      } catch {
        return { ok: false, offline: true, error: "Chưa kết nối lại được máy chủ để tra cứu chứng từ." };
      }
    }

    async function reconcilePendingFinanceIntents() {
      const pending = readPendingFinanceIntents();
      if (pending.length === 0) return { ok: true, resolved: [], remaining: [] };
      const resolved = [];
      const remaining = [];
      for (const item of pending) {
        const check = await lookupFinanceByIdempotency(item.idempotencyKey);
        if (check && check.ok && check.found && check.transaction) {
          resolved.push({ intent: item, transaction: check.transaction });
        } else {
          remaining.push(item);
        }
      }
      writePendingFinanceIntents(remaining);
      if (resolved.length > 0) {
        if (mode === "server") await pullLatestFromServer({ type: "finance_reconciled" });
        emit({ type: "finance_pending_resolved", resolved, pendingIntents: remaining, state: getSnapshot(), status: getStatus() });
      }
      return { ok: true, resolved, remaining };
    }

    function applyLocalFinanceFallbackMutation(mutatorFn) {
      if (!localStore || typeof localStore.getFinanceState !== "function") {
        return { ok: false, error: "Bộ nhớ cục bộ chưa sẵn sàng." };
      }
      const fState = localStore.getFinanceState();
      const bookings = localStore.getBookings();
      const out = mutatorFn(fState, bookings);
      if (!out || !out.ok) return out || { ok: false, error: "Thao tác tài chính thất bại." };
      if (out.nextFinanceState) localStore.saveFinanceState(out.nextFinanceState);
      syncFromLocalCache("local_commit");
      return { ...out, bookings: stateCache.bookings, financeState: stateCache.financeState };
    }

    async function recordFinanceTransaction(payload = {}) {
      const idempotencyKey = Core.sanitizeText(payload.idempotencyKey, 120)
        || `ftx_${payload.txType || "pay"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const reqPayload = { ...payload, idempotencyKey };

      if (mode !== "server") {
        return applyLocalFinanceFallbackMutation((fState) => {
          const dup = fState.transactions.find((t) => t.idempotencyKey === idempotencyKey);
          if (dup) return { ok: true, idempotentReplay: true, transaction: dup, nextFinanceState: fState };
          const auxSeq = (fState.voucherSeq || fState.transactions.length) + 1;
          const meta = Core.FINANCE_TX_TYPES[reqPayload.txType] || Core.FINANCE_TX_TYPES.customer_payment;
          const ts = Core.normalizeFinanceTimestamp(reqPayload.receivedAt || reqPayload.receivedDate);
          const tx = Core.sanitizeFinanceTransaction({
            ...reqPayload,
            id: `ftx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            voucherCode: `${meta.prefix}-${ts.receivedDate.slice(0, 7).replace("-", "")}-${String(auxSeq).padStart(4, "0")}`,
            receivedDate: ts.receivedDate,
            receivedAt: ts.receivedAt,
            recordedAt: new Date().toISOString()
          }, auxSeq);
          const nextFinanceState = {
            ...fState,
            ledgerVersion: (fState.ledgerVersion || 0) + 1,
            voucherSeq: auxSeq,
            transactions: [...fState.transactions, tx]
          };
          return { ok: true, idempotentReplay: false, transaction: tx, nextFinanceState };
        });
      }

      // Persist pending unconfirmed intent BEFORE sending over network (Section III.4)
      upsertPendingFinanceIntent({
        idempotencyKey,
        kind: "transaction",
        payload: reqPayload,
        status: "unconfirmed",
        label: `${Core.formatVND(reqPayload.amount)} (${Core.getFinanceFundById(reqPayload.fundId).shortName})`,
        createdAt: new Date().toISOString()
      });

      try {
        const res = await fetchJson("/api/finance/transactions", {
          method: "POST",
          body: reqPayload,
          headers: { "X-Idempotency-Key": idempotencyKey },
          timeoutMs: 12000
        });
        if (res.status === 401) {
          handleAuthExpired(res.data && res.data.error);
          return { ok: false, code: "AUTH_REQUIRED", error: "Phiên đăng nhập đã hết hạn." };
        }
        if (!res.data) {
          // Unknown server outcome: KEEP pending intent so staff can verify by idempotencyKey without double-charging!
          return {
            ok: false,
            offline: true,
            unconfirmed: true,
            idempotencyKey,
            code: "UNCONFIRMED_RESPONSE",
            error: "Chưa xác nhận được phản hồi từ máy chủ — giao dịch đang ở trạng thái Chờ đồng bộ. Bấm Kiểm tra lại sau khi có mạng để tránh thu trùng."
          };
        }
        if (res.data.ok) {
          removePendingFinanceIntent(idempotencyKey);
          if (Array.isArray(res.data.bookings)) stateCache.bookings = res.data.bookings;
          if (res.data.financeState) stateCache.financeState = Core.sanitizeFinanceState(res.data.financeState);
          if (res.data.storeVersion) storeVersion = res.data.storeVersion;
          lastSyncedAt = new Date().toISOString();
          emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
          return res.data;
        }
        // Definitive server rejection (400 / 403 / 409 STALE_BALANCE): clear pending intent & pull fresh state on conflict
        removePendingFinanceIntent(idempotencyKey);
        if (res.status === 409) {
          await pullLatestFromServer({ type: "conflict_refresh" });
        }
        return res.data;
      } catch {
        // Network dropped BEFORE receiving response (server may already have committed!) -> KEEP pending intent!
        return {
          ok: false,
          offline: true,
          unconfirmed: true,
          idempotencyKey,
          code: "NETWORK_UNCONFIRMED",
          error: "Chưa xác nhận (mất kết nối khi gửi giao dịch). Không thu lại ngay — hệ thống đã lưu mã yêu cầu để đối chiếu tự động khi có mạng."
        };
      }
    }

    async function transferBetweenFunds(payload = {}) {
      const idempotencyKey = Core.sanitizeText(payload.idempotencyKey, 120)
        || `ftx_trf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const reqPayload = { ...payload, idempotencyKey };

      if (mode !== "server") {
        return applyLocalFinanceFallbackMutation((fState) => {
          const dup = fState.transactions.find((t) => t.idempotencyKey === idempotencyKey);
          if (dup) return { ok: true, idempotentReplay: true, transaction: dup, nextFinanceState: fState };
          const auxSeq = (fState.voucherSeq || fState.transactions.length) + 1;
          const ts = Core.normalizeFinanceTimestamp(reqPayload.receivedAt || reqPayload.receivedDate);
          const tx = Core.sanitizeFinanceTransaction({
            ...reqPayload,
            txType: "fund_transfer",
            entityType: "fund",
            id: `ftx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            voucherCode: `CK-${ts.receivedDate.slice(0, 7).replace("-", "")}-${String(auxSeq).padStart(4, "0")}`,
            receivedDate: ts.receivedDate,
            receivedAt: ts.receivedAt,
            fundId: reqPayload.fromFundId,
            recordedAt: new Date().toISOString()
          }, auxSeq);
          return {
            ok: true,
            idempotentReplay: false,
            transaction: tx,
            nextFinanceState: { ...fState, ledgerVersion: (fState.ledgerVersion || 0) + 1, voucherSeq: auxSeq, transactions: [...fState.transactions, tx] }
          };
        });
      }

      upsertPendingFinanceIntent({
        idempotencyKey,
        kind: "transfer",
        payload: reqPayload,
        status: "unconfirmed",
        label: `Chuyển quỹ ${Core.formatVND(reqPayload.amount)}`,
        createdAt: new Date().toISOString()
      });

      try {
        const res = await fetchJson("/api/finance/transfers", {
          method: "POST",
          body: reqPayload,
          headers: { "X-Idempotency-Key": idempotencyKey },
          timeoutMs: 12000
        });
        if (res.status === 401) {
          handleAuthExpired(res.data && res.data.error);
          return { ok: false, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
        }
        if (!res.data) {
          return { ok: false, offline: true, unconfirmed: true, idempotencyKey, error: "Chưa xác nhận chuyển quỹ — đang chờ đồng bộ." };
        }
        removePendingFinanceIntent(idempotencyKey);
        if (res.data.ok) {
          if (res.data.financeState) stateCache.financeState = Core.sanitizeFinanceState(res.data.financeState);
          if (res.data.storeVersion) storeVersion = res.data.storeVersion;
          lastSyncedAt = new Date().toISOString();
          emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        }
        return res.data;
      } catch {
        return { ok: false, offline: true, unconfirmed: true, idempotencyKey, error: "Mất kết nối — lệnh chuyển quỹ đang ở trạng thái Chưa xác nhận." };
      }
    }

    async function retryPendingFinanceIntent(idempotencyKey) {
      const item = readPendingFinanceIntents().find((it) => it && it.idempotencyKey === idempotencyKey);
      if (!item) return { ok: false, error: "Không tìm thấy lệnh chờ đồng bộ." };
      // First check if server already committed before retrying!
      const check = await lookupFinanceByIdempotency(idempotencyKey);
      if (check && check.ok && check.found && check.transaction) {
        removePendingFinanceIntent(idempotencyKey);
        await pullLatestFromServer({ type: "finance_reconciled" });
        return { ok: true, idempotentReplay: true, alreadyCommitted: true, transaction: check.transaction };
      }
      if (item.kind === "transfer") return transferBetweenFunds(item.payload);
      return recordFinanceTransaction(item.payload);
    }

    async function postFinanceSimple(url, method, body) {
      try {
        const res = await fetchJson(url, { method, body, timeoutMs: 12000 });
        if (res.status === 401) {
          handleAuthExpired(res.data && res.data.error);
          return { ok: false, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
        }
        if (!res.data) return { ok: false, error: `Lỗi máy chủ (${res.status}).` };
        if (res.data.ok) {
          if (Array.isArray(res.data.bookings)) stateCache.bookings = res.data.bookings;
          if (res.data.financeState) stateCache.financeState = Core.sanitizeFinanceState(res.data.financeState);
          if (res.data.storeVersion) storeVersion = res.data.storeVersion;
          lastSyncedAt = new Date().toISOString();
          emit({ type: "local_commit", state: getSnapshot(), status: getStatus() });
        }
        return res.data;
      } catch {
        return { ok: false, offline: true, error: "Không kết nối được tới máy chủ." };
      }
    }

    async function setFundOpeningBalance(payload) {
      if (mode !== "server") {
        return applyLocalFinanceFallbackMutation((fState) => {
          const entry = {
            id: `ob_${payload.fundId}_${payload.asOfDate || Core.getVietnamTodayISO()}`,
            fundId: payload.fundId,
            amount: Core.parseSignedVND(payload.amount),
            asOfDate: Core.normalizeFinanceDateISO(payload.asOfDate) || Core.getVietnamTodayISO(),
            voucherRef: Core.sanitizeText(payload.voucherRef, 80),
            note: Core.sanitizeText(payload.note, 300),
            recordedBy: "Quản lý",
            recordedAt: new Date().toISOString()
          };
          return {
            ok: true,
            openingBalance: entry,
            nextFinanceState: { ...fState, openingBalances: [...(fState.openingBalances || []).filter((o) => o.id !== entry.id), entry] }
          };
        });
      }
      return postFinanceSimple("/api/finance/opening-balance", "POST", payload);
    }

    async function reconcileFinanceTransaction(txId, payload) {
      if (mode !== "server") {
        return applyLocalFinanceFallbackMutation((fState) => {
          const nextList = fState.transactions.map((t) => (t.id === txId
            ? {
                ...t,
                reconciled: payload.reconciled !== undefined ? Boolean(payload.reconciled) : true,
                fundId: payload.fundId || t.fundId,
                receivedDate: payload.receivedDate || t.receivedDate,
                legacyStatus: (t.isLegacyMigrated && payload.fundId && payload.receivedDate) ? "reconciled" : t.legacyStatus,
                reconciledAt: new Date().toISOString(),
                reconciledBy: "Quản lý",
                reconcileNote: Core.sanitizeText(payload.reconcileNote || t.reconcileNote, 300)
              }
            : t));
          return { ok: true, nextFinanceState: { ...fState, transactions: nextList } };
        });
      }
      return postFinanceSimple(`/api/finance/transactions/${encodeURIComponent(txId)}/reconcile`, "PATCH", payload);
    }

    async function saveFundReconciliationCheck(payload) {
      if (mode !== "server") {
        return applyLocalFinanceFallbackMutation((fState, bookings) => {
          const asOfDate = Core.normalizeFinanceDateISO(payload.asOfDate) || Core.getVietnamTodayISO();
          const cb = Core.computeCashbookReport(fState, bookings, { toDate: asOfDate });
          const fRep = cb.funds.find((f) => f.id === payload.fundId);
          const bookBal = fRep ? fRep.closingBalance : 0;
          const actBal = Core.parseSignedVND(payload.actualBalance);
          const check = {
            id: `rec_${payload.fundId}_${Date.now().toString(36)}`,
            fundId: payload.fundId,
            asOfDate,
            actualBalance: actBal,
            bookBalanceAtCheck: bookBal,
            discrepancy: Core.roundVND(actBal - bookBal),
            note: Core.sanitizeText(payload.note, 300),
            checkedBy: "Quản lý",
            checkedAt: new Date().toISOString()
          };
          return { ok: true, check, nextFinanceState: { ...fState, reconciliationChecks: [...(fState.reconciliationChecks || []), check] } };
        });
      }
      return postFinanceSimple("/api/finance/reconcile-check", "POST", payload);
    }

    async function cancelBookingWithDeposit(bookingId, payload) {
      if (mode !== "server") {
        const bookings = localStore.getBookings();
        const target = bookings.find((b) => b.id === bookingId);
        if (!target) return { ok: false, error: "Không tìm thấy đặt phòng." };
        const res = localStore.saveBooking({
          ...target,
          status: "cancelled",
          cancelReason: payload.reason || "Khách hủy",
          depositDisposition: payload.depositDisposition || "pending",
          retainedDepositAmount: payload.retainedDepositAmount || 0,
          allowOverpaid: true,
          ledgerManaged: true
        });
        if (res.ok) syncFromLocalCache("local_commit");
        return res;
      }
      return postFinanceSimple(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, "POST", payload);
    }

    async function updateBookingCharges(bookingId, payload) {
      if (mode !== "server") {
        const bookings = localStore.getBookings();
        const target = bookings.find((b) => b.id === bookingId);
        if (!target) return { ok: false, error: "Không tìm thấy đặt phòng." };
        const res = localStore.saveBooking({
          ...target,
          roomAmount: payload.roomAmount !== undefined ? payload.roomAmount : Core.getBookingChargesBreakdown(target).roomAmount,
          services: payload.services !== undefined ? payload.services : (target.services || []),
          adjustments: payload.adjustments !== undefined ? payload.adjustments : (target.adjustments || []),
          allowOverpaid: true,
          ledgerManaged: true
        });
        if (res.ok) syncFromLocalCache("local_commit");
        return res;
      }
      return postFinanceSimple(`/api/bookings/${encodeURIComponent(bookingId)}/charges`, "POST", payload);
    }

    async function migrateLegacyPayments(opts = {}) {
      if (mode !== "server") {
        return applyLocalFinanceFallbackMutation((fState, bookings) => {
          const plan = Core.buildLegacyMigrationPlan(bookings, fState, "Quản lý");
          if (opts.dryRun) return { ok: true, dryRun: true, ...plan };
          return { ok: true, dryRun: false, ...plan, nextFinanceState: plan.nextFinanceState };
        });
      }
      return postFinanceSimple("/api/finance/migrate-legacy", "POST", { dryRun: Boolean(opts.dryRun) });
    }

    async function appendFinanceSyncLog(entry) {
      if (mode !== "server") return { ok: true };
      try {
        const res = await fetchJson("/api/finance/sync-logs", { method: "POST", body: entry || {}, timeoutMs: 6000 });
        return (res && res.data) || { ok: false };
      } catch {
        return { ok: false, offline: true };
      }
    }

    function runHealthCheck() {
      if (mode === "server") {
        const consistency = Core.auditBookingConsistency(stateCache.bookings);
        return {
          ok: consistency.ok && connectionStatus === "connected",
          backend: "sqlite",
          storageReadable: connectionStatus === "connected",
          storageWritable: connectionStatus === "connected",
          storageCorrupted: false,
          consistencyErrors: connectionStatus === "connected"
            ? consistency.errors
            : ["Đang mất kết nối tới máy chủ SQLite.", ...consistency.errors],
          bookingCount: stateCache.bookings.length,
          hasRollbackBackup: stateCache.hasRollbackBackup,
          autoBackupCount: stateCache.autoBackups.length,
          auditLogCount: stateCache.auditLogs.length,
          appVersion: runningVersion.appVersion,
          buildId: runningVersion.buildId,
          checkedAt: new Date().toISOString()
        };
      }
      return localStore.runHealthCheck();
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
      getRole: getCurrentRole,
      can,
      login,
      logout,
      getStatus,
      getSnapshot,
      getBookings: () => stateCache.bookings,
      getAuditLogs: () => stateCache.auditLogs,
      getAutoBackups: () => stateCache.autoBackups,
      hasRollbackBackup: () => stateCache.hasRollbackBackup,
      getOperatingCosts: () => stateCache.operatingCosts,
      saveOperatingCosts,
      getFinanceState: () => stateCache.financeState,
      getPendingFinanceIntents: readPendingFinanceIntents,
      dismissPendingFinanceIntent: removePendingFinanceIntent,
      lookupFinanceByIdempotency,
      reconcilePendingFinanceIntents,
      retryPendingFinanceIntent,
      recordFinanceTransaction,
      transferBetweenFunds,
      setFundOpeningBalance,
      reconcileFinanceTransaction,
      saveFundReconciliationCheck,
      cancelBookingWithDeposit,
      updateBookingCharges,
      migrateLegacyPayments,
      appendFinanceSyncLog,
      getHousekeepingTasks: () => stateCache.housekeepingTasks,
      getMaintenanceIssues: () => stateCache.maintenanceIssues,
      getRoomStatuses: () => stateCache.roomStatuses,
      getAccounts: () => stateCache.accounts,
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
      refreshLatest: () => {
        if (mode === "local" && localStore) {
          localStore.refreshLatest();
          syncFromLocalCache("refresh");
        }
        return stateCache.bookings;
      },
      pullLatest: () => pullLatestFromServer({ type: "manual_refresh" }),
      saveBooking,
      deleteBooking,
      restoreFromImport,
      rollbackLastChange,
      restoreFromAutoBackup,
      resetToSample,
      runHealthCheck
    };
  }

  root.PMSClient = { createUnifiedClient };
  if (!root.pmsClient) {
    root.pmsClient = createUnifiedClient();
  }
})(typeof window !== "undefined" ? window : globalThis);
