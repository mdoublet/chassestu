// Proposition des postes du jour et tirage au sort (logique pure).
import { describe, expect, it } from 'vitest';
import { drawAssignments, hungarian, proposePosts, rotationWeight } from '../src/proposal';

// Postes « p1 » … « p13 » ; plans de l'exemple de la spécification.
const P = (...n: number[]) => n.map((i) => `p${i}`);
const all = new Set(P(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13));
const plans = [
  { hunter_count: 5, post_ids: P(1, 3, 6, 7, 12) },
  { hunter_count: 6, post_ids: P(1, 3, 5, 8, 10, 13) },
];

describe('proposition des postes selon l’effectif', () => {
  it('6 postés présents : postes 1, 3, 5, 8, 10 et 13', () => {
    expect(proposePosts(6, plans, all)).toMatchObject({ kind: 'plan', plan_count: 6, post_ids: P(1, 3, 5, 8, 10, 13), missing: 0 });
  });
  it('7 postés et aucun plan pour 7 : le plan à 6 est proposé, un poste à ajouter', () => {
    const p = proposePosts(7, plans, all);
    expect(p).toMatchObject({ kind: 'lower_plan', plan_count: 6, post_ids: P(1, 3, 5, 8, 10, 13), missing: 1 });
    expect(p.message).toMatch(/plan à 6 proposé, ajoutez 1 poste/);
  });
  it('effectif inférieur au plus petit plan : sélection manuelle', () => {
    expect(proposePosts(3, plans, all)).toMatchObject({ kind: 'manual', post_ids: [], missing: 3 });
  });
  it('plus de chasseurs que de postes disponibles : blocage (traque ou doublon)', () => {
    const p = proposePosts(15, plans, all);
    expect(p).toMatchObject({ kind: 'too_many', extra: 2 });
    expect(p.message).toMatch(/traque ou en doublon/);
  });
  it('un poste devenu indisponible est retiré de la proposition', () => {
    const without5 = new Set([...all].filter((id) => id !== 'p5'));
    expect(proposePosts(6, plans, without5)).toMatchObject({ kind: 'plan_incomplete', post_ids: P(1, 3, 8, 10, 13), missing: 1 });
  });
  it('aucun posté : rien à proposer', () => {
    expect(proposePosts(0, plans, all).kind).toBe('none');
  });
});

describe('tirage au sort', () => {
  const posts = P(1, 3, 5, 8, 10, 13);
  const hunters = ['a', 'b', 'c', 'd', 'e', 'f'];
  it('respecte les postes verrouillés et place chacun sur un poste différent', () => {
    for (let run = 0; run < 200; run++) {
      const { assignments, unplaced } = drawAssignments(posts, hunters, [{ post_id: 'p13', participant_id: 'a' }], false);
      expect(unplaced).toEqual([]);
      expect(assignments.find((x) => x.participant_id === 'a')).toBeUndefined(); // reste verrouillé, non retiré
      expect(assignments.some((x) => x.post_id === 'p13')).toBe(false);
      expect(new Set(assignments.map((x) => x.post_id)).size).toBe(5);
    }
  });
  it('produit des tirages différents', () => {
    const seen = new Set<string>();
    for (let run = 0; run < 50; run++) seen.add(JSON.stringify(drawAssignments(posts, hunters, [], false).assignments));
    expect(seen.size).toBeGreaterThan(10);
  });
  it('chasseurs en trop : non placés, ou en doublon (2 au plus par poste) si choisi', () => {
    const many = [...hunters, 'g', 'h'];
    expect(drawAssignments(posts, many, [], false).unplaced).toHaveLength(2);
    const doubled = drawAssignments(posts, many, [], true);
    expect(doubled.unplaced).toHaveLength(0);
    const counts = new Map<string, number>();
    for (const a of doubled.assignments) counts.set(a.post_id, (counts.get(a.post_id) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBe(2);
  });
});

describe('rotation des postes', () => {
  const H = (entries: Record<string, Record<string, number>>) =>
    new Map(Object.entries(entries).map(([h, m]) => [h, new Map(Object.entries(m))]));

  it('chacun évite les postes occupés récemment', () => {
    // a était au p1, b au p2 la battue précédente : ils échangent.
    const history = H({ a: { p1: 1 }, b: { p2: 1 } });
    for (let run = 0; run < 30; run++) {
      const { assignments } = drawAssignments(['p1', 'p2'], ['a', 'b'], [], false, undefined, undefined, history);
      expect(Object.fromEntries(assignments.map((x) => [x.participant_id, x.post_id]))).toEqual({ a: 'p2', b: 'p1' });
    }
  });

  it('postes jamais occupés d’abord, puis les plus anciens ; à égalité, le hasard', () => {
    const history = H({ a: { p1: rotationWeight(0), p2: rotationWeight(3) } });
    expect(drawAssignments(['p1', 'p2', 'p3'], ['a'], [], false, undefined, undefined, history).assignments[0].post_id).toBe('p3');
    expect(drawAssignments(['p1', 'p2'], ['a'], [], false, undefined, undefined, history).assignments[0].post_id).toBe('p2');
    const seen = new Set<string>();
    for (let run = 0; run < 60; run++) seen.add(drawAssignments(['p1', 'p2', 'p3'], ['z'], [], false).assignments[0].post_id);
    expect(seen.size).toBe(3);
  });

  it('la marche prime sur la rotation ; on place le plus de chasseurs possible', () => {
    const mobility = {
      difficulty: new Map<string, number | null>([['facile', 1], ['dur', 5]]),
      ability: new Map<string, number | null>([['lent', 1], ['rapide', 5]]),
    };
    // « lent » a toujours eu le poste facile : il le garde (seul accessible), « rapide » prend le dur.
    const history = H({ lent: { facile: 3 }, rapide: { dur: 3 } });
    for (let run = 0; run < 20; run++) {
      const { assignments, unplaced } = drawAssignments(['facile', 'dur'], ['lent', 'rapide'], [], false, undefined, mobility, history);
      expect(unplaced).toEqual([]);
      expect(Object.fromEntries(assignments.map((x) => [x.participant_id, x.post_id]))).toEqual({ lent: 'facile', rapide: 'dur' });
    }
  });

  it('affectation optimale (hongrois)', () => {
    expect(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]])).toEqual([1, 0, 2]);
  });
});

describe('rotation : la battue précédente prime', () => {
  it('ne reprend pas le poste de la battue précédente, même avec un long passé ailleurs', () => {
    // marc : poste 3 à la battue précédente, mais poste 1 très souvent avant ; jean : poste 1 la dernière fois.
    const history = new Map([
      ['marc', new Map([['p3', rotationWeight(0)], ['p1', rotationWeight(1) + rotationWeight(2) + rotationWeight(3) + rotationWeight(4)]])],
      ['jean', new Map([['p1', rotationWeight(0)], ['p3', rotationWeight(1)]])],
    ]);
    for (let run = 0; run < 20; run++) {
      const a = drawAssignments(['p1', 'p3'], ['marc', 'jean'], [], false, undefined, undefined, history).assignments;
      expect(Object.fromEntries(a.map((x) => [x.participant_id, x.post_id]))).toEqual({ marc: 'p1', jean: 'p3' });
    }
  });
});

describe('chefs de ligne', () => {
  it('chaque chef sur un poste d’une ligne différente ; les autres complètent', () => {
    const lineOf = new Map<string, string | null>([['a1', 'A'], ['a2', 'A'], ['b1', 'B'], ['x', null]]);
    for (let run = 0; run < 30; run++) {
      const { assignments, unplaced } = drawAssignments(['a1', 'a2', 'b1', 'x'], ['c1', 'c2', 'h1', 'h2'], [], false, undefined, undefined, undefined,
        { lineOf, chiefs: new Set(['c1', 'c2']) });
      expect(unplaced).toEqual([]);
      const at = Object.fromEntries(assignments.map((x) => [x.participant_id, x.post_id]));
      expect(new Set([lineOf.get(at.c1), lineOf.get(at.c2)])).toEqual(new Set(['A', 'B']));
    }
  });
});

describe('chefs de ligne et marche', () => {
  it('le chef ne prend jamais le seul poste accessible à un chasseur qui marche peu', () => {
    const lineOf = new Map<string, string | null>([['facile', 'A'], ['dur', 'A'], ['hors', null]]);
    const mobility = {
      difficulty: new Map<string, number | null>([['facile', 1], ['dur', 4], ['hors', 3]]),
      ability: new Map<string, number | null>([['chef', 5], ['lent', 2], ['marc', 4]]),
    };
    for (let run = 0; run < 30; run++) {
      const { assignments, unplaced } = drawAssignments(['facile', 'dur', 'hors'], ['chef', 'lent', 'marc'], [], false, undefined, mobility, undefined,
        { lineOf, chiefs: new Set(['chef']) });
      expect(unplaced).toEqual([]);
      const at = Object.fromEntries(assignments.map((x) => [x.participant_id, x.post_id]));
      expect(at.lent).toBe('facile');
      expect(at.chef).toBe('dur'); // sur sa ligne, sans priver « lent »
    }
  });
});
