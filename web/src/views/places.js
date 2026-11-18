// Lieux de l'association (président) : cabanes, restaurants, autres points
// de rendez-vous ou de regroupement, en plus des parkings des territoires.
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng } from '../map/shapes.js';
import { api } from '../api.js';
import { h, fill, toast, errorMessage, confirmDialog } from '../ui.js';
import { PLACE_KINDS } from './place-picker.js';

const ICON = { cabane: '🛖', restaurant: '🍽', autre: '📍' };

export async function placesView(main) {
  const st = { places: [], parkings: [], editing: null, placing: false, draft: null };
  const list = h('div');
  const mapEl = h('div.places-map');
  main.append(h('h1', 'Lieux'),
    h('p.muted.small', 'Points de rendez-vous et de regroupement (cabane, restaurant…). Les parkings des territoires sont aussi proposés.'),
    h('div.places-layout', list, mapEl));
  const map = L.map(mapEl).setView([46.6, 2.4], 6);
  addBasemaps(map);
  const layer = L.featureGroup().addTo(map);
  let fitted = false;

  const icon = (txt, cls = '') => L.divIcon({ className: `place-icon ${cls}`, html: `<span>${txt}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  async function load() {
    const res = await api.get('/places');
    st.places = res.places;
    st.parkings = res.parkings;
    render();
  }

  function drawMap() {
    layer.clearLayers();
    // Pendant le placement, les icônes laissent passer le clic jusqu'à la carte.
    const interactive = !st.placing;
    for (const p of st.parkings) layer.addLayer(L.marker(toLatLng(p.geom.coordinates), { icon: icon('P', 'parking'), interactive }).bindTooltip(escapeHtml(`Parking ${p.name} (${p.territory_name})`)));
    for (const p of st.places) {
      const m = L.marker(toLatLng(p.geom.coordinates), { icon: icon(ICON[p.kind], st.editing === p.id ? 'selected' : ''), interactive }).bindTooltip(escapeHtml(p.name));
      m.on('click', () => { st.editing = p.id; render(); });
      layer.addLayer(m);
    }
    if (st.draft?.geom) layer.addLayer(L.marker(toLatLng(st.draft.geom.coordinates), { icon: icon('✚', 'selected') }));
    if (!fitted && layer.getLayers().length) {
      fitted = true;
      map.fitBounds(layer.getBounds().pad(0.3), { maxZoom: 15 });
    }
  }

  map.on('click', (e) => {
    if (!st.placing) return;
    st.placing = false;
    const geom = { type: 'Point', coordinates: [e.latlng.lng, e.latlng.lat] };
    if (st.draft) {
      st.draft.geom = geom;
      render();
    } else if (st.editing) {
      save(st.editing, { geom }, 'Lieu déplacé.');
    }
  });

  async function save(id, body, msg) {
    try {
      if (id) await api.patch(`/places/${id}`, body);
      else await api.post('/places', body);
      toast(msg);
      st.draft = null;
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const kindSelect = (value, onchange) => h('select', { onchange }, Object.entries(PLACE_KINDS).map(([k, l]) => h('option', { value: k, selected: k === value }, l)));
  const placeHere = (target) => [
    h('button', { type: 'button', onclick: () => { st.placing = true; drawMap(); toast('Cliquez sur la carte à l’emplacement du lieu.'); } }, target ? 'Déplacer sur la carte' : 'Placer sur la carte'),
    h('button', { type: 'button', onclick: () => navigator.geolocation?.getCurrentPosition((p) => {
      const geom = { type: 'Point', coordinates: [p.coords.longitude, p.coords.latitude] };
      if (st.draft) { st.draft.geom = geom; render(); } else save(target, { geom }, 'Lieu déplacé.');
    }, () => toast('Position indisponible.', 'error'), { enableHighAccuracy: true, timeout: 15000 }) }, 'Ma position'),
  ];

  function render() {
    const draft = st.draft;
    const form = draft
      ? h('form.card', { onsubmit: (e) => {
          e.preventDefault();
          if (!draft.geom) return toast('Placez le lieu sur la carte.', 'error');
          save(null, { name: draft.name, kind: draft.kind, geom: draft.geom, notes: draft.notes }, 'Lieu ajouté.');
        } },
        h('label', 'Nom', h('input', { required: true, maxlength: 200, value: draft.name, oninput: (e) => { draft.name = e.target.value; }, placeholder: 'ex. Cabane du Lampy' })),
        h('label', 'Type', kindSelect(draft.kind, (e) => { draft.kind = e.target.value; })),
        h('label', 'Note (facultatif)', h('input', { maxlength: 500, value: draft.notes, oninput: (e) => { draft.notes = e.target.value; } })),
        h('div.buttons', placeHere(null)),
        h('p.small', draft.geom ? '✔ Emplacement choisi.' : 'Emplacement : à placer sur la carte.'),
        h('div.buttons', h('button.primary', { type: 'submit' }, 'Ajouter'), h('button.link', { type: 'button', onclick: () => { st.draft = null; render(); } }, 'Annuler')))
      : h('button.primary', { onclick: () => { st.draft = { name: '', kind: 'cabane', notes: '', geom: null }; st.editing = null; render(); } }, '+ Nouveau lieu');

    fill(list,
      form,
      st.places.length
        ? h('ul.plain.places-list', st.places.map((p) => h('li', { class: st.editing === p.id ? 'editing' : '' },
            st.editing === p.id
              ? h('div.place-edit',
                  h('input', { value: p.name, maxlength: 200, 'aria-label': 'Nom', onchange: (e) => save(p.id, { name: e.target.value }, 'Nom enregistré.') }),
                  kindSelect(p.kind, (e) => save(p.id, { kind: e.target.value }, 'Type enregistré.')),
                  h('input', { value: p.notes, maxlength: 500, placeholder: 'Note', 'aria-label': 'Note', onchange: (e) => save(p.id, { notes: e.target.value }, 'Note enregistrée.') }),
                  h('div.buttons', placeHere(p.id),
                    h('button.link.danger', { onclick: async () => {
                      if (!(await confirmDialog('Supprimer', `Supprimer « ${p.name} » ?`, 'Supprimer', true))) return;
                      try { await api.del(`/places/${p.id}`); st.editing = null; await load(); } catch (err) { toast(errorMessage(err), 'error'); }
                    } }, 'Supprimer'),
                    h('button.link', { onclick: () => { st.editing = null; render(); } }, 'Fermer')))
              : h('button.link.place-name', { onclick: () => { st.editing = p.id; st.draft = null; map.setView(toLatLng(p.geom.coordinates), 15); render(); } },
                  `${ICON[p.kind]} ${p.name}`, h('span.small.muted', ` · ${PLACE_KINDS[p.kind]}${p.notes ? ` · ${p.notes}` : ''}`)))))
        : h('p.muted', 'Aucun lieu pour l’instant.'),
      st.parkings.length ? h('details', h('summary', `Parkings des territoires (${st.parkings.length})`),
        h('ul.plain.small', st.parkings.map((p) => h('li', `🅿 ${p.name} · ${p.territory_name}`)))) : null);
    drawMap();
  }

  try {
    await load();
  } catch (err) {
    fill(list, h('p.error', errorMessage(err)));
  }
  setTimeout(() => map.invalidateSize(), 0);
  return () => map.remove();
}
