// Liste des battues et création (président, responsable de battue).
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage } from '../ui.js';
import { STATUS_LABELS, formatHuntDate, formatTime } from '../lib/hunts.js';

const MANAGERS = ['president', 'responsable'];

export async function huntsView(main) {
  const canManage = MANAGERS.includes(state.role);
  const listBox = h('div');
  const formBox = h('div');
  main.append(h('h1', 'Battues'), canManage ? formBox : null, listBox);

  async function loadList() {
    const { hunts } = await api.get('/hunts');
    const upcoming = hunts.filter((x) => ['brouillon', 'publiee', 'en_cours'].includes(x.status)).reverse();
    const past = hunts.filter((x) => !['brouillon', 'publiee', 'en_cours'].includes(x.status));
    const item = (x) =>
      h(
        'a.tile.hunt-tile',
        { href: `#/battues/${x.id}` },
        h('strong', `${formatHuntDate(x.date)} · ${x.territory_name}`),
        h('span', `RDV ${formatTime(x.meeting_time)}${x.meeting_place ? ` · ${x.meeting_place}` : ''}`),
        h('span.status', { class: `status-${x.status}` }, STATUS_LABELS[x.status],
          canManage && x.status !== 'brouillon' ? ` · ${x.answered_present}/${x.convoked} présent(s) annoncé(s)` : '',
          !canManage && x.status === 'publiee' ? (x.my_response ? ` · vous avez répondu ${x.my_response === 'present' ? 'présent' : 'absent'}` : ' · réponse attendue') : ''),
      );
    fill(
      listBox,
      upcoming.length ? [h('h2', 'À venir'), h('nav.tiles', upcoming.map(item))] : h('p.muted', canManage ? 'Aucune battue prévue.' : 'Aucune battue à laquelle vous êtes convoqué.'),
      past.length ? [h('h2', 'Passées'), h('nav.tiles', past.slice(0, 20).map(item))] : null,
    );
  }

  async function renderForm() {
    const [{ territories }, { members }] = await Promise.all([api.get('/territories'), api.get('/members')]);
    if (!territories.length) {
      fill(formBox, h('p.muted', 'Créez d’abord un territoire dans la cartographie.'));
      return;
    }
    const nextSaturday = (() => {
      const d = new Date();
      d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const checks = members.map((m) => ({ m, input: h('input', { type: 'checkbox', checked: true, value: m.id }) }));
    const form = h(
      'form.card',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          try {
            const res = await api.post('/hunts', {
              territory_id: fd.get('territory_id'),
              date: fd.get('date'),
              meeting_time: fd.get('meeting_time'),
              meeting_place: fd.get('meeting_place'),
              briefing: fd.get('briefing'),
              participant_user_ids: checks.filter((c) => c.input.checked).map((c) => c.m.id),
            });
            location.hash = `#/battues/${res.hunt.id}`;
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        },
      },
      h('div.row',
        h('label', 'Territoire', h('select', { name: 'territory_id' }, territories.map((t) => h('option', { value: t.id }, t.name)))),
        h('label', 'Date', h('input', { type: 'date', name: 'date', value: nextSaturday, required: true })),
        h('label', 'Rendez-vous', h('input', { type: 'time', name: 'meeting_time', value: '07:45', required: true })),
      ),
      h('label', 'Lieu de rendez-vous', h('input', { name: 'meeting_place', maxlength: 200, placeholder: 'ex. cabane de chasse' })),
      h('label', 'Consignes (espèces chassables, sécurité)', h('textarea', { name: 'briefing', rows: 3, maxlength: 5000 })),
      h('fieldset.members',
        h('legend', 'Membres convoqués'),
        checks.map(({ m, input }) => h('label.check', input, m.display_name || m.email || 'Membre')),
      ),
      h('button.primary', { type: 'submit' }, 'Créer la battue (brouillon)'),
    );
    fill(formBox, h('details', h('summary.button-like', '+ Nouvelle battue'), form));
  }

  try {
    await Promise.all([loadList(), canManage ? renderForm() : null]);
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
  }
}
