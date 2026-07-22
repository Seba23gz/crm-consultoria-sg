const DEFAULT_OWNER_EMAIL = 'tu-email@ejemplo.com';

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

function setCorsHeaders(res) {
  const headers = getCorsHeaders();
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (!req || !req.body) return {};

  if (typeof req.body === 'string') {
    const trimmed = req.body.trim();
    if (!trimmed) return {};

    try {
      return JSON.parse(trimmed);
    } catch {
      const params = new URLSearchParams(trimmed);
      const result = {};
      params.forEach((value, key) => {
        result[key] = value;
      });
      return result;
    }
  }

  if (typeof req.body === 'object') return req.body;
  return {};
}

function normalizeLeadPayload(payload) {
  const source = payload || {};
  const nombre = source.nombre || source.name || source.full_name || '';
  const email = source.email || source.correo || '';
  const telefono = source.telefono || source.phone || source.whatsapp || '';
  const empresa = source.empresa || source.company || source.organizacion || '';
  const cargo = source.cargo || source.role || '';
  const mensaje = source.mensaje || source.message || source.notas || '';
  const prioridad = source.prioridad || source.priority || 'media';
  const etapa = source.etapa || 'contactado';
  const origen = source.origen || 'formulario_web';

  return {
    nombre: nombre.trim(),
    email: email.trim(),
    telefono: telefono.trim(),
    empresa: empresa.trim(),
    cargo: cargo.trim(),
    mensaje: mensaje.trim(),
    prioridad,
    etapa,
    origen,
  };
}

function buildEmailBody(lead) {
  const lines = [
    'Hola,',
    '',
    `Has recibido un nuevo lead desde el formulario web.`,
    '',
    `Nombre: ${lead.nombre || 'Sin datos'}`,
    `Email: ${lead.email || 'Sin datos'}`,
    `Teléfono: ${lead.telefono || 'Sin datos'}`,
    `Empresa: ${lead.empresa || 'Sin datos'}`,
    `Cargo: ${lead.cargo || 'Sin datos'}`,
    `Mensaje: ${lead.mensaje || 'Sin datos'}`,
    '',
    `Etapa asignada: ${lead.etapa}`,
    '',
    'Este contacto ya quedó registrado en el CRM como contactado.',
  ];

  return lines.join('\n');
}

async function sendLeadEmail(lead) {
  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.CRM_OWNER_EMAIL || DEFAULT_OWNER_EMAIL;
  const fromEmail = process.env.FROM_EMAIL || 'CRM <onboarding@resend.dev>';

  if (!apiKey || ownerEmail === DEFAULT_OWNER_EMAIL) {
    return { skipped: true, reason: 'RESEND_API_KEY o CRM_OWNER_EMAIL no configurados' };
  }

  const body = {
    from: fromEmail,
    to: [ownerEmail],
    subject: `Nuevo lead: ${lead.nombre || 'Sin nombre'}`,
    html: `<p>Hola,</p><p>Has recibido un nuevo lead desde el formulario web.</p><ul><li><strong>Nombre:</strong> ${lead.nombre || 'Sin datos'}</li><li><strong>Email:</strong> ${lead.email || 'Sin datos'}</li><li><strong>Teléfono:</strong> ${lead.telefono || 'Sin datos'}</li><li><strong>Empresa:</strong> ${lead.empresa || 'Sin datos'}</li><li><strong>Mensaje:</strong> ${lead.mensaje || 'Sin datos'}</li></ul><p>Este contacto quedó registrado en el CRM como contactado.</p>`,
    text: buildEmailBody(lead),
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { skipped: false, error: data?.message || 'No se pudo enviar el correo' };
  }

  return { skipped: false, emailId: data.id };
}

async function upsertCompany(lead, supabaseUrl, serviceRoleKey) {
  if (!lead.empresa) return null;

  const payload = {
    nombre: lead.empresa,
    rubro: 'Sin definir',
    ciudad: 'Sin definir',
    notas: `Lead captado desde ${lead.origen}`,
    telefono: lead.telefono || null,
  };

  const response = await fetch(`${supabaseUrl}/rest/v1/empresas`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return rows[0] || null;
}

async function createLeadRecord(lead, supabaseUrl, serviceRoleKey) {
  const company = await upsertCompany(lead, supabaseUrl, serviceRoleKey);

  const payload = {
    nombre: lead.nombre || 'Sin nombre',
    cargo: lead.cargo || null,
    email: lead.email || null,
    telefono: lead.telefono || null,
    empresa_id: company?.id || null,
    etapa: lead.etapa || 'contactado',
    prioridad: lead.prioridad || 'media',
    ultimo_contacto: new Date().toISOString(),
    proximo_seguimiento: null,
    notas: lead.mensaje || `Lead captado desde ${lead.origen}`,
    linkedin_url: null,
  };

  const response = await fetch(`${supabaseUrl}/rest/v1/contactos`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`No se pudo guardar el contacto: ${errorText}`);
  }

  const rows = await response.json().catch(() => []);
  return rows[0] || null;
}

async function createActivity(lead, contactId, supabaseUrl, serviceRoleKey) {
  if (!contactId) return null;

  const payload = {
    contacto_id: contactId,
    tipo: 'email',
    descripcion: `Lead captado desde ${lead.origen}: ${lead.mensaje || 'sin mensaje'}`.slice(0, 500),
    fecha: new Date().toISOString(),
  };

  const response = await fetch(`${supabaseUrl}/rest/v1/actividades`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return rows[0] || null;
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Método no permitido' });
    return;
  }

  const payload = normalizeLeadPayload(parseBody(req));

  if (!payload.email) {
    sendJson(res, 400, { ok: false, error: 'Falta el email del lead' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    sendJson(res, 500, { ok: false, error: 'Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }

  try {
    const contact = await createLeadRecord(payload, supabaseUrl, serviceRoleKey);
    await createActivity(payload, contact?.id, supabaseUrl, serviceRoleKey);
    const emailResult = await sendLeadEmail(payload);

    sendJson(res, 200, {
      ok: true,
      message: 'Lead recibido y registrado como contactado',
      lead: {
        id: contact?.id || null,
        etapa: payload.etapa,
      },
      email: emailResult,
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || 'No se pudo procesar el lead' });
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports.parseBody = parseBody;
module.exports.normalizeLeadPayload = normalizeLeadPayload;
module.exports.buildEmailBody = buildEmailBody;
module.exports.sendLeadEmail = sendLeadEmail;
