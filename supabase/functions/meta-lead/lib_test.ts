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
  type DatosPersistencia,
  type Desenlace,
  ErrorGraph,
  esReintentable,
  type EventoLeadgen,
  extraerEventosLeadgen,
  filtrarPorPagina,
  igualSeguro,
  type LeadDeGraph,
  LIMITE_CUERPO_BYTES,
  normalizarCampos,
  normalizarRespuestaGraph,
  ofuscarEmail,
  procesarEvento,
  type ResultadoPersistencia,
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

/** Puntos donde se puede inyectar una falla dentro de la "transaccion". */
type PuntoDeFalla = "empresa" | "contacto" | "lead" | "cierre";

interface Fila {
  status: "pending" | "processing" | "completed" | "failed";
  attempt_count: number;
  last_attempt_at: number | null;
  last_error: string | null;
  processed_at: number | null;
  lead_id: number | null;
  contacto_id: number | null;
  empresa_id: number | null;
}

interface Registro {
  empresas: { id: number; nombre: string; ciudad: string | null }[];
  contactos: { id: number; nombre: string; email: string | null; empresa_id: number | null }[];
  leads: { id: number; leadgenId: string; titulo: string; notas: string; contacto_id: number; empresa_id: number | null }[];
}

/** Cede el turno del event loop, para que dos flujos puedan intercalarse. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Almacen en memoria que replica las dos funciones SQL:
 *
 *   reclamar_meta_lead()  -> maquina de estados y exclusion mutua
 *   procesar_meta_lead()  -> empresa + contacto + lead + cierre, transaccional
 *
 * `persistir` trabaja sobre copias y solo las publica al final. Eso es lo que
 * modela la transaccion de Postgres: si se inyecta una falla en cualquier punto
 * intermedio, no queda NADA escrito, igual que un ROLLBACK.
 *
 * El reloj es manual para poder simular un `processing` abandonado sin esperar
 * cinco minutos.
 */
function almacenFalso() {
  const filas = new Map<string, Fila>();
  const r: Registro = { empresas: [], contactos: [], leads: [] };
  let ahora = 1_786_000_000_000;
  let seqEmpresa = 1000;
  let seqContacto = 2000;
  let seqLead = 1;
  let fallarEn: PuntoDeFalla | null = null;

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
          empresa_id: null,
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

    async persistir(id: string, d: DatosPersistencia): Promise<ResultadoPersistencia> {
      await tick();
      const f = filas.get(id);
      if (!f) throw new Error(`meta_lead ${id} no existe; hay que reclamarlo antes`);

      // Idempotencia dura: si ya se completo no se escribe nada.
      if (f.status === "completed") {
        return { leadId: f.lead_id, contactoId: f.contacto_id, empresaId: f.empresa_id, yaEstaba: true };
      }

      // --- inicio de la "transaccion": se trabaja sobre copias ---
      const empresas = [...r.empresas];
      const contactos = [...r.contactos];
      const leads = [...r.leads];

      // 1) Empresa: checkpoint por id, luego por nombre, luego crear.
      let empresaId = f.empresa_id;
      if (empresaId === null && d.lead.empresa) {
        const hallada = empresas.find((e) => e.nombre.toLowerCase() === d.lead.empresa.toLowerCase());
        if (hallada) empresaId = hallada.id;
        else {
          empresaId = ++seqEmpresa;
          empresas.push({ id: empresaId, nombre: d.lead.empresa, ciudad: d.lead.ciudad || null });
        }
      }
      if (fallarEn === "empresa") throw new Error("falla simulada: despues de crear la empresa");

      // 2) Contacto: checkpoint por id, luego por correo, luego crear.
      let contactoId = f.contacto_id;
      if (contactoId === null && d.lead.email) {
        const c = contactos.find((x) => x.email?.toLowerCase() === d.lead.email.toLowerCase());
        if (c) contactoId = c.id;
      }
      if (contactoId === null) {
        contactoId = ++seqContacto;
        contactos.push({ id: contactoId, nombre: d.lead.nombre, email: d.lead.email || null, empresa_id: empresaId });
      }
      if (fallarEn === "contacto") throw new Error("falla simulada: despues de crear el contacto");

      // 3) Lead: el unico (origen, origen_id) lo hace idempotente.
      let leadId = f.lead_id;
      if (leadId === null) {
        const ya = leads.find((l) => l.leadgenId === id);
        if (ya) leadId = ya.id;
        else {
          leadId = seqLead++;
          leads.push({
            id: leadId,
            leadgenId: id,
            titulo: d.titulo,
            notas: d.notas,
            contacto_id: contactoId,
            empresa_id: empresaId,
          });
        }
      }
      if (fallarEn === "lead") throw new Error("falla simulada: despues de crear el lead");
      if (fallarEn === "cierre") throw new Error("falla simulada: cierre, antes de marcar completed");

      // --- commit: recien aca se publica todo ---
      r.empresas = empresas;
      r.contactos = contactos;
      r.leads = leads;
      f.status = "completed";
      f.processed_at = ahora;
      f.last_error = null;
      f.lead_id = leadId;
      f.contacto_id = contactoId;
      f.empresa_id = empresaId;

      return { leadId, contactoId, empresaId, yaEstaba: false };
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
    fallarEn: (p: PuntoDeFalla | null) => {
      fallarEn = p;
    },
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
// Origen: filtro por pagina y tope de tamano
// ---------------------------------------------------------------------------

Deno.test("sin META_PAGE_ID pasan todos los eventos", () => {
  const eventos = [
    { ...EVENTO, pageId: "100000000000001" },
    { ...EVENTO, leadgenId: "2", pageId: "999" },
  ];
  const { aceptados, descartados } = filtrarPorPagina(eventos, undefined);
  assertEquals(aceptados.length, 2);
  assertEquals(descartados.length, 0);
});

Deno.test("con META_PAGE_ID se descartan los eventos de otra pagina", () => {
  const eventos = [
    { ...EVENTO, pageId: "100000000000001" },
    { ...EVENTO, leadgenId: "2", pageId: "888888888888888" },
    { ...EVENTO, leadgenId: "3", pageId: null },
  ];
  const { aceptados, descartados } = filtrarPorPagina(eventos, "100000000000001");
  assertEquals(aceptados.map((e) => e.leadgenId), ["900000000000001"]);
  // El de otra pagina y el que no se puede atribuir quedan fuera.
  assertEquals(descartados.map((e) => e.leadgenId), ["2", "3"]);
});

Deno.test("el tope de cuerpo es razonable para una entrega real", () => {
  // Una entrega de Meta son unos pocos KB; el tope deja margen sin ser absurdo.
  assertEquals(LIMITE_CUERPO_BYTES, 256 * 1024);
  assert(LIMITE_CUERPO_BYTES > 64 * 1024);
  assert(LIMITE_CUERPO_BYTES < 5 * 1024 * 1024);
});

Deno.test("la firma se valida sobre los bytes crudos, no sobre el JSON reserializado", async () => {
  // Meta firma el cuerpo tal como lo manda. Este cuerpo tiene espaciado propio:
  // pasarlo por JSON.parse/stringify cambia los bytes y romperia el HMAC. Por eso
  // el handler firma el texto crudo ANTES de parsearlo.
  const crudo = '{"object":"page",  "entry":[ {"id":"1"} ]}';
  const firma = await firmar(crudo);

  assert((await verificarFirma(crudo, firma, APP_SECRET)).ok, "el crudo debe validar");

  const reserializado = JSON.stringify(JSON.parse(crudo));
  assert(reserializado !== crudo, "el fixture debe cambiar al reserializar");
  assert(
    !(await verificarFirma(reserializado, firma, APP_SECRET)).ok,
    "validar sobre el reserializado seria un bug",
  );
});

Deno.test("el payload que se guarda no lleva cabeceras, firma ni tokens", async () => {
  // `crudo` se arma con una lista blanca de campos, no copiando la respuesta.
  const graph = normalizarRespuestaGraph(
    {
      ...(await leerFixture("graph_lead.json") as Record<string, unknown>),
      // Basura que Graph nunca manda, pero que si llegara no debe quedar guardada.
      access_token: "EAAG1234567890abcdefghijklmnop",
      authorization: "Bearer secreto",
      "x-hub-signature-256": "sha256=deadbeef",
    },
    EVENTO.leadgenId,
  );

  const claves = Object.keys(graph.crudo);
  assertEquals(claves.sort(), ["ad_id", "created_time", "field_data", "form_id", "id"]);

  const serializado = JSON.stringify(graph.crudo);
  for (const prohibido of ["access_token", "authorization", "signature", "Bearer", "EAAG"]) {
    assert(!serializado.includes(prohibido), `el payload no debe contener ${prohibido}`);
  }
});

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

  // Relaciones: la fila apunta a lo creado, y lo creado se apunta entre si.
  assertEquals(f.lead_id, r.leads[0].id);
  assertEquals(f.contacto_id, r.contactos[0].id);
  assertEquals(f.empresa_id, r.empresas[0].id);
  assertEquals(r.leads[0].contacto_id, r.contactos[0].id);
  assertEquals(r.leads[0].empresa_id, r.empresas[0].id);
  assertEquals(r.contactos[0].empresa_id, r.empresas[0].id);

  assertStringIncludes(r.leads[0].notas, "Seguimiento de arriendos");
  assertStringIncludes(r.leads[0].notas, "Origen: Meta Lead Ads");
});

// ---------------------------------------------------------------------------
// Atomicidad: fallas parciales
// ---------------------------------------------------------------------------

/**
 * El nucleo de la auditoria. Se inyecta una falla en cada punto de la escritura y
 * se comprueba que el reintento deja EXACTAMENTE una de cada cosa.
 *
 * Si la persistencia fueran cuatro llamadas sueltas, la falla "despues de crear
 * el contacto" dejaria un contacto huerfano confirmado, y el reintento crearia
 * otro: el fixture no tiene con que deduplicar de forma fiable (empresas.nombre
 * no es unico y hay leads sin correo). Con todo en una transaccion, el intento
 * fallido no deja rastro.
 */
for (const punto of ["empresa", "contacto", "lead", "cierre"] as const) {
  Deno.test(`falla despues de "${punto}": el reintento deja exactamente una de cada cosa`, async () => {
    const { almacen, r, filas, fila, fallarEn } = almacenFalso();
    const graph = await graphDeFixture();
    const deps = { almacen, traerDeGraph: () => Promise.resolve(graph) };

    // Primer intento: se cae en el punto indicado.
    fallarEn(punto);
    assertEquals(await procesarEvento(EVENTO, deps), "retry");

    // Rollback: no quedo NADA a medio escribir.
    assertEquals(r.empresas.length, 0, "no debe quedar empresa huerfana");
    assertEquals(r.contactos.length, 0, "no debe quedar contacto huerfano");
    assertEquals(r.leads.length, 0, "no debe quedar lead huerfano");

    const tras = fila(EVENTO.leadgenId)!;
    assertEquals(tras.status, "failed");
    assertStringIncludes(tras.last_error!, punto);

    // Segundo intento, ya sin la falla.
    fallarEn(null);
    assertEquals(await procesarEvento(EVENTO, deps), "completed");

    // Exactamente una de cada cosa.
    assertEquals(r.empresas.length, 1, "una empresa");
    assertEquals(r.contactos.length, 1, "un contacto");
    assertEquals(r.leads.length, 1, "un lead");
    assertEquals(filas.size, 1, "un meta_lead");

    // Y las relaciones bien enlazadas.
    const f = fila(EVENTO.leadgenId)!;
    assertEquals(f.status, "completed");
    assertEquals(f.attempt_count, 2);
    assertEquals(f.last_error, null);
    assertEquals(f.empresa_id, r.empresas[0].id);
    assertEquals(f.contacto_id, r.contactos[0].id);
    assertEquals(f.lead_id, r.leads[0].id);
    assertEquals(r.leads[0].contacto_id, r.contactos[0].id);
    assertEquals(r.leads[0].empresa_id, r.empresas[0].id);
    assertEquals(r.contactos[0].empresa_id, r.empresas[0].id);
  });
}

Deno.test("un lead sin correo tampoco se duplica tras una falla parcial", async () => {
  // El caso peligroso: sin correo no hay con que deduplicar el contacto. Hoy 41
  // de 57 contactos del CRM no tienen correo, asi que no es hipotetico.
  const { almacen, r, filas, fallarEn } = almacenFalso();
  const graph = normalizarRespuestaGraph(
    {
      id: EVENTO.leadgenId,
      field_data: [
        { name: "full_name", values: ["Sin Correo"] },
        { name: "phone_number", values: ["+56900000000"] },
      ],
    },
    EVENTO.leadgenId,
  );
  const deps = { almacen, traerDeGraph: () => Promise.resolve(graph) };

  fallarEn("lead");
  assertEquals(await procesarEvento(EVENTO, deps), "retry");
  assertEquals(r.contactos.length, 0);

  fallarEn(null);
  assertEquals(await procesarEvento(EVENTO, deps), "completed");

  assertEquals(r.contactos.length, 1, "sin correo igual debe haber un solo contacto");
  assertEquals(r.leads.length, 1);
  assertEquals(filas.size, 1);
});

Deno.test("tres fallas seguidas y un exito: sigue habiendo una sola de cada cosa", async () => {
  const { almacen, r, filas, fila, fallarEn } = almacenFalso();
  const graph = await graphDeFixture();
  const deps = { almacen, traerDeGraph: () => Promise.resolve(graph) };

  for (const punto of ["empresa", "contacto", "lead"] as const) {
    fallarEn(punto);
    assertEquals(await procesarEvento(EVENTO, deps), "retry");
  }
  fallarEn(null);
  assertEquals(await procesarEvento(EVENTO, deps), "completed");

  assertEquals(r.empresas.length, 1);
  assertEquals(r.contactos.length, 1);
  assertEquals(r.leads.length, 1);
  assertEquals(filas.size, 1);
  assertEquals(fila(EVENTO.leadgenId)!.attempt_count, 4);
});

Deno.test("persistir sobre una fila ya completed no escribe nada", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();
  const deps = { almacen, traerDeGraph: () => Promise.resolve(graph) };

  await procesarEvento(EVENTO, deps);
  const antes = { e: r.empresas.length, c: r.contactos.length, l: r.leads.length };

  // Llamada directa, saltandose el reclamo: la propia funcion es idempotente.
  const res = await almacen.persistir(EVENTO.leadgenId, {
    lead: normalizarCampos(graph.fieldData),
    graph,
    titulo: "otro titulo",
    notas: "otras notas",
  });

  assert(res.yaEstaba, "debe reportar que ya estaba");
  assertEquals(r.empresas.length, antes.e);
  assertEquals(r.contactos.length, antes.c);
  assertEquals(r.leads.length, antes.l);
});

Deno.test("persistir sin reclamo previo falla en vez de escribir", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();

  await assertRejects(() =>
    almacen.persistir("no-reclamado", {
      lead: normalizarCampos(graph.fieldData),
      graph,
      titulo: "t",
      notas: "n",
    })
  );
  assertEquals(r.contactos.length, 0);
});

// ---------------------------------------------------------------------------
// Idempotencia, concurrencia y recuperacion
// ---------------------------------------------------------------------------

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

  let caer = true;
  const deps = {
    almacen,
    traerDeGraph: () =>
      caer ? Promise.reject(new ErrorGraph("Graph API 503", 503, null, true)) : Promise.resolve(graph),
  };

  assertEquals(await procesarEvento(EVENTO, deps), "retry");
  assertEquals(fila(EVENTO.leadgenId)!.status, "failed");

  caer = false;
  assertEquals(await procesarEvento(EVENTO, deps), "completed");

  const f = fila(EVENTO.leadgenId)!;
  assertEquals(f.status, "completed");
  assertEquals(f.attempt_count, 2);
  assertEquals(f.last_error, null);
  assertEquals(r.leads.length, 1);
  assertEquals(r.contactos.length, 1);
});

Deno.test("un processing abandonado se recupera pasado el umbral", async () => {
  const { almacen, r, fila, avanzarReloj } = almacenFalso();
  const graph = await graphDeFixture();

  // Se reclama y el proceso "muere" sin marcar nada: la fila queda en processing.
  assertEquals((await almacen.reclamar(EVENTO)).tipo, "claimed");
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

  const [a, b] = await Promise.all([procesarEvento(EVENTO, deps), procesarEvento(EVENTO, deps)]);

  // Una gana el reclamo y completa; la otra se retira pidiendo reintento.
  assertEquals([a, b].sort(), ["completed", "retry"]);
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
  const { almacen, r, filas } = almacenFalso();
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
  assertEquals(filas.size, 1);
});

Deno.test("un 429 y un 5xx terminan en respuesta reintentable", async () => {
  for (const [status, codigo] of [[429, 4], [429, null], [500, null], [503, null], [0, null]] as const) {
    const { almacen, r, fila } = almacenFalso();
    const res = await procesarEvento(EVENTO, {
      almacen,
      traerDeGraph: () =>
        Promise.reject(new ErrorGraph(`Graph API ${status}`, status, codigo, esReintentable(status, codigo))),
    });

    assertEquals(res, "retry", `status ${status} deberia ser reintentable`);
    assertEquals(codigoHttp([res]), 503);
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
        new ErrorGraph(`Graph API 400 (codigo 190): Error validating access token=${token}`, 400, 190, false),
      ),
    secretos: [token],
  });

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
