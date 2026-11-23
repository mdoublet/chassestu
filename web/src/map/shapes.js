// Éléments de dessin partagés par l'éditeur et la page des plans de couverture.
import L from './leaflet.js';

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const toLatLng = ([lon, lat]) => [lat, lon];

// Intensité des zones non chassables (curseur des options de carte), 0 à 100,
// 50 = rendu normal. En dessous : plus transparent ; au-dessus : hachures plus
// épaisses et fond plus soutenu. Mémorisée sur l'appareil, commune à toutes les cartes.
const ZONE_KEY = 'chassestu.zonesIntensite';
export function zoneStrength() {
  try {
    const v = Number(localStorage.getItem(ZONE_KEY));
    return localStorage.getItem(ZONE_KEY) !== null && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50;
  } catch {
    return 50;
  }
}
export function setZoneStrength(v, remember = true) {
  const s = Math.min(100, Math.max(0, Number(v))) / 50; // 0 → 2, 1 = normal
  document.documentElement.style.setProperty('--zone-opacity', String(Math.min(1, s)));
  const boost = Math.max(1, s);
  const pattern = document.getElementById('hatch-orange');
  pattern?.querySelector('rect')?.setAttribute('fill', `rgba(217,72,15,${(0.10 * boost * boost).toFixed(3)})`);
  pattern?.querySelector('line')?.setAttribute('stroke-width', String(2 * boost));
  if (remember) {
    try { localStorage.setItem(ZONE_KEY, String(v)); } catch { /* rien */ }
  }
}

export function ensureHatchPattern() {
  if (document.getElementById('hatch-defs')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'hatch-defs';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = `<defs>
    <pattern id="hatch-red" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="rgba(201,42,42,0.08)"/><line x1="0" y1="0" x2="0" y2="8" stroke="#c92a2a" stroke-width="2"/>
    </pattern>
    <pattern id="hatch-orange" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
      <rect width="10" height="10" fill="rgba(217,72,15,0.10)"/><line x1="0" y1="0" x2="0" y2="10" stroke="#d9480f" stroke-width="2"/>
    </pattern></defs>`;
  document.body.append(svg);
  setZoneStrength(zoneStrength(), false);
}

export function postIcon(number, cls = '') {
  return L.divIcon({ className: `post-icon ${cls}`, html: `<span>${Number(number) || '+'}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
}
export const parkingIcon = (cls = '') => L.divIcon({ className: `parking-icon ${cls}`, html: '<span>P</span>', iconSize: [26, 26], iconAnchor: [13, 13] });

/** Icônes de départ (D) et de sortie (S) d'une traque. */
export const traqueIcon = (kind, cls = '') => L.divIcon({
  className: `traque-icon traque-${kind} ${cls}`, html: `<span>${kind === 'start' ? 'D' : 'S'}</span>`, iconSize: [26, 26], iconAnchor: [13, 13],
});

/**
 * Couches d'une traque (plan de chasse) : tracé orange en tirets, départ et
 * sortie. `draggable` : marqueurs déplaçables (callback onMove(kind, [lon, lat])).
 */
export function traqueLayers(hp, { draggable = false, onMove = null } = {}) {
  if (!hp) return [];
  const out = [];
  const label = escapeHtml(hp.name);
  if (hp.drive_path) {
    out.push(L.polyline(hp.drive_path.coordinates.map(toLatLng), { color: '#fff', weight: 7, opacity: 0.7, interactive: false }));
    out.push(L.polyline(hp.drive_path.coordinates.map(toLatLng), { color: '#e8590c', weight: 4, dashArray: '10 7', className: 'traque-line' })
      .bindTooltip(`Traque · ${label}${hp.drive_length_m ? ` · ${hp.drive_length_m} m` : ''}`, { sticky: true }));
  }
  for (const kind of ['start', 'exit']) {
    const g = hp[`${kind}_point`];
    if (!g) continue;
    const m = L.marker(toLatLng(g.coordinates), { icon: traqueIcon(kind), draggable, zIndexOffset: 900 })
      .bindTooltip(`${kind === 'start' ? 'Départ' : 'Sortie'} de la traque · ${label}`, { direction: 'top', offset: [0, -12] });
    if (draggable && onMove) m.on('dragend', () => { const ll = m.getLatLng(); onMove(kind, [ll.lng, ll.lat]); });
    out.push(m);
  }
  return out;
}
