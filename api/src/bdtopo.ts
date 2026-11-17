// Bâtiments de la BD TOPO (IGN) via le service WFS de la Géoplateforme.
//
// * Nom de couche vérifié dans le GetCapabilities (novembre 2026) :
//   BDTOPO_V3:batiment. S'il disparaît, on relit le GetCapabilities pour
//   trouver la couche « …:batiment » de la BD TOPO plutôt que d'échouer.
// * Les réponses JSON ne sont PAS décodées ici : elles sont transmises telles
//   quelles à PostgreSQL (jsonb). Décoder des Mo de JSON dépasserait la limite
//   de temps de calcul d'un Worker gratuit (10 ms).
// * Le service est parfois surchargé (erreurs 400/503 transitoires) : on
//   réessaie avant d'abandonner.
import { AppError } from './errors';

const WFS = 'https://data.geopf.fr/wfs/ows';
const DEFAULT_LAYER = 'BDTOPO_V3:batiment';
const PAGE_SIZE = 1000;
export const MAX_BUILDINGS = 10_000;
const PROPERTIES = 'cleabs,nature,usage_1,usage_2,etat_de_l_objet,nombre_de_logements,geometrie';

let layerName = DEFAULT_LAYER;

export type Bbox = { minLon: number; minLat: number; maxLon: number; maxLat: number };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function getFeatureUrl(layer: string, bbox: Bbox, startIndex: number): string {
  const params = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: layer,
    OUTPUTFORMAT: 'application/json',
    SRSNAME: 'EPSG:4326',
    // WFS 2.0 + urn EPSG:4326 : ordre latitude, longitude.
    BBOX: `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon},urn:ogc:def:crs:EPSG::4326`,
    PROPERTYNAME: PROPERTIES,
    COUNT: String(PAGE_SIZE),
    STARTINDEX: String(startIndex),
    SORTBY: 'cleabs',
  });
  return `${WFS}?${params}`;
}

async function fetchText(url: string, fetchImpl: FetchLike, attempts = 3): Promise<{ ok: boolean; text: string }> {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) return { ok: true, text };
      last = text.slice(0, 300);
      // Couche inconnue : inutile de réessayer.
      if (/feature type|typename|unknown/i.test(last) && !/connection|timeout/i.test(last)) return { ok: false, text: last };
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  return { ok: false, text: last };
}

/** Relit le GetCapabilities pour retrouver la couche bâtiment de la BD TOPO (cas rare). */
async function discoverLayer(fetchImpl: FetchLike): Promise<string | null> {
  const res = await fetchImpl(`${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities`);
  if (!res.ok) return null;
  const xml = await res.text();
  const names = [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
  return names.find((n) => /^BDTOPO_V\d+:batiment$/.test(n)) ?? null;
}

/**
 * Renvoie les pages GeoJSON brutes (texte) des bâtiments de l'emprise.
 * Lève une AppError 502 si le service ne répond pas, 422 si l'emprise est trop grande.
 */
export async function fetchBuildingPages(bbox: Bbox, fetchImpl: FetchLike = fetch): Promise<string[]> {
  const pages: string[] = [];
  let first = await fetchText(getFeatureUrl(layerName, bbox, 0), fetchImpl);
  if (!first.ok && /feature type|typename|unknown/i.test(first.text)) {
    const found = await discoverLayer(fetchImpl).catch(() => null);
    if (found && found !== layerName) {
      layerName = found;
      first = await fetchText(getFeatureUrl(layerName, bbox, 0), fetchImpl);
    }
  }
  if (!first.ok) {
    console.warn('BD TOPO indisponible :', first.text);
    throw new AppError(502, 'BDTOPO_UNAVAILABLE', 'Le service des bâtiments de l’IGN ne répond pas. Réessayez dans quelques minutes.');
  }
  pages.push(first.text);

  // numberMatched est présent dans la réponse GeoJSON de la Géoplateforme.
  const matched = Number(/"numberMatched"\s*:\s*(\d+)/.exec(first.text)?.[1] ?? 0);
  if (matched > MAX_BUILDINGS) {
    throw new AppError(422, 'TOO_MANY_BUILDINGS', `Emprise trop grande : ${matched} bâtiments (maximum ${MAX_BUILDINGS}). Découpez le territoire.`);
  }
  // Pages suivantes : 3 requêtes à la fois (plus rapide, sans surcharger un service fragile).
  const starts: number[] = [];
  for (let start = PAGE_SIZE; start < matched; start += PAGE_SIZE) starts.push(start);
  for (let i = 0; i < starts.length; i += 3) {
    const batch = await Promise.all(starts.slice(i, i + 3).map((start) => fetchText(getFeatureUrl(layerName, bbox, start), fetchImpl)));
    for (const page of batch) {
      if (!page.ok) {
        throw new AppError(502, 'BDTOPO_UNAVAILABLE', 'Le service des bâtiments de l’IGN a interrompu l’import. Réessayez dans quelques minutes.');
      }
      pages.push(page.text);
    }
  }
  return pages;
}
