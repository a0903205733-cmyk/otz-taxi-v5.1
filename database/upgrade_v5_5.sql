-- Cancellation and arrival serialize on the same order row.
create or replace function public.cancel_intake_before_arrival(p_order_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  target public.orders;
  driver_source jsonb;
begin
  select * into target from public.orders where id = p_order_id for update;
  if not found then return null; end if;
  if target.status = 'cancelled' or target.cancelled_at is not null then return null; end if;
  if exists (select 1 from public.audit_logs where entity_type = 'order'
    and entity_id = p_order_id::text and action = 'order.dispatch_arrival') then return null; end if;
  select details->'source' into driver_source from public.audit_logs
    where entity_type = 'order' and entity_id = p_order_id::text
    and action = 'order.dispatch_tag_complete' order by created_at, id limit 1;
  if not coalesce((target.status = 'pending' and target.completed_at is null)
    or (target.status = 'completed' and driver_source->>'userId' is not null
      and driver_source->>'type' = 'group' and driver_source->>'groupId' is not null), false)
    then return null; end if;
  update public.orders set status = 'cancelled', cancelled_at = now()
    where id = p_order_id returning * into target;
  insert into public.audit_logs(actor_type, action, entity_type, entity_id, details)
    values ('line', 'order.cancel_before_arrival', 'order', p_order_id::text,
      jsonb_build_object('driver_source', driver_source));
  return jsonb_build_object('order', to_jsonb(target), 'driverSource', driver_source);
end;
$$;

create or replace function public.claim_dispatch_arrival(p_order_id bigint, p_source jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  target public.orders;
  claim_id bigint;
begin
  select * into target from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if target.status = 'cancelled' or target.cancelled_at is not null then
    raise exception 'ORDER_CANCELLED';
  end if;
  if target.status <> 'completed' or not exists (select 1 from public.audit_logs
    where entity_type = 'order' and entity_id = p_order_id::text
    and action = 'order.dispatch_tag_complete') then
    raise exception 'FIRST_DISPATCH_COMPLETION_REQUIRED';
  end if;
  insert into public.audit_logs(actor_type, action, entity_type, entity_id, details)
    values ('line', 'order.dispatch_arrival', 'order', p_order_id::text,
      jsonb_build_object('source', p_source, 'notification_status', 'pending'))
    on conflict do nothing returning id into claim_id;
  return claim_id;
end;
$$;

revoke all on function public.cancel_intake_before_arrival(bigint) from public, anon, authenticated;
revoke all on function public.claim_dispatch_arrival(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.cancel_intake_before_arrival(bigint) to service_role;
grant execute on function public.claim_dispatch_arrival(bigint, jsonb) to service_role;
