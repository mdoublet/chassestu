// Territoires : vue d'ensemble, liste, ajout, renommage, notes, suppression.
// Le dessin (contour, postes, parkings, réserves, chemins) se fait sur la
// carte du territoire (« Ouvrir la carte »).
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { toLatLng, escapeHtml, postIcon, ensureHatchPattern } from '../map/shapes.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, confirmDialog, fold } from '../ui.js';

export async function territoriesView(main) {
  const canEdit = state.role === 'president';
  ensureHatchPattern();
  const list = h('div.territory-list');
  const mapEl = h('div.territories-map');
  const shown = h('div.territory-toggles');
  main.append(
    h('div.page-head', h('h1', 'Territoires'),
      canEdit ? h('a.button.primary', { href: '#/carte/nouveau' }, '+ Nouveau territoire') : null),
    mapEl, shown, list);
  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  addBasemaps(map);
  const layer = L.featureGroup().addTo(map);
  let territories = [];
  let overview = null;
  let highlighted = null;
  // Territoires masqués sur la vue globale (préférence de l'appareil).
  const HIDDEN_KEY = 'chassestu.hiddenTerritories';
  let hidden = new Set();
  try { hidden = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')); } catch { /* rien */ }
  const saveHidden = () => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* rien */ } };

  async function load() {
    const [list, ov] = await Promise.all([api.get('/territories'), api.get('/territories/overview')]);
    territories = list.territories;
    overview = ov;
    render();
  }

  async function patch(t, body, msg) {
    try {
      await api.patch(`/territories/${t.id}`, body);
      toast(msg);
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function drawMap() {
    layer.clearLayers();
    const visible = (id) => !hidden.has(id);
    for (const z of (overview?.exclusions ?? []).filter((x) => visible(x.territory_id))) {
      layer.addLayer(L.geoJSON(z.geom, { style: { color: '#d9480f', weight: 0.5, fillOpacity: 0.45, className: 'exclusion-shape' }, interactive: false }));
    }
    for (const r of (overview?.reserves ?? []).filter((x) => visible(x.territory_id))) {
      layer.addLayer(L.geoJSON(r.geom, { style: { color: '#c92a2a', weight: 1, fillOpacity: 0.6, className: 'reserve-shape' }, interactive: false }));
    }
    for (const p of (overview?.posts ?? []).filter((x) => visible(x.territory_id))) {
      const t = territories.find((x) => x.id === p.territory_id);
      layer.addLayer(L.marker(toLatLng(p.geom.coordinates), { icon: postIcon(p.number, p.invalid_reason ? 'invalid-static' : '') })
        .bindTooltip(escapeHtml(`${t?.name ?? ''} · poste ${p.number}${p.name ? ` · ${p.name}` : ''}`), { direction: 'top', offset: [0, -12] }));
    }
    for (const t of territories.filter((x) => visible(x.id))) {
      const poly = L.polygon(t.geom.coordinates.map((r) => r.map(toLatLng)), {
        color: t.id === highlighted ? '#e8590c' : '#1f5130', weight: t.id === highlighted ? 4 : 2, fillOpacity: 0.08,
      }).bindTooltip(escapeHtml(t.name), { permanent: true, direction: 'center', className: 'territory-label' });
      poly.on('click', () => {
        highlighted = t.id;
        render();
        document.getElementById(`t-${t.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      layer.addLayer(poly);
    }
  }

  function card(t) {
    const warnings = [
      t.invalid_posts ? `${t.invalid_posts} poste(s) invalide(s) (trop près d’une habitation)` : null,
      t.posts_without_parking ? `${t.posts_without_parking} poste(s) sans parking` : null,
      !t.posts_count ? 'aucun poste' : null,
    ].filter(Boolean);
    const name = h('input.territory-name', { value: t.name, maxlength: 200, 'aria-label': 'Nom du territoire', disabled: !canEdit,
      onchange: (e) => e.target.value.trim() && patch(t, { name: e.target.value.trim() }, 'Territoire renommé.') });
    return h('section.card.territory-card', { id: `t-${t.id}`, class: t.id === highlighted ? 'highlighted' : '' },
      h('div.territory-card-head', name, h('span.small.muted.area', `${Math.round(t.area_ha).toLocaleString('fr-FR')} ha`)),
      h('p.small.counts', `${t.posts_count} poste${t.posts_count > 1 ? 's' : ''} · ${t.parkings_count} P · ${t.reserves_count} réserve${t.reserves_count > 1 ? 's' : ''}`,
        warnings.length ? h('span.warn-text', { title: warnings.join(' · ') }, ` · ⚠ ${warnings.length > 1 ? `${warnings.length} alertes` : warnings[0]}`) : null),
      h('div.buttons.territory-actions',
        h('a.button', { href: `#/carte/${t.id}` }, '🗺 Carte'),
        state.role === 'president' || state.role === 'responsable' ? h('a.button', { href: `#/plans/${t.id}` }, `📋 Plans de chasse (${t.plans_count})`) : null,
        canEdit ? h('button.icon.danger', { title: 'Supprimer le territoire', 'aria-label': 'Supprimer le territoire', onclick: async () => {
          if (!(await confirmDialog('Supprimer le territoire', `Supprimer « ${t.name} » avec ses réserves, parkings, postes, chemins et plans ? Cette suppression ne peut pas être annulée.`, 'Supprimer', true))) return;
          try {
            await api.del(`/territories/${t.id}`);
            toast('Territoire supprimé.');
            await load();
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        } }, '🗑') : null),
      canEdit || t.notes ? fold('Notes', { key: `t.notes.${t.id}`, extra: t.notes ? t.notes.slice(0, 40) + (t.notes.length > 40 ? '…' : '') : '' },
        h('textarea', { rows: 3, maxlength: 5000, disabled: !canEdit, placeholder: canEdit ? 'Accès, propriétaires, consignes…' : '',
          onchange: (e) => patch(t, { notes: e.target.value }, 'Notes enregistrées.') }, t.notes ?? '')) : null);
  }

  function renderToggles() {
    fill(shown, territories.length > 1
      ? fold('Territoires affichés sur la carte', { key: 'territories.shown', extra: `${territories.length - territories.filter((t) => hidden.has(t.id)).length}/${territories.length}` },
         territories.map((t) => h('label.check', h('input', { type: 'checkbox', checked: !hidden.has(t.id), onchange: (e) => {
           if (e.target.checked) hidden.delete(t.id); else hidden.add(t.id);
           saveHidden();
           drawMap();
           fitVisible();
         } }), t.name)),
         h('button.link', { onclick: () => { hidden.clear(); saveHidden(); render(); fitVisible(); } }, 'Tous'))
      : null);
  }

  function fitVisible() {
    const polys = territories.filter((t) => !hidden.has(t.id)).map((t) => L.polygon(t.geom.coordinates.map((r) => r.map(toLatLng))));
    if (polys.length) map.fitBounds(L.featureGroup(polys).getBounds().pad(0.1));
  }

  let fitted = false;
  function render() {
    renderToggles();
    fill(list, territories.length ? territories.map(card)
      : h('div.card', h('p', 'Aucun territoire pour l’instant.'), canEdit ? h('a.button.primary', { href: '#/carte/nouveau' }, 'Créer le premier territoire') : null));
    drawMap();
    if (!fitted && territories.length) {
      fitted = true;
      fitVisible();
    }
  }

  try {
    await load();
  } catch (err) {
    fill(list, h('p.error', errorMessage(err)));
  }
  setTimeout(() => map.invalidateSize(), 0);
  return () => map.remove();
}
