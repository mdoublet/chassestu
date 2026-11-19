// Éditeur cartographique (lot 1) : territoires, réserves, parkings, postes et
// chemins d'accès sur fond IGN. Chaque modification est enregistrée
// immédiatement côté serveur (source de vérité) ; Ctrl+Z applique l'opération
// inverse (50 pas).
import L from '../map/leaflet.js';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon, parkingIcon } from '../map/shapes.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, confirmDialog, promptDialog, modal } from '../ui.js';
import { History } from '../lib/history.js';
import { checkPost, selfIntersects } from '../lib/checks.js';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { simplifyMeters, lineLengthMeters, distanceMeters } from '../lib/simplify.js';
import { parseGeoFile } from '../lib/importer.js';
import { DIFFICULTY_LABELS } from '../lib/hunts.js';

/** Champs nécessaires pour recréer un objet supprimé (annulation). */
const FIELDS = {
  reserves: ['name', 'reason', 'geom'],
  parkings: ['name', 'geom'],
  posts: ['number', 'name', 'geom', 'parking_id', 'access_path', 'instructions', 'active', 'access_difficulty'],
  dwellings: ['geom', 'comment'],
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
  warningBand: { color: '#e8a33d', weight: 1, dashArray: '4 4', fillColor: '#e8a33d', fillOpacity: 0.12 },
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
  territory: 'Cliquez pour placer les sommets du territoire ; cliquez sur le premier sommet pour fermer.',
  reserves: 'Dessinez la zone de réserve ; cliquez sur le premier sommet pour fermer.',
  parkings: 'Cliquez sur la carte pour placer le parking.',
  posts: 'Cliquez sur la carte pour placer le poste : dans le territoire ou à sa lisière (pointillés verts), hors réserve et hors zone non chassable.',
  dwellings: 'Cliquez à l’emplacement de l’habitation manquante (construction récente, caravane habitée…).',
  path: 'Tracez le chemin à pied du parking jusqu’au poste ; cliquez sur le dernier point pour terminer.',
};

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));


function importSummary(report) {
  if (!report) return 'Bâtiments déjà à jour.';
  const parts = [`${report.total} bâtiment(s) IGN`];
  if (report.added) parts.push(`${report.added} nouveau(x)`);
  if (report.missing) parts.push(`${report.missing} disparu(s) de la BD TOPO (à vérifier)`);
  return `${parts.join(', ')}. Zone non chassable recalculée.`;
}

function postTooltip(p, bufferM = 150) {
  const label = `Poste ${p.number}${p.name ? ` · ${p.name}` : ''}`;
  if (p.invalid_reason) return `⛔ ${label} — invalide : à moins de ${bufferM} m d’une habitation, à déplacer`;
  if (p.nearest_dwelling_m != null) return `⚠ ${label} — habitation à ${p.nearest_dwelling_m} m : ne pas tirer dans sa direction`;
  return label;
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
  };

  ensureHatchPattern();
  const panel = h('aside.panel');
  const mapEl = h('div.map');
  main.append(h('div.editor', mapEl, panel));

  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  if (import.meta.env.DEV) window.__map = map; // tests de bout en bout (jamais en production)
  addBasemaps(map);
  map.pm.setLang('fr');
  map.pm.setGlobalOptions({ snappable: true, snapDistance: 20, allowSelfIntersection: false });

  // Bâtiments au-dessus du territoire et des zones (sinon le territoire prend le
  // clic), sous les postes. SVG : seuls les bâtiments captent le clic.
  map.createPane('dwellings');
  map.getPane('dwellings').style.zIndex = 450;
  const dwellingRenderer = L.svg({ pane: 'dwellings', padding: 0.5 });
  const groups = {
    others: L.featureGroup().addTo(map), // autres territoires, sous le territoire actif
    territory: L.featureGroup().addTo(map),
    exclusion: L.featureGroup().addTo(map),
    dwellings: L.featureGroup().addTo(map),
    reserves: L.featureGroup().addTo(map),
    paths: L.featureGroup().addTo(map),
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
    warning: data?.exclusion?.warning_geom,
    bufferM: data?.exclusion?.buffer_distance_m,
    warningM: data?.exclusion?.warning_margin_m,
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
    render();
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

    // Zone non chassable (hachures orange) et bande d'avertissement
    if (exclusion?.warning_geom) {
      groups.exclusion.addLayer(L.geoJSON(exclusion.warning_geom, { style: STYLE.warningBand, interactive: false }));
    }
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

    // Parkings
    for (const pk of parkings) {
      const m = L.marker(toLatLng(pk.geom.coordinates), { icon: parkingIcon(isSelected('parkings', pk.id) ? 'selected' : ''), draggable: canEdit, title: pk.name, bubblingMouseEvents: true });
      m.bindTooltip(escapeHtml(pk.name), { direction: 'top', offset: [0, -12] });
      m.on('click', onPick('parkings', pk.id));
      m.on('dragend', () => {
        const { lat, lng } = m.getLatLng();
        run(() => updateItem('parkings', pk, { geom: { type: 'Point', coordinates: [lng, lat] } }));
      });
      groups.parkings.addLayer(m);
    }

    // Postes : contrôle en direct pendant le glisser-déposer
    const reserveGeoms = allReserveGeoms();
    const zones = zonesFor(ed.data);
    for (const p of posts) {
      const cls = [
        isSelected('posts', p.id) ? 'selected' : '',
        p.active ? '' : 'inactive',
        p.invalid_reason ? 'invalid-static' : p.nearest_dwelling_m != null ? 'warning' : '',
      ].join(' ');
      const m = L.marker(toLatLng(p.geom.coordinates), { icon: postIcon(p.number, cls), draggable: canEdit, title: `Poste ${p.number}`, bubblingMouseEvents: true });
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
        run(() => updateItem('posts', p, { geom: { type: 'Point', coordinates: [lng, lat] } }));
      });
      groups.posts.addLayer(m);
    }

    if (!ed.fitted) {
      ed.fitted = true;
      map.fitBounds(tLayer.getBounds(), { padding: [30, 30] });
    }
  }

  function saveShape(kind, item, geom) {
    if (selfIntersects(geom)) {
      toast('Le contour se recoupe lui-même : modification refusée.', 'error');
      return reload();
    }
    return run(() => updateItem(kind, item, { geom }));
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
    if (mode === 'parkings') options.markerStyle = { icon: parkingIcon() };
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
        toast('Territoire en cours de création, import des bâtiments IGN…');
        const { territory, dwellings_import, import_error } = await api.post('/territories', { name, geom });
        toast(import_error ? `Territoire créé, mais ${import_error.charAt(0).toLowerCase()}${import_error.slice(1)}` : importSummary(dwellings_import), import_error ? 'warn' : 'info');
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
    if (mode === 'parkings') {
      const name = await promptDialog('Nouveau parking', 'Nom du parking', `Parking ${ed.data.parkings.length + 1}`);
      if (!name) return render();
      return run(async () => {
        const item = await createItem('parkings', { name, geom });
        ed.selected = { kind: 'parkings', id: item.id };
      });
    }
    if (mode === 'dwellings') {
      const comment = await promptDialog('Habitation manquante', 'Description (ex. maison récente, caravane habitée)', '');
      if (comment === null) return render();
      return run(async () => {
        const item = await createItem('dwellings', { geom, comment });
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
            const { territory, import_error } = await api.post('/territories', { name: item.label || filename.replace(/\.\w+$/, ''), geom: item.geometry });
            if (import_error) errors.push(`Bâtiments IGN : ${import_error}`);
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
      const plans = kind === 'posts' ? item.plan_counts ?? [] : [];
      if (plans.length && (key === 'number' || (key === 'active' && value === false))) {
        const what = key === 'number'
          ? `Le poste ${item.number} devient le poste ${value} : son numéro change aussi dans les plans à ${plans.join(', ')} chasseurs (listes papier à refaire).`
          : `Désactiver le poste ${item.number} rend invalides les plans à ${plans.join(', ')} chasseurs.`;
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
                if (!(await confirmDialog('Supprimer le territoire', `Supprimer « ${t.name} » avec ses réserves, parkings, postes et chemins ? Cette suppression ne peut pas être annulée.`, 'Supprimer', true))) return;
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
    const del = canEdit
      ? h('button.danger', {
          onclick: async () => {
            const plans = kind === 'posts' ? item.plan_counts ?? [] : [];
            if (plans.length && !(await confirmDialog('Supprimer le poste', `Le poste ${item.number} est utilisé dans les plans à ${plans.join(', ')} chasseurs : ces plans deviendront incomplets.`, 'Supprimer', true))) return;
            run(async () => { await deleteItem(kind, item); ed.selected = null; });
          },
        }, 'Supprimer')
      : null;

    if (kind === 'reserves') {
      return h('section.props', h('h3', 'Zone de réserve'), field('Nom', bound(kind, item, 'name', { maxlength: 200 })), field('Motif', bound(kind, item, 'reason', { maxlength: 1000 })), h('p.small', `${item.area_ha.toLocaleString('fr-FR')} ha`), del);
    }
    if (kind === 'dwellings') return dwellingPanel(item);
    if (kind === 'parkings') {
      return h('section.props', h('h3', 'Parking'), field('Nom', bound(kind, item, 'name', { maxlength: 200, required: true })), h('p.small', 'Glissez l’icône pour déplacer le parking.'), del);
    }
    // Poste
    const parkingSelect = bound(kind, item, 'parking_id', {}, 'select');
    parkingSelect.append(h('option', { value: '' }, '— aucun —'), ...ed.data.parkings.map((pk) => h('option', { value: pk.id, selected: pk.id === item.parking_id }, pk.name)));
    parkingSelect.value = item.parking_id ?? '';
    return h(
      'section.props',
      h('h3', `Poste ${item.number}`),
      item.invalid_reason
        ? h('p.alert.danger', `Poste invalide : il est à moins de ${ed.data.exclusion?.buffer_distance_m ?? 150} m d’une habitation. Déplacez-le ; il ne sera pas proposé pour les battues tant qu’il est invalide.`)
        : item.nearest_dwelling_m != null
          ? h('p.alert.warn', `Habitation à ${item.nearest_dwelling_m} m : rappeler l’interdiction de tirer en direction de l’habitation.`)
          : null,
      (item.plan_counts ?? []).length
        ? h('p.small', `Utilisé dans les plans à ${item.plan_counts.join(', ')} chasseurs. `, h('a', { href: '#/plans' }, 'Voir les plans'))
        : null,
      isOutside(item) ? h('p.alert.warn', 'Poste hors du territoire : il faut le droit de chasse à cet endroit (ou l’accord du propriétaire).') : null,
      h('div.row', field('Numéro', bound(kind, item, 'number', { type: 'number', min: 1, max: 999, required: true })), field('Nom', bound(kind, item, 'name', { maxlength: 200 }))),
      field('Parking', parkingSelect),
      field('Difficulté d’accès (pour les chasseurs qui marchent peu)', difficultySelect(item)),
      field('Consignes', bound(kind, item, 'instructions', { rows: 3, maxlength: 2000 }, 'textarea')),
      h('label.check', bound(kind, item, 'active', { type: 'checkbox' }), 'Poste actif'),
      h('p.small', item.access_path ? `Chemin d’accès : ${item.access_path_length_m} m. Déplacez ses sommets pour l’ajuster.` : 'Pas encore de chemin d’accès.'),
      canEdit
        ? h(
            'div.buttons',
            h('button', { onclick: () => startDraw('path') }, item.access_path ? 'Retracer le chemin' : 'Tracer le chemin'),
            h('button', { onclick: () => startRecording(item) }, 'Enregistrer en marchant'),
            item.access_path ? h('button', { onclick: () => run(() => updateItem('posts', item, { access_path: null })) }, 'Effacer le chemin') : null,
          )
        : null,
      del,
    );
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
      d.usage ? `Usage : ${d.usage}` : ign ? 'Usage non renseigné par l’IGN' : null,
      d.comment ? `Note : ${d.comment}` : null,
      d.missing_since ? `Absent de la BD TOPO depuis le ${new Date(d.missing_since).toLocaleDateString('fr-FR')} (démoli ?).` : null,
      d.likely_non_residential && !d.ignored ? 'Probablement pas une habitation d’après l’IGN : à vérifier sur place.' : null,
    ].filter(Boolean);
    const reason = h('input', { maxlength: 500, placeholder: 'Pourquoi ? ex. ruine, hangar sans logement' });
    const remove = () => {
      if (!ign) return run(async () => { await deleteItem('dwellings', d); ed.selected = null; });
      if (reason.value.trim().length < 3) {
        toast('Indiquez pourquoi ce bâtiment n’est pas une habitation.', 'error');
        reason.focus();
        return undefined;
      }
      return run(() => updateItem('dwellings', d, { ignored: true, ignored_reason: reason.value.trim() }));
    };
    return h('section.props',
      h('h3', d.ignored ? 'Bâtiment supprimé' : 'Bâtiment'),
      facts.map((f) => h('p.small', f)),
      d.ignored
        ? [
            h('p.small.alert.muted', `Supprimé le ${new Date(d.ignored_at).toLocaleDateString('fr-FR')} (${d.ignored_reason}) : il ne compte plus dans la zone non chassable.`),
            canEdit ? h('button', { onclick: () => run(() => updateItem('dwellings', d, { ignored: false })) }, 'Rétablir comme habitation') : null,
          ]
        : [
            h('p.small', `Compté comme habitation : pas de poste ni de tir à moins de ${buffer} m.`),
            canEdit ? [
              ign ? reason : null,
              h('button.danger', { onclick: remove }, 'Supprimer ce bâtiment'),
              ign ? h('p.small.muted', 'À faire seulement si vous êtes sûr qu’il n’est pas habité. Il reste mémorisé pour ne pas revenir à la prochaine actualisation IGN, et peut être rétabli.') : null,
            ] : null,
          ]);
  }

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

  function listSection(title, kind, items, labelOf) {
    if (!items.length) return null;
    return h(
      'section',
      h('h3', title),
      h('ul.objects', items.map((it) => h('li', h('button.link', { class: isSelected(kind, it.id) ? 'active' : '', onclick: () => select(kind, it.id, { zoom: true }) }, labelOf(it))))),
    );
  }

  function exclusionSummary() {
    const ex = ed.data.exclusion;
    const ds = ed.data.dwellings ?? [];
    const invalid = ed.data.posts.filter((p) => p.invalid_reason).length;
    if (!ex) return null;
    const pct = ed.data.territory.area_ha ? Math.round((100 * ex.area_ha) / ed.data.territory.area_ha) : 0;
    return h(
      'section.zone-summary',
      h('p', h('span.swatch.exclusion'), h('strong', 'Non chassable'), ` (habitations à moins de ${ex.buffer_distance_m} m) : ${ex.area_ha.toLocaleString('fr-FR')} ha, soit ${pct} % du territoire.`),
      h('p.small', `${ds.filter((d) => !d.ignored).length} habitation(s) prise(s) en compte, ${ds.filter((d) => d.ignored).length} ignorée(s).`,
        ex.dwellings_refreshed_at ? ` Bâtiments IGN du ${new Date(ex.dwellings_refreshed_at).toLocaleDateString('fr-FR')}.` : ''),
      ex.needs_refresh ? h('p.alert.warn', 'Bâtiments à actualiser : jamais importés, ou territoire / distance modifiés depuis le dernier import.') : null,
      invalid ? h('p.alert.danger', `${invalid} poste(s) invalide(s) : trop près d’une habitation, à déplacer.`) : null,
      ex.needs_refresh && canEdit ? h('p.small.muted', 'Actualisation : section « Données et bâtiments » en bas.') : null,
    );
  }

  function renderPanel() {
    const busy = ed.mode || ed.recording;
    const tools = canEdit && ed.data && !busy
      ? h('div.buttons',
          h('button', { onclick: () => startDraw('reserves') }, '+ Réserve'),
          h('button', { onclick: () => startDraw('parkings') }, '+ Parking'),
          h('button', { onclick: () => startDraw('posts') }, '+ Poste'),
          h('button', { onclick: () => startDraw('dwellings'), title: 'Habitation absente de la BD TOPO' }, '+ Habitation'),
          h('button', { onclick: undo, disabled: !history.peekLabel(), title: history.peekLabel() ? `Annuler : ${history.peekLabel()}` : 'Rien à annuler' }, '↶'))
      : null;
    const rec = ed.recording;
    const t = ed.data?.territory;
    const dwellings = ed.data?.dwellings ?? [];
    const toCheck = dwellings.filter((d) => !d.ignored && (d.likely_non_residential || d.missing_since));
    const manual = dwellings.filter((d) => d.source === 'manuel');

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
      ed.data ? listSection('Postes', 'posts', ed.data.posts, (p) => `${p.invalid_reason ? '⛔ ' : p.nearest_dwelling_m != null ? '⚠ ' : ''}${p.number}${p.name ? ` · ${p.name}` : ''}${isOutside(p) ? ' (hors territoire)' : ''}${p.access_path ? '' : ' (sans chemin)'}${p.active ? '' : ' (inactif)'}`) : null,
      ed.data ? listSection('Parkings', 'parkings', ed.data.parkings, (p) => p.name) : null,
      ed.data ? listSection('Réserves', 'reserves', ed.data.reserves, (r) => r.name || 'Réserve') : null,
      // Rarement utile : fermé au départ.
      ed.data && !busy
        ? h('details.more-tools',
            h('summary', `Données et bâtiments${toCheck.length ? ` · ${toCheck.length} à vérifier` : ''}`),
            h('div.buttons',
              canEdit ? h('button', { onclick: pickFile }, 'Importer (GeoJSON, KML, GPX)') : null,
              h('button', { onclick: exportGeoJSON }, 'Exporter GeoJSON'),
              canEdit ? h('button', { onclick: refreshDwellings }, 'Actualiser les bâtiments (IGN)') : null),
            listSection('Bâtiments à vérifier', 'dwellings', toCheck, (d) => d.missing_since ? `Disparu de la BD TOPO · ${d.usage || 'bâtiment'}` : d.usage || 'Bâtiment'),
            listSection('Habitations ajoutées', 'dwellings', manual, (d) => d.comment || 'Habitation'),
            h('p.small.muted', 'Astuce : cliquez un bâtiment sur la carte pour l’identifier et, si besoin, ne plus le compter.'))
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
      // Création : carte vide (pas de territoire en dessous), le nom puis le contour.
      render();
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
