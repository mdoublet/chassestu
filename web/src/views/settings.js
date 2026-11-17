import { api } from '../api.js';
import { h, errorMessage, toast } from '../ui.js';

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
          gps_tolerance_m: Number(fd.get('gps_tolerance_m')),
          position_retention_h: Number(fd.get('position_retention_h')),
          show_all_posts: fd.get('show_all_posts') === 'on',
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
    field('name', 'Nom de l’association', { required: true, maxlength: 200 }),
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
    field(
      'buffer_distance_m',
      'Distance de sécurité autour des habitations (m)',
      { type: 'number', min: 50, max: 1000, required: true },
      '150 m par défaut (art. L.422-10 en ACCA) ; certains arrêtés imposent 200 m. Modifier cette distance recalcule les zones non chassables et marque invalides les postes devenus trop proches.',
    ),
    field('gps_tolerance_m', 'Tolérance GPS « sur le poste » (m)', { type: 'number', min: 5, max: 200, required: true }),
    field('position_retention_h', 'Conservation des positions GPS (heures)', { type: 'number', min: 1, max: 720, required: true }),
    h('label.check', h('input', { type: 'checkbox', name: 'show_all_posts', checked: tenant.show_all_posts }), 'Les chasseurs voient tous les postes occupés (sinon : le leur et leurs voisins)'),
    h('button.primary', { type: 'submit' }, 'Enregistrer'),
  );
  main.append(h('h1', 'Paramètres'), form);
}
