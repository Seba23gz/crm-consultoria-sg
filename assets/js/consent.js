/* Consentimiento básico: Google Tag Manager no se descarga ni recibe eventos
   hasta que la persona acepta. Este archivo se carga de forma síncrona en el
   <head>, antes de cualquier herramienta de medición. */
(function (w, d) {
  'use strict';

  var CLAVE = 'veta_consent_v2';
  var GTM_ID = 'GTM-TS67GQTV';

  w.dataLayer = w.dataLayer || [];
  w.gtag = w.gtag || function () { w.dataLayer.push(arguments); };

  function leer() {
    try { return JSON.parse(w.localStorage.getItem(CLAVE) || 'null'); }
    catch (e) { return null; }
  }

  w.vetaHasMeasurementConsent = function () {
    if (w.__vetaConsentGranted === true) return true;
    var c = leer();
    return !!(c && c.estado === 'aceptado');
  };

  w.vetaLoadGTM = function () {
    if (w.__vetaGtmLoaded || !w.vetaHasMeasurementConsent()) return;
    w.__vetaGtmLoaded = true;
    w.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    var script = d.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtm.js?id=' + GTM_ID;
    d.head.appendChild(script);
  };

  w.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    personalization_storage: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted'
  });

  if (w.vetaHasMeasurementConsent()) {
    w.__vetaConsentGranted = true;
    w.gtag('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
      personalization_storage: 'denied'
    });
    w.vetaLoadGTM();
  }
})(window, document);
