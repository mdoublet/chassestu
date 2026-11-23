// Fiche d'un lieu (lecture) à l'écran : nom, type, note, photo, itinéraire ;
// lien vers la page Lieux pour le président (modification).
import { h, modal } from '../ui.js';
import { state } from '../state.js';
import { kindBadge, kindLabel } from './place-picker.js';
import { placePhotoUrl } from '../lib/photo.js';
import { navLine } from '../lib/navigation.js';

export function openPlaceSheet(p) {
  const photo = p.has_photo ? h('div.place-sheet-photo', h('p.small.muted', 'Chargement de la photo…')) : null;
  if (photo) {
    placePhotoUrl(p.id, p.photo_updated_at ?? '').then((src) => {
      photo.replaceChildren(src ? h('img', { src, alt: p.name }) : h('p.small.muted', 'Photo indisponible.'));
    });
  }
  const canEdit = state.role === 'president';
  const actions = [...(canEdit ? [{ label: '✏️ Modifier dans Lieux', value: 'edit' }] : []), { label: 'Fermer', value: null, primary: true }];
  return modal(h('span', kindBadge(p.kind), ` ${p.name}`), h('div.place-sheet',
    h('p.muted', kindLabel(p.kind)),
    p.notes ? h('p', p.notes) : null,
    photo,
    navLine('Itinéraire', p.geom.coordinates, p.name)), actions)
    .then((v) => { if (v === 'edit') location.hash = `#/lieux/${p.id}`; });
}
