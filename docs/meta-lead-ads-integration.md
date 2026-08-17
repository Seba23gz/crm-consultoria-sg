# Integración con Meta Lead Ads

Cómo entran al CRM los leads de los formularios instantáneos de Facebook e Instagram.

> **Sobre los pasos en Meta.** Todo lo que va bajo el título **En Meta (manual)** hay que
> hacerlo a mano en el panel de Meta: no se puede automatizar desde acá. Meta cambia los
> nombres y la ubicación de sus pantallas seguido, así que abajo se describe **qué** hay
> que lograr en cada paso; si un menú no se llama exactamente así, busca la opción
> equivalente. Donde no puedo confirmar el detalle exacto, está marcado.

## Arquitectura

Meta **no manda los datos del lead en el webhook**. Manda un `leadgen_id` y hay que ir a
buscar el contenido a Graph API con el token de la página. De ahí el ida y vuelta:

```
Formulario en FB/IG
        │
        │  1. POST con {leadgen_id, form_id, page_id, ad_id}
        ▼
Edge Function `meta-lead`  ──── valida X-Hub-Signature-256 (HMAC SHA-256)
        │
        │  2. reclamo atómico en meta_leads (status -> processing)
        │  3. GET /{leadgen_id}?fields=…   (Authorization: Bearer <page token>)
        ▼
   Graph API  ─────────────►  field_data + form_id + ad_id
        │
        │  4. normaliza y guarda
        ▼
Supabase Postgres
   meta_leads  (detalle crudo de Meta, una fila por leadgen_id)
   empresas / contactos / leads  (el pipeline de siempre)
        │
        │  5. recién ahora responde: 200 / 503 / 500
        ▼
      Meta
```

### Entrega durable: el 200 significa que el lead está guardado

El procesamiento es **síncrono**. La función no responde `200` hasta que el lead
está en la base. Si respondiera `200` de inmediato y procesara después en segundo
plano, un fallo posterior de Graph API o de Postgres perdería el lead para
siempre: Meta ya lo daría por entregado y no lo reenviaría.

| Situación | Código | Qué hace Meta |
|---|---|---|
| Lead guardado en este intento | `200` | Nada más |
| El lead ya estaba `completed` | `200` | Nada más |
| Fallo temporal: 429, 5xx, red, timeout, error de base de datos | `503` + `Retry-After: 60` | Reintenta |
| Otra entrega lo está procesando ahora mismo | `503` | Reintenta; la reentrega verá `completed` |
| Fallo permanente: token inválido/vencido, falta `leads_retrieval` | `500` | Reintenta, pero fallará igual hasta que arregles la configuración |
| Firma inválida | `401` | — |
| Evento que no es `leadgen` | `200` | Nada; se ignora sin ruido |

**El costo de esto**: la respuesta tarda más. Meta puede desactivar una
suscripción si el endpoint responde lento de forma sostenida, así que hay un
presupuesto de tiempo estricto de **10 s** por entrega (`PRESUPUESTO_TOTAL_MS` en
`index.ts`): la llamada a Graph tiene 4 s de timeout, un solo reintento con 300 ms
de espera, y si el presupuesto se acaba a media entrega el resto queda sin
reclamar y se devuelve `503`. Nunca hay esperas largas dentro del webhook.

**Cómo recuperarse de un error permanente (`500`).** El lead no se pierde: queda
en `meta_leads` con `status = 'failed'` y el detalle saneado en `last_error`.

1. Ver qué pasó: `select meta_lead_id, last_error, attempt_count from meta_leads where status = 'failed';`
2. Arreglar la causa (regenerar `META_PAGE_ACCESS_TOKEN`, o asignar el permiso que falte).
3. Reprocesar: como `failed` es reclamable, basta con reenviar el lead desde la
   herramienta de pruebas de Meta, o forzar el reintento con un `POST` firmado.
   No hay que borrar la fila.

### Por qué es una Edge Function y no `/api/meta/webhook`

Este repo no es una app con framework: la raíz es HTML estático que Vercel sirve sin build.
Los webhooks públicos del CRM ya viven como **Supabase Edge Functions** (`nuevo-lead`,
`email-evento`, `recordatorio-diario`, `importar-empresas`), que es donde está la clave
`service_role`. Se siguió esa convención.

Equivalencia con la ruta que se suele pedir en un proyecto Next.js:

| Convención habitual | Acá |
|---|---|
| `GET/POST /api/meta/webhook` | `GET/POST https://rayvimywyqjnzzmbagpv.supabase.co/functions/v1/meta-lead` |
| Middleware de auth desactivado para la ruta | `verify_jwt: false` en la función |
| Migración del ORM | SQL en `supabase/migrations/` |

Existe un `api/lead-form.js` (función serverless de Vercel), pero está **sin conectar** y el
README ya avisa que activarlo duplica leads. No se tocó, y **no** se agregó un segundo
endpoint de Meta ahí: dos webhooks activos para el mismo evento significan leads duplicados.

### Archivos

| Archivo | Qué hace |
|---|---|
| `supabase/functions/meta-lead/lib.ts` | Firma, verificación, parseo, normalización, flujo. Sin red ni DB |
| `supabase/functions/meta-lead/index.ts` | Wiring: Graph API con reintentos, Supabase, handler HTTP |
| `supabase/functions/meta-lead/lib_test.ts` | Pruebas (`deno task test`) |
| `supabase/functions/meta-lead/fixtures/` | Payloads de ejemplo, inventados |
| `supabase/migrations/20260816173000_meta_leads.sql` | Tabla `meta_leads` (+ `_down.sql` para revertir) |

### Estados e idempotencia

Cada `leadgen_id` tiene exactamente una fila en `meta_leads`, y su `status` gobierna todo:

```
                      ┌──────────────────────────────────────┐
                      │                                      │
   (fila nueva)       ▼                                      │
        │        ┌─────────┐   reclamo    ┌────────────┐     │
        └───────►│ pending │─────────────►│ processing │     │
                 └─────────┘              └────────────┘     │
                                            │        │       │
                              todo salió    │        │ falló │
                                  bien      │        ▼       │
                                            │   ┌────────┐   │
                                            │   │ failed │───┘
                                            │   └────────┘  reclamo
                                            ▼
                                      ┌───────────┐
                                      │ completed │  terminal
                                      └───────────┘
```

Más una arista que no se dibuja bien: `processing` **abandonado** (con
`last_attempt_at` de hace más de 5 minutos) vuelve a ser reclamable. Eso es lo que
impide que una caída justo después del reclamo deje el lead bloqueado para siempre.

La decisión de quién procesa vive entera en la función de Postgres
`reclamar_meta_lead`, no en TypeScript. Tiene que ser atómica: un `SELECT` seguido
de un `INSERT` desde la Edge Function dejaría pasar dos entregas simultáneas.

| Estado al llegar una entrega | Resultado del reclamo | Desenlace |
|---|---|---|
| No existe la fila | `claimed` (insert) | Se procesa |
| `pending` | `claimed` | Se procesa |
| `failed` | `claimed`, `attempt_count + 1` | Se reintenta |
| `processing` hace < 5 min | `in_progress` | No se toca. `503` |
| `processing` hace > 5 min | `claimed`, `attempt_count + 1` | Se recupera |
| `completed` | `completed` | No se toca. `200` |

**Dos entregas simultáneas nunca crean dos contactos.** El `INSERT ... ON CONFLICT
DO NOTHING` deja pasar a una sola; la segunda cae al `UPDATE`, que exige
`status IN ('pending','failed')` o un `processing` vencido. En `READ COMMITTED`, la
segunda sesión espera el lock de la primera y luego **re-evalúa** ese `WHERE`
contra la fila ya actualizada: ve `processing` con `last_attempt_at` recién puesto,
no calza, y actualiza cero filas. Ahí está la exclusión mutua.

Como segunda red, `leads` tiene su propio índice único `(origen, origen_id)`: si un
intento anterior alcanzó a escribir el lead antes de caerse, el reintento lo
reutiliza en vez de duplicarlo.

Campos de recuperación en la tabla: `status`, `attempt_count`, `last_attempt_at`,
`last_error` (saneado, nunca con tokens), `processed_at`, y `lead_id` /
`contacto_id` / `empresa_id` apuntando a lo que se creó.

## Variables de entorno

Van en **Supabase → Edge Functions → Secrets**, no en Vercel: la función corre en Supabase.
Los nombres están documentados en `.env.example` (solo nombres, nunca valores).

| Variable | Obligatoria | Para qué |
|---|---|---|
| `META_WEBHOOK_VERIFY_TOKEN` | sí | Se compara con `hub.verify_token` en el GET de verificación |
| `META_APP_SECRET` | sí | Valida la firma `X-Hub-Signature-256` de cada POST |
| `META_PAGE_ACCESS_TOKEN` | sí | Lee el lead desde Graph API |
| `META_GRAPH_API_VERSION` | no | Formato `vNN.N`. Por defecto **`v26.0`** |
| `META_PAGE_ID` | no | Solo si más adelante quieres filtrar por página |
| `RESEND_API_KEY`, `RESEND_FROM` | no | Aviso por correo. Sin la clave, no manda nada |

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` las inyecta Supabase sola.

> **Compatibilidad.** Si ya tenías cargado `META_VERIFY_TOKEN` (el nombre que usaba el
> README viejo), sigue funcionando: la función lo acepta como alternativa.
> `META_WEBHOOK_VERIFY_TOKEN` tiene prioridad.

### Campos que se piden a Graph API

Solo estos cinco, que son los documentados para el nodo del lead en v26.0:

```
id, created_time, field_data, form_id, ad_id
```

**`adset_id`, `campaign_id`, `platform` e `is_organic` no se piden.** No aparecen
en la referencia del nodo lead ni en los ejemplos de la
[guía de recuperación de leads](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/);
pedir un campo que la API no reconoce devuelve `400` y tumbaría **todos** los
leads, no solo ese campo.

Las columnas `adset_id`, `campaign_id`, `plataforma` y `es_organico` existen en
`meta_leads` y quedan en `NULL`. Si más adelante hacen falta, la vía es consultar
el nodo del anuncio (`/{ad_id}?fields=adset_id,campaign_id`) en un proceso aparte,
no dentro del webhook: sería una segunda llamada a Graph y el presupuesto de
tiempo es ajustado.

`page_id` sí se guarda, pero viene del webhook, no de Graph.

### Generar el token de verificación

Es una cadena cualquiera que inventas tú, y que pegas idéntica en los dos lados (Supabase y
Meta). Solo sirve para que Meta pruebe que la URL es tuya.

```bash
openssl rand -hex 32
```

No lo reutilices de otro servicio, no lo pongas en el repo y no lo mandes por chat.

## Puesta en marcha

### 1. Base de datos

Aplicar `supabase/migrations/20260816173000_meta_leads.sql`. Es aditiva: crea la tabla
`meta_leads` y nada más. No modifica ni borra datos existentes.

Para revertir: `supabase/migrations/20260816173000_meta_leads_down.sql`. Elimina la tabla y
su política. Los leads y contactos que la integración haya creado **no** se tocan; lo que se
pierde es el detalle crudo de Meta.

### 2. Desplegar la función

La función `meta-lead` debe quedar con **`verify_jwt: false`**: Meta no manda JWT, y la
autenticación real es la firma HMAC. Si se despliega con `verify_jwt: true`, Supabase
rechaza todas las entregas antes de que la función las vea.

### 3. En Meta (manual) — crear la app

En [developers.facebook.com](https://developers.facebook.com):

1. Crear una app de tipo **Negocio** (Business) y vincularla a tu cuenta de Meta Business.
2. Agregarle el producto **Webhooks**.
3. Anotar la **clave secreta de la app** (Configuración → Básica). Ese es `META_APP_SECRET`.

### 4. En Meta (manual) — registrar la URL del webhook

En el producto **Webhooks**, elegir el objeto **Página** (Page) y suscribirse:

- **URL de retrollamada:**
  `https://rayvimywyqjnzzmbagpv.supabase.co/functions/v1/meta-lead`
- **Token de verificación:** el mismo valor que cargaste en `META_WEBHOOK_VERIFY_TOKEN`.

Al pulsar *Verificar y guardar*, Meta hace un `GET` con `hub.mode=subscribe`,
`hub.verify_token` y `hub.challenge`. La función responde el challenge tal cual si el token
coincide, y `403` si no.

Después, **suscribir el campo `leadgen`** de ese objeto. Sin esa suscripción al campo, la
URL queda verificada pero no llega ningún evento.

### 5. En Meta (manual) — conectar la página de Veta Labs

La suscripción del webhook es a nivel de app; además hay que suscribir **la página**
concreta a esa app. Desde la misma pantalla de Webhooks se puede elegir la página, o por
Graph API:

```
POST /{page-id}/subscribed_apps?subscribed_fields=leadgen
```

(con un token de la página que tenga `pages_manage_metadata`).

Para comprobar que quedó:

```
GET /{page-id}/subscribed_apps
```

### 6. Obtener y renovar el token de la página

`META_PAGE_ACCESS_TOKEN` tiene que ser un **token de la página**, no de usuario, y de larga
duración.

El camino habitual, con el **Explorador de la API Graph**:

1. Elegir tu app y pedir los permisos `leads_retrieval`, `pages_show_list` y
   `pages_manage_metadata`.
2. Generar un token de usuario y aceptar los permisos.
3. Cambiarlo por un token de usuario de larga duración.
4. Pedir `GET /me/accounts` con ese token: en la respuesta viene el token de cada página.

Un token de página derivado de un token de usuario de larga duración **no expira por
tiempo**, pero sí se invalida si cambias la contraseña de Facebook, si revocas los permisos
de la app, o si pierdes el rol de administrador de la página. En ese caso hay que rehacer el
paso 4 y actualizar el secreto en Supabase.

Cuando el token muere, Graph responde con el código de error `190`. La función **no
reintenta** ese caso (no se arregla solo): marca el lead como `error` en `meta_leads` con el
detalle, para que no se pierda y puedas reprocesarlo.

Verificar la salud de un token: herramienta **Depurador de tokens de acceso** de Meta.

### 7. Permisos y revisión de la app

- **`leads_retrieval`** — imprescindible: sin él Graph API no entrega el `field_data`.
- **`pages_manage_metadata`** — para suscribir la página al webhook.
- **`pages_show_list`** — para listar tus páginas y sacar su token.
- Según qué más haga la app, Meta puede pedir **`pages_read_engagement`** o
  **`business_management`**.

Mientras la app esté **en modo desarrollo**, estos permisos funcionan para las personas con
rol de administrador, desarrollador o tester de la app. Como el CRM lo usas solo tú, con eso
alcanza para operar y probar.

Para que funcione con la app **en modo activo (producción)**, Meta exige **revisión de la
app** para `leads_retrieval`, y normalmente también **verificación del negocio**. Ese
trámite lo hace Meta y toma días: es un bloqueo externo, no algo que se resuelva en el
código.

> No hay atajo para saltarse la revisión ni los permisos, y no conviene buscarlo: Meta
> desactiva las apps que lo intentan.

### 8. En Meta (manual) — acceso a la información de clientes potenciales

Aunque la app tenga los permisos, la **página** tiene su propia lista de quién puede leer
sus leads. Si el CRM no está en esa lista, Graph responde que no hay permisos aunque todo lo
demás esté bien.

En **Meta Business Suite → Configuración del negocio**, dentro de la sección de la página,
hay una opción de **acceso a la información de clientes potenciales** (*Lead Access*), donde
se asignan tanto personas como **CRMs / aplicaciones**. Ahí hay que asignar tu app.

> La ruta exacta de este menú cambia entre versiones de Business Suite y según cómo esté
> armado tu negocio; no puedo confirmarte los nombres literales de cada pantalla. Lo que hay
> que lograr es: **tu app aparece con acceso a los leads de la página de Veta Labs**.

## Probar la integración

Meta tiene una herramienta oficial: **Lead Ads Testing Tool**
(`developers.facebook.com/tools/lead-ads-testing`).

1. Seleccionar la página y el formulario.
2. Enviar un lead de prueba.
3. La herramienta muestra si la entrega del webhook salió bien.

Después, comprobar del lado del CRM:

```sql
select meta_lead_id, status, attempt_count, nombre, email, form_id, ad_id,
       last_error, processed_at, created_at
from public.meta_leads
order by created_at desc
limit 10;
```

Un lead de prueba llega con los campos rellenos con datos ficticios de Meta. Se pueden
borrar después sin afectar nada:

```sql
-- Ojo: borra también el lead del pipeline asociado.
delete from public.leads where origen = 'meta_lead_ads' and origen_id = '<leadgen_id>';
delete from public.meta_leads where meta_lead_id = '<leadgen_id>';
```

La verificación GET se puede probar sin Meta (reemplazando el token):

```bash
curl -i "https://rayvimywyqjnzzmbagpv.supabase.co/functions/v1/meta-lead?hub.mode=subscribe&hub.verify_token=TU_TOKEN&hub.challenge=hola"
```

Debe responder `200` con el cuerpo `hola`. Con un token equivocado, `403`.

## Diagnóstico: no llegan los eventos

De más frecuente a menos:

| Síntoma | Causa probable | Qué revisar |
|---|---|---|
| Nada en `meta_leads` | La página no está suscrita al campo `leadgen` | `GET /{page-id}/subscribed_apps` |
| Nada, y la URL no verifica | Token de verificación distinto entre Meta y Supabase | Que `META_WEBHOOK_VERIFY_TOKEN` sea idéntico |
| Todo responde `401` | Firma inválida: `META_APP_SECRET` es de otra app o está mal copiado | Configuración → Básica de la app |
| Todo responde `401` sin tocar nada | La función quedó con `verify_jwt: true` | Redesplegar con `verify_jwt: false` |
| Meta reporta `503` y reintenta | Fallo temporal de Graph o de la base | `last_error` de la fila; suele resolverse solo |
| Meta reporta `500` | Fallo permanente de configuración | `last_error`: código `190` o `200` |
| Filas en `status = 'failed'` con código `190` | Token de página vencido o revocado | Regenerar `META_PAGE_ACCESS_TOKEN` |
| Filas en `status = 'failed'` con código `200` o `100` | Falta `leads_retrieval` o falta el acceso a leads de la página | Permisos y paso 8 |
| Filas en `status = 'processing'` de hace rato | Se cortó a mitad de camino | Se recuperan solas al siguiente reintento pasados 5 min |
| `attempt_count` crece y nunca llega a `completed` | Fallo persistente | `last_error`; cada reintento de Meta lo incrementa |
| Llega el lead pero sin datos | El formulario no tiene los campos estándar | `select respuestas from meta_leads` — están todas ahí |
| `adset_id` / `campaign_id` / `plataforma` siempre nulos | Es lo esperado: no se piden a Graph | Ver "Campos que se piden a Graph API" |

Ver qué falló, sin exponer datos personales:

```sql
select meta_lead_id, status, attempt_count, last_attempt_at, last_error
from public.meta_leads
where status <> 'completed'
order by last_attempt_at desc nulls last;
```

Un `processing` viejo que quedó colgado se puede devolver a la cola a mano:

```sql
update public.meta_leads set status = 'failed', last_error = 'reencolado a mano'
where meta_lead_id = '<leadgen_id>' and status = 'processing';
```

Los logs de la función están en Supabase → Edge Functions → `meta-lead` → Logs. **No
registran tokens ni datos personales completos**: los correos salen ofuscados
(`p***@example.com`) y del payload de Meta solo se anotan ids y conteos.

En Meta, el panel de Webhooks muestra los intentos de entrega recientes y sus respuestas:
sirve para distinguir "Meta nunca lo mandó" de "lo mandó y el endpoint falló".

## Revocar la integración

De menos a más definitivo:

1. **Pausar la entrada de leads**: quitar la suscripción al campo `leadgen`
   (`DELETE /{page-id}/subscribed_apps`) o desuscribir la página en el panel de Webhooks.
   Los datos ya guardados quedan intactos.
2. **Cortar el acceso a los datos**: borrar `META_PAGE_ACCESS_TOKEN` de los secretos de
   Supabase. La función deja de poder leer leads nuevos.
3. **Quitar el acceso del lado de Meta**: sacar la app de la lista de acceso a clientes
   potenciales de la página (paso 8) y, si corresponde, quitar la app del negocio.
4. **Borrar la URL de retrollamada** en el producto Webhooks de la app.
5. **Rotar los secretos** que hayan quedado dando vueltas: `META_APP_SECRET` se regenera
   desde Configuración → Básica; el token de verificación se cambia generando otro.
6. **Revertir el esquema**, si además quieres borrar el detalle guardado:
   `20260816173000_meta_leads_down.sql`.

## Privacidad

- Los datos personales de los leads viven solo en Postgres, detrás de RLS. `meta_leads`
  tiene la misma política que el resto de las tablas: solo el usuario dueño.
- La Edge Function entra con `service_role`, que salta RLS. Esa clave nunca sale de los
  secretos de Supabase y no está en el repo.
- El token de página viaja en la cabecera `Authorization`, **no** en la query string, para
  que no quede escrito en logs de acceso.
- El frontend (`index.html`, `crm/index.html`) nunca ve ninguno de estos secretos.
