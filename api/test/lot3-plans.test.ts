// Lot 3 — plans de couverture (critères d'acceptation de la spécification).
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createTenant, east, point, square } from './helpers';

const P = 'pres_plans';
let tenant: string;
const call = (method: string, path: string, body?: unknown) => api(P, method, path, { tenant, body });
const LAT = 44.2;

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des plans');
});

/** Territoire avec 13 postes numérotés 1 à 13, espacés de 100 m (pas d'habitation). */
async function territoryWith13Posts(lon: number) {
  const t = (await call('POST', '/api/territories', { name: `Plans ${lon}`, geom: square(lon, LAT, 0.01) })).body.territory;
  const ids: Record<number, string> = {};
  for (let n = 1; n <= 13; n++) {
    const res = await call('POST', `/api/territories/${t.id}/posts`, { number: n, geom: point(east(lon - 0.008, LAT, n * 100), LAT) });
    expect(res.status).toBe(201);
    ids[n] = res.body.item.id;
  }
  return { t, ids, byNumbers: (nums: number[]) => nums.map((n) => ids[n]) };
}

describe('plans de couverture', () => {
  it('les plans de l’exemple (5 et 6 chasseurs) s’enregistrent et se relisent', async () => {
    const { t, byNumbers } = await territoryWith13Posts(4.1);
    const five = await call('PUT', `/api/territories/${t.id}/coverage-plans/5`, { post_ids: byNumbers([1, 3, 6, 7, 12]) });
    expect(five.status).toBe(200);
    expect(five.body.plan).toMatchObject({ hunter_count: 5, numbers: [1, 3, 6, 7, 12], valid: true });
    const six = await call('PUT', `/api/territories/${t.id}/coverage-plans/6`, { post_ids: byNumbers([1, 3, 5, 8, 10, 13]) });
    expect(six.body.plan.numbers).toEqual([1, 3, 5, 8, 10, 13]);

    const list = await call('GET', `/api/territories/${t.id}/coverage-plans`);
    expect(list.body.plans.map((p: any) => [p.hunter_count, p.numbers])).toEqual([
      [5, [1, 3, 6, 7, 12]],
      [6, [1, 3, 5, 8, 10, 13]],
    ]);

    // Remplacer un plan : nouvelle liste, trace dans l'audit.
    const again = await call('PUT', `/api/territories/${t.id}/coverage-plans/5`, { post_ids: byNumbers([2, 3, 6, 7, 12]) });
    expect(again.body.plan.numbers).toEqual([2, 3, 6, 7, 12]);
    const audit = await call('GET', '/api/audit?limit=3');
    expect(audit.body.entries[0]).toMatchObject({
      entity: 'coverage_plans',
      action: 'update',
      diff: { hunter_count: 5, posts: { old: [1, 3, 6, 7, 12], new: [2, 3, 6, 7, 12] } },
    });

    // Le détail du territoire indique les plans qui utilisent chaque poste (avertissement de renumérotation).
    const detail = await call('GET', `/api/territories/${t.id}`);
    const post3 = detail.body.posts.find((p: any) => p.number === 3);
    expect(post3.plan_counts).toEqual([5, 6]);
  });

  it('une ligne dont le nombre de postes diffère de l’effectif ne peut pas être enregistrée', async () => {
    const { t, byNumbers } = await territoryWith13Posts(4.2);
    const res = await call('PUT', `/api/territories/${t.id}/coverage-plans/5`, { post_ids: byNumbers([1, 3, 6, 7]) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PLAN_COUNT_MISMATCH');
    expect(res.body.message).toMatch(/4 poste\(s\) coché\(s\) pour 5 chasseur\(s\)/);
    expect((await call('GET', `/api/territories/${t.id}/coverage-plans`)).body.plans).toEqual([]);
    // Doublons comptés une seule fois.
    const dup = await call('PUT', `/api/territories/${t.id}/coverage-plans/2`, { post_ids: byNumbers([1, 1]) });
    expect(dup.body.code).toBe('PLAN_COUNT_MISMATCH');
  });

  it('un poste invalidé, désactivé ou supprimé signale en rouge les plans qui l’utilisent', async () => {
    const lon = 4.3;
    const { t, ids, byNumbers } = await territoryWith13Posts(lon);
    await call('PUT', `/api/territories/${t.id}/coverage-plans/5`, { post_ids: byNumbers([1, 3, 6, 7, 12]) });
    await call('PUT', `/api/territories/${t.id}/coverage-plans/6`, { post_ids: byNumbers([1, 3, 5, 8, 10, 13]) });
    await call('PUT', `/api/territories/${t.id}/coverage-plans/2`, { post_ids: byNumbers([9, 11]) });

    // Habitation ajoutée à 50 m du poste 3 : poste invalide → plans 5 et 6 invalides.
    const house = await call('POST', `/api/territories/${t.id}/dwellings`, { geom: point(east(lon - 0.008, LAT, 300), LAT + 0.00045), comment: 'Maison neuve' });
    expect(house.status).toBe(201);
    let plans = (await call('GET', `/api/territories/${t.id}/coverage-plans`)).body.plans;
    const byCount = (n: number) => plans.find((p: any) => p.hunter_count === n);
    expect(byCount(5)).toMatchObject({ valid: false, invalid_numbers: [3] });
    expect(byCount(6).valid).toBe(false);
    expect(byCount(5).issues[0]).toMatch(/poste\(s\) 3 trop près d’une habitation/);
    expect(byCount(2).valid).toBe(true);

    // Désactivé, puis supprimé.
    await call('PATCH', `/api/posts/${ids[9]}`, { active: false });
    plans = (await call('GET', `/api/territories/${t.id}/coverage-plans`)).body.plans;
    expect(byCount(2)).toMatchObject({ valid: false, inactive_numbers: [9] });
    await call('DELETE', `/api/posts/${ids[11]}`);
    plans = (await call('GET', `/api/territories/${t.id}/coverage-plans`)).body.plans;
    expect(byCount(2).numbers).toEqual([9]);
    expect(byCount(2).issues.join(' ')).toMatch(/1 poste\(s\) pour 2 chasseur\(s\)/);

    // On ne peut pas enregistrer un plan avec un poste invalide ou inactif.
    const res = await call('PUT', `/api/territories/${t.id}/coverage-plans/2`, { post_ids: byNumbers([3, 4]) });
    expect(res.body.code).toBe('PLAN_POST_UNAVAILABLE');
    expect(res.body.message).toMatch(/3/);
  });

  it('refuse un poste d’un autre territoire ; seul le président modifie, tous les membres lisent', async () => {
    const a = await territoryWith13Posts(4.4);
    const b = await territoryWith13Posts(4.6);
    const res = await call('PUT', `/api/territories/${a.t.id}/coverage-plans/2`, { post_ids: [a.ids[1], b.ids[1]] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PLAN_POST_OTHER_TERRITORY');

    await call('PUT', `/api/territories/${a.t.id}/coverage-plans/2`, { post_ids: [a.ids[1], a.ids[2]] });
    const inv = await call('POST', '/api/invitations', { role: 'responsable' });
    await api('resp_plans', 'POST', `/api/invitation-links/${inv.body.invitation.url.split('/').pop()}/accept`);
    const read = await api('resp_plans', 'GET', `/api/territories/${a.t.id}/coverage-plans`, { tenant });
    expect(read.status).toBe(200);
    expect(read.body.plans).toHaveLength(1);
    const write = await api('resp_plans', 'PUT', `/api/territories/${a.t.id}/coverage-plans/2`, { tenant, body: { post_ids: [a.ids[3], a.ids[4]] } });
    expect(write.status).toBe(403);

    expect((await call('DELETE', `/api/territories/${a.t.id}/coverage-plans/2`)).status).toBe(204);
    expect((await call('DELETE', `/api/territories/${a.t.id}/coverage-plans/2`)).status).toBe(404);
  });
});
