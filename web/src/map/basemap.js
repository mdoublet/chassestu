// Fonds de carte IGN (Géoplateforme, flux WMTS publics, sans clé).
// Noms de couches, styles, formats et TileMatrixSet vérifiés dans le
// GetCapabilities de https://data.geopf.fr/wmts (novembre 2026).
import L from './leaflet.js';

const WMTS = 'https://data.geopf.fr/wmts';
const ATTRIBUTION = '© <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a> — Géoplateforme';

export function ignUrl(layer, { style = 'normal', format = 'image/png' } = {}) {
  const params = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: layer,
    STYLE: style,
    TILEMATRIXSET: 'PM_0_19',
    FORMAT: format,
  });
  return `${WMTS}?${params}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
}

export const IGN_LAYERS = {
  plan: { name: 'Plan IGN', layer: 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', format: 'image/png' },
  ortho: { name: 'Photographies aériennes', layer: 'ORTHOIMAGERY.ORTHOPHOTOS', format: 'image/jpeg' },
  cadastre: { name: 'Cadastre', layer: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS', format: 'image/png', style: 'PCI vecteur' },
};

function tileLayer(def, extra = {}) {
  return L.tileLayer(ignUrl(def.layer, { style: def.style, format: def.format }), {
    attribution: ATTRIBUTION,
    maxZoom: 19,
    maxNativeZoom: 19,
    ...extra,
  });
}

/** Ajoute les fonds IGN et le sélecteur de couches ; renvoie les couches. */
export function addBasemaps(map) {
  const plan = tileLayer(IGN_LAYERS.plan);
  const ortho = tileLayer(IGN_LAYERS.ortho);
  const cadastre = tileLayer(IGN_LAYERS.cadastre, { opacity: 0.8 });
  plan.addTo(map);
  L.control
    .layers(
      { [IGN_LAYERS.plan.name]: plan, [IGN_LAYERS.ortho.name]: ortho },
      { [IGN_LAYERS.cadastre.name]: cadastre },
      { position: 'topright', collapsed: true },
    )
    .addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  return { plan, ortho, cadastre };
}
