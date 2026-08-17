import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type Almacen,
  CAMPOS_GRAPH,
  CAMPOS_GRAPH_MINIMOS,
  type DatosProcesado,
  ErrorGraph,
  esReintentable,
  type EventoLeadgen,
  extraerEventosLeadgen,
  type LeadDeGraph,
  type LeadNormalizado,
  mensajeDe,
  normalizarRespuestaGraph,
  procesarEvento,
  type Registro,
  urlGraph,
  verificarFirma,
  verificarSuscripcion,
  versionGraph,
} from "./lib.ts";

// Webhook de Meta Lead Ads (formularios instantaneos de Facebook e Instagram).
//
// Meta NO manda los datos del lead en el webhook: manda un leadgen_id y hay que
// ir a buscarlos a la Graph API con el token de la pagina. El flujo es:
//   1. GET  -> Meta verifica la URL con hub.challenge (una sola vez, al darla de alta)
//   2. POST -> llega {leadgen_id}, se consulta Graph API y se crea empresa + contacto + lead
//
// verify_jwt off a proposito: Meta no manda JWT. La proteccion es la firma
// X-Hub-Signature-256 (HMAC del cuerpo con el app secret), que se valida abajo.
//
// La logica vive en `lib.ts` y esta cubierta por `lib_test.ts`. Aca solo va el
// wiring con el mundo real: entorno, red y base de datos.

const NOTIFY_TO = "sebastiangomez2003@gmail.com";

// `EdgeRuntime.waitUntil` mantiene vivo el trabajo en segundo plano despues de
// responder. Sin esto el runtime puede cortar la funcion apenas sale el 200.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const log: Registro = {
  info: (mensaje, datos) => console.log(`[meta-lead] ${mensaje}`, datos ?? ""),
  error: (mensaje, datos) => console.error(`[meta-lead] ${mensaje}`, datos ?? ""),
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function esc(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

function env(nombre: string): string | undefined {
  const v = Deno.env.get(nombre);
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Token de verificacion del webhook. El nombre nuevo manda; se acepta el viejo
 * (`META_VERIFY_TOKEN`, el que documentaba el README) para no romper si ya estaba
 * cargado en Supabase.
 */
function tokenDeVerificacion(): string | undefined {
  return env("META_WEBHOOK_VERIFY_TOKEN") ?? env("META_VERIFY_TOKEN");
}

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

const REINTENTOS = 3;
const ESPERA_BASE_MS = 800;

function dormir(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Un 4xx de Graph trae el detalle en `error`; lo pasamos a ErrorGraph. */
async function errorDeRespuesta(res: Response): Promise<ErrorGraph> {
  const cuerpo = await res.json().catch(() => ({})) as { error?: { message?: string; code?: number } };
  const codigo = typeof cuerpo?.error?.code === "number" ? cuerpo.error.code : null;
  // El mensaje de Meta no incluye el token, pero se recorta igual por prudencia.
  const detalle = (cuerpo?.error?.message ?? "sin detalle").slice(0, 300);
  return new ErrorGraph(
    `Graph API ${res.status} (codigo ${codigo ?? "?"}): ${detalle}`,
    res.status,
    codigo,
    esReintentable(res.status, codigo),
  );
}

/**
 * Pide el lead a Graph API.
 *
 * El token va en la cabecera Authorization y no en la query string: asi no queda
 * escrito en logs de acceso ni en trazas de red.
 *
 * Reintenta ante 429, 5xx y fallos de red, con espera creciente. Un token vencido
 * o un permiso faltante no se reintenta: no se arregla solo.
 */
async function traerDeGraph(leadgenId: string): Promise<LeadDeGraph> {
  const token = env("META_PAGE_ACCESS_TOKEN");
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN no configurado");
  const version = versionGraph(Deno.env.get("META_GRAPH_API_VERSION"));

  // Primero el set completo. Si esta version de la API no conoce algun campo,
  // devuelve 400 y se reintenta con el minimo garantizado.
  const intentos: readonly (readonly string[])[] = [CAMPOS_GRAPH, CAMPOS_GRAPH_MINIMOS];

  let ultimo: unknown = null;
  for (const campos of intentos) {
    for (let intento = 1; intento <= REINTENTOS; intento++) {
      try {
        const res = await fetch(urlGraph(version, leadgenId, campos), {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const cuerpo = await res.json();
          return normalizarRespuestaGraph(cuerpo, leadgenId);
        }

        const err = await errorDeRespuesta(res);
        ultimo = err;

        // Campo desconocido para esta version: probar con el set reducido.
        if (res.status === 400 && campos !== CAMPOS_GRAPH_MINIMOS) {
          log.error("Graph rechazo el set completo de campos, se reintenta con el minimo", {
            leadgenId,
            status: res.status,
          });
          break;
        }

        if (!err.reintentable || intento === REINTENTOS) throw err;

        const espera = ESPERA_BASE_MS * 2 ** (intento - 1);
        log.error("Graph fallo, se reintenta", { leadgenId, status: res.status, intento, espera });
        await dormir(espera);
      } catch (e) {
        if (e instanceof ErrorGraph && !e.reintentable) throw e;
        ultimo = e;
        if (intento === REINTENTOS) {
          if (e instanceof ErrorGraph) throw e;
          // Fallo de red: no hubo respuesta.
          throw new ErrorGraph(`Graph API inalcanzable: ${mensajeDe(e)}`, 0, null, true);
        }
        await dormir(ESPERA_BASE_MS * 2 ** (intento - 1));
      }
    }
  }

  throw ultimo instanceof Error ? ultimo : new Error("Graph API: fallo desconocido");
}

// ---------------------------------------------------------------------------
// Persistencia (implementacion del puerto `Almacen` con supabase-js)
// ---------------------------------------------------------------------------

/** 23505 = choque con un indice unico. */
const CONFLICTO_UNICO = "23505";

function almacenSupabase(sb: SupabaseClient): Almacen {
  return {
    async reclamar(evento: EventoLeadgen) {
      const { error } = await sb.from("meta_leads").insert({
        meta_lead_id: evento.leadgenId,
        form_id: evento.formId,
        page_id: evento.pageId,
        ad_id: evento.adId,
        creado_en_meta: evento.createdTime ? new Date(evento.createdTime * 1000).toISOString() : null,
        estado: "pendiente",
        intentos: 1,
      });
      // Ya estaba: otra entrega del mismo lead llego primero.
      if (error?.code === CONFLICTO_UNICO) return false;
      if (error) throw new Error(`reclamar: ${error.message}`);
      return true;
    },

    async buscarEmpresaPorNombre(nombre: string) {
      const { data } = await sb.from("empresas").select("id").ilike("nombre", nombre).limit(1).maybeSingle();
      return data?.id ?? null;
    },

    async crearEmpresa({ nombre, ciudad }) {
      const { data, error } = await sb
        .from("empresas")
        .insert({ nombre, ciudad, fuente: "meta_lead_ads" })
        .select("id")
        .single();
      if (error) {
        // No es fatal: el lead puede quedar sin empresa asociada.
        log.error("no se pudo crear la empresa", { detalle: error.message });
        return null;
      }
      return data?.id ?? null;
    },

    async buscarContactoPorEmail(email: string) {
      const { data } = await sb.from("contactos").select("id").ilike("email", email).limit(1).maybeSingle();
      return data?.id ?? null;
    },

    async crearContacto({ nombre, cargo, email, telefono, empresaId }) {
      const { data, error } = await sb
        .from("contactos")
        .insert({ nombre, cargo, email, telefono, empresa_id: empresaId })
        .select("id")
        .single();
      if (error) throw new Error(`contacto: ${error.message}`);
      return data.id as number;
    },

    async crearLead({ empresaId, contactoId, titulo, notas, leadgenId }) {
      const hoy = new Date().toISOString().slice(0, 10);
      const { data, error } = await sb
        .from("leads")
        .insert({
          empresa_id: empresaId,
          contacto_id: contactoId,
          titulo,
          etapa: "nuevo",
          prioridad: "media",
          notas,
          ultimo_contacto: hoy,
          origen: "meta_lead_ads",
          origen_id: leadgenId,
        })
        .select("id")
        .single();

      // El indice unico (origen, origen_id) ya tenia este lead: no es un error.
      if (error?.code === CONFLICTO_UNICO) {
        const { data: existente } = await sb
          .from("leads")
          .select("id")
          .eq("origen", "meta_lead_ads")
          .eq("origen_id", leadgenId)
          .maybeSingle();
        return existente?.id ?? null;
      }
      if (error) throw new Error(`lead: ${error.message}`);
      return data?.id ?? null;
    },

    async marcarProcesado(leadgenId: string, d: DatosProcesado) {
      const { error } = await sb
        .from("meta_leads")
        .update({
          lead_id: d.leadId,
          contacto_id: d.contactoId,
          empresa_id: d.empresaId,
          nombre: d.lead.nombre,
          email: d.lead.email || null,
          telefono: d.lead.telefono || null,
          empresa: d.lead.empresa || null,
          cargo: d.lead.cargo || null,
          ciudad: d.lead.ciudad || null,
          // Los ids de Graph completan lo que el webhook no traia.
          form_id: d.graph.formId ?? undefined,
          ad_id: d.graph.adId ?? undefined,
          adset_id: d.graph.adsetId,
          campaign_id: d.graph.campaignId,
          plataforma: d.graph.plataforma,
          es_organico: d.graph.esOrganico,
          respuestas: d.lead.respuestas,
          payload: d.graph.crudo,
          creado_en_meta: d.graph.createdTime ?? undefined,
          estado: "procesado",
          error_detalle: null,
          updated_at: new Date().toISOString(),
        })
        .eq("meta_lead_id", leadgenId);
      if (error) throw new Error(`marcarProcesado: ${error.message}`);
    },

    async marcarError(leadgenId: string, detalle: string) {
      await sb
        .from("meta_leads")
        .update({ estado: "error", error_detalle: detalle, updated_at: new Date().toISOString() })
        .eq("meta_lead_id", leadgenId);
    },
  };
}

// ---------------------------------------------------------------------------
// Aviso por correo (mismo formato que `nuevo-lead`)
// ---------------------------------------------------------------------------

async function avisarPorCorreo(lead: LeadNormalizado, graph: LeadDeGraph): Promise<void> {
  const key = env("RESEND_API_KEY");
  if (!key) return;
  const from = env("RESEND_FROM") ?? "Leads CRM <onboarding@resend.dev>";

  const fila = (label: string, val: string) =>
    val
      ? `<tr><td style="padding:6px 12px;color:#71717a;font:600 13px sans-serif">${label}</td><td style="padding:6px 12px;font:400 14px sans-serif">${esc(val)}</td></tr>`
      : "";

  const extras = Object.entries(lead.personalizadas)
    .map(([p, r]) => `<tr><td colspan="2" style="padding:6px 12px;font:400 13px sans-serif;color:#52525b">${esc(p)}: ${esc(r)}</td></tr>`)
    .join("");

  const origen = graph.plataforma ? `Formulario de ${esc(graph.plataforma)}` : "Formulario de Facebook/Instagram";
  const html = `<div style="font-family:sans-serif;max-width:520px">
    <h2 style="margin:0 0 4px">Nuevo lead desde Meta Ads</h2>
    <p style="color:#71717a;margin:0 0 16px">${origen}${graph.formId ? ` &middot; form ${esc(graph.formId)}` : ""}</p>
    <table style="border-collapse:collapse;width:100%">
      ${fila("Nombre", lead.nombre)}${fila("Email", lead.email)}${fila("Telefono", lead.telefono)}${fila("Empresa", lead.empresa)}${fila("Cargo", lead.cargo)}${fila("Ciudad", lead.ciudad)}
      ${extras}
    </table>
    <p style="color:#a1a1aa;margin:18px 0 0;font-size:12px">Guardado en tu CRM como lead en etapa Nuevo.</p>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [NOTIFY_TO],
      reply_to: lead.email || undefined,
      subject: `Nuevo lead Meta: ${lead.nombre}`,
      html,
    }),
  });
  if (!res.ok) {
    // Nunca el cuerpo entero: puede traer de vuelta los datos del lead.
    log.error("Resend rechazo el aviso", { status: res.status });
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // 1) Verificacion de la URL. Meta la llama al dar de alta el webhook.
  if (req.method === "GET") {
    const r = verificarSuscripcion(url.searchParams, tokenDeVerificacion());
    if (!r.ok) {
      // Sin el motivo detallado en la respuesta y sin el token en el log.
      log.error("verificacion rechazada", { motivo: r.motivo });
      return new Response("Verificacion fallida", { status: 403 });
    }
    // Meta espera el challenge crudo, sin comillas ni JSON.
    return new Response(r.challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  if (req.method !== "POST") return json({ error: "Metodo no permitido" }, 405);

  // El cuerpo se lee como texto y se firma sobre esos bytes exactos.
  const crudo = await req.text();
  const firma = await verificarFirma(crudo, req.headers.get("x-hub-signature-256"), env("META_APP_SECRET"));
  if (!firma.ok) {
    log.error("firma rechazada", { motivo: firma.motivo });
    return json({ error: "Firma invalida" }, 401);
  }

  let cuerpo: unknown;
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    return json({ error: "JSON invalido" }, 400);
  }

  // Lo que no sea `leadgen` se descarta sin ruido: la suscripcion a la pagina
  // trae cambios de otros campos que no nos incumben.
  const eventos = extraerEventosLeadgen(cuerpo);
  if (eventos.length === 0) return json({ ok: true, recibidos: 0 });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const deps = {
    almacen: almacenSupabase(sb),
    traerDeGraph,
    notificar: avisarPorCorreo,
    log,
  };

  // Meta reintenta si la respuesta tarda, asi que el trabajo pesado (Graph API +
  // varias escrituras) va en segundo plano y el 200 sale de inmediato.
  const trabajo = Promise.allSettled(eventos.map((e) => procesarEvento(e, deps)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(trabajo);
  else await trabajo;

  return json({ ok: true, recibidos: eventos.length });
});
