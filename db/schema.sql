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
-- 3b. Hari operasional wajib ada
--
-- Kolom ini menjadi tulang punggung setiap kueri papan dan laporan, dan sejak
-- awal ia boleh kosong. Akibatnya setiap penyaringan tanggal harus ditulis
-- sebagai `operational_date is null or operational_date >= …` — dan sebuah OR
-- di situ berarti Postgres membangun BitmapOr alih-alih pemindaian index
-- tunggal, pada kueri yang dijalankan tiap lima belas detik.
--
-- Baris kosong itu sendiri sebenarnya cacat data, bukan keadaan yang sah:
-- inbound_create_tickets_bulk() SELALU mengisinya. Jadi nilainya diisi ulang
-- dari created_at, lalu kolomnya dijadikan wajib supaya kekosongan itu tidak
-- dapat kembali.
-- ---------------------------------------------------------------------------
update tickets
   set operational_date = (timezone('Asia/Jakarta', created_at) - interval '4 hours')::date
 where operational_date is null;

alter table tickets
  alter column operational_date set default (timezone('Asia/Jakarta', now()) - interval '4 hours')::date;

do $$
begin
  alter table tickets alter column operational_date set not null;
exception
  -- Bila masih ada baris kosong yang tidak terjangkau backfill di atas, skema
  -- tetap harus dapat diterapkan: kontainer yang menolak start karena satu
  -- baris cacat jauh lebih buruk daripada satu kueri yang sedikit lebih lambat.
  when others then raise notice 'operational_date belum dapat dijadikan wajib: %', sqlerrm;
end $$;

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

-- superset_po_master di-join ke site_master lewat location_id, BUKAN site_code:
-- itulah kolom yang benar-benar dikirim Superset. Tanpa index ini, setiap
-- snapshot papan — jadi tiap lima belas detik, tiap tablet — memindai seluruh
-- master PO hanya untuk melaporkan umur sinkronisasinya di pojok layar.
create index if not exists superset_po_location_idx on superset_po_master(location_id);

-- Halaman Pengaturan dan snapshot papan sama-sama meminta baris sync terakhir.
-- Tanpa index ini, `order by started_at desc limit 1` memindai seluruh riwayat
-- sync, yang bertambah dua belas baris tiap jam selamanya.
create index if not exists sync_runs_recent_idx on sync_runs(sync_name, started_at desc);

-- Gate yang sedang terpakai dicari per gudang untuk mencegah dua truk
-- diarahkan ke dock yang sama.
create index if not exists tickets_gate_busy_idx
  on tickets(site_code, gate) where status = 'UNLOADING';

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
--
-- PENTING — kedua fungsi di bawah sengaja ditulis TANPA klausa `from`.
--
-- Bentuk `... from (select upper(regexp_replace(...)) as v) x` jauh lebih enak
-- dibaca: normalisasinya ditulis sekali, lalu dipakai dua belas kali. Sayangnya
-- klausa `from` itulah yang membuat Postgres MENOLAK menyisipkan fungsi ini ke
-- dalam kueri pemanggilnya. Syarat inlining fungsi SQL menuntut badan berupa
-- satu SELECT tanpa FROM; begitu ada FROM, setiap pemanggilan menjadi
-- pemanggilan fungsi sungguhan lengkap dengan penyiapan rencana tersendiri.
--
-- Papan memanggilnya sekali per tiket, dan `inbound_sla_target_hours`
-- memanggilnya lagi. Pada dua puluh ribu tiket, biaya itu terukur sebagai 25
-- DETIK untuk satu snapshot papan — pada kueri yang diminta ulang tiap lima
-- belas detik. Setelah keduanya dapat disisipkan, angka yang sama menjadi
-- sekitar 50 milidetik.
--
-- Harganya: `upper(btrim(...))` ditulis ulang di setiap cabang. Itu berjalan
-- pada string sepanjang belasan karakter dan berhenti pada cabang pertama yang
-- cocok — pertukaran yang sangat menguntungkan.
--
-- `regexp_replace` untuk merapatkan spasi hanya tersisa di cabang terakhir,
-- tempat ia tidak lagi berada di jalur panas. Pola '%RODA%2%' menggantikan
-- perannya bagi satu-satunya nilai yang benar-benar memuat spasi.
create or replace function inbound_fleet_canonical(p_fleet text)
returns text language sql immutable as $$
  select case
    when upper(btrim(coalesce(p_fleet, ''))) like '%TRONTON%'
      or upper(btrim(coalesce(p_fleet, ''))) like '%FUSO%'      then 'TRONTON/FUSO'
    when upper(btrim(coalesce(p_fleet, ''))) like '%WING%'      then 'WING BOX'
    when upper(btrim(coalesce(p_fleet, ''))) like '%CDDL%'      then 'CDDL'
    when upper(btrim(coalesce(p_fleet, ''))) like '%CDEL%'      then 'CDEL'
    when upper(btrim(coalesce(p_fleet, ''))) like '%CDD%'       then 'CDD'
    when upper(btrim(coalesce(p_fleet, ''))) like '%CDE%'       then 'CDE'
    when upper(btrim(coalesce(p_fleet, ''))) like '%DROP%'      then 'DROP-OFF'
    when upper(btrim(coalesce(p_fleet, ''))) like '%RODA%2%'
      or upper(btrim(coalesce(p_fleet, ''))) like '%MOTOR%'     then 'RODA 2'
    when upper(btrim(coalesce(p_fleet, ''))) like '%L300%'      then 'L300 BOX'
    when upper(btrim(coalesce(p_fleet, ''))) like '%PICK%'      then 'PICKUP'
    when upper(btrim(coalesce(p_fleet, ''))) like '%GRANDMAX%'
      or upper(btrim(coalesce(p_fleet, ''))) like '%MOBIL%'     then 'MOBIL'
    when upper(btrim(coalesce(p_fleet, ''))) like '%VAN%'       then 'VAN'
    else upper(regexp_replace(btrim(coalesce(p_fleet, '')), '\s+', ' ', 'g'))
  end;
$$;

/**
 * Target SLA bongkar dalam jam. CDDL mengikuti CDD, CDEL mengikuti CDE.
 * SKU tepat 40 masih masuk tier 2 jam — batasnya "lebih dari 40".
 * Mengembalikan 0 untuk armada tanpa SLA.
 */
create or replace function inbound_sla_target_hours(p_fleet text, p_sku integer)
returns integer language sql immutable as $$
  select case
    when inbound_fleet_canonical(p_fleet) in ('TRONTON/FUSO', 'WING BOX')           then 4
    when inbound_fleet_canonical(p_fleet) in ('CDD', 'CDDL', 'CDE', 'CDEL')
      then case when coalesce(p_sku, 0) > 40 then 4 else 2 end
    when inbound_fleet_canonical(p_fleet) in ('VAN', 'PICKUP', 'MOBIL', 'L300 BOX') then 2
    when inbound_fleet_canonical(p_fleet) = 'RODA 2'                                then 1
    when inbound_fleet_canonical(p_fleet) = 'DROP-OFF'                              then 23
    else 0
  end;
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
--
-- PENTING — agregasi PO memakai LATERAL, bukan CTE.
--
-- Bentuk sebelumnya adalah `with po_rollup as (select ... from ticket_pos group
-- by ticket_id)` lalu di-join. Bacanya rapi, tetapi artinya: setiap kali view
-- ini disentuh, Postgres mengagregasi SELURUH tabel ticket_pos lebih dulu —
-- tidak peduli bahwa pemanggilnya hanya meminta lima puluh tiket dari dua hari
-- terakhir. Predikat gudang dan tanggal mustahil didorong masuk ke dalam CTE
-- itu karena hasilnya tidak membawa kolom site_code maupun operational_date.
--
-- Papan antrean meminta snapshot ini setiap lima belas detik, dari setiap
-- tablet yang menyala. Agregasi penuh atas seluruh riwayat PO, berkali-kali per
-- menit, adalah beban yang tumbuh terus sepanjang umur gudang.
--
-- LATERAL membalik urutannya: baris tiket dipilih lebih dulu, lalu PO-nya
-- dicari per tiket lewat ticket_pos_ticket_idx. Lima puluh tiket berarti lima
-- puluh pencarian index, bukan satu pemindaian tabel penuh.
--
-- `operational_date` juga sengaja TIDAK lagi di-cast ke text di sini. Cast itu
-- membuat setiap penyaringan tanggal di atas view berjalan pada ekspresi, bukan
-- pada kolom, sehingga tickets_board_idx tidak pernah terpakai. JSON yang
-- dihasilkan tetap sama persis: to_jsonb(date) menghasilkan "YYYY-MM-DD".
create or replace view inbound_board as
select
  t.ticket_id, t.queue_no, t.ticket_type, t.status, t.site_code,
  t.vendor_name, t.fleet_type, t.plat_number, t.driver_name, t.driver_phone,
  t.gate, t.slot, t.operational_date,
  t.registered_by, t.source,
  t.arrived_at, t.called_at, t.call_count,
  t.start_unloading_at, t.done_unloading_at,
  t.expired_at, t.expired_reason,
  t.created_at, t.updated_at,

  coalesce(p.po_numbers, '') as po_numbers,
  coalesce(p.po_count, 0)    as po_count,
  coalesce(p.total_qty, 0)   as total_qty,
  coalesce(p.total_sku, 0)   as total_sku,

  -- Target SLA dihitung SEKALI per baris, lalu dipakai ulang.
  --
  -- Bentuk sebelumnya memanggil inbound_sla_target_hours() tiga kali untuk
  -- setiap tiket — sekali di sini dan dua kali lagi di dalam CASE di bawah.
  -- Fungsi itu memanggil inbound_fleet_canonical(), yang menjalankan
  -- regexp_replace dan dua belas pola LIKE. Tiga kali lipat pekerjaan regex per
  -- tiket, pada setiap siklus polling, untuk menghasilkan angka yang sama persis
  -- ketiga kalinya.
  sla.target_hours as sla_target_hours,

  case
    when sla.target_hours > 0 and t.start_unloading_at is not null
    then t.start_unloading_at + make_interval(hours => sla.target_hours)
  end as sla_deadline_at,

  t.start_unloading_at as sla_started_at,

  coalesce(
    case when p.all_done_gr then p.last_gr_done_at end,
    t.done_unloading_at,
    t.expired_at
  ) as sla_stopped_at,

  greatest(t.updated_at, coalesce(p.po_updated_at, t.updated_at)) as row_updated_at
from tickets t
left join lateral (
  select
    string_agg(po_number, ', ' order by created_at, ticket_po_id) as po_numbers,
    count(*)::int                                                 as po_count,
    coalesce(sum(request_quantity), 0)                            as total_qty,
    coalesce(sum(count_sku), 0)::int                              as total_sku,
    max(gr_done_at)                                               as last_gr_done_at,
    count(*) filter (where upper(coalesce(gr_status, '')) = 'DONE GR') = count(*) as all_done_gr,
    max(updated_at)                                               as po_updated_at
  from ticket_pos
  where ticket_pos.ticket_id = t.ticket_id
) p on true
cross join lateral (
  select inbound_sla_target_hours(t.fleet_type, coalesce(p.total_sku, 0)) as target_hours
) sla;

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
  -- Dirujuk empat kali di bawah sebagai subquery skalar; tanpa `materialized`
  -- setiap rujukan menjalankan kueri ini lagi.
  last_run as materialized (
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
-- 10b. Cakupan gudang
--
-- Mengubah "gudang ini, atau semua gudang" menjadi SEBUAH DAFTAR.
--
-- Bentuk yang wajar ditulis untuk itu adalah `p_site_code is null or site_code =
-- p_site_code`, dan di dalam fungsi SQL bentuk itu adalah jebakan. `p_site_code`
-- adalah parameter, bukan konstanta, jadi Postgres menyusun rencana generik yang
-- tidak dapat melipat cabang `is null` — dan predikat berbentuk OR semacam itu
-- tidak dapat dipakai sebagai kondisi index. Rencananya jatuh ke pemindaian
-- SELURUH tabel tiket, lalu satu pencarian ticket_pos untuk masing-masing.
--
-- Terukur pada dua puluh ribu tiket: 157 milidetik per snapshot, tiap lima belas
-- detik, tiap tablet. Dengan `site_code = any(daftar)` predikat kembali menjadi
-- ScalarArrayOp yang dapat memakai index: 0,04 milidetik. Empat ribu kali lebih
-- cepat, dan selisihnya tumbuh seiring bertambahnya riwayat.
-- ---------------------------------------------------------------------------
create or replace function inbound_scoped_sites(p_site_code text default null)
returns text[] language sql stable as $$
  select case
    when nullif(upper(btrim(coalesce(p_site_code, ''))), '') is null
      then (select array_agg(site_code) from site_master)
    else array[upper(btrim(p_site_code))]
  end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Snapshot papan
-- ---------------------------------------------------------------------------
create or replace function inbound_board_snapshot(
  p_site_code text default null,
  p_days_back integer default 2
)
returns jsonb language sql stable as $$
  -- PENTING — batas gudang dan tanggal ditulis LANGSUNG di predikat.
  --
  -- Sebelumnya keduanya datang dari sebuah CTE `bounds`, dan itu bukan sekadar
  -- soal gaya. CTE yang dirujuk beberapa kali dimaterialisasi Postgres, jadi
  -- `x.site` dan `x.today` menjadi nilai yang baru diketahui saat eksekusi —
  -- terlalu terlambat untuk dipakai sebagai kondisi index. Rencananya berubah
  -- menjadi `Seq Scan on tickets` yang membaca SELURUH tabel tiket, menyaring
  -- dua ratus baris darinya, dan mengulanginya tiap lima belas detik untuk
  -- setiap tablet yang menyala. Ditulis langsung seperti ini, keduanya menjadi
  -- konstanta pada waktu perencanaan dan tickets_board_idx terpakai.
  with scoped as (
    select b.*
      from inbound_board b
     where b.site_code = any(inbound_scoped_sites(p_site_code))
       -- Hari operasional bergeser empat jam supaya shift malam yang lewat
       -- tengah malam tetap dihitung sebagai hari yang sama.
       and b.operational_date >= (timezone('Asia/Jakarta', now()) - interval '4 hours')::date
                                 - greatest(least(coalesce(p_days_back, 2), 30), 0)
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
  -- `materialized` di sini menghemat lebih banyak daripada yang terlihat.
  --
  -- Tanpanya, Postgres menyisipkan pemanggilan fungsi ini ke dalam kueri luar,
  -- lalu mengevaluasinya ulang untuk SETIAP rujukan — dan payload-nya dirujuk
  -- dua kali di sini serta berkali-kali lagi setelah disisipkan. Terukur: satu
  -- snapshot memanggilnya sekitar dua puluh tujuh kali, masing-masing menghitung
  -- ulang tiga puluh ribu baris master PO. Itulah 220 dari 227 milidetik yang
  -- dihabiskan satu siklus polling.
  freshness as materialized (
    select inbound_source_freshness(nullif(upper(btrim(coalesce(p_site_code, ''))), '')) as payload
  )
  select jsonb_build_object(
    'operational_date', ((timezone('Asia/Jakarta', now()) - interval '4 hours')::date)::text,
    'site_code', nullif(upper(btrim(coalesce(p_site_code, ''))), ''),
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
  -- Batas baris HARUS berada di dalam subquery.
  --
  -- Bentuk sebelumnya menaruh `limit 5000` di samping jsonb_agg, dan agregat
  -- selalu menciut menjadi satu baris — jadi yang dibatasi adalah satu baris
  -- hasil itu, bukan lima ribu tiket yang diagregasi ke dalamnya. Batasnya
  -- tidak pernah berlaku sama sekali: rentang sebulan mengirim seluruh isinya
  -- sebagai satu JSON raksasa, dan browser yang menerimanya membeku.
  , capped as (
    select b.*
      from inbound_board b, bounds x
     where b.site_code = any(inbound_scoped_sites(p_site_code))
       and b.operational_date between x.from_date and x.to_date
     order by b.created_at desc
     limit 5000
  )
  select jsonb_build_object(
    'from', (select from_date::text from bounds),
    'to', (select to_date::text from bounds),
    'truncated', (select count(*) from capped) >= 5000,
    'rows', coalesce((select jsonb_agg(to_jsonb(capped) order by capped.created_at desc) from capped), '[]'::jsonb));
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

/**
 * Menolak gate yang sedang dipakai tiket lain yang masih bongkar.
 *
 * Papan antrean sudah menampilkan gate terpakai sebagai opsi yang tidak dapat
 * dipilih, tetapi itu hanya berlaku bagi layar yang datanya mutakhir. Dua
 * supervisor yang menekan "Mulai bongkar" dalam selang beberapa detik sama-sama
 * melihat dock yang sama masih kosong — dan dua truk diarahkan ke tempat yang
 * sama, di gudang beku, dengan pintu yang harus tetap tertutup.
 *
 * Pemeriksaannya karena itu harus di sini, tempat kedua permintaan bertemu.
 */
create or replace function inbound_assert_gate_free(p_ticket_id text, p_gate text, p_site text)
returns void language plpgsql as $$
declare v_holder text;
begin
  if p_gate is null then return; end if;

  select queue_no into v_holder
    from tickets
   where gate = p_gate
     and ticket_id <> p_ticket_id
     and upper(coalesce(status, '')) = 'UNLOADING'
     and (p_site is null or site_code = p_site)
   limit 1;

  if v_holder is not null then
    raise exception 'Gate % sedang dipakai tiket %.', p_gate, v_holder;
  end if;
end; $$;

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

  select * into v_row from tickets where ticket_id = v_id;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;

  -- Kedatangan tidak boleh terjadi SETELAH bongkar dimulai. Koreksi semacam itu
  -- membuat lama tunggu driver menjadi negatif, dan laporan pagi berikutnya
  -- melaporkan angka yang mustahil tanpa petunjuk dari mana asalnya.
  if v_row.start_unloading_at is not null and v_at > v_row.start_unloading_at then
    raise exception 'Jam kedatangan tidak boleh setelah bongkar dimulai (%).',
      to_char(v_row.start_unloading_at at time zone 'Asia/Jakarta', 'HH24:MI');
  end if;

  update tickets set arrived_at = v_at where ticket_id = v_id returning * into v_row;

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

  -- Baris dikunci sampai transaksi selesai. Tanpa kunci ini, dua panggilan
  -- bersamaan sama-sama lolos pemeriksaan gate sebelum salah satunya menulis.
  select * into v_row from tickets where ticket_id = v_id for update;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if upper(coalesce(v_row.status, '')) in ('COMPLETED', 'EXPIRED') then
    raise exception 'Ticket sudah % dan tidak dapat dipanggil.', upper(v_row.status);
  end if;
  perform inbound_assert_gate_free(v_id, v_gate, v_row.site_code);

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

  select * into v_ticket from tickets where ticket_id = v_id for update;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if upper(coalesce(v_ticket.status, '')) in ('COMPLETED', 'EXPIRED') then
    raise exception 'Ticket sudah % dan tidak dapat dimulai ulang.', upper(v_ticket.status);
  end if;

  -- Gate wajib ada sebelum SLA mulai berdetak: tanpa itu papan tidak dapat
  -- menunjukkan dock mana yang terpakai, dan pemeriksaan tabrakan di bawah ini
  -- tidak punya apa pun untuk diperiksa.
  if coalesce(v_gate, v_ticket.gate) is null then
    raise exception 'Gate wajib ditentukan sebelum bongkar dimulai.';
  end if;
  perform inbound_assert_gate_free(v_id, coalesce(v_gate, v_ticket.gate), v_ticket.site_code);

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
/**
 * Menghapus tiket satu hari operasional.
 *
 * Cakupan gudang WAJIB diberikan bila ada lebih dari satu gudang aktif.
 * Sebelumnya fungsi ini menghapus tiket seluruh gudang untuk tanggal itu,
 * padahal pemanggilnya selalu sedang melihat satu gudang saja — admin yang
 * membersihkan data uji coba di Srengseng ikut menghapus hari kerja Pegangsaan,
 * tanpa satu pun konfirmasi yang menyebutkan hal itu.
 */
create or replace function inbound_delete_tickets_by_date(
  p_operational_date date,
  p_site_code text default null
)
returns jsonb language plpgsql as $$
declare
  v_count integer;
  v_site text := nullif(upper(btrim(coalesce(p_site_code, ''))), '');
  v_active integer;
begin
  if p_operational_date is null then raise exception 'Tanggal operasional wajib diisi.'; end if;

  select count(*) into v_active from site_master where active;
  if v_site is null and v_active > 1 then
    raise exception 'Kode gudang wajib diisi saat lebih dari satu gudang aktif.';
  end if;

  delete from tickets
   where operational_date = p_operational_date
     and (v_site is null or site_code = v_site);
  get diagnostics v_count = row_count;
  return jsonb_build_object('deleted', v_count, 'operational_date', p_operational_date, 'site_code', v_site);
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

/**
 * Pemangkasan riwayat.
 *
 * Dua tabel di skema ini tumbuh selamanya dan tidak pernah dibaca setelah
 * beberapa hari: `sync_runs` bertambah dua belas baris tiap jam — sekitar
 * seratus ribu baris per tahun — dan hanya baris terakhirnya yang pernah
 * ditanyakan. `ticket_events` adalah jejak audit, jadi umurnya jauh lebih
 * panjang, tetapi tetap terbatas.
 *
 * Menjalankannya sebagai fungsi, bukan sebagai cron di dalam database,
 * mengikuti keputusan yang sama seperti sinkronisasi Superset: penjadwalnya ada
 * di proses Node, sehingga kegagalannya muncul di log yang sama dengan sisa
 * aplikasi alih-alih hanya sebagai baris di sebuah tabel.
 */
create or replace function inbound_prune_history(
  p_sync_run_days integer default 14,
  p_event_days integer default 180
)
returns jsonb language plpgsql as $$
declare v_runs integer; v_events integer;
begin
  delete from sync_runs where started_at < now() - make_interval(days => greatest(p_sync_run_days, 1));
  get diagnostics v_runs = row_count;

  delete from ticket_events where created_at < now() - make_interval(days => greatest(p_event_days, 30));
  get diagnostics v_events = row_count;

  return jsonb_build_object('sync_runs_deleted', v_runs, 'ticket_events_deleted', v_events);
end; $$;
