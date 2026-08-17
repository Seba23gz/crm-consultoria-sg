-- Meta Lead Ads: tabla companera de `leads` con todo lo propio de Meta.
--
-- Por que una tabla aparte y no columnas nuevas en `leads`: `leads` es la tabla
-- generica del pipeline, la usa todo el CRM. Meterle ocho columnas que solo
-- aplican a un origen la ensucia. `meta_leads` guarda el detalle crudo, el estado
-- del procesamiento del webhook, y apunta al lead que genero.
--
-- Aditiva: no toca ni borra nada existente. El rollback esta en
-- 20260816173000_meta_leads_down.sql.
--
-- Los nombres de las columnas de estado van en ingles (status, attempt_count,
-- last_attempt_at, last_error, processed_at) por pedido explicito; el resto del
-- esquema del CRM esta en espanol.

create table if not exists public.meta_leads (
  id bigint generated always as identity primary key,

  -- leadgen_id de Meta. Es la clave de idempotencia de toda la integracion.
  meta_lead_id text not null,

  -- A donde fue a parar en el CRM. Nulos mientras se procesa o si fallo.
  lead_id bigint references public.leads(id) on delete set null,
  contacto_id bigint references public.contactos(id) on delete set null,
  empresa_id bigint references public.empresas(id) on delete set null,

  -- Copia de los campos estandar tal como los mando Meta, para poder auditar
  -- sin depender de que el contacto siga existiendo o lo hayan editado.
  nombre text,
  email text,
  telefono text,
  empresa text,
  cargo text,
  ciudad text,

  -- Trazabilidad de la pauta.
  -- page_id viene del webhook; form_id y ad_id, del webhook y de Graph API.
  form_id text,
  page_id text,
  ad_id text,
  -- Estos tres NO se piden a Graph API: no estan documentados en el nodo lead de
  -- v26.0 y pedirlos devolveria 400. Quedan para rellenar despues (por ejemplo
  -- consultando el nodo del anuncio en un proceso aparte).
  adset_id text,
  campaign_id text,
  plataforma text,
  es_organico boolean,

  -- Todas las respuestas del formulario con los nombres originales de Meta,
  -- incluidas las preguntas personalizadas. Nada se descarta.
  respuestas jsonb not null default '{}'::jsonb,

  -- Respuesta normalizada de Graph API (sin tokens). Sirve para reprocesar.
  payload jsonb,

  fuente text not null default 'meta_lead_ads',

  -- Estado del procesamiento del webhook, no del pipeline comercial
  -- (ese vive en leads.etapa).
  --
  --   pending    -> fila creada pero sin reclamar (no la produce el webhook;
  --                 queda disponible para reencolar a mano)
  --   processing -> alguien la reclamo y la esta procesando ahora
  --   completed  -> lead creado en el CRM; es terminal
  --   failed     -> el intento fallo; se puede volver a reclamar
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  processed_at timestamptz,

  creado_en_meta timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotencia: Meta reintenta la misma entrega varias veces. Esta restriccion es
-- lo que hace que dos entregas simultaneas no puedan crear dos contactos.
create unique index if not exists meta_leads_meta_lead_id_uidx
  on public.meta_leads (meta_lead_id);

-- Para el diagnostico y para encontrar `processing` abandonados.
create index if not exists meta_leads_status_idx
  on public.meta_leads (status, last_attempt_at) where status <> 'completed';

create index if not exists meta_leads_lead_id_idx
  on public.meta_leads (lead_id);

comment on table public.meta_leads is
  'Leads que entraron por formularios instantaneos de Meta (Facebook/Instagram). Una fila por leadgen_id.';
comment on column public.meta_leads.meta_lead_id is
  'leadgen_id de Meta. Unico: es la clave de idempotencia del webhook.';
comment on column public.meta_leads.respuestas is
  'Respuestas del formulario con los nombres de campo originales de Meta, incluidas las preguntas personalizadas.';
comment on column public.meta_leads.payload is
  'Respuesta normalizada de Graph API para el lead. Nunca contiene tokens.';
comment on column public.meta_leads.status is
  'Estado del procesamiento del webhook: pending/processing/completed/failed. No es la etapa comercial.';
comment on column public.meta_leads.last_error is
  'Ultimo error, saneado: nunca contiene tokens ni el payload completo.';
comment on column public.meta_leads.page_id is
  'Id de la pagina de Facebook. Viene del webhook, no de Graph API: el nodo del lead no lo expone.';
comment on column public.meta_leads.adset_id is
  'No lo entrega el nodo lead en v26.0. Queda nulo salvo que se rellene por otra via.';
comment on column public.meta_leads.campaign_id is
  'No lo entrega el nodo lead en v26.0. Queda nulo salvo que se rellene por otra via.';
comment on column public.meta_leads.plataforma is
  'No lo entrega el nodo lead en v26.0. Queda nulo salvo que se rellene por otra via.';

-- ---------------------------------------------------------------------------
-- Reclamo atomico del lead
-- ---------------------------------------------------------------------------
--
-- Toda la decision de "quien procesa este lead" pasa por aca, en una sola
-- sentencia por rama, para que dos entregas simultaneas de Meta no puedan crear
-- dos contactos.
--
-- Devuelve:
--   claimed     -> reclamado por quien llama; hay que procesarlo
--   completed   -> ya se proceso antes; no hacer nada y responder 200
--   in_progress -> otro lo tiene reclamado hace poco; responder 503 y esperar
--
-- La recuperacion de un `processing` abandonado sale del propio WHERE: si
-- last_attempt_at es mas viejo que p_stale_after, se puede volver a reclamar. Eso
-- es lo que impide que una caida despues del reclamo bloquee el lead para siempre.

create or replace function public.reclamar_meta_lead(
  p_meta_lead_id text,
  p_form_id text default null,
  p_page_id text default null,
  p_ad_id text default null,
  p_created_time timestamptz default null,
  p_stale_after interval default interval '5 minutes'
)
returns table (resultado text, intento integer)
language plpgsql
-- search_path fijo: la funcion no debe resolver nombres segun quien la llame.
set search_path = public, pg_temp
as $$
begin
  -- 1) Primera vez que vemos este leadgen_id.
  return query
  insert into public.meta_leads as m (
    meta_lead_id, form_id, page_id, ad_id, creado_en_meta,
    status, attempt_count, last_attempt_at
  )
  values (
    p_meta_lead_id, p_form_id, p_page_id, p_ad_id, p_created_time,
    'processing', 1, now()
  )
  on conflict (meta_lead_id) do nothing
  returning 'claimed'::text, m.attempt_count;

  if found then
    return;
  end if;

  -- 2) Ya existia. Se puede reclamar si fallo, si nunca se reclamo, o si quedo
  --    colgada en `processing` mas alla del umbral.
  --
  --    En READ COMMITTED, si dos sesiones llegan a la vez, la segunda espera el
  --    lock de la primera y luego re-evalua este WHERE contra la fila ya
  --    actualizada: ve status='processing' con last_attempt_at recien puesto, no
  --    calza, y actualiza cero filas. Ahi esta la exclusion mutua.
  return query
  update public.meta_leads as m
     set status = 'processing',
         attempt_count = m.attempt_count + 1,
         last_attempt_at = now(),
         updated_at = now(),
         -- El webhook puede traer ids que a la fila le faltaban.
         form_id = coalesce(m.form_id, p_form_id),
         page_id = coalesce(m.page_id, p_page_id),
         ad_id = coalesce(m.ad_id, p_ad_id),
         creado_en_meta = coalesce(m.creado_en_meta, p_created_time)
   where m.meta_lead_id = p_meta_lead_id
     and (
       m.status in ('pending', 'failed')
       or (m.status = 'processing'
           and (m.last_attempt_at is null or m.last_attempt_at < now() - p_stale_after))
     )
  returning 'claimed'::text, m.attempt_count;

  if found then
    return;
  end if;

  -- 3) No se pudo reclamar: o ya esta listo, o hay otro trabajando en el.
  return query
  select
    case when m.status = 'completed' then 'completed'::text else 'in_progress'::text end,
    m.attempt_count
  from public.meta_leads as m
  where m.meta_lead_id = p_meta_lead_id;
end;
$$;

comment on function public.reclamar_meta_lead is
  'Reclamo atomico de un lead de Meta. Devuelve claimed/completed/in_progress. Recupera los processing abandonados pasado p_stale_after.';

-- ---------------------------------------------------------------------------
-- Persistencia transaccional del lead
-- ---------------------------------------------------------------------------
--
-- Crea o reutiliza empresa + contacto + lead, enlaza todo y cierra la fila como
-- `completed`. Una sola funcion, una sola transaccion.
--
-- Por que no cuatro llamadas sueltas desde la Edge Function: cada llamada de
-- PostgREST es su propia transaccion, asi que una caida entre la segunda y la
-- tercera dejaria una empresa y un contacto ya confirmados. El reintento tendria
-- que averiguar cuales existen, y este esquema no da para eso:
--
--   * `empresas.nombre` no es unico (hoy ya hay 4 nombres repetidos), asi que
--     buscar por nombre no garantiza acertar.
--   * 41 de 57 contactos no tienen correo, asi que deduplicar por email tampoco.
--
-- Con todo en una transaccion no hay escrituras parciales que reconciliar: o
-- queda todo, o no queda nada y el reintento arranca limpio.
--
-- Ademas, como segunda red, los ids ya creados quedan guardados en la propia fila
-- de meta_leads (lead_id / contacto_id / empresa_id) y se reutilizan por id, no
-- por heuristica, si alguna vez hubiera que reanudar.

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
-- search_path fijo: la funcion no debe resolver nombres segun quien la llame.
set search_path = public, pg_temp
as $$
declare
  v_fila public.meta_leads%rowtype;
  v_empresa bigint;
  v_contacto bigint;
  v_lead bigint;
begin
  -- FOR UPDATE: nadie mas puede cerrar este mismo lead mientras corre esto.
  select * into v_fila
    from public.meta_leads
   where meta_leads.meta_lead_id = p_meta_lead_id
   for update;

  if not found then
    raise exception 'meta_lead % no existe; hay que reclamarlo antes', p_meta_lead_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotencia dura: si ya se completo, no se escribe nada.
  if v_fila.status = 'completed' then
    return query select v_fila.lead_id, v_fila.contacto_id, v_fila.empresa_id, true;
    return;
  end if;

  -- 1) Empresa. Primero el checkpoint (por id), despues por nombre, y si no, se crea.
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

  -- 2) Contacto. Igual: checkpoint, luego correo, luego crear.
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

  -- 3) Lead. El unico parcial (origen, origen_id) lo vuelve idempotente por si un
  --    intento anterior alcanzo a escribirlo.
  v_lead := v_fila.lead_id;
  if v_lead is null then
    insert into public.leads (
      empresa_id, contacto_id, titulo, etapa, prioridad, notas,
      ultimo_contacto, origen, origen_id
    )
    values (
      v_empresa, v_contacto, coalesce(nullif(p_titulo, ''), 'Lead desde Meta Ads'),
      'nuevo', 'media', p_notas, current_date, 'meta_lead_ads', p_meta_lead_id
    )
    on conflict (origen, origen_id) where origen_id is not null do nothing
    returning id into v_lead;

    if v_lead is null then
      select l.id into v_lead
        from public.leads l
       where l.origen = 'meta_lead_ads' and l.origen_id = p_meta_lead_id;
    end if;
  end if;

  -- 4) Cierre. Misma transaccion: si algo de arriba falla, esto tampoco ocurre.
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

comment on function public.procesar_meta_lead is
  'Crea o reutiliza empresa+contacto+lead y cierra meta_leads como completed, todo en una transaccion. Idempotente: si la fila ya estaba completed no escribe nada.';

-- RLS igual que el resto del CRM: solo el usuario dueno.
-- La Edge Function entra con service_role, que salta RLS.
alter table public.meta_leads enable row level security;

drop policy if exists solo_dueno_meta_leads on public.meta_leads;
create policy solo_dueno_meta_leads on public.meta_leads
  for all to authenticated
  using (auth.uid() = '259591dc-71b4-4633-93a3-3a686dfd057e'::uuid)
  with check (auth.uid() = '259591dc-71b4-4633-93a3-3a686dfd057e'::uuid);

-- ---------------------------------------------------------------------------
-- Permisos de las funciones
-- ---------------------------------------------------------------------------
--
-- Ninguna de las dos usa SECURITY DEFINER, y es deliberado: no hace falta.
-- Quien las llama es la Edge Function con `service_role`, que ya salta RLS.
-- Un SECURITY DEFINER las haria correr con los privilegios del dueno de la
-- funcion, y entonces cualquiera que consiguiera ejecutarlas escribiria en el
-- CRM. Siendo SECURITY INVOKER (el valor por defecto), si algun dia se filtrara
-- el permiso de ejecucion al rol `authenticated`, seguiria topandose con RLS.
--
-- Aun asi las dos fijan `set search_path = public, pg_temp` explicitamente: sin
-- eso, quien las llama podria anteponer un esquema propio y hacer que
-- `meta_leads` o `contactos` resuelvan a tablas suyas.
--
-- PostgreSQL le da EXECUTE a PUBLIC por defecto en toda funcion nueva, y en
-- Supabase `anon` y `authenticated` son alcanzables desde el navegador con la
-- clave anon, que es publica. Por eso se revoca primero y se concede despues,
-- solo a service_role.

revoke all on function public.reclamar_meta_lead(text, text, text, text, timestamptz, interval)
  from public, anon, authenticated;
grant execute on function public.reclamar_meta_lead(text, text, text, text, timestamptz, interval)
  to service_role;

revoke all on function public.procesar_meta_lead(
  text, text, text, text, text, text, text, text, text, jsonb, jsonb, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.procesar_meta_lead(
  text, text, text, text, text, text, text, text, text, jsonb, jsonb, text, text, timestamptz
) to service_role;

-- La tabla tampoco se expone al rol anonimo: el CRM entra autenticado y RLS
-- limita al usuario dueno. `anon` no debe poder leer datos personales de leads.
revoke all on table public.meta_leads from anon;
