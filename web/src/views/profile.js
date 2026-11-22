// Mon profil : nom, marche et voiture (servent aux postes accessibles et au covoiturage).
import { api } from '../api.js';
import { state } from '../state.js';
import { h, toast, errorMessage, confirmDialog, fold } from '../ui.js';
import { WALK_LABELS, NAV_APPS } from '../lib/hunts.js';
import { preferredNavApp } from '../lib/navigation.js';
import { signOut } from '../auth.js';

export function profileView(main, { refreshMe }) {
  const u = state.user;
  const name = h('input', { required: true, maxlength: 120, value: u.display_name ?? '' });
  const walk = h('select', h('option', { value: '' }, 'Non renseigné'),
    Object.entries(WALK_LABELS).map(([v, l]) => h('option', { value: v, selected: String(u.walking_ability ?? '') === v }, l)));
  const car = h('input', { type: 'checkbox', checked: !!u.has_car });
  const nav = h('select', Object.entries(NAV_APPS).map(([k, v]) => h('option', { value: k, selected: k === preferredNavApp() }, v)));
  const seats = h('input', { type: 'number', min: 0, max: 8, value: u.car_seats ?? '', style: 'width:6rem' });
  const sync = () => { seats.disabled = !car.checked; };
  car.addEventListener('change', sync);
  sync();
  main.append(h('h1', 'Mon profil'), h('form.card', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api.patch('/me', {
          display_name: name.value.trim(),
          walking_ability: walk.value ? Number(walk.value) : null,
          has_car: car.checked,
          car_seats: car.checked ? (seats.value === '' ? null : Number(seats.value)) : 0,
          nav_app: nav.value,
        }, { tenant: false });
        await refreshMe();
        toast('Profil enregistré.');
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
  },
  h('label', 'Nom', name),
  h('label', 'Marche jusqu’au poste', walk),
  h('div.row', h('label.check', car, 'Ma voiture'), h('label', 'Places libres', seats)),
  h('label', 'Application de navigation (🧭)', nav),
  h('button.primary', { type: 'submit' }, 'Enregistrer')),
  h('section.card', fold('Mon compte', { key: 'profile.account', extra: u.email ?? '' },
    h('button', { onclick: async () => { await signOut(); location.hash = '#/'; location.reload(); } }, 'Se déconnecter'),
    h('button.danger', {
      onclick: async () => {
        if (!(await confirmDialog('Supprimer mon compte', 'Supprimer définitivement votre compte et votre accès à toutes vos associations ?', 'Supprimer', true))) return;
        try {
          await api.del('/me', { tenant: false });
          toast('Compte supprimé.');
          location.reload();
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      },
    }, 'Supprimer mon compte'))));
}
