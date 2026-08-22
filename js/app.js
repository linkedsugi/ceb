/* 영한 성경 대조 웹앱
 * 데이터는 data/<version>/<bookId>.js 를 <script> 태그로 지연 로드한다.
 * (fetch 대신 script 주입을 쓰므로 file:// 로 열어도 동작한다)
 */

const BibleData = (() => {
  const store = {};   // store[version][bookId] = { chapters, titles }
  const pending = {}; // pending[version:bookId] = Promise

  function register(version, bookId, chapters, titles) {
    (store[version] = store[version] || {})[bookId] = { chapters, titles: titles || {} };
  }

  function load(version, bookId) {
    if (store[version] && store[version][bookId]) {
      return Promise.resolve(store[version][bookId]);
    }
    const key = version + ":" + bookId;
    if (pending[key]) return pending[key];
    pending[key] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "data/" + version + "/" + bookId + ".js";
      s.onload = () => {
        delete pending[key];
        const b = store[version] && store[version][bookId];
        b ? resolve(b) : reject(new Error("데이터 없음: " + key));
      };
      s.onerror = () => {
        delete pending[key];
        reject(new Error("데이터를 불러오지 못했습니다: " + key));
      };
      document.head.appendChild(s);
    });
    return pending[key];
  }

  return { register, load, store };
})();

/* ── API.Bible (Common English Bible 온라인) ─────
 * CEB는 저작권 번역이라 본문을 내장할 수 없고,
 * 사용자 브라우저에서 API.Bible을 직접 호출해 표시한다.
 */
const CebApi = (() => {
  const BASE = "https://api.scripture.api.bible/v1";
  const chapterCache = {}; // "book:chapter" -> { verses, title }
  let bibleIdPromise = null;

  function enabled() {
    return typeof API_BIBLE_KEY !== "undefined" && API_BIBLE_KEY;
  }

  async function req(path) {
    const res = await fetch(BASE + path, { headers: { "api-key": API_BIBLE_KEY } });
    if (res.status === 401 || res.status === 403) {
      throw new Error("API 키가 거부되었습니다 (" + res.status + "). 키 또는 사용 권한을 확인해 주세요.");
    }
    if (!res.ok) throw new Error("API.Bible 오류 (" + res.status + ")");
    const json = await res.json();
    reportFums(json.meta);
    return json;
  }

  // API.Bible 이용 조건인 FUMS(사용량 집계) 픽셀 보고
  function reportFums(meta) {
    if (meta && meta.fumsNoScript) {
      try { $("fums").innerHTML = meta.fumsNoScript; } catch (e) { /* 무시 */ }
    }
  }

  // 키에 허용된 성경 목록에서 CEB의 ID를 찾는다 (localStorage에 캐시)
  function getBibleId() {
    if (bibleIdPromise) return bibleIdPromise;
    bibleIdPromise = (async () => {
      try {
        const cached = localStorage.getItem("bible-app-ceb-id");
        if (cached) return cached;
      } catch (e) { /* 무시 */ }
      const json = await req("/bibles?language=eng");
      const list = json.data || [];
      const ceb = list.find((b) => /common english bible/i.test(b.name || "")) ||
                  list.find((b) => (b.abbreviation || "").toUpperCase() === "CEB");
      if (!ceb) {
        throw new Error("이 API 키로는 Common English Bible을 사용할 수 없습니다. " +
          "API.Bible 대시보드에서 CEB 사용 신청이 승인되었는지 확인해 주세요.");
      }
      try { localStorage.setItem("bible-app-ceb-id", ceb.id); } catch (e) { /* 무시 */ }
      return ceb.id;
    })();
    bibleIdPromise.catch(() => { bibleIdPromise = null; }); // 실패 시 다음에 재시도
    return bibleIdPromise;
  }

  // "[1] 본문 [2] 본문…" 형태의 텍스트를 절 배열로 파싱
  function parseContent(content) {
    const parts = String(content).split(/\s*\[(\d+)\]\s*/);
    const verses = [];
    const title = parts[0] ? parts[0].replace(/\s+/g, " ").trim() : "";
    for (let i = 1; i + 1 <= parts.length - 1; i += 2) {
      verses[Number(parts[i]) - 1] = parts[i + 1].replace(/\s+/g, " ").trim();
    }
    for (let i = 0; i < verses.length; i++) if (verses[i] == null) verses[i] = "";
    return { verses, title };
  }

  async function chapter(book, ch) {
    const key = book + ":" + ch;
    if (chapterCache[key]) return chapterCache[key];
    const id = await getBibleId();
    const chapterId = USFM[book] + "." + ch;
    const json = await req("/bibles/" + id + "/chapters/" + chapterId +
      "?content-type=text&include-verse-numbers=true&include-titles=false" +
      "&include-notes=false&include-chapter-numbers=false");
    const parsed = parseContent(json.data && json.data.content);
    if (!parsed.verses.length) throw new Error("본문을 해석하지 못했습니다: " + chapterId);
    chapterCache[key] = parsed;
    return parsed;
  }

  async function search(q, limit) {
    const id = await getBibleId();
    const json = await req("/bibles/" + id + "/search?query=" +
      encodeURIComponent(q) + "&limit=" + (limit || 100) + "&sort=canonical");
    const verses = (json.data && json.data.verses) || [];
    const byCode = {};
    USFM.forEach((code, i) => { if (code) byCode[code] = i; });
    return verses.map((v) => {
      const p = String(v.id || "").split("."); // 예: JHN.3.16
      const book = byCode[p[0]];
      if (!book) return null;
      return { book, chapter: Number(p[1]), verse: Number(p[2]), text: v.text || "" };
    }).filter(Boolean);
  }

  return { enabled, chapter, search };
})();

/* ── 상태 ─────────────────────────────── */
const state = {
  book: 43,       // 요한복음
  chapter: 3,
  version: "web", // 영어 번역본
  mode: "both",   // both | en | ko
  fontScale: 1,
  theme: "auto",
};

const LS_KEY = "bible-app-state";

function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      book: state.book, chapter: state.chapter, version: state.version,
      mode: state.mode, fontScale: state.fontScale, theme: state.theme,
    }));
  } catch (e) { /* 사생활 보호 모드 등에서 실패해도 무시 */ }
}

function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY));
    if (saved) Object.assign(state, saved);
  } catch (e) { /* 무시 */ }
}

function bookMeta(id) { return BOOKS[id - 1]; }

/* ── DOM 헬퍼 ──────────────────────────── */
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

/* ── 테마 / 글자 크기 ───────────────────── */
function applyTheme() {
  const dark = state.theme === "dark" ||
    (state.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("themeBtn").textContent = dark ? "☀️" : "🌙";
}

function applyFont() {
  document.documentElement.style.setProperty("--font-scale", state.fontScale);
}

/* ── 본문 렌더링 ────────────────────────── */
let renderToken = 0;

// 선택된 영어 번역본의 해당 장을 { verses, title } 형태로 반환
async function loadEnglishChapter(book, chapter) {
  if (state.version === "ceb") {
    return CebApi.chapter(book, chapter);
  }
  const en = await BibleData.load(state.version, book);
  return {
    verses: en.chapters[chapter - 1] || [],
    title: (en.titles && en.titles[String(chapter)]) || "",
  };
}

async function renderChapter(highlightVerse) {
  const meta = bookMeta(state.book);
  const reader = $("reader");
  const token = ++renderToken;
  $("refText").textContent = meta[1] + " " + state.chapter + "장";
  document.title = meta[1] + " " + state.chapter + "장 — 영한 성경";
  reader.className = "reader mode-" + state.mode;
  reader.innerHTML = '<div class="loading">불러오는 중…</div>';

  let en, ko;
  try {
    [en, ko] = await Promise.all([
      loadEnglishChapter(state.book, state.chapter),
      BibleData.load("krv", state.book),
    ]);
  } catch (err) {
    if (token !== renderToken) return;
    reader.innerHTML = "";
    reader.appendChild(el("div", "loading",
      "본문을 불러오지 못했습니다. " + (err && err.message ? err.message : "")));
    if (state.version === "ceb") {
      const back = el("button", "pager-btn", "WEB(오프라인) 번역으로 보기");
      back.style.display = "block";
      back.style.margin = "0 auto";
      back.addEventListener("click", () => {
        state.version = "web";
        $("versionSel").value = "web";
        renderChapter();
      });
      reader.appendChild(back);
    }
    return;
  }
  if (token !== renderToken) return;

  const ci = state.chapter - 1;
  const enVerses = en.verses;
  const koVerses = ko.chapters[ci] || [];
  const count = Math.max(enVerses.length, koVerses.length);

  reader.innerHTML = "";
  const heading = el("h1", "chapter-heading", meta[1] + " " + state.chapter + "장");
  const sub = el("span", "sub", meta[2] + " " + state.chapter);
  heading.appendChild(sub);
  reader.appendChild(heading);

  if (en.title && state.mode !== "ko") {
    reader.appendChild(el("div", "psalm-title", en.title));
  }

  for (let v = 0; v < count; v++) {
    const row = el("div", "verse");
    row.dataset.verse = v + 1;
    row.appendChild(el("div", "verse-num", String(v + 1)));
    const body = el("div", "verse-body");
    if (enVerses[v]) body.appendChild(el("div", "verse-en", enVerses[v]));
    if (koVerses[v]) body.appendChild(el("div", "verse-ko", koVerses[v]));
    row.appendChild(body);
    row.addEventListener("click", () => copyVerse(meta, v + 1, enVerses[v], koVerses[v]));
    reader.appendChild(row);
  }

  $("prevBtn").disabled = state.book === 1 && state.chapter === 1;
  $("nextBtn").disabled = state.book === 66 && state.chapter === bookMeta(66)[3];

  location.hash = "#" + state.book + "/" + state.chapter + (highlightVerse ? "/" + highlightVerse : "");
  saveState();
  renderBookListActive();

  if (highlightVerse) {
    const target = reader.querySelector('.verse[data-verse="' + highlightVerse + '"]');
    if (target) {
      target.classList.add("highlight");
      target.scrollIntoView({ block: "center" });
      setTimeout(() => target.classList.remove("highlight"), 3000);
    }
  } else {
    scrollTo(0, 0);
  }
}

function copyVerse(meta, num, enText, koText) {
  const ref = meta[1] + " " + state.chapter + ":" + num;
  const parts = [ref];
  if (state.mode !== "ko" && enText) parts.push(enText);
  if (state.mode !== "en" && koText) parts.push(koText);
  const text = parts.join("\n");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => toast(ref + " 복사됨"))
      .catch(() => toast("복사하지 못했습니다"));
  } else {
    toast("이 브라우저에서는 복사를 지원하지 않습니다");
  }
}

/* ── 탐색 ─────────────────────────────── */
function goTo(book, chapter, verse) {
  state.book = book;
  state.chapter = chapter;
  renderChapter(verse);
}

function step(delta) {
  let b = state.book, c = state.chapter + delta;
  if (c < 1) {
    if (b === 1) return;
    b -= 1;
    c = bookMeta(b)[3];
  } else if (c > bookMeta(b)[3]) {
    if (b === 66) return;
    b += 1;
    c = 1;
  }
  goTo(b, c);
}

/* ── 책 목록 / 장 선택 ─────────────────── */
function buildBookList() {
  const ot = $("otList"), nt = $("ntList");
  BOOKS.forEach((b) => {
    const btn = el("button", "book-item");
    btn.dataset.book = b[0];
    btn.appendChild(el("span", "ko", b[1]));
    btn.appendChild(el("span", "en", b[2]));
    btn.addEventListener("click", () => {
      closePanels();
      openChapterPicker(b[0]);
    });
    (b[0] <= 39 ? ot : nt).appendChild(btn);
  });
}

function renderBookListActive() {
  document.querySelectorAll(".book-item").forEach((n) => {
    n.classList.toggle("active", Number(n.dataset.book) === state.book);
  });
}

function openChapterPicker(bookId) {
  const meta = bookMeta(bookId);
  $("chapterPickerTitle").textContent = meta[1] + " (" + meta[2] + ")";
  const grid = $("chapterGrid");
  grid.innerHTML = "";
  for (let c = 1; c <= meta[3]; c++) {
    const cell = el("button", "chapter-cell", String(c));
    if (bookId === state.book && c === state.chapter) cell.classList.add("active");
    cell.addEventListener("click", () => {
      closePanels();
      goTo(bookId, c);
    });
    grid.appendChild(cell);
  }
  $("overlay").hidden = false;
  $("chapterPicker").hidden = false;
}

function openSidebar() {
  $("overlay").hidden = false;
  $("sidebar").hidden = false;
  const active = document.querySelector(".book-item.active");
  if (active) active.scrollIntoView({ block: "center" });
}

function closePanels() {
  $("sidebar").hidden = true;
  $("chapterPicker").hidden = true;
  $("searchPanel").hidden = true;
  $("overlay").hidden = true;
}

/* ── 검색 ─────────────────────────────── */
let searchToken = 0;

function openSearch() {
  $("overlay").hidden = false;
  $("searchPanel").hidden = false;
  $("searchInput").focus();
}

async function runSearch() {
  const q = $("searchInput").value.trim();
  const status = $("searchStatus");
  const box = $("searchResults");
  box.innerHTML = "";
  if (q.length < 2) {
    status.textContent = "두 글자 이상 입력한 뒤 Enter를 눌러 주세요.";
    return;
  }
  const token = ++searchToken;
  const isKorean = /[가-힣]/.test(q);
  const version = isKorean ? "krv" : state.version;
  const needle = isKorean ? q : q.toLowerCase();
  const MAX = 200;
  let hits = 0;

  status.textContent = "검색 중…";

  // CEB(온라인)는 API.Bible 검색 엔드포인트 사용
  if (version === "ceb") {
    try {
      const results = await CebApi.search(q, MAX);
      if (token !== searchToken) return;
      results.forEach((r) => {
        const meta = bookMeta(r.book);
        const hit = el("button", "search-hit");
        hit.appendChild(el("div", "ref", meta[1] + " " + r.chapter + ":" + r.verse));
        hit.appendChild(el("div", "snippet", r.text.slice(0, 160)));
        hit.addEventListener("click", () => {
          closePanels();
          goTo(r.book, r.chapter, r.verse);
        });
        box.appendChild(hit);
      });
      status.textContent = results.length === 0
        ? "「" + q + "」 검색 결과가 없습니다. (CEB)"
        : "「" + q + "」 " + results.length + "건 — CEB";
    } catch (err) {
      if (token !== searchToken) return;
      status.textContent = "CEB 검색 실패: " + (err && err.message ? err.message : "네트워크 오류");
    }
    return;
  }
  for (let b = 1; b <= 66 && hits < MAX; b++) {
    let data;
    try {
      data = await BibleData.load(version, b);
    } catch (e) { continue; }
    if (token !== searchToken) return; // 새 검색이 시작됨
    const meta = bookMeta(b);
    data.chapters.forEach((verses, ci) => {
      if (hits >= MAX) return;
      verses.forEach((text, vi) => {
        if (hits >= MAX) return;
        const hay = isKorean ? text : text.toLowerCase();
        const idx = hay.indexOf(needle);
        if (idx === -1) return;
        hits++;
        const hit = el("button", "search-hit");
        hit.appendChild(el("div", "ref", meta[1] + " " + (ci + 1) + ":" + (vi + 1)));
        const snippet = el("div", "snippet");
        const start = Math.max(0, idx - 40);
        if (start > 0) snippet.appendChild(document.createTextNode("…"));
        snippet.appendChild(document.createTextNode(text.slice(start, idx)));
        const mark = el("mark", null, text.slice(idx, idx + q.length));
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(text.slice(idx + q.length, idx + q.length + 60)));
        hit.appendChild(snippet);
        hit.addEventListener("click", () => {
          closePanels();
          goTo(b, ci + 1, vi + 1);
        });
        box.appendChild(hit);
      });
    });
    status.textContent = "검색 중… (" + meta[1] + ", " + hits + "건)";
  }
  if (token !== searchToken) return;
  status.textContent = hits === 0
    ? "「" + q + "」 검색 결과가 없습니다. (" + VERSIONS[version].label + ")"
    : "「" + q + "」 " + hits + "건" + (hits >= MAX ? " (최대 표시 수 도달)" : "") +
      " — " + VERSIONS[version].label;
}

/* ── 초기화 ────────────────────────────── */
function parseHash() {
  const m = location.hash.match(/^#(\d+)\/(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  const book = Number(m[1]), chapter = Number(m[2]);
  if (book < 1 || book > 66 || chapter < 1 || chapter > bookMeta(book)[3]) return null;
  return { book, chapter, verse: m[3] ? Number(m[3]) : null };
}

function init() {
  restoreState();
  const fromHash = parseHash();
  if (fromHash) {
    state.book = fromHash.book;
    state.chapter = fromHash.chapter;
  }

  applyTheme();
  applyFont();
  buildBookList();

  if (CebApi.enabled()) {
    const opt = document.createElement("option");
    opt.value = "ceb";
    opt.textContent = "CEB";
    opt.title = VERSIONS.ceb.full;
    $("versionSel").appendChild(opt);
  } else if (state.version === "ceb") {
    state.version = "web"; // 키가 제거된 경우
  }

  $("versionSel").value = state.version;
  $("modeSel").value = state.mode;

  $("menuBtn").addEventListener("click", openSidebar);
  $("refBtn").addEventListener("click", () => openChapterPicker(state.book));
  $("overlay").addEventListener("click", closePanels);
  $("chapterPickerClose").addEventListener("click", closePanels);
  $("searchClose").addEventListener("click", closePanels);
  $("prevBtn").addEventListener("click", () => step(-1));
  $("nextBtn").addEventListener("click", () => step(1));
  $("searchBtn").addEventListener("click", openSearch);
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });

  $("versionSel").addEventListener("change", (e) => {
    state.version = e.target.value;
    renderChapter();
  });
  $("modeSel").addEventListener("change", (e) => {
    state.mode = e.target.value;
    renderChapter();
  });
  $("fontPlus").addEventListener("click", () => {
    state.fontScale = Math.min(1.6, +(state.fontScale + 0.1).toFixed(2));
    applyFont(); saveState();
  });
  $("fontMinus").addEventListener("click", () => {
    state.fontScale = Math.max(0.7, +(state.fontScale - 0.1).toFixed(2));
    applyFont(); saveState();
  });
  $("themeBtn").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme === "dark";
    state.theme = dark ? "light" : "dark";
    applyTheme(); saveState();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") {
      if (e.key === "Escape") closePanels();
      return;
    }
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "Escape") closePanels();
    else if (e.key === "/") { e.preventDefault(); openSearch(); }
  });

  window.addEventListener("hashchange", () => {
    const h = parseHash();
    if (h && (h.book !== state.book || h.chapter !== state.chapter)) {
      goTo(h.book, h.chapter, h.verse);
    }
  });

  renderChapter(fromHash && fromHash.verse);
}

init();
