// Proposition des postes du jour selon le nombre de chasseurs postés
// présents (spécification, « Effectif sans plan défini »). Fonction pure.

export interface ProposalPlan {
  hunter_count: number;
  post_ids: string[];
}

export type ProposalKind =
  | 'plan' //          plan défini pour N, entièrement utilisable
  | 'plan_incomplete' // plan pour N, mais certains postes sont devenus indisponibles
  | 'lower_plan' //     pas de plan pour N : plan du plus grand effectif inférieur
  | 'manual' //         N inférieur au plus petit plan, ou aucun plan
  | 'too_many' //       plus de chasseurs que de postes disponibles
  | 'none'; //          aucun chasseur posté

export interface Proposal {
  kind: ProposalKind;
  hunters: number;
  plan_count: number | null; // effectif du plan utilisé
  post_ids: string[]; // postes proposés (disponibles uniquement)
  missing: number; // postes à ajouter à la main
  extra: number; // chasseurs sans poste possible (traque ou doublon)
  message: string;
}

/**
 * @param hunters nombre de chasseurs postés présents
 * @param plans plans de couverture du territoire
 * @param available identifiants des postes disponibles (actifs, valides)
 */
export function proposePosts(hunters: number, plans: ProposalPlan[], available: Set<string>): Proposal {
  const usable = (ids: string[]) => ids.filter((id) => available.has(id));
  const base = { hunters, plan_count: null as number | null, post_ids: [] as string[], missing: 0, extra: 0 };

  if (hunters <= 0) {
    return { ...base, kind: 'none', message: 'Cochez les chasseurs présents et postés.' };
  }
  if (hunters > available.size) {
    return {
      ...base,
      kind: 'too_many',
      post_ids: [...available],
      extra: hunters - available.size,
      message: `${hunters} postés pour ${available.size} poste(s) disponible(s) : ${hunters - available.size} chasseur(s) en trop passent en traque ou en doublon de poste, au choix du responsable.`,
    };
  }

  const exact = plans.find((p) => p.hunter_count === hunters);
  if (exact) {
    const ids = usable(exact.post_ids);
    if (ids.length === hunters) {
      return { ...base, kind: 'plan', plan_count: hunters, post_ids: ids, message: `Plan à ${hunters} chasseurs.` };
    }
    return {
      ...base,
      kind: 'plan_incomplete',
      plan_count: hunters,
      post_ids: ids,
      missing: hunters - ids.length,
      message: `Plan à ${hunters} chasseurs, mais ${hunters - ids.length} poste(s) indisponible(s) (désactivés ou trop près d’une habitation) : choisissez-en d’autres sur la carte.`,
    };
  }

  const lower = plans.filter((p) => p.hunter_count < hunters).sort((a, b) => b.hunter_count - a.hunter_count)[0];
  if (lower) {
    const ids = usable(lower.post_ids);
    const missing = hunters - ids.length;
    return {
      ...base,
      kind: 'lower_plan',
      plan_count: lower.hunter_count,
      post_ids: ids,
      missing,
      message: `Pas de plan pour ${hunters} chasseurs : plan à ${lower.hunter_count} proposé, ajoutez ${missing} poste(s) sur la carte.`,
    };
  }

  return {
    ...base,
    kind: 'manual',
    missing: hunters,
    message: plans.length
      ? `Moins de chasseurs que le plus petit plan : choisissez ${hunters} poste(s) sur la carte.`
      : `Aucun plan de couverture : choisissez ${hunters} poste(s) sur la carte.`,
  };
}

/** Mélange de Fisher-Yates avec un générateur cryptographique. */
export function shuffle<T>(items: T[], random: () => number = cryptoRandom): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** Difficulté d'accès des postes et capacité de marche des chasseurs (1 à 5 ; null : inconnue). */
export interface Mobility {
  difficulty: Map<string, number | null>;
  ability: Map<string, number | null>;
}

/** Le chasseur peut-il tenir ce poste ? (inconnu d'un côté ou de l'autre : oui) */
export function canReach(difficulty: number | null | undefined, ability: number | null | undefined): boolean {
  return difficulty == null || ability == null || difficulty <= ability;
}

/**
 * Tirage au sort : les attributions verrouillées sont conservées ; les autres
 * chasseurs postés sont répartis au hasard sur les postes libres. Avec
 * `allowDouble`, les chasseurs en trop complètent les postes (2 au plus).
 *
 * Avec `mobility` : jamais un poste plus difficile que la capacité de marche
 * du chasseur. Les chasseurs qui marchent le moins sont placés d'abord, et
 * ceux qui marchent peu (1 ou 2) reçoivent le poste le plus facile restant.
 * (Les postes accessibles à un chasseur sont inclus dans ceux accessibles à
 * un meilleur marcheur : placer d'abord les moins mobiles trouve une
 * répartition dès qu'il en existe une.)
 * Renvoie les nouvelles attributions (hors verrouillées) et les non-placés.
 */
export function drawAssignments(
  postIds: string[],
  hunters: string[],
  locked: { post_id: string; participant_id: string }[],
  allowDouble: boolean,
  random?: () => number,
  mobility?: Mobility,
): { assignments: { post_id: string; participant_id: string }[]; unplaced: string[] } {
  const lockedHunters = new Set(locked.map((l) => l.participant_id));
  const load = new Map(postIds.map((id) => [id, 0]));
  for (const l of locked) load.set(l.post_id, (load.get(l.post_id) ?? 0) + 1);
  const diff = (p: string) => mobility?.difficulty.get(p) ?? null;
  const ab = (h: string) => mobility?.ability.get(h) ?? null;

  // Au hasard, puis (tri stable) les moins mobiles d'abord.
  const toPlace = shuffle(hunters.filter((h) => !lockedHunters.has(h)), random)
    .sort((a, b) => (ab(a) ?? 99) - (ab(b) ?? 99));
  const assignments: { post_id: string; participant_id: string }[] = [];
  const unplaced: string[] = [];

  const pick = (h: string, candidates: string[]) => {
    const ok = candidates.filter((p) => canReach(diff(p), ab(h)));
    if (!ok.length) return null;
    const a = ab(h);
    if (a !== null && a <= 2) {
      // Marche difficile : le poste connu le plus facile (inconnu en dernier recours).
      return ok.slice().sort((x, y) => (diff(x) ?? 6) - (diff(y) ?? 6))[0];
    }
    return ok[0]; // candidats déjà mélangés
  };

  const rest: string[] = [];
  for (const h of toPlace) {
    const free = shuffle(postIds.filter((id) => (load.get(id) ?? 0) === 0), random);
    const post_id = pick(h, free);
    if (post_id) {
      assignments.push({ post_id, participant_id: h });
      load.set(post_id, 1);
    } else {
      rest.push(h);
    }
  }
  for (const h of rest) {
    const singles = allowDouble ? shuffle(postIds.filter((id) => (load.get(id) ?? 0) === 1), random) : [];
    const post_id = pick(h, singles);
    if (post_id) {
      assignments.push({ post_id, participant_id: h });
      load.set(post_id, 2);
    } else {
      unplaced.push(h);
    }
  }
  return { assignments, unplaced };
}
