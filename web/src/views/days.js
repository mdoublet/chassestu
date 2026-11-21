// Journées de chasse : liste et création (président, organisateur).
// L'heure, le lieu du rendez-vous et le déjeuner sont repris de la dernière
// journée : ils changent rarement d'une fois à l'autre.
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, fold } from '../ui.js';
import { DAY_STATUS_LABELS, formatHuntDate, formatTime } from '../lib/hunts.js';
import { every } from '../lib/live.js';
import { placeSelect } from './place-picker.js';
import { pushCard } from './notifications.js';

const MANAGERS = ['president', 'responsable'];
const OPEN = ['brouillon', 'convoquee', 'en_cours'];

export async function daysView(main) {
  const canManage = MANAGERS.includes(state.role);
  const listBox = h('div');
  const formBox = h('div');
  // Repris de l'ancien accueil : profil à compléter, notifications à activer sur cet appareil.
  const profileMissing = !state.user.walking_ability || state.user.has_car === null || state.user.has_car === undefined;
  const push = pushCard((status) => { if (status === 'enabled') setTimeout(() => push.remove(), 2500); });
  import('../push-client.js').then(async ({ pushStatus }) => { if ((await pushStatus()) === 'enabled') push.remove(); }).catch(() => {});
  main.append(...[h('h1', 'Journées de chasse'),
    profileMissing ? h('a.current-hunt', { href: '#/profil' }, h('strong', '👤 Complétez votre profil'), h('span', 'Marche et voiture →')) : null,
    canManage ? formBox : null, listBox, push].filter(Boolean));

  async function loadList() {
    const { days } = await api.get('/days');
    const upcoming = days.filter((x) => OPEN.includes(x.status)).reverse();
    const past = days.filter((x) => !OPEN.includes(x.status));
    // Une ligne par journée : date courte, état, l'essentiel du moment.
    const item = (x) => {
      const b = x.current_battue;
      let extra = '';
      if (x.status === 'en_cours' && b) extra = `battue ${b.number} ${b.status === 'terminee' ? 'terminée' : b.started_at ? 'en cours' : 'en préparation'}`;
      else if (canManage && x.status === 'convoquee') extra = `${x.answered_present}/${x.convoked} présents${x.lunch_offered ? ` · 🍽 ${x.lunch_count}` : ''}`;
      else if (!canManage && x.status === 'convoquee') extra = x.my_response ? (x.my_response === 'present' ? '✔ présent' : '✘ absent') : 'réponse attendue';
      else if (x.status === 'terminee' && x.battue_count) extra = `${x.battue_count} battue(s)`;
      return h('a.day-row', { href: `#/journees/${x.id}` },
        h('span.day-date', new Date(`${x.date}T12:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })),
        h('span.status', { class: `status-${x.status}` }, DAY_STATUS_LABELS[x.status]),
        extra ? h('span.small.muted', extra) : null);
    };
    const done = past.filter((x) => x.status === 'terminee');
    const cancelled = past.filter((x) => x.status === 'annulee');
    fill(listBox,
      upcoming.length ? h('div.day-list', upcoming.map(item)) : h('p.muted', canManage ? 'Aucune journée prévue.' : 'Aucune journée à laquelle vous êtes convoqué.'),
      done.length ? fold('Passées', { key: 'days.past', extra: String(done.length) }, h('div.day-list', done.slice(0, 30).map(item))) : null,
      cancelled.length && canManage ? fold('Annulées', { key: 'days.cancelled', extra: String(cancelled.length) }, h('div.day-list', cancelled.slice(0, 30).map(item))) : null);
  }

  async function renderForm() {
    const [{ members }, defaults, places] = await Promise.all([api.get('/members'), api.get('/days/defaults'), api.get('/places')]);
    let meetingPoint = defaults.meeting_point;
    const placeInput = h('input', { name: 'meeting_place', maxlength: 200, value: defaults.meeting_place ?? '', placeholder: 'ex. cabane de chasse' });
    const nextSaturday = (() => {
      const d = new Date();
      d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const checks = members.map((m) => ({ m, input: h('input', { type: 'checkbox', checked: true, value: m.id }) }));
    const lunch = h('input', { type: 'checkbox', name: 'lunch_offered', checked: defaults.lunch_offered });
    const lunchInfo = h('input', { name: 'lunch_info', maxlength: 300, value: defaults.lunch_info ?? '', placeholder: 'ex. salle des fêtes, 15 €' });
    const form = h('form.card', {
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          const res = await api.post('/days', {
            date: fd.get('date'),
            meeting_time: fd.get('meeting_time'),
            meeting_place: fd.get('meeting_place'),
            meeting_point: meetingPoint ?? null,
            briefing: fd.get('briefing'),
            lunch_offered: lunch.checked,
            lunch_info: lunchInfo.value,
            participant_user_ids: checks.filter((c) => c.input.checked).map((c) => c.m.id),
          });
          location.hash = `#/journees/${res.day.id}`;
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      },
    },
    h('div.row',
      h('label', 'Date', h('input', { type: 'date', name: 'date', value: nextSaturday, required: true })),
      h('label', 'Rendez-vous', h('input', { type: 'time', name: 'meeting_time', value: defaults.meeting_time, required: true }))),
    h('label', 'Lieu du rendez-vous', placeSelect(places, {
      current: defaults.meeting_place,
      other: 'Autre (texte libre)',
      onpick: (c) => {
        if (c && c !== 'other') { placeInput.value = c.name; meetingPoint = c.point; }
        else if (c === 'other') { meetingPoint = null; placeInput.focus(); }
      },
    })),
    h('label', 'Lieu (texte)', placeInput),
    h('label.check', lunch, 'Déjeuner proposé (inscription facultative)'),
    h('label', 'Déjeuner : lieu, prix…', lunchInfo),
    h('label', 'Consignes de la journée', h('textarea', { name: 'briefing', rows: 2, maxlength: 5000 })),
    h('fieldset.members', h('legend', 'Membres convoqués'), checks.map(({ m, input }) => h('label.check', input, m.display_name || m.email || 'Membre'))),
    h('button.primary', { type: 'submit' }, 'Créer la journée (brouillon)'));
    fill(formBox, h('details', h('summary.button-like', '+ Nouvelle journée'), form));
  }

  try {
    await Promise.all([loadList(), canManage ? renderForm() : null]);
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
  }
  // Statuts et réponses à jour sans recharger la page.
  return every(30_000, () => loadList().catch(() => {}));
}
