// Lot 3 — Plans de couverture : une ligne par effectif, une colonne par
// poste, des cases à cocher. La carte met en évidence les postes de la ligne
// survolée ou sélectionnée ; un clic sur un poste de la carte le coche dans
// la ligne sélectionnée. Chaque ligne s'enregistre séparément, et seulement
// si le nombre de postes cochés égale l'effectif.
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon } from '../map/shapes.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, confirmDialog } from '../ui.js';
import { previousCount, rowStatus, sameSet, selectable } from '../lib/plans.js';

const TERRITORY_KEY = 'chassestu.plansTerritory';

function storedTerritory() {
  try {
    return localStorage.getItem(TERRITORY_KEY);
  } catch {
    return null;
  }
}

export async function plansView(main) {
  const canEdit = state.role === 'president';
  const ps = {
    territories: [],
    territoryId: storedTerritory(),
    data: null, // détail du territoire (postes, zones…)
    plans: [], // plans enregistrés (serveur)
    rows: new Map(), // effectif → { saved: Set|null, current: Set, plan }
    selected: null, // effectif de la ligne sélectionnée
    hover: null,
    fitted: false,
  };

  ensureHatchPattern();
  const gridBox = h('div.plans-grid');
  const mapEl = h('div.plans-map');
  const head = h('div.plans-head');
  main.append(h('div.plans-page', head, h('div.plans-layout', mapEl, gridBox)));

  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  addBasemaps(map);
  const layers = { base: L.featureGroup().addTo(map), posts: L.featureGroup().addTo(map) };
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
    const [detail, plans] = await Promise.all([
      api.get(`/territories/${ps.territoryId}`),
      api.get(`/territories/${ps.territoryId}/coverage-plans`),
    ]);
    ps.data = detail;
    ps.plans = plans.plans;
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
    for (const p of posts()) {
      const m = L.marker(toLatLng(p.geom.coordinates), { icon: postIcon(p.number), title: `Poste ${p.number}` });
      m.bindTooltip(escapeHtml(`Poste ${p.number}${p.name ? ` · ${p.name}` : ''}${!selectable(p) ? ' — indisponible' : ''}`), { direction: 'top', offset: [0, -14] });
      m.on('click', () => togglePost(p));
      layers.posts.addLayer(m);
      markers.set(p.id, m);
    }
    if (!ps.fitted) {
      ps.fitted = true;
      map.fitBounds(tLayer.getBounds(), { padding: [20, 20] });
    }
    highlight();
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
      await api.put(`/territories/${ps.territoryId}/coverage-plans/${count}`, { post_ids: [...r.current] });
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
      if (r.saved) await api.del(`/territories/${ps.territoryId}/coverage-plans/${count}`);
      ps.rows.delete(count);
      if (ps.selected === count) ps.selected = null;
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function duplicate(count) {
    const from = previousCount(counts(), count);
    if (from === null) return;
    const r = ps.rows.get(count);
    r.current = new Set([...ps.rows.get(from).current].filter((id) => selectable(posts().find((p) => p.id === id) ?? {})));
    ps.selected = count;
    renderGrid();
    highlight();
  }

  function addRow(count) {
    if (!Number.isInteger(count) || count < 1 || count > 999) {
      toast('Effectif invalide.', 'error');
      return;
    }
    if (ps.rows.has(count)) {
      ps.selected = count;
    } else {
      ps.rows.set(count, { saved: null, current: new Set(), plan: null });
      ps.selected = count;
    }
    renderGrid();
    highlight();
  }

  function renderGrid() {
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
            canEdit && previousCount(counts(), count) !== null
              ? h('button.link', { onclick: () => duplicate(count), title: `Copier la ligne ${previousCount(counts(), count)} chasseurs` }, 'Dupliquer N-1')
              : null,
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

    const newCount = h('input', { type: 'number', min: 1, max: 999, placeholder: 'Effectif', 'aria-label': 'Effectif à ajouter' });
    fill(
      gridBox,
      h('p.small.muted', `${available} poste(s) disponible(s) sur ${cols.length}. ${canEdit ? 'Cliquez sur un effectif pour le sélectionner, puis cochez les postes dans la grille ou sur la carte.' : 'Survolez une ligne pour voir ses postes sur la carte.'}`),
      cols.length
        ? h('div.table-scroll', h('table.plans', h('thead', header), h('tbody', body)))
        : h('p.muted', 'Ce territoire n’a pas encore de poste.'),
      canEdit && cols.length
        ? h(
            'form.row.add-row',
            { onsubmit: (e) => { e.preventDefault(); addRow(Number(newCount.value)); newCount.value = ''; } },
            newCount,
            h('button', { type: 'submit' }, 'Ajouter un effectif'),
          )
        : null,
    );
  }

  function renderHead() {
    fill(
      head,
      h('h1', 'Plans de couverture'),
      ps.territories.length
        ? h(
            'select',
            {
              'aria-label': 'Territoire',
              onchange: async (e) => {
                if ([...ps.rows.values()].some(isDirty) && !(await confirmDialog('Modifications non enregistrées', 'Changer de territoire abandonne les lignes non enregistrées.', 'Continuer'))) {
                  e.target.value = ps.territoryId;
                  return;
                }
                ps.territoryId = e.target.value;
                try { localStorage.setItem(TERRITORY_KEY, ps.territoryId); } catch { /* préférence non mémorisée */ }
                ps.rows = new Map();
                ps.selected = null;
                ps.fitted = false;
                await load();
              },
            },
            ps.territories.map((t) => h('option', { value: t.id, selected: t.id === ps.territoryId }, t.name)),
          )
        : null,
    );
  }

  function renderAll() {
    renderHead();
    renderGrid();
  }

  try {
    await load();
  } catch (err) {
    fill(gridBox, h('p.error', errorMessage(err)));
  }
  setTimeout(() => map.invalidateSize(), 0);

  return () => map.remove();
}
