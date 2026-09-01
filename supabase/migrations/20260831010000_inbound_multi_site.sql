-- ============================================================================
-- ANTRIAN INBOUND FROZEN — MULTI SITE
--
-- Mengganti sumber data tunggal CBT (819) menjadi PGS (160) dan menyiapkan
-- SRG (796), BIT (983), CSI (998) tanpa perubahan skema lagi di kemudian hari.
--
-- Setelah migrasi ini:
--   * site_master menjadi sumber kebenaran daftar gudang di sisi server.
--   * superset_po_master hanya menyimpan PO milik gudang yang aktif.
--   * Nomor antrian dan nomor BA di-scope per gudang.
--   * Gate dibangkitkan otomatis dari prefix + jumlah dock per gudang.
--
-- Menambah gudang = `update public.site_master set active = true where site_code = 'SRG';`
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Master gudang
-- ---------------------------------------------------------------------------
create table if not exists public.site_master (
  site_code text primary key,
  location_id text unique not null,
  site_name text not null,
  short_name text,
  timezone text not null default 'Asia/Jakarta',
  gate_prefix text not null,
  gate_count integer not null default 0 check (gate_count >= 0 and gate_count <= 99),
  active boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists site_master_touch_updated_at on public.site_master;
create trigger site_master_touch_updated_at before update on public.site_master
for each row execute function public.touch_updated_at();

insert into public.site_master
  (site_code, location_id, site_name, short_name, gate_prefix, gate_count, active, sort_order)
values
  ('PGS', '160', 'Pegangsaan', 'Pegangsaan', 'PGS-GATE-INB-01', 9, true,  1),
  ('SRG', '796', 'Srengseng',  'Srengseng',  'SRG-GATE-INB-01', 6, false, 2),
  ('BIT', '983', 'Bitung',     'Bitung',     'BIT-GATE-INB-01', 6, false, 3),
  ('CSI', '998', 'Cileungsi',  'Cileungsi',  'CSI-GATE-INB-01', 6, false, 4)
on conflict (site_code) do update set
  location_id = excluded.location_id,
  site_name   = excluded.site_name,
  short_name  = excluded.short_name,
  gate_prefix = excluded.gate_prefix,
  sort_order  = excluded.sort_order,
  updated_at  = now();

create index if not exists site_master_active_idx on public.site_master(active, sort_order);

-- Daftar location_id gudang aktif. Dipakai sync-superset dan view publik.
create or replace function public.inbound_active_location_ids()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(location_id order by sort_order), array[]::text[])
  from public.site_master where active;
$$;

create or replace function public.inbound_site_of_location(p_location_id text)
returns text language sql stable security definer set search_path = public as $$
  select site_code from public.site_master where location_id = btrim(p_location_id);
$$;

-- Nama gate lengkap untuk seluruh gudang aktif, contoh PGS-GATE-INB-01-03.
create or replace function public.inbound_active_gates()
returns table (site_code text, gate_name text, gate_index integer)
language sql stable security definer set search_path = public as $$
  select s.site_code,
         s.gate_prefix || '-' || lpad(g::text, 2, '0') as gate_name,
         g as gate_index
  from public.site_master s
  cross join lateral generate_series(1, s.gate_count) as g
  where s.active
  order by s.sort_order, g;
$$;

-- ---------------------------------------------------------------------------
-- 2. Kolom site pada tabel operasional
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists site_code text not null default 'PGS'
  references public.site_master(site_code);

alter table public.superset_po_master add column if not exists site_code text;
alter table public.superset_po_stage  add column if not exists site_code text;
alter table public.ba_documents       add column if not exists site_code text;
alter table public.gates              add column if not exists site_code text;

-- Backfill data lama: petakan lewat location_id, sisanya jatuh ke gudang default.
update public.superset_po_master m
   set site_code = s.site_code
  from public.site_master s
 where m.site_code is distinct from s.site_code
   and m.location_id = s.location_id;

update public.ba_documents set site_code = 'PGS' where site_code is null;
update public.gates set site_code = coalesce(site_code, split_part(gate_name, '-', 1));

create index if not exists tickets_site_operational_idx
  on public.tickets(site_code, operational_date, ticket_type, slot);
create index if not exists tickets_site_status_idx
  on public.tickets(site_code, status, created_at desc);
-- Delta sync mengambil baris berdasarkan updated_at; tanpa index ini setiap
-- polling 10 detik memaksa sequential scan pada tabel tickets.
create index if not exists tickets_updated_idx on public.tickets(updated_at desc);
create index if not exists superset_po_site_idx on public.superset_po_master(site_code, po_number);
create index if not exists superset_po_location_idx on public.superset_po_master(location_id);
create index if not exists ba_documents_site_date_idx on public.ba_documents(site_code, ba_date desc);

-- ---------------------------------------------------------------------------
-- 3. View publik hanya menampilkan gudang aktif
-- ---------------------------------------------------------------------------
create or replace view public.superset_po_public
with (security_invoker = true) as
select m.po_number, m.vendor_name, '3'::text as slot,
  m.request_quantity as total_request_quantity,
  m.count_sku as "Count SKU", m.location_id, m.location_name,
  m.request_shipping_date, m.fulfillment_arrived_start_at, m.schedule_type, m.po_status,
  m.synced_at, s.site_code, s.site_name
from public.superset_po_master m
join public.site_master s on s.location_id = m.location_id
where s.active;

-- Kolom site_code sengaja ditaruh di akhir view supaya CREATE OR REPLACE VIEW
-- tetap sah (Postgres hanya mengizinkan penambahan kolom di posisi terakhir).
create or replace view public.inbound_operational_rows
with (security_invoker = true) as
select
  t.ticket_id, t.queue_no, t.ticket_type, t.status, t.vendor_name,
  t.fleet_type, t.plat_number, t.driver_name, t.driver_phone as phone_number,
  t.gate, t.slot, t.operational_date::text as operational_date,
  t.registered_by, t.ktp_6_digit, t.unload_sla, t.source,
  t.called_at, t.arrived_at, t.start_unloading_at,
  t.done_unloading_at as finish_unloading_at, t.expired_at, t.expired_reason,
  t.call_count, t.last_call_at, t.created_at as register_time,
  t.created_at, t.updated_at,
  p.ticket_po_id, p.po_number, p.vendor_name as po_vendor_name,
  p.request_quantity as total_po_qty, p.actual_quantity,
  p.count_sku as count_po_sku, p.checker_status, p.gr_status,
  p.checker_id, p.checker_name,
  p.checking_started_at as checker_started_at,
  p.checking_done_at as checker_done_at,
  p.gr_done_at as done_gr_at, p.handover_grn_at,
  p.created_at as po_created_at, p.updated_at as po_updated_at,
  greatest(t.updated_at, coalesce(p.updated_at, t.updated_at)) as row_updated_at,
  row_number() over (partition by t.ticket_id order by p.created_at, p.ticket_po_id) as po_sequence,
  count(p.ticket_po_id) over (partition by t.ticket_id) as ticket_po_count,
  coalesce(sum(p.request_quantity) over (partition by t.ticket_id), 0) as ticket_total_qty,
  coalesce(sum(p.count_sku) over (partition by t.ticket_id), 0) as ticket_total_sku,
  max(p.gr_done_at) over (partition by t.ticket_id) as ticket_done_gr_at,
  count(*) filter (where upper(coalesce(p.gr_status, '')) = 'DONE GR') over (partition by t.ticket_id)
    = count(*) over (partition by t.ticket_id) as ticket_all_done_gr,
  t.site_code
from public.tickets t
left join public.ticket_pos p on p.ticket_id = t.ticket_id;

create or replace view public.inbound_ticket_summaries
with (security_invoker = true) as
select t.ticket_id, t.queue_no, t.ticket_type, t.status, t.vendor_name,
  t.fleet_type, t.plat_number, t.driver_name, t.driver_phone, t.gate, t.slot,
  t.operational_date::text as operational_date, t.registered_by, t.called_at,
  t.arrived_at, t.start_unloading_at, t.done_unloading_at, t.expired_at,
  t.created_at, t.updated_at,
  coalesce(sum(p.request_quantity), 0) as request_quantity,
  coalesce(sum(p.actual_quantity), 0) as actual_quantity,
  count(p.ticket_po_id) as po_count,
  t.site_code
from public.tickets t left join public.ticket_pos p on p.ticket_id = t.ticket_id
group by t.ticket_id;

create or replace view public.ba_documents_summary
with (security_invoker = true) as
select d.ba_id, d.ba_number, d.ba_date::text as ba_date, d.day_name,
  d.po_number, d.supplier_name, d.note, d.created_by, d.created_role,
  d.created_at, count(i.ba_item_id)::integer as item_count,
  d.site_code
from public.ba_documents d left join public.ba_items i on i.ba_id = d.ba_id
group by d.ba_id;

-- ---------------------------------------------------------------------------
-- 4. Pembuatan ticket: nomor antrian di-scope per gudang
-- ---------------------------------------------------------------------------
create or replace function public.inbound_create_tickets_bulk(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_items jsonb := coalesce(p_payload->'tickets', '[]'::jsonb);
  v_item jsonb; v_ticket jsonb; v_po jsonb;
  v_ticket_id text; v_ticket_type text; v_slot text; v_queue_no text;
  v_default_site text := coalesce(nullif(btrim(p_payload->>'site_code'), ''),
    (select site_code from public.site_master where active order by sort_order limit 1));
  v_site text;
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
    if not exists(select 1 from public.site_master where site_code = v_site and active) then
      raise exception 'Gudang % tidak aktif. Aktifkan dahulu di site_master.', v_site;
    end if;
    v_ticket_id := coalesce(nullif(btrim(v_ticket->>'ticket_id'), ''), gen_random_uuid()::text);
    if exists(select 1 from public.tickets where ticket_id = v_ticket_id) then
      raise exception 'ticket_id duplikat: %', v_ticket_id;
    end if;
    if jsonb_array_length(coalesce(v_item->'pos', '[]'::jsonb)) < 1 then
      raise exception 'Minimal satu PO wajib diisi.';
    end if;
    v_ticket_type := upper(regexp_replace(coalesce(nullif(btrim(v_ticket->>'ticket_type'), ''), 'REG'), '\s+', '-', 'g'));
    if v_ticket_type = 'DROP' then v_ticket_type := 'DROP-OFF'; end if;
    v_slot := coalesce(nullif(btrim(v_ticket->>'slot'), ''), '3');
    perform pg_advisory_xact_lock(hashtext(v_site || '|' || v_operational_date::text || '|' || v_ticket_type || '|' || v_slot));
    select coalesce(max((regexp_match(queue_no, '(\d+)\s*$'))[1]::integer), 0) + 1 into v_seq
      from public.tickets where operational_date = v_operational_date
      and site_code = v_site and ticket_type = v_ticket_type and slot = v_slot;
    v_queue_no := v_ticket_type || ' ' || v_slot || '-' || v_seq;

    insert into public.tickets(ticket_id, queue_no, ticket_type, status, vendor_name,
      site_code, fleet_type, plat_number, driver_name, driver_phone, gate, slot, operational_date,
      registered_by, ktp_6_digit, unload_sla, source)
    values(v_ticket_id, v_queue_no, v_ticket_type,
      coalesce(nullif(btrim(v_ticket->>'status'), ''), 'WAITING'), nullif(btrim(v_ticket->>'vendor_name'), ''),
      v_site, nullif(btrim(v_ticket->>'fleet_type'), ''), nullif(btrim(v_ticket->>'plat_number'), ''),
      nullif(btrim(v_ticket->>'driver_name'), ''), nullif(btrim(v_ticket->>'driver_phone'), ''),
      nullif(btrim(v_ticket->>'gate'), ''), v_slot, v_operational_date,
      nullif(btrim(v_ticket->>'registered_by'), ''), nullif(btrim(v_ticket->>'ktp_6_digit'), ''),
      coalesce(nullif(btrim(v_ticket->>'unload_sla'), ''), 'ON PROCESS'),
      coalesce(nullif(btrim(v_ticket->>'source'), ''), 'Supabase'));

    for v_po in select value from jsonb_array_elements(v_item->'pos')
    loop
      if nullif(btrim(v_po->>'po_number'), '') is null then raise exception 'po_number wajib diisi.'; end if;
      if coalesce((v_po->>'is_manual')::boolean, false) = false and not exists(
        select 1 from public.superset_po_master m
        join public.site_master s on s.location_id = m.location_id and s.active
        where m.po_number = btrim(v_po->>'po_number')) then
        raise exception 'PO % tidak ditemukan di master gudang aktif. Pilih opsi PO manual.', btrim(v_po->>'po_number');
      end if;
      v_po_id := coalesce(nullif(btrim(v_po->>'ticket_po_id'), ''), gen_random_uuid()::text);
      insert into public.ticket_pos(ticket_po_id, ticket_id, po_number, vendor_name,
        request_quantity, actual_quantity, count_sku, checker_status)
      values(v_po_id, v_ticket_id, btrim(v_po->>'po_number'),
        coalesce(nullif(btrim(v_po->>'vendor_name'), ''), nullif(btrim(v_ticket->>'vendor_name'), '')),
        coalesce((v_po->>'request_quantity')::double precision, 0),
        coalesce((v_po->>'actual_quantity')::double precision, 0),
        coalesce((v_po->>'count_sku')::integer, 0),
        coalesce(nullif(btrim(v_po->>'checker_status'), ''), 'PENDING'));
      insert into public.gsheet_sync_outbox(ticket_po_id, ticket_id)
      values(v_po_id, v_ticket_id) on conflict (ticket_po_id) do update set
        ticket_id=excluded.ticket_id, sync_status='PENDING', attempt_count=0,
        last_error=null, synced_at=null, updated_at=now();
    end loop;
    insert into public.ticket_events(ticket_id,event_type,actor_role,actor_name,payload_json)
      values(v_ticket_id,'SECURITY_REGISTERED',p_actor->>'role',p_actor->>'name',
        jsonb_build_object('queue_no',v_queue_no,'site_code',v_site,'po_count',jsonb_array_length(v_item->'pos')));
    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'ticket_id',v_ticket_id,'queue_no',v_queue_no,'site_code',v_site,
      'operational_date',v_operational_date::text));
  end loop;
  return jsonb_build_object('created',v_created,'inserted_tickets',jsonb_array_length(v_created));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Nomor BA memakai kode gudang, bukan CBT
-- ---------------------------------------------------------------------------
create or replace function public.inbound_create_ba(p_payload jsonb, p_actor jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_date date:=coalesce((p_payload->>'ba_date')::date,timezone('Asia/Jakarta',now())::date); v_key text;
  v_number integer; v_id uuid:=gen_random_uuid(); v_ba_number text; v_item jsonb; v_count integer:=0;
  v_site text:=upper(coalesce(nullif(btrim(p_payload->>'site_code'),''),
    (select site_code from public.site_master where active order by sort_order limit 1)));
  v_reasons text[]:=array['MSLOR','BARANG RUSAK','KURANG KIRIM','TIDAK DATANG','LEBIH KIRIM','BARANG TIDAK ADA DI PO','TOLAK BEDA SKU','TOLAK BEDA GRAMASI','SALAH BAWA BARANG'];
begin
  if not exists(select 1 from public.site_master where site_code=v_site) then
    raise exception 'Kode gudang % tidak dikenal.',v_site;
  end if;
  -- Sequence di-scope per gudang supaya nomor BA tiap gudang berjalan sendiri.
  v_key:=v_site||'-'||to_char(v_date,'YYYY-MM');
  insert into public.ba_sequences(sequence_key,last_number) values(v_key,1)
    on conflict(sequence_key) do update set last_number=ba_sequences.last_number+1,updated_at=now() returning last_number into v_number;
  v_ba_number:=lpad(v_number::text,6,'0')||'/'||v_site||'/'||to_char(v_date,'MM/YYYY');
  insert into public.ba_documents(ba_id,ba_number,ba_date,day_name,site_code,po_number,supplier_name,note,created_by,created_role)
    values(v_id,v_ba_number,v_date,coalesce(nullif(btrim(p_payload->>'day_name'),''),upper(to_char(v_date,'FMDay'))),
      v_site,nullif(btrim(p_payload->>'po_number'),''),nullif(btrim(p_payload->>'supplier_name'),''),nullif(btrim(p_payload->>'note'),''),
      p_actor->>'name',p_actor->>'role');
  for v_item in select value from jsonb_array_elements(coalesce(p_payload->'items','[]'::jsonb)) loop
    if nullif(btrim(v_item->>'product_name'),'') is null then continue; end if;
    if not upper(btrim(v_item->>'reason'))=any(v_reasons) then raise exception 'Reason BA tidak valid.'; end if;
    insert into public.ba_items(ba_id,sku_number,product_id,product_name,quantity,reason)
      values(v_id,nullif(btrim(v_item->>'sku_number'),''),nullif(btrim(v_item->>'product_id'),''),btrim(v_item->>'product_name'),
        btrim(v_item->>'quantity'),upper(btrim(v_item->>'reason'))); v_count:=v_count+1;
  end loop;
  if v_count=0 then raise exception 'Isi minimal satu barang BA.'; end if;
  return jsonb_build_object('document',(select to_jsonb(d) from public.ba_documents d where ba_id=v_id),
    'items',(select coalesce(jsonb_agg(to_jsonb(i) order by created_at),'[]'::jsonb) from public.ba_items i where ba_id=v_id));
end; $$;

-- ---------------------------------------------------------------------------
-- 6. Finalize sync menghormati filter gudang aktif
-- ---------------------------------------------------------------------------
create or replace function public.inbound_finalize_superset_sync(p_run_id uuid, p_expected_count integer, p_checksum text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_count integer; v_active text[] := public.inbound_active_location_ids();
begin
  select count(*) into v_count from public.superset_po_stage where run_id=p_run_id;
  if v_count <> p_expected_count or v_count=0 then raise exception 'Stage count % tidak cocok expected %',v_count,p_expected_count; end if;
  if cardinality(v_active)=0 then raise exception 'Tidak ada gudang aktif; snapshot lama dipertahankan.'; end if;
  -- Sabuk pengaman: sync tidak boleh menulis PO gudang di luar daftar aktif,
  -- walaupun chart Superset berubah filternya.
  if exists(select 1 from public.superset_po_stage
             where run_id=p_run_id
               and (location_id is null or not (location_id = any(v_active)))) then
    raise exception 'Stage berisi location_id di luar gudang aktif.';
  end if;

  insert into public.superset_po_master(source_row_key,po_number,vendor_name,location_id,location_name,
    request_shipping_date,fulfillment_arrived_start_at,schedule_type,po_status,
    fulfillment_receiving_start_at,fulfillment_completed_at,request_quantity,actual_quantity,count_sku,site_code,synced_at)
  select s.source_row_key,s.po_number,s.vendor_name,s.location_id,s.location_name,
    s.request_shipping_date,s.fulfillment_arrived_start_at,s.schedule_type,s.po_status,
    s.fulfillment_receiving_start_at,s.fulfillment_completed_at,s.request_quantity,s.actual_quantity,s.count_sku,
    coalesce(s.site_code, public.inbound_site_of_location(s.location_id)),now()
    from public.superset_po_stage s where s.run_id=p_run_id
  on conflict(source_row_key) do update set po_number=excluded.po_number,vendor_name=excluded.vendor_name,
    location_id=excluded.location_id,location_name=excluded.location_name,request_shipping_date=excluded.request_shipping_date,
    fulfillment_arrived_start_at=excluded.fulfillment_arrived_start_at,schedule_type=excluded.schedule_type,
    po_status=excluded.po_status,fulfillment_receiving_start_at=excluded.fulfillment_receiving_start_at,
    fulfillment_completed_at=excluded.fulfillment_completed_at,request_quantity=excluded.request_quantity,
    actual_quantity=excluded.actual_quantity,count_sku=excluded.count_sku,site_code=excluded.site_code,synced_at=now();

  -- Hanya membuang baris milik gudang aktif yang tidak lagi ada di snapshot baru.
  -- Baris gudang non-aktif tidak boleh terhapus diam-diam oleh sync gudang lain.
  delete from public.superset_po_master m
   where m.location_id = any(v_active)
     and not exists(select 1 from public.superset_po_stage s
                     where s.run_id=p_run_id and s.source_row_key=m.source_row_key);

  insert into public.sync_runs(run_id,sync_name,status,fetched_count,written_count,checksum,finished_at)
    values(p_run_id,'superset_po','SUCCESS',p_expected_count,v_count,p_checksum,now())
    on conflict(run_id) do update set status='SUCCESS',fetched_count=excluded.fetched_count,
      written_count=excluded.written_count,checksum=excluded.checksum,finished_at=now();
  delete from public.superset_po_stage where run_id=p_run_id;
  return jsonb_build_object('fetched',p_expected_count,'written',v_count,'checksum',p_checksum,
    'active_locations',to_jsonb(v_active));
end;
$$;

create or replace function public.inbound_superset_freshness()
returns jsonb language sql security definer set search_path=public as $$
  with d as (select timezone('Asia/Jakarta',now())::date as today),
  scoped as (
    -- Kolom disebut satu per satu, TIDAK memakai `m.*`.
    --
    -- Migrasi ini sendiri menambahkan `site_code` ke `superset_po_master`
    -- (bagian 2 di atas), sehingga `m.*` sudah membawa satu kolom bernama
    -- `site_code`. Menambah `s.site_code` di sebelahnya membuat CTE ini punya
    -- dua kolom dengan nama sama, dan setiap rujukan tak berkualifikasi di
    -- bawah gagal dengan "column reference site_code is ambiguous".
    --
    -- `site_code` diambil dari `site_master` karena join-lah yang otoritatif;
    -- kolom salinan di `superset_po_master` dapat kosong pada baris lama.
    select
      m.po_number, m.vendor_name, m.request_shipping_date,
      m.fulfillment_arrived_start_at, m.po_status, m.synced_at,
      s.site_code, s.site_name
    from public.superset_po_master m
    join public.site_master s on s.location_id = m.location_id and s.active
  ),
  summary as (select count(*)::int total_master_po,max(synced_at) last_synced_at,
    count(*) filter(where coalesce(fulfillment_arrived_start_at,'') like '%'||(select today::text from d)||'%')::int received_today_count
    from scoped),
  per_site as (select coalesce(jsonb_agg(jsonb_build_object('site_code',site_code,'site_name',site_name,
    'total_po',total_po,'last_synced_at',last_synced_at) order by site_code),'[]'::jsonb) rows from (
    select site_code,site_name,count(*)::int total_po,max(synced_at) last_synced_at from scoped group by site_code,site_name) y),
  samples as (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) rows from (
    select po_number,vendor_name,site_code,fulfillment_arrived_start_at,request_shipping_date,po_status,synced_at
    from scoped where coalesce(fulfillment_arrived_start_at,'') like '%'||(select today::text from d)||'%'
    order by synced_at desc,po_number limit 8) x)
  select jsonb_build_object('received_date_wib',(select today::text from d),'total_master_po',summary.total_master_po,
    'last_synced_at',summary.last_synced_at,'received_today_count',summary.received_today_count,
    'active_sites',per_site.rows,'received_today_samples',samples.rows)
  from summary,samples,per_site;
$$;

-- ---------------------------------------------------------------------------
-- 7. Hak akses
-- ---------------------------------------------------------------------------
alter table public.site_master enable row level security;
grant all on public.site_master to service_role;
grant execute on function public.inbound_active_location_ids() to service_role;
grant execute on function public.inbound_active_gates() to service_role;
grant execute on function public.inbound_site_of_location(text) to service_role;

commit;
