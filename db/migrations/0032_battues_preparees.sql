-- Battues préparées d'avance : pendant une journée en cours, le président ou
-- un responsable crée la battue suivante « en préparation » (statut
-- brouillon) — plan, volontaires, postes, placement — même pendant une autre
-- battue. Invisible des chasseurs ; publier ses postes l'ouvre (brouillon →
-- en_cours), une fois la battue précédente terminée.

CREATE OR REPLACE FUNCTION app.check_hunt_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'brouillon' AND NEW.status IN ('publiee', 'annulee'))
    OR (OLD.status = 'publiee'   AND NEW.status IN ('en_cours', 'annulee', 'brouillon'))
    OR (OLD.status = 'en_cours'  AND NEW.status = 'terminee')
    -- Battue préparée d'avance (journée en cours) : ouverte à la publication de ses postes.
    OR (OLD.status = 'brouillon' AND NEW.status = 'en_cours' AND NEW.day_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'HUNT_BAD_TRANSITION: passage de « % » à « % » impossible', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'terminee' THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION app.check_hunt_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (SELECT status FROM hunts WHERE id = NEW.hunt_id) NOT IN ('en_cours', 'brouillon') THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: l''attribution n''est possible que pour une battue en cours ou en préparation'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'hunt_assignments' THEN
    IF NOT EXISTS (SELECT 1 FROM hunt_participants hp
                    WHERE hp.id = NEW.participant_id AND hp.present AND hp.role IN ('poste', 'chef_de_ligne')) THEN
      RAISE EXCEPTION 'PARTICIPANT_NOT_POSTED: seul un chasseur présent, posté ou chef de ligne, reçoit un poste'
        USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM hunt_assignments a
         WHERE a.hunt_id = NEW.hunt_id AND a.post_id = NEW.post_id AND a.id <> NEW.id) >= 2 THEN
      RAISE EXCEPTION 'POST_FULL: deux chasseurs au plus par poste'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION app.day_view_base(p_day uuid, p_dp uuid, p_overview boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  SELECT * INTO v_cur FROM hunts WHERE day_id = p_day AND status IN ('en_cours', 'terminee') ORDER BY number DESC LIMIT 1;
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
                  FROM hunts h JOIN territories t ON t.id = h.territory_id
                 WHERE h.day_id = p_day AND h.status IN ('en_cours', 'terminee')),
    -- Battue la plus récente : fiche personnelle si on y participe, vue
    -- d'ensemble pour un responsable, sinon rien (non volontaire).
    'current', CASE
      WHEN v_cur.id IS NULL THEN NULL
      WHEN v_hp IS NOT NULL THEN app.hunt_view(v_cur.id, v_hp)
      WHEN p_overview THEN app.hunt_view(v_cur.id, NULL)
      ELSE NULL END);
END $function$;
