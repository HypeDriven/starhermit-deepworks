/* Deepworks — localization core (browser global: window.DWI18n).
 *
 * Every player-facing string is authored in US English and looked up by that
 * English text: T('Play') → the current locale's translation (en-US is the key
 * itself). Placeholders use {name}. Dictionaries come from js/locales/*.js
 * (loaded first, into window.DW_LOCALES); en-GB, es-ES and fr-CA list only
 * their differences from en-US, es-419 and fr-FR.
 *
 * The locale comes from sh-language.js (window.StarHermitLanguage): the game's
 * Language setting (`ui.language`), Automatic → the StarHermit account's
 * preferred language → navigator.languages → en-US. `?lang=` forces a locale
 * for one page load (QA links) and hides the selector. A change re-applies the
 * data-i18n markup, sets <html lang>, and calls every onChange listener so the
 * visible screens re-render in place.
 */
(function (root) {
  'use strict';
  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var src = root.DW_LOCALES || {};
  function merge(a, b) { var o = {}, k; for (k in a || {}) o[k] = a[k]; for (k in b || {}) o[k] = b[k]; return o; }
  var DICTS = {
    'en-US': {},
    'en-GB': src['en-GB'] || {},
    'es-419': src['es-419'] || {},
    'es-ES': merge(src['es-419'], src['es-ES']),
    'de-DE': src['de-DE'] || {},
    'fr-FR': src['fr-FR'] || {},
    'fr-CA': merge(src['fr-FR'], src['fr-CA']),
    'pt-BR': src['pt-BR'] || {},
    'it-IT': src['it-IT'] || {}
  };
  var lang = 'en-US', dict = DICTS[lang], listeners = [];

  function fmt(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : m; });
  }
  function T(key, vars) {
    if (key == null) return '';
    var s = String(key);
    var out = Object.prototype.hasOwnProperty.call(dict, s) ? dict[s] : s;
    return vars ? fmt(out, vars) : out;
  }
  function N(key) { return key; }

  function applyMarkup(scope) {
    var doc = root.document;
    scope = scope || doc;
    if (!scope || !scope.querySelectorAll) return;
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n]'), function (n) { n.textContent = T(n.getAttribute('data-i18n')); });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-aria]'), function (n) { n.setAttribute('aria-label', T(n.getAttribute('data-i18n-aria'))); });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-title]'), function (n) { n.setAttribute('title', T(n.getAttribute('data-i18n-title'))); });
  }

  function setLocale(next) {
    var resolved = DICTS[next] ? next : 'en-US';
    var changed = resolved !== lang;
    lang = resolved; dict = DICTS[lang];
    var doc = root.document;
    if (doc && doc.documentElement) {
      doc.documentElement.lang = lang;
      if (doc.readyState !== 'loading') applyMarkup(doc);
    }
    if (changed) listeners.slice().forEach(function (fn) { try { fn(lang); } catch (e) { if (root.console) root.console.error(e); } });
  }

  var api = {
    LOCALES: LOCALES, DICTS: DICTS, T: T, N: N, fmt: fmt,
    get lang() { return lang; },
    setLocale: setLocale, applyMarkup: applyMarkup,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    language: null
  };
  root.DWI18n = api;

  // Browser: follow the StarHermit language preference.
  if (root.document) {
    var forced = null;
    try { forced = new URLSearchParams(root.location.search).get('lang'); } catch (e) { /* opaque origin */ }
    var SHL = root.StarHermitLanguage;
    var forcedLocale = forced && SHL ? SHL.match(forced, LOCALES) : null;
    if (SHL) {
      api.language = SHL.create({
        game: 'deepworks', supported: LOCALES, panel: !forcedLocale,
        apply: function (locale) { setLocale(forcedLocale || locale); }
      });
    }
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', function () { applyMarkup(); });
    else applyMarkup();
  }
})(typeof self !== 'undefined' ? self : this);
