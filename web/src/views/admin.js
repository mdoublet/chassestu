// Administration de la plateforme (super-administrateur) : créer, lister et
// supprimer des associations.
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, copyText, errorMessage, toast, modal, formatDate, ROLE_LABELS } from '../ui.js';

export async function adminView(main, { refreshMe } = {}) {
  if (!state.user.is_super_admin) {
    main.append(h('p.error', 'Réservé au super-administrateur.'));
    return;
  }
  const listBox = h('div');
  const result = h('div');

  async function loadList() {
    const { tenants } = await api.get('/admin/tenants', { tenant: false });
    fill(
      listBox,
      tenants.length
        ? h('div.table-scroll', h('table.list',
            h('thead', h('tr', h('th', 'Association'), h('th', 'Président(s)'), h('th', 'Membres'), h('th', 'Territoires'), h('th', 'Battues'), h('th', 'Créée le'), h('th', ''))),
            h('tbody', tenants.map((t) => h('tr',
              h('td', h('strong', t.name), h('div.small.muted', [t.kind === 'acca' ? 'ACCA' : t.kind === 'societe' ? 'Société' : 'Autre', t.departement].filter(Boolean).join(' · '))),
              h('td', t.presidents || h('span.muted', 'aucun (lien non utilisé ?)')),
              h('td', String(t.members)),
              h('td', String(t.territories)),
              h('td', String(t.hunts)),
              h('td.small', formatDate(t.created_at)),
              h('td', h('button.link.danger', { onclick: () => confirmDelete(t) }, 'Supprimer')),
            ))),
          ))
        : h('p.muted', 'Aucune association.'),
    );
  }

  async function confirmDelete(t) {
    let members;
    try {
      ({ members } = await api.get(`/admin/tenants/${t.id}/members`, { tenant: false }));
    } catch (err) {
      toast(errorMessage(err), 'error');
      return;
    }
    const deletable = members.filter((m) => m.deletable);
    const kept = members.filter((m) => !m.deletable);
    const withUsers = h('input', { type: 'checkbox', checked: deletable.length > 0, disabled: !deletable.length });
    const confirmName = h('input', { placeholder: t.name, autocomplete: 'off' });
    const person = (m) => h('li', `${m.name}${m.email && m.email !== m.name ? ` (${m.email})` : ''} — ${ROLE_LABELS[m.role]}${m.kept_reason ? ` : ${m.kept_reason}` : ''}`);

    const ok = await modal(`Supprimer « ${t.name} »`, [
      h('p.alert.danger', `Suppression définitive de l’association et de toutes ses données : ${t.territories} territoire(s), postes, plans, ${t.hunts} battue(s), journal.`),
      h('label.check', withUsers, `Supprimer aussi les ${deletable.length} utilisateur(s) qui n’appartiennent à aucune autre association, avec leur compte de connexion`),
      deletable.length ? h('details', h('summary', `Seraient supprimés (${deletable.length})`), h('ul', deletable.map(person))) : null,
      kept.length ? h('details', h('summary', `Toujours conservés (${kept.length})`), h('ul', kept.map(person))) : null,
      h('label', `Pour confirmer, tapez le nom de l’association : ${t.name}`, confirmName),
    ], [
      { label: 'Annuler', value: false },
      {
        label: 'Supprimer définitivement',
        danger: true,
        value: true,
        onClick: () => {
          if (confirmName.value.trim() !== t.name) {
            toast('Le nom saisi ne correspond pas.', 'error');
            confirmName.focus();
            return false; // garde la fenêtre ouverte
          }
          return true;
        },
      },
    ]);
    if (!ok) return;

    try {
      const res = await api.post(`/admin/tenants/${t.id}/delete`, { delete_users: withUsers.checked, confirm_name: confirmName.value.trim() }, { tenant: false });
      const parts = [`Association « ${t.name} » supprimée`];
      if (res.deleted_users) parts.push(`${res.deleted_users} utilisateur(s) supprimé(s)`);
      if (res.clerk.failed.length) parts.push(`${res.clerk.failed.length} compte(s) de connexion à supprimer à la main dans Clerk`);
      toast(`${parts.join(', ')}.`, res.clerk.failed.length ? 'warn' : 'info');
      if (state.tenantId === t.id) state.setTenant(null);
      await refreshMe?.();
      await loadList();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const form = h(
    'form.card',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          const res = await api.post('/admin/tenants', { name: fd.get('name'), kind: fd.get('kind'), departement: fd.get('departement') || null }, { tenant: false });
          form.reset();
          fill(
            result,
            h(
              'div.card',
              h('p', 'Association créée. Envoyez ce lien au futur président (usage unique, 14 jours) :'),
              h('textarea.copy', { readOnly: true, rows: 3 }, res.president_invitation_url),
              h('button', { type: 'button', onclick: () => copyText(res.president_invitation_url) }, 'Copier'),
            ),
          );
          await loadList();
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

  main.append(
    h('h1', 'Administration'),
    h('h2', 'Associations'),
    listBox,
    h('details.card', h('summary', '+ Nouvelle association'), form),
    result,
  );
  try {
    await loadList();
  } catch (err) {
    fill(listBox, h('p.error', errorMessage(err)));
  }
}
