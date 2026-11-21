// Page d'une journée de chasse. Chasseur : vue chasseur. Président /
// responsable : deux onglets, « Vue chasseur » et « Gestion » :
//  - avant : rendez-vous, déjeuner, convocations et réponses ;
//  - jour J : présents (marche, voiture), invités, puis battue après battue :
//    territoire et volontaires, postes du jour, attribution (marche),
//    espèces, publication, covoiturage, mise en place, début, fin,
//    regroupement.
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon, traqueLayers } from '../map/shapes.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, confirmDialog, copyText, modal, fold } from '../ui.js';
import {
  DAY_STATUS_LABELS, ROLE_LABELS, CATEGORY_LABELS, COMMON_SPECIES, DIFFICULTY_LABELS,
  formatHuntDate, formatTime, postedSummary,
} from '../lib/hunts.js';
import { canReach } from '../lib/mobility.js';
import { watchRevision } from '../lib/live.js';
import { memberDayView } from './day-sheet.js';
import { placeSelect } from './place-picker.js';
import { panelResizer } from '../map/resizer.js';

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

const NAMES_KEY = 'chassestu.showPostNames';
const POSTED_ROLES = ['poste', 'chef_de_ligne']; // le chef de ligne est un chasseur posté

async function dayConsole(main, dayId) {
  ensureHatchPattern();
  const dv = {
    detail: null, hunt: null, territory: null, territoryId: null, carpool: null,
    members: [], territories: [], allowDouble: false, placing: null,
    picked: null, places: { places: [], parkings: [] }, regroup: { choice: null, place: '', time: '', point: null, when: 'now' }, newBattue: { territory_id: null, hunt_plan_id: undefined, excluded: new Set() },
    huntPlans: new Map(), // territoire → plans de chasse
    showPostNames: (() => { try { return localStorage.getItem(NAMES_KEY) !== '0'; } catch { return true; } })(),
  };
  const box = h('div.hunt-console');
  const mapEl = h('div.hunt-map');
  const resizer = panelResizer(box, { key: 'chassestu.dayPanelWidth', side: 'left', onResize: () => map.invalidateSize() });
  main.append(h('div.hunt-layout', box, resizer, mapEl));
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

  /** Plans de chasse d'un territoire (chargés une fois, puis re-rendu). */
  function huntPlansOf(territoryId) {
    if (!territoryId) return [];
    if (!dv.huntPlans.has(territoryId)) {
      dv.huntPlans.set(territoryId, null);
      api.get(`/territories/${territoryId}/hunt-plans`)
        .then((r) => { dv.huntPlans.set(territoryId, r.hunt_plans.filter((hp) => hp.in_season !== false)); render(); })
        .catch(() => dv.huntPlans.delete(territoryId));
    }
    return dv.huntPlans.get(territoryId) ?? null; // null : en cours de chargement
  }

  /** Choix du plan de chasse : '' = sans plan (postes choisis à la main). */
  function huntPlanSelect(territoryId, value, onchange, disabled = false) {
    const plans = huntPlansOf(territoryId);
    if (plans === null) return h('select', { disabled: true }, h('option', 'Chargement…'));
    return h('select', { disabled, 'aria-label': 'Plan de chasse', onchange: (e) => onchange(e.target.value || null) },
      plans.map((hp) => h('option', { value: hp.id, selected: hp.id === value }, hp.name)),
      h('option', { value: '', selected: !value }, '— sans plan : postes choisis à la main —'));
  }

  /**
   * Postes du plan de chasse repris d'office si aucun poste n'est encore choisi
   * (ou s'ils sont ceux de la proposition précédente, non retouchés).
   */
  async function takePlanPosts(previous = null) {
    const { hunt, proposal, day_post_ids } = dv.hunt ?? {};
    if (!hunt || hunt.started_at || !proposal?.post_ids.length || !proposal.plan_count) return;
    const untouched = !day_post_ids.length || (previous && sameIds(previous, day_post_ids));
    if (!untouched || sameIds(proposal.post_ids, day_post_ids)) return;
    if (await act(() => api.put(`/hunts/${hunt.id}/posts`, { post_ids: proposal.post_ids }),
      `Postes du plan « ${hunt.hunt_plan_name} » à ${proposal.plan_count} chasseurs repris (modifiables sur la carte).`)) await autoPlace();
  }

  /**
   * Placement automatique des postés sans poste : rotation (chacun évite les
   * postes occupés lors de ses battues précédentes), marche respectée, hasard
   * à égalité. Les placements déjà faits sont gardés.
   */
  async function autoPlace(all = false) {
    const { hunt, participants, day_post_ids } = dv.hunt ?? {};
    if (!hunt || hunt.started_at || !day_post_ids?.length) return;
    if (!all && !participants.some((p) => p.present && POSTED_ROLES.includes(p.role) && !p.post_id)) return;
    if (all) await api.del(`/hunts/${hunt.id}/assignments`).catch(() => {});
    const res = await act(() => api.post(`/hunts/${hunt.id}/draw`, { allow_double: dv.allowDouble, keep_existing: true }),
      'Chasseurs placés : chacun change de poste par rapport à ses battues précédentes (marche respectée). Ajustez à la main si besoin.');
    if (res?.unplaced) toast(`${res.unplaced} chasseur(s) sans poste accessible : ajoutez un poste plus facile ou passez-les en traque.`, 'warn');
  }
  const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

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
    if (dv.hunt?.hunt_plan) for (const l of traqueLayers(dv.hunt.hunt_plan)) layers.base.addLayer(l);
    if (day.meeting_point) layers.base.addLayer(L.circleMarker(toLatLng(day.meeting_point.coordinates), { radius: 8, color: '#0b6bcb', fillOpacity: 0.9 }).bindTooltip('Rendez-vous'));
    const rg = (dv.regroup.choice === 'other' ? dv.regroup.point : dv.regroup.choice?.point) ?? day.regroup_point;
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
    // Placement initial automatique : personne n'est encore placé et il y a un poste pour chacun.
    const posted = dv.hunt.participants.filter((x) => x.present && POSTED_ROLES.includes(x.role)).length;
    const auto = !dv.hunt.participants.some((x) => x.post_id) && chosen.size >= posted;
    act(() => api.put(`/hunts/${dv.hunt.hunt.id}/posts`, { post_ids: [...chosen] })).then((r) => r && auto && autoPlace());
  }

  map.on('click', (e) => {
    const point = { type: 'Point', coordinates: [e.latlng.lng, e.latlng.lat] };
    if (dv.placing === 'meeting') {
      dv.placing = null;
      act(() => api.patch(`/days/${dayId}`, { meeting_point: point }), 'Point de rendez-vous enregistré.');
    } else if (dv.placing === 'regroup') {
      dv.placing = null;
      dv.regroup.choice = 'other';
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
      brouillon: [h('button.primary', { onclick: go('convoquer', 'Convocations envoyées : les chasseurs sont prévenus dans l’application.') }, 'Envoyer les convocations'),
        h('button.danger', { onclick: async () => {
          if (!(await confirmDialog('Supprimer', 'Supprimer cette journée (brouillon) ?', 'Supprimer', true))) return;
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
      editable ? h('label', 'Choisir le lieu du rendez-vous', placeSelect(dv.places, {
        current: day.meeting_place,
        onpick: (c) => c && c !== 'other' && act(() => api.patch(`/days/${dayId}`, { meeting_place: c.name, meeting_point: c.point }), 'Rendez-vous enregistré.'),
      })) : null,
      field('meeting_place', 'Lieu du rendez-vous (texte)', { maxlength: 200 }),
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
    // Liste longue : une section par catégorie (chasseurs, traqueurs, autres), cocher / décocher tout.
    const save = (ids) => act(() => api.put(`/days/${dayId}/convocations`, { user_ids: [...ids] }));
    const groups = [['chasseur', 'Chasseurs'], ['traqueur', 'Traqueurs'], ['autre', 'Autres']]
      // Membres inscrits pour la saison (et ceux déjà convoqués).
      .map(([k, label]) => ({ label, members: dv.members.filter((m) => (m.usual_role ?? 'chasseur') === k && (m.in_season !== false || convoked.has(m.id))) }))
      .filter((g) => g.members.length);
    const section = (g) => {
      const n = g.members.filter((m) => convoked.has(m.id)).length;
      return fold(g.label, { key: `convoc.${g.label}`, open: dv.members.length <= 15, extra: `${n}/${g.members.length}` },
        editable ? h('div.buttons.compact',
          h('button.link', { onclick: () => save(new Set([...convoked.keys(), ...g.members.map((m) => m.id)])) }, 'Tout cocher'),
          h('button.link', { onclick: () => { const ids = new Set(convoked.keys()); for (const m of g.members) ids.delete(m.id); save(ids); } }, 'Tout décocher')) : null,
        h('ul.plain.members', g.members.map((m) => {
          const p = convoked.get(m.id);
          return h('li', h('label.check',
            h('input', {
              type: 'checkbox', checked: !!p, disabled: !editable,
              onchange: (e) => {
                const ids = new Set(convoked.keys());
                if (e.target.checked) ids.add(m.id);
                else ids.delete(m.id);
                save(ids);
              },
            }),
            `${icon(p)} ${m.display_name || m.email || 'Membre'}${p?.lunch ? ' 🍽' : ''}`));
        })));
    };
    return h('section.card.step', fold(`Convocations (${convoked.size})`, { key: 'convoc', open: day.status !== 'en_cours',
      extra: day.status !== 'brouillon' ? `✅ ${counts.present} · ❌ ${counts.absent} · … ${counts.none}${day.lunch_offered ? ` · 🍽 ${lunch}` : ''}` : '' },
      groups.map(section)));
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
        // Pas de lien à la création : on l'envoie ensuite (📨 dans « Invités »).
        await act(() => api.post(`/days/${dayId}/guests`, {
          name: guestName.value.trim(),
          walking_ability: guestWalk.value ? Number(guestWalk.value) : null,
          has_car: guestCar.checked,
          car_seats: guestSeats.value === '' ? null : Number(guestSeats.value),
          link: false,
        }), 'Invité ajouté : envoyez-lui son lien avec 📨 quand vous voulez.');
      } }, guestName, guestWalk, h('label.check', guestCar, 'voiture'), guestSeats, h('button', { type: 'submit' }, 'Ajouter un invité')),
      guestLinks());
  }

  /** Lien affiché une seule fois : partage du téléphone, sinon copie / SMS / WhatsApp. */
  async function shareGuestLink(link) {
    const text = `${link.name}, voici votre accès à la journée de chasse (votre poste, l’itinéraire et les consignes) : ${link.url}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Journée de chasse', text });
        toast(`Lien de ${link.name} partagé.`);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') { /* partage annulé : on propose les autres moyens */ }
      }
    }
    modal(`Envoyer le lien à ${link.name}`, h('div',
      h('p', `Envoyez ce lien à ${link.name}. Il ne sera plus affiché ensuite (vous pourrez en créer un nouveau).`),
      h('p.small', h('code', link.url)),
      h('div.buttons',
        h('button.primary', { onclick: async () => { await copyText(text); toast('Message copié.'); } }, 'Copier le message'),
        h('a.button', { href: `sms:?&body=${encodeURIComponent(text)}` }, 'SMS'),
        h('a.button', { href: `https://wa.me/?text=${encodeURIComponent(text)}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'))));
  }

  async function sendGuestLink(g) {
    if (g.has_guest_link && !(await confirmDialog('Nouveau lien', `Un lien a déjà été créé pour ${g.name}. En envoyer un nouveau ? L’ancien cessera de fonctionner.`, 'Nouveau lien'))) return;
    try {
      const link = await api.post(`/days/${dayId}/participants/${g.id}/guest-link`);
      await load();
      await shareGuestLink(link);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function guestLinks() {
    const guests = dv.detail.participants.filter((p) => p.guest);
    if (!guests.length) return null;
    return h('div.guest-links',
      h('h3', 'Invités'),
      h('ul.plain', guests.map((g) => h('li',
        h('span', g.name), h('span.small.muted', g.has_guest_link ? ' · lien créé' : ' · lien pas encore envoyé'), ' ',
        h('button.small', { onclick: () => sendGuestLink(g), title: 'Envoyer à l’invité son lien (poste, itinéraire, consignes)' }, g.has_guest_link ? '📨 Renvoyer un lien' : '📨 Envoyer le lien'),
        h('button.link.danger', { onclick: async () => {
          if (await confirmDialog('Retirer', `Retirer ${g.name} de la journée ?`, 'Retirer', true)) act(() => api.del(`/days/${dayId}/participants/${g.id}`));
        } }, ' Retirer')))));
  }

  // -------------------------------------------------------------------------
  // Battues : nouvelle battue, regroupement
  // -------------------------------------------------------------------------

  /** Bloc d'étape de la battue : carte dépliable, résumé à droite (état gardé pendant la session). */
  function step(key, title, extra, open, ...content) {
    return h(`section.card.step.step-${key}`, fold(title, { key: `battue.${key}`, extra, open }, ...content));
  }

  function battuesList() {
    // La battue en cours a son propre bloc : seules les précédentes sont listées (repliées).
    const battues = dv.detail.battues.filter((b) => b.status !== 'en_cours');
    if (!battues.length) return null;
    return fold('Battues précédentes', { key: 'day.battues', extra: String(battues.length) }, h('ul.plain.battues', battues.map((b) => h('li', { class: b.status === 'en_cours' ? 'running' : '' },
      h('strong', `Battue n° ${b.number}`), ` · ${b.territory_name}${b.hunt_plan_name ? ` (${b.hunt_plan_name})` : ''} · ${b.participant_count} participant(s) · `,
      b.status === 'terminee' ? `terminée${b.ended_at ? ` à ${timeOf(b.ended_at)}` : ''}` : b.started_at ? `traque depuis ${timeOf(b.started_at)}` : b.assignments_published_at ? 'postes publiés' : 'en préparation'))));
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
      h('label', 'Territoire', h('select', { onchange: (e) => { nb.territory_id = e.target.value; nb.hunt_plan_id = undefined; render(); } },
        dv.territories.map((t) => h('option', { value: t.id, selected: t.id === nb.territory_id }, t.name)))),
      (() => {
        const plans = huntPlansOf(nb.territory_id);
        if (plans && nb.hunt_plan_id === undefined) nb.hunt_plan_id = plans[0]?.id ?? null;
        return [
          h('label', 'Plan de chasse', huntPlanSelect(nb.territory_id, nb.hunt_plan_id, (v) => { nb.hunt_plan_id = v; })),
          plans && !plans.length
            ? h('p.small.muted', 'Aucun plan de chasse pour ce territoire : les postes seront choisis à la main. ',
                state.role === 'president' ? h('a', { href: `#/plans/${nb.territory_id}` }, 'Créer un plan de chasse') : null)
            : h('p.small.muted', 'Le plan de chasse (sens de la traque) donne les postes à pourvoir en priorité.'),
        ];
      })(),
      h('fieldset.members', h('legend', `Volontaires (${present.length - nb.excluded.size} sur ${present.length} présents)`), checks),
      h('p.small.muted', 'Décochez les présents qui ne font pas cette battue.'),
      h('button.primary', { onclick: async () => {
        const ids = present.filter((p) => !nb.excluded.has(p.id)).map((p) => p.id);
        if (!ids.length) return toast('Choisissez au moins un volontaire.', 'error');
        const res = await act(() => api.post(`/days/${dayId}/battues`, { territory_id: nb.territory_id, hunt_plan_id: nb.hunt_plan_id ?? null, participant_ids: ids }), 'Battue créée.');
        if (res) { await takePlanPosts(); nb.excluded.clear(); nb.hunt_plan_id = undefined; dv.regroup = { choice: null, place: '', time: '', point: null, when: 'now' }; }
      } }, 'Créer la battue'));
  }

  /** Regroupement : un lieu (lieux de l'association, parkings, ou point sur la carte), immédiat par défaut. */
  function regroupForm() {
    const { day } = dv.detail;
    const rg = dv.regroup;
    rg.when ??= 'now';
    const isOther = rg.choice === 'other';
    const point = isOther ? rg.point : rg.choice?.point ?? null;
    const placeName = isOther ? rg.place : rg.choice?.name ?? '';
    const at = h('input', { type: 'time', value: rg.time, 'aria-label': 'Heure du regroupement', oninput: (e) => { rg.time = e.target.value; } });
    return h('section.card.regroup',
      h('h2', '⚑ Regroupement'),
      day.regroup_at ? h('p.small', `Annoncé à ${timeOf(day.regroup_at)} : ${day.regroup_place || 'point sur la carte'} ${day.regroup_time ? `à ${formatTime(day.regroup_time)}` : '(immédiat)'}.`) : null,
      h('label', 'Lieu', placeSelect(dv.places, {
        selectedKey: rg.choice === 'other' ? 'other' : rg.choice?.key ?? '',
        other: 'Autre : point sur la carte',
        onpick: (c) => { rg.choice = c; rg.point = null; render(); },
      })),
      isOther ? [
        h('input', { maxlength: 200, placeholder: 'Nom (facultatif), ex. croisement de la D12', value: rg.place, oninput: (e) => { rg.place = e.target.value; } }),
        h('div.buttons',
          h('button', { onclick: () => { dv.placing = 'regroup'; toast('Cliquez sur la carte à l’endroit du regroupement.'); } }, point ? '⚑ Déplacer le point' : '⚑ Placer sur la carte'),
          h('button', { onclick: () => navigator.geolocation?.getCurrentPosition(
            (p) => { rg.point = { type: 'Point', coordinates: [p.coords.longitude, p.coords.latitude] }; render(); },
            () => toast('Position indisponible.', 'error'), { enableHighAccuracy: true, timeout: 15000 }) }, '📍 Ma position')),
      ] : null,
      h('div.row',
        h('label', 'Quand', h('select', { onchange: (e) => { rg.when = e.target.value; render(); } },
          h('option', { value: 'now', selected: rg.when === 'now' }, 'Immédiat'),
          h('option', { value: 'time', selected: rg.when === 'time' }, 'À une heure précise'))),
        rg.when === 'time' ? h('label', 'Heure', at) : null),
      h('button.primary', { onclick: () => {
        if (!point && !placeName) return toast('Choisissez un lieu.', 'error');
        if (rg.when === 'time' && !rg.time) return toast('Indiquez l’heure.', 'error');
        act(() => api.post(`/days/${dayId}/regroup`, { place: placeName, point, time: rg.when === 'time' ? rg.time : null }), 'Regroupement annoncé aux présents.');
      } }, day.regroup_at ? 'Annoncer à nouveau' : 'Annoncer le regroupement'));
  }

  // -------------------------------------------------------------------------
  // Battue en cours : volontaires, postes, attribution, espèces, publication
  // -------------------------------------------------------------------------

  function battueHeader() {
    const { hunt, participants } = dv.hunt;
    // Responsable de battue : un membre participant (ou le responsable actuel) ; le président par défaut.
    const candidates = new Map(participants.filter((p) => p.user_id).map((p) => [p.user_id, p.name]));
    if (hunt.leader_user_id && !candidates.has(hunt.leader_user_id)) candidates.set(hunt.leader_user_id, hunt.leader_name ?? '?');
    return h('div.battue-head',
      h('h2', `Battue n° ${hunt.number} · ${hunt.territory_name}`),
      hunt.started_at ? h('p', h('span.status.status-en_cours', `Traque depuis ${timeOf(hunt.started_at)}`)) : null,
      h('div.battue-roles',
        h('label.hunt-plan-choice', 'Plan de chasse ',
          hunt.started_at
            ? h('strong', hunt.hunt_plan_name ?? 'aucun (postes à la main)')
            : huntPlanSelect(hunt.territory_id, hunt.hunt_plan_id, async (v) => {
                const previous = dv.hunt.proposal?.post_ids ?? null;
                if (await act(() => api.patch(`/hunts/${hunt.id}`, { hunt_plan_id: v }), v ? 'Plan de chasse changé.' : 'Battue sans plan de chasse : choisissez les postes sur la carte.')) await takePlanPosts(previous);
              })),
        h('label.hunt-plan-choice', { title: 'Il voit qui est en place et peut lancer et arrêter la battue depuis son téléphone (le président le peut toujours).' }, 'Responsable de battue ',
          h('select', { 'aria-label': 'Responsable de battue', onchange: (e) => act(() => api.patch(`/hunts/${hunt.id}`, { leader_user_id: e.target.value }), 'Responsable de battue désigné : il est prévenu.') },
            [...candidates].map(([id, name]) => h('option', { value: id, selected: id === hunt.leader_user_id }, id === state.user.id ? `${name} (moi)` : name))))),
      dv.hunt.hunt_plan?.notes ? h('p.small', `Traque : ${dv.hunt.hunt_plan.notes}`) : null);
  }

  /** En bas, dans l'ordre des actions : d'abord publier les postes, puis lancer ; fin ; suppression. */
  function battueActions() {
    const { hunt } = dv.hunt;
    const r = readiness();
    const go = (action, msg, confirmText) => async () => {
      if (confirmText && !(await confirmDialog(`Battue n° ${hunt.number}`, confirmText, 'Confirmer'))) return;
      await act(() => api.post(`/hunts/${hunt.id}/actions/${action}`), msg);
    };
    return h('section.card.battue-actions',
      h('div.buttons',
        !hunt.started_at
          ? [h('button.primary', { onclick: go('debut', 'Début de battue : les chasseurs sont prévenus.'), disabled: !hunt.assignments_published_at, title: hunt.assignments_published_at ? '' : 'Publiez d’abord les postes' }, 'Lancer la battue'),
             r ? h('span.small', { class: r.ready === r.rows.length ? 'all-ready' : 'muted' }, `${r.ready}/${r.rows.length} poste(s) confirmé(s)`) : h('span.small.muted', 'Publiez d’abord les postes.')]
          : null,
        // Pas de « fin » avant le lancement : seulement annuler la battue (créée par erreur).
        hunt.started_at ? h('button.danger', { onclick: go('fin', 'Fin de battue : les chasseurs sont prévenus. Annoncez le regroupement.', 'Terminer la battue ? Les chasseurs seront prévenus.') }, 'Fin de battue') : null,
        !hunt.started_at ? h('button.link.danger', { onclick: async () => {
          if (!(await confirmDialog('Supprimer', `Supprimer la battue n° ${hunt.number} (créée par erreur) ?`, 'Supprimer', true))) return;
          act(() => api.del(`/hunts/${hunt.id}`));
        } }, 'Annuler la battue') : null));
  }

  function volunteersSection() {
    const { hunt, participants } = dv.hunt;
    const selected = new Map(participants.map((p) => [p.day_participant_id, p]));
    const present = dv.detail.participants.filter((p) => p.present);
    const editable = !hunt.started_at;
    const { posted } = postedSummary(participants);
    return step('participants', '1. Participants', `${participants.length} · ${posted} posté(s)`, false,
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

  /**
   * Postes et chasseurs, en un bloc : une ligne par poste avec ses chasseurs.
   * Toucher un nom puis un poste le déplace (échange si le poste est occupé) ;
   * « Sans poste » le retire. Les postes s'ajoutent ou se retirent sur la carte.
   */
  function assignmentSection() {
    const { participants, proposal, day_post_ids, hunt } = dv.hunt;
    const editable = !hunt.started_at;
    const postsById = new Map(dv.territory.posts.map((p) => [p.id, p]));
    const dayPosts = day_post_ids.map((id) => postsById.get(id)).filter(Boolean).sort((a, b) => a.number - b.number);
    const posted = participants.filter((p) => p.present && POSTED_ROLES.includes(p.role));
    const picked = posted.find((p) => p.id === dv.picked) ?? null;
    if (!picked) dv.picked = null;
    const sameAsProposal = proposal && proposal.post_ids.length === day_post_ids.length && proposal.post_ids.every((id) => day_post_ids.includes(id));

    const moveTo = (post) => {
      const p = picked;
      dv.picked = null;
      if (!post) return act(() => api.del(`/hunts/${hunt.id}/assignments/${p.id}`));
      if (p.post_id === post.id) return render();
      const occupied = participants.some((x) => x.post_id === post.id && x.id !== p.id);
      act(() => api.put(`/hunts/${hunt.id}/assignments`, { participant_id: p.id, post_id: post.id, mode: occupied && dv.allowDouble ? 'double' : 'move' }));
    };
    const chip = (p, post) => h('button.chip', {
      type: 'button',
      disabled: !editable,
      class: `${p.id === dv.picked ? 'picked' : ''} ${post && !canReach(post.difficulty, p.walking_ability) ? 'too-hard' : ''}`,
      title: post && !canReach(post.difficulty, p.walking_ability) ? 'Poste plus difficile que sa marche' : '',
      onclick: (e) => {
        e.stopPropagation();
        if (!dv.picked) { dv.picked = p.id; return render(); }
        if (dv.picked === p.id) { dv.picked = null; return render(); }
        moveTo(post);
      },
    }, p.role === 'chef_de_ligne' ? h('span.chef', { title: 'Chef de ligne' }, '★ ') : null, p.name, p.walking_ability ? h('span.walk', ` 🥾${p.walking_ability}`) : null, post && !canReach(post.difficulty, p.walking_ability) ? ' ⚠' : '');
    const row = (post, people, label, extra) => h('li.assign-row', {
      class: picked ? 'target' : '',
      onclick: () => picked && moveTo(post),
    }, h('span.post-label', label, extra ? h('small', extra) : null), h('span.chips', people.map((p) => chip(p, post))));

    const unassigned = posted.filter((p) => !p.post_id);
    return step('postes', '2. Postes', `${dayPosts.length} pour ${posted.length} posté(s)${hunt.assignments_published_at ? ' · publiés' : ''}`, true,
      editable && proposal?.post_ids.length && !sameAsProposal
        ? h('button', { onclick: async () => {
            const nobodyPlaced = !participants.some((x) => x.post_id);
            if (await act(() => api.put(`/hunts/${hunt.id}/posts`, { post_ids: proposal.post_ids }), 'Postes du plan choisis.') && nobodyPlaced) await autoPlace();
          } },
            proposal.plan_count ? `Prendre les postes du plan « ${hunt.hunt_plan_name} » à ${proposal.plan_count} chasseurs (${proposal.post_ids.length})` : `Prendre la proposition (${proposal.post_ids.length} postes)`)
        : null,
      editable ? (picked ? h('p.small.alert.muted', `Touchez le poste où placer ${picked.name}.`)
        : h('details.legend.small.muted', h('summary', 'ⓘ Aide'), 'Touchez un nom puis un poste pour le déplacer (échange si occupé). Postes : ajout et retrait sur la carte. ⛰ difficulté d’accès · 🥾 marche · ★ chef de ligne.')) : null,
      h('label.check.small', h('input', { type: 'checkbox', checked: dv.showPostNames, onchange: (e) => {
        dv.showPostNames = e.target.checked;
        try { localStorage.setItem(NAMES_KEY, e.target.checked ? '1' : '0'); } catch { /* rien */ }
        render();
      } }), 'Noms des postes'),
      dayPosts.length || unassigned.length
        ? h('ul.plain.assign-list',
            groupByLine(dayPosts).map(({ line, posts: lp }) => [
              line || (dv.territory.lines ?? []).length ? h('li.line-head', lineHeader(line, lp, participants)) : null,
              lp.map((post) => row(post, participants.filter((p) => p.post_id === post.id),
                [String(post.number), dv.showPostNames && post.name ? h('span.post-name', ` ${post.name}`) : null],
                `${post.difficulty ? ` ⛰${post.difficulty}` : ''}${post.parking_id ? '' : ' · sans P'}`)),
            ]),
            unassigned.length || picked ? row(null, unassigned, 'Sans poste', '') : null)
        : h('p.muted', 'Choisissez les postes sur la carte.'),
      editable && dayPosts.length
        ? h('div.buttons',
            unassigned.length ? h('button', { onclick: () => autoPlace(), title: 'Rotation : chacun évite ses postes récents' }, `Placer les ${unassigned.length} sans poste`) : null,
            participants.some((p) => p.post_id) ? h('button', { onclick: async () => {
              if (await confirmDialog('Tout replacer', 'Refaire tout le placement (rotation des postes) ? Les placements faits à la main seront perdus.', 'Tout replacer')) autoPlace(true);
            }, title: 'Rotation : chacun évite ses postes récents' }, '🔄 Tout replacer') : null,
            participants.some((p) => p.post_id) ? h('button.link', { onclick: () => act(() => api.del(`/hunts/${hunt.id}/assignments`)) }, 'Tout effacer') : null,
            proposal?.kind === 'too_many' ? h('label.check', h('input', { type: 'checkbox', checked: dv.allowDouble, onchange: (e) => { dv.allowDouble = e.target.checked; } }), 'Doublons') : null)
        : null,
      editable ? h('button.primary', { disabled: !dayPosts.length, onclick: () => act(() => api.post(`/hunts/${hunt.id}/publish-assignments`), 'Postes publiés.') },
        hunt.assignments_published_at ? 'Republier les postes' : 'Publier les postes') : null,
      hunt.assignments_published_at && editable ? h('span.small.muted', ` publiés à ${timeOf(hunt.assignments_published_at)}`) : null);
  }

  /** Postes du jour groupés par ligne (ordre des noms de ligne), puis hors ligne. */
  function groupByLine(posts) {
    const lines = new Map((dv.territory.lines ?? []).map((l) => [l.id, l]));
    const groups = new Map();
    for (const p of posts) {
      const key = lines.has(p.line_id) ? p.line_id : '';
      if (!groups.has(key)) groups.set(key, { line: lines.get(key) ?? null, posts: [] });
      groups.get(key).posts.push(p);
    }
    return [...groups.values()].sort((a, b) => (a.line ? 0 : 1) - (b.line ? 0 : 1) || (a.line?.name ?? '').localeCompare(b.line?.name ?? '', 'fr'));
  }

  /** En-tête d'une ligne : nom et chef(s) de ligne (le chef de ligne est placé sur un poste de sa ligne). */
  function lineHeader(line, posts, participants) {
    if (!line) return h('span.muted', 'Hors ligne');
    const ids = new Set(posts.map((p) => p.id));
    const chiefs = participants.filter((p) => p.role === 'chef_de_ligne' && ids.has(p.post_id));
    return [h('strong', line.name), ' · ',
      chiefs.length ? h('span', `chef de ligne : ${chiefs.map((c) => c.name).join(', ')}`)
        : h('span.warn-text', { title: 'Passez un participant en « Chef de ligne » (bloc 1) et placez-le sur un poste de cette ligne.' }, '⚠ pas de chef de ligne')];
  }

  /** Espèces tirables et quotas de cette battue (vides = sans limite fixée). */
  function speciesEditor() {
    const { hunt } = dv.hunt;
    const editable = hunt.status === 'en_cours';
    const rows = dv.hunt.species.map((x) => ({ ...x }));
    const save = () => act(() => api.put(`/hunts/${hunt.id}/species`, { species: rows.filter((r) => r.species.trim()) }), 'Espèces enregistrées.');
    const name = h('input', { list: 'species-list', placeholder: 'Espèce (ex. Sanglier)', maxlength: 60 });
    const quota = h('input', { type: 'number', min: 0, max: 999, placeholder: 'nombre' });
    return step('especes', '3. Espèces', rows.length ? rows.map((r) => `${r.species}${r.quota != null ? ` ${r.quota}` : ''}`).join(', ') : 'aucune précisée', false,
      rows.length
        ? h('table.list.compact', h('tbody', rows.map((r, i) => h('tr',
            h('td', r.species, seasonLeft(r.species)),
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
      h('datalist', { id: 'species-list' }, [...new Set([...(dv.hunt.season_species ?? []).map((x) => x.species), ...COMMON_SPECIES])].map((x) => h('option', { value: x })))) : null);
  }

  /** Reste du quota de la saison pour une espèce (« reste 12/40 »). */
  function seasonLeft(species) {
    const ss = (dv.hunt.season_species ?? []).find((x) => x.species === species);
    if (!ss || ss.season_quota == null) return null;
    const left = ss.season_quota - ss.harvested;
    return h('span.small', { class: left <= 0 ? 'warn-text' : 'muted', title: `Saison : ${ss.harvested} prélevé(s) sur ${ss.season_quota}` }, ` · reste ${Math.max(0, left)}/${ss.season_quota}`);
  }

  function carpoolSection() {
    const c = dv.carpool;
    if (!c) return null;
    return step('covoit', '4. Covoiturage', `${c.cars.length} voiture(s)${c.cars.length < c.carsAdvised ? ' · ⚠' : ''}`, false,
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
    return step('place', '5. Mise en place', `${r.ready}/${r.rows.length} confirmé(s)`, true,
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
    return step('prelev', `Prélèvements · battue ${hunt.number}`, String(harvests.length), true,
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
        battuesList(),
        run && dv.hunt
          // Ordre des actions ; prélèvements seulement une fois la battue lancée.
          ? [h('div.battue', battueHeader(), volunteersSection(), assignmentSection(), speciesEditor(), carpoolSection(), readinessSection(),
              dv.hunt.hunt.started_at ? harvestSection() : null, battueActions())]
          : [last?.status === 'terminee' ? regroupForm() : null, newBattueForm(),
             last && dv.hunt ? harvestSection() : null],
        // Rendez-vous, déjeuner, consignes et convocations : acquis, la journée a commencé.
      ];
    } else {
      sections = [battuesList(), last && dv.hunt ? harvestSection() : null];
    }
    fill(box,
      h('h1', `Journée du ${formatHuntDate(day.date)}`),
      h('p', `Rendez-vous à ${formatTime(day.meeting_time)}${day.meeting_place ? `, ${day.meeting_place}` : ''} · `, h('span.status', { class: `status-${day.status}` }, DAY_STATUS_LABELS[day.status])),
      // En préparation : on règle d'abord, les boutons (envoyer, supprimer…) viennent en bas.
      ['brouillon', 'convoquee'].includes(day.status) ? [sections, actionsSection()] : [actionsSection(), sections],
    );
    renderMap();
  }

  try {
    const [members, territories, places] = await Promise.all([api.get('/members'), api.get('/territories'), api.get('/places')]);
    dv.members = members.members;
    dv.places = places;
    dv.territories = territories.territories.filter((t) => t.in_season !== false); // saison en cours
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
