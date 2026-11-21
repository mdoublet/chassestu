// Saison en cours : rattacher / détacher un élément (territoire, plan de
// chasse, lieu, membre). Les listes montrent la saison en cours ; le reste est
// replié dans « Hors saison ».
import { api } from '../api.js';

let cached = null;
export async function currentSeason() {
  cached ??= api.get('/seasons').then((r) => r.current).catch(() => null);
  return cached;
}
export function forgetSeason() { cached = null; }

/** kind : 'territories' | 'hunt-plans' | 'places' | 'members' */
export async function setInSeason(kind, id, inSeason) {
  const s = await currentSeason();
  if (!s) throw new Error('Aucune saison en cours : créez-en une dans Paramètres.');
  const path = `/seasons/${s.id}/${kind}/${encodeURIComponent(id)}`;
  return inSeason ? api.put(path, {}) : api.del(path);
}
