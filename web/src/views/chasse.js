// « Ma chasse » : l'écran simple, en onglets.
// - En cours : la vue chasseur de la journée en cours (ou de la prochaine
//   convocation) — poste, itinéraire, consignes, alertes.
// - Gestion (président, responsables) : la console de cette journée.
// - Infos : dates d'ouverture, espèces, règles de l'association.
// Par défaut : la journée démarrée (Gestion pour le président), Infos sinon.
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, errorMessage, toast } from '../ui.js';
import { localToday } from '../lib/live.js';
import { formatHuntDate } from '../lib/hunts.js';
import { memberDayView } from './day-sheet.js';
import { pickDay } from '../lib/pick-day.js';

const MANAGERS = ['president', 'responsable'];

export async function chasseView(main, tab = null, dayId = null) {
  const manager = MANAGERS.includes(state.role);
  let days = [];
  try {
    days = (await api.get('/days')).days;
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
    return null;
  }
  // Journée choisie (lien « Gérer dans Ma chasse »), sinon celle du moment.
  const day = (dayId && days.find((d) => d.id === dayId)) || pickDay(days, localToday(), { manager });
  const running = day?.status === 'en_cours';
  if (tab === 'journee') tab = 'encours'; // ancienne adresse
  if (tab === 'gestion' && !manager) tab = null;
  // Par défaut : la journée démarrée (Gestion pour le président), sinon les infos.
  const current = tab ?? (running ? (manager ? 'gestion' : 'encours') : 'infos');

  const seg = (key, label, extra = null) => h('a.seg', { href: `#/chasse/${key}${dayId && key !== 'infos' ? `/${dayId}` : ''}`, class: key === current ? 'active' : '', 'aria-current': key === current ? 'page' : null }, label, extra);
  const dot = running ? h('span.live-dot', { title: 'Journée de chasse démarrée' }) : null;
  const switcher = h('nav.seg-switch', { 'aria-label': 'Ma chasse' },
    seg('encours', '🎯 En cours', dot),
    manager ? seg('gestion', '⚙ Gestion') : null,
    seg('infos', '📅 Infos'));
  const body = h('div.chasse-body');
  main.append(h('div.chasse', switcher, body));

  if (current === 'infos') return (await infosTab(body)) ?? null;
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
  // Infos de la saison (données de l'association) : vue complète dans l'application.
  let season = null;
  try {
    const res = await api.get('/seasons/current/regulations');
    season = res.season;
    if (res.regulations) return showInfos(body, res.regulations);
  } catch { /* solutions de repli ci-dessous */ }
  const url = state.tenant?.info_url;
  const president = state.role === 'president';
  // Président : chargement en un clic des infos complètes (espèces, périodes, battues, sécurité, règles).
  const loadCard = president && season ? h('section.card.infos-empty',
    h('h2', 'Infos de la saison à charger'),
    h('p', 'Toutes les informations de la page de l’ACCA de Fontcouverte (espèces de petit et de grand gibier, périodes d’ouverture, jours et horaires, limites, calendrier des battues, sécurité, règles) seront reprises ici pour tous les membres, et modifiables dans Paramètres → Infos de la saison.'),
    h('button.primary', { onclick: async (e) => {
      e.target.disabled = true;
      try {
        const model = (await import('../data/fontcouverte-2026-2027.json')).default;
        const { regulations } = await api.put(`/seasons/${season.id}/regulations`, { regulations: model });
        toast('Infos chargées pour tous les membres.');
        body.replaceChildren();
        showInfos(body, regulations);
      } catch (err) {
        e.target.disabled = false;
        toast(errorMessage(err), 'error');
      }
    } }, 'Charger les infos de l’ACCA de Fontcouverte 2026-2027')) : null;
  if (url) {
    fill(body, loadCard,
      h('iframe.info-frame', {
        src: url, title: 'Informations de chasse de l’association', loading: 'lazy',
        // Page tierce : scripts et stockage local autorisés, pas d'accès à l'application.
        sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
        referrerpolicy: 'no-referrer',
      }),
      h('p.small.muted.info-open', h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Ouvrir dans un nouvel onglet ↗')));
    return null;
  }
  // Sans infos ni page : espèces et quotas de la saison en cours.
  try {
    const { current, species } = await api.get('/seasons');
    fill(body, loadCard, h('section.card',
      h('h2', current ? `Saison ${current.name}` : 'Saison'),
      president ? null : h('p.small.muted', 'Le président n’a pas encore renseigné les infos de la saison.'),
      current ? h('p.small.muted', `Du ${formatHuntDate(current.starts_on)} au ${formatHuntDate(current.ends_on)}`) : null,
      species.length
        ? h('table.species-table', h('thead', h('tr', h('th', 'Espèce'), h('th', 'Saison'), h('th', 'Par battue'))),
            h('tbody', species.map((s) => h('tr', h('td', s.species),
              h('td', s.season_quota == null ? '—' : `${s.harvested ?? 0} / ${s.season_quota}`),
              h('td', s.battue_quota == null ? '—' : String(s.battue_quota))))))
        : h('p.muted', 'Aucune espèce renseignée pour cette saison.')));
  } catch (err) {
    fill(body, h('p.error', errorMessage(err)));
  }
  return null;
}

async function showInfos(body, regulations) {
  body.classList.add('scroll');
  const { renderInfos } = await import('./infos.js');
  return renderInfos(body, regulations);
}
