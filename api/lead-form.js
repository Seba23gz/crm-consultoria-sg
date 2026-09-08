// Fallback sin JavaScript: mismo receptor y mismas garantías que el formulario JS.
// No guarda en contactos por separado ni usa credenciales de Supabase en Vercel.
const ENDPOINT = 'https://rayvimywyqjnzzmbagpv.supabase.co/functions/v1/nuevo-lead';

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.statusCode = 405;
    return res.end('Método no permitido');
  }
  const type = req.headers['content-type'] || '';
  const html = type.includes('application/x-www-form-urlencoded');
  function reply(status, ok) {
    res.statusCode = status;
    if (!html) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok }));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    return res.end('<!doctype html><html lang="es-CL"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Diagnóstico — Veta Labs</title><main><h1>' +
      (ok ? 'Recibimos tu solicitud' : 'No pudimos enviar tu solicitud') +
      '</h1><p>' + (ok ? 'Te contactaremos para coordinar el diagnóstico. No necesitas enviar el formulario otra vez.' :
      'Vuelve al formulario para reintentarlo o escríbenos a contacto@vetalabs.cl.') +
      '</p><a href="/contacto">Volver a contacto</a></main></html>');
  }
  try {
    if (!html && !type.includes('application/json')) return reply(415, false);
    let body = req.body;
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > 16384) return reply(413, false);
      if (html) {
        const params = new URLSearchParams(body);
        body = Object.fromEntries(params);
        body.canales = params.getAll('canales');
      } else body = JSON.parse(body);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, false);
    // Vercel puede entregar ya parseado el formulario.
    if (html && typeof body.canales === 'string') body.canales = [body.canales];
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > 16384) return reply(413, false);
    const result = await fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: serialized, signal: AbortSignal.timeout(35000)
    });
    const data = await result.json();
    return reply(result.ok && data.ok === true ? 200 : (result.ok ? 502 : result.status), result.ok && data.ok === true);
  } catch {
    return reply(503, false);
  }
}
module.exports = handler;
