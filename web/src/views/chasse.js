// « Ma chasse » : l'écran simple du chasseur, en deux onglets.
// - Journée : la vue chasseur de la journée en cours (ou de la prochaine
//   convocation) — poste, itinéraire, consignes, alertes.
// - Infos chasse : la page d'informations de l'association (dates
//   d'ouverture, espèces, règles), sinon les espèces et quotas de la saison.
// Par défaut : Journée si une journée de chasse est démarrée, Infos sinon.
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, errorMessage } from '../ui.js';
import { localToday } from '../lib/live.js';
import { formatHuntDate } from '../lib/hunts.js';
import { memberDayView } from './day-sheet.js';
import { pickDay } from '../lib/pick-day.js';

export async function chasseView(main, tab = null) {
  let days = [];
  try {
    days = (await api.get('/days')).days;
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
    return null;
  }
  const day = pickDay(days, localToday());
  const running = day?.status === 'en_cours';
  const current = tab ?? (running ? 'journee' : 'infos');

  const seg = (key, label, extra = null) => h('a.seg', { href: `#/chasse/${key}`, class: key === current ? 'active' : '', 'aria-current': key === current ? 'page' : null }, label, extra);
  const switcher = h('nav.seg-switch', { 'aria-label': 'Ma chasse' },
    seg('journee', '🎯 Journée', running ? h('span.live-dot', { title: 'Journée de chasse démarrée' }) : null),
    seg('infos', '📅 Infos chasse'));
  const body = h('div.chasse-body');
  main.append(h('div.chasse', switcher, body));

  if (current === 'infos') {
    await infosTab(body);
    return null;
  }
  if (!day) {
    fill(body, h('div.card',
      h('p', 'Aucune journée de chasse en cours ni prévue pour vous.'),
      h('p.small.muted', 'Vous recevrez une notification à la prochaine convocation.'),
      h('a', { href: '#/journees' }, 'Toutes les journées →')));
    return null;
  }
  if (!running) body.append(h('p.small.muted.chasse-next', `Prochaine journée : ${formatHuntDate(day.date)}`));
  const view = h('div.chasse-day');
  body.append(view);
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
