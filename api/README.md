# API del CRM

`POST /api/lead-form` recibe JSON o formularios HTML y reenvía a `nuevo-lead`,
que guarda oportunidades en etapa `nuevo`. Es el respaldo sin JavaScript;
no escribe directamente en la base de datos. Nombre y email son obligatorios.

## Configuración

No requiere claves privadas en Vercel: los secretos permanecen en Supabase.
Aplicar `20260906230000_web_intake.sql` antes de desplegar `nuevo-lead` junto
con `validation.ts`. El cuerpo tiene un máximo de 16 KB. La respuesta HTML
no incluye datos personales. Un fallo del aviso no invalida el lead guardado.

Pruebas sin envíos reales: `node --test scripts/lead-form-test.cjs`.

## Ejemplo de uso

```bash
curl -X POST https://vetalabs.cl/api/lead-form \
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
