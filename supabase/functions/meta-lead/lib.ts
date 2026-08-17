// Logica de la integracion con Meta Lead Ads, sin dependencias de Deno ni de red.
//
// Todo lo que toca el mundo exterior (Graph API, base de datos, correo) entra por
// parametro. Asi `lib_test.ts` prueba el flujo completo con dobles y sin secretos.
// El wiring real esta en `index.ts`.

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Un evento `leadgen` ya extraido del cuerpo del webhook. */
export interface EventoLeadgen {
  leadgenId: string;
  formId: string | null;
  pageId: string | null;
  adId: string | null;
  createdTime: number | null;
}

/** Campos estandar que reconocemos, mas todo lo demas sin perder nada. */
export interface LeadNormalizado {
  nombre: string;
  email: string;
  telefono: string;
  empresa: string;
  cargo: string;
  ciudad: string;
  /** Todas las respuestas con el nombre de campo original de Meta. */
  respuestas: Record<string, string[]>;
  /** Solo las que no son campos estandar, aplanadas para mostrar. */
  personalizadas: Record<string, string>;
}

/** Respuesta del nodo del lead en Graph API, ya saneada. */
export interface LeadDeGraph {
  id: string;
  createdTime: string | null;
  formId: string | null;
  adId: string | null;
  fieldData: { name: string; values: string[] }[];
  /** Copia saneada de la respuesta, para guardar como payload. Sin tokens. */
  crudo: Record<string, unknown>;
}

/**
 * Que paso al intentar reclamar un lead.
 *
 *   claimed     -> lo tenemos nosotros, hay que procesarlo
 *   completed   -> ya se proceso antes; no hay nada que hacer
 *   in_progress -> otra entrega lo esta procesando ahora mismo
 */
export type ResultadoReclamo =
  | { tipo: "claimed"; intento: number }
  | { tipo: "completed" }
  | { tipo: "in_progress" };

/** Puerto de persistencia. La implementacion real usa supabase-js. */
export interface Almacen {
  /** Reclamo atomico. Es lo unico que impide que dos entregas dupliquen. */
  reclamar(evento: EventoLeadgen): Promise<ResultadoReclamo>;
  buscarEmpresaPorNombre(nombre: string): Promise<number | null>;
  crearEmpresa(datos: { nombre: string; ciudad: string | null }): Promise<number | null>;
  buscarContactoPorEmail(email: string): Promise<number | null>;
  crearContacto(datos: {
    nombre: string;
    cargo: string | null;
    email: string | null;
    telefono: string | null;
    empresaId: number | null;
  }): Promise<number>;
  crearLead(datos: {
    empresaId: number | null;
    contactoId: number;
    titulo: string;
    notas: string;
    leadgenId: string;
  }): Promise<number | null>;
  marcarCompletado(leadgenId: string, datos: DatosProcesado): Promise<void>;
  /** Deja la fila en `failed`, que es reclamable de nuevo. */
  marcarFallido(leadgenId: string, errorSaneado: string): Promise<void>;
}

export interface DatosProcesado {
  leadId: number | null;
  contactoId: number | null;
  empresaId: number | null;
  lead: LeadNormalizado;
  graph: LeadDeGraph;
}

export interface Dependencias {
  almacen: Almacen;
  /** Trae el lead desde Graph API. Lanza `ErrorGraph` si no se pudo. */
  traerDeGraph(leadgenId: string): Promise<LeadDeGraph>;
  /** Aviso por correo. Los fallos aca no deben tumbar el procesamiento. */
  notificar?(lead: LeadNormalizado, graph: LeadDeGraph): Promise<void>;
  /** Valores que jamas deben terminar escritos en `last_error` ni en los logs. */
  secretos?: string[];
  log?: Registro;
}

export interface Registro {
  info(mensaje: string, datos?: Record<string, unknown>): void;
  error(mensaje: string, datos?: Record<string, unknown>): void;
}

/** Error de Graph API con la informacion necesaria para decidir si reintentar. */
export class ErrorGraph extends Error {
  readonly status: number;
  readonly codigo: number | null;
  readonly reintentable: boolean;

  constructor(mensaje: string, status: number, codigo: number | null, reintentable: boolean) {
    super(mensaje);
    this.name = "ErrorGraph";
    this.status = status;
    this.codigo = codigo;
    this.reintentable = reintentable;
  }
}

/**
 * Desenlace de un evento. Determina el codigo HTTP que se le devuelve a Meta.
 *
 *   completed          -> 200. El lead quedo en el CRM en este intento.
 *   already_completed  -> 200. Ya estaba; la reentrega no hizo nada.
 *   retry              -> 503. Fallo temporal (429, 5xx, red, base de datos) o
 *                         hay otra entrega en curso. Meta debe reintentar.
 *   permanent          -> 500. Token invalido, permiso faltante. Reintentar no
 *                         sirve: hay que arreglar la configuracion.
 */
export type Desenlace = "completed" | "already_completed" | "retry" | "permanent";

// ---------------------------------------------------------------------------
// Firma X-Hub-Signature-256
// ---------------------------------------------------------------------------

/** Compara en tiempo constante: una comparacion normal filtra la firma por timing. */
export function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function aHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Valida la firma de Meta sobre el cuerpo crudo. Se usa el texto exacto que
 * llego: reserializar el JSON cambia bytes y rompe el HMAC.
 */
export async function verificarFirma(
  cuerpoCrudo: string,
  cabecera: string | null,
  appSecret: string | undefined,
): Promise<{ ok: boolean; motivo: string }> {
  if (!appSecret) return { ok: false, motivo: "META_APP_SECRET no configurado" };
  if (!cabecera) return { ok: false, motivo: "falta la cabecera X-Hub-Signature-256" };
  if (!cabecera.startsWith("sha256=")) return { ok: false, motivo: "formato de firma no reconocido" };

  const recibida = cabecera.slice("sha256=".length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recibida)) return { ok: false, motivo: "firma malformada" };

  const clave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(cuerpoCrudo));

  return igualSeguro(aHex(mac), recibida)
    ? { ok: true, motivo: "" }
    : { ok: false, motivo: "la firma no coincide" };
}

// ---------------------------------------------------------------------------
// Verificacion GET del webhook
// ---------------------------------------------------------------------------

export interface ResultadoVerificacion {
  ok: boolean;
  challenge: string;
  motivo: string;
}

/**
 * Meta llama una sola vez con `hub.mode=subscribe` al dar de alta la URL.
 * Hay que devolver `hub.challenge` tal cual y nada mas.
 */
export function verificarSuscripcion(
  params: URLSearchParams,
  tokenEsperado: string | undefined,
): ResultadoVerificacion {
  const modo = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  // Sin token configurado no se puede verificar nada: mejor fallar que aceptar.
  if (!tokenEsperado) return { ok: false, challenge: "", motivo: "token de verificacion no configurado" };
  if (modo !== "subscribe") return { ok: false, challenge: "", motivo: "hub.mode no es subscribe" };
  if (!challenge) return { ok: false, challenge: "", motivo: "falta hub.challenge" };
  // Tiempo constante tambien aca: el token de verificacion es un secreto.
  if (!token || !igualSeguro(token, tokenEsperado)) {
    return { ok: false, challenge: "", motivo: "token de verificacion incorrecto" };
  }

  return { ok: true, challenge, motivo: "" };
}

// ---------------------------------------------------------------------------
// Parseo del cuerpo del webhook
// ---------------------------------------------------------------------------

function texto(valor: unknown): string | null {
  if (typeof valor === "string" && valor.trim()) return valor.trim();
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return null;
}

/**
 * Saca los eventos `leadgen` del cuerpo. Todo lo que no sea `leadgen` se ignora
 * en silencio: Meta manda cambios de otros campos por la misma suscripcion y no
 * son un error.
 *
 * Nada de lo que viene aca se da por bueno: la estructura se valida entera.
 */
export function extraerEventosLeadgen(cuerpo: unknown): EventoLeadgen[] {
  const eventos: EventoLeadgen[] = [];
  if (!cuerpo || typeof cuerpo !== "object") return eventos;

  const raiz = cuerpo as Record<string, unknown>;
  // Solo nos interesan los webhooks del objeto `page`.
  if (texto(raiz.object) !== "page") return eventos;

  const entradas = Array.isArray(raiz.entry) ? raiz.entry : [];
  for (const entrada of entradas) {
    if (!entrada || typeof entrada !== "object") continue;
    const e = entrada as Record<string, unknown>;
    const pageIdEntrada = texto(e.id);

    const cambios = Array.isArray(e.changes) ? e.changes : [];
    for (const cambio of cambios) {
      if (!cambio || typeof cambio !== "object") continue;
      const c = cambio as Record<string, unknown>;
      if (c.field !== "leadgen") continue;

      const valor = (c.value && typeof c.value === "object" ? c.value : {}) as Record<string, unknown>;
      const leadgenId = texto(valor.leadgen_id);
      if (!leadgenId) continue; // sin id no hay nada que ir a buscar

      const createdTime = typeof valor.created_time === "number" && Number.isFinite(valor.created_time)
        ? valor.created_time
        : null;

      eventos.push({
        leadgenId,
        formId: texto(valor.form_id),
        // El page_id del `value` manda; si no viene, el `entry.id` es la pagina.
        pageId: texto(valor.page_id) ?? pageIdEntrada,
        // `adgroup_id` es el nombre antiguo de `ad_id` en el payload del webhook.
        adId: texto(valor.ad_id) ?? texto(valor.adgroup_id),
        createdTime,
      });
    }
  }

  return eventos;
}

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

/**
 * Version de Graph API por defecto.
 *
 * v26.0 salio el 29 de julio de 2026 y es la vigente. Se puede cambiar sin tocar
 * el codigo con `META_GRAPH_API_VERSION`.
 */
export const VERSION_GRAPH_POR_DEFECTO = "v26.0";

/**
 * Campos que se le piden al nodo del lead.
 *
 * Solo estos cinco estan documentados para el nodo lead. `adset_id`,
 * `campaign_id`, `platform` e `is_organic` NO aparecen en la referencia de v26.0:
 * pedirlos hace que Graph devuelva 400 y se caiga el lead entero. Las columnas
 * existen en `meta_leads` y quedan nulas.
 */
export const CAMPOS_GRAPH = [
  "id",
  "created_time",
  "field_data",
  "form_id",
  "ad_id",
] as const;

/**
 * Valida la version de Graph que viene del entorno. Se interpola en una URL, asi
 * que no puede ser cualquier cosa.
 */
export function versionGraph(valor: string | undefined): string {
  const v = (valor ?? "").trim();
  if (!v) return VERSION_GRAPH_POR_DEFECTO;
  if (!/^v\d{1,3}\.\d{1,3}$/.test(v)) {
    throw new Error("META_GRAPH_API_VERSION invalida: se espera el formato vNN.N (ej. v26.0)");
  }
  return v;
}

export function urlGraph(version: string, leadgenId: string, campos: readonly string[]): string {
  return `https://graph.facebook.com/${version}/${encodeURIComponent(leadgenId)}` +
    `?fields=${encodeURIComponent(campos.join(","))}`;
}

/** Codigos de Meta que no tiene sentido reintentar: hay que arreglar algo. */
const CODIGOS_PERMANENTES = new Set([
  100, // campo o parametro invalido / objeto no accesible
  102, // sesion caducada
  190, // token invalido o vencido
  200, // permisos insuficientes (falta leads_retrieval)
  803, // objeto inexistente
]);

/** Codigos de limite de solicitudes: se reintenta con espera. */
const CODIGOS_LIMITE = new Set([4, 17, 32, 613, 80004]);

export function esReintentable(status: number, codigo: number | null): boolean {
  if (codigo !== null && CODIGOS_LIMITE.has(codigo)) return true;
  if (codigo !== null && CODIGOS_PERMANENTES.has(codigo)) return false;
  if (status === 429) return true;
  if (status >= 500) return true;
  // Sin respuesta (fallo de red) se representa con status 0.
  if (status === 0) return true;
  // 4xx que no reconocemos: no reintentar, no va a cambiar solo.
  return false;
}

/** Deja la respuesta de Graph en una forma conocida y validada. */
export function normalizarRespuestaGraph(crudo: unknown, leadgenId: string): LeadDeGraph {
  const o = (crudo && typeof crudo === "object" ? crudo : {}) as Record<string, unknown>;

  const fieldData: { name: string; values: string[] }[] = [];
  const lista = Array.isArray(o.field_data) ? o.field_data : [];
  // Tope defensivo: un formulario real no tiene cientos de campos.
  for (const item of lista.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const campo = item as Record<string, unknown>;
    const name = texto(campo.name);
    if (!name) continue;
    const values = (Array.isArray(campo.values) ? campo.values : [])
      .map((v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : ""))
      .map((v) => v.trim().slice(0, 2000))
      .filter((v) => v.length > 0);
    fieldData.push({ name: name.slice(0, 200), values });
  }

  return {
    id: texto(o.id) ?? leadgenId,
    createdTime: texto(o.created_time),
    formId: texto(o.form_id),
    adId: texto(o.ad_id),
    fieldData,
    crudo: {
      id: texto(o.id) ?? leadgenId,
      created_time: texto(o.created_time),
      form_id: texto(o.form_id),
      ad_id: texto(o.ad_id),
      field_data: fieldData,
    },
  };
}

// ---------------------------------------------------------------------------
// Normalizacion de field_data
// ---------------------------------------------------------------------------

/**
 * Nombres estandar de Meta y sus equivalentes en espanol, por si el formulario
 * se armo con preguntas propias en vez de los campos predefinidos.
 */
const ALIAS: Record<"email" | "telefono" | "empresa" | "cargo" | "ciudad", string[]> = {
  email: ["email", "correo", "correo_electronico", "e_mail"],
  telefono: ["phone_number", "telefono", "celular", "whatsapp", "fono"],
  empresa: ["company_name", "empresa", "compania", "negocio", "organizacion"],
  cargo: ["job_title", "cargo", "puesto", "rol"],
  ciudad: ["city", "ciudad", "comuna"],
};

const ALIAS_NOMBRE = ["full_name", "nombre", "nombre_completo"];
const ALIAS_PRIMER_NOMBRE = ["first_name", "primer_nombre", "nombres"];
const ALIAS_APELLIDO = ["last_name", "apellido", "apellidos"];

/** Todos los nombres que consideramos "estandar" y por lo tanto ya mapeados. */
const NOMBRES_ESTANDAR = new Set<string>([
  ...ALIAS_NOMBRE,
  ...ALIAS_PRIMER_NOMBRE,
  ...ALIAS_APELLIDO,
  ...Object.values(ALIAS).flat(),
]);

/** Normaliza la clave para comparar: minusculas, sin acentos, sin adornos. */
function claveCanonica(nombre: string): string {
  return nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function primero(mapa: Record<string, string>, claves: string[]): string {
  for (const clave of claves) {
    const v = mapa[clave];
    if (v) return v;
  }
  return "";
}

/**
 * Convierte la lista `[{name, values}]` de Meta en un objeto usable.
 *
 * Los campos desconocidos NO se descartan: quedan en `respuestas` con su nombre
 * original y en `personalizadas` aplanados para mostrar.
 */
export function normalizarCampos(fieldData: { name: string; values: string[] }[]): LeadNormalizado {
  const respuestas: Record<string, string[]> = {};
  const porClave: Record<string, string> = {};

  for (const campo of fieldData) {
    if (!campo?.name) continue;
    const valores = (campo.values ?? []).filter((v) => typeof v === "string" && v.trim().length > 0);
    // Nombre original tal cual lo mando Meta: es lo que se guarda en jsonb.
    respuestas[campo.name] = valores;

    const clave = claveCanonica(campo.name);
    // Si el mismo campo viene repetido, gana el primero con contenido.
    if (clave && valores.length > 0 && !porClave[clave]) porClave[clave] = valores[0].trim();
  }

  const nombreCompleto = primero(porClave, ALIAS_NOMBRE);
  const nombre = nombreCompleto ||
    [primero(porClave, ALIAS_PRIMER_NOMBRE), primero(porClave, ALIAS_APELLIDO)]
      .filter(Boolean)
      .join(" ")
      .trim();

  const personalizadas: Record<string, string> = {};
  for (const campo of fieldData) {
    if (!campo?.name) continue;
    const clave = claveCanonica(campo.name);
    if (!clave || NOMBRES_ESTANDAR.has(clave)) continue;
    const valores = (campo.values ?? []).filter((v) => typeof v === "string" && v.trim().length > 0);
    if (valores.length > 0) personalizadas[campo.name] = valores.join(", ");
  }

  return {
    nombre: nombre || "Sin nombre",
    email: primero(porClave, ALIAS.email),
    telefono: primero(porClave, ALIAS.telefono),
    empresa: primero(porClave, ALIAS.empresa),
    cargo: primero(porClave, ALIAS.cargo),
    ciudad: primero(porClave, ALIAS.ciudad),
    respuestas,
    personalizadas,
  };
}

// ---------------------------------------------------------------------------
// Higiene de errores y logs
// ---------------------------------------------------------------------------

/**
 * Deja un correo reconocible sin exponerlo entero. Para logs: hay que poder
 * diagnosticar sin volcar datos personales a la consola.
 */
export function ofuscarEmail(email: string): string {
  if (!email || !email.includes("@")) return email ? "***" : "";
  const [usuario, dominio] = email.split("@");
  const u = usuario.length <= 1 ? "*" : `${usuario[0]}***`;
  return `${u}@${dominio}`;
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Limpia un mensaje de error antes de guardarlo en `last_error` o escribirlo en
 * un log.
 *
 * Dos capas, porque una sola no basta: primero se borran los valores concretos de
 * los secretos que conocemos, y despues los patrones que parecen credenciales
 * aunque no los tengamos en la lista (un token que Meta devuelva en su propio
 * mensaje de error, por ejemplo).
 */
export function sanitizarError(mensaje: string, secretos: string[] = []): string {
  let out = mensaje;

  for (const secreto of secretos) {
    // Tan cortos que redactarlos destrozaria el mensaje entero.
    if (!secreto || secreto.length < 8) continue;
    out = out.replace(new RegExp(escaparRegex(secreto), "g"), "[REDACTADO]");
  }

  // Patrones que parecen credenciales aunque no estuvieran en la lista.
  out = out
    .replace(/(access_token=)[^\s&"']+/gi, "$1[REDACTADO]")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1[REDACTADO]")
    // Tokens de Meta: empiezan con EAA y siguen largo.
    .replace(/EAA[A-Za-z0-9]{20,}/g, "[REDACTADO]");

  return out.slice(0, 500);
}

export function mensajeDe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------------------
// Flujo de procesamiento
// ---------------------------------------------------------------------------

function armarNotas(lead: LeadNormalizado, graph: LeadDeGraph): string {
  const lineas: string[] = [];
  for (const [pregunta, respuesta] of Object.entries(lead.personalizadas)) {
    lineas.push(`${pregunta}: ${respuesta}`);
  }
  if (graph.formId) lineas.push(`Formulario: ${graph.formId}`);
  if (graph.adId) lineas.push(`Anuncio: ${graph.adId}`);
  lineas.push("Origen: Meta Lead Ads");
  return lineas.join("\n");
}

/**
 * Procesa un evento de punta a punta y devuelve el desenlace, que es lo que
 * decide el codigo HTTP.
 *
 * Es sincrono a proposito: el 200 sale recien cuando el lead esta guardado. Si
 * algo falla, la fila queda en `failed` (reclamable) y se responde un codigo que
 * hace que Meta reintente.
 */
export async function procesarEvento(evento: EventoLeadgen, deps: Dependencias): Promise<Desenlace> {
  const log = deps.log ?? consolaSilenciosa;
  const limpiar = (e: unknown) => sanitizarError(mensajeDe(e), deps.secretos);

  let reclamo: ResultadoReclamo;
  try {
    reclamo = await deps.almacen.reclamar(evento);
  } catch (e) {
    // Si ni siquiera se pudo reclamar, no hay fila que marcar: que Meta reintente.
    log.error("no se pudo reclamar el lead", { leadgenId: evento.leadgenId, detalle: limpiar(e) });
    return "retry";
  }

  if (reclamo.tipo === "completed") {
    log.info("lead ya estaba completado, se ignora la reentrega", { leadgenId: evento.leadgenId });
    return "already_completed";
  }
  if (reclamo.tipo === "in_progress") {
    // Otra entrega lo tiene tomado. No duplicamos y pedimos reintento: si ese otro
    // intento falla, el lead no se pierde.
    log.info("lead en curso en otra entrega", { leadgenId: evento.leadgenId });
    return "retry";
  }

  try {
    const graph = await deps.traerDeGraph(evento.leadgenId);
    const lead = normalizarCampos(graph.fieldData);

    // 1) Empresa: se reutiliza si ya existe con ese nombre.
    let empresaId: number | null = null;
    if (lead.empresa) {
      empresaId = await deps.almacen.buscarEmpresaPorNombre(lead.empresa);
      if (empresaId === null) {
        empresaId = await deps.almacen.crearEmpresa({
          nombre: lead.empresa,
          ciudad: lead.ciudad || null,
        });
      }
    }

    // 2) Contacto: el correo es la llave natural de una persona en este CRM.
    let contactoId: number | null = null;
    if (lead.email) contactoId = await deps.almacen.buscarContactoPorEmail(lead.email);
    if (contactoId === null) {
      contactoId = await deps.almacen.crearContacto({
        nombre: lead.nombre,
        cargo: lead.cargo || null,
        email: lead.email || null,
        telefono: lead.telefono || null,
        empresaId,
      });
    }

    // 3) Lead en el pipeline, en la etapa inicial.
    const leadId = await deps.almacen.crearLead({
      empresaId,
      contactoId,
      titulo: lead.empresa ? `Meta Ads: ${lead.empresa}` : "Lead desde Meta Ads",
      notas: armarNotas(lead, graph),
      leadgenId: evento.leadgenId,
    });

    // 4) Recien aca la fila pasa a `completed`.
    await deps.almacen.marcarCompletado(evento.leadgenId, { leadId, contactoId, empresaId, lead, graph });

    log.info("lead guardado", {
      leadgenId: evento.leadgenId,
      leadId,
      email: ofuscarEmail(lead.email),
      campos: Object.keys(lead.respuestas).length,
    });

    if (deps.notificar) {
      // El correo va despues de completar: si falla, el lead ya esta a salvo y no
      // hay que reintentar la entrega entera por un aviso.
      try {
        await deps.notificar(lead, graph);
      } catch (e) {
        log.error("no se pudo avisar por correo", { leadgenId: evento.leadgenId, detalle: limpiar(e) });
      }
    }

    return "completed";
  } catch (e) {
    const detalle = limpiar(e);
    const permanente = e instanceof ErrorGraph && !e.reintentable;

    log.error("fallo el procesamiento del lead", {
      leadgenId: evento.leadgenId,
      permanente,
      detalle,
    });

    // La fila vuelve a `failed`, que es reclamable: ni el reintento de Meta ni una
    // reejecucion manual quedan bloqueados.
    try {
      await deps.almacen.marcarFallido(evento.leadgenId, detalle);
    } catch (e2) {
      log.error("ademas fallo al registrar el error", {
        leadgenId: evento.leadgenId,
        detalle: limpiar(e2),
      });
    }

    return permanente ? "permanent" : "retry";
  }
}

/**
 * Codigo HTTP para el conjunto de desenlaces de una entrega.
 *
 * Meta manda varios eventos en un mismo POST y reintenta la entrega completa, no
 * evento por evento. Por eso basta con que uno pida reintento para devolver 503:
 * los que ya quedaron `completed` se resuelven solos en la reentrega.
 *
 * Precedencia: retry > permanent > ok.
 */
export function codigoHttp(desenlaces: Desenlace[]): number {
  if (desenlaces.some((d) => d === "retry")) return 503;
  if (desenlaces.some((d) => d === "permanent")) return 500;
  return 200;
}

const consolaSilenciosa: Registro = { info: () => {}, error: () => {} };
