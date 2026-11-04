-- Tradeloggen: databas
-- Signaler är gemensamma för alla inloggade. Trades och avfärdade signaler är privata per person.

create table if not exists public.signals (
  id            text primary key,              -- t.ex. sig-abb-20261104
  aktie         text not null,
  ticker        text,                          -- TradingView-format, t.ex. OMXSTO:ABB
  valuta        text not null default 'SEK',
  datum         text,                          -- visningsdatum, t.ex. "4 nov"
  kalla         text,                          -- rubriken på Stockrobbers inlägg
  skal          text,                          -- huvudanledning
  kop           numeric,
  stopp         numeric,
  mal1          numeric,
  mal2          numeric,
  stod          numeric[] default '{}',
  motstand      numeric[] default '{}',
  knockout_max  numeric,                       -- Mini L-stopnivå bör ligga under detta
  rapport       text,                          -- varning, t.ex. "Rapport 6 nov"
  aktiv         boolean not null default true, -- false = dold för alla
  skapad        timestamptz not null default now()
);

create table if not exists public.trades (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  signal_id   text references public.signals(id) on delete set null,
  aktie       text not null,
  ticker      text,
  valuta      text not null default 'SEK',
  status      text not null check (status in ('Planerad', 'Öppen', 'Stängd')),
  instrument  text not null default 'Mini L',
  hav         numeric,
  kop         numeric not null,
  stopp       numeric,
  mal1        numeric,
  mal2        numeric,
  knockout    numeric,
  insats      numeric,
  kurs        numeric,
  kurs_datum  timestamptz,
  resultat    numeric,
  anteckning  text,
  skapad      timestamptz not null default now(),
  stangd      timestamptz
);
create index if not exists trades_user_idx on public.trades(user_id);

create table if not exists public.dismissed (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  signal_id  text not null references public.signals(id) on delete cascade,
  skapad     timestamptz not null default now(),
  primary key (user_id, signal_id)
);

-- Åtkomstregler
alter table public.signals   enable row level security;
alter table public.trades    enable row level security;
alter table public.dismissed enable row level security;

drop policy if exists "Inloggade läser signaler" on public.signals;
create policy "Inloggade läser signaler" on public.signals
  for select to authenticated using (aktiv);

drop policy if exists "Egna trades" on public.trades;
create policy "Egna trades" on public.trades
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Egna avfärdade" on public.dismissed;
create policy "Egna avfärdade" on public.dismissed
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Live-uppdateringar i appen
do $$
begin
  begin alter publication supabase_realtime add table public.signals;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.trades;    exception when duplicate_object then null; end;
end $$;
