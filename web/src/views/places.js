// Lieux de l'association : cabanes, restaurants, autres points de rendez-vous
// ou de regroupement, en plus des parkings des territoires. Le président les
// gère ; chaque chasseur enregistre ses propres lieux (privés), que le
// président peut rendre publics.
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng } from '../map/shapes.js';
import { api } from '../api.js';
import { h, fill, toast, errorMessage, confirmDialog, promptDialog } from '../ui.js';
import { kindIcon, kindLabel, kindSelect as pickKind } from './place-picker.js';
import { setInSeason } from '../lib/season.js';
import { navIcon } from '../lib/navigation.js';
import { shrinkPhoto, photoThumb, photoIcon } from '../lib/photo.js';
import { fold } from '../ui.js';
import { state } from '../state.js';


export async function placesView(main) {
  const st = { places: [], parkings: [], editing: null, placing: false, draft: null };
  const isPres = state.role === 'president';
  const canEdit = (p) => isPres || (p.mine && p.visibility === 'private');
  const list = h('div');
  const mapEl = h('div.places-map');
  main.append(h('h1', 'Lieux'),
    h('div.places-layout', list, mapEl));
  const map = L.map(mapEl).setView([46.6, 2.4], 6);
  if (import.meta.env.DEV) window.__placesMap = map; // tests et démonstrations (jamais en production)
  addBasemaps(map);
  const layer = L.featureGroup().addTo(map);
  let fitted = false;

  const icon = (txt, cls = '') => L.divIcon({ className: `place-icon ${cls}`, html: `<span>${txt}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  async function load() {
    const res = await api.get('/places');
    st.places = res.places.filter((p) => p.in_season !== false);
    st.kinds = res.kinds ?? [];
    st.off = res.places.filter((p) => p.in_season === false);
    st.parkings = res.parkings;
    render();
  }

  function drawMap() {
    layer.clearLayers();
    // Pendant le placement, les icônes laissent passer le clic jusqu'à la carte.
    const interactive = !st.placing;
    for (const p of st.parkings) layer.addLayer(L.marker(toLatLng(p.geom.coordinates), { icon: icon('P', 'parking'), interactive }).bindTooltip(escapeHtml(`Parking ${p.name} (${p.territory_name})`)));
    for (const p of st.places) {
      const cls = [st.editing === p.id ? 'selected' : '', p.visibility === 'private' ? 'private' : ''].join(' ');
      const m = L.marker(toLatLng(p.geom.coordinates), { icon: icon(kindIcon(p.kind), cls), interactive }).bindTooltip(escapeHtml(p.visibility === 'private' ? `${p.name} (privé)` : p.name));
      if (canEdit(p)) m.on('click', () => { st.editing = p.id; render(); });
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

  async function save(id, body, msg, photo = null) {
    try {
      if (id) await api.patch(`/places/${id}`, body);
      else {
        const { place } = await api.post('/places', body);
        if (photo) await api.put(`/places/${place.id}/photo`, photo);
        st.editing = place.id;
      }
      toast(msg);
      st.draft = null;
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const kindSelect = (value, onchange) => pickKind(value, st.kinds, (k) => onchange({ target: { value: k } }), () => promptDialog('Nouveau type de lieu', 'Type (ex. salle des fêtes, carrefour)'));
  const placeHere = (target) => [
    h('button', { type: 'button', onclick: () => { st.placing = true; drawMap(); toast('Cliquez sur la carte à l’emplacement du lieu.'); } }, target ? 'Déplacer sur la carte' : 'Placer sur la carte'),
    h('button', { type: 'button', onclick: () => navigator.geolocation?.getCurrentPosition((p) => {
      const geom = { type: 'Point', coordinates: [p.coords.longitude, p.coords.latitude] };
      if (st.draft) { st.draft.geom = geom; render(); } else save(target, { geom }, 'Lieu déplacé.');
    }, () => toast('Position indisponible.', 'error'), { enableHighAccuracy: true, timeout: 15000 }) }, 'Ma position'),
  ];

  /**
   * Boutons photo : « Prendre » (appareil photo du téléphone) et « Importer »
   * (galerie, fichiers). `onfile(file)` reçoit l'image choisie.
   */
  const touch = matchMedia('(pointer: coarse)').matches;
  function photoButtons(has, onfile) {
    const pick = (capture) => {
      const input = h('input', { type: 'file', accept: 'image/*', hidden: true, ...(capture ? { capture: 'environment' } : {}) });
      input.onchange = () => { const f = input.files?.[0]; input.remove(); if (f) onfile(f); };
      document.body.append(input);
      input.click();
    };
    return [
      touch ? h('button', { type: 'button', onclick: () => pick(true) }, has ? '📷 Reprendre' : '📷 Prendre une photo') : null,
      h('button', { type: 'button', onclick: () => pick(false) }, touch ? '🖼 Importer' : has ? '📷 Changer la photo' : '📷 Ajouter une photo'),
    ];
  }

  /** Photo du lieu : prendre / importer (réduite avant l'envoi), remplacer, retirer. */
  function photoEditor(p) {
    return h('div.place-photo',
      p.has_photo ? photoThumb(h, p.id, p.photo_updated_at, p.name) : null,
      photoButtons(p.has_photo, async (file) => {
        try {
          toast('Envoi de la photo…');
          await api.put(`/places/${p.id}/photo`, await shrinkPhoto(file));
          toast('Photo enregistrée.');
          await load();
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      }),
      p.has_photo ? h('button.link.danger', { type: 'button', onclick: async () => {
        try { await api.del(`/places/${p.id}/photo`); await load(); } catch (err) { toast(errorMessage(err), 'error'); }
      } }, 'Retirer la photo') : null);
  }

  async function seasonLink(p, inSeason) {
    try {
      await setInSeason('places', p.id, inSeason);
      st.editing = null;
      toast(inSeason ? `${p.name} rattaché à la saison.` : `${p.name} retiré de la saison.`);
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function publish(p) {
    if (!(await confirmDialog('Rendre public', `« ${p.name} » sera visible de tous les membres et proposé pour les rendez-vous.`, 'Rendre public'))) return;
    await save(p.id, { visibility: 'public' }, `${p.name} est maintenant public.`);
  }

  /** Fiche d'un lieu modifiable (président, ou auteur d'un lieu privé). */
  function editRow(p) {
    const proposed = isPres && p.visibility === 'private' && !p.mine;
    return h('div.place-edit',
      proposed ? h('p.small', `Proposé par ${p.author ?? 'un chasseur'}.`) : null,
      h('input', { value: p.name, maxlength: 200, 'aria-label': 'Nom', onchange: (e) => save(p.id, { name: e.target.value }, 'Nom enregistré.') }),
      kindSelect(p.kind, (e) => save(p.id, { kind: e.target.value }, 'Type enregistré.')),
      h('input', { value: p.notes, maxlength: 500, placeholder: 'Note', 'aria-label': 'Note', onchange: (e) => save(p.id, { notes: e.target.value }, 'Note enregistrée.') }),
      photoEditor(p),
      h('div.buttons', placeHere(p.id),
        isPres && p.visibility === 'private' ? h('button.primary', { onclick: () => publish(p) }, '🌐 Rendre public') : null,
        isPres && p.visibility === 'public' ? h('button.link', { onclick: () => seasonLink(p, false), title: 'Sans le supprimer' }, 'Retirer de la saison') : null,
        h('button.link.danger', { onclick: async () => {
          if (!(await confirmDialog('Supprimer', `Supprimer « ${p.name} » ?`, 'Supprimer', true))) return;
          try { await api.del(`/places/${p.id}`); st.editing = null; await load(); } catch (err) { toast(errorMessage(err), 'error'); }
        } }, 'Supprimer'),
        h('button.link', { onclick: () => { st.editing = null; render(); } }, 'Fermer')));
  }

  function placeList(items, empty) {
    if (!items.length) return empty ? h('p.muted', empty) : null;
    return h('ul.plain.places-list', items.map((p) => h('li', { class: st.editing === p.id ? 'editing' : '' },
      st.editing === p.id && canEdit(p)
        ? editRow(p)
        : h('div.place-row',
            h('button.link.place-name', { onclick: () => { st.editing = canEdit(p) ? p.id : null; st.draft = null; map.setView(toLatLng(p.geom.coordinates), 15); render(); } },
              `${kindIcon(p.kind)} ${p.name}`,
              h('span.small.muted', ` · ${kindLabel(p.kind)}${isPres && p.visibility === 'private' && !p.mine ? ` · ${p.author ?? 'chasseur'}` : ''}${p.notes ? ` · ${p.notes}` : ''}`)),
            p.has_photo ? photoIcon(h, p.id, p.photo_updated_at, p.name) : null,
            navIcon(p.geom.coordinates, p.name)))));
  }

  function render() {
    const draft = st.draft;
    const form = draft
      ? h('form.card', { onsubmit: (e) => {
          e.preventDefault();
          if (!draft.geom) return toast('Placez le lieu sur la carte.', 'error');
          save(null, { name: draft.name, kind: draft.kind, geom: draft.geom, notes: draft.notes }, isPres ? 'Lieu ajouté.' : 'Lieu enregistré (visible de vous seul).', draft.photo);
        } },
        h('label', 'Nom', h('input', { required: true, maxlength: 200, value: draft.name, oninput: (e) => { draft.name = e.target.value; }, placeholder: isPres ? 'ex. Cabane du Lampy' : 'ex. Mon affût du chêne' })),
        h('label', 'Type', kindSelect(draft.kind, (e) => { draft.kind = e.target.value; if (!st.kinds.includes(draft.kind)) { st.kinds = [...st.kinds, draft.kind]; render(); } })),
        h('label', 'Note (facultatif)', h('input', { maxlength: 500, value: draft.notes, oninput: (e) => { draft.notes = e.target.value; } })),
        h('div.buttons', placeHere(null)),
        h('p.small', draft.geom ? '✔ Emplacement choisi.' : 'Emplacement : à placer sur la carte.'),
        h('div.place-photo',
          photoButtons(!!draft.photo, async (file) => {
            try { draft.photo = await shrinkPhoto(file); render(); } catch (err) { toast(errorMessage(err), 'error'); }
          }),
          draft.photo ? h('span.small', '✔ Photo jointe') : null),
        isPres ? null : h('p.small.muted', 'Visible de vous seul ; le président pourra le rendre public.'),
        h('div.buttons', h('button.primary', { type: 'submit' }, 'Ajouter'), h('button.link', { type: 'button', onclick: () => { st.draft = null; render(); } }, 'Annuler')))
      : h('button.primary', { onclick: () => { st.draft = { name: '', kind: isPres ? 'cabane' : 'autre', notes: '', geom: null, photo: null }; st.editing = null; render(); } }, '+ Nouveau lieu');

    const pub = st.places.filter((p) => p.visibility !== 'private');
    const mine = st.places.filter((p) => p.visibility === 'private' && p.mine);
    const proposed = st.places.filter((p) => p.visibility === 'private' && !p.mine);
    fill(list,
      form,
      placeList(pub, 'Aucun lieu pour l’instant.'),
      mine.length || !isPres ? fold('Mes lieux', { key: 'places.mine', open: true, extra: String(mine.length) },
        placeList(mine, 'Vos lieux à vous (affût, passage, point d’eau…), avec photo : « + Nouveau lieu ».')) : null,
      isPres && proposed.length ? fold('Proposés par les chasseurs', { key: 'places.proposed', open: true, extra: String(proposed.length) },
        h('p.small.muted', 'Visibles d’eux seuls tant que vous ne les rendez pas publics.'),
        placeList(proposed)) : null,
      st.parkings.length ? fold('Parkings des territoires', { key: 'places.parkings', extra: String(st.parkings.length) },
        h('ul.plain.small', st.parkings.map((p) => h('li', `🅿 ${p.name} · ${p.territory_name}`)))) : null,
      isPres && st.off?.length ? fold('Hors saison', { key: 'places.off', extra: String(st.off.length) },
        h('ul.plain', st.off.map((p) => h('li.off-row', h('span', `${kindIcon(p.kind)} ${p.name}`), h('button.link', { onclick: () => seasonLink(p, true) }, 'Rattacher à la saison'))))) : null);
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
