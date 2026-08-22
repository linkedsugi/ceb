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
  insert into public.profiles (id, email, display_name, approved, shared_key_access)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
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
insert into public.profiles (id, email, display_name, approved, shared_key_access)
select u.id, u.email,
       coalesce(u.raw_user_meta_data ->> 'full_name', u.email), true, true
from auth.users u
where u.email = 'linkedsugi@gmail.com'
on conflict (id) do update
  set approved = true, shared_key_access = true;

-- ── 공유 API 키 (승인된 회원만 읽기, 관리자만 쓰기) ──
create table if not exists public.shared_keys (
  provider text primary key check (provider in ('openai', 'gemini')),
  api_key text not null,
  note text,
  updated_at timestamptz not null default now()
);

alter table public.shared_keys enable row level security;

drop policy if exists "shared_keys approved read" on public.shared_keys;
create policy "shared_keys approved read" on public.shared_keys
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.approved and p.shared_key_access
    )
  );

drop policy if exists "shared_keys admin write" on public.shared_keys;
create policy "shared_keys admin write" on public.shared_keys
  for all using (public.is_admin()) with check (public.is_admin());
