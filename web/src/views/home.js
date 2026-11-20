import { api } from '../api.js';
import { providerName } from '../auth.js';
import { state } from '../state.js';
import { h, fill, errorMessage, toast, ROLE_LABELS } from '../ui.js';
import { pushCard } from './notifications.js';
import { every, localToday } from '../lib/live.js';
import { formatHuntDate, formatTime } from '../lib/hunts.js';

export async function homeView(main, { refreshMe, rerender }) {
  let stopRefresh = null;
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
        h('p', 'Demandez au président de votre association de vous envoyer un lien d’invitation, puis ouvrez-le sur cet appareil.'),
      ),
    );
  } else {
    const role = state.role;
    const tiles = [
      {
        href: '#/journees',
        title: 'Journées de chasse',
        text: role === 'chasseur' ? 'Vos convocations, votre poste, l’itinéraire et le covoiturage.' : 'Convoquer, pointer les présents, organiser les battues.',
      },
      {
        href: '#/territoires',
        title: 'Territoires',
        text: role === 'president' ? 'Liste, ajout et carte : réserves, postes, parkings, chemins, plans de couverture.' : 'Consulter les territoires et les postes.',
      },
      (role === 'president' || role === 'responsable') && {
        href: '#/membres',
        title: 'Membres',
        text: role === 'president' ? 'Inviter des chasseurs, gérer les rôles.' : 'Liste des membres.',
      },
      role === 'president' && { href: '#/parametres', title: 'Paramètres', text: 'Distance de sécurité, tolérance GPS, conservation des positions.' },
    ].filter(Boolean);

    // Journée du moment : en cours, sinon la prochaine convoquée (vue chasseur en un clic).
    const current = h('div');
    const loadCurrent = async () => {
      try {
        const { days } = await api.get('/days');
        const today = localToday();
        const pick = days.find((x) => x.status === 'en_cours')
          ?? days.filter((x) => x.status === 'convoquee' && x.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
        const b = pick?.current_battue;
        const title = !pick ? '' : pick.status !== 'en_cours' ? '📅 Prochaine journée de chasse'
          : !b ? '🎯 Journée en cours : rendez-vous'
            : b.status === 'terminee' ? `🎯 Battue n° ${b.number} terminée` : b.started_at ? `🎯 Battue n° ${b.number} en cours` : `🎯 Battue n° ${b.number} en préparation`;
        fill(current, pick
          ? h('a.current-hunt', { href: `#/journees/${pick.id}`, class: pick.status === 'en_cours' ? 'running' : '' },
              h('strong', title),
              h('span', `${formatHuntDate(pick.date)} · RDV ${formatTime(pick.meeting_time)}${pick.meeting_place ? `, ${pick.meeting_place}` : ''}`),
              h('span.small', pick.status === 'convoquee' && pick.convoked_me && !pick.my_response ? 'Répondez présent ou absent →' : 'Voir mon poste et les consignes →'))
          : null);
      } catch {
        /* réseau : on réessaiera */
      }
    };
    loadCurrent();
    stopRefresh = every(30_000, loadCurrent);

    main.append(
      current,
      h('p.muted', `${state.tenant.name} — ${ROLE_LABELS[role]}`),
      h('nav.tiles', tiles.map((t) => h('a.tile', { href: t.href }, h('strong', t.title), h('span', t.text)))),
    );
  }

  // Proposer d'activer les notifications tant qu'elles ne le sont pas sur cet appareil.
  if (state.tenants.length) {
    const card = pushCard((status) => { if (status === 'enabled') setTimeout(() => card.remove(), 2500); });
    main.append(card);
    import('../push-client.js').then(async ({ pushStatus }) => { if ((await pushStatus()) === 'enabled') card.remove(); });
  }

  if (state.user.is_super_admin) {
    main.append(h('p', h('a', { href: '#/admin' }, 'Administration de la plateforme')));
  }

  // Rappel en haut de page tant que le profil (marche, voiture) n'est pas rempli.
  if (!state.user.walking_ability || state.user.has_car === null || state.user.has_car === undefined) {
    main.querySelector('h1')?.after(
      h('a.current-hunt', { href: '#/profil' }, h('strong', '👤 Complétez votre profil'), h('span', 'Votre marche et votre voiture : pour des postes accessibles et le covoiturage →')));
  }
  return () => stopRefresh?.();
}

