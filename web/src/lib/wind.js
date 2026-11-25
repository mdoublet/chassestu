// Vent : directions (rose des vents en français), plages favorables des plans
// de chasse, prévision Open-Meteo (gratuite, sans clé). La direction est celle
// d'où vient le vent (convention météo) : « vent d'ouest » = 270°.

export const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const SECTOR = 360 / COMPASS.length; // 22,5°

export const norm = (deg) => ((Math.round(deg) % 360) + 360) % 360;

/** Nom de la direction (16 secteurs) : 268° → « O ». */
export function compassName(deg) {
  return COMPASS[Math.round(norm(deg) / SECTOR) % COMPASS.length];
}

/** Angle (°) d'un secteur : « ONO » → 293. */
export const sectorDeg = (name) => norm(COMPASS.indexOf(name) * SECTOR);

/**
 * La direction est-elle dans la plage [from → to] (sens horaire, bornes
 * comprises, demi-secteur de marge de chaque côté) ? Plage absente : tout vent.
 */
export function windInRange(deg, from, to) {
  if (from == null || to == null || deg == null) return true;
  const span = norm(to - from);            // largeur de la plage, sens horaire
  const offset = norm(deg - from + SECTOR / 2);
  return offset <= span + SECTOR;          // marge d'un demi-secteur de part et d'autre
}

/** « O à NO », « tous vents ». */
export function rangeLabel(from, to) {
  if (from == null || to == null) return 'tous vents';
  return from === to ? compassName(from) : `${compassName(from)} à ${compassName(to)}`;
}

const FULL = ['nord', 'nord-nord-est', 'nord-est', 'est-nord-est', 'est', 'est-sud-est', 'sud-est', 'sud-sud-est',
  'sud', 'sud-sud-ouest', 'sud-ouest', 'ouest-sud-ouest', 'ouest', 'ouest-nord-ouest', 'nord-ouest', 'nord-nord-ouest'];

/** « d’ouest », « du nord-est »… (« Vent d’ouest »). */
export const windPhrase = (deg) => {
  const n = FULL[Math.round(norm(deg) / SECTOR) % FULL.length];
  return /^[aeiou]/.test(n) ? `d’${n}` : `du ${n}`;
};

/** Force du vent en mots (km/h, échelle de Beaufort simplifiée). */
export function strength(kmh) {
  if (kmh == null) return '';
  if (kmh < 6) return 'calme';
  if (kmh < 12) return 'faible';
  if (kmh < 29) return 'modéré';
  if (kmh < 50) return 'fort';
  return 'très fort';
}

/**
 * Plans classés pour un vent donné : ceux dont la plage contient le vent
 * d'abord (`favorable: true`), puis les plans « tous vents », puis les autres.
 */
export function rankPlans(plans, deg) {
  const score = (p) => (p.wind_from_min == null ? 1 : windInRange(deg, p.wind_from_min, p.wind_from_max) ? 0 : 2);
  return plans
    .map((p, i) => ({ ...p, favorable: deg != null && p.wind_from_min != null && score(p) === 0, rank: score(p), i }))
    .sort((a, b) => (deg == null ? 0 : a.rank - b.rank) || a.i - b.i);
}

/** Centre approximatif d'un polygone GeoJSON : [lon, lat]. */
export function polygonCenter(geom) {
  const ring = geom?.type === 'Polygon' ? geom.coordinates[0] : geom?.type === 'MultiPolygon' ? geom.coordinates[0][0] : null;
  if (!ring?.length) return null;
  const pts = ring.slice(0, -1).length ? ring.slice(0, -1) : ring;
  const s = pts.reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
  return [s[0] / pts.length, s[1] / pts.length];
}

/** Heure de prévision la plus proche de `when` dans une réponse Open-Meteo (horaire). */
export function pickHour(hourly, when) {
  const t = when.getTime();
  let best = -1;
  let gap = Infinity;
  hourly.time.forEach((iso, i) => {
    const d = Math.abs(Date.parse(`${iso}Z`) - t);
    if (d < gap) { gap = d; best = i; }
  });
  if (best < 0) return null;
  return {
    time: hourly.time[best],
    from_deg: norm(hourly.wind_direction_10m[best]),
    speed_kmh: Math.round(hourly.wind_speed_10m[best]),
    gust_kmh: hourly.wind_gusts_10m?.[best] == null ? null : Math.round(hourly.wind_gusts_10m[best]),
  };
}

const cache = new Map();
/**
 * Vent prévu à `when` (Date) au point [lon, lat] : { from_deg, speed_kmh, gust_kmh, time }.
 * Heures en UTC ; une réponse gardée 15 min par point.
 */
export async function fetchWind([lon, lat], when = new Date(), fetchImpl = fetch) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > 15 * 60_000) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
      + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=GMT&past_days=1&forecast_days=16';
    entry = { at: Date.now(), data: fetchImpl(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Météo indisponible (${r.status})`)))) };
    cache.set(key, entry);
    entry.data.catch(() => cache.delete(key));
  }
  const data = await entry.data;
  return pickHour(data.hourly, when);
}
