-- Collector's Fix — database setup
-- Run this ONCE in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again: it only creates what is missing.

create table if not exists public.settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

-- One row per logged-in person: which Torn account she syncs and her wallet.
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text,
  torn_id     bigint,
  torn_name   text,
  money       bigint default 0,
  last_log_ts bigint default 0,
  synced_ts   bigint default 0
);

create table if not exists public.suppliers (
  id         bigint generated always as identity primary key,
  name       text not null,
  torn_id    bigint not null unique,
  rate       numeric(5,2) not null default 10,
  active     boolean not null default true,
  notes      text default '',
  created_at timestamptz default now()
);

-- Every sale, receipt and mugging read from the Torn logs (one row per item line).
create table if not exists public.events (
  id              text primary key,
  account_id      bigint not null,
  kind            text not null check (kind in ('bazaar_sale','im_sale','receive','mug')),
  ts              bigint not null,
  item_id         int,
  item_name       text,
  qty             int default 0,
  gross           bigint default 0,
  fee             bigint default 0,
  net             bigint default 0,
  counterparty_id bigint,
  raw             jsonb,
  created_at      timestamptz default now()
);
create index if not exists events_ts_idx   on public.events (ts);
create index if not exists events_item_idx on public.events (item_id, ts);

-- What is still on sale or waiting in inventory, per account, at the last sync.
create table if not exists public.stock (
  account_id bigint not null,
  item_id    int not null,
  item_name  text,
  bazaar_qty int default 0,
  im_qty     int default 0,
  inv_qty    int default 0,
  bazaar_price bigint default 0,
  updated_at timestamptz default now(),
  primary key (account_id, item_id)
);

-- A lot closes when every unit of an item has been sold.
create table if not exists public.lots (
  id         bigint generated always as identity primary key,
  item_id    int not null,
  item_name  text,
  opened_ts  bigint not null,
  closed_ts  bigint not null,
  sold_qty   int not null,
  revenue    bigint not null,
  own_qty    int not null,
  cf_keeps   bigint not null,
  created_at timestamptz default now(),
  unique (item_id, closed_ts)
);

create table if not exists public.lot_shares (
  id            bigint generated always as identity primary key,
  lot_id        bigint not null references public.lots(id) on delete cascade,
  supplier_id   bigint references public.suppliers(id) on delete set null,
  supplier_name text,
  qty           int not null,
  rate          numeric(5,2) not null,
  gross_share   bigint not null,
  payout        bigint not null,
  status        text not null default 'pending' check (status in ('pending','paid')),
  paid_at       timestamptz,
  paid_by       text
);

create table if not exists public.rent_log (
  id      bigint generated always as identity primary key,
  paid_at timestamptz default now(),
  amount  bigint not null,
  paid_by text
);

-- Only signed-in users (the accounts you create in Authentication → Users) can read or write.
do $$
declare t text;
begin
  foreach t in array array['settings','profiles','suppliers','events','stock','lots','lot_shares','rent_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "team access" on public.%I', t);
    execute format('create policy "team access" on public.%I for all to authenticated using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

grant usage on schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

insert into public.settings (key, value) values
  ('rent',           '{"amount": 12000000, "every_days": 3, "next_due": null}'),
  ('tracking_start', 'null')
on conflict (key) do nothing;

-- Added later: bazaar listing prices (safe to run on an existing database)
alter table public.stock add column if not exists bazaar_price bigint default 0;

-- Added later: stock market holdings per account
alter table public.profiles add column if not exists stocks_value bigint;
alter table public.profiles add column if not exists stocks jsonb;
alter table public.profiles add column if not exists stocks_ts bigint default 0;

-- Added later: Money tab (purchases, transfers and manual entries)
alter table public.events drop constraint if exists events_kind_check;
alter table public.events add constraint events_kind_check check (kind in
  ('bazaar_sale','im_sale','receive','mug','im_buy','bazaar_buy','abroad_buy','shop_buy','money_send','money_receive'));
create table if not exists public.money_entries (
  id          bigint generated always as identity primary key,
  ts          bigint not null,
  direction   text not null check (direction in ('in','out')),
  amount      bigint not null check (amount > 0),
  description text not null,
  tag         text,
  method      text,
  account     text,
  created_by  text,
  created_at  timestamptz default now()
);
alter table public.money_entries enable row level security;
drop policy if exists "team access" on public.money_entries;
create policy "team access" on public.money_entries for all to authenticated using (true) with check (true);
revoke all on public.money_entries from anon;
grant select, insert, update, delete on public.money_entries to authenticated;
grant usage, select on all sequences in schema public to authenticated;
notify pgrst, 'reload schema';
