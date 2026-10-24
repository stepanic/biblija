/* Biblija 365 & Offline Pretraživač — Dual-mode (SQLite Server + Static JSON PWA) */

const state = {
  hasSqliteServer: false,
  books: [],
  booksByOrder: {},
  bookCache: {},
  plansIndex: [],
  loadedPlans: {},
  currentBookOrder: 1,
  currentChapter: 1,
  highlightVerse: null,
  testamentFilter: "ALL",
  bookQuery: "",
  currentPlanId: localStorage.getItem("biblija_plan_id") || "mb-tematski-365",
  activePlanDayContext: null, // { planId, day, readings, label }
  dayFilter: "all",
  daySearch: "",
  progress: JSON.parse(localStorage.getItem("biblija_progress") || "{}"),
  bookmarks: JSON.parse(localStorage.getItem("biblija_bookmarks") || "{}"), // key: "order:ch:verse"
  selectedVerseContext: null,
  compactVersesCache: null,
  fontSize: parseInt(localStorage.getItem("biblija_fontsize") || "19", 10),
  theme: localStorage.getItem("biblija_theme") || "light",
};

const CRO_MAP = {
  "č": "c", "ć": "c", "ž": "z", "š": "s", "đ": "d",
  "Č": "c", "Ć": "c", "Ž": "z", "Š": "s", "Đ": "d",
};

function foldHr(str) {
  if (!str) return "";
  return str
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

function pad2(n) {
  return String(n).padStart(2, "0");
}

function applyThemeAndFont() {
  document.documentElement.setAttribute("data-theme", state.theme);
  document.documentElement.style.setProperty("--font-size-reading", `${state.fontSize}px`);
  localStorage.setItem("biblija_theme", state.theme);
  localStorage.setItem("biblija_fontsize", String(state.fontSize));
}

async function detectServerAndSync() {
  const pill = document.getElementById("engineStatusPill");
  try {
    const res = await fetch("api/status", { cache: "no-store" });
    if (res.ok) {
      const info = await res.json();
      if (info && info.mode === "sqlite-server") {
        state.hasSqliteServer = true;
        pill.textContent = "⚡ SQLite + FTS5 (biblija.db)";
        pill.style.borderColor = "var(--accent)";
        await syncFromSqliteServer();
        return;
      }
    }
  } catch (_) {
    // Fallback to pure static JSON mode
  }
  state.hasSqliteServer = false;
  pill.textContent = "📦 Statički JSON (Offline PWA)";
}

async function syncFromSqliteServer() {
  try {
    const [pRes, bRes] = await Promise.all([fetch("api/progress"), fetch("api/bookmarks")]);
    if (pRes.ok) {
      const pData = await pRes.json();
      if (pData.progress) {
        for (const [pid, daysObj] of Object.entries(pData.progress)) {
          state.progress[pid] = { ...(state.progress[pid] || {}), ...daysObj };
        }
        localStorage.setItem("biblija_progress", JSON.stringify(state.progress));
      }
    }
    if (bRes.ok) {
      const bData = await bRes.json();
      if (Array.isArray(bData.bookmarks)) {
        for (const bm of bData.bookmarks) {
          const key = `${bm.book_order}:${bm.chapter}:${bm.verse}`;
          state.bookmarks[key] = {
            book_order: bm.book_order,
            chapter: bm.chapter,
            verse: bm.verse,
            color: bm.color || "gold",
            note: bm.note || "",
            created_at: bm.created_at,
            text: bm.text || "",
          };
        }
        localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
      }
    }
  } catch (e) {
    console.warn("SQLite sync warning:", e);
  }
}

async function loadBookData(bookOrder) {
  if (state.bookCache[bookOrder]) return state.bookCache[bookOrder];
  const bmeta = state.booksByOrder[bookOrder];
  if (!bmeta) throw new Error(`Nepoznata knjiga #${bookOrder}`);
  const url = `data/json/books/${pad2(bookOrder)}_${bmeta.id}.json`;
  const res = await fetch(url);
  const data = await res.json();
  state.bookCache[bookOrder] = data;
  return data;
}

async function loadPlanData(planId) {
  if (state.loadedPlans[planId]) return state.loadedPlans[planId];
  const res = await fetch(`data/json/plans/${planId}.json`);
  const data = await res.json();
  state.loadedPlans[planId] = data;
  return data;
}

/* ==================== READER VIEW ==================== */

function renderBookSidebar() {
  const container = document.getElementById("bookListContainer");
  const q = foldHr(state.bookQuery.trim());
  const filtered = state.books.filter((b) => {
    if (state.testamentFilter !== "ALL" && b.testament !== state.testamentFilter) return false;
    if (!q) return true;
    return foldHr(b.title).includes(q) || foldHr(b.abbr).includes(q) || foldHr(b.category).includes(q);
  });

  const groups = {};
  for (const b of filtered) {
    if (!groups[b.category]) groups[b.category] = [];
    groups[b.category].push(b);
  }

  let html = "";
  for (const [cat, items] of Object.entries(groups)) {
    html += `<div class="book-group-title">${escapeHtml(cat)}</div>`;
    for (const b of items) {
      const isAct = b.order === state.currentBookOrder ? "active" : "";
      html += `
        <button class="book-item ${isAct}" data-order="${b.order}">
          <span><span class="book-item-abbr">${escapeHtml(b.abbr)}</span> ${escapeHtml(b.title)}</span>
          <span class="book-item-count">${b.chapter_count}</span>
        </button>
      `;
    }
  }
  container.innerHTML = html || `<div style="padding:0.8rem;color:var(--text-muted);font-size:0.85rem;">Nema pronađenih knjiga.</div>`;

  container.querySelectorAll(".book-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = parseInt(btn.getAttribute("data-order"), 10);
      openChapter(order, 1, null);
    });
  });
}

async function openChapter(bookOrder, chapterNum, highlightVerse = null) {
  state.currentBookOrder = bookOrder;
  state.highlightVerse = highlightVerse;
  const book = await loadBookData(bookOrder);

  const availableChs = book.chapters.map((c) => c.chapter);
  if (!availableChs.includes(chapterNum)) {
    chapterNum = availableChs.includes(1) ? 1 : availableChs[0];
  }
  state.currentChapter = chapterNum;

  localStorage.setItem("biblija_last_book", String(bookOrder));
  localStorage.setItem("biblija_last_ch", String(chapterNum));

  renderBookSidebar();
  renderReaderPlanBanner();

  document.getElementById("readerCategoryBadge").textContent = `${book.testament} • ${book.category}`;
  document.getElementById("readerBookTitle").textContent = book.title;
  const chObj = book.chapters.find((c) => c.chapter === chapterNum);
  const chLabel = chapterNum === 0 ? "Proslov" : `Poglavlje ${chapterNum}`;
  document.getElementById("readerChapterMeta").textContent = `${chLabel} (${chObj ? chObj.verse_count : 0} redaka)`;
  document.getElementById("footerLocationLabel").textContent = `${book.abbr} ${chapterNum === 0 ? "Proslov" : chapterNum}`;

  // Chapter pills
  const chGrid = document.getElementById("chapterGrid");
  chGrid.innerHTML = book.chapters
    .map((c) => {
      const lbl = c.chapter === 0 ? "Proslov" : c.chapter;
      const act = c.chapter === chapterNum ? "active" : "";
      return `<button class="ch-pill ${act}" data-ch="${c.chapter}">${lbl}</button>`;
    })
    .join("");

  chGrid.querySelectorAll(".ch-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      openChapter(bookOrder, parseInt(btn.getAttribute("data-ch"), 10), null);
    });
  });

  // Render verses
  const bodyEl = document.getElementById("chapterBody");
  if (!chObj) {
    bodyEl.innerHTML = `<p>Poglavlje nije pronađeno.</p>`;
    return;
  }

  let out = "";
  for (const v of chObj.verses) {
    if (v.headings && v.headings.length) {
      for (const h of v.headings) {
        const tag = ["h2", "h3", "h4"].includes(h.level) ? h.level : "h4";
        out += `<${tag} class="sec-${tag}">${escapeHtml(h.text)}</${tag}>`;
      }
    }
    if (v.references && v.references.length) {
      for (const refStr of v.references) {
        out += `<div class="sec-ref">${escapeHtml(refStr)}</div>`;
      }
    }

    const bmKey = `${bookOrder}:${chapterNum}:${v.verse}`;
    const bm = state.bookmarks[bmKey];
    const hlClass = bm && bm.color ? `hl-${bm.color}` : "";
    const flashClass = state.highlightVerse === v.verse ? "flash-target" : "";
    const poeticClass = v.lines && v.lines.length > 1 ? "poetic-block" : "";
    const vLabel = v.verse_label || v.verse;
    const noteBadge = bm && bm.note ? `<span class="verse-note-badge" title="${escapeHtml(bm.note)}">✎ bilješka</span>` : "";

    if (v.lines && v.lines.length > 1) {
      const linesHtml = v.lines
        .map((ln, idx) =>
          idx === 0
            ? `<span class="poetic-line"><sup class="verse-sup">${escapeHtml(vLabel)}</sup>${escapeHtml(ln)}</span>`
            : `<span class="poetic-line">${escapeHtml(ln)}</span>`
        )
        .join("");
      out += `<span class="verse-item ${poeticClass} ${hlClass} ${flashClass}" id="v-${v.verse}" data-verse="${v.verse}">${linesHtml}${noteBadge}</span> `;
    } else {
      out += `<span class="verse-item ${hlClass} ${flashClass}" id="v-${v.verse}" data-verse="${v.verse}"><sup class="verse-sup">${escapeHtml(vLabel)}</sup>${escapeHtml(v.text)}${noteBadge}</span> `;
    }
  }

  bodyEl.innerHTML = out;

  bodyEl.querySelectorAll(".verse-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const vnum = parseInt(el.getAttribute("data-verse"), 10);
      const vObj = chObj.verses.find((x) => x.verse === vnum);
      openVersePopover(book, chapterNum, vObj);
    });
  });

  if (highlightVerse) {
    setTimeout(() => {
      const target = document.getElementById(`v-${highlightVerse}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function renderReaderPlanBanner() {
  const banner = document.getElementById("readerPlanBanner");
  const ctx = state.activePlanDayContext;
  if (!ctx) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  const isDone = Boolean((state.progress[ctx.planId] || {})[String(ctx.day)]);
  document.getElementById("bannerPlanDayTitle").textContent = `🗓️ Dan ${ctx.day}: ${ctx.label}`;

  const markBtn = document.getElementById("btnBannerMarkDone");
  markBtn.textContent = isDone ? "✓ Dan je označen pročitanim" : "✓ Označi Dan " + ctx.day + " pročitanim";
  markBtn.style.background = isDone ? "#388e3c" : "var(--accent)";

  const pillsContainer = document.getElementById("bannerPlanPills");
  const pills = [];
  for (const r of ctx.readings) {
    for (let ch = r.chapter_start; ch <= r.chapter_end; ch++) {
      const act = r.book_order === state.currentBookOrder && ch === state.currentChapter ? "active" : "";
      const chLbl = ch === 0 ? "Proslov" : ch;
      pills.push(
        `<button class="plan-reading-pill ${act}" data-bo="${r.book_order}" data-ch="${ch}">${escapeHtml(r.book_abbr)} ${chLbl}</button>`
      );
    }
  }
  pillsContainer.innerHTML = pills.join("");
  pillsContainer.querySelectorAll(".plan-reading-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      openChapter(parseInt(btn.getAttribute("data-bo"), 10), parseInt(btn.getAttribute("data-ch"), 10), null);
    });
  });
}

function navigateAdjacentChapter(delta) {
  const book = state.bookCache[state.currentBookOrder];
  if (!book) return;
  const chs = book.chapters.map((c) => c.chapter);
  const idx = chs.indexOf(state.currentChapter);
  if (idx + delta >= 0 && idx + delta < chs.length) {
    openChapter(state.currentBookOrder, chs[idx + delta], null);
  } else if (delta > 0 && state.currentBookOrder < 73) {
    openChapter(state.currentBookOrder + 1, 1, null);
  } else if (delta < 0 && state.currentBookOrder > 1) {
    loadBookData(state.currentBookOrder - 1).then((prevBook) => {
      const lastCh = prevBook.chapters[prevBook.chapters.length - 1].chapter;
      openChapter(prevBook.order, lastCh, null);
    });
  }
}

/* ==================== VERSE POPOVER & BOOKMARKS ==================== */

function openVersePopover(book, chapterNum, verseObj) {
  const pop = document.getElementById("versePopover");
  const key = `${book.order}:${chapterNum}:${verseObj.verse}`;
  const existing = state.bookmarks[key] || {};
  state.selectedVerseContext = {
    key,
    book_order: book.order,
    book_abbr: book.abbr,
    book_title: book.title,
    chapter: chapterNum,
    verse: verseObj.verse,
    text: verseObj.text,
    color: existing.color || "gold",
  };
  document.getElementById("popoverRefTitle").textContent = `${book.abbr} ${chapterNum},${verseObj.verse} — ${book.title}`;
  document.getElementById("popoverNoteInput").value = existing.note || "";
  pop.classList.add("open");
}

async function saveCurrentBookmark(colorOverride = null) {
  const ctx = state.selectedVerseContext;
  if (!ctx) return;
  const color = colorOverride || ctx.color || "gold";
  const note = document.getElementById("popoverNoteInput").value.trim();
  const now = new Date().toISOString();
  state.bookmarks[ctx.key] = {
    book_order: ctx.book_order,
    book_abbr: ctx.book_abbr,
    book_title: ctx.book_title,
    chapter: ctx.chapter,
    verse: ctx.verse,
    color,
    note,
    text: ctx.text,
    created_at: now,
  };
  localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
  if (state.hasSqliteServer) {
    fetch("api/bookmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "upsert",
        book_order: ctx.book_order,
        chapter: ctx.chapter,
        verse: ctx.verse,
        color,
        note,
      }),
    }).catch(() => {});
  }
  await openChapter(state.currentBookOrder, state.currentChapter, null);
  renderBookmarksTab();
}

async function removeCurrentBookmark() {
  const ctx = state.selectedVerseContext;
  if (!ctx) return;
  delete state.bookmarks[ctx.key];
  localStorage.setItem("biblija_bookmarks", JSON.stringify(state.bookmarks));
  if (state.hasSqliteServer) {
    fetch("api/bookmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        book_order: ctx.book_order,
        chapter: ctx.chapter,
        verse: ctx.verse,
      }),
    }).catch(() => {});
  }
  document.getElementById("versePopover").classList.remove("open");
  await openChapter(state.currentBookOrder, state.currentChapter, null);
  renderBookmarksTab();
}

/* ==================== BIBLIJA 365 VIEW ==================== */

async function renderPlan365View() {
  const sel = document.getElementById("planSelector");
  if (!sel.options.length) {
    sel.innerHTML = state.plansIndex
      .map((p) => {
        const prefix = p.category === "biblija-365" ? "★ " : "• ";
        return `<option value="${escapeHtml(p.id)}">${prefix}${escapeHtml(p.title)} (${p.days_count} dana)</option>`;
      })
      .join("");
    sel.value = state.currentPlanId;
  }

  const plan = await loadPlanData(state.currentPlanId);
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

  // Render Hero Card for next unread day
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
    });

    hero.querySelectorAll(".hero-read-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = nextDayObj.readings[parseInt(btn.getAttribute("data-ridx"), 10)];
        openPlanDayInReader(plan, nextDayObj, r.book_order, r.chapter_start);
      });
    });
  }

  // Render Days Grid
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
    });
  });

  grid.querySelectorAll(".day-open-first").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dayNum = parseInt(btn.getAttribute("data-day"), 10);
      const dayObj = plan.days.find((x) => x.day === dayNum);
      if (dayObj && dayObj.readings.length) {
        openPlanDayInReader(plan, dayObj, dayObj.readings[0].book_order, dayObj.readings[0].chapter_start);
      }
    });
  });

  grid.querySelectorAll(".day-pill-jump").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dayNum = parseInt(btn.getAttribute("data-day"), 10);
      const ridx = parseInt(btn.getAttribute("data-ridx"), 10);
      const dayObj = plan.days.find((x) => x.day === dayNum);
      if (dayObj && dayObj.readings[ridx]) {
        openPlanDayInReader(plan, dayObj, dayObj.readings[ridx].book_order, dayObj.readings[ridx].chapter_start);
      }
    });
  });
}

function openPlanDayInReader(plan, dayObj, bookOrder, chapterNum) {
  state.activePlanDayContext = {
    planId: plan.id,
    day: dayObj.day,
    label: dayObj.label,
    readings: dayObj.readings,
  };
  switchTab("reader");
  openChapter(bookOrder, chapterNum, null);
}

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

  if (state.hasSqliteServer) {
    fetch("api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_id: planId, day: dayNum, completed: nextVal }),
    }).catch(() => {});
  }

  renderPlan365View();
  renderReaderPlanBanner();
}

/* ==================== SEARCH & CITATION PARSER ==================== */

function parseBibleReference(rawQuery) {
  // Matches e.g. "Iv 1,19", "1 Kor 13, 4-7", "Post 1", "Ps 23,1"
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

  // Build diacritic-tolerant regex for highlighting
  const charMap = {
    c: "[cčćCČĆ]",
    z: "[zžZŽ]",
    s: "[sšSŠ]",
    d: "[dđDĐ]",
  };
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

  // 1. Check direct citation reference
  const parsedRef = parseBibleReference(q);
  if (parsedRef) {
    const refLbl = `${parsedRef.book.abbr} ${parsedRef.chapter}${parsedRef.verse ? "," + parsedRef.verse : ""}`;
    directCard.style.display = "block";
    directCard.innerHTML = `
      <div class="active-plan-banner" style="margin:0;">
        <div>
          <span class="badge">Prepoznata biblijska kratica</span>
          <strong style="margin-left:0.5rem;">${escapeHtml(parsedRef.book.title)} — ${escapeHtml(refLbl)}</strong>
        </div>
        <button class="icon-btn" id="btnJumpParsedRef" style="background:var(--accent);color:#fff;border-color:var(--accent);">
          Otvori ${escapeHtml(refLbl)} →
        </button>
      </div>
    `;
    document.getElementById("btnJumpParsedRef").addEventListener("click", () => {
      switchTab("reader");
      openChapter(parsedRef.book.order, parsedRef.chapter, parsedRef.verse || null);
    });
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
    const params = new URLSearchParams({
      q,
      testament,
      book_order: bookOrderStr,
      limit: "100",
    });
    const res = await fetch(`api/search?${params.toString()}`);
    const data = await res.json();
    results = data.results || [];
    total = data.total || 0;
    engineLabel = "SQLite FTS5";
  } else {
    // Pure static fallback using verses_compact.json
    statusEl.textContent = "Učitavanje lokalnog indeksa redaka...";
    if (!state.compactVersesCache) {
      const res = await fetch("data/json/verses_compact.json");
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
            book_abbr: bmeta.abbr,
            book_title: bmeta.title,
            chapter: ch,
            verse: vnum,
            text: txt,
          });
        }
      }
    }
    engineLabel = "Lokalni statički JSON indeks";
  }

  const elapsed = (performance.now() - t0).toFixed(1);
  statusEl.textContent = `Pronađeno ${total} pogodaka u ${elapsed} ms (${engineLabel})${total > 100 ? " — prikazano prvih 100" : ""}`;

  listEl.innerHTML = results
    .map(
      (r) => `
      <div class="search-result-item" data-bo="${r.book_order}" data-ch="${r.chapter}" data-v="${r.verse}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <span class="search-result-ref">${escapeHtml(r.book_abbr)} ${r.chapter},${r.verse} — ${escapeHtml(r.book_title)}</span>
          <span class="badge">Otvori u čitaču →</span>
        </div>
        <div style="margin-top:0.25rem;font-family:var(--font-reading);font-size:1.02rem;">
          ${highlightMatch(r.text, q)}
        </div>
      </div>
    `
    )
    .join("");

  listEl.querySelectorAll(".search-result-item").forEach((el) => {
    el.addEventListener("click", () => {
      const bo = parseInt(el.getAttribute("data-bo"), 10);
      const ch = parseInt(el.getAttribute("data-ch"), 10);
      const v = parseInt(el.getAttribute("data-v"), 10);
      switchTab("reader");
      openChapter(bo, ch, v);
    });
  });
}

/* ==================== BOOKMARKS & AUDIT TAB ==================== */

function renderBookmarksTab() {
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
      const abbr = bm.book_abbr || bmeta.abbr || "";
      const title = bm.book_title || bmeta.title || "";
      return `
        <div class="search-result-item bm-jump-item" data-bo="${bm.book_order}" data-ch="${bm.chapter}" data-v="${bm.verse}">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="search-result-ref">${escapeHtml(abbr)} ${bm.chapter},${bm.verse} (${escapeHtml(title)})</span>
            <span class="badge hl-${escapeHtml(bm.color || "gold")}">Oznaka</span>
          </div>
          <div style="margin-top:0.25rem;font-family:var(--font-reading);">${escapeHtml(bm.text || "")}</div>
          ${bm.note ? `<div style="margin-top:0.35rem;font-size:0.86rem;color:var(--accent);font-weight:600;">✎ Bilješka: ${escapeHtml(bm.note)}</div>` : ""}
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".bm-jump-item").forEach((el) => {
    el.addEventListener("click", () => {
      switchTab("reader");
      openChapter(
        parseInt(el.getAttribute("data-bo"), 10),
        parseInt(el.getAttribute("data-ch"), 10),
        parseInt(el.getAttribute("data-v"), 10)
      );
    });
  });
}

async function renderAuditReport() {
  const container = document.getElementById("auditSummaryContainer");
  try {
    const res = await fetch("data/audit_report.json");
    const audit = await res.json();

    const sampleDiscrepancies = (audit.web_vs_mobile_api_discrepancies || []).slice(0, 12);
    const planBugs = audit.ks_reading_plan_bugs || [];

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0.75rem;margin-bottom:1.1rem;">
        <div style="background:var(--bg);padding:0.85rem;border-radius:8px;border:1px solid var(--border);">
          <div style="font-size:0.78rem;color:var(--text-muted);">Ukupno provjerenih redaka</div>
          <div style="font-size:1.5rem;font-weight:700;color:var(--accent);">${audit.total_verses.toLocaleString("hr-HR")}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);">73 knjige • 1.329 poglavlja (s Proslovom Siraha)</div>
        </div>
        <div style="background:var(--bg);padding:0.85rem;border-radius:8px;border:1px solid var(--border);">
          <div style="font-size:0.78rem;color:var(--text-muted);">Web vs. Mobilni API razlike</div>
          <div style="font-size:1.5rem;font-weight:700;color:var(--accent);">${audit.web_vs_mobile_api_discrepancies.length} redaka</div>
          <div style="font-size:0.78rem;color:var(--text-muted);">Pozicija broja retka i uputnica (popravljeno)</div>
        </div>
        <div style="background:var(--bg);padding:0.85rem;border-radius:8px;border:1px solid var(--border);">
          <div style="font-size:0.78rem;color:var(--text-muted);">Vraćeno skriveno poglavlje</div>
          <div style="font-size:1.5rem;font-weight:700;color:var(--accent);">Sirah 0 (Proslov)</div>
          <div style="font-size:0.78rem;color:var(--text-muted);">8 redaka nedostupnih u WP bible_chapter</div>
        </div>
        <div style="background:var(--bg);padding:0.85rem;border-radius:8px;border:1px solid var(--border);">
          <div style="font-size:0.78rem;color:var(--text-muted);">Greške u KS planovima čitanja</div>
          <div style="font-size:1.5rem;font-weight:700;color:var(--accent);">${planBugs.length} knjiga</div>
          <div style="font-size:0.78rem;color:var(--text-muted);">Preskočena poglavlja (npr. Dj 2, Mt 26, Mk 14)</div>
        </div>
      </div>

      <h4 style="margin:0.8rem 0 0.4rem;">1. Metapodaci knjiga i skrivena poglavlja (ispravljeno u katalogu)</h4>
      <ul style="font-size:0.88rem;margin-top:0.2rem;">
        <li><strong>Knjiga Izlaska (<code>knjiga-izlaska</code>):</strong> U KS API-ju stoji <code>chapter_count: 41</code> iako postoji samo 40 poglavlja (traženje 41. poglavlja vraća 404). Ispravljeno na <strong>40</strong>.</li>
        <li><strong>Knjiga Sirahova — Proslov prevodiočev (<code>chapter_id: 871</code>, poglavlje 0):</strong> U KS bazi postoji 8 redaka Proslova (ID 23140–23147), ali endpoint <code>/wp/v2/bible_chapter/871</code> puca s praznim odgovorom, a na webu ne postoji poveznica za Poglavlje 0. U našoj aplikaciji <strong>Proslov</strong> je vraćen kao uvodno poglavlje Knjige Sirahove.</li>
        <li><strong>Poslanica Kološanima:</strong> U KS API-ju naslov sadrži sirovi HTML entitet <code>Poslanica Kolo&amp;scaron;anima</code>. Očišćeno u <strong>Poslanica Kološanima</strong>.</li>
      </ul>

      <h4 style="margin:0.9rem 0 0.4rem;">2. Primjeri od 428 redaka gdje se Web i Mobilni API razlikuju (klikni za skok)</h4>
      <div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.8rem;">
        ${sampleDiscrepancies
          .map(
            (d) =>
              `<button class="plan-reading-pill audit-jump-btn" data-slug="${escapeHtml(d.book_slug)}" data-ch="${d.chapter}" data-v="${d.verse}">${escapeHtml(d.reference)}</button>`
          )
          .join("")}
      </div>

      <h4 style="margin:0.9rem 0 0.4rem;">3. Detektirana preskočena poglavlja u službenim KS planovima čitanja</h4>
      <div style="max-height:220px;overflow-y:auto;font-size:0.84rem;border:1px solid var(--border);border-radius:6px;padding:0.6rem;">
        ${planBugs
          .map(
            (b) =>
              `<div style="margin-bottom:0.25rem;">• <strong>${escapeHtml(b.plan_title)}</strong> → u knjizi <em>${escapeHtml(b.book)}</em> preskočena poglavlja: <code>${b.missing_chapters.join(", ")}</code></div>`
          )
          .join("")}
      </div>
    `;

    container.querySelectorAll(".audit-jump-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.getAttribute("data-slug");
        const ch = parseInt(btn.getAttribute("data-ch"), 10);
        const v = parseInt(btn.getAttribute("data-v"), 10);
        const book = state.books.find((x) => x.id === slug);
        if (book) {
          switchTab("reader");
          openChapter(book.order, ch, v);
        }
      });
    });
  } catch (e) {
    container.innerHTML = `<p>Greška pri učitavanju audit izvještaja.</p>`;
  }
}

/* ==================== NAVIGATION & INIT ==================== */

function switchTab(tabName) {
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabName);
  });
  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `view-${tabName}`);
  });
  if (tabName === "plan365") renderPlan365View();
  if (tabName === "notes") renderBookmarksTab();
  if (tabName === "search") {
    setTimeout(() => document.getElementById("searchInput").focus(), 50);
  }
}

async function initApp() {
  applyThemeAndFont();
  await detectServerAndSync();

  const [booksRes, plansRes] = await Promise.all([
    fetch("data/json/books.json"),
    fetch("data/json/plans/index.json"),
  ]);
  state.books = await booksRes.json();
  state.plansIndex = await plansRes.json();
  for (const b of state.books) {
    state.booksByOrder[b.order] = b;
  }

  // Populate search book dropdown
  const searchBookSel = document.getElementById("searchBookFilter");
  searchBookSel.innerHTML =
    `<option value="">Sve knjige (73)</option>` +
    state.books.map((b) => `<option value="${b.order}">${escapeHtml(b.abbr)} — ${escapeHtml(b.title)}</option>`).join("");

  // Bind top navigation tabs
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
  });

  // Font & Theme buttons
  document.getElementById("btnFontDec").addEventListener("click", () => {
    state.fontSize = Math.max(14, state.fontSize - 1);
    applyThemeAndFont();
  });
  document.getElementById("btnFontInc").addEventListener("click", () => {
    state.fontSize = Math.min(28, state.fontSize + 1);
    applyThemeAndFont();
  });
  document.getElementById("btnThemeToggle").addEventListener("click", () => {
    const order = ["light", "sepia", "dark"];
    state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
    applyThemeAndFont();
  });

  // Reader sidebar filters
  document.querySelectorAll("[data-testament]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-testament]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.testamentFilter = btn.getAttribute("data-testament");
      renderBookSidebar();
    });
  });

  document.getElementById("bookFilterInput").addEventListener("input", (e) => {
    state.bookQuery = e.target.value;
    renderBookSidebar();
  });

  document.getElementById("btnPrevChapter").addEventListener("click", () => navigateAdjacentChapter(-1));
  document.getElementById("btnNextChapter").addEventListener("click", () => navigateAdjacentChapter(1));

  // Reader Plan Banner controls
  document.getElementById("btnBannerClose").addEventListener("click", () => {
    state.activePlanDayContext = null;
    renderReaderPlanBanner();
  });
  document.getElementById("btnBannerMarkDone").addEventListener("click", () => {
    if (state.activePlanDayContext) {
      togglePlanDayCompleted(state.activePlanDayContext.planId, state.activePlanDayContext.day);
    }
  });

  // Verse popover controls
  document.getElementById("btnClosePopover").addEventListener("click", () => {
    document.getElementById("versePopover").classList.remove("open");
  });
  document.querySelectorAll(".color-dot").forEach((dot) => {
    dot.addEventListener("click", () => {
      saveCurrentBookmark(dot.getAttribute("data-color"));
    });
  });
  document.getElementById("btnSaveNote").addEventListener("click", () => {
    saveCurrentBookmark(null);
    document.getElementById("versePopover").classList.remove("open");
  });
  document.getElementById("btnRemoveBookmark").addEventListener("click", () => {
    removeCurrentBookmark();
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

  // Plan 365 controls
  document.getElementById("planSelector").addEventListener("change", (e) => {
    state.currentPlanId = e.target.value;
    localStorage.setItem("biblija_plan_id", state.currentPlanId);
    renderPlan365View();
  });
  document.querySelectorAll("[data-dayfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-dayfilter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.dayFilter = btn.getAttribute("data-dayfilter");
      renderPlan365View();
    });
  });
  document.getElementById("daySearchInput").addEventListener("input", (e) => {
    state.daySearch = e.target.value;
    renderPlan365View();
  });

  // Search controls
  document.getElementById("btnRunSearch").addEventListener("click", runSearch);
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  document.getElementById("searchTestamentFilter").addEventListener("change", runSearch);
  document.getElementById("searchBookFilter").addEventListener("change", runSearch);

  // Export / Import JSON backup
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
        renderBookmarksTab();
        renderPlan365View();
        openChapter(state.currentBookOrder, state.currentChapter, null);
      } catch (err) {
        alert("Neispravna JSON datoteka.");
      }
    };
    reader.readAsText(file);
  });

  // Initial load
  const lastBook = parseInt(localStorage.getItem("biblija_last_book") || "1", 10);
  const lastCh = parseInt(localStorage.getItem("biblija_last_ch") || "1", 10);
  await openChapter(lastBook, lastCh, null);
  renderAuditReport();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

window.addEventListener("DOMContentLoaded", initApp);
