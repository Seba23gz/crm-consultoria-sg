-- Los leads de Meta no aparecian en la vista "Seguimientos".
--
-- Esa vista del CRM filtra por `proximo_seguimiento`, y la version anterior de
-- `procesar_meta_lead` lo dejaba nulo. Resultado: entraba un lead pagado, se
-- quedaba en la columna "Nuevo" del tablero, y nada avisaba. Para un lead que
-- respondio a un anuncio y espera contacto, ese retraso cuesta plata.
--
-- Ahora entra con `proximo_seguimiento = current_date`: aparece en Seguimientos
-- el mismo dia, como pendiente y sin marcarse vencido.
--
-- Es un `create or replace` de la funcion; el resto del cuerpo no cambia respecto
-- de 20260816173000_meta_leads.sql. Para revertir, volver a aplicar aquella.

create or replace function public.procesar_meta_lead(
  p_meta_lead_id text,
  p_nombre text,
  p_email text,
  p_telefono text,
  p_empresa text,
  p_cargo text,
  p_ciudad text,
  p_titulo text,
  p_notas text,
  p_respuestas jsonb,
  p_payload jsonb,
  p_form_id text default null,
  p_ad_id text default null,
  p_created_time timestamptz default null
)
returns table (lead_id bigint, contacto_id bigint, empresa_id bigint, ya_estaba boolean)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_fila public.meta_leads%rowtype;
  v_empresa bigint;
  v_contacto bigint;
  v_lead bigint;
begin
  select * into v_fila
    from public.meta_leads
   where meta_leads.meta_lead_id = p_meta_lead_id
   for update;

  if not found then
    raise exception 'meta_lead % no existe; hay que reclamarlo antes', p_meta_lead_id
      using errcode = 'no_data_found';
  end if;

  if v_fila.status = 'completed' then
    return query select v_fila.lead_id, v_fila.contacto_id, v_fila.empresa_id, true;
    return;
  end if;

  v_empresa := v_fila.empresa_id;
  if v_empresa is null and coalesce(p_empresa, '') <> '' then
    select e.id into v_empresa
      from public.empresas e
     where lower(e.nombre) = lower(p_empresa)
     order by e.id
     limit 1;

    if v_empresa is null then
      insert into public.empresas (nombre, ciudad, fuente)
      values (p_empresa, nullif(p_ciudad, ''), 'meta_lead_ads')
      returning id into v_empresa;
    end if;
  end if;

  v_contacto := v_fila.contacto_id;
  if v_contacto is null and coalesce(p_email, '') <> '' then
    select c.id into v_contacto
      from public.contactos c
     where lower(c.email) = lower(p_email)
     order by c.id
     limit 1;
  end if;

  if v_contacto is null then
    insert into public.contactos (nombre, cargo, email, telefono, empresa_id)
    values (
      coalesce(nullif(p_nombre, ''), 'Sin nombre'),
      nullif(p_cargo, ''),
      nullif(p_email, ''),
      nullif(p_telefono, ''),
      v_empresa
    )
    returning id into v_contacto;
  end if;

  v_lead := v_fila.lead_id;
  if v_lead is null then
    insert into public.leads (
      empresa_id, contacto_id, titulo, etapa, prioridad, notas,
      ultimo_contacto, proximo_seguimiento, origen, origen_id
    )
    values (
      v_empresa, v_contacto, coalesce(nullif(p_titulo, ''), 'Lead desde Meta Ads'),
      'nuevo', 'media', p_notas,
      current_date,
      -- Lo unico que cambia respecto de la version anterior.
      current_date,
      'meta_lead_ads', p_meta_lead_id
    )
    on conflict (origen, origen_id) where origen_id is not null do nothing
    returning id into v_lead;

    if v_lead is null then
      select l.id into v_lead
        from public.leads l
       where l.origen = 'meta_lead_ads' and l.origen_id = p_meta_lead_id;
    end if;
  end if;

  update public.meta_leads
     set lead_id = v_lead,
         contacto_id = v_contacto,
         empresa_id = v_empresa,
         nombre = nullif(p_nombre, ''),
         email = nullif(p_email, ''),
         telefono = nullif(p_telefono, ''),
         empresa = nullif(p_empresa, ''),
         cargo = nullif(p_cargo, ''),
         ciudad = nullif(p_ciudad, ''),
         respuestas = coalesce(p_respuestas, '{}'::jsonb),
         payload = p_payload,
         form_id = coalesce(meta_leads.form_id, p_form_id),
         ad_id = coalesce(meta_leads.ad_id, p_ad_id),
         creado_en_meta = coalesce(meta_leads.creado_en_meta, p_created_time),
         status = 'completed',
         last_error = null,
         processed_at = now(),
         updated_at = now()
   where meta_leads.meta_lead_id = p_meta_lead_id;

  return query select v_lead, v_contacto, v_empresa, false;
end;
$$;

-- `create or replace` conserva los permisos existentes, pero se reafirman por si
-- esta migracion se aplica sobre una base donde la funcion no existia.
revoke all on function public.procesar_meta_lead(
  text, text, text, text, text, text, text, text, text, jsonb, jsonb, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.procesar_meta_lead(
  text, text, text, text, text, text, text, text, text, jsonb, jsonb, text, text, timestamptz
) to service_role;
