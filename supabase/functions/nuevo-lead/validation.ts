export class InputError extends Error {}

export function normalize(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Datos inválidos.');
  const b = body as Record<string, unknown>;
  function field(key: string, max: number) {
    const value = b[key] ?? '';
    if (typeof value !== 'string' || value.length > max) throw new InputError(`Revisa el campo ${key}.`);
    return value.trim();
  }
  const website = field('website', 200);
  const nombre = field('nombre', 120);
  const email = field('email', 200).toLowerCase();
  if (!nombre || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError('Escribe tu nombre y un correo válido.');
  const raw = b.canales ?? [];
  const channels = typeof raw === 'string' ? raw.split(',').filter(Boolean) : raw;
  if (!Array.isArray(channels) || channels.length > 12 || channels.some(c => typeof c !== 'string' || c.length > 60)) {
    throw new InputError('Revisa los canales de venta.');
  }
  const requestId = field('request_id', 80);
  if (requestId && !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) throw new InputError('Identificador inválido.');
  return { requestId, website, payload: {
    nombre, email, empresa: field('empresa',160), cargo: field('cargo',120), telefono: field('telefono',40),
    necesidad: field('necesidad',200) || field('negocio',200), sitio: field('sitio',300),
    presupuesto: field('presupuesto',120), mensaje: field('mensaje',3000),
    canales: [...new Set(channels.map((c: string) => c.trim()).filter(Boolean))].sort(),
  } };
}

export async function fallbackId(payload: unknown, date = new Date()) {
  // Compatibilidad con formularios anteriores: idénticos datos en el mismo día = una solicitud.
  const bytes = new TextEncoder().encode(date.toISOString().slice(0,10) + JSON.stringify(payload));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(b => b.toString(16).padStart(2,'0')).join('');
}
