import { api } from '../api.js';
import { providerName } from '../auth.js';
import { state } from '../state.js';
import { h, fill, errorMessage, toast } from '../ui.js';
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

  // Membre d'une association : l'accueil ne ferait que répéter le menu, on ouvre les journées.
  if (state.tenants.length) {
    location.replace('#/journees');
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
      { href: '#/journees', icon: '🎯', title: 'Journées' },
      { href: '#/territoires', icon: '🗺️', title: 'Territoires' },
      role === 'president' && { href: '#/lieux', icon: '📍', title: 'Lieux' },
      (role === 'president' || role === 'responsable') && { href: '#/membres', icon: '👥', title: 'Membres' },
      role === 'president' && { href: '#/parametres', icon: '⚙️', title: 'Paramètres' },
      { href: '#/profil', icon: '👤', title: 'Mon profil' },
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
      h('nav.icon-tiles', tiles.map((t) => h('a.icon-tile', { href: t.href }, h('span.icon', t.icon), h('span', t.title)))),
    );
  }

  // Proposer d'activer les notifications tant qu'elles ne le sont pas sur cet appareil.
  if (state.tenants.length) {
    const card = pushCard((status) => { if (status === 'enabled') setTimeout(() => card.remove(), 2500); });
    main.append(card);
    import('../push-client.js').then(async ({ pushStatus }) => { if ((await pushStatus()) === 'enabled') card.remove(); });
  }


  // Rappel en haut de page tant que le profil (marche, voiture) n'est pas rempli.
  if (!state.user.walking_ability || state.user.has_car === null || state.user.has_car === undefined) {
    main.querySelector('h1')?.after(
      h('a.current-hunt', { href: '#/profil' }, h('strong', '👤 Complétez votre profil'), h('span', 'Marche et voiture →')));
  }
  return () => stopRefresh?.();
}

