// Pruebas de la integracion con Meta Lead Ads.
//
//   deno task test
//
// No tocan la red ni la base de datos: Graph API y la persistencia entran como
// dobles. Los fixtures son inventados, sin datos personales reales.
//
// `almacenFalso` replica la maquina de estados de `reclamar_meta_lead`
// (supabase/migrations/20260816173000_meta_leads.sql). Si una cambia, la otra
// tambien: son la misma logica escrita dos veces, y estas pruebas cubren la de
// aca. La atomicidad real la da Postgres.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type Almacen,
  CAMPOS_GRAPH,
  codigoHttp,
  type DatosProcesado,
  type Desenlace,
  ErrorGraph,
  esReintentable,
  type EventoLeadgen,
  extraerEventosLeadgen,
  igualSeguro,
  type LeadDeGraph,
  normalizarCampos,
  normalizarRespuestaGraph,
  ofuscarEmail,
  procesarEvento,
  type ResultadoReclamo,
  sanitizarError,
  urlGraph,
  verificarFirma,
  verificarSuscripcion,
  VERSION_GRAPH_POR_DEFECTO,
  versionGraph,
} from "./lib.ts";

const APP_SECRET = "app-secret-de-prueba";
const VERIFY_TOKEN = "token-de-verificacion-de-prueba";

async function leerFixture(nombre: string): Promise<unknown> {
  const url = new URL(`./fixtures/${nombre}`, import.meta.url);
  return JSON.parse(await Deno.readTextFile(url));
}

/** Firma un cuerpo igual que lo hace Meta, para las pruebas de POST. */
async function firmar(cuerpo: string, secreto = APP_SECRET): Promise<string> {
  const clave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secreto),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(cuerpo));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

// ---------------------------------------------------------------------------
// Verificacion GET
// ---------------------------------------------------------------------------

Deno.test("GET de verificacion: token correcto devuelve el challenge", () => {
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": VERIFY_TOKEN,
    "hub.challenge": "1158201444",
  });
  const r = verificarSuscripcion(params, VERIFY_TOKEN);
  assert(r.ok);
  assertEquals(r.challenge, "1158201444");
});

Deno.test("GET de verificacion: token incorrecto se rechaza", () => {
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "token-equivocado",
    "hub.challenge": "1158201444",
  });
  const r = verificarSuscripcion(params, VERIFY_TOKEN);
  assert(!r.ok);
  assertEquals(r.challenge, "");
  // El motivo no debe revelar el token esperado.
  assert(!r.motivo.includes(VERIFY_TOKEN));
});

Deno.test("GET de verificacion: sin token configurado nunca pasa", () => {
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "loquesea",
    "hub.challenge": "123",
  });
  assert(!verificarSuscripcion(params, undefined).ok);
  assert(!verificarSuscripcion(new URLSearchParams({ "hub.mode": "subscribe" }), "").ok);
});

Deno.test("GET de verificacion: hub.mode distinto de subscribe se rechaza", () => {
  const params = new URLSearchParams({
    "hub.mode": "unsubscribe",
    "hub.verify_token": VERIFY_TOKEN,
    "hub.challenge": "123",
  });
  assert(!verificarSuscripcion(params, VERIFY_TOKEN).ok);
});

// ---------------------------------------------------------------------------
// Firma POST
// ---------------------------------------------------------------------------

Deno.test("firma POST valida se acepta", async () => {
  const cuerpo = JSON.stringify(await leerFixture("webhook_leadgen.json"));
  const r = await verificarFirma(cuerpo, await firmar(cuerpo), APP_SECRET);
  assert(r.ok, r.motivo);
});

Deno.test("firma POST invalida se rechaza", async () => {
  const cuerpo = JSON.stringify(await leerFixture("webhook_leadgen.json"));
  // Firmada con otro secreto: es el caso de un tercero intentando postear.
  const ajena = await firmar(cuerpo, "otro-secreto");
  assert(!(await verificarFirma(cuerpo, ajena, APP_SECRET)).ok);

  // Cuerpo alterado despues de firmar.
  const buena = await firmar(cuerpo);
  assert(!(await verificarFirma(cuerpo + " ", buena, APP_SECRET)).ok);

  // Cabecera ausente o con formato raro.
  assert(!(await verificarFirma(cuerpo, null, APP_SECRET)).ok);
  assert(!(await verificarFirma(cuerpo, "sha1=abc", APP_SECRET)).ok);
  assert(!(await verificarFirma(cuerpo, "sha256=nohex", APP_SECRET)).ok);

  // Sin app secret configurado no se valida nada: tiene que fallar.
  assert(!(await verificarFirma(cuerpo, buena, undefined)).ok);
});

Deno.test("igualSeguro compara bien y no explota con largos distintos", () => {
  assert(igualSeguro("abc", "abc"));
  assert(!igualSeguro("abc", "abd"));
  assert(!igualSeguro("abc", "abcd"));
  assert(igualSeguro("", ""));
});

// ---------------------------------------------------------------------------
// Parseo de eventos
// ---------------------------------------------------------------------------

Deno.test("evento leadgen valido se extrae con sus ids", async () => {
  const eventos = extraerEventosLeadgen(await leerFixture("webhook_leadgen.json"));
  assertEquals(eventos.length, 1);
  assertEquals(eventos[0].leadgenId, "900000000000001");
  assertEquals(eventos[0].formId, "700000000000001");
  assertEquals(eventos[0].pageId, "100000000000001");
  assertEquals(eventos[0].adId, "600000000000002");
  assertEquals(eventos[0].createdTime, 1786000000);
});

Deno.test("evento ajeno se ignora sin error", async () => {
  assertEquals(extraerEventosLeadgen(await leerFixture("webhook_ajeno.json")).length, 0);
});

Deno.test("payload incompleto o malformado no rompe el parseo", () => {
  assertEquals(extraerEventosLeadgen(null).length, 0);
  assertEquals(extraerEventosLeadgen("texto suelto").length, 0);
  assertEquals(extraerEventosLeadgen({}).length, 0);
  assertEquals(extraerEventosLeadgen({ object: "page" }).length, 0);
  assertEquals(extraerEventosLeadgen({ object: "page", entry: "no es lista" }).length, 0);
  assertEquals(extraerEventosLeadgen({ object: "page", entry: [null, 5, {}] }).length, 0);
  assertEquals(
    extraerEventosLeadgen({
      object: "instagram",
      entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: "1" } }] }],
    }).length,
    0,
  );
  assertEquals(
    extraerEventosLeadgen({ object: "page", entry: [{ changes: [{ field: "leadgen", value: {} }] }] }).length,
    0,
  );
});

Deno.test("si falta page_id en value se usa el id de la entrada", () => {
  const eventos = extraerEventosLeadgen({
    object: "page",
    entry: [{ id: "100000000000009", changes: [{ field: "leadgen", value: { leadgen_id: "5" } }] }],
  });
  assertEquals(eventos[0].pageId, "100000000000009");
  assertEquals(eventos[0].createdTime, null);
});

Deno.test("adgroup_id sirve de ad_id cuando no viene ad_id", () => {
  const eventos = extraerEventosLeadgen({
    object: "page",
    entry: [{ id: "1", changes: [{ field: "leadgen", value: { leadgen_id: "5", adgroup_id: "77" } }] }],
  });
  assertEquals(eventos[0].adId, "77");
});

Deno.test("varios eventos leadgen en una sola entrega", () => {
  const eventos = extraerEventosLeadgen({
    object: "page",
    entry: [
      { id: "1", changes: [{ field: "leadgen", value: { leadgen_id: "a" } }, { field: "feed", value: {} }] },
      { id: "2", changes: [{ field: "leadgen", value: { leadgen_id: "b" } }] },
    ],
  });
  assertEquals(eventos.map((e) => e.leadgenId), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// Normalizacion de field_data
// ---------------------------------------------------------------------------

Deno.test("field_data se transforma a los campos del CRM", async () => {
  const graph = normalizarRespuestaGraph(await leerFixture("graph_lead.json"), "900000000000001");
  const lead = normalizarCampos(graph.fieldData);

  assertEquals(lead.nombre, "Persona De Prueba");
  assertEquals(lead.email, "prueba@example.com");
  assertEquals(lead.telefono, "+56900000000");
  assertEquals(lead.empresa, "Empresa Ficticia SpA");
  assertEquals(lead.cargo, "Gerente de Operaciones");
  assertEquals(lead.ciudad, "La Serena");
});

Deno.test("full_name ausente: se arma con first_name y last_name", () => {
  const lead = normalizarCampos([
    { name: "first_name", values: ["Ana"] },
    { name: "last_name", values: ["Rojas"] },
  ]);
  assertEquals(lead.nombre, "Ana Rojas");
});

Deno.test("sin ningun nombre queda el marcador, no vacio", () => {
  assertEquals(normalizarCampos([{ name: "email", values: ["x@example.com"] }]).nombre, "Sin nombre");
  assertEquals(normalizarCampos([]).nombre, "Sin nombre");
});

Deno.test("las preguntas personalizadas se conservan enteras", async () => {
  const graph = normalizarRespuestaGraph(await leerFixture("graph_lead.json"), "900000000000001");
  const lead = normalizarCampos(graph.fieldData);

  // Nada se pierde: `respuestas` tiene los ocho campos con su nombre original.
  assertEquals(Object.keys(lead.respuestas).length, 8);
  assertEquals(lead.respuestas["¿Cuántas propiedades administras?"], ["Entre 10 y 50"]);

  assertEquals(Object.keys(lead.personalizadas).length, 2);
  assertEquals(lead.personalizadas["¿Qué proceso te gustaría automatizar?"], "Seguimiento de arriendos");
  assert(!("email" in lead.personalizadas));
});

Deno.test("reconoce variantes en espanol y con acentos", () => {
  const lead = normalizarCampos([
    { name: "Nombre Completo", values: ["Luis Pardo"] },
    { name: "Correo Electrónico", values: ["luis@example.com"] },
    { name: "teléfono", values: ["+56911111111"] },
    { name: "Empresa", values: ["Constructora X"] },
  ]);
  assertEquals(lead.nombre, "Luis Pardo");
  assertEquals(lead.email, "luis@example.com");
  assertEquals(lead.telefono, "+56911111111");
  assertEquals(lead.empresa, "Constructora X");
  assertEquals(Object.keys(lead.personalizadas).length, 0);
});

Deno.test("respuestas de opcion multiple se conservan todas", () => {
  const lead = normalizarCampos([{ name: "servicios", values: ["Dashboards", "Automatizacion", "IA"] }]);
  assertEquals(lead.respuestas["servicios"].length, 3);
  assertEquals(lead.personalizadas["servicios"], "Dashboards, Automatizacion, IA");
});

Deno.test("normalizarRespuestaGraph sanea basura sin lanzar", () => {
  const g = normalizarRespuestaGraph(
    {
      id: 900,
      created_time: "2026-08-16T14:30:00+0000",
      field_data: [
        null,
        "no es objeto",
        { name: "email", values: ["a@example.com", 42, null] },
        { values: ["sin nombre"] },
        { name: "vacio", values: [] },
      ],
    },
    "fallback",
  );

  assertEquals(g.id, "900");
  assertEquals(g.fieldData.length, 2);
  assertEquals(g.fieldData[0], { name: "email", values: ["a@example.com", "42"] });
  assertEquals(g.fieldData[1], { name: "vacio", values: [] });
});

Deno.test("normalizarRespuestaGraph usa el leadgenId si la respuesta no trae id", () => {
  assertEquals(normalizarRespuestaGraph({}, "900000000000001").id, "900000000000001");
});

// ---------------------------------------------------------------------------
// Graph API: version, campos, URL y politica de reintentos
// ---------------------------------------------------------------------------

Deno.test("la version por defecto de Graph API es v26.0", () => {
  assertEquals(VERSION_GRAPH_POR_DEFECTO, "v26.0");
  // Sin variable de entorno, y con la variable vacia o en blanco.
  assertEquals(versionGraph(undefined), "v26.0");
  assertEquals(versionGraph(""), "v26.0");
  assertEquals(versionGraph("   "), "v26.0");
  // Y la URL que se arma efectivamente la usa.
  assertStringIncludes(urlGraph(versionGraph(undefined), "1", CAMPOS_GRAPH), "/v26.0/");
});

Deno.test("META_GRAPH_API_VERSION sigue siendo configurable", () => {
  assertEquals(versionGraph("v25.0"), "v25.0");
  assertEquals(versionGraph("  v27.0 "), "v27.0");
  assertStringIncludes(urlGraph(versionGraph("v25.0"), "1", CAMPOS_GRAPH), "/v25.0/");
});

Deno.test("versionGraph rechaza formatos que no sean vNN.N", () => {
  // Se interpola en una URL: no puede ser cualquier cosa.
  for (const malo of ["26.0", "v26", "v26.0/../me", "?access_token=x", "latest", "v26.0&x=1"]) {
    let lanzo = false;
    try {
      versionGraph(malo);
    } catch {
      lanzo = true;
    }
    assert(lanzo, `deberia rechazar "${malo}"`);
  }
});

Deno.test("solo se piden campos documentados del nodo lead en v26.0", () => {
  // adset_id, campaign_id, platform e is_organic NO estan documentados en el nodo
  // lead: pedirlos devuelve 400 y tumba el lead entero.
  assertEquals([...CAMPOS_GRAPH], ["id", "created_time", "field_data", "form_id", "ad_id"]);
  const url = urlGraph("v26.0", "1", CAMPOS_GRAPH);
  for (const prohibido of ["adset_id", "campaign_id", "platform", "is_organic"]) {
    assert(!url.includes(prohibido), `no deberia pedir ${prohibido}`);
  }
});

Deno.test("la URL de Graph no lleva el token", () => {
  const url = urlGraph("v26.0", "900000000000001", CAMPOS_GRAPH);
  assert(url.startsWith("https://graph.facebook.com/v26.0/900000000000001?"));
  assert(!url.includes("access_token"));
});

Deno.test("politica de reintentos ante errores de Graph", () => {
  // Limites y fallas temporales: se reintenta.
  assert(esReintentable(429, null));
  assert(esReintentable(500, null));
  assert(esReintentable(503, null));
  assert(esReintentable(0, null)); // sin respuesta: timeout o red
  assert(esReintentable(400, 4)); // limite de la app
  assert(esReintentable(400, 613)); // llamadas por hora
  // Un 429 con codigo de limite sigue siendo reintentable.
  assert(esReintentable(429, 17));

  // Problemas que no se arreglan solos: no se reintenta.
  assert(!esReintentable(400, 190)); // token vencido
  assert(!esReintentable(403, 200)); // falta leads_retrieval
  assert(!esReintentable(400, 100)); // objeto no accesible
  assert(!esReintentable(404, null));
  // Un codigo permanente manda aunque el status sea 5xx.
  assert(!esReintentable(500, 190));
});

// ---------------------------------------------------------------------------
// Higiene de errores y logs
// ---------------------------------------------------------------------------

Deno.test("los correos se ofuscan para los logs", () => {
  assertEquals(ofuscarEmail("persona@example.com"), "p***@example.com");
  assertEquals(ofuscarEmail("a@example.com"), "*@example.com");
  assertEquals(ofuscarEmail(""), "");
  assertEquals(ofuscarEmail("sin-arroba"), "***");
});

Deno.test("sanitizarError borra los secretos conocidos y los que parecen token", () => {
  const token = "EAAG1234567890abcdefghijklmnopqrstuvwxyz";
  const secreto = "app-secret-larguisimo-de-prueba";

  const limpio = sanitizarError(
    `fallo con access_token=${token} y secret ${secreto} (Bearer ${token})`,
    [secreto, token],
  );

  assert(!limpio.includes(token), "no debe quedar el token");
  assert(!limpio.includes(secreto), "no debe quedar el app secret");
  assertStringIncludes(limpio, "[REDACTADO]");

  // Aunque no este en la lista de secretos conocidos, el patron se redacta igual.
  const otro = sanitizarError(`Graph dijo: access_token=EAAotroTokenLargoQueNoConocemos123`, []);
  assert(!otro.includes("EAAotroTokenLargoQueNoConocemos123"));

  // Los mensajes se recortan para no llenar la columna.
  assertEquals(sanitizarError("x".repeat(2000)).length, 500);
});

// ---------------------------------------------------------------------------
// Codigos HTTP
// ---------------------------------------------------------------------------

Deno.test("el codigo HTTP sale del peor desenlace de la entrega", () => {
  assertEquals(codigoHttp(["completed"]), 200);
  assertEquals(codigoHttp(["already_completed"]), 200);
  assertEquals(codigoHttp(["completed", "already_completed"]), 200);
  assertEquals(codigoHttp([]), 200);

  // Un temporal manda sobre todo lo demas: Meta tiene que reintentar.
  assertEquals(codigoHttp(["completed", "retry"]), 503);
  assertEquals(codigoHttp(["retry", "permanent"]), 503);

  // Permanente solo si no hay ningun temporal.
  assertEquals(codigoHttp(["completed", "permanent"]), 500);
  assertEquals(codigoHttp(["permanent"]), 500);
});

// ---------------------------------------------------------------------------
// Doble de la base de datos
// ---------------------------------------------------------------------------

/** Umbral de abandono, igual al `p_stale_after` de la funcion SQL. */
const STALE_MS = 5 * 60 * 1000;

interface Fila {
  status: "pending" | "processing" | "completed" | "failed";
  attempt_count: number;
  last_attempt_at: number | null;
  last_error: string | null;
  processed_at: number | null;
  lead_id: number | null;
  contacto_id: number | null;
}

interface Registro {
  empresas: { nombre: string; ciudad: string | null }[];
  contactos: { nombre: string; email: string | null }[];
  leads: { leadgenId: string; titulo: string; notas: string }[];
  completados: DatosProcesado[];
}

/** Cede el turno del event loop, para que dos flujos puedan intercalarse. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Almacen en memoria que replica `reclamar_meta_lead`. El reloj es manual para
 * poder simular un `processing` abandonado sin esperar cinco minutos.
 */
function almacenFalso() {
  const filas = new Map<string, Fila>();
  const r: Registro = { empresas: [], contactos: [], leads: [], completados: [] };
  let ahora = 1_786_000_000_000;
  let seq = 1;

  const almacen: Almacen = {
    async reclamar(evento: EventoLeadgen): Promise<ResultadoReclamo> {
      // El await simula el viaje a la base; lo de abajo es la parte atomica.
      await tick();
      const f = filas.get(evento.leadgenId);

      if (!f) {
        filas.set(evento.leadgenId, {
          status: "processing",
          attempt_count: 1,
          last_attempt_at: ahora,
          last_error: null,
          processed_at: null,
          lead_id: null,
          contacto_id: null,
        });
        return { tipo: "claimed", intento: 1 };
      }

      const abandonado = f.status === "processing" &&
        (f.last_attempt_at === null || ahora - f.last_attempt_at >= STALE_MS);

      if (f.status === "pending" || f.status === "failed" || abandonado) {
        f.status = "processing";
        f.attempt_count += 1;
        f.last_attempt_at = ahora;
        return { tipo: "claimed", intento: f.attempt_count };
      }

      if (f.status === "completed") return { tipo: "completed" };
      return { tipo: "in_progress" };
    },

    async buscarEmpresaPorNombre(nombre) {
      await tick();
      const i = r.empresas.findIndex((e) => e.nombre.toLowerCase() === nombre.toLowerCase());
      return i === -1 ? null : i + 1000;
    },
    async crearEmpresa(datos) {
      await tick();
      r.empresas.push(datos);
      return r.empresas.length + 999;
    },
    async buscarContactoPorEmail(email) {
      await tick();
      const i = r.contactos.findIndex((c) => c.email?.toLowerCase() === email.toLowerCase());
      return i === -1 ? null : i + 2000;
    },
    async crearContacto(datos) {
      await tick();
      r.contactos.push({ nombre: datos.nombre, email: datos.email });
      return r.contactos.length + 1999;
    },
    async crearLead(datos) {
      await tick();
      r.leads.push({ leadgenId: datos.leadgenId, titulo: datos.titulo, notas: datos.notas });
      return seq++;
    },
    async marcarCompletado(id, datos) {
      await tick();
      const f = filas.get(id);
      if (f) {
        f.status = "completed";
        f.processed_at = ahora;
        f.last_error = null;
        f.lead_id = datos.leadId;
        f.contacto_id = datos.contactoId;
      }
      r.completados.push(datos);
    },
    async marcarFallido(id, detalle) {
      await tick();
      const f = filas.get(id);
      if (f) {
        f.status = "failed";
        f.last_error = detalle;
      }
    },
  };

  return {
    almacen,
    r,
    filas,
    fila: (id: string) => filas.get(id),
    avanzarReloj: (ms: number) => {
      ahora += ms;
    },
  };
}

const EVENTO: EventoLeadgen = {
  leadgenId: "900000000000001",
  formId: "700000000000001",
  pageId: "100000000000001",
  adId: "600000000000002",
  createdTime: 1786000000,
};

async function graphDeFixture(): Promise<LeadDeGraph> {
  return normalizarRespuestaGraph(await leerFixture("graph_lead.json"), EVENTO.leadgenId);
}

// ---------------------------------------------------------------------------
// Flujo completo
// ---------------------------------------------------------------------------

Deno.test("lead valido crea empresa, contacto y lead, y queda completed", async () => {
  const { almacen, r, fila } = almacenFalso();
  const graph = await graphDeFixture();

  const res = await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) });

  assertEquals(res, "completed");
  assertEquals(codigoHttp([res]), 200);
  assertEquals(r.empresas.length, 1);
  assertEquals(r.empresas[0].nombre, "Empresa Ficticia SpA");
  assertEquals(r.contactos.length, 1);
  assertEquals(r.contactos[0].email, "prueba@example.com");
  assertEquals(r.leads.length, 1);
  assertEquals(r.leads[0].titulo, "Meta Ads: Empresa Ficticia SpA");

  const f = fila(EVENTO.leadgenId)!;
  assertEquals(f.status, "completed");
  assertEquals(f.attempt_count, 1);
  assertEquals(f.last_error, null);
  assert(f.processed_at !== null, "processed_at debe quedar puesto");
  assert(f.lead_id !== null, "la fila debe apuntar al lead creado");
  assert(f.contacto_id !== null, "la fila debe apuntar al contacto creado");

  // Las preguntas personalizadas viajan a las notas del lead.
  assertStringIncludes(r.leads[0].notas, "Seguimiento de arriendos");
  assertStringIncludes(r.leads[0].notas, "Origen: Meta Lead Ads");
  // Y las respuestas completas quedan para persistir en jsonb.
  assertEquals(Object.keys(r.completados[0].lead.respuestas).length, 8);
});

Deno.test("un completed no se vuelve a procesar y responde 200", async () => {
  const { almacen, r, fila } = almacenFalso();
  const graph = await graphDeFixture();
  let llamadasGraph = 0;
  const deps = {
    almacen,
    traerDeGraph: () => {
      llamadasGraph++;
      return Promise.resolve(graph);
    },
  };

  assertEquals(await procesarEvento(EVENTO, deps), "completed");
  assertEquals(await procesarEvento(EVENTO, deps), "already_completed");
  assertEquals(await procesarEvento(EVENTO, deps), "already_completed");

  // Ni un contacto de mas, ni una llamada de mas a Graph.
  assertEquals(r.leads.length, 1);
  assertEquals(r.contactos.length, 1);
  assertEquals(r.empresas.length, 1);
  assertEquals(llamadasGraph, 1);
  assertEquals(codigoHttp(["already_completed"]), 200);
  // El reintento no toca attempt_count: no se reclamo.
  assertEquals(fila(EVENTO.leadgenId)!.attempt_count, 1);
});

Deno.test("falla despues de reclamar: la fila queda failed, no colgada en processing", async () => {
  const { almacen, r, fila } = almacenFalso();

  const res = await procesarEvento(EVENTO, {
    almacen,
    traerDeGraph: () => Promise.reject(new ErrorGraph("Graph API 500: se cayo", 500, null, true)),
  });

  assertEquals(res, "retry");
  assertEquals(codigoHttp([res]), 503);
  assertEquals(r.leads.length, 0);
  assertEquals(r.contactos.length, 0);

  const f = fila(EVENTO.leadgenId)!;
  // Lo importante: NO queda en processing, que bloquearia el lead hasta el umbral.
  assertEquals(f.status, "failed");
  assertEquals(f.attempt_count, 1);
  assertEquals(f.processed_at, null);
  assertStringIncludes(f.last_error!, "500");
});

Deno.test("un registro failed se puede reintentar y completar", async () => {
  const { almacen, r, fila } = almacenFalso();
  const graph = await graphDeFixture();

  // Primer intento: Graph se cae.
  let caer = true;
  const deps = {
    almacen,
    traerDeGraph: () =>
      caer
        ? Promise.reject(new ErrorGraph("Graph API 503", 503, null, true))
        : Promise.resolve(graph),
  };

  assertEquals(await procesarEvento(EVENTO, deps), "retry");
  assertEquals(fila(EVENTO.leadgenId)!.status, "failed");

  // Meta reintenta la entrega y esta vez Graph responde.
  caer = false;
  assertEquals(await procesarEvento(EVENTO, deps), "completed");

  const f = fila(EVENTO.leadgenId)!;
  assertEquals(f.status, "completed");
  assertEquals(f.attempt_count, 2); // se reclamo dos veces
  assertEquals(f.last_error, null);
  assertEquals(r.leads.length, 1); // y no duplico
  assertEquals(r.contactos.length, 1);
});

Deno.test("un processing abandonado se recupera pasado el umbral", async () => {
  const { almacen, r, fila, avanzarReloj } = almacenFalso();
  const graph = await graphDeFixture();

  // Se reclama y el proceso "muere" sin marcar nada: la fila queda en processing.
  const reclamo = await almacen.reclamar(EVENTO);
  assertEquals(reclamo.tipo, "claimed");
  assertEquals(fila(EVENTO.leadgenId)!.status, "processing");

  // Mientras esta fresco, otra entrega no lo toca: no duplica.
  assertEquals(
    await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) }),
    "retry",
  );
  assertEquals(r.contactos.length, 0);

  // Pasado el umbral, se puede recuperar.
  avanzarReloj(STALE_MS + 1000);
  assertEquals(
    await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) }),
    "completed",
  );

  const f = fila(EVENTO.leadgenId)!;
  assertEquals(f.status, "completed");
  assertEquals(f.attempt_count, 2);
  assertEquals(r.contactos.length, 1);
  assertEquals(r.leads.length, 1);
});

Deno.test("dos entregas concurrentes nunca crean dos contactos", async () => {
  const { almacen, r, fila } = almacenFalso();
  const graph = await graphDeFixture();
  const deps = {
    almacen,
    traerDeGraph: async () => {
      await tick();
      return graph;
    },
  };

  // Las dos arrancan antes de que ninguna termine.
  const [a, b] = await Promise.all([
    procesarEvento(EVENTO, deps),
    procesarEvento(EVENTO, deps),
  ]);

  // Una gana el reclamo y completa; la otra se retira pidiendo reintento.
  const desenlaces = [a, b].sort();
  assertEquals(desenlaces, ["completed", "retry"]);

  assertEquals(r.contactos.length, 1, "no puede haber dos contactos");
  assertEquals(r.leads.length, 1, "no puede haber dos leads");
  assertEquals(r.empresas.length, 1);
  assertEquals(fila(EVENTO.leadgenId)!.status, "completed");

  // El 503 de la perdedora hace que Meta reintente; esa reentrega ve completed.
  assertEquals(codigoHttp([a, b]), 503);
  assertEquals(await procesarEvento(EVENTO, deps), "already_completed");
  assertEquals(r.contactos.length, 1);
});

Deno.test("cinco entregas concurrentes tampoco duplican", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();
  const deps = {
    almacen,
    traerDeGraph: async () => {
      await tick();
      return graph;
    },
  };

  const res = await Promise.all(Array.from({ length: 5 }, () => procesarEvento(EVENTO, deps)));

  assertEquals(res.filter((d) => d === "completed").length, 1);
  assertEquals(res.filter((d) => d === "retry").length, 4);
  assertEquals(r.contactos.length, 1);
  assertEquals(r.leads.length, 1);
});

Deno.test("un 429 y un 5xx terminan en respuesta reintentable", async () => {
  for (const [status, codigo] of [[429, 4], [429, null], [500, null], [503, null], [0, null]] as const) {
    const { almacen, r, fila } = almacenFalso();
    const res = await procesarEvento(EVENTO, {
      almacen,
      traerDeGraph: () =>
        Promise.reject(
          new ErrorGraph(`Graph API ${status}`, status, codigo, esReintentable(status, codigo)),
        ),
    });

    assertEquals(res, "retry", `status ${status} deberia ser reintentable`);
    assertEquals(codigoHttp([res]), 503);
    // Y queda reclamable para el reintento de Meta.
    assertEquals(fila(EVENTO.leadgenId)!.status, "failed");
    assertEquals(r.contactos.length, 0);
  }
});

Deno.test("token invalido: desenlace permanente y sin secretos en last_error", async () => {
  const token = "EAAG1234567890abcdefghijklmnopqrstuvwxyz";
  const { almacen, fila } = almacenFalso();

  const res = await procesarEvento(EVENTO, {
    almacen,
    // Mensaje realista: Meta a veces devuelve el token dentro del propio error.
    traerDeGraph: () =>
      Promise.reject(
        new ErrorGraph(
          `Graph API 400 (codigo 190): Error validating access token=${token}`,
          400,
          190,
          false,
        ),
      ),
    secretos: [token],
  });

  // No es reintentable: reintentar con el mismo token invalido no arregla nada.
  assertEquals(res, "permanent");
  assertEquals(codigoHttp([res]), 500);

  const f = fila(EVENTO.leadgenId)!;
  assertEquals(f.status, "failed"); // reclamable una vez que se arregle el token
  assert(!f.last_error!.includes(token), "el token no puede quedar en last_error");
  assertStringIncludes(f.last_error!, "[REDACTADO]");
  assertStringIncludes(f.last_error!, "190"); // el codigo si, para diagnosticar
});

Deno.test("si no se puede ni reclamar, se pide reintento y no se toca nada", async () => {
  const { almacen, r } = almacenFalso();
  almacen.reclamar = () => Promise.reject(new Error("base de datos inalcanzable"));

  const res = await procesarEvento(EVENTO, {
    almacen,
    traerDeGraph: () => Promise.reject(new Error("no deberia llegar aca")),
  });

  assertEquals(res, "retry");
  assertEquals(codigoHttp([res]), 503);
  assertEquals(r.contactos.length, 0);
});

Deno.test("contacto existente se reutiliza en vez de duplicarse", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();

  await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) });
  // Segundo lead distinto, misma persona.
  await procesarEvento(
    { ...EVENTO, leadgenId: "900000000000002" },
    { almacen, traerDeGraph: () => Promise.resolve(graph) },
  );

  assertEquals(r.leads.length, 2);
  assertEquals(r.contactos.length, 1);
  assertEquals(r.empresas.length, 1);
});

Deno.test("un lead sin empresa igual se guarda", async () => {
  const { almacen, r } = almacenFalso();
  const graph = normalizarRespuestaGraph(
    { id: EVENTO.leadgenId, field_data: [{ name: "email", values: ["solo@example.com"] }] },
    EVENTO.leadgenId,
  );

  assertEquals(
    await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) }),
    "completed",
  );
  assertEquals(r.empresas.length, 0);
  assertEquals(r.leads.length, 1);
  assertEquals(r.leads[0].titulo, "Lead desde Meta Ads");
  assertEquals(r.contactos[0].nombre, "Sin nombre");
});

Deno.test("un fallo del correo no invalida el lead ya guardado", async () => {
  const { almacen, r, fila } = almacenFalso();
  const graph = await graphDeFixture();

  const res = await procesarEvento(EVENTO, {
    almacen,
    traerDeGraph: () => Promise.resolve(graph),
    notificar: () => Promise.reject(new Error("Resend caido")),
  });

  // El correo es accesorio: el lead ya esta a salvo, no se pide reintento.
  assertEquals(res, "completed");
  assertEquals(r.leads.length, 1);
  assertEquals(fila(EVENTO.leadgenId)!.status, "completed");
});

Deno.test("si falla la escritura del contacto se marca failed y se reintenta", async () => {
  const { almacen, r, fila } = almacenFalso();
  const graph = await graphDeFixture();
  almacen.crearContacto = () => Promise.reject(new Error("contacto: conexion perdida"));

  const res = await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) });

  assertEquals(res, "retry");
  assertEquals(codigoHttp([res]), 503);
  assertEquals(fila(EVENTO.leadgenId)!.status, "failed");
  assertEquals(r.leads.length, 0);
});

Deno.test("si falla marcarCompletado se pide reintento (la reentrega es idempotente)", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();
  almacen.marcarCompletado = () => Promise.reject(new Error("update: conexion perdida"));

  const res = await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) });

  // El lead se creo pero la fila no llego a `completed`: mejor 503 que mentir.
  assertEquals(res, "retry");
  assertEquals(r.leads.length, 1);
});

Deno.test("ErrorGraph conserva status, codigo y si es reintentable", async () => {
  await assertRejects(
    () => Promise.reject(new ErrorGraph("limite alcanzado", 429, 4, true)),
    ErrorGraph,
    "limite alcanzado",
  );
  const e = new ErrorGraph("x", 429, 4, true);
  assertEquals(e.status, 429);
  assertEquals(e.codigo, 4);
  assert(e.reintentable);
});

Deno.test("los desenlaces cubren todos los casos del tipo", () => {
  // Si se agrega un desenlace nuevo, esta prueba obliga a mapearlo a un codigo.
  const todos: Desenlace[] = ["completed", "already_completed", "retry", "permanent"];
  assertEquals(todos.map((d) => codigoHttp([d])), [200, 200, 503, 500]);
});
