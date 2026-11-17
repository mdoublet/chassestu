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

/**
 * Tirage au sort : les attributions verrouillées sont conservées ; les autres
 * chasseurs postés sont répartis au hasard sur les postes libres. Avec
 * `allowDouble`, les chasseurs en trop complètent les postes (2 au plus).
 * Renvoie les nouvelles attributions (hors verrouillées) et les non-placés.
 */
export function drawAssignments(
  postIds: string[],
  hunters: string[],
  locked: { post_id: string; participant_id: string }[],
  allowDouble: boolean,
  random?: () => number,
): { assignments: { post_id: string; participant_id: string }[]; unplaced: string[] } {
  const lockedHunters = new Set(locked.map((l) => l.participant_id));
  const load = new Map(postIds.map((id) => [id, 0]));
  for (const l of locked) load.set(l.post_id, (load.get(l.post_id) ?? 0) + 1);

  const toPlace = shuffle(hunters.filter((h) => !lockedHunters.has(h)), random);
  const free = shuffle(postIds.filter((id) => (load.get(id) ?? 0) === 0), random);
  const assignments: { post_id: string; participant_id: string }[] = [];

  while (toPlace.length && free.length) {
    const post_id = free.pop()!;
    assignments.push({ post_id, participant_id: toPlace.pop()! });
    load.set(post_id, 1);
  }
  if (allowDouble) {
    const singles = shuffle(postIds.filter((id) => (load.get(id) ?? 0) === 1), random);
    while (toPlace.length && singles.length) {
      const post_id = singles.pop()!;
      assignments.push({ post_id, participant_id: toPlace.pop()! });
      load.set(post_id, 2);
    }
  }
  return { assignments, unplaced: toPlace };
}
