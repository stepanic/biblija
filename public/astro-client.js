/* Biblija 365 — Astro SSG + Cloudflare / Local SQLite Client Controller */
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
    books: null,
    booksByOrder: {},
    loadedPlans: {},
    compactVersesCache: null,
    currentPlanId: localStorage.getItem("biblija_plan_id") || "mb-tematski-365",
    dayFilter: "all",
    daySearch: "",
    progress: JSON.parse(localStorage.getItem("biblija_progress") || "{}"),
    bookmarks: JSON.parse(localStorage.getItem("biblija_bookmarks") || "{}"),
    activePlanDayContext: JSON.parse(sessionStorage.getItem("biblija_active_day_ctx") || "null"),
    selectedVerseContext: null,
    fontSize: parseInt(localStorage.getItem("biblija_fontsize") || "19", 10),
    theme: localStorage.getItem("biblija_theme") || "light",
  };

  function applyThemeAndFont() {
    document.documentElement.setAttribute("data-theme", state.theme);
    document.documentElement.style.setProperty("--font-size-reading", `${state.fontSize}px`);
    localStorage.setItem("biblija_theme", state.theme);
    localStorage.setItem("biblija_fontsize", String(state.fontSize));
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
        if (info && info.mode === "sqlite-server") {
          state.hasSqliteServer = true;
          if (pill) pill.textContent = "⚡ Astro + SQLite FTS5";
          return;
        }
      }
    } catch (_) {}
    if (pill) pill.textContent = "⚡ Astro SSG (Edge / Offline)";
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

    // Check if on "/" and user had a different last read chapter
    const resumeBar = document.getElementById("resumeReadingBar");
    if (resumeBar && window.location.pathname === "/") {
      const lastUrl = localStorage.getItem("biblija_last_url");
      const lastLabel = localStorage.getItem("biblija_last_label");
      if (lastUrl && lastUrl !== "/" && lastUrl !== "/knjiga-postanka/1/") {
        resumeBar.style.display = "flex";
        document.getElementById("resumeReadingLabel").textContent = lastLabel || lastUrl;
        document.getElementById("resumeReadingLink").setAttribute("href", lastUrl);
      }
    } else {
      localStorage.setItem("biblija_last_url", `/${bookId}/${chapter}/`);
      localStorage.setItem(
        "biblija_last_label",
        `${bookTitle} (${bookAbbr} ${chapter === 0 ? "Proslov" : chapter})`
      );
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
          const s = foldHr(item.getAttribute("data-search") || "");
          const show = (curTestament === "ALL" || t === curTestament) && (!q || s.includes(q));
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
        const bm = state.bookmarks[key];
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
        const existing = state.bookmarks[key] || {};
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
        document.getElementById("popoverRefTitle").textContent = `${bookAbbr} ${chapter},${vnum} — ${bookTitle}`;
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
      const isDone = Boolean((state.progress[ctx.planId] || {})[String(ctx.day)]);
      document.getElementById("bannerPlanDayTitle").textContent = `🗓️ Dan ${ctx.day}: ${ctx.label}`;
      const markBtn = document.getElementById("btnBannerMarkDone");
      markBtn.textContent = isDone ? "✓ Dan je označen pročitanim" : `✓ Označi Dan ${ctx.day} pročitanim`;
      markBtn.style.background = isDone ? "#388e3c" : "var(--accent)";

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
    const closeBtn = document.getElementById("btnClosePopover");
    if (!closeBtn) return;

    closeBtn.addEventListener("click", () => {
      document.getElementById("versePopover").classList.remove("open");
    });

    function saveBookmark(colorOverride) {
      const ctx = state.selectedVerseContext;
      if (!ctx) return;
      const color = colorOverride || ctx.color || "gold";
      const note = document.getElementById("popoverNoteInput").value.trim();
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
        created_at: new Date().toISOString(),
      };
      localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
      if (ctx.onRefresh) ctx.onRefresh();
    }

    document.querySelectorAll(".color-dot").forEach((dot) => {
      dot.addEventListener("click", () => saveBookmark(dot.getAttribute("data-color")));
    });

    document.getElementById("btnSaveNote").addEventListener("click", () => {
      saveBookmark(null);
      document.getElementById("versePopover").classList.remove("open");
    });

    document.getElementById("btnRemoveBookmark").addEventListener("click", () => {
      const ctx = state.selectedVerseContext;
      if (!ctx) return;
      delete state.bookmarks[ctx.key];
      localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
      document.getElementById("versePopover").classList.remove("open");
      if (ctx.onRefresh) ctx.onRefresh();
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
    const cur = Boolean(state.progress[planId][String(dayNum)]);
    const nextVal = forceValue !== null ? forceValue : !cur;
    if (nextVal) {
      state.progress[planId][String(dayNum)] = new Date().toISOString();
    } else {
      delete state.progress[planId][String(dayNum)];
    }
    localStorage.setItem("biblija_progress", JSON.stringify(state.progress));
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
        renderPlan();
      });
    }

    document.querySelectorAll("[data-dayfilter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-dayfilter]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.dayFilter = btn.getAttribute("data-dayfilter");
        renderPlan();
      });
    });

    const daySearchInput = document.getElementById("daySearchInput");
    if (daySearchInput) {
      daySearchInput.addEventListener("input", (e) => {
        state.daySearch = e.target.value;
        renderPlan();
      });
    }

    async function renderPlan() {
      if (!state.loadedPlans[state.currentPlanId]) {
        const res = await fetch(`/data/json/plans/${state.currentPlanId}.json`);
        state.loadedPlans[state.currentPlanId] = await res.json();
      }
      const plan = state.loadedPlans[state.currentPlanId];
      document.getElementById("planDescription").textContent = plan.description;

      const doneMap = state.progress[plan.id] || {};
      const doneCount = plan.days.filter((d) => Boolean(doneMap[String(d.day)])).length;
      const pct = Math.round((doneCount / plan.days_count) * 100);
      document.getElementById("planProgressBar").style.width = `${pct}%`;
      document.getElementById("planProgressStats").textContent = `Pročitano: ${doneCount} / ${plan.days_count} dana (${pct}%)`;

      const nextDayObj = plan.days.find((d) => !doneMap[String(d.day)]) || plan.days[plan.days.length - 1];
      document.getElementById("planNextSuggested").textContent =
        doneCount === plan.days_count
          ? "🎉 Čestitamo! Plan je u cijelosti pročitan!"
          : `Sljedeći nepročitani dan: Dan ${nextDayObj.day} (${nextDayObj.label})`;

      const hero = document.getElementById("currentDayHeroCard");
      if (nextDayObj) {
        const readingBtns = nextDayObj.readings
          .map(
            (r, idx) =>
              `<button class="icon-btn hero-read-btn" data-ridx="${idx}" style="border-color:var(--accent);">📖 Čitaj: <strong>${escapeHtml(r.label)}</strong> (${escapeHtml(r.book_title)})</button>`
          )
          .join(" ");

        hero.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.75rem;">
            <div>
              <span class="badge" style="background:var(--accent);color:#fff;">Današnje čitanje • Dan ${nextDayObj.day} od ${plan.days_count}</span>
              <h3 style="margin:0.4rem 0 0.25rem;font-size:1.3rem;">${escapeHtml(nextDayObj.label)}</h3>
              <div style="font-size:0.84rem;color:var(--text-muted);">Ukupno ~${nextDayObj.verse_count} redaka u današnjem rasporedu</div>
            </div>
            <button class="icon-btn" id="btnHeroToggleDone" style="background:var(--accent);color:#fff;border-color:var(--accent);padding:0.5rem 0.95rem;">
              ✓ Označi Dan ${nextDayObj.day} pročitanim
            </button>
          </div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.85rem;">
            ${readingBtns}
          </div>
        `;

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
        const isDone = Boolean(doneMap[String(d.day)]);
        if (state.dayFilter === "todo" && isDone) return false;
        if (state.dayFilter === "done" && !isDone) return false;
        if (!q) return true;
        return `dan ${d.day}`.includes(q) || foldHr(d.label).includes(q);
      });

      grid.innerHTML = filteredDays
        .map((d) => {
          const isDone = Boolean(doneMap[String(d.day)]);
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
                <strong>Dan ${d.day}</strong>
                <span class="badge">${d.verse_count} redaka</span>
              </div>
              <div class="plan-reading-pills">${pills}</div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.25rem;">
                <button class="icon-btn day-open-first" data-day="${d.day}" style="font-size:0.78rem;">Otvori u čitaču →</button>
                <label style="font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:0.3rem;font-weight:600;">
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
              <span class="badge">Prepoznata biblijska kratica</span>
              <strong style="margin-left:0.5rem;">${escapeHtml(parsedRef.book.title)} — ${escapeHtml(refLbl)}</strong>
            </div>
            <a href="${targetUrl}" class="icon-btn" style="background:var(--accent);color:#fff;border-color:var(--accent);text-decoration:none;">
              Otvori ${escapeHtml(refLbl)} →
            </a>
          </div>
        `;
      } else {
        directCard.style.display = "none";
      }

      if (!q) {
        statusEl.textContent = "Upiši pojam za pretragu.";
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
              <div style="display:flex;justify-content:space-between;align-items:baseline;">
                <span class="search-result-ref">${escapeHtml(r.book_abbr)} ${r.chapter},${r.verse} — ${escapeHtml(r.book_title)}</span>
                <span class="badge">Otvori u čitaču →</span>
              </div>
              <div style="margin-top:0.25rem;font-family:var(--font-reading);font-size:1.02rem;">
                ${highlightMatch(r.text, q)}
              </div>
            </a>
          `;
        })
        .join("");
    }

    document.getElementById("btnRunSearch").addEventListener("click", runSearch);
    document.getElementById("searchInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSearch();
    });
    document.getElementById("searchTestamentFilter").addEventListener("change", runSearch);
    document.getElementById("searchBookFilter").addEventListener("change", runSearch);
  }

  /* ==================== NOTES & AUDIT PAGE ==================== */
  async function initNotesPage() {
    const root = document.getElementById("notesPageRoot");
    if (!root) return;

    await ensureBooksLoaded();

    function renderBookmarks() {
      const container = document.getElementById("bookmarksListContainer");
      const items = Object.values(state.bookmarks).sort((a, b) =>
        String(b.created_at || "").localeCompare(String(a.created_at || ""))
      );
      if (!items.length) {
        container.innerHTML = `<p style="color:var(--text-muted);font-size:0.9rem;">Još nemaš spremljenih oznaka ili bilješki. Tijekom čitanja klikni na bilo koji redak za označavanje.</p>`;
        return;
      }
      container.innerHTML = items
        .map((bm) => {
          const bmeta = state.booksByOrder[bm.book_order] || {};
          const bId = bm.book_id || bmeta.id || "knjiga-postanka";
          const abbr = bm.book_abbr || bmeta.abbr || "";
          const title = bm.book_title || bmeta.title || "";
          return `
            <a href="/${escapeHtml(bId)}/${bm.chapter}/#v-${bm.verse}" class="search-result-item" style="display:block;text-decoration:none;color:inherit;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="search-result-ref">${escapeHtml(abbr)} ${bm.chapter},${bm.verse} (${escapeHtml(title)})</span>
                <span class="badge hl-${escapeHtml(bm.color || "gold")}">Oznaka</span>
              </div>
              <div style="margin-top:0.25rem;font-family:var(--font-reading);">${escapeHtml(bm.text || "")}</div>
              ${bm.note ? `<div style="margin-top:0.35rem;font-size:0.86rem;color:var(--accent);font-weight:600;">✎ Bilješka: ${escapeHtml(bm.note)}</div>` : ""}
            </a>
          `;
        })
        .join("");
    }

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
        } catch (_) {
          alert("Neispravna JSON datoteka.");
        }
      };
      reader.readAsText(file);
    });
  }

  /* ==================== GLOBAL INIT ==================== */
  window.addEventListener("DOMContentLoaded", () => {
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
  });
})();
