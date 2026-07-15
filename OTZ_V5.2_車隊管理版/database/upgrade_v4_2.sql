alter table public.drivers
  add column if not exists username text,
  add column if not exists password_hash text,
  add column if not exists last_login_at timestamptz;

create unique index if not exists drivers_username_unique
  on public.drivers(lower(username))
  where username is not null;

notify pgrst, 'reload schema';
