// Fonds de carte IGN (Géoplateforme, flux WMTS publics, sans clé).
// Noms de couches, styles, formats et TileMatrixSet vérifiés dans le
// GetCapabilities de https://data.geopf.fr/wmts (novembre 2026).
import L from './leaflet.js';
import { zoneStrength, setZoneStrength } from './shapes.js';
import { state } from '../state.js';

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

/**
 * Ajoute les fonds IGN et le sélecteur de couches ; renvoie les couches.
 * `zones` : ajoute au sélecteur le curseur d'intensité des zones non chassables.
 */
export function addBasemaps(map, { zones = false, labels = false } = {}) {
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
  const control = L.control
    .layers(
      { [IGN_LAYERS.plan.name]: plan, [IGN_LAYERS.ortho.name]: ortho },
      { [IGN_LAYERS.routes.name]: routes, [IGN_LAYERS.cadastre.name]: cadastre },
      { position: 'topright', collapsed: true },
    )
    .addTo(map);
  const list = control.getContainer().querySelector('.leaflet-control-layers-list');
  if (labels) list?.append(labelToggles(map));
  if (zones) list?.append(zoneSlider());
  L.control.scale({ imperial: false }).addTo(map);
  return { plan, ortho, cadastre, routes };
}

/** Curseur « zones à moins de N m » : plus discrètes ← → plus visibles. */
function zoneSlider() {
  const meters = state.tenant?.buffer_distance_m ?? 150;
  const box = L.DomUtil.create('div', 'zone-slider');
  box.innerHTML = `<div class="leaflet-control-layers-separator"></div>
    <label><span>Zones à moins de ${meters} m</span>
    <input type="range" min="0" max="100" step="5" aria-label="Intensité des zones à moins de ${meters} m des habitations"></label>
    <div class="zone-slider-ends"><span>atténuées</span><span>renforcées</span></div>`;
  const input = box.querySelector('input');
  input.value = String(zoneStrength());
  input.addEventListener('input', () => setZoneStrength(input.value));
  // Glisser le curseur ne déplace pas la carte.
  L.DomEvent.disableClickPropagation(box);
  for (const ev of ['pointerdown', 'mousedown', 'touchstart']) L.DomEvent.on(input, ev, L.DomEvent.stopPropagation);
  return box;
}

/**
 * Cases « Noms des lignes » et « Noms des postes » (décochées par défaut,
 * mémorisées sur l'appareil) : les étiquettes sont toujours dessinées et
 * s'affichent selon une classe de la carte.
 */
const LABEL_KEYS = { lines: 'chassestu.mapLineNames', posts: 'chassestu.mapPostNames' };
function labelToggles(map) {
  const box = L.DomUtil.create('div', 'label-toggles');
  box.append(Object.assign(document.createElement('div'), { className: 'leaflet-control-layers-separator' }));
  const el = map.getContainer();
  for (const [kind, text] of [['lines', 'Noms des lignes'], ['posts', 'Noms des postes']]) {
    let on = false;
    try { on = localStorage.getItem(LABEL_KEYS[kind]) === '1'; } catch { /* rien */ }
    el.classList.toggle(`show-${kind}-names`, on);
    const label = document.createElement('label');
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'leaflet-control-layers-selector', checked: on });
    input.addEventListener('change', () => {
      el.classList.toggle(`show-${kind}-names`, input.checked);
      try { localStorage.setItem(LABEL_KEYS[kind], input.checked ? '1' : '0'); } catch { /* rien */ }
    });
    const span = document.createElement('span');
    span.textContent = ` ${text}`;
    label.append(input, span);
    box.append(label);
  }
  L.DomEvent.disableClickPropagation(box);
  return box;
}
