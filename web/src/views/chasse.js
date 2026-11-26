// « Ma chasse » : l'écran simple, en onglets.
// - En cours : la vue chasseur de la journée en cours (ou de la prochaine
//   convocation) — poste, itinéraire, consignes, alertes.
// - Gestion (président, responsables) : la console de cette journée.
// - Infos : dates d'ouverture, espèces, règles de l'association.
// Par défaut : la journée démarrée (Gestion pour le président), Infos sinon.
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, errorMessage } from '../ui.js';
import { localToday } from '../lib/live.js';
import { formatHuntDate } from '../lib/hunts.js';
import { memberDayView } from './day-sheet.js';
import { pickDay } from '../lib/pick-day.js';

const MANAGERS = ['president', 'responsable'];

export async function chasseView(main, tab = null) {
  const manager = MANAGERS.includes(state.role);
  let days = [];
  try {
    days = (await api.get('/days')).days;
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
    return null;
  }
  const day = pickDay(days, localToday(), { manager });
  const running = day?.status === 'en_cours';
  if (tab === 'journee') tab = 'encours'; // ancienne adresse
  if (tab === 'gestion' && !manager) tab = null;
  // Par défaut : la journée démarrée (Gestion pour le président), sinon les infos.
  const current = tab ?? (running ? (manager ? 'gestion' : 'encours') : 'infos');

  const seg = (key, label, extra = null) => h('a.seg', { href: `#/chasse/${key}`, class: key === current ? 'active' : '', 'aria-current': key === current ? 'page' : null }, label, extra);
  const dot = running ? h('span.live-dot', { title: 'Journée de chasse démarrée' }) : null;
  const switcher = h('nav.seg-switch', { 'aria-label': 'Ma chasse' },
    seg('encours', '🎯 En cours', dot),
    manager ? seg('gestion', '⚙ Gestion') : null,
    seg('infos', '📅 Infos'));
  const body = h('div.chasse-body');
  main.append(h('div.chasse', switcher, body));

  if (current === 'infos') {
    await infosTab(body);
    return null;
  }
  if (!day) {
    fill(body, h('div.card',
      h('p', manager ? 'Aucune journée de chasse en cours ni prévue.' : 'Aucune journée de chasse en cours ni prévue pour vous.'),
      manager ? null : h('p.small.muted', 'Vous recevrez une notification à la prochaine convocation.'),
      h('a', { href: '#/journees' }, manager ? 'Journées : en créer une →' : 'Toutes les journées →')));
    return null;
  }
  if (!running) body.append(h('p.small.muted.chasse-next', `Prochaine journée : ${formatHuntDate(day.date)}`));
  const view = h(`div.hunt-body.${current === 'gestion' ? 'gestion' : 'chasseur'}`);
  body.append(view);
  if (current === 'gestion') {
    const { dayConsole } = await import('./day.js');
    return dayConsole(view, day.id);
  }
  return memberDayView(view, day.id);
}

async function infosTab(body) {
  const url = state.tenant?.info_url;
  if (url) {
    fill(body,
      h('iframe.info-frame', {
        src: url, title: 'Informations de chasse de l’association', loading: 'lazy',
        // Page tierce : scripts et stockage local autorisés, pas d'accès à l'application.
        sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
        referrerpolicy: 'no-referrer',
      }),
      h('p.small.muted.info-open', h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Ouvrir dans un nouvel onglet ↗')));
    return;
  }
  // Sans page : espèces et quotas de la saison en cours.
  try {
    const { current, species } = await api.get('/seasons');
    fill(body, h('section.card',
      h('h2', current ? `Saison ${current.name}` : 'Saison'),
      current ? h('p.small.muted', `Du ${formatHuntDate(current.starts_on)} au ${formatHuntDate(current.ends_on)}`) : null,
      species.length
        ? h('table.species-table', h('thead', h('tr', h('th', 'Espèce'), h('th', 'Saison'), h('th', 'Par battue'))),
            h('tbody', species.map((s) => h('tr', h('td', s.species),
              h('td', s.season_quota == null ? '—' : `${s.harvested ?? 0} / ${s.season_quota}`),
              h('td', s.battue_quota == null ? '—' : String(s.battue_quota))))))
        : h('p.muted', 'Aucune espèce renseignée pour cette saison.'),
      state.role === 'president' ? h('p.small.muted', 'Astuce : ajoutez l’adresse de votre page d’informations (dates, espèces, règles) dans Paramètres → Association.') : null));
  } catch (err) {
    fill(body, h('p.error', errorMessage(err)));
  }
}
