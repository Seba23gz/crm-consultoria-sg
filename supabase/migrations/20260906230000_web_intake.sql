-- Aplicar ANTES de desplegar nuevo-lead. Aditiva; no modifica leads existentes.
-- Registro de idempotencia y estado del aviso. Solo accesible por service_role.
begin;
create table public.web_intake (
  request_id text primary key,
  payload_hash text not null,
  email_hash text not null,
  lead_id bigint references public.leads(id) on delete cascade,
  created_at timestamptz not null default now(),
  email_status text not null default 'pending' check (email_status in ('pending','sending','sent','failed')),
  email_attempts integer not null default 0,
  email_claimed_at timestamptz
);
create index web_intake_created_idx on public.web_intake(created_at);
create index web_intake_email_idx on public.web_intake(email_hash, created_at);
alter table public.web_intake enable row level security;
revoke all on public.web_intake from public, anon, authenticated;
grant select, insert, update on public.web_intake to service_role;

create function public.recibir_lead_web(p_request_id text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  previous public.web_intake%rowtype;
  company_id bigint;
  person_id bigint;
  opportunity_id bigint;
  email_key text := md5(lower(p_payload->>'email'));
begin
  -- Serializa el chequeo y la escritura: ni duplicados ni cuotas eludibles por concurrencia.
  perform pg_advisory_xact_lock(hashtextextended('veta-web-intake', 0));
  select * into previous from public.web_intake where request_id = p_request_id;
  if found then
    if previous.payload_hash <> encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex') then
      raise exception 'request_conflict';
    end if;
    return jsonb_build_object('duplicate', true, 'email_status', previous.email_status);
  end if;
  -- Cuotas persistentes compartidas por todas las instancias, sin guardar IP.
  if (select count(*) from public.web_intake where created_at > now() - interval '1 hour') >= 100
    or (select count(*) from public.web_intake where email_hash = email_key
        and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited';
  end if;
  if nullif(p_payload->>'empresa', '') is not null then
    select id into company_id from public.empresas
      where lower(nombre) = lower(p_payload->>'empresa') order by id limit 1;
    if company_id is null then
      insert into public.empresas(nombre, sitio_web)
      values (p_payload->>'empresa', nullif(p_payload->>'sitio', '')) returning id into company_id;
    end if;
  end if;
  select id into person_id from public.contactos
    where lower(email) = lower(p_payload->>'email') order by id limit 1;
  if person_id is null then
    insert into public.contactos(nombre, email, telefono, cargo, empresa_id)
    values (p_payload->>'nombre', p_payload->>'email', nullif(p_payload->>'telefono',''),
      nullif(p_payload->>'cargo',''), company_id) returning id into person_id;
  end if;
  insert into public.leads(empresa_id, contacto_id, titulo, etapa, prioridad, notas,
    ultimo_contacto, origen, necesidad, canales, presupuesto, sitio)
  values (company_id, person_id,
    case when p_payload->>'necesidad' <> '' then 'Interés: ' || (p_payload->>'necesidad') else 'Lead desde la web' end,
    'nuevo', 'media', nullif(p_payload->>'mensaje',''), current_date, 'web',
    nullif(p_payload->>'necesidad',''),
    array(select jsonb_array_elements_text(p_payload->'canales')),
    nullif(p_payload->>'presupuesto',''), nullif(p_payload->>'sitio',''))
  returning id into opportunity_id;
  insert into public.web_intake(request_id, payload_hash, email_hash, lead_id)
    values(p_request_id, encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex'), email_key, opportunity_id);
  return jsonb_build_object('duplicate', false, 'email_status', 'pending');
end;
$$;
revoke all on function public.recibir_lead_web(text,jsonb) from public, anon, authenticated;
grant execute on function public.recibir_lead_web(text,jsonb) to service_role;

-- Un único emisor por solicitud; una caída libera el reclamo al cabo de 2 min.
create function public.reclamar_aviso_web(p_request_id text)
returns boolean language sql security definer set search_path = public, pg_temp as $$
  with claimed as (
    update public.web_intake set email_status='sending', email_claimed_at=now(), email_attempts=email_attempts+1
    where request_id=p_request_id and email_status <> 'sent' and email_attempts < 5
      and (email_status <> 'sending' or email_claimed_at < now() - interval '2 minutes')
      -- Resend conserva la idempotencia durante 24 h: no reenvío automático fuera de esa ventana.
      and created_at > now() - interval '23 hours'
    returning 1
  ) select exists(select 1 from claimed);
$$;
revoke all on function public.reclamar_aviso_web(text) from public, anon, authenticated;
grant execute on function public.reclamar_aviso_web(text) to service_role;
commit;
