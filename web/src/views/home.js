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
        href: '#/carte',
        title: role === 'president' ? 'Cartographie' : 'Carte des territoires',
        text: role === 'president' ? 'Territoires, réserves, postes, parkings et chemins d’accès.' : 'Consulter les territoires et les postes.',
      },
      (role === 'president' || role === 'responsable') && {
        href: '#/plans',
        title: 'Plans de couverture',
        text: role === 'president' ? 'Quels postes couvrir selon le nombre de chasseurs.' : 'Postes à couvrir selon le nombre de chasseurs.',
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

  main.append(
    profileCard(refreshMe),
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
  return () => stopRefresh?.();
}

/**
 * Marche et voiture : l'organisateur s'en sert pour proposer des postes
 * accessibles et organiser le covoiturage.
 */
function profileCard(refreshMe) {
  const u = state.user;
  const walk = h('select', { name: 'walking_ability' }, h('option', { value: '' }, 'Non renseigné'),
    Object.entries(WALK_LABELS).map(([v, l]) => h('option', { value: v, selected: String(u.walking_ability ?? '') === v }, l)));
  const car = h('input', { type: 'checkbox', checked: !!u.has_car });
  const seats = h('input', { type: 'number', min: 0, max: 8, value: u.car_seats ?? '', style: 'width:6rem' });
  const sync = () => { seats.disabled = !car.checked; };
  car.addEventListener('change', sync);
  sync();
  const incomplete = !u.walking_ability || u.has_car === null || u.has_car === undefined;
  return h('details.card', { open: incomplete },
    h('summary', `Mon profil : marche et voiture${incomplete ? ' (à compléter)' : ''}`),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api.patch('/me', {
            walking_ability: walk.value ? Number(walk.value) : null,
            has_car: car.checked,
            car_seats: car.checked && seats.value !== '' ? Number(seats.value) : car.checked ? null : 0,
          }, { tenant: false });
          await refreshMe();
          toast('Profil enregistré.');
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      },
    },
    h('label', 'Combien pouvez-vous marcher pour rejoindre un poste ?', walk),
    h('label.check', car, 'Je viens avec ma voiture'),
    h('label', 'Places libres pour d’autres chasseurs', seats),
    h('p.small.muted', 'Sert à vous proposer des postes accessibles et à organiser le covoiturage vers les parkings. Modifiable à tout moment ; l’organisateur peut l’ajuster pour une journée.'),
    h('button.primary', { type: 'submit' }, 'Enregistrer')));
}
