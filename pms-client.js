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
      user: null,
      staffList: [...(Core.CONFIRMERS || []), "Quản lý"]
    };

    let runningVersion = { appVersion: null, buildId: null };
    let pendingUpdate = null;

    let stateCache = {
      bookings: [],
      auditLogs: [],
      autoBackups: [],
      hasRollbackBackup: false,
      operatingCosts: Core.createDefaultOperatingCostsState()
    };

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
        runningVersion: { ...runningVersion },
        pendingUpdate: pendingUpdate ? { ...pendingUpdate } : null
      };
    }

    function getAuthState() {
      return {
        ...authState,
        user: authState.user ? { ...authState.user } : null,
        staffList: [...authState.staffList]
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
      // Busy (receptionist is editing a booking or collecting payment): wait safely without losing input
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
              : authState.staffList
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

    async function login(staffName, passcode) {
      if (mode !== "server") return { ok: true, user: { staffName: staffName || "Lễ tân", role: "staff" } };
      try {
        const res = await fetchJson("/api/auth/login", {
          method: "POST",
          body: { staffName, passcode },
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
        authState.user = res.data.user || { staffName, role: "staff" };
        if (res.data.appVersion || res.data.buildId) {
          recordOrCheckVersion(res.data.appVersion, res.data.buildId);
        }
        const pulled = await pullLatestFromServer({ type: "auth_login" });
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
      stateCache = { bookings: [], auditLogs: [], autoBackups: [], hasRollbackBackup: false };
      storeVersion = 0;
      authState.authenticated = false;
      authState.user = null;
      connectionStatus = "auth_required";
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
