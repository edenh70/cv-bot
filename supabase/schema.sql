-- Autonomous Data Analyst Job Hunter & 1-Page CV Tailoring PWA
-- Run this SQL in your Supabase SQL Editor.

create extension if not exists "pgcrypto";

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null unique,
  is_active boolean not null default true,
  last_scanned_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.sources(id) on delete set null,
  company text not null,
  title text not null,
  url text not null unique,
  match_score integer not null check (match_score >= 1 and match_score <= 10),
  summary_hebrew text not null,
  changes_made text not null,
  tailored_cv_json jsonb not null,
  status text not null default 'pending_review' check (status in ('pending_review', 'applied', 'archived')),
  applied_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_jobs_status_created_at
  on public.jobs (status, created_at desc);

create index if not exists idx_jobs_source_id
  on public.jobs (source_id);

create index if not exists idx_sources_is_active
  on public.sources (is_active);

-- Row Level Security:
-- All API routes use SUPABASE_SERVICE_ROLE_KEY strictly on the server,
-- which bypasses RLS safely while blocking all unauthenticated anon/public access.
alter table public.sources enable row level security;
alter table public.jobs enable row level security;
