// Journées de chasse : liste et création (président, organisateur).
// L'heure, le lieu du rendez-vous et le déjeuner sont repris de la dernière
// journée : ils changent rarement d'une fois à l'autre.
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, fold } from '../ui.js';
import { DAY_STATUS_LABELS, formatHuntDate, formatTime } from '../lib/hunts.js';
import { every } from '../lib/live.js';
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

  /**
   * Nouvelle journée : brouillon créé d'office (samedi prochain, rendez-vous et
   * déjeuner repris de la dernière journée, tous les membres convoqués), puis
   * réglé sur sa page avant l'envoi des convocations.
   */
  async function createDay() {
    try {
      const [{ members }, defaults] = await Promise.all([api.get('/members'), api.get('/days/defaults')]);
      const d = new Date();
      d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const res = await api.post('/days', {
        date,
        meeting_time: defaults.meeting_time,
        meeting_place: defaults.meeting_place ?? '',
        meeting_point: defaults.meeting_point ?? null,
        lunch_offered: !!defaults.lunch_offered,
        lunch_info: defaults.lunch_info ?? '',
        participant_user_ids: members.map((m) => m.id),
      });
      location.hash = `#/journees/${res.day.id}`;
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
  if (canManage) fill(formBox, h('button.primary-outline', { onclick: createDay }, '+ Nouvelle journée'));

  try {
    await loadList();
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
  }
  // Statuts et réponses à jour sans recharger la page.
  return every(30_000, () => loadList().catch(() => {}));
}
