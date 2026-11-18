// Vue chasseur d'une journée de chasse : elle suit la journée phase par phase.
//  - avant : répondre (et le déjeuner), rendez-vous et itinéraire ;
//  - jour J : attente, battue en préparation, « rejoignez votre poste »
//    (voiture jusqu'au parking avec covoiturage, puis guidage à pied, « Je
//    suis en place »), traque (écran réduit : statut, prélèvements, fin
//    annoncée), fin, regroupement (itinéraire voiture et à pied) ;
//  - après : résumé.
// Pour tous : chasseurs, responsables, président, invités. Mise à jour automatique.
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon, parkingIcon } from '../map/shapes.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage } from '../ui.js';
import { watchRevision, every } from '../lib/live.js';
import {
  DAY_STATUS_LABELS, ROLE_LABELS, CATEGORY_LABELS, COMMON_SPECIES, NAV_APPS,
  formatHuntDate, formatTime, navigationLinks, dayPhase,
} from '../lib/hunts.js';
import { positionPanel } from './positions.js';

// Appli de navigation choisie une fois, mémorisée sur ce téléphone.
const NAV_KEY = 'chassestu.navApp';
function preferredNavApp() {
  try {
    const v = localStorage.getItem(NAV_KEY);
    if (v && NAV_APPS[v]) return v;
  } catch {
    /* stockage indisponible */
  }
  return /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? 'apple' : 'google';
}

/** « Y aller en voiture » vers l'appli choisie, avec choix modifiable. */
function navButtons(label, coords) {
  const links = navigationLinks(coords);
  const go = h('a.button.primary', { target: '_blank', rel: 'noopener' });
  const select = h('select', {
    'aria-label': 'Application de navigation',
    onchange: () => {
      try {
        localStorage.setItem(NAV_KEY, select.value);
      } catch {
        /* rien */
      }
      sync();
    },
  }, Object.entries(NAV_APPS).map(([k, v]) => h('option', { value: k }, v)));
  function sync() {
    go.href = links[select.value];
    go.textContent = `🚗 Y aller en voiture (${NAV_APPS[select.value]})`;
  }
  select.value = preferredNavApp();
  sync();
  return h('div.nav-links', h('span', label), go, select);
}

const time = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Ma voiture dans le plan de covoiturage. */
function carpoolCard(carpool, myParticipantId) {
  if (!carpool || !myParticipantId) return null;
  const asDriver = carpool.cars.find((c) => c.driver.id === myParticipantId);
  const asPassenger = carpool.cars.find((c) => c.passengers.some((p) => p.id === myParticipantId));
  const unseated = carpool.unseated.some((p) => p.id === myParticipantId);
  let body;
  if (asDriver) {
    body = asDriver.passengers.length
      ? [h('p', h('strong', 'Vous conduisez'), ` jusqu’au ${asDriver.destinationName}, avec :`),
         h('ul.plain', asDriver.passengers.map((p) => h('li', `${p.name}${p.detour ? ` (à déposer au ${p.destinationName})` : ''}`)))]
      : h('p', 'Vous prenez votre voiture, sans passager.');
  } else if (asPassenger) {
    const me = asPassenger.passengers.find((p) => p.id === myParticipantId);
    body = h('p', h('strong', `Vous montez avec ${asPassenger.driver.name}`),
      ` (sa voiture va au ${asPassenger.destinationName}${me.detour ? ` ; il vous dépose au ${me.destinationName}` : ''}).`);
  } else if (unseated) {
    body = h('p.alert.warn', 'Pas de place trouvée dans une voiture : voyez l’organisateur.');
  } else {
    return null;
  }
  return h('section.card.carpool', h('h3', '🚗 Covoiturage'), body);
}

/**
 * Crée la vue ; `update(view, carpool)` la remet à jour sans recréer la carte.
 * @param {{ dayId?: string, guestToken?: string, canSeeAll?: boolean,
 *   onRespond?: Function, onDeclare?: Function, onWithdraw?: Function, onChanged?: Function }} opts
 */
export function createDaySheet(container, opts = {}) {
  ensureHatchPattern();
  // Haut : ce qu'il faut faire maintenant ; puis la carte ; puis les blocs
  // repliables (ligne de postes, consignes, battues de la journée).
  const info = h('div.sheet-info');
  const mapEl = h('div.sheet-map');
  const more = h('div.sheet-more');
  fill(container, info, mapEl, more);
  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  addBasemaps(map);
  const layers = L.featureGroup().addTo(map);
  const panel = positionPanel(map, { dayId: opts.dayId, guestToken: opts.guestToken, canSeeAll: opts.canSeeAll, onChanged: opts.onChanged });
  let fittedFor = null;
  let lunchWanted = null;

  function respondBox(view) {
    const { day, me } = view;
    if (!opts.onRespond || !me || me.guest || day.status !== 'convoquee') return null;
    if (lunchWanted === null) lunchWanted = me.lunch;
    const lunch = day.lunch_offered
      ? h('label.check', h('input', { type: 'checkbox', checked: lunchWanted, onchange: (e) => {
          lunchWanted = e.target.checked;
          if (me.response === 'present') opts.onRespond('present', lunchWanted);
        } }), `Je reste au déjeuner${day.lunch_info ? ` (${day.lunch_info})` : ''}`)
      : null;
    return h('div',
      h('div.buttons',
        h('button', { class: me.response === 'present' ? 'primary' : '', onclick: () => opts.onRespond('present', lunchWanted) }, 'Présent'),
        h('button', { class: me.response === 'absent' ? 'primary' : '', onclick: () => opts.onRespond('absent', false) }, 'Absent')),
      lunch);
  }

  function rdvCard(day) {
    return h('section.card',
      h('h3', 'Rendez-vous'),
      h('p', `${formatHuntDate(day.date)} à ${formatTime(day.meeting_time)}${day.meeting_place ? ` · ${day.meeting_place}` : ''}`),
      day.meeting_point ? navButtons('Rendez-vous :', day.meeting_point.coordinates) : null,
      day.lunch_offered ? h('p.small', `🍽 Déjeuner proposé${day.lunch_info ? ` : ${day.lunch_info}` : ''}.`) : null);
  }

  function speciesList(cur) {
    if (!cur?.species?.length) return null;
    return h('ul.plain.species', cur.species.map((s) => {
        const full = s.quota !== null && s.taken >= s.quota;
        return h('li', { class: full ? 'full' : '' },
          h('strong', s.s),
          h('span', s.quota === null ? `${s.taken} prélevé(s)` : `${s.taken} / ${s.quota}`),
          s.quota !== null ? h('progress', { max: Math.max(s.quota, 1), value: Math.min(s.taken, s.quota) }) : null,
          full ? h('span.badge.danger', 'quota atteint : ne plus tirer') : null);
      }));
  }

  function speciesBox(cur) {
    const list = speciesList(cur);
    return list ? h('section.card', h('h3', 'Espèces tirables'), list) : null;
  }

  function harvestBox(cur, canDeclare) {
    if (!cur || (!cur.harvests?.length && !canDeclare)) return null;
    // Seulement les espèces autorisées par l'organisateur (liste usuelle s'il n'en a fixé aucune).
    const allowed = (cur.species ?? []).map((s) => s.s);
    const species = h('select', { 'aria-label': 'Espèce' }, (allowed.length ? allowed : COMMON_SPECIES).map((s) => h('option', { value: s }, s)));
    const category = h('select', { 'aria-label': 'Catégorie' }, Object.entries(CATEGORY_LABELS).map(([v, l]) => h('option', { value: v, selected: v === 'indetermine' }, l)));
    return h('section.card',
      h('h3', `Animaux tués (${cur.harvests.length})`),
      canDeclare ? speciesList(cur) : null,
      cur.harvests.length
        ? h('ul.plain.harvests', cur.harvests.map((x) => h('li',
            h('span', h('strong', x.species), ` ${CATEGORY_LABELS[x.category]}`, x.shooter ? ` — ${x.shooter}${x.post_number ? ` (poste ${x.post_number})` : ''}` : '', x.notes ? ` · ${x.notes}` : ''),
            h('span.small.muted', time(x.at)),
            x.mine && canDeclare && opts.onWithdraw ? h('button.link.danger', { onclick: () => opts.onWithdraw(cur.hunt.id, x) }, 'Retirer') : null)))
        : null,
      canDeclare
        ? h('form.row.declare', {
            onsubmit: (e) => {
              e.preventDefault();
              opts.onDeclare(cur.hunt.id, { species: species.value, category: category.value });
            },
          }, species, category, h('button.primary', { type: 'submit' }, 'Déclarer un animal tué'))
        : null);
  }

  function postCard(cur) {
    const post = cur?.post;
    if (!post) return null;
    return h('section.card.my-post',
      h('h2', `Votre poste : ${post.number}${post.name ? ` · ${post.name}` : ''}`),
      post.shared_with?.length ? h('p', `Poste partagé avec ${post.shared_with.join(', ')}.`) : null,
      post.instructions ? h('p.alert.warn', post.instructions) : null,
      post.parking ? navButtons(`Parking « ${post.parking.name} »`, post.parking.geom.coordinates) : null,
      post.access_path ? h('p.small', `Puis ${post.access_path_length_m} m à pied (pointillés).`) : null);
  }

  function neighborsCard(cur, compact) {
    if (!cur?.neighbors?.length) return null;
    const me = cur.me;
    const items = cur.neighbors.map((n) => `${n.side === 'gauche' ? '◀ ' : n.side === 'droite' ? '▶ ' : ''}Poste ${n.number}${n.name && !compact ? ` · ${n.name}` : ''} : ${n.occupant ?? 'libre'}`);
    return h('details.card',
      h('summary', me && !cur.show_all_posts ? 'Vos voisins' : 'Ligne de postes'),
      compact ? h('p', items.join(' · ')) : h('ul.plain', items.map((t) => h('li', t))),
      me ? h('p.small.muted', 'Ne tirez jamais vers vos voisins.') : null);
  }

  function briefing(view) {
    const text = [view.day.briefing, view.current?.hunt?.briefing].filter(Boolean).join('\n\n');
    if (!text) return null;
    return h('details.card', h('summary', 'Consignes'), h('p.pre', text));
  }

  function battuesSummary(view) {
    if (!view.battues?.length) return null;
    return h('details.card',
      h('summary', `Battues de la journée (${view.battues.length})`),
      h('ul.plain', view.battues.map((b) => h('li',
        `N° ${b.number} · ${b.territory_name} · ${b.status === 'terminee' ? `terminée${b.ended_at ? ` à ${time(b.ended_at)}` : ''}` : b.started_at ? 'traque en cours' : 'en préparation'}`,
        view.me && !b.selected ? h('span.small.muted', ' (sans vous)') : null))));
  }

  function renderInfo(view, carpool, step) {
    const { day, me } = view;
    const cur = view.current;
    const phase = step.phase;
    const placed = !!cur?.me?.in_place;
    let top = [];
    switch (phase) {
      case 'reponse': case 'rdv': case 'absent': case 'convoque':
        top = [rdvCard(day)];
        break;
      case 'non_present': case 'attente_battue':
        top = [rdvCard(day), panel.el];
        break;
      case 'non_volontaire':
        top = [panel.el];
        break;
      case 'preparation':
        top = [postCard(cur), speciesBox(cur), panel.el];
        break;
      case 'rejoindre':
        // Une fois en place, parking, chemin et covoiturage ne servent plus.
        top = placed
          ? [panel.el, speciesBox(cur)]
          : [postCard(cur), carpoolCard(carpool, cur?.me?.participant_id), panel.el, speciesBox(cur)];
        break;
      case 'traque':
        // Pendant la traque : déclarer un animal tué, sa place, la fin annoncée.
        top = [harvestBox(cur, !!me && !!cur?.me && !me.guest && !!opts.onDeclare), panel.el];
        break;
      case 'fin':
        top = [harvestBox(cur, false), panel.el];
        break;
      case 'regroupement':
        top = [day.regroup?.point ? navButtons(`Regroupement${day.regroup.place ? ` : ${day.regroup.place}` : ''}`, day.regroup.point.coordinates) : null, panel.el];
        break;
      default:
        top = [];
    }
    const lastBattue = view.battues?.[view.battues.length - 1];
    fill(
      info,
      me?.guest ? h('p.notice', `Bonjour ${me.name} (accès invité pour la journée).`) : null,
      h('section.status-banner', { class: `tone-${step.tone}` }, h('strong', step.title), step.text ? h('span', step.text) : null, respondBox(view)),
      h('p.small.day-line', h('span.status', { class: `status-${day.status}` }, DAY_STATUS_LABELS[day.status]),
        ` ${formatHuntDate(day.date)}`,
        lastBattue && day.status === 'en_cours' ? ` · battue n° ${lastBattue.number} (${lastBattue.territory_name})` : '',
        cur?.me ? ` · ${ROLE_LABELS[cur.me.role].toLowerCase()}` : ''),
      top,
    );
    fill(
      more,
      ['rejoindre', 'traque', 'preparation'].includes(phase) ? neighborsCard(cur, phase === 'traque') : null,
      briefing(view),
      day.status === 'en_cours' || day.status === 'terminee' ? battuesSummary(view) : null,
      h('p.small.muted.live', `Mis à jour à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`),
    );
  }

  function renderMap(view, step) {
    const cur = view.current;
    const { day } = view;
    layers.clearLayers();
    let tLayer = null;
    if (cur) {
      tLayer = L.geoJSON(cur.territory.geom, { style: { color: '#1f5130', weight: 3, fillOpacity: 0.04 }, interactive: false });
      layers.addLayer(tLayer);
      if (cur.exclusion) layers.addLayer(L.geoJSON(cur.exclusion, { style: { color: '#d9480f', weight: 1, fillOpacity: 1, className: 'exclusion-shape' }, interactive: false }));
      for (const r of cur.reserves ?? []) layers.addLayer(L.geoJSON(r, { style: { color: '#c92a2a', weight: 1, fillOpacity: 1, className: 'reserve-shape' }, interactive: false }));
    }
    const post = cur?.post;
    let focus = null;
    if (post) {
      if (post.access_path) layers.addLayer(L.polyline(post.access_path.coordinates.map(toLatLng), { color: '#5c3d1e', weight: 5, dashArray: '2 8', lineCap: 'round' }));
      if (post.parking) layers.addLayer(L.marker(toLatLng(post.parking.geom.coordinates), { icon: parkingIcon() }).bindTooltip(escapeHtml(post.parking.name)));
      focus = L.marker(toLatLng(post.geom.coordinates), { icon: postIcon(post.number, 'selected mine') }).bindTooltip('Votre poste', { permanent: true, direction: 'top', offset: [0, -14] });
      layers.addLayer(focus);
    }
    const meeting = day.meeting_point ? L.circleMarker(toLatLng(day.meeting_point.coordinates), { radius: 8, color: '#0b6bcb', fillOpacity: 0.9 }).bindTooltip('Rendez-vous') : null;
    if (meeting) layers.addLayer(meeting);
    const regroup = day.regroup?.point
      ? L.marker(toLatLng(day.regroup.point.coordinates), { icon: L.divIcon({ className: 'regroup-icon', html: '<span>⚑</span>', iconSize: [30, 30], iconAnchor: [15, 28] }) })
        .bindTooltip(`Regroupement${day.regroup.place ? ` : ${escapeHtml(day.regroup.place)}` : ''}`, { permanent: step.phase === 'regroupement', direction: 'top', offset: [0, -24] })
      : null;
    if (regroup) layers.addLayer(regroup);
    // Recadrer seulement quand l'objet principal change (sinon on garde le zoom de l'utilisateur).
    const key = step.phase === 'regroupement' && regroup ? `regroup:${day.regroup.at}` : post ? `post:${cur.hunt.id}:${post.number}` : tLayer ? `territory:${cur.hunt.id}` : meeting ? 'meeting' : 'none';
    if (fittedFor !== key) {
      fittedFor = key;
      if (key.startsWith('regroup')) map.setView(regroup.getLatLng(), 15);
      else if (post) map.fitBounds(L.featureGroup([focus, ...(post.parking ? [L.marker(toLatLng(post.parking.geom.coordinates))] : [])]).getBounds().pad(0.6), { maxZoom: 16 });
      else if (tLayer) map.fitBounds(tLayer.getBounds());
      else if (meeting) map.setView(meeting.getLatLng(), 14);
    }
  }

  /** Cible du guidage selon la phase : le poste, ou le point de regroupement. */
  function panelContext(view, step) {
    const cur = view.current;
    const post = cur?.post;
    const running = cur?.hunt?.status === 'en_cours';
    let target = null;
    if (post && ['rejoindre', 'traque'].includes(step.phase)) {
      target = { kind: 'post', number: post.number, name: post.name, coords: post.geom.coordinates, path: post.access_path?.coordinates ?? null, canConfirm: running };
    } else if (step.phase === 'regroupement' && view.day.regroup?.point) {
      target = { kind: 'point', title: `Regroupement${view.day.regroup.place ? ` · ${view.day.regroup.place}` : ''}`, coords: view.day.regroup.point.coordinates };
    }
    return {
      huntId: cur?.hunt?.id ?? view.battues?.[view.battues.length - 1]?.id ?? null,
      running,
      dayRunning: view.day.status === 'en_cours',
      me: cur?.me ? { ...cur.me, guest: view.me?.guest } : view.me,
      sharing: view.me?.sharing,
      tolerance: view.gps_tolerance_m ?? 30,
      reserves: cur?.reserves ?? [],
      exclusion: cur?.exclusion ?? null,
      compact: step.phase === 'traque' || !!cur?.me?.in_place,
      target,
    };
  }

  // Pas de rafraîchissement pendant une saisie : la mise à jour attend que le
  // champ perde le focus (une case cochée ou un bouton ne comptent pas).
  let pending = null;
  const editing = () => {
    const a = document.activeElement;
    return info.contains(a) && (/^(SELECT|TEXTAREA)$/.test(a.tagName) || (a.tagName === 'INPUT' && !/^(checkbox|radio|button|submit)$/.test(a.type)));
  };
  function apply(view, carpool) {
    if (editing()) {
      pending = [view, carpool];
      return;
    }
    pending = null;
    const step = dayPhase(view);
    panel.update(panelContext(view, step));
    renderInfo(view, carpool, step);
    renderMap(view, step);
  }
  info.addEventListener('focusout', () => setTimeout(() => pending && !editing() && apply(...pending), 0));

  setTimeout(() => map.invalidateSize(), 0);
  return {
    update: apply,
    destroy() {
      panel.destroy();
      map.remove();
    },
  };
}

/** Vue chasseur d'un membre connecté (convoqué, ou responsable en vue d'ensemble). */
export async function memberDayView(main, dayId) {
  let view = null;
  let watcher = null;
  const load = async () => {
    const res = await api.get(`/days/${dayId}/view`);
    view.update(res.view, res.carpool);
  };
  const act = async (fn, msg) => {
    try {
      await fn();
      await load();
      await watcher?.sync();
      if (msg) toast(msg);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  view = createDaySheet(main, {
    dayId,
    canSeeAll: ['president', 'responsable'].includes(state.role),
    onRespond: (response, lunch) => act(() => api.post(`/days/${dayId}/respond`, { response, lunch: !!lunch }), 'Réponse enregistrée.'),
    onDeclare: (huntId, body) => act(() => api.post(`/hunts/${huntId}/harvests`, body), `${body.species} déclaré.`),
    onWithdraw: (huntId, x) => act(() => api.del(`/hunts/${huntId}/harvests/${x.id}`), 'Déclaration retirée.'),
    onChanged: () => load().then(() => watcher?.sync()).catch(() => {}),
  });
  try {
    await load();
  } catch (err) {
    fill(main, h('p.error', errorMessage(err)));
    view.destroy();
    return null;
  }
  watcher = watchRevision(() => api.get(`/days/${dayId}/revision`), load);
  return () => {
    watcher.stop();
    view.destroy();
  };
}

/** Vue d'un invité (lien sans compte) : rafraîchie toutes les 15 secondes. */
export async function guestDayView(main, token) {
  const load = async () => (await api.get(`/guest/${token}`, { tenant: false })).view;
  let view;
  try {
    const v = await load();
    view = createDaySheet(main, { guestToken: token, onChanged: () => load().then((x) => view.update(x, null)).catch(() => {}) });
    view.update(v, null);
  } catch (err) {
    main.append(h('h1', 'Journée de chasse'), h('p.error', errorMessage(err)));
    return null;
  }
  const stop = every(15_000, async () => {
    try {
      view.update(await load(), null);
    } catch (err) {
      if (err.status === 410) toast(errorMessage(err), 'warn');
    }
  });
  return () => {
    stop();
    view.destroy();
  };
}
