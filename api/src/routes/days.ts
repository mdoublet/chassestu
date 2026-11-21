// Journées de chasse : convocation (date, heure et lieu du rendez-vous,
// déjeuner), réponses, présents du jour J et invités, battues successives,
// regroupement entre deux battues, vue chasseur de la journée.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from '../env';
import type { Tx } from '../db';
import { notFoundIfNull, parseId, tenantTx } from '../context';
import { AppError } from '../errors';
import { randomToken, sha256Hex } from '../auth';
import { geomOut, geomParam, pointSchema } from '../geo';
import { notifyUsers } from './notifications';
import { MANAGERS, carpoolFor, setHuntPlan, setSelection } from './hunts';
import { defaultHuntPlanId } from './plans';

export const dayRoutes = new Hono<AppEnv>();

const DAY_SELECT = `d.id, to_char(d.date, 'YYYY-MM-DD') AS date, to_char(d.meeting_time, 'HH24:MI') AS meeting_time,
  d.meeting_place, ${geomOut('d.meeting_point', 'meeting_point')}, d.briefing, d.lunch_offered, d.lunch_info,
  d.leader_user_id, lu.display_name AS leader_name, d.status, d.started_at, d.ended_at,
  d.regroup_place, ${geomOut('d.regroup_point', 'regroup_point')}, to_char(d.regroup_time, 'HH24:MI') AS regroup_time,
  d.regroup_at, d.revision::int AS revision, d.created_at`;
const DAY_FROM = `hunt_days d LEFT JOIN users lu ON lu.id = d.leader_user_id`;

const STATUS_LABEL: Record<string, string> = {
  brouillon: 'en brouillon', convoquee: 'convoquée', en_cours: 'en cours', terminee: 'terminée', annulee: 'annulée',
};

async function loadDay(tx: Tx, id: string) {
  return notFoundIfNull(await tx.maybeOne<Record<string, any>>(`SELECT ${DAY_SELECT} FROM ${DAY_FROM} WHERE d.id = $1`, [id]), 'Journée');
}

function requireStatus(day: Record<string, any>, allowed: string[], action: string) {
  if (!allowed.includes(day.status)) {
    throw new AppError(409, 'DAY_BAD_STATUS', `${action} impossible : la journée est « ${STATUS_LABEL[day.status] ?? day.status} ».`);
  }
}

export function guestUrl(env: Env, token: string): string {
  const origin = (env.APP_ORIGIN ?? '').split(',')[0].trim().replace(/\/$/, '');
  return `${origin}/#/journee-invite/${token}`;
}

/** Vue complète d'une journée pour le président / responsable. */
async function dayDetail(tx: Tx, id: string) {
  const day = await loadDay(tx, id);
  const participants = await tx.query(
    `SELECT dp.id, dp.user_id, coalesce(u.display_name, dp.guest_name) AS name, dp.user_id IS NULL AS guest,
            dp.response, dp.lunch, dp.present, dp.guest_token_hash IS NOT NULL AS has_guest_link,
            dp.walking_ability AS walking_ability_today, dp.has_car AS has_car_today, dp.car_seats AS car_seats_today,
            coalesce(dp.walking_ability, u.walking_ability) AS walking_ability,
            coalesce(dp.has_car, u.has_car) AS has_car, coalesce(dp.car_seats, u.car_seats) AS car_seats
       FROM day_participants dp LEFT JOIN users u ON u.id = dp.user_id
      WHERE dp.day_id = $1
      ORDER BY dp.user_id IS NULL, lower(coalesce(u.display_name, dp.guest_name))`,
    [id],
  );
  const battues = await tx.query(
    `SELECT h.id, h.number, h.territory_id, t.name AS territory_name, h.hunt_plan_id,
            (SELECT name FROM hunt_plans WHERE id = h.hunt_plan_id) AS hunt_plan_name, h.status, h.started_at, h.ended_at,
            h.assignments_published_at,
            (SELECT count(*)::int FROM hunt_participants x WHERE x.hunt_id = h.id) AS participant_count
       FROM hunts h JOIN territories t ON t.id = h.territory_id
      WHERE h.day_id = $1 ORDER BY h.number`,
    [id],
  );
  return { day, participants, battues };
}

// ---------------------------------------------------------------------------
// Alertes de la journée
// ---------------------------------------------------------------------------

function frenchDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
const frenchTime = (hhmm: string) => {
  const [h, m] = hhmm.split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
};

async function notifyDay(c: Context<AppEnv>, tx: Tx, dayId: string, kind: 'convocation' | 'annulation' | 'regroupement') {
  const day = await loadDay(tx, dayId);
  const users = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM day_participants WHERE day_id = $1 AND user_id IS NOT NULL AND ($2 OR present)`,
    [dayId, kind !== 'regroupement'],
  );
  const rdv = `RDV ${frenchTime(day.meeting_time)}${day.meeting_place ? `, ${day.meeting_place}` : ''}`;
  const item = (user_id: string) => {
    switch (kind) {
      case 'convocation':
        return { user_id, title: `Journée de chasse le ${frenchDate(day.date)}`, body: `${rdv}. Répondez présent ou absent${day.lunch_offered ? ' et dites si vous restez déjeuner' : ''}.` };
      case 'annulation':
        return { user_id, title: 'Journée annulée', body: `La journée de chasse du ${frenchDate(day.date)} est annulée.` };
      case 'regroupement':
        return { user_id, title: 'Regroupement', body: `Rendez-vous ${day.regroup_place || 'au point indiqué sur la carte'} ${day.regroup_time ? `à ${frenchTime(day.regroup_time)}` : 'dès maintenant'}. Itinéraire dans l’application.` };
    }
  };
  return notifyUsers(c, tx, { dayId }, kind, users.map((u) => item(u.user_id)));
}

// ---------------------------------------------------------------------------
// Liste, création, modification
// ---------------------------------------------------------------------------

dayRoutes.get('/days', (c) =>
  tenantTx(c, null, async (tx) => {
    const days = await tx.query(
      `SELECT ${DAY_SELECT},
              (SELECT count(*)::int FROM day_participants x WHERE x.day_id = d.id AND x.user_id IS NOT NULL) AS convoked,
              (SELECT count(*)::int FROM day_participants x WHERE x.day_id = d.id AND x.response = 'present') AS answered_present,
              (SELECT count(*)::int FROM day_participants x WHERE x.day_id = d.id AND x.present) AS present_count,
              (SELECT count(*)::int FROM day_participants x WHERE x.day_id = d.id AND x.lunch) AS lunch_count,
              (SELECT x.response FROM day_participants x WHERE x.day_id = d.id AND x.user_id = $1) AS my_response,
              (SELECT x.lunch FROM day_participants x WHERE x.day_id = d.id AND x.user_id = $1) AS my_lunch,
              EXISTS (SELECT 1 FROM day_participants x WHERE x.day_id = d.id AND x.user_id = $1) AS convoked_me,
              (SELECT jsonb_build_object('number', h.number, 'status', h.status, 'started_at', h.started_at,
                                         'territory_name', t.name, 'published', h.assignments_published_at IS NOT NULL)
                 FROM hunts h JOIN territories t ON t.id = h.territory_id
                WHERE h.day_id = d.id ORDER BY h.number DESC LIMIT 1) AS current_battue,
              (SELECT count(*)::int FROM hunts h WHERE h.day_id = d.id) AS battue_count,
              d.season_id, d.season_id IS NOT DISTINCT FROM app.current_season() AS in_season
         FROM ${DAY_FROM}
        ORDER BY d.date DESC, d.meeting_time DESC`,
      [c.get('user').id],
    );
    return c.json({ days });
  }),
);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide (AAAA-MM-JJ).');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure invalide (HH:MM).');
const dayFields = z.object({
  date: dateSchema,
  meeting_time: timeSchema,
  meeting_place: z.string().trim().max(200),
  meeting_point: pointSchema.nullable(),
  briefing: z.string().max(5000),
  lunch_offered: z.boolean(),
  lunch_info: z.string().trim().max(300),
  participant_user_ids: z.array(z.string().min(1).max(64)).max(500),
});

/** Valeurs de la dernière journée : heure, lieu et déjeuner changent rarement. */
async function lastDefaults(tx: Tx) {
  return (await tx.maybeOne(
    `SELECT to_char(meeting_time, 'HH24:MI') AS meeting_time, meeting_place, ${geomOut('meeting_point')},
            lunch_offered, lunch_info
       FROM hunt_days ORDER BY created_at DESC LIMIT 1`,
  )) ?? { meeting_time: '08:00', meeting_place: '', meeting_point: null, lunch_offered: false, lunch_info: '' };
}

dayRoutes.get('/days/defaults', (c) => tenantTx(c, MANAGERS, async (tx) => c.json(await lastDefaults(tx))));

dayRoutes.post('/days', async (c) => {
  const body = dayFields.partial().required({ date: true }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx, { tenantId }) => {
    const last = await lastDefaults(tx);
    const point = body.meeting_point === undefined ? last.meeting_point : body.meeting_point;
    const { id } = await tx.one<{ id: string }>(
      `INSERT INTO hunt_days (date, meeting_time, meeting_place, meeting_point, briefing, lunch_offered, lunch_info, leader_user_id)
       VALUES ($1, $2::time, $3, CASE WHEN $4::text IS NULL THEN NULL ELSE ${geomParam(4)} END, $5, $6, $7, app.current_user_id())
       RETURNING id`,
      [body.date, body.meeting_time ?? last.meeting_time, body.meeting_place ?? last.meeting_place,
       point ? JSON.stringify(point) : null, body.briefing ?? '', body.lunch_offered ?? last.lunch_offered, body.lunch_info ?? last.lunch_info],
    );
    if (body.participant_user_ids?.length) await setConvocations(tx, id, tenantId, body.participant_user_ids);
    return c.json(await dayDetail(tx, id), 201);
  });
});

dayRoutes.get('/days/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => c.json(await dayDetail(tx, id)));
});

dayRoutes.patch('/days/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = dayFields.omit({ participant_user_ids: true })
    .extend({ leader_user_id: z.string().min(1).max(64) })
    .partial().strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadDay(tx, id), ['brouillon', 'convoquee', 'en_cours'], 'Modification');
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(body)) {
      params.push(k === 'meeting_point' && v ? JSON.stringify(v) : v);
      sets.push(k === 'meeting_point' && v ? `${k} = ${geomParam(params.length)}` : `${k} = $${params.length}`);
    }
    if (!sets.length) throw new AppError(400, 'VALIDATION', 'Aucune modification.');
    await tx.execute(`UPDATE hunt_days SET ${sets.join(', ')} WHERE id = $1`, params);
    return c.json(await dayDetail(tx, id));
  });
});

dayRoutes.delete('/days/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadDay(tx, id), ['brouillon', 'annulee'], 'Suppression');
    await tx.execute('DELETE FROM hunt_days WHERE id = $1', [id]);
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// Convocations, réponses, présents, invités
// ---------------------------------------------------------------------------

/** Convoque exactement ces membres (les invités ne sont pas touchés). */
async function setConvocations(tx: Tx, dayId: string, tenantId: string, userIds: string[]) {
  await tx.execute('DELETE FROM day_participants WHERE day_id = $1 AND user_id IS NOT NULL AND NOT (user_id = ANY($2))', [dayId, userIds]);
  await tx.execute(
    `INSERT INTO day_participants (day_id, user_id)
     SELECT $1, m.user_id FROM memberships m WHERE m.tenant_id = $2 AND m.user_id = ANY($3)
     ON CONFLICT (day_id, user_id) DO NOTHING`,
    [dayId, tenantId, userIds],
  );
}

dayRoutes.put('/days/:id/convocations', async (c) => {
  const id = parseId(c.req.param('id'));
  const { user_ids } = z.object({ user_ids: z.array(z.string().min(1).max(64)).max(500) }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx, { tenantId }) => {
    requireStatus(await loadDay(tx, id), ['brouillon', 'convoquee', 'en_cours'], 'Convocation');
    await setConvocations(tx, id, tenantId, user_ids);
    return c.json(await dayDetail(tx, id));
  });
});

dayRoutes.post('/days/:id/respond', async (c) => {
  const id = parseId(c.req.param('id'));
  const { response, lunch } = z.object({ response: z.enum(['present', 'absent']), lunch: z.boolean().default(false) }).strict().parse(await c.req.json());
  return tenantTx(c, null, async (tx) => {
    await tx.query('SELECT app.respond_day($1, $2, $3)', [id, response, lunch]);
    return c.json({ view: (await tx.one('SELECT app.view_day($1) AS v', [id])).v });
  });
});

const overrides = {
  walking_ability: z.number().int().min(1).max(5).nullable(),
  has_car: z.boolean().nullable(),
  car_seats: z.number().int().min(0).max(8).nullable(),
};

async function newGuestLink(tx: Tx, dpId: string, env: Env) {
  const token = randomToken();
  await tx.execute('UPDATE day_participants SET guest_token_hash = $2 WHERE id = $1 AND user_id IS NULL', [dpId, await sha256Hex(token)]);
  return guestUrl(env, token);
}

/**
 * Invité du jour : présent d'office. Son lien personnel n'est renvoyé qu'une
 * fois ; `link: false` : pas de lien à la création (envoyé plus tard).
 */
dayRoutes.post('/days/:id/guests', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = z.object({
    name: z.string().trim().min(1).max(120),
    walking_ability: overrides.walking_ability.optional(),
    has_car: overrides.has_car.optional(),
    car_seats: overrides.car_seats.optional(),
    link: z.boolean().optional(),
  }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadDay(tx, id), ['convoquee', 'en_cours'], 'Ajout d’un invité');
    const { id: dpId } = await tx.one<{ id: string }>(
      `INSERT INTO day_participants (day_id, guest_name, present, response, walking_ability, has_car, car_seats)
       VALUES ($1, $2, true, 'present', $3, $4, $5) RETURNING id`,
      [id, body.name, body.walking_ability ?? null, body.has_car ?? null, body.car_seats ?? null],
    );
    const url = body.link === false ? null : await newGuestLink(tx, dpId, c.env);
    return c.json({ ...(await dayDetail(tx, id)), guest_link: url ? { participant_id: dpId, name: body.name, url } : null }, 201);
  });
});

dayRoutes.patch('/days/:id/participants/:pid', async (c) => {
  const id = parseId(c.req.param('id'));
  const pid = parseId(c.req.param('pid'));
  const body = z.object({ present: z.boolean(), lunch: z.boolean(), ...overrides }).partial().strict().parse(await c.req.json());
  const entries = Object.entries(body);
  if (!entries.length) throw new AppError(400, 'VALIDATION', 'Aucune modification.');
  return tenantTx(c, MANAGERS, async (tx) => {
    const day = await loadDay(tx, id);
    requireStatus(day, ['brouillon', 'convoquee', 'en_cours'], 'Modification du participant');
    if (body.present !== undefined) requireStatus(day, ['en_cours'], 'Pointage des présents');
    // Les noms de colonnes viennent du schéma .strict() ci-dessus, jamais du client.
    const sets = entries.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    const n = await tx.execute(`UPDATE day_participants SET ${sets} WHERE id = $2 AND day_id = $1`, [id, pid, ...entries.map(([, v]) => v)]);
    if (!n) throw new AppError(404, 'NOT_FOUND', 'Participant introuvable.');
    return c.json(await dayDetail(tx, id));
  });
});

dayRoutes.delete('/days/:id/participants/:pid', (c) => {
  const id = parseId(c.req.param('id'));
  const pid = parseId(c.req.param('pid'));
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadDay(tx, id), ['brouillon', 'convoquee', 'en_cours'], 'Retrait du participant');
    await tx.execute('DELETE FROM day_participants WHERE id = $2 AND day_id = $1', [id, pid]);
    return c.json(await dayDetail(tx, id));
  });
});

/** Nouveau lien pour un invité (l'ancien cesse de fonctionner). */
dayRoutes.post('/days/:id/participants/:pid/guest-link', (c) => {
  const id = parseId(c.req.param('id'));
  const pid = parseId(c.req.param('pid'));
  return tenantTx(c, MANAGERS, async (tx) => {
    const g = notFoundIfNull(await tx.maybeOne<{ id: string; guest_name: string }>(
      'SELECT id, guest_name FROM day_participants WHERE id = $2 AND day_id = $1 AND user_id IS NULL', [id, pid],
    ), 'Invité');
    return c.json({ participant_id: g.id, name: g.guest_name, url: await newGuestLink(tx, g.id, c.env) });
  });
});

// ---------------------------------------------------------------------------
// Cycle de vie de la journée
// ---------------------------------------------------------------------------

dayRoutes.post('/days/:id/actions/:action{convoquer|brouillon|demarrer|terminer|annuler}', (c) => {
  const id = parseId(c.req.param('id'));
  const action = c.req.param('action');
  return tenantTx(c, MANAGERS, async (tx) => {
    const day = await loadDay(tx, id);
    switch (action) {
      case 'convoquer':
        if (!(await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM day_participants WHERE day_id = $1', [id])).n) {
          throw new AppError(422, 'DAY_NO_PARTICIPANT', 'Convoquez au moins un chasseur.');
        }
        await tx.execute(`UPDATE hunt_days SET status = 'convoquee' WHERE id = $1`, [id]);
        await notifyDay(c, tx, id, 'convocation');
        break;
      case 'brouillon':
        await tx.execute(`UPDATE hunt_days SET status = 'brouillon' WHERE id = $1`, [id]);
        break;
      case 'demarrer':
        // Jour J : présents pré-cochés d'après les réponses (ajustables ensuite).
        await tx.execute(`UPDATE hunt_days SET status = 'en_cours' WHERE id = $1`, [id]);
        await tx.execute(`UPDATE day_participants SET present = true WHERE day_id = $1 AND response = 'present'`, [id]);
        break;
      case 'terminer':
        await tx.execute(`UPDATE hunt_days SET status = 'terminee' WHERE id = $1`, [id]);
        break;
      case 'annuler':
        await tx.execute(`UPDATE hunt_days SET status = 'annulee' WHERE id = $1`, [id]);
        if (day.status === 'convoquee') await notifyDay(c, tx, id, 'annulation'); // un brouillon n'a prévenu personne
        break;
    }
    return c.json(await dayDetail(tx, id));
  });
});

// ---------------------------------------------------------------------------
// Battues de la journée et regroupement
// ---------------------------------------------------------------------------

/**
 * Nouvelle battue : territoire et volontaires parmi les présents (tous par
 * défaut). Une seule battue à la fois. Les espèces de la battue précédente
 * sont reprises (modifiables ; quotas indépendants d'une battue à l'autre).
 */
dayRoutes.post('/days/:id/battues', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = z.object({ territory_id: z.uuid(), hunt_plan_id: z.uuid().nullable().optional(), participant_ids: z.array(z.uuid()).max(500).optional() }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    const day = await loadDay(tx, id);
    requireStatus(day, ['en_cours'], 'Nouvelle battue');
    if (await tx.maybeOne(`SELECT 1 FROM hunts WHERE day_id = $1 AND status = 'en_cours'`, [id])) {
      throw new AppError(409, 'BATTUE_RUNNING', 'Terminez d’abord la battue en cours.');
    }
    const previous = await tx.maybeOne<{ id: string }>('SELECT id FROM hunts WHERE day_id = $1 ORDER BY number DESC LIMIT 1', [id]);
    const { id: huntId } = await tx.one<{ id: string }>(
      `INSERT INTO hunts (day_id, number, territory_id, date, meeting_time, meeting_place, meeting_point, status, leader_user_id)
       SELECT d.id, coalesce((SELECT max(number) FROM hunts WHERE day_id = d.id), 0) + 1, $2, d.date,
              d.meeting_time, d.meeting_place, d.meeting_point, 'en_cours', app.current_user_id()
         FROM hunt_days d WHERE d.id = $1
       RETURNING id`,
      [id, body.territory_id],
    );
    // Plan de chasse : celui choisi, sinon le seul (ou le premier) du territoire.
    await setHuntPlan(tx, huntId, body.territory_id, body.hunt_plan_id !== undefined ? body.hunt_plan_id : await defaultHuntPlanId(tx, body.territory_id));
    const ids = body.participant_ids
      ?? (await tx.query<{ id: string }>('SELECT id FROM day_participants WHERE day_id = $1 AND present', [id])).map((r) => r.id);
    await setSelection(tx, huntId, ids);
    if (previous) {
      await tx.execute('INSERT INTO hunt_species (hunt_id, species, quota) SELECT $1, species, quota FROM hunt_species WHERE hunt_id = $2', [huntId, previous.id]);
    } else {
      // Première battue de la journée : espèces de la saison, avec leur nombre par défaut par battue.
      await tx.execute(
        `INSERT INTO hunt_species (hunt_id, species, quota)
         SELECT $1, ss.species, ss.battue_quota FROM season_species ss JOIN hunt_days d ON d.season_id = ss.season_id WHERE d.id = $2`,
        [huntId, id]);
    }
    await tx.execute('UPDATE hunt_days SET regroup_at = NULL WHERE id = $1', [id]);
    return c.json({ hunt_id: huntId, ...(await dayDetail(tx, id)) }, 201);
  });
});

/** Regroupement après une battue : lieu, point et heure, annoncés aux présents. */
dayRoutes.post('/days/:id/regroup', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = z.object({ place: z.string().trim().max(200), point: pointSchema.nullable(), time: timeSchema.nullable() })
    .partial({ point: true, time: true }).strict().parse(await c.req.json());
  if (!body.place && !body.point) throw new AppError(422, 'VALIDATION', 'Indiquez un lieu ou un point sur la carte.');
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadDay(tx, id), ['en_cours'], 'Regroupement');
    await tx.execute(
      `UPDATE hunt_days SET regroup_place = $2, regroup_point = CASE WHEN $3::text IS NULL THEN NULL ELSE ${geomParam(3)} END,
              regroup_time = $4::time, regroup_at = now() WHERE id = $1`,
      [id, body.place, body.point ? JSON.stringify(body.point) : null, body.time ?? null],
    );
    const notified = await notifyDay(c, tx, id, 'regroupement');
    return c.json({ ...(await dayDetail(tx, id)), notified });
  });
});

// ---------------------------------------------------------------------------
// Vue chasseur de la journée, version, partage de position
// ---------------------------------------------------------------------------

/** Vue de la journée + covoiturage de la battue en cours (postes publiés). */
dayRoutes.get('/days/:id/view', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    const { v } = await tx.one<{ v: any }>('SELECT app.view_day($1) AS v', [id]);
    if (!v) throw new AppError(404, 'NOT_FOUND', 'Journée introuvable ou vous n’y êtes pas convoqué.');
    const cur = v.current?.hunt;
    // Ligne de postes : chef de ligne du chasseur ; pour un chef, les chasseurs de sa ligne.
    if (cur?.id && v.current) v.current.line = (await tx.one<{ l: unknown }>('SELECT app.my_line($1) AS l', [cur.id])).l;
    const carpool = cur && cur.status === 'en_cours' && cur.assignments_published && !cur.started_at
      ? await carpoolFor(tx, cur.id) : null;
    return c.json({ view: v, carpool });
  });
});

dayRoutes.get('/days/:id/revision', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    const row = notFoundIfNull(await tx.maybeOne('SELECT revision::int AS revision, status, date::text AS date FROM hunt_days WHERE id = $1', [id]), 'Journée');
    return c.json(row);
  });
});

dayRoutes.put('/days/:id/position-sharing', async (c) => {
  const id = parseId(c.req.param('id'));
  const { share } = z.object({ share: z.boolean() }).strict().parse(await c.req.json());
  return tenantTx(c, null, async (tx) => {
    await tx.query('SELECT app.set_day_position_sharing($1, $2)', [id, share]);
    return c.json({ share });
  });
});
