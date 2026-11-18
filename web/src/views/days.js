// Journées de chasse : liste et création (président, responsable de battue).
// L'heure, le lieu du rendez-vous et le déjeuner sont repris de la dernière
// journée : ils changent rarement d'une fois à l'autre.
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage } from '../ui.js';
import { DAY_STATUS_LABELS, formatHuntDate, formatTime } from '../lib/hunts.js';
import { every } from '../lib/live.js';

const MANAGERS = ['president', 'responsable'];
const OPEN = ['brouillon', 'convoquee', 'en_cours'];

export async function daysView(main) {
  const canManage = MANAGERS.includes(state.role);
  const listBox = h('div');
  const formBox = h('div');
  main.append(...[h('h1', 'Journées de chasse'), canManage ? formBox : null, listBox].filter(Boolean));

  async function loadList() {
    const { days } = await api.get('/days');
    const upcoming = days.filter((x) => OPEN.includes(x.status)).reverse();
    const past = days.filter((x) => !OPEN.includes(x.status));
    const item = (x) => {
      const b = x.current_battue;
      const extra = [];
      if (x.status === 'en_cours' && b) extra.push(` · battue n° ${b.number}${b.status === 'terminee' ? ' terminée' : b.started_at ? ' en cours' : ' en préparation'}`);
      if (canManage && x.status === 'convoquee') extra.push(` · ${x.answered_present}/${x.convoked} présent(s) annoncé(s)${x.lunch_offered ? ` · 🍽 ${x.lunch_count}` : ''}`);
      if (canManage && x.status === 'en_cours') extra.push(` · ${x.present_count} présent(s)`);
      if (!canManage && x.status === 'convoquee') extra.push(x.my_response ? ` · vous avez répondu ${x.my_response === 'present' ? `présent${x.my_lunch ? ' (déjeuner)' : ''}` : 'absent'}` : ' · réponse attendue');
      if (['terminee'].includes(x.status) && x.battue_count) extra.push(` · ${x.battue_count} battue(s)`);
      return h('a.tile.hunt-tile', { href: `#/journees/${x.id}` },
        h('strong', formatHuntDate(x.date)),
        h('span', `RDV ${formatTime(x.meeting_time)}${x.meeting_place ? ` · ${x.meeting_place}` : ''}`),
        h('span.status', { class: `status-${x.status}` }, DAY_STATUS_LABELS[x.status], ...extra));
    };
    fill(listBox,
      upcoming.length ? [h('h2', 'À venir'), h('nav.tiles', upcoming.map(item))] : h('p.muted', canManage ? 'Aucune journée prévue.' : 'Aucune journée à laquelle vous êtes convoqué.'),
      past.length ? [h('h2', 'Passées'), h('nav.tiles', past.slice(0, 20).map(item))] : null);
  }

  async function renderForm() {
    const [{ members }, defaults] = await Promise.all([api.get('/members'), api.get('/days/defaults')]);
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
    h('label', 'Lieu du rendez-vous', h('input', { name: 'meeting_place', maxlength: 200, value: defaults.meeting_place ?? '', placeholder: 'ex. cabane de chasse' })),
    defaults.meeting_point ? h('p.small.muted', 'Le point de rendez-vous sur la carte est repris de la dernière journée.') : null,
    h('label.check', lunch, 'Déjeuner proposé (inscription facultative)'),
    h('label', 'Déjeuner : lieu, prix…', lunchInfo),
    h('label', 'Consignes de la journée', h('textarea', { name: 'briefing', rows: 2, maxlength: 5000 })),
    h('fieldset.members', h('legend', 'Membres convoqués'), checks.map(({ m, input }) => h('label.check', input, m.display_name || m.email || 'Membre'))),
    h('p.small.muted', 'Les territoires, postes et espèces se choisissent le jour même, battue par battue.'),
    h('button.primary', { type: 'submit' }, 'Créer la journée (brouillon)'));
    fill(formBox, h('details', h('summary.button-like', '+ Nouvelle journée de chasse'), form));
  }

  try {
    await Promise.all([loadList(), canManage ? renderForm() : null]);
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
  }
  // Statuts et réponses à jour sans recharger la page.
  return every(30_000, () => loadList().catch(() => {}));
}
