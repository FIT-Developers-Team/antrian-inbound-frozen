-- ============================================================================
-- ANTRIAN INBOUND FROZEN — SKEMA POSTGRES
--
-- Satu berkas, Postgres biasa. Tidak ada Supabase di sini: tidak ada
-- `service_role`, `anon`, `authenticated`, tidak ada `supabase_vault`,
-- `pg_net`, maupun `pg_cron`.
--
-- Yang menggantikan ketiganya:
--   * Peran      -> hanya API yang menyentuh database, jadi RLS tidak lagi
--                   menjadi batas keamanan. Batasnya ada di lapisan API.
--   * Penjadwal  -> proses Node menjalankan sync pada timer, bukan pg_cron.
--   * HTTP       -> Node yang memanggil Superset, bukan pg_net dari dalam SQL.
--
-- SELURUH berkas ini idempoten (`if not exists` / `create or replace`),
-- sehingga API dapat menerapkannya pada setiap start dan skema selalu menyusul
-- kode tanpa perlu perkakas migrasi terpisah.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Gudang
-- ---------------------------------------------------------------------------
create table if not exists site_master (
  site_code    text primary key,
  location_id  text not null unique,
  site_name    text not null,
  short_name   text,
  gate_prefix  text not null,
  gate_count   integer not null default 6,
  active       boolean not null default false,
  sort_order   integer not null default 100,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

insert into site_master(site_code, location_id, site_name, short_name, gate_prefix, gate_count, active, sort_order)
values
  ('PGS','160','Pegangsaan','Pegangsaan','PGS-GATE-INB-01',9,true ,1),
  ('SRG','796','Srengseng','Srengseng','SRG-GATE-INB-01',6,false,2),
  ('BIT','983','Bitung','Bitung','BIT-GATE-INB-01',6,false,3),
  ('CSI','998','Cileungsi','Cileungsi','CSI-GATE-INB-01',6,false,4)
on conflict (site_code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Tiket
-- ---------------------------------------------------------------------------
create table if not exists tickets (
  ticket_id          text primary key,
  queue_no           text not null,
  ticket_type        text not null default 'REG',
  status             text not null default 'WAITING',
  site_code          text references site_master(site_code),
  vendor_name        text,
  fleet_type         text,
  plat_number        text,
  driver_name        text,
  driver_phone       text,
  gate               text,
  slot               text,
  operational_date   date,
  registered_by      text,
  ktp_6_digit        text,
  unload_sla         text,
  source             text,
  called_at          timestamptz,
  arrived_at         timestamptz,
  start_unloading_at timestamptz,
  done_unloading_at  timestamptz,
  expired_at         timestamptz,
  expired_reason     text,
  call_count         integer not null default 0,
  last_call_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists ticket_pos (
  ticket_po_id        text primary key,
  ticket_id           text not null references tickets(ticket_id) on delete cascade,
  po_number           text not null,
  vendor_name         text,
  request_quantity    double precision not null default 0,
  actual_quantity     double precision not null default 0,
  count_sku           integer not null default 0,
  checker_status      text not null default 'PENDING',
  gr_status           text not null default 'PENDING',
  checker_id          text,
  checker_name        text,
  checking_started_at timestamptz,
  checking_done_at    timestamptz,
  gr_done_at          timestamptz,
  handover_grn_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists ticket_events (
  event_id     uuid primary key default gen_random_uuid(),
  ticket_id    text not null references tickets(ticket_id) on delete cascade,
  event_type   text not null,
  actor_role   text,
  actor_name   text,
  payload_json jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists checker_master (
  mp_id        text primary key,
  checker_name text not null,
  active       boolean not null default true
);

-- ---------------------------------------------------------------------------
-- 3. Master PO dari Superset
-- ---------------------------------------------------------------------------
create table if not exists superset_po_master (
  source_row_key                 text primary key,
  po_number                      text not null,
  vendor_name                    text,
  location_id                    text,
  location_name                  text,
  site_code                      text,
  request_shipping_date          text,
  fulfillment_arrived_start_at   text,
  schedule_type                  text,
  po_status                      text,
  fulfillment_receiving_start_at text,
  fulfillment_completed_at       text,
  request_quantity               double precision not null default 0,
  actual_quantity                double precision not null default 0,
  count_sku                      bigint not null default 0,
  synced_at                      timestamptz not null default now()
);

create table if not exists sync_runs (
  run_id        uuid primary key default gen_random_uuid(),
  sync_name     text not null,
  status        text not null,
  fetched_count integer not null default 0,
  written_count integer not null default 0,
  error_message text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create table if not exists product_master (
  sku_number   text primary key,
  product_name text not null,
  product_id   text
);

-- Antrean ekspor ke Google Sheet. Tabelnya tetap ada supaya RPC dapat menandai
-- baris yang berubah; pekerjanya opsional dan mati secara bawaan.
create table if not exists gsheet_sync_outbox (
  ticket_po_id  text primary key references ticket_pos(ticket_po_id) on delete cascade,
  ticket_id     text not null references tickets(ticket_id) on delete cascade,
  sync_status   text not null default 'PENDING',
  attempt_count integer not null default 0,
  last_error    text,
  synced_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Index untuk jalur kueri panas
-- ---------------------------------------------------------------------------
create index if not exists tickets_board_idx
  on tickets(site_code, operational_date desc, created_at desc);
create index if not exists tickets_status_idx on tickets(site_code, status);
create index if not exists ticket_pos_ticket_idx on ticket_pos(ticket_id);
create index if not exists superset_po_number_idx on superset_po_master(po_number);
create index if not exists superset_po_site_idx on superset_po_master(site_code, po_number);
create index if not exists ticket_events_ticket_idx on ticket_events(ticket_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. updated_at otomatis
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

do $$
declare t text;
begin
  foreach t in array array['tickets','ticket_pos','site_master','gsheet_sync_outbox'] loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format(
      'create trigger %I_touch before update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Aturan SLA — satu-satunya sumber kebenaran
--
-- Angka ini tidak boleh dihitung ulang di browser. Sebelum revamp, aturan yang
-- sama ditulis di tiga tempat dengan hasil berbeda, dan angka SLA di layar
-- tidak pernah cocok dengan angka di laporan.
-- ---------------------------------------------------------------------------
create or replace function inbound_fleet_canonical(p_fleet text)
returns text language sql immutable as $$
  select case
    when v like '%TRONTON%' or v like '%FUSO%'   then 'TRONTON/FUSO'
    when v like '%WING%'                         then 'WING BOX'
    when v like '%CDDL%'                         then 'CDDL'
    when v like '%CDEL%'                         then 'CDEL'
    when v like '%CDD%'                          then 'CDD'
    when v like '%CDE%'                          then 'CDE'
    when v like '%DROP%'                         then 'DROP-OFF'
    when v like '%RODA 2%' or v like '%MOTOR%'   then 'RODA 2'
    when v like '%L300%'                         then 'L300 BOX'
    when v like '%PICK%'                         then 'PICKUP'
    when v like '%GRANDMAX%' or v like '%MOBIL%' then 'MOBIL'
    when v like '%VAN%'                          then 'VAN'
    else v
  end
  from (select upper(regexp_replace(btrim(coalesce(p_fleet, '')), '\s+', ' ', 'g')) as v) x;
$$;

/**
 * Target SLA bongkar dalam jam. CDDL mengikuti CDD, CDEL mengikuti CDE.
 * SKU tepat 40 masih masuk tier 2 jam — batasnya "lebih dari 40".
 * Mengembalikan 0 untuk armada tanpa SLA.
 */
create or replace function inbound_sla_target_hours(p_fleet text, p_sku integer)
returns integer language sql immutable as $$
  select case
    when f in ('TRONTON/FUSO', 'WING BOX')           then 4
    when f in ('CDD', 'CDDL', 'CDE', 'CDEL')         then case when coalesce(p_sku, 0) > 40 then 4 else 2 end
    when f in ('VAN', 'PICKUP', 'MOBIL', 'L300 BOX') then 2
    when f = 'RODA 2'                                then 1
    when f = 'DROP-OFF'                              then 23
    else 0
  end
  from (select inbound_fleet_canonical(p_fleet) as f) x;
$$;

-- ---------------------------------------------------------------------------
-- 7. Gate
-- ---------------------------------------------------------------------------
create or replace function inbound_active_gates()
returns table(site_code text, gate_index integer, gate_name text)
language sql stable as $$
  select s.site_code, g.i::integer,
         s.gate_prefix || '-' || lpad(g.i::text, 2, '0')
    from site_master s
    cross join lateral generate_series(1, greatest(s.gate_count, 0)) as g(i)
   where s.active
   order by s.sort_order, g.i;
$$;

-- ---------------------------------------------------------------------------
-- 8. Papan antrean — satu baris per tiket
-- ---------------------------------------------------------------------------
create or replace view inbound_board as
with po_rollup as (
  select
    ticket_id,
    string_agg(po_number, ', ' order by created_at, ticket_po_id) as po_numbers,
    count(*)::int                                                 as po_count,
    coalesce(sum(request_quantity), 0)                            as total_qty,
    coalesce(sum(count_sku), 0)::int                              as total_sku,
    max(gr_done_at)                                               as last_gr_done_at,
    count(*) filter (where upper(coalesce(gr_status, '')) = 'DONE GR') = count(*) as all_done_gr,
    max(updated_at)                                               as po_updated_at
  from ticket_pos
  group by ticket_id
)
select
  t.ticket_id, t.queue_no, t.ticket_type, t.status, t.site_code,
  t.vendor_name, t.fleet_type, t.plat_number, t.driver_name, t.driver_phone,
  t.gate, t.slot, t.operational_date::text as operational_date,
  t.registered_by, t.source,
  t.arrived_at, t.called_at, t.call_count,
  t.start_unloading_at, t.done_unloading_at,
  t.expired_at, t.expired_reason,
  t.created_at, t.updated_at,

  coalesce(p.po_numbers, '') as po_numbers,
  coalesce(p.po_count, 0)    as po_count,
  coalesce(p.total_qty, 0)   as total_qty,
  coalesce(p.total_sku, 0)   as total_sku,

  inbound_sla_target_hours(t.fleet_type, coalesce(p.total_sku, 0)) as sla_target_hours,

  case
    when inbound_sla_target_hours(t.fleet_type, coalesce(p.total_sku, 0)) > 0
     and t.start_unloading_at is not null
    then t.start_unloading_at
         + make_interval(hours => inbound_sla_target_hours(t.fleet_type, coalesce(p.total_sku, 0)))
  end as sla_deadline_at,

  t.start_unloading_at as sla_started_at,

  coalesce(
    case when p.all_done_gr then p.last_gr_done_at end,
    t.done_unloading_at,
    t.expired_at
  ) as sla_stopped_at,

  greatest(t.updated_at, coalesce(p.po_updated_at, t.updated_at)) as row_updated_at
from tickets t
left join po_rollup p on p.ticket_id = t.ticket_id;

-- ---------------------------------------------------------------------------
-- 9. Antrean ekspor Google Sheet
-- ---------------------------------------------------------------------------
create or replace function inbound_requeue_gsheet(p_ticket_ids text[])
returns void language sql as $$
  insert into gsheet_sync_outbox(ticket_po_id, ticket_id, sync_status, attempt_count, last_error, synced_at)
  select p.ticket_po_id, p.ticket_id, 'PENDING', 0, null, null
    from ticket_pos p where p.ticket_id = any(p_ticket_ids)
  on conflict (ticket_po_id) do update
    set sync_status = 'PENDING', attempt_count = 0, last_error = null, synced_at = null;
$$;

-- ---------------------------------------------------------------------------
-- 10. Kesegaran sumber
-- ---------------------------------------------------------------------------
create or replace function inbound_source_freshness(p_site_code text default null)
returns jsonb language sql stable as $$
  with bounds as (select nullif(upper(btrim(coalesce(p_site_code, ''))), '') as site),
  scoped as (
    -- Kolom disebut satu per satu: `m.*` bersama `s.site_code` menghasilkan
    -- dua kolom bernama sama dan membuat setiap rujukan di bawah ambigu.
    select m.synced_at, s.site_code, s.location_id
      from superset_po_master m
      join site_master s on s.location_id = m.location_id and s.active
      cross join bounds b
     where b.site is null or s.site_code = b.site
  ),
  master as (
    select count(*)::int as total_po, max(synced_at) as last_synced_at,
           min(location_id) as location_id, min(site_code) as site_code
      from scoped
  ),
  last_run as (
    select status, finished_at, written_count, error_message
      from sync_runs where sync_name = 'superset'
      order by started_at desc limit 1
  )
  select jsonb_build_object(
    'location_id', master.location_id,
    'site_code', master.site_code,
    'total_po', coalesce(master.total_po, 0),
    'last_synced_at', master.last_synced_at,
    -- Umur dihitung server: jam tablet gudang kerap meleset beberapa menit,
    -- dan itu justru menyembunyikan sync yang benar-benar macet.
    'age_seconds', case when master.last_synced_at is not null
                        then extract(epoch from (now() - master.last_synced_at))::int end,
    'last_run_status', (select status from last_run),
    'last_run_at', (select finished_at from last_run),
    'last_run_rows', (select written_count from last_run),
    'last_run_error', (select error_message from last_run)
  ) from master;
$$;

-- ---------------------------------------------------------------------------
-- 11. Snapshot papan
-- ---------------------------------------------------------------------------
create or replace function inbound_board_snapshot(
  p_site_code text default null,
  p_days_back integer default 2
)
returns jsonb language sql stable as $$
  with bounds as (
    select
      greatest(least(coalesce(p_days_back, 2), 30), 0) as days_back,
      -- Hari operasional bergeser empat jam supaya shift malam yang lewat
      -- tengah malam tetap dihitung sebagai hari yang sama.
      (timezone('Asia/Jakarta', now()) - interval '4 hours')::date as today,
      nullif(upper(btrim(coalesce(p_site_code, ''))), '') as site
  ),
  scoped as (
    select b.* from inbound_board b, bounds x
     where (x.site is null or b.site_code = x.site)
       and (b.operational_date is null or b.operational_date::date >= x.today - x.days_back)
  ),
  payload as (
    select coalesce(jsonb_agg(to_jsonb(scoped) order by scoped.created_at desc), '[]'::jsonb) as rows,
           count(*)::int as row_count,
           max(scoped.row_updated_at) as max_updated_at
      from scoped
  ),
  sites as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'site_code', site_code, 'location_id', location_id, 'site_name', site_name,
             'short_name', short_name, 'gate_prefix', gate_prefix, 'gate_count', gate_count)
           order by sort_order), '[]'::jsonb) as rows
      from site_master where active
  ),
  gates as (
    select coalesce(jsonb_agg(gate_name order by site_code, gate_index), '[]'::jsonb) as rows
      from inbound_active_gates()
  ),
  checkers as (
    select coalesce(jsonb_agg(jsonb_build_object('checker_id', mp_id, 'checker_name', checker_name)
           order by checker_name), '[]'::jsonb) as rows
      from checker_master where active
  ),
  freshness as (select inbound_source_freshness((select site from bounds)) as payload)
  select jsonb_build_object(
    'operational_date', (select today::text from bounds),
    'site_code', (select site from bounds),
    'server_time', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'rows', payload.rows,
    'sites', sites.rows,
    'gates', gates.rows,
    'checkers', checkers.rows,
    'source', freshness.payload,
    -- Kesegaran sumber ikut di fingerprint. Tanpa itu, sync Superset baru tidak
    -- mengubah ETag selama tidak ada tiket berubah, dan indikator layar membeku.
    'fingerprint', md5(
      payload.row_count::text || '|' ||
      coalesce(payload.max_updated_at::text, '-') || '|' ||
      coalesce(freshness.payload->>'last_synced_at', '-'))
  ) from payload, sites, gates, checkers, freshness;
$$;

-- ---------------------------------------------------------------------------
-- 12. Riwayat
-- ---------------------------------------------------------------------------
create or replace function inbound_history(
  p_site_code text default null,
  p_from date default null,
  p_to date default null
)
returns jsonb language sql stable as $$
  with bounds as (
    select nullif(upper(btrim(coalesce(p_site_code, ''))), '') as site,
           coalesce(p_from, (timezone('Asia/Jakarta', now()) - interval '7 days')::date) as from_date,
           coalesce(p_to, (timezone('Asia/Jakarta', now()))::date) as to_date
  )
  select jsonb_build_object(
    'from', (select from_date::text from bounds),
    'to', (select to_date::text from bounds),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.created_at desc)
        from inbound_board b, bounds x
       where (x.site is null or b.site_code = x.site)
         and b.operational_date::date between x.from_date and x.to_date
       limit 5000), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- 13. Master PO untuk layar pendaftaran
-- ---------------------------------------------------------------------------
create or replace function inbound_po_master_fingerprint(p_site_code text default null)
returns text language sql stable as $$
  select md5(count(*)::text || '|' || coalesce(max(m.synced_at)::text, '-'))
    from superset_po_master m
    join site_master s on s.location_id = m.location_id and s.active
   where p_site_code is null or s.site_code = upper(btrim(p_site_code));
$$;

create or replace function inbound_po_master(p_site_code text default null)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total', count(*),
    'fingerprint', inbound_po_master_fingerprint(p_site_code),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'po_number', m.po_number, 'vendor_name', m.vendor_name,
      'request_quantity', m.request_quantity, 'count_sku', m.count_sku,
      'po_status', m.po_status) order by m.po_number), '[]'::jsonb))
    from superset_po_master m
    join site_master s on s.location_id = m.location_id and s.active
   where p_site_code is null or s.site_code = upper(btrim(p_site_code));
$$;

-- ---------------------------------------------------------------------------
-- 14. Kesehatan
-- ---------------------------------------------------------------------------
create or replace function inbound_health()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'backend', 'postgres',
    'checked_at', now(),
    'tickets', (select count(*) from tickets),
    'active_sites', (select coalesce(jsonb_agg(site_code order by sort_order), '[]'::jsonb)
                       from site_master where active),
    'po_master_rows', (select count(*) from superset_po_master),
    'last_superset_sync', (select max(synced_at) from superset_po_master));
$$;

-- ---------------------------------------------------------------------------
-- 15. Membuat tiket
-- ---------------------------------------------------------------------------
create or replace function inbound_create_tickets_bulk(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  v_items jsonb := coalesce(p_payload->'tickets', '[]'::jsonb);
  v_item jsonb; v_ticket jsonb; v_po jsonb;
  v_ticket_id text; v_ticket_type text; v_slot text; v_queue_no text;
  v_default_site text := coalesce(nullif(btrim(p_payload->>'site_code'), ''),
    (select site_code from site_master where active order by sort_order limit 1));
  v_site text; v_arrived timestamptz;
  v_operational_date date := (timezone('Asia/Jakarta', now()) - interval '4 hours')::date;
  v_seq integer; v_created jsonb := '[]'::jsonb; v_po_id text;
begin
  if jsonb_array_length(v_items) < 1 then raise exception 'Minimal satu ticket wajib diisi.'; end if;
  if jsonb_array_length(v_items) > 50 then raise exception 'Maksimal 50 ticket per submit.'; end if;
  if v_default_site is null then raise exception 'Belum ada gudang aktif di site_master.'; end if;

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_ticket := coalesce(v_item->'ticket', v_item);
    v_site := upper(coalesce(nullif(btrim(v_ticket->>'site_code'), ''), v_default_site));
    if not exists(select 1 from site_master where site_code = v_site and active) then
      raise exception 'Gudang % tidak aktif.', v_site;
    end if;

    v_ticket_id := coalesce(nullif(btrim(v_ticket->>'ticket_id'), ''), gen_random_uuid()::text);
    if jsonb_array_length(coalesce(v_item->'pos', '[]'::jsonb)) < 1 then
      raise exception 'Minimal satu PO wajib diisi.';
    end if;

    -- Kedatangan di masa depan hampir selalu salah ketik, dan bila lolos ia
    -- membuat waktu tunggu driver menjadi negatif.
    v_arrived := coalesce(nullif(btrim(v_ticket->>'arrived_at'), '')::timestamptz, now());
    if v_arrived > now() + interval '5 minutes' then
      raise exception 'Jam kedatangan tidak boleh melewati waktu sekarang.';
    end if;

    v_ticket_type := upper(regexp_replace(coalesce(nullif(btrim(v_ticket->>'ticket_type'), ''), 'REG'), '\s+', '-', 'g'));
    if v_ticket_type = 'DROP' then v_ticket_type := 'DROP-OFF'; end if;
    v_slot := coalesce(nullif(btrim(v_ticket->>'slot'), ''), '3');

    -- Lock per (gudang, hari, tipe, slot) supaya dua pendaftaran bersamaan
    -- tidak pernah menghasilkan nomor antrean kembar.
    perform pg_advisory_xact_lock(hashtext(v_site || '|' || v_operational_date::text || '|' || v_ticket_type || '|' || v_slot));
    select coalesce(max((regexp_match(queue_no, '(\d+)\s*$'))[1]::integer), 0) + 1 into v_seq
      from tickets where operational_date = v_operational_date
       and site_code = v_site and ticket_type = v_ticket_type and slot = v_slot;
    v_queue_no := v_ticket_type || ' ' || v_slot || '-' || v_seq;

    insert into tickets(ticket_id, queue_no, ticket_type, status, vendor_name, site_code,
      fleet_type, plat_number, driver_name, driver_phone, gate, slot, operational_date,
      registered_by, ktp_6_digit, unload_sla, source, arrived_at)
    values(v_ticket_id, v_queue_no, v_ticket_type,
      coalesce(nullif(btrim(v_ticket->>'status'), ''), 'WAITING'),
      nullif(btrim(v_ticket->>'vendor_name'), ''), v_site,
      nullif(btrim(v_ticket->>'fleet_type'), ''), nullif(btrim(v_ticket->>'plat_number'), ''),
      nullif(btrim(v_ticket->>'driver_name'), ''), nullif(btrim(v_ticket->>'driver_phone'), ''),
      nullif(btrim(v_ticket->>'gate'), ''), v_slot, v_operational_date,
      nullif(btrim(v_ticket->>'registered_by'), ''), nullif(btrim(v_ticket->>'ktp_6_digit'), ''),
      coalesce(nullif(btrim(v_ticket->>'unload_sla'), ''), 'ON PROCESS'),
      coalesce(nullif(btrim(v_ticket->>'source'), ''), 'App'), v_arrived);

    for v_po in select value from jsonb_array_elements(v_item->'pos')
    loop
      if nullif(btrim(v_po->>'po_number'), '') is null then raise exception 'po_number wajib diisi.'; end if;
      if coalesce((v_po->>'is_manual')::boolean, false) = false and not exists(
        select 1 from superset_po_master m
          join site_master s on s.location_id = m.location_id and s.active
         where m.po_number = btrim(v_po->>'po_number')) then
        raise exception 'PO % tidak ditemukan di master gudang aktif. Pilih opsi PO manual.', btrim(v_po->>'po_number');
      end if;
      v_po_id := coalesce(nullif(btrim(v_po->>'ticket_po_id'), ''), gen_random_uuid()::text);
      insert into ticket_pos(ticket_po_id, ticket_id, po_number, vendor_name,
        request_quantity, actual_quantity, count_sku, checker_status)
      values(v_po_id, v_ticket_id, btrim(v_po->>'po_number'),
        coalesce(nullif(btrim(v_po->>'vendor_name'), ''), nullif(btrim(v_ticket->>'vendor_name'), '')),
        coalesce((v_po->>'request_quantity')::double precision, 0),
        coalesce((v_po->>'actual_quantity')::double precision, 0),
        coalesce((v_po->>'count_sku')::integer, 0),
        coalesce(nullif(btrim(v_po->>'checker_status'), ''), 'PENDING'));
    end loop;

    perform inbound_requeue_gsheet(array[v_ticket_id]);
    insert into ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
      values(v_ticket_id, 'SECURITY_REGISTERED', p_actor->>'role', p_actor->>'name',
        jsonb_build_object('queue_no', v_queue_no, 'site_code', v_site, 'arrived_at', v_arrived));
    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'ticket_id', v_ticket_id, 'queue_no', v_queue_no, 'site_code', v_site,
      'arrived_at', v_arrived, 'operational_date', v_operational_date::text));
  end loop;
  return jsonb_build_object('created', v_created, 'inserted_tickets', jsonb_array_length(v_created));
end; $$;

-- ---------------------------------------------------------------------------
-- 16. Aksi tiket
-- ---------------------------------------------------------------------------
create or replace function inbound_set_arrival(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  v_id text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_at timestamptz; v_row tickets;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;
  v_at := coalesce(nullif(btrim(p_payload->>'arrived_at'), '')::timestamptz, now());
  if v_at > now() + interval '5 minutes' then
    raise exception 'Jam kedatangan tidak boleh melewati waktu sekarang.';
  end if;

  update tickets set arrived_at = v_at where ticket_id = v_id returning * into v_row;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;

  insert into ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'ARRIVAL_RECORDED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('arrived_at', v_at));
  perform inbound_requeue_gsheet(array[v_id]);
  return to_jsonb(v_row);
end; $$;

create or replace function inbound_call_ticket(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  v_id text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_gate text := nullif(btrim(p_payload->>'gate'), '');
  v_row tickets;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;
  if v_gate is null then raise exception 'Gate wajib ditentukan saat memanggil driver.'; end if;

  select * into v_row from tickets where ticket_id = v_id;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if upper(coalesce(v_row.status, '')) in ('COMPLETED', 'EXPIRED') then
    raise exception 'Ticket sudah % dan tidak dapat dipanggil.', upper(v_row.status);
  end if;

  update tickets set
    status = case when upper(status) = 'UNLOADING' then status else 'CALLED' end,
    gate = v_gate,
    -- Panggilan ulang hanya menaikkan pencacah; menggeser called_at akan
    -- menghapus jejak berapa lama driver sebenarnya sudah ditunggu.
    called_at = coalesce(called_at, now()),
    last_call_at = now(),
    call_count = call_count + 1,
    arrived_at = coalesce(arrived_at, now())
  where ticket_id = v_id returning * into v_row;

  insert into ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'DRIVER_CALLED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('gate', v_gate, 'call_count', v_row.call_count));
  perform inbound_requeue_gsheet(array[v_id]);
  return to_jsonb(v_row);
end; $$;

create or replace function inbound_start_unloading(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  v_id text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_gate text := nullif(btrim(p_payload->>'gate'), '');
  v_started timestamptz := now();
  v_ticket tickets; v_pos integer;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;

  select * into v_ticket from tickets where ticket_id = v_id;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if upper(coalesce(v_ticket.status, '')) in ('COMPLETED', 'EXPIRED') then
    raise exception 'Ticket sudah % dan tidak dapat dimulai ulang.', upper(v_ticket.status);
  end if;

  -- Idempoten: menekan dua kali tidak menggeser jam mulai, karena itu akan
  -- memperpanjang SLA secara diam-diam.
  v_started := coalesce(v_ticket.start_unloading_at, v_started);

  update tickets set
    status = 'UNLOADING',
    gate = coalesce(v_gate, gate),
    arrived_at = coalesce(arrived_at, v_started),
    called_at = coalesce(called_at, v_started),
    start_unloading_at = v_started
  where ticket_id = v_id;

  update ticket_pos set
    checker_status = 'CHECKING',
    checking_started_at = coalesce(checking_started_at, v_started)
  where ticket_id = v_id and upper(coalesce(checker_status, 'PENDING')) = 'PENDING';
  get diagnostics v_pos = row_count;

  insert into ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'UNLOADING_STARTED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('gate', v_gate, 'started_at', v_started, 'po_started', v_pos));
  perform inbound_requeue_gsheet(array[v_id]);

  return jsonb_build_object('ticket_id', v_id, 'started_at', v_started, 'po_started', v_pos);
end; $$;

create or replace function inbound_finish_unloading(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  v_id text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_finished timestamptz := now(); v_row tickets;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;

  select * into v_row from tickets where ticket_id = v_id;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if v_row.start_unloading_at is null then
    raise exception 'Bongkar belum pernah dimulai untuk ticket ini.';
  end if;

  -- Idempoten seperti mulai bongkar: jam selesai yang bergeser akan mengubah
  -- hasil penilaian SLA yang sudah tercatat.
  v_finished := coalesce(v_row.done_unloading_at, v_finished);

  update tickets set status = 'COMPLETED', done_unloading_at = v_finished
   where ticket_id = v_id returning * into v_row;

  update ticket_pos set
    checker_status = 'DONE', checking_done_at = coalesce(checking_done_at, v_finished),
    gr_status = 'DONE GR', gr_done_at = coalesce(gr_done_at, v_finished)
  where ticket_id = v_id and upper(coalesce(gr_status, '')) <> 'DONE GR';

  insert into ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'UNLOADING_FINISHED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('finished_at', v_finished));
  perform inbound_requeue_gsheet(array[v_id]);
  return to_jsonb(v_row);
end; $$;

create or replace function inbound_cancel_ticket(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  v_id text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_reason text := coalesce(nullif(btrim(p_payload->>'reason'), ''), 'Dibatalkan operator');
  v_row tickets;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;
  update tickets set status = 'EXPIRED', expired_at = coalesce(expired_at, now()), expired_reason = v_reason
   where ticket_id = v_id and upper(coalesce(status, '')) <> 'COMPLETED'
  returning * into v_row;
  if not found then raise exception 'Ticket tidak ditemukan atau sudah selesai.'; end if;

  insert into ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'TICKET_CANCELLED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('reason', v_reason));
  perform inbound_requeue_gsheet(array[v_id]);
  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- 17. Pemeliharaan
-- ---------------------------------------------------------------------------
create or replace function inbound_delete_tickets_by_date(p_operational_date date)
returns jsonb language plpgsql as $$
declare v_count integer;
begin
  delete from tickets where operational_date = p_operational_date;
  get diagnostics v_count = row_count;
  return jsonb_build_object('deleted', v_count, 'operational_date', p_operational_date);
end; $$;

create or replace function inbound_delete_single_ticket(p_payload jsonb)
returns jsonb language plpgsql as $$
declare v_id text := btrim(coalesce(p_payload->>'ticket_id', '')); v_count integer;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;
  delete from tickets where ticket_id = v_id;
  get diagnostics v_count = row_count;
  return jsonb_build_object('deleted', v_count, 'ticket_id', v_id);
end; $$;
