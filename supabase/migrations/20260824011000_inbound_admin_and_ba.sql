begin;

create or replace function public.inbound_delete_tickets_by_date(p_operational_date date)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_ids text[]; v_tickets integer; v_pos integer; v_events integer;
begin
  select coalesce(array_agg(ticket_id),array[]::text[]) into v_ids from public.tickets
    where operational_date=p_operational_date or created_at::date=p_operational_date;
  if cardinality(v_ids)=0 then return jsonb_build_object('operational_date',p_operational_date::text,'tickets_deleted',0,'po_rows_deleted',0,'events_deleted',0); end if;
  delete from public.ticket_events where ticket_id=any(v_ids); get diagnostics v_events=row_count;
  delete from public.ticket_pos where ticket_id=any(v_ids); get diagnostics v_pos=row_count;
  update public.gates set status='KOSONG',ticket_id=null where ticket_id=any(v_ids);
  delete from public.tickets where ticket_id=any(v_ids); get diagnostics v_tickets=row_count;
  return jsonb_build_object('operational_date',p_operational_date::text,'tickets_deleted',v_tickets,'po_rows_deleted',v_pos,'events_deleted',v_events);
end; $$;

create or replace function public.inbound_delete_single_ticket(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_ticket public.tickets; v_tickets integer; v_pos integer; v_events integer;
begin
  select * into strict v_ticket from public.tickets where queue_no=btrim(p_payload->>'queue_no')
    and upper(replace(coalesce(plat_number,''),' ',''))=upper(replace(btrim(p_payload->>'plat_number'),' ',''))
    and operational_date=(p_payload->>'operational_date')::date;
  delete from public.ticket_events where ticket_id=v_ticket.ticket_id; get diagnostics v_events=row_count;
  delete from public.ticket_pos where ticket_id=v_ticket.ticket_id; get diagnostics v_pos=row_count;
  update public.gates set status='KOSONG',ticket_id=null where ticket_id=v_ticket.ticket_id;
  delete from public.tickets where ticket_id=v_ticket.ticket_id; get diagnostics v_tickets=row_count;
  return jsonb_build_object('deleted_ticket',to_jsonb(v_ticket),'tickets_deleted',v_tickets,'po_rows_deleted',v_pos,'events_deleted',v_events);
exception when no_data_found then raise exception 'Ticket tidak ditemukan. Pastikan Queue No, plat, dan tanggal operasional sudah tepat.';
end; $$;

create or replace function public.inbound_bulk_complete_operational(p_payload jsonb,p_actor jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_date date:=coalesce((p_payload->>'operational_date')::date,(timezone('Asia/Jakarta',now())-interval '4 hours')::date);
  v_all boolean:=coalesce((p_payload->>'all_active')::boolean,false); v_ids text[]; v_pos integer; v_tickets integer;
begin
  select coalesce(array_agg(ticket_id),array[]::text[]) into v_ids from public.tickets
    where upper(coalesce(status,'WAITING')) not in('COMPLETED','EXPIRED') and (v_all or operational_date=v_date);
  if cardinality(v_ids)=0 then return jsonb_build_object('operational_date',v_date::text,'all_active',v_all,'tickets_completed',0,'po_completed',0); end if;
  update public.ticket_pos set checker_id=coalesce(nullif(checker_id,''),p_actor->>'name'),checker_name=coalesce(nullif(checker_name,''),p_actor->>'name'),
    checker_status='DONE',checking_started_at=coalesce(checking_started_at,now()),checking_done_at=coalesce(checking_done_at,now()),
    actual_quantity=case when coalesce(actual_quantity,0)<=0 then coalesce(request_quantity,0) else actual_quantity end,
    gr_status='DONE GR',gr_done_at=coalesce(gr_done_at,now()),handover_grn_at=coalesce(handover_grn_at,now()) where ticket_id=any(v_ids);
  get diagnostics v_pos=row_count;
  update public.tickets set status='COMPLETED',called_at=coalesce(called_at,now()),start_unloading_at=coalesce(start_unloading_at,now()),
    done_unloading_at=coalesce(done_unloading_at,now()) where ticket_id=any(v_ids); get diagnostics v_tickets=row_count;
  insert into public.ticket_events(ticket_id,event_type,actor_role,actor_name,payload_json)
    select unnest(v_ids),'DEVELOPER_BULK_COMPLETE',p_actor->>'role',p_actor->>'name',jsonb_build_object('operational_date',v_date::text,'all_active',v_all);
  perform public.inbound_requeue_gsheet(v_ids);
  return jsonb_build_object('operational_date',v_date::text,'all_active',v_all,'tickets_completed',v_tickets,'po_completed',v_pos);
end; $$;

create or replace function public.inbound_create_ba(p_payload jsonb,p_actor jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_date date:=coalesce((p_payload->>'ba_date')::date,timezone('Asia/Jakarta',now())::date); v_key text;
  v_number integer; v_id uuid:=gen_random_uuid(); v_ba_number text; v_item jsonb; v_count integer:=0;
  v_reasons text[]:=array['MSLOR','BARANG RUSAK','KURANG KIRIM','TIDAK DATANG','LEBIH KIRIM','BARANG TIDAK ADA DI PO','TOLAK BEDA SKU','TOLAK BEDA GRAMASI','SALAH BAWA BARANG'];
begin
  v_key:=to_char(v_date,'YYYY-MM');
  insert into public.ba_sequences(sequence_key,last_number) values(v_key,1)
    on conflict(sequence_key) do update set last_number=ba_sequences.last_number+1,updated_at=now() returning last_number into v_number;
  v_ba_number:=lpad(v_number::text,6,'0')||'/CBT/'||to_char(v_date,'MM/YYYY');
  insert into public.ba_documents(ba_id,ba_number,ba_date,day_name,po_number,supplier_name,note,created_by,created_role)
    values(v_id,v_ba_number,v_date,coalesce(nullif(btrim(p_payload->>'day_name'),''),upper(to_char(v_date,'FMDay'))),
      nullif(btrim(p_payload->>'po_number'),''),nullif(btrim(p_payload->>'supplier_name'),''),nullif(btrim(p_payload->>'note'),''),
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

grant execute on function public.inbound_delete_tickets_by_date(date) to service_role;
grant execute on function public.inbound_delete_single_ticket(jsonb) to service_role;
grant execute on function public.inbound_bulk_complete_operational(jsonb,jsonb) to service_role;
grant execute on function public.inbound_create_ba(jsonb,jsonb) to service_role;

commit;
