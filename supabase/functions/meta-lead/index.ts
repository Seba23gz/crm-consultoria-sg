import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type Almacen,
  CAMPOS_GRAPH,
  codigoHttp,
  type DatosPersistencia,
  type Desenlace,
  ErrorGraph,
  esReintentable,
  type EventoLeadgen,
  extraerEventosLeadgen,
  filtrarPorPagina,
  type LeadDeGraph,
  type LeadNormalizado,
  LIMITE_CUERPO_BYTES,
  mensajeDe,
  normalizarRespuestaGraph,
  procesarEvento,
  type Registro,
  type ResultadoPersistencia,
  type ResultadoReclamo,
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
//   2. POST -> llega {leadgen_id}; se reclama, se consulta Graph y se persiste
//
// El procesamiento es SINCRONO: el 200 sale recien cuando el lead esta guardado.
// Si algo falla, se responde 503 (temporal) o 500 (permanente) para que Meta
// reintente en vez de dar la entrega por buena. El costo es que la respuesta
// tarda mas; por eso hay un presupuesto de tiempo estricto, abajo.
//
// Toda la escritura pasa por dos funciones de Postgres, no por llamadas sueltas:
//   reclamar_meta_lead()  -> quien procesa (exclusion mutua)
//   procesar_meta_lead()  -> empresa + contacto + lead + cierre, en UNA transaccion
//
// verify_jwt off a proposito: Meta no manda JWT. La proteccion es la firma
// X-Hub-Signature-256 (HMAC del cuerpo con el app secret), que se valida abajo.
//
// La logica vive en `lib.ts` y esta cubierta por `lib_test.ts`. Aca solo va el
// wiring con el mundo real: entorno, red y base de datos.

const NOTIFY_TO = "sebastiangomez2003@gmail.com";

// Presupuesto de tiempo. Meta corta la conexion si el endpoint tarda demasiado y
// las entregas lentas repetidas pueden hacer que desactive la suscripcion, asi
// que preferimos rendirnos y devolver 503 (que reintenta) antes que colgarnos.
const PRESUPUESTO_TOTAL_MS = 10_000;
/** Debajo de esto no vale la pena empezar otro evento. */
const MINIMO_POR_EVENTO_MS = 2_500;
const TIMEOUT_GRAPH_MS = 4_000;
const INTENTOS_GRAPH = 2;
const ESPERA_ENTRE_INTENTOS_MS = 300;

const log: Registro = {
  info: (mensaje, datos) => console.log(`[meta-lead] ${mensaje}`, datos ?? ""),
  error: (mensaje, datos) => console.error(`[meta-lead] ${mensaje}`, datos ?? ""),
};

function json(obj: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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

/** Valores que nunca deben aparecer en `last_error` ni en los logs. */
function secretosConocidos(): string[] {
  return [
    env("META_PAGE_ACCESS_TOKEN"),
    env("META_APP_SECRET"),
    tokenDeVerificacion(),
    env("RESEND_API_KEY"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? undefined,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Lleva la cuenta del tiempo que queda antes de rendirse. */
function presupuesto(totalMs: number) {
  const inicio = Date.now();
  return {
    restante: () => totalMs - (Date.now() - inicio),
    agotado: (minimo = 0) => totalMs - (Date.now() - inicio) <= minimo,
  };
}

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

function dormir(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Un 4xx de Graph trae el detalle en `error`; lo pasamos a ErrorGraph. */
async function errorDeRespuesta(res: Response): Promise<ErrorGraph> {
  const cuerpo = await res.json().catch(() => ({})) as { error?: { message?: string; code?: number } };
  const codigo = typeof cuerpo?.error?.code === "number" ? cuerpo.error.code : null;
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
 * Reintenta una sola vez y con espera corta: esto corre dentro del webhook, y las
 * esperas largas son peores que devolver 503 y dejar que Meta reintente.
 */
function hacerTraerDeGraph(reloj: ReturnType<typeof presupuesto>) {
  return async function traerDeGraph(leadgenId: string): Promise<LeadDeGraph> {
    const token = env("META_PAGE_ACCESS_TOKEN");
    // Falta de configuracion: reintentar no arregla nada.
    if (!token) throw new ErrorGraph("META_PAGE_ACCESS_TOKEN no configurado", 0, null, false);
    const version = versionGraph(Deno.env.get("META_GRAPH_API_VERSION"));

    let ultimo: ErrorGraph | null = null;

    for (let intento = 1; intento <= INTENTOS_GRAPH; intento++) {
      // Nunca arrancar una llamada que no alcanza a terminar.
      const disponible = Math.min(TIMEOUT_GRAPH_MS, reloj.restante());
      if (disponible <= 0) {
        throw new ErrorGraph("se agoto el presupuesto de tiempo del webhook", 0, null, true);
      }

      try {
        const res = await fetch(urlGraph(version, leadgenId, CAMPOS_GRAPH), {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(disponible),
        });

        if (res.ok) return normalizarRespuestaGraph(await res.json(), leadgenId);

        ultimo = await errorDeRespuesta(res);
        if (!ultimo.reintentable) throw ultimo;
      } catch (e) {
        if (e instanceof ErrorGraph) {
          if (!e.reintentable) throw e;
          ultimo = e;
        } else {
          // Timeout o fallo de red: no hubo respuesta. status 0 = reintentable.
          ultimo = new ErrorGraph(`Graph API inalcanzable: ${mensajeDe(e)}`, 0, null, true);
        }
      }

      if (intento < INTENTOS_GRAPH && !reloj.agotado(ESPERA_ENTRE_INTENTOS_MS)) {
        await dormir(ESPERA_ENTRE_INTENTOS_MS);
      }
    }

    throw ultimo ?? new ErrorGraph("Graph API: fallo desconocido", 0, null, true);
  };
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------
//
// Solo tres operaciones, y las dos que escriben son funciones de Postgres. No hay
// inserts sueltos desde aca a proposito: cada llamada de PostgREST es su propia
// transaccion, y encadenar cuatro dejaria escrituras parciales confirmadas si el
// proceso muere a mitad de camino.

function almacenSupabase(sb: SupabaseClient): Almacen {
  return {
    /**
     * Exclusion mutua. Tiene que ser una sola sentencia atomica: un SELECT
     * seguido de un INSERT desde aca dejaria pasar dos entregas simultaneas.
     */
    async reclamar(evento: EventoLeadgen): Promise<ResultadoReclamo> {
      const { data, error } = await sb.rpc("reclamar_meta_lead", {
        p_meta_lead_id: evento.leadgenId,
        p_form_id: evento.formId,
        p_page_id: evento.pageId,
        p_ad_id: evento.adId,
        p_created_time: evento.createdTime ? new Date(evento.createdTime * 1000).toISOString() : null,
      });
      if (error) throw new Error(`reclamar: ${error.message}`);

      const fila = Array.isArray(data) ? data[0] : data;
      const resultado = fila?.resultado as string | undefined;

      if (resultado === "claimed") return { tipo: "claimed", intento: fila?.intento ?? 1 };
      if (resultado === "completed") return { tipo: "completed" };
      if (resultado === "in_progress") return { tipo: "in_progress" };

      // No deberia pasar: la funcion siempre devuelve una de las tres.
      throw new Error(`reclamar: respuesta inesperada (${resultado ?? "vacia"})`);
    },

    /**
     * Empresa + contacto + lead + cierre de la fila, todo en una transaccion de
     * Postgres. Si algo falla adentro, no queda nada escrito y el reintento
     * arranca limpio.
     */
    async persistir(leadgenId: string, d: DatosPersistencia): Promise<ResultadoPersistencia> {
      const { data, error } = await sb.rpc("procesar_meta_lead", {
        p_meta_lead_id: leadgenId,
        p_nombre: d.lead.nombre,
        p_email: d.lead.email,
        p_telefono: d.lead.telefono,
        p_empresa: d.lead.empresa,
        p_cargo: d.lead.cargo,
        p_ciudad: d.lead.ciudad,
        p_titulo: d.titulo,
        p_notas: d.notas,
        p_respuestas: d.lead.respuestas,
        // `crudo` es una copia con solo los campos que pedimos a Graph: nunca
        // lleva cabeceras, firma ni tokens.
        p_payload: d.graph.crudo,
        p_form_id: d.graph.formId,
        p_ad_id: d.graph.adId,
        p_created_time: d.graph.createdTime,
      });
      if (error) throw new Error(`persistir: ${error.message}`);

      const fila = Array.isArray(data) ? data[0] : data;
      if (!fila) throw new Error("persistir: la funcion no devolvio nada");

      return {
        leadId: fila.lead_id ?? null,
        contactoId: fila.contacto_id ?? null,
        empresaId: fila.empresa_id ?? null,
        yaEstaba: fila.ya_estaba === true,
      };
    },

    async marcarFallido(leadgenId: string, errorSaneado: string) {
      const ahora = new Date().toISOString();
      const { error } = await sb
        .from("meta_leads")
        .update({ status: "failed", last_error: errorSaneado, updated_at: ahora })
        .eq("meta_lead_id", leadgenId);
      // Si esto falla, la fila queda en `processing` y la recupera el umbral de
      // abandono. No se propaga: ya estamos en el camino de error.
      if (error) log.error("no se pudo marcar el fallo", { detalle: error.message });
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
    .map(([p, r]) =>
      `<tr><td colspan="2" style="padding:6px 12px;font:400 13px sans-serif;color:#52525b">${esc(p)}: ${esc(r)}</td></tr>`
    )
    .join("");

  const html = `<div style="font-family:sans-serif;max-width:520px">
    <h2 style="margin:0 0 4px">Nuevo lead desde Meta Ads</h2>
    <p style="color:#71717a;margin:0 0 16px">Formulario de Facebook/Instagram${
    graph.formId ? ` &middot; form ${esc(graph.formId)}` : ""
  }</p>
    <table style="border-collapse:collapse;width:100%">
      ${fila("Nombre", lead.nombre)}${fila("Email", lead.email)}${fila("Telefono", lead.telefono)}${
    fila("Empresa", lead.empresa)
  }${fila("Cargo", lead.cargo)}${fila("Ciudad", lead.ciudad)}
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
    signal: AbortSignal.timeout(3_000),
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

  // 2) Tope de tamano antes de leer nada: una entrega real son unos pocos KB.
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > LIMITE_CUERPO_BYTES) {
    log.error("cuerpo rechazado por tamano", { declarado });
    return json({ error: "Cuerpo demasiado grande" }, 413);
  }

  // El cuerpo se lee como TEXTO y se firma sobre esos bytes exactos, antes de
  // cualquier JSON.parse: reserializar cambia bytes y romperia el HMAC.
  const crudo = await req.text();
  if (crudo.length > LIMITE_CUERPO_BYTES) {
    log.error("cuerpo rechazado por tamano", { real: crudo.length });
    return json({ error: "Cuerpo demasiado grande" }, 413);
  }

  // 3) Firma. Nada de lo que sigue corre si esto no pasa.
  const firma = await verificarFirma(crudo, req.headers.get("x-hub-signature-256"), env("META_APP_SECRET"));
  if (!firma.ok) {
    log.error("firma rechazada", { motivo: firma.motivo });
    return json({ error: "Firma invalida" }, 401);
  }

  // 4) Recien con la firma validada se interpreta el contenido.
  let cuerpo: unknown;
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    return json({ error: "JSON invalido" }, 400);
  }

  // Lo que no sea `leadgen` se descarta sin ruido: la suscripcion a la pagina
  // trae cambios de otros campos que no nos incumben.
  const todos = extraerEventosLeadgen(cuerpo);
  // Y si hay varias paginas en la misma app, solo la nuestra.
  const { aceptados: eventos, descartados } = filtrarPorPagina(todos, env("META_PAGE_ID"));
  if (descartados.length > 0) {
    log.info("eventos de otra pagina ignorados", { cantidad: descartados.length });
  }
  if (eventos.length === 0) return json({ ok: true, recibidos: 0, completados: 0 });

  const reloj = presupuesto(PRESUPUESTO_TOTAL_MS);
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const deps = {
    almacen: almacenSupabase(sb),
    traerDeGraph: hacerTraerDeGraph(reloj),
    notificar: avisarPorCorreo,
    secretos: secretosConocidos(),
    log,
  };

  // Secuencial y sincrono: el 200 sale recien cuando el lead esta guardado.
  const desenlaces: Desenlace[] = [];
  for (const evento of eventos) {
    // Si no queda tiempo, ni se reclama: se deja intacto para la reentrega de Meta.
    if (reloj.agotado(MINIMO_POR_EVENTO_MS)) {
      log.error("sin presupuesto para el resto de la entrega", {
        leadgenId: evento.leadgenId,
        pendientes: eventos.length - desenlaces.length,
      });
      desenlaces.push("retry");
      continue;
    }
    desenlaces.push(await procesarEvento(evento, deps));
  }

  const status = codigoHttp(desenlaces);
  const cuerpoRespuesta = {
    ok: status === 200,
    recibidos: eventos.length,
    completados: desenlaces.filter((d) => d === "completed" || d === "already_completed").length,
  };

  if (status === 503) {
    // Meta reintenta igual; la cabecera solo evita que lo haga de inmediato.
    return json(cuerpoRespuesta, 503, { "Retry-After": "60" });
  }
  if (status === 500) {
    // Error permanente de configuracion. El detalle esta en meta_leads.last_error,
    // saneado; no se devuelve por la respuesta.
    return json({ ...cuerpoRespuesta, error: "El lead quedo registrado como failed" }, 500);
  }
  return json(cuerpoRespuesta, 200);
});
