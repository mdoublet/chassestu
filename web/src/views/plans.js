// Plans de chasse d'un territoire. Chaque plan de chasse décrit une traque
// (départ, tracé, sortie) et sa grille de couverture : une ligne par effectif,
// une colonne par poste, des cases à cocher. La carte met en évidence les
// postes de la ligne survolée ou sélectionnée ; un clic sur un poste de la
// carte le coche dans la ligne sélectionnée. Chaque ligne s'enregistre
// séparément, et seulement si le nombre de postes cochés égale l'effectif.
import L from '../map/leaflet.js';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon, traqueIcon, traqueLayers, placeMarker } from '../map/shapes.js';
import { kindIcon } from './place-picker.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, confirmDialog, promptDialog, fold } from '../ui.js';
import { freeCounts, previousCount, rowStatus, sameSet, selectable } from '../lib/plans.js';
import { panelResizer } from '../map/resizer.js';
import { setInSeason } from '../lib/season.js';

const TERRITORY_KEY = 'chassestu.plansTerritory';

function storedTerritory() {
  try {
    return localStorage.getItem(TERRITORY_KEY);
  } catch {
    return null;
  }
}

export async function plansView(main, territoryId, huntPlanId) {
  const canEdit = state.role === 'president';
  const ps = {
    territories: [],
    territoryId: territoryId ?? storedTerritory(),
    huntPlans: [], // plans de chasse du territoire (avec leur grille)
    huntPlanId: huntPlanId ?? null,
    placing: null, // 'start' | 'exit' | 'path' : dessin de la traque en cours
    collapsed: false, // bloc du plan de chasse actif replié
    data: null, // détail du territoire (postes, zones…)
    plans: [], // plans enregistrés (serveur)
    rows: new Map(), // effectif → { saved: Set|null, current: Set, plan }
    selected: null, // effectif de la ligne sélectionnée
    hover: null,
    fitted: false,
  };

  ensureHatchPattern();
  // Même principe que l'éditeur de territoire : carte, poignée, panneau à droite.
  const gridBox = h('div.plans-grid');
  const mapEl = h('div.map');
  const head = h('div.plans-head');
  const traqueBox = h('div.traque-box');
  const listBox = h('div.hunt-plan-list');
  const panel = h('aside.panel.plans-panel', head, listBox);
  const resizer = panelResizer(panel, { key: 'chassestu.plansPanelWidth', defaultWidth: 520, onResize: () => map.invalidateSize() });
  main.append(h('div.editor', mapEl, resizer, panel));

  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  addBasemaps(map, { zones: true });
  map.pm.setLang('fr');
  if (import.meta.env.DEV) window.__plansMap = map; // tests de bout en bout (jamais en production)
  const layers = { base: L.featureGroup().addTo(map), traque: L.featureGroup().addTo(map), posts: L.featureGroup().addTo(map) };
  const markers = new Map(); // post_id → marker

  // -------------------------------------------------------------------------
  // Données
  // -------------------------------------------------------------------------

  async function load() {
    ps.territories = (await api.get('/territories')).territories;
    if (!ps.territories.some((t) => t.id === ps.territoryId)) ps.territoryId = ps.territories[0]?.id ?? null;
    if (!ps.territoryId) {
      fill(gridBox, h('p.muted', 'Aucun territoire : dessinez-en un dans la cartographie.'));
      renderHead();
      return;
    }
    try { localStorage.setItem(TERRITORY_KEY, ps.territoryId); } catch { /* préférence non mémorisée */ }
    const [detail, hps] = await Promise.all([
      api.get(`/territories/${ps.territoryId}`),
      api.get(`/territories/${ps.territoryId}/hunt-plans`),
    ]);
    ps.data = detail;
    // Plans de la saison en cours ; les autres sont proposés à la fin (« Hors saison »).
    ps.huntPlans = hps.hunt_plans.filter((x) => x.in_season !== false);
    ps.offSeason = hps.hunt_plans.filter((x) => x.in_season === false);
    if (!ps.huntPlans.some((x) => x.id === ps.huntPlanId)) ps.huntPlanId = ps.huntPlans[0]?.id ?? null;
    if (ps.huntPlanId) history.replaceState(null, '', `#/plans/${ps.territoryId}/${ps.huntPlanId}`);
    ps.plans = huntPlan()?.coverage ?? [];
    // On garde les lignes non enregistrées (brouillons) ; on resynchronise les autres.
    const drafts = new Map([...ps.rows].filter(([, r]) => !r.saved || !sameSet(r.saved, r.current)));
    ps.rows = new Map();
    for (const plan of ps.plans) {
      const saved = new Set(plan.post_ids);
      const draft = drafts.get(plan.hunter_count);
      ps.rows.set(plan.hunter_count, { saved, current: draft ? draft.current : new Set(saved), plan });
    }
    for (const [count, r] of drafts) if (!ps.rows.has(count)) ps.rows.set(count, { saved: null, current: r.current, plan: null });
    if (ps.selected !== null && !ps.rows.has(ps.selected)) ps.selected = null;
    renderMap();
    renderAll();
  }

  const posts = () => ps.data?.posts ?? [];
  const huntPlan = () => ps.huntPlans.find((x) => x.id === ps.huntPlanId) ?? null;
  const counts = () => [...ps.rows.keys()].sort((a, b) => a - b);
  const isDirty = (r) => !r.saved || !sameSet(r.saved, r.current);

  // -------------------------------------------------------------------------
  // Carte
  // -------------------------------------------------------------------------

  function renderMap() {
    layers.base.clearLayers();
    layers.posts.clearLayers();
    markers.clear();
    if (!ps.data) return;
    const { territory, reserves, exclusion } = ps.data;
    const tLayer = L.geoJSON(territory.geom, { style: { color: '#1f5130', weight: 3, fillOpacity: 0.04 }, interactive: false });
    layers.base.addLayer(tLayer);
    if (exclusion?.geom) layers.base.addLayer(L.geoJSON(exclusion.geom, { style: { color: '#d9480f', weight: 1, fillOpacity: 1, className: 'exclusion-shape' }, interactive: false }));
    for (const r of reserves) layers.base.addLayer(L.geoJSON(r.geom, { style: { color: '#c92a2a', weight: 1, fillOpacity: 1, className: 'reserve-shape' }, interactive: false }));
    // Lieux de l'association, parkings compris (repères).
    for (const p of ps.data.places ?? []) layers.base.addLayer(placeMarker(p, kindIcon(p.kind)));
    for (const p of posts()) {
      const m = L.marker(toLatLng(p.geom.coordinates), { icon: postIcon(p.number), title: `Poste ${p.number}` });
      m.bindTooltip(escapeHtml(`Poste ${p.number}${p.name ? ` · ${p.name}` : ''}${!selectable(p) ? ' — indisponible' : ''}`), { direction: 'top', offset: [0, -14] });
      m.on('click', () => togglePost(p));
      layers.posts.addLayer(m);
      markers.set(p.id, m);
    }
    renderTraque();
    if (!ps.fitted) {
      ps.fitted = true;
      map.fitBounds(tLayer.getBounds(), { padding: [20, 20] });
    }
    highlight();
  }

  function renderTraque() {
    layers.traque.clearLayers();
    for (const l of traqueLayers(huntPlan(), { draggable: canEdit, onMove: (kind, c) => patchHuntPlan({ [`${kind}_point`]: { type: 'Point', coordinates: c } }, kind === 'start' ? 'Départ déplacé.' : 'Sortie déplacée.') })) {
      layers.traque.addLayer(l);
    }
  }

  // -------------------------------------------------------------------------
  // Plans de chasse : création, traque (départ, tracé, sortie)
  // -------------------------------------------------------------------------

  const anyDirty = () => [...ps.rows.values()].some(isDirty);

  async function switchHuntPlan(id) {
    if (id === ps.huntPlanId) return;
    if (anyDirty() && !(await confirmDialog('Modifications non enregistrées', 'Changer de plan de chasse abandonne les lignes non enregistrées de la grille.', 'Continuer'))) {
      renderHead();
      return;
    }
    ps.collapsed = false;
    stopPlacing();
    ps.huntPlanId = id;
    ps.rows = new Map();
    ps.selected = null;
    await load();
  }

  async function createHuntPlan() {
    const name = (await promptDialog('Nouveau plan de chasse', 'Nom (ex. Traque du ruisseau, sortie au col)', ps.huntPlans.length ? '' : 'Plan principal'))?.trim();
    if (!name) return;
    if (anyDirty() && !(await confirmDialog('Modifications non enregistrées', 'Les lignes non enregistrées de la grille seront abandonnées.', 'Continuer'))) return;
    try {
      const { hunt_plan } = await api.post(`/territories/${ps.territoryId}/hunt-plans`, { name });
      ps.huntPlanId = hunt_plan.id;
      ps.collapsed = false;
      ps.rows = new Map();
      ps.selected = null;
      await load();
      toast('Plan de chasse créé : tracez la traque, puis remplissez la grille.');
      startPlacing('path');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function patchHuntPlan(body, msg) {
    try {
      await api.patch(`/hunt-plans/${ps.huntPlanId}`, body);
      if (msg) toast(msg);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    await load();
  }

  async function deleteHuntPlan() {
    const hp = huntPlan();
    if (!hp) return;
    if (!(await confirmDialog('Supprimer le plan de chasse', `Supprimer « ${hp.name} », sa traque et sa grille (${hp.coverage.length} effectif(s)) ? Les battues qui l’utilisent passeront sans plan.`, 'Supprimer', true))) return;
    try {
      await api.del(`/hunt-plans/${hp.id}`);
      ps.huntPlanId = null;
      ps.rows = new Map();
      ps.selected = null;
      toast('Plan de chasse supprimé.');
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function startPlacing(what) {
    stopPlacing();
    ps.placing = what;
    mapEl.classList.add('placing'); // les postes ne captent plus les clics
    if (what === 'path') map.pm.enableDraw('Line', { snappable: false, continueDrawing: false, templineStyle: { color: '#e8590c' }, hintlineStyle: { color: '#e8590c', dashArray: '5 5' } });
    else map.pm.enableDraw('Marker', { continueDrawing: false, markerStyle: { icon: traqueIcon(what) } });
    renderTraqueCard();
  }

  function stopPlacing() {
    map.pm.disableDraw();
    mapEl.classList.remove('placing');
    ps.placing = null;
  }

  map.on('pm:create', async (e) => {
    const geom = e.layer.toGeoJSON().geometry;
    map.removeLayer(e.layer);
    const what = ps.placing;
    stopPlacing();
    if (what === 'path') {
      // Départ et sortie par défaut : les extrémités du tracé (déplaçables ensuite).
      const hp = huntPlan();
      const ends = {};
      if (!hp?.start_point) ends.start_point = { type: 'Point', coordinates: geom.coordinates[0] };
      if (!hp?.exit_point) ends.exit_point = { type: 'Point', coordinates: geom.coordinates.at(-1) };
      await patchHuntPlan({ drive_path: geom, ...ends }, 'Traque enregistrée.');
    } else if (what === 'start' || what === 'exit') {
      await patchHuntPlan({ [`${what}_point`]: geom }, what === 'start' ? 'Départ placé.' : 'Sortie placée.');
    } else {
      renderTraqueCard();
    }
  });

  const onKey = (e) => { if (e.key === 'Escape' && ps.placing) { stopPlacing(); renderTraqueCard(); } };
  document.addEventListener('keydown', onKey);

  const PLACING_HINTS = {
    path: 'Cliquez le long du parcours de la traque, du départ vers la sortie ; cliquez à nouveau le dernier point pour terminer.',
    start: 'Cliquez à l’endroit du départ des traqueurs.',
    exit: 'Cliquez à l’endroit de la sortie de la traque.',
  };

  function renderTraqueCard() {
    const hp = huntPlan();
    if (!hp) {
      fill(traqueBox, ps.data ? h('div.card', h('p', 'Aucun plan de chasse pour ce territoire.'),
        h('p.small.muted', 'Une traque (départ, tracé, sortie) et ses postes à pourvoir selon le nombre de chasseurs.'),
        canEdit ? h('button.primary', { onclick: createHuntPlan }, '+ Créer un plan de chasse') : null) : null);
      return;
    }
    const fact = (label, ok, txt) => h('span.small', { class: ok ? '' : 'muted' }, `${ok ? '✔' : '○'} ${label}${txt ? ` : ${txt}` : ''}`);
    fill(traqueBox, h('section.card.traque-card',
      canEdit
        ? h('div.row',
            h('label', 'Nom', h('input', { value: hp.name, maxlength: 200, onchange: (e) => e.target.value.trim() && patchHuntPlan({ name: e.target.value.trim() }, 'Plan de chasse renommé.') })),
            h('label', 'Consignes de la traque', h('input', { value: hp.notes, maxlength: 2000, placeholder: 'ex. chiens lâchés au ruisseau, sens nord → sud', onchange: (e) => patchHuntPlan({ notes: e.target.value }, 'Consignes enregistrées.') })))
        : [h('h2', hp.name), hp.notes ? h('p', hp.notes) : null],
      h('div.traque-facts',
        fact('Départ', !!hp.start_point),
        fact('Tracé', !!hp.drive_path, hp.drive_length_m ? `${hp.drive_length_m.toLocaleString('fr-FR')} m` : ''),
        fact('Sortie', !!hp.exit_point)),
      ps.placing
        ? h('div.hint', h('p', PLACING_HINTS[ps.placing]), h('button', { onclick: () => { stopPlacing(); renderTraqueCard(); } }, 'Annuler (Échap)'))
        : canEdit
          ? h('div.buttons',
              h('button', { onclick: () => startPlacing('path') }, hp.drive_path ? '〰 Retracer la traque' : '〰 Tracer la traque'),
              h('button', { onclick: () => startPlacing('start') }, hp.start_point ? 'D Replacer le départ' : 'D Placer le départ'),
              h('button', { onclick: () => startPlacing('exit') }, hp.exit_point ? 'S Replacer la sortie' : 'S Placer la sortie'),
              hp.drive_path || hp.start_point || hp.exit_point
                ? h('button.link', { onclick: async () => {
                    if (await confirmDialog('Effacer la traque', 'Effacer le départ, le tracé et la sortie de ce plan de chasse ? La grille est conservée.', 'Effacer', true)) {
                      patchHuntPlan({ drive_path: null, start_point: null, exit_point: null }, 'Traque effacée.');
                    }
                  } }, 'Effacer la traque')
                : null,
              h('button.link', { onclick: async () => {
                if (!(await confirmDialog('Retirer de la saison', `Retirer « ${hp.name} » de la saison en cours ? Il n’est pas supprimé.`, 'Retirer'))) return;
                try { await setInSeason('hunt-plans', hp.id, false); ps.huntPlanId = null; ps.rows = new Map(); await load(); } catch (err) { toast(errorMessage(err), 'error'); }
              } }, 'Retirer de la saison'),
              h('button.link.danger', { onclick: deleteHuntPlan }, 'Supprimer ce plan de chasse'))
          : null,
      canEdit && !ps.placing && (hp.start_point || hp.exit_point) ? h('p.small.muted', 'Glissez D ou S sur la carte pour les déplacer.') : null));
  }

  /** Met en évidence les postes de la ligne survolée (sinon sélectionnée). */
  function highlight() {
    const count = ps.hover ?? ps.selected;
    const set = count !== null ? ps.rows.get(count)?.current : null;
    for (const p of posts()) {
      const el = markers.get(p.id)?.getElement();
      if (!el) continue;
      el.classList.toggle('in-plan', Boolean(set?.has(p.id)));
      el.classList.toggle('dim', Boolean(set) && !set.has(p.id));
      el.classList.toggle('invalid-static', !selectable(p));
    }
  }

  // -------------------------------------------------------------------------
  // Grille
  // -------------------------------------------------------------------------

  function togglePost(p, row = ps.selected) {
    if (!canEdit) return;
    if (row === null) {
      toast('Sélectionnez d’abord une ligne (cliquez sur son effectif).', 'warn');
      return;
    }
    const r = ps.rows.get(row);
    if (!r) return;
    if (r.current.has(p.id)) r.current.delete(p.id);
    else if (selectable(p)) r.current.add(p.id);
    else {
      toast(`Poste ${p.number} indisponible : ${p.invalid_reason ? 'trop près d’une habitation' : 'désactivé'}.`, 'error');
      return;
    }
    renderGrid();
    highlight();
  }

  async function save(count) {
    const r = ps.rows.get(count);
    try {
      await api.put(`/hunt-plans/${ps.huntPlanId}/coverage/${count}`, { post_ids: [...r.current] });
      r.saved = new Set(r.current); // n'est plus un brouillon
      toast(`Plan à ${count} chasseurs enregistré.`);
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function remove(count) {
    const r = ps.rows.get(count);
    if (r.saved && !(await confirmDialog('Supprimer le plan', `Supprimer le plan à ${count} chasseurs ?`, 'Supprimer', true))) return;
    try {
      if (r.saved) await api.del(`/hunt-plans/${ps.huntPlanId}/coverage/${count}`);
      ps.rows.delete(count);
      if (ps.selected === count) ps.selected = null;
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function addRow(count) {
    if (!Number.isInteger(count) || count < 1 || count > 999) {
      toast('Effectif invalide.', 'error');
      return;
    }
    if (!ps.rows.has(count)) {
      // Prérempli avec les postes de l'effectif inférieur le plus proche (postes encore disponibles).
      const from = previousCount(counts(), count);
      const current = new Set(from === null ? [] : [...ps.rows.get(from).current].filter((id) => selectable(posts().find((p) => p.id === id) ?? {})));
      ps.rows.set(count, { saved: null, current, plan: null });
      const missing = count - current.size;
      toast(from === null
        ? `Effectif ${count} : cochez ${count} poste(s) dans la grille ou sur la carte.`
        : `Effectif ${count} prérempli avec les postes de l’effectif ${from}${missing > 0 ? ` : cochez encore ${missing} poste(s).` : '.'}`);
    }
    ps.selected = count;
    renderGrid();
    highlight();
  }

  function renderGrid() {
    if (!huntPlan()) return fill(gridBox);
    const cols = posts();
    const available = cols.filter(selectable).length;
    const header = h(
      'tr',
      h('th.sticky', 'Chasseurs'),
      cols.map((p) => h('th', { class: selectable(p) ? '' : 'unavailable', title: p.name || `Poste ${p.number}` }, String(p.number), !selectable(p) ? h('span', { title: p.invalid_reason ? 'Trop près d’une habitation' : 'Désactivé' }, ' ⛔') : null)),
      h('th.sticky-right', 'Postes'),
    );
    const body = counts().map((count) => {
      const r = ps.rows.get(count);
      const status = rowStatus(count, r.current);
      const dirty = isDirty(r);
      const serverIssues = !dirty && r.plan && !r.plan.valid ? r.plan.issues : [];
      const tr = h(
        'tr',
        {
          class: [ps.selected === count ? 'selected' : '', serverIssues.length ? 'plan-invalid' : '', dirty ? 'dirty' : ''].join(' '),
          onmouseenter: () => { ps.hover = count; highlight(); },
          onmouseleave: () => { ps.hover = null; highlight(); },
        },
        h('th.sticky', h('button.link', { onclick: () => { ps.selected = ps.selected === count ? null : count; renderGrid(); highlight(); } }, `${count} chasseurs`)),
        cols.map((p) =>
          h('td', h('input', {
            type: 'checkbox',
            'aria-label': `Poste ${p.number} pour ${count} chasseurs`,
            checked: r.current.has(p.id),
            disabled: !canEdit || (!selectable(p) && !r.current.has(p.id)),
            onchange: () => togglePost(p, count),
          })),
        ),
        // Compteur et actions épinglés à droite : visibles même avec beaucoup de postes.
        h(
          'td.sticky-right',
          h('div.row-actions',
            h('span.count', { class: status.exact ? 'ok' : 'ko' }, status.label),
            canEdit ? h('button.small', { onclick: () => save(count), disabled: !status.exact || !dirty, title: status.exact ? '' : 'Le nombre de postes cochés doit égaler l’effectif' }, 'Enregistrer') : null,
            canEdit ? h('button.link.danger', { onclick: () => remove(count), title: 'Supprimer ce plan' }, '✕') : null,
          ),
        ),
      );
      const notes = [];
      if (serverIssues.length) notes.push(h('p.alert.danger', `Plan invalide : ${serverIssues.join(' ; ')}.`));
      if (dirty) notes.push(h('p.small.muted', status.exact ? 'Modifications non enregistrées.' : `Cochez exactement ${count} postes pour pouvoir enregistrer.`));
      const noteRow = notes.length ? h('tr.notes', h('td', { colSpan: cols.length + 2 }, notes)) : null;
      return [tr, noteRow];
    });

    const free = freeCounts(counts(), available);
    const newCount = h('select', { 'aria-label': 'Effectif à ajouter', onchange: (e) => e.target.value && addRow(Number(e.target.value)) },
      h('option', { value: '' }, free.length ? '+ Ajouter un effectif…' : 'Tous les effectifs sont définis'),
      free.map((n) => h('option', { value: n }, `${n} chasseur${n > 1 ? 's' : ''}${previousCount(counts(), n) !== null ? ` (à partir de ${previousCount(counts(), n)})` : ''}`)));
    newCount.disabled = !free.length;
    fill(
      gridBox,
      h('h3', 'Postes à pourvoir selon l’effectif'),
      h('p.small.muted', `${available}/${cols.length} postes disponibles${canEdit ? ' · touchez un effectif, puis cochez ses postes (grille ou carte)' : ''}.`),
      !cols.length ? h('p.muted', 'Ce territoire n’a pas encore de poste.')
        : counts().length ? h('div.table-scroll', h('table.plans', h('thead', header), h('tbody', body)))
          : h('p.small', 'Aucun effectif défini : choisissez-en un ci-dessous.'),
      canEdit && cols.length ? h('div.add-row', newCount) : null,
    );
  }

  function renderHead() {
    const t = ps.territories.find((x) => x.id === ps.territoryId);
    fill(head,
      h('a.small', { href: '#/territoires' }, '← Territoires'),
      h('h2.editor-title', 'Plans de chasse', t ? h('span.small.muted', ` · ${t.name}`) : null));
    // Un bloc dépliable par plan de chasse ; un seul ouvert à la fois (celui affiché sur la carte).
    const blocks = ps.huntPlans.map((hp) => {
      const active = hp.id === ps.huntPlanId;
      const traque = [hp.start_point ? 'D' : null, hp.drive_path ? '〰' : null, hp.exit_point ? 'S' : null].filter(Boolean).join(' ');
      const d = h('details.fold.hunt-plan', { open: active && !ps.collapsed, class: active ? 'active' : '' },
        h('summary', h('span', hp.name),
          h('span.small.muted', ` · ${hp.coverage.length ? `effectifs ${hp.coverage.map((c) => c.hunter_count).join(', ')}` : 'grille vide'}${traque ? ` · ${traque}` : ' · traque non tracée'}`)),
        active ? [traqueBox, gridBox] : null);
      d.addEventListener('toggle', () => {
        if (d.open && !active) switchHuntPlan(hp.id);
        else if (active) ps.collapsed = !d.open;
      });
      return d;
    });
    fill(listBox,
      blocks,
      ps.data && !ps.huntPlans.length ? traqueBox : null, // « aucun plan » : explication et bouton de création
      canEdit && ps.huntPlans.length ? h('button.link.new-hunt-plan', { onclick: createHuntPlan }, '+ Nouveau plan de chasse') : null,
      ps.offSeason?.length ? fold('Hors saison', { key: 'plans.off', extra: String(ps.offSeason.length) },
        h('ul.plain', ps.offSeason.map((hp) => h('li.off-row', h('span', hp.name),
          canEdit ? h('button.link', { onclick: async () => {
            try { await setInSeason('hunt-plans', hp.id, true); ps.huntPlanId = hp.id; await load(); toast(`${hp.name} rattaché à la saison.`); } catch (err) { toast(errorMessage(err), 'error'); }
          } }, 'Rattacher à la saison') : null)))) : null);
  }

  function renderAll() {
    renderHead();
    renderTraqueCard();
    renderGrid();
  }

  try {
    await load();
  } catch (err) {
    fill(gridBox, h('p.error', errorMessage(err)));
  }
  setTimeout(() => map.invalidateSize(), 0);
  setTimeout(() => map.invalidateSize(), 400); // après la mise en page du panneau

  return () => { document.removeEventListener('keydown', onKey); map.remove(); };
}
