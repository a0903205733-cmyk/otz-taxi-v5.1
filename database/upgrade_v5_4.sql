-- One durable arrival notification claim per order, across all bot instances.
create unique index if not exists audit_logs_dispatch_arrival_unique
  on public.audit_logs(entity_type, entity_id, action)
  where action = 'order.dispatch_arrival';
