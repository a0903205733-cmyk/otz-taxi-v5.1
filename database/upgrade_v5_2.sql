create table if not exists public.vehicles (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  plate text not null,
  brand text,
  model text not null,
  color text,
  seats integer not null default 4 check (seats between 1 and 20),
  is_active boolean not null default true
);

create unique index if not exists vehicles_plate_unique
  on public.vehicles(upper(plate));

alter table public.drivers
  add column if not exists vehicle_id bigint references public.vehicles(id) on delete set null,
  add column if not exists member_role text not null default 'driver'
    check (member_role in ('driver', 'dispatcher', 'manager')),
  add column if not exists joined_at timestamptz not null default now();

alter table public.orders
  add column if not exists customer_phone text,
  add column if not exists payment_method text,
  add column if not exists payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'paid', 'refunded')),
  add column if not exists paid_at timestamptz;

create table if not exists public.customers (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  line_user_id text unique,
  name text,
  phone text,
  customer_type text not null default 'regular'
    check (customer_type in ('regular', 'vip', 'blacklist')),
  notes text
);

create table if not exists public.payments (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  order_id bigint not null references public.orders(id) on delete cascade,
  method text not null check (method in ('cash', 'line_pay')),
  amount integer not null check (amount >= 0),
  status text not null default 'paid' check (status in ('pending', 'paid', 'refunded')),
  transaction_ref text,
  recorded_by text
);

create table if not exists public.receipts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  order_id bigint not null unique references public.orders(id) on delete cascade,
  receipt_no text not null unique,
  amount integer not null check (amount >= 0),
  payment_method text,
  issued_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_type text not null,
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb
);

insert into public.settings(key, value)
values
  ('line_welcome_message', '"歡迎使用 OTZ 車隊，請輸入上車地點、下車地點、時間與人數。"'::jsonb),
  ('receipt_prefix', '"OTZR"'::jsonb)
on conflict (key) do nothing;

create index if not exists customers_phone_idx on public.customers(phone);
create index if not exists customers_type_idx on public.customers(customer_type);
create index if not exists payments_order_id_idx on public.payments(order_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);
create index if not exists audit_logs_entity_idx on public.audit_logs(entity_type, entity_id);

insert into public.vehicles(plate, model)
select distinct trim(plate), coalesce(nullif(trim(vehicle), ''), '未設定')
from public.drivers
where nullif(trim(plate), '') is not null
on conflict do nothing;

update public.drivers d
set vehicle_id = v.id
from public.vehicles v
where d.vehicle_id is null
  and nullif(trim(d.plate), '') is not null
  and upper(trim(d.plate)) = upper(v.plate);

create index if not exists drivers_vehicle_id_idx on public.drivers(vehicle_id);
create index if not exists drivers_member_role_idx on public.drivers(member_role);

create or replace function public.set_vehicle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists vehicles_set_updated_at on public.vehicles;
create trigger vehicles_set_updated_at
before update on public.vehicles
for each row execute function public.set_vehicle_updated_at();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'drivers'
  ) then
    alter publication supabase_realtime add table public.drivers;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vehicles'
  ) then
    alter publication supabase_realtime add table public.vehicles;
  end if;
end $$;

notify pgrst, 'reload schema';
