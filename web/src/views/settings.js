import { api } from '../api.js';
import { h, fill, errorMessage, toast, fold, confirmDialog, modal } from '../ui.js';
import { CATEGORY_LABELS } from '../lib/hunts.js';
import { forgetSeason } from '../lib/season.js';

export async function settingsView(main, { refreshMe }) {
  const { tenant } = await api.get('/tenant');
  const field = (name, label, attrs, help) =>
    h('label', label, h('input', { name, value: tenant[name] ?? '', ...attrs }), help ? h('small', help) : null);

  const form = h(
    'form.card',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = {
          name: fd.get('name'),
          kind: fd.get('kind'),
          departement: fd.get('departement') || null,
          buffer_distance_m: Number(fd.get('buffer_distance_m')),
          post_max_outside_m: Number(fd.get('post_max_outside_m')),
          gps_tolerance_m: Number(fd.get('gps_tolerance_m')),
          position_retention_h: Number(fd.get('position_retention_h')),
          show_all_posts: fd.get('show_all_posts') === 'on',
          hunters_per_car: Number(fd.get('hunters_per_car')),
          info_url: String(fd.get('info_url') ?? '').trim(),
        };
        try {
          await api.patch('/tenant', body);
          await refreshMe();
          toast('Paramètres enregistrés.');
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      },
    },
    fold('Association', { key: 'settings.assoc', open: true, extra: tenant.name },
    field('name', 'Nom', { required: true, maxlength: 200 }),
    h(
      'label',
      'Type',
      h(
        'select',
        { name: 'kind' },
        [['acca', 'ACCA'], ['societe', 'Société de chasse'], ['autre', 'Autre']].map(([v, l]) => h('option', { value: v, selected: v === tenant.kind }, l)),
      ),
    ),
    field('departement', 'Département', { maxlength: 3, pattern: '([0-9]{2}|2A|2B|97[1-6])', placeholder: 'ex. 11' }),
    field('info_url', 'Page d’informations (dates, espèces, règles)', { type: 'url', maxlength: 500, pattern: 'https://.*', placeholder: 'https://…' },
      'Affichée dans « Ma chasse → Infos ». Adresse https.')),
    fold('Sécurité', { key: 'settings.safety', extra: `${tenant.buffer_distance_m} m des habitations` },
      field('buffer_distance_m', 'Distance des habitations (m)', { type: 'number', min: 50, max: 1000, required: true },
        '150 m en ACCA (L.422-10), parfois 200 m. Recalcule les zones non chassables.'),
      field('post_max_outside_m', 'Poste hors du territoire, au plus (m)', { type: 'number', min: 0, max: 500, required: true },
        '0 : postes dans le territoire seulement.')),
    fold('Postes et GPS', { key: 'settings.gps', extra: `${tenant.gps_tolerance_m} m · ${tenant.position_retention_h} h` },
      field('gps_tolerance_m', 'Tolérance « sur le poste » (m)', { type: 'number', min: 5, max: 200, required: true }),
      field('position_retention_h', 'Conservation des positions (heures)', { type: 'number', min: 1, max: 720, required: true }),
      h('label.check', h('input', { type: 'checkbox', name: 'show_all_posts', checked: tenant.show_all_posts }), 'Les chasseurs voient tous les postes (sinon leurs voisins)')),
    fold('Covoiturage', { key: 'settings.car', extra: `${tenant.hunters_per_car} par voiture` },
      field('hunters_per_car', 'Chasseurs par voiture, au plus', { type: 'number', min: 2, max: 9, required: true }, 'Conducteur compris.')),
    h('button.primary', { type: 'submit' }, 'Enregistrer'),
  );
  const seasonBox = h('section.card');
  const speciesBox = h('section.card');
  const recapBox = h('section.card');
  main.append(h('h1', 'Paramètres'), seasonBox, form, speciesBox, recapBox);
  await loadSeasons();

  // -------------------------------------------------------------------------
  // Saison en cours, nouvelle saison, espèces et quotas, récapitulatif
  // -------------------------------------------------------------------------
  async function loadSeasons() {
    try {
      const { seasons, current, species } = await api.get('/seasons');
      renderSeason(seasons, current);
      renderSpecies(current, species);
      if (current) renderRecap(current, await api.get(`/seasons/${current.id}/recap`));
    } catch (err) {
      fill(seasonBox, h('p.error', errorMessage(err)));
    }
  }

  function renderSeason(seasons, current) {
    const select = h('select', { 'aria-label': 'Saison en cours', onchange: async (e) => {
      const s = seasons.find((x) => x.id === e.target.value);
      if (!(await confirmDialog('Saison en cours', `Passer à la saison ${s.name} ? Les listes (territoires, plans, lieux, membres, journées) suivront cette saison.`, 'Changer'))) {
        e.target.value = current?.id ?? '';
        return;
      }
      try { await api.put('/seasons/current', { season_id: e.target.value }); forgetSeason(); toast(`Saison ${s.name} en cours.`); } catch (err) { toast(errorMessage(err), 'error'); }
      loadSeasons();
    } }, seasons.map((x) => h('option', { value: x.id, selected: x.current }, `${x.name}${x.days_count ? ` · ${x.days_count} journée(s)` : ''}`)));
    fill(seasonBox, fold('Saison', { key: 'settings.season', open: true, extra: current?.name ?? 'aucune' },
      h('label', 'Saison en cours', select),
      h('button.link', { onclick: () => newSeason(current) }, '+ Nouvelle saison'),
      h('p.small.muted', 'Une nouvelle saison reprend les espèces, territoires, plans de chasse, lieux et membres de la saison en cours.')));
  }

  async function newSeason(current) {
    // Saison suivante proposée : « 2027-2028 », du 1er juillet au 30 juin.
    const y = current ? Number(current.ends_on.slice(0, 4)) : new Date().getFullYear();
    const name = h('input', { value: `${y}-${y + 1}`, maxlength: 50, required: true });
    const start = h('input', { type: 'date', value: `${y}-07-01` });
    const end = h('input', { type: 'date', value: `${y + 1}-06-30` });
    const makeCurrent = h('input', { type: 'checkbox', checked: true });
    const v = await modal('Nouvelle saison', h('div',
      h('label', 'Nom', name),
      h('div.row', h('label', 'Début', start), h('label', 'Fin', end)),
      h('label.check', makeCurrent, 'En faire la saison en cours'),
      current ? h('p.small.muted', `Reprend tout de la saison ${current.name}.`) : null),
    [{ label: 'Annuler', value: null }, { label: 'Créer', value: 'ok', primary: true }]);
    if (v !== 'ok') return;
    try {
      await api.post('/seasons', { name: name.value.trim(), starts_on: start.value, ends_on: end.value, copy_from: current?.id ?? null, make_current: makeCurrent.checked });
      forgetSeason();
      toast(`Saison ${name.value.trim()} créée.`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    loadSeasons();
  }

  /** Espèces de la saison : nom, quota sur la saison, nombre par défaut par battue. */
  function renderSpecies(current, species) {
    if (!current) return fill(speciesBox);
    const rows = species.map((x) => ({ ...x }));
    const num = (r, key, label) => h('input', { type: 'number', min: 0, max: key === 'season_quota' ? 9999 : 999, value: r[key] ?? '', placeholder: '∞', 'aria-label': label,
      oninput: (e) => { r[key] = e.target.value === '' ? null : Number(e.target.value); } });
    const draw = () => fill(list, h('table.list.compact.species-table',
      h('thead', h('tr', h('th', 'Espèce'), h('th', { title: 'Nombre total sur la saison' }, 'Saison'), h('th', { title: 'Nombre par défaut à chaque battue' }, 'Battue'), h('th', ''))),
      h('tbody', rows.map((r, i) => h('tr',
        h('td', h('input', { value: r.species, maxlength: 60, 'aria-label': 'Espèce', oninput: (e) => { r.species = e.target.value; } })),
        h('td', num(r, 'season_quota', `Quota de saison : ${r.species}`)),
        h('td', num(r, 'battue_quota', `Par battue : ${r.species}`)),
        h('td', h('button.icon.danger', { title: 'Retirer', 'aria-label': 'Retirer', onclick: () => { rows.splice(i, 1); draw(); } }, '🗑')))))));
    const list = h('div');
    draw();
    fill(speciesBox, fold('Espèces et quotas', { key: 'settings.species', extra: species.map((x) => x.species).join(', ') },
      list,
      h('div.buttons',
        h('button.link', { onclick: () => { rows.push({ species: '', season_quota: null, battue_quota: null }); draw(); list.querySelector('tr:last-child input')?.focus(); } }, '+ Ajouter une espèce'),
        h('button.primary', { onclick: async () => {
          try {
            await api.put(`/seasons/${current.id}/species`, { species: rows.filter((r) => r.species.trim()).map((r) => ({ species: r.species.trim(), season_quota: r.season_quota, battue_quota: r.battue_quota })) });
            toast('Espèces enregistrées.');
            loadSeasons();
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        } }, 'Enregistrer')),
      h('p.small.muted', 'Vide : sans limite. Le nombre par battue est repris à la première battue de chaque journée.')));
  }

  /** Récapitulatif des prélèvements de la saison. */
  function renderRecap(current, recap) {
    const total = recap.species.reduce((n, x) => n + x.total, 0);
    fill(recapBox, fold('Prélèvements de la saison', { key: 'settings.recap', extra: `${total} animaux · ${recap.days} journée(s) · ${recap.battues} battue(s)` },
      recap.species.length
        ? h('ul.plain.recap', recap.species.map((x) => {
            const pct = x.season_quota ? Math.min(100, Math.round((100 * x.total) / x.season_quota)) : null;
            const cats = Object.entries(x.by_category).map(([k, n]) => `${n} ${CATEGORY_LABELS[k] ?? k}`).join(', ');
            return h('li',
              h('div.recap-head', h('strong', x.species), h('span', x.season_quota != null ? `${x.total} / ${x.season_quota}` : String(x.total))),
              pct != null ? h('div.bar', { class: x.total >= x.season_quota ? 'full' : '' }, h('span', { style: `width:${pct}%` })) : null,
              cats || x.wounded ? h('span.small.muted', [cats, x.wounded ? `⚠️ ${x.wounded} blessé(s)` : ''].filter(Boolean).join(' · ')) : null);
          }))
        : h('p.muted', 'Aucun prélèvement.')));
  }
}
