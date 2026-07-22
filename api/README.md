# API del CRM

Este endpoint recibe leads desde tu sitio web y los guarda en Supabase como contactos en etapa `contactado`.

## Variables de entorno en Vercel
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `CRM_OWNER_EMAIL`
- `FROM_EMAIL` (opcional)

## Ejemplo de uso

```bash
curl -X POST https://TU-APP.vercel.app/api/lead-form \
  -H 'Content-Type: application/json' \
  -d '{
    "nombre": "Juan Pérez",
    "email": "juan@ejemplo.com",
    "telefono": "+56912345678",
    "empresa": "Mi Empresa",
    "cargo": "Dueño",
    "mensaje": "Quiero cotizar"
  }'
```
