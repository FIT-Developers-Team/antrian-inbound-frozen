-- ============================================================================
-- ANTRIAN INBOUND FROZEN — PAPAN ANTREAN
--
-- Migrasi ini merampingkan permukaan backend agar sesuai dengan aplikasi yang
-- sudah dirampingkan: satu papan, empat aksi.
--
-- Masalah yang diperbaiki
-- -----------------------
--
-- 1. `inbound_operational_snapshot` mengembalikan view yang sudah "diledakkan"
--    per PO (`inbound_operational_rows` = tickets × ticket_pos). Tiket dengan
--    delapan PO mengirim delapan baris yang hampir identik, masing-masing
--    membawa payload tiket lengkap. Papan hanya perlu satu baris per tiket.
--    `inbound_board` mengagregasi PO menjadi satu baris.
--
-- 2. Tidak ada satu pun fungsi untuk memanggil driver, menyelesaikan bongkar,
--    atau membatalkan tiket; ketiganya sebelumnya menumpang `updatechecker`
--    dan `update_ticket_status` dengan payload yang berbeda-beda.
--
-- 3. Riwayat untuk laporan diambil lewat `export_rows` yang menarik SELURUH
--    tabel tanpa batas tanggal, lalu disaring di browser.
--
-- Aturan SLA TIDAK diubah di sini. Ia tetap hidup di
-- `public.inbound_sla_target_hours()` dari migrasi 20260901010000, dan tetap
-- menjadi satu-satunya sumber kebenaran.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Papan antrean — satu baris per tiket
--
-- PO diagregasi menjadi daftar nomor, total qty, dan total SKU. Total SKU juga
-- yang menentukan tier SLA untuk armada CDD/CDE, jadi ia harus dihitung
-- sebelum target SLA, bukan sesudah.
-- ---------------------------------------------------------------------------
create or replace view public.inbound_board
with (security_invoker = true) as
with po_rollup as (
  select
    ticket_id,
    string_agg(po_number, ', ' order by created_at, ticket_po_id) as po_numbers,
    count(*)::int                                                  as po_count,
    coalesce(sum(request_quantity), 0)                             as total_qty,
    coalesce(sum(count_sku), 0)::int                               as total_sku,
    max(gr_done_at)                                                as last_gr_done_at,
    count(*) filter (where upper(coalesce(gr_status, '')) = 'DONE GR') = count(*) as all_done_gr,
    max(updated_at)                                                as po_updated_at
  from public.ticket_pos
  group by ticket_id
)
select
  t.ticket_id,
  t.queue_no,
  t.ticket_type,
  t.status,
  t.site_code,
  t.vendor_name,
  t.fleet_type,
  t.plat_number,
  t.driver_name,
  t.driver_phone,
  t.gate,
  t.slot,
  t.operational_date::text as operational_date,
  t.registered_by,
  t.source,
  t.arrived_at,
  t.called_at,
  t.call_count,
  t.start_unloading_at,
  t.done_unloading_at,
  t.expired_at,
  t.expired_reason,
  t.created_at,
  t.updated_at,

  coalesce(p.po_numbers, '')   as po_numbers,
  coalesce(p.po_count, 0)      as po_count,
  coalesce(p.total_qty, 0)     as total_qty,
  coalesce(p.total_sku, 0)     as total_sku,

  -- ---- SLA dihitung server ------------------------------------------------
  public.inbound_sla_target_hours(t.fleet_type, coalesce(p.total_sku, 0)) as sla_target_hours,

  case
    when public.inbound_sla_target_hours(t.fleet_type, coalesce(p.total_sku, 0)) > 0
     and t.start_unloading_at is not null
    then t.start_unloading_at
         + make_interval(hours => public.inbound_sla_target_hours(t.fleet_type, coalesce(p.total_sku, 0)))
  end as sla_deadline_at,

  t.start_unloading_at as sla_started_at,

  -- Jam berhenti: seluruh PO selesai GR, bongkar ditandai selesai, atau tiket
  -- dibatalkan. `coalesce` berurutan supaya penyelesaian yang paling spesifik
  -- selalu menang.
  coalesce(
    case when p.all_done_gr then p.last_gr_done_at end,
    t.done_unloading_at,
    t.expired_at
  ) as sla_stopped_at,

  greatest(t.updated_at, coalesce(p.po_updated_at, t.updated_at)) as row_updated_at

from public.tickets t
left join po_rollup p on p.ticket_id = t.ticket_id;

comment on view public.inbound_board is
  'Satu baris per tiket dengan PO teragregasi dan tenggat SLA yang dihitung server. Sumber tunggal papan antrean.';

-- ---------------------------------------------------------------------------
-- 2. Snapshot papan
--
-- Dibungkus fingerprint agar Edge Function dapat menjawab 304 tanpa membangun
-- payload sama sekali ketika tidak ada yang berubah sejak polling sebelumnya.
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
  )
  select jsonb_build_object(
    'operational_date', (select today::text from bounds),
    'site_code', (select site from bounds),
    'rows', payload.rows,
    'sites', sites.rows,
    'gates', gates.rows,
    'checkers', checkers.rows,
    'fingerprint', md5(payload.row_count::text || '|' || coalesce(payload.max_updated_at::text, '-'))
  ) from payload, sites, gates, checkers;
$$;

-- ---------------------------------------------------------------------------
-- 3. Riwayat untuk laporan
--
-- Dibatasi rentang tanggal di server. Sebelumnya laporan menarik seluruh tabel
-- dan menyaringnya di browser.
-- ---------------------------------------------------------------------------
create or replace function public.inbound_history(
  p_site_code text default null,
  p_from date default null,
  p_to date default null
)
returns jsonb language sql stable security definer set search_path = public as $$
  with bounds as (
    select
      nullif(upper(btrim(coalesce(p_site_code, ''))), '') as site,
      coalesce(p_from, (timezone('Asia/Jakarta', now()) - interval '7 days')::date) as from_date,
      coalesce(p_to, (timezone('Asia/Jakarta', now()))::date) as to_date
  )
  select jsonb_build_object(
    'from', (select from_date::text from bounds),
    'to', (select to_date::text from bounds),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.created_at desc)
        from public.inbound_board b, bounds x
       where (x.site is null or b.site_code = x.site)
         and b.operational_date::date between x.from_date and x.to_date
       -- Batas atas menjaga payload tetap wajar; rentang yang lebih besar
       -- dipersempit oleh operator lewat filter tanggal.
       limit 5000
    ), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- 4. Memanggil driver ke gate
-- ---------------------------------------------------------------------------
create or replace function public.inbound_call_ticket(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id   text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_gate text := nullif(btrim(p_payload->>'gate'), '');
  v_row  public.tickets;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;
  if v_gate is null then raise exception 'Gate wajib ditentukan saat memanggil driver.'; end if;

  select * into v_row from public.tickets where ticket_id = v_id;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if upper(coalesce(v_row.status, '')) in ('COMPLETED', 'EXPIRED') then
    raise exception 'Ticket sudah % dan tidak dapat dipanggil.', upper(v_row.status);
  end if;

  update public.tickets set
    status       = case when upper(status) = 'UNLOADING' then status else 'CALLED' end,
    gate         = v_gate,
    -- Panggilan pertama menetapkan called_at; panggilan ulang hanya menaikkan
    -- pencacah, karena menggeser called_at akan menghapus jejak berapa lama
    -- driver sebenarnya sudah ditunggu.
    called_at    = coalesce(called_at, now()),
    last_call_at = now(),
    call_count   = call_count + 1,
    arrived_at   = coalesce(arrived_at, now())
  where ticket_id = v_id
  returning * into v_row;

  insert into public.ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'DRIVER_CALLED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('gate', v_gate, 'call_count', v_row.call_count));
  perform public.inbound_requeue_gsheet(array[v_id]);

  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- 5. Menyelesaikan bongkar
--
-- Menutup jam SLA sekaligus menandai seluruh PO selesai, sehingga operator
-- tidak perlu menutup PO satu per satu hanya agar hitung mundur berhenti.
-- ---------------------------------------------------------------------------
create or replace function public.inbound_finish_unloading(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id       text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_finished timestamptz := now();
  v_row      public.tickets;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;

  select * into v_row from public.tickets where ticket_id = v_id;
  if not found then raise exception 'Ticket tidak ditemukan.'; end if;
  if v_row.start_unloading_at is null then
    raise exception 'Bongkar belum pernah dimulai untuk ticket ini.';
  end if;

  -- Idempoten seperti mulai bongkar: menekan dua kali tidak menggeser jam
  -- selesai, karena itu akan mengubah hasil penilaian SLA yang sudah tercatat.
  v_finished := coalesce(v_row.done_unloading_at, v_finished);

  update public.tickets set
    status            = 'COMPLETED',
    done_unloading_at = v_finished
  where ticket_id = v_id
  returning * into v_row;

  update public.ticket_pos set
    checker_status     = 'DONE',
    checking_done_at   = coalesce(checking_done_at, v_finished),
    gr_status          = 'DONE GR',
    gr_done_at         = coalesce(gr_done_at, v_finished)
  where ticket_id = v_id and upper(coalesce(gr_status, '')) <> 'DONE GR';

  insert into public.ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'UNLOADING_FINISHED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('finished_at', v_finished));
  perform public.inbound_requeue_gsheet(array[v_id]);

  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- 6. Membatalkan tiket
-- ---------------------------------------------------------------------------
create or replace function public.inbound_cancel_ticket(p_payload jsonb, p_actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id     text := btrim(coalesce(p_payload->>'ticket_id', ''));
  v_reason text := coalesce(nullif(btrim(p_payload->>'reason'), ''), 'Dibatalkan operator');
  v_row    public.tickets;
begin
  if v_id = '' then raise exception 'ticket_id wajib diisi.'; end if;

  update public.tickets set
    status         = 'EXPIRED',
    expired_at     = coalesce(expired_at, now()),
    expired_reason = v_reason
  where ticket_id = v_id and upper(coalesce(status, '')) <> 'COMPLETED'
  returning * into v_row;

  if not found then
    raise exception 'Ticket tidak ditemukan atau sudah selesai.';
  end if;

  insert into public.ticket_events(ticket_id, event_type, actor_role, actor_name, payload_json)
    values(v_id, 'TICKET_CANCELLED', p_actor->>'role', p_actor->>'name',
           jsonb_build_object('reason', v_reason));
  perform public.inbound_requeue_gsheet(array[v_id]);

  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- 7. Index untuk jalur kueri papan
--
-- Papan selalu menyaring per gudang dan per hari operasional, lalu mengurutkan
-- dari yang terbaru. Index gabungan ini yang membuatnya tetap satu index scan
-- ketika tabel tiket tumbuh.
-- ---------------------------------------------------------------------------
create index if not exists tickets_board_idx
  on public.tickets(site_code, operational_date desc, created_at desc);

create index if not exists ticket_pos_rollup_idx
  on public.ticket_pos(ticket_id) include (request_quantity, count_sku, gr_status, gr_done_at);

grant execute on function public.inbound_board_snapshot(text, integer) to service_role;
grant execute on function public.inbound_history(text, date, date) to service_role;
grant execute on function public.inbound_call_ticket(jsonb, jsonb) to service_role;
grant execute on function public.inbound_finish_unloading(jsonb, jsonb) to service_role;
grant execute on function public.inbound_cancel_ticket(jsonb, jsonb) to service_role;

commit;
