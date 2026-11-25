// Battues d'une journée de chasse : volontaires parmi les présents, postes du
// jour, attribution (tirage au sort tenant compte de la marche), espèces,
// publication, début et fin, prélèvements, positions GPS, « Je suis en
// place », covoiturage. La convocation et la présence relèvent de la journée
// (routes/days.ts).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import type { Tx } from '../db';
import { withTx } from '../db';
import { notFoundIfNull, parseId, tenantTx, type Role } from '../context';
import { AppError } from '../errors';
import { sha256Hex } from '../auth';
import { loadHuntPlan, loadPlans } from './plans';
import { drawAssignments, proposePosts, rotationWeight, type PlacementHistory } from '../proposal';
import { planCarpool, type CarpoolPlan } from '../carpool';
import { notifyUsers } from './notifications';
import { seasonSpecies } from './seasons';

export const huntRoutes = new Hono<AppEnv>();

export const MANAGERS: Role[] = ['president', 'responsable'];
/** Rôles qui reçoivent un poste : le chef de ligne est un chasseur posté. */
export const POSTED = ['poste', 'chef_de_ligne'];

const HUNT_SELECT = `h.id, h.day_id, h.number, h.territory_id, t.name AS territory_name, h.hunt_plan_id,
  (SELECT name FROM hunt_plans WHERE id = h.hunt_plan_id) AS hunt_plan_name, to_char(h.date, 'YYYY-MM-DD') AS date,
  h.briefing, h.leader_user_id, lu.display_name AS leader_name, h.status, h.assignments_published_at,
  h.started_at, h.ended_at, h.created_at, h.revision::int AS revision,
  h.wind_from_deg, h.wind_speed_kmh, h.wind_gust_kmh`;
const HUNT_FROM = `hunts h JOIN territories t ON t.id = h.territory_id LEFT JOIN users lu ON lu.id = h.leader_user_id`;

export async function loadHunt(tx: Tx, id: string) {
  return notFoundIfNull(await tx.maybeOne<Record<string, any>>(`SELECT ${HUNT_SELECT} FROM ${HUNT_FROM} WHERE h.id = $1`, [id]), 'Battue');
}

/** Battue modifiable : en cours ; `notStarted` : avant le début de battue. */
function requireOpen(hunt: Record<string, any>, action: string, notStarted = false) {
  if (hunt.status !== 'en_cours') throw new AppError(409, 'HUNT_BAD_STATUS', `${action} impossible : la battue est terminée.`);
  if (notStarted && hunt.started_at) throw new AppError(409, 'HUNT_STARTED', `${action} impossible : la battue a commencé.`);
}

/** Plan de chasse d'une battue : forcément un plan du territoire de la battue. */
export async function setHuntPlan(tx: Tx, huntId: string, territoryId: string, huntPlanId: string | null) {
  if (huntPlanId && !(await tx.maybeOne('SELECT 1 FROM hunt_plans WHERE id = $1 AND territory_id = $2', [huntPlanId, territoryId]))) {
    throw new AppError(422, 'HUNT_PLAN_OTHER_TERRITORY', 'Ce plan de chasse n’appartient pas au territoire de la battue.');
  }
  await tx.execute('UPDATE hunts SET hunt_plan_id = $2 WHERE id = $1', [huntId, huntPlanId]);
}

/** Postes disponibles du territoire (actifs, hors zone d'habitation). */
async function availablePostIds(tx: Tx, territoryId: string) {
  const rows = await tx.query<{ id: string }>(
    'SELECT id FROM posts WHERE territory_id = $1 AND active AND invalid_reason IS NULL',
    [territoryId],
  );
  return new Set(rows.map((r) => r.id));
}

/** Vue complète d'une battue pour le président / responsable. */
export async function huntDetail(tx: Tx, id: string) {
  const hunt = await loadHunt(tx, id);
  const participants = await tx.query(
    `SELECT hp.id, hp.user_id, hp.day_participant_id, coalesce(u.display_name, hp.guest_name) AS name, hp.user_id IS NULL AS guest,
            hp.role, hp.present, hp.in_place_at, a.post_id, a.locked,
            coalesce(dp.walking_ability, u.walking_ability) AS walking_ability,
            coalesce(dp.has_car, u.has_car) AS has_car, coalesce(dp.car_seats, u.car_seats) AS car_seats
       FROM hunt_participants hp
       JOIN day_participants dp ON dp.id = hp.day_participant_id
       LEFT JOIN users u ON u.id = hp.user_id
       LEFT JOIN hunt_assignments a ON a.participant_id = hp.id
      WHERE hp.hunt_id = $1
      ORDER BY hp.user_id IS NULL, lower(coalesce(u.display_name, hp.guest_name))`,
    [id],
  );
  const dayPosts = (await tx.query<{ post_id: string }>('SELECT post_id FROM hunt_posts WHERE hunt_id = $1', [id])).map((r) => r.post_id);
  const species = await tx.query('SELECT species, quota FROM hunt_species WHERE hunt_id = $1 ORDER BY species', [id]);
  const harvests = await tx.query(
    `SELECT hh.id, hh.species, hh.category, hh.outcome, hh.notes, hh.created_at, coalesce(u.display_name, x.guest_name) AS shooter
       FROM hunt_harvests hh LEFT JOIN hunt_participants x ON x.id = hh.participant_id LEFT JOIN users u ON u.id = x.user_id
      WHERE hh.hunt_id = $1 ORDER BY hh.created_at DESC`,
    [id],
  );
  let proposal = null;
  if (hunt.status === 'en_cours') {
    const hunters = participants.filter((p: any) => p.present && POSTED.includes(p.role)).length;
    const plans = await loadPlans(tx, hunt.hunt_plan_id);
    proposal = proposePosts(hunters, plans, await availablePostIds(tx, hunt.territory_id));
  }
  // Traque du plan de chasse (affichée sur la carte de gestion).
  const huntPlan = hunt.hunt_plan_id ? await loadHuntPlan(tx, hunt.hunt_plan_id) : null;
  // Espèces de la saison de la journée : quota de saison et prélèvements déjà faits.
  const seasonId = (await tx.maybeOne<{ s: string | null }>('SELECT season_id AS s FROM hunt_days WHERE id = $1', [hunt.day_id]))?.s ?? null;
  return { hunt, participants, day_post_ids: dayPosts, proposal, species, harvests, hunt_plan: huntPlan, season_species: await seasonSpecies(tx, seasonId) };
}

// ---------------------------------------------------------------------------
// Alertes aux participants de la battue (cloche + notification push)
// ---------------------------------------------------------------------------

type HuntEvent = 'attributions' | 'debut' | 'fin';

async function notifyHunt(c: Context<AppEnv>, tx: Tx, huntId: string, event: HuntEvent) {
  const hunt = await loadHunt(tx, huntId);
  const what = `Battue n° ${hunt.number} (${hunt.territory_name})`;
  const people = await tx.query<{ user_id: string; role: string; post_number: number | null; post_name: string | null }>(
    `SELECT hp.user_id, hp.role, p.number AS post_number, p.name AS post_name
       FROM hunt_participants hp
       LEFT JOIN hunt_assignments a ON a.participant_id = hp.id
       LEFT JOIN posts p ON p.id = a.post_id
      WHERE hp.hunt_id = $1 AND hp.user_id IS NOT NULL AND hp.present`,
    [huntId],
  );
  const items = people.map((u) => {
    switch (event) {
      case 'attributions':
        return u.post_number
          ? { user_id: u.user_id, title: `Votre poste : ${u.post_number}${u.post_name ? ` · ${u.post_name}` : ''}`, body: `${what} : rejoignez votre poste (itinéraire et covoiturage dans l’application).` }
          : { user_id: u.user_id, title: 'Postes attribués', body: u.role === 'poste' ? `${what} : pas de poste pour vous, voyez le responsable.` : `${what} : vous êtes ${u.role === 'traqueur' ? 'traqueur' : 'chef de ligne'}.` };
      case 'debut':
        return { user_id: u.user_id, title: 'Début de battue', body: `${what} : la traque commence. Restez à votre poste, angles de tir respectés.` };
      case 'fin':
        return { user_id: u.user_id, title: 'Fin de battue', body: `${what} : déchargez vos armes. Le point de regroupement va vous être indiqué.` };
    }
  });
  // Le responsable désigné est prévenu même s'il ne participe pas : c'est lui qui lance et arrête.
  if (event === 'attributions' && hunt.leader_user_id && !people.some((u) => u.user_id === hunt.leader_user_id)) {
    items.push({ user_id: hunt.leader_user_id, title: 'Postes publiés', body: `${what} : vous en êtes responsable, lancez-la depuis votre vue chasseur.` });
  }
  return notifyUsers(c, tx, { huntId, dayId: hunt.day_id }, event, items);
}

// ---------------------------------------------------------------------------
// Battue : lecture, consignes, suppression (avant le début)
// ---------------------------------------------------------------------------

huntRoutes.get('/hunts/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => c.json(await huntDetail(tx, id)));
});

huntRoutes.patch('/hunts/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = z.object({ briefing: z.string().max(5000), leader_user_id: z.string().min(1).max(64), hunt_plan_id: z.uuid().nullable() })
    .partial().strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    const hunt = await loadHunt(tx, id);
    requireOpen(hunt, 'Modification');
    if (body.leader_user_id && !(await tx.maybeOne('SELECT 1 FROM memberships WHERE tenant_id = app.current_tenant_id() AND user_id = $1', [body.leader_user_id]))) {
      throw new AppError(422, 'LEADER_NOT_MEMBER', 'Le responsable de battue doit être un membre de l’association.');
    }
    await tx.execute(
      'UPDATE hunts SET briefing = coalesce($2, briefing), leader_user_id = coalesce($3, leader_user_id) WHERE id = $1',
      [id, body.briefing ?? null, body.leader_user_id ?? null],
    );
    if (body.leader_user_id && body.leader_user_id !== hunt.leader_user_id && body.leader_user_id !== c.get('user').id) {
      await notifyUsers(c, tx, { huntId: id, dayId: hunt.day_id }, 'responsable', [{
        user_id: body.leader_user_id, title: 'Responsable de battue',
        body: `Vous êtes responsable de la battue n° ${hunt.number} (${hunt.territory_name}) : vous verrez qui est en place et pourrez la lancer et l’arrêter.`,
      }]);
    }
    if (body.hunt_plan_id !== undefined) {
      if (hunt.started_at) throw new AppError(409, 'HUNT_STARTED', 'Changement de plan de chasse impossible : la battue a commencé.');
      await setHuntPlan(tx, id, hunt.territory_id, body.hunt_plan_id);
    }
    return c.json(await huntDetail(tx, id));
  });
});

/** Battue créée par erreur : supprimable tant qu'elle n'a pas commencé. */
huntRoutes.delete('/hunts/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => {
    requireOpen(await loadHunt(tx, id), 'Suppression', true);
    await tx.execute('DELETE FROM hunts WHERE id = $1', [id]);
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// Volontaires (parmi les présents de la journée) et rôles
// ---------------------------------------------------------------------------

/** Participants de la battue = exactement ces présents de la journée. */
export async function setSelection(tx: Tx, huntId: string, dayParticipantIds: string[]) {
  const hunt = await loadHunt(tx, huntId);
  await tx.execute('DELETE FROM hunt_participants WHERE hunt_id = $1 AND NOT (day_participant_id = ANY($2))', [huntId, dayParticipantIds]);
  // Rôle repris de la battue précédente de la journée ; sinon traqueur pour un
  // traqueur habituel de l'association, posté pour les autres.
  const added = await tx.query(
    `INSERT INTO hunt_participants (hunt_id, day_participant_id, user_id, guest_name, present, role)
     SELECT $1, dp.id, dp.user_id, dp.guest_name, true,
            coalesce((SELECT x.role FROM hunt_participants x JOIN hunts ph ON ph.id = x.hunt_id
                       WHERE x.day_participant_id = dp.id AND ph.day_id = $3 AND ph.id <> $1
                       ORDER BY ph.number DESC LIMIT 1),
                     CASE WHEN (SELECT m.usual_role FROM memberships m WHERE m.user_id = dp.user_id AND m.tenant_id = dp.tenant_id) = 'traqueur'
                          THEN 'traqueur'::hunt_role ELSE 'poste'::hunt_role END)
       FROM day_participants dp
      WHERE dp.day_id = $3 AND dp.present AND dp.id = ANY($2)
     ON CONFLICT (hunt_id, day_participant_id) DO NOTHING
     RETURNING id`,
    [huntId, dayParticipantIds, hunt.day_id],
  );
  const missing = await tx.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM unnest($2::uuid[]) x(id)
      WHERE NOT EXISTS (SELECT 1 FROM hunt_participants hp WHERE hp.hunt_id = $1 AND hp.day_participant_id = x.id)`,
    [huntId, dayParticipantIds],
  );
  if (missing.n) throw new AppError(422, 'NOT_PRESENT', 'Seuls les présents de la journée peuvent participer à une battue.');
  return added.length;
}

huntRoutes.put('/hunts/:id/selection', async (c) => {
  const id = parseId(c.req.param('id'));
  const { day_participant_ids } = z.object({ day_participant_ids: z.array(z.uuid()).max(500) }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    requireOpen(await loadHunt(tx, id), 'Choix des participants', true);
    await setSelection(tx, id, day_participant_ids);
    return c.json(await huntDetail(tx, id));
  });
});

huntRoutes.patch('/hunts/:id/participants/:pid', async (c) => {
  const id = parseId(c.req.param('id'));
  const pid = parseId(c.req.param('pid'));
  const { role } = z.object({ role: z.enum(['poste', 'traqueur', 'chef_de_ligne']) }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    requireOpen(await loadHunt(tx, id), 'Modification du rôle');
    const n = await tx.execute('UPDATE hunt_participants SET role = $3 WHERE id = $2 AND hunt_id = $1', [id, pid, role]);
    if (!n) throw new AppError(404, 'NOT_FOUND', 'Participant introuvable.');
    return c.json(await huntDetail(tx, id));
  });
});

// ---------------------------------------------------------------------------
// Début et fin de battue
// ---------------------------------------------------------------------------

/**
 * Début / fin de battue : président, responsable, ou responsable désigné de
 * la battue (depuis sa vue chasseur ; il reçoit alors un simple accusé).
 */
huntRoutes.post('/hunts/:id/actions/:action{debut|fin}', (c) => {
  const id = parseId(c.req.param('id'));
  const action = c.req.param('action');
  return tenantTx(c, null, async (tx, { role }) => {
    const lead = await tx.one<{ ok: boolean }>('SELECT app.can_lead_hunt($1) AS ok', [id]);
    if (!lead.ok) throw new AppError(403, 'FORBIDDEN', 'Seul le responsable de la battue (ou le président) peut la lancer ou l’arrêter.');
    const hunt = await loadHunt(tx, id);
    requireOpen(hunt, action === 'debut' ? 'Début de battue' : 'Fin de battue');
    if (action === 'debut' && !hunt.assignments_published_at) {
      throw new AppError(422, 'ASSIGNMENTS_NOT_PUBLISHED', 'Publiez les postes avant de lancer la battue.');
    }
    await tx.query('SELECT app.lead_hunt_action($1, $2)', [id, action]);
    if (action === 'fin' || !hunt.started_at) await notifyHunt(c, tx, id, action as HuntEvent);
    return c.json(MANAGERS.includes(role) ? await huntDetail(tx, id) : { ok: true });
  });
});

/** Vue du responsable désigné : la battue et la mise en place des postés. */
huntRoutes.get('/hunts/:id/lead', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    const lead = await tx.one<{ ok: boolean }>('SELECT app.can_lead_hunt($1) AS ok', [id]);
    const me = c.get('user').id;
    const hunt = lead.ok ? await tx.maybeOne<Record<string, any>>(`SELECT ${HUNT_SELECT} FROM ${HUNT_FROM} WHERE h.id = $1`, [id]) : null;
    // Le responsable désigné ; le président (et l'organisateur) peut agir à sa place.
    if (!hunt) return c.json({ lead: false });
    const readiness = await tx.query('SELECT * FROM app.hunt_readiness($1)', [id]);
    return c.json({ lead: true, as_leader: hunt.leader_user_id === me, hunt, readiness });
  });
});

// ---------------------------------------------------------------------------
// Postes du jour et attribution
// ---------------------------------------------------------------------------

huntRoutes.put('/hunts/:id/posts', async (c) => {
  const id = parseId(c.req.param('id'));
  const { post_ids } = z.object({ post_ids: z.array(z.uuid()).max(999) }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    const hunt = await loadHunt(tx, id);
    requireOpen(hunt, 'Choix des postes');
    const available = await availablePostIds(tx, hunt.territory_id);
    if (post_ids.some((p) => !available.has(p))) {
      throw new AppError(422, 'POST_UNAVAILABLE', 'Un poste choisi est désactivé, trop près d’une habitation ou hors du territoire.');
    }
    await tx.execute('DELETE FROM hunt_posts WHERE hunt_id = $1 AND NOT (post_id = ANY($2))', [id, post_ids]);
    await tx.execute(
      `INSERT INTO hunt_posts (hunt_id, territory_id, post_id)
       SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
      [id, hunt.territory_id, post_ids],
    );
    return c.json(await huntDetail(tx, id));
  });
});

/**
 * Place un chasseur sur un poste. Mode « move » (défaut) : si le poste est
 * occupé, l'occupant prend l'ancien poste du chasseur (échange), ou passe
 * « sans poste » si le chasseur n'en avait pas. Mode « double » : le chasseur
 * rejoint l'occupant (doublon, deux au plus).
 */
huntRoutes.put('/hunts/:id/assignments', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = z.object({
    participant_id: z.uuid(), post_id: z.uuid(), locked: z.boolean().default(false),
    mode: z.enum(['move', 'double']).default('move'),
  }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    const prev = await tx.maybeOne<{ post_id: string }>(
      'SELECT post_id FROM hunt_assignments WHERE hunt_id = $1 AND participant_id = $2', [id, body.participant_id]);
    if (prev?.post_id !== body.post_id) {
      if (body.mode === 'move') {
        const occupants = await tx.query<{ participant_id: string }>(
          'SELECT participant_id FROM hunt_assignments WHERE hunt_id = $1 AND post_id = $2 AND participant_id <> $3',
          [id, body.post_id, body.participant_id]);
        await tx.execute('DELETE FROM hunt_assignments WHERE hunt_id = $1 AND participant_id = $2', [id, body.participant_id]);
        for (const o of occupants) {
          if (prev) await tx.execute('UPDATE hunt_assignments SET post_id = $3, locked = false WHERE hunt_id = $1 AND participant_id = $2', [id, o.participant_id, prev.post_id]);
          else await tx.execute('DELETE FROM hunt_assignments WHERE hunt_id = $1 AND participant_id = $2', [id, o.participant_id]);
        }
      }
    }
    await tx.execute(
      `INSERT INTO hunt_assignments (hunt_id, post_id, participant_id, locked) VALUES ($1, $2, $3, $4)
       ON CONFLICT (hunt_id, participant_id) DO UPDATE SET post_id = EXCLUDED.post_id, locked = EXCLUDED.locked`,
      [id, body.post_id, body.participant_id, body.locked],
    );
    return c.json(await huntDetail(tx, id));
  });
});

/** Retire tous les chasseurs de leur poste (avant un nouveau tirage). */
huntRoutes.delete('/hunts/:id/assignments', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => {
    await tx.execute('DELETE FROM hunt_assignments WHERE hunt_id = $1', [id]);
    return c.json(await huntDetail(tx, id));
  });
});

huntRoutes.delete('/hunts/:id/assignments/:pid', (c) => {
  const id = parseId(c.req.param('id'));
  const pid = parseId(c.req.param('pid'));
  return tenantTx(c, MANAGERS, async (tx) => {
    await tx.execute('DELETE FROM hunt_assignments WHERE hunt_id = $1 AND participant_id = $2', [id, pid]);
    return c.json(await huntDetail(tx, id));
  });
});

/**
 * Placements passés des chasseurs sur ces postes (battues publiées, toutes
 * journées, sur un an) : poids décroissant avec l'ancienneté, compté en
 * battues du chasseur (0 : sa battue précédente). Un invité n'a d'historique
 * que dans la journée (il n'a pas de compte).
 */
async function placementHistory(tx: Tx, huntId: string, hunters: { id: string; who: string }[], postIds: string[]): Promise<PlacementHistory> {
  const rows = await tx.query<{ who: string; post_id: string; age: number }>(
    `WITH past AS (
       SELECT coalesce(hp.user_id, 'dp:' || hp.day_participant_id) AS who, a.post_id,
              coalesce(h.started_at, h.assignments_published_at) AS at, h.id AS hunt_id
         FROM hunt_assignments a
         JOIN hunts h ON h.id = a.hunt_id
         JOIN hunt_participants hp ON hp.id = a.participant_id
        WHERE h.id <> $1 AND h.assignments_published_at IS NOT NULL
          AND h.assignments_published_at > now() - interval '1 year')
     SELECT who, post_id, (dense_rank() OVER (PARTITION BY who ORDER BY at DESC, hunt_id) - 1)::int AS age
       FROM past WHERE who = ANY ($2::text[])`,
    [huntId, hunters.map((h) => h.who)],
  );
  const wanted = new Set(postIds);
  const byWho = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!wanted.has(r.post_id)) continue;
    const m = byWho.get(r.who) ?? new Map<string, number>();
    m.set(r.post_id, (m.get(r.post_id) ?? 0) + rotationWeight(r.age));
    byWho.set(r.who, m);
  }
  return new Map(hunters.map((h) => [h.id, byWho.get(h.who) ?? new Map()]));
}

/**
 * Tirage au sort : garde les attributions verrouillées, répartit les autres,
 * sans jamais donner un poste plus difficile que la capacité de marche.
 */
huntRoutes.post('/hunts/:id/draw', async (c) => {
  const id = parseId(c.req.param('id'));
  const { allow_double, keep_existing } = z.object({ allow_double: z.boolean().default(false), keep_existing: z.boolean().default(false) })
    .strict().parse(await c.req.json().catch(() => ({})));
  return tenantTx(c, MANAGERS, async (tx) => {
    requireOpen(await loadHunt(tx, id), 'Tirage au sort');
    const posts = await tx.query<{ post_id: string; difficulty: number | null; line_id: string | null }>(
      `SELECT hp.post_id, app.post_difficulty(p.access_difficulty, p.access_path) AS difficulty, p.line_id
         FROM hunt_posts hp JOIN posts p ON p.id = hp.post_id WHERE hp.hunt_id = $1`, [id]);
    if (!posts.length) throw new AppError(422, 'NO_DAY_POSTS', 'Choisissez d’abord les postes de la battue.');
    const hunters = await tx.query<{ id: string; ability: number | null; who: string; role: string }>(
      `SELECT hp.id, coalesce(dp.walking_ability, u.walking_ability) AS ability, hp.role,
              coalesce(hp.user_id, 'dp:' || hp.day_participant_id) AS who
         FROM hunt_participants hp JOIN day_participants dp ON dp.id = hp.day_participant_id
         LEFT JOIN users u ON u.id = hp.user_id
        WHERE hp.hunt_id = $1 AND hp.present AND hp.role IN ('poste', 'chef_de_ligne')`, [id]);
    const locked = await tx.query<{ post_id: string; participant_id: string }>(
      // keep_existing : les placements déjà faits (à la main) sont gardés ; on ne place que les autres.
      `SELECT post_id, participant_id FROM hunt_assignments WHERE hunt_id = $1 AND (locked OR $2)`, [id, keep_existing],
    );
    await tx.execute('DELETE FROM hunt_assignments WHERE hunt_id = $1 AND NOT (locked OR $2)', [id, keep_existing]);
    const { assignments, unplaced } = drawAssignments(
      posts.map((p) => p.post_id), hunters.map((h) => h.id), locked, allow_double, undefined,
      { difficulty: new Map(posts.map((p) => [p.post_id, p.difficulty])), ability: new Map(hunters.map((h) => [h.id, h.ability])) },
      await placementHistory(tx, id, hunters, posts.map((p) => p.post_id)),
      { lineOf: new Map(posts.map((p) => [p.post_id, p.line_id])), chiefs: new Set(hunters.filter((h) => h.role === 'chef_de_ligne').map((h) => h.id)) },
    );
    for (const a of assignments) {
      await tx.execute('INSERT INTO hunt_assignments (hunt_id, post_id, participant_id) VALUES ($1, $2, $3)', [id, a.post_id, a.participant_id]);
    }
    return c.json({ ...(await huntDetail(tx, id)), unplaced: unplaced.length });
  });
});

/** Publie les postes : chaque chasseur voit le sien et doit s'y rendre. */
huntRoutes.post('/hunts/:id/publish-assignments', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => {
    requireOpen(await loadHunt(tx, id), 'Publication des postes');
    await tx.execute('UPDATE hunts SET assignments_published_at = now() WHERE id = $1', [id]);
    const notified = await notifyHunt(c, tx, id, 'attributions');
    return c.json({ ...(await huntDetail(tx, id)), notified });
  });
});

// ---------------------------------------------------------------------------
// Covoiturage (du rendez-vous aux parkings)
// ---------------------------------------------------------------------------

/** Plan de covoiturage d'une battue (responsable ou participant). */
export async function carpoolFor(tx: Tx, huntId: string): Promise<CarpoolPlan & { mine: string | null }> {
  const people = await tx.query<any>('SELECT * FROM app.battue_people($1)', [huntId]);
  const { per_car } = await tx.one<{ per_car: number }>(
    'SELECT t.hunters_per_car AS per_car FROM hunts h JOIN tenants t ON t.id = h.tenant_id WHERE h.id = $1', [huntId]);
  // Un posté sans poste reste au rendez-vous : pas de trajet.
  const plan = planCarpool(
    people.filter((p) => p.post_number || p.role !== 'poste').map((p) => ({
      id: p.participant_id,
      name: p.name,
      hasCar: p.has_car,
      seats: p.car_seats,
      destination: p.parking_id ?? (p.post_number ? `poste-${p.post_number}` : p.role === 'poste' ? 'sans-poste' : 'traque'),
      destinationName: p.parking_name ? `parking ${p.parking_name}` : p.post_number ? `poste ${p.post_number}` : p.role === 'poste' ? 'rendez-vous (sans poste)' : 'départ de la traque',
      lon: p.parking_lon,
      lat: p.parking_lat,
    })),
    per_car,
  );
  return { ...plan, mine: people.find((p) => p.mine)?.participant_id ?? null };
}

huntRoutes.get('/hunts/:id/carpool', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => c.json(await carpoolFor(tx, id)));
});

// ---------------------------------------------------------------------------
// Espèces et prélèvements
// ---------------------------------------------------------------------------

const SPECIES_RE = /^[\p{L}\p{N} '’.\-()]{1,60}$/u;
const speciesSchema = z.string().trim().min(1).max(60).regex(SPECIES_RE, 'Nom d’espèce invalide.');

huntRoutes.put('/hunts/:id/species', async (c) => {
  const id = parseId(c.req.param('id'));
  const { species } = z.object({
    species: z.array(z.object({ species: speciesSchema, quota: z.number().int().min(0).max(999).nullable() }).strict()).max(30),
  }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    requireOpen(await loadHunt(tx, id), 'Modification des espèces');
    const names = species.map((x) => x.species);
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new AppError(422, 'DUPLICATE', 'Espèce en double.');
    await tx.execute('DELETE FROM hunt_species WHERE hunt_id = $1 AND NOT (species = ANY($2))', [id, names]);
    for (const x of species) {
      await tx.execute(
        `INSERT INTO hunt_species (hunt_id, species, quota) VALUES ($1, $2, $3)
         ON CONFLICT (hunt_id, species) DO UPDATE SET quota = EXCLUDED.quota`,
        [id, x.species, x.quota],
      );
    }
    return c.json(await huntDetail(tx, id));
  });
});

const harvestSchema = z.object({
  species: speciesSchema,
  category: z.enum(['male', 'femelle', 'jeune', 'indetermine']).default('indetermine'),
  outcome: z.enum(['tue', 'blesse', 'vu']).default('tue'),
  notes: z.string().trim().max(500).default(''),
  participant_id: z.uuid().nullable().optional(), // responsable : tireur au choix
}).strict();

async function viewOfHuntDay(tx: Tx, huntId: string) {
  return withOutcomes(tx, (await tx.one<{ v: any }>('SELECT app.view_day(h.day_id) AS v FROM hunts h WHERE h.id = $1', [huntId])).v);
}

/** Complète les déclarations d'une vue chasseur avec leur état (tué, blessé, vu). */
export async function withOutcomes(tx: Tx, view: any) {
  const list = view?.current?.harvests;
  if (!Array.isArray(list) || !list.length) return view;
  const rows = await tx.query<{ id: string; outcome: string }>('SELECT * FROM app.harvest_outcomes($1::uuid[])', [list.map((x: any) => x.id)]);
  const by = new Map(rows.map((r) => [r.id, r.outcome]));
  for (const x of list) x.outcome = by.get(x.id) ?? 'tue';
  return view;
}

/** Alerte « animal tué / blessé / vu » aux participants de la battue (cloche + push). */
async function notifyHarvest(c: Context<AppEnv>, tx: Tx, harvestId: string) {
  const tenantId = c.req.header('X-Tenant-Id') ?? '';
  const rows = await tx.query<{ user_id: string; title: string; body: string; endpoint: string | null; p256dh: string; auth: string }>(
    'SELECT n.*, (SELECT h.day_id FROM hunt_harvests hh JOIN hunts h ON h.id = hh.hunt_id WHERE hh.id = $1) AS day_id FROM app.notify_harvest($1) n', [harvestId]);
  for (const r of rows as any[]) {
    if (r.endpoint) c.get('pushQueue').push({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, title: r.title, body: r.body, url: `/?tenant=${encodeURIComponent(tenantId)}#/journees/${r.day_id}` });
  }
}

/** Déclarer un prélèvement : le participant pour lui-même, le responsable pour n'importe qui. */
huntRoutes.post('/hunts/:id/harvests', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = harvestSchema.parse(await c.req.json());
  return tenantTx(c, null, async (tx, { role }) => {
    let harvestId: string;
    if (MANAGERS.includes(role) && body.participant_id !== undefined) {
      const hunt = await loadHunt(tx, id);
      if (!['en_cours', 'terminee'].includes(hunt.status)) throw new AppError(409, 'HUNT_BAD_STATUS', 'Saisie impossible.');
      harvestId = (await tx.one<{ id: string }>(
        `INSERT INTO hunt_harvests (hunt_id, species, category, notes, participant_id, recorded_by, outcome)
         VALUES ($1, $2, $3, $4, $5, app.current_user_id(), $6) RETURNING id`,
        [id, body.species, body.category, body.notes, body.participant_id, body.outcome],
      )).id;
    } else {
      harvestId = (await tx.one<{ id: string }>('SELECT app.declare_harvest($1, $2, $3, $4, $5) AS id', [id, body.species, body.category, body.notes, body.outcome])).id;
    }
    await notifyHarvest(c, tx, harvestId);
    return c.json({ view: await viewOfHuntDay(tx, id) }, 201);
  });
});

huntRoutes.delete('/hunts/:id/harvests/:hid', (c) => {
  const id = parseId(c.req.param('id'));
  const hid = parseId(c.req.param('hid'));
  return tenantTx(c, null, async (tx, { role }) => {
    if (MANAGERS.includes(role)) {
      const n = await tx.execute('DELETE FROM hunt_harvests WHERE id = $1 AND hunt_id = $2', [hid, id]);
      if (!n) throw new AppError(404, 'NOT_FOUND', 'Prélèvement introuvable.');
    } else {
      await tx.query('SELECT app.withdraw_harvest($1)', [hid]);
    }
    return c.json({ view: await viewOfHuntDay(tx, id) });
  });
});

// ---------------------------------------------------------------------------
// Positions GPS en direct (accord donné pour la journée, dernière position)
// ---------------------------------------------------------------------------

/** Statut d'un participant sur la carte du responsable. */
export function positionStatus(
  p: { in_place?: boolean; shared: boolean; age_s: number | null; accuracy_m: number | null; distance_m: number | null },
  toleranceM: number,
): 'confirme' | 'non_partage' | 'sans_signal' | 'imprecise' | 'sur_poste' | 'en_route' | 'localise' {
  if (p.in_place) return 'confirme';   // « Je suis en place » : prime sur le GPS
  if (!p.shared) return 'non_partage';
  if (p.age_s === null || p.age_s > 180) return 'sans_signal';
  if ((p.accuracy_m ?? Infinity) > 2 * toleranceM) return 'imprecise';
  if (p.distance_m === null) return 'localise';
  return p.distance_m <= toleranceM ? 'sur_poste' : 'en_route';
}

const positionBody = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  accuracy: z.number().min(0).max(100_000),
  recorded_at: z.string().datetime({ offset: true }).optional(),
}).strict();

huntRoutes.post('/hunts/:id/position', async (c) => {
  const id = parseId(c.req.param('id'));
  const b = positionBody.parse(await c.req.json());
  return tenantTx(c, null, async (tx) => {
    await tx.query('SELECT app.report_position($1, $2, $3, $4, $5)', [id, b.lon, b.lat, b.accuracy, b.recorded_at ?? null]);
    return c.body(null, 204);
  });
});

// « Je suis en place » (confirmation manuelle, transmise au responsable).
/** Chef de ligne : un chasseur de sa ligne (participant_id) ou toute la ligne (sans) est en place. */
huntRoutes.put('/hunts/:id/line-in-place', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = z.object({ participant_id: z.uuid().nullable().optional(), in_place: z.boolean() }).strict().parse(await c.req.json());
  return tenantTx(c, null, async (tx) => {
    const { n } = await tx.one<{ n: number }>('SELECT app.chief_set_in_place($1, $2, $3) AS n', [id, body.participant_id ?? null, body.in_place]);
    return c.json({ updated: n });
  });
});

huntRoutes.put('/hunts/:id/in-place', async (c) => {
  const id = parseId(c.req.param('id'));
  const { in_place } = z.object({ in_place: z.boolean() }).strict().parse(await c.req.json());
  return tenantTx(c, null, async (tx) => {
    await tx.query('SELECT app.set_in_place($1, $2)', [id, in_place]);
    return c.json({ in_place });
  });
});

// Responsables : tous les présents ; chasseur : lui seul (RLS sur hunt_positions).
huntRoutes.get('/hunts/:id/positions', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    const hunt = notFoundIfNull(await tx.maybeOne<{ status: string; tolerance: number; day_id: string }>(
      `SELECT h.status, h.day_id, t.gps_tolerance_m AS tolerance FROM hunts h JOIN tenants t ON t.id = h.tenant_id WHERE h.id = $1`, [id]), 'Battue');
    const me = await tx.maybeOne<{ shared: boolean }>(
      'SELECT position_shared_at IS NOT NULL AS shared FROM day_participants WHERE day_id = $1 AND user_id = app.current_user_id()', [hunt.day_id]);
    const { manager } = await tx.one<{ manager: boolean }>(`SELECT app.has_role('president', 'responsable') AS manager`);
    const rows = await tx.query<any>(
      `SELECT hp.id AS participant_id, coalesce(u.display_name, hp.guest_name) AS name, hp.role,
              hp.user_id IS NULL AS guest, dp.position_shared_at IS NOT NULL AS shared, hp.in_place_at IS NOT NULL AS in_place,
              hp.user_id = app.current_user_id() AS mine, p.number AS post_number,
              ST_X(pos.geom::geometry) AS lon, ST_Y(pos.geom::geometry) AS lat, pos.accuracy_m,
              extract(epoch FROM now() - pos.recorded_at)::int AS age_s,
              CASE WHEN pos.geom IS NOT NULL AND p.geom IS NOT NULL THEN round(ST_Distance(pos.geom, p.geom::geography))::int END AS distance_m
         FROM hunt_participants hp
         JOIN day_participants dp ON dp.id = hp.day_participant_id
         LEFT JOIN users u ON u.id = hp.user_id
         LEFT JOIN hunt_assignments a ON a.participant_id = hp.id
         LEFT JOIN posts p ON p.id = a.post_id
         LEFT JOIN hunt_positions pos ON pos.participant_id = hp.id
        WHERE hp.hunt_id = $1 AND hp.present AND ($2 OR hp.user_id = app.current_user_id())
        ORDER BY p.number NULLS LAST, lower(coalesce(u.display_name, hp.guest_name))`,
      [id, manager],
    );
    return c.json({
      status: hunt.status,
      tolerance_m: hunt.tolerance,
      sharing: me?.shared ?? false,
      participants: rows.map((r) => ({ ...r, status: r.guest && !r.in_place ? 'invite' : positionStatus(r, hunt.tolerance) })),
    });
  });
});

// ---------------------------------------------------------------------------
// Invité (lien sans compte) : vue de la journée et « Je suis en place »
// ---------------------------------------------------------------------------

export const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const expired = () => new AppError(410, 'GUEST_LINK_EXPIRED', 'Ce lien n’est plus valable : la journée est terminée ou le lien a été remplacé.');

huntRoutes.get('/guest/:token', async (c: Context<AppEnv>) => {
  const token = c.req.param('token') ?? '';
  if (!TOKEN_RE.test(token)) throw new AppError(404, 'GUEST_LINK_UNKNOWN', 'Lien inconnu.');
  const hash = await sha256Hex(token);
  return withTx(c.get('pool'), { userId: null, tenantId: null }, async (tx) => {
    const { v } = await tx.one<{ v: any }>('SELECT app.guest_day_view($1) AS v', [hash]);
    if (!v) throw expired();
    if (v.current?.hunt?.id) v.current.line = (await tx.one<{ l: unknown }>('SELECT app.guest_line($1, $2) AS l', [hash, v.current.hunt.id])).l;
    await withOutcomes(tx, v);
    return c.json({ view: v });
  });
});

huntRoutes.put('/guest/:token/in-place', async (c: Context<AppEnv>) => {
  const token = c.req.param('token') ?? '';
  if (!TOKEN_RE.test(token)) throw new AppError(404, 'GUEST_LINK_UNKNOWN', 'Lien inconnu.');
  const { in_place } = z.object({ in_place: z.boolean() }).strict().parse(await c.req.json());
  const hash = await sha256Hex(token);
  return withTx(c.get('pool'), { userId: null, tenantId: null }, async (tx) => {
    const { ok } = await tx.one<{ ok: boolean }>('SELECT app.guest_set_in_place($1, $2) AS ok', [hash, in_place]);
    if (!ok) throw expired();
    return c.json({ in_place });
  });
});

