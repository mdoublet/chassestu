// Vue chasseur : quoi faire maintenant (bandeau), où se rendre (itinéraires),
// consignes, espèces et quotas, prélèvements en direct, mon poste et mes
// voisins, carte. Pour tous : chasseurs, responsables, président, invités.
// Se met à jour automatiquement (numéro de version de la battue).
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon, parkingIcon } from '../map/shapes.js';
import { api } from '../api.js';
import { h, fill, toast, errorMessage } from '../ui.js';
import { watchRevision, every } from '../lib/live.js';
import {
  STATUS_LABELS, ROLE_LABELS, CATEGORY_LABELS, COMMON_SPECIES,
  formatHuntDate, formatTime, hunterInstruction, navigationLinks,
} from '../lib/hunts.js';

function navButtons(label, coords) {
  const links = navigationLinks(coords);
  return h('div.nav-links',
    h('span', label),
    h('a.button', { href: links.google, target: '_blank', rel: 'noopener' }, 'Google Maps'),
    h('a.button', { href: links.waze, target: '_blank', rel: 'noopener' }, 'Waze'),
    h('a.button', { href: links.apple, target: '_blank', rel: 'noopener' }, 'Plans'),
  );
}

/**
 * Crée la vue ; `update(sheet)` la remet à jour sans recréer la carte.
 * @param {{ onRespond?: Function, onDeclare?: Function, onWithdraw?: Function }} actions
 */
export function createSheetView(container, actions = {}) {
  ensureHatchPattern();
  const info = h('div.sheet-info');
  const mapEl = h('div.sheet-map');
  fill(container, info, mapEl);
  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  addBasemaps(map);
  const layers = L.featureGroup().addTo(map);
  let fittedFor = null;

  function renderInfo(sheet) {
    const { hunt, me, post, neighbors, territory } = sheet;
    const step = hunterInstruction(sheet);
    const chefs = hunt.chefs_de_ligne?.length ? hunt.chefs_de_ligne.join(', ') : null;
    const canDeclare = me && hunt.status === 'en_cours' && actions.onDeclare;

    const speciesBox = sheet.species?.length
      ? h('section.card',
          h('h3', 'Espèces chassées'),
          h('ul.plain.species', sheet.species.map((s) => {
            const full = s.quota !== null && s.taken >= s.quota;
            return h('li', { class: full ? 'full' : '' },
              h('strong', s.s),
              h('span', s.quota === null ? `${s.taken} prélevé(s)` : `${s.taken} / ${s.quota}`),
              s.quota !== null ? h('progress', { max: Math.max(s.quota, 1), value: Math.min(s.taken, s.quota) }) : null,
              full ? h('span.badge.danger', 'quota atteint : ne plus tirer') : null);
          })))
      : null;

    const species = h('select', { 'aria-label': 'Espèce' },
      [...new Set([...(sheet.species ?? []).map((s) => s.s), ...COMMON_SPECIES])].map((s) => h('option', { value: s }, s)));
    const category = h('select', { 'aria-label': 'Catégorie' }, Object.entries(CATEGORY_LABELS).map(([v, l]) => h('option', { value: v, selected: v === 'indetermine' }, l)));
    const notes = h('input', { placeholder: 'Remarque (facultatif)', maxlength: 500 });

    const harvestBox = (sheet.harvests?.length || canDeclare)
      ? h('section.card',
          h('h3', `Prélèvements (${sheet.harvests.length})`),
          sheet.harvests.length
            ? h('ul.plain.harvests', sheet.harvests.map((x) => h('li',
                h('span', h('strong', x.species), ` ${CATEGORY_LABELS[x.category]}`, x.shooter ? ` — ${x.shooter}${x.post_number ? ` (poste ${x.post_number})` : ''}` : '', x.notes ? ` · ${x.notes}` : ''),
                h('span.small.muted', new Date(x.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })),
                x.mine && hunt.status === 'en_cours' && actions.onWithdraw ? h('button.link.danger', { onclick: () => actions.onWithdraw(x) }, 'Retirer') : null)))
            : h('p.small.muted', 'Aucun prélèvement pour l’instant.'),
          canDeclare
            ? h('form.row.declare', {
                onsubmit: (e) => {
                  e.preventDefault();
                  actions.onDeclare({ species: species.value, category: category.value, notes: notes.value.trim() });
                },
              }, species, category, notes, h('button.primary', { type: 'submit' }, 'Déclarer un prélèvement'))
            : null)
      : null;

    const postCard = post
      ? h('section.card.my-post',
          h('h2', `Votre poste : ${post.number}${post.name ? ` · ${post.name}` : ''}`),
          post.shared_with?.length ? h('p', `Poste partagé avec ${post.shared_with.join(', ')}.`) : null,
          post.instructions ? h('p.alert.warn', post.instructions) : null,
          post.parking ? navButtons(`🚗 Parking « ${post.parking.name} » :`, post.parking.geom.coordinates) : null,
          h('p.small', post.access_path ? `🥾 Chemin à pied : ${post.access_path_length_m} m depuis le parking (pointillés sur la carte).` : 'Pas de chemin tracé : repérez le poste sur la carte.'))
      : null;

    const line = neighbors.length
      ? h('section.card',
          h('h3', me && !sheet.show_all_posts ? 'Vos voisins' : 'Ligne de postes'),
          h('ul.plain', neighbors.map((n) => h('li', `${n.side === 'gauche' ? '◀ ' : n.side === 'droite' ? '▶ ' : ''}Poste ${n.number}${n.name ? ` · ${n.name}` : ''} : ${n.occupant ?? 'libre'}`))),
          me ? h('p.small.muted', 'Information de sécurité : ne tirez jamais en direction de vos voisins.') : null)
      : null;

    const respond = actions.onRespond && me && !me.guest && hunt.status === 'publiee'
      ? h('div.buttons',
          h('button', { class: me.response === 'present' ? 'primary' : '', onclick: () => actions.onRespond('present') }, 'Présent'),
          h('button', { class: me.response === 'absent' ? 'primary' : '', onclick: () => actions.onRespond('absent') }, 'Absent'))
      : null;

    fill(
      info,
      me?.guest ? h('p.notice', `Bonjour ${me.name} : accès invité, valable pour cette battue seulement.`) : null,
      h('section.status-banner', { class: `tone-${step.tone}` }, h('strong', step.title), step.text ? h('span', step.text) : null, respond),
      h('h1', `${territory.name} · ${formatHuntDate(hunt.date)}`),
      h('p.small', h('span.status', { class: `status-${hunt.status}` }, STATUS_LABELS[hunt.status]),
        me ? ` · vous : ${ROLE_LABELS[me.role].toLowerCase()}` : '',
        hunt.leader ? ` · responsable : ${hunt.leader}` : '', chefs ? ` · chef(s) de ligne : ${chefs}` : ''),
      h('section.card',
        h('h3', 'Rendez-vous'),
        h('p', `${formatTime(hunt.meeting_time)}${hunt.meeting_place ? ` · ${hunt.meeting_place}` : ''}`),
        hunt.meeting_point ? navButtons('🚗 Itinéraire :', hunt.meeting_point.coordinates) : null),
      postCard,
      hunt.briefing ? h('section.card', h('h3', 'Consignes'), h('p.pre', hunt.briefing)) : null,
      speciesBox,
      harvestBox,
      line,
      h('p.small.muted.live', `Mise à jour automatique · ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`),
    );
  }

  function renderMap(sheet) {
    const { hunt, post, territory } = sheet;
    layers.clearLayers();
    const tLayer = L.geoJSON(territory.geom, { style: { color: '#1f5130', weight: 3, fillOpacity: 0.04 }, interactive: false });
    layers.addLayer(tLayer);
    if (sheet.exclusion) layers.addLayer(L.geoJSON(sheet.exclusion, { style: { color: '#d9480f', weight: 1, fillOpacity: 1, className: 'exclusion-shape' }, interactive: false }));
    for (const r of sheet.reserves ?? []) layers.addLayer(L.geoJSON(r, { style: { color: '#c92a2a', weight: 1, fillOpacity: 1, className: 'reserve-shape' }, interactive: false }));
    let focus = null;
    if (post) {
      if (post.access_path) layers.addLayer(L.polyline(post.access_path.coordinates.map(toLatLng), { color: '#5c3d1e', weight: 5, dashArray: '2 8', lineCap: 'round' }));
      if (post.parking) layers.addLayer(L.marker(toLatLng(post.parking.geom.coordinates), { icon: parkingIcon() }).bindTooltip(escapeHtml(post.parking.name)));
      focus = L.marker(toLatLng(post.geom.coordinates), { icon: postIcon(post.number, 'selected mine') }).bindTooltip('Votre poste', { permanent: true, direction: 'top', offset: [0, -14] });
      layers.addLayer(focus);
    }
    if (hunt.meeting_point) layers.addLayer(L.circleMarker(toLatLng(hunt.meeting_point.coordinates), { radius: 8, color: '#0b6bcb', fillOpacity: 0.9 }).bindTooltip('Rendez-vous'));
    // Recadrer seulement quand l'objet principal change (sinon on garde le zoom de l'utilisateur).
    const key = post ? `post:${post.number}` : 'territory';
    if (fittedFor !== key) {
      fittedFor = key;
      const bounds = post
        ? L.featureGroup([focus, ...(post.parking ? [L.marker(toLatLng(post.parking.geom.coordinates))] : [])]).getBounds().pad(0.6)
        : tLayer.getBounds();
      map.fitBounds(bounds, { maxZoom: 16 });
    }
  }

  // Pas de rafraîchissement pendant une saisie (formulaire de prélèvement) :
  // la mise à jour attend que le champ perde le focus.
  let pending = null;
  const editing = () => info.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  function apply(sheet) {
    if (editing()) {
      pending = sheet;
      return;
    }
    pending = null;
    renderInfo(sheet);
    renderMap(sheet);
  }
  info.addEventListener('focusout', () => setTimeout(() => pending && !editing() && apply(pending), 0));

  setTimeout(() => map.invalidateSize(), 0);
  return {
    update: apply,
    destroy() {
      map.remove();
    },
  };
}

/** Vue chasseur d'un membre connecté (convoqué, ou responsable en vue d'ensemble). */
export async function memberSheetView(main, huntId) {
  let view = null;
  let watcher = null;
  const load = async () => view.update((await api.get(`/hunts/${huntId}/view`)).sheet);
  const act = async (fn, msg) => {
    try {
      const res = await fn();
      if (res?.sheet) view.update(res.sheet);
      else await load();
      await watcher?.sync();
      if (msg) toast(msg);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  view = createSheetView(main, {
    onRespond: (response) => act(() => api.post(`/hunts/${huntId}/respond`, { response }), 'Réponse enregistrée.'),
    onDeclare: (body) => act(() => api.post(`/hunts/${huntId}/harvests`, body), `${body.species} déclaré.`),
    onWithdraw: (x) => act(() => api.del(`/hunts/${huntId}/harvests/${x.id}`), 'Déclaration retirée.'),
  });
  try {
    await load();
  } catch (err) {
    fill(main, h('p.error', errorMessage(err)));
    view.destroy();
    return null;
  }
  watcher = watchRevision(() => api.get(`/hunts/${huntId}/revision`), load);
  return () => {
    watcher.stop();
    view.destroy();
  };
}

/** Vue d'un invité (lien sans compte) : rafraîchie toutes les 20 secondes. */
export async function guestSheetView(main, token) {
  const load = async () => (await api.get(`/guest/${token}`, { tenant: false })).sheet;
  let view;
  try {
    const sheet = await load();
    view = createSheetView(main);
    view.update(sheet);
  } catch (err) {
    main.append(h('h1', 'Battue'), h('p.error', errorMessage(err)));
    return null;
  }
  const stop = every(20_000, async () => {
    try {
      view.update(await load());
    } catch (err) {
      if (err.status === 410) toast(errorMessage(err), 'warn');
    }
  });
  return () => {
    stop();
    view.destroy();
  };
}
