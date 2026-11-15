import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, copyText, errorMessage, formatDate, modal, toast, ROLE_LABELS } from '../ui.js';

export async function membersView(main) {
  const isPresident = state.role === 'president';
  const membersBox = h('div');
  const invitesBox = h('div');
  main.append(h('h1', 'Membres'), ...(isPresident ? [h('section', h('h2', 'Inviter'), invitesBox)] : []), h('section', h('h2', 'Membres de l’association'), membersBox));

  async function loadMembers() {
    const { members } = await api.get('/members');
    fill(membersBox, 
      h(
        'table.list',
        h('thead', h('tr', h('th', 'Nom'), h('th', 'Contact'), h('th', 'Rôle'), isPresident ? h('th', '') : null)),
        h(
          'tbody',
          members.map((m) =>
            h(
              'tr',
              h('td', m.display_name || '(sans nom)', m.id === state.user.id ? ' (vous)' : ''),
              h('td.small', [m.email, m.phone].filter(Boolean).join(' · ')),
              h(
                'td',
                isPresident
                  ? h(
                      'select',
                      {
                        'aria-label': `Rôle de ${m.display_name}`,
                        onchange: async (e) => {
                          try {
                            await api.patch(`/members/${encodeURIComponent(m.id)}`, { role: e.target.value });
                            toast('Rôle modifié.');
                          } catch (err) {
                            toast(errorMessage(err), 'error');
                            e.target.value = m.role;
                          }
                        },
                      },
                      Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === m.role }, l)),
                    )
                  : ROLE_LABELS[m.role],
              ),
              isPresident
                ? h(
                    'td',
                    h('button.link.danger', {
                      onclick: async () => {
                        if (!confirm(`Retirer ${m.display_name} de l’association ?`)) return;
                        try {
                          await api.del(`/members/${encodeURIComponent(m.id)}`);
                          loadMembers();
                        } catch (err) {
                          toast(errorMessage(err), 'error');
                        }
                      },
                    }, 'Retirer'),
                  )
                : null,
            ),
          ),
        ),
      ),
    );
  }

  async function loadInvites() {
    const { invitations } = await api.get('/invitations');
    const role = h('select', Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === 'chasseur' }, l)));
    const days = h('select', [7, 30, 90, 365].map((d) => h('option', { value: d, selected: d === 30 }, `${d} jours`)));
    fill(invitesBox, 
      h(
        'div.card',
        h('p', 'Créez un lien et partagez-le dans le groupe WhatsApp ou par SMS. Toute personne qui l’ouvre rejoint l’association avec le rôle choisi.'),
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
        }, 'Créer un lien d’invitation'),
      ),
      invitations.length
        ? h(
            'ul.plain',
            invitations.map((i) =>
              h(
                'li',
                `${ROLE_LABELS[i.role]} — expire le ${formatDate(i.expires_at)} — utilisé ${i.use_count}${i.max_uses ? `/${i.max_uses}` : ''} fois `,
                h('button.link.danger', {
                  onclick: async () => {
                    await api.del(`/invitations/${i.id}`);
                    toast('Lien révoqué.');
                    loadInvites();
                  },
                }, 'Révoquer'),
              ),
            ),
          )
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
