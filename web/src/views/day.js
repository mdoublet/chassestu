// Page d'une journée de chasse. Chasseur : vue chasseur. Président /
// responsable : deux onglets, « Vue chasseur » et « Gestion » :
//  - avant : rendez-vous, déjeuner, convocations et réponses ;
//  - jour J : présents (marche, voiture), invités, puis battue après battue :
//    territoire et volontaires, postes du jour, attribution (marche),
//    espèces, publication, covoiturage, mise en place, début, fin,
//    regroupement.
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon } from '../map/shapes.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, confirmDialog, copyText, modal } from '../ui.js';
import {
  DAY_STATUS_LABELS, ROLE_LABELS, CATEGORY_LABELS, COMMON_SPECIES, DIFFICULTY_LABELS,
  formatHuntDate, formatTime, postedSummary,
} from '../lib/hunts.js';
import { canReach } from '../lib/mobility.js';
import { watchRevision } from '../lib/live.js';
import { memberDayView } from './day-sheet.js';

const MANAGERS = ['president', 'responsable'];
const TAB_KEY = 'chassestu.huntTab';

export async function dayView(main, dayId) {
  if (!MANAGERS.includes(state.role)) {
    main.classList.remove('full');
    return memberDayView(main, dayId);
  }
  let tab = 'gestion';
  try {
    tab = localStorage.getItem(TAB_KEY) === 'chasseur' ? 'chasseur' : 'gestion';
  } catch { /* préférence non mémorisée */ }
  const tabs = h('nav.hunt-tabs', { role: 'tablist' });
  const body = h('div.hunt-body');
  main.classList.add('with-tabs');
  main.append(tabs, body);
  let cleanup = null;

  async function show(next) {
    cleanup?.();
    cleanup = null;
    tab = next;
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* rien */ }
    fill(tabs,
      h('a', { role: 'tab', href: '#/journees', class: 'back' }, '←'),
      ...[['chasseur', '👁 Vue chasseur'], ['gestion', '⚙ Gestion']].map(([id, label]) =>
        h('button', { role: 'tab', 'aria-selected': String(tab === id), class: tab === id ? 'active' : '', onclick: () => tab !== id && show(id) }, label)));
    body.replaceChildren();
    body.className = `hunt-body ${tab}`;
    cleanup = tab === 'chasseur' ? await memberDayView(body, dayId) : await dayConsole(body, dayId);
  }
  await show(tab);
  return () => cleanup?.();
}

const WALK_SHORT = { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' };
const timeOf = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

async function dayConsole(main, dayId) {
  ensureHatchPattern();
  const dv = {
    detail: null, hunt: null, territory: null, territoryId: null, carpool: null,
    members: [], territories: [], allowDouble: false, placing: null,
    regroup: { place: '', time: '', point: null }, newBattue: { territory_id: null, excluded: new Set() },
  };
  const box = h('div.hunt-console');
  const mapEl = h('div.hunt-map');
  main.append(h('div.hunt-layout', box, mapEl));
  let watcher = null;
  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  addBasemaps(map);
  const layers = { base: L.featureGroup().addTo(map), posts: L.featureGroup().addTo(map) };
  let fittedFor = null;

  const current = () => dv.detail?.battues.at(-1) ?? null;
  const running = () => current()?.status === 'en_cours' ? current() : null;

  async function loadBattue() {
    const b = current();
    if (!b) {
      dv.hunt = null;
      dv.carpool = null;
      return;
    }
    dv.hunt = await api.get(`/hunts/${b.id}`);
    if (dv.territoryId !== dv.hunt.hunt.territory_id) {
      dv.territory = await api.get(`/territories/${dv.hunt.hunt.territory_id}`);
      dv.territoryId = dv.hunt.hunt.territory_id;
    }
    dv.carpool = dv.hunt.hunt.status === 'en_cours' && dv.hunt.hunt.assignments_published_at
      ? await api.get(`/hunts/${b.id}/carpool`) : null;
  }

  async function load() {
    dv.detail = await api.get(`/days/${dayId}`);
    await loadBattue();
    render();
  }

  /** Action sur l'API, puis rechargement de la journée et de la battue. */
  async function act(fn, success) {
    try {
      const res = await fn();
      dv.detail = await api.get(`/days/${dayId}`);
      await loadBattue();
      await watcher?.sync(); // notre propre modification : pas de rechargement inutile
      if (success) toast(success);
      render();
      return res;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Carte : territoire de la battue, postes du jour (vert) ; points de RDV
  // -------------------------------------------------------------------------

  function renderMap() {
    layers.base.clearLayers();
    layers.posts.clearLayers();
    const { day } = dv.detail;
    let tLayer = null;
    const t = dv.hunt && dv.territory;
    if (t) {
      const { hunt, day_post_ids, participants } = dv.hunt;
      tLayer = L.geoJSON(t.territory.geom, { style: { color: '#1f5130', weight: 3, fillOpacity: 0.04 }, interactive: false });
      layers.base.addLayer(tLayer);
      if (t.exclusion?.geom) layers.base.addLayer(L.geoJSON(t.exclusion.geom, { style: { color: '#d9480f', weight: 1, fillOpacity: 1, className: 'exclusion-shape' }, interactive: false }));
      for (const r of t.reserves) layers.base.addLayer(L.geoJSON(r.geom, { style: { color: '#c92a2a', weight: 1, fillOpacity: 1, className: 'reserve-shape' }, interactive: false }));
      const chosen = new Set(day_post_ids);
      const occupants = new Map();
      for (const p of participants) if (p.post_id) occupants.set(p.post_id, [...(occupants.get(p.post_id) ?? []), p.name]);
      const editable = hunt.status === 'en_cours' && !hunt.started_at && !dv.placing;
      for (const p of t.posts) {
        const available = p.active && !p.invalid_reason;
        const cls = chosen.has(p.id) ? 'in-plan' : available ? 'dim' : 'invalid-static dim';
        const m = L.marker(toLatLng(p.geom.coordinates), { icon: postIcon(p.number, cls) });
        m.bindTooltip(escapeHtml(`Poste ${p.number}${p.name ? ` · ${p.name}` : ''}${p.difficulty ? ` · accès ${DIFFICULTY_LABELS[p.difficulty]}` : ''}${occupants.get(p.id) ? ` — ${occupants.get(p.id).join(', ')}` : ''}${!available ? ' (indisponible)' : ''}`), { direction: 'top', offset: [0, -14] });
        if (editable) m.on('click', () => toggleDayPost(p, available));
        layers.posts.addLayer(m);
      }
    }
    if (day.meeting_point) layers.base.addLayer(L.circleMarker(toLatLng(day.meeting_point.coordinates), { radius: 8, color: '#0b6bcb', fillOpacity: 0.9 }).bindTooltip('Rendez-vous'));
    const rg = dv.regroup.point ?? day.regroup_point;
    if (rg) layers.base.addLayer(L.marker(toLatLng(rg.coordinates), { icon: L.divIcon({ className: 'regroup-icon', html: '<span>⚑</span>', iconSize: [30, 30], iconAnchor: [15, 28] }) }).bindTooltip('Regroupement'));
    const key = tLayer ? `t:${dv.territoryId}` : day.meeting_point ? 'meeting' : 'none';
    if (fittedFor !== key) {
      fittedFor = key;
      if (tLayer) map.fitBounds(tLayer.getBounds(), { padding: [20, 20] });
      else if (day.meeting_point) map.setView(toLatLng(day.meeting_point.coordinates), 14);
    }
  }

  function toggleDayPost(p, available) {
    const chosen = new Set(dv.hunt.day_post_ids);
    if (chosen.has(p.id)) chosen.delete(p.id);
    else if (available) chosen.add(p.id);
    else return toast(`Poste ${p.number} indisponible.`, 'error');
    act(() => api.put(`/hunts/${dv.hunt.hunt.id}/posts`, { post_ids: [...chosen] }));
  }

  map.on('click', (e) => {
    const point = { type: 'Point', coordinates: [e.latlng.lng, e.latlng.lat] };
    if (dv.placing === 'meeting') {
      dv.placing = null;
      act(() => api.patch(`/days/${dayId}`, { meeting_point: point }), 'Point de rendez-vous enregistré.');
    } else if (dv.placing === 'regroup') {
      dv.placing = null;
      dv.regroup.point = point;
      render();
    }
  });

  // -------------------------------------------------------------------------
  // Avant la journée : rendez-vous, déjeuner, convocations
  // -------------------------------------------------------------------------

  function actionsSection() {
    const { day } = dv.detail;
    const go = (action, msg, confirmText) => async () => {
      if (confirmText && !(await confirmDialog(DAY_STATUS_LABELS[day.status], confirmText, 'Confirmer'))) return;
      await act(() => api.post(`/days/${dayId}/actions/${action}`), msg);
    };
    const buttons = {
      brouillon: [h('button.primary', { onclick: go('convoquer', 'Convocations envoyées : les chasseurs sont prévenus dans l’application.') }, 'Convoquer les chasseurs'),
        h('button.danger', { onclick: async () => {
          if (!(await confirmDialog('Supprimer', 'Supprimer ce brouillon de journée ?', 'Supprimer', true))) return;
          try { await api.del(`/days/${dayId}`); location.hash = '#/journees'; } catch (err) { toast(errorMessage(err), 'error'); }
        } }, 'Supprimer')],
      convoquee: [h('button.primary', { onclick: go('demarrer', 'Journée commencée : ajustez les présents.') }, 'Commencer la journée (jour J)'),
        h('button', { onclick: go('brouillon') }, 'Repasser en brouillon'),
        h('button.danger', { onclick: go('annuler', 'Journée annulée.', 'Annuler la journée ? Les convoqués seront prévenus.') }, 'Annuler la journée')],
      en_cours: [running() ? null : h('button', { onclick: go('terminer', 'Journée terminée.', 'Terminer la journée ? Les liens invités cesseront de fonctionner.') }, 'Terminer la journée')],
    }[day.status] ?? [];
    return h('div.buttons', buttons);
  }

  function infoSection(open) {
    const { day } = dv.detail;
    const editable = ['brouillon', 'convoquee', 'en_cours'].includes(day.status);
    const field = (name, label, attrs, tag = 'input') => {
      const el = h(tag, { name, ...attrs, disabled: !editable });
      if (attrs.type === 'checkbox') el.checked = !!day[name];
      else el.value = day[name] ?? '';
      el.addEventListener('change', () => act(() => api.patch(`/days/${dayId}`, { [name]: attrs.type === 'checkbox' ? el.checked : el.value }), 'Enregistré.'));
      return attrs.type === 'checkbox' ? h('label.check', el, label) : h('label', label, el);
    };
    return h('details.card', { open },
      h('summary', 'Rendez-vous, déjeuner et consignes'),
      h('div.row', field('date', 'Date', { type: 'date' }), field('meeting_time', 'Heure du rendez-vous', { type: 'time' })),
      field('meeting_place', 'Lieu du rendez-vous', { maxlength: 200 }),
      editable ? h('button.link', { onclick: () => { dv.placing = 'meeting'; toast('Cliquez sur la carte à l’endroit du rendez-vous.'); } }, day.meeting_point ? 'Déplacer le point de rendez-vous' : 'Placer le rendez-vous sur la carte') : null,
      field('lunch_offered', 'Déjeuner proposé (inscription facultative)', { type: 'checkbox' }),
      day.lunch_offered ? field('lunch_info', 'Déjeuner : lieu, prix…', { maxlength: 300 }) : null,
      field('briefing', 'Consignes de la journée', { rows: 3, maxlength: 5000 }, 'textarea'));
  }

  function convocationSection() {
    const { day, participants } = dv.detail;
    const convoked = new Map(participants.filter((p) => !p.guest).map((p) => [p.user_id, p]));
    const editable = ['brouillon', 'convoquee', 'en_cours'].includes(day.status);
    const icon = (p) => (!p ? '' : p.response === 'present' ? '✅' : p.response === 'absent' ? '❌' : '…');
    const counts = { present: 0, absent: 0, none: 0 };
    let lunch = 0;
    for (const p of convoked.values()) {
      counts[p.response ?? 'none'] += 1;
      if (p.lunch) lunch += 1;
    }
    return h('details.card', { open: day.status !== 'en_cours' },
      h('summary', `Convocations (${convoked.size})`, day.status !== 'brouillon' ? ` · ✅ ${counts.present} · ❌ ${counts.absent} · … ${counts.none}${day.lunch_offered ? ` · 🍽 ${lunch}` : ''}` : ''),
      h('ul.plain.members', dv.members.map((m) => {
        const p = convoked.get(m.id);
        return h('li', h('label.check',
          h('input', {
            type: 'checkbox', checked: !!p, disabled: !editable,
            onchange: (e) => {
              const ids = new Set(convoked.keys());
              if (e.target.checked) ids.add(m.id);
              else ids.delete(m.id);
              act(() => api.put(`/days/${dayId}/convocations`, { user_ids: [...ids] }));
            },
          }),
          `${icon(p)} ${m.display_name || m.email || 'Membre'}${p?.lunch ? ' 🍽' : ''}`));
      })));
  }

  // -------------------------------------------------------------------------
  // Jour J : présents, marche, voiture, invités
  // -------------------------------------------------------------------------

  function walkSelect(value, label, onchange) {
    return h('select', { 'aria-label': label, title: 'Capacité de marche (1 peu … 5 beaucoup)', onchange },
      h('option', { value: '' }, '—'),
      Object.keys(WALK_SHORT).map((v) => h('option', { value: v, selected: String(value ?? '') === v }, `🥾 ${v}`)));
  }

  function presentsSection() {
    const { participants, day } = dv.detail;
    const present = participants.filter((p) => p.present);
    const patch = (p, body) => act(() => api.patch(`/days/${dayId}/participants/${p.id}`, body));
    const guestName = h('input', { placeholder: 'Nom de l’invité', maxlength: 120 });
    const guestWalk = walkSelect(null, 'Marche de l’invité', () => {});
    const guestCar = h('input', { type: 'checkbox', 'aria-label': 'Invité en voiture' });
    const guestSeats = h('input', { type: 'number', min: 0, max: 8, placeholder: 'places', 'aria-label': 'Places libres de l’invité', style: 'width:6rem' });
    return h('details.card', { open: !dv.detail.battues.length },
      h('summary', `Présents du jour · ${present.length}${day.lunch_offered ? ` · 🍽 ${participants.filter((p) => p.lunch).length}` : ''}`),
      h('table.list.compact.presents', h('thead', h('tr', h('th', ''), h('th', 'Nom'), h('th', 'Marche'), h('th', 'Voiture'), h('th', 'Places'), day.lunch_offered ? h('th', '🍽') : null)),
        h('tbody', participants.map((p) => h('tr', { class: p.present ? '' : 'absent' },
          h('td', h('input', { type: 'checkbox', checked: p.present, 'aria-label': `Présent : ${p.name}`, onchange: (e) => patch(p, { present: e.target.checked }) })),
          h('td', p.name, p.guest ? h('span.badge', 'invité') : null, !p.guest && p.response !== 'present' ? h('span.small.muted', p.response === 'absent' ? ' (annoncé absent)' : ' (sans réponse)') : null),
          h('td', walkSelect(p.walking_ability, `Marche de ${p.name}`, (e) => patch(p, { walking_ability: e.target.value ? Number(e.target.value) : null }))),
          h('td', h('input', { type: 'checkbox', checked: !!p.has_car, 'aria-label': `Voiture : ${p.name}`, onchange: (e) => patch(p, { has_car: e.target.checked }) })),
          h('td', h('input', { type: 'number', min: 0, max: 8, value: p.car_seats ?? '', disabled: !p.has_car, 'aria-label': `Places : ${p.name}`, style: 'width:4.5rem',
            onchange: (e) => patch(p, { car_seats: e.target.value === '' ? null : Number(e.target.value) }) })),
          day.lunch_offered ? h('td', h('input', { type: 'checkbox', checked: p.lunch, 'aria-label': `Déjeuner : ${p.name}`, onchange: (e) => patch(p, { lunch: e.target.checked }) })) : null)))),
      h('form.row', { onsubmit: async (e) => {
        e.preventDefault();
        if (!guestName.value.trim()) return;
        const res = await act(() => api.post(`/days/${dayId}/guests`, {
          name: guestName.value.trim(),
          walking_ability: guestWalk.value ? Number(guestWalk.value) : null,
          has_car: guestCar.checked,
          car_seats: guestSeats.value === '' ? null : Number(guestSeats.value),
        }), 'Invité ajouté.');
        if (res?.guest_link) showGuestLink(res.guest_link);
      } }, guestName, guestWalk, h('label.check', guestCar, 'voiture'), guestSeats, h('button', { type: 'submit' }, 'Ajouter un invité')),
      guestLinks());
  }

  function showGuestLink(link) {
    const text = `${link.name}, voici votre accès à la journée de chasse (votre poste, l’itinéraire et les consignes) : ${link.url}`;
    modal('Lien de l’invité', h('div',
      h('p', `Envoyez ce lien à ${link.name} (SMS, WhatsApp…). Il ne sera plus affiché : vous pourrez en créer un nouveau.`),
      h('p.small', h('code', link.url)),
      h('button.primary', { onclick: () => copyText(text) }, 'Copier le message')));
  }

  function guestLinks() {
    const guests = dv.detail.participants.filter((p) => p.guest);
    if (!guests.length) return null;
    return h('div',
      h('h3', 'Liens invités'),
      h('ul.plain', guests.map((g) => h('li', `${g.name} : ${g.has_guest_link ? 'lien envoyé' : 'pas de lien'} `,
        h('button.link', { onclick: async () => {
          try {
            showGuestLink(await api.post(`/days/${dayId}/participants/${g.id}/guest-link`));
            await load();
          } catch (err) { toast(errorMessage(err), 'error'); }
        } }, g.has_guest_link ? 'Nouveau lien' : 'Créer un lien'),
        h('button.link.danger', { onclick: async () => {
          if (await confirmDialog('Retirer', `Retirer ${g.name} de la journée ?`, 'Retirer', true)) act(() => api.del(`/days/${dayId}/participants/${g.id}`));
        } }, ' Retirer')))));
  }

  // -------------------------------------------------------------------------
  // Battues : nouvelle battue, regroupement
  // -------------------------------------------------------------------------

  function battuesList() {
    const { battues } = dv.detail;
    if (!battues.length) return null;
    return h('ul.plain.battues', battues.map((b) => h('li', { class: b.status === 'en_cours' ? 'running' : '' },
      h('strong', `Battue n° ${b.number}`), ` · ${b.territory_name} · ${b.participant_count} participant(s) · `,
      b.status === 'terminee' ? `terminée${b.ended_at ? ` à ${timeOf(b.ended_at)}` : ''}` : b.started_at ? `traque depuis ${timeOf(b.started_at)}` : b.assignments_published_at ? 'postes publiés' : 'en préparation')));
  }

  function newBattueForm() {
    const present = dv.detail.participants.filter((p) => p.present);
    const nb = dv.newBattue;
    nb.territory_id ??= dv.territoryId ?? dv.territories[0]?.id ?? null;
    if (!dv.territories.length) return h('p.muted', 'Créez d’abord un territoire dans la cartographie.');
    const checks = present.map((p) => h('label.check', h('input', {
      type: 'checkbox', checked: !nb.excluded.has(p.id),
      onchange: (e) => { if (e.target.checked) nb.excluded.delete(p.id); else nb.excluded.add(p.id); },
    }), p.name, p.guest ? h('span.badge', 'invité') : null));
    return h('section.card',
      h('h2', `Battue n° ${dv.detail.battues.length + 1}`),
      h('label', 'Territoire', h('select', { onchange: (e) => { nb.territory_id = e.target.value; } },
        dv.territories.map((t) => h('option', { value: t.id, selected: t.id === nb.territory_id }, t.name)))),
      h('fieldset.members', h('legend', `Volontaires (${present.length - nb.excluded.size} sur ${present.length} présents)`), checks),
      h('p.small.muted', 'Décochez les présents qui ne font pas cette battue.'),
      h('button.primary', { onclick: async () => {
        const ids = present.filter((p) => !nb.excluded.has(p.id)).map((p) => p.id);
        if (!ids.length) return toast('Choisissez au moins un volontaire.', 'error');
        const res = await act(() => api.post(`/days/${dayId}/battues`, { territory_id: nb.territory_id, participant_ids: ids }), 'Battue créée : choisissez les postes.');
        if (res) { nb.excluded.clear(); dv.regroup = { place: '', time: '', point: null }; }
      } }, 'Créer la battue'));
  }

  function regroupForm() {
    const { day } = dv.detail;
    const rg = dv.regroup;
    const place = h('input', { maxlength: 200, placeholder: 'ex. cabane, croisement de la D12…', value: rg.place || day.regroup_place || '', oninput: (e) => { rg.place = e.target.value; } });
    const at = h('input', { type: 'time', value: rg.time || day.regroup_time || '', oninput: (e) => { rg.time = e.target.value; } });
    const point = rg.point ?? day.regroup_point;
    return h('section.card.regroup',
      h('h2', day.regroup_at ? '⚑ Regroupement annoncé' : '⚑ Regroupement'),
      day.regroup_at ? h('p.small', `Annoncé à ${timeOf(day.regroup_at)} : ${day.regroup_place || 'point sur la carte'}${day.regroup_time ? ` à ${formatTime(day.regroup_time)}` : ''}. Les présents ont l’itinéraire.`) : h('p.small.muted', 'Convoquez les chasseurs à un point pour faire le point et décider d’une nouvelle battue.'),
      h('div.row', h('label', 'Lieu', place), h('label', 'Heure', at)),
      h('div.buttons',
        h('button', { onclick: () => { dv.placing = 'regroup'; toast('Cliquez sur la carte à l’endroit du regroupement.'); } }, point ? '⚑ Déplacer le point' : '⚑ Placer sur la carte'),
        h('button', { onclick: () => navigator.geolocation?.getCurrentPosition(
          (p) => { rg.point = { type: 'Point', coordinates: [p.coords.longitude, p.coords.latitude] }; render(); toast('Votre position actuelle sera le point de regroupement.'); },
          () => toast('Position indisponible.', 'error'), { enableHighAccuracy: true, timeout: 15000 }) }, '📍 Ici (ma position)')),
      point ? h('p.small', `Point : ${point.coordinates[1].toFixed(5)}, ${point.coordinates[0].toFixed(5)}`) : null,
      h('button.primary', { onclick: () => {
        if (!rg.place && !point) return toast('Indiquez un lieu ou placez un point.', 'error');
        act(() => api.post(`/days/${dayId}/regroup`, { place: rg.place || day.regroup_place || '', point: point ?? null, time: rg.time || day.regroup_time || null }), 'Regroupement annoncé aux présents.');
      } }, day.regroup_at ? 'Annoncer à nouveau' : 'Annoncer le regroupement'));
  }

  // -------------------------------------------------------------------------
  // Battue en cours : volontaires, postes, attribution, espèces, publication
  // -------------------------------------------------------------------------

  function battueHeader() {
    const { hunt } = dv.hunt;
    const r = readiness();
    const go = (action, msg, confirmText) => async () => {
      if (confirmText && !(await confirmDialog(`Battue n° ${hunt.number}`, confirmText, 'Confirmer'))) return;
      await act(() => api.post(`/hunts/${hunt.id}/actions/${action}`), msg);
    };
    return h('div.battue-head',
      h('h2', `Battue n° ${hunt.number} · ${hunt.territory_name}`),
      h('div.buttons',
        !hunt.started_at
          ? [h('button.primary', { onclick: go('debut', 'Début de battue : les chasseurs sont prévenus.'), disabled: !hunt.assignments_published_at, title: hunt.assignments_published_at ? '' : 'Publiez d’abord les postes' }, 'Lancer la battue'),
             r ? h('span.small', { class: r.ready === r.rows.length ? 'all-ready' : 'muted' }, `${r.ready}/${r.rows.length} poste(s) confirmé(s)`) : null]
          : h('span.status.status-en_cours', `Traque depuis ${timeOf(hunt.started_at)}`),
        h('button.danger', { onclick: go('fin', 'Fin de battue : les chasseurs sont prévenus. Annoncez le regroupement.', 'Terminer la battue ? Les chasseurs seront prévenus.') }, 'Fin de battue'),
        !hunt.started_at ? h('button.link.danger', { onclick: async () => {
          if (!(await confirmDialog('Supprimer', `Supprimer la battue n° ${hunt.number} (créée par erreur) ?`, 'Supprimer', true))) return;
          act(() => api.del(`/hunts/${hunt.id}`));
        } }, 'Supprimer') : null));
  }

  function volunteersSection() {
    const { hunt, participants } = dv.hunt;
    const selected = new Map(participants.map((p) => [p.day_participant_id, p]));
    const present = dv.detail.participants.filter((p) => p.present);
    const editable = !hunt.started_at;
    const { posted } = postedSummary(participants);
    return h('section.card',
      h('h3', `1. Participants · ${participants.length} dont ${posted} posté(s)`),
      h('table.list.compact', h('tbody', present.map((dp) => {
        const p = selected.get(dp.id);
        return h('tr', { class: p ? '' : 'absent' },
          h('td', h('input', { type: 'checkbox', checked: !!p, disabled: !editable, 'aria-label': `Volontaire : ${dp.name}`, onchange: (e) => {
            const ids = new Set(selected.keys());
            if (e.target.checked) ids.add(dp.id);
            else ids.delete(dp.id);
            act(() => api.put(`/hunts/${hunt.id}/selection`, { day_participant_ids: [...ids] }));
          } })),
          h('td', dp.name, dp.walking_ability ? h('span.small.muted', ` 🥾${dp.walking_ability}`) : null, dp.guest ? h('span.badge', 'invité') : null),
          h('td', p ? h('select', { 'aria-label': `Rôle de ${dp.name}`, onchange: (e) => act(() => api.patch(`/hunts/${hunt.id}/participants/${p.id}`, { role: e.target.value })) },
            Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === p.role }, l))) : h('span.small.muted', 'ne participe pas')));
      }))));
  }

  function postsSection() {
    const { proposal, day_post_ids, hunt } = dv.hunt;
    const { posted } = postedSummary(dv.hunt.participants);
    const sameAsProposal = proposal && proposal.post_ids.length === day_post_ids.length && proposal.post_ids.every((id) => day_post_ids.includes(id));
    return h('section.card',
      h('h3', `2. Postes de la battue · ${day_post_ids.length} pour ${posted} posté(s)`),
      proposal ? h(`p.alert.${['plan', 'none'].includes(proposal.kind) ? 'muted' : proposal.kind === 'too_many' ? 'danger' : 'warn'}`, proposal.message) : null,
      proposal?.post_ids.length && !sameAsProposal && !hunt.started_at
        ? h('button', { onclick: () => act(() => api.put(`/hunts/${hunt.id}/posts`, { post_ids: proposal.post_ids }), 'Proposition appliquée.') }, `Utiliser la proposition (${proposal.post_ids.length} poste(s))`)
        : null,
      h('p.small.muted', 'Cliquez sur un poste de la carte pour l’ajouter ou le retirer (le plan enregistré n’est pas modifié).'));
  }

  function assignmentSection() {
    const { participants, proposal, day_post_ids, hunt } = dv.hunt;
    const { unassigned } = postedSummary(participants);
    const postsById = new Map(dv.territory.posts.map((p) => [p.id, p]));
    const dayPosts = day_post_ids.map((id) => postsById.get(id)).filter(Boolean).sort((a, b) => a.number - b.number);
    const postedPeople = participants.filter((p) => p.present && p.role === 'poste');
    const warnings = [];
    const rows = dayPosts.map((post) => {
      const holders = participants.filter((p) => p.post_id === post.id);
      for (const p of holders) if (!canReach(post.difficulty, p.walking_ability)) warnings.push(`${p.name} (marche ${p.walking_ability}) au poste ${post.number} (accès ${DIFFICULTY_LABELS[post.difficulty]})`);
      const cell = (holder, slot) => h('select', {
        'aria-label': `Poste ${post.number}${slot ? ' (doublon)' : ''}`,
        onchange: (e) => {
          const pid = e.target.value;
          if (!pid) return holder && act(() => api.del(`/hunts/${hunt.id}/assignments/${holder.id}`));
          act(() => api.put(`/hunts/${hunt.id}/assignments`, { participant_id: pid, post_id: post.id, locked: holder?.locked ?? false }));
        },
      },
      h('option', { value: '' }, slot ? '+ doublon' : '— libre —'),
      postedPeople.filter((p) => !p.post_id || p.id === holder?.id).map((p) => h('option', { value: p.id, selected: p.id === holder?.id },
        `${p.name}${p.walking_ability ? ` 🥾${p.walking_ability}` : ''}${canReach(post.difficulty, p.walking_ability) ? '' : ' ⚠'}`)));
      return h('tr',
        h('th', `${post.number}${post.name ? ` · ${post.name}` : ''}`, post.difficulty ? h('span.small.muted', { title: 'Difficulté d’accès' }, ` · accès ${post.difficulty}`) : null),
        h('td', cell(holders[0], 0), holders[0] ? h('label.check.small', h('input', {
          type: 'checkbox', checked: holders[0].locked, title: 'Verrouillé : conservé par le tirage au sort',
          onchange: (e) => act(() => api.put(`/hunts/${hunt.id}/assignments`, { participant_id: holders[0].id, post_id: post.id, locked: e.target.checked })),
        }), '🔒') : null),
        h('td', holders[0] && (holders[1] || proposal?.kind === 'too_many' || unassigned.length > 0) ? cell(holders[1], 1) : null));
    });
    return h('section.card',
      h('h3', '3. Attribution'),
      dayPosts.length ? h('table.list.compact', h('tbody', rows)) : h('p.muted', 'Choisissez d’abord les postes.'),
      warnings.length ? h('p.alert.warn', `⚠ Poste plus difficile que la capacité de marche déclarée : ${warnings.join(' ; ')}.`) : null,
      dayPosts.length && !hunt.started_at
        ? h('div.row',
            h('button', { onclick: async () => {
              const res = await act(() => api.post(`/hunts/${hunt.id}/draw`, { allow_double: dv.allowDouble }), 'Tirage au sort effectué (postes verrouillés conservés, marche respectée).');
              if (res?.unplaced) toast(`${res.unplaced} chasseur(s) sans poste accessible : ajoutez un poste plus facile, passez-les en traque ou autorisez les doublons.`, 'warn');
            } }, '🎲 Tirer au sort'),
            proposal?.kind === 'too_many' ? h('label.check', h('input', { type: 'checkbox', checked: dv.allowDouble, onchange: (e) => { dv.allowDouble = e.target.checked; } }), 'Autoriser les doublons') : null)
        : null,
      unassigned.length ? h('p.alert.warn', `Sans poste : ${unassigned.map((p) => {
        const free = dayPosts.filter((post) => !participants.some((x) => x.post_id === post.id));
        return free.length && !free.some((post) => canReach(post.difficulty, p.walking_ability))
          ? `${p.name} (marche ${p.walking_ability} : aucun poste libre assez accessible, ajoutez-en un plus facile)` : p.name;
      }).join(', ')}.`) : null,
      !hunt.started_at ? h('div.row',
        h('button.primary', { disabled: !dayPosts.length, onclick: () => act(() => api.post(`/hunts/${hunt.id}/publish-assignments`), 'Postes publiés : chaque chasseur a son poste, l’itinéraire et le covoiturage.') },
          hunt.assignments_published_at ? 'Republier les postes' : '4. Publier les postes')) : null,
      hunt.assignments_published_at ? h('p.small.muted', `Publiés à ${timeOf(hunt.assignments_published_at)}.`) : null);
  }

  /** Espèces tirables et quotas de cette battue (vides = sans limite fixée). */
  function speciesEditor() {
    const { hunt } = dv.hunt;
    const editable = hunt.status === 'en_cours';
    const rows = dv.hunt.species.map((x) => ({ ...x }));
    const save = () => act(() => api.put(`/hunts/${hunt.id}/species`, { species: rows.filter((r) => r.species.trim()) }), 'Espèces enregistrées.');
    const name = h('input', { list: 'species-list', placeholder: 'Espèce (ex. Sanglier)', maxlength: 60 });
    const quota = h('input', { type: 'number', min: 0, max: 999, placeholder: 'nombre' });
    return h('section.card.species-editor',
      h('h3', 'Espèces tirables et nombre'),
      rows.length
        ? h('table.list.compact', h('tbody', rows.map((r, i) => h('tr',
            h('td', r.species),
            h('td', h('input', { type: 'number', min: 0, max: 999, placeholder: 'sans limite', value: r.quota ?? '', disabled: !editable, 'aria-label': `Nombre ${r.species}`,
              onchange: (e) => { r.quota = e.target.value === '' ? null : Number(e.target.value); save(); } })),
            editable ? h('td', h('button.link.danger', { onclick: () => { rows.splice(i, 1); save(); } }, '✕')) : null))))
        : h('p.small.muted', 'Aucune espèce précisée.'),
      editable ? h('form.row', { onsubmit: (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        rows.push({ species: name.value.trim(), quota: quota.value === '' ? null : Number(quota.value) });
        save();
      } }, name, quota, h('button', { type: 'submit' }, 'Ajouter'),
      h('datalist', { id: 'species-list' }, COMMON_SPECIES.map((x) => h('option', { value: x })))) : null);
  }

  function carpoolSection() {
    const c = dv.carpool;
    if (!c) return null;
    return h('section.card.carpool',
      h('h3', `🚗 Covoiturage vers les parkings · ${c.cars.length} voiture(s)`),
      c.cars.length < c.carsAdvised ? h('p.alert.warn', `${c.carsAdvised} voitures conseillées (${c.maxPerCar} chasseurs au plus par voiture) : il en manque ${c.carsAdvised - c.cars.length}.`) : null,
      h('ul.plain', c.cars.map((car) => h('li',
        h('strong', car.driver.name), ` → ${car.destinationName}`,
        car.passengers.length ? ` avec ${car.passengers.map((p) => `${p.name}${p.detour ? ` (déposé au ${p.destinationName})` : ''}`).join(', ')}` : ' (seul)'))),
      c.unseated.length ? h('p.alert.danger', `Sans place : ${c.unseated.map((p) => `${p.name} (${p.destinationName})`).join(', ')}.`) : null);
  }

  /** Postes occupés et confirmés (« Je suis en place »), pour lancer la traque. */
  function readiness() {
    const { participants, day_post_ids, hunt } = dv.hunt;
    if (hunt.status !== 'en_cours' || !hunt.assignments_published_at) return null;
    const postsById = new Map(dv.territory.posts.map((p) => [p.id, p]));
    const rows = day_post_ids.map((id) => postsById.get(id)).filter(Boolean).sort((a, b) => a.number - b.number)
      .map((post) => {
        const holders = participants.filter((p) => p.post_id === post.id);
        return { post, holders, ok: holders.length > 0 && holders.every((p) => p.in_place_at) };
      });
    return { rows, ready: rows.filter((r) => r.ok).length };
  }

  function readinessSection() {
    const r = readiness();
    if (!r || dv.hunt.hunt.started_at) return null;
    return h('section.card',
      h('h3', `5. Mise en place · ${r.ready}/${r.rows.length} poste(s) occupé(s) et confirmé(s)`),
      h('ul.plain.readiness', r.rows.map(({ post, holders, ok }) => h('li', { class: ok ? 'ok' : '' },
        h('span.light', ok ? '●' : '○'),
        h('strong', `Poste ${post.number}${post.name ? ` · ${post.name}` : ''}`),
        h('span', holders.length ? holders.map((p) => `${p.name} ${p.in_place_at ? `✅ ${timeOf(p.in_place_at)}` : '⏳'}`).join(' · ') : 'libre')))));
  }

  /** Prélèvements : saisie pour un participant (invité, chasseur sans téléphone). */
  function harvestSection() {
    const { participants, harvests, species, hunt } = dv.hunt;
    const shooter = h('select', { 'aria-label': 'Tireur' }, h('option', { value: '' }, '— tireur —'),
      participants.map((p) => h('option', { value: p.id }, p.name)));
    const sp = h('select', { 'aria-label': 'Espèce' }, [...new Set([...species.map((x) => x.species), ...COMMON_SPECIES])].map((x) => h('option', { value: x }, x)));
    const cat = h('select', { 'aria-label': 'Catégorie' }, Object.entries(CATEGORY_LABELS).map(([v, l]) => h('option', { value: v, selected: v === 'indetermine' }, l)));
    return h('section.card',
      h('h3', `Prélèvements de la battue n° ${hunt.number} (${harvests.length})`),
      harvests.length ? h('ul.plain', harvests.map((x) => h('li',
        `${x.species} ${CATEGORY_LABELS[x.category]}${x.shooter ? ` — ${x.shooter}` : ''} · ${timeOf(x.created_at)} `,
        h('button.link.danger', { onclick: () => act(() => api.del(`/hunts/${hunt.id}/harvests/${x.id}`)) }, 'Supprimer')))) : null,
      h('form.row', { onsubmit: (e) => {
        e.preventDefault();
        act(() => api.post(`/hunts/${hunt.id}/harvests`, { species: sp.value, category: cat.value, participant_id: shooter.value || null }), 'Prélèvement enregistré.');
      } }, shooter, sp, cat, h('button', { type: 'submit' }, 'Ajouter')));
  }

  function render() {
    const { day } = dv.detail;
    const run = running();
    const last = current();
    const mine = dv.detail.participants.find((p) => p.user_id === state.user.id);
    let sections;
    if (day.status === 'brouillon' || day.status === 'convoquee') {
      sections = [infoSection(true), convocationSection()];
    } else if (day.status === 'en_cours') {
      sections = [
        presentsSection(),
        h('h2.section-title', 'Battues'),
        battuesList(),
        run && dv.hunt
          ? [h('div.battue', battueHeader(), readinessSection(), volunteersSection(), postsSection(), assignmentSection(), speciesEditor(), carpoolSection(), harvestSection())]
          : [last?.status === 'terminee' ? regroupForm() : null, newBattueForm(),
             last && dv.hunt ? harvestSection() : null],
        infoSection(false),
        convocationSection(),
      ];
    } else {
      sections = [battuesList(), last && dv.hunt ? harvestSection() : null];
    }
    fill(box,
      h('h1', `Journée du ${formatHuntDate(day.date)}`),
      h('p', `Rendez-vous à ${formatTime(day.meeting_time)}${day.meeting_place ? `, ${day.meeting_place}` : ''} · `, h('span.status', { class: `status-${day.status}` }, DAY_STATUS_LABELS[day.status])),
      actionsSection(),
      sections,
    );
    renderMap();
  }

  try {
    const [members, territories] = await Promise.all([api.get('/members'), api.get('/territories')]);
    dv.members = members.members;
    dv.territories = territories.territories;
    await load();
  } catch (err) {
    fill(box, h('p.error', errorMessage(err)));
  }
  setTimeout(() => map.invalidateSize(), 0);
  // Mise à jour automatique (réponses, confirmations, prélèvements, autre responsable…).
  watcher = watchRevision(() => api.get(`/days/${dayId}/revision`), async () => {
    const a = document.activeElement;
    if (box.contains(a) && (/^(SELECT|TEXTAREA)$/.test(a.tagName) || (a.tagName === 'INPUT' && !/^(checkbox|radio)$/.test(a.type)))) return false;
    await load();
    return true;
  });
  return () => {
    watcher.stop();
    map.remove();
  };
}
