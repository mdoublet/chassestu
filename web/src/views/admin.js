import { api } from '../api.js';
import { state } from '../state.js';
import { h, copyText, errorMessage, toast } from '../ui.js';

export async function adminView(main) {
  if (!state.user.is_super_admin) {
    main.append(h('p.error', 'Réservé au super-administrateur.'));
    return;
  }
  const result = h('div');
  const form = h(
    'form.card',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          const res = await api.post('/admin/tenants', { name: fd.get('name'), kind: fd.get('kind'), departement: fd.get('departement') || null }, { tenant: false });
          form.reset();
          result.replaceChildren(
            h(
              'div.card',
              h('p', 'Association créée. Envoyez ce lien au futur président (usage unique, 14 jours) :'),
              h('textarea.copy', { readOnly: true, rows: 3 }, res.president_invitation_url),
              h('button', { type: 'button', onclick: () => copyText(res.president_invitation_url) }, 'Copier'),
            ),
          );
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      },
    },
    h('label', 'Nom', h('input', { name: 'name', required: true, maxlength: 200 })),
    h('label', 'Type', h('select', { name: 'kind' }, h('option', { value: 'acca' }, 'ACCA'), h('option', { value: 'societe' }, 'Société de chasse'), h('option', { value: 'autre' }, 'Autre'))),
    h('label', 'Département', h('input', { name: 'departement', maxlength: 3, pattern: '([0-9]{2}|2A|2B|97[1-6])' })),
    h('button.primary', { type: 'submit' }, 'Créer l’association'),
  );
  main.append(h('h1', 'Nouvelle association'), form, result);
}
