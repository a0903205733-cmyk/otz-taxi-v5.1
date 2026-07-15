alter table public.orders
  add column if not exists assigned_driver_id bigint,
  add column if not exists started_at timestamptz;

create table if not exists public.drivers (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null,
  phone text,
  plate text,
  vehicle text,
  status text not null default 'available'
    check (status in ('available','busy','offline')),
  is_active boolean not null default true
);

create index if not exists drivers_status_idx on public.drivers(status);
create index if not exists orders_assigned_driver_idx on public.orders(assigned_driver_id);

notify pgrst, 'reload schema';
