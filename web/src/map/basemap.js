// Fonds de carte IGN (Géoplateforme, flux WMTS publics, sans clé).
// Noms de couches, styles, formats et TileMatrixSet vérifiés dans le
// GetCapabilities de https://data.geopf.fr/wmts (novembre 2026).
import L from './leaflet.js';

const WMTS = 'https://data.geopf.fr/wmts';
const ATTRIBUTION = '© <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a> — Géoplateforme';

export function ignUrl(layer, { style = 'normal', format = 'image/png', matrixSet = 'PM_0_19' } = {}) {
  const params = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: layer,
    STYLE: style,
    TILEMATRIXSET: matrixSet,
    FORMAT: format,
  });
  return `${WMTS}?${params}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
}

export const IGN_LAYERS = {
  plan: { name: 'Plan IGN', layer: 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', format: 'image/png' },
  ortho: { name: 'Photographies aériennes', layer: 'ORTHOIMAGERY.ORTHOPHOTOS', format: 'image/jpeg' },
  cadastre: { name: 'Cadastre', layer: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS', format: 'image/png', style: 'PCI vecteur' },
  // Réseau BD TOPO transparent : routes, mais aussi pistes et sentiers (vérifié en forêt).
  routes: { name: 'Routes et chemins', layer: 'TRANSPORTNETWORKS.ROADS', format: 'image/png', matrixSet: 'PM_6_18', minZoom: 6, maxNativeZoom: 18 },
};

// Routes et chemins par-dessus la photo : affichés par défaut, choix mémorisé.
const ROUTES_KEY = 'chassestu.routesSurPhoto';
function routesWanted() {
  try {
    return localStorage.getItem(ROUTES_KEY) !== 'off';
  } catch {
    return true;
  }
}
function rememberRoutes(on) {
  try {
    localStorage.setItem(ROUTES_KEY, on ? 'on' : 'off');
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
  const routes = tileLayer(IGN_LAYERS.routes);
  plan.addTo(map);
  // Sur la photo : routes et chemins par-dessus, et classe CSS pour éclaircir
  // les contours (vert foncé illisible sur la forêt). Sur le plan : inutiles.
  let switching = false;
  map.on('baselayerchange', (e) => {
    const onPhoto = e.layer === ortho;
    map.getContainer().classList.toggle('basemap-ortho', onPhoto);
    // Après le clic dans le sélecteur : sinon Leaflet ne met pas sa case à jour.
    setTimeout(() => {
      switching = true;
      if (onPhoto && routesWanted()) routes.addTo(map);
      else if (!onPhoto) map.removeLayer(routes);
      switching = false;
    }, 0);
  });
  map.on('overlayadd', (e) => e.layer === routes && !switching && rememberRoutes(true));
  map.on('overlayremove', (e) => e.layer === routes && !switching && map.hasLayer(ortho) && rememberRoutes(false));
  L.control
    .layers(
      { [IGN_LAYERS.plan.name]: plan, [IGN_LAYERS.ortho.name]: ortho },
      { [IGN_LAYERS.routes.name]: routes, [IGN_LAYERS.cadastre.name]: cadastre },
      { position: 'topright', collapsed: true },
    )
    .addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  return { plan, ortho, cadastre, routes };
}
