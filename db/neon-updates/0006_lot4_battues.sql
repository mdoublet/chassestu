-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0006_lot4_battues.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0006_lot4_battues.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0006_lot4_battues.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0005_lot3_plans_couverture.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0005_lot3_plans_couverture.sql';
  END IF;
END $guard$;

-- ==================== 0006_lot4_battues.sql ====================
-- Lot 4 — Battue et attribution des postes.
--
-- Cycle de vie : brouillon → publiée → en cours → terminée ; annulée depuis
-- brouillon ou publiée. Les postes du jour et leur attribution n'existent
-- qu'en cours. Un chasseur ne voit une battue que s'il y est convoqué et
-- qu'elle n'est plus en brouillon ; un invité sans compte y accède par un lien
-- personnel (jeton) valable pour cette seule battue, jusqu'à sa clôture.

CREATE TYPE hunt_status AS ENUM ('brouillon', 'publiee', 'en_cours', 'terminee', 'annulee');
CREATE TYPE hunt_role AS ENUM ('poste', 'traqueur', 'chef_de_ligne');

CREATE TABLE hunts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id             uuid NOT NULL,
  date                     date NOT NULL,
  meeting_time             time NOT NULL DEFAULT '08:00',
  meeting_point            geometry(Point, 4326),
  meeting_place            text NOT NULL DEFAULT '' CHECK (length(meeting_place) <= 200),
  briefing                 text NOT NULL DEFAULT '' CHECK (length(briefing) <= 5000),
  leader_user_id           text REFERENCES users (id) ON DELETE SET NULL,
  status                   hunt_status NOT NULL DEFAULT 'brouillon',
  assignments_published_at timestamptz,
  started_at               timestamptz,   -- « Début de battue »
  ended_at                 timestamptz,   -- « Fin de battue » (statut terminée)
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (territory_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX hunts_tenant_date_idx ON hunts (tenant_id, date DESC);

CREATE TABLE hunt_participants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant_id(),
  hunt_id          uuid NOT NULL,
  user_id          text REFERENCES users (id) ON DELETE CASCADE,
  guest_name       text CHECK (length(btrim(guest_name)) BETWEEN 1 AND 120),
  role             hunt_role NOT NULL DEFAULT 'poste',
  response         text CHECK (response IN ('present', 'absent')),   -- réponse à la convocation
  present          boolean NOT NULL DEFAULT false,                   -- coché au rond du matin
  guest_token_hash text UNIQUE,                                      -- lien invité (empreinte SHA-256)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, user_id),
  UNIQUE (hunt_id, id),
  FOREIGN KEY (tenant_id, hunt_id) REFERENCES hunts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT participant_member_or_guest CHECK ((user_id IS NULL) <> (guest_name IS NULL)),
  CONSTRAINT guest_token_only_for_guests CHECK (guest_token_hash IS NULL OR user_id IS NULL)
);
CREATE INDEX hunt_participants_user_idx ON hunt_participants (user_id);

-- Postes couverts ce jour-là (proposition du plan, modifiable sans toucher au plan).
CREATE TABLE hunt_posts (
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  hunt_id      uuid NOT NULL,
  territory_id uuid NOT NULL,
  post_id      uuid NOT NULL,
  PRIMARY KEY (hunt_id, post_id),
  FOREIGN KEY (tenant_id, hunt_id) REFERENCES hunts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (territory_id, hunt_id) REFERENCES hunts (territory_id, id) ON DELETE CASCADE,
  FOREIGN KEY (territory_id, post_id) REFERENCES posts (territory_id, id) ON DELETE CASCADE
);

CREATE TABLE hunt_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id(),
  hunt_id        uuid NOT NULL,
  post_id        uuid NOT NULL,
  participant_id uuid NOT NULL,
  locked         boolean NOT NULL DEFAULT false,   -- conservé par le tirage au sort
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, participant_id),                -- un poste par chasseur
  FOREIGN KEY (tenant_id, hunt_id) REFERENCES hunts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hunt_id, post_id) REFERENCES hunt_posts (hunt_id, post_id) ON DELETE CASCADE,
  FOREIGN KEY (hunt_id, participant_id) REFERENCES hunt_participants (hunt_id, id) ON DELETE CASCADE
);
CREATE INDEX hunt_assignments_post_idx ON hunt_assignments (hunt_id, post_id);

-- ---------------------------------------------------------------------------
-- Règles
-- ---------------------------------------------------------------------------

-- Postes du jour et attribution : seulement en cours ; au plus deux chasseurs
-- par poste (doublon choisi par le responsable) ; chasseur présent et posté.
CREATE FUNCTION app.check_hunt_assignment() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM hunts WHERE id = NEW.hunt_id) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: l''attribution n''est possible que pendant la battue (en cours)'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'hunt_assignments' THEN
    IF NOT EXISTS (SELECT 1 FROM hunt_participants hp
                    WHERE hp.id = NEW.participant_id AND hp.present AND hp.role = 'poste') THEN
      RAISE EXCEPTION 'PARTICIPANT_NOT_POSTED: seul un chasseur présent et posté reçoit un poste'
        USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM hunt_assignments a
         WHERE a.hunt_id = NEW.hunt_id AND a.post_id = NEW.post_id AND a.id <> NEW.id) >= 2 THEN
      RAISE EXCEPTION 'POST_FULL: deux chasseurs au plus par poste'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hunt_assignments_check BEFORE INSERT OR UPDATE ON hunt_assignments
  FOR EACH ROW EXECUTE FUNCTION app.check_hunt_assignment();
CREATE TRIGGER hunt_posts_check BEFORE INSERT ON hunt_posts
  FOR EACH ROW EXECUTE FUNCTION app.check_hunt_assignment();

-- Un chasseur qui n'est plus présent ou plus posté perd son poste.
CREATE FUNCTION app.participant_changed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.present OR NEW.role <> 'poste' THEN
    DELETE FROM hunt_assignments WHERE participant_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER hunt_participants_changed AFTER UPDATE OF present, role ON hunt_participants
  FOR EACH ROW EXECUTE FUNCTION app.participant_changed();

-- Transitions de statut autorisées.
CREATE FUNCTION app.check_hunt_status() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'brouillon' AND NEW.status IN ('publiee', 'annulee'))
    OR (OLD.status = 'publiee'   AND NEW.status IN ('en_cours', 'annulee', 'brouillon'))
    OR (OLD.status = 'en_cours'  AND NEW.status = 'terminee')) THEN
    RAISE EXCEPTION 'HUNT_BAD_TRANSITION: passage de « % » à « % » impossible', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'terminee' THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hunts_status BEFORE UPDATE OF status ON hunts
  FOR EACH ROW EXECUTE FUNCTION app.check_hunt_status();
CREATE TRIGGER hunts_touch BEFORE UPDATE ON hunts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Audit des battues et des attributions.
CREATE TRIGGER hunts_audit AFTER INSERT OR UPDATE OR DELETE ON hunts
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER hunt_assignments_audit AFTER INSERT OR UPDATE OR DELETE ON hunt_assignments
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

-- ---------------------------------------------------------------------------
-- Accès des chasseurs et des invités
-- ---------------------------------------------------------------------------

-- Battues (hors brouillon) auxquelles l'utilisateur courant est convoqué.
-- SECURITY DEFINER : évite la récursion des politiques sur hunt_participants.
CREATE FUNCTION app.my_hunt_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT hp.hunt_id FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
     WHERE hp.user_id = app.current_user_id() AND h.status <> 'brouillon'
       AND h.tenant_id = app.current_tenant_id()
  $$;

-- Réponse à une convocation (battue publiée).
CREATE FUNCTION app.respond_hunt(p_hunt uuid, p_response text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_response NOT IN ('present', 'absent') THEN
    RAISE EXCEPTION 'INVALID: réponse inconnue' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hunts WHERE id = p_hunt AND status = 'publiee'
                    AND tenant_id = app.current_tenant_id()) THEN
    RAISE EXCEPTION 'HUNT_NOT_OPEN: on ne répond qu''à une battue publiée' USING ERRCODE = '23514';
  END IF;
  UPDATE hunt_participants SET response = p_response
   WHERE hunt_id = p_hunt AND user_id = app.current_user_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_INVITED: vous n''êtes pas convoqué à cette battue' USING ERRCODE = '42501';
  END IF;
END $$;

-- Fiche d'un participant : battue, son poste et ses voisins (si les
-- attributions sont publiées), de quoi dessiner la carte. Appelée par
-- app.my_hunt_sheet (membre) et app.guest_hunt_sheet (invité), qui vérifient l'accès.
CREATE FUNCTION app.hunt_sheet(p_participant uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_p      hunt_participants%ROWTYPE;
  v_h      hunts%ROWTYPE;
  v_all    boolean;
  v_post   uuid;
  v_result jsonb;
BEGIN
  SELECT * INTO v_p FROM hunt_participants WHERE id = p_participant;
  SELECT * INTO v_h FROM hunts WHERE id = v_p.hunt_id;
  SELECT show_all_posts INTO v_all FROM tenants WHERE id = v_h.tenant_id;
  SELECT a.post_id INTO v_post FROM hunt_assignments a
   WHERE a.participant_id = v_p.id AND v_h.assignments_published_at IS NOT NULL;

  WITH day_posts AS (
    SELECT p.id, p.number, p.name,
           row_number() OVER (ORDER BY p.number) AS rk,
           (SELECT string_agg(coalesce(u.display_name, x.guest_name), ' et ' ORDER BY coalesce(u.display_name, x.guest_name))
              FROM hunt_assignments a JOIN hunt_participants x ON x.id = a.participant_id
              LEFT JOIN users u ON u.id = x.user_id
             WHERE a.hunt_id = v_h.id AND a.post_id = p.id) AS occupant
      FROM hunt_posts hp JOIN posts p ON p.id = hp.post_id
     WHERE hp.hunt_id = v_h.id
  ), mine AS (SELECT rk FROM day_posts WHERE id = v_post)
  SELECT jsonb_build_object(
    'hunt', jsonb_build_object(
      'id', v_h.id, 'date', v_h.date, 'meeting_time', to_char(v_h.meeting_time, 'HH24:MI'),
      'meeting_place', v_h.meeting_place, 'meeting_point', ST_AsGeoJSON(v_h.meeting_point, 7)::jsonb,
      'briefing', v_h.briefing, 'status', v_h.status, 'started_at', v_h.started_at, 'ended_at', v_h.ended_at,
      'assignments_published', v_h.assignments_published_at IS NOT NULL,
      'leader', (SELECT display_name FROM users WHERE id = v_h.leader_user_id),
      'chefs_de_ligne', (SELECT coalesce(jsonb_agg(coalesce(u.display_name, x.guest_name)), '[]')
                           FROM hunt_participants x LEFT JOIN users u ON u.id = x.user_id
                          WHERE x.hunt_id = v_h.id AND x.role = 'chef_de_ligne')),
    'territory', (SELECT jsonb_build_object('name', t.name, 'geom', ST_AsGeoJSON(t.geom, 7)::jsonb)
                    FROM territories t WHERE t.id = v_h.territory_id),
    'exclusion', (SELECT ST_AsGeoJSON(z.geom, 7)::jsonb FROM exclusion_zones z WHERE z.territory_id = v_h.territory_id),
    'reserves', (SELECT coalesce(jsonb_agg(ST_AsGeoJSON(r.geom, 7)::jsonb), '[]')
                   FROM reserve_zones r WHERE r.territory_id = v_h.territory_id),
    'me', jsonb_build_object(
      'name', coalesce((SELECT display_name FROM users WHERE id = v_p.user_id), v_p.guest_name),
      'role', v_p.role, 'response', v_p.response, 'present', v_p.present, 'guest', v_p.user_id IS NULL),
    'post', (SELECT jsonb_build_object(
               'number', p.number, 'name', p.name, 'instructions', p.instructions,
               'geom', ST_AsGeoJSON(p.geom, 7)::jsonb, 'access_path', ST_AsGeoJSON(p.access_path, 7)::jsonb,
               'access_path_length_m', round(ST_Length(p.access_path::geography)),
               'parking', (SELECT jsonb_build_object('name', pk.name, 'geom', ST_AsGeoJSON(pk.geom, 7)::jsonb)
                             FROM parkings pk WHERE pk.id = p.parking_id),
               'shared_with', (SELECT coalesce(jsonb_agg(coalesce(u.display_name, x.guest_name)), '[]')
                                 FROM hunt_assignments a JOIN hunt_participants x ON x.id = a.participant_id
                                 LEFT JOIN users u ON u.id = x.user_id
                                WHERE a.hunt_id = v_h.id AND a.post_id = p.id AND x.id <> v_p.id))
               FROM posts p WHERE p.id = v_post),
    -- Voisins (poste précédent et suivant dans la ligne du jour) : information de
    -- sécurité. Tous les postes si l'association l'a choisi.
    'neighbors', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'number', d.number, 'name', d.name, 'occupant', d.occupant,
                     'side', CASE WHEN d.rk < m.rk THEN 'gauche' ELSE 'droite' END) ORDER BY d.number), '[]')
                    FROM day_posts d, mine m
                   WHERE v_h.assignments_published_at IS NOT NULL
                     AND d.id <> v_post AND (v_all OR abs(d.rk - m.rk) = 1)),
    'show_all_posts', v_all
  ) INTO v_result;
  RETURN v_result;
END $$;

CREATE FUNCTION app.my_hunt_sheet(p_hunt uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT app.hunt_sheet(hp.id) FROM hunt_participants hp
     WHERE hp.hunt_id = p_hunt AND hp.user_id = app.current_user_id()
       AND p_hunt IN (SELECT app.my_hunt_ids())
  $$;

-- Lien invité : valable tant que la battue est publiée ou en cours.
CREATE FUNCTION app.guest_hunt_sheet(p_token_hash text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT app.hunt_sheet(hp.id) FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
     WHERE hp.guest_token_hash = p_token_hash AND h.status IN ('publiee', 'en_cours')
  $$;

-- ---------------------------------------------------------------------------
-- RLS : président et responsables gèrent les battues ; un chasseur voit
-- celles auxquelles il est convoqué (hors brouillon), en lecture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hunts', 'hunt_participants', 'hunt_posts', 'hunt_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$s_select ON %1$I FOR SELECT TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id())
                             AND (app.has_role('president', 'responsable')
                                  OR %2$s IN (SELECT app.my_hunt_ids())))$p$,
                   t, CASE WHEN t = 'hunts' THEN 'id' ELSE 'hunt_id' END);
    EXECUTE format($p$CREATE POLICY %1$s_write ON %1$I FOR ALL TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president', 'responsable'))
                      WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president', 'responsable'))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rls', t);
  END LOOP;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0006_lot4_battues.sql', 'f426149cd8b1513a0b82758c26b4239c60907d802225bb4629d38966f6abdc49');

COMMIT;
