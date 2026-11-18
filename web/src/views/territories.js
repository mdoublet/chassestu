// Territoires : vue d'ensemble, liste, ajout, renommage, notes, suppression.
// Le dessin (contour, postes, parkings, réserves, chemins) se fait sur la
// carte du territoire (« Ouvrir la carte »).
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { toLatLng, escapeHtml } from '../map/shapes.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, confirmDialog } from '../ui.js';

export async function territoriesView(main) {
  const canEdit = state.role === 'president';
  const list = h('div.territory-list');
  const mapEl = h('div.territories-map');
  main.append(
    h('div.page-head', h('h1', 'Territoires'),
      canEdit ? h('a.button.primary', { href: '#/carte/nouveau' }, '+ Nouveau territoire') : null),
    mapEl, list);
  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  addBasemaps(map);
  const layer = L.featureGroup().addTo(map);
  let territories = [];
  let highlighted = null;

  async function load() {
    territories = (await api.get('/territories')).territories;
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
    for (const t of territories) {
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
      h('div.territory-card-head', name, h('span.small.muted', `${t.area_ha.toLocaleString('fr-FR')} ha`)),
      h('p.small.counts',
        `${t.posts_count} poste(s) · ${t.parkings_count} parking(s) · ${t.reserves_count} réserve(s) · ${t.plans_count} plan(s) de couverture`),
      warnings.length ? h('p.small.alert.warn', `⚠ ${warnings.join(' · ')}`) : null,
      h('label.small', 'Notes', h('textarea', { rows: 2, maxlength: 5000, disabled: !canEdit, placeholder: canEdit ? 'Accès, propriétaires, consignes particulières…' : '',
        onchange: (e) => patch(t, { notes: e.target.value }, 'Notes enregistrées.') }, t.notes ?? '')),
      h('div.buttons',
        h('a.button', { href: `#/carte/${t.id}` }, canEdit ? '🗺 Ouvrir la carte (postes, parkings, réserves…)' : '🗺 Voir la carte'),
        h('a.button', { href: '#/plans' }, '📋 Plans'),
        canEdit ? h('button.link.danger', { onclick: async () => {
          if (!(await confirmDialog('Supprimer le territoire', `Supprimer « ${t.name} » avec ses réserves, parkings, postes, chemins et plans ? Cette suppression ne peut pas être annulée.`, 'Supprimer', true))) return;
          try {
            await api.del(`/territories/${t.id}`);
            toast('Territoire supprimé.');
            await load();
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        } }, 'Supprimer') : null));
  }

  let fitted = false;
  function render() {
    fill(list, territories.length ? territories.map(card)
      : h('div.card', h('p', 'Aucun territoire pour l’instant.'), canEdit ? h('a.button.primary', { href: '#/carte/nouveau' }, 'Créer le premier territoire') : null));
    drawMap();
    if (!fitted && layer.getLayers().length) {
      fitted = true;
      map.fitBounds(layer.getBounds().pad(0.1));
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
