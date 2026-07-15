create table if not exists public.settings (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  key text not null unique,
  value jsonb not null
);

insert into public.settings(key, value)
values
  ('fleet_name', '"OTZ 車隊"'::jsonb),
  ('base_fare', '60'::jsonb),
  ('per_km', '20'::jsonb),
  ('per_minute', '2'::jsonb),
  ('default_toll', '0'::jsonb),
  ('night_surcharge', '0'::jsonb),
  ('ignored_keywords', '["常見問題","試算車資","應徵司機"]'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
