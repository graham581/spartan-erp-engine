-- 20260620020000_next_series_fn.sql
-- Adds an atomic naming-series increment function.
-- ROLLBACK: drop function if exists next_series(text);
create or replace function next_series(prefix text)
returns bigint
language sql
as $$
  insert into tab_series (name, current)
       values (prefix, 1)
  on conflict (name)
       do update set current = tab_series.current + 1
  returning current;
$$;

grant execute on function next_series(text) to service_role;
