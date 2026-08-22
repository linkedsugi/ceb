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

/* ── YouVersion Platform (CEB·NIV·NASB 온라인) ─────
 * 저작권 번역들은 본문을 내장할 수 없고, 사용자 브라우저에서
 * YouVersion Platform API(platform.youversion.com)를 직접 호출해 표시한다.
 */
const CebApi = (() => {
  const BASE = "https://api.youversion.com";
  const chapterCache = {};   // "vkey:book:chapter" -> { verses, title, copyright }
  const versionPromises = {}; // vkey -> Promise<{ id, copyright }>

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
    const text = await res.text();
    if (!res.ok) {
      let detail = "";
      try {
        const body = JSON.parse(text);
        detail = body.message || body.error || "";
      } catch (e) { /* 무시 */ }
      const err = new Error("YouVersion API 오류 (" + res.status + (detail ? ": " + detail : "") +
        ") — " + path);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204 || !text) return null; // 빈 응답 = 결과 없음
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("YouVersion 응답을 해석하지 못했습니다 — " + path);
    }
  }

  // 번역본의 버전 정보(ID·저작권)를 확인한다 (localStorage에 캐시)
  function getVersion(vkey) {
    if (versionPromises[vkey]) return versionPromises[vkey];
    const meta = ONLINE_VERSIONS[vkey];
    const lsKey = "bible-app-yv-version:" + vkey;
    versionPromises[vkey] = (async () => {
      try {
        const cached = JSON.parse(localStorage.getItem(lsKey));
        if (cached && cached.id) return cached;
      } catch (e) { /* 무시 */ }

      const save = (b) => {
        const v = { id: b.id, copyright: b.copyright || "" };
        try { localStorage.setItem(lsKey, JSON.stringify(v)); } catch (e) { /* 무시 */ }
        return v;
      };

      // 알려진 버전 ID를 먼저 직접 확인
      let denied = false;
      try {
        const b = await req("/v1/bibles/" + meta.id);
        if (b && (meta.pattern.test(b.title || "") ||
            (b.abbreviation || "").toUpperCase().indexOf(vkey.toUpperCase()) === 0)) {
          return save(b);
        }
      } catch (e) {
        if (e && e.status === 404) denied = true; // 키에 이 번역본 권한 없음
        else throw e;
      }

      // 혹시 다른 ID로 등록돼 있을 수 있으니 목록도 확인 (빈 목록이면 204/null)
      let pageToken = "";
      for (let page = 0; page < 10; page++) {
        const params = { "language_ranges[]": ["en"], page_size: 99 }; // API 최대치 99
        if (pageToken) params.page_token = pageToken;
        const json = await req("/v1/bibles", params);
        if (!json) break; // 204: 이 키로 열람 가능한 목록이 비어 있음
        const hit = (json.data || []).find((b) => meta.pattern.test(b.title || ""));
        if (hit) return save(hit);
        pageToken = json.next_page_token;
        if (!pageToken) break;
      }

      throw new Error("이 앱 키에 " + VERSIONS[vkey].full + " 사용 권한이 없습니다" +
        (denied ? " (버전 " + meta.id + " 접근 거부됨)" : "") +
        ". platform.youversion.com의 Licensing에서 해당 출판사 계약을 수락해 주세요.");
    })();
    versionPromises[vkey].catch(() => { delete versionPromises[vkey]; }); // 실패 시 재시도
    return versionPromises[vkey];
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

  async function chapter(vkey, book, ch) {
    const key = vkey + ":" + book + ":" + ch;
    if (chapterCache[key]) return chapterCache[key];
    const v = await getVersion(vkey);
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

function isOnlineVersion(v) { return !!ONLINE_VERSIONS[v]; }

/* ── AI 실시간 번역 (OpenAI 호환 API) ─────────
 * 선택한 영어 본문을 장 단위로 한국어로 번역한다.
 * API 키는 사용자가 설정 화면에 입력하며 localStorage에만 저장된다.
 */
const AiTranslator = (() => {
  const LS_SETTINGS = "bible-app-ai-settings";
  const CACHE_PREFIX = "bible-app-ai-tr:";
  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
  const memCache = {};

  // 2026-08 기준 시드 목록 — ↻ 새로고침 시 공급자 API의 실제 목록으로 대체된다
  const DEFAULTS = {
    provider: "openai",
    openai: {
      key: "",
      useShared: false, // 관리자 공유 키 사용 여부 (승인 회원 전용)
      model: "gpt-5.6-sol",
      base: "https://api.openai.com/v1",
      models: ["gpt-5.6-sol"],
    },
    gemini: {
      key: "",
      useShared: false,
      model: "gemini-3.6-flash",
      models: ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"],
    },
  };

  function getSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}; } catch (e) { /* 무시 */ }
    if (s.key !== undefined && !s.openai) {
      // 구버전 설정({key, model, base}) 마이그레이션
      s = { provider: "openai", openai: { key: s.key, model: s.model, base: s.base } };
    }
    const merged = {
      provider: s.provider === "gemini" ? "gemini" : "openai",
      openai: Object.assign({}, DEFAULTS.openai, s.openai),
      gemini: Object.assign({}, DEFAULTS.gemini, s.gemini),
    };
    merged.openai.base = (merged.openai.base || DEFAULTS.openai.base).replace(/\/+$/, "");
    if (!merged.openai.models || !merged.openai.models.length) merged.openai.models = DEFAULTS.openai.models.slice();
    if (!merged.gemini.models || !merged.gemini.models.length) merged.gemini.models = DEFAULTS.gemini.models.slice();
    return merged;
  }

  function saveSettings(s) {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch (e) { /* 무시 */ }
  }

  function current(s) {
    s = s || getSettings();
    return { provider: s.provider, conf: s[s.provider] };
  }

  function configured() {
    const conf = current().conf;
    return !!conf.key || (conf.useShared && Auth.enabled());
  }

  // 실제 요청에 쓸 키를 결정: 직접 입력한 키 또는 관리자 공유 키
  async function resolveKey(provider, conf) {
    if (conf.useShared && Auth.enabled()) return Auth.getSharedKey(provider);
    if (!conf.key) throw new Error("AI 번역을 쓰려면 ⚙️ 설정에서 API 키를 입력해 주세요.");
    return conf.key;
  }

  // 공급자 API에서 사용 가능한 최신 모델 목록을 불러온다
  async function listModels(provider, conf, apiKey) {
    const key = apiKey || conf.key;
    if (!key) throw new Error("먼저 API 키를 입력해 주세요.");
    if (provider === "gemini") {
      const res = await fetch(GEMINI_BASE + "/models?pageSize=200", {
        headers: { "x-goog-api-key": key },
      });
      if (!res.ok) {
        let msg = "";
        try { const j = await res.json(); msg = (j.error && j.error.message) || ""; } catch (e) { /* 무시 */ }
        throw new Error("모델 목록 조회 실패 (" + res.status + (msg ? ": " + msg : "") + ")");
      }
      const json = await res.json();
      const names = (json.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
        .map((m) => String(m.name || "").replace(/^models\//, ""))
        .filter((n) => n && !/embedding|aqa|imagen|veo|tts|audio|image/i.test(n));
      names.sort().reverse(); // 최신 버전 번호가 앞으로
      if (!names.length) throw new Error("사용 가능한 Gemini 모델이 없습니다.");
      return names;
    }
    // OpenAI 호환
    const res = await fetch((conf.base || DEFAULTS.openai.base).replace(/\/+$/, "") + "/models", {
      headers: { "Authorization": "Bearer " + key },
    });
    if (!res.ok) {
      let msg = "";
      try { const j = await res.json(); msg = (j.error && j.error.message) || ""; } catch (e) { /* 무시 */ }
      throw new Error("모델 목록 조회 실패 (" + res.status + (msg ? ": " + msg : "") + ")");
    }
    const json = await res.json();
    const rows = (json.data || []).filter((m) => {
      const id = String(m.id || "");
      if (!/^(gpt|o\d|chatgpt)/i.test(id)) return false;
      return !/embed|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|search|instruct/i.test(id);
    });
    rows.sort((a, b) => (b.created || 0) - (a.created || 0)); // 최신 등록 순
    const ids = rows.map((m) => m.id);
    if (!ids.length) throw new Error("사용 가능한 채팅 모델이 없습니다.");
    return ids;
  }

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

  // Gemini generateContent 호출 (JSON 응답을 우선 요청, 거부되면 없이 재시도)
  async function callGemini(conf, apiKey, messages) {
    async function call(jsonMime) {
      const body = {
        system_instruction: { parts: [{ text: messages[0].content }] },
        contents: [{ role: "user", parts: [{ text: messages[1].content }] }],
      };
      if (jsonMime) body.generationConfig = { responseMimeType: "application/json" };
      const res = await fetch(GEMINI_BASE + "/models/" + encodeURIComponent(conf.model) +
        ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let apiMsg = "";
        try { const j = await res.json(); apiMsg = (j.error && j.error.message) || ""; } catch (e) { /* 무시 */ }
        let text;
        if (res.status === 400 && /api key/i.test(apiMsg)) text = "Gemini API 키가 거부되었습니다. ⚙️ 설정에서 키를 확인해 주세요.";
        else if (res.status === 401 || res.status === 403) text = "Gemini API 접근이 거부되었습니다(" + res.status + "). 키를 확인해 주세요.";
        else if (res.status === 404) text = "모델 「" + conf.model + "」을 찾을 수 없습니다(404). ↻로 모델 목록을 새로고침해 주세요.";
        else if (res.status === 429) text = "Gemini API 사용량 한도에 도달했습니다(429). 잠시 후 다시 시도해 주세요.";
        else text = "Gemini 번역 요청 실패 (" + res.status + ")";
        if (apiMsg) text += " — " + apiMsg;
        const err = new Error(text);
        err.status = res.status;
        err.apiMessage = apiMsg;
        throw err;
      }
      const json = await res.json();
      const cand = json.candidates && json.candidates[0];
      const parts = cand && cand.content && cand.content.parts;
      return (parts || []).map((p) => p.text || "").join("");
    }
    try {
      return await call(true);
    } catch (err) {
      if (err.status === 400 && /response_mime|responseMimeType|mime/i.test(err.apiMessage || "")) {
        return call(false);
      }
      throw err;
    }
  }

  // 장 전체를 한 번의 요청으로 번역해 절 배열을 반환
  async function translateChapter(version, book, chapter, meta, enVerses) {
    const picked = current();
    const provider = picked.provider;
    const conf = picked.conf;
    const apiKey = await resolveKey(provider, conf);
    const ck = cacheKey(version, book, chapter, provider + ":" + conf.model);
    if (memCache[ck]) return memCache[ck];
    try {
      const stored = JSON.parse(localStorage.getItem(ck));
      if (Array.isArray(stored) && stored.length === enVerses.length) {
        memCache[ck] = stored;
        return stored;
      }
    } catch (e) { /* 무시 */ }

    const numbered = enVerses.map((v, i) => (i + 1) + ". " + (v || "")).join("\n");
    const messages = [
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
    ];

    // 모델(특히 GPT-5 계열)에 따라 temperature나 response_format을 거부하므로
    // 최소 파라미터로 요청하고, response_format이 거부되면 없이 재시도한다.
    async function call(useJsonFormat) {
      const body = { model: conf.model, messages };
      if (useJsonFormat) body.response_format = { type: "json_object" };
      const res = await fetch(conf.base + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let apiMsg = "";
        try {
          const j = await res.json();
          apiMsg = (j.error && j.error.message) || j.message || "";
        } catch (e) { /* 무시 */ }
        let text;
        if (res.status === 401) text = "AI API 키가 거부되었습니다(401). ⚙️ 설정에서 키를 확인해 주세요.";
        else if (res.status === 404) text = "모델 「" + conf.model + "」을 찾을 수 없습니다(404). ↻로 모델 목록을 새로고침해 주세요.";
        else if (res.status === 429) text = "AI API 사용량 한도에 도달했습니다(429). 잠시 후 다시 시도해 주세요.";
        else text = "AI 번역 요청 실패 (" + res.status + ")";
        if (apiMsg) text += " — " + apiMsg;
        const err = new Error(text);
        err.status = res.status;
        err.apiMessage = apiMsg;
        throw err;
      }
      return res.json();
    }

    let content;
    if (provider === "gemini") {
      content = await callGemini(conf, apiKey, messages);
    } else {
      let json;
      try {
        json = await call(true);
      } catch (err) {
        // response_format을 지원하지 않는 모델/게이트웨이면 없이 다시 시도
        if (err.status === 400 && /response_format|json_object/i.test(err.apiMessage || "")) {
          json = await call(false);
        } else {
          throw err;
        }
      }
      content = json.choices && json.choices[0] && json.choices[0].message &&
        json.choices[0].message.content;
    }
    if (!content) throw new Error("AI 응답이 비어 있습니다.");

    // 코드 펜스나 앞뒤 설명이 붙어도 JSON 부분만 추출해 해석
    function extractJson(text) {
      let t = String(text).trim();
      const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) t = fence[1].trim();
      try { return JSON.parse(t); } catch (e) { /* 아래 폴백 */ }
      const a = t.indexOf("{"), b = t.lastIndexOf("}");
      if (a >= 0 && b > a) {
        try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* 아래 폴백 */ }
      }
      const c = t.indexOf("["), d = t.lastIndexOf("]");
      if (c >= 0 && d > c) {
        try { return JSON.parse(t.slice(c, d + 1)); } catch (e) { /* 실패 */ }
      }
      throw new Error("AI 응답을 해석하지 못했습니다.");
    }

    const parsed = extractJson(content);
    let verses = Array.isArray(parsed) ? parsed : parsed.verses;
    if (!Array.isArray(verses) || !verses.length) throw new Error("AI 응답 형식이 올바르지 않습니다.");
    verses = enVerses.map((_, i) => String(verses[i] == null ? "" : verses[i]).trim());

    memCache[ck] = verses;
    try { localStorage.setItem(ck, JSON.stringify(verses)); } catch (e) { /* 용량 초과 등은 무시 */ }
    return verses;
  }

  // 현재 선택된 공급자·모델 표시용 정보
  function info() {
    const picked = current();
    return {
      provider: picked.provider,
      providerLabel: picked.provider === "gemini" ? "Google Gemini" : "OpenAI",
      model: picked.conf.model,
    };
  }

  return { getSettings, saveSettings, configured, translateChapter, clearCache, listModels, info };
})();

/* ── 구절 주석 (책갈피·형광펜·밑줄, localStorage) ── */
const Annotations = (() => {
  const LS = "bible-app-annotations";
  let data = null;

  function load() {
    if (data) return data;
    try { data = JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { data = {}; }
    return data;
  }
  function persist() {
    try { localStorage.setItem(LS, JSON.stringify(data)); } catch (e) { /* 무시 */ }
  }
  function key(b, c, v) { return b + ":" + c + ":" + v; }

  function get(b, c, v) { return load()[key(b, c, v)] || null; }

  // patch: { b?: 책갈피, h?: 형광펜 색, u?: 밑줄 }. 모두 비면 항목 삭제.
  function set(b, c, v, patch, snippet) {
    load();
    const k = key(b, c, v);
    const next = Object.assign({}, data[k] || {}, patch);
    if (!next.b && !next.h && !next.u) {
      delete data[k];
      persist();
      return null;
    }
    if (snippet) next.t = snippet;
    // 책갈피를 새로 추가하는 순간의 날짜·시각을 기록
    if (patch.b === true) next.ts = Date.now();
    if (!next.ts) next.ts = Date.now();
    data[k] = next;
    persist();
    return next;
  }

  function clear(b, c, v) { return set(b, c, v, { b: null, h: null, u: null }); }

  function list() {
    load();
    return Object.keys(data).map((k) => {
      const p = k.split(":").map(Number);
      return Object.assign({ book: p[0], chapter: p[1], verse: p[2] }, data[k]);
    }).sort((a, b) => a.book - b.book || a.chapter - b.chapter || a.verse - b.verse);
  }

  return { get, set, clear, list };
})();

const HL_COLORS = ["yellow", "green", "blue", "pink"];

function applyAnnotationClasses(row, ann) {
  row.classList.remove("bookmarked", "underlined");
  HL_COLORS.forEach((c) => row.classList.remove("hl-" + c));
  if (!ann) return;
  if (ann.b) row.classList.add("bookmarked");
  if (ann.u) row.classList.add("underlined");
  if (ann.h) row.classList.add("hl-" + ann.h);
}

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
}

function applyFont() {
  document.documentElement.style.setProperty("--font-scale", state.fontScale);
  const label = $("fontScaleLabel");
  if (label) label.textContent = Math.round(state.fontScale * 100) + "%";
}

/* ── 본문 렌더링 ────────────────────────── */
let renderToken = 0;

// 선택된 영어 번역본의 해당 장을 { verses, title } 형태로 반환
async function loadEnglishChapter(book, chapter) {
  if (isOnlineVersion(state.version)) {
    return CebApi.chapter(state.version, book, chapter);
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
  document.title = meta[1] + " " + state.chapter + "장 — Bible Canvas";
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
    if (isOnlineVersion(state.version)) {
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
      if (AiTranslator.configured()) {
        const inf = AiTranslator.info();
        ai.title = inf.providerLabel + " · " + inf.model;
      }
      body.appendChild(ai);
    }
    row.appendChild(body);
    applyAnnotationClasses(row, Annotations.get(state.book, state.chapter, v + 1));
    row.addEventListener("click", () =>
      openVerseMenu(meta, v + 1, enVerses[v], showKrv ? koVerses[v] : "", aiResult, row));
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

  if (isOnlineVersion(state.version) && en.copyright) {
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
  if (state.mode !== "en" && aiText) {
    const inf = AiTranslator.info();
    parts.push("(AI 번역 · " + inf.model + ") " + aiText);
  }
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
  $("adminPanel").hidden = true;
  $("versePanel").hidden = true;
  $("bookmarksPanel").hidden = true;
  $("overlay").hidden = true;
}

/* ── 구절 액션 메뉴 (복사·책갈피·형광펜·밑줄) ── */
let verseCtx = null; // { book, chapter, verse, en, ko, aiArr, row }

function verseSnippet(ctx) {
  return String(ctx.ko || ctx.en || "").slice(0, 60);
}

function updateVerseMenu() {
  const ann = Annotations.get(verseCtx.book, verseCtx.chapter, verseCtx.verse);
  $("vmBookmark").textContent = ann && ann.b ? "🔖 책갈피 해제" : "🔖 책갈피 추가";
  $("vmUnderline").textContent = ann && ann.u ? "빨간 밑줄 제거" : "빨간 밑줄";
  document.querySelectorAll(".hl-swatch").forEach((s) => {
    s.classList.toggle("sel", (ann && ann.h ? ann.h : "") === s.dataset.hl && s.dataset.hl !== "");
  });
}

function openVerseMenu(meta, verse, enText, koText, aiArr, row) {
  closePanels();
  verseCtx = { book: state.book, chapter: state.chapter, verse,
    en: enText || "", ko: koText || "", aiArr, row };
  $("versePanelTitle").textContent = meta[1] + " " + state.chapter + ":" + verse;
  updateVerseMenu();
  $("overlay").hidden = false;
  $("versePanel").hidden = false;
}

function mutateVerseAnn(patch) {
  const c = verseCtx;
  const ann = Annotations.set(c.book, c.chapter, c.verse, patch, verseSnippet(c));
  applyAnnotationClasses(c.row, ann);
  updateVerseMenu();
  return ann;
}

/* ── 저장된 구절 목록 ───────────────────── */
function formatTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function openBookmarksPanel() {
  closePanels();
  const box = $("bookmarksList");
  box.innerHTML = "";
  const items = Annotations.list();
  if (!items.length) {
    box.appendChild(el("div", "settings-note",
      "저장된 구절이 없습니다. 절을 누르면 책갈피·형광펜을 추가할 수 있습니다."));
  }
  items.forEach((it) => {
    const meta = bookMeta(it.book);
    const row = el("div", "bm-row");
    const badges = el("div", "bm-badges");
    if (it.b) badges.appendChild(el("span", null, "🔖"));
    if (it.h) {
      const dot = el("span", "bm-dot hl-" + it.h);
      dot.title = "형광펜";
      badges.appendChild(dot);
    }
    if (it.u) badges.appendChild(el("span", "bm-underline", "밑줄"));
    const info = el("div", "bm-info");
    const refLine = el("div", "bm-ref", meta[1] + " " + it.chapter + ":" + it.verse);
    if (it.ts) refLine.appendChild(el("span", "bm-date", formatTs(it.ts)));
    info.appendChild(refLine);
    info.appendChild(el("div", "bm-snippet", it.t || ""));
    row.appendChild(badges);
    row.appendChild(info);
    const del = el("button", "icon-btn bm-del", "✕");
    del.title = "저장 삭제";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      Annotations.clear(it.book, it.chapter, it.verse);
      openBookmarksPanel();
    });
    row.appendChild(del);
    row.addEventListener("click", () => {
      closePanels();
      goTo(it.book, it.chapter, it.verse);
    });
    box.appendChild(row);
  });
  $("overlay").hidden = false;
  $("bookmarksPanel").hidden = false;
}

/* ── 로그인 / 회원 관리 ─────────────────── */
function updateAuthUi() {
  if (!Auth.enabled()) return;
  const u = Auth.user();
  $("loginBtn").hidden = !!u;
  $("userBox").hidden = !u;
  if (u) {
    const name = (u.email || "").split("@")[0];
    const status = Auth.isAdmin() ? "관리자" : (Auth.isApproved() ? "승인됨" : "승인 대기 중");
    $("userChip").textContent = name + (Auth.isAdmin() ? " ★" : (Auth.isApproved() ? " ✓" : " ⏳"));
    $("userChip").title = u.email + " · " + status;
    $("adminBtn").hidden = !Auth.isAdmin();
  }
}

async function openAdminPanel() {
  closePanels();
  $("overlay").hidden = false;
  $("adminPanel").hidden = false;
  const box = $("adminMembers");
  box.textContent = "불러오는 중…";
  try {
    const [profiles, keys] = await Promise.all([Auth.listProfiles(), Auth.getSharedKeys()]);
    $("sharedOpenai").value = keys.openai || "";
    $("sharedGemini").value = keys.gemini || "";
    renderMembers(profiles);
  } catch (err) {
    box.textContent = (err && err.message) || "불러오지 못했습니다.";
  }
}

// 토글 스위치 하나 (캡션 포함). onChange가 없으면 잠긴 상태로 표시.
function memberSwitch(caption, checked, disabled, title, onChange) {
  const group = el("div", "switch-group");
  const sw = el("label", "switch");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = disabled;
  sw.title = title || "";
  sw.appendChild(input);
  sw.appendChild(el("span", "slider"));
  group.appendChild(sw);
  group.appendChild(el("span", "switch-caption", caption));
  if (onChange) {
    input.addEventListener("change", () => onChange(input));
  }
  return group;
}

function renderMembers(profiles) {
  const box = $("adminMembers");
  box.innerHTML = "";
  const pendingCount = profiles.filter((p) => !p.approved).length;
  box.appendChild(el("div", "admin-summary",
    "회원 " + profiles.length + "명" +
    (pendingCount ? " · 승인 대기 " + pendingCount + "명" : "")));
  if (!profiles.length) {
    box.appendChild(el("div", "settings-note", "아직 가입한 회원이 없습니다."));
    return;
  }
  profiles.forEach((p) => {
    const isAdminRow = p.email === ADMIN_EMAIL;
    const row = el("div", "member-row" + (!p.approved && !isAdminRow ? " pending" : ""));
    const info = el("div", "member-info");
    info.appendChild(el("div", "member-email",
      p.email + (isAdminRow ? " (관리자)" : "")));
    info.appendChild(el("div", "member-meta",
      (p.display_name || "") + " · 가입 " + String(p.created_at || "").slice(0, 10) +
      (!p.approved && !isAdminRow ? " · 승인 대기" : "")));
    row.appendChild(info);

    if (isAdminRow) {
      // 관리자는 항상 승인·공용API 허용 상태
      row.appendChild(memberSwitch("승인", true, true, "관리자는 항상 승인 상태입니다"));
      row.appendChild(memberSwitch("공용API", true, true, "관리자는 항상 공용API를 쓸 수 있습니다"));
    } else {
      row.appendChild(memberSwitch("승인", !!p.approved, false,
        "가입 승인 (끄면 차단)", async (input) => {
          input.disabled = true;
          try {
            await Auth.setApproved(p.id, input.checked);
            p.approved = input.checked;
            row.classList.toggle("pending", !p.approved);
            toast(p.email + (p.approved ? " 승인됨" : " 차단됨"));
          } catch (err) {
            input.checked = !input.checked;
            toast(err.message);
          } finally {
            input.disabled = false;
          }
        }));
      row.appendChild(memberSwitch("공용API", !!p.shared_key_access, false,
        "관리자가 등록한 공유 API 키 사용 권한", async (input) => {
          input.disabled = true;
          try {
            await Auth.setSharedAccess(p.id, input.checked);
            p.shared_key_access = input.checked;
            toast(p.email + (p.shared_key_access ? " 공용API 허용됨" : " 공용API 해제됨"));
          } catch (err) {
            input.checked = !input.checked;
            toast(err.message);
          } finally {
            input.disabled = false;
          }
        }));
    }
    box.appendChild(row);
  });
}

/* ── AI 번역 설정 ──────────────────────── */
let settingsDraft = null; // 설정 패널이 열려 있는 동안의 편집본

function populateModelSelect(models, selected) {
  const sel = $("aiModelSel");
  sel.innerHTML = "";
  const list = models.slice();
  if (selected && list.indexOf(selected) === -1) list.unshift(selected);
  list.forEach((m) => {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  });
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "직접 입력…";
  sel.appendChild(custom);
  sel.value = selected && list.indexOf(selected) !== -1 ? selected : list[0];
  $("aiModelCustom").hidden = sel.value !== "__custom__";
}

function fillSettingsForm() {
  const p = settingsDraft.provider;
  const conf = settingsDraft[p];
  $("themeSel").value = state.theme;
  const inf = AiTranslator.info();
  $("aiCurrentNote").textContent = AiTranslator.configured()
    ? "현재 사용 중인 모델: " + inf.model + " (" + inf.providerLabel + ")"
    : "아직 AI 번역이 설정되지 않았습니다.";
  $("aiProvider").value = p;
  $("aiKeySourceField").hidden = !Auth.enabled();
  $("aiKeySource").value = conf.useShared && Auth.enabled() ? "shared" : "own";
  $("aiKeyField").hidden = $("aiKeySource").value === "shared";
  $("aiKey").value = conf.key;
  $("aiBaseField").hidden = p !== "openai";
  $("aiBase").value = settingsDraft.openai.base;
  populateModelSelect(conf.models, conf.model);
}

// 폼의 현재 입력값을 편집본의 해당 공급자 설정에 반영
function collectSettingsForm() {
  const p = settingsDraft.provider;
  const conf = settingsDraft[p];
  conf.useShared = Auth.enabled() && $("aiKeySource").value === "shared";
  conf.key = $("aiKey").value.trim();
  if (p === "openai") {
    settingsDraft.openai.base =
      ($("aiBase").value.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  }
  const sel = $("aiModelSel").value;
  const model = sel === "__custom__" ? $("aiModelCustom").value.trim() : sel;
  if (model) conf.model = model;
}

function openSettings(hint) {
  closePanels();
  settingsDraft = AiTranslator.getSettings();
  fillSettingsForm();
  $("overlay").hidden = false;
  $("settingsPanel").hidden = false;
  if (hint) toast(hint);
}

function saveSettingsFromForm() {
  collectSettingsForm();
  AiTranslator.saveSettings(settingsDraft);
  closePanels();
  toast("저장되었습니다");
  if (state.koSource !== "krv") renderChapter();
}

async function refreshModelList() {
  collectSettingsForm();
  const p = settingsDraft.provider;
  const btn = $("aiModelRefresh");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    let sharedKey = null;
    if (settingsDraft[p].useShared) sharedKey = await Auth.getSharedKey(p);
    const models = await AiTranslator.listModels(p, settingsDraft[p], sharedKey);
    settingsDraft[p].models = models;
    if (models.indexOf(settingsDraft[p].model) === -1) settingsDraft[p].model = models[0];
    populateModelSelect(models, settingsDraft[p].model);
    toast("모델 " + models.length + "개를 불러왔습니다");
  } catch (err) {
    toast(err && err.message ? err.message : "모델 목록을 불러오지 못했습니다");
  } finally {
    btn.disabled = false;
    btn.textContent = "↻";
  }
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
  // 온라인 번역본은 검색 API가 없으므로 영어 검색은 오프라인 WEB 본문 기준
  const onlineNote = !isKorean && isOnlineVersion(state.version);
  const onlineLabel = onlineNote ? VERSIONS[state.version].label : "";
  const version = isKorean ? "krv" : (onlineNote ? "web" : state.version);
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
    (onlineNote ? " · " + onlineLabel + "는 검색을 지원하지 않아 WEB 본문 기준으로 찾았습니다" : "");
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
    Object.keys(ONLINE_VERSIONS).forEach((vkey) => {
      const opt = document.createElement("option");
      opt.value = vkey;
      opt.textContent = VERSIONS[vkey].label +
        (ONLINE_VERSIONS[vkey].unavailable ? " (currently unavailable)" : "");
      opt.title = VERSIONS[vkey].full;
      if (ONLINE_VERSIONS[vkey].unavailable) opt.disabled = true;
      $("versionSel").appendChild(opt);
    });
  }
  if (isOnlineVersion(state.version) &&
      (!CebApi.enabled() || ONLINE_VERSIONS[state.version].unavailable)) {
    state.version = "web"; // 키가 없거나 사용 불가 번역본이 저장돼 있던 경우
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
  $("aiProvider").addEventListener("change", (e) => {
    collectSettingsForm();
    settingsDraft.provider = e.target.value;
    fillSettingsForm();
  });
  $("aiModelSel").addEventListener("change", (e) => {
    $("aiModelCustom").hidden = e.target.value !== "__custom__";
  });
  $("aiModelRefresh").addEventListener("click", refreshModelList);
  $("aiKeySource").addEventListener("change", (e) => {
    $("aiKeyField").hidden = e.target.value === "shared";
  });

  Auth.init();
  Auth.onChange(updateAuthUi);
  if (Auth.enabled()) {
    $("loginBtn").hidden = false;
    $("loginBtn").addEventListener("click", () =>
      Auth.signIn().catch((e) => toast(e.message || "로그인 실패")));
    $("logoutBtn").addEventListener("click", () =>
      Auth.signOut().then(() => toast("로그아웃되었습니다")));
    $("adminBtn").addEventListener("click", openAdminPanel);
    $("adminClose").addEventListener("click", closePanels);
    $("sharedKeysSave").addEventListener("click", async () => {
      const btn = $("sharedKeysSave");
      btn.disabled = true;
      try {
        await Auth.upsertSharedKey("openai", $("sharedOpenai").value.trim());
        await Auth.upsertSharedKey("gemini", $("sharedGemini").value.trim());
        toast("공유 키가 저장되었습니다");
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }
  $("aiClearCache").addEventListener("click", () => {
    AiTranslator.clearCache();
    toast("번역 캐시를 비웠습니다");
  });

  $("bookmarksBtn").addEventListener("click", openBookmarksPanel);
  $("bookmarksClose").addEventListener("click", closePanels);
  $("versePanelClose").addEventListener("click", closePanels);
  $("vmBookmark").addEventListener("click", () => {
    const ann = Annotations.get(verseCtx.book, verseCtx.chapter, verseCtx.verse);
    const next = mutateVerseAnn({ b: !(ann && ann.b) });
    toast(next && next.b ? "책갈피에 추가했습니다" : "책갈피를 해제했습니다");
  });
  $("vmUnderline").addEventListener("click", () => {
    const ann = Annotations.get(verseCtx.book, verseCtx.chapter, verseCtx.verse);
    mutateVerseAnn({ u: !(ann && ann.u) });
  });
  $("vmCopy").addEventListener("click", () => {
    copyVerse(bookMeta(verseCtx.book), verseCtx.verse, verseCtx.en, verseCtx.ko,
      verseCtx.aiArr ? verseCtx.aiArr[verseCtx.verse - 1] : "");
    closePanels();
  });
  document.querySelectorAll(".hl-swatch").forEach((s) => {
    s.addEventListener("click", () => {
      mutateVerseAnn({ h: s.dataset.hl || null });
    });
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
  $("themeSel").addEventListener("change", (e) => {
    state.theme = e.target.value;
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
