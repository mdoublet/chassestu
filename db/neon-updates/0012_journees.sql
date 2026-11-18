-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0012_journees.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0012_journees.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0012_journees.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0011_guidage.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0011_guidage.sql';
  END IF;
END $guard$;

-- ==================== 0012_journees.sql ====================
-- Journées de chasse.
--
-- Les chasseurs sont convoqués à une JOURNÉE (date, heure et lieu de
-- rendez-vous, déjeuner facultatif). Le jour J, l'organisateur ajuste les
-- présents (et ajoute des invités), puis enchaîne les BATTUES : territoire,
-- volontaires parmi les présents, postes, espèces, publication, début, fin,
-- puis regroupement à un point de rendez-vous avant la battue suivante.
--
-- * hunt_days / day_participants : convocation, réponse, déjeuner, présence,
--   voiture et marche du jour, lien invité, accord de partage GPS (journée).
-- * hunts devient une battue de la journée (day_id, number) ; ses
--   participants (hunt_participants) sont les volontaires de cette battue.
-- * Profil : capacité de marche (1 à 5), voiture et places libres.
-- * Postes : difficulté d'accès (1 à 5), estimée d'après le chemin sinon.
-- * Association : nombre maximal de chasseurs par voiture (covoiturage).
--
-- Conversion : chaque ancienne battue devient une journée de même
-- identifiant ; ses participants deviennent ceux de la journée (mêmes
-- identifiants). Les battues pas encore commencées (brouillon, publiée,
-- annulée) ne gardent que la journée : la battue sera créée le jour J.

CREATE TYPE day_status AS ENUM ('brouillon', 'convoquee', 'en_cours', 'terminee', 'annulee');

-- ---------------------------------------------------------------------------
-- Profil, postes, association
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN walking_ability smallint CHECK (walking_ability BETWEEN 1 AND 5),
  ADD COLUMN has_car boolean,
  ADD COLUMN car_seats smallint CHECK (car_seats BETWEEN 0 AND 8);
GRANT UPDATE (walking_ability, has_car, car_seats) ON users TO app_rls;

ALTER TABLE posts ADD COLUMN access_difficulty smallint CHECK (access_difficulty BETWEEN 1 AND 5);

ALTER TABLE tenants ADD COLUMN hunters_per_car smallint NOT NULL DEFAULT 4 CHECK (hunters_per_car BETWEEN 2 AND 9);
GRANT UPDATE (hunters_per_car) ON tenants TO app_rls;

-- Difficulté d'accès d'un poste : celle saisie par le président, sinon estimée
-- d'après la longueur du chemin depuis le parking ; NULL si rien n'est connu.
CREATE FUNCTION app.post_difficulty(p_manual smallint, p_path geometry) RETURNS smallint
  LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_manual, CASE
    WHEN p_path IS NULL THEN NULL
    WHEN ST_Length(p_path::geography) <= 100 THEN 1
    WHEN ST_Length(p_path::geography) <= 300 THEN 2
    WHEN ST_Length(p_path::geography) <= 600 THEN 3
    WHEN ST_Length(p_path::geography) <= 1000 THEN 4
    ELSE 5 END)::smallint;
$$;

-- ---------------------------------------------------------------------------
-- Journées
-- ---------------------------------------------------------------------------

CREATE TABLE hunt_days (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants (id) ON DELETE CASCADE,
  date           date NOT NULL,
  meeting_time   time NOT NULL DEFAULT '08:00',
  meeting_place  text NOT NULL DEFAULT '' CHECK (length(meeting_place) <= 200),
  meeting_point  geometry(Point, 4326),
  briefing       text NOT NULL DEFAULT '' CHECK (length(briefing) <= 5000),
  lunch_offered  boolean NOT NULL DEFAULT false,
  lunch_info     text NOT NULL DEFAULT '' CHECK (length(lunch_info) <= 300),
  leader_user_id text REFERENCES users (id) ON DELETE SET NULL,
  status         day_status NOT NULL DEFAULT 'brouillon',
  started_at     timestamptz,
  ended_at       timestamptz,
  -- Regroupement après une battue (lieu, point, heure), annoncé aux présents.
  regroup_place  text NOT NULL DEFAULT '' CHECK (length(regroup_place) <= 200),
  regroup_point  geometry(Point, 4326),
  regroup_time   time,
  regroup_at     timestamptz,
  revision       bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX hunt_days_tenant_date_idx ON hunt_days (tenant_id, date DESC);

CREATE TABLE day_participants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT app.current_tenant_id(),
  day_id             uuid NOT NULL,
  user_id            text REFERENCES users (id) ON DELETE CASCADE,
  guest_name         text CHECK (length(btrim(guest_name)) BETWEEN 1 AND 120),
  response           text CHECK (response IN ('present', 'absent')),
  lunch              boolean NOT NULL DEFAULT false,
  present            boolean NOT NULL DEFAULT false,
  -- Valeurs du jour (sinon celles du profil) : invité, voiture laissée, etc.
  walking_ability    smallint CHECK (walking_ability BETWEEN 1 AND 5),
  has_car            boolean,
  car_seats          smallint CHECK (car_seats BETWEEN 0 AND 8),
  guest_token_hash   text UNIQUE,
  position_shared_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day_id, user_id),
  UNIQUE (day_id, id),
  FOREIGN KEY (tenant_id, day_id) REFERENCES hunt_days (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT day_participant_member_or_guest CHECK ((user_id IS NULL) <> (guest_name IS NULL)),
  CONSTRAINT day_guest_token_only_for_guests CHECK (guest_token_hash IS NULL OR user_id IS NULL)
);
CREATE INDEX day_participants_user_idx ON day_participants (user_id);

-- ---------------------------------------------------------------------------
-- Conversion des battues existantes
-- ---------------------------------------------------------------------------

ALTER TABLE hunts ADD COLUMN day_id uuid, ADD COLUMN number smallint;
ALTER TABLE hunt_participants ADD COLUMN day_participant_id uuid;

INSERT INTO hunt_days (id, tenant_id, date, meeting_time, meeting_place, meeting_point, briefing, leader_user_id,
                       status, started_at, ended_at, created_at)
SELECT h.id, h.tenant_id, h.date, h.meeting_time, h.meeting_place, h.meeting_point, h.briefing, h.leader_user_id,
       CASE h.status WHEN 'publiee' THEN 'convoquee' ELSE h.status::text END::day_status,
       CASE WHEN h.status IN ('en_cours', 'terminee') THEN coalesce(h.started_at, h.created_at) END,
       h.ended_at, h.created_at
  FROM hunts h;

INSERT INTO day_participants (id, tenant_id, day_id, user_id, guest_name, response, present,
                              guest_token_hash, position_shared_at, created_at)
SELECT hp.id, hp.tenant_id, hp.hunt_id, hp.user_id, hp.guest_name, hp.response, hp.present,
       hp.guest_token_hash, hp.position_shared_at, hp.created_at
  FROM hunt_participants hp;

UPDATE hunts SET day_id = id, number = 1;
UPDATE hunt_participants SET day_participant_id = id, guest_token_hash = NULL;

-- Alertes : rattachées à la journée ; elles survivent à la suppression d'une battue.
ALTER TABLE notifications ADD COLUMN day_id uuid REFERENCES hunt_days (id) ON DELETE CASCADE;
UPDATE notifications n SET day_id = h.day_id, url = '#/journees/' || h.day_id FROM hunts h WHERE h.id = n.hunt_id;
ALTER TABLE notifications DROP CONSTRAINT notifications_hunt_id_fkey,
  ADD CONSTRAINT notifications_hunt_id_fkey FOREIGN KEY (hunt_id) REFERENCES hunts (id) ON DELETE SET NULL;

-- Une battue n'existe qu'à partir du jour J.
DELETE FROM hunts WHERE status IN ('brouillon', 'publiee', 'annulee');

ALTER TABLE hunts ALTER COLUMN day_id SET NOT NULL, ALTER COLUMN number SET NOT NULL,
  ADD CONSTRAINT hunts_day_fkey FOREIGN KEY (tenant_id, day_id) REFERENCES hunt_days (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT hunts_day_number_key UNIQUE (day_id, number);
ALTER TABLE hunt_participants ALTER COLUMN day_participant_id SET NOT NULL,
  ADD CONSTRAINT hunt_participants_day_participant_fkey FOREIGN KEY (day_participant_id) REFERENCES day_participants (id) ON DELETE CASCADE,
  ADD CONSTRAINT hunt_participants_day_participant_key UNIQUE (hunt_id, day_participant_id);
ALTER TABLE hunt_participants DROP COLUMN position_shared_at;

-- ---------------------------------------------------------------------------
-- Règles : statut de la journée, numéro de version
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.check_day_status() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'brouillon' AND NEW.status IN ('convoquee', 'annulee'))
    OR (OLD.status = 'convoquee' AND NEW.status IN ('en_cours', 'annulee', 'brouillon'))
    OR (OLD.status = 'en_cours'  AND NEW.status = 'terminee')) THEN
    RAISE EXCEPTION 'DAY_BAD_TRANSITION: passage de « % » à « % » impossible', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'en_cours' THEN
    NEW.started_at := now();
  ELSIF NEW.status = 'terminee' THEN
    IF EXISTS (SELECT 1 FROM hunts WHERE day_id = NEW.id AND status = 'en_cours') THEN
      RAISE EXCEPTION 'BATTUE_RUNNING: terminez d''abord la battue en cours' USING ERRCODE = '23514';
    END IF;
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hunt_days_status BEFORE UPDATE OF status ON hunt_days
  FOR EACH ROW EXECUTE FUNCTION app.check_day_status();
CREATE TRIGGER hunt_days_touch BEFORE UPDATE ON hunt_days FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER hunt_days_revision BEFORE UPDATE ON hunt_days FOR EACH ROW EXECUTE FUNCTION app.hunt_own_revision();

-- Toute modification d'une battue ou des participants change la version de la journée.
CREATE FUNCTION app.bump_day_revision() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE hunt_days SET revision = revision + 1 WHERE id = coalesce(NEW.day_id, OLD.day_id);
  RETURN NULL;
END $$;
CREATE TRIGGER day_participants_revision AFTER INSERT OR UPDATE OR DELETE ON day_participants
  FOR EACH ROW EXECUTE FUNCTION app.bump_day_revision();
CREATE TRIGGER hunts_day_revision AFTER INSERT OR UPDATE OR DELETE ON hunts
  FOR EACH ROW EXECUTE FUNCTION app.bump_day_revision();

CREATE TRIGGER hunt_days_audit AFTER INSERT OR UPDATE OR DELETE ON hunt_days
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER day_participants_audit AFTER INSERT OR UPDATE OR DELETE ON day_participants
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

-- ---------------------------------------------------------------------------
-- Accès
-- ---------------------------------------------------------------------------

-- Journées (hors brouillon) auxquelles l'utilisateur courant est convoqué.
CREATE FUNCTION app.my_day_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT dp.day_id FROM day_participants dp JOIN hunt_days d ON d.id = dp.day_id
     WHERE dp.user_id = app.current_user_id() AND d.status <> 'brouillon'
       AND d.tenant_id = app.current_tenant_id()
  $$;

ALTER TABLE hunt_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY hunt_days_select ON hunt_days FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND (app.has_role('president', 'responsable') OR id IN (SELECT app.my_day_ids())));
CREATE POLICY day_participants_select ON day_participants FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND (app.has_role('president', 'responsable') OR day_id IN (SELECT app.my_day_ids())));
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hunt_days', 'day_participants'] LOOP
    EXECUTE format($p$CREATE POLICY %1$s_write ON %1$I FOR ALL TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president', 'responsable'))
                      WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president', 'responsable'))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rls', t);
  END LOOP;
END $$;

-- Réponse à une convocation (journée convoquée), avec le déjeuner.
CREATE FUNCTION app.respond_day(p_day uuid, p_response text, p_lunch boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_response NOT IN ('present', 'absent') THEN
    RAISE EXCEPTION 'INVALID: réponse inconnue' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hunt_days WHERE id = p_day AND status = 'convoquee'
                    AND tenant_id = app.current_tenant_id()) THEN
    RAISE EXCEPTION 'DAY_NOT_OPEN: on ne répond qu''à une journée convoquée, avant son début' USING ERRCODE = '23514';
  END IF;
  UPDATE day_participants
     SET response = p_response,
         lunch = p_response = 'present' AND coalesce(p_lunch, false)
                 AND (SELECT lunch_offered FROM hunt_days WHERE id = p_day)
   WHERE day_id = p_day AND user_id = app.current_user_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_INVITED: vous n''êtes pas convoqué à cette journée' USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Positions GPS : accord donné une fois pour la journée
-- ---------------------------------------------------------------------------

DROP FUNCTION app.set_position_sharing(uuid, boolean);

CREATE FUNCTION app.set_day_position_sharing(p_day uuid, p_share boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_dp uuid;
BEGIN
  SELECT dp.id INTO v_dp FROM day_participants dp JOIN hunt_days d ON d.id = dp.day_id
   WHERE dp.day_id = p_day AND dp.user_id = app.current_user_id() AND d.tenant_id = app.current_tenant_id();
  IF v_dp IS NULL THEN
    RAISE EXCEPTION 'NOT_INVITED: vous ne participez pas à cette journée' USING ERRCODE = '42501';
  END IF;
  IF p_share AND (SELECT status FROM hunt_days WHERE id = p_day) <> 'en_cours' THEN
    RAISE EXCEPTION 'DAY_NOT_RUNNING: le partage de position n’est possible que pendant la journée' USING ERRCODE = '23514';
  END IF;
  UPDATE day_participants SET position_shared_at = CASE WHEN p_share THEN coalesce(position_shared_at, now()) END
   WHERE id = v_dp AND (position_shared_at IS NULL) = p_share;
  IF NOT p_share THEN
    DELETE FROM hunt_positions WHERE participant_id IN (SELECT id FROM hunt_participants WHERE day_participant_id = v_dp);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.report_position(p_hunt uuid, p_lon double precision, p_lat double precision,
                                               p_accuracy real, p_recorded_at timestamptz) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_participant uuid := app.my_participant_id(p_hunt);
  v_at timestamptz := least(coalesce(p_recorded_at, now()), now());
BEGIN
  IF (SELECT status FROM hunts WHERE id = p_hunt) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: aucune position n’est enregistrée hors de la battue en cours' USING ERRCODE = '23514';
  END IF;
  IF (SELECT dp.position_shared_at FROM hunt_participants hp JOIN day_participants dp ON dp.id = hp.day_participant_id
       WHERE hp.id = v_participant) IS NULL THEN
    RAISE EXCEPTION 'POSITION_NOT_SHARED: partage de position non accepté pour cette journée' USING ERRCODE = '42501';
  END IF;
  IF v_at < now() - interval '15 minutes' THEN
    RETURN false;
  END IF;
  INSERT INTO hunt_positions (tenant_id, hunt_id, participant_id, geom, accuracy_m, recorded_at)
  SELECT h.tenant_id, p_hunt, v_participant, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography, p_accuracy, v_at
    FROM hunts h WHERE h.id = p_hunt
  ON CONFLICT (hunt_id, participant_id) DO UPDATE
     SET geom = EXCLUDED.geom, accuracy_m = EXCLUDED.accuracy_m,
         recorded_at = EXCLUDED.recorded_at, received_at = now()
   WHERE hunt_positions.recorded_at < EXCLUDED.recorded_at;
  RETURN true;
END $$;

-- Invité : « Je suis en place » sur la battue en cours de sa journée.
CREATE OR REPLACE FUNCTION app.guest_set_in_place(p_token_hash text, p_in_place boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v uuid;
BEGIN
  SELECT hp.id INTO v
    FROM day_participants dp
    JOIN hunt_days d ON d.id = dp.day_id AND d.status = 'en_cours'
    JOIN hunts h ON h.day_id = d.id AND h.status = 'en_cours'
    JOIN hunt_participants hp ON hp.hunt_id = h.id AND hp.day_participant_id = dp.id
   WHERE dp.guest_token_hash = p_token_hash;
  IF v IS NULL THEN
    IF EXISTS (SELECT 1 FROM day_participants dp JOIN hunt_days d ON d.id = dp.day_id
                WHERE dp.guest_token_hash = p_token_hash AND d.status IN ('convoquee', 'en_cours')) THEN
      RAISE EXCEPTION 'NO_POST: aucune battue en cours pour vous' USING ERRCODE = '23514';
    END IF;
    RETURN false;
  END IF;
  PERFORM app.set_in_place_for(v, p_in_place);
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- Vue chasseur de la journée
-- ---------------------------------------------------------------------------

-- p_dp : participant de la journée (NULL : responsable non convoqué).
-- p_overview : vue d'ensemble de la battue en cours si p_dp n'y participe pas.
CREATE FUNCTION app.day_view_base(p_day uuid, p_dp uuid, p_overview boolean) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_d   hunt_days%ROWTYPE;
  v_dp  day_participants%ROWTYPE;
  v_u   users%ROWTYPE;
  v_cur hunts%ROWTYPE;
  v_hp  uuid;
BEGIN
  SELECT * INTO v_d FROM hunt_days WHERE id = p_day;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF p_dp IS NOT NULL THEN
    SELECT * INTO v_dp FROM day_participants WHERE id = p_dp AND day_id = p_day;
    SELECT * INTO v_u FROM users WHERE id = v_dp.user_id;
  END IF;
  SELECT * INTO v_cur FROM hunts WHERE day_id = p_day ORDER BY number DESC LIMIT 1;
  IF v_cur.id IS NOT NULL AND v_dp.id IS NOT NULL THEN
    SELECT id INTO v_hp FROM hunt_participants WHERE hunt_id = v_cur.id AND day_participant_id = v_dp.id;
  END IF;

  RETURN jsonb_build_object(
    'revision', v_d.revision,
    'gps_tolerance_m', (SELECT gps_tolerance_m FROM tenants WHERE id = v_d.tenant_id),
    'day', jsonb_build_object(
      'id', v_d.id, 'date', v_d.date, 'meeting_time', to_char(v_d.meeting_time, 'HH24:MI'),
      'meeting_place', v_d.meeting_place, 'meeting_point', ST_AsGeoJSON(v_d.meeting_point, 7)::jsonb,
      'briefing', v_d.briefing, 'lunch_offered', v_d.lunch_offered, 'lunch_info', v_d.lunch_info,
      'status', v_d.status, 'started_at', v_d.started_at, 'ended_at', v_d.ended_at,
      'leader', (SELECT display_name FROM users WHERE id = v_d.leader_user_id),
      'regroup', CASE WHEN v_d.regroup_at IS NULL THEN NULL ELSE jsonb_build_object(
        'place', v_d.regroup_place, 'point', ST_AsGeoJSON(v_d.regroup_point, 7)::jsonb,
        'time', to_char(v_d.regroup_time, 'HH24:MI'), 'at', v_d.regroup_at) END,
      'present_count', (SELECT count(*) FROM day_participants x WHERE x.day_id = p_day AND x.present),
      'lunch_count', (SELECT count(*) FROM day_participants x WHERE x.day_id = p_day AND x.lunch)),
    'me', CASE WHEN v_dp.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_dp.id, 'name', coalesce(v_u.display_name, v_dp.guest_name), 'guest', v_dp.user_id IS NULL,
      'response', v_dp.response, 'lunch', v_dp.lunch, 'present', v_dp.present,
      'sharing', v_dp.position_shared_at IS NOT NULL,
      'has_car', coalesce(v_dp.has_car, v_u.has_car), 'car_seats', coalesce(v_dp.car_seats, v_u.car_seats),
      'walking_ability', coalesce(v_dp.walking_ability, v_u.walking_ability)) END,
    'battues', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'id', h.id, 'number', h.number, 'territory_name', t.name, 'status', h.status,
                   'started_at', h.started_at, 'ended_at', h.ended_at,
                   'assignments_published', h.assignments_published_at IS NOT NULL,
                   'selected', EXISTS (SELECT 1 FROM hunt_participants x WHERE x.hunt_id = h.id AND x.day_participant_id = v_dp.id))
                   ORDER BY h.number), '[]')
                  FROM hunts h JOIN territories t ON t.id = h.territory_id WHERE h.day_id = p_day),
    -- Battue la plus récente : fiche personnelle si on y participe, vue
    -- d'ensemble pour un responsable, sinon rien (non volontaire).
    'current', CASE
      WHEN v_cur.id IS NULL THEN NULL
      WHEN v_hp IS NOT NULL THEN app.hunt_view(v_cur.id, v_hp)
      WHEN p_overview THEN app.hunt_view(v_cur.id, NULL)
      ELSE NULL END);
END $$;

-- Membre : convoqué (journée hors brouillon) ou responsable.
CREATE FUNCTION app.view_day(p_day uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_dp uuid;
  v_manager boolean := app.has_role('president', 'responsable');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hunt_days WHERE id = p_day AND tenant_id = app.current_tenant_id()) THEN
    RETURN NULL;
  END IF;
  SELECT dp.id INTO v_dp FROM day_participants dp
   WHERE dp.day_id = p_day AND dp.user_id = app.current_user_id() AND p_day IN (SELECT app.my_day_ids());
  IF v_dp IS NULL AND NOT v_manager THEN
    RETURN NULL;
  END IF;
  RETURN app.day_view_base(p_day, v_dp, v_manager);
END $$;

-- Invité : par son lien, tant que la journée est convoquée ou en cours.
CREATE FUNCTION app.guest_day_view(p_token_hash text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.day_view_base(dp.day_id, dp.id, false)
    FROM day_participants dp JOIN hunt_days d ON d.id = dp.day_id
   WHERE dp.guest_token_hash = p_token_hash AND d.status IN ('convoquee', 'en_cours')
$$;

-- Personnes d'une battue pour le covoiturage (parking, voiture, marche).
-- Responsable de l'association ou participant de la battue.
CREATE FUNCTION app.battue_people(p_hunt uuid)
  RETURNS TABLE (participant_id uuid, name text, role hunt_role, guest boolean, post_number int,
                 parking_id uuid, parking_name text, parking_lon double precision, parking_lat double precision,
                 has_car boolean, car_seats int, walking_ability int, mine boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hunts h WHERE h.id = p_hunt AND h.tenant_id = app.current_tenant_id())
     OR NOT (app.has_role('president', 'responsable')
             OR EXISTS (SELECT 1 FROM hunt_participants x WHERE x.hunt_id = p_hunt AND x.user_id = app.current_user_id())) THEN
    RAISE EXCEPTION 'NOT_FOUND: battue introuvable' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
    SELECT hp.id, coalesce(u.display_name, hp.guest_name), hp.role, hp.user_id IS NULL, p.number::int,
           pk.id, pk.name, ST_X(pk.geom), ST_Y(pk.geom),
           coalesce(dp.has_car, u.has_car, false), coalesce(dp.car_seats, u.car_seats, 0)::int,
           coalesce(dp.walking_ability, u.walking_ability)::int,
           hp.user_id IS NOT NULL AND hp.user_id = app.current_user_id()
      FROM hunt_participants hp
      JOIN day_participants dp ON dp.id = hp.day_participant_id
      LEFT JOIN users u ON u.id = hp.user_id
      LEFT JOIN hunt_assignments a ON a.participant_id = hp.id
      LEFT JOIN posts p ON p.id = a.post_id
      LEFT JOIN parkings pk ON pk.id = p.parking_id
     WHERE hp.hunt_id = p_hunt AND hp.present;
END $$;

-- ---------------------------------------------------------------------------
-- Alertes de la journée (convocation, annulation, regroupement)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.notify_day_users(p_day uuid, p_kind text, p_url text, p_items jsonb)
  RETURNS TABLE (user_id text, title text, body text, endpoint text, p256dh text, auth text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT d.tenant_id INTO v_tenant FROM hunt_days d WHERE d.id = p_day;
  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM app.current_tenant_id()
     OR NOT app.has_role('president', 'responsable') THEN
    RAISE EXCEPTION 'FORBIDDEN: notification non autorisée' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    WITH items AS (
      SELECT i.user_id, left(i.title, 200) AS title, left(coalesce(i.body, ''), 1000) AS body
        FROM jsonb_to_recordset(p_items) AS i(user_id text, title text, body text)
       WHERE EXISTS (SELECT 1 FROM day_participants dp WHERE dp.day_id = p_day AND dp.user_id = i.user_id)
    ), ins AS (
      INSERT INTO notifications (tenant_id, user_id, day_id, kind, title, body, url)
      SELECT v_tenant, items.user_id, p_day, p_kind, items.title, items.body, p_url FROM items
      RETURNING notifications.user_id, notifications.title, notifications.body
    )
    SELECT ins.user_id, ins.title, ins.body, s.endpoint, s.p256dh, s.auth
      FROM ins LEFT JOIN push_subscriptions s ON s.user_id = ins.user_id;
END $$;

-- Alertes d'une battue : rattachées aussi à sa journée.
CREATE OR REPLACE FUNCTION app.notify_users(p_hunt uuid, p_kind text, p_url text, p_items jsonb)
  RETURNS TABLE (user_id text, title text, body text, endpoint text, p256dh text, auth text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
  v_day uuid;
BEGIN
  SELECT h.tenant_id, h.day_id INTO v_tenant, v_day FROM hunts h WHERE h.id = p_hunt;
  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM app.current_tenant_id()
     OR NOT app.has_role('president', 'responsable') THEN
    RAISE EXCEPTION 'FORBIDDEN: notification non autorisée' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    WITH items AS (
      SELECT i.user_id, left(i.title, 200) AS title, left(coalesce(i.body, ''), 1000) AS body
        FROM jsonb_to_recordset(p_items) AS i(user_id text, title text, body text)
       WHERE EXISTS (SELECT 1 FROM hunt_participants hp WHERE hp.hunt_id = p_hunt AND hp.user_id = i.user_id)
    ), ins AS (
      INSERT INTO notifications (tenant_id, user_id, hunt_id, day_id, kind, title, body, url)
      SELECT v_tenant, items.user_id, p_hunt, v_day, p_kind, items.title, items.body, p_url FROM items
      RETURNING notifications.user_id, notifications.title, notifications.body
    )
    SELECT ins.user_id, ins.title, ins.body, s.endpoint, s.p256dh, s.auth
      FROM ins LEFT JOIN push_subscriptions s ON s.user_id = ins.user_id;
END $$;

-- Anciennes fiches (battue seule) : remplacées par la vue de la journée.
DROP FUNCTION app.my_hunt_sheet(uuid);
DROP FUNCTION app.guest_hunt_sheet(text);
DROP FUNCTION app.view_hunt(uuid);
DROP FUNCTION app.hunt_sheet(uuid);
DROP FUNCTION app.respond_hunt(uuid, text);

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_day_ids(), app.respond_day(uuid, text, boolean),
  app.set_day_position_sharing(uuid, boolean), app.view_day(uuid), app.guest_day_view(text),
  app.battue_people(uuid), app.notify_day_users(uuid, text, text, jsonb), app.post_difficulty(smallint, geometry),
  app.report_position(uuid, double precision, double precision, real, timestamptz),
  app.guest_set_in_place(text, boolean), app.notify_users(uuid, text, text, jsonb) TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0012_journees.sql', '8c7094db37c35c94b05cfa80d36b1f7e3d8e39ed36995db2769f72423bad781d');

COMMIT;
