/* Bible Canvas 정적 서버 (Railway 배포용)
 *
 * 이 앱은 빌드가 필요 없는 정적 사이트다. 이 서버가 하는 일은 셋뿐이다.
 *   1) index.html 의 __BUILD__ 를 배포 커밋 해시로 바꿔 캐시 불일치를 막는다
 *      (GitHub Pages 에서는 워크플로의 sed 단계가 같은 일을 한다)
 *   2) 정적 파일을 캐시 규칙에 맞게 서빙한다
 *   3) 헬스체크와 우아한 종료를 제공한다 (Railway 재배포 시 "Deploy Crashed" 방지)
 *
 * 의존성이 없어 npm ci 없이도 그대로 뜬다. 반드시 `node server.js` 로 띄운다.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const SHUTDOWN_GRACE_MS = 8000;

// Railway 가 배포 커밋을 넣어 준다. 없으면(로컬) 짧은 시각 문자열을 쓴다.
const BUILD = (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) ||
  process.env.BUILD_ID || String(Date.now()).slice(-7);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

// index.html 은 시작할 때 한 번만 읽어 __BUILD__ 를 치환해 둔다
const indexHtml = Buffer.from(
  fs.readFileSync(path.join(ROOT, "index.html"), "utf8").split("__BUILD__").join(BUILD),
  "utf8");
const indexEtag = '"' + crypto.createHash("sha1").update(indexHtml).digest("hex").slice(0, 16) + '"';

function send(res, status, headers, body, req) {
  // ETag 가 같으면 본문을 다시 보내지 않는다
  if (headers.ETag && req && req.headers["if-none-match"] === headers.ETag) {
    res.writeHead(304, { ETag: headers.ETag, "Cache-Control": headers["Cache-Control"] });
    return res.end();
  }
  res.writeHead(status, headers);
  if (req && req.method === "HEAD") return res.end();
  res.end(body);
}

function serveFile(req, res, rel, versioned) {
  const file = path.join(ROOT, rel);
  // ROOT 밖으로 나가는 경로는 거부한다
  if (!file.startsWith(ROOT + path.sep)) {
    return send(res, 403, { "Content-Type": TYPES[".txt"] }, "Forbidden", req);
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      return send(res, 404, { "Content-Type": TYPES[".txt"], "Cache-Control": "no-cache" },
        "Not found", req);
    }
    const ext = path.extname(file).toLowerCase();
    const etag = '"' + crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + '"';
    // ?v=<배포해시> 가 붙은 요청만 영구 캐시 — 나머지는 매번 확인(ETag 로 304)
    const cache = versioned
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    send(res, 200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": cache,
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    }, buf, req);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { Allow: "GET, HEAD" }, "Method not allowed", req);
  }
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    return send(res, 400, { "Content-Type": TYPES[".txt"] }, "Bad request", req);
  }
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/api/health") {
    return send(res, 200, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" },
      JSON.stringify({ status: "ok", build: BUILD }), req);
  }

  if (pathname === "/" || pathname === "/index.html") {
    return send(res, 200, {
      "Content-Type": TYPES[".html"],
      "Cache-Control": "no-cache",     // 새 배포를 바로 받도록
      ETag: indexEtag,
      "X-Content-Type-Options": "nosniff",
    }, indexHtml, req);
  }

  const rel = pathname.replace(/^\/+/, "");
  if (!rel || rel.includes("..")) {
    return send(res, 404, { "Content-Type": TYPES[".txt"] }, "Not found", req);
  }
  serveFile(req, res, rel, url.searchParams.has("v"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[bible-canvas] listening on " + PORT + " · build " + BUILD);
});

// 우아한 종료: 재배포 때 Railway 가 "Deploy Crashed" 로 보지 않도록
["SIGTERM", "SIGINT"].forEach((sig) => {
  process.once(sig, () => {
    console.log("[bible-canvas] " + sig + " — 종료합니다");
    server.close(() => process.exit(0));
    if (server.closeIdleConnections) server.closeIdleConnections();
    setTimeout(() => {
      if (server.closeAllConnections) server.closeAllConnections();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
  });
});
