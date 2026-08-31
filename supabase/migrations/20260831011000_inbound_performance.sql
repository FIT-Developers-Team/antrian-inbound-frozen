-- ============================================================================
-- ANTRIAN INBOUND FROZEN — SNAPSHOT & DELTA YANG EFISIEN
--
-- Masalah yang diperbaiki:
--   * `action=state` sebelumnya menarik SELURUH superset_po_master (puluhan ribu
--     baris) setiap kali polling, padahal hanya halaman Daftar yang memakainya.
--   * Pagination `range()` di Edge Function melakukan 1 round-trip per 1000 baris
--     dan bisa melewatkan/menduplikasi baris karena ORDER BY-nya tidak unik.
--   * Delta sync menarik ulang 5000 ticket_id tiap 10 detik hanya untuk mendeteksi
--     penghapusan.
--
-- Solusi: dua RPC yang mengembalikan satu payload JSON siap pakai plus
-- fingerprint murah untuk ETag / HTTP 304.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Snapshot operasional (dipanggil setiap polling — harus ringan)
-- ---------------------------------------------------------------------------
create or replace function public.inbound_operational_snapshot(
  p_site_code text default null,
  p_days_back integer default 7
)
returns jsonb language sql stable security definer set search_path = public as $$
  with bounds as (
    select
      greatest(least(coalesce(p_days_back, 7), 90), 0) as days_back,
      (timezone('Asia/Jakarta', now()) - interval '4 hours')::date as today,
      nullif(upper(btrim(coalesce(p_site_code, ''))), '') as site
  ),
  scoped as (
    select r.* from public.inbound_operational_rows r, bounds b
     where (b.site is null or r.site_code = b.site)
       -- Tiket tanpa operational_date (data lama) tetap ikut supaya tidak hilang.
       and (r.operational_date is null
            or r.operational_date::date >= b.today - b.days_back)
  ),
  checkers as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'mp_id', mp_id, 'checker_id', mp_id, 'checker_name', checker_name)
           order by checker_name), '[]'::jsonb) as rows
      from public.checker_master where active
  ),
  sites as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'site_code', site_code, 'location_id', location_id, 'site_name', site_name,
             'short_name', short_name, 'gate_prefix', gate_prefix, 'gate_count', gate_count)
           order by sort_order), '[]'::jsonb) as rows
      from public.site_master where active
  ),
  gates as (
    select coalesce(jsonb_agg(gate_name order by site_code, gate_index), '[]'::jsonb) as rows
      from public.inbound_active_gates()
  ),
  payload as (
    select coalesce(jsonb_agg(to_jsonb(scoped) order by scoped.created_at desc, scoped.ticket_po_id),
                    '[]'::jsonb) as rows,
           count(*)::int as row_count,
           max(scoped.row_updated_at) as max_updated_at
      from scoped
  )
  select jsonb_build_object(
    'status', 'success',
    'timestamp', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'operational_date', (select today::text from bounds),
    'site_code', (select site from bounds),
    'sites', sites.rows,
    'gates', gates.rows,
    'outputForm', payload.rows,
    'inboundMp', checkers.rows,
    -- Fingerprint dipakai untuk ETag: jumlah baris + timestamp perubahan terakhir.
    'fingerprint', md5(payload.row_count::text || '|' || coalesce(payload.max_updated_at::text, '-'))
  ) from payload, checkers, sites, gates;
$$;

-- ---------------------------------------------------------------------------
-- 2. Delta operasional (hanya baris yang berubah + daftar id yang masih hidup)
-- ---------------------------------------------------------------------------
create or replace function public.inbound_operational_delta(
  p_since timestamptz,
  p_site_code text default null,
  p_days_back integer default 7
)
returns jsonb language sql stable security definer set search_path = public as $$
  with bounds as (
    select
      greatest(least(coalesce(p_days_back, 7), 90), 0) as days_back,
      (timezone('Asia/Jakarta', now()) - interval '4 hours')::date as today,
      nullif(upper(btrim(coalesce(p_site_code, ''))), '') as site
  ),
  scoped as (
    select r.* from public.inbound_operational_rows r, bounds b
     where (b.site is null or r.site_code = b.site)
       and (r.operational_date is null
            or r.operational_date::date >= b.today - b.days_back)
  ),
  changed as (
    select coalesce(jsonb_agg(to_jsonb(scoped) order by scoped.created_at desc, scoped.ticket_po_id),
                    '[]'::jsonb) as rows
      from scoped where scoped.row_updated_at > p_since
  ),
  alive as (
    select coalesce(jsonb_agg(distinct scoped.ticket_id), '[]'::jsonb) as ids from scoped
  ),
  checkers as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'mp_id', mp_id, 'checker_id', mp_id, 'checker_name', checker_name)
           order by checker_name), '[]'::jsonb) as rows
      from public.checker_master where active
  )
  select jsonb_build_object(
    'status', 'success',
    'timestamp', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'outputForm', changed.rows,
    'ticket_ids', alive.ids,
    'inboundMp', checkers.rows
  ) from changed, alive, checkers;
$$;

-- ---------------------------------------------------------------------------
-- 3. Master PO untuk halaman Daftar (berat, tapi jarang berubah → cocok di-ETag)
-- ---------------------------------------------------------------------------
create or replace function public.inbound_po_master(p_site_code text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with scoped as (
    select p.* from public.superset_po_public p
     where nullif(upper(btrim(coalesce(p_site_code, ''))), '') is null
        or p.site_code = upper(btrim(p_site_code))
  ),
  payload as (
    select coalesce(jsonb_agg(to_jsonb(scoped) order by scoped.po_number), '[]'::jsonb) as rows,
           count(*)::int as row_count,
           max(scoped.synced_at) as last_synced_at
      from scoped
  )
  select jsonb_build_object(
    'status', 'success',
    'timestamp', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'tablev2', payload.rows,
    'total', payload.row_count,
    'last_synced_at', payload.last_synced_at,
    'fingerprint', md5(payload.row_count::text || '|' || coalesce(payload.last_synced_at::text, '-'))
  ) from payload;
$$;

-- Fingerprint saja: dipakai untuk memutuskan HTTP 304 tanpa membangun payload.
create or replace function public.inbound_po_master_fingerprint(p_site_code text default null)
returns text language sql stable security definer set search_path = public as $$
  select md5(count(*)::text || '|' || coalesce(max(p.synced_at)::text, '-'))
    from public.superset_po_public p
   where nullif(upper(btrim(coalesce(p_site_code, ''))), '') is null
      or p.site_code = upper(btrim(p_site_code));
$$;

-- ---------------------------------------------------------------------------
-- 4. Outbox GSheet: klaim batch dan tutup batch dalam satu round-trip
-- ---------------------------------------------------------------------------
create or replace function public.inbound_claim_gsheet_batch(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ids text[]; v_rows jsonb;
begin
  -- SKIP LOCKED mencegah dua worker cron mengirim baris yang sama ke Google.
  with picked as (
    select ticket_po_id from public.gsheet_sync_outbox
     where sync_status in ('PENDING','FAILED') and attempt_count < 10
     order by created_at
     limit greatest(least(coalesce(p_limit,100), 500), 1)
     for update skip locked
  ), claimed as (
    update public.gsheet_sync_outbox o
       set sync_status='PROCESSING', attempt_count=o.attempt_count+1, updated_at=now()
      from picked where o.ticket_po_id = picked.ticket_po_id
    returning o.ticket_po_id
  )
  select coalesce(array_agg(ticket_po_id), array[]::text[]) into v_ids from claimed;

  if cardinality(v_ids)=0 then return jsonb_build_object('ticket_po_ids','[]'::jsonb,'rows','[]'::jsonb); end if;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_rows
    from public.inbound_operational_rows r where r.ticket_po_id = any(v_ids);

  return jsonb_build_object('ticket_po_ids', to_jsonb(v_ids), 'rows', v_rows);
end; $$;

create or replace function public.inbound_settle_gsheet_batch(
  p_ticket_po_ids text[], p_success boolean, p_error text default null
)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update public.gsheet_sync_outbox
     set sync_status = case when p_success then 'SYNCED' else 'FAILED' end,
         last_error  = case when p_success then null else left(coalesce(p_error,'unknown'), 500) end,
         synced_at   = case when p_success then now() else synced_at end,
         updated_at  = now()
   where ticket_po_id = any(p_ticket_po_ids);
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

-- Baris PROCESSING yang menggantung (function timeout / cold start) harus bisa
-- dicoba ulang, bukan terkunci selamanya.
create or replace function public.inbound_reap_stuck_gsheet(p_older_than interval default interval '10 minutes')
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update public.gsheet_sync_outbox
     set sync_status='FAILED', last_error='Reclaimed stuck PROCESSING row', updated_at=now()
   where sync_status='PROCESSING' and updated_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

create index if not exists gsheet_outbox_pending_idx
  on public.gsheet_sync_outbox(created_at)
  where sync_status in ('PENDING','FAILED');

-- ---------------------------------------------------------------------------
-- 5. Health check murah
-- ---------------------------------------------------------------------------
create or replace function public.inbound_health()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'backend', 'supabase',
    'checked_at', now(),
    'active_sites', (select coalesce(jsonb_agg(site_code order by sort_order), '[]'::jsonb)
                       from public.site_master where active),
    'tickets_today', (select count(*)::int from public.tickets
                       where operational_date = (timezone('Asia/Jakarta', now()) - interval '4 hours')::date),
    'po_master_rows', (select count(*)::int from public.superset_po_public),
    'gsheet_backlog', (select count(*)::int from public.gsheet_sync_outbox
                        where sync_status in ('PENDING','FAILED')),
    'last_superset_sync', (select max(finished_at) from public.sync_runs
                            where sync_name='superset_po' and status='SUCCESS')
  );
$$;

grant execute on function public.inbound_operational_snapshot(text,integer) to service_role;
grant execute on function public.inbound_operational_delta(timestamptz,text,integer) to service_role;
grant execute on function public.inbound_po_master(text) to service_role;
grant execute on function public.inbound_po_master_fingerprint(text) to service_role;
grant execute on function public.inbound_claim_gsheet_batch(integer) to service_role;
grant execute on function public.inbound_settle_gsheet_batch(text[],boolean,text) to service_role;
grant execute on function public.inbound_reap_stuck_gsheet(interval) to service_role;
grant execute on function public.inbound_health() to service_role;

commit;
