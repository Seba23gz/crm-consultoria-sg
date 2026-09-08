import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { normalize, fallbackId, InputError } from './validation.ts';

// Endpoint público del formulario web. Crea/enlaza empresa + contacto (persona) + lead
// (oportunidad), y notifica por correo (Resend). verify_jwt off a propósito (form público);
// protección = honeypot + validación + cuotas persistentes. Claves solo del entorno.
//
// Campos que acepta: nombre y email (obligatorios), telefono, empresa, cargo,
// negocio/necesidad, canales (arreglo), presupuesto, sitio, mensaje y website
// (honeypot). Los demás son opcionales: el sitio publicado puede ir
// una versión atrás y el formulario tiene que seguir entrando igual.

// Destino del aviso. Se lee del entorno para poder cambiarlo sin desplegar.
//
// El valor por defecto es el Gmail y NO es un descuido: la cuenta de Resend está
// en modo prueba (sin dominio verificado), así que el remitente
// `onboarding@resend.dev` solo puede entregar al correo del dueño de la cuenta.
// Mandarlo a contacto@vetalabs.cl devuelve 403 y el aviso se pierde en silencio,
// que es exactamente lo que pasó con el lead del 24-08-2026: quedó guardado en el
// CRM y nadie se enteró.
//
// Para volver a contacto@vetalabs.cl, sin tocar este archivo ni redesplegar:
//   1. Verificar vetalabs.cl en resend.com/domains (agregar los registros DNS).
//   2. En Supabase → Edge Functions → Secrets:
//        RESEND_FROM = Leads Veta Labs <leads@vetalabs.cl>
//        NOTIFY_TO   = contacto@vetalabs.cl
//   3. Comprobar que esa casilla exista de verdad: verificar el dominio arregla
//      desde dónde SALE el correo, no que haya un buzón donde RECIBIRLO.
const NOTIFY_TO = Deno.env.get("NOTIFY_TO") || "sebastiangomez2003@gmail.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

async function enviarCorreo(lead: Record<string, string>, requestId: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return "skipped";
  const from = Deno.env.get("RESEND_FROM") || "Leads CRM <onboarding@resend.dev>";
  // `mensaje` es texto libre y puede traer saltos de línea (y los trae, si el
  // sitio publicado todavía pliega respuestas ahí). En HTML se colapsarían en
  // un párrafo ilegible.
  const row = (label: string, val: string) => val
    ? `<tr><td style="padding:6px 12px;color:#71717a;font:600 13px sans-serif;vertical-align:top;white-space:nowrap">${label}</td><td style="padding:6px 12px;font:400 14px sans-serif">${esc(val).replace(/\n/g, "<br>")}</td></tr>` : "";
  const html = `<div style="font-family:sans-serif;max-width:520px">
    <h2 style="margin:0 0 4px">Nuevo lead desde la web</h2>
    <p style="color:#71717a;margin:0 0 16px">Origen: formulario de diagnóstico de vetalabs.cl</p>
    <table style="border-collapse:collapse;width:100%">
      ${row("Nombre", lead.nombre)}${row("Email", lead.email)}${row("WhatsApp", lead.telefono)}${row("Marca", lead.empresa)}${row("Cargo", lead.cargo)}${row("Instagram o web", lead.sitio)}${row("Qué necesita", lead.negocio)}${row("Vende hoy por", lead.canales)}${row("Presupuesto", lead.presupuesto)}${row("Cuenta", lead.mensaje)}
    </table>
    <p style="margin:18px 0 0"><a href="https://vetalabs.cl/crm" style="font:600 14px sans-serif;color:#111111">Abrir el CRM →</a></p>
    <p style="color:#a1a1aa;margin:10px 0 0;font-size:12px">Guardado como lead en etapa “Nuevo”, con su contacto y empresa.</p>
  </div>`;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `web-${requestId}` },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ from, to: [NOTIFY_TO], reply_to: lead.email || undefined, subject: `Nuevo lead: ${lead.nombre}`, html }),
    });
    if (!res.ok) {
      console.error("Resend error", res.status); // No registrar datos personales.
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      return `error:${res.status}`;
    }
    return "sent";
    }
    return 'error';
  } catch (e) { console.error("Resend exception", e); return "error"; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  if (!req.headers.get('content-type')?.includes('application/json')) return json({ error: 'Usa JSON.' }, 415);
  // Límite real del cuerpo, también cuando no hay Content-Length.
  const reader = req.body?.getReader();
  if (!reader) return json({ error: 'Faltan datos.' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) { await reader.cancel(); return json({ error: 'Datos demasiado largos.' }, 413); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const input = normalize(JSON.parse(new TextDecoder().decode(bytes)));
    if (input.website) return json({ ok: true });
    const requestId = input.requestId || await fallbackId(input.payload);
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await supabase.rpc('recibir_lead_web', {
      p_request_id: requestId, p_payload: input.payload
    });
    if (error) {
      if (error.message.includes('rate_limited')) return json({ error: 'Demasiados envíos. Inténtalo más tarde.' }, 429);
      if (error.message.includes('request_conflict')) return json({ error: 'La solicitud cambió. Recarga y vuelve a intentarlo.' }, 409);
      console.error('web intake failed', error.code);
      return json({ error: 'No pudimos guardar tu solicitud. Inténtalo de nuevo.' }, 503);
    }
    let emailStatus = data.email_status;
    const { data: claimed, error: claimError } = await supabase.rpc('reclamar_aviso_web', { p_request_id: requestId });
    if (claimed && !claimError) {
      const p = input.payload;
      const result = await enviarCorreo({ ...p, negocio: p.necesidad, canales: p.canales.join(', ') }, requestId);
      emailStatus = result === 'sent' ? 'sent' : 'failed';
      const { error: stateError } = await supabase.from('web_intake')
        .update({ email_status: emailStatus }).eq('request_id', requestId);
      if (stateError) console.error('email status persistence failed', stateError.code);
    }
    // El lead ya está guardado: un fallo del aviso no pide al cliente reenviarlo.
    return json({ ok: true, email: emailStatus, duplicate: data.duplicate });
  } catch (error) {
    if (error instanceof InputError || error instanceof SyntaxError) {
      return json({ error: error instanceof InputError ? error.message : 'JSON inválido.' }, 400);
    }
    console.error('web intake unexpected error');
    return json({ error: 'No pudimos procesar tu solicitud. Inténtalo de nuevo.' }, 503);
  }
});
