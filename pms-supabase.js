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
  const MAX_BROADCAST_PDF_CHARS = 32000;

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
    const staffList = [...(Core.CONFIRMERS || []), "Quản lý"];
    const clientId = `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    const listeners = new Set();
    const busyChecks = new Set();

    let connectionStatus = "connecting"; // "connected" | "reconnecting" | "offline" | "auth_required"
    let lastSyncedAt = null;
    let storeVersion = 0;
    let lastOperatingCostsUpdatedAt = "";

    let session = null; // { access_token, refresh_token, expires_at, staffName }
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

    let stateCache = {
      bookings: [],
      auditLogs: [],
      autoBackups: [],
      hasRollbackBackup: false,
      operatingCosts: Core.createDefaultOperatingCostsState(),
      housekeepingTasks: [],
      maintenanceIssues: [],
      roomStatuses: Core.computeAllRoomOperationalStatuses([], [], Core.getTodayISO()),
      accounts: []
    };

    function getCurrentRole() {
      if (!session) return "reception";
      if (session.role) return Core.normalizeRole(session.role);
      const nm = String(session.staffName || "").trim().toLowerCase();
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

    function getAuthState() {
      return {
        authRequired: true,
        authConfigured: Boolean(baseUrl && anonKey),
        authenticated: Boolean(session && session.access_token),
        user: session ? { username: session.username || session.staffName || "Lễ tân", staffName: session.staffName || "Lễ tân", role: getCurrentRole() } : null,
        staffList: [...staffList, "Buồng phòng"],
        accountsPublic: [
          ...staffList.map((n) => ({ id: `sb_${n}`, username: n, staffName: n, role: n === "Quản lý" ? "manager" : "reception" })),
          { id: "sb_hk", username: "Buồng phòng", staffName: "Buồng phòng", role: "housekeeping" }
        ]
      };
    }

    function getVersionInfo() {
      return {
        appVersion: runningVersion.appVersion,
        buildId: runningVersion.buildId,
        pendingUpdate: pendingUpdate ? { ...pendingUpdate } : null
      };
    }

    function getStatus() {
      return {
        mode: "server",
        backend: "supabase",
        connectionStatus,
        realtimeConnected: wsJoined,
        lastSyncedAt,
        storeVersion,
        isOnline: connectionStatus === "connected",
        authRequired: true,
        authenticated: Boolean(session && session.access_token),
        user: session ? { username: session.username || session.staffName || "Lễ tân", staffName: session.staffName || "Lễ tân", role: getCurrentRole() } : null,
        role: getCurrentRole(),
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
        operatingCosts: getCurrentRole() === "manager" ? stateCache.operatingCosts : null,
        housekeepingTasks: stateCache.housekeepingTasks,
        maintenanceIssues: stateCache.maintenanceIssues,
        roomStatuses: stateCache.roomStatuses,
        accounts: stateCache.accounts,
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

    function handleAuthExpired(errorMsg) {
      closeRealtime();
      saveStoredSession(null);
      connectionStatus = "auth_required";
      emit({
        type: "auth_required",
        error: errorMsg || "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại (nội dung đang nhập vẫn được giữ).",
        auth: getAuthState(),
        status: getStatus()
      });
    }

    // Single-flight token refresh prevents concurrent RPCs from racing refresh-token rotation!
    async function ensureValidAccessToken(forceRefresh = false) {
      if (!session || !session.access_token) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      if (!forceRefresh && session.expires_at && session.expires_at - nowSec > 120) {
        return session.access_token;
      }
      if (!session.refresh_token) return session.access_token;
      if (refreshInFlight) return refreshInFlight;

      const refreshTok = session.refresh_token;
      const staffName = session.staffName || "Lễ tân";
      refreshInFlight = (async () => {
        try {
          const res = await rawFetchJson(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
            method: "POST",
            body: { refresh_token: refreshTok },
            timeoutMs: 8000
          });
          if (res.httpOk && res.data && res.data.access_token) {
            const next = {
              access_token: res.data.access_token,
              refresh_token: res.data.refresh_token || refreshTok,
              expires_at: Math.floor(Date.now() / 1000) + (Number(res.data.expires_in) || 3600),
              staffName
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
      const token = await ensureValidAccessToken(false);
      if (!token) {
        return { ok: false, code: "AUTH_REQUIRED", error: "Vui lòng đăng nhập tài khoản lễ tân." };
      }
      try {
        const res = await rawFetchJson(`${baseUrl}/rest/v1/rpc/${rpcName}`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}` },
          body: params,
          timeoutMs: 12000
        });
        if (res.status === 401 || (res.data && String(res.data.message || "").includes("AUTH_REQUIRED"))) {
          if (allowRetry && session && session.refresh_token) {
            const refreshed = await ensureValidAccessToken(true);
            if (refreshed) return callRpc(rpcName, params, false);
          }
          handleAuthExpired("Phiên đăng nhập đã hết hạn — nội dung đang nhập vẫn được giữ nguyên.");
          return { ok: false, code: "AUTH_REQUIRED", error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại rồi bấm Lưu." };
        }
        if (!res.httpOk) {
          return {
            ok: false,
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
      const allowReset = meta.type === "init" || meta.type === "auth_login" || meta.force === true;
      // Prevent out-of-order stale responses from overwriting a newer committed version
      if (!allowReset && incomingVer !== null && incomingVer < storeVersion) {
        return false;
      }

      Core.normalizeDormSlots(data.bookings);
      stateCache.bookings = data.bookings;
      if (Array.isArray(data.auditLogs)) stateCache.auditLogs = data.auditLogs;
      if (Array.isArray(data.autoBackups)) stateCache.autoBackups = data.autoBackups;
      if (typeof data.hasRollbackBackup === "boolean") stateCache.hasRollbackBackup = data.hasRollbackBackup;
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

    function prepareBroadcastPayload(delta) {
      const copy = { ...delta };
      // Keep Realtime broadcast frame compact (<32KB); if a huge base64 PDF is attached, strip dataUrl
      // so peers paint the booking cell in <80ms and fetch the full PDF cleanly in the background.
      if (copy.booking && copy.booking.confirmationPdf && copy.booking.confirmationPdf.dataUrl) {
        if (String(copy.booking.confirmationPdf.dataUrl).length > MAX_BROADCAST_PDF_CHARS) {
          copy.booking = {
            ...copy.booking,
            confirmationPdf: {
              name: copy.booking.confirmationPdf.name,
              size: copy.booking.confirmationPdf.size,
              uploadedAt: copy.booking.confirmationPdf.uploadedAt
            }
          };
          copy.needsFullPull = true;
        }
      }
      return copy;
    }

    function broadcastDeltaToPeers(delta) {
      const payload = prepareBroadcastPayload(delta);
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

    function applyIncomingPeerDelta(delta) {
      if (!delta || typeof delta !== "object") return;
      if (delta.senderId && delta.senderId === clientId) return;

      if (delta.action === "COSTS_UPDATE" && delta.operatingCosts) {
        stateCache.operatingCosts = Core.sanitizeOperatingCostsState(delta.operatingCosts);
        lastOperatingCostsUpdatedAt = stateCache.operatingCosts.updatedAt || delta.ts || new Date().toISOString();
        lastSyncedAt = new Date().toISOString();
        connectionStatus = "connected";
        emit({
          type: "remote_change",
          remoteEvent: { action: "COSTS_UPDATE", actor: delta.actor || "", ts: delta.ts || lastSyncedAt },
          state: getSnapshot(),
          status: getStatus()
        });
        return;
      }

      const remoteVer = typeof delta.storeVersion === "number" ? delta.storeVersion : null;
      if (remoteVer !== null && remoteVer <= storeVersion) return;

      const remoteEvent = {
        action: delta.action || "REMOTE_CHANGE",
        roomId: delta.roomId || (delta.booking && delta.booking.roomId) || "",
        guestName: delta.guestName || (delta.booking && delta.booking.guestName) || "",
        actor: delta.actor || "",
        storeVersion: remoteVer,
        ts: delta.ts || new Date().toISOString()
      };

      // Bulk replace (restore/rollback/reset) or skipped version gap -> authoritative coalesced full pull
      const isSequentialNext = remoteVer !== null && remoteVer === storeVersion + 1;
      const canPatchDirectly = !delta.bulkReplace && isSequentialNext && (delta.booking || delta.deletedId);

      if (canPatchDirectly) {
        let nextBookings;
        if (delta.deletedId) {
          nextBookings = stateCache.bookings.filter((b) => b.id !== delta.deletedId);
        } else {
          const bk = delta.booking;
          const idx = stateCache.bookings.findIndex((b) => b.id === bk.id);
          if (idx >= 0) {
            nextBookings = stateCache.bookings.slice();
            nextBookings[idx] = bk;
          } else {
            nextBookings = [...stateCache.bookings, bk];
          }
        }
        Core.normalizeDormSlots(nextBookings);
        stateCache.bookings = nextBookings;
        if (delta.auditEntry && typeof delta.auditEntry === "object") {
          stateCache.auditLogs = [
            delta.auditEntry,
            ...stateCache.auditLogs.filter((l) => l && l.id !== delta.auditEntry.id)
          ].slice(0, 300);
        }
        storeVersion = remoteVer;
        lastSyncedAt = new Date().toISOString();
        connectionStatus = "connected";
        emit({
          type: "remote_change",
          remoteEvent,
          state: getSnapshot(),
          status: getStatus()
        });
        // If PDF dataUrl was stripped from broadcast frame, pull full state seamlessly in background
        if (delta.needsFullPull) {
          pullLatestFromCloud({ type: "remote_change", remoteEvent, force: true });
        }
        return;
      }

      // Version gap or bulk change -> immediate coalesced authoritative pull
      pullLatestFromCloud({ type: "remote_change", remoteEvent });
    }

    async function pullLatestFromCloud(meta = {}) {
      if (!session || !session.access_token) {
        return { ok: false, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
      }

      // Coalesce concurrent pulls so rapid bursts never cause out-of-order overwrites or N duplicate RPCs
      if (inFlightPull) {
        queuedPullMeta = meta;
        return inFlightPull;
      }

      const runOnePull = async (currentMeta) => {
        const res = await callRpc("pms_get_state", {});
        if (!res || !res.ok) {
          return res || { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Không thể tải dữ liệu." };
        }
        // Also fetch operating_costs_v1 from pms_meta (existing RLS-protected table — zero SQL changes needed)
        try {
          const token = await ensureValidAccessToken(false);
          if (token) {
            const cRes = await rawFetchJson(`${baseUrl}/rest/v1/pms_meta?key=eq.operating_costs_v1&select=value,updated_at`, {
              method: "GET",
              headers: { "Authorization": `Bearer ${token}` },
              timeoutMs: 6000
            });
            if (cRes.httpOk && Array.isArray(cRes.data) && cRes.data[0] && cRes.data[0].value) {
              stateCache.operatingCosts = Core.sanitizeOperatingCostsState(cRes.data[0].value);
              lastOperatingCostsUpdatedAt = (cRes.data[0].value && cRes.data[0].value.updatedAt) || cRes.data[0].updated_at || stateCache.operatingCosts.updatedAt || "";
            }
          }
        } catch {}
        connectionStatus = "connected";
        applyCloudState(res, currentMeta);
        return { ok: true, bookings: stateCache.bookings, storeVersion };
      };

      inFlightPull = (async () => {
        let lastResult = await runOnePull(meta);
        while (queuedPullMeta && session && session.access_token) {
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

    // Ultra-lightweight version probe (reads store_version + operating_costs_v1 from pms_meta).
    // Triggers full pms_get_state() when remote storeVersion > local storeVersion,
    // and immediately catches up operating_costs_v1 when modified on another device while sleeping/offline.
    async function checkRemoteVersionAndSync(reason = "VERSION_PROBE") {
      if (!session || !session.access_token || navigator.onLine === false) return false;
      if (inFlightPull || inFlightVersionProbe) return false;

      inFlightVersionProbe = (async () => {
        const token = await ensureValidAccessToken(false);
        if (!token) return false;
        lastProbeAt = Date.now();
        try {
          const res = await rawFetchJson(`${baseUrl}/rest/v1/pms_meta?key=in.(store_version,operating_costs_v1)&select=key,value,updated_at`, {
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
      if (wsReconnectTimer || !session || !session.access_token || navigator.onLine === false) return;
      const delay = Math.min(4000, 450 * Math.pow(1.5, wsReconnectAttempt));
      wsReconnectAttempt += 1;
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectRealtime();
      }, delay);
    }

    async function connectRealtime() {
      if (!session || !session.access_token || typeof root.WebSocket !== "function" || navigator.onLine === false) return;
      if (wsConnecting) return;
      wsConnecting = true;

      let accessToken = null;
      try {
        accessToken = await ensureValidAccessToken(false);
      } finally {
        wsConnecting = false;
      }
      if (!accessToken || !session || navigator.onLine === false) return;

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
          socket.send(JSON.stringify({
            topic: "realtime:pms-sync",
            event: "phx_join",
            payload: {
              config: {
                broadcast: { ack: false, self: false },
                presence: { key: "" },
                postgres_changes: [
                  { event: "*", schema: "public", table: "pms_meta" }
                ]
              },
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
          } else if (session && session.access_token) {
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
      if (!session || !session.access_token || navigator.onLine === false) return;
      connectionStatus = "reconnecting";
      emit({ type: "status", status: getStatus() });
      checkRemoteVersionAndSync(reason || "RECONNECT_SYNC");
      connectRealtime();
    }

    function handleAppResume(reason) {
      checkAppVersion();
      if (!session || !session.access_token || navigator.onLine === false) return;
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
        if (!session || !session.access_token) return;
        connectionStatus = "reconnecting";
        emit({ type: "status", status: getStatus() });
        checkRemoteVersionAndSync("RECONNECT_SYNC");
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
          if (root.document.hidden || navigator.onLine === false || !session || !session.access_token) return;
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
      const cleanStaff = String(staffName || "").trim() || "Lễ tân";
      const cleanPass = String(passcode || "");
      if (!cleanPass) {
        return { ok: false, code: "MISSING_CREDENTIALS", error: "Vui lòng nhập mật khẩu khách sạn." };
      }
      try {
        const res = await rawFetchJson(`${baseUrl}/auth/v1/token?grant_type=password`, {
          method: "POST",
          body: { email: hotelEmail, password: cleanPass },
          timeoutMs: 12000
        });
        if (!res.httpOk || !res.data || !res.data.access_token) {
          return {
            ok: false,
            code: "INVALID_CREDENTIALS",
            error: "Sai mật khẩu khách sạn (hoặc tài khoản lễ tân chưa được tạo trên Supabase)."
          };
        }
        saveStoredSession({
          access_token: res.data.access_token,
          refresh_token: res.data.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + (Number(res.data.expires_in) || 3600),
          staffName: cleanStaff
        });
        const pulled = await pullLatestFromCloud({ type: "auth_login", force: true });
        if (!pulled.ok) {
          return { ok: false, code: pulled.code, error: pulled.error };
        }
        connectRealtime();
        emit({ type: "auth_login", auth: getAuthState(), state: getSnapshot(), status: getStatus() });
        return { ok: true, user: getAuthState().user, bookings: stateCache.bookings };
      } catch {
        return { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Không kết nối được tới Supabase để đăng nhập." };
      }
    }

    async function logout() {
      const token = session && session.access_token;
      closeRealtime();
      if (token) {
        try {
          await rawFetchJson(`${baseUrl}/auth/v1/logout`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}` },
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
        operatingCosts: Core.createDefaultOperatingCostsState()
      };
      storeVersion = 0;
      lastOperatingCostsUpdatedAt = "";
      connectionStatus = "auth_required";
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

    async function restoreFromImport(rawPayload) {
      const validated = Core.validateAndSanitizeImport(rawPayload);
      if (!validated.ok) {
        return { ok: false, code: "INVALID_IMPORT", error: validated.error, details: validated.details };
      }
      Core.normalizeDormSlots(validated.bookings);
      const rpcRes = await callRpc("pms_replace_all", {
        p_bookings: validated.bookings,
        p_action: "RESTORE",
        p_summary: `Khôi phục ${validated.bookings.length} lượt đặt phòng từ file JSON.`,
        p_actor_name: (session && session.staffName) || ""
      });
      if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Khôi phục thất bại." };
      applyMutationCommit(rpcRes, { action: "RESTORE", bulkReplace: true });
      pullLatestFromCloud({ type: "local_commit" }); // refresh backup snapshots asynchronously
      return { ...rpcRes, bookings: stateCache.bookings };
    }

    async function rollbackLastChange() {
      const rpcRes = await callRpc("pms_rollback_last", {
        p_actor_name: (session && session.staffName) || ""
      });
      if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Hoàn tác thất bại." };
      applyMutationCommit(rpcRes, { action: "ROLLBACK", bulkReplace: true });
      pullLatestFromCloud({ type: "local_commit" });
      return { ...rpcRes, bookings: stateCache.bookings };
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
      const token = await ensureValidAccessToken(false);
      if (!token) {
        return { ok: false, code: "AUTH_REQUIRED", error: "Vui lòng đăng nhập để lưu chi phí vận hành." };
      }
      const clean = Core.sanitizeOperatingCostsState(nextState);
      clean.updatedAt = new Date().toISOString();
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
          return { ok: false, code: "AUTH_REQUIRED", error: "Phiên đăng nhập đã hết hạn." };
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
      const token = await ensureValidAccessToken(false);
      if (!token) {
        return { ok: false, code: "AUTH_REQUIRED", error: "Vui lòng đăng nhập lại." };
      }
      const updatedAt = new Date().toISOString();
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
          return { ok: false, code: "AUTH_REQUIRED", error: "Phiên đăng nhập đã hết hạn." };
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
      if (!can("bookings:checkout")) return { ok: false, code: "FORBIDDEN", error: "Tài khoản không có quyền check-out." };
      const target = stateCache.bookings.find((b) => b.id === bookingId);
      if (!target) return { ok: false, code: "NOT_FOUND", error: "Không tìm thấy đặt phòng." };
      const actor = (session && session.staffName) || "Lễ tân";
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
      if (!can("housekeeping:create")) return { ok: false, code: "FORBIDDEN", error: "Không có quyền tạo yêu cầu dọn phòng." };
      const actor = (session && session.staffName) || "Lễ tân";
      const task = Core.sanitizeHousekeepingTask({ ...payload, status: "dirty", createdBy: actor });
      if (!task) return { ok: false, error: "Thông tin phòng không hợp lệ." };
      const nextTasks = [task, ...stateCache.housekeepingTasks];
      stateCache.housekeepingTasks = nextTasks;
      const metaRes = await upsertPmsMetaKey("housekeeping_v1", { tasks: nextTasks, updatedAt: new Date().toISOString() }, "HK_TASK_CREATE");
      return metaRes.ok ? { ok: true, task, housekeepingTasks: nextTasks } : metaRes;
    }

    async function startHousekeepingTask(taskId) {
      if (!can("housekeeping:execute")) return { ok: false, code: "FORBIDDEN", error: "Không có quyền thực hiện dọn phòng." };
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
      if (!can("housekeeping:execute")) return { ok: false, code: "FORBIDDEN", error: "Không có quyền hoàn tất dọn phòng." };
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
      if (!can("issues:create")) return { ok: false, code: "FORBIDDEN", error: "Không có quyền báo sự cố." };
      const actor = (session && session.staffName) || "Nhân viên";
      const issue = Core.sanitizeMaintenanceIssue({ ...payload, reportedBy: actor });
      if (!issue) return { ok: false, error: "Vui lòng nhập đầy đủ số phòng và mô tả sự cố." };
      const nextIssues = [issue, ...stateCache.maintenanceIssues];
      stateCache.maintenanceIssues = nextIssues;
      const metaRes = await upsertPmsMetaKey("issues_v1", { issues: nextIssues, updatedAt: new Date().toISOString() }, "ISSUE_CREATE");
      return metaRes.ok ? { ok: true, issue, maintenanceIssues: nextIssues } : metaRes;
    }

    async function updateMaintenanceIssue(issueId, patch) {
      if (!can("issues:manage")) return { ok: false, code: "FORBIDDEN", error: "Không có quyền xử lý sự cố." };
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

    function runHealthCheck() {
      const consistency = Core.auditBookingConsistency(stateCache.bookings);
      return {
        ok: consistency.ok && connectionStatus === "connected",
        backend: "supabase",
        realtimeConnected: wsJoined,
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
      getBookings: () => (getCurrentRole() === "housekeeping" ? [] : stateCache.bookings),
      getAuditLogs: () => (getCurrentRole() === "housekeeping" ? [] : stateCache.auditLogs),
      getAutoBackups: () => (getCurrentRole() === "housekeeping" ? [] : stateCache.autoBackups),
      hasRollbackBackup: () => (getCurrentRole() === "housekeeping" ? false : stateCache.hasRollbackBackup),
      getOperatingCosts: () => (getCurrentRole() === "manager" ? stateCache.operatingCosts : null),
      saveOperatingCosts,
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
      listAccounts: async () => ({ ok: true, accounts: getAuthState().accountsPublic }),
      createAccount: async () => ({ ok: false, error: "Tạo tài khoản riêng cho từng nhân viên được quản lý trực tiếp trên máy chủ PMS (SQLite) hoặc Supabase Auth." }),
      updateAccount: async () => ({ ok: false, error: "Cập nhật tài khoản riêng được quản lý trực tiếp trên máy chủ PMS (SQLite) hoặc Supabase Auth." }),
      refreshLatest: () => (getCurrentRole() === "housekeeping" ? [] : stateCache.bookings),
      pullLatest: () => pullLatestFromCloud({ type: "manual_refresh", force: true }),
      saveBooking,
      deleteBooking,
      restoreFromImport,
      rollbackLastChange,
      restoreFromAutoBackup,
      resetToSample,
      runHealthCheck
    };
  }

  root.PMSSupabase = { createSupabaseClient };
})(typeof window !== "undefined" ? window : globalThis);
