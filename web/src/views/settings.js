import { api } from '../api.js';
import { h, errorMessage, toast, fold } from '../ui.js';

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
    field('departement', 'Département', { maxlength: 3, pattern: '([0-9]{2}|2A|2B|97[1-6])', placeholder: 'ex. 11' })),
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
  main.append(h('h1', 'Paramètres'), form);
}
