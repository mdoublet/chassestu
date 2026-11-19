// Adresses des tuiles IGN (Géoplateforme, flux WMTS publics, sans clé), sans DOM (testé).
// Noms de couches, styles, formats et TileMatrixSet vérifiés dans le
// GetCapabilities de https://data.geopf.fr/wmts (novembre 2026).
export const WMTS = 'https://data.geopf.fr/wmts';
export const ATTRIBUTION = '© <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a> — Géoplateforme';

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
  // Limites administratives à jour (ADMIN EXPRESS, précision métrique) ; tuiles des zooms 6 à 16 seulement.
  limites: { name: 'Limites communales', layer: 'LIMITES_ADMINISTRATIVES_EXPRESS.LATEST', format: 'image/png', matrixSet: 'PM_6_16', minZoom: 6, maxNativeZoom: 16 },
};

