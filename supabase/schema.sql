-- CaliSurf Light Supabase schema
-- Run this in Supabase SQL Editor after creating your project.
-- Then create auth user admin@calisurf.com in Authentication and insert its UUID into admin_profiles.

create table if not exists public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  role text not null default 'admin' check (role in ('admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.surf_spots (
  id text primary key,
  name text not null,
  region text not null default 'California',
  lat double precision not null,
  lon double precision not null,
  active boolean not null default true,
  display_order integer,
  beach_orientation_deg double precision,
  bathymetry jsonb not null default '{}'::jsonb,
  exposure_by_direction jsonb not null default '{}'::jsonb,
  public_data jsonb not null default '{}'::jsonb,
  notes text,
  updated_at timestamptz not null default now()
);

alter table public.admin_profiles enable row level security;
alter table public.site_settings enable row level security;
alter table public.surf_spots enable row level security;

create or replace function public.is_calisurf_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_profiles
    where id = auth.uid() and role = 'admin' and active = true
  );
$$;

drop policy if exists "admins read own admin profile" on public.admin_profiles;
drop policy if exists "public read site settings" on public.site_settings;
drop policy if exists "public read active surf spots" on public.surf_spots;
drop policy if exists "admins write site settings" on public.site_settings;
drop policy if exists "admins write surf spots" on public.surf_spots;

create policy "admins read own admin profile"
  on public.admin_profiles for select
  using (id = auth.uid());

create policy "public read site settings"
  on public.site_settings for select
  using (true);

create policy "public read active surf spots"
  on public.surf_spots for select
  using (active = true or public.is_calisurf_admin());

create policy "admins write site settings"
  on public.site_settings for all
  using (public.is_calisurf_admin())
  with check (public.is_calisurf_admin());

create policy "admins write surf spots"
  on public.surf_spots for all
  using (public.is_calisurf_admin())
  with check (public.is_calisurf_admin());

-- After creating admin@calisurf.com in Supabase Auth, run this with the real UUID:
-- insert into public.admin_profiles (id, email, role, active)
-- values ('PASTE-AUTH-USER-UUID-HERE', 'admin@calisurf.com', 'admin', true)
-- on conflict (id) do update set email = excluded.email, role = 'admin', active = true;
