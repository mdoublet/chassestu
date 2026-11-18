// Entrées du menu selon le rôle (sans DOM, testé).
export const APP_NAME = 'Chasses-tu ?'; // espace fine insécable avant « ? »

/**
 * @param {{ role: string|null, isSuperAdmin: boolean, hasTenant: boolean }} who
 * @returns {{ href: string, label: string, icon: string }[]}
 */
export function navItems({ role, isSuperAdmin, hasTenant }) {
  const manager = role === 'president' || role === 'responsable';
  return [
    { href: '#/', label: 'Accueil', icon: '🏠' },
    hasTenant && { href: '#/journees', label: 'Journées', icon: '🎯' },
    hasTenant && { href: '#/carte', label: role === 'president' ? 'Cartographie' : 'Carte', icon: '🗺️' },
    hasTenant && manager && { href: '#/plans', label: 'Plans', icon: '📋' },
    hasTenant && manager && { href: '#/membres', label: 'Membres', icon: '👥' },
    hasTenant && role === 'president' && { href: '#/parametres', label: 'Paramètres', icon: '⚙️' },
    isSuperAdmin && { href: '#/admin', label: 'Administration', icon: '🛠️' },
  ].filter(Boolean);
}

/** Entrée du menu correspondant à l'adresse courante (#/journees/… → Journées). */
export function activeHref(hash, items) {
  const h = hash || '#/';
  let best = null;
  for (const it of items) {
    const match = it.href === '#/' ? h === '#/' || h === '' : h === it.href || h.startsWith(`${it.href}/`);
    if (match && (!best || it.href.length > best.length)) best = it.href;
  }
  return best;
}
