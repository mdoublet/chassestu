// Éditeur cartographique (lot 1) : territoires, réserves, parkings, postes et
// chemins d'accès sur fond IGN. Chaque modification est enregistrée
// immédiatement côté serveur (source de vérité) ; Ctrl+Z applique l'opération
// inverse (50 pas).
import L from '../map/leaflet.js';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon, parkingIcon, placeMarker } from '../map/shapes.js';
import { kindIcon } from './place-picker.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, confirmDialog, promptDialog, modal, fold } from '../ui.js';
import { History } from '../lib/history.js';
import { checkPost, selfIntersects } from '../lib/checks.js';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { geomCenter, streetViewUrl, satelliteUrl } from '../lib/streetview.js';
import { simplifyMeters, lineLengthMeters, distanceMeters } from '../lib/simplify.js';
import { parseGeoFile } from '../lib/importer.js';
import { DIFFICULTY_LABELS } from '../lib/hunts.js';
import { updatedPath, bestPathToPost } from '../lib/routing.js';
import { startCenter } from '../lib/start-center.js';
import { panelResizer } from '../map/resizer.js';

/** Champs nécessaires pour recréer un objet supprimé (annulation). */
const FIELDS = {
  reserves: ['name', 'reason', 'geom'],
  parkings: ['name', 'geom'],
  posts: ['number', 'name', 'geom', 'parking_id', 'line_id', 'access_path', 'instructions', 'special_instructions', 'active', 'access_difficulty'],
  dwellings: ['geom', 'comment', 'name'],
};
const LABEL = { territories: 'du territoire', reserves: 'de la réserve', parkings: 'du parking', posts: 'du poste', dwellings: 'de l’habitation' };

// Les clics sur les objets remontent à la carte : Geoman en a besoin pour
// dessiner par-dessus (réserve dans le territoire, chemin qui finit sur le
// poste). Le clic de sélection est marqué pour ne pas désélectionner aussitôt.
const STYLE = {
  territory: { color: '#1f5130', weight: 4, fillColor: '#2f7d4a', fillOpacity: 0.06 },
  territorySelected: { color: '#0b6bcb', weight: 4, fillOpacity: 0.08 },
  reserve: { color: '#c92a2a', weight: 2, fillOpacity: 1, className: 'reserve-shape' },
  path: { color: '#5c3d1e', weight: 4, dashArray: '2 8', lineCap: 'round' },
  pathSelected: { color: '#0b6bcb', weight: 5, dashArray: '2 8', lineCap: 'round' },
  recording: { color: '#d9480f', weight: 4, interactive: false },
  exclusion: { color: '#d9480f', weight: 1, fillOpacity: 1, className: 'exclusion-shape' },
  postArea: { color: '#1f5130', weight: 1.5, dashArray: '1 6', lineCap: 'round', fill: false },
  otherTerritory: { color: '#5f6b63', weight: 2, dashArray: '6 4', fillColor: '#5f6b63', fillOpacity: 0.05 },
  otherExclusion: { color: '#d9480f', weight: 0.5, fillOpacity: 0.45, className: 'exclusion-shape' },
  otherReserve: { color: '#c92a2a', weight: 1, fillOpacity: 0.45, className: 'reserve-shape' },
};

/** Style d'un bâtiment selon son état (rendu sur canvas : des centaines d'objets). */
function dwellingStyle(d, selected) {
  if (selected) return { color: '#0b6bcb', weight: 3, fillColor: '#0b6bcb', fillOpacity: 0.5, radius: 6 };
  if (d.ignored) return { color: '#7a7a7a', weight: 1, dashArray: '3 3', fillOpacity: 0, radius: 4 };
  if (d.source === 'manuel') return { color: '#7a3e00', weight: 2, fillColor: '#b35c00', fillOpacity: 0.8, radius: 6 };
  if (d.likely_non_residential || d.missing_since) return { color: '#7048e8', weight: 2, fillColor: '#9775fa', fillOpacity: 0.7, radius: 5 };
  return { color: '#343a40', weight: 1, fillColor: '#495057', fillOpacity: 0.8, radius: 5 };
}

const DRAW_HINTS = {
  territory: 'Zoomez sur le secteur, puis cliquez pour placer les sommets du territoire ; cliquez sur le premier sommet pour fermer.',
  reserves: 'Dessinez la zone de réserve ; cliquez sur le premier sommet pour fermer.',
  parkings: 'Cliquez sur la carte pour placer le parking.',
  posts: 'Cliquez sur la carte pour placer le poste : dans le territoire ou à sa lisière (pointillés verts), hors réserve et hors zone non chassable.',
  dwellings: 'Cliquez à l’emplacement de l’habitation manquante (construction récente, caravane habitée…).',
  path: 'Tracez le chemin à pied du parking jusqu’au poste ; cliquez sur le dernier point pour terminer.',
};

/** Zoom de création : 6 à 7 km de large sur ordinateur, 2 à 3 km sur téléphone. */
const CREATE_ZOOM = 14;

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));


function importSummary(report) {
  if (!report) return 'Bâtiments déjà à jour.';
  const parts = [`${report.total} bâtiment(s) IGN`];
  if (report.added) parts.push(`${report.added} nouveau(x)`);
  if (report.missing) parts.push(`${report.missing} disparu(s) de la BD TOPO (à vérifier)`);
  return `${parts.join(', ')}. Zone non chassable recalculée.`;
}

/** ⚠ : case « Consignes particulières » cochée, ou consignes contenant « attention ». */
const hasSpecial = (p) => Boolean(p.special_instructions) || /attention/i.test(p.instructions ?? '');

function postTooltip(p, bufferM = 150) {
  const label = `Poste ${p.number}${p.name ? ` · ${p.name}` : ''}`;
  if (p.invalid_reason) return `⛔ ${label} — invalide : à moins de ${bufferM} m d’une habitation, à déplacer`;
  const parts = [hasSpecial(p) ? `⚠ ${label} — consignes particulières` : label];
  if (p.nearest_dwelling_m != null) parts.push(`habitation à ${p.nearest_dwelling_m} m : ne pas tirer dans sa direction`);
  return parts.join(' — ');
}

/** `start` : identifiant d'un territoire à ouvrir, ou « nouveau » pour en créer un. */
export async function editorView(main, start) {
  const canEdit = state.role === 'president';
  const history = new History(50);
  const ed = {
    territories: [],
    territoryId: null,
    data: null, // { territory, reserves, parkings, posts }
    selected: null, // { kind, id }
    mode: null,
    recording: null,
    fitted: false,
    showAll: false, // les autres territoires : vue globale de la page Territoires
    overview: null, // { territories, reserves, posts, exclusions } de tout le tenant
    open: new Set(), // sections dépliées du panneau (fermées au départ)
    allDwellings: false, // liste des bâtiments : tout afficher
  };

  ensureHatchPattern();
  const panel = h('aside.panel');
  const mapEl = h('div.map');
  // Panneau élargissable : poignée à glisser (largeur mémorisée sur l'appareil).
  const resizer = panelResizer(panel, { key: 'chassestu.editorPanelWidth', onResize: () => map.invalidateSize() });
  main.append(h('div.editor', mapEl, resizer, panel));

  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  if (import.meta.env.DEV) window.__map = map; // tests de bout en bout (jamais en production)
  addBasemaps(map, { zones: true });
  map.pm.setLang('fr');
  map.pm.setGlobalOptions({ snappable: true, snapDistance: 20, allowSelfIntersection: false });

  // Bâtiments au-dessus du territoire et des zones (sinon le territoire prend le
  // clic), sous les postes. SVG : seuls les bâtiments captent le clic.
  map.createPane('dwellings');
  map.getPane('dwellings').style.zIndex = 450;
  // Canvas avec tolérance : un bâtiment de quelques pixels reste facile à toucher.
  const dwellingRenderer = L.canvas({ pane: 'dwellings', padding: 0.5, tolerance: 8 });
  const groups = {
    others: L.featureGroup().addTo(map), // autres territoires, sous le territoire actif
    territory: L.featureGroup().addTo(map),
    exclusion: L.featureGroup().addTo(map),
    dwellings: L.featureGroup().addTo(map),
    reserves: L.featureGroup().addTo(map),
    paths: L.featureGroup().addTo(map),
    places: L.featureGroup().addTo(map), // lieux de l'association (repères)
    parkings: L.featureGroup().addTo(map),
    posts: L.featureGroup().addTo(map),
  };

  // -------------------------------------------------------------------------
  // Données et opérations (toutes annulables)
  // -------------------------------------------------------------------------

  const itemPath = (kind, id) => (kind === 'territories' ? `/territories/${id}` : `/${kind}/${id}`);
  const find = (kind, id) => ed.data?.[kind]?.find((x) => x.id === id) ?? null;

  /** Zones calculées par le serveur, pour le contrôle des postes côté client. */
  const zonesFor = (data) => ({
    exclusion: data?.exclusion?.geom,
    bufferM: data?.exclusion?.buffer_distance_m,
    postArea: data?.exclusion?.post_area,
    maxOutsideM: data?.exclusion?.post_max_outside_m ?? 0,
  });

  /** Réserves du territoire actif et, si elles sont chargées, des autres territoires. */
  const allReserveGeoms = () => [
    ...(ed.data?.reserves ?? []).map((r) => r.geom),
    ...(ed.overview?.reserves ?? []).filter((r) => r.territory_id !== ed.territoryId).map((r) => r.geom),
  ];

  /** Le poste est-il hors du territoire actif ? */
  const isOutside = (p) => Boolean(ed.data) && !booleanPointInPolygon(p.geom.coordinates, ed.data.territory.geom);

  async function run(fn) {
    try {
      await fn();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    await reload();
  }

  async function loadTerritories() {
    ed.territories = (await api.get('/territories')).territories;
    if (!ed.territories.some((t) => t.id === ed.territoryId)) ed.territoryId = ed.territories[0]?.id ?? null;
    await loadOverview();
  }

  /** Données des autres territoires (une seule requête), si l'affichage est activé. */
  async function loadOverview() {
    if (!ed.showAll || ed.territories.length < 2) {
      ed.overview = null;
      return;
    }
    try {
      ed.overview = await api.get('/territories/overview');
    } catch (err) {
      ed.overview = null;
      toast(`Autres territoires indisponibles : ${errorMessage(err)}`, 'warn');
    }
  }

  /** Change de territoire actif ; `keepView` garde le cadrage (clic sur la carte). */
  async function switchTerritory(id, { postId = null, keepView = false } = {}) {
    if (ed.mode || ed.recording || id === ed.territoryId) return;
    ed.territoryId = id;
    ed.selected = postId ? { kind: 'posts', id: postId } : null;
    ed.fitted = keepView;
    history.clear();
    await loadOverview();
    await reload();
  }

  function fitAll() {
    const layers = ed.territories.map((t) => L.geoJSON(t.geom));
    if (!layers.length) return;
    map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [30, 30] });
  }

  /**
   * Lieux de l'association (parkings compris), affichés comme repères non
   * modifiables, y compris pendant le tracé d'un nouveau territoire : ils se
   * gèrent dans la page Lieux.
   */
  function renderPlaces() {
    const places = ed.data?.places ?? ed.places ?? [];
    for (const p of places) {
      groups.places.addLayer(placeMarker(p, kindIcon(p.kind)));
    }
  }

  /** Autres territoires : grisés, non modifiables ; un clic les rend actifs. */
  function renderOthers() {
    if (!ed.showAll || !ed.overview) return;
    const others = ed.overview.territories.filter((t) => t.id !== ed.territoryId);
    const isOther = (o) => o.territory_id !== ed.territoryId;
    for (const z of ed.overview.exclusions.filter(isOther)) {
      groups.others.addLayer(L.geoJSON(z.geom, { style: STYLE.otherExclusion, interactive: false }));
    }
    for (const r of ed.overview.reserves.filter(isOther)) {
      groups.others.addLayer(L.geoJSON(r.geom, { style: STYLE.otherReserve, interactive: false }));
    }
    for (const t of others) {
      const layer = L.polygon(t.geom.coordinates.map((ring) => ring.map(toLatLng)), STYLE.otherTerritory);
      layer.bindTooltip(escapeHtml(t.name), { permanent: true, direction: 'center', className: 'territory-label' });
      layer.on('click', (e) => {
        if (e.originalEvent) e.originalEvent.handledByLayer = true;
        if (!ed.mode && !ed.recording) switchTerritory(t.id, { keepView: true });
      });
      groups.others.addLayer(layer);
    }
    for (const p of ed.overview.posts.filter(isOther)) {
      const m = L.marker(toLatLng(p.geom.coordinates), {
        icon: postIcon(p.number, `other ${p.invalid_reason ? 'invalid-static' : ''}`),
        title: `Poste ${p.number}`,
        bubblingMouseEvents: true,
      });
      const t = ed.overview.territories.find((x) => x.id === p.territory_id);
      m.bindTooltip(escapeHtml(`${t?.name ?? ''} · poste ${p.number}${p.name ? ` · ${p.name}` : ''}`), { direction: 'top', offset: [0, -12] });
      m.on('click', (e) => {
        if (e.originalEvent) e.originalEvent.handledByLayer = true;
        switchTerritory(p.territory_id, { postId: p.id, keepView: true });
      });
      groups.others.addLayer(m);
    }
  }

  async function reload() {
    if (ed.territoryId) {
      try {
        ed.data = await api.get(`/territories/${ed.territoryId}`);
      } catch (err) {
        ed.data = null;
        if (err.status === 404) {
          await loadTerritories();
          return reload();
        }
        toast(errorMessage(err), 'error');
      }
    } else {
      ed.data = null;
    }
    if (ed.selected) {
      ed.selected.id = history.resolve(ed.selected.id);
      if (ed.selected.kind !== 'territories' && !find(ed.selected.kind, ed.selected.id)) ed.selected = null;
    }
    render();
  }

  async function createItem(kind, body) {
    const { item } = await api.post(`/territories/${ed.territoryId}/${kind}`, body);
    history.push({
      label: `Création ${LABEL[kind]}`,
      undo: async (hh) => api.del(itemPath(kind, hh.resolve(item.id))),
    });
    return item;
  }

  async function updateItem(kind, item, patch) {
    const before = pick(item, Object.keys(patch));
    const res = await api.patch(itemPath(kind, item.id), patch);
    // Chemin enregistré : le parking de départ est rattaché automatiquement (base de données).
    const updated = res.item;
    if (kind === 'posts' && 'access_path' in patch && updated?.parking_id && updated.parking_id !== item.parking_id) {
      before.parking_id = item.parking_id ?? null; // l'annulation remet aussi l'ancien parking
      const pk = ed.data?.parkings.find((x) => x.id === updated.parking_id);
      toast(`Parking « ${pk?.name ?? '?'} » rattaché au poste ${updated.number} : le chemin en part.`);
    }
    history.push({
      label: `Modification ${LABEL[kind]}`,
      undo: async (hh) => {
        const b = { ...before };
        if (b.parking_id) b.parking_id = hh.resolve(b.parking_id);
        await api.patch(itemPath(kind, hh.resolve(item.id)), b);
      },
    });
    return res.item ?? res.territory;
  }

  async function deleteItem(kind, item) {
    await api.del(itemPath(kind, item.id));
    history.push({
      label: `Suppression ${LABEL[kind]}`,
      undo: async (hh) => {
        const body = pick(item, FIELDS[kind]);
        if (body.parking_id) body.parking_id = hh.resolve(body.parking_id);
        const { item: created } = await api.post(`/territories/${hh.resolve(item.territory_id)}/${kind}`, body);
        hh.alias(item.id, created.id);
      },
    });
  }

  async function undo() {
    if (ed.mode || ed.recording) return;
    try {
      const label = await history.undo();
      if (label) toast(`Annulé : ${label.toLowerCase()}`);
    } catch (err) {
      toast(`Annulation impossible : ${errorMessage(err)}`, 'error');
    }
    await loadTerritories().catch(() => {});
    await reload();
  }

  // -------------------------------------------------------------------------
  // Carte
  // -------------------------------------------------------------------------

  const isSelected = (kind, id) => ed.selected?.kind === kind && ed.selected?.id === id;

  /** Gestionnaire de clic de sélection d'un objet de la carte. */
  const onPick = (kind, id) => (e) => {
    if (e?.originalEvent) e.originalEvent.handledByLayer = true;
    select(kind, id);
  };

  function select(kind, id, { zoom = false } = {}) {
    if (ed.mode || ed.recording) return;
    ed.selected = kind ? { kind, id } : null;
    if (kind === 'dwellings') {
      ed.open.add('dwellings');
      if (!ed.allDwellings && dwellingRank(id) >= DWELLINGS_LIMIT) ed.allDwellings = true;
    }
    render();
    if (kind) panel.querySelector('.props')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (zoom && kind) {
      const item = kind === 'territories' ? ed.data.territory : find(kind, id);
      const layer = L.geoJSON(item.geom);
      if (item.geom.type === 'Point') map.setView(layer.getBounds().getCenter(), Math.max(map.getZoom(), 16));
      else map.fitBounds(layer.getBounds(), { padding: [30, 30], maxZoom: 17 });
    }
  }

  /** Active l'édition des sommets d'un polygone ou d'une ligne, avec enregistrement différé. */
  function makeEditable(layer, onSave) {
    if (!canEdit) return;
    layer.pm.enable({ allowSelfIntersection: false, snappable: true, snapDistance: 20 });
    let timer;
    layer.on('pm:edit', () => {
      clearTimeout(timer);
      timer = setTimeout(() => onSave(layer.toGeoJSON().geometry), 600);
    });
  }

  function render() {
    for (const g of Object.values(groups)) g.clearLayers();
    renderPanel();
    renderOthers();
    renderPlaces();
    if (!ed.data) return;
    const { territory, reserves, parkings, posts, dwellings = [], exclusion } = ed.data;

    // Territoire
    const tLayer = L.polygon(territory.geom.coordinates.map((r) => r.map(toLatLng)), isSelected('territories', territory.id) ? STYLE.territorySelected : STYLE.territory);
    tLayer.on('click', onPick('territories', territory.id));
    groups.territory.addLayer(tLayer);
    if (isSelected('territories', territory.id)) {
      makeEditable(tLayer, (geom) => saveShape('territories', territory, geom));
    }

    // Réserves (hachures rouges)
    for (const r of reserves) {
      const layer = L.polygon(r.geom.coordinates.map((ring) => ring.map(toLatLng)), STYLE.reserve);
      layer.bindTooltip(escapeHtml(`Réserve${r.name && r.name !== 'Réserve' ? ` · ${r.name}` : ''}`), { permanent: true, direction: 'center', className: 'reserve-label' });
      layer.on('click', onPick('reserves', r.id));
      groups.reserves.addLayer(layer);
      if (isSelected('reserves', r.id)) makeEditable(layer, (geom) => saveShape('reserves', r, geom));
    }

    // Limite de la zone des postes (territoire + marge autorisée hors territoire)
    if (exclusion?.post_area && exclusion.post_max_outside_m > 0) {
      groups.exclusion.addLayer(L.geoJSON(exclusion.post_area, { style: STYLE.postArea, interactive: false }));
    }

    // Zone non chassable (hachures orange) : distance des paramètres.
    if (exclusion?.geom) {
      const zone = L.geoJSON(exclusion.geom, { style: STYLE.exclusion, interactive: false });
      groups.exclusion.addLayer(zone);
    }

    // Bâtiments (habitations) : cliquables pour les ignorer ou les réactiver
    for (const d of dwellings) {
      const style = dwellingStyle(d, isSelected('dwellings', d.id));
      const layer = d.geom.type === 'Point'
        ? L.circleMarker(toLatLng(d.geom.coordinates), { ...style, renderer: dwellingRenderer })
        : L.geoJSON(d.geom, { style, renderer: dwellingRenderer });
      layer.on('click', onPick('dwellings', d.id));
      groups.dwellings.addLayer(layer);
    }

    // Chemin proposé (pas encore enregistré)
    if (ed.proposal?.coords && isSelected('posts', ed.proposal.postId)) {
      groups.paths.addLayer(L.polyline(ed.proposal.coords.map(toLatLng), { color: '#e8590c', weight: 4, dashArray: '6 8', interactive: false }));
    }

    // Chemins d'accès (pointillés)
    for (const p of posts) {
      if (!p.access_path) continue;
      const sel = isSelected('posts', p.id);
      const layer = L.polyline(p.access_path.coordinates.map(toLatLng), sel ? STYLE.pathSelected : STYLE.path);
      layer.on('click', onPick('posts', p.id));
      groups.paths.addLayer(layer);
      if (sel) {
        makeEditable(layer, (geom) =>
          run(async () => {
            await updateItem('posts', p, { access_path: geom });
          }),
        );
      }
    }


    // Postes : contrôle en direct pendant le glisser-déposer
    const reserveGeoms = allReserveGeoms();
    const zones = zonesFor(ed.data);
    for (const p of posts) {
      const cls = [
        isSelected('posts', p.id) ? 'selected' : '',
        p.active ? '' : 'inactive',
        p.invalid_reason ? 'invalid-static' : hasSpecial(p) ? 'warning' : '',
      ].join(' ');
      // Au-dessus des poignées du chemin (sa fin est sur le poste) : glisser déplace le poste, le chemin suit.
      const m = L.marker(toLatLng(p.geom.coordinates), { icon: postIcon(p.number, cls), draggable: canEdit, title: `Poste ${p.number}`, bubblingMouseEvents: true, zIndexOffset: 1000 });
      m.bindTooltip(escapeHtml(postTooltip(p, zones.bufferM) + (isOutside(p) ? ' — hors du territoire' : '')), { direction: 'top', offset: [0, -14] });
      let origin;
      m.on('click', onPick('posts', p.id));
      m.on('dragstart', () => {
        origin = m.getLatLng();
      });
      m.on('drag', () => {
        const { lat, lng } = m.getLatLng();
        const check = checkPost([lng, lat], territory.geom, reserveGeoms, zones);
        m.getElement()?.classList.toggle('invalid', !check.ok);
        m.getElement()?.classList.toggle('warning', check.ok && Boolean(check.warning));
        m.setTooltipContent(escapeHtml(!check.ok ? `⛔ ${check.message}` : check.warning ? `⚠ ${check.warning}` : `Poste ${p.number}`));
        m.openTooltip();
      });
      m.on('dragend', () => {
        const { lat, lng } = m.getLatLng();
        const check = checkPost([lng, lat], territory.geom, reserveGeoms, zones);
        if (!check.ok) {
          m.setLatLng(origin);
          m.getElement()?.classList.remove('invalid');
          toast(`Poste ${p.number} non déplacé : ${check.message.toLowerCase()}.`, 'error');
          return;
        }
        if (check.warning) toast(`Poste ${p.number} : ${check.warning}.`, 'warn');
        run(async () => {
          const patch = { geom: { type: 'Point', coordinates: [lng, lat] } };
          let note = null;
          if (p.access_path) {
            const r = await updatedPath(p.access_path.coordinates, { which: 'post', from: p.geom.coordinates, to: [lng, lat], post: p.geom.coordinates });
            patch.access_path = { type: 'LineString', coordinates: r.coords };
            note = r.recomputed ? `Poste ${p.number} déplacé : chemin recalculé depuis le parking.` : `Poste ${p.number} déplacé : fin du chemin ajustée.`;
          }
          await updateItem('posts', p, patch);
          if (note) toast(note);
        });
      });
      groups.posts.addLayer(m);
    }

    if (!ed.fitted) {
      ed.fitted = true;
      map.fitBounds(tLayer.getBounds(), { padding: [30, 30] });
    }
  }

  /**
   * Propose le meilleur chemin à pied vers un poste, depuis le parking le plus
   * favorable (itinéraire IGN sur routes, pistes et sentiers). Affiché en
   * pointillés orange ; le président l'accepte ou l'ignore.
   */
  async function proposePath(post) {
    if (!ed.data?.parkings.length) {
      ed.proposal = { postId: post.id, noParking: true };
      return renderPanel();
    }
    ed.proposal = { postId: post.id, loading: true };
    renderPanel();
    const best = await bestPathToPost(post.geom.coordinates, ed.data.parkings);
    if (ed.proposal?.postId !== post.id) return undefined; // entre-temps : autre sélection
    ed.proposal = { postId: post.id, ...best };
    return render();
  }

  /**
   * Nouveau poste : le meilleur chemin depuis les parkings est appliqué
   * d'office (annulable avec ↶, ou à retracer).
   */
  async function autoPath(post) {
    if (!ed.data?.parkings.length) {
      toast('Poste créé. Ajoutez un parking pour qu’un chemin d’accès soit tracé automatiquement.');
      return;
    }
    toast('Calcul du chemin d’accès depuis le parking le plus favorable…');
    const best = await bestPathToPost(post.geom.coordinates, ed.data.parkings);
    const current = find('posts', post.id);
    // Entre-temps, le poste a pu être supprimé, déplacé ou doté d'un chemin.
    if (!best || !current || current.access_path || distanceMeters(current.geom.coordinates, post.geom.coordinates) > 1) return;
    await run(async () => {
      await updateItem('posts', current, { access_path: { type: 'LineString', coordinates: best.coords }, parking_id: best.parking.id });
      toast(`Chemin de ${Math.round(best.length)} m tracé depuis « ${best.parking.name} »${best.routed ? '' : ' (à vol d’oiseau : itinéraire IGN indisponible)'}. ↶ pour l’annuler, ou retracez-le.`);
    });
  }

  function saveShape(kind, item, geom) {
    if (selfIntersects(geom)) {
      toast('Le contour se recoupe lui-même : modification refusée.', 'error');
      return reload();
    }
    return run(async () => {
      await updateItem(kind, item, { geom });
      // Contour agrandi au-delà des bâtiments connus : on complète l'import.
      if (kind === 'territories') {
        const fresh = await api.get(`/territories/${item.id}`);
        if (fresh.exclusion?.needs_refresh) await importBuildings(item.id, 'Contour enregistré');
      }
    });
  }

  /**
   * Import des bâtiments IGN autour d'un territoire, dans une requête à part :
   * si le service de l'IGN est lent ou indisponible, le territoire, lui, est
   * déjà enregistré. Renvoie true si l'import a réussi.
   */
  async function importBuildings(territoryId, done) {
    toast(`${done}. Import des bâtiments IGN en cours…`);
    try {
      const { report } = await api.post(`/territories/${territoryId}/dwellings/refresh`, {});
      toast(importSummary(report));
      return true;
    } catch (err) {
      toast(`${done}, mais les bâtiments IGN n’ont pas pu être importés (${errorMessage(err).replace(/\.$/, '')}). Réessayez avec « Actualiser les bâtiments » (section « Données et bâtiments »).`, 'warn');
      return false;
    }
  }

  map.on('click', (e) => {
    if (e.originalEvent?.handledByLayer) return;
    if (!ed.mode && !ed.recording && ed.selected) select(null);
  });

  // -------------------------------------------------------------------------
  // Dessin
  // -------------------------------------------------------------------------

  function startDraw(mode) {
    stopDraw();
    ed.mode = mode;
    const shape = { territory: 'Polygon', reserves: 'Polygon', parkings: 'Marker', posts: 'Marker', path: 'Line', dwellings: 'CircleMarker' }[mode];
    const options = { snappable: true, snapDistance: 20, allowSelfIntersection: false, continueDrawing: false };
    if (mode === 'posts') options.markerStyle = { icon: postIcon('+') };
    map.pm.enableDraw(shape, options);
    renderPanel();
  }

  function stopDraw() {
    map.pm.disableDraw();
    ed.mode = null;
  }

  /** Nouveau territoire : le nom d'abord, puis le contour à dessiner (carte vidée). */
  async function newTerritory() {
    const name = (await promptDialog('Nouveau territoire', 'Nom du territoire'))?.trim();
    if (!name) {
      location.hash = '#/territoires';
      return;
    }
    ed.pendingTerritory = { name };
    ed.territoryId = null;
    ed.selected = null;
    ed.data = null;
    render();
    startDraw('territory');
  }

  /** Abandon du dessin : un nouveau territoire en attente est oublié. */
  function cancelDraw() {
    stopDraw();
    if (ed.pendingTerritory) {
      ed.pendingTerritory = null;
      location.hash = '#/territoires';
      return undefined;
    }
    render();
  }

  map.on('pm:create', async (e) => {
    const geom = e.layer.toGeoJSON().geometry;
    map.removeLayer(e.layer);
    const mode = ed.mode;
    stopDraw();
    renderPanel();
    await handleDrawn(mode, geom);
  });

  async function handleDrawn(mode, geom) {
    if (mode === 'territory') {
      const name = ed.pendingTerritory?.name ?? await promptDialog('Nouveau territoire', 'Nom du territoire');
      ed.pendingTerritory = null;
      if (!name) {
        location.hash = '#/territoires';
        return undefined;
      }
      try {
        const { territory } = await api.post('/territories', { name, geom });
        await importBuildings(territory.id, 'Territoire créé');
        history.push({ label: 'Création du territoire', undo: async (hh) => api.del(itemPath('territories', hh.resolve(territory.id))) });
        ed.territoryId = territory.id;
        ed.selected = null;
        ed.fitted = false;
        window.history.replaceState(null, '', `#/carte/${territory.id}`);
        await loadTerritories();
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
      return reload();
    }
    if (mode === 'reserves') {
      return run(async () => {
        const item = await createItem('reserves', { geom });
        ed.selected = { kind: 'reserves', id: item.id };
      });
    }
    if (mode === 'dwellings') {
      const name = await promptDialog('Habitation manquante', 'Nom (ex. maison récente, caravane habitée)', '');
      if (name === null) return render();
      return run(async () => {
        const item = await createItem('dwellings', { geom, name: name.trim() });
        ed.selected = { kind: 'dwellings', id: item.id };
        toast('Habitation ajoutée : la zone non chassable est recalculée.');
      });
    }
    if (mode === 'posts') {
      const check = checkPost(geom.coordinates, ed.data.territory.geom, allReserveGeoms(), zonesFor(ed.data));
      if (check.warning) toast(check.warning, 'warn');
      if (!check.ok) {
        toast(`Poste refusé : ${check.message.toLowerCase()}.`, 'error');
        return render();
      }
      return run(async () => {
        const item = await createItem('posts', { geom });
        ed.selected = { kind: 'posts', id: item.id };
        autoPath(item);
      });
    }
    if (mode === 'path') {
      const post = find('posts', ed.selected?.id);
      if (!post) return render();
      warnIfFarFromParking(post, geom.coordinates);
      return run(() => updateItem('posts', post, { access_path: geom }));
    }
  }

  function warnIfFarFromParking(post, coords) {
    const parking = find('parkings', post.parking_id);
    if (parking && distanceMeters(coords[0], parking.geom.coordinates) > 50) {
      toast('Le chemin ne part pas du parking du poste (à plus de 50 m).', 'warn');
    }
  }

  // -------------------------------------------------------------------------
  // Enregistrement du trajet en marchant
  // -------------------------------------------------------------------------

  async function startRecording(post) {
    if (!('geolocation' in navigator)) {
      toast('La géolocalisation n’est pas disponible sur cet appareil.', 'error');
      return;
    }
    const rec = { post, coords: [], accuracy: null, line: L.polyline([], STYLE.recording).addTo(map), wakeLock: null };
    try {
      rec.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* Wake Lock non disponible : l'écran pourra s'éteindre */
    }
    rec.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        rec.accuracy = Math.round(pos.coords.accuracy);
        const c = [pos.coords.longitude, pos.coords.latitude];
        // On ignore les points trop imprécis et le piétinement sur place.
        if (pos.coords.accuracy <= 25 && (!rec.coords.length || distanceMeters(rec.coords.at(-1), c) >= 2)) {
          rec.coords.push(c);
          rec.line.addLatLng(toLatLng(c));
          if (rec.coords.length === 1) map.setView(toLatLng(c), 17);
        }
        renderPanel();
      },
      (err) => toast(`GPS : ${err.message}`, 'error'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
    ed.recording = rec;
    ed.selected = { kind: 'posts', id: post.id };
    renderPanel();
  }

  async function stopRecording(save) {
    const rec = ed.recording;
    if (!rec) return;
    navigator.geolocation.clearWatch(rec.watchId);
    rec.wakeLock?.release?.().catch(() => {});
    map.removeLayer(rec.line);
    ed.recording = null;
    if (!save) return render();
    if (rec.coords.length < 2) {
      toast('Trajet trop court : aucun point précis enregistré.', 'error');
      return render();
    }
    const simplified = simplifyMeters(rec.coords, 3);
    await run(async () => {
      await updateItem('posts', rec.post, { access_path: { type: 'LineString', coordinates: simplified } });
      toast(`Trajet enregistré (${Math.round(lineLengthMeters(simplified))} m, ${rec.coords.length} → ${simplified.length} points). Vous pouvez ajuster le tracé.`);
    });
  }

  // -------------------------------------------------------------------------
  // Import / export
  // -------------------------------------------------------------------------

  function pickFile() {
    const input = h('input', { type: 'file', accept: '.geojson,.json,.kml,.gpx' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const items = parseGeoFile(file.name, await file.text());
        if (!items.length) throw new Error('Aucune géométrie trouvée dans le fichier.');
        await importDialog(file.name, items);
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    });
    input.click();
  }

  async function importDialog(filename, items) {
    const posts = ed.data?.posts ?? [];
    const choices = {
      Polygon: [['territory', ed.data ? 'Contour du territoire (remplace)' : 'Nouveau territoire'], ['reserve', 'Zone de réserve'], ['ignore', 'Ignorer']],
      Point: [['post', 'Poste'], ['parking', 'Parking'], ['ignore', 'Ignorer']],
      LineString: [
        ...posts.map((p) => [`path:${p.id}`, `Chemin du poste ${p.number}`]),
        ['ignore', 'Ignorer'],
      ],
    };
    const rows = items.map((item, i) => {
      const opts = choices[item.geometry.type];
      let initial = item.kind === 'path' ? (opts[0]?.[0] ?? 'ignore') : item.kind;
      if (item.kind === 'territory' || (!ed.data && item.geometry.type === 'Polygon' && i === items.findIndex((x) => x.geometry.type === 'Polygon'))) initial = 'territory';
      if (!ed.data && !items.some((x) => x.geometry.type === 'Polygon')) initial = 'ignore';
      const select = h('select', opts.map(([v, l]) => h('option', { value: v, selected: v === initial }, l)));
      return { item, select, row: h('tr', h('td', item.label || '—'), h('td', { Polygon: 'Polygone', Point: 'Point', LineString: 'Ligne' }[item.geometry.type]), h('td', select)) };
    });
    const ok = await modal(
      `Importer ${filename}`,
      [
        !ed.data ? h('p.small', 'Aucun territoire sélectionné : importez d’abord un polygone comme territoire.') : null,
        h('table.list', h('thead', h('tr', h('th', 'Nom'), h('th', 'Type'), h('th', 'Importer comme'))), h('tbody', rows.map((r) => r.row))),
      ],
      [
        { label: 'Annuler', value: false },
        { label: 'Importer', value: true, primary: true },
      ],
    );
    if (!ok) return;

    // Ordre : territoire, réserves, parkings, postes, chemins.
    const order = ['territory', 'reserve', 'parking', 'post', 'path'];
    const plan = rows
      .map((r) => ({ ...r, choice: r.select.value }))
      .filter((r) => r.choice !== 'ignore')
      .sort((a, b) => order.indexOf(a.choice.split(':')[0]) - order.indexOf(b.choice.split(':')[0]));
    const errors = [];
    for (const { item, choice } of plan) {
      const label = item.label || item.geometry.type;
      try {
        if (choice === 'territory') {
          if (ed.data) await updateItem('territories', ed.data.territory, { geom: item.geometry });
          else {
            const { territory } = await api.post('/territories', { name: item.label || filename.replace(/\.\w+$/, ''), geom: item.geometry });
            if (!(await importBuildings(territory.id, 'Territoire importé'))) errors.push('Bâtiments IGN : import à refaire (« Données et bâtiments »)');
            history.push({ label: 'Création du territoire', undo: async (hh) => api.del(itemPath('territories', hh.resolve(territory.id))) });
            ed.territoryId = territory.id;
            ed.fitted = false;
            await loadTerritories();
          }
          ed.data = await api.get(`/territories/${ed.territoryId}`);
        } else if (!ed.data) {
          errors.push(`${label} : aucun territoire`);
        } else if (choice === 'reserve') {
          await createItem('reserves', { name: item.label || 'Réserve', geom: item.geometry });
        } else if (choice === 'parking') {
          await createItem('parkings', { name: item.label || 'Parking', geom: item.geometry });
        } else if (choice === 'post') {
          const number = Number(String(item.label).match(/\d+/)?.[0]);
          // « Poste 4 » ne sert qu'à donner le numéro : pas de nom redondant.
          const body = { name: /^poste\s*\d+$/i.test(item.label.trim()) ? '' : item.label, geom: item.geometry };
          if (number >= 1 && number <= 999 && !ed.data.posts.some((p) => p.number === number)) body.number = number;
          const created = await createItem('posts', body);
          ed.data.posts.push(created);
        } else if (choice.startsWith('path:')) {
          const post = ed.data.posts.find((p) => p.id === choice.slice(5));
          await updateItem('posts', post, { access_path: item.geometry });
        }
      } catch (err) {
        errors.push(`${label} : ${errorMessage(err)}`);
      }
    }
    await reload();
    if (errors.length) {
      await modal('Import partiel', h('ul', errors.map((e) => h('li', e))));
    } else {
      toast(`${plan.length} élément(s) importé(s).`);
    }
  }

  async function exportGeoJSON() {
    try {
      const res = await api.raw(`/territories/${ed.territoryId}/export`);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'territoire.geojson';
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Panneau latéral
  // -------------------------------------------------------------------------

  function field(label, input) {
    return h('label', label, input);
  }

  /** Champ enregistré à la sortie (change), avec annulation. */
  function bound(kind, item, key, attrs = {}, tag = 'input') {
    const el = h(tag, { ...attrs, disabled: !canEdit });
    if (attrs.type === 'checkbox') el.checked = Boolean(item[key]);
    else el.value = item[key] ?? '';
    el.addEventListener('change', async () => {
      let value = attrs.type === 'checkbox' ? el.checked : attrs.type === 'number' ? Number(el.value) : el.value;
      if (tag === 'select' && value === '') value = null;
      const plans = kind === 'posts' ? item.plan_uses ?? [] : [];
      if (plans.length && (key === 'number' || (key === 'active' && value === false))) {
        const what = key === 'number'
          ? `Le poste ${item.number} devient le poste ${value} : son numéro change aussi dans les plans de chasse ${plans.join(', ')} chasseurs (listes papier à refaire).`
          : `Désactiver le poste ${item.number} rend invalides les plans de chasse ${plans.join(', ')} chasseurs.`;
        if (!(await confirmDialog('Poste utilisé dans des plans de couverture', what, 'Continuer'))) {
          if (attrs.type === 'checkbox') el.checked = Boolean(item[key]);
          else el.value = item[key] ?? '';
          return;
        }
      }
      run(() => updateItem(kind, item, { [key]: value }));
    });
    return el;
  }

  function propertiesPanel() {
    if (!ed.selected || !ed.data) return null;
    const { kind, id } = ed.selected;
    if (kind === 'territories') {
      const t = ed.data.territory;
      return h(
        'section.props',
        h('h3', 'Territoire'),
        field('Nom', bound('territories', t, 'name', { maxlength: 200 })),
        field('Notes', bound('territories', t, 'notes', { rows: 3, maxlength: 5000 }, 'textarea')),
        h('p.small', `${t.area_ha.toLocaleString('fr-FR')} ha. Déplacez les sommets pour modifier le contour (accrochage aux sommets existants).`),
        canEdit
          ? h('button.danger', {
              onclick: async () => {
                if (!(await confirmDialog('Supprimer le territoire', `Supprimer « ${t.name} » avec ses réserves, postes et chemins (les parkings restent dans les lieux) ? Cette suppression ne peut pas être annulée.`, 'Supprimer', true))) return;
                try {
                  await api.del(itemPath('territories', t.id));
                  history.clear();
                  toast('Territoire supprimé.');
                  location.hash = '#/territoires';
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              },
            }, 'Supprimer le territoire')
          : null,
      );
    }
    const item = find(kind, id);
    if (!item) return null;
    const del = canEdit ? h('button.danger', { onclick: () => askDelete(kind, item) }, 'Supprimer') : null;

    if (kind === 'reserves') {
      return h('section.props', h('h3', 'Zone de réserve'), field('Nom', bound(kind, item, 'name', { maxlength: 200 })), field('Motif', bound(kind, item, 'reason', { maxlength: 1000 })), h('p.small', `${item.area_ha.toLocaleString('fr-FR')} ha`), del);
    }
    if (kind === 'dwellings') return dwellingPanel(item);
    // Poste
    const parkingSelect = bound(kind, item, 'parking_id', {}, 'select');
    parkingSelect.append(h('option', { value: '' }, '— aucun —'), ...ed.data.parkings.map((pk) => h('option', { value: pk.id, selected: pk.id === item.parking_id }, pk.name)));
    parkingSelect.value = item.parking_id ?? '';
    // Essentiel d'abord ; consignes, chemin et plans de chasse dans des blocs repliables.
    const plans = item.plan_uses ?? [];
    const hasNotes = Boolean(item.instructions || item.special_instructions);
    return h(
      'section.props',
      h('h3', `Poste ${item.number}${item.name ? ` · ${item.name}` : ''}`),
      item.invalid_reason
        ? h('p.alert.danger', `⛔ À moins de ${ed.data.exclusion?.buffer_distance_m ?? 150} m d’une habitation : à déplacer (non proposé en battue).`)
        : null,
      isOutside(item) ? h('p.alert.warn', 'Hors du territoire : droit de chasse ou accord du propriétaire nécessaire.') : null,
      h('div.row', field('Numéro', bound(kind, item, 'number', { type: 'number', min: 1, max: 999, required: true })), field('Nom', bound(kind, item, 'name', { maxlength: 200 }))),
      h('div.row', field('Ligne', lineSelect(item)), field('Parking', parkingSelect)),
      h('div.row', field('Difficulté d’accès', difficultySelect(item)),
        h('label.check', bound(kind, item, 'active', { type: 'checkbox' }), 'Actif')),
      item.nearest_dwelling_m != null && !item.invalid_reason ? h('p.small.muted', `Habitation à ${item.nearest_dwelling_m} m : pas de tir dans sa direction.`) : null,
      fold('Chemin d’accès', { key: 'post.path', open: !item.access_path || ed.proposal?.postId === item.id, extra: item.access_path ? `${item.access_path_length_m} m` : 'aucun' },
        canEdit ? pathProposal(item) : null,
        item.access_path && canEdit ? h('p.small.muted', 'Déplacez ses sommets sur la carte pour l’ajuster.') : null,
        canEdit
          ? h('div.buttons.compact',
              !item.access_path && ed.proposal?.postId !== item.id ? h('button', { onclick: () => proposePath(item) }, 'Proposer') : null,
              h('button', { onclick: () => startDraw('path') }, item.access_path ? 'Retracer' : 'Tracer'),
              h('button', { onclick: () => startRecording(item), title: 'Enregistrer le trajet en marchant (GPS)' }, '🚶 En marchant'),
              item.access_path ? h('button.link.danger', { onclick: () => run(() => updateItem('posts', item, { access_path: null })) }, 'Effacer') : null)
          : null),
      fold('Consignes', { key: 'post.notes', open: hasNotes, extra: item.special_instructions || /attention/i.test(item.instructions ?? '') ? '⚠' : hasNotes ? '✔' : '' },
        bound(kind, item, 'instructions', { rows: 3, maxlength: 2000, placeholder: 'Angles de tir, repères…' }, 'textarea'),
        h('label.check', bound(kind, item, 'special_instructions', { type: 'checkbox' }), 'Consignes particulières ⚠')),
      plans.length
        ? fold('Plans de chasse utilisant ce poste', { key: 'post.plans', extra: String(plans.length) },
            h('ul.plain.small', plans.map((x) => h('li', `${x} chasseurs`))),
            h('a.small', { href: `#/plans/${ed.territoryId}` }, 'Ouvrir les plans de chasse'))
        : null,
      del,
    );
  }

  function pathProposal(item) {
    const pr = ed.proposal;
    if (!pr || pr.postId !== item.id) return null;
    if (pr.noParking) return h('p.small.alert.muted', 'Ajoutez un parking pour qu’un chemin soit proposé.');
    if (pr.loading) return h('p.small.muted', 'Calcul du meilleur chemin depuis les parkings…');
    return h('div.hint.proposal',
      h('p', h('strong', `Chemin proposé : ${Math.round(pr.length)} m`), ` depuis le parking « ${pr.parking.name} »${pr.routed ? ', par les routes et sentiers IGN' : ' (à vol d’oiseau : itinéraire IGN indisponible)'}.`),
      h('div.buttons',
        h('button.primary', { onclick: () => {
          const coords = pr.coords;
          ed.proposal = null;
          run(() => updateItem('posts', item, { access_path: { type: 'LineString', coordinates: coords }, parking_id: pr.parking.id }));
        } }, 'Utiliser ce chemin'),
        h('button.link', { onclick: () => { ed.proposal = null; render(); } }, 'Ignorer')),
      h('p.small.muted', 'Vérifiez-le sur le terrain : le dernier tronçon jusqu’au poste est à vol d’oiseau.'));
  }

  /** Ligne du poste (groupe nommé de postes) ; « Nouvelle ligne… » la crée et y met le poste. */
  function lineSelect(item) {
    const el = h('select', { disabled: !canEdit, onchange: async () => {
      if (el.value === '__new') {
        el.value = item.line_id ?? '';
        const name = (await promptDialog('Nouvelle ligne', 'Nom de la ligne (ex. Ligne du ruisseau)'))?.trim();
        if (!name) return;
        run(async () => {
          const { line } = await api.post(`/territories/${ed.territoryId}/lines`, { name });
          await updateItem('posts', item, { line_id: line.id });
          ed.open.add('lines');
          toast(`Ligne « ${name} » créée.`);
        });
        return;
      }
      run(() => updateItem('posts', item, { line_id: el.value || null }));
    } },
      h('option', { value: '' }, '— aucune (poste isolé) —'),
      (ed.data.lines ?? []).map((l) => h('option', { value: l.id, selected: l.id === item.line_id }, l.name)),
      canEdit ? h('option', { value: '__new' }, '+ Nouvelle ligne…') : null);
    el.value = item.line_id ?? '';
    return el;
  }

  /** Lignes de postes : nom, nombre de postes ; renommer, supprimer (les postes restent, sans ligne). */
  function linesSection() {
    const lines = ed.data.lines ?? [];
    const count = (l) => ed.data.posts.filter((p) => p.line_id === l.id);
    const isolated = ed.data.posts.filter((p) => !p.line_id).length;
    return foldSection('lines', `Lignes (${lines.length})`, lines.length && isolated ? `· ${isolated} poste(s) hors ligne` : '',
      lines.length ? null : h('p.small.muted', 'Groupe de postes, avec un chef de ligne à chaque battue. Rattachez un poste depuis sa fiche.'),
      h('ul.obj-list', lines.map((l) => {
        const lp = count(l).sort((a, b) => a.number - b.number);
        return h('li.obj-row',
          h('span.obj-label', l.name, h('span.small.muted', ` · ${lp.length ? `postes ${lp.map((p) => p.number).join(', ')}` : 'aucun poste'}`)),
          canEdit ? h('span.obj-actions',
            h('button.icon', { title: 'Renommer', 'aria-label': 'Renommer', onclick: async () => {
              const name = (await promptDialog('Renommer la ligne', 'Nom de la ligne', l.name))?.trim();
              if (name && name !== l.name) run(async () => { await api.patch(`/lines/${l.id}`, { name }); });
            } }, '✏️'),
            h('button.icon.danger', { title: 'Supprimer', 'aria-label': 'Supprimer', onclick: async () => {
              if (!(await confirmDialog('Supprimer la ligne', `Supprimer la ligne « ${l.name} » ? Ses ${lp.length} poste(s) restent, sans ligne.`, 'Supprimer', true))) return;
              run(async () => { await api.del(`/lines/${l.id}`); });
            } }, '🗑')) : null);
      })),
      canEdit ? h('button.link', { onclick: async () => {
        const name = (await promptDialog('Nouvelle ligne', 'Nom de la ligne (ex. Ligne du ruisseau)'))?.trim();
        if (name) run(async () => { await api.post(`/territories/${ed.territoryId}/lines`, { name }); toast(`Ligne « ${name} » créée : rattachez-y des postes depuis leur fiche.`); });
      } }, '+ Nouvelle ligne') : null);
  }

  /** 1 très facile … 5 escarpé ; vide : estimée d'après la longueur du chemin. */
  function difficultySelect(item) {
    const estimated = item.access_difficulty == null && item.difficulty != null ? ` (${item.difficulty} · ${DIFFICULTY_LABELS[item.difficulty]})` : '';
    const el = h('select', { disabled: !canEdit, onchange: () => run(() => updateItem('posts', item, { access_difficulty: el.value ? Number(el.value) : null })) },
      h('option', { value: '' }, item.access_path ? `Estimée d’après le chemin${estimated}` : 'Non renseignée'),
      Object.entries(DIFFICULTY_LABELS).map(([v, l]) => h('option', { value: v, selected: String(item.access_difficulty ?? '') === v }, `${v} · ${l}`)));
    return el;
  }

  /**
   * Fiche d'un bâtiment cliqué sur la carte : de quel bâtiment il s'agit, et
   * le supprimer si ce n'est pas une habitation. Un bâtiment IGN supprimé est
   * gardé comme « ignoré » (avec la raison) pour ne pas revenir à la prochaine
   * actualisation ; une habitation ajoutée à la main est vraiment supprimée.
   */
  function dwellingPanel(d) {
    const ign = d.source !== 'manuel';
    const buffer = ed.data?.exclusion?.buffer_distance_m ?? 150;
    const facts = [
      ign ? `Bâtiment IGN (BD TOPO)${d.source_id ? ` · ${d.source_id}` : ''}` : 'Habitation ajoutée à la main',
      d.usage && d.usage !== 'Ajout manuel' ? `Usage : ${d.usage}` : ign ? 'Usage non renseigné par l’IGN' : null,
      d.comment ? `Note : ${d.comment}` : null,
      d.missing_since ? `Absent de la BD TOPO depuis le ${new Date(d.missing_since).toLocaleDateString('fr-FR')} (démoli ?).` : null,
      d.likely_non_residential && !d.ignored ? 'Probablement pas une habitation d’après l’IGN : à vérifier sur place.' : null,
    ].filter(Boolean);
    return h('section.props',
      h('h3', d.ignored ? 'Bâtiment supprimé' : 'Bâtiment'),
      field('Nom', bound('dwellings', d, 'name', { maxlength: 100, placeholder: dwellingLabel({ ...d, name: '' }) })),
      facts.map((f) => h('p.small', f)),
      streetViewLinks(d.geom),
      d.ignored
        ? [
            h('p.small.alert.muted', `Supprimé le ${new Date(d.ignored_at).toLocaleDateString('fr-FR')} : ${d.ignored_reason}. Il ne compte plus dans la zone non chassable.`),
            canEdit ? h('button', { onclick: () => restoreDwelling(d) }, '↺ Rétablir (compté comme habitation)') : null,
          ]
        : [
            h('p.small', `Compté comme habitation : pas de poste ni de tir à moins de ${buffer} m.`),
            canEdit ? h('button.danger', { onclick: () => removeDwelling(d) }, 'Supprimer ce bâtiment…') : null,
          ]);
  }

  /** Voir le bâtiment dans Google (nouvel onglet) : Street View, ou satellite à défaut. */
  function streetViewLinks(geom) {
    const c = geomCenter(geom);
    if (!c) return null;
    return h('p.buttons.streetview',
      h('a.button', { href: streetViewUrl(c), target: '_blank', rel: 'noopener noreferrer', title: 'Panorama Street View le plus proche (Google)' }, '👁 Street View'),
      h('a.small', { href: satelliteUrl(c), target: '_blank', rel: 'noopener noreferrer', title: 'Si Street View ne couvre pas ce secteur' }, 'Vue satellite Google'));
  }

  /** Libellé d'un bâtiment : son nom, sinon l'usage IGN. */
  const dwellingLabel = (d) => d.name || (d.source === 'manuel' ? d.comment || 'Habitation' : d.usage || 'Bâtiment');

  /**
   * Supprimer un bâtiment (IGN ou ajouté à la main) : raison obligatoire. Il
   * reste mémorisé, barré, et peut être rétabli ; il ne compte plus dans la
   * zone non chassable.
   */
  async function removeDwelling(d) {
    const reason = await promptDialog('Supprimer ce bâtiment',
      `« ${dwellingLabel(d)} » ne comptera plus comme habitation (zone non chassable recalculée). Pourquoi ? ex. ruine, hangar sans logement. Il reste rétablissable.`, '');
    if (reason == null) return undefined;
    if (reason.trim().length < 3) return toast('Indiquez la raison de la suppression (3 caractères au moins).', 'error');
    return run(() => updateItem('dwellings', d, { ignored: true, ignored_reason: reason.trim() }));
  }

  function restoreDwelling(d) {
    return run(() => updateItem('dwellings', d, { ignored: false }));
  }

  const DWELLINGS_LIMIT = 50;
  /** Ordre de la liste : à vérifier, ajoutés à la main, IGN, supprimés ; puis près des postes. */
  function sortedDwellings() {
    const all = ed.data?.dwellings ?? [];
    const rank = (d) => (d.ignored ? 3 : d.missing_since || d.likely_non_residential ? 0 : d.source === 'manuel' ? 1 : 2);
    const anchor = (g) => (g.type === 'Point' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0][0] : g.coordinates[0][0][0]);
    const near = new Map(all.map((d) => {
      let best = null;
      for (const p of ed.data.posts) {
        const m = distanceMeters(anchor(d.geom), p.geom.coordinates);
        if (!best || m < best.m) best = { p, m };
      }
      return [d.id, best];
    }));
    const sorted = [...all].sort((a, b) => rank(a) - rank(b) || (near.get(a.id)?.m ?? 0) - (near.get(b.id)?.m ?? 0));
    return { all, sorted, near, rank };
  }
  const dwellingRank = (id) => sortedDwellings().sorted.findIndex((d) => d.id === id);

  async function refreshDwellings() {
    toast('Import des bâtiments IGN en cours… (jusqu’à une minute pour un grand territoire)');
    try {
      const { report } = await api.post(`/territories/${ed.territoryId}/dwellings/refresh`, {});
      toast(importSummary(report));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    await reload();
  }

  /** Section dépliable (fermée au départ, état gardé entre deux rendus). */
  function foldSection(key, title, extra, ...content) {
    const d = h('details.fold', { open: ed.open.has(key) },
      h('summary', h('span', title), extra ? h('span.small.muted', ` ${extra}`) : null),
      ...content);
    d.addEventListener('toggle', () => { if (d.open) ed.open.add(key); else ed.open.delete(key); });
    return d;
  }

  /** Symbole d'état : grisé quand la condition n'est pas remplie. */
  const sym = (icon, ok, yes, no) => h('span.sym', { class: ok ? '' : 'off', title: ok ? yes : no, 'aria-label': ok ? yes : no }, icon);

  /** Ligne de liste : symboles, libellé (zoom), ✏️ éditer, 🗑 supprimer. */
  function objectRow(kind, it, { symbols = [], label, note, onDelete, deleteTitle = 'Supprimer', deleteIcon = '🗑', dim = false }) {
    const edit = () => {
      select(kind, it.id, { zoom: true });
      panel.querySelector('.props')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    return h('li.obj-row', { class: [isSelected(kind, it.id) ? 'active' : '', dim ? 'dim' : ''].join(' ') },
      symbols.length ? h('span.syms', symbols) : null,
      h('button.link.obj-label', { onclick: () => select(kind, it.id, { zoom: true }), title: 'Voir sur la carte' }, label,
        note ? h('span.small.muted', ` ${note}`) : null),
      h('span.obj-actions',
        h('button.icon', { onclick: edit, title: canEdit ? 'Modifier' : 'Détails', 'aria-label': canEdit ? 'Modifier' : 'Détails' }, '✏️'),
        canEdit && onDelete ? h(deleteIcon === '🗑' ? 'button.icon.danger' : 'button.icon', { onclick: onDelete, title: deleteTitle, 'aria-label': deleteTitle }, deleteIcon) : null));
  }

  async function confirmDelete(kind, item, title, message) {
    if (!(await confirmDialog(title, message, 'Supprimer', true))) return;
    run(async () => {
      await deleteItem(kind, item);
      if (isSelected(kind, item.id)) ed.selected = null;
    });
  }

  const postLabel = (p) => `${p.number}${p.name ? ` (${p.name})` : ''}`;

  /** Suppression confirmée d'un poste, parking ou réserve (liste ou fiche). */
  function askDelete(kind, item) {
    if (kind === 'posts') {
      const plans = item.plan_uses ?? [];
      return confirmDelete('posts', item, 'Supprimer le poste', `Supprimer le poste ${postLabel(item)}${item.access_path ? ' et son chemin d’accès' : ''} ?${plans.length ? ` Il est utilisé dans les plans de chasse ${plans.join(', ')} chasseurs : ces grilles deviendront incomplètes.` : ''} (Annulable avec ↶.)`);
    }
    if (kind === 'dwellings') return removeDwelling(item);
    if (kind === 'reserves') return confirmDelete('reserves', item, 'Supprimer la réserve', `Supprimer la réserve « ${item.name || 'Réserve'} » ? (Annulable avec ↶.)`);
    return confirmDelete(kind, item, 'Supprimer', 'Supprimer cet élément ? (Annulable avec ↶.)');
  }

  function postsSection() {
    const posts = [...ed.data.posts].sort((a, b) => a.number - b.number);
    const problems = posts.filter((p) => p.invalid_reason || !p.parking_id || !p.access_path || isOutside(p)).length;
    return foldSection('posts', `Postes (${posts.length})`, problems ? `· ${problems} à compléter` : '',
      posts.length ? h('details.legend.small.muted', h('summary', 'ⓘ Légende'), '🅿 parking · 🥾 chemin · ✅ actif · 🗺 dans le territoire (grisé : non) · ⚠ consignes particulières · ⛔ trop près d’une habitation') : h('p.small.muted', 'Aucun poste : « + Poste » pour en placer un.'),
      h('ul.obj-list', posts.map((p) => objectRow('posts', p, {
        symbols: [
          sym('🅿', !!p.parking_id, 'Parking associé', 'Pas de parking associé'),
          sym('🥾', !!p.access_path, `Chemin d’accès${p.access_path_length_m ? ` (${p.access_path_length_m} m)` : ''}`, 'Pas de chemin d’accès'),
          sym('✅', p.active, 'Actif', 'Inactif'),
          sym('🗺', !isOutside(p), 'Dans le territoire', 'Hors du territoire'),
        ],
        label: [
          p.invalid_reason ? h('span', { title: 'Trop près d’une habitation : à déplacer' }, '⛔ ') : hasSpecial(p) ? h('span', { title: 'Consignes particulières' }, '⚠ ') : null,
          String(p.number),
          p.name ? h('span.post-name', ` (${p.name})`) : null,
        ],
        note: (ed.data.lines ?? []).find((l) => l.id === p.line_id)?.name ? `· ${(ed.data.lines ?? []).find((l) => l.id === p.line_id).name}` : '',
        dim: !p.active,
        onDelete: () => askDelete('posts', p),
      }))));
  }

  function reservesSection() {
    const reserves = ed.data.reserves;
    return foldSection('reserves', `Réserves (${reserves.length})`, '',
      reserves.length ? null : h('p.small.muted', 'Aucune réserve : « + Réserve » pour en dessiner une.'),
      h('ul.obj-list', reserves.map((r) => objectRow('reserves', r, {
        label: r.name || 'Réserve',
        note: `· ${r.area_ha.toLocaleString('fr-FR')} ha${r.reason ? ` · ${r.reason}` : ''}`,
        onDelete: () => askDelete('reserves', r),
      }))));
  }

  /** Bâtiments IGN et habitations ajoutées à la main, dans une seule liste. */
  function dwellingsSection() {
    const { all, sorted, near, rank } = sortedDwellings();
    const where = (d) => { const n = near.get(d.id); return n ? `à ${Math.round(n.m)} m du poste ${n.p.number}` : ''; };
    const toCheck = all.filter((d) => rank(d) === 0).length;
    const shown = ed.allDwellings ? sorted : sorted.slice(0, DWELLINGS_LIMIT);
    return foldSection('dwellings', `Bâtiments (${all.filter((d) => !d.ignored).length})`, toCheck ? `· ⚠ ${toCheck} à vérifier` : '',
      all.length ? h('details.legend.small.muted', h('summary', 'ⓘ Légende'), '🏛 IGN · ✍ ajoutée à la main · ⚠ à vérifier · 🚫 supprimé (ne compte plus, rétablissable)') : h('p.small.muted', 'Aucun bâtiment : actualisez-les depuis la section « Données ».'),
      h('ul.obj-list', shown.map((d) => objectRow('dwellings', d, {
        symbols: [
          h('span.sym', { title: d.source === 'manuel' ? 'Ajoutée à la main' : 'Bâtiment IGN (BD TOPO)' }, d.source === 'manuel' ? '✍' : '🏛'),
          d.ignored ? h('span.sym', { title: `Supprimé : ${d.ignored_reason ?? ''}` }, '🚫')
            : rank(d) === 0 ? h('span.sym', { title: d.missing_since ? 'Disparu de la BD TOPO' : 'Probablement pas une habitation' }, '⚠') : null,
        ],
        label: dwellingLabel(d),
        note: [where(d), d.ignored ? d.ignored_reason ?? 'supprimé' : d.missing_since ? 'disparu de la BD TOPO' : ''].filter(Boolean).map((x) => `· ${x}`).join(' '),
        dim: d.ignored,
        onDelete: d.ignored ? () => restoreDwelling(d) : () => removeDwelling(d),
        deleteTitle: d.ignored ? 'Rétablir' : 'Supprimer',
        deleteIcon: d.ignored ? '↺' : '🗑',
      }))),
      sorted.length > DWELLINGS_LIMIT ? h('button.link.small', { onclick: () => { ed.allDwellings = !ed.allDwellings; render(); } },
        ed.allDwellings ? 'Réduire la liste' : `Afficher les ${sorted.length - DWELLINGS_LIMIT} autres`) : null,
      h('p.small.muted', 'Cliquez un bâtiment sur la carte pour le sélectionner.'));
  }

  function exclusionSummary() {
    const ex = ed.data.exclusion;
    const ds = ed.data.dwellings ?? [];
    const invalid = ed.data.posts.filter((p) => p.invalid_reason).length;
    if (!ex) return null;
    const pct = ed.data.territory.area_ha ? Math.round((100 * ex.area_ha) / ed.data.territory.area_ha) : 0;
    const kept = ds.filter((d) => !d.ignored).length;
    return h('section.zone-summary',
      h('p', { title: `Habitations à moins de ${ex.buffer_distance_m} m${ex.dwellings_refreshed_at ? ` · bâtiments IGN du ${new Date(ex.dwellings_refreshed_at).toLocaleDateString('fr-FR')}` : ''}` },
        h('span.swatch.exclusion'), h('strong', 'Non chassable'), ` ${ex.area_ha.toLocaleString('fr-FR')} ha (${pct} %) · ${kept} habitation${kept > 1 ? 's' : ''} à ${ex.buffer_distance_m} m`),
      ex.needs_refresh ? h('p.alert.warn', 'Bâtiments à actualiser ', canEdit ? h('button.link', { onclick: refreshDwellings }, 'Actualiser') : null) : null,
      invalid ? h('p.alert.danger', `⛔ ${invalid} poste(s) trop près d’une habitation`) : null,
    );
  }

  function renderPanel() {
    const busy = ed.mode || ed.recording;
    const tools = canEdit && ed.data && !busy
      ? h('div.buttons',
          h('button', { onclick: () => startDraw('reserves') }, '+ Réserve'),
          h('button', { onclick: () => startDraw('posts') }, '+ Poste'),
          h('button', { onclick: () => startDraw('dwellings'), title: 'Habitation absente de la BD TOPO' }, '+ Habitation'),
          h('button', { onclick: undo, disabled: !history.peekLabel(), title: history.peekLabel() ? `Annuler : ${history.peekLabel()}` : 'Rien à annuler' }, '↶'))
      : null;
    const rec = ed.recording;
    const t = ed.data?.territory;

    fill(panel,
      h('a.small', { href: '#/territoires' }, '← Territoires'),
      ed.pendingTerritory
        ? h('h2.editor-title', `Nouveau territoire « ${ed.pendingTerritory.name} »`)
        : t
          ? h('h2.editor-title', h('button.link', { onclick: () => select('territories', t.id, { zoom: true }), title: 'Renommer, notes, supprimer' }, t.name),
              h('span.small.muted', ` ${t.area_ha.toLocaleString('fr-FR')} ha`))
          : h('p.muted', 'Territoire introuvable.'),
      ed.data ? exclusionSummary() : null,
      ed.mode
        ? h('div.hint', h('p', DRAW_HINTS[ed.mode]), h('button', { onclick: cancelDraw }, 'Annuler (Échap)'))
        : null,
      rec
        ? h('div.hint.recording',
            h('p', h('strong', `Enregistrement du trajet vers le poste ${rec.post.number}`)),
            h('p', `${rec.coords.length} points · ${Math.round(lineLengthMeters(rec.coords))} m · précision ${rec.accuracy ?? '…'} m`),
            h('p.small', 'Gardez l’écran allumé et cette page ouverte pendant la marche.'),
            h('div.buttons', h('button.primary', { onclick: () => stopRecording(true) }, 'Arrivé au poste'), h('button', { onclick: () => stopRecording(false) }, 'Abandonner')))
        : null,
      tools,
      propertiesPanel(),
      ed.data ? postsSection() : null,
      ed.data ? linesSection() : null,
      ed.data ? reservesSection() : null,
      ed.data ? dwellingsSection() : null,
      ed.data && !busy
        ? foldSection('data', 'Données', 'import, export, IGN',
            h('div.buttons',
              canEdit ? h('button', { onclick: pickFile }, 'Importer (GeoJSON, KML, GPX)') : null,
              h('button', { onclick: exportGeoJSON }, 'Exporter GeoJSON'),
              canEdit ? h('button', { onclick: refreshDwellings }, 'Actualiser les bâtiments (IGN)') : null))
        : null,
      h('p.disclaimer', 'Aide au placement uniquement : la responsabilité du placement des postes reste celle du président.'),
    );
  }

  // -------------------------------------------------------------------------
  // Clavier, démarrage, nettoyage
  // -------------------------------------------------------------------------

  const onKey = (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if (e.key === 'Escape' && ed.mode) {
      cancelDraw();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !typing && canEdit) {
      e.preventDefault();
      undo();
    }
  };
  document.addEventListener('keydown', onKey);
  const unsubscribe = history.onChange(() => renderPanel());

  try {
    if (!start) {
      location.hash = '#/territoires'; // l'éditeur s'ouvre toujours sur un territoire précis
      return () => map.remove();
    }
    if (start === 'nouveau') {
      // Création : carte vide (pas de territoire en dessous), centrée à
      // quelques kilomètres autour de la cabane de chasse si elle est définie,
      // sinon d'un lieu, d'un parking ou d'un territoire existant.
      render();
      try {
        const [{ places }, { territories }] = await Promise.all([api.get('/places'), api.get('/territories')]);
        ed.places = places.filter((p) => p.visibility !== 'private' && p.in_season !== false);
        render();
        const center = startCenter({ places: ed.places, territories });
        if (center) map.setView(center, CREATE_ZOOM, { animate: false });
      } catch { /* cadrage par défaut */ }
      if (canEdit) setTimeout(newTerritory, 300);
    } else {
      ed.territoryId = start;
      await loadTerritories();
      await reload();
    }
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
  setTimeout(() => map.invalidateSize(), 0);

  return () => {
    document.removeEventListener('keydown', onKey);
    unsubscribe();
    if (ed.recording) stopRecording(false);
    map.remove();
  };
}
