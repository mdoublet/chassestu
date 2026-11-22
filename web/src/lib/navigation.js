// « Y aller » : une icône qui ouvre l'application de navigation choisie dans
// le profil (sinon Plans sur Apple, Google Maps ailleurs).
import { h } from '../ui.js';
import { state } from '../state.js';
import { NAV_APPS, navigationLinks } from './hunts.js';

export function preferredNavApp() {
  const mine = state.user?.nav_app;
  if (mine && NAV_APPS[mine]) return mine;
  try {
    const v = localStorage.getItem('chassestu.navApp'); // ancien choix sur ce téléphone
    if (v && NAV_APPS[v]) return v;
  } catch { /* rien */ }
  return /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? 'apple' : 'google';
}

/** Icône boussole « y aller » vers des coordonnées [lon, lat]. */
export function navIcon(coords, what = '') {
  const app = preferredNavApp();
  const title = `Y aller${what ? ` (${what})` : ''} avec ${NAV_APPS[app]}`;
  return h('a.nav-icon', { href: navigationLinks(coords)[app], target: '_blank', rel: 'noopener', title, 'aria-label': title }, '🧭');
}

/** Libellé + icône sur une ligne. */
export function navLine(label, coords, what = '') {
  return h('div.nav-line', h('span', label), navIcon(coords, what));
}
