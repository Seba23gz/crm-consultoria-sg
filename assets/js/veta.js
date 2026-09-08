/* ==========================================================================
   Veta Labs — comportamiento del sitio público
   Sin dependencias, sin build. Se carga con `defer` en todas las páginas, así
   que nunca bloquea el pintado. Todo lo que hay acá es progresivo: si el JS
   falla, la página se sigue leyendo, se navega y el formulario se envía igual.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* CONFIGURACIÓN — lo único que hay que tocar para encender cada cosa. */
  /* ------------------------------------------------------------------ */
  //
  // MEDICIÓN: assets/js/consent.js deja todo denegado y solo descarga Google
  // Tag Manager (contenedor GTM-TS67GQTV) después de que la persona acepta.
  // Analytics y el píxel de Meta se configuran DENTRO de GTM, no acá.
  //
  // Las dos constantes de abajo son la vía alternativa, para cargar cada
  // herramienta directamente sin pasar por GTM. Deben quedarse vacías mientras
  // GTM esté puesto: si se llena una y además esa misma herramienta está
  // configurada dentro del contenedor, cada visita y cada evento se cuentan dos
  // veces y los informes quedan inflados sin que nada avise.
  //
  // Todos los eventos del sitio se empujan a `window.dataLayer` (ver `track`
  // más abajo), así que en GTM se usan como activadores de evento
  // personalizado con su mismo nombre: click_diagnostico, form_start,
  // form_submit, click_whatsapp, view_pricing, view_project, click_shopify,
  // click_meta_ads y click_identidad.
  var CONFIG = {
    // Meta Pixel: Administrador de eventos → Orígenes de datos. Vacío = no se
    // carga nada y no se envía ningún dato a Meta. Ver el aviso de arriba antes
    // de llenarlo: el píxel además habilita publicidad dirigida, y eso obliga a
    // corregir /privacidad, que hoy declara que no la hacemos.
    META_PIXEL_ID: '',

    // Google Analytics 4 (formato G-XXXXXXX). Vacío = no se carga nada.
    // Con GTM puesto, GA4 va dentro del contenedor y esto se queda vacío.
    GA_MEASUREMENT_ID: '',

    // WhatsApp comercial, en formato internacional y sin signos ni espacios
    // (es lo que espera wa.me). Si se deja vacío, los enlaces de WhatsApp se
    // ocultan solos: preferimos no mostrarlo antes que mostrarlo roto.
    WHATSAPP: '56963060767',
    WHATSAPP_TEXTO: 'Hola, vengo desde la web de Veta Labs y quiero mi diagnóstico gratuito.',

    // Endpoint que ya usa el CRM (Edge Function `nuevo-lead` en Supabase).
    LEAD_ENDPOINT: 'https://rayvimywyqjnzzmbagpv.supabase.co/functions/v1/nuevo-lead'
  };

  var doc = document;
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* =================================================================== */
  /* 1. MEDICIÓN                                                          */
  /* =================================================================== */

  // Cola única. Si mañana entra Google Tag Manager, ya encuentra los eventos
  // en `dataLayer` sin tocar el HTML.
  window.dataLayer = window.dataLayer || [];

  // Eventos de Meta con nombre propio. El resto viaja como evento personalizado.
  var META_EVENTS = { form_submit: 'Lead', click_whatsapp: 'Contact', click_diagnostico: 'InitiateCheckout' };

  function puedeMedir() {
    return typeof window.vetaHasMeasurementConsent === 'function' && window.vetaHasMeasurementConsent();
  }

  function track(name, params) {
    // No se guardan eventos previos para mandarlos retroactivamente al aceptar.
    if (!puedeMedir()) return false;
    var data = params || {};
    window.dataLayer.push(Object.assign({ event: name }, data));
    // Solo si GA lo cargó este archivo. Con GTM puesto, `window.gtag` existe
    // desde el <head> para el consentimiento, y llamarlo acá duplicaría el evento.
    if (CONFIG.GA_MEASUREMENT_ID && typeof window.gtag === 'function') window.gtag('event', name, data);
    if (typeof window.fbq === 'function') {
      if (META_EVENTS[name]) fbq('track', META_EVENTS[name], data);
      else fbq('trackCustom', name, data);
    }
    return true;
  }

  function cargarMedicionDirecta() {
    if (!puedeMedir() || window.__vetaDirectMeasurementLoaded) return;
    window.__vetaDirectMeasurementLoaded = true;

    // Meta Pixel (solo si hay ID configurado y consentimiento).
    if (CONFIG.META_PIXEL_ID) {
      window.META_PIXEL_ID = CONFIG.META_PIXEL_ID;
      !function (f, b, e, v, n, t, s) {
        if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
        if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
        t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
      }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', CONFIG.META_PIXEL_ID);
      fbq('track', 'PageView');
    }

    // Google Analytics 4 (solo si hay ID configurado y consentimiento).
    if (CONFIG.GA_MEASUREMENT_ID) {
      var ga = doc.createElement('script');
      ga.async = true;
      ga.src = 'https://www.googletagmanager.com/gtag/js?id=' + CONFIG.GA_MEASUREMENT_ID;
      doc.head.appendChild(ga);
      window.gtag('js', new Date());
      window.gtag('config', CONFIG.GA_MEASUREMENT_ID);
    }
  }

  // Expuesto para disparar eventos y arrancar medición tras el consentimiento.
  window.veta = { track: track, config: CONFIG, startMeasurement: cargarMedicionDirecta };
  cargarMedicionDirecta();

  // Clicks declarados en el HTML: <a data-ev="click_diagnostico" data-ev-pos="hero">
  doc.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-ev]');
    if (!el) return;
    track(el.dataset.ev, { origen: el.dataset.evPos || '', destino: el.getAttribute('href') || '' });
  });

  // Secciones vistas: <section data-view-ev="view_pricing">. Se dispara una vez.
  if ('IntersectionObserver' in window) {
    var seen = doc.querySelectorAll('[data-view-ev]');
    if (seen.length) {
      var viewObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          if (track(e.target.dataset.viewEv, { id: e.target.dataset.viewId || e.target.id || '' })) {
            viewObs.unobserve(e.target);
          }
        });
      }, { threshold: 0.35 });
      seen.forEach(function (el) { viewObs.observe(el); });
    }
  }

  /* =================================================================== */
  /* 2. WHATSAPP (canal secundario)                                       */
  /* =================================================================== */
  var waLinks = doc.querySelectorAll('[data-whatsapp]');
  if (waLinks.length) {
    if (CONFIG.WHATSAPP) {
      var waHref = 'https://wa.me/' + CONFIG.WHATSAPP + '?text=' + encodeURIComponent(CONFIG.WHATSAPP_TEXTO);
      waLinks.forEach(function (a) { a.setAttribute('href', waHref); a.hidden = false; });
    } else {
      // Sin número configurado no dejamos un enlace muerto en producción.
      waLinks.forEach(function (a) { a.hidden = true; });
    }
  }

  /* =================================================================== */
  /* 3. NAVEGACIÓN MOBILE                                                 */
  /* =================================================================== */
  var toggle = doc.querySelector('[data-nav-toggle]');
  var nav = doc.getElementById('nav-principal');
  if (toggle && nav) {
    var setNav = function (open) {
      toggle.setAttribute('aria-expanded', String(open));
      nav.dataset.open = String(open);
      toggle.querySelector('[data-nav-label]').textContent = open ? 'Cerrar' : 'Menú';
    };
    toggle.addEventListener('click', function () {
      setNav(toggle.getAttribute('aria-expanded') !== 'true');
    });
    // Al elegir un destino, el cajón se cierra solo.
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setNav(false); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setNav(false); toggle.focus(); }
    });
    // Si se vuelve a ancho de escritorio, el estado del cajón deja de aplicar.
    window.matchMedia('(min-width: 901px)').addEventListener('change', function (e) { if (e.matches) setNav(false); });
  }

  /* =================================================================== */
  /* 4. BARRA FIJA MOBILE                                                 */
  /* =================================================================== */
  var dock = doc.querySelector('[data-dock]');
  var dockAnchor = doc.querySelector('[data-dock-after]');
  var dockFuera = false;   // el hero todavía en pantalla
  var dockCedido = false;  // el banner de cookies ocupa el lugar

  // Las dos barras viven fijas abajo. Mientras haya una decisión de cookies
  // pendiente, manda el banner: pedir el diagnóstico puede esperar treinta
  // segundos, y dos barras superpuestas no se leen.
  function pintarDock() {
    if (dock) dock.dataset.show = String(dockFuera && !dockCedido);
  }
  function cederDock(v) { dockCedido = v; pintarDock(); }

  if (dock && 'IntersectionObserver' in window) {
    if (dockAnchor) {
      new IntersectionObserver(function (entries) {
        // Aparece recién cuando el hero salió de pantalla: arriba el CTA ya está.
        dockFuera = !entries[0].isIntersecting;
        pintarDock();
      }, { threshold: 0 }).observe(dockAnchor);
    } else {
      dockFuera = true;
      pintarDock();
    }
  }

  /* =================================================================== */
  /* 5. ANIMACIÓN DE ENTRADA                                              */
  /* =================================================================== */
  var reveal = [].slice.call(doc.querySelectorAll('[data-reveal]'));
  if (reveal.length && !reduceMotion && 'IntersectionObserver' in window) {
    reveal.forEach(function (el) { el.classList.add('is-armed'); });
    var show = function (el) {
      var delay = parseFloat(el.dataset.reveal) || 0;
      el.style.transitionDelay = delay + 's';
      el.classList.add('is-in');
    };
    var revObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { show(e.target); revObs.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -5% 0px' });
    reveal.forEach(function (el) { revObs.observe(el); });
    // Red de seguridad: pase lo que pase, a los 3 s todo está visible.
    setTimeout(function () { reveal.forEach(function (el) { if (!el.classList.contains('is-in')) show(el); }); }, 3000);
  }

  /* =================================================================== */
  /* CONSENTIMIENTO DE COOKIES (Ley 21.719)                              */
  /* =================================================================== */
  /* El <head> ya dejó la medición en `denied` y no carga GTM. Acá se pregunta,
     se guarda la respuesta y se arranca la medición solo al aceptar.

     Lo que exige la ley y por qué está resuelto así:
     - Previo: nada se activa antes de la respuesta; el default es denegado.
     - Libre: rechazar es un botón del mismo tamaño y en el mismo lugar.
     - Informado: el banner dice qué se mide y enlaza a /privacidad.
     - Revocable: el pie de todas las páginas reabre el banner.
     - Versionado: se guarda la decisión con su fecha y versión para recordarla.

     La versión importa: si mañana se suma una herramienta al contenedor, subirla
     invalida los consentimientos viejos y vuelve a preguntar, que es lo correcto
     —la persona aceptó otra cosa—. */
  var CONSENT_CLAVE = 'veta_consent_v2';

  var consent = doc.querySelector('[data-consent]');
  if (consent) {
    var abrir = doc.querySelectorAll('[data-consent-abrir]');
    var consentOpener = null;

    function leerConsent() {
      try { return JSON.parse(window.localStorage.getItem(CONSENT_CLAVE) || 'null'); }
      catch (e) { return null; }  // modo privado o almacenamiento bloqueado
    }

    function mostrarConsent(v) {
      consent.hidden = !v;
      cederDock(v);
    }

    function decidir(acepta) {
      var permisoAnalitica = acepta ? 'granted' : 'denied';
      var habiaMedicion = !!(window.__vetaGtmLoaded || window.__vetaDirectMeasurementLoaded);
      window.__vetaConsentGranted = acepta;
      try {
        window.localStorage.setItem(CONSENT_CLAVE, JSON.stringify({
          estado: acepta ? 'aceptado' : 'rechazado',
          fecha: new Date().toISOString()
        }));
      } catch (e) { /* sin almacenamiento: la decisión vale para esta visita */ }

      if (typeof window.gtag === 'function') {
        window.gtag('consent', 'update', {
          ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
          analytics_storage: permisoAnalitica, personalization_storage: 'denied'
        });
      }

      if (acepta) {
        if (typeof window.vetaLoadGTM === 'function') window.vetaLoadGTM();
        cargarMedicionDirecta();
      }
      mostrarConsent(false);

      // Una etiqueta ya descargada no puede desinstalarse. Al retirar el
      // permiso, recargar deja la página limpia y sin nuevas llamadas a Google.
      if (!acepta && habiaMedicion) {
        window.location.reload();
        return;
      }
      // Si el banner se abrió desde el pie, devolvemos el foco exactamente a
      // ese botón sin mover el scroll. En la pregunta inicial no hay un origen:
      // enfocar el enlace del footer llevaba al visitante hasta el final de la
      // página justo después de aceptar o rechazar.
      if (consentOpener && doc.documentElement.contains(consentOpener)) {
        try { consentOpener.focus({ preventScroll: true }); }
        catch (e) { consentOpener.focus(); }
      } else if (doc.activeElement && consent.contains(doc.activeElement)) {
        doc.activeElement.blur();
      }
      consentOpener = null;
    }

    on(consent.querySelector('[data-consent-si]'), 'click', function () { decidir(true); });
    on(consent.querySelector('[data-consent-no]'), 'click', function () { decidir(false); });
    for (var i = 0; i < abrir.length; i++) {
      on(abrir[i], 'click', function (e) {
        consentOpener = e.currentTarget;
        mostrarConsent(true);
        consent.querySelector('[data-consent-si]').focus();
      });
    }

    // Solo se pregunta si no hay una decisión guardada.
    if (!leerConsent()) mostrarConsent(true);
  }

  /* =================================================================== */
  /* 6. FORMULARIO DE DIAGNÓSTICO                                         */
  /* =================================================================== */
  doc.querySelectorAll('[data-lead-form]').forEach(function (form) {
    var statusEl = form.querySelector('[data-status]');
    var btn = form.querySelector('[data-submit]');
    var done = doc.getElementById(form.dataset.doneTarget || '');
    var started = false;
    var sending = false;
    var attemptPayload = '';
    var requestId = '';

    var val = function (name) {
      var el = form.elements[name];
      return el && typeof el.value === 'string' ? el.value.trim() : '';
    };
    var checked = function (name) {
      return [].slice.call(form.querySelectorAll('input[name="' + name + '"]:checked')).map(function (i) { return i.value; });
    };

    function setError(name, msg) {
      var input = form.elements[name];
      if (!input) return;
      var slot = form.querySelector('[data-error-for="' + name + '"]');
      if (slot) slot.textContent = msg || '';
      if (msg) { input.setAttribute('aria-invalid', 'true'); }
      else { input.removeAttribute('aria-invalid'); }
    }

    function setStatus(msg, ok) {
      if (!statusEl) return;
      statusEl.textContent = msg || '';
      // Monocromo por manual de marca: el error pesa por contraste, no por color.
      statusEl.style.fontWeight = ok ? '400' : '700';
      statusEl.hidden = !msg;
    }

    // form_start: una sola vez, cuando la persona escribe algo de verdad.
    form.addEventListener('input', function () {
      if (started) return;
      started = true;
      track('form_start', { formulario: form.dataset.leadForm || 'diagnostico' });
    }, { once: false });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (sending) return;

      var nombre = val('nombre');
      var email = val('email');
      var ok = true;

      setError('nombre', ''); setError('email', '');
      if (!nombre) { setError('nombre', 'Escribe tu nombre.'); ok = false; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('email', 'Escribe un correo válido.'); ok = false; }
      if (!ok) {
        setStatus('Revisa los campos marcados.', false);
        var bad = form.querySelector('[aria-invalid="true"]');
        if (bad) bad.focus();
        return;
      }
      setStatus('', true);

      // Cada pregunta del diagnóstico viaja en su propio campo: en el CRM son
      // columnas de `leads`, así que se puede filtrar y ordenar por ellas.
      // Antes iban todas plegadas dentro de `mensaje` y quedaban como texto
      // suelto imposible de consultar.
      var payload = {
        nombre: nombre,
        email: email,
        telefono: val('telefono'),
        empresa: val('empresa'),
        cargo: '',
        // `negocio` es lo que termina titulando la oportunidad en el CRM
        // ("Interés: Tienda online"), por eso va la necesidad declarada.
        // `necesidad` es el mismo dato con el nombre de la columna.
        negocio: val('necesidad'),
        necesidad: val('necesidad'),
        sitio: val('sitio'),
        canales: checked('canales'), // selección múltiple → arreglo
        presupuesto: val('presupuesto'),
        mensaje: val('mensaje'),
        website: val('website') // honeypot
      };

      // Conservar la clave al reintentar: un timeout no significa que no se guardó.
      var serialized = JSON.stringify(payload);
      if (!requestId || serialized !== attemptPayload) {
        requestId = window.crypto.randomUUID();
        attemptPayload = serialized;
      }
      payload.request_id = requestId;
      sending = true;
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 35000);

      var label = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
      setStatus('Enviando…', true);

      fetch(CONFIG.LEAD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      }).then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok || data.ok !== true) throw new Error('http ' + r.status);
          return data;
        });
      }).then(function () {
        track('form_submit', { formulario: form.dataset.leadForm || 'diagnostico', necesidad: payload.negocio || '' });
        form.reset();
        if (done) {
          // Confirmación explícita: qué pasa ahora y en cuánto tiempo.
          form.hidden = true;
          done.hidden = false;
          done.setAttribute('tabindex', '-1');
          done.focus();
          // La barra fija ofrecía el diagnóstico que la persona acaba de pedir.
          var barra = doc.querySelector('[data-dock]');
          if (barra) barra.hidden = true;
        } else {
          setStatus('¡Listo! Revisaremos tu negocio y te escribiremos para coordinar el diagnóstico.', true);
        }
      }).catch(function () {
        setStatus('No se pudo enviar. Vuelve a intentarlo o escríbenos a contacto@vetalabs.cl.', false);
      }).then(function () {
        clearTimeout(timer);
        sending = false;
        if (btn) { btn.disabled = false; btn.textContent = label; }
      });
    });
  });
})();
