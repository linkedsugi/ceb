# 영한 성경 (English–Korean Parallel Bible)

영어 성경 본문을 한국어 번역과 절 단위로 나란히 읽을 수 있는 정적 웹앱입니다.
서버나 빌드 과정 없이 브라우저만으로 동작합니다.

> **번역본 안내** — 원래 목표였던 Common English Bible(CEB)은 저작권이 있는
> 번역이어서 본문을 담을 수 없습니다. 대신 퍼블릭 도메인인 현대 영어 번역
> **World English Bible(WEB)** 을 기본으로 하고, **King James Version(KJV)** 을
> 함께 제공합니다. 한국어 본문은 저작권이 만료된 **개역한글판(1961)** 입니다.

## 실행 방법

- `index.html` 파일을 브라우저로 열면 바로 동작합니다 (더블클릭으로 실행 가능).
- 또는 간단한 정적 서버로 실행: `python3 -m http.server 8000` → http://localhost:8000
- GitHub Pages에 그대로 올려도 동작합니다 (저장소 설정 → Pages → 브랜치 선택).

## 기능

- **영·한 대조 보기** — 절마다 영어 본문 아래에 한국어 번역 표시 (영어만 / 한국어만 모드 지원)
- **영어 번역본 전환** — WEB(현대 영어) ↔ KJV(1611)
- **책·장 탐색** — 구약/신약 책 목록, 장 번호 그리드, 이전/다음 장 버튼, ←/→ 방향키
- **검색** — 한글을 입력하면 개역한글에서, 영어를 입력하면 선택한 영어 번역본에서 검색 (`/` 키로 열기)
- **절 복사** — 절을 클릭하면 "책 장:절 + 영어 + 한국어" 형식으로 클립보드에 복사
- **다크 모드, 글자 크기 조절, 마지막 읽던 위치 기억** (localStorage)
- **주소로 공유** — `index.html#43/3/16` 형식(책 번호/장/절)으로 특정 절 링크 가능
- 시편 표제(superscription)는 WEB에서 장 제목 아래 별도 표시

## 구조

```
index.html        앱 진입점
css/style.css     스타일 (라이트/다크 테마)
js/books.js       66권 메타데이터 (한국어·영어 이름, 장 수)
js/app.js         앱 로직 (탐색, 렌더링, 검색, 설정)
data/web/N.js     World English Bible, 책 번호 N (1–66)
data/kjv/N.js     King James Version
data/krv/N.js     개역한글판
```

본문 데이터는 책 단위 JS 파일로 분할되어 있고, `<script>` 태그 주입으로
지연 로드합니다(`fetch`를 쓰지 않아 `file://`로 열어도 동작).

## 데이터 출처

- WEB: [TehShrike/world-english-bible](https://github.com/TehShrike/world-english-bible) (퍼블릭 도메인)
- KJV·개역한글: [thiagobodruk/bible](https://github.com/thiagobodruk/bible)

절 번호 매김(versification)은 번역본에 따라 일부 장에서 다를 수 있으며,
이 경우 절 번호 순서대로 짝지어 표시합니다.
