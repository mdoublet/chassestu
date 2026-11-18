// Libellés et messages des battues (sans DOM, testés).

export const STATUS_LABELS = {
  brouillon: 'Brouillon',
  publiee: 'Publiée',
  en_cours: 'En cours',
  terminee: 'Terminée',
  annulee: 'Annulée',
};

export const ROLE_LABELS = { poste: 'Posté', traqueur: 'Traqueur', chef_de_ligne: 'Chef de ligne' };

/** « samedi 5 décembre 2026 » à partir de « 2026-12-05 » (sans décalage de fuseau). */
export function formatHuntDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** « 7h45 », « 8h » */
export function formatTime(hhmm) {
  const [hh, mm] = hhmm.split(':');
  return `${Number(hh)}h${mm === '00' ? '' : mm}`;
}

export const huntLink = (origin, id) => `${origin}/#/battues/${id}`;

/** Messages prêts à copier pour WhatsApp, à chaque étape. */
export function whatsappMessage(kind, hunt, link) {
  const when = `${formatHuntDate(hunt.date)}, rendez-vous à ${formatTime(hunt.meeting_time)}${hunt.meeting_place ? ` (${hunt.meeting_place})` : ''}`;
  switch (kind) {
    case 'convocation':
      return `Battue au ${hunt.territory_name} le ${when}.\nMerci de répondre présent ou absent dans l’application : ${link}`;
    case 'attributions':
      return `Les postes de la battue du ${formatHuntDate(hunt.date)} sont attribués. Votre poste, le chemin et vos voisins : ${link}`;
    case 'debut':
      return `Début de battue (${hunt.territory_name}) : la traque commence. Restez à votre poste, angles de tir respectés.`;
    case 'fin':
      return `Fin de battue (${hunt.territory_name}) : déchargez vos armes et rejoignez le point de rendez-vous.`;
    case 'annulation':
      return `La battue du ${formatHuntDate(hunt.date)} au ${hunt.territory_name} est annulée.`;
    default:
      return link;
  }
}

/** Participants postés présents, et ceux sans poste. */
export function postedSummary(participants) {
  const posted = participants.filter((p) => p.present && p.role === 'poste');
  return { posted: posted.length, unassigned: posted.filter((p) => !p.post_id) };
}

export const CATEGORY_LABELS = { male: 'mâle', femelle: 'femelle', jeune: 'jeune', indetermine: 'indéterminé' };
export const COMMON_SPECIES = ['Sanglier', 'Chevreuil', 'Cerf élaphe', 'Daim', 'Mouflon', 'Chamois', 'Renard'];

/**
 * Bandeau de la vue chasseur : quoi faire maintenant, selon le statut de la
 * battue, la publication des postes, le début de battue et le rôle.
 * @returns {{ tone: 'info'|'warn'|'go'|'done'|'danger', title: string, text: string }}
 */
export function hunterInstruction(sheet) {
  const { hunt, me, post } = sheet;
  const rdv = `${formatTime(hunt.meeting_time)}${hunt.meeting_place ? `, ${hunt.meeting_place}` : ''}`;
  const role = me?.role;
  switch (hunt.status) {
    case 'annulee':
      return { tone: 'danger', title: 'Battue annulée', text: `La battue du ${formatHuntDate(hunt.date)} n’aura pas lieu.` };
    case 'terminee':
      return { tone: 'done', title: 'Battue terminée', text: 'Déchargez votre arme et rejoignez le rendez-vous. Signalez vos prélèvements s’ils ne sont pas encore déclarés.' };
    case 'publiee':
      if (!me) return { tone: 'info', title: `Battue prévue le ${formatHuntDate(hunt.date)}`, text: `Rendez-vous à ${rdv}.` };
      if (!me.response) return { tone: 'warn', title: 'Serez-vous présent ?', text: `Battue le ${formatHuntDate(hunt.date)}, rendez-vous à ${rdv}. Répondez ci-dessous.` };
      if (me.response === 'absent') return { tone: 'info', title: 'Vous êtes noté absent', text: 'Vous pouvez changer d’avis ci-dessous tant que la battue n’a pas commencé.' };
      return { tone: 'info', title: `Rendez-vous le ${formatHuntDate(hunt.date)}`, text: `À ${rdv}. Votre poste sera attribué au rond du matin.` };
    case 'en_cours':
      if (!me) {
        return hunt.started_at
          ? { tone: 'go', title: 'Battue en cours', text: `${hunt.posted_count} posté(s) sur ${hunt.present_count} présent(s).` }
          : { tone: 'warn', title: 'Rond du matin', text: `${hunt.present_count} présent(s) ; ${hunt.assignments_published ? 'postes publiés, en attente du début de battue.' : 'postes pas encore publiés.'}` };
      }
      if (!hunt.assignments_published) {
        return { tone: 'warn', title: 'Rond du matin', text: `Rejoignez le rendez-vous (${rdv}) : les postes sont attribués sur place.` };
      }
      if (hunt.started_at) {
        if (role === 'traqueur') return { tone: 'go', title: 'Battue en cours : traque', text: 'Gilet orange, restez en ligne avec les autres traqueurs, signalez-vous à la voix.' };
        if (role === 'chef_de_ligne') return { tone: 'go', title: 'Battue en cours', text: 'Veillez à la ligne de postes et à la sécurité. Fin de battue annoncée par le responsable.' };
        return post
          ? { tone: 'go', title: `Battue en cours — poste ${post.number}`, text: 'Restez à votre poste. Tir uniquement dans les angles autorisés, jamais vers vos voisins ni vers les habitations.' }
          : { tone: 'warn', title: 'Battue en cours', text: 'Vous n’avez pas de poste : voyez le responsable.' };
      }
      if (role === 'traqueur') return { tone: 'warn', title: 'Vous êtes traqueur', text: 'Préparez-vous : la traque démarrera au signal du responsable.' };
      if (role === 'chef_de_ligne') return { tone: 'warn', title: 'Vous êtes chef de ligne', text: 'Vérifiez la mise en place des postés avant le début de battue.' };
      return post
        ? { tone: 'warn', title: `Rejoignez votre poste n° ${post.number}`, text: 'Chargez votre arme seulement une fois au poste et attendez le signal de début de battue.' }
        : { tone: 'warn', title: 'Pas de poste attribué', text: 'Voyez le responsable de la battue.' };
    default:
      return { tone: 'info', title: STATUS_LABELS[hunt.status] ?? hunt.status, text: '' };
  }
}

export const NAV_APPS = { google: 'Google Maps', waze: 'Waze', apple: 'Plans' };

/** Liens d'itinéraire en voiture vers un point [lon, lat] (applis du téléphone). */
export function navigationLinks([lon, lat]) {
  const ll = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${ll}&navigate=yes`,
    apple: `https://maps.apple.com/?daddr=${ll}`,
  };
}
