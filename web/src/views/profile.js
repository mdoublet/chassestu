// Mon profil : nom, marche et voiture (servent aux postes accessibles et au covoiturage).
import { api } from '../api.js';
import { state } from '../state.js';
import { h, toast, errorMessage } from '../ui.js';
import { WALK_LABELS } from '../lib/hunts.js';

export function profileView(main, { refreshMe }) {
  const u = state.user;
  const name = h('input', { required: true, maxlength: 120, value: u.display_name ?? '' });
  const walk = h('select', h('option', { value: '' }, 'Non renseigné'),
    Object.entries(WALK_LABELS).map(([v, l]) => h('option', { value: v, selected: String(u.walking_ability ?? '') === v }, l)));
  const car = h('input', { type: 'checkbox', checked: !!u.has_car });
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
        }, { tenant: false });
        await refreshMe();
        toast('Profil enregistré.');
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
  },
  h('label', 'Nom', name),
  h('label', 'Combien pouvez-vous marcher pour rejoindre un poste ?', walk),
  h('label.check', car, 'Je viens avec ma voiture'),
  h('label', 'Places libres pour d’autres chasseurs', seats),
  h('p.small.muted', 'Sert à vous proposer des postes accessibles et à organiser le covoiturage. L’organisateur peut l’ajuster pour une journée.'),
  h('button.primary', { type: 'submit' }, 'Enregistrer')));
}
