// Proposition des postes du jour et tirage au sort (logique pure).
import { describe, expect, it } from 'vitest';
import { drawAssignments, proposePosts } from '../src/proposal';

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
