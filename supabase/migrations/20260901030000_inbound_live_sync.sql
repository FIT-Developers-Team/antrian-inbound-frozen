-- ============================================================================
-- ANTRIAN INBOUND FROZEN — KESEGARAN DATA SUMBER (PGS 160)
--
-- Papan antrean sudah menarik ulang datanya sendiri tiap 15 detik, tetapi
-- kesegaran ITU hanya mengukur perjalanan Supabase → browser. Yang tidak
-- terlihat sama sekali adalah perjalanan sebelumnya: Superset (location_id
-- 160) → `superset_po_master`, yang berjalan lewat cron tiap lima menit.
--
-- Bila cron mati atau cookie Superset kedaluwarsa, papan tetap tampak "live"
-- karena tiket tetap mengalir, sementara master PO diam-diam membeku. Operator
-- baru menyadarinya saat sebuah PO yang jelas-jelas ada ditolak dengan pesan
-- "PO tidak ditemukan di master gudang aktif".
--
-- Migrasi ini membawa status kedua rantai itu ke dalam satu snapshot papan,
-- sehingga UI dapat menampilkannya tanpa permintaan tambahan.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Ringkasan kesegaran sumber, per gudang aktif
--
-- Ringan dengan sengaja: hanya agregat, tanpa contoh baris. Ia ikut di setiap
-- snapshot papan, jadi tidak boleh menambah biaya yang berarti.
-- ---------------------------------------------------------------------------
create or replace function public.inbound_source_freshness(p_site_code text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with bounds as (
    select nullif(upper(btrim(coalesce(p_site_code, ''))), '') as site
  ),
  scoped as (
    select m.synced_at, s.site_code, s.location_id
      from public.superset_po_master m
      join public.site_master s on s.location_id = m.location_id and s.active
      cross join bounds b
     where b.site is null or s.site_code = b.site
  ),
  master as (
    select
      count(*)::int             as total_po,
      max(synced_at)            as last_synced_at,
      min(location_id)          as location_id,
      min(site_code)            as site_code
    from scoped
  ),
  last_run as (
    select status, finished_at, fetched_count, written_count, error_message
      from public.sync_runs
     where sync_name = 'superset'
     order by started_at desc
     limit 1
  )
  select jsonb_build_object(
    'location_id',   master.location_id,
    'site_code',     master.site_code,
    'total_po',      coalesce(master.total_po, 0),
    'last_synced_at', master.last_synced_at,
    -- Umur dalam detik dihitung server: jam browser di tablet gudang kerap
    -- meleset beberapa menit, dan "sync 4 menit lalu" yang dihitung dari jam
    -- yang salah justru menyembunyikan sync yang benar-benar macet.
    'age_seconds',   case when master.last_synced_at is not null
                          then extract(epoch from (now() - master.last_synced_at))::int end,
    'last_run_status',  (select status from last_run),
    'last_run_at',      (select finished_at from last_run),
    'last_run_rows',    (select written_count from last_run),
    'last_run_error',   (select error_message from last_run)
  ) from master;
$$;

-- ---------------------------------------------------------------------------
-- 2. Snapshot papan membawa kesegaran sumber
--
-- `create or replace` sehingga aman dijalankan ulang di atas versi mana pun
-- dari migrasi 20260901020000.
-- ---------------------------------------------------------------------------
create or replace function public.inbound_board_snapshot(
  p_site_code text default null,
  p_days_back integer default 2
)
returns jsonb language sql stable security definer set search_path = public as $$
  with bounds as (
    select
      greatest(least(coalesce(p_days_back, 2), 30), 0) as days_back,
      -- Hari operasional bergeser empat jam: shift malam yang lewat tengah
      -- malam tetap dihitung sebagai hari yang sama.
      (timezone('Asia/Jakarta', now()) - interval '4 hours')::date as today,
      nullif(upper(btrim(coalesce(p_site_code, ''))), '') as site
  ),
  scoped as (
    select b.* from public.inbound_board b, bounds x
     where (x.site is null or b.site_code = x.site)
       and (b.operational_date is null
            or b.operational_date::date >= x.today - x.days_back)
  ),
  payload as (
    select
      coalesce(jsonb_agg(to_jsonb(scoped) order by scoped.created_at desc), '[]'::jsonb) as rows,
      count(*)::int as row_count,
      max(scoped.row_updated_at) as max_updated_at
    from scoped
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
  checkers as (
    select coalesce(jsonb_agg(jsonb_build_object('checker_id', mp_id, 'checker_name', checker_name)
           order by checker_name), '[]'::jsonb) as rows
      from public.checker_master where active
  ),
  freshness as (
    select public.inbound_source_freshness((select site from bounds)) as payload
  )
  select jsonb_build_object(
    'operational_date', (select today::text from bounds),
    'site_code', (select site from bounds),
    'server_time', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'rows', payload.rows,
    'sites', sites.rows,
    'gates', gates.rows,
    'checkers', checkers.rows,
    'source', freshness.payload,
    -- Fingerprint memuat kesegaran sumber juga. Tanpa itu, sync Superset yang
    -- baru masuk tidak akan pernah mengubah ETag selama tidak ada tiket yang
    -- berubah, dan indikator di layar akan membeku sampai tiket berikutnya.
    'fingerprint', md5(
      payload.row_count::text || '|' ||
      coalesce(payload.max_updated_at::text, '-') || '|' ||
      coalesce(freshness.payload->>'last_synced_at', '-'))
  ) from payload, sites, gates, checkers, freshness;
$$;

grant execute on function public.inbound_source_freshness(text) to service_role;
grant execute on function public.inbound_board_snapshot(text, integer) to service_role;

commit;
