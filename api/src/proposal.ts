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
      : `Pas de plan de chasse, ou grille vide : choisissez ${hunters} poste(s) sur la carte.`,
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
 * Historique des placements d'un chasseur : poids par poste (occupations
 * passées, les plus récentes pèsent le plus ; voir `rotationWeight`).
 */
export type PlacementHistory = Map<string, Map<string, number>>;

/**
 * Poids d'une occupation passée selon son ancienneté (0 : la battue précédente
 * du chasseur). Reprendre le poste de sa battue précédente coûte beaucoup plus
 * que toute l'histoire ancienne réunie (somme des 0,5^n < 1) : on l'évite dès
 * que c'est possible, puis on équilibre sur la durée.
 */
export const rotationWeight = (age: number) => (age === 0 ? 4 : 0.5 ** age);

const INFEASIBLE = 1e7; // poste trop difficile : jamais choisi
const UNPLACED = 1e5; //   chasseur laissé sans poste : seulement si impossible autrement

/**
 * Affectation de coût minimal (algorithme hongrois) sur une matrice carrée.
 * Renvoie pour chaque ligne la colonne choisie.
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const rowToCol = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j]) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

/**
 * Placement automatique : les attributions verrouillées sont conservées ; les
 * autres chasseurs postés sont répartis sur les postes libres en faisant
 * TOURNER les postes : chacun évite ceux qu'il a occupés récemment (`history`),
 * à égalité c'est le hasard qui tranche. Avec `allowDouble`, les chasseurs en
 * trop complètent les postes (2 au plus).
 *
 * Avec `mobility` : jamais un poste plus difficile que la capacité de marche
 * du chasseur ; le plus grand nombre possible de chasseurs est placé. Ceux
 * qui marchent peu (1 ou 2) préfèrent légèrement les postes les plus faciles.
 * Renvoie les nouvelles attributions (hors verrouillées) et les non-placés.
 */
export function drawAssignments(
  postIds: string[],
  hunters: string[],
  locked: { post_id: string; participant_id: string }[],
  allowDouble: boolean,
  random?: () => number,
  mobility?: Mobility,
  history?: PlacementHistory,
  lines?: { lineOf: Map<string, string | null>; chiefs: Set<string> },
): { assignments: { post_id: string; participant_id: string }[]; unplaced: string[] } {
  const rnd = random ?? cryptoRandom;
  const lockedHunters = new Set(locked.map((l) => l.participant_id));
  const load = new Map(postIds.map((id) => [id, 0]));
  for (const l of locked) load.set(l.post_id, (load.get(l.post_id) ?? 0) + 1);
  const diff = (p: string) => mobility?.difficulty.get(p) ?? null;
  const ab = (h: string) => mobility?.ability.get(h) ?? null;

  let chiefCost = (_h: string, _p: string) => 0;
  const cost = (h: string, p: string) => {
    if (!canReach(diff(p), ab(h))) return INFEASIBLE;
    const a = ab(h);
    const ease = a !== null && a <= 2 ? 0.05 * (diff(p) ?? 6) : 0; // marche difficile : postes faciles d'abord
    return (history?.get(h)?.get(p) ?? 0) + ease + chiefCost(h, p) + 0.01 * rnd(); // hasard pour départager
  };

  /** Une passe : chaque chasseur sur au plus un des postes candidats. */
  const pass = (people: string[], candidates: string[]) => {
    const n = Math.max(people.length, candidates.length);
    if (!people.length || !candidates.length) return { placed: [] as { post_id: string; participant_id: string }[], left: people };
    const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
      i >= people.length ? 0 : j >= candidates.length ? UNPLACED : cost(people[i], candidates[j])));
    const pick = hungarian(m);
    const placed: { post_id: string; participant_id: string }[] = [];
    const left: string[] = [];
    people.forEach((h, i) => {
      const j = pick[i];
      if (j >= 0 && j < candidates.length && m[i][j] < UNPLACED) placed.push({ post_id: candidates[j], participant_id: h });
      else left.push(h);
    });
    return { placed, left };
  };

  // Chefs de ligne : un poste d'une ligne (pénalité sinon), une ligne par chef si possible
  // (pénalités bien inférieures à UNPLACED : elles ne privent jamais personne de poste).
  const chiefs = new Set([...(lines?.chiefs ?? [])].filter((h) => hunters.includes(h)));
  const led = new Map<string, Set<string>>(); // chef → lignes déjà tenues par un autre chef
  const lockedLines = new Set(locked.filter((l) => chiefs.has(l.participant_id)).map((l) => lines?.lineOf.get(l.post_id)).filter(Boolean) as string[]);
  chiefCost = (h: string, p: string) => {
    if (!chiefs.has(h)) return 0;
    const line = lines?.lineOf.get(p) ?? null;
    if (!line) return 100;
    return lockedLines.has(line) || led.get(h)?.has(line) ? 50 : 0;
  };

  const toPlace = shuffle(hunters.filter((h) => !lockedHunters.has(h)), random);
  const freePosts = shuffle(postIds.filter((id) => (load.get(id) ?? 0) === 0), random);
  let first = pass(toPlace, freePosts);
  // Deux nouveaux chefs sur la même ligne : on pénalise ce doublon et on recommence (quelques essais).
  for (let round = 0; round < 3 && chiefs.size > 1; round++) {
    const byLine = new Map<string, string[]>();
    for (const a of first.placed) {
      const line = lines?.lineOf.get(a.post_id);
      if (chiefs.has(a.participant_id) && line) byLine.set(line, [...(byLine.get(line) ?? []), a.participant_id]);
    }
    const dup = [...byLine].filter(([, hs]) => hs.length > 1);
    if (!dup.length) break;
    for (const [line, hs] of dup) for (const h of hs.slice(1)) led.set(h, new Set([...(led.get(h) ?? []), line]));
    first = pass(toPlace, freePosts);
  }
  for (const a of first.placed) load.set(a.post_id, 1);
  const second = allowDouble ? pass(first.left, shuffle(postIds.filter((id) => (load.get(id) ?? 0) === 1), random)) : { placed: [], left: first.left };
  return { assignments: [...first.placed, ...second.placed], unplaced: second.left };
}
