import { api } from '../api.js';
import { providerName } from '../auth.js';
import { state } from '../state.js';
import { h, errorMessage, toast, ROLE_LABELS } from '../ui.js';

export async function homeView(main, { refreshMe, rerender }) {
  // Profil incomplet : le nom est indispensable (attributions, liste des membres).
  if (!state.user.display_name) {
    const input = h('input', { required: true, maxlength: 120, value: providerName() });
    main.append(
      h('h1', 'Bienvenue'),
      h(
        'form.card',
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api.patch('/me', { display_name: input.value.trim() }, { tenant: false });
              await refreshMe();
              rerender();
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          },
        },
        h('label', 'Votre nom, tel que le verra le président', input),
        h('button.primary', { type: 'submit' }, 'Continuer'),
      ),
    );
    return;
  }

  main.append(h('h1', `Bonjour ${state.user.display_name}`));

  if (state.tenants.length === 0) {
    main.append(
      h(
        'div.card',
        h('p', 'Vous n’êtes membre d’aucune association de chasse.'),
        h('p', 'Demandez au président de votre association de vous envoyer un lien d’invitation, puis ouvrez-le sur ce téléphone.'),
      ),
    );
  } else {
    const role = state.role;
    const tiles = [
      {
        href: '#/carte',
        title: role === 'president' ? 'Cartographie' : 'Carte des territoires',
        text: role === 'president' ? 'Territoires, réserves, postes, parkings et chemins d’accès.' : 'Consulter les territoires et les postes.',
      },
      (role === 'president' || role === 'responsable') && {
        href: '#/membres',
        title: 'Membres',
        text: role === 'president' ? 'Inviter des chasseurs, gérer les rôles.' : 'Liste des membres.',
      },
      role === 'president' && { href: '#/parametres', title: 'Paramètres', text: 'Distance de sécurité, tolérance GPS, conservation des positions.' },
    ].filter(Boolean);

    main.append(
      h('p.muted', `${state.tenant.name} — ${ROLE_LABELS[role]}`),
      h('nav.tiles', tiles.map((t) => h('a.tile', { href: t.href }, h('strong', t.title), h('span', t.text)))),
      h('p.muted.small', 'Les battues (convocations, attribution des postes, guidage GPS) arrivent dans les prochaines versions.'),
    );
  }

  if (state.user.is_super_admin) {
    main.append(h('p', h('a', { href: '#/admin' }, 'Administration de la plateforme')));
  }

  main.append(
    h(
      'details.card.small',
      h('summary', 'Mon compte'),
      h('p', 'Supprimer votre compte retire votre accès à toutes vos associations.'),
      h('button.danger', {
        onclick: async () => {
          if (!confirm('Supprimer définitivement votre compte ?')) return;
          try {
            await api.del('/me', { tenant: false });
            toast('Compte supprimé.');
            location.reload();
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        },
      }, 'Supprimer mon compte'),
    ),
  );
}
