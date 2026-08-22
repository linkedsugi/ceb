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

/* ── YouVersion Platform (Common English Bible 온라인) ─────
 * CEB는 저작권 번역이라 본문을 내장할 수 없고, 사용자 브라우저에서
 * YouVersion Platform API(platform.youversion.com)를 직접 호출해 표시한다.
 */
const CebApi = (() => {
  const BASE = "https://api.youversion.com";
  const chapterCache = {}; // "book:chapter" -> { verses, title }
  let versionPromise = null; // { id, copyright }

  function enabled() {
    return typeof YOUVERSION_APP_KEY !== "undefined" && YOUVERSION_APP_KEY;
  }

  // 공식 SDK와 동일한 요청 형태: URLSearchParams 인코딩 + Installation-Id 헤더
  async function req(path, params) {
    const url = new URL(BASE + path);
    if (params) {
      Object.keys(params).forEach((k) => {
        const v = params[k];
        if (v == null) return;
        if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
        else url.searchParams.append(k, String(v));
      });
    }
    const res = await fetch(url.toString(), {
      headers: {
        "X-YVP-App-Key": YOUVERSION_APP_KEY,
        "X-YVP-Installation-Id": "ceb-web-app",
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("YouVersion 앱 키가 거부되었습니다 (" + res.status +
        "). platform.youversion.com에서 키와 사용 권한을 확인해 주세요.");
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body.message || body.error || "";
      } catch (e) { /* 무시 */ }
      throw new Error("YouVersion API 오류 (" + res.status + (detail ? ": " + detail : "") +
        ") — " + path);
    }
    return res.json();
  }

  function pickCeb(list) {
    return (list || []).find((b) =>
      (b.abbreviation || "").toUpperCase() === "CEB" ||
      (b.localized_abbreviation || "").toUpperCase() === "CEB" ||
      /common english bible/i.test(b.title || ""));
  }

  // 앱 키로 사용 가능한 영어 번역본 중에서 CEB를 찾는다 (localStorage에 캐시)
  function getVersion() {
    if (versionPromise) return versionPromise;
    versionPromise = (async () => {
      try {
        const cached = JSON.parse(localStorage.getItem("bible-app-ceb-version"));
        if (cached && cached.id) return cached;
      } catch (e) { /* 무시 */ }

      const save = (b) => {
        const v = { id: b.id, copyright: b.copyright || "" };
        try { localStorage.setItem("bible-app-ceb-version", JSON.stringify(v)); } catch (e) { /* 무시 */ }
        return v;
      };

      let listError = null;
      try {
        let pageToken = "";
        for (let page = 0; page < 10; page++) {
          const params = { "language_ranges[]": ["en"], page_size: 100 };
          if (pageToken) params.page_token = pageToken;
          const json = await req("/v1/bibles", params);
          const ceb = pickCeb(json.data);
          if (ceb) return save(ceb);
          pageToken = json.next_page_token;
          if (!pageToken) break;
        }
      } catch (e) {
        listError = e;
      }

      // 목록 조회가 실패하거나 목록에 없으면 CEB의 공개 버전 ID(37)로 직접 확인
      try {
        const b = await req("/v1/bibles/37");
        if (/common english bible/i.test(b.title || "") ||
            (b.abbreviation || "").toUpperCase() === "CEB") {
          return save(b);
        }
      } catch (e) { /* 아래에서 종합 안내 */ }

      if (listError) throw listError;
      throw new Error("이 앱 키로 사용할 수 있는 번역본 중에 Common English Bible이 없습니다. " +
        "platform.youversion.com에서 앱의 번역본 사용 범위를 확인해 주세요.");
    })();
    versionPromise.catch(() => { versionPromise = null; }); // 실패 시 다음에 재시도
    return versionPromise;
  }

  /* passages API의 HTML을 절 배열로 파싱한다.
   * 구조: <span class="yv-v" v="16"></span><span class="yv-vlbl">16</span>본문…
   * 각주는 <span class="yv-n …">, 시편 표제는 <div class="d">, 도입부는 <div class="ip">.
   */
  function parseChapterHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll(".yv-n, .yv-vlbl, .note, .f").forEach((n) => n.remove());
    const verses = [];
    const titleParts = [];
    let current = 0; // 0 = 아직 절 시작 전(표제/도입부)
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 1) {
        if (node.classList && node.classList.contains("yv-v")) {
          const num = parseInt(node.getAttribute("v"), 10);
          if (num >= 1) current = num;
        }
        continue;
      }
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      if (current === 0) titleParts.push(text);
      else verses[current - 1] = (verses[current - 1] || "") + text + " ";
    }
    const clean = (s) => s.replace(/\s+/g, " ").trim();
    for (let i = 0; i < verses.length; i++) verses[i] = clean(verses[i] || "");
    return { verses, title: clean(titleParts.join(" ")) };
  }

  async function chapter(book, ch) {
    const key = book + ":" + ch;
    if (chapterCache[key]) return chapterCache[key];
    const v = await getVersion();
    const usfm = USFM[book] + "." + ch;
    const json = await req("/v1/bibles/" + v.id + "/passages/" + usfm, {
      format: "html",
      include_headings: false,
      include_notes: false,
    });
    const parsed = parseChapterHtml(json.content || "");
    if (!parsed.verses.length) throw new Error("본문을 해석하지 못했습니다: " + usfm);
    parsed.copyright = v.copyright;
    chapterCache[key] = parsed;
    return parsed;
  }

  return { enabled, chapter };
})();

/* ── AI 실시간 번역 (OpenAI 호환 API) ─────────
 * 선택한 영어 본문을 장 단위로 한국어로 번역한다.
 * API 키는 사용자가 설정 화면에 입력하며 localStorage에만 저장된다.
 */
const AiTranslator = (() => {
  const LS_SETTINGS = "bible-app-ai-settings";
  const CACHE_PREFIX = "bible-app-ai-tr:";
  const memCache = {};

  function getSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}; } catch (e) { /* 무시 */ }
    return {
      key: s.key || "",
      model: s.model || "gpt-5.6-sol",
      base: (s.base || "https://api.openai.com/v1").replace(/\/+$/, ""),
    };
  }

  function saveSettings(s) {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch (e) { /* 무시 */ }
  }

  function configured() { return !!getSettings().key; }

  function cacheKey(version, book, chapter, model) {
    return CACHE_PREFIX + model + ":" + version + ":" + book + ":" + chapter;
  }

  function clearCache() {
    memCache && Object.keys(memCache).forEach((k) => delete memCache[k]);
    try {
      const dead = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) dead.push(k);
      }
      dead.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* 무시 */ }
  }

  // 장 전체를 한 번의 요청으로 번역해 절 배열을 반환
  async function translateChapter(version, book, chapter, meta, enVerses) {
    const s = getSettings();
    if (!s.key) throw new Error("AI 번역을 쓰려면 ⚙️ 설정에서 API 키를 입력해 주세요.");
    const ck = cacheKey(version, book, chapter, s.model);
    if (memCache[ck]) return memCache[ck];
    try {
      const stored = JSON.parse(localStorage.getItem(ck));
      if (Array.isArray(stored) && stored.length === enVerses.length) {
        memCache[ck] = stored;
        return stored;
      }
    } catch (e) { /* 무시 */ }

    const numbered = enVerses.map((v, i) => (i + 1) + ". " + (v || "")).join("\n");
    const body = {
      model: s.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a professional Bible translator. Translate English Bible verses into natural, " +
            "faithful modern Korean (현대 한국어, 존댓말이 아닌 성경 문어체). Preserve meaning precisely; " +
            "do not add, omit, or interpret beyond the text. Keep proper nouns in standard Korean " +
            "Bible spelling (e.g., 예수, 여호와, 예루살렘). Return ONLY a JSON object of the form " +
            '{"verses": ["...", ...]} with exactly one Korean string per input verse, in order. ' +
            "If an input verse is empty, return an empty string for it.",
        },
        {
          role: "user",
          content: meta[2] + " chapter " + chapter + " (" + enVerses.length + " verses):\n" + numbered,
        },
      ],
    };

    const res = await fetch(s.base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + s.key,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("AI API 키가 거부되었습니다(401). ⚙️ 설정에서 키를 확인해 주세요.");
    if (res.status === 404) throw new Error("모델을 찾을 수 없습니다(404). ⚙️ 설정에서 모델 이름을 확인해 주세요.");
    if (res.status === 429) throw new Error("AI API 사용량 한도에 도달했습니다(429). 잠시 후 다시 시도해 주세요.");
    if (!res.ok) throw new Error("AI 번역 요청 실패 (" + res.status + ")");
    const json = await res.json();
    const content = json.choices && json.choices[0] && json.choices[0].message &&
      json.choices[0].message.content;
    if (!content) throw new Error("AI 응답이 비어 있습니다.");

    let verses;
    try {
      const parsed = JSON.parse(content);
      verses = Array.isArray(parsed) ? parsed : parsed.verses;
    } catch (e) {
      throw new Error("AI 응답을 해석하지 못했습니다.");
    }
    if (!Array.isArray(verses) || !verses.length) throw new Error("AI 응답 형식이 올바르지 않습니다.");
    verses = enVerses.map((_, i) => String(verses[i] == null ? "" : verses[i]).trim());

    memCache[ck] = verses;
    try { localStorage.setItem(ck, JSON.stringify(verses)); } catch (e) { /* 용량 초과 등은 무시 */ }
    return verses;
  }

  return { getSettings, saveSettings, configured, translateChapter, clearCache };
})();

/* ── 상태 ─────────────────────────────── */
const state = {
  book: 43,       // 요한복음
  chapter: 3,
  version: "web",  // 영어 번역본
  mode: "both",    // both | en | ko
  koSource: "krv", // krv | ai | both
  fontScale: 1,
  theme: "auto",
};

const LS_KEY = "bible-app-state";

function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      book: state.book, chapter: state.chapter, version: state.version,
      mode: state.mode, koSource: state.koSource,
      fontScale: state.fontScale, theme: state.theme,
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

  const showKrv = state.koSource !== "ai";
  const showAi = state.koSource !== "krv";
  const aiResult = []; // 번역이 도착하면 채워짐 (복사에 사용)

  for (let v = 0; v < count; v++) {
    const row = el("div", "verse");
    row.dataset.verse = v + 1;
    row.appendChild(el("div", "verse-num", String(v + 1)));
    const body = el("div", "verse-body");
    if (enVerses[v]) body.appendChild(el("div", "verse-en", enVerses[v]));
    if (showKrv && koVerses[v]) body.appendChild(el("div", "verse-ko", koVerses[v]));
    if (showAi && enVerses[v]) {
      const ai = el("div", "verse-ai pending", "AI 번역 중…");
      ai.dataset.aiVerse = v;
      body.appendChild(ai);
    }
    row.appendChild(body);
    row.addEventListener("click", () =>
      copyVerse(meta, v + 1, enVerses[v], showKrv ? koVerses[v] : "", aiResult[v]));
    reader.appendChild(row);
  }

  if (showAi && state.mode !== "en") {
    if (!AiTranslator.configured()) {
      reader.querySelectorAll(".verse-ai").forEach((n) => {
        n.textContent = "⚙️ 설정에서 AI API 키를 입력하면 번역이 표시됩니다.";
      });
      openSettings("AI 번역을 사용하려면 API 키를 입력해 주세요.");
    } else {
      AiTranslator.translateChapter(state.version, state.book, state.chapter, meta, enVerses)
        .then((translated) => {
          if (token !== renderToken) return;
          translated.forEach((t, i) => { aiResult[i] = t; });
          reader.querySelectorAll(".verse-ai").forEach((n) => {
            const i = Number(n.dataset.aiVerse);
            n.classList.remove("pending");
            n.textContent = translated[i] || "";
          });
        })
        .catch((err) => {
          if (token !== renderToken) return;
          const msg = (err && err.message) || "AI 번역에 실패했습니다.";
          reader.querySelectorAll(".verse-ai").forEach((n) => n.remove());
          const first = reader.querySelector(".verse");
          const notice = el("div", "ai-error", msg);
          reader.insertBefore(notice, first);
          toast("AI 번역 실패");
        });
    }
  }

  if (state.version === "ceb" && en.copyright) {
    reader.appendChild(el("div", "copyright", en.copyright));
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

function copyVerse(meta, num, enText, koText, aiText) {
  const ref = meta[1] + " " + state.chapter + ":" + num;
  const parts = [ref];
  if (state.mode !== "ko" && enText) parts.push(enText);
  if (state.mode !== "en" && koText) parts.push(koText);
  if (state.mode !== "en" && aiText) parts.push("(AI 번역) " + aiText);
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
  $("settingsPanel").hidden = true;
  $("overlay").hidden = true;
}

/* ── AI 번역 설정 ──────────────────────── */
function openSettings(hint) {
  closePanels();
  const s = AiTranslator.getSettings();
  $("aiKey").value = s.key;
  $("aiModel").value = s.model;
  $("aiBase").value = s.base;
  $("overlay").hidden = false;
  $("settingsPanel").hidden = false;
  if (hint) toast(hint);
}

function saveSettingsFromForm() {
  AiTranslator.saveSettings({
    key: $("aiKey").value.trim(),
    model: $("aiModel").value.trim() || "gpt-5.6-sol",
    base: $("aiBase").value.trim() || "https://api.openai.com/v1",
  });
  closePanels();
  toast("저장되었습니다");
  if (state.koSource !== "krv") renderChapter();
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
  // CEB는 검색 API가 없으므로 영어 검색은 오프라인 WEB 본문을 기준으로 한다
  const cebNote = !isKorean && state.version === "ceb";
  const version = isKorean ? "krv" : (cebNote ? "web" : state.version);
  const needle = isKorean ? q : q.toLowerCase();
  const MAX = 200;
  let hits = 0;

  status.textContent = "검색 중…";
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
  status.textContent = (hits === 0
    ? "「" + q + "」 검색 결과가 없습니다. (" + VERSIONS[version].label + ")"
    : "「" + q + "」 " + hits + "건" + (hits >= MAX ? " (최대 표시 수 도달)" : "") +
      " — " + VERSIONS[version].label) +
    (cebNote ? " · CEB는 검색을 지원하지 않아 WEB 본문 기준으로 찾았습니다" : "");
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
  $("koSel").value = state.koSource;

  $("koSel").addEventListener("change", (e) => {
    state.koSource = e.target.value;
    renderChapter();
  });
  $("settingsBtn").addEventListener("click", () => openSettings());
  $("settingsClose").addEventListener("click", closePanels);
  $("aiSave").addEventListener("click", saveSettingsFromForm);
  $("aiClearCache").addEventListener("click", () => {
    AiTranslator.clearCache();
    toast("번역 캐시를 비웠습니다");
  });

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
