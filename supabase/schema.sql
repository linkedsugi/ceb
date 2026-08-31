-- Bible Canvas — Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 Run 하세요.
-- 관리자: linkedsugi@gmail.com (변경하려면 아래 is_admin 함수와 트리거의 이메일을 수정)

-- ── 관리자 판별 ─────────────────────────────
create or replace function public.is_admin()
returns boolean
language sql stable
as $$
  select coalesce((auth.jwt() ->> 'email') = 'linkedsugi@gmail.com', false)
$$;

-- ── 회원 프로필 ─────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  approved boolean not null default false,           -- 회원 승인 (가입 허용)
  shared_key_access boolean not null default false,  -- 공용 API 키 사용 허용
  created_at timestamptz not null default now()
);

-- 기존 설치본 업그레이드용 (없으면 컬럼 추가)
alter table public.profiles
  add column if not exists shared_key_access boolean not null default false;
-- ElevenLabs 음성 사용 특별 승인 (관리자만 부여, 별도 신청 없음)
alter table public.profiles
  add column if not exists elevenlabs_access boolean not null default false;

alter table public.profiles enable row level security;

drop policy if exists "profiles select" on public.profiles;
create policy "profiles select" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- 구글 로그인(가입) 시 프로필 자동 생성. 관리자는 자동 승인.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, approved, shared_key_access, elevenlabs_access)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.email = 'linkedsugi@gmail.com',
    new.email = 'linkedsugi@gmail.com',
    new.email = 'linkedsugi@gmail.com'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 관리자 계정은 항상 기본 승인 + 공용API 허용 상태로 보정
-- (트리거 설치 전에 가입했거나 컬럼이 나중에 추가된 경우 대비)
insert into public.profiles (id, email, display_name, approved, shared_key_access, elevenlabs_access)
select u.id, u.email,
       coalesce(u.raw_user_meta_data ->> 'full_name', u.email), true, true, true
from auth.users u
where u.email = 'linkedsugi@gmail.com'
on conflict (id) do update
  set approved = true, shared_key_access = true, elevenlabs_access = true;

-- ── 공유 API 키 (승인된 회원만 읽기, 관리자만 쓰기) ──
create table if not exists public.shared_keys (
  provider text primary key,
  api_key text not null,
  note text,
  updated_at timestamptz not null default now()
);

-- 허용 공급자 (기존 설치본 업그레이드 시에도 elevenlabs가 포함되도록 재생성)
alter table public.shared_keys drop constraint if exists shared_keys_provider_check;
alter table public.shared_keys add constraint shared_keys_provider_check
  check (provider in ('openai', 'gemini', 'elevenlabs'));

alter table public.shared_keys enable row level security;

-- 읽기: OpenAI·Gemini 키는 승인+공용API 회원, ElevenLabs 키는
-- 관리자가 특별 승인(elevenlabs_access)한 회원만
drop policy if exists "shared_keys approved read" on public.shared_keys;
create policy "shared_keys approved read" on public.shared_keys
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.approved and (
        (shared_keys.provider <> 'elevenlabs' and p.shared_key_access)
        or (shared_keys.provider = 'elevenlabs' and p.elevenlabs_access)
      )
    )
  );

drop policy if exists "shared_keys admin write" on public.shared_keys;
create policy "shared_keys admin write" on public.shared_keys
  for all using (public.is_admin()) with check (public.is_admin());

-- ── 사용 통계 (회원별 · 일자별 집계) ─────────
-- 원문 내용은 저장하지 않고 이벤트 횟수만 센다.
create table if not exists public.usage_stats (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  event text not null,
  detail text not null default '',   -- ai: "provider:model", tts: "provider"
  count integer not null default 1,
  primary key (user_id, day, event, detail)
);

alter table public.usage_stats drop constraint if exists usage_stats_event_check;
alter table public.usage_stats add constraint usage_stats_event_check
  check (event in ('visit','chapter','ai','search','bookmark','note','tts','plan'));

alter table public.usage_stats enable row level security;

-- 읽기는 관리자만 (본인 행 포함 직접 조회 불가 — RPC로만 기록)
drop policy if exists "usage admin read" on public.usage_stats;
create policy "usage admin read" on public.usage_stats
  for select using (public.is_admin());

-- 기록: 로그인한 사용자가 자기 카운터를 1 올린다 (security definer)
create or replace function public.log_usage(p_event text, p_detail text default '')
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  if p_event not in ('visit','chapter','ai','search','bookmark','note','tts','plan') then return; end if;
  insert into public.usage_stats (user_id, day, event, detail)
  values (auth.uid(), (now() at time zone 'utc')::date, p_event, coalesce(left(p_detail, 80), ''))
  on conflict (user_id, day, event, detail)
  do update set count = usage_stats.count + 1;
end;
$$;

grant execute on function public.log_usage(text, text) to authenticated;
