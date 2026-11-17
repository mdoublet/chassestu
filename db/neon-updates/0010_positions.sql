-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0010_positions.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0010_positions.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0010_positions.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0009_vue_chasseur.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0009_vue_chasseur.sql';
  END IF;
END $guard$;

-- ==================== 0010_positions.sql ====================
-- Positions GPS en direct pendant une battue (spécification : « Envoi des
-- positions », « Sécurité et RGPD »).
--
-- * Consentement par battue : hunt_participants.position_shared_at (NULL = pas
--   de partage). Retirer son accord efface sa position.
-- * hunt_positions : la DERNIÈRE position de chaque participant, rien d'autre
--   (aucun historique de trajet). Écriture uniquement par app.report_position,
--   qui exige une battue en cours et le consentement.
-- * Lecture : président et responsables voient toutes les positions ; un
--   chasseur ne voit que la sienne. Pas de journal d'audit des positions.
-- * Purge : app.purge_positions() efface les positions plus anciennes que
--   tenants.position_retention_h (tâche planifiée du Worker, toutes les heures).

ALTER TABLE hunt_participants ADD COLUMN position_shared_at timestamptz;

CREATE TABLE hunt_positions (
  tenant_id      uuid NOT NULL,
  hunt_id        uuid NOT NULL,
  participant_id uuid NOT NULL,
  geom           geography(Point, 4326) NOT NULL,
  accuracy_m     real NOT NULL CHECK (accuracy_m >= 0 AND accuracy_m <= 100000),
  recorded_at    timestamptz NOT NULL,          -- heure de la mesure (téléphone)
  received_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hunt_id, participant_id),
  FOREIGN KEY (tenant_id, hunt_id) REFERENCES hunts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hunt_id, participant_id) REFERENCES hunt_participants (hunt_id, id) ON DELETE CASCADE
);
CREATE INDEX hunt_positions_recorded_idx ON hunt_positions (recorded_at);

ALTER TABLE hunt_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY hunt_positions_select ON hunt_positions FOR SELECT TO app_rls
  USING (tenant_id = app.current_tenant_id()
         AND (app.has_role('president', 'responsable')
              OR participant_id IN (SELECT id FROM hunt_participants WHERE user_id = app.current_user_id())));
GRANT SELECT ON hunt_positions TO app_rls;   -- écriture : fonctions ci-dessous uniquement

-- Participant connecté à la battue (de l'association courante), sinon erreur.
CREATE FUNCTION app.my_participant_id(p_hunt uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v uuid;
BEGIN
  SELECT hp.id INTO v FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
   WHERE hp.hunt_id = p_hunt AND hp.user_id = app.current_user_id()
     AND h.tenant_id = app.current_tenant_id();
  IF v IS NULL THEN
    RAISE EXCEPTION 'NOT_INVITED: vous ne participez pas à cette battue' USING ERRCODE = '42501';
  END IF;
  RETURN v;
END $$;

-- Donner ou retirer son accord pour cette battue. Retirer efface la position.
CREATE FUNCTION app.set_position_sharing(p_hunt uuid, p_share boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_participant uuid := app.my_participant_id(p_hunt);
BEGIN
  IF p_share AND (SELECT status FROM hunts WHERE id = p_hunt) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: le partage de position n’est possible que pendant la battue' USING ERRCODE = '23514';
  END IF;
  UPDATE hunt_participants SET position_shared_at = CASE WHEN p_share THEN coalesce(position_shared_at, now()) END
   WHERE id = v_participant AND (position_shared_at IS NULL) = p_share;
  IF NOT p_share THEN
    DELETE FROM hunt_positions WHERE participant_id = v_participant;
  END IF;
END $$;

-- Enregistre la dernière position (ignorée si plus ancienne que celle connue).
CREATE FUNCTION app.report_position(p_hunt uuid, p_lon double precision, p_lat double precision,
                                    p_accuracy real, p_recorded_at timestamptz) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_participant uuid := app.my_participant_id(p_hunt);
  v_at timestamptz := least(coalesce(p_recorded_at, now()), now());
BEGIN
  IF (SELECT status FROM hunts WHERE id = p_hunt) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: aucune position n’est enregistrée hors de la battue en cours' USING ERRCODE = '23514';
  END IF;
  IF (SELECT position_shared_at FROM hunt_participants WHERE id = v_participant) IS NULL THEN
    RAISE EXCEPTION 'POSITION_NOT_SHARED: partage de position non accepté pour cette battue' USING ERRCODE = '42501';
  END IF;
  IF v_at < now() - interval '15 minutes' THEN
    RETURN false;   -- trop vieille pour être utile en direct
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

-- Purge (toutes associations) : à appeler par la tâche planifiée.
CREATE FUNCTION app.purge_positions() RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH d AS (
    DELETE FROM hunt_positions p USING tenants t
     WHERE t.id = p.tenant_id AND p.recorded_at < now() - make_interval(hours => t.position_retention_h)
    RETURNING 1)
  SELECT count(*)::int FROM d;
$$;
REVOKE EXECUTE ON FUNCTION app.purge_positions() FROM PUBLIC, app_rls;

GRANT EXECUTE ON FUNCTION app.my_participant_id(uuid), app.set_position_sharing(uuid, boolean),
  app.report_position(uuid, double precision, double precision, real, timestamptz) TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0010_positions.sql', '42ed44ceddd585b3399d097563f4d22da6d2f3e341dc7f79f8a1e273c162d3c7');

COMMIT;
