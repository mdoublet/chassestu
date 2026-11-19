// Fonds de carte IGN (Géoplateforme, flux WMTS publics, sans clé).
// Noms de couches, styles, formats et TileMatrixSet vérifiés dans le
// GetCapabilities de https://data.geopf.fr/wmts (novembre 2026).
import L from './leaflet.js';

import { ATTRIBUTION, ignUrl, IGN_LAYERS } from './ign.js';

export { ignUrl, IGN_LAYERS };

const LIMITS_KEY = 'chassestu.limitesCommunales';
function limitsWanted() {
  try {
    return localStorage.getItem(LIMITS_KEY) !== 'off'; // affichées par défaut
  } catch {
    return true;
  }
}
function rememberLimits(on) {
  try {
    localStorage.setItem(LIMITS_KEY, on ? 'on' : 'off');
  } catch {
    /* rien */
  }
}

function tileLayer(def, extra = {}) {
  return L.tileLayer(ignUrl(def.layer, { style: def.style, format: def.format, matrixSet: def.matrixSet }), {
    attribution: ATTRIBUTION,
    maxZoom: 19,
    maxNativeZoom: def.maxNativeZoom ?? 19,
    minZoom: def.minZoom ?? 0,
    ...extra,
  });
}

/** Ajoute les fonds IGN et le sélecteur de couches ; renvoie les couches. */
export function addBasemaps(map) {
  const plan = tileLayer(IGN_LAYERS.plan);
  const ortho = tileLayer(IGN_LAYERS.ortho);
  const cadastre = tileLayer(IGN_LAYERS.cadastre, { opacity: 0.8 });
  const limites = tileLayer(IGN_LAYERS.limites, { opacity: 0.9 });
  plan.addTo(map);
  if (limitsWanted()) limites.addTo(map);
  map.on('overlayadd', (e) => e.layer === limites && rememberLimits(true));
  map.on('overlayremove', (e) => e.layer === limites && rememberLimits(false));
  L.control
    .layers(
      { [IGN_LAYERS.plan.name]: plan, [IGN_LAYERS.ortho.name]: ortho },
      { [IGN_LAYERS.limites.name]: limites, [IGN_LAYERS.cadastre.name]: cadastre },
      { position: 'topright', collapsed: true },
    )
    .addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  return { plan, ortho, cadastre, limites };
}
