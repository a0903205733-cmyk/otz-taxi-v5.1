-- Preserve unparsed customer form details (人數／行李／特殊需求) on each order.
alter table public.orders
  add column if not exists ride_details text;
