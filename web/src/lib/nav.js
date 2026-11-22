// Entrées du menu selon le rôle (sans DOM, testé).
export const APP_NAME = 'Chasses-tu ?'; // espace fine insécable avant « ? »

/**
 * @param {{ role: string|null, isSuperAdmin: boolean, hasTenant: boolean }} who
 * @returns {{ href: string, label: string, icon: string }[]}
 */
export function navItems({ role, isSuperAdmin, hasTenant }) {
  const manager = role === 'president' || role === 'responsable';
  return [
    // Pas d'accueil une fois membre : on arrive directement sur les journées.
    !hasTenant && { href: '#/', label: 'Accueil', icon: '🏠' },
    hasTenant && { href: '#/journees', label: 'Journées', icon: '🎯' },
    hasTenant && { href: '#/territoires', label: 'Territoires', icon: '🗺️', also: ['#/carte', '#/plans'] },
    hasTenant && { href: '#/lieux', label: 'Lieux', icon: '📍' },
    hasTenant && manager && { href: '#/membres', label: 'Membres', icon: '👥' },
    hasTenant && role === 'president' && { href: '#/parametres', label: 'Paramètres', icon: '⚙️' },
    { href: '#/profil', label: 'Mon profil', icon: '👤' },
    isSuperAdmin && { href: '#/admin', label: 'Administration', icon: '🛠️' },
  ].filter(Boolean);
}

/** Entrée du menu correspondant à l'adresse courante (#/journees/… → Journées). */
export function activeHref(hash, items) {
  const h = hash || '#/';
  let best = null;
  for (const it of items) {
    const match = it.href === '#/' ? h === '#/' || h === ''
      : [it.href, ...(it.also ?? [])].some((p) => h === p || h.startsWith(`${p}/`));
    if (match && (!best || it.href.length > best.length)) best = it.href;
  }
  return best;
}
