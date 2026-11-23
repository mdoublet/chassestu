// Choix d'un lieu : lieux de l'association (cabane, restaurant, autre) puis
// parkings (lieux de type « parking ») ; option « Autre » au besoin.
import { h } from '../ui.js';

// Types usuels ; le président peut en saisir d'autres (texte libre, reproposé ensuite).
export const PLACE_KINDS = { cabane: 'Cabane', restaurant: 'Restaurant', parking: 'Parking', autre: 'Autre lieu' };
const ICON = { cabane: '🛖', restaurant: '🍽', parking: '🅿', autre: '📍' };
export const kindIcon = (k) => ICON[k] ?? '📍';
/** Icône d'un type dans une liste : « P » bleu des cartes pour un parking, sinon l'emoji. */
export const kindBadge = (k) => (k === 'parking' ? h('span.p-badge', { 'aria-label': 'Parking' }, 'P') : h('span.kind-emoji', kindIcon(k)));
export const kindLabel = (k) => PLACE_KINDS[k] ?? k;

/**
 * Choix du type : types usuels, types déjà utilisés par l'association, puis
 * « Nouveau type… » (saisie). `onchange(kind)` reçoit le type choisi.
 */
export function kindSelect(value, usedKinds, onchange, ask) {
  const custom = [...new Set([...(usedKinds ?? []), value].filter((k) => k && !PLACE_KINDS[k]))].sort((a, b) => a.localeCompare(b, 'fr'));
  const el = h('select', { 'aria-label': 'Type de lieu', onchange: async () => {
    if (el.value !== '__new') return onchange(el.value);
    el.value = value ?? 'autre';
    const k = (await ask())?.trim();
    if (k) onchange(k.slice(0, 40));
    return undefined;
  } },
  Object.entries(PLACE_KINDS).map(([k, l]) => h('option', { value: k, selected: k === value }, `${ICON[k]} ${l}`)),
  custom.length ? h('optgroup', { label: 'Vos types' }, custom.map((k) => h('option', { value: k, selected: k === value }, `📍 ${k}`))) : null,
  h('option', { value: '__new' }, '+ Nouveau type…'));
  return el;
}

/** Liste des choix possibles : { key, label, name, point }. */
export function placeChoices({ places = [] }) {
  const usable = places.filter((p) => p.in_season !== false && p.visibility !== 'private');
  const choice = (p) => ({ key: `place:${p.id}`, label: `${kindIcon(p.kind)} ${p.name}`, point: p.geom });
  return [
    ...usable.filter((p) => p.kind !== 'parking').map((p) => ({ ...choice(p), group: 'Lieux de l’association', name: p.name })),
    // Parkings : des lieux de type « parking », communs à tous les territoires.
    ...usable.filter((p) => p.kind === 'parking').map((p) => ({ ...choice(p), group: 'Parkings', name: /^parking\b/i.test(p.name) ? p.name : `Parking ${p.name}` })),
  ];
}

/**
 * <select> de lieux. `onpick(choice | 'other' | null)`.
 * `current` : nom du lieu actuel, pour présélectionner le bon choix.
 */
export function placeSelect(data, { current = '', selectedKey = null, other = null, onpick, label = 'Lieu' } = {}) {
  const choices = placeChoices(data);
  const groups = [...new Set(choices.map((c) => c.group))];
  const found = selectedKey ? choices.find((c) => c.key === selectedKey) : choices.find((c) => c.name === current);
  const select = h('select', { 'aria-label': label, onchange: () => {
    const v = select.value;
    onpick(v === 'other' ? 'other' : choices.find((c) => c.key === v) ?? null);
  } },
  h('option', { value: '' }, choices.length ? '— choisir —' : 'Aucun lieu : créez-en dans « Lieux »'),
  groups.map((g) => h('optgroup', { label: g }, choices.filter((c) => c.group === g).map((c) => h('option', { value: c.key, selected: c === found }, c.label)))),
  other ? h('option', { value: 'other', selected: selectedKey === 'other' || (!found && !!current) }, other) : null);
  return select;
}
