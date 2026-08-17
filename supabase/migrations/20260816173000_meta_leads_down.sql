-- Rollback de 20260816173000_meta_leads.sql.
--
-- Solo elimina lo que esa migracion creo. Los leads, contactos y empresas que la
-- integracion haya generado NO se tocan: quedan en el CRM como cualquier otro.
-- Se pierde el detalle crudo de Meta (respuestas, ids de pauta, payload).

drop policy if exists solo_dueno_meta_leads on public.meta_leads;
drop table if exists public.meta_leads;
