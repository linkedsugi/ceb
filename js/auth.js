/* 로그인·회원·공유 API 키 (Supabase)
 * SUPABASE_URL이 비어 있으면 전체 기능이 비활성화되고 UI도 숨겨진다.
 * 접근 통제는 전적으로 서버(RLS 정책)가 담당한다 — supabase/schema.sql 참고.
 */
const Auth = (() => {
  const enabled =
    typeof SUPABASE_URL !== "undefined" && !!SUPABASE_URL &&
    typeof SUPABASE_ANON_KEY !== "undefined" && !!SUPABASE_ANON_KEY &&
    typeof window !== "undefined" && !!window.supabase;

  let sb = null;
  let session = null;
  let profile = null; // { id, email, display_name, approved }
  const sharedKeyCache = {}; // provider -> api_key (메모리에만 보관)
  const listeners = [];

  function notify() {
    listeners.forEach((fn) => {
      try { fn(); } catch (e) { /* 무시 */ }
    });
  }

  async function refreshProfile() {
    profile = null;
    if (!session) return;
    const { data } = await sb
      .from("profiles").select("id,email,display_name,approved,shared_key_access")
      .eq("id", session.user.id).maybeSingle();
    profile = data || null;
  }

  function init() {
    if (!enabled) return;
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: "pkce" },
    });
    sb.auth.onAuthStateChange((_event, s) => {
      session = s;
      Object.keys(sharedKeyCache).forEach((k) => delete sharedKeyCache[k]);
      refreshProfile().then(notify);
    });
    sb.auth.getSession().then(({ data }) => {
      session = data.session;
      refreshProfile().then(notify);
    });
  }

  function onChange(fn) { listeners.push(fn); }
  function user() { return session ? session.user : null; }
  function isAdmin() {
    return !!(session && session.user.email === ADMIN_EMAIL);
  }
  function isApproved() {
    return isAdmin() || !!(profile && profile.approved);
  }
  // 공용 API 키 사용 권한 (회원 승인과 별개)
  function canUseShared() {
    return isAdmin() || !!(profile && profile.approved && profile.shared_key_access);
  }

  async function signIn() {
    await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin + location.pathname },
    });
  }
  async function signOut() { await sb.auth.signOut(); }

  // ── 공유 API 키 (승인 회원 전용, RLS가 통제) ──
  async function getSharedKey(provider) {
    if (!enabled) throw new Error("공유 키 기능이 설정되지 않았습니다.");
    if (!session) throw new Error("공유 키를 쓰려면 먼저 구글 로그인해 주세요.");
    if (sharedKeyCache[provider]) return sharedKeyCache[provider];
    const { data, error } = await sb
      .from("shared_keys").select("api_key")
      .eq("provider", provider).maybeSingle();
    if (error) throw new Error("공유 키 조회 실패: " + error.message);
    if (!data) {
      if (!isApproved()) {
        throw new Error("공유 키는 관리자 승인 후 사용할 수 있습니다 (현재 승인 대기 중). " +
          "본인 키를 직접 입력해 쓰실 수도 있습니다.");
      }
      if (!canUseShared()) {
        throw new Error("공용 API 사용 권한이 없습니다. 관리자에게 공용API 허용을 요청하거나 " +
          "본인 키를 직접 입력해 주세요.");
      }
      throw new Error("관리자가 아직 " +
        (provider === "gemini" ? "Gemini" : "OpenAI") + " 공유 키를 등록하지 않았습니다.");
    }
    sharedKeyCache[provider] = data.api_key;
    return data.api_key;
  }

  // ── 관리자 기능 (RLS가 관리자 외 접근을 거부) ──
  async function listProfiles() {
    const { data, error } = await sb
      .from("profiles").select("id,email,display_name,approved,shared_key_access,created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error("회원 목록 조회 실패: " + error.message);
    return data || [];
  }
  async function setApproved(id, approved) {
    const { error } = await sb.from("profiles").update({ approved }).eq("id", id);
    if (error) throw new Error("변경 실패: " + error.message);
  }
  async function setSharedAccess(id, sharedKeyAccess) {
    const { error } = await sb.from("profiles")
      .update({ shared_key_access: sharedKeyAccess }).eq("id", id);
    if (error) throw new Error("변경 실패: " + error.message);
  }
  async function getSharedKeys() {
    const { data, error } = await sb.from("shared_keys").select("provider,api_key");
    if (error) throw new Error("공유 키 조회 실패: " + error.message);
    const out = {};
    (data || []).forEach((r) => { out[r.provider] = r.api_key; });
    return out;
  }
  async function upsertSharedKey(provider, apiKey) {
    if (!apiKey) {
      const { error } = await sb.from("shared_keys").delete().eq("provider", provider);
      if (error) throw new Error("삭제 실패: " + error.message);
    } else {
      const { error } = await sb.from("shared_keys")
        .upsert({ provider, api_key: apiKey, updated_at: new Date().toISOString() });
      if (error) throw new Error("저장 실패: " + error.message);
    }
    delete sharedKeyCache[provider];
  }

  return {
    enabled: () => enabled,
    init, onChange, user, isAdmin, isApproved, canUseShared, signIn, signOut,
    getSharedKey, listProfiles, setApproved, setSharedAccess,
    getSharedKeys, upsertSharedKey,
  };
})();
