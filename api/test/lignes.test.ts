// Lignes de postes et chefs de ligne.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, app, createTenant, east, env, newBattue, point, runningDay, square } from './helpers';

const P = 'pres_lignes';
let tenant: string;
const as = (user: string, method: string, path: string, body?: unknown) => api(user, method, path, { tenant, body });
const HUNTERS = ['lg1', 'lg2', 'lg3', 'lg4'];
let territoryId: string;
const posts: string[] = [];

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des lignes');
  const inv = await as(P, 'POST', '/api/invitations', {});
  const token = inv.body.invitation.url.split('/').pop();
  for (const u of HUNTERS) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
  territoryId = (await as(P, 'POST', '/api/territories', { name: 'Bois des lignes', geom: square(4.3, 44.3, 0.01) })).body.territory.id;
  for (let n = 1; n <= 5; n++) posts.push((await as(P, 'POST', `/api/territories/${territoryId}/posts`, { number: n, name: `P${n}`, geom: point(east(4.292, 44.3, n * 150), 44.3) })).body.item.id);
});

describe('lignes de postes', () => {
  it('création, nom unique, rattachement des postes, suppression (postes gardés)', async () => {
    const a = await as(P, 'POST', `/api/territories/${territoryId}/lines`, { name: 'Ligne du haut' });
    expect(a.status).toBe(201);
    expect((await as(P, 'POST', `/api/territories/${territoryId}/lines`, { name: 'Ligne du haut' })).status).toBe(409);
    const tmp = (await as(P, 'POST', `/api/territories/${territoryId}/lines`, { name: 'Temporaire' })).body.line;
    expect((await as(P, 'PATCH', `/api/lines/${tmp.id}`, { name: 'Ligne du bas' })).body.line.name).toBe('Ligne du bas');
    expect((await as('lg1', 'POST', `/api/territories/${territoryId}/lines`, { name: 'x' })).status).toBe(403);
    expect((await as(P, 'PATCH', `/api/posts/${posts[0]}`, { line_id: a.body.line.id })).body.item.line_id).toBe(a.body.line.id);
    await as(P, 'PATCH', `/api/posts/${posts[4]}`, { line_id: tmp.id });
    const t = (await as(P, 'GET', `/api/territories/${territoryId}`)).body;
    expect(t.lines.map((l: any) => l.name)).toEqual(['Ligne du bas', 'Ligne du haut']);
    expect((await as(P, 'DELETE', `/api/lines/${tmp.id}`)).status).toBe(204);
    const after = (await as(P, 'GET', `/api/territories/${territoryId}`)).body.posts.find((p: any) => p.id === posts[4]);
    expect(after.line_id).toBeNull();
    // Postes 1 à 3 dans la ligne du haut, 4 et 5 hors ligne.
    for (const id of posts.slice(1, 3)) await as(P, 'PATCH', `/api/posts/${id}`, { line_id: a.body.line.id });
  });

  it('le chef de ligne est placé comme un chasseur ; il voit sa ligne, les postés voient leur chef', async () => {
    const { dayId } = await runningDay(as, P, HUNTERS);
    const guest = (await as(P, 'POST', `/api/days/${dayId}/guests`, { name: 'Invité Léon' })).body.guest_link;
    const day = (await as(P, 'GET', `/api/days/${dayId}`)).body;
    const ids = day.participants.filter((p: any) => p.user_id !== `dev_${P}`).map((p: any) => p.id);
    const { huntId, detail } = await newBattue(as, P, dayId, territoryId, ids);
    const by = (u: string) => detail.participants.find((p: any) => p.user_id === `dev_${u}` || p.name === u);
    expect((await as(P, 'PATCH', `/api/hunts/${huntId}/participants/${by('lg1').id}`, { role: 'chef_de_ligne' })).status).toBe(200);
    await as(P, 'PUT', `/api/hunts/${huntId}/posts`, { post_ids: posts });
    const drawn = (await as(P, 'POST', `/api/hunts/${huntId}/draw`, {})).body;
    expect(drawn.unplaced).toBe(0);
    expect(drawn.participants.find((p: any) => p.user_id === 'dev_lg1').post_id).toBeTruthy(); // chef placé
    // Placement voulu : chef au poste 1, lg2 au 2, invité au 3 (ligne du haut) ; lg3 au 4, lg4 au 5 (hors ligne).
    await as(P, 'DELETE', `/api/hunts/${huntId}/assignments`);
    const place = async (pid: string, post: string) => expect((await as(P, 'PUT', `/api/hunts/${huntId}/assignments`, { participant_id: pid, post_id: post })).status).toBe(200);
    await place(by('lg1').id, posts[0]); await place(by('lg2').id, posts[1]); await place(by('Invité Léon').id, posts[2]);
    await place(by('lg3').id, posts[3]); await place(by('lg4').id, posts[4]);
    // Avant publication : rien.
    expect((await as('lg2', 'GET', `/api/days/${dayId}/view`)).body.view.current.line).toBeNull();
    await as(P, 'POST', `/api/hunts/${huntId}/publish-assignments`);

    const lg2 = (await as('lg2', 'GET', `/api/days/${dayId}/view`)).body.view.current.line;
    expect(lg2).toMatchObject({ name: 'Ligne du haut', chief: false, chiefs: [{ name: expect.any(String), post_number: 1, me: false }] });
    expect(lg2.members).toBeNull();
    const chef = (await as('lg1', 'GET', `/api/days/${dayId}/view`)).body.view.current.line;
    expect(chef).toMatchObject({ name: 'Ligne du haut', chief: true });
    expect(chef.members.map((m: any) => [m.post_number, m.chief, m.me])).toEqual([[1, true, true], [2, false, false], [3, false, false]]);
    expect(chef.members[2]).toMatchObject({ name: 'Invité Léon', post_name: 'P3', in_place_at: null });
    // Hors ligne : pas de ligne.
    expect((await as('lg3', 'GET', `/api/days/${dayId}/view`)).body.view.current.line).toBeNull();
    // Invité : son chef de ligne.
    const g = (await (await app.request(`/api/guest/${guest.url.split('/').pop()}`, {}, env)).json()) as any;
    expect(g.view.current.line).toMatchObject({ name: 'Ligne du haut', chiefs: [{ post_number: 1 }] });

    // Le chef de ligne confirme sa ligne ; chacun peut toujours se confirmer lui-même.
    expect((await as('lg2', 'PUT', `/api/hunts/${huntId}/line-in-place`, { in_place: true })).status).toBe(403); // pas chef
    expect((await as('lg1', 'PUT', `/api/hunts/${huntId}/line-in-place`, { participant_id: by('lg3').id, in_place: true })).status).toBe(403); // hors de sa ligne
    expect((await as('lg2', 'PUT', `/api/hunts/${huntId}/in-place`, { in_place: true })).status).toBe(200); // lg2 se déclare lui-même
    expect((await as('lg1', 'PUT', `/api/hunts/${huntId}/line-in-place`, { in_place: true })).body.updated).toBe(2); // chef + invité
    const after = (await as('lg1', 'GET', `/api/days/${dayId}/view`)).body.view.current.line.members;
    expect(after.map((m: any) => [m.post_number, !!m.in_place_at, m.by_chief])).toEqual([[1, true, false], [2, true, false], [3, true, true]]);
    expect((await as('lg3', 'GET', `/api/days/${dayId}/view`)).body.view.current.me.in_place).toBe(false); // hors ligne : intact
    // Annuler pour un chasseur précis.
    expect((await as('lg1', 'PUT', `/api/hunts/${huntId}/line-in-place`, { participant_id: by('Invité Léon').id, in_place: false })).body.updated).toBe(1);
    expect((await as('lg1', 'GET', `/api/days/${dayId}/view`)).body.view.current.line.members[2].in_place_at).toBeNull();
  });
});
