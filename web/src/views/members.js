import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, copyText, errorMessage, formatDate, modal, toast, confirmDialog, fold, ROLE_LABELS } from '../ui.js';

const CATEGORY = { chasseur: 'Chasseur', traqueur: 'Traqueur', autre: 'Autre' };

export async function membersView(main) {
  const isPresident = state.role === 'president';
  // Président adjoint : droits du président, sauf sur les droits des autres (rôles, retraits, mandats).
  const isTitular = isPresident && !state.tenant?.deputy_until;
  const membersBox = h('div');
  const invitesBox = h('div');
  main.append(h('h1', 'Membres'), membersBox, ...(isPresident ? [h('section', h('h2', 'Inviter'), invitesBox)] : []));
  const shortDate = (iso) => new Date(new Date(iso).getTime() - 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

  async function setDeputy(m, until) {
    try {
      await api.put(`/members/${encodeURIComponent(m.id)}/deputy`, { until });
      toast(until ? `${m.display_name} est président adjoint jusqu’au ${new Date(until).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}.` : `Mandat de ${m.display_name} terminé.`);
      loadMembers();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function askDeputy(m) {
    const d = new Date(Date.now() + 7 * 86_400_000);
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const input = h('input', { type: 'date', value: iso(d), min: iso(new Date()), max: iso(new Date(Date.now() + 365 * 86_400_000)) });
    const v = await modal(`Président adjoint : ${m.display_name}`, h('div',
      h('p', `${m.display_name} aura tous les droits du président (territoires, plans, journées, battues, paramètres), sauf changer les droits des membres. Il pourra désigner le responsable des battues qu’il crée.`),
      h('label', 'Jusqu’au (inclus)', input)), [
      { label: 'Annuler', value: null },
      { label: 'Nommer', value: 'ok', primary: true },
    ]);
    if (v === 'ok' && input.value) setDeputy(m, input.value);
  }

  /**
   * Un membre = une ligne dépliable : nom et résumé (rôle, marche, voiture) ;
   * dépliée : rôle, président adjoint, marche, voiture, retrait.
   */
  function memberRow(m) {
    const save = async (body) => {
      try {
        await api.patch(`/members/${encodeURIComponent(m.id)}/mobility`, body);
        toast('Enregistré.');
        loadMembers();
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    };
    const summary = [
      // Catégorie (chasseur, traqueur, autre) ; le rôle seulement s'il donne des droits.
      CATEGORY[m.usual_role ?? 'chasseur'],
      m.deputy_until ? `adjoint → ${shortDate(m.deputy_until)}` : m.role !== 'chasseur' ? ROLE_LABELS[m.role].toLowerCase() : null,
      m.walking_ability ? `🥾${m.walking_ability}` : null,
      m.has_car ? `🚗${m.car_seats ?? ''}` : null,
    ].filter(Boolean).join(' · ');
    const role = isTitular
      ? h('select', { 'aria-label': `Rôle de ${m.display_name}`, onchange: async (e) => {
          try {
            await api.patch(`/members/${encodeURIComponent(m.id)}`, { role: e.target.value });
            toast('Rôle modifié.');
            loadMembers();
          } catch (err) {
            toast(errorMessage(err), 'error');
            e.target.value = m.role;
          }
        } }, Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === m.role }, l)))
      : h('span', ROLE_LABELS[m.role]);
    const deputy = m.role === 'president' ? null
      : m.deputy_until
        ? h('div', h('span.badge.deputy', `Président adjoint jusqu’au ${shortDate(m.deputy_until)}`),
            isTitular ? h('button.link', { onclick: () => askDeputy(m) }, ' Prolonger') : null,
            isTitular ? h('button.link.danger', { onclick: () => setDeputy(m, null) }, ' Fin du mandat') : null)
        : isTitular ? h('button.link', { onclick: () => askDeputy(m), title: 'Droits du président, sauf les droits des membres' }, 'Nommer président adjoint') : null;
    return fold(`${m.display_name || '(sans nom)'}${m.id === state.user.id ? ' (vous)' : ''}`, { extra: summary, className: 'member-row' },
      h('div.member-grid',
        h('label', 'Rôle', role),
        h('label', { title: 'Range les convocations ; un traqueur est traqueur par défaut dans les battues.' }, 'Catégorie',
          h('select', { 'aria-label': `Catégorie de ${m.display_name}`, onchange: (e) => save({ usual_role: e.target.value }) },
            Object.entries(CATEGORY).map(([v, l]) => h('option', { value: v, selected: (m.usual_role ?? 'chasseur') === v }, l)))),
        h('label', 'Marche', h('select', { 'aria-label': `Marche de ${m.display_name}`, onchange: (e) => save({ walking_ability: e.target.value ? Number(e.target.value) : null }) },
          h('option', { value: '' }, '—'), [1, 2, 3, 4, 5].map((v) => h('option', { value: v, selected: m.walking_ability === v }, `🥾 ${v}`)))),
        h('label.check', h('input', { type: 'checkbox', checked: !!m.has_car, 'aria-label': `Voiture de ${m.display_name}`, onchange: (e) => save({ has_car: e.target.checked }) }), 'Voiture'),
        h('label', 'Places', h('input', { type: 'number', min: 0, max: 8, value: m.car_seats ?? '', disabled: !m.has_car, 'aria-label': `Places de ${m.display_name}`,
          onchange: (e) => save({ car_seats: e.target.value === '' ? null : Number(e.target.value) }) }))),
      [m.email, m.phone].filter(Boolean).length ? h('p.small.muted', [m.email, m.phone].filter(Boolean).join(' · ')) : null,
      deputy,
      isTitular && m.id !== state.user.id
        ? h('button.link.danger', { onclick: async () => {
            if (!(await confirmDialog('Retirer', `Retirer ${m.display_name} de l’association ?`, 'Retirer', true))) return;
            try {
              await api.del(`/members/${encodeURIComponent(m.id)}`);
              loadMembers();
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          } }, 'Retirer de l’association')
        : null);
  }

  async function loadMembers() {
    const { members } = await api.get('/members');
    fill(membersBox, h('div.card.member-list', members.map(memberRow)));
  }

  async function loadInvites() {
    const { invitations } = await api.get('/invitations');
    // Un président adjoint n'invite que des chasseurs.
    const role = h('select', Object.entries(ROLE_LABELS).filter(([v]) => isTitular || v === 'chasseur').map(([v, l]) => h('option', { value: v, selected: v === 'chasseur' }, l)));
    const days = h('select', [7, 30, 90, 365].map((d) => h('option', { value: d, selected: d === 30 }, `${d} jours`)));
    fill(invitesBox, 
      h(
        'div.card',
        h('div.row', h('label', 'Rôle', role), h('label', 'Validité', days)),
        h('button.primary', {
          onclick: async () => {
            try {
              const { invitation } = await api.post('/invitations', {
                role: role.value,
                expires_in_days: Number(days.value),
                // Un lien de président ou de responsable est à usage unique.
                max_uses: role.value === 'chasseur' ? null : 1,
              });
              await showLink(invitation);
              loadInvites();
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          },
        }, 'Créer un lien à partager'),
      ),
      invitations.length
        ? fold('Liens actifs', { key: 'members.links', extra: String(invitations.length) }, h(
            'ul.plain.small',
            invitations.map((i) =>
              h(
                'li',
                `${ROLE_LABELS[i.role]} · jusqu’au ${formatDate(i.expires_at)} · ${i.use_count}${i.max_uses ? `/${i.max_uses}` : ''} utilisation(s) `,
                h('button.link.danger', {
                  onclick: async () => {
                    await api.del(`/invitations/${i.id}`);
                    toast('Lien révoqué.');
                    loadInvites();
                  },
                }, 'Révoquer'),
              ),
            ),
          ))
        : null,
    );
  }

  async function showLink(invitation) {
    const message = `Rejoins ${state.tenant.name} sur l’application des battues : ${invitation.url}`;
    await modal(
      'Lien d’invitation',
      [
        h('p', 'Ce lien ne sera plus affiché : copiez-le maintenant.'),
        h('textarea.copy', { readOnly: true, rows: 3 }, invitation.url),
        h('div.row', h('button', { type: 'button', onclick: () => copyText(invitation.url) }, 'Copier le lien'), h('button.primary', { type: 'button', onclick: () => copyText(message) }, 'Copier pour WhatsApp')),
      ],
      [{ label: 'Fermer', value: null }],
    );
  }

  try {
    await Promise.all([loadMembers(), isPresident ? loadInvites() : null]);
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
  }
}
