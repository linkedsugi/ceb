// YouVersion Platform (platform.youversion.com) 앱 키.
// CEB(Common English Bible) 온라인 본문을 불러오는 데 사용한다.
// 주의: 정적 웹앱 특성상 이 키는 사이트 방문자에게 노출된다.
// 키를 비우면("") CEB 온라인 옵션이 숨겨진다.
const YOUVERSION_APP_KEY = "qbm8XmKaOzIz13aHVCrcgd9vfWAfRr6Ge6LoPV8w5i7NaLLf";

// Supabase (로그인·회원관리·공유 API 키). 값을 비우면 로그인 기능이 숨겨진다.
// SUPABASE_ANON_KEY는 공개용(anon) 키로, 노출되어도 RLS 정책이 접근을 통제한다.
const SUPABASE_URL = "";
const SUPABASE_ANON_KEY = "";
const ADMIN_EMAIL = "linkedsugi@gmail.com"; // 표시용 (실제 권한은 DB의 is_admin()이 결정)
