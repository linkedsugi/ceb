# Supabase 설정 가이드 (구글 로그인 · 회원관리 · 공유 API 키)

이 앱의 로그인 기능은 Supabase 무료 플랜으로 동작합니다.
아래 순서대로 한 번만 설정하면 됩니다 (약 15분).

## 1. Supabase 프로젝트 만들기

1. https://supabase.com 접속 → 구글 계정으로 가입/로그인
2. **New project** 클릭
   - Name: `bible-canvas` (아무 이름이나 가능)
   - Database password: 아무 강한 비밀번호 (기억해 둘 필요는 거의 없음)
   - Region: `Northeast Asia (Seoul)` 권장
3. 프로젝트가 생성되면 **Project Settings → API** 에서 두 값을 복사해 둡니다:
   - **Project URL** (예: `https://abcdefgh.supabase.co`)
   - **anon public** 키 (긴 문자열 — 공개용 키라 노출되어도 됩니다)

## 2. 구글 OAuth 클라이언트 만들기

1. https://console.cloud.google.com 접속 (linkedsugi@gmail.com 계정)
2. 상단에서 프로젝트 선택/생성 → **API 및 서비스 → OAuth 동의 화면**
   - User Type: **외부(External)** → 앱 이름 `Bible Canvas`, 지원 이메일 입력 → 저장
   - 게시 상태를 **프로덕션**으로 게시 (테스트 상태면 등록한 테스트 사용자만 로그인 가능)
3. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 리디렉션 URI에 추가:
     `https://<프로젝트ID>.supabase.co/auth/v1/callback`
     (1번에서 복사한 Project URL 뒤에 `/auth/v1/callback`을 붙인 것)
   - 만들기 → **클라이언트 ID**와 **클라이언트 보안 비밀** 복사

## 3. Supabase에 구글 로그인 연결

1. Supabase 대시보드 → **Authentication → Sign In / Providers → Google**
   - Enable 켜기 → 2번에서 복사한 클라이언트 ID / 보안 비밀 붙여넣기 → Save
2. **Authentication → URL Configuration**
   - Site URL: `https://linkedsugi.github.io/ceb/`
   - Additional Redirect URLs: `https://linkedsugi.github.io/ceb/`

## 4. 데이터베이스 스키마 설치

1. Supabase 대시보드 → **SQL Editor → New query**
2. 이 저장소의 `supabase/schema.sql` 파일 내용 전체를 붙여넣고 **Run**
   - 회원 테이블, 공유 키 테이블, 사용 통계 테이블(usage_stats), 접근 권한(RLS),
     가입 시 자동 프로필 생성이 설정됩니다
   - 관리자(linkedsugi@gmail.com)는 가입 즉시 자동 승인됩니다
   - 스키마가 바뀌면 이 파일을 **다시 실행해도 안전**합니다 (기존 데이터 유지).
     회원 관리의 사용 통계가 "불러오지 못했습니다"로 나오면 최신본을 재실행하세요.

## 5. 앱에 연결 정보 넣기

`js/config.js` 의 두 값을 1번에서 복사한 값으로 채웁니다:

```js
const SUPABASE_URL = "https://abcdefgh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

(Claude에게 두 값을 알려주면 대신 채워서 배포해 드립니다.)

## 사용 방법

- **가입/로그인**: 상단 [구글 로그인] 버튼 → 구글 계정 선택. 처음 로그인하면
  자동으로 가입되며 "승인 대기" 상태가 됩니다.
- **회원 관리 (관리자)**: linkedsugi@gmail.com 으로 로그인하면 상단에 👥 버튼이
  나타납니다. 회원마다 두 가지 권한을 따로 관리합니다:
  - **승인/차단** — 가입 허용 여부
  - **공용API 허용/해제** — 관리자가 등록한 공유 API 키 사용 권한
- **공유 API 키 (관리자)**: 같은 👥 패널에서 OpenAI/Gemini 키를 등록합니다.
- **공유 키 사용 (승인 + 공용API 허용 회원)**: ⚙️ 설정 → 키 사용 방식에서
  "공유 키" 선택. 본인 키를 직접 입력해 쓰는 것도 그대로 가능합니다.

## 보안 참고

- anon 키는 공개용입니다. 데이터 접근 권한은 전부 DB의 RLS 정책이 통제합니다.
- 공유 API 키는 **승인된 회원만** 읽을 수 있습니다. 다만 승인된 회원은 기술적으로
  키 값을 확인할 수 있으므로, 신뢰하는 사람만 승인하세요. 키를 완전히 숨기려면
  Edge Function 프록시 방식으로 업그레이드할 수 있습니다 (Claude에게 요청).
