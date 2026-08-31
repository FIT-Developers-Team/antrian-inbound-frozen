begin;

create extension if not exists pgcrypto;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table if not exists public.tickets (
  ticket_id text primary key,
  queue_no text not null,
  ticket_type text not null default 'REG',
  status text not null default 'WAITING',
  vendor_name text,
  fleet_type text,
  plat_number text,
  driver_name text,
  driver_phone text,
  gate text,
  slot text,
  operational_date date,
  registered_by text,
  ktp_6_digit text,
  unload_sla text,
  source text,
  called_at timestamptz,
  arrived_at timestamptz,
  start_unloading_at timestamptz,
  done_unloading_at timestamptz,
  expired_at timestamptz,
  expired_reason text,
  call_count integer not null default 0,
  last_call_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ticket_pos (
  ticket_po_id text primary key,
  ticket_id text not null references public.tickets(ticket_id) on delete cascade,
  po_number text not null,
  vendor_name text,
  request_quantity double precision not null default 0,
  actual_quantity double precision not null default 0,
  count_sku integer not null default 0,
  checker_status text not null default 'PENDING',
  gr_status text not null default 'PENDING',
  checker_id text,
  checker_name text,
  checking_started_at timestamptz,
  checking_done_at timestamptz,
  gr_done_at timestamptz,
  handover_grn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ticket_events (
  event_id uuid primary key default gen_random_uuid(),
  ticket_id text not null references public.tickets(ticket_id) on delete cascade,
  event_type text not null,
  actor_role text,
  actor_name text,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.gates (
  gate_name text primary key,
  status text not null default 'KOSONG',
  ticket_id text references public.tickets(ticket_id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.checker_master (
  mp_id text primary key,
  checker_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.superset_po_master (
  source_row_key text primary key,
  po_number text not null,
  vendor_name text,
  location_id text,
  location_name text,
  request_shipping_date text,
  fulfillment_arrived_start_at text,
  schedule_type text,
  po_status text,
  fulfillment_receiving_start_at text,
  fulfillment_completed_at text,
  request_quantity double precision not null default 0,
  actual_quantity double precision not null default 0,
  count_sku bigint not null default 0,
  synced_at timestamptz not null default now()
);

create table if not exists public.superset_po_stage (
  run_id uuid not null,
  source_row_key text not null,
  po_number text not null,
  vendor_name text,
  location_id text,
  location_name text,
  request_shipping_date text,
  fulfillment_arrived_start_at text,
  schedule_type text,
  po_status text,
  fulfillment_receiving_start_at text,
  fulfillment_completed_at text,
  request_quantity double precision not null default 0,
  actual_quantity double precision not null default 0,
  count_sku bigint not null default 0,
  staged_at timestamptz not null default now(),
  primary key (run_id, source_row_key)
);

create table if not exists public.sync_runs (
  run_id uuid primary key,
  sync_name text not null,
  status text not null,
  fetched_count integer not null default 0,
  written_count integer not null default 0,
  checksum text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.product_master (
  sku_number text primary key,
  product_name text not null,
  product_id text,
  imported_at timestamptz not null default now()
);

create table if not exists public.gsheet_sync_outbox (
  ticket_po_id text primary key references public.ticket_pos(ticket_po_id) on delete cascade,
  ticket_id text not null references public.tickets(ticket_id) on delete cascade,
  sync_status text not null default 'PENDING',
  attempt_count integer not null default 0,
  last_error text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ba_sequences (
  sequence_key text primary key,
  last_number integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.ba_documents (
  ba_id uuid primary key default gen_random_uuid(),
  ba_number text unique not null,
  ba_date date not null,
  day_name text not null,
  po_number text,
  supplier_name text,
  note text,
  created_by text,
  created_role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ba_items (
  ba_item_id uuid primary key default gen_random_uuid(),
  ba_id uuid not null references public.ba_documents(ba_id) on delete cascade,
  sku_number text,
  product_id text,
  product_name text not null,
  quantity text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists tickets_status_created_idx on public.tickets(status, created_at desc);
create index if not exists tickets_operational_idx on public.tickets(operational_date, ticket_type, slot);
create index if not exists ticket_pos_ticket_idx on public.ticket_pos(ticket_id, created_at);
create index if not exists ticket_pos_updated_idx on public.ticket_pos(updated_at);
create index if not exists ticket_events_ticket_idx on public.ticket_events(ticket_id, created_at desc);
create index if not exists superset_po_number_idx on public.superset_po_master(po_number);
create index if not exists superset_po_synced_idx on public.superset_po_master(synced_at desc);
create index if not exists superset_stage_run_idx on public.superset_po_stage(run_id);
create index if not exists product_master_product_id_idx on public.product_master(product_id);
create index if not exists gsheet_outbox_status_idx on public.gsheet_sync_outbox(sync_status, updated_at);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tickets_touch_updated_at on public.tickets;
create trigger tickets_touch_updated_at before update on public.tickets
for each row execute function public.touch_updated_at();
drop trigger if exists ticket_pos_touch_updated_at on public.ticket_pos;
create trigger ticket_pos_touch_updated_at before update on public.ticket_pos
for each row execute function public.touch_updated_at();

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
    = count(*) over (partition by t.ticket_id) as ticket_all_done_gr
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
  count(p.ticket_po_id) as po_count
from public.tickets t left join public.ticket_pos p on p.ticket_id = t.ticket_id
group by t.ticket_id;

create or replace view public.superset_po_public
with (security_invoker = true) as
select po_number, vendor_name, '3'::text as slot,
  request_quantity as total_request_quantity,
  count_sku as "Count SKU", location_id, location_name,
  request_shipping_date, fulfillment_arrived_start_at, schedule_type, po_status,
  synced_at
from public.superset_po_master;

create or replace view public.ba_documents_summary
with (security_invoker = true) as
select d.ba_id, d.ba_number, d.ba_date::text as ba_date, d.day_name,
  d.po_number, d.supplier_name, d.note, d.created_by, d.created_role,
  d.created_at, count(i.ba_item_id)::integer as item_count
from public.ba_documents d left join public.ba_items i on i.ba_id = d.ba_id
group by d.ba_id;

create or replace function public.inbound_requeue_gsheet(p_ticket_ids text[])
returns void language sql security definer set search_path = public as $$
  insert into public.gsheet_sync_outbox
    (ticket_po_id, ticket_id, sync_status, attempt_count, last_error, synced_at, created_at, updated_at)
  select p.ticket_po_id, p.ticket_id, 'PENDING', 0, null, null, now(), now()
  from public.ticket_pos p where p.ticket_id = any(p_ticket_ids)
  on conflict (ticket_po_id) do update set
    ticket_id = excluded.ticket_id, sync_status = 'PENDING', attempt_count = 0,
    last_error = null, synced_at = null, updated_at = now();
$$;

create or replace function public.inbound_create_tickets_bulk(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_items jsonb := coalesce(p_payload->'tickets', '[]'::jsonb);
  v_item jsonb; v_ticket jsonb; v_po jsonb;
  v_ticket_id text; v_ticket_type text; v_slot text; v_queue_no text;
  v_operational_date date := (timezone('Asia/Jakarta', now()) - interval '4 hours')::date;
  v_seq integer; v_created jsonb := '[]'::jsonb; v_po_id text;
begin
  if jsonb_array_length(v_items) < 1 then raise exception 'Minimal satu ticket wajib diisi.'; end if;
  if jsonb_array_length(v_items) > 50 then raise exception 'Maksimal 50 ticket per submit.'; end if;

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_ticket := coalesce(v_item->'ticket', v_item);
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
    perform pg_advisory_xact_lock(hashtext(v_operational_date::text || '|' || v_ticket_type || '|' || v_slot));
    select coalesce(max((regexp_match(queue_no, '(\d+)\s*$'))[1]::integer), 0) + 1 into v_seq
      from public.tickets where operational_date = v_operational_date
      and ticket_type = v_ticket_type and slot = v_slot;
    v_queue_no := v_ticket_type || ' ' || v_slot || '-' || v_seq;

    insert into public.tickets(ticket_id, queue_no, ticket_type, status, vendor_name,
      fleet_type, plat_number, driver_name, driver_phone, gate, slot, operational_date,
      registered_by, ktp_6_digit, unload_sla, source)
    values(v_ticket_id, v_queue_no, v_ticket_type,
      coalesce(nullif(btrim(v_ticket->>'status'), ''), 'WAITING'), nullif(btrim(v_ticket->>'vendor_name'), ''),
      nullif(btrim(v_ticket->>'fleet_type'), ''), nullif(btrim(v_ticket->>'plat_number'), ''),
      nullif(btrim(v_ticket->>'driver_name'), ''), nullif(btrim(v_ticket->>'driver_phone'), ''),
      nullif(btrim(v_ticket->>'gate'), ''), v_slot, v_operational_date,
      nullif(btrim(v_ticket->>'registered_by'), ''), nullif(btrim(v_ticket->>'ktp_6_digit'), ''),
      coalesce(nullif(btrim(v_ticket->>'unload_sla'), ''), 'ON PROCESS'),
      coalesce(nullif(btrim(v_ticket->>'source'), ''), 'Supabase'));

    for v_po in select value from jsonb_array_elements(v_item->'pos')
    loop
      if nullif(btrim(v_po->>'po_number'), '') is null then raise exception 'po_number wajib diisi.'; end if;
      if coalesce((v_po->>'is_manual')::boolean, false) = false and not exists(
        select 1 from public.superset_po_master where po_number = btrim(v_po->>'po_number')) then
        raise exception 'PO % tidak ditemukan di master Supabase. Pilih opsi PO manual.', btrim(v_po->>'po_number');
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
        jsonb_build_object('queue_no',v_queue_no,'po_count',jsonb_array_length(v_item->'pos')));
    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'ticket_id',v_ticket_id,'queue_no',v_queue_no,'operational_date',v_operational_date::text));
  end loop;
  return jsonb_build_object('created',v_created,'inserted_tickets',jsonb_array_length(v_created));
end;
$$;

create or replace function public.inbound_update_ticket_status(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id text := btrim(p_payload->>'ticket_id'); v_status text := upper(btrim(p_payload->>'status')); v_row public.tickets;
begin
  if v_id = '' or v_status = '' then raise exception 'ticket_id dan status wajib diisi.'; end if;
  update public.tickets set status=v_status,
    gate=coalesce(nullif(btrim(p_payload->>'gate'),''),gate),
    called_at=case when v_status='CALLED' then coalesce(called_at,now()) else called_at end,
    arrived_at=case when v_status='ARRIVED' then coalesce(arrived_at,now()) else arrived_at end,
    start_unloading_at=case when v_status='UNLOADING' then coalesce(start_unloading_at,now()) else start_unloading_at end,
    done_unloading_at=case when v_status='COMPLETED' then coalesce(done_unloading_at,now()) else done_unloading_at end,
    expired_at=case when v_status='EXPIRED' then coalesce(expired_at,now()) else expired_at end
  where ticket_id=v_id returning * into v_row;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  insert into public.ticket_events(ticket_id,event_type,actor_role,actor_name,payload_json)
    values(v_id,'STATUS_'||v_status,p_actor->>'role',p_actor->>'name',jsonb_build_object('gate',p_payload->>'gate'));
  perform public.inbound_requeue_gsheet(array[v_id]);
  return to_jsonb(v_row);
end;
$$;

create or replace function public.inbound_update_ticket_pos(p_action text, p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id text := btrim(p_payload->>'ticket_id'); v_po_ids text[]; v_count integer; v_rows jsonb;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;
  select coalesce(array_agg(value), array[]::text[]) into v_po_ids from (
    select btrim(value) value from jsonb_array_elements_text(coalesce(p_payload->'ticket_po_ids','[]'::jsonb))
    union all select btrim(p_payload->>'ticket_po_id') where nullif(btrim(p_payload->>'ticket_po_id'),'') is not null
  ) x;
  if lower(p_action)='startcheckerpo' then
    update public.ticket_pos set checker_id=nullif(btrim(p_payload->>'checker_id'),''),
      checker_name=nullif(btrim(p_payload->>'checker_name'),''), checker_status='CHECKING',
      checking_started_at=now() where ticket_id=v_id and ticket_po_id=any(v_po_ids)
      and upper(coalesce(checker_status,'PENDING'))='PENDING';
    get diagnostics v_count=row_count;
    if v_count <> cardinality(v_po_ids) then raise exception 'Ada PO yang sudah sedang atau selesai checking.'; end if;
    update public.tickets set status='UNLOADING',start_unloading_at=coalesce(start_unloading_at,now()) where ticket_id=v_id;
  elsif lower(p_action)='donecheckerpo' then
    update public.ticket_pos set checker_status='DONE',checking_done_at=now(),
      gr_status=case when gr_status='DONE GR' then gr_status else 'WAITING GR' end
      where ticket_id=v_id and ticket_po_id=any(v_po_ids) and upper(coalesce(checker_status,'PENDING'))='CHECKING';
    get diagnostics v_count=row_count;
    if v_count <> cardinality(v_po_ids) then raise exception 'Done Checker hanya berlaku untuk PO berstatus CHECKING.'; end if;
    if not exists(select 1 from public.ticket_pos where ticket_id=v_id and upper(coalesce(checker_status,'PENDING'))<>'DONE') then
      update public.tickets set status='WAITING GR',done_unloading_at=coalesce(done_unloading_at,now()) where ticket_id=v_id and status not in('COMPLETED','EXPIRED');
    end if;
  elsif lower(p_action)='donegrpo' then
    update public.ticket_pos set actual_quantity=coalesce((p_payload->>'actual_quantity')::double precision,0),
      gr_status='DONE GR',gr_done_at=now() where ticket_id=v_id and ticket_po_id=any(v_po_ids);
  elsif lower(p_action)='donegrpos' then
    update public.ticket_pos p set actual_quantity=(i.value->>'actual_quantity')::double precision,
      gr_status='DONE GR',gr_done_at=now() from jsonb_array_elements(p_payload->'items') i
      where p.ticket_id=v_id and p.ticket_po_id=btrim(i.value->>'ticket_po_id')
      and (i.value->>'actual_quantity')::double precision>0
      and upper(coalesce(p.checker_status,'PENDING'))='DONE' and upper(coalesce(p.gr_status,'PENDING'))<>'DONE GR';
  elsif lower(p_action)='handovergrn' then
    update public.ticket_pos set handover_grn_at=now() where ticket_id=v_id;
    update public.tickets set status='COMPLETED',done_unloading_at=now() where ticket_id=v_id;
  elsif lower(p_action)='failcall' then
    update public.tickets set status='EXPIRED',expired_at=now(),expired_reason=nullif(btrim(p_payload->>'reason'),'') where ticket_id=v_id;
  else
    update public.tickets set
      status=coalesce(nullif(upper(btrim(p_payload->>'status')),''),status),
      gate=coalesce(nullif(btrim(p_payload->>'gate'),''),gate),
      called_at=case when upper(btrim(p_payload->>'status'))='CALLED' then coalesce(called_at,now()) else called_at end,
      last_call_at=case when upper(btrim(p_payload->>'status'))='CALLED' then now() else last_call_at end,
      call_count=case when upper(btrim(p_payload->>'status'))='CALLED' then call_count+1 else call_count end,
      start_unloading_at=case when upper(btrim(p_payload->>'status'))='UNLOADING' then coalesce(start_unloading_at,now()) else start_unloading_at end,
      done_unloading_at=case when upper(btrim(p_payload->>'status')) in('WAITING GR','COMPLETED') then coalesce(done_unloading_at,now()) else done_unloading_at end
    where ticket_id=v_id;
  end if;
  perform public.inbound_requeue_gsheet(array[v_id]);
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.po_created_at), '[]'::jsonb)
    into v_rows from public.inbound_operational_rows r where r.ticket_id=v_id;
  return jsonb_build_object('rows',v_rows,'all_done_gr',
    not exists(select 1 from public.ticket_pos where ticket_id=v_id and upper(coalesce(gr_status,''))<>'DONE GR'));
end;
$$;

create or replace function public.inbound_finalize_superset_sync(p_run_id uuid, p_expected_count integer, p_checksum text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  select count(*) into v_count from public.superset_po_stage where run_id=p_run_id;
  if v_count <> p_expected_count or v_count=0 then raise exception 'Stage count % tidak cocok expected %',v_count,p_expected_count; end if;
  insert into public.superset_po_master select source_row_key,po_number,vendor_name,location_id,location_name,
    request_shipping_date,fulfillment_arrived_start_at,schedule_type,po_status,
    fulfillment_receiving_start_at,fulfillment_completed_at,request_quantity,actual_quantity,count_sku,now()
    from public.superset_po_stage where run_id=p_run_id
  on conflict(source_row_key) do update set po_number=excluded.po_number,vendor_name=excluded.vendor_name,
    location_id=excluded.location_id,location_name=excluded.location_name,request_shipping_date=excluded.request_shipping_date,
    fulfillment_arrived_start_at=excluded.fulfillment_arrived_start_at,schedule_type=excluded.schedule_type,
    po_status=excluded.po_status,fulfillment_receiving_start_at=excluded.fulfillment_receiving_start_at,
    fulfillment_completed_at=excluded.fulfillment_completed_at,request_quantity=excluded.request_quantity,
    actual_quantity=excluded.actual_quantity,count_sku=excluded.count_sku,synced_at=now();
  delete from public.superset_po_master m where not exists(
    select 1 from public.superset_po_stage s where s.run_id=p_run_id and s.source_row_key=m.source_row_key);
  insert into public.sync_runs(run_id,sync_name,status,fetched_count,written_count,checksum,finished_at)
    values(p_run_id,'superset_po','SUCCESS',p_expected_count,v_count,p_checksum,now())
    on conflict(run_id) do update set status='SUCCESS',fetched_count=excluded.fetched_count,
      written_count=excluded.written_count,checksum=excluded.checksum,finished_at=now();
  delete from public.superset_po_stage where run_id=p_run_id;
  return jsonb_build_object('fetched',p_expected_count,'written',v_count,'checksum',p_checksum);
end;
$$;

create or replace function public.inbound_superset_freshness()
returns jsonb language sql security definer set search_path=public as $$
  with d as (select timezone('Asia/Jakarta',now())::date as today),
  summary as (select count(*)::int total_master_po,max(synced_at) last_synced_at,
    count(*) filter(where coalesce(fulfillment_arrived_start_at,'') like '%'||(select today::text from d)||'%')::int received_today_count
    from public.superset_po_master),
  samples as (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) rows from (
    select po_number,vendor_name,fulfillment_arrived_start_at,request_shipping_date,po_status,synced_at
    from public.superset_po_master where coalesce(fulfillment_arrived_start_at,'') like '%'||(select today::text from d)||'%'
    order by synced_at desc,po_number limit 8) x)
  select jsonb_build_object('received_date_wib',(select today::text from d),'total_master_po',summary.total_master_po,
    'last_synced_at',summary.last_synced_at,'received_today_count',summary.received_today_count,
    'received_today_samples',samples.rows) from summary,samples;
$$;

do $$ declare t text; begin
  foreach t in array array['tickets','ticket_pos','ticket_events','gates','checker_master','superset_po_master',
    'superset_po_stage','sync_runs','product_master','gsheet_sync_outbox','ba_sequences','ba_documents','ba_items']
  loop execute format('alter table public.%I enable row level security',t); end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;

commit;
