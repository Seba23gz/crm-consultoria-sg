-- Meta Lead Ads: tabla companera de `leads` con todo lo propio de Meta.
--
-- Por que una tabla aparte y no columnas nuevas en `leads`: `leads` es la tabla
-- generica del pipeline, la usa todo el CRM. Meterle ocho columnas que solo
-- aplican a un origen la ensucia. `meta_leads` guarda el detalle crudo y apunta
-- al lead que genero.
--
-- Aditiva: no toca ni borra nada existente. El rollback esta en
-- 20260816173000_meta_leads_down.sql.

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

  -- Trazabilidad de la pauta. page_id viene del webhook; el resto, de Graph API.
  form_id text,
  page_id text,
  ad_id text,
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

  -- Estado del procesamiento, no del pipeline comercial (ese vive en leads.etapa).
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'procesado', 'error')),
  error_detalle text,
  intentos integer not null default 0,

  creado_en_meta timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotencia: Meta reintenta la misma entrega varias veces. El insert de esta
-- fila es la "reclamacion" del lead; el segundo choca con 23505 y se descarta.
create unique index if not exists meta_leads_meta_lead_id_uidx
  on public.meta_leads (meta_lead_id);

-- Para la vista de diagnostico: que quedo pendiente o fallado.
create index if not exists meta_leads_estado_idx
  on public.meta_leads (estado) where estado <> 'procesado';

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
comment on column public.meta_leads.estado is
  'Estado del procesamiento del webhook (pendiente/procesado/error), no del pipeline comercial.';
comment on column public.meta_leads.page_id is
  'Id de la pagina de Facebook. Viene del webhook, no de Graph API: el nodo del lead no lo expone.';

-- RLS igual que el resto del CRM: solo el usuario dueno.
-- La Edge Function entra con service_role, que salta RLS.
alter table public.meta_leads enable row level security;

drop policy if exists solo_dueno_meta_leads on public.meta_leads;
create policy solo_dueno_meta_leads on public.meta_leads
  for all to authenticated
  using (auth.uid() = '259591dc-71b4-4633-93a3-3a686dfd057e'::uuid)
  with check (auth.uid() = '259591dc-71b4-4633-93a3-3a686dfd057e'::uuid);
