// Paramètres → « Infos de la saison » : ce que les membres voient dans
// Ma chasse → Infos. Modèle à charger, import / export JSON, et formulaires :
// généralités, espèces et périodes, calendrier des battues, avis datés, règles.
import { api } from '../api.js';
import { h, fill, toast, errorMessage, confirmDialog, fold } from '../ui.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'espece';

/** Document vide de départ (jours et horaires usuels). */
function emptyRegulations(season) {
  return {
    version: 1, title: `Saison ${season.name}`, season_label: season.name,
    reference: { name: 'Paris', lat: 48.8566, lon: 2.3522 },
    campaign: { from: season.starts_on, to: season.ends_on },
    categories: [{ id: 'petit', label: 'Petit gibier sédentaire' }, { id: 'passage', label: 'Oiseaux de passage' }, { id: 'eau', label: 'Gibier d’eau' }, { id: 'autre', label: 'Renard, corvidés et autres' }, { id: 'grand', label: 'Grand gibier' }],
    days: { ALL: { label: 'Tous les jours', dow: [0, 1, 2, 3, 4, 5, 6] }, DMF: { label: 'Dimanche, mercredi et jours fériés', dow: [0, 3], holidays: true }, DM: { label: 'Dimanche et mercredi', dow: [0, 3] }, D: { label: 'Dimanche uniquement', dow: [0] } },
    hours: { DAY: { seg: [['r-60', 's+60']], label: '1 h avant le lever à 1 h après le coucher du soleil' }, STD: { seg: [['08:00', '12:00'], ['14:00', '18:00']], label: '8h00–12h00 et 14h00–18h00' } },
    species: [], battues: [], notices: [], checklist: [], rules: [],
  };
}

export async function infosEditor(box, season) {
  let saved = null;
  let reg = null;
  const dirty = () => JSON.stringify(reg) !== JSON.stringify(saved);

  async function load() {
    try {
      saved = (await api.get('/seasons/current/regulations')).regulations;
      reg = saved ? clone(saved) : null;
      render();
    } catch (err) {
      fill(box, h('p.error', errorMessage(err)));
    }
  }

  async function save(next = reg, msg = 'Infos enregistrées.') {
    try {
      const { regulations } = await api.put(`/seasons/${season.id}/regulations`, { regulations: next });
      saved = regulations;
      reg = regulations ? clone(regulations) : null;
      toast(msg);
      render();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function fileButtons() {
    const input = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async () => {
      const f = input.files?.[0];
      if (!f) return;
      try { await save(JSON.parse(await f.text()), 'Infos importées.'); } catch (err) { toast(err instanceof SyntaxError ? 'Fichier JSON illisible.' : errorMessage(err), 'error'); }
      input.value = '';
    } });
    return h('div.buttons',
      h('button', { type: 'button', onclick: async () => {
        if (saved && !(await confirmDialog('Charger le modèle', 'Remplacer les infos actuelles par le modèle de l’ACCA de Fontcouverte 2026-2027 ?', 'Remplacer'))) return;
        const model = (await import('../data/fontcouverte-2026-2027.json')).default;
        save(clone(model), 'Modèle de Fontcouverte chargé.');
      } }, 'Charger le modèle Fontcouverte 2026-2027'),
      !saved ? h('button', { type: 'button', onclick: () => { reg = emptyRegulations(season); render(); } }, 'Partir d’une page vide') : null,
      saved ? h('button', { type: 'button', onclick: () => {
        const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(saved, null, 1)], { type: 'application/json' })), download: `infos-${season.name}.json` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, 'Exporter (JSON)') : null,
      h('button', { type: 'button', onclick: () => input.click() }, 'Importer (JSON)'), input,
      saved ? h('button.link.danger', { type: 'button', onclick: async () => {
        if (await confirmDialog('Effacer', 'Effacer les infos de la saison ? L’onglet Infos affichera la page d’informations, ou les espèces et quotas.', 'Effacer', true)) save(null, 'Infos effacées.');
      } }, 'Effacer') : null);
  }

  // Petits champs liés au document en cours de modification.
  const text = (obj, key, attrs = {}) => h('input', { value: obj[key] ?? '', ...attrs, oninput: (e) => { obj[key] = e.target.value || undefined; markDirty(); } });
  const area = (obj, key, rows = 3, attrs = {}) => h('textarea', { rows, ...attrs, oninput: (e) => { obj[key] = e.target.value || undefined; markDirty(); } }, obj[key] ?? '');
  const date = (obj, key) => h('input', { type: 'date', value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; markDirty(); } });
  const select = (obj, key, options, attrs = {}) => h('select', { ...attrs, onchange: (e) => { obj[key] = e.target.value || undefined; markDirty(); } },
    options.map(([v, l]) => h('option', { value: v, selected: (obj[key] ?? '') === v }, l)));
  const check = (obj, key, label) => h('label.check', h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked || undefined; markDirty(); } }), label);
  const del = (arr, i) => h('button.icon.danger', { type: 'button', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: () => { arr.splice(i, 1); render(); } }, '🗑');
  const saveBar = h('div.infos-save');
  function markDirty() {
    fill(saveBar, dirty()
      ? [h('span.small', 'Modifications non enregistrées.'), h('button.primary', { type: 'button', onclick: () => save() }, 'Enregistrer'),
         h('button.link', { type: 'button', onclick: () => { reg = saved ? clone(saved) : null; render(); } }, 'Annuler')]
      : null);
  }

  function generalSection() {
    reg.campaign ??= {};
    reg.reference ??= { name: '', lat: 0, lon: 0 };
    reg.chart ??= { from: reg.campaign.from, to: reg.campaign.to };
    const num = (obj, key) => h('input', { type: 'number', step: '0.0001', value: obj[key], oninput: (e) => { obj[key] = Number(e.target.value); markDirty(); } });
    return fold('Généralités', { key: 'infos.ed.general' },
      h('label', 'Titre (en haut de l’onglet)', text(reg, 'title', { maxlength: 200 })),
      h('label', 'Saison (libellé)', text(reg, 'season_label', { maxlength: 40 })),
      h('div.row', h('label', 'Début de campagne', date(reg.campaign, 'from')), h('label', 'Fin de campagne', date(reg.campaign, 'to'))),
      h('label', 'Texte avant la campagne', text(reg.campaign, 'before_text', { maxlength: 300 })),
      h('label', 'Texte après la campagne', text(reg.campaign, 'after_text', { maxlength: 300 })),
      h('div.row', h('label', 'Frise : du', date(reg.chart, 'from')), h('label', 'au', date(reg.chart, 'to'))),
      h('p.small.muted', 'Lever et coucher du soleil calculés pour :'),
      h('div.row', h('label', 'Ville de référence', text(reg.reference, 'name', { maxlength: 100 })), h('label', 'Latitude', num(reg.reference, 'lat')), h('label', 'Longitude', num(reg.reference, 'lon'))),
      h('label', 'Rappel sous l’en-tête', area(reg, 'day_hint', 2, { maxlength: 500 })),
      h('label', 'Consignes de battue (avis du jour de battue)', area(reg, 'battue_notice', 2, { maxlength: 1000 })),
      h('label', 'Bas de page « Ce jour »', area(reg, 'day_footer', 3, { maxlength: 2000 })),
      h('label', 'Bas de page « Saison »', area(reg, 'season_footer', 3, { maxlength: 2000 })));
  }

  const dayOpts = () => Object.entries(reg.days).map(([k, v]) => [k, v.label]);
  const hourOpts = () => Object.entries(reg.hours).map(([k, v]) => [k, v.label]);
  const catOpts = () => reg.categories.map((c) => [c.id, c.label]);

  function speciesForm(e) {
    const notes = h('textarea', { rows: 3, oninput: (ev) => { e.notes = ev.target.value.split('\n').map((x) => x.trim()).filter(Boolean); markDirty(); } }, (e.notes ?? []).join('\n'));
    return h('div.infos-species-form',
      h('div.row', h('label', 'Nom', text(e, 'name', { maxlength: 120, required: true })), h('label', 'Catégorie', select(e, 'cat', catOpts()))),
      h('label', 'Précision (sous le nom)', text(e, 'sub', { maxlength: 200 })),
      h('div.row', h('label', 'Situation', select(e, 'kind', [['', 'Dates ci-dessous'], ['check', 'À vérifier (sans dates)'], ['suspended', 'Chasse suspendue']])), h('label', 'Source', text(e, 'src', { maxlength: 100 }))),
      h('label', 'Texte (espèce à vérifier ou suspendue)', area(e, 'checkText', 2, { maxlength: 1000 })),
      h('label', 'Limite (courte)', text(e, 'limit', { maxlength: 200, placeholder: 'ex. 2 par jour, 20 par an' })),
      h('label', 'Limites (PMA), détail', area(e, 'limitFull', 2, { maxlength: 1500 })),
      h('div.row', h('label', 'Plan de chasse', text(e, 'plan', { maxlength: 500 })), h('label', 'Battues (calendrier)', select(e, 'battue', [['', '—'], ...battueGames().map((g) => [g, g])]))),
      check(e, 'noPlan', 'Pas au plan de chasse de l’association'),
      h('label', 'À noter (une ligne par remarque)', notes),
      h('h4', 'Périodes'),
      h('div.infos-periods', (e.periods ?? []).map((p, i) => h('div.infos-period',
        h('div.row', h('label', 'Du', date(p, 'from')), h('label', 'Au', date(p, 'to')), del(e.periods, i)),
        h('div.row', h('label', 'Jours', select(p, 'days', dayOpts())), h('label', 'Horaires', select(p, 'hours', hourOpts()))),
        h('div.row', h('label', 'Lieu (facultatif)', text(p, 'where', { maxlength: 100, placeholder: 'ex. Zones humides' })), h('label', 'Condition', text(p, 'cond', { maxlength: 1000 }))),
        check(p, 'restricted', 'Sur autorisation / sous conditions (grand gibier…)')))),
      h('button', { type: 'button', onclick: () => {
        const last = e.periods?.at(-1);
        (e.periods ??= []).push({ from: last?.to ?? reg.campaign.from, to: reg.campaign.to, days: last?.days ?? Object.keys(reg.days)[0], hours: last?.hours ?? Object.keys(reg.hours)[0] });
        render();
      } }, '+ Période'));
  }

  const battueGames = () => [...new Set([...reg.battues.map((b) => b.game), ...reg.species.map((e) => e.battue).filter(Boolean)])];

  function speciesSection() {
    return fold('Espèces et périodes', { key: 'infos.ed.species', extra: String(reg.species.length) },
      reg.categories.map((cat) => {
        const list = reg.species.map((e, i) => ({ e, i })).filter(({ e }) => e.cat === cat.id);
        return list.length ? [h('h4', cat.label), list.map(({ e, i }) => {
          const d = h('details.infos-sp', h('summary', e.name || '(sans nom)', h('span.small.muted', e.kind === 'suspended' ? ' · suspendu' : e.kind === 'check' ? ' · à vérifier' : ` · ${e.periods?.length ?? 0} période(s)`)),
            speciesForm(e),
            h('button.link.danger', { type: 'button', onclick: async () => {
              if (await confirmDialog('Supprimer', `Retirer « ${e.name} » des infos ?`, 'Retirer', true)) { reg.species.splice(i, 1); render(); }
            } }, 'Retirer cette espèce'));
          return d;
        })] : null;
      }),
      h('button', { type: 'button', onclick: () => {
        const name = 'Nouvelle espèce';
        let id = slug(name);
        for (let n = 2; reg.species.some((x) => x.id === id); n++) id = `${slug(name)}-${n}`;
        reg.species.push({ id, cat: reg.categories[0]?.id ?? 'autre', name, notes: [], periods: [] });
        render();
      } }, '+ Espèce'));
  }

  function battuesSection() {
    reg.battues.sort((a, b) => a.date.localeCompare(b.date));
    const games = battueGames();
    return fold('Calendrier des battues', { key: 'infos.ed.battues', extra: String(reg.battues.length) },
      h('table.infos-table', h('thead', h('tr', h('th', 'Date'), h('th', 'Gibier'), h('th', 'Responsable'), h('th'))),
        h('tbody', reg.battues.map((b, i) => h('tr',
          h('td', date(b, 'date')),
          h('td', h('input', { value: b.game, list: 'infos-games', maxlength: 40, oninput: (e) => { b.game = e.target.value.trim(); markDirty(); } })),
          h('td', text(b, 'leader', { maxlength: 100 })),
          h('td', del(reg.battues, i)))))),
      h('datalist', { id: 'infos-games' }, games.map((g) => h('option', { value: g }))),
      h('button', { type: 'button', onclick: () => { const last = reg.battues.at(-1); reg.battues.push({ date: last?.date ?? reg.campaign.from, game: last?.game ?? games[0] ?? 'sanglier', leader: last?.leader ?? '' }); render(); } }, '+ Battue'),
      h('p.small.muted', 'Le gibier relie la battue aux espèces (champ « Battues » d’une espèce), ex. « chevreuil », « sanglier ».'));
  }

  function noticesSection() {
    return fold('Avis datés', { key: 'infos.ed.notices', extra: String(reg.notices.length) },
      reg.notices.map((n, i) => h('div.infos-period',
        h('div.row', h('label', 'Du', date(n, 'from')), h('label', 'Au', date(n, 'to')), del(reg.notices, i)),
        h('label', 'Titre', text(n, 'title', { maxlength: 200 })),
        h('label', 'Texte', area(n, 'text', 2, { maxlength: 1500 })))),
      h('button', { type: 'button', onclick: () => { reg.notices.push({ from: reg.campaign.from, to: reg.campaign.from, title: '', text: '' }); render(); } }, '+ Avis'),
      h('p.small.muted', 'Affichés dans « Ce jour » entre les deux dates (ouverture générale, clôture…). Les jours fériés et les battues du calendrier sont signalés automatiquement.'));
  }

  function rulesSection() {
    return fold('Règles et liste de contrôle', { key: 'infos.ed.rules', extra: String(reg.rules.length) },
      reg.rules.map((r, i) => h('div.infos-period',
        h('div.row', h('label', 'Titre', text(r, 'title', { maxlength: 200 })), del(reg.rules, i)),
        h('label', 'Texte', area(r, 'text', 6, { maxlength: 10000 })),
        check(r, 'open', 'Ouverte par défaut'))),
      h('button', { type: 'button', onclick: () => { reg.rules.push({ title: 'Nouvelle règle', text: '' }); render(); } }, '+ Règle'),
      h('p.small.muted', 'Mise en forme : une ligne vide sépare les paragraphes ; « - » en début de ligne pour une liste ; **gras**.'),
      h('h4', 'Liste de contrôle (sous la première règle)'),
      reg.checklist.map((c, i) => h('div.row', text(c, 'label', { maxlength: 200 }), del(reg.checklist, i))),
      h('button', { type: 'button', onclick: () => { reg.checklist.push({ id: `ck${Date.now().toString(36)}`, label: '' }); render(); } }, '+ Élément'));
  }

  function render() {
    const summary = saved ? `${saved.species.length} espèces · ${saved.battues.length} battues · ${saved.rules.length} règles` : 'aucune';
    fill(box, fold('Infos de la saison (onglet Infos)', { key: 'settings.infos', extra: summary },
      h('p.small.muted', `Dates d’ouverture, espèces, battues et règles de la saison ${season.name}, affichées à tous les membres dans Ma chasse → Infos.`),
      fileButtons(),
      reg ? [generalSection(), speciesSection(), battuesSection(), noticesSection(), rulesSection()] : null,
      saveBar));
    markDirty();
  }

  await load();
}
