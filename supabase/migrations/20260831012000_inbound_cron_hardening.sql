-- ============================================================================
-- ANTRIAN INBOUND FROZEN — PENGERASAN SCHEDULER
--
-- Perbaikan terhadap versi sebelumnya:
--   * Regex project ref Supabase menolak ref yang mengandung angka, sehingga
--     configure-cron gagal di sebagian project. Sekarang menerima [a-z0-9-].
--   * Job cron sebelumnya berbagi satu nilai vault yang dibaca ulang tiap run
--     tanpa penanda; sekarang setiap job punya nama eksplisit dan timeout.
--   * Ditambahkan job harian untuk membebaskan baris outbox yang menggantung.
-- ============================================================================
begin;

create or replace function public.configure_inbound_cron(p_function_base_url text, p_sync_secret text)
returns jsonb language plpgsql security definer set search_path=public,extensions,vault,cron as $$
declare
  v_job record;
  v_secret_id uuid;
  v_jobs text[] := array['inbound-sync-superset-5m','inbound-sync-gsheet-1m','inbound-reap-gsheet-15m'];
begin
  if p_function_base_url !~ '^https://[a-z0-9][a-z0-9-]*\.supabase\.co/functions/v1$' then
    raise exception 'Function base URL Supabase tidak valid: %', p_function_base_url;
  end if;
  if length(p_sync_secret) < 32 then raise exception 'SYNC secret minimal 32 karakter.'; end if;

  select id into v_secret_id from vault.secrets where name='inbound_sync_secret' limit 1;
  if v_secret_id is null then
    perform vault.create_secret(p_sync_secret,'inbound_sync_secret','Cron to Edge Function authorization');
  else
    perform vault.update_secret(v_secret_id,p_sync_secret,'inbound_sync_secret','Cron to Edge Function authorization');
  end if;

  for v_job in select jobid from cron.job where jobname = any(v_jobs) loop
    perform cron.unschedule(v_job.jobid);
  end loop;

  perform cron.schedule('inbound-sync-superset-5m','*/5 * * * *',format($job$
    select net.http_post(url := %L || '/sync-superset',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name='inbound_sync_secret' order by created_at desc limit 1)),
      body := jsonb_build_object('scheduled_at',now()),
      timeout_milliseconds := 120000);
  $job$,p_function_base_url));

  perform cron.schedule('inbound-sync-gsheet-1m','* * * * *',format($job$
    select net.http_post(url := %L || '/sync-gsheet',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name='inbound_sync_secret' order by created_at desc limit 1)),
      body := jsonb_build_object('scheduled_at',now()),
      timeout_milliseconds := 50000);
  $job$,p_function_base_url));

  -- Jaring pengaman lokal: tidak memanggil Edge Function, hanya membebaskan
  -- baris outbox yang tertinggal di status PROCESSING.
  perform cron.schedule('inbound-reap-gsheet-15m','*/15 * * * *',
    $job$ select public.inbound_reap_stuck_gsheet(interval '10 minutes'); $job$);

  return jsonb_build_object('superset','*/5 * * * *','gsheet','* * * * *','reaper','*/15 * * * *');
end; $$;

revoke all on function public.configure_inbound_cron(text,text) from public,anon,authenticated;
grant execute on function public.configure_inbound_cron(text,text) to postgres,service_role;

commit;
