// Lot 4 — Battues : convocation, réponses, rond du matin (présents, postes du
// jour, attribution, tirage au sort), publication des attributions, liens
// invités, début et fin de battue.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from '../env';
import type { Tx } from '../db';
import { withTx } from '../db';
import { notFoundIfNull, parseId, tenantTx, type Role } from '../context';
import { AppError } from '../errors';
import { randomToken, sha256Hex } from '../auth';
import { geomOut, geomParam, pointSchema } from '../geo';
import { loadPlans } from './plans';
import { drawAssignments, proposePosts } from '../proposal';

export const huntRoutes = new Hono<AppEnv>();

const MANAGERS: Role[] = ['president', 'responsable'];

const HUNT_SELECT = `h.id, h.territory_id, t.name AS territory_name, to_char(h.date, 'YYYY-MM-DD') AS date,
  to_char(h.meeting_time, 'HH24:MI') AS meeting_time, h.meeting_place, ${geomOut('h.meeting_point', 'meeting_point')},
  h.briefing, h.leader_user_id, lu.display_name AS leader_name, h.status, h.assignments_published_at,
  h.started_at, h.ended_at, h.created_at`;
const HUNT_FROM = `hunts h JOIN territories t ON t.id = h.territory_id LEFT JOIN users lu ON lu.id = h.leader_user_id`;

export function guestUrl(env: Env, token: string): string {
  const origin = (env.APP_ORIGIN ?? '').split(',')[0].trim().replace(/\/$/, '');
  return `${origin}/#/battue-invite/${token}`;
}

async function loadHunt(tx: Tx, id: string) {
  return notFoundIfNull(await tx.maybeOne<Record<string, any>>(`SELECT ${HUNT_SELECT} FROM ${HUNT_FROM} WHERE h.id = $1`, [id]), 'Battue');
}

function requireStatus(hunt: Record<string, any>, allowed: string[], action: string) {
  if (!allowed.includes(hunt.status)) {
    throw new AppError(409, 'HUNT_BAD_STATUS', `${action} impossible : la battue est « ${STATUS_LABEL[hunt.status] ?? hunt.status} ».`);
  }
}

const STATUS_LABEL: Record<string, string> = {
  brouillon: 'en brouillon',
  publiee: 'publiée',
  en_cours: 'en cours',
  terminee: 'terminée',
  annulee: 'annulée',
};

/** Postes disponibles du territoire (actifs, hors zone d'habitation). */
async function availablePostIds(tx: Tx, territoryId: string) {
  const rows = await tx.query<{ id: string }>(
    'SELECT id FROM posts WHERE territory_id = $1 AND active AND invalid_reason IS NULL',
    [territoryId],
  );
  return new Set(rows.map((r) => r.id));
}

/** Vue complète d'une battue pour le président / responsable. */
async function huntDetail(tx: Tx, id: string) {
  const hunt = await loadHunt(tx, id);
  const participants = await tx.query(
    `SELECT hp.id, hp.user_id, coalesce(u.display_name, hp.guest_name) AS name, hp.user_id IS NULL AS guest,
            hp.role, hp.response, hp.present, hp.guest_token_hash IS NOT NULL AS has_guest_link,
            a.post_id, a.locked
       FROM hunt_participants hp
       LEFT JOIN users u ON u.id = hp.user_id
       LEFT JOIN hunt_assignments a ON a.participant_id = hp.id
      WHERE hp.hunt_id = $1
      ORDER BY hp.user_id IS NULL, lower(coalesce(u.display_name, hp.guest_name))`,
    [id],
  );
  const dayPosts = (await tx.query<{ post_id: string }>('SELECT post_id FROM hunt_posts WHERE hunt_id = $1', [id])).map((r) => r.post_id);
  let proposal = null;
  if (hunt.status === 'en_cours') {
    const hunters = participants.filter((p: any) => p.present && p.role === 'poste').length;
    const plans = await loadPlans(tx, hunt.territory_id);
    proposal = proposePosts(hunters, plans, await availablePostIds(tx, hunt.territory_id));
  }
  return { hunt, participants, day_post_ids: dayPosts, proposal };
}

// ---------------------------------------------------------------------------
// Liste, création, modification
// ---------------------------------------------------------------------------

huntRoutes.get('/hunts', (c) =>
  tenantTx(c, null, async (tx) => {
    const hunts = await tx.query(
      `SELECT ${HUNT_SELECT},
              (SELECT count(*)::int FROM hunt_participants x WHERE x.hunt_id = h.id AND x.user_id IS NOT NULL) AS convoked,
              (SELECT count(*)::int FROM hunt_participants x WHERE x.hunt_id = h.id AND x.response = 'present') AS answered_present,
              (SELECT x.response FROM hunt_participants x WHERE x.hunt_id = h.id AND x.user_id = $1) AS my_response,
              EXISTS (SELECT 1 FROM hunt_participants x WHERE x.hunt_id = h.id AND x.user_id = $1) AS convoked_me
         FROM ${HUNT_FROM}
        ORDER BY h.date DESC, h.meeting_time DESC`,
      [c.get('user').id],
    );
    return c.json({ hunts });
  }),
);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide (AAAA-MM-JJ).');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure invalide (HH:MM).');
const huntFields = z.object({
  territory_id: z.uuid(),
  date: dateSchema,
  meeting_time: timeSchema,
  meeting_place: z.string().trim().max(200),
  meeting_point: pointSchema.nullable(),
  briefing: z.string().max(5000),
  participant_user_ids: z.array(z.string().min(1).max(64)).max(500),
});

huntRoutes.post('/hunts', async (c) => {
  const body = huntFields.partial({ meeting_time: true, meeting_place: true, meeting_point: true, briefing: true, participant_user_ids: true }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx, { tenantId }) => {
    const { id } = await tx.one<{ id: string }>(
      `INSERT INTO hunts (territory_id, date, meeting_time, meeting_place, meeting_point, briefing, leader_user_id)
       VALUES ($1, $2, coalesce($3::time, '08:00'), coalesce($4, ''),
               CASE WHEN $5::text IS NULL THEN NULL ELSE ${geomParam(5)} END, coalesce($6, ''), app.current_user_id())
       RETURNING id`,
      [body.territory_id, body.date, body.meeting_time ?? null, body.meeting_place ?? null,
       body.meeting_point ? JSON.stringify(body.meeting_point) : null, body.briefing ?? null],
    );
    if (body.participant_user_ids?.length) await setConvocations(tx, id, tenantId, body.participant_user_ids);
    return c.json(await huntDetail(tx, id), 201);
  });
});

huntRoutes.get('/hunts/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => c.json(await huntDetail(tx, id)));
});

huntRoutes.patch('/hunts/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = huntFields.omit({ territory_id: true, participant_user_ids: true })
    .extend({ leader_user_id: z.string().min(1).max(64) })
    .partial().strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadHunt(tx, id), ['brouillon', 'publiee', 'en_cours'], 'Modification');
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(body)) {
      params.push(k === 'meeting_point' && v ? JSON.stringify(v) : v);
      sets.push(k === 'meeting_point' && v ? `${k} = ${geomParam(params.length)}` : `${k} = $${params.length}`);
    }
    if (!sets.length) throw new AppError(400, 'VALIDATION', 'Aucune modification.');
    await tx.execute(`UPDATE hunts SET ${sets.join(', ')} WHERE id = $1`, params);
    return c.json(await huntDetail(tx, id));
  });
});

huntRoutes.delete('/hunts/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadHunt(tx, id), ['brouillon', 'annulee'], 'Suppression');
    await tx.execute('DELETE FROM hunts WHERE id = $1', [id]);
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// Convocations, réponses, invités, présents
// ---------------------------------------------------------------------------

/** Convoque exactement ces membres (les invités sans compte ne sont pas touchés). */
async function setConvocations(tx: Tx, huntId: string, tenantId: string, userIds: string[]) {
  await tx.execute('DELETE FROM hunt_participants WHERE hunt_id = $1 AND user_id IS NOT NULL AND NOT (user_id = ANY($2))', [huntId, userIds]);
  await tx.execute(
    `INSERT INTO hunt_participants (hunt_id, user_id)
     SELECT $1, m.user_id FROM memberships m WHERE m.tenant_id = $2 AND m.user_id = ANY($3)
     ON CONFLICT (hunt_id, user_id) DO NOTHING`,
    [huntId, tenantId, userIds],
  );
}

huntRoutes.put('/hunts/:id/convocations', async (c) => {
  const id = parseId(c.req.param('id'));
  const { user_ids } = z.object({ user_ids: z.array(z.string().min(1).max(64)).max(500) }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx, { tenantId }) => {
    requireStatus(await loadHunt(tx, id), ['brouillon', 'publiee', 'en_cours'], 'Convocation');
    await setConvocations(tx, id, tenantId, user_ids);
    return c.json(await huntDetail(tx, id));
  });
});

huntRoutes.post('/hunts/:id/respond', async (c) => {
  const id = parseId(c.req.param('id'));
  const { response } = z.object({ response: z.enum(['present', 'absent']) }).strict().parse(await c.req.json());
  return tenantTx(c, null, async (tx) => {
    await tx.query('SELECT app.respond_hunt($1, $2)', [id, response]);
    return c.json({ sheet: (await tx.one('SELECT app.my_hunt_sheet($1) AS s', [id])).s });
  });
});

huntRoutes.post('/hunts/:id/guests', async (c) => {
  const id = parseId(c.req.param('id'));
  const { name } = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadHunt(tx, id), ['publiee', 'en_cours'], 'Ajout d’un invité');
    await tx.execute(`INSERT INTO hunt_participants (hunt_id, guest_name, present) VALUES ($1, $2, true)`, [id, name]);
    return c.json(await huntDetail(tx, id), 201);
  });
});

huntRoutes.patch('/hunts/:id/participants/:pid', async (c) => {
  const id = parseId(c.req.param('id'));
  const pid = parseId(c.req.param('pid'));
  const body = z.object({ present: z.boolean(), role: z.enum(['poste', 'traqueur', 'chef_de_ligne']) }).partial().strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    const hunt = await loadHunt(tx, id);
    requireStatus(hunt, body.present !== undefined ? ['en_cours'] : ['brouillon', 'publiee', 'en_cours'], 'Modification du participant');
    const n = await tx.execute(
      `UPDATE hunt_participants SET present = coalesce($3, present), role = coalesce($4::hunt_role, role)
        WHERE id = $2 AND hunt_id = $1`,
      [id, pid, body.present ?? null, body.role ?? null],
    );
    if (!n) throw new AppError(404, 'NOT_FOUND', 'Participant introuvable.');
    return c.json(await huntDetail(tx, id));
  });
});

huntRoutes.delete('/hunts/:id/participants/:pid', (c) => {
  const id = parseId(c.req.param('id'));
  const pid = parseId(c.req.param('pid'));
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadHunt(tx, id), ['brouillon', 'publiee', 'en_cours'], 'Retrait du participant');
    await tx.execute('DELETE FROM hunt_participants WHERE id = $2 AND hunt_id = $1', [id, pid]);
    return c.json(await huntDetail(tx, id));
  });
});

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

huntRoutes.post('/hunts/:id/actions/:action{publier|demarrer|debut|fin|annuler|brouillon}', (c) => {
  const id = parseId(c.req.param('id'));
  const action = c.req.param('action');
  return tenantTx(c, MANAGERS, async (tx) => {
    const hunt = await loadHunt(tx, id);
    switch (action) {
      case 'publier':
        if (!(await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM hunt_participants WHERE hunt_id = $1', [id])).n) {
          throw new AppError(422, 'HUNT_NO_PARTICIPANT', 'Convoquez au moins un chasseur avant de publier.');
        }
        await tx.execute(`UPDATE hunts SET status = 'publiee' WHERE id = $1`, [id]);
        break;
      case 'brouillon':
        await tx.execute(`UPDATE hunts SET status = 'brouillon' WHERE id = $1`, [id]);
        break;
      case 'demarrer':
        // Rond du matin : présents pré-cochés d'après les réponses.
        await tx.execute(`UPDATE hunts SET status = 'en_cours' WHERE id = $1`, [id]);
        await tx.execute(`UPDATE hunt_participants SET present = true WHERE hunt_id = $1 AND response = 'present'`, [id]);
        break;
      case 'debut':
        requireStatus(hunt, ['en_cours'], 'Début de battue');
        if (!hunt.assignments_published_at) {
          throw new AppError(422, 'ASSIGNMENTS_NOT_PUBLISHED', 'Publiez les attributions avant de lancer la battue.');
        }
        await tx.execute('UPDATE hunts SET started_at = coalesce(started_at, now()) WHERE id = $1', [id]);
        break;
      case 'fin':
        await tx.execute(`UPDATE hunts SET status = 'terminee' WHERE id = $1`, [id]);
        break;
      case 'annuler':
        await tx.execute(`UPDATE hunts SET status = 'annulee' WHERE id = $1`, [id]);
        break;
    }
    return c.json(await huntDetail(tx, id));
  });
});

// ---------------------------------------------------------------------------
// Postes du jour et attribution (en cours)
// ---------------------------------------------------------------------------

huntRoutes.put('/hunts/:id/posts', async (c) => {
  const id = parseId(c.req.param('id'));
  const { post_ids } = z.object({ post_ids: z.array(z.uuid()).max(999) }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    const hunt = await loadHunt(tx, id);
    requireStatus(hunt, ['en_cours'], 'Choix des postes');
    const available = await availablePostIds(tx, hunt.territory_id);
    const unavailable = post_ids.filter((p) => !available.has(p));
    if (unavailable.length) {
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

huntRoutes.put('/hunts/:id/assignments', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = z.object({ participant_id: z.uuid(), post_id: z.uuid(), locked: z.boolean().default(false) }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    await tx.execute(
      `INSERT INTO hunt_assignments (hunt_id, post_id, participant_id, locked) VALUES ($1, $2, $3, $4)
       ON CONFLICT (hunt_id, participant_id) DO UPDATE SET post_id = EXCLUDED.post_id, locked = EXCLUDED.locked`,
      [id, body.post_id, body.participant_id, body.locked],
    );
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

/** Tirage au sort : garde les attributions verrouillées, répartit les autres. */
huntRoutes.post('/hunts/:id/draw', async (c) => {
  const id = parseId(c.req.param('id'));
  const { allow_double } = z.object({ allow_double: z.boolean().default(false) }).strict().parse(await c.req.json().catch(() => ({})));
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadHunt(tx, id), ['en_cours'], 'Tirage au sort');
    const posts = (await tx.query<{ post_id: string }>('SELECT post_id FROM hunt_posts WHERE hunt_id = $1', [id])).map((r) => r.post_id);
    if (!posts.length) throw new AppError(422, 'NO_DAY_POSTS', 'Choisissez d’abord les postes du jour.');
    const hunters = (await tx.query<{ id: string }>(
      `SELECT id FROM hunt_participants WHERE hunt_id = $1 AND present AND role = 'poste'`, [id],
    )).map((r) => r.id);
    const locked = await tx.query<{ post_id: string; participant_id: string }>(
      'SELECT post_id, participant_id FROM hunt_assignments WHERE hunt_id = $1 AND locked', [id],
    );
    await tx.execute('DELETE FROM hunt_assignments WHERE hunt_id = $1 AND NOT locked', [id]);
    const { assignments, unplaced } = drawAssignments(posts, hunters, locked, allow_double);
    for (const a of assignments) {
      await tx.execute('INSERT INTO hunt_assignments (hunt_id, post_id, participant_id) VALUES ($1, $2, $3)', [id, a.post_id, a.participant_id]);
    }
    return c.json({ ...(await huntDetail(tx, id)), unplaced: unplaced.length });
  });
});

/**
 * Publie les attributions : chaque chasseur voit son poste. Les invités sans
 * lien en reçoivent un (renvoyé une seule fois : seule l'empreinte est stockée).
 */
huntRoutes.post('/hunts/:id/publish-assignments', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadHunt(tx, id), ['en_cours'], 'Publication des attributions');
    await tx.execute('UPDATE hunts SET assignments_published_at = now() WHERE id = $1', [id]);
    const guests = await tx.query<{ id: string; guest_name: string }>(
      'SELECT id, guest_name FROM hunt_participants WHERE hunt_id = $1 AND user_id IS NULL AND guest_token_hash IS NULL', [id],
    );
    const links = [];
    for (const g of guests) links.push({ participant_id: g.id, name: g.guest_name, url: await newGuestLink(tx, g.id, c.env) });
    return c.json({ ...(await huntDetail(tx, id)), guest_links: links });
  });
});

async function newGuestLink(tx: Tx, participantId: string, env: Env) {
  const token = randomToken();
  await tx.execute('UPDATE hunt_participants SET guest_token_hash = $2 WHERE id = $1 AND user_id IS NULL', [participantId, await sha256Hex(token)]);
  return guestUrl(env, token);
}

/** Nouveau lien pour un invité (l'ancien cesse de fonctionner). */
huntRoutes.post('/hunts/:id/participants/:pid/guest-link', (c) => {
  const id = parseId(c.req.param('id'));
  const pid = parseId(c.req.param('pid'));
  return tenantTx(c, MANAGERS, async (tx) => {
    const g = notFoundIfNull(await tx.maybeOne<{ id: string; guest_name: string }>(
      'SELECT id, guest_name FROM hunt_participants WHERE id = $2 AND hunt_id = $1 AND user_id IS NULL', [id, pid],
    ), 'Invité');
    return c.json({ participant_id: g.id, name: g.guest_name, url: await newGuestLink(tx, g.id, c.env) });
  });
});

huntRoutes.delete('/hunts/:id/participants/:pid/guest-link', (c) => {
  const id = parseId(c.req.param('id'));
  const pid = parseId(c.req.param('pid'));
  return tenantTx(c, MANAGERS, async (tx) => {
    await tx.execute('UPDATE hunt_participants SET guest_token_hash = NULL WHERE id = $2 AND hunt_id = $1', [id, pid]);
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// Fiche « Ma battue » (membre) et lien invité (sans compte)
// ---------------------------------------------------------------------------

huntRoutes.get('/hunts/:id/sheet', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    const { s } = await tx.one<{ s: unknown }>('SELECT app.my_hunt_sheet($1) AS s', [id]);
    if (!s) throw new AppError(404, 'NOT_FOUND', 'Vous n’êtes pas convoqué à cette battue.');
    return c.json({ sheet: s });
  });
});

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

huntRoutes.get('/guest/:token', async (c: Context<AppEnv>) => {
  const token = c.req.param('token') ?? '';
  if (!TOKEN_RE.test(token)) throw new AppError(404, 'GUEST_LINK_UNKNOWN', 'Lien inconnu.');
  const hash = await sha256Hex(token);
  return withTx(c.get('pool'), { userId: null, tenantId: null }, async (tx) => {
    const { s } = await tx.one<{ s: unknown }>('SELECT app.guest_hunt_sheet($1) AS s', [hash]);
    if (!s) throw new AppError(410, 'GUEST_LINK_EXPIRED', 'Ce lien n’est plus valable : la battue est terminée ou le lien a été remplacé.');
    return c.json({ sheet: s });
  });
});
