// Fiche « Ma battue » : rendez-vous, consignes, mon poste, mes voisins, carte.
// Même affichage pour un membre connecté et pour un invité (lien sans compte).
// Le guidage (voiture puis à pied, GPS) arrive au lot 5.
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon, parkingIcon } from '../map/shapes.js';
import { api } from '../api.js';
import { h, fill, toast, errorMessage } from '../ui.js';
import { STATUS_LABELS, ROLE_LABELS, formatHuntDate, formatTime } from '../lib/hunts.js';

export function renderSheet(container, sheet, { onRespond } = {}) {
  const { hunt, me, post, neighbors, territory } = sheet;
  ensureHatchPattern();
  const mapEl = h('div.sheet-map');
  const chefs = hunt.chefs_de_ligne?.length ? hunt.chefs_de_ligne.join(', ') : null;

  const postCard = post
    ? h(
        'section.card.my-post',
        h('h2', `Votre poste : ${post.number}${post.name ? ` · ${post.name}` : ''}`),
        post.shared_with?.length ? h('p', `Poste partagé avec ${post.shared_with.join(', ')}.`) : null,
        post.instructions ? h('p.alert.warn', post.instructions) : null,
        h('p.small', post.parking ? `Parking : ${post.parking.name}. ` : '', post.access_path ? `Chemin à pied : ${post.access_path_length_m} m (en pointillés sur la carte).` : 'Pas de chemin tracé.'),
        neighbors.length
          ? h('div',
              h('h3', sheet.show_all_posts ? 'Postes de la ligne' : 'Vos voisins'),
              h('ul.plain', neighbors.map((n) => h('li', `${n.side === 'gauche' ? '◀' : '▶'} Poste ${n.number}${n.name ? ` · ${n.name}` : ''} : ${n.occupant ?? 'libre'}`))),
              h('p.small.muted', 'Connaître ses voisins est une information de sécurité : ne tirez jamais dans leur direction.'),
            )
          : null,
      )
    : me.role === 'poste'
      ? h('section.card', h('p', hunt.status === 'en_cours' ? 'Les postes ne sont pas encore publiés : ils seront attribués au rond du matin.' : 'Votre poste sera attribué au rond du matin.'))
      : h('section.card', h('p', `Vous êtes ${ROLE_LABELS[me.role].toLowerCase()} : pas de poste fixe.`));

  const respond = onRespond && hunt.status === 'publiee'
    ? h(
        'section.card',
        h('p', me.response ? `Vous avez répondu ${me.response === 'present' ? 'présent' : 'absent'}.` : 'Serez-vous présent ?'),
        h('div.buttons',
          h('button', { class: me.response === 'present' ? 'primary' : '', onclick: () => onRespond('present') }, 'Présent'),
          h('button', { class: me.response === 'absent' ? 'primary' : '', onclick: () => onRespond('absent') }, 'Absent'),
        ),
      )
    : null;

  fill(
    container,
    me.guest ? h('p.notice', `Bonjour ${me.name} : accès invité, valable pour cette battue seulement.`) : null,
    h('h1', `Battue · ${territory.name}`),
    h('p', h('strong', formatHuntDate(hunt.date)), ` — rendez-vous à ${formatTime(hunt.meeting_time)}${hunt.meeting_place ? `, ${hunt.meeting_place}` : ''}`),
    h('p.small', h('span.status', { class: `status-${hunt.status}` }, STATUS_LABELS[hunt.status]),
      hunt.started_at && hunt.status === 'en_cours' ? ' · battue commencée' : '',
      hunt.leader ? ` · responsable : ${hunt.leader}` : '', chefs ? ` · chef(s) de ligne : ${chefs}` : ''),
    hunt.briefing ? h('section.card', h('h3', 'Consignes'), h('p.pre', hunt.briefing)) : null,
    respond,
    postCard,
    mapEl,
  );

  // Carte : territoire, zones, mon poste, chemin, parking, rendez-vous.
  const map = L.map(mapEl, { zoomControl: true });
  addBasemaps(map);
  const group = L.featureGroup().addTo(map);
  group.addLayer(L.geoJSON(territory.geom, { style: { color: '#1f5130', weight: 3, fillOpacity: 0.04 }, interactive: false }));
  if (sheet.exclusion) group.addLayer(L.geoJSON(sheet.exclusion, { style: { color: '#d9480f', weight: 1, fillOpacity: 1, className: 'exclusion-shape' }, interactive: false }));
  for (const r of sheet.reserves ?? []) group.addLayer(L.geoJSON(r, { style: { color: '#c92a2a', weight: 1, fillOpacity: 1, className: 'reserve-shape' }, interactive: false }));
  let focus = null;
  if (post) {
    if (post.access_path) group.addLayer(L.polyline(post.access_path.coordinates.map(toLatLng), { color: '#5c3d1e', weight: 5, dashArray: '2 8', lineCap: 'round' }));
    if (post.parking) group.addLayer(L.marker(toLatLng(post.parking.geom.coordinates), { icon: parkingIcon() }).bindTooltip(escapeHtml(post.parking.name)));
    focus = L.marker(toLatLng(post.geom.coordinates), { icon: postIcon(post.number, 'selected mine') }).bindTooltip('Votre poste', { permanent: true, direction: 'top', offset: [0, -14] });
    group.addLayer(focus);
  }
  if (hunt.meeting_point) {
    group.addLayer(L.circleMarker(toLatLng(hunt.meeting_point.coordinates), { radius: 8, color: '#0b6bcb', fillOpacity: 0.9 }).bindTooltip('Rendez-vous'));
  }
  const bounds = post ? L.featureGroup([focus, ...(post.parking ? [L.marker(toLatLng(post.parking.geom.coordinates))] : [])]).getBounds().pad(0.6) : group.getBounds();
  map.fitBounds(bounds, { maxZoom: 16 });
  setTimeout(() => map.invalidateSize(), 0);
  return () => map.remove();
}

/** Fiche d'un membre connecté. */
export async function memberSheetView(main, huntId) {
  let cleanup = null;
  async function load() {
    const { sheet } = await api.get(`/hunts/${huntId}/sheet`);
    if (cleanup) cleanup();
    cleanup = renderSheet(main, sheet, {
      onRespond: async (response) => {
        try {
          await api.post(`/hunts/${huntId}/respond`, { response });
          toast('Réponse enregistrée.');
          await load();
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      },
    });
  }
  try {
    await load();
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
  }
  return () => cleanup?.();
}

/** Fiche d'un invité (lien sans compte). */
export async function guestSheetView(main, token) {
  try {
    const { sheet } = await api.get(`/guest/${token}`, { tenant: false });
    return renderSheet(main, sheet);
  } catch (err) {
    main.append(h('h1', 'Battue'), h('p.error', errorMessage(err)));
    return null;
  }
}
