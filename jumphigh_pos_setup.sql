-- Projeclab Studios: Jumphigh POS (sales tracking, stock per size/colour)
-- Already applied in Supabase on 14 Nov 2026 (migration "jumphigh_pos") - kept here for the record.
-- Not a BIR receipt system: it tracks sales and stock. Official receipts stay with Jumphigh's BIR booklet/system.
--
-- Who can do what (row-level security + checks inside the functions):
--   * every Jumphigh member (staff + managers): read products, stock, sales and cash counts;
--     record a sale (jh_record_sale) and a cash count (jh_close_day)
--   * Jumphigh managers (jh_members.role = 'admin'): edit products/stock, returns (jh_return_sale)
-- Sales and cash counts can't be written directly, only through the functions, so stock
-- and totals always come from the server, not from the browser.

create table if not exists public.jh_products (
  id         text primary key,
  name       text not null,
  brand      text,
  category   text,
  price      numeric(12,2) not null default 0,
  active     boolean not null default true,
  sort       integer not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.jh_variants (
  id         text primary key,
  product_id text not null references public.jh_products(id) on delete cascade,
  color      text not null default '',
  size       text not null default '',
  stock      integer not null default 0,
  price      numeric(12,2),            -- blank = product price
  active     boolean not null default true,
  sort       integer not null default 0
);
create index if not exists jh_variants_product_idx on public.jh_variants(product_id);

create table if not exists public.jh_sales (
  id        text primary key,
  no        bigserial unique,
  at        timestamptz not null default now(),
  day       date not null,
  seller_id text,
  cashier   text,
  items     jsonb not null default '[]'::jsonb,
  subtotal  numeric(12,2) not null default 0,
  item_disc numeric(12,2) not null default 0,
  sale_disc numeric(12,2) not null default 0,
  total     numeric(12,2) not null default 0,
  payments  jsonb not null default '[]'::jsonb,
  change    numeric(12,2) not null default 0,
  note      text,
  status    text not null default 'done',   -- done | partial | returned
  returns   jsonb not null default '[]'::jsonb,
  returned  numeric(12,2) not null default 0
);
create index if not exists jh_sales_day_idx on public.jh_sales(day);

create table if not exists public.jh_cash_counts (
  id       bigserial primary key,
  day      date not null,
  counted  numeric(12,2) not null,
  expected numeric(12,2) not null,
  note     text,
  by_email text,
  at       timestamptz not null default now()
);

alter table public.jh_products    enable row level security;
alter table public.jh_variants    enable row level security;
alter table public.jh_sales       enable row level security;
alter table public.jh_cash_counts enable row level security;

drop policy if exists "jh products: members read" on public.jh_products;
drop policy if exists "jh products: admins write" on public.jh_products;
drop policy if exists "jh variants: members read" on public.jh_variants;
drop policy if exists "jh variants: admins write" on public.jh_variants;
drop policy if exists "jh sales: members read"    on public.jh_sales;
drop policy if exists "jh counts: members read"   on public.jh_cash_counts;
create policy "jh products: members read" on public.jh_products for select to authenticated using (public.is_jh_member());
create policy "jh products: admins write" on public.jh_products for all    to authenticated using (public.is_jh_admin()) with check (public.is_jh_admin());
create policy "jh variants: members read" on public.jh_variants for select to authenticated using (public.is_jh_member());
create policy "jh variants: admins write" on public.jh_variants for all    to authenticated using (public.is_jh_admin()) with check (public.is_jh_admin());
create policy "jh sales: members read"    on public.jh_sales    for select to authenticated using (public.is_jh_member());
create policy "jh counts: members read"   on public.jh_cash_counts for select to authenticated using (public.is_jh_member());

-- Record a sale. Prices come from the products table; the browser only sends
-- which items, how many, discounts, who sold it and how it was paid.
create or replace function public.jh_record_sale(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it jsonb; v record; q integer; disc numeric; items jsonb := '[]'::jsonb;
  sub numeric := 0; idisc numeric := 0; sdisc numeric; tot numeric;
  paid numeric := 0; cash numeric := 0; chg numeric;
  d date := (now() at time zone 'Asia/Manila')::date;
begin
  if not public.is_jh_member() then raise exception 'Your login can''t record Jumphigh sales.' using errcode = '42501'; end if;
  if coalesce(p->>'id', '') = '' then raise exception 'Missing sale id.'; end if;
  if exists (select 1 from jh_sales where id = p->>'id') then
    return (select to_jsonb(s) from jh_sales s where id = p->>'id');   -- already saved (double tap)
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'The sale has no items.'; end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    select vv.id, vv.product_id, vv.color, vv.size, pp.name as pname, coalesce(vv.price, pp.price) as uprice
      into v from jh_variants vv join jh_products pp on pp.id = vv.product_id where vv.id = it->>'variantId';
    if not found then raise exception 'One of the items no longer exists. Refresh and try again.'; end if;
    q := coalesce((it->>'qty')::integer, 0);
    if q <= 0 then raise exception 'Quantity must be at least 1.'; end if;
    disc := least(greatest(coalesce((it->>'disc')::numeric, 0), 0), v.uprice * q);
    update jh_variants set stock = stock - q where id = v.id;
    items := items || jsonb_build_object('variantId', v.id, 'productId', v.product_id, 'name', v.pname,
      'color', v.color, 'size', v.size, 'qty', q, 'price', v.uprice, 'disc', round(disc, 2));
    sub := sub + v.uprice * q; idisc := idisc + disc;
  end loop;
  sdisc := least(greatest(coalesce((p->>'saleDisc')::numeric, 0), 0), sub - idisc);
  tot := round(sub - idisc - sdisc, 2);
  select coalesce(sum((x->>'amount')::numeric), 0),
         coalesce(sum(case when x->>'method' = 'cash' then (x->>'amount')::numeric else 0 end), 0)
    into paid, cash from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) x;
  if paid < tot then raise exception 'The payment is short by %.', round(tot - paid, 2); end if;
  chg := round(paid - tot, 2);
  if chg > cash then raise exception 'Only cash can be overpaid (for change).'; end if;
  insert into jh_sales (id, day, seller_id, cashier, items, subtotal, item_disc, sale_disc, total, payments, change, note)
  values (p->>'id', d, nullif(p->>'sellerId', ''), lower(coalesce(auth.jwt() ->> 'email', '')), items,
          round(sub, 2), round(idisc, 2), round(sdisc, 2), tot, coalesce(p->'payments', '[]'::jsonb), chg, nullif(p->>'note', ''));
  return (select to_jsonb(s) from jh_sales s where id = p->>'id');
end $$;

-- Return items from a sale (managers only). Puts the stock back and records the refund.
-- lines = [{ "i": item index, "qty": n }]. Refund per item = what was actually paid for it
-- (after its own discount and its share of the sale discount).
create or replace function public.jh_return_sale(p_sale text, p_lines jsonb, p_method text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s jh_sales%rowtype; ln jsonb; i integer; q integer; it jsonb; done_q integer; unit numeric;
  base numeric; amt numeric := 0; lines_out jsonb := '[]'::jsonb; total_q integer; total_ret integer;
begin
  if not public.is_jh_admin() then raise exception 'Only Jumphigh managers can do returns.' using errcode = '42501'; end if;
  select * into s from jh_sales where id = p_sale for update;
  if not found then raise exception 'Sale not found.'; end if;
  base := s.subtotal - s.item_disc;
  for ln in select * from jsonb_array_elements(p_lines) loop
    i := (ln->>'i')::integer; q := coalesce((ln->>'qty')::integer, 0);
    if q <= 0 then continue; end if;
    it := s.items -> i;
    if it is null then raise exception 'Unknown item on this sale.'; end if;
    select coalesce(sum((l->>'qty')::integer), 0) into done_q
      from jsonb_array_elements(s.returns) r, jsonb_array_elements(r->'lines') l where (l->>'i')::integer = i;
    if done_q + q > (it->>'qty')::integer then raise exception 'You can''t return more % than were sold.', it->>'name'; end if;
    unit := ((it->>'price')::numeric * (it->>'qty')::integer - (it->>'disc')::numeric);
    if base > 0 then unit := unit - s.sale_disc * unit / base; end if;
    unit := unit / (it->>'qty')::integer;
    update jh_variants set stock = stock + q where id = it->>'variantId';
    lines_out := lines_out || jsonb_build_object('i', i, 'qty', q, 'amount', round(unit * q, 2));
    amt := amt + round(unit * q, 2);
  end loop;
  if jsonb_array_length(lines_out) = 0 then raise exception 'Pick at least one item to return.'; end if;
  update jh_sales set
    returns = returns || jsonb_build_array(jsonb_build_object('at', now(), 'by', lower(coalesce(auth.jwt() ->> 'email', '')),
      'lines', lines_out, 'amount', amt, 'method', coalesce(nullif(p_method, ''), 'cash'), 'note', nullif(p_note, ''))),
    returned = returned + amt
  where id = p_sale;
  select coalesce(sum((x->>'qty')::integer), 0) into total_q from jsonb_array_elements(s.items) x;
  select coalesce(sum((l->>'qty')::integer), 0) into total_ret
    from jh_sales ss, jsonb_array_elements(ss.returns) r, jsonb_array_elements(r->'lines') l where ss.id = p_sale;
  update jh_sales set status = case when total_ret >= total_q then 'returned' else 'partial' end where id = p_sale;
  return (select to_jsonb(x) from jh_sales x where id = p_sale);
end $$;

-- Cash expected in the drawer for a day: opening float + cash taken - change given - cash refunds.
create or replace function public.jh_cash_expected(p_day date)
returns numeric language sql stable security definer set search_path = public as $$
  select case when not public.is_jh_member() then null else coalesce((select nullif(data->>'float', '')::numeric from jh_data where id = 'settings'), 0)
    + coalesce((select sum((x->>'amount')::numeric) from jh_sales s, jsonb_array_elements(s.payments) x
                where s.day = p_day and x->>'method' = 'cash'), 0)
    - coalesce((select sum(change) from jh_sales where day = p_day), 0)
    - coalesce((select sum((r->>'amount')::numeric) from jh_sales s, jsonb_array_elements(s.returns) r
                where r->>'method' = 'cash' and ((r->>'at')::timestamptz at time zone 'Asia/Manila')::date = p_day), 0) end;
$$;

create or replace function public.jh_close_day(p_day date, p_counted numeric, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jh_cash_counts%rowtype;
begin
  if not public.is_jh_member() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  if p_counted is null or p_counted < 0 then raise exception 'Type the cash you counted.'; end if;
  insert into jh_cash_counts (day, counted, expected, note, by_email)
  values (p_day, round(p_counted, 2), round(public.jh_cash_expected(p_day), 2), nullif(p_note, ''), lower(coalesce(auth.jwt() ->> 'email', '')))
  returning * into r;
  return to_jsonb(r);
end $$;

revoke execute on function public.jh_record_sale(jsonb) from public, anon;
revoke execute on function public.jh_return_sale(text, jsonb, text, text) from public, anon;
revoke execute on function public.jh_cash_expected(date) from public, anon;
revoke execute on function public.jh_close_day(date, numeric, text) from public, anon;
grant execute on function public.jh_record_sale(jsonb) to authenticated;
grant execute on function public.jh_return_sale(text, jsonb, text, text) to authenticated;
grant execute on function public.jh_cash_expected(date) to authenticated;
grant execute on function public.jh_close_day(date, numeric, text) to authenticated;
