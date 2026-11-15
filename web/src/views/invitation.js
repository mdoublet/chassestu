import { api } from '../api.js';
import { isSignedIn, mountSignIn } from '../auth.js';
import { state } from '../state.js';
import { h, errorMessage, ROLE_LABELS } from '../ui.js';

export const PENDING_INVITE_KEY = 'chassestu.pendingInvite';

export async function invitationView(main, token, opts) {
  if (!isSignedIn()) {
    // On mémorise le lien pour y revenir après la connexion.
    sessionStorage.setItem(PENDING_INVITE_KEY, token);
    main.classList.add('narrow');
    main.append(
      h('h1', 'Invitation'),
      h('p', 'Connectez-vous pour rejoindre l’association. Un code vous sera envoyé par e-mail.'),
    );
    return mountSignIn(main);
  }

  main.classList.add('narrow');
  let preview;
  try {
    preview = (await api.get(`/invitation-links/${token}`, { tenant: false })).invitation;
  } catch (err) {
    main.append(h('h1', 'Invitation'), h('p.error', errorMessage(err)));
    return;
  }
  if (!preview.valid) {
    main.append(h('h1', 'Invitation'), h('p.error', 'Ce lien a expiré ou a été révoqué. Demandez-en un nouveau au président.'));
    return;
  }

  const button = h('button.primary', {
    onclick: async () => {
      button.disabled = true;
      try {
        const { membership } = await api.post(`/invitation-links/${token}/accept`, {}, { tenant: false });
        await opts.refreshMe();
        state.setTenant(membership.tenant_id);
        location.hash = '#/';
      } catch (err) {
        button.disabled = false;
        main.append(h('p.error', errorMessage(err)));
      }
    },
  }, 'Rejoindre');

  main.append(
    h('h1', 'Invitation'),
    h('div.card', h('p', 'Vous êtes invité à rejoindre ', h('strong', preview.tenant_name), ` en tant que ${ROLE_LABELS[preview.role].toLowerCase()}.`), button),
  );
}
