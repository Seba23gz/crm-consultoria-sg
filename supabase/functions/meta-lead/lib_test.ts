// Pruebas de la integracion con Meta Lead Ads.
//
//   deno task test
//
// No tocan la red ni la base de datos: Graph API y la persistencia entran como
// dobles. Los fixtures son inventados, sin datos personales reales.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Almacen,
  type DatosProcesado,
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
  urlGraph,
  verificarFirma,
  verificarSuscripcion,
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
  // Ni siquiera si el token que llega es la cadena vacia.
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
  // Nada de esto debe lanzar: son cuerpos que Meta o un tercero podrian mandar.
  assertEquals(extraerEventosLeadgen(null).length, 0);
  assertEquals(extraerEventosLeadgen("texto suelto").length, 0);
  assertEquals(extraerEventosLeadgen({}).length, 0);
  assertEquals(extraerEventosLeadgen({ object: "page" }).length, 0);
  assertEquals(extraerEventosLeadgen({ object: "page", entry: "no es lista" }).length, 0);
  assertEquals(extraerEventosLeadgen({ object: "page", entry: [null, 5, {}] }).length, 0);
  // Objeto que no es `page`: no nos incumbe.
  assertEquals(
    extraerEventosLeadgen({
      object: "instagram",
      entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: "1" } }] }],
    }).length,
    0,
  );
  // `leadgen` sin leadgen_id: no hay nada que ir a buscar.
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

  // Y las no estandar quedan aparte, listas para mostrar.
  assertEquals(Object.keys(lead.personalizadas).length, 2);
  assertEquals(lead.personalizadas["¿Qué proceso te gustaría automatizar?"], "Seguimiento de arriendos");
  // Los estandar no se duplican como personalizados.
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
  // Al reconocerlos como estandar no se repiten en personalizadas.
  assertEquals(Object.keys(lead.personalizadas).length, 0);
});

Deno.test("respuestas de opcion multiple se conservan todas", () => {
  const lead = normalizarCampos([
    { name: "servicios", values: ["Dashboards", "Automatizacion", "IA"] },
  ]);
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
      is_organic: "no es booleano",
    },
    "fallback",
  );

  assertEquals(g.id, "900");
  assertEquals(g.esOrganico, null);
  assertEquals(g.adsetId, null);
  // Solo sobreviven los campos con nombre; los valores no-texto se descartan.
  assertEquals(g.fieldData.length, 2);
  assertEquals(g.fieldData[0], { name: "email", values: ["a@example.com", "42"] });
  assertEquals(g.fieldData[1], { name: "vacio", values: [] });
});

Deno.test("normalizarRespuestaGraph usa el leadgenId si la respuesta no trae id", () => {
  assertEquals(normalizarRespuestaGraph({}, "900000000000001").id, "900000000000001");
});

// ---------------------------------------------------------------------------
// Graph API: version, URL y politica de reintentos
// ---------------------------------------------------------------------------

Deno.test("versionGraph valida el formato", () => {
  assertEquals(versionGraph("v21.0"), "v21.0");
  assertEquals(versionGraph(undefined), "v21.0");
  assertEquals(versionGraph("  v23.0 "), "v23.0");
  // No se acepta cualquier cosa: se interpola en una URL.
  for (const malo of ["21.0", "v21", "v21.0/../me", "?access_token=x", "latest"]) {
    let lanzo = false;
    try {
      versionGraph(malo);
    } catch {
      lanzo = true;
    }
    assert(lanzo, `deberia rechazar "${malo}"`);
  }
});

Deno.test("la URL de Graph no lleva el token", () => {
  const url = urlGraph("v21.0", "900000000000001", ["id", "field_data"]);
  assert(url.startsWith("https://graph.facebook.com/v21.0/900000000000001?"));
  assert(!url.includes("access_token"));
});

Deno.test("politica de reintentos ante errores de Graph", () => {
  // Limites y fallas temporales: se reintenta.
  assert(esReintentable(429, null));
  assert(esReintentable(500, null));
  assert(esReintentable(503, null));
  assert(esReintentable(400, 4)); // limite de la app
  assert(esReintentable(400, 613)); // llamadas por hora

  // Problemas que no se arreglan solos: no se reintenta.
  assert(!esReintentable(400, 190)); // token vencido
  assert(!esReintentable(403, 200)); // falta leads_retrieval
  assert(!esReintentable(400, 100)); // objeto no accesible
  assert(!esReintentable(404, null));
});

// ---------------------------------------------------------------------------
// Privacidad en logs
// ---------------------------------------------------------------------------

Deno.test("los correos se ofuscan para los logs", () => {
  assertEquals(ofuscarEmail("persona@example.com"), "p***@example.com");
  assertEquals(ofuscarEmail("a@example.com"), "*@example.com");
  assertEquals(ofuscarEmail(""), "");
  assertEquals(ofuscarEmail("sin-arroba"), "***");
});

// ---------------------------------------------------------------------------
// Flujo completo con dobles
// ---------------------------------------------------------------------------

interface Registro {
  empresas: { nombre: string; ciudad: string | null }[];
  contactos: { nombre: string; email: string | null }[];
  leads: { leadgenId: string; titulo: string; notas: string }[];
  procesados: DatosProcesado[];
  errores: string[];
}

/** Almacen en memoria que replica la idempotencia del indice unico. */
function almacenFalso() {
  const reclamados = new Set<string>();
  const r: Registro = { empresas: [], contactos: [], leads: [], procesados: [], errores: [] };
  let seq = 1;

  const almacen: Almacen = {
    reclamar(evento: EventoLeadgen) {
      if (reclamados.has(evento.leadgenId)) return Promise.resolve(false);
      reclamados.add(evento.leadgenId);
      return Promise.resolve(true);
    },
    buscarEmpresaPorNombre(nombre) {
      const i = r.empresas.findIndex((e) => e.nombre.toLowerCase() === nombre.toLowerCase());
      return Promise.resolve(i === -1 ? null : i + 1000);
    },
    crearEmpresa(datos) {
      r.empresas.push(datos);
      return Promise.resolve(r.empresas.length + 999);
    },
    buscarContactoPorEmail(email) {
      const i = r.contactos.findIndex((c) => c.email?.toLowerCase() === email.toLowerCase());
      return Promise.resolve(i === -1 ? null : i + 2000);
    },
    crearContacto(datos) {
      r.contactos.push({ nombre: datos.nombre, email: datos.email });
      return Promise.resolve(r.contactos.length + 1999);
    },
    crearLead(datos) {
      r.leads.push({ leadgenId: datos.leadgenId, titulo: datos.titulo, notas: datos.notas });
      return Promise.resolve(seq++);
    },
    marcarProcesado(_id, datos) {
      r.procesados.push(datos);
      return Promise.resolve();
    },
    marcarError(_id, detalle) {
      r.errores.push(detalle);
      return Promise.resolve();
    },
  };

  return { almacen, r };
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

Deno.test("lead valido crea empresa, contacto y lead", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();

  const res = await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) });

  assertEquals(res, "nuevo");
  assertEquals(r.empresas.length, 1);
  assertEquals(r.empresas[0].nombre, "Empresa Ficticia SpA");
  assertEquals(r.contactos.length, 1);
  assertEquals(r.contactos[0].email, "prueba@example.com");
  assertEquals(r.leads.length, 1);
  assertEquals(r.leads[0].titulo, "Meta Ads: Empresa Ficticia SpA");
  assertEquals(r.errores.length, 0);

  // Las preguntas personalizadas viajan a las notas del lead.
  assert(r.leads[0].notas.includes("Seguimiento de arriendos"));
  assert(r.leads[0].notas.includes("Origen: Meta Lead Ads"));

  // Y las respuestas completas quedan para persistir en jsonb.
  assertEquals(Object.keys(r.procesados[0].lead.respuestas).length, 8);
  assertEquals(r.procesados[0].graph.adsetId, "600000000000003");
  assertEquals(r.procesados[0].graph.plataforma, "ig");
});

Deno.test("el mismo leadgen_id dos veces no duplica nada", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();
  const deps = { almacen, traerDeGraph: () => Promise.resolve(graph) };

  assertEquals(await procesarEvento(EVENTO, deps), "nuevo");
  assertEquals(await procesarEvento(EVENTO, deps), "duplicado");
  assertEquals(await procesarEvento(EVENTO, deps), "duplicado");

  assertEquals(r.leads.length, 1);
  assertEquals(r.contactos.length, 1);
  assertEquals(r.empresas.length, 1);
});

Deno.test("la reentrega no vuelve a llamar a Graph API", async () => {
  const { almacen } = almacenFalso();
  const graph = await graphDeFixture();
  let llamadas = 0;
  const deps = {
    almacen,
    traerDeGraph: () => {
      llamadas++;
      return Promise.resolve(graph);
    },
  };

  await procesarEvento(EVENTO, deps);
  await procesarEvento(EVENTO, deps);

  // La reclamacion corta antes de gastar cuota de la API.
  assertEquals(llamadas, 1);
});

Deno.test("contacto existente se reutiliza en vez de duplicarse", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();

  // Primer lead con ese correo.
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

Deno.test("error de Graph API deja el lead marcado y no crea nada", async () => {
  const { almacen, r } = almacenFalso();

  const res = await procesarEvento(EVENTO, {
    almacen,
    traerDeGraph: () => Promise.reject(new ErrorGraph("Graph API 400 (codigo 190): token vencido", 400, 190, false)),
  });

  assertEquals(res, "error");
  assertEquals(r.leads.length, 0);
  assertEquals(r.contactos.length, 0);
  assertEquals(r.errores.length, 1);
  assert(r.errores[0].includes("190"));
});

Deno.test("un lead sin empresa igual se guarda", async () => {
  const { almacen, r } = almacenFalso();
  const graph = normalizarRespuestaGraph(
    { id: EVENTO.leadgenId, field_data: [{ name: "email", values: ["solo@example.com"] }] },
    EVENTO.leadgenId,
  );

  assertEquals(await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) }), "nuevo");
  assertEquals(r.empresas.length, 0);
  assertEquals(r.leads.length, 1);
  assertEquals(r.leads[0].titulo, "Lead desde Meta Ads");
  assertEquals(r.contactos[0].nombre, "Sin nombre");
});

Deno.test("un fallo del correo no invalida el lead ya guardado", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();

  const res = await procesarEvento(EVENTO, {
    almacen,
    traerDeGraph: () => Promise.resolve(graph),
    notificar: () => Promise.reject(new Error("Resend caido")),
  });

  assertEquals(res, "nuevo");
  assertEquals(r.leads.length, 1);
  assertEquals(r.errores.length, 0);
});

Deno.test("si falla la escritura del contacto se registra el error", async () => {
  const { almacen, r } = almacenFalso();
  const graph = await graphDeFixture();
  almacen.crearContacto = () => Promise.reject(new Error("contacto: permiso denegado"));

  assertEquals(await procesarEvento(EVENTO, { almacen, traerDeGraph: () => Promise.resolve(graph) }), "error");
  assertEquals(r.errores.length, 1);
  assertEquals(r.leads.length, 0);
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
