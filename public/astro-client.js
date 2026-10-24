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
    syncAuth: JSON.parse(localStorage.getItem("biblija_sync_auth") || "null"),
    savedProfiles: JSON.parse(localStorage.getItem("biblija_saved_profiles") || "[]"),
    lastSyncedAt: localStorage.getItem("biblija_last_synced_at") || null,
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
      light: { icon: "☀️", label: "Svijetla" },
      sepia: { icon: "📜", label: "Sepia" },
      dark: { icon: "🌙", label: "Tamna" },
    }[state.theme] || { icon: "☀️", label: "Tema" };
    if (themeIcon) themeIcon.textContent = themeMeta.icon;
    if (themeLbl) themeLbl.textContent = themeMeta.label;

    const rmBtn = document.getElementById("btnReadingModeToggle");
    if (rmBtn) {
      rmBtn.textContent = state.readingMode === "verses" ? "≡ Stih po stih" : "¶ Knjiški odlomci";
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
    const pill = document.getElementById("engineStatusPill");
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.ok) {
        const info = await res.json();
        state.syncEnabledServer = Boolean(info && info.sync_enabled);
        if (info && info.mode === "sqlite-server") {
          state.hasSqliteServer = true;
          if (pill) pill.textContent = "⚡ Astro + SQLite FTS5 + Sync";
          return;
        }
        if (info && info.mode === "cloudflare-d1") {
          if (pill) pill.textContent = "⚡ Cloudflare Edge + D1 Sync";
          return;
        }
      }
    } catch (_) {}
    if (pill) pill.textContent = "⚡ Astro SSG (Edge / Offline)";
  }

  /* ==================== MULTI-DEVICE CLOUD SYNC & PROFILE SWITCHER ==================== */
  let syncDebounceTimer = null;

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
      lbl.textContent = state.isSyncing ? `🔄 @${state.syncAuth.user_key}` : `👤 @${state.syncAuth.user_key}`;
    } else {
      btn.classList.remove("synced");
      lbl.textContent = "👤 Prijava / Sync";
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
              ${isAct ? "✓ " : "👤 "}@${escapeHtml(p.user_key)}
            </span>
            <button type="button" class="saved-profile-remove" data-remove-key="${escapeHtml(p.user_key)}" title="Ukloni spremljeni profil s ovog uređaja">✕</button>
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
        <div>✓ Pročitanih dana u planovima: <strong>${completedDays}</strong></div>
        <div>🔖 Spremljenih oznaka i bilješki: <strong>${bmCount}</strong></div>
        <div>📖 Zadnje čitano: <strong>${escapeHtml(lastLbl)}</strong></div>
      `;
    } else {
      outView.style.display = "block";
      inView.style.display = "none";
    }
  }

  async function syncWithServer({ silent = false } = {}) {
    if (!state.syncAuth || !state.syncAuth.user_key || !state.syncAuth.pin) return false;
    if (state.isSyncing) return false;

    state.isSyncing = true;
    updateSyncHeaderUI();

    try {
      const payload = {
        user_key: state.syncAuth.user_key,
        pin: state.syncAuth.pin,
        meta: {
          active_plan_id: state.currentPlanId,
          last_url: localStorage.getItem("biblija_last_url") || "/",
          last_label: localStorage.getItem("biblija_last_label") || "",
          last_updated_at: localStorage.getItem("biblija_meta_updated_at") || "1970-01-01T00:00:00.000Z",
        },
        progress: state.progress,
        bookmarks: state.bookmarks,
      };

      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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

      state.lastSyncedAt = data.synced_at || new Date().toISOString();
      localStorage.setItem("biblija_last_synced_at", state.lastSyncedAt);

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
        connectBtn.textContent = "🔄 Povezivanje i sinkronizacija...";
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
            connectBtn.textContent = "☁️ Poveži uređaj i sinkroniziraj";
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
          connectBtn.textContent = "☁️ Poveži uređaj i sinkroniziraj";
          updateSyncHeaderUI();
          updateSyncModalViews();
        } catch (_) {
          connectBtn.disabled = false;
          connectBtn.textContent = "☁️ Poveži uređaj i sinkroniziraj";
          showMsg("Server za sinkronizaciju trenutno nije dostupan.");
        }
      });
    }

    const syncNowBtn = document.getElementById("btnSyncNow");
    if (syncNowBtn) {
      syncNowBtn.addEventListener("click", async () => {
        syncNowBtn.textContent = "🔄 Sinkroniziram...";
        await syncWithServer({ silent: false });
        syncNowBtn.textContent = "✓ Sinkronizirano!";
        setTimeout(() => {
          syncNowBtn.textContent = "🔄 Sinkroniziraj sada";
        }, 1200);
      });
    }

    const copyBtn = document.getElementById("btnCopySyncInfo");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        if (!state.syncAuth) return;
        const text = `Biblija 365 Sync podaci:\nURL: ${window.location.origin}\nSync kod (korisničko ime): ${state.syncAuth.user_key}\nPIN: ${state.syncAuth.pin}`;
        navigator.clipboard.writeText(text);
        copyBtn.textContent = "✓ Kopirano u međuspremnik!";
        setTimeout(() => {
          copyBtn.textContent = "📋 Kopiraj podatke za povezivanje drugog uređaja";
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

    // Share chapter button
    const shareBtn = document.getElementById("btnShareChapter");
    if (shareBtn) {
      shareBtn.addEventListener("click", () => {
        const shareUrl = `${window.location.origin}/${bookId}/${chapter}/`;
        navigator.clipboard.writeText(shareUrl);
        shareBtn.textContent = "✓ Poveznica kopirana!";
        setTimeout(() => {
          shareBtn.textContent = "🔗 Podijeli";
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
      if (resumeBar && window.location.pathname === "/") {
        const lastUrl = localStorage.getItem("biblija_last_url");
        const lastLabel = localStorage.getItem("biblija_last_label");
        if (lastUrl && lastUrl !== "/" && lastUrl !== "/knjiga-postanka/1/") {
          resumeBar.style.display = "flex";
          document.getElementById("resumeReadingLabel").textContent = lastLabel || lastUrl;
          document.getElementById("resumeReadingLink").setAttribute("href", lastUrl);
        } else {
          resumeBar.style.display = "none";
        }
      }
    }

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
          badge.textContent = "✎ bilješka";
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

    // Hash verse highlight (#v-19)
    if (window.location.hash && window.location.hash.startsWith("#v-")) {
      const target = document.querySelector(window.location.hash);
      if (target) {
        target.classList.add("flash-target");
        setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
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
      document.getElementById("bannerPlanDayTitle").textContent = `🗓️ Dan ${ctx.day}: ${ctx.label}`;
      const markBtn = document.getElementById("btnBannerMarkDone");
      markBtn.textContent = isDone ? "✓ Dan je označen pročitanim" : `✓ Označi Dan ${ctx.day} pročitanim`;
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

    document.getElementById("btnCopyVerse").addEventListener("click", () => {
      const ctx = state.selectedVerseContext;
      if (!ctx) return;
      const quote = `»${ctx.text}« (${ctx.book_abbr} ${ctx.chapter},${ctx.verse})`;
      navigator.clipboard.writeText(quote);
      const btn = document.getElementById("btnCopyVerse");
      btn.textContent = "✓ Kopirano!";
      setTimeout(() => (btn.textContent = "📋 Kopiraj citat"), 1400);
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
          ? "🎉 Čestitamo! Plan je u cijelosti pročitan!"
          : `Sljedeći nepročitani dan: Dan ${nextDayObj.day} (${nextDayObj.label})`;

      const hero = document.getElementById("currentDayHeroCard");
      if (nextDayObj) {
        const readingBtns = nextDayObj.readings
          .map(
            (r, idx) =>
              `<button class="icon-btn hero-read-btn" data-ridx="${idx}" style="border-color:var(--accent);">📖 <strong>${escapeHtml(r.label)}</strong> <span style="color:var(--text-muted);font-weight:500;">(${escapeHtml(r.book_title)})</span></button>`
          )
          .join(" ");

        hero.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.85rem;">
            <div>
              <span class="badge badge-accent">Današnje čitanje • Dan ${nextDayObj.day} od ${plan.days_count}</span>
              <h3 style="margin:0.35rem 0 0.2rem;font-size:1.35rem;">${escapeHtml(nextDayObj.label)}</h3>
              <div style="font-size:0.84rem;color:var(--text-muted);">Ukupno ~${nextDayObj.verse_count} redaka u današnjem rasporedu</div>
            </div>
            <div style="display:flex;gap:0.45rem;flex-wrap:wrap;">
              <button class="icon-btn btn-accent" id="btnHeroStartFirst" style="padding:0.5rem 0.95rem;">
                📖 Započni čitanje →
              </button>
              <button class="icon-btn" id="btnHeroToggleDone" style="padding:0.5rem 0.9rem;">
                ✓ Označi Dan ${nextDayObj.day} pročitanim
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
                <strong>Dan ${d.day}${isCur ? " • Danas" : ""}</strong>
                <span class="badge">${d.verse_count} redaka</span>
              </div>
              <div class="plan-reading-pills">${pills}</div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.25rem;">
                <button class="icon-btn day-open-first" data-day="${d.day}" style="font-size:0.78rem;">Otvori u čitaču →</button>
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
              Otvori ${escapeHtml(refLbl)} u čitaču →
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
                <span class="badge">Otvori u čitaču →</span>
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
                  <a href="/${escapeHtml(bId)}/${bm.chapter}/#v-${bm.verse}" class="icon-btn" style="text-decoration:none;font-size:0.75rem;padding:0.2rem 0.5rem;">Otvori →</a>
                  <button type="button" class="icon-btn bm-delete-btn" data-bmkey="${escapeHtml(key)}" style="font-size:0.75rem;padding:0.2rem 0.45rem;" title="Ukloni oznaku">🗑</button>
                </div>
              </div>
              <div style="font-family:var(--font-reading);font-size:1.02rem;line-height:1.6;">
                »${escapeHtml(bm.text || "")}«
              </div>
              ${bm.note ? `<div style="margin-top:0.2rem;font-size:0.86rem;color:var(--accent);font-weight:600;">✎ Bilješka: ${escapeHtml(bm.note)}</div>` : ""}
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
          renderBookmarks();
          scheduleCloudSync();
        } catch (_) {
          alert("Neispravna JSON datoteka.");
        }
      };
      reader.readAsText(file);
    });
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
    initSyncModal();
  });
})();
