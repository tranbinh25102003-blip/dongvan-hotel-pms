/* ==========================================================================
   Dongvan Ville du H'mong Hotel — Supabase Cloud Realtime Adapter
   Zero external CDN dependencies. Uses standard Supabase Auth REST,
   Transactional PostgreSQL RPCs (with RLS), and Realtime WebSocket (Phoenix).
   - STRICT cloud-only mode: NEVER silently falls back to localStorage ledger
     and NEVER claims "Đã lưu" before PostgreSQL commits.
   - Works on static HTTPS hosts (GitHub Pages) across iPhone 4G/5G & PC.
   ========================================================================== */

(function (root) {
  "use strict";

  const Core = root.PMSCore;
  if (!Core) {
    throw new Error("PMSCore (pms-core.js) must load before pms-supabase.js");
  }

  const SESSION_STORAGE_KEY = "ks_pms_supabase_session_v1";

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

    const listeners = new Set();
    const busyChecks = new Set();

    let connectionStatus = "connecting"; // "connected" | "reconnecting" | "offline" | "auth_required"
    let lastSyncedAt = null;
    let storeVersion = 0;

    let session = null; // { access_token, refresh_token, expires_at, staffName }
    let ws = null;
    let wsJoined = false;
    let wsRef = 1;
    let wsHeartbeatTimer = null;
    let wsReconnectTimer = null;
    let wsReconnectAttempt = 0;
    let fallbackPollTimer = null;
    let versionCheckTimer = null;
    let idleUpdateTimer = null;
    let applyingUpdate = false;

    let runningVersion = { appVersion: null, buildId: null };
    let pendingUpdate = null;

    let stateCache = {
      bookings: [],
      auditLogs: [],
      autoBackups: [],
      hasRollbackBackup: false
    };

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
        user: session ? { staffName: session.staffName || "Lễ tân", role: session.staffName === "Quản lý" ? "admin" : "staff" } : null,
        staffList: [...staffList]
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
        lastSyncedAt,
        storeVersion,
        isOnline: connectionStatus === "connected",
        authRequired: true,
        authenticated: Boolean(session && session.access_token),
        user: session ? { staffName: session.staffName || "Lễ tân", role: session.staffName === "Quản lý" ? "admin" : "staff" } : null,
        runningVersion: { ...runningVersion },
        pendingUpdate: pendingUpdate ? { ...pendingUpdate } : null
      };
    }

    function getSnapshot() {
      return {
        bookings: stateCache.bookings,
        auditLogs: stateCache.auditLogs,
        autoBackups: stateCache.autoBackups,
        hasRollbackBackup: stateCache.hasRollbackBackup,
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

    /* -------------------- HTTP & Supabase Auth Helpers -------------------- */

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

    async function ensureValidAccessToken() {
      if (!session || !session.access_token) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      // Refresh 2 minutes before expiry
      if (session.expires_at && session.expires_at - nowSec > 120) {
        return session.access_token;
      }
      if (!session.refresh_token) return session.access_token;
      try {
        const res = await rawFetchJson(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          body: { refresh_token: session.refresh_token },
          timeoutMs: 8000
        });
        if (res.httpOk && res.data && res.data.access_token) {
          const next = {
            access_token: res.data.access_token,
            refresh_token: res.data.refresh_token || session.refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + (Number(res.data.expires_in) || 3600),
            staffName: session.staffName || "Lễ tân"
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
      return session.access_token;
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
      const token = await ensureValidAccessToken();
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
            session.expires_at = 0;
            const refreshed = await ensureValidAccessToken();
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

    function applyCloudState(data, meta = {}) {
      if (!data || !Array.isArray(data.bookings)) return;
      Core.normalizeDormSlots(data.bookings);
      stateCache.bookings = data.bookings;
      if (Array.isArray(data.auditLogs)) stateCache.auditLogs = data.auditLogs;
      if (Array.isArray(data.autoBackups)) stateCache.autoBackups = data.autoBackups;
      if (typeof data.hasRollbackBackup === "boolean") stateCache.hasRollbackBackup = data.hasRollbackBackup;
      if (typeof data.storeVersion === "number") storeVersion = data.storeVersion;
      lastSyncedAt = new Date().toISOString();
      emit({
        type: meta.type || "state",
        remoteEvent: meta.remoteEvent || null,
        state: getSnapshot(),
        status: getStatus()
      });
    }

    async function pullLatestFromCloud(meta = {}) {
      if (!session || !session.access_token) {
        return { ok: false, code: "AUTH_REQUIRED", error: "Cần đăng nhập." };
      }
      const res = await callRpc("pms_get_state", {});
      if (!res || !res.ok) {
        return res || { ok: false, offline: true, code: "NETWORK_OFFLINE", error: "Không thể tải dữ liệu." };
      }
      connectionStatus = "connected";
      applyCloudState(res, meta);
      return { ok: true, bookings: stateCache.bookings, storeVersion };
    }

    /* -------------------- Supabase Realtime WebSocket -------------------- */

    function closeRealtime() {
      wsJoined = false;
      if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
      if (ws) {
        try { ws.onclose = null; ws.onerror = null; ws.close(); } catch {}
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
      if (wsReconnectTimer || !session || !session.access_token) return;
      const delay = Math.min(5000, 700 * Math.pow(1.6, wsReconnectAttempt));
      wsReconnectAttempt += 1;
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectRealtime();
      }, delay);
    }

    function connectRealtime() {
      if (!session || !session.access_token || typeof root.WebSocket !== "function") return;
      closeRealtime();
      const wsBase = baseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
      const wsUrl = `${wsBase}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;

      try {
        const socket = new root.WebSocket(wsUrl);
        ws = socket;

        socket.onopen = () => {
          wsReconnectAttempt = 0;
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
              access_token: session.access_token
            },
            ref: String(++wsRef)
          }));

          wsHeartbeatTimer = setInterval(() => {
            if (socket.readyState === 1) {
              try {
                socket.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++wsRef) }));
              } catch {}
            }
          }, 25000);
        };

        socket.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.event === "phx_reply" && msg.topic === "realtime:pms-sync") {
            if (msg.payload && msg.payload.status === "ok") {
              wsJoined = true;
              connectionStatus = "connected";
              emit({ type: "status", status: getStatus() });
              // Catch up immediately on (re)join in case events happened during disconnect
              pullLatestFromCloud({ type: "remote_change", remoteEvent: { action: "SYNC_CATCHUP" } });
            }
            return;
          }
          if (msg.event === "postgres_changes") {
            const rec = msg.payload && msg.payload.data && msg.payload.data.record;
            const metaVal = rec && rec.key === "store_version" ? rec.value : null;
            const remoteVer = metaVal && typeof metaVal.version === "number" ? metaVal.version : null;
            if (remoteVer === null || remoteVer !== storeVersion) {
              pullLatestFromCloud({
                type: "remote_change",
                remoteEvent: metaVal || { action: "REMOTE_CHANGE" }
              });
            }
          }
        };

        socket.onerror = () => {
          wsJoined = false;
        };

        socket.onclose = () => {
          wsJoined = false;
          if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
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

    function bindWatchers() {
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
        pullLatestFromCloud({ type: "remote_change", remoteEvent: { action: "RECONNECT_SYNC" } });
        connectRealtime();
      });

      root.document.addEventListener("visibilitychange", () => {
        if (root.document.hidden) return;
        checkAppVersion();
        if (!session || !session.access_token) return;
        pullLatestFromCloud({ type: "remote_change", remoteEvent: { action: "RESUME_SYNC" } });
        if (!ws || ws.readyState !== 1) connectRealtime();
      });

      // Fallback safety catch-up ONLY when WebSocket is not currently joined
      if (!fallbackPollTimer) {
        fallbackPollTimer = setInterval(() => {
          if (!root.document.hidden && navigator.onLine !== false && session && session.access_token && !wsJoined) {
            pullLatestFromCloud({ type: "remote_change", remoteEvent: { action: "FALLBACK_SYNC" } });
          }
        }, 12000);
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
      const pulled = await pullLatestFromCloud({ type: "init" });
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
        const pulled = await pullLatestFromCloud({ type: "auth_login" });
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
      stateCache = { bookings: [], auditLogs: [], autoBackups: [], hasRollbackBackup: false };
      storeVersion = 0;
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
      await pullLatestFromCloud({ type: "local_commit" });
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
        if (rpcRes && rpcRes.code === "CONFLICT_STALE_EDIT") {
          await pullLatestFromCloud({ type: "conflict_refresh" });
        }
        return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Xóa thất bại." };
      }
      await pullLatestFromCloud({ type: "local_commit" });
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
      await pullLatestFromCloud({ type: "local_commit" });
      return { ...rpcRes, bookings: stateCache.bookings };
    }

    async function rollbackLastChange() {
      const rpcRes = await callRpc("pms_rollback_last", {
        p_actor_name: (session && session.staffName) || ""
      });
      if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Hoàn tác thất bại." };
      await pullLatestFromCloud({ type: "local_commit" });
      return { ...rpcRes, bookings: stateCache.bookings };
    }

    async function restoreFromAutoBackup(snapshotId) {
      const rpcRes = await callRpc("pms_restore_autobackup", {
        p_snapshot_id: snapshotId,
        p_actor_name: (session && session.staffName) || ""
      });
      if (!rpcRes || !rpcRes.ok) return rpcRes || { ok: false, code: "SERVER_ERROR", error: "Khôi phục mốc sao lưu thất bại." };
      await pullLatestFromCloud({ type: "local_commit" });
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
      await pullLatestFromCloud({ type: "local_commit" });
      return { ...rpcRes, bookings: stateCache.bookings };
    }

    function runHealthCheck() {
      const consistency = Core.auditBookingConsistency(stateCache.bookings);
      return {
        ok: consistency.ok && connectionStatus === "connected",
        backend: "supabase",
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
      login,
      logout,
      getStatus,
      getSnapshot,
      getBookings: () => stateCache.bookings,
      getAuditLogs: () => stateCache.auditLogs,
      getAutoBackups: () => stateCache.autoBackups,
      hasRollbackBackup: () => stateCache.hasRollbackBackup,
      refreshLatest: () => stateCache.bookings,
      pullLatest: () => pullLatestFromCloud({ type: "manual_refresh" }),
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
