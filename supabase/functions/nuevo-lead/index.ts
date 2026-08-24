import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Endpoint público del formulario web. Crea/enlaza empresa + contacto (persona) + lead
// (oportunidad), y notifica por correo (Resend). verify_jwt off a propósito (form público);
// protección = honeypot + validación. Claves service_role y Resend vienen del entorno.

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

async function enviarCorreo(lead: Record<string, string>) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return "skipped";
  const from = Deno.env.get("RESEND_FROM") || "Leads CRM <onboarding@resend.dev>";
  // El formulario pliega varias respuestas dentro de `mensaje`, separadas por
  // saltos de línea. En HTML se colapsarían en un párrafo ilegible.
  const row = (label: string, val: string) => val
    ? `<tr><td style="padding:6px 12px;color:#71717a;font:600 13px sans-serif;vertical-align:top;white-space:nowrap">${label}</td><td style="padding:6px 12px;font:400 14px sans-serif">${esc(val).replace(/\n/g, "<br>")}</td></tr>` : "";
  const html = `<div style="font-family:sans-serif;max-width:520px">
    <h2 style="margin:0 0 4px">Nuevo lead desde la web</h2>
    <p style="color:#71717a;margin:0 0 16px">Origen: formulario de diagnóstico de vetalabs.cl</p>
    <table style="border-collapse:collapse;width:100%">
      ${row("Nombre", lead.nombre)}${row("Email", lead.email)}${row("WhatsApp", lead.telefono)}${row("Marca", lead.empresa)}${row("Cargo", lead.cargo)}${row("Qué necesita", lead.negocio)}${row("Cuenta", lead.mensaje)}
    </table>
    <p style="margin:18px 0 0"><a href="https://vetalabs.cl/crm" style="font:600 14px sans-serif;color:#111111">Abrir el CRM →</a></p>
    <p style="color:#a1a1aa;margin:10px 0 0;font-size:12px">Guardado como lead en etapa “Nuevo”, con su contacto y empresa.</p>
  </div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [NOTIFY_TO], reply_to: lead.email || undefined, subject: `Nuevo lead: ${lead.nombre}`, html }),
    });
    if (!res.ok) { console.error("Resend error", res.status, await res.text()); return `error:${res.status}`; }
    return "sent";
  } catch (e) { console.error("Resend exception", e); return "error"; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const str = (v: unknown) => (v ?? "").toString().trim();
  const nombre = str(body.nombre);
  const empresaNombre = str(body.empresa);
  const cargo = str(body.cargo);
  const negocio = str(body.negocio);
  const mensaje = str(body.mensaje);
  const email = str(body.email);
  const telefono = str(body.telefono);
  const honeypot = str(body.website);

  if (honeypot) return json({ ok: true });
  if (!nombre) return json({ error: "Falta el nombre" }, 400);
  if (nombre.length > 120 || empresaNombre.length > 160 || cargo.length > 120 || negocio.length > 200 || mensaje.length > 3000 || email.length > 200 || telefono.length > 40) {
    return json({ error: "Datos demasiado largos" }, 400);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1) Empresa: busca por nombre o crea
  let empresa_id: number | null = null;
  if (empresaNombre) {
    const { data: found } = await supabase.from("empresas").select("id").ilike("nombre", empresaNombre).limit(1).maybeSingle();
    if (found) empresa_id = found.id;
    else {
      const { data: creada } = await supabase.from("empresas").insert({ nombre: empresaNombre, rubro: negocio || null }).select("id").single();
      empresa_id = creada ? creada.id : null;
    }
  }

  // 2) Contacto (persona): busca por email o crea
  let contacto_id: number | null = null;
  if (email) {
    const { data: c } = await supabase.from("contactos").select("id").ilike("email", email).limit(1).maybeSingle();
    if (c) contacto_id = c.id;
  }
  if (!contacto_id) {
    const { data: c, error: ce } = await supabase.from("contactos")
      .insert({ nombre, cargo: cargo || null, email: email || null, telefono: telefono || null, empresa_id }).select("id").single();
    if (ce) return json({ error: ce.message }, 500);
    contacto_id = c.id;
  }

  // 3) Lead (oportunidad)
  const hoy = new Date().toISOString().slice(0, 10);
  const titulo = negocio ? `Interés: ${negocio}` : "Lead desde la web";
  const notas = [mensaje && `Mensaje: ${mensaje}`, "Origen: formulario web"].filter(Boolean).join("\n");
  const { error: le } = await supabase.from("leads").insert({
    empresa_id, contacto_id, titulo, etapa: "nuevo", prioridad: "media", notas, ultimo_contacto: hoy,
  });
  if (le) return json({ error: le.message }, 500);

  const emailStatus = await enviarCorreo({ nombre, email, telefono, empresa: empresaNombre, cargo, negocio, mensaje });
  return json({ ok: true, email: emailStatus });
});
