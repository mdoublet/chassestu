-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0022_animal_blesse_vu.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0022_animal_blesse_vu.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0022_animal_blesse_vu.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0021_saisons.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0021_saisons.sql';
  END IF;
END $guard$;

-- ==================== 0022_animal_blesse_vu.sql ====================
-- Déclaration d'un animal : tué, blessé (recherche au sang, sécurité) ou vu.
-- Seuls les animaux tués comptent dans les prélèvements et les quotas.
-- Chaque déclaration alerte les participants de la battue.

ALTER TABLE hunt_harvests ADD COLUMN outcome text NOT NULL DEFAULT 'tue' CHECK (outcome IN ('tue', 'blesse', 'vu'));

DROP FUNCTION app.declare_harvest(uuid, text, text, text);
CREATE FUNCTION app.declare_harvest(p_hunt uuid, p_species text, p_category text, p_notes text, p_outcome text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_participant uuid;
  v_id uuid;
BEGIN
  SELECT hp.id INTO v_participant FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
   WHERE hp.hunt_id = p_hunt AND hp.user_id = app.current_user_id()
     AND h.tenant_id = app.current_tenant_id();
  IF v_participant IS NULL THEN
    RAISE EXCEPTION 'NOT_INVITED: vous ne participez pas à cette battue' USING ERRCODE = '42501';
  END IF;
  IF (SELECT status FROM hunts WHERE id = p_hunt) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: on déclare un animal pendant la battue' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hunt_harvests (tenant_id, hunt_id, species, category, participant_id, notes, recorded_by, outcome)
  SELECT h.tenant_id, p_hunt, btrim(p_species), coalesce(p_category, 'indetermine'), v_participant, coalesce(p_notes, ''),
         app.current_user_id(), coalesce(p_outcome, 'tue')
    FROM hunts h WHERE h.id = p_hunt
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

/** État (tué, blessé, vu) de déclarations : complète les vues chasseur. */
CREATE FUNCTION app.harvest_outcomes(p_ids uuid[]) RETURNS TABLE (id uuid, outcome text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT hh.id, hh.outcome FROM hunt_harvests hh WHERE hh.id = ANY (p_ids)
$$;

/**
 * Alerte d'une déclaration à tous les participants présents de la battue (et
 * à son responsable), sauf à son auteur. Appelant : participant de la battue
 * ou président / organisateur.
 */
CREATE FUNCTION app.notify_harvest(p_harvest uuid)
  RETURNS TABLE (user_id text, title text, body text, endpoint text, p256dh text, auth text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v record;
  v_title text;
  v_body text;
BEGIN
  SELECT hh.*, h.number AS hunt_number, h.day_id, h.tenant_id AS t_id, h.leader_user_id,
         coalesce(u.display_name, x.guest_name) AS shooter,
         (SELECT p.number FROM hunt_assignments a JOIN posts p ON p.id = a.post_id WHERE a.participant_id = hh.participant_id) AS post_number
    INTO v
    FROM hunt_harvests hh JOIN hunts h ON h.id = hh.hunt_id
    LEFT JOIN hunt_participants x ON x.id = hh.participant_id LEFT JOIN users u ON u.id = x.user_id
   WHERE hh.id = p_harvest;
  IF v.id IS NULL OR v.t_id IS DISTINCT FROM app.current_tenant_id()
     OR NOT (app.has_role('president', 'responsable')
             OR EXISTS (SELECT 1 FROM hunt_participants hp WHERE hp.hunt_id = v.hunt_id AND hp.user_id = app.current_user_id())) THEN
    RAISE EXCEPTION 'FORBIDDEN: notification non autorisée' USING ERRCODE = '42501';
  END IF;
  v_title := CASE v.outcome WHEN 'tue' THEN v.species || ' tué' WHEN 'blesse' THEN '⚠ ' || v.species || ' blessé' ELSE v.species || ' vu' END
             || CASE WHEN v.category <> 'indetermine' AND v.outcome <> 'vu' THEN ' (' || CASE v.category WHEN 'male' THEN 'mâle' ELSE v.category END || ')' ELSE '' END;
  v_body := 'Battue n° ' || v.hunt_number
            || CASE WHEN v.post_number IS NOT NULL THEN ' · poste ' || v.post_number ELSE '' END
            || CASE WHEN v.shooter IS NOT NULL THEN ' · ' || v.shooter ELSE '' END
            || CASE v.outcome WHEN 'blesse' THEN '. Ne bougez pas : recherche au signal du responsable.' ELSE '.' END;
  RETURN QUERY
    WITH dest AS (
      SELECT DISTINCT hp.user_id FROM hunt_participants hp
       WHERE hp.hunt_id = v.hunt_id AND hp.present AND hp.user_id IS NOT NULL
      UNION SELECT v.leader_user_id WHERE v.leader_user_id IS NOT NULL
    ), ins AS (
      INSERT INTO notifications (tenant_id, user_id, hunt_id, day_id, kind, title, body, url)
      SELECT v.t_id, d.user_id, v.hunt_id, v.day_id, 'animal', v_title, v_body, '#/journees/' || v.day_id
        FROM dest d WHERE d.user_id IS DISTINCT FROM app.current_user_id()
      RETURNING notifications.user_id, notifications.title, notifications.body
    )
    SELECT ins.user_id, ins.title, ins.body, s.endpoint, s.p256dh, s.auth
      FROM ins LEFT JOIN push_subscriptions s ON s.user_id = ins.user_id;
END $$;

REVOKE ALL ON FUNCTION app.declare_harvest(uuid, text, text, text, text), app.harvest_outcomes(uuid[]), app.notify_harvest(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.declare_harvest(uuid, text, text, text, text), app.harvest_outcomes(uuid[]), app.notify_harvest(uuid) TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0022_animal_blesse_vu.sql', '4fa5aeab83cc8d52884e1b8648683de4baec51ca4d6a229953783880d1452532');

COMMIT;
