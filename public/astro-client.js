/* Biblija 365 — Astro SSG + Cloudflare D1 / Local SQLite Multi-Device Client Controller */
(function () {
  const CRO_MAP = {
    "č": "c", "ć": "c", "ž": "z", "š": "s", "đ": "d",
    "Č": "c", "Ć": "c", "Ž": "z", "Š": "s", "Đ": "d",
  };

  function foldHr(str) {
    if (!str) return "";
    return String(str)
      .replace(/[čćžšđČĆŽŠĐ]/g, (m) => CRO_MAP[m] || m)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Lucide ikona iz /icons.svg (scripts/build_icons.mjs skuplja imena iz ic("...") poziva)
  function ic(name) {
    const cls = name === "loader-circle" ? "icon icon-spin" : "icon";
    return `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="/icons.svg#${name}"/></svg>`;
  }

  function iconLabel(el, name, text) {
    if (!el) return;
    el.innerHTML = ic(name);
    const span = document.createElement("span");
    span.className = "btn-text";
    span.textContent = text;
    el.appendChild(span);
  }

  function readJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  const state = {
    hasSqliteServer: false,
    syncEnabledServer: false,
    books: null,
    booksByOrder: {},
    loadedPlans: {},
    compactVersesCache: null,
    currentPlanId: localStorage.getItem("biblija_plan_id") || "mb-tematski-365",
    dayFilter: "all",
    daySearch: "",
    bookmarkFilter: "all",
    progress: JSON.parse(localStorage.getItem("biblija_progress") || "{}"),
    bookmarks: JSON.parse(localStorage.getItem("biblija_bookmarks") || "{}"),
    activePlanDayContext: JSON.parse(sessionStorage.getItem("biblija_active_day_ctx") || "null"),
    selectedVerseContext: null,
    fontSize: parseInt(localStorage.getItem("biblija_fontsize") || "19", 10),
    theme: localStorage.getItem("biblija_theme") || "light",
    readingMode: localStorage.getItem("biblija_reading_mode") || "paragraphs",
    translation: localStorage.getItem("biblija_translation") || "ks",
    syncAuth: JSON.parse(localStorage.getItem("biblija_sync_auth") || "null"),
    savedProfiles: JSON.parse(localStorage.getItem("biblija_saved_profiles") || "[]"),
    lastSyncedAt: localStorage.getItem("biblija_last_synced_at") || null,
    linear: readJson("biblija_linear", null),
    readingLog: readJson("biblija_reading_log", []),
    logDirty: new Set(readJson("biblija_log_dirty", [])),
    isSyncing: false,
    uiRefreshCallbacks: [],
  };

  function isDayDone(planId, dayNum) {
    const planMap = state.progress[planId];
    if (!planMap) return false;
    const entry = planMap[String(dayNum)];
    if (!entry) return false;
    if (typeof entry === "string") return true;
    if (typeof entry === "object") return Boolean(entry.completed);
    return Boolean(entry);
  }

  function getActiveBookmark(key) {
    const bm = state.bookmarks[key];
    if (!bm || bm.deleted) return null;
    return bm;
  }

  function getActiveBookmarksList() {
    return Object.entries(state.bookmarks)
      .filter(([, bm]) => bm && !bm.deleted)
      .map(([key, bm]) => ({ ...bm, _key: key }))
      .sort((a, b) =>
        String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))
      );
  }

  function countTotalCompletedDays() {
    let total = 0;
    for (const planId of Object.keys(state.progress)) {
      const daysMap = state.progress[planId] || {};
      for (const d of Object.keys(daysMap)) {
        if (isDayDone(planId, d)) total++;
      }
    }
    return total;
  }

  function touchMetaTimestamp() {
    const now = new Date().toISOString();
    localStorage.setItem("biblija_meta_updated_at", now);
    return now;
  }

  /* ==================== DNEVNIK ČITANJA I LINEARNO ČITANJE ====================
     Linearni kursor (`biblija_linear`) je mjesto do kojeg se čita redom: pomiče se samo kad se otvori
     isto ili sljedeće poglavlje, ili kad ga korisnik sam postavi. Dnevnik (`biblija_reading_log`) pamti
     svaki posjet poglavlju (redak do kojeg se stiglo, početak i kraj, uređaj) i šalje se serveru
     inkrementalno: samo zapisi iz `biblija_log_dirty`, a natrag dolazi sve od `biblija_log_cursor`. */
  const CHAPTER_URL_RE = /^\/[a-z0-9-]{1,60}\/\d{1,3}\/$/;
  // Isto poglavlje otvoreno ponovno unutar ovog vremena nastavlja postojeći zapis umjesto novog.
  const LOG_CONTINUE_MS = 30 * 60 * 1000;
  const MAX_LOG_PER_SYNC = 500;
  let logSyncTimer = null;

  // Stari klijenti pamtili su samo zadnje otvoreno poglavlje; ono postaje početni kursor
  // s najstarijim mogućim vremenom, da ne pregazi kursor koji je već na serveru.
  if (!state.linear) {
    const lastUrl = localStorage.getItem("biblija_last_url");
    if (lastUrl && CHAPTER_URL_RE.test(lastUrl)) {
      state.linear = {
        url: lastUrl,
        label: localStorage.getItem("biblija_last_label") || "",
        verse: 0,
        updated_at: "1970-01-01T00:00:00.001Z",
      };
      saveLinear();
    }
  }

  function saveLinear() {
    localStorage.setItem("biblija_linear", JSON.stringify(state.linear));
  }

  function setLinear(url, label, verse) {
    state.linear = { url, label, verse: verse || 0, updated_at: new Date().toISOString() };
    saveLinear();
  }

  /* Veza kursora i plana „Biblija 365 — Kanonski redom": samo taj plan ide redom kao kursor, pa se dani
     prije kursora mogu označiti pročitanima. Uvijek uz potvrdu, nikad tiho, i nikad se ne poništava. */
  const CANON_PLAN_ID = "biblija-365-kanonski";

  async function loadPlanJson(planId) {
    if (!state.loadedPlans[planId]) {
      const res = await fetch(`/data/json/plans/${planId}.json`);
      state.loadedPlans[planId] = await res.json();
    }
    return state.loadedPlans[planId];
  }

  /** (book_order, chapter) mjesta u kanonu kao jedan broj; Proslov je poglavlje 0. */
  function canonPos(bookOrder, chapter) {
    return bookOrder * 1000 + chapter;
  }

  async function linearCanonPos(lin) {
    const m = lin && lin.url ? lin.url.match(/^\/([a-z0-9-]+)\/(\d+)\/$/) : null;
    if (!m) return null;
    const books = await ensureBooksLoaded();
    const b = books.find((x) => x.id === m[1]);
    return b ? canonPos(b.order, Number(m[2])) : null;
  }

  /** Kraj dana: zadnje poglavlje zadnjeg čitanja. */
  function dayEndPos(day) {
    let end = -1;
    for (const r of day.readings || []) end = Math.max(end, canonPos(r.book_order, r.chapter_end));
    return end;
  }

  /**
   * Nakon pomaka kursora ponudi označavanje dana kanonskog plana koji završavaju prije kursora.
   * Ručno postavljanje nudi sve neoznačene dane prije kursora; linearno čitanje samo dane koje je
   * ovaj pomak završio (kraj u [stari kursor, novi kursor)), da odbijeni dani ne iskaču ponovno.
   */
  async function offerPlanCatchUp(prevLinear, manual) {
    if (state.currentPlanId !== CANON_PLAN_ID || !state.linear) return;
    try {
      const to = await linearCanonPos(state.linear);
      if (to === null) return;
      const from = manual ? -1 : await linearCanonPos(prevLinear);
      if (from === null || from >= to) return;
      const plan = await loadPlanJson(CANON_PLAN_ID);
      const days = plan.days.filter((d) => {
        const end = dayEndPos(d);
        return end < to && end >= from && !isDayDone(plan.id, d.day);
      });
      if (days.length) showPlanCatchUp(plan, days);
    } catch (_) {}
  }

  function showPlanCatchUp(plan, days) {
    document.getElementById("planCatchUpToast")?.remove();
    const first = days[0];
    const last = days[days.length - 1];
    const place = (state.linear.label.match(/\(([^)]+)\)$/) || [])[1] || state.linear.label;
    const text =
      days.length === 1
        ? `Označiti ${first.day}. dan (${escapeHtml(first.label)}) pročitanim?`
        : `Označiti pročitanim ${days.length} dana, od ${first.day}. do ${last.day}. (prije ${escapeHtml(place)})?`;
    const box = document.createElement("div");
    box.id = "planCatchUpToast";
    box.className = "plan-catchup-toast";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-live", "polite");
    box.innerHTML = `
      <div class="plan-catchup-info">
        <span class="linear-return-kicker">${ic("calendar-check")}Biblija 365 — Kanonski redom</span>
        <span class="plan-catchup-text">${text}</span>
      </div>
      <div class="linear-return-actions">
        <button type="button" class="icon-btn btn-accent" data-catchup="yes">${ic("check")}<span class="btn-text">Označi</span></button>
        <button type="button" class="icon-btn" data-catchup="no">${ic("x")}<span class="btn-text">Ne</span></button>
      </div>`;
    box.querySelector('[data-catchup="yes"]').addEventListener("click", () => {
      for (const d of days) {
        if (!isDayDone(plan.id, d.day)) togglePlanDayCompleted(plan.id, d.day, true);
      }
      box.remove();
      triggerAllUiRefresh();
    });
    box.querySelector('[data-catchup="no"]').addEventListener("click", () => box.remove());
    document.body.appendChild(box);
  }

  function saveReadingLog() {
    localStorage.setItem("biblija_reading_log", JSON.stringify(state.readingLog));
    localStorage.setItem("biblija_log_dirty", JSON.stringify([...state.logDirty]));
  }

  function findLogIndex(id) {
    for (let i = state.readingLog.length - 1; i >= 0; i--) {
      if (state.readingLog[i].id === id) return i;
    }
    return -1;
  }

  function upsertLogEntry(entry) {
    const i = findLogIndex(entry.id);
    if (i >= 0) state.readingLog[i] = entry;
    else state.readingLog.push(entry);
    state.logDirty.add(entry.id);
  }

  /** Zapisi sa servera: LWW po id-u, lokalni pobjeđuje samo ako je strogo noviji. */
  function mergeServerLog(entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const byId = new Map(state.readingLog.map((e, i) => [e.id, i]));
    for (const e of entries) {
      const i = byId.get(e.id);
      if (i === undefined) {
        byId.set(e.id, state.readingLog.length);
        state.readingLog.push(e);
      } else if (!(state.readingLog[i].updated_at > e.updated_at)) {
        state.readingLog[i] = e;
      }
    }
    state.readingLog.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  }

  function newLogId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function deviceLabel() {
    const ua = navigator.userAgent || "";
    if (/iPhone/.test(ua)) return "Web · iPhone";
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "Web · iPad";
    if (/Android/.test(ua)) return "Web · Android";
    if (/Macintosh/.test(ua)) return "Web · Mac";
    if (/Windows/.test(ua)) return "Web · Windows";
    if (/Linux/.test(ua)) return "Web · Linux";
    return "Web";
  }

  /** Poveznica koja otvara poglavlje na retku (#od-N postavlja redak na vrh, ne u sredinu). */
  function resumeHref(url, verse) {
    return verse > 1 ? `${url}#od-${verse}` : url;
  }

  function placeLabel(label, verse) {
    return verse > 1 ? `${label} · redak ${verse}` : label;
  }

  function scheduleLogSync() {
    if (!state.syncAuth || !state.syncAuth.user_key) return;
    clearTimeout(logSyncTimer);
    logSyncTimer = setTimeout(() => syncWithServer({ silent: true }), 4000);
  }

  function applyThemeAndFont() {
    document.documentElement.setAttribute("data-theme", state.theme);
    document.documentElement.setAttribute("data-reading-mode", state.readingMode);
    document.documentElement.style.setProperty("--font-size-reading", `${state.fontSize}px`);
    localStorage.setItem("biblija_theme", state.theme);
    localStorage.setItem("biblija_fontsize", String(state.fontSize));
    localStorage.setItem("biblija_reading_mode", state.readingMode);

    const fsInd = document.getElementById("fontSizeIndicator");
    if (fsInd) fsInd.textContent = String(state.fontSize);

    const themeIcon = document.getElementById("themeToggleIcon");
    const themeLbl = document.getElementById("themeToggleLabel");
    const themeMeta = {
      light: { icon: ic("sun"), label: "Svijetla" },
      sepia: { icon: ic("scroll-text"), label: "Sepia" },
      dark: { icon: ic("moon"), label: "Tamna" },
    }[state.theme] || { icon: ic("sun"), label: "Tema" };
    if (themeIcon) themeIcon.innerHTML = themeMeta.icon;
    if (themeLbl) themeLbl.textContent = themeMeta.label;

    const rmBtn = document.getElementById("btnReadingModeToggle");
    if (rmBtn) {
      if (state.readingMode === "verses") iconLabel(rmBtn, "list", "Stih po stih");
      else iconLabel(rmBtn, "pilcrow", "Knjiški odlomci");
    }
  }

  async function ensureBooksLoaded() {
    if (state.books) return state.books;
    const res = await fetch("/data/json/books.json");
    state.books = await res.json();
    for (const b of state.books) {
      state.booksByOrder[b.order] = b;
    }
    return state.books;
  }

  async function detectServer() {
    const pill = document.getElementById("engineStatusText") || document.getElementById("engineStatusPill");
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.ok) {
        const info = await res.json();
        state.syncEnabledServer = Boolean(info && info.sync_enabled);
        if (info && info.mode === "sqlite-server") {
          state.hasSqliteServer = true;
          if (pill) pill.textContent = "Astro + SQLite FTS5 + Sync";
          return;
        }
        if (info && info.mode === "cloudflare-d1") {
          if (pill) pill.textContent = "Cloudflare Edge + D1 Sync";
          return;
        }
      }
    } catch (_) {}
    if (pill) pill.textContent = "Astro SSG (Edge / Offline)";
  }

  /* ==================== MULTI-DEVICE CLOUD SYNC & PROFILE SWITCHER ==================== */
  let syncDebounceTimer = null;
  let syncAgain = false;

  /* Realtime: dok je kartica vidljiva drži WebSocket na /api/live; na "changed" povuci /api/sync.
     clientId je po kartici, da Worker obavijest ne vrati kartici koja je promjenu poslala. */
  const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const live = { ws: null, room: null, retry: 0, timer: null, ping: null };

  function connectLive() {
    const room = localStorage.getItem("biblija_live_room");
    if (!room || !state.syncAuth || document.visibilityState !== "visible") return;
    if (live.ws && live.room === room && live.ws.readyState <= 1) return;
    closeLive();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/live?room=${room}&client=${clientId}`);
    } catch (_) {
      return;
    }
    live.ws = ws;
    live.room = room;
    ws.onopen = () => {
      live.retry = 0;
      live.ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), 30000);
    };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {}
      if (msg && msg.type === "changed") syncWithServer({ silent: true });
    };
    ws.onclose = () => {
      clearInterval(live.ping);
      if (live.ws !== ws) return;
      live.ws = null;
      if (document.visibilityState === "visible" && state.syncAuth) {
        const delay = Math.min(30000, 1000 * 2 ** live.retry++);
        live.timer = setTimeout(connectLive, delay);
      }
    };
  }

  function closeLive() {
    clearTimeout(live.timer);
    const ws = live.ws;
    live.ws = null;
    live.room = null;
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
    }
  }

  function saveProfileToDeviceList(authObj) {
    if (!authObj || !authObj.user_key || !authObj.pin) return;
    const list = state.savedProfiles.filter((p) => p && p.user_key !== authObj.user_key);
    list.unshift({
      user_key: authObj.user_key,
      display_name: authObj.display_name || authObj.user_key,
      pin: authObj.pin,
      saved_at: new Date().toISOString(),
    });
    state.savedProfiles = list.slice(0, 8);
    localStorage.setItem("biblija_saved_profiles", JSON.stringify(state.savedProfiles));
  }

  function removeProfileFromDeviceList(userKey) {
    state.savedProfiles = state.savedProfiles.filter((p) => p && p.user_key !== userKey);
    localStorage.setItem("biblija_saved_profiles", JSON.stringify(state.savedProfiles));
    renderSavedProfilesSwitcher();
  }

  function resetLocalUserData() {
    state.progress = {};
    state.bookmarks = {};
    state.lastSyncedAt = null;
    localStorage.removeItem("biblija_progress");
    localStorage.removeItem("biblija_bookmarks");
    localStorage.removeItem("biblija_last_url");
    localStorage.removeItem("biblija_last_label");
    localStorage.removeItem("biblija_meta_updated_at");
    localStorage.removeItem("biblija_last_synced_at");
    localStorage.removeItem("biblija_live_room");
    state.linear = null;
    state.readingLog = [];
    state.logDirty = new Set();
    localStorage.removeItem("biblija_linear");
    localStorage.removeItem("biblija_reading_log");
    localStorage.removeItem("biblija_log_dirty");
    localStorage.removeItem("biblija_log_cursor");
    closeLive();
  }

  function triggerAllUiRefresh() {
    for (const cb of state.uiRefreshCallbacks) {
      try {
        cb();
      } catch (_) {}
    }
  }

  function scheduleCloudSync() {
    if (!state.syncAuth || !state.syncAuth.user_key || !state.syncAuth.pin) return;
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
      syncWithServer({ silent: true });
    }, 350);
  }

  function updateSyncHeaderUI() {
    const btn = document.getElementById("btnOpenSyncModal");
    const lbl = document.getElementById("syncBtnLabel");
    if (!btn || !lbl) return;

    if (state.syncAuth && state.syncAuth.user_key) {
      btn.classList.add("synced");
      iconLabel(lbl, state.isSyncing ? "refresh-cw" : "user-round", `@${state.syncAuth.user_key}`);
      lbl.classList.toggle("is-spinning", Boolean(state.isSyncing));
    } else {
      btn.classList.remove("synced");
      iconLabel(lbl, "user-round", "Prijava / Sync");
      lbl.classList.remove("is-spinning");
    }
  }

  function renderSavedProfilesSwitcher() {
    const box = document.getElementById("syncSavedProfilesSection");
    const listEl = document.getElementById("syncSavedProfilesList");
    if (!box || !listEl) return;

    if (!state.savedProfiles || state.savedProfiles.length === 0) {
      box.style.display = "none";
      return;
    }

    box.style.display = "block";
    const curKey = state.syncAuth ? state.syncAuth.user_key : null;

    listEl.innerHTML = state.savedProfiles
      .map((p) => {
        const isAct = p.user_key === curKey;
        return `
          <div class="saved-profile-chip ${isAct ? "active" : ""}">
            <span class="saved-profile-switch" data-switch-key="${escapeHtml(p.user_key)}" title="Prebaci na profil @${escapeHtml(p.user_key)}">
              ${isAct ? ic("circle-check") : ic("user-round")}@${escapeHtml(p.user_key)}
            </span>
            <button type="button" class="saved-profile-remove" data-remove-key="${escapeHtml(p.user_key)}" title="Ukloni spremljeni profil s ovog uređaja" aria-label="Ukloni profil">${ic("x")}</button>
          </div>
        `;
      })
      .join("");

    listEl.querySelectorAll("[data-switch-key]").forEach((el) => {
      el.addEventListener("click", async () => {
        const targetKey = el.getAttribute("data-switch-key");
        const found = state.savedProfiles.find((x) => x.user_key === targetKey);
        if (!found) return;
        if (state.syncAuth && state.syncAuth.user_key === found.user_key) {
          await syncWithServer({ silent: false });
          return;
        }
        // Clean local state before switching to another user so data never bleeds across users
        resetLocalUserData();
        state.syncAuth = {
          user_key: found.user_key,
          display_name: found.display_name || found.user_key,
          pin: found.pin,
        };
        localStorage.setItem("biblija_sync_auth", JSON.stringify(state.syncAuth));
        updateSyncHeaderUI();
        updateSyncModalViews();
        await syncWithServer({ silent: true });
      });
    });

    listEl.querySelectorAll("[data-remove-key]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const k = btn.getAttribute("data-remove-key");
        removeProfileFromDeviceList(k);
      });
    });
  }

  function updateSyncModalViews() {
    const outView = document.getElementById("syncLoggedOutView");
    const inView = document.getElementById("syncLoggedInView");
    if (!outView || !inView) return;

    renderSavedProfilesSwitcher();

    if (state.syncAuth && state.syncAuth.user_key) {
      outView.style.display = "none";
      inView.style.display = "block";
      document.getElementById("syncActiveUserBadge").textContent = `@${state.syncAuth.user_key}`;
      const lastTime = state.lastSyncedAt
        ? new Date(state.lastSyncedAt).toLocaleString("hr-HR")
        : "upravo sada";
      document.getElementById("syncLastTimeLabel").textContent = `Zadnja sinkronizacija: ${lastTime}`;

      const completedDays = countTotalCompletedDays();
      const bmCount = getActiveBookmarksList().length;
      const lastLbl = localStorage.getItem("biblija_last_label") || "Knjiga Postanka (Post 1)";
      document.getElementById("syncStatsSummary").innerHTML = `
        <div>${ic("calendar-check")}<span>Pročitanih dana u planovima</span><strong>${completedDays}</strong></div>
        <div>${ic("bookmark")}<span>Spremljenih oznaka i bilješki</span><strong>${bmCount}</strong></div>
        <div>${ic("book-open")}<span>Zadnje čitano</span><strong>${escapeHtml(lastLbl)}</strong></div>
      `;
    } else {
      outView.style.display = "block";
      inView.style.display = "none";
    }
  }

  async function syncWithServer(opts = {}) {
    if (state.isSyncing) {
      // npr. realtime obavijest stigla usred synca: ponovi kad ovaj završi
      syncAgain = true;
      return false;
    }
    const ok = await syncOnce(opts);
    if (syncAgain) {
      syncAgain = false;
      return syncWithServer({ silent: true });
    }
    return ok;
  }

  async function syncOnce({ silent = false, keepalive = false } = {}) {
    if (!state.syncAuth || !state.syncAuth.user_key || !state.syncAuth.pin) return false;

    state.isSyncing = true;
    updateSyncHeaderUI();
    clearTimeout(logSyncTimer);

    try {
      const sentLog = state.readingLog.filter((e) => state.logDirty.has(e.id)).slice(0, MAX_LOG_PER_SYNC);
      const sentVersions = new Map(sentLog.map((e) => [e.id, e.updated_at]));
      const payload = {
        user_key: state.syncAuth.user_key,
        pin: state.syncAuth.pin,
        client_id: clientId,
        meta: {
          active_plan_id: state.currentPlanId,
          last_url: localStorage.getItem("biblija_last_url") || "/",
          last_label: localStorage.getItem("biblija_last_label") || "",
          last_updated_at: localStorage.getItem("biblija_meta_updated_at") || "1970-01-01T00:00:00.000Z",
        },
        progress: state.progress,
        bookmarks: state.bookmarks,
        linear: state.linear,
        log: sentLog,
        log_since: localStorage.getItem("biblija_log_cursor") || "",
      };

      const body = JSON.stringify(payload);
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        // pri zatvaranju kartice zahtjev mora preživjeti; preglednik dopušta keepalive tijelo do 64 KB
        keepalive: keepalive && body.length < 60000,
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (!silent) {
          alert(data.error || "Pogreška pri sinkronizaciji.");
        }
        state.isSyncing = false;
        updateSyncHeaderUI();
        return false;
      }

      if (data.progress) {
        state.progress = data.progress;
        localStorage.setItem("biblija_progress", JSON.stringify(state.progress));
      }
      if (data.bookmarks) {
        state.bookmarks = data.bookmarks;
        localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
      }
      if (data.meta) {
        if (data.meta.active_plan_id) {
          state.currentPlanId = data.meta.active_plan_id;
          localStorage.setItem("biblija_plan_id", state.currentPlanId);
        }
        if (data.meta.last_url) {
          localStorage.setItem("biblija_last_url", data.meta.last_url);
        }
        if (data.meta.last_label) {
          localStorage.setItem("biblija_last_label", data.meta.last_label);
        }
        if (data.meta.last_updated_at) {
          localStorage.setItem("biblija_meta_updated_at", data.meta.last_updated_at);
        }
      }

      // Server bez dnevnika (stari server.py) ne vraća log_cursor: tada zapisi ostaju za idući put.
      if (data.log_cursor) {
        if (data.linear && (!state.linear || !(state.linear.updated_at > data.linear.updated_at))) {
          state.linear = data.linear;
          saveLinear();
        }
        mergeServerLog(data.log);
        for (const [id, ver] of sentVersions) {
          const i = findLogIndex(id);
          if (i < 0 || state.readingLog[i].updated_at === ver) state.logDirty.delete(id);
        }
        saveReadingLog();
        localStorage.setItem("biblija_log_cursor", data.log_cursor);
        if (state.logDirty.size > 0) scheduleLogSync();
      }

      state.lastSyncedAt = data.synced_at || new Date().toISOString();
      localStorage.setItem("biblija_last_synced_at", state.lastSyncedAt);
      if (data.live_room) {
        localStorage.setItem("biblija_live_room", data.live_room);
        connectLive();
      }

      state.isSyncing = false;
      updateSyncHeaderUI();
      updateSyncModalViews();
      triggerAllUiRefresh();
      return true;
    } catch (_) {
      state.isSyncing = false;
      updateSyncHeaderUI();
      return false;
    }
  }

  function initSyncModal() {
    const overlay = document.getElementById("syncModalOverlay");
    const openBtn = document.getElementById("btnOpenSyncModal");
    const closeBtn = document.getElementById("btnCloseSyncModal");
    if (!overlay || !openBtn) return;

    if (state.syncAuth && state.syncAuth.user_key) {
      saveProfileToDeviceList(state.syncAuth);
    }

    updateSyncHeaderUI();

    openBtn.addEventListener("click", () => {
      updateSyncModalViews();
      overlay.classList.add("open");
    });

    closeBtn.addEventListener("click", () => {
      overlay.classList.remove("open");
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("open");
    });

    const pinToggleBtn = document.getElementById("btnTogglePinVisibility");
    const pinInputEl = document.getElementById("syncPinInput");
    if (pinToggleBtn && pinInputEl) {
      pinToggleBtn.addEventListener("click", () => {
        pinInputEl.type = pinInputEl.type === "password" ? "text" : "password";
        const pinVisible = pinInputEl.type === "text";
        pinToggleBtn.innerHTML = ic(pinVisible ? "eye-off" : "eye");
      });
    }

    const genBtn = document.getElementById("btnGenerateSyncKey");
    if (genBtn) {
      genBtn.addEventListener("click", () => {
        const words = ["psalam", "svjetlo", "rijec", "put", "istina", "mir", "zrno", "stijena", "izvor"];
        const w = words[Math.floor(Math.random() * words.length)];
        const num = Math.floor(1000 + Math.random() * 9000);
        document.getElementById("syncUserKeyInput").value = `${w}-${num}`;
        const pinEl = document.getElementById("syncPinInput");
        if (!pinEl.value) {
          pinEl.type = "text";
          pinEl.value = String(Math.floor(1000 + Math.random() * 9000));
        }
      });
    }

    const connectBtn = document.getElementById("btnConnectSync");
    if (connectBtn) {
      connectBtn.addEventListener("click", async () => {
        const rawKey = document.getElementById("syncUserKeyInput").value.trim();
        const pin = document.getElementById("syncPinInput").value.trim();
        const msgEl = document.getElementById("syncAuthMessage");

        function showMsg(txt, isErr = true) {
          msgEl.style.display = "block";
          msgEl.style.background = isErr ? "var(--danger-soft)" : "var(--success-soft)";
          msgEl.style.color = isErr ? "var(--danger)" : "var(--success)";
          msgEl.textContent = txt;
        }

        if (rawKey.length < 3) {
          return showMsg("Korisničko ime / Sync kod mora imati barem 3 znaka.");
        }
        if (pin.length < 4) {
          return showMsg("PIN mora imati barem 4 znaka.");
        }

        connectBtn.disabled = true;
        iconLabel(connectBtn, "loader-circle", "Povezivanje i sinkronizacija...");
        msgEl.style.display = "none";

        try {
          const authRes = await fetch("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_key: rawKey, pin }),
          });
          const authData = await authRes.json();
          if (!authRes.ok || !authData.ok) {
            connectBtn.disabled = false;
            iconLabel(connectBtn, "cloud-upload", "Poveži uređaj i sinkroniziraj");
            return showMsg(authData.error || "Neuspješna prijava.");
          }

          state.syncAuth = {
            user_key: authData.user_key,
            display_name: authData.display_name || authData.user_key,
            pin,
          };
          localStorage.setItem("biblija_sync_auth", JSON.stringify(state.syncAuth));
          saveProfileToDeviceList(state.syncAuth);

          await syncWithServer({ silent: true });

          connectBtn.disabled = false;
          iconLabel(connectBtn, "cloud-upload", "Poveži uređaj i sinkroniziraj");
          updateSyncHeaderUI();
          updateSyncModalViews();
        } catch (_) {
          connectBtn.disabled = false;
          iconLabel(connectBtn, "cloud-upload", "Poveži uređaj i sinkroniziraj");
          showMsg("Server za sinkronizaciju trenutno nije dostupan.");
        }
      });
    }

    const syncNowBtn = document.getElementById("btnSyncNow");
    if (syncNowBtn) {
      syncNowBtn.addEventListener("click", async () => {
        iconLabel(syncNowBtn, "loader-circle", "Sinkroniziram...");
        await syncWithServer({ silent: false });
        iconLabel(syncNowBtn, "check", "Sinkronizirano!");
        setTimeout(() => {
          iconLabel(syncNowBtn, "refresh-cw", "Sinkroniziraj sada");
        }, 1200);
      });
    }

    const copyBtn = document.getElementById("btnCopySyncInfo");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        if (!state.syncAuth) return;
        const text = `Biblija 365 Sync podaci:\nURL: ${window.location.origin}\nSync kod (korisničko ime): ${state.syncAuth.user_key}\nPIN: ${state.syncAuth.pin}`;
        navigator.clipboard.writeText(text);
        iconLabel(copyBtn, "check", "Kopirano u međuspremnik!");
        setTimeout(() => {
          iconLabel(copyBtn, "copy", "Kopiraj podatke za povezivanje drugog uređaja");
        }, 1500);
      });
    }

    const logoutBtn = document.getElementById("btnLogoutSync");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => {
        state.syncAuth = null;
        localStorage.removeItem("biblija_sync_auth");
        resetLocalUserData();
        const keyInput = document.getElementById("syncUserKeyInput");
        const pinInput = document.getElementById("syncPinInput");
        if (keyInput) keyInput.value = "";
        if (pinInput) pinInput.value = "";
        updateSyncHeaderUI();
        updateSyncModalViews();
        triggerAllUiRefresh();
      });
    }

    // Auto-sync on startup & when switching back to tab on mobile/laptop
    if (state.syncAuth && state.syncAuth.user_key) {
      syncWithServer({ silent: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.syncAuth && state.syncAuth.user_key) {
        syncWithServer({ silent: true });
      } else if (document.visibilityState === "hidden") {
        closeLive();
      }
    });
  }

  /* ==================== READER ENHANCEMENTS ==================== */
  function initReaderPage() {
    const root = document.getElementById("readerRoot");
    if (!root) return;

    const bookOrder = parseInt(root.getAttribute("data-book-order"), 10);
    const bookId = root.getAttribute("data-book-id");
    const bookAbbr = root.getAttribute("data-book-abbr");
    const bookTitle = root.getAttribute("data-book-title");
    const chapter = parseInt(root.getAttribute("data-chapter"), 10);
    const prevUrl = root.getAttribute("data-prev-url") || "";
    const nextUrl = root.getAttribute("data-next-url") || "";

    // Scroll active book item into view inside sidebar on desktop
    const activeBookEl = document.querySelector("#bookListContainer .book-item.active");
    if (activeBookEl && window.innerWidth > 960) {
      setTimeout(() => {
        activeBookEl.scrollIntoView({ block: "nearest" });
      }, 60);
    }

    // Mobile Drawer Open/Close
    const drawer = document.getElementById("bookSidebarDrawer");
    const backdrop = document.getElementById("bookDrawerBackdrop");
    const btnOpenDrawer = document.getElementById("btnOpenBookDrawer");
    const btnCloseDrawer = document.getElementById("btnCloseBookDrawer");

    function closeBookDrawer() {
      if (drawer) drawer.classList.remove("open");
      if (backdrop) backdrop.classList.remove("open");
    }

    if (btnOpenDrawer && drawer && backdrop) {
      btnOpenDrawer.addEventListener("click", () => {
        drawer.classList.add("open");
        backdrop.classList.add("open");
        if (activeBookEl) {
          setTimeout(() => activeBookEl.scrollIntoView({ block: "center" }), 80);
        }
      });
      backdrop.addEventListener("click", closeBookDrawer);
    }
    if (btnCloseDrawer) {
      btnCloseDrawer.addEventListener("click", closeBookDrawer);
    }

    // Reading mode toggle (Paragraphs vs Verses)
    const rmToggleBtn = document.getElementById("btnReadingModeToggle");
    if (rmToggleBtn) {
      rmToggleBtn.addEventListener("click", () => {
        state.readingMode = state.readingMode === "paragraphs" ? "verses" : "paragraphs";
        applyThemeAndFont();
      });
    }

    /* Drugi prijevod: Katančić (Budim 1831.) iz data/json/katancic/, po knjizi. Oznake, bilješke,
       plan i dnevnik ostaju na retcima KS-a; Katančić se poravnava po broju retka i samo se prikazuje. */
    const TRANSLATIONS = ["ks", "parallel", "katancic"];
    const trBtn = document.getElementById("btnTranslationToggle");
    const altBody = document.getElementById("altChapterBody");
    const altNotice = document.getElementById("altNotice");
    const ksBody = document.getElementById("chapterBody");
    let katancicBook; // undefined = nije učitano, null = FOI nema knjigu

    async function loadKatancicBook() {
      if (katancicBook !== undefined) return katancicBook;
      try {
        const res = await fetch(`/data/json/katancic/${String(bookOrder).padStart(2, "0")}_${bookId}.json`);
        katancicBook = res.ok ? await res.json() : null;
      } catch {
        katancicBook = null;
      }
      return katancicBook;
    }

    function showAltNotice(text) {
      altNotice.textContent = text;
      altNotice.hidden = !text;
    }

    function altVerseEl(tag, cls, verse, text) {
      const el = document.createElement(tag);
      el.className = cls;
      el.setAttribute("data-verse", verse);
      const sup = document.createElement("sup");
      sup.className = "verse-sup";
      sup.textContent = verse;
      el.append(sup, document.createTextNode(text));
      return el;
    }

    function clearParallel() {
      ksBody.querySelectorAll(".alt-verse, .alt-extra").forEach((el) => el.remove());
    }

    async function applyTranslation() {
      const mode = TRANSLATIONS.includes(state.translation) ? state.translation : "ks";
      localStorage.setItem("biblija_translation", mode);
      document.documentElement.setAttribute("data-translation", mode);
      if (trBtn) iconLabel(trBtn, "languages", { ks: "KS", parallel: "KS + Katančić", katancic: "Katančić" }[mode]);

      clearParallel();
      altBody.replaceChildren();
      altBody.hidden = true;
      ksBody.hidden = false;
      showAltNotice("");
      if (mode === "ks") return;

      const book = await loadKatancicBook();
      if (state.translation !== mode) return; // u međuvremenu prebačeno
      const verses = book && book.chapters[String(chapter)];
      if (!verses || !verses.length) {
        showAltNotice(book
          ? `Katančić nema ${chapter === 0 ? "proslov" : `${chapter}. poglavlje`} pod ovim brojem.`
          : "Katančića za ovu knjigu nema u izvoru (library.foi.hr). Prikazan je tekst KS-a.");
        return;
      }
      showAltNotice("Katančić, Sveto pismo (Budim 1831.) · digitalizacija library.foi.hr · stari pravopis"
        + (book.note ? `. ${book.note}` : ""));

      if (mode === "parallel") {
        const ksByVerse = new Map();
        ksBody.querySelectorAll(".verse-item").forEach((el) => {
          const v = parseInt(el.getAttribute("data-verse"), 10);
          if (!ksByVerse.has(v)) ksByVerse.set(v, el);
        });
        const extra = [];
        for (const [v, text] of verses) {
          const target = ksByVerse.get(v);
          if (!target) {
            extra.push([v, text]);
            continue;
          }
          const alt = document.createElement("span");
          alt.className = "alt-verse";
          alt.textContent = text;
          const badge = target.querySelector(".verse-note-badge");
          target.insertBefore(alt, badge);
        }
        if (extra.length) {
          const box = document.createElement("div");
          box.className = "alt-extra";
          const title = document.createElement("div");
          title.className = "sec-ref";
          title.textContent = "Retci koje KS nema pod istim brojem (Katančić):";
          box.append(title, ...extra.map(([v, t]) => altVerseEl("span", "alt-verse alt-verse-standalone", v, t)));
          ksBody.append(box);
        }
        return;
      }

      altBody.append(...verses.flatMap(([v, text]) => {
        const el = altVerseEl("span", "verse-item alt-only", v, text);
        if (!altBody.querySelector(`#kv-${v}`)) el.id = `kv-${v}`;
        return [el, document.createTextNode(" ")];
      }));
      ksBody.hidden = true;
      altBody.hidden = false;
      const m = (window.location.hash || "").match(/^#(v|od)-(\d+)$/);
      const target = m && document.getElementById(`kv-${m[2]}`);
      if (target) target.scrollIntoView({ block: m[1] === "od" ? "start" : "center" });
    }

    if (trBtn && altBody && ksBody) {
      trBtn.addEventListener("click", () => {
        state.translation = TRANSLATIONS[(TRANSLATIONS.indexOf(state.translation) + 1) % TRANSLATIONS.length];
        applyTranslation();
      });
      applyTranslation();
    }

    // Share chapter button
    const shareBtn = document.getElementById("btnShareChapter");
    if (shareBtn) {
      shareBtn.addEventListener("click", () => {
        const shareUrl = `${window.location.origin}/${bookId}/${chapter}/`;
        navigator.clipboard.writeText(shareUrl);
        iconLabel(shareBtn, "check", "Poveznica kopirana!");
        setTimeout(() => {
          iconLabel(shareBtn, "link", "Podijeli");
        }, 1400);
      });
    }

    // Keyboard navigation (<- / ->) for previous/next chapter
    document.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" && prevUrl) {
        window.location.href = prevUrl;
      } else if (e.key === "ArrowRight" && nextUrl) {
        window.location.href = nextUrl;
      }
    });

    function refreshResumeReadingBar() {
      const resumeBar = document.getElementById("resumeReadingBar");
      if (!resumeBar || window.location.pathname !== "/") return;
      const lin = state.linear;
      if (!lin || (lin.url === "/knjiga-postanka/1/" && lin.verse <= 1)) {
        resumeBar.style.display = "none";
        return;
      }
      resumeBar.style.display = "flex";
      document.getElementById("resumeReadingLabel").textContent = placeLabel(lin.label || lin.url, lin.verse);
      document.getElementById("resumeReadingLink").setAttribute("href", resumeHref(lin.url, lin.verse));

      // Zadnje otvoreno izvan linearnog čitanja, ako se razlikuje od kursora
      const lastEl = document.getElementById("resumeLastVisited");
      const last = state.readingLog[state.readingLog.length - 1];
      if (lastEl) {
        if (last && last.url !== lin.url) {
          lastEl.style.display = "";
          lastEl.setAttribute("href", resumeHref(last.url, last.verse));
          lastEl.querySelector("span").textContent = `Zadnje otvoreno: ${placeLabel(last.label || last.url, last.verse)}`;
        } else {
          lastEl.style.display = "none";
        }
      }
    }

    let tracker = null;
    if (window.location.pathname === "/") {
      refreshResumeReadingBar();
    } else {
      const curUrl = `/${bookId}/${chapter}/`;
      const curLbl = `${bookTitle} (${bookAbbr} ${chapter === 0 ? "Proslov" : chapter})`;
      if (localStorage.getItem("biblija_last_url") !== curUrl) {
        localStorage.setItem("biblija_last_url", curUrl);
        localStorage.setItem("biblija_last_label", curLbl);
        touchMetaTimestamp();
        scheduleCloudSync();
      }
      tracker = initReadingTracker(curUrl, curLbl, prevUrl);
    }

    // Sidebar testament & search filtering
    let curTestament = "ALL";
    let curQuery = "";
    function filterSidebar() {
      const q = foldHr(curQuery.trim());
      document.querySelectorAll("#bookListContainer .book-group-section").forEach((sec) => {
        let visibleInGroup = 0;
        sec.querySelectorAll(".book-item").forEach((item) => {
          const t = item.getAttribute("data-testament-item");
          const isDeut = item.getAttribute("data-deut-item") === "1";
          const s = foldHr(item.getAttribute("data-search") || "");
          const matchTab =
            curTestament === "ALL" ||
            (curTestament === "DEUT" ? isDeut : t === curTestament);
          const show = matchTab && (!q || s.includes(q));
          item.style.display = show ? "flex" : "none";
          if (show) visibleInGroup++;
        });
        sec.style.display = visibleInGroup > 0 ? "block" : "none";
      });
    }

    document.querySelectorAll("[data-testament]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-testament]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        curTestament = btn.getAttribute("data-testament");
        filterSidebar();
      });
    });

    const filterInput = document.getElementById("bookFilterInput");
    if (filterInput) {
      filterInput.addEventListener("input", (e) => {
        curQuery = e.target.value;
        filterSidebar();
      });
    }

    // Apply saved bookmarks & notes to verses
    function refreshVerseHighlights() {
      document.querySelectorAll("#chapterBody .verse-item").forEach((el) => {
        const vnum = parseInt(el.getAttribute("data-verse"), 10);
        const key = `${bookOrder}:${chapter}:${vnum}`;
        const bm = getActiveBookmark(key);
        el.classList.remove("hl-gold", "hl-green", "hl-blue", "hl-pink");
        const oldBadge = el.querySelector(".verse-note-badge");
        if (oldBadge) oldBadge.remove();

        if (bm && bm.color) {
          el.classList.add(`hl-${bm.color}`);
        }
        if (bm && bm.note) {
          const badge = document.createElement("span");
          badge.className = "verse-note-badge";
          badge.title = bm.note;
          badge.innerHTML = `${ic("pencil-line")}bilješka`;
          el.appendChild(badge);
        }
      });
    }

    refreshVerseHighlights();

    // Verse click -> open popover
    document.querySelectorAll("#chapterBody .verse-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const vnum = parseInt(el.getAttribute("data-verse"), 10);
        const vtext = el.getAttribute("data-text") || "";
        const key = `${bookOrder}:${chapter}:${vnum}`;
        const existing = getActiveBookmark(key) || {};
        state.selectedVerseContext = {
          key,
          book_order: bookOrder,
          book_id: bookId,
          book_abbr: bookAbbr,
          book_title: bookTitle,
          chapter,
          verse: vnum,
          text: vtext,
          color: existing.color || "gold",
          onRefresh: refreshVerseHighlights,
        };
        const chRef = chapter === 0 ? "Proslov" : chapter;
        document.getElementById("popoverRefTitle").textContent = `${bookAbbr} ${chRef},${vnum} — ${bookTitle}`;
        const prevEl = document.getElementById("popoverVersePreview");
        if (prevEl) prevEl.textContent = `»${vtext}«`;
        document.getElementById("popoverNoteInput").value = existing.note || "";
        document.getElementById("versePopover").classList.add("open");
      });
    });

    // Hash verse highlight (#v-19 u sredinu ekrana; #od-19 na vrh, za nastavak čitanja)
    const hash = window.location.hash || "";
    if (hash.startsWith("#v-") || hash.startsWith("#od-")) {
      const resume = hash.startsWith("#od-");
      const target = document.getElementById(`v-${parseInt(hash.slice(resume ? 4 : 3), 10)}`);
      if (target) {
        target.classList.add("flash-target");
        if (resume) setTimeout(() => target.classList.remove("flash-target"), 2500);
        setTimeout(() => target.scrollIntoView({ behavior: resume ? "auto" : "smooth", block: resume ? "start" : "center" }), 80);
      }
    }

    // Active Biblija 365 Banner inside Reader
    function renderPlanBanner() {
      const banner = document.getElementById("readerPlanBanner");
      const ctx = state.activePlanDayContext;
      if (!banner || !ctx) {
        if (banner) banner.style.display = "none";
        return;
      }
      banner.style.display = "flex";
      const isDone = isDayDone(ctx.planId, ctx.day);
      document.getElementById("bannerPlanDayTitle").textContent = `Dan ${ctx.day}: ${ctx.label}`;
      const markBtn = document.getElementById("btnBannerMarkDone");
      iconLabel(markBtn, isDone ? "circle-check" : "check", isDone ? "Dan je označen pročitanim" : `Označi Dan ${ctx.day} pročitanim`);
      markBtn.style.background = isDone ? "var(--success)" : "var(--accent)";

      const pills = [];
      for (const r of ctx.readings) {
        for (let ch = r.chapter_start; ch <= r.chapter_end; ch++) {
          const act = r.book_order === bookOrder && ch === chapter ? "active" : "";
          const chLbl = ch === 0 ? "Proslov" : ch;
          pills.push(
            `<a href="/${escapeHtml(r.book_id)}/${ch}/" class="plan-reading-pill ${act}" style="text-decoration:none;">${escapeHtml(r.book_abbr)} ${chLbl}</a>`
          );
        }
      }
      document.getElementById("bannerPlanPills").innerHTML = pills.join("");
    }

    renderPlanBanner();

    state.uiRefreshCallbacks.push(() => {
      refreshResumeReadingBar();
      refreshVerseHighlights();
      renderPlanBanner();
      if (tracker) tracker.renderBanner();
    });

    const btnBannerClose = document.getElementById("btnBannerClose");
    if (btnBannerClose) {
      btnBannerClose.addEventListener("click", () => {
        state.activePlanDayContext = null;
        sessionStorage.removeItem("biblija_active_day_ctx");
        renderPlanBanner();
      });
    }

    const btnBannerMarkDone = document.getElementById("btnBannerMarkDone");
    if (btnBannerMarkDone) {
      btnBannerMarkDone.addEventListener("click", () => {
        if (!state.activePlanDayContext) return;
        togglePlanDayCompleted(state.activePlanDayContext.planId, state.activePlanDayContext.day);
        renderPlanBanner();
      });
    }
  }

  /**
   * Prati čitanje otvorenog poglavlja: odluči je li ovo linearno čitanje (isto ili sljedeće poglavlje od
   * kursora), otvori ili nastavi zapis u dnevniku i dok se skrola pamti redak na vrhu ekrana.
   */
  function initReadingTracker(url, label, prevUrl) {
    const lin = state.linear;
    if (!lin || (prevUrl && lin.url === prevUrl)) {
      setLinear(url, label, 0);
      if (lin && lin.url !== url) offerPlanCatchUp(lin, false);
    }
    const isLinearHere = () => Boolean(state.linear && state.linear.url === url);

    const device = deviceLabel();
    const nowMs = Date.now();
    let entry = null;
    for (let i = state.readingLog.length - 1; i >= Math.max(0, state.readingLog.length - 20); i--) {
      const e = state.readingLog[i];
      if (e.url === url && e.device === device && nowMs - Date.parse(e.ended_at) < LOG_CONTINUE_MS) {
        entry = e;
        break;
      }
    }
    const nowIso = new Date(nowMs).toISOString();
    entry = entry
      ? { ...entry, ended_at: nowIso, updated_at: nowIso, linear: entry.linear || isLinearHere() }
      : { id: newLogId(), url, label, verse: 0, started_at: nowIso, ended_at: nowIso, linear: isLinearHere(), device, updated_at: nowIso };
    upsertLogEntry(entry);
    saveReadingLog();
    scheduleLogSync();

    // Redak na vrhu: zadnji čiji početak je iznad crte čitanja. Crta je ista kao scroll-margin-top
    // retka (6rem), pa nastavak preko #od-N ne pomiče zapamćeni redak unatrag.
    // Vidljivo tijelo: u načinu „samo Katančić" #chapterBody je skriven i svi bi mu retci bili „iznad crte".
    function topVerse() {
      const verseEls = Array.from(document.querySelectorAll("#chapterBody:not([hidden]) .verse-item, #altChapterBody:not([hidden]) .verse-item"));
      const line = parseFloat(getComputedStyle(document.documentElement).fontSize) * 6 + 6;
      let v = 0;
      for (const el of verseEls) {
        if (el.getBoundingClientRect().top > line) break;
        v = parseInt(el.getAttribute("data-verse"), 10) || v;
      }
      return v || (verseEls.length ? parseInt(verseEls[0].getAttribute("data-verse"), 10) || 0 : 0);
    }

    state.topVerse = topVerse;

    function record(verse, scrolledAt = Infinity) {
      const now = new Date().toISOString();
      entry = { ...entry, verse, ended_at: now, updated_at: now, linear: entry.linear || isLinearHere() };
      upsertLogEntry(entry);
      // Kursor se dira samo kad se redak stvarno promijeni: otkucaj otvorene kartice na drugom
      // uređaju ne smije novijim vremenom pregaziti kursor koji je u međuvremenu otišao dalje.
      // Ručno „Ovdje sam stao" vrijedi dok se redak na vrhu stvarno ne pomakne: ni skrolanje započeto
      // prije klika ni pomak rasporeda (npr. nakon sinkronizacije) ga ne smiju pregaziti.
      const pin = state.linearPin;
      const pinned = pin && (scrolledAt < pin.at || verse === pin.top);
      if (isLinearHere() && state.linear.verse !== verse && !pinned) {
        state.linear = { ...state.linear, verse, updated_at: now };
        saveLinear();
      }
      saveReadingLog();
    }

    let scrollTimer = null;
    window.addEventListener(
      "scroll",
      () => {
        const scrolledAt = Date.now();
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          const v = topVerse();
          if (v === entry.verse) return;
          record(v, scrolledAt);
          scheduleLogSync();
        }, 700);
      },
      { passive: true }
    );

    // Dok je kartica otvorena, kraj zapisa prati stvarno vrijeme čitanja (bez slanja na server).
    setInterval(() => {
      if (document.visibilityState === "visible") record(entry.verse);
    }, 30000);
    const flush = () => {
      record(entry.verse);
      if (state.syncAuth) syncWithServer({ silent: true, keepalive: true });
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);

    const banner = document.getElementById("linearReturnBanner");
    function renderBanner() {
      if (!banner) return;
      const cur = state.linear;
      const away = Boolean(cur) && cur.url !== url && !state.activePlanDayContext;
      banner.hidden = !away;
      if (!away) return;
      document.getElementById("linearReturnLabel").textContent = placeLabel(cur.label || cur.url, cur.verse);
      document.getElementById("linearReturnLink").setAttribute("href", resumeHref(cur.url, cur.verse));
    }
    const hereBtn = document.getElementById("btnLinearContinueHere");
    if (hereBtn) {
      hereBtn.addEventListener("click", () => {
        setLinear(url, label, topVerse());
        record(state.linear.verse);
        renderBanner();
        scheduleCloudSync();
        offerPlanCatchUp(null, true);
      });
    }
    renderBanner();
    return { renderBanner };
  }

  /* ==================== POPOVER ACTIONS ==================== */
  function initPopover() {
    const popover = document.getElementById("versePopover");
    const closeBtn = document.getElementById("btnClosePopover");
    if (!popover || !closeBtn) return;

    closeBtn.addEventListener("click", () => {
      popover.classList.remove("open");
    });

    document.addEventListener("click", (e) => {
      if (popover.classList.contains("open") && !popover.contains(e.target)) {
        popover.classList.remove("open");
      }
    });

    function saveBookmark(colorOverride) {
      const ctx = state.selectedVerseContext;
      if (!ctx) return;
      const color = colorOverride || ctx.color || "gold";
      const note = document.getElementById("popoverNoteInput").value.trim();
      const now = new Date().toISOString();
      state.bookmarks[ctx.key] = {
        book_order: ctx.book_order,
        book_id: ctx.book_id,
        book_abbr: ctx.book_abbr,
        book_title: ctx.book_title,
        chapter: ctx.chapter,
        verse: ctx.verse,
        color,
        note,
        text: ctx.text,
        deleted: false,
        updated_at: now,
      };
      localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
      if (ctx.onRefresh) ctx.onRefresh();
      scheduleCloudSync();
    }

    document.querySelectorAll(".color-dot").forEach((dot) => {
      dot.addEventListener("click", () => saveBookmark(dot.getAttribute("data-color")));
    });

    document.getElementById("btnSaveNote").addEventListener("click", () => {
      saveBookmark(null);
      popover.classList.remove("open");
    });

    document.getElementById("popoverNoteInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        saveBookmark(null);
        popover.classList.remove("open");
      }
    });

    document.getElementById("btnRemoveBookmark").addEventListener("click", () => {
      const ctx = state.selectedVerseContext;
      if (!ctx) return;
      const existing = state.bookmarks[ctx.key] || {
        book_order: ctx.book_order,
        book_id: ctx.book_id,
        book_abbr: ctx.book_abbr,
        book_title: ctx.book_title,
        chapter: ctx.chapter,
        verse: ctx.verse,
      };
      state.bookmarks[ctx.key] = {
        ...existing,
        deleted: true,
        updated_at: new Date().toISOString(),
      };
      localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
      popover.classList.remove("open");
      if (ctx.onRefresh) ctx.onRefresh();
      scheduleCloudSync();
    });

    const stopHereBtn = document.getElementById("btnStoppedHere");
    if (stopHereBtn) {
      stopHereBtn.addEventListener("click", () => {
        const ctx = state.selectedVerseContext;
        if (!ctx) return;
        const chLbl = ctx.chapter === 0 ? "Proslov" : ctx.chapter;
        setLinear(`/${ctx.book_id}/${ctx.chapter}/`, `${ctx.book_title} (${ctx.book_abbr} ${chLbl})`, ctx.verse);
        state.linearPin = { at: Date.now(), top: state.topVerse ? state.topVerse() : -1 };
        scheduleCloudSync();
        offerPlanCatchUp(null, true);
        iconLabel(stopHereBtn, "check", "Zapamćeno");
        setTimeout(() => {
          iconLabel(stopHereBtn, "flag", "Ovdje sam stao");
          popover.classList.remove("open");
        }, 900);
        triggerAllUiRefresh();
      });
    }

    document.getElementById("btnCopyVerse").addEventListener("click", () => {
      const ctx = state.selectedVerseContext;
      if (!ctx) return;
      const quote = `»${ctx.text}« (${ctx.book_abbr} ${ctx.chapter},${ctx.verse})`;
      navigator.clipboard.writeText(quote);
      const btn = document.getElementById("btnCopyVerse");
      iconLabel(btn, "check", "Kopirano!");
      setTimeout(() => iconLabel(btn, "copy", "Kopiraj citat"), 1400);
    });
  }

  /* ==================== BIBLIJA 365 PAGE ==================== */
  function togglePlanDayCompleted(planId, dayNum, forceValue = null) {
    if (!state.progress[planId]) state.progress[planId] = {};
    const cur = isDayDone(planId, dayNum);
    const nextVal = forceValue !== null ? Boolean(forceValue) : !cur;
    state.progress[planId][String(dayNum)] = {
      completed: nextVal,
      updated_at: new Date().toISOString(),
    };
    localStorage.setItem("biblija_progress", JSON.stringify(state.progress));
    scheduleCloudSync();
  }

  async function initPlanPage() {
    const root = document.getElementById("planPageRoot");
    if (!root) return;

    const sel = document.getElementById("planSelector");
    if (sel) {
      sel.value = state.currentPlanId;
      sel.addEventListener("change", () => {
        state.currentPlanId = sel.value;
        localStorage.setItem("biblija_plan_id", state.currentPlanId);
        touchMetaTimestamp();
        renderPlan();
        scheduleCloudSync();
      });
    }

    document.querySelectorAll("[data-plan-quick]").forEach((card) => {
      card.addEventListener("click", () => {
        const pid = card.getAttribute("data-plan-quick");
        if (!pid) return;
        state.currentPlanId = pid;
        localStorage.setItem("biblija_plan_id", state.currentPlanId);
        touchMetaTimestamp();
        renderPlan();
        scheduleCloudSync();
      });
    });

    document.querySelectorAll("[data-dayfilter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-dayfilter]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.dayFilter = btn.getAttribute("data-dayfilter");
        renderPlan();
      });
    });

    const scrollCurBtn = document.getElementById("btnScrollToCurrentDay");
    if (scrollCurBtn) {
      scrollCurBtn.addEventListener("click", () => {
        const curCard = document.querySelector("#planDaysGrid .day-card.current-day");
        if (curCard) {
          curCard.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }

    const daySearchInput = document.getElementById("daySearchInput");
    if (daySearchInput) {
      daySearchInput.addEventListener("input", (e) => {
        state.daySearch = e.target.value;
        renderPlan();
      });
    }

    async function renderPlan() {
      if (sel && sel.value !== state.currentPlanId) {
        sel.value = state.currentPlanId;
      }
      document.querySelectorAll("[data-plan-quick]").forEach((card) => {
        card.classList.toggle("active", card.getAttribute("data-plan-quick") === state.currentPlanId);
      });

      if (!state.loadedPlans[state.currentPlanId]) {
        const res = await fetch(`/data/json/plans/${state.currentPlanId}.json`);
        state.loadedPlans[state.currentPlanId] = await res.json();
      }
      const plan = state.loadedPlans[state.currentPlanId];
      document.getElementById("planDescription").textContent = plan.description;

      const doneCount = plan.days.filter((d) => isDayDone(plan.id, d.day)).length;
      const pct = Math.round((doneCount / plan.days_count) * 100);
      document.getElementById("planProgressBar").style.width = `${pct}%`;
      document.getElementById("planProgressStats").textContent = `Pročitano: ${doneCount} / ${plan.days_count} dana (${pct}%)`;

      const nextDayObj = plan.days.find((d) => !isDayDone(plan.id, d.day)) || plan.days[plan.days.length - 1];
      document.getElementById("planNextSuggested").textContent =
        doneCount === plan.days_count
          ? "Čestitamo! Plan je u cijelosti pročitan!"
          : `Sljedeći nepročitani dan: Dan ${nextDayObj.day} (${nextDayObj.label})`;

      const hero = document.getElementById("currentDayHeroCard");
      if (nextDayObj) {
        const readingBtns = nextDayObj.readings
          .map(
            (r, idx) =>
              `<button class="icon-btn hero-read-btn" data-ridx="${idx}" style="border-color:var(--accent);">${ic("book-open")}<strong>${escapeHtml(r.label)}</strong> <span style="color:var(--text-muted);font-weight:500;">(${escapeHtml(r.book_title)})</span></button>`
          )
          .join(" ");

        hero.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.85rem;">
            <div>
              <span class="badge badge-accent">${ic("calendar-days")}Današnje čitanje · Dan ${nextDayObj.day} od ${plan.days_count}</span>
              <h3 style="margin:0.35rem 0 0.2rem;font-size:1.35rem;">${escapeHtml(nextDayObj.label)}</h3>
              <div style="font-size:0.84rem;color:var(--text-muted);">Ukupno ~${nextDayObj.verse_count} redaka u današnjem rasporedu</div>
            </div>
            <div style="display:flex;gap:0.45rem;flex-wrap:wrap;">
              <button class="icon-btn btn-accent" id="btnHeroStartFirst" style="padding:0.5rem 0.95rem;">
                ${ic("book-open")}Započni čitanje
              </button>
              <button class="icon-btn" id="btnHeroToggleDone" style="padding:0.5rem 0.9rem;">
                ${ic("check")}Označi Dan ${nextDayObj.day} pročitanim
              </button>
            </div>
          </div>
          <div style="display:flex;gap:0.45rem;flex-wrap:wrap;margin-top:0.9rem;">
            ${readingBtns}
          </div>
        `;

        hero.querySelector("#btnHeroStartFirst").addEventListener("click", () => {
          if (nextDayObj.readings.length) {
            openPlanDayInReader(plan, nextDayObj, nextDayObj.readings[0]);
          }
        });

        hero.querySelector("#btnHeroToggleDone").addEventListener("click", () => {
          togglePlanDayCompleted(plan.id, nextDayObj.day);
          renderPlan();
        });

        hero.querySelectorAll(".hero-read-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const r = nextDayObj.readings[parseInt(btn.getAttribute("data-ridx"), 10)];
            openPlanDayInReader(plan, nextDayObj, r);
          });
        });
      }

      const grid = document.getElementById("planDaysGrid");
      const q = foldHr(state.daySearch.trim());
      const filteredDays = plan.days.filter((d) => {
        const isDone = isDayDone(plan.id, d.day);
        if (state.dayFilter === "todo" && isDone) return false;
        if (state.dayFilter === "done" && !isDone) return false;
        if (!q) return true;
        return `dan ${d.day}`.includes(q) || foldHr(d.label).includes(q);
      });

      grid.innerHTML = filteredDays
        .map((d) => {
          const isDone = isDayDone(plan.id, d.day);
          const isCur = nextDayObj && d.day === nextDayObj.day ? "current-day" : "";
          const pills = d.readings
            .map(
              (r, idx) =>
                `<button class="plan-reading-pill day-pill-jump" data-day="${d.day}" data-ridx="${idx}">${escapeHtml(r.label)}</button>`
            )
            .join("");

          return `
            <div class="day-card ${isDone ? "done" : ""} ${isCur}">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <strong>Dan ${d.day}${isCur ? " · Danas" : ""}</strong>
                <span class="badge">${d.verse_count} redaka</span>
              </div>
              <div class="plan-reading-pills">${pills}</div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.25rem;">
                <button class="icon-btn day-open-first" data-day="${d.day}" style="font-size:0.78rem;">Otvori u čitaču${ic("arrow-right")}</button>
                <label style="font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:0.35rem;font-weight:600;">
                  <input type="checkbox" class="day-done-checkbox" data-day="${d.day}" ${isDone ? "checked" : ""} />
                  Pročitano
                </label>
              </div>
            </div>
          `;
        })
        .join("");

      grid.querySelectorAll(".day-done-checkbox").forEach((cb) => {
        cb.addEventListener("change", () => {
          togglePlanDayCompleted(plan.id, parseInt(cb.getAttribute("data-day"), 10), cb.checked);
          renderPlan();
        });
      });

      grid.querySelectorAll(".day-open-first").forEach((btn) => {
        btn.addEventListener("click", () => {
          const dayNum = parseInt(btn.getAttribute("data-day"), 10);
          const dayObj = plan.days.find((x) => x.day === dayNum);
          if (dayObj && dayObj.readings.length) {
            openPlanDayInReader(plan, dayObj, dayObj.readings[0]);
          }
        });
      });

      grid.querySelectorAll(".day-pill-jump").forEach((btn) => {
        btn.addEventListener("click", () => {
          const dayNum = parseInt(btn.getAttribute("data-day"), 10);
          const ridx = parseInt(btn.getAttribute("data-ridx"), 10);
          const dayObj = plan.days.find((x) => x.day === dayNum);
          if (dayObj && dayObj.readings[ridx]) {
            openPlanDayInReader(plan, dayObj, dayObj.readings[ridx]);
          }
        });
      });
    }

    function openPlanDayInReader(plan, dayObj, reading) {
      const ctx = {
        planId: plan.id,
        day: dayObj.day,
        label: dayObj.label,
        readings: dayObj.readings,
      };
      sessionStorage.setItem("biblija_active_day_ctx", JSON.stringify(ctx));
      window.location.href = `/${reading.book_id}/${reading.chapter_start}/`;
    }

    state.uiRefreshCallbacks.push(renderPlan);
    renderPlan();
  }

  /* ==================== SEARCH PAGE ==================== */
  async function initSearchPage() {
    const root = document.getElementById("searchPageRoot");
    if (!root) return;

    await ensureBooksLoaded();

    function parseBibleReference(rawQuery) {
      const q = rawQuery.trim();
      const m = q.match(/^([1-3]?\s*[a-zA-ZčćžšđČĆŽŠĐ.]+)\s+(\d+)(?:\s*[,:]\s*(\d+)(?:\s*[-–]\s*(\d+))?)?$/);
      if (!m) return null;
      const bookToken = foldHr(m[1].replace(/\./g, "").trim());
      const ch = parseInt(m[2], 10);
      const vStart = m[3] ? parseInt(m[3], 10) : null;

      const matchedBook = state.books.find(
        (b) =>
          foldHr(b.abbr) === bookToken ||
          foldHr(b.title) === bookToken ||
          foldHr(b.title).startsWith(bookToken)
      );
      if (!matchedBook) return null;
      if (ch < 0 || ch > matchedBook.chapter_count) return null;
      return { book: matchedBook, chapter: ch, verse: vStart };
    }

    function highlightMatch(text, query) {
      const cleanQ = query.replace(/["*]/g, "").trim();
      if (!cleanQ) return escapeHtml(text);
      const tokens = cleanQ.split(/\s+/).filter((t) => t.length >= 2);
      if (!tokens.length) return escapeHtml(text);
      const charMap = { c: "[cčćCČĆ]", z: "[zžZŽ]", s: "[sšSŠ]", d: "[dđDĐ]" };
      const pattern = tokens
        .map((tok) =>
          foldHr(tok)
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/[czsd]/g, (ch) => charMap[ch] || ch)
        )
        .join("|");
      try {
        const re = new RegExp(`(${pattern})`, "gi");
        return escapeHtml(text).replace(re, "<mark>$1</mark>");
      } catch (_) {
        return escapeHtml(text);
      }
    }

    async function runSearch() {
      const q = document.getElementById("searchInput").value.trim();
      const testament = document.getElementById("searchTestamentFilter").value;
      const bookOrderStr = document.getElementById("searchBookFilter").value;
      const directCard = document.getElementById("directRefCard");
      const statusEl = document.getElementById("searchMetaStatus");
      const listEl = document.getElementById("searchResultsList");

      const parsedRef = parseBibleReference(q);
      if (parsedRef) {
        const refLbl = `${parsedRef.book.abbr} ${parsedRef.chapter}${parsedRef.verse ? "," + parsedRef.verse : ""}`;
        const targetUrl = `/${parsedRef.book.id}/${parsedRef.chapter}/${parsedRef.verse ? "#v-" + parsedRef.verse : ""}`;
        directCard.style.display = "block";
        directCard.innerHTML = `
          <div class="active-plan-banner" style="margin:0;">
            <div>
              <span class="badge badge-accent">Prepoznata biblijska kratica</span>
              <strong style="margin-left:0.5rem;">${escapeHtml(parsedRef.book.title)} — ${escapeHtml(refLbl)}</strong>
            </div>
            <a href="${targetUrl}" class="icon-btn btn-accent" style="text-decoration:none;">
              Otvori ${escapeHtml(refLbl)} u čitaču${ic("arrow-right")}
            </a>
          </div>
        `;
      } else {
        directCard.style.display = "none";
      }

      if (!q) {
        statusEl.textContent = "Upiši pojam, frazu ili biblijsku kraticu za pretragu.";
        listEl.innerHTML = "";
        return;
      }

      const t0 = performance.now();
      let results = [];
      let total = 0;
      let engineLabel = "";

      if (state.hasSqliteServer) {
        const params = new URLSearchParams({ q, testament, book_order: bookOrderStr, limit: "100" });
        const res = await fetch(`/api/search?${params.toString()}`);
        const data = await res.json();
        results = data.results || [];
        total = data.total || 0;
        engineLabel = "SQLite FTS5";
      } else {
        statusEl.textContent = "Učitavanje lokalnog indeksa redaka...";
        if (!state.compactVersesCache) {
          const res = await fetch("/data/json/verses_compact.json");
          state.compactVersesCache = await res.json();
        }
        const foldedQ = foldHr(q.replace(/^"|"$/g, ""));
        const isPhrase = q.startsWith('"') && q.endsWith('"');
        const tokens = foldedQ.split(/\s+/).filter(Boolean);
        const filterBo = bookOrderStr ? parseInt(bookOrderStr, 10) : null;

        for (const row of state.compactVersesCache) {
          const [bo, ch, vnum, txt] = row;
          const bmeta = state.booksByOrder[bo];
          if (testament && bmeta.testament !== testament) continue;
          if (filterBo && bo !== filterBo) continue;
          const fTxt = foldHr(txt);
          const match = isPhrase ? fTxt.includes(foldedQ) : tokens.every((t) => fTxt.includes(t));
          if (match) {
            total++;
            if (results.length < 100) {
              results.push({
                book_order: bo,
                book_id: bmeta.id,
                book_abbr: bmeta.abbr,
                book_title: bmeta.title,
                chapter: ch,
                verse: vnum,
                text: txt,
              });
            }
          }
        }
        engineLabel = "Statički JSON indeks (Edge / Offline)";
      }

      const elapsed = (performance.now() - t0).toFixed(1);
      statusEl.textContent = `Pronađeno ${total} pogodaka u ${elapsed} ms (${engineLabel})${total > 100 ? " — prikazano prvih 100" : ""}`;

      listEl.innerHTML = results
        .map((r) => {
          const bId = r.book_id || (state.booksByOrder[r.book_order] && state.booksByOrder[r.book_order].id);
          return `
            <a href="/${escapeHtml(bId)}/${r.chapter}/#v-${r.verse}" class="search-result-item" style="display:block;text-decoration:none;color:inherit;">
              <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem;">
                <span class="search-result-ref">${escapeHtml(r.book_abbr)} ${r.chapter},${r.verse} — ${escapeHtml(r.book_title)}</span>
                <span class="badge">Otvori u čitaču${ic("arrow-right")}</span>
              </div>
              <div style="margin-top:0.3rem;font-family:var(--font-reading);font-size:1.04rem;line-height:1.6;">
                ${highlightMatch(r.text, q)}
              </div>
            </a>
          `;
        })
        .join("");
    }

    let searchTimer = null;
    const searchInputEl = document.getElementById("searchInput");

    document.getElementById("btnRunSearch").addEventListener("click", runSearch);
    searchInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (searchTimer) clearTimeout(searchTimer);
        runSearch();
      }
    });
    searchInputEl.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 240);
    });
    document.getElementById("searchTestamentFilter").addEventListener("change", runSearch);
    document.getElementById("searchBookFilter").addEventListener("change", runSearch);

    document.querySelectorAll("[data-example-query]").forEach((chip) => {
      chip.addEventListener("click", () => {
        searchInputEl.value = chip.getAttribute("data-example-query") || "";
        runSearch();
      });
    });
  }

  /* ==================== NOTES & AUDIT PAGE ==================== */
  async function initNotesPage() {
    const root = document.getElementById("notesPageRoot");
    if (!root) return;

    await ensureBooksLoaded();

    document.querySelectorAll("[data-bmfilter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-bmfilter]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.bookmarkFilter = btn.getAttribute("data-bmfilter") || "all";
        renderBookmarks();
      });
    });

    function renderBookmarks() {
      const container = document.getElementById("bookmarksListContainer");
      const allItems = getActiveBookmarksList();
      const items = allItems.filter((bm) => {
        if (state.bookmarkFilter === "all") return true;
        if (state.bookmarkFilter === "notes") return Boolean(bm.note && bm.note.trim());
        return (bm.color || "gold") === state.bookmarkFilter;
      });

      if (!items.length) {
        container.innerHTML = `<p style="color:var(--text-muted);font-size:0.9rem;margin:0.5rem 0;">${
          allItems.length === 0
            ? "Još nemaš spremljenih oznaka ili bilješki. Tijekom čitanja klikni na bilo koji redak za označavanje."
            : "Nema oznaka u odabranom filtru."
        }</p>`;
        return;
      }

      container.innerHTML = items
        .map((bm) => {
          const bmeta = state.booksByOrder[bm.book_order] || {};
          const bId = bm.book_id || bmeta.id || "knjiga-postanka";
          const abbr = bm.book_abbr || bmeta.abbr || "";
          const title = bm.book_title || bmeta.title || "";
          const key = bm._key || `${bm.book_order}:${bm.chapter}:${bm.verse}`;
          return `
            <div class="bookmark-card">
              <div class="bookmark-card-top">
                <a href="/${escapeHtml(bId)}/${bm.chapter}/#v-${bm.verse}" class="search-result-ref" style="text-decoration:none;">
                  ${escapeHtml(abbr)} ${bm.chapter},${bm.verse} — ${escapeHtml(title)}
                </a>
                <div class="bookmark-card-actions">
                  <span class="badge hl-${escapeHtml(bm.color || "gold")}">Oznaka</span>
                  <a href="/${escapeHtml(bId)}/${bm.chapter}/#v-${bm.verse}" class="icon-btn" style="text-decoration:none;font-size:0.75rem;padding:0.2rem 0.5rem;">Otvori${ic("arrow-right")}</a>
                  <button type="button" class="icon-btn bm-delete-btn" data-bmkey="${escapeHtml(key)}" style="font-size:0.75rem;padding:0.2rem 0.45rem;" title="Ukloni oznaku" aria-label="Ukloni oznaku">${ic("trash-2")}</button>
                </div>
              </div>
              <div style="font-family:var(--font-reading);font-size:1.02rem;line-height:1.6;">
                »${escapeHtml(bm.text || "")}«
              </div>
              ${bm.note ? `<div style="margin-top:0.2rem;font-size:0.86rem;color:var(--accent);font-weight:600;display:flex;gap:0.35rem;align-items:flex-start;">${ic("pencil-line")}<span>${escapeHtml(bm.note)}</span></div>` : ""}
            </div>
          `;
        })
        .join("");

      container.querySelectorAll(".bm-delete-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const k = btn.getAttribute("data-bmkey");
          if (!k || !state.bookmarks[k]) return;
          state.bookmarks[k] = {
            ...state.bookmarks[k],
            deleted: true,
            updated_at: new Date().toISOString(),
          };
          localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
          renderBookmarks();
          scheduleCloudSync();
        });
      });
    }

    state.uiRefreshCallbacks.push(renderBookmarks);
    renderBookmarks();

    document.getElementById("btnExportData").addEventListener("click", () => {
      const payload = {
        exported_at: new Date().toISOString(),
        progress: state.progress,
        bookmarks: state.bookmarks,
        linear: state.linear,
        reading_log: state.readingLog,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `biblija365_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    });

    document.getElementById("inputImportData").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (data.progress) {
            state.progress = data.progress;
            localStorage.setItem("biblija_progress", JSON.stringify(state.progress));
          }
          if (data.bookmarks) {
            state.bookmarks = data.bookmarks;
            localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
          }
          if (data.linear && data.linear.url && (!state.linear || data.linear.updated_at > state.linear.updated_at)) {
            state.linear = data.linear;
            saveLinear();
          }
          if (Array.isArray(data.reading_log)) {
            const valid = data.reading_log.filter((e) => e && e.id && CHAPTER_URL_RE.test(String(e.url)));
            mergeServerLog(valid);
            for (const e of valid) state.logDirty.add(e.id);
            saveReadingLog();
          }
          renderBookmarks();
          scheduleCloudSync();
        } catch (_) {
          alert("Neispravna JSON datoteka.");
        }
      };
      reader.readAsText(file);
    });
  }

  /* ==================== DNEVNIK ČITANJA (/dnevnik/) ==================== */
  function initReadingLogPage() {
    const root = document.getElementById("readingLogRoot");
    if (!root) return;

    const books = JSON.parse(document.getElementById("linearPickerBooks").textContent || "[]");
    const bookSel = document.getElementById("linearBookSelect");
    const chSel = document.getElementById("linearChapterSelect");
    const verseInput = document.getElementById("linearVerseInput");
    let filter = "all";
    let daysShown = 30;

    const fmtTime = (iso) => new Date(iso).toLocaleTimeString("hr-HR", { hour: "2-digit", minute: "2-digit" });
    const fmtDay = (iso) =>
      new Date(iso).toLocaleDateString("hr-HR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const dayKey = (iso) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const minutes = (e) => Math.max(0, Math.round((Date.parse(e.ended_at) - Date.parse(e.started_at)) / 60000));
    function fmtDuration(min) {
      if (min < 60) return `${min} min`;
      const h = Math.floor(min / 60);
      return `${h} h ${min % 60} min`;
    }

    bookSel.innerHTML = books.map((b, i) => `<option value="${i}">${escapeHtml(b.title)} (${escapeHtml(b.abbr)})</option>`).join("");
    function fillChapters() {
      const b = books[Number(bookSel.value)] || books[0];
      chSel.innerHTML = b.chapters
        .map(([ch, vc]) => `<option value="${ch}" data-vc="${vc}">${ch === 0 ? "Proslov" : ch}</option>`)
        .join("");
      fillVerseMax();
    }
    function fillVerseMax() {
      const opt = chSel.options[chSel.selectedIndex];
      verseInput.max = opt ? opt.getAttribute("data-vc") : "";
    }
    bookSel.addEventListener("change", fillChapters);
    chSel.addEventListener("change", fillVerseMax);

    // Izbornik kreće od trenutnog kursora
    if (state.linear) {
      const m = state.linear.url.match(/^\/([a-z0-9-]+)\/(\d+)\/$/);
      const bi = m ? books.findIndex((b) => b.id === m[1]) : -1;
      if (bi >= 0) {
        bookSel.value = String(bi);
        fillChapters();
        chSel.value = m[2];
        fillVerseMax();
        if (state.linear.verse > 1) verseInput.value = String(state.linear.verse);
      } else fillChapters();
    } else fillChapters();

    document.getElementById("btnSetLinear").addEventListener("click", () => {
      const b = books[Number(bookSel.value)];
      const ch = Number(chSel.value);
      if (!b || !Number.isInteger(ch)) return;
      const max = Number(verseInput.max) || 999;
      const verse = Math.min(max, Math.max(0, parseInt(verseInput.value, 10) || 0));
      setLinear(`/${b.id}/${ch}/`, `${b.title} (${b.abbr} ${ch === 0 ? "Proslov" : ch})`, verse);
      scheduleCloudSync();
      offerPlanCatchUp(null, true);
      document.getElementById("linearSetDetails").open = false;
      render();
    });

    document.querySelectorAll("[data-logfilter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-logfilter]").forEach((x) => x.classList.remove("active"));
        btn.classList.add("active");
        filter = btn.getAttribute("data-logfilter") || "all";
        render();
      });
    });

    document.getElementById("btnLogMore").addEventListener("click", () => {
      daysShown += 30;
      render();
    });

    function renderLinear() {
      const lin = state.linear;
      const link = document.getElementById("linearCurrentLink");
      const lbl = document.getElementById("linearCurrentLabel");
      const time = document.getElementById("linearCurrentTime");
      if (!lin) {
        lbl.textContent = "Još nije postavljeno";
        time.textContent = "Otvori bilo koje poglavlje ili postavi mjesto ispod.";
        link.style.display = "none";
        return;
      }
      lbl.textContent = placeLabel(lin.label || lin.url, lin.verse);
      time.textContent = lin.updated_at > "1971" ? `Zadnja promjena: ${new Date(lin.updated_at).toLocaleString("hr-HR")}` : "";
      link.style.display = "";
      link.setAttribute("href", resumeHref(lin.url, lin.verse));
    }

    function renderStats() {
      const log = state.readingLog;
      const days = new Set(log.map((e) => dayKey(e.started_at)));
      const chapters = new Set(log.map((e) => e.url));
      const total = log.reduce((sum, e) => sum + minutes(e), 0);
      document.getElementById("logStats").innerHTML = `
        <div class="log-stat"><span>Dana čitanja</span><strong>${days.size}</strong></div>
        <div class="log-stat"><span>Različitih poglavlja</span><strong>${chapters.size}</strong></div>
        <div class="log-stat"><span>Ukupno vrijeme</span><strong>${fmtDuration(total)}</strong></div>
      `;
    }

    function render() {
      renderLinear();
      renderStats();
      const list = document.getElementById("readingLogList");
      const items = state.readingLog
        .filter((e) => filter === "all" || (filter === "linear" ? e.linear : !e.linear))
        .slice()
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));

      if (!items.length) {
        list.innerHTML = `<p class="log-empty">${
          state.readingLog.length ? "Nema zapisa u odabranom filtru." : "Dnevnik je prazan. Svako poglavlje koje otvoriš ovdje će se zapisati."
        }</p>`;
        document.getElementById("btnLogMore").style.display = "none";
        return;
      }

      const groups = [];
      for (const e of items) {
        const k = dayKey(e.started_at);
        if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, items: [] });
        groups[groups.length - 1].items.push(e);
      }

      list.innerHTML = groups
        .slice(0, daysShown)
        .map((g) => {
          const dayMin = g.items.reduce((sum, e) => sum + minutes(e), 0);
          return `
            <div class="log-day">
              <div class="log-day-head"><strong>${escapeHtml(fmtDay(g.items[0].started_at))}</strong><span>${g.items.length} · ${fmtDuration(dayMin)}</span></div>
              ${g.items
                .map((e) => {
                  const min = minutes(e);
                  const range = min > 0 ? `${fmtTime(e.started_at)}–${fmtTime(e.ended_at)}` : fmtTime(e.started_at);
                  const kind = e.linear
                    ? `<span class="badge log-kind-linear">Redom</span>`
                    : `<span class="badge">Skok</span>`;
                  return `
                    <a class="log-row" href="${escapeHtml(resumeHref(e.url, e.verse))}">
                      <span class="log-row-time">${range}</span>
                      <span class="log-row-main">
                        <strong>${escapeHtml(placeLabel(e.label || e.url, e.verse))}</strong>
                        <span class="log-row-meta">${kind}${min > 0 ? `<span>${fmtDuration(min)}</span>` : ""}${e.device ? `<span>${escapeHtml(e.device)}</span>` : ""}</span>
                      </span>
                      ${ic("chevron-right")}
                    </a>`;
                })
                .join("")}
            </div>`;
        })
        .join("");
      document.getElementById("btnLogMore").style.display = groups.length > daysShown ? "" : "none";
    }

    state.uiRefreshCallbacks.push(render);
    render();
  }

  /* ==================== GLOBAL INIT ==================== */
  window.addEventListener("DOMContentLoaded", () => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .then((reg) => reg.update().catch(() => {}))
        .catch(() => {});
    }

    // Redirect legacy single-page hashes (#reader, #plan365, #search, #notes) to clean Astro routes
    if (window.location.hash === "#plan365") {
      window.location.replace("/plan/");
      return;
    }
    if (window.location.hash === "#search") {
      window.location.replace("/pretraga/");
      return;
    }
    if (window.location.hash === "#notes") {
      window.location.replace("/oznake/");
      return;
    }
    if (window.location.hash === "#reader") {
      history.replaceState(null, "", window.location.pathname);
    }

    // Global Escape key handler for modals, drawers, and popovers
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const syncOverlay = document.getElementById("syncModalOverlay");
        if (syncOverlay) syncOverlay.classList.remove("open");
        const popover = document.getElementById("versePopover");
        if (popover) popover.classList.remove("open");
        const drawer = document.getElementById("bookSidebarDrawer");
        const backdrop = document.getElementById("bookDrawerBackdrop");
        if (drawer) drawer.classList.remove("open");
        if (backdrop) backdrop.classList.remove("open");
      }
    });

    applyThemeAndFont();
    detectServer();

    const btnDec = document.getElementById("btnFontDec");
    const btnInc = document.getElementById("btnFontInc");
    const btnTheme = document.getElementById("btnThemeToggle");

    if (btnDec) {
      btnDec.addEventListener("click", () => {
        state.fontSize = Math.max(14, state.fontSize - 1);
        applyThemeAndFont();
      });
    }
    if (btnInc) {
      btnInc.addEventListener("click", () => {
        state.fontSize = Math.min(28, state.fontSize + 1);
        applyThemeAndFont();
      });
    }
    if (btnTheme) {
      btnTheme.addEventListener("click", () => {
        const order = ["light", "sepia", "dark"];
        state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
        applyThemeAndFont();
      });
    }

    initPopover();
    initReaderPage();
    initPlanPage();
    initSearchPage();
    initNotesPage();
    initReadingLogPage();
    initSyncModal();
  });
})();
