// Indicateur de vent sur une carte : flèche dans le sens où le vent souffle
// (vers où partent les odeurs), direction d'origine et force. Prévision
// Open-Meteo pour l'heure en cours, rafraîchie toutes les 15 minutes.
import L from './leaflet.js';
import { fetchWind, compassName, windPhrase, strength } from '../lib/wind.js';

const ARROW = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 2 L18 14 H13.5 V22 H10.5 V14 H6 Z" fill="currentColor"/></svg>';

export function windText(w) {
  if (!w) return '';
  return `Vent ${windPhrase(w.from_deg)} (${w.from_deg}°), ${w.speed_kmh} km/h${w.gust_kmh ? `, rafales ${w.gust_kmh} km/h` : ''} · ${strength(w.speed_kmh)}`;
}

/** Contrôle Leaflet ; `show(w)` affiche un vent { from_deg, speed_kmh, gust_kmh }, `show(null)` le masque. */
export function windControl(map, position = 'topleft') {
  let el;
  const Ctl = L.Control.extend({
    onAdd() {
      el = L.DomUtil.create('div', 'wind-control');
      el.hidden = true;
      L.DomEvent.disableClickPropagation(el);
      return el;
    },
  });
  new Ctl({ position }).addTo(map);
  return {
    show(w, note = 'prévision Open-Meteo') {
      if (!el) return;
      el.hidden = !w;
      if (!w) return;
      // La flèche indique où va le vent : direction d'origine + 180°.
      el.innerHTML = `<span class="wind-arrow" style="transform: rotate(${(w.from_deg + 180) % 360}deg)">${ARROW}</span>
        <span class="wind-text"><strong>${compassName(w.from_deg)}</strong> ${w.speed_kmh} km/h${w.gust_kmh ? `<small> raf. ${w.gust_kmh}</small>` : ''}</span>`;
      el.title = `${windText(w)} — ${note}`;
    },
  };
}

/**
 * Vent « en direct » au centre donné par `center()` ([lon, lat] ou null) :
 * mis à jour maintenant, à chaque `refresh()` et toutes les 15 minutes.
 * Renvoie { refresh, stop, current }.
 */
export function liveWind(map, center, { onWind = null } = {}) {
  const ctl = windControl(map);
  let current = null;
  let lastKey = null;
  async function refresh(force = false) {
    const c = center();
    if (!c) { ctl.show(null); return; }
    const key = `${c[0].toFixed(2)},${c[1].toFixed(2)}`;
    if (!force && key === lastKey && current) return;
    lastKey = key;
    try {
      current = await fetchWind(c, new Date());
      ctl.show(current, `prévision Open-Meteo pour ${new Date(`${current.time}Z`).getHours()} h`);
      onWind?.(current);
    } catch {
      ctl.show(null); // météo indisponible : rien d'affiché
    }
  }
  setTimeout(refresh, 0); // après l'initialisation de la vue appelante
  const timer = setInterval(() => refresh(true), 15 * 60_000);
  return { refresh, stop: () => clearInterval(timer), get current() { return current; } };
}
