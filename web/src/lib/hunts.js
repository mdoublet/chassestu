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
