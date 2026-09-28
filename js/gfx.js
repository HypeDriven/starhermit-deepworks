/**
 * Deepworks — graphics quality model (`DWGfx`).
 *
 * Pure (no three.js, no DOM): presets, per-category overrides, GPU detection,
 * a cost summary and the Graphics panel strings. The renderer and the
 * settings panel both read it so they agree on what a setting means.
 * Classic script with a UMD wrapper (also loads in Node for tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DWGfx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category → allowed tiers, cheapest first.
  var CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],
    ao: ['off', 'on', 'high'],
    bloom: ['off', 'on'],
    grade: ['off', 'on'],
    antialias: ['off', 'fxaa', 'smaa', 'msaa'],
    reflections: ['off', 'on'],
    detail: ['plain', 'detailed'],
    particles: ['low', 'medium', 'high']
  };
  var CATEGORY_ORDER = ['shadows', 'ao', 'bloom', 'grade', 'antialias', 'reflections', 'detail', 'particles'];

  // Each preset is a row of tiers, a render scale (multiplies the capped
  // device pixel ratio) and a device-pixel-ratio cap.
  var TABLE = {
    low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low' },
    balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'medium' },
    high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high' },
    ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high' }
  };

  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
  var PARTICLE_MULT = { low: 0.35, medium: 0.7, high: 1 };
  var CRYSTALS = { plain: 24, detailed: 80 };
  var DUST = { low: 0, medium: 18, high: 36 }; // drifting motes per open layer

  /** Best preset for this GPU, from the unmasked renderer string when exposed. */
  function detectPreset(gpu, mobile) {
    var g = String(gpu || '').toLowerCase();
    var tier = 'balanced';
    if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) tier = 'low';
    else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) tier = 'high';
    if (mobile && (tier === 'high' || tier === 'ultra')) tier = 'balanced';
    return tier;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /**
   * Resolve saved settings into concrete tiers.
   * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
   */
  function resolve(saved, detected) {
    var s = saved || {};
    var auto = PRESETS.indexOf(s.preset) < 0;
    var preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    var row = TABLE[preset];
    var out = {
      preset: preset,
      auto: auto,
      renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
      dprCap: row.dprCap
    };
    out.scale = row.scale * out.renderScale;
    CATEGORY_ORDER.forEach(function (cat) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    });
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    // Post-processing runs only when something needs it; otherwise the canvas
    // draws directly with its built-in MSAA (as cheap as before the upgrade).
    out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
      out.antialias === 'fxaa' || out.antialias === 'smaa';
    return out;
  }

  /** Choosing a preset clears every per-category override. */
  function choosePreset(saved, preset) {
    var s = Object.assign({}, saved || {});
    s.preset = PRESETS.indexOf(preset) >= 0 ? preset : 'auto';
    CATEGORY_ORDER.forEach(function (cat) { delete s[cat]; });
    return s;
  }

  /** The preset's own tier for a category (for "From preset (…)" labels). */
  function presetTier(preset, cat) {
    return TABLE[preset] ? TABLE[preset][cat] : undefined;
  }

  /** Final device pixel ratio for a resolved setting set. */
  function pixelRatio(r, dpr, adaptiveScale) {
    var base = Math.min(dpr || 1, r.dprCap);
    return clamp(base * r.scale * (adaptiveScale || 1), 0.4, 3);
  }

  // ------------------------------------------------------------- strings ---
  // The game ships English UI; the Graphics panel is localized into the
  // fleet's required locales (picked from navigator.language).
  var STRINGS = {
    'en-US': {
      graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {t})', from_preset: 'From preset ({t})',
      render_scale: 'Render scale', adaptive: 'Adaptive resolution', show_fps: 'Show frame rate',
      post_unavailable: 'Post-processing is unavailable on this device; effects that need it are off.',
      unknown_gpu: 'Unknown GPU', fps: 'fps',
      p_low: 'Low', p_balanced: 'Balanced', p_high: 'High', p_ultra: 'Ultra',
      c_shadows: 'Shadows', c_ao: 'Ambient occlusion', c_bloom: 'Bloom', c_grade: 'Color grade',
      c_antialias: 'Anti-aliasing', c_reflections: 'Reflections', c_detail: 'Surface detail', c_particles: 'Particles',
      t_off: 'Off', t_on: 'On', t_low: 'Low', t_medium: 'Medium', t_high: 'High', t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA',
      t_plain: 'Plain', t_detailed: 'Detailed',
      d_no_shadows: 'no shadows', d_shadows: '{n}² shadows', d_ao: 'ambient occlusion', d_ao_high: 'full ambient occlusion',
      d_bloom: 'bloom', d_reflections: 'reflections', d_no_aa: 'no anti-aliasing'
    },
    'en-GB': {},
    'es-419': {
      graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {t})', from_preset: 'Según el ajuste ({t})',
      render_scale: 'Escala de renderizado', adaptive: 'Resolución adaptativa', show_fps: 'Mostrar fotogramas por segundo',
      post_unavailable: 'El posprocesamiento no está disponible en este dispositivo; los efectos que lo necesitan están desactivados.',
      unknown_gpu: 'GPU desconocida', fps: 'fps',
      p_low: 'Baja', p_balanced: 'Equilibrada', p_high: 'Alta', p_ultra: 'Ultra',
      c_shadows: 'Sombras', c_ao: 'Oclusión ambiental', c_bloom: 'Resplandor', c_grade: 'Corrección de color',
      c_antialias: 'Suavizado de bordes', c_reflections: 'Reflejos', c_detail: 'Detalle de superficies', c_particles: 'Partículas',
      t_off: 'Desactivado', t_on: 'Activado', t_low: 'Bajo', t_medium: 'Medio', t_high: 'Alto',
      t_plain: 'Simple', t_detailed: 'Detallado',
      d_no_shadows: 'sin sombras', d_shadows: 'sombras {n}²', d_ao: 'oclusión ambiental', d_ao_high: 'oclusión ambiental completa',
      d_bloom: 'resplandor', d_reflections: 'reflejos', d_no_aa: 'sin suavizado'
    },
    'es-ES': {},
    'de-DE': {
      graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {t})', from_preset: 'Aus Voreinstellung ({t})',
      render_scale: 'Renderskalierung', adaptive: 'Adaptive Auflösung', show_fps: 'Bildrate anzeigen',
      post_unavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Effekte, die sie brauchen, sind aus.',
      unknown_gpu: 'Unbekannte GPU', fps: 'fps',
      p_low: 'Niedrig', p_balanced: 'Ausgewogen', p_high: 'Hoch', p_ultra: 'Ultra',
      c_shadows: 'Schatten', c_ao: 'Umgebungsverdeckung', c_bloom: 'Leuchteffekt', c_grade: 'Farbkorrektur',
      c_antialias: 'Kantenglättung', c_reflections: 'Spiegelungen', c_detail: 'Oberflächendetails', c_particles: 'Partikel',
      t_off: 'Aus', t_on: 'An', t_low: 'Niedrig', t_medium: 'Mittel', t_high: 'Hoch',
      t_plain: 'Einfach', t_detailed: 'Detailliert',
      d_no_shadows: 'keine Schatten', d_shadows: '{n}²-Schatten', d_ao: 'Umgebungsverdeckung', d_ao_high: 'volle Umgebungsverdeckung',
      d_bloom: 'Leuchteffekt', d_reflections: 'Spiegelungen', d_no_aa: 'keine Kantenglättung'
    },
    'fr-FR': {
      graphics: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {t})', from_preset: 'Selon le préréglage ({t})',
      render_scale: 'Échelle de rendu', adaptive: 'Résolution adaptative', show_fps: 'Afficher les images par seconde',
      post_unavailable: 'Le post-traitement est indisponible sur cet appareil ; les effets qui en dépendent sont désactivés.',
      unknown_gpu: 'GPU inconnu', fps: 'i/s',
      p_low: 'Basse', p_balanced: 'Équilibrée', p_high: 'Haute', p_ultra: 'Ultra',
      c_shadows: 'Ombres', c_ao: 'Occlusion ambiante', c_bloom: 'Halo lumineux', c_grade: 'Étalonnage des couleurs',
      c_antialias: 'Anticrénelage', c_reflections: 'Reflets', c_detail: 'Détail des surfaces', c_particles: 'Particules',
      t_off: 'Désactivé', t_on: 'Activé', t_low: 'Bas', t_medium: 'Moyen', t_high: 'Élevé',
      t_plain: 'Simple', t_detailed: 'Détaillé',
      d_no_shadows: 'sans ombres', d_shadows: 'ombres {n}²', d_ao: 'occlusion ambiante', d_ao_high: 'occlusion ambiante complète',
      d_bloom: 'halo', d_reflections: 'reflets', d_no_aa: 'sans anticrénelage'
    },
    'fr-CA': {},
    'pt-BR': {
      graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {t})', from_preset: 'Da predefinição ({t})',
      render_scale: 'Escala de renderização', adaptive: 'Resolução adaptativa', show_fps: 'Mostrar taxa de quadros',
      post_unavailable: 'O pós-processamento não está disponível neste dispositivo; os efeitos que dependem dele estão desligados.',
      unknown_gpu: 'GPU desconhecida', fps: 'qps',
      p_low: 'Baixa', p_balanced: 'Equilibrada', p_high: 'Alta', p_ultra: 'Ultra',
      c_shadows: 'Sombras', c_ao: 'Oclusão de ambiente', c_bloom: 'Brilho', c_grade: 'Correção de cor',
      c_antialias: 'Suavização de bordas', c_reflections: 'Reflexos', c_detail: 'Detalhe das superfícies', c_particles: 'Partículas',
      t_off: 'Desligado', t_on: 'Ligado', t_low: 'Baixo', t_medium: 'Médio', t_high: 'Alto',
      t_plain: 'Simples', t_detailed: 'Detalhado',
      d_no_shadows: 'sem sombras', d_shadows: 'sombras {n}²', d_ao: 'oclusão de ambiente', d_ao_high: 'oclusão de ambiente completa',
      d_bloom: 'brilho', d_reflections: 'reflexos', d_no_aa: 'sem suavização'
    },
    'it-IT': {
      graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {t})', from_preset: 'Dalla preimpostazione ({t})',
      render_scale: 'Scala di rendering', adaptive: 'Risoluzione adattiva', show_fps: 'Mostra frequenza fotogrammi',
      post_unavailable: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti che la richiedono sono disattivati.',
      unknown_gpu: 'GPU sconosciuta', fps: 'fps',
      p_low: 'Bassa', p_balanced: 'Bilanciata', p_high: 'Alta', p_ultra: 'Ultra',
      c_shadows: 'Ombre', c_ao: 'Occlusione ambientale', c_bloom: 'Bagliore', c_grade: 'Correzione colore',
      c_antialias: 'Anti-aliasing', c_reflections: 'Riflessi', c_detail: 'Dettaglio superfici', c_particles: 'Particelle',
      t_off: 'Disattivato', t_on: 'Attivato', t_low: 'Basso', t_medium: 'Medio', t_high: 'Alto',
      t_plain: 'Semplice', t_detailed: 'Dettagliato',
      d_no_shadows: 'senza ombre', d_shadows: 'ombre {n}²', d_ao: 'occlusione ambientale', d_ao_high: 'occlusione ambientale completa',
      d_bloom: 'bagliore', d_reflections: 'riflessi', d_no_aa: 'senza anti-aliasing'
    }
  };
  // Regional variants share their base table; only real differences listed.
  STRINGS['en-GB'] = Object.assign({}, STRINGS['en-US'], { c_grade: 'Colour grade' });
  STRINGS['es-ES'] = Object.assign({}, STRINGS['es-419'], { show_fps: 'Mostrar imágenes por segundo' });
  STRINGS['fr-CA'] = Object.assign({}, STRINGS['fr-FR'], { c_bloom: 'Éclat lumineux', d_bloom: 'éclat' });
  var LOCALES = Object.keys(STRINGS);
  var FALLBACK = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

  function pickLocale(lang) {
    var l = String(lang || 'en-US');
    for (var i = 0; i < LOCALES.length; i++) if (LOCALES[i].toLowerCase() === l.toLowerCase()) return LOCALES[i];
    var base = l.split(/[-_]/)[0].toLowerCase();
    if (base === 'es' && /-es$/i.test(l)) return 'es-ES';
    return FALLBACK[base] || 'en-US';
  }

  function t(locale, key, vars) {
    var table = STRINGS[locale] || STRINGS['en-US'];
    var s = table[key];
    if (s === undefined) s = STRINGS['en-US'][key];
    if (s === undefined) s = key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', vars[k]); });
    return s;
  }

  /** Cost summary: "2048² shadows · ambient occlusion · bloom · SMAA · 1280×800 px". */
  function describe(r, pixels, locale) {
    var L = locale || 'en-US';
    var parts = [
      r.shadows === 'off' ? t(L, 'd_no_shadows') : t(L, 'd_shadows', { n: SHADOW_MAP[r.shadows] }),
      r.ao === 'off' ? null : t(L, r.ao === 'high' ? 'd_ao_high' : 'd_ao'),
      r.bloom === 'on' ? t(L, 'd_bloom') : null,
      r.reflections === 'on' ? t(L, 'd_reflections') : null,
      r.antialias === 'off' ? t(L, 'd_no_aa') : r.antialias.toUpperCase(),
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  return {
    PRESETS: PRESETS,
    CATEGORIES: CATEGORIES,
    CATEGORY_ORDER: CATEGORY_ORDER,
    SHADOW_MAP: SHADOW_MAP,
    PARTICLE_MULT: PARTICLE_MULT,
    CRYSTALS: CRYSTALS,
    DUST: DUST,
    LOCALES: LOCALES,
    detectPreset: detectPreset,
    resolve: resolve,
    choosePreset: choosePreset,
    presetTier: presetTier,
    pixelRatio: pixelRatio,
    describe: describe,
    pickLocale: pickLocale,
    t: t
  };
});
