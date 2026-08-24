-- Los campos del formulario de diagnostico, como columnas propias.
--
-- Hasta ahora el formulario del sitio preguntaba mas cosas de las que la Edge
-- Function `nuevo-lead` sabia guardar, asi que las respuestas sobrantes se
-- plegaban dentro de `notas` como texto libre:
--
--   Instagram o web: @pecadoras.shoes
--   Vende hoy por: Instagram, WhatsApp
--   Presupuesto estimado: Entre $390.000 y $690.000
--
-- Se leia bien en el correo, pero en el CRM no se podia filtrar ni ordenar por
-- nada de eso: para saber cuantos leads llegan con presupuesto sobre $690.000
-- habia que abrirlos uno por uno.
--
-- Estas cuatro columnas son las cuatro preguntas del formulario. Todas nulas y
-- aditivas: los leads cargados a mano y los que entran por Meta las dejan
-- vacias, y `notas` sigue funcionando igual para lo que se escribe a mano.
--
-- `canales` es un arreglo porque la pregunta es de seleccion multiple (se vende
-- por Instagram *y* WhatsApp a la vez). `presupuesto` es texto y no un numero
-- porque la respuesta es un tramo, no una cifra: quien elige "Sobre $690.000"
-- no esta comprometiendo un monto.
--
-- Para revertir: alter table public.leads drop column ... (se pierden los datos
-- de esas columnas, no los de `notas`).

alter table public.leads
  add column if not exists necesidad   text,
  add column if not exists canales     text[],
  add column if not exists presupuesto text,
  add column if not exists sitio       text;

comment on column public.leads.necesidad   is 'Que necesita, segun el formulario del sitio. Es lo que titula la oportunidad.';
comment on column public.leads.canales     is 'Canales por los que vende hoy (seleccion multiple del formulario).';
comment on column public.leads.presupuesto is 'Tramo de presupuesto declarado. Texto, no monto: es un rango, no un compromiso.';
comment on column public.leads.sitio       is 'Instagram o sitio web que dejo la persona, para mirarlo antes de escribirle.';

-- Los leads del formulario no venian marcados con origen, asi que en el tablero
-- se veian igual que uno cargado a mano. `ORIGENES` del CRM ya tenia la etiqueta
-- 'web' esperandolos.
update public.leads
   set origen = 'web'
 where origen is null
   and notas like '%Origen: formulario web%';
