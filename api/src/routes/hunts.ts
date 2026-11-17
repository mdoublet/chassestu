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
import { notifyUsers } from './notifications';

export const huntRoutes = new Hono<AppEnv>();

const MANAGERS: Role[] = ['president', 'responsable'];

const HUNT_SELECT = `h.id, h.territory_id, t.name AS territory_name, to_char(h.date, 'YYYY-MM-DD') AS date,
  to_char(h.meeting_time, 'HH24:MI') AS meeting_time, h.meeting_place, ${geomOut('h.meeting_point', 'meeting_point')},
  h.briefing, h.leader_user_id, lu.display_name AS leader_name, h.status, h.assignments_published_at,
  h.started_at, h.ended_at, h.created_at, h.revision::int AS revision`;
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
  const species = await tx.query('SELECT species, quota FROM hunt_species WHERE hunt_id = $1 ORDER BY species', [id]);
  const harvests = await tx.query(
    `SELECT hh.id, hh.species, hh.category, hh.notes, hh.created_at, coalesce(u.display_name, x.guest_name) AS shooter
       FROM hunt_harvests hh LEFT JOIN hunt_participants x ON x.id = hh.participant_id LEFT JOIN users u ON u.id = x.user_id
      WHERE hh.hunt_id = $1 ORDER BY hh.created_at DESC`,
    [id],
  );
  let proposal = null;
  if (hunt.status === 'en_cours') {
    const hunters = participants.filter((p: any) => p.present && p.role === 'poste').length;
    const plans = await loadPlans(tx, hunt.territory_id);
    proposal = proposePosts(hunters, plans, await availablePostIds(tx, hunt.territory_id));
  }
  return { hunt, participants, day_post_ids: dayPosts, proposal, species, harvests };
}

// ---------------------------------------------------------------------------
// Alertes aux participants (cloche + notification push)
// ---------------------------------------------------------------------------

/** « samedi 5 décembre » (date stockée sans heure : pas de fuseau). */
function frenchDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
const frenchTime = (hhmm: string) => {
  const [h, m] = hhmm.split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
};

type HuntEvent = 'convocation' | 'annulation' | 'attributions' | 'debut' | 'fin';

async function notifyHunt(c: Context<AppEnv>, tx: Tx, huntId: string, event: HuntEvent) {
  const hunt = await loadHunt(tx, huntId);
  const where = `${hunt.territory_name}`;
  const rdv = `RDV ${frenchTime(hunt.meeting_time)}${hunt.meeting_place ? `, ${hunt.meeting_place}` : ''}`;
  // Convocation et annulation : tous les convoqués ; ensuite : les présents.
  const people = await tx.query<{ user_id: string; role: string; post_number: number | null; post_name: string | null }>(
    `SELECT hp.user_id, hp.role, p.number AS post_number, p.name AS post_name
       FROM hunt_participants hp
       LEFT JOIN hunt_assignments a ON a.participant_id = hp.id
       LEFT JOIN posts p ON p.id = a.post_id
      WHERE hp.hunt_id = $1 AND hp.user_id IS NOT NULL
        AND ($2 OR hp.present)`,
    [huntId, event === 'convocation' || event === 'annulation'],
  );
  const items = people.map((u) => {
    switch (event) {
      case 'convocation':
        return { user_id: u.user_id, title: `Battue le ${frenchDate(hunt.date)}`, body: `${where} · ${rdv}. Répondez présent ou absent.` };
      case 'annulation':
        return { user_id: u.user_id, title: 'Battue annulée', body: `La battue du ${frenchDate(hunt.date)} (${where}) est annulée.` };
      case 'attributions':
        return u.post_number
          ? { user_id: u.user_id, title: `Votre poste : ${u.post_number}${u.post_name ? ` · ${u.post_name}` : ''}`, body: `${where} : chemin, voisins et consignes dans l’application.` }
          : { user_id: u.user_id, title: 'Postes attribués', body: u.role === 'poste' ? `${where} : pas de poste pour vous pour l’instant, voyez le responsable.` : `${where} : vous êtes ${u.role === 'traqueur' ? 'traqueur' : 'chef de ligne'}.` };
      case 'debut':
        return { user_id: u.user_id, title: 'Début de battue', body: `${where} : la traque commence. Restez à votre poste, angles de tir respectés.` };
      case 'fin':
        return { user_id: u.user_id, title: 'Fin de battue', body: `${where} : déchargez vos armes et rejoignez le rendez-vous.` };
    }
  });
  return notifyUsers(c, tx, huntId, event, items);
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
        await notifyHunt(c, tx, id, 'convocation');
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
        if (!hunt.started_at) await notifyHunt(c, tx, id, 'debut');
        break;
      case 'fin':
        await tx.execute(`UPDATE hunts SET status = 'terminee' WHERE id = $1`, [id]);
        await notifyHunt(c, tx, id, 'fin');
        break;
      case 'annuler':
        const wasPublished = hunt.status === 'publiee';
        await tx.execute(`UPDATE hunts SET status = 'annulee' WHERE id = $1`, [id]);
        if (wasPublished) await notifyHunt(c, tx, id, 'annulation'); // un brouillon n'a prévenu personne
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
    const notified = await notifyHunt(c, tx, id, 'attributions');
    return c.json({ ...(await huntDetail(tx, id)), guest_links: links, notified });
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
// Vue chasseur (tout le monde), version, espèces, prélèvements
// ---------------------------------------------------------------------------

/** Fiche de la battue : la sienne pour un convoqué, vue d'ensemble pour un responsable. */
huntRoutes.get('/hunts/:id/view', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    const { v } = await tx.one<{ v: unknown }>('SELECT app.view_hunt($1) AS v', [id]);
    if (!v) throw new AppError(404, 'NOT_FOUND', 'Battue introuvable ou vous n’y êtes pas convoqué.');
    return c.json({ sheet: v });
  });
});

/** Numéro de version (les écrans ouverts se rechargent s'il change). */
huntRoutes.get('/hunts/:id/revision', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    const row = notFoundIfNull(await tx.maybeOne('SELECT revision::int AS revision, status, date::text AS date FROM hunts WHERE id = $1', [id]), 'Battue');
    return c.json(row);
  });
});

const SPECIES_RE = /^[\p{L}\p{N} '’.\-()]{1,60}$/u;
const speciesSchema = z.string().trim().min(1).max(60).regex(SPECIES_RE, 'Nom d’espèce invalide.');

// ---------------------------------------------------------------------------
// Positions GPS en direct (consentement par battue, dernière position seulement)
// ---------------------------------------------------------------------------

/** Statut d'un participant sur la carte du responsable. */
export function positionStatus(
  p: { shared: boolean; age_s: number | null; accuracy_m: number | null; distance_m: number | null },
  toleranceM: number,
): 'non_partage' | 'sans_signal' | 'imprecise' | 'sur_poste' | 'en_route' | 'localise' {
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

huntRoutes.put('/hunts/:id/position-sharing', async (c) => {
  const id = parseId(c.req.param('id'));
  const { share } = z.object({ share: z.boolean() }).strict().parse(await c.req.json());
  return tenantTx(c, null, async (tx) => {
    await tx.query('SELECT app.set_position_sharing($1, $2)', [id, share]);
    return c.json({ share });
  });
});

huntRoutes.post('/hunts/:id/position', async (c) => {
  const id = parseId(c.req.param('id'));
  const b = positionBody.parse(await c.req.json());
  return tenantTx(c, null, async (tx) => {
    await tx.query('SELECT app.report_position($1, $2, $3, $4, $5)', [id, b.lon, b.lat, b.accuracy, b.recorded_at ?? null]);
    return c.body(null, 204);
  });
});

// Responsables : tous les présents ; chasseur : lui seul (RLS sur hunt_positions).
huntRoutes.get('/hunts/:id/positions', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    const hunt = notFoundIfNull(await tx.maybeOne<{ status: string; tolerance: number }>(
      `SELECT h.status, t.gps_tolerance_m AS tolerance FROM hunts h JOIN tenants t ON t.id = h.tenant_id WHERE h.id = $1`, [id]), 'Battue');
    const me = await tx.maybeOne<{ shared: boolean }>(
      'SELECT position_shared_at IS NOT NULL AS shared FROM hunt_participants WHERE hunt_id = $1 AND user_id = app.current_user_id()', [id]);
    const { manager } = await tx.one<{ manager: boolean }>(`SELECT app.has_role('president', 'responsable') AS manager`);
    const rows = await tx.query<any>(
      `SELECT hp.id AS participant_id, coalesce(u.display_name, hp.guest_name) AS name, hp.role,
              hp.user_id IS NULL AS guest, hp.position_shared_at IS NOT NULL AS shared,
              hp.user_id = app.current_user_id() AS mine, p.number AS post_number,
              ST_X(pos.geom::geometry) AS lon, ST_Y(pos.geom::geometry) AS lat, pos.accuracy_m,
              extract(epoch FROM now() - pos.recorded_at)::int AS age_s,
              CASE WHEN pos.geom IS NOT NULL AND p.geom IS NOT NULL THEN round(ST_Distance(pos.geom, p.geom::geography))::int END AS distance_m
         FROM hunt_participants hp
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
      participants: rows.map((r) => ({ ...r, status: r.guest ? 'invite' : positionStatus(r, hunt.tolerance) })),
    });
  });
});

huntRoutes.put('/hunts/:id/species', async (c) => {
  const id = parseId(c.req.param('id'));
  const { species } = z.object({
    species: z.array(z.object({ species: speciesSchema, quota: z.number().int().min(0).max(999).nullable() }).strict()).max(30),
  }).strict().parse(await c.req.json());
  return tenantTx(c, MANAGERS, async (tx) => {
    requireStatus(await loadHunt(tx, id), ['brouillon', 'publiee', 'en_cours'], 'Modification des espèces');
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
  notes: z.string().trim().max(500).default(''),
  participant_id: z.uuid().nullable().optional(), // responsable : tireur au choix
}).strict();

/** Déclarer un prélèvement : le participant pour lui-même, le responsable pour n'importe qui. */
huntRoutes.post('/hunts/:id/harvests', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = harvestSchema.parse(await c.req.json());
  return tenantTx(c, null, async (tx, { role }) => {
    if (MANAGERS.includes(role) && body.participant_id !== undefined) {
      requireStatus(await loadHunt(tx, id), ['en_cours', 'terminee'], 'Saisie d’un prélèvement');
      await tx.execute(
        `INSERT INTO hunt_harvests (hunt_id, species, category, notes, participant_id, recorded_by)
         VALUES ($1, $2, $3, $4, $5, app.current_user_id())`,
        [id, body.species, body.category, body.notes, body.participant_id],
      );
    } else {
      await tx.query('SELECT app.declare_harvest($1, $2, $3, $4)', [id, body.species, body.category, body.notes]);
    }
    return c.json({ sheet: (await tx.one('SELECT app.view_hunt($1) AS v', [id])).v }, 201);
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
    return c.json({ sheet: (await tx.one('SELECT app.view_hunt($1) AS v', [id])).v });
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
