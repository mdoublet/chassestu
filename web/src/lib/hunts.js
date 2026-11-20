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
  const posted = participants.filter((p) => p.present && (p.role === 'poste' || p.role === 'chef_de_ligne'));
  return { posted: posted.length, unassigned: posted.filter((p) => !p.post_id) };
}

export const CATEGORY_LABELS = { male: 'mâle', femelle: 'femelle', jeune: 'jeune', indetermine: 'indéterminé' };
export const COMMON_SPECIES = ['Sanglier', 'Chevreuil', 'Cerf élaphe', 'Daim', 'Mouflon', 'Chamois', 'Renard'];

export const DAY_STATUS_LABELS = {
  brouillon: 'Brouillon',
  convoquee: 'Convoquée',
  en_cours: 'En cours',
  terminee: 'Terminée',
  annulee: 'Annulée',
};

/** Capacité de marche déclarée par le chasseur (profil). */
export const WALK_LABELS = {
  1: '1 · très peu (poste au bord du chemin)',
  2: '2 · peu (quelques centaines de mètres faciles)',
  3: '3 · moyennement',
  4: '4 · bien',
  5: '5 · beaucoup, chemins escarpés compris',
};

/** Difficulté d'accès d'un poste (1 facile … 5 escarpé). */
export const DIFFICULTY_LABELS = { 1: 'très facile', 2: 'facile', 3: 'moyen', 4: 'difficile', 5: 'escarpé' };

/**
 * Où en est la journée pour ce chasseur, et quoi faire maintenant.
 * `view` : réponse de /days/:id/view (journée, moi, battues, battue courante).
 * @returns {{ phase: string, tone: 'info'|'warn'|'go'|'done'|'danger', title: string, text: string }}
 */
export function dayPhase(view) {
  const { day, me, battues = [], current } = view;
  const rdv = `${formatTime(day.meeting_time)}${day.meeting_place ? `, ${day.meeting_place}` : ''}`;
  const last = battues[battues.length - 1] ?? null;
  const hunt = current?.hunt;
  const role = current?.me?.role;
  const post = current?.post;
  const what = last ? `Battue n° ${last.number} (${last.territory_name})` : '';
  switch (day.status) {
    case 'annulee':
      return { phase: 'annulee', tone: 'danger', title: 'Journée annulée', text: `La journée du ${formatHuntDate(day.date)} n’aura pas lieu.` };
    case 'terminee':
      return { phase: 'terminee', tone: 'done', title: 'Journée terminée', text: 'Merci à tous. Bon retour.' };
    case 'brouillon':
    case 'convoquee':
      if (!me) return { phase: 'convoque', tone: 'info', title: `Journée du ${formatHuntDate(day.date)}`, text: `Rendez-vous à ${rdv}.` };
      if (!me.response) return { phase: 'reponse', tone: 'warn', title: 'Serez-vous présent ?', text: `Journée de chasse le ${formatHuntDate(day.date)}, rendez-vous à ${rdv}.` };
      if (me.response === 'absent') return { phase: 'absent', tone: 'info', title: 'Vous êtes noté absent', text: 'Vous pouvez changer d’avis ci-dessous jusqu’au début de la journée.' };
      return { phase: 'rdv', tone: 'info', title: `Rendez-vous le ${formatHuntDate(day.date)}`, text: `À ${rdv}.${day.lunch_offered ? (me.lunch ? ' Vous êtes inscrit au déjeuner.' : ' Vous n’êtes pas inscrit au déjeuner.') : ''}` };
    default:
      break;
  }
  // Journée en cours.
  if (me && !me.present) {
    return { phase: 'non_present', tone: 'info', title: 'Vous n’êtes pas noté présent', text: 'Arrivé au rendez-vous ? Signalez-vous à l’organisateur.' };
  }
  if (!last) {
    return { phase: 'attente_battue', tone: 'info', title: 'Rendez-vous', text: `${rdv}. La première battue va être organisée.` };
  }
  if (last.status === 'terminee') {
    if (day.regroup) {
      const where = day.regroup.place || 'au point indiqué sur la carte';
      return { phase: 'regroupement', tone: 'warn', title: 'Regroupement', text: `Rendez-vous ${where} ${day.regroup.time ? `à ${formatTime(day.regroup.time)}` : 'dès maintenant'}.` };
    }
    return { phase: 'fin', tone: 'done', title: `Fin de la battue n° ${last.number}`, text: 'Déchargez votre arme. Le lieu de regroupement va vous être indiqué.' };
  }
  if (!current) {
    return { phase: 'non_volontaire', tone: 'info', title: `${what} en cours`, text: 'Vous ne participez pas à cette battue. Attendez le regroupement.' };
  }
  if (!me) {
    return hunt.started_at
      ? { phase: 'traque', tone: 'go', title: `${what} : traque en cours`, text: `${hunt.posted_count} posté(s).` }
      : { phase: 'preparation', tone: 'warn', title: `${what} en préparation`, text: hunt.assignments_published ? 'Postes publiés : les chasseurs rejoignent leur poste.' : 'Postes pas encore publiés.' };
  }
  if (!hunt.assignments_published) {
    return { phase: 'preparation', tone: 'warn', title: `${what} en préparation`, text: 'Restez au rendez-vous : les postes vont être attribués.' };
  }
  if (hunt.started_at) {
    if (role === 'traqueur') return { phase: 'traque', tone: 'go', title: 'Traque en cours', text: 'Gilet orange, restez en ligne avec les autres traqueurs, signalez-vous à la voix.' };
    if (role === 'chef_de_ligne' && !post) return { phase: 'traque', tone: 'go', title: 'Battue en cours', text: 'Veillez à la ligne de postes et à la sécurité. La fin vous sera annoncée.' };
    return post
      ? { phase: 'traque', tone: 'go', title: `Battue en cours — poste ${post.number}`, text: 'Restez à votre poste. Tir uniquement dans les angles autorisés. La fin vous sera annoncée ici.' }
      : { phase: 'traque', tone: 'warn', title: 'Battue en cours', text: 'Vous n’avez pas de poste : voyez le responsable.' };
  }
  if (role === 'traqueur') return { phase: 'rejoindre', tone: 'warn', title: 'Vous êtes traqueur', text: 'Préparez-vous : la traque démarrera au signal du responsable.' };
  // Le chef de ligne est un chasseur posté : il rejoint son poste ; sa ligne s'affiche en dessous.
  if (role === 'chef_de_ligne' && !post) return { phase: 'rejoindre', tone: 'warn', title: 'Vous êtes chef de ligne', text: 'Vérifiez la mise en place des postés avant le début de battue.' };
  if (post && current.me.in_place) {
    return { phase: 'rejoindre', tone: 'go', title: `En place au poste n° ${post.number}`, text: 'Attendez le signal de début de battue.' };
  }
  return post
    ? { phase: 'rejoindre', tone: 'warn', title: `Rejoignez votre poste n° ${post.number}`, text: 'En voiture jusqu’au parking, puis à pied. Chargez votre arme seulement au poste et confirmez « Je suis en place ».' }
    : { phase: 'rejoindre', tone: 'warn', title: 'Pas de poste attribué', text: 'Voyez le responsable de la battue.' };
}

export const NAV_APPS = { google: 'Google Maps', waze: 'Waze', apple: 'Plans' };

/** Liens d'itinéraire en voiture vers un point [lon, lat] (applis du téléphone). */
export function navigationLinks([lon, lat]) {
  const ll = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${ll}&navigate=yes`,
    // Format « unified Maps URLs » d'Apple (iOS 18.4+) : l'ancien ?daddr=lat,long
    // n'est plus interprété comme des coordonnées (destination fausse).
    apple: `https://maps.apple.com/directions?destination=${ll}&mode=driving`,
  };
}
