// Positions GPS : règles d'envoi et libellés (sans DOM, testés).
import { distanceMeters } from './simplify.js';

/** Envoi toutes les 15 s en mouvement, toutes les 60 s à l'arrêt (spécification). */
export const MOVING_MS = 15_000;
export const IDLE_MS = 60_000;
export const MOVED_M = 15;

/**
 * Faut-il envoyer `fix` ({ lon, lat, at }) sachant le dernier envoi `last` ?
 */
export function shouldSend(last, fix, now = Date.now()) {
  if (!fix) return false;
  if (!last) return true;
  const elapsed = now - last.sentAt;
  if (elapsed >= IDLE_MS) return true;
  return elapsed >= MOVING_MS && distanceMeters([last.lon, last.lat], [fix.lon, fix.lat]) >= MOVED_M;
}

/** Statut de sa propre position par rapport à son poste (même règle que le serveur). */
export function ownStatus(fix, postCoords, toleranceM) {
  if (!fix) return null;
  if (fix.accuracy > 2 * toleranceM) return 'imprecise';
  if (!postCoords) return 'localise';
  return distanceMeters([fix.lon, fix.lat], postCoords) <= toleranceM ? 'sur_poste' : 'en_route';
}

export const POSITION_STATUS = {
  sur_poste: { label: 'Sur le poste', color: '#2f9e44' },
  en_route: { label: 'En route', color: '#e8590c' },
  localise: { label: 'Localisé', color: '#1c7ed6' },
  imprecise: { label: 'Position imprécise', color: '#f59f00' },
  sans_signal: { label: 'Sans signal', color: '#868e96' },
  non_partage: { label: 'Ne partage pas', color: '#adb5bd' },
  invite: { label: 'Invité (sans suivi)', color: '#adb5bd' },
};

/** « à l'instant », « il y a 40 s », « il y a 3 min », « il y a 2 h » */
export function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 10) return 'à l’instant';
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  return `il y a ${Math.floor(seconds / 3600)} h`;
}

export function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}
