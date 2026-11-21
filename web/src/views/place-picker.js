// Choix d'un lieu : lieux de l'association (cabane, restaurant, autre) puis
// parkings des territoires ; option « Autre » au besoin.
import { h } from '../ui.js';

export const PLACE_KINDS = { cabane: 'Cabane', restaurant: 'Restaurant', autre: 'Autre lieu' };
const ICON = { cabane: '🛖', restaurant: '🍽', autre: '📍' };

/** Liste des choix possibles : { key, label, name, point }. */
export function placeChoices({ places = [], parkings = [] }) {
  return [
    ...places.filter((p) => p.in_season !== false).map((p) => ({ key: `place:${p.id}`, group: 'Lieux de l’association', label: `${ICON[p.kind] ?? '📍'} ${p.name}`, name: p.name, point: p.geom })),
    ...parkings.map((p) => ({ key: `parking:${p.id}`, group: 'Parkings', label: `🅿 ${p.name} (${p.territory_name})`, name: /^parking\b/i.test(p.name) ? p.name : `Parking ${p.name}`, point: p.geom })),
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
