-- ============================================================================
-- ANTRIAN INBOUND FROZEN — SLA, KEDATANGAN, DAN TRIGGER MULAI BONGKAR
--
-- Masalah yang diperbaiki:
--
-- 1. Target SLA dihitung di tiga tempat dengan aturan yang BERBEDA:
--      js/app.js (V16.3)          VAN/PICKUP/MOBIL/L300 = 2 jam, RODA 2 = 1 jam,
--                                 DROP-OFF = 23 jam
--      sync-gsheet/index.ts       VAN/PICKUP/MOBIL/L300 = 1 jam, RODA 2 = tanpa SLA,
--                                 DROP-OFF = tanpa SLA
--    Akibatnya angka SLA di layar dan di Google Sheet tidak pernah cocok.
--    Migrasi ini memindahkan aturan ke database sebagai satu-satunya sumber
--    kebenaran, memakai aturan operasional dari js/app.js.
--
-- 2. `tickets.arrived_at` sudah ada sejak awal tetapi tidak pernah dapat diisi:
--    tidak ada UI maupun RPC untuk mencatat jam kedatangan driver. Waktu tunggu
--    driver selama ini dihitung dari jam input data, bukan jam kedatangan.
--
-- 3. Memulai bongkar mengharuskan operator memilih PO satu per satu lebih dulu.
--    Tidak ada trigger tunggal "mulai bongkar sekarang".
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Aturan SLA — satu sumber kebenaran
-- ---------------------------------------------------------------------------

/** Menyeragamkan penulisan tipe armada sebelum dicocokkan ke aturan SLA. */
create or replace function public.inbound_fleet_canonical(p_fleet text)
returns text language sql immutable as $$
  select case
    when v like '%TRONTON%' or v like '%FUSO%'   then 'TRONTON/FUSO'
    when v like '%WING%'                          then 'WING BOX'
    when v like '%CDDL%'                          then 'CDDL'
    when v like '%CDEL%'                          then 'CDEL'
    when v like '%CDD%'                           then 'CDD'
    when v like '%CDE%'                           then 'CDE'
    when v like '%DROP%'                          then 'DROP-OFF'
    when v like '%RODA 2%' or v like '%MOTOR%'    then 'RODA 2'
    when v like '%L300%'                          then 'L300 BOX'
    when v like '%PICK%'                          then 'PICKUP'
    when v like '%GRANDMAX%' or v like '%MOBIL%'  then 'MOBIL'
    when v like '%VAN%'                           then 'VAN'
    else v
  end
  from (select upper(regexp_replace(btrim(coalesce(p_fleet, '')), '\s+', ' ', 'g')) as v) x;
$$;

/**
 * Target SLA bongkar dalam jam.
 * CDDL mengikuti aturan CDD dan CDEL mengikuti CDE.
 * SKU tepat 40 masuk tier 2 jam (batasnya "lebih dari 40").
 * Mengembalikan 0 untuk armada tanpa SLA.
 */
create or replace function public.inbound_sla_target_hours(p_fleet text, p_sku integer)
returns integer language sql immutable as $$
  select case
    when f in ('TRONTON/FUSO', 'WING BOX')       then 4
    when f in ('CDD', 'CDDL', 'CDE', 'CDEL')     then case when coalesce(p_sku, 0) > 40 then 4 else 2 end
    when f in ('VAN', 'PICKUP', 'MOBIL', 'L300 BOX') then 2
    when f = 'RODA 2'                            then 1
    when f = 'DROP-OFF'                          then 23
    else 0
  end
  from (select public.inbound_fleet_canonical(p_fleet) as f) x;
$$;

-- ---------------------------------------------------------------------------
-- 2. View operasional membawa SLA yang sudah dihitung server
--
-- Kolom baru ditambahkan di akhir agar CREATE OR REPLACE VIEW tetap sah.
-- Klien tidak lagi menghitung target SLA sendiri; ia hanya menghitung selisih
-- waktu terhadap `sla_deadline_at` supaya hitung mundurnya berdetak per detik.
-- ---------------------------------------------------------------------------
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
  t.site_code,

  -- ---- SLA yang dihitung server ------------------------------------------
  public.inbound_sla_target_hours(
    t.fleet_type,
    coalesce(sum(p.count_sku) over (partition by t.ticket_id), 0)::integer
  ) as sla_target_hours,

  case when public.inbound_sla_target_hours(
         t.fleet_type,
         coalesce(sum(p.count_sku) over (partition by t.ticket_id), 0)::integer) > 0
       and t.start_unloading_at is not null
    then t.start_unloading_at + make_interval(hours => public.inbound_sla_target_hours(
           t.fleet_type,
           coalesce(sum(p.count_sku) over (partition by t.ticket_id), 0)::integer))
  end as sla_deadline_at,

  t.start_unloading_at as sla_started_at,

  -- Jam berhenti: seluruh PO selesai GR, bongkar selesai, atau tiket expired.
  coalesce(
    case when count(*) filter (where upper(coalesce(p.gr_status, '')) = 'DONE GR') over (partition by t.ticket_id)
              = count(*) over (partition by t.ticket_id)
         then max(p.gr_done_at) over (partition by t.ticket_id) end,
    t.done_unloading_at,
    t.expired_at
  ) as sla_stopped_at,

  -- Waktu tunggu driver dihitung dari kedatangan aktual bila ada; bila tidak,
  -- jatuh ke jam registrasi seperti perilaku sebelumnya.
  coalesce(t.arrived_at, t.created_at) as waiting_started_at,
  coalesce(t.start_unloading_at, t.expired_at) as waiting_stopped_at

from public.tickets t
left join public.ticket_pos p on p.ticket_id = t.ticket_id;

-- ---------------------------------------------------------------------------
-- 3. Mencatat / mengoreksi jam kedatangan
-- ---------------------------------------------------------------------------
create or replace function public.inbound_set_arrival(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_at timestamptz;
  v_row public.tickets;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;

  v_at := coalesce(nullif(btrim(p_payload->>'arrived_at'), '')::timestamptz, now());

  -- Jam kedatangan di masa depan hampir selalu salah ketik; tolak lebih awal
  -- daripada membiarkannya merusak perhitungan waktu tunggu.
  if v_at > now() + interval '5 minutes' then
    raise exception 'Jam kedatangan tidak boleh melewati waktu sekarang.';
  end if;

  update public.tickets set arrived_at = v_at where ticket_id = v_id returning * into v_row;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;

  insert into public.ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'ARRIVAL_RECORDED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('arrived_at', v_at));
  perform public.inbound_requeue_gsheet(array[v_id]);
  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- 4. Trigger tunggal "mulai bongkar"
--
-- Berbeda dari `startcheckerpo` yang menuntut daftar ticket_po_id eksplisit,
-- fungsi ini memulai bongkar untuk seluruh PO yang masih PENDING dalam satu
-- aksi. Operasional hanya perlu menekan satu tombol saat truk merapat.
-- ---------------------------------------------------------------------------
create or replace function public.inbound_start_unloading(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_gate text := nullif(btrim(p_payload->>'gate'), '');
  v_checker_id text := nullif(btrim(p_payload->>'checker_id'), '');
  v_checker_name text := nullif(btrim(p_payload->>'checker_name'), '');
  v_started timestamptz := now();
  v_ticket public.tickets;
  v_pos integer;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;

  select * into v_ticket from public.tickets where ticket_id = v_id;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if upper(coalesce(v_ticket.status, '')) in ('COMPLETED', 'EXPIRED') then
    raise exception 'Ticket sudah % dan tidak dapat dimulai ulang.', upper(v_ticket.status);
  end if;

  -- Idempoten: menekan tombol dua kali tidak menggeser jam mulai yang sudah ada,
  -- karena itu akan memperpanjang SLA secara diam-diam.
  v_started := coalesce(v_ticket.start_unloading_at, v_started);

  update public.tickets set
    status = 'UNLOADING',
    gate = coalesce(v_gate, gate),
    -- Truk yang langsung dibongkar tanpa sempat dicatat kedatangannya tetap
    -- punya jam kedatangan yang masuk akal.
    arrived_at = coalesce(arrived_at, v_started),
    called_at = coalesce(called_at, v_started),
    start_unloading_at = v_started
  where ticket_id = v_id;

  update public.ticket_pos set
    checker_id = coalesce(v_checker_id, checker_id),
    checker_name = coalesce(v_checker_name, checker_name),
    checker_status = 'CHECKING',
    checking_started_at = coalesce(checking_started_at, v_started)
  where ticket_id = v_id and upper(coalesce(checker_status, 'PENDING')) = 'PENDING';
  get diagnostics v_pos = row_count;

  insert into public.ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'UNLOADING_STARTED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('gate', v_gate, 'checker_name', v_checker_name,
                              'started_at', v_started, 'po_started', v_pos));
  perform public.inbound_requeue_gsheet(array[v_id]);

  return jsonb_build_object(
    'ticket_id', v_id,
    'started_at', v_started,
    'po_started', v_pos,
    'rows', (select coalesce(jsonb_agg(to_jsonb(r) order by r.po_sequence), '[]'::jsonb)
               from public.inbound_operational_rows r where r.ticket_id = v_id));
end; $$;

-- ---------------------------------------------------------------------------
-- 5. Pembuatan ticket menerima jam kedatangan
-- ---------------------------------------------------------------------------
create or replace function public.inbound_create_tickets_bulk(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_items jsonb := coalesce(p_payload->'tickets', '[]'::jsonb);
  v_item jsonb; v_ticket jsonb; v_po jsonb;
  v_ticket_id text; v_ticket_type text; v_slot text; v_queue_no text;
  v_default_site text := coalesce(nullif(btrim(p_payload->>'site_code'), ''),
    (select site_code from public.site_master where active order by sort_order limit 1));
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

    -- Security mencatat jam kedatangan sebenarnya; bila kosong dipakai jam input.
    v_arrived := coalesce(nullif(btrim(v_ticket->>'arrived_at'), '')::timestamptz, now());
    if v_arrived > now() + interval '5 minutes' then
      raise exception 'Jam kedatangan tidak boleh melewati waktu sekarang.';
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
      registered_by, ktp_6_digit, unload_sla, source, arrived_at)
    values(v_ticket_id, v_queue_no, v_ticket_type,
      coalesce(nullif(btrim(v_ticket->>'status'), ''), 'WAITING'), nullif(btrim(v_ticket->>'vendor_name'), ''),
      v_site, nullif(btrim(v_ticket->>'fleet_type'), ''), nullif(btrim(v_ticket->>'plat_number'), ''),
      nullif(btrim(v_ticket->>'driver_name'), ''), nullif(btrim(v_ticket->>'driver_phone'), ''),
      nullif(btrim(v_ticket->>'gate'), ''), v_slot, v_operational_date,
      nullif(btrim(v_ticket->>'registered_by'), ''), nullif(btrim(v_ticket->>'ktp_6_digit'), ''),
      coalesce(nullif(btrim(v_ticket->>'unload_sla'), ''), 'ON PROCESS'),
      coalesce(nullif(btrim(v_ticket->>'source'), ''), 'Supabase'),
      v_arrived);

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
        jsonb_build_object('queue_no',v_queue_no,'site_code',v_site,'arrived_at',v_arrived,
                           'po_count',jsonb_array_length(v_item->'pos')));
    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'ticket_id',v_ticket_id,'queue_no',v_queue_no,'site_code',v_site,
      'arrived_at',v_arrived,'operational_date',v_operational_date::text));
  end loop;
  return jsonb_build_object('created',v_created,'inserted_tickets',jsonb_array_length(v_created));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Index untuk pencarian tiket aktif per gudang
-- ---------------------------------------------------------------------------
create index if not exists tickets_arrived_idx on public.tickets(site_code, arrived_at desc);
create index if not exists tickets_unloading_idx
  on public.tickets(site_code, start_unloading_at desc)
  where start_unloading_at is not null;

grant execute on function public.inbound_fleet_canonical(text) to service_role;
grant execute on function public.inbound_sla_target_hours(text,integer) to service_role;
grant execute on function public.inbound_set_arrival(jsonb,jsonb) to service_role;
grant execute on function public.inbound_start_unloading(jsonb,jsonb) to service_role;

commit;
