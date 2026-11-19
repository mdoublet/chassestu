// Intégration avec le vrai service WFS de l'IGN (réseau requis) : IGN=1 npm test -w api
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createTenant, env, point, pool } from './helpers';

const realApp = createApp(() => ({ pool }));

describe.skipIf(!process.env.IGN)('BD TOPO réelle (data.geopf.fr)', () => {
  it('importe les bâtiments autour d’un territoire près de Carcassonne', async () => {
    const tenant = await createTenant('pres_ign');
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await realApp.request(path, {
        method,
        headers: { Authorization: 'Bearer dev:pres_ign', 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }, env);
      return { status: res.status, body: (await res.json()) as any };
    };
    const geom = { type: 'Polygon', coordinates: [[[2.34, 43.19], [2.36, 43.19], [2.362, 43.205], [2.35, 43.212], [2.338, 43.205], [2.34, 43.19]]] };
    const created = await call('POST', '/api/territories', { name: 'Carcassonne sud', geom });
    expect(created.status).toBe(201);
    const imported = await call('POST', `/api/territories/${created.body.territory.id}/dwellings/refresh`);
    console.log('import :', imported.status, imported.body.report);
    expect(imported.status).toBe(200);
    expect(imported.body.report.total).toBeGreaterThan(50);

    const detail = await call('GET', `/api/territories/${created.body.territory.id}`);
    const pct = (100 * detail.body.exclusion.area_ha) / detail.body.territory.area_ha;
    console.log(`zone non chassable : ${detail.body.exclusion.area_ha} ha sur ${detail.body.territory.area_ha} ha (${pct.toFixed(0)} %),`,
      `${detail.body.dwellings.filter((d: any) => d.likely_non_residential).length} bâtiments pré-signalés`);
    expect(detail.body.exclusion.area_ha).toBeGreaterThan(0);

    // Un poste au milieu des maisons est refusé.
    const post = await call('POST', `/api/territories/${created.body.territory.id}/posts`, { geom: point(2.35, 43.2) });
    console.log('poste en ville :', post.status, post.body.message);
    expect(post.status).toBe(422);
  }, 120_000);
});
