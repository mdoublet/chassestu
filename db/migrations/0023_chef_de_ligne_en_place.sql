-- Le chef de ligne confirme la mise en place des chasseurs de sa ligne (un
-- par un, ou toute la ligne). Chacun peut toujours se déclarer « en place »
-- lui-même ou être vu sur son poste par le GPS. in_place_by : qui a confirmé
-- (NULL ou le chasseur lui-même : sa propre confirmation).

ALTER TABLE hunt_participants ADD COLUMN in_place_by text REFERENCES users (id) ON DELETE SET NULL;

-- Confirmation par le chasseur lui-même : elle remplace celle du chef.
CREATE OR REPLACE FUNCTION app.set_in_place_for(p_participant uuid, p_in_place boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT h.status FROM hunts h JOIN hunt_participants hp ON hp.hunt_id = h.id WHERE hp.id = p_participant) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: la confirmation se fait pendant la battue' USING ERRCODE = '23514';
  END IF;
  IF p_in_place AND NOT EXISTS (SELECT 1 FROM hunt_assignments WHERE participant_id = p_participant) THEN
    RAISE EXCEPTION 'NO_POST: aucun poste ne vous est attribué' USING ERRCODE = '23514';
  END IF;
  UPDATE hunt_participants SET in_place_at = CASE WHEN p_in_place THEN coalesce(in_place_at, now()) END, in_place_by = NULL
   WHERE id = p_participant AND ((in_place_at IS NULL) = p_in_place OR in_place_by IS NOT NULL);
END $$;
REVOKE EXECUTE ON FUNCTION app.set_in_place_for(uuid, boolean) FROM PUBLIC;

/**
 * Chef de ligne : confirme (ou annule) la mise en place d'un chasseur de sa
 * ligne, ou de toute sa ligne (p_participant NULL). Postes publiés, battue en
 * cours. Renvoie le nombre de chasseurs modifiés.
 */
CREATE FUNCTION app.chief_set_in_place(p_hunt uuid, p_participant uuid, p_in_place boolean) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_line uuid;
  v_n integer;
BEGIN
  SELECT p.line_id INTO v_line
    FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
    JOIN hunt_assignments a ON a.participant_id = hp.id JOIN posts p ON p.id = a.post_id
   WHERE hp.hunt_id = p_hunt AND hp.user_id = app.current_user_id() AND hp.role = 'chef_de_ligne'
     AND h.tenant_id = app.current_tenant_id();
  IF v_line IS NULL THEN
    RAISE EXCEPTION 'NOT_CHIEF: vous n''êtes pas chef d''une ligne dans cette battue' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hunts WHERE id = p_hunt AND status = 'en_cours' AND assignments_published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: postes non publiés ou battue terminée' USING ERRCODE = '23514';
  END IF;
  UPDATE hunt_participants hp
     SET in_place_at = CASE WHEN p_in_place THEN coalesce(hp.in_place_at, now()) END,
         in_place_by = CASE WHEN p_in_place THEN coalesce(CASE WHEN hp.in_place_at IS NOT NULL THEN hp.in_place_by END, app.current_user_id()) END
    FROM hunt_assignments a JOIN posts p ON p.id = a.post_id
   WHERE a.participant_id = hp.id AND a.hunt_id = p_hunt AND p.line_id = v_line
     AND (p_participant IS NULL OR hp.id = p_participant)
     AND (hp.in_place_at IS NULL) = p_in_place;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF p_participant IS NOT NULL AND v_n = 0 AND NOT EXISTS (
       SELECT 1 FROM hunt_assignments a JOIN posts p ON p.id = a.post_id
        WHERE a.participant_id = p_participant AND a.hunt_id = p_hunt AND p.line_id = v_line) THEN
    RAISE EXCEPTION 'NOT_IN_LINE: ce chasseur n''est pas dans votre ligne' USING ERRCODE = '42501';
  END IF;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION app.line_view_for(p_hunt uuid, p_dp uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hp   hunt_participants%ROWTYPE;
  v_line post_lines%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hunts h WHERE h.id = p_hunt AND h.assignments_published_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_hp FROM hunt_participants WHERE hunt_id = p_hunt AND day_participant_id = p_dp;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT l.* INTO v_line FROM hunt_assignments a JOIN posts p ON p.id = a.post_id JOIN post_lines l ON l.id = p.line_id
   WHERE a.hunt_id = p_hunt AND a.participant_id = v_hp.id;
  IF NOT FOUND THEN
    RETURN CASE WHEN v_hp.role = 'chef_de_ligne' THEN jsonb_build_object('name', NULL, 'chief', true, 'chiefs', '[]'::jsonb, 'members', '[]'::jsonb) END;
  END IF;
  RETURN (
    WITH m AS (
      SELECT hp.id AS participant_id, coalesce(u.display_name, hp.guest_name) AS name, hp.role, p.number, p.name AS post_name,
             hp.in_place_at, hp.in_place_by IS NOT NULL AND hp.in_place_by <> coalesce(hp.user_id, '') AS by_chief, hp.id = v_hp.id AS me
        FROM hunt_assignments a
        JOIN posts p ON p.id = a.post_id
        JOIN hunt_participants hp ON hp.id = a.participant_id
        LEFT JOIN users u ON u.id = hp.user_id
       WHERE a.hunt_id = p_hunt AND p.line_id = v_line.id)
    SELECT jsonb_build_object(
      'name', v_line.name,
      'chief', v_hp.role = 'chef_de_ligne',
      'chiefs', coalesce((SELECT jsonb_agg(jsonb_build_object('name', m.name, 'post_number', m.number, 'me', m.me) ORDER BY m.number)
                            FROM m WHERE m.role = 'chef_de_ligne'), '[]'::jsonb),
      'members', CASE WHEN v_hp.role = 'chef_de_ligne' THEN
                   coalesce((SELECT jsonb_agg(jsonb_build_object('participant_id', m.participant_id, 'name', m.name, 'post_number', m.number,
                                                                 'post_name', m.post_name, 'in_place_at', m.in_place_at, 'by_chief', m.by_chief,
                                                                 'chief', m.role = 'chef_de_ligne', 'me', m.me)
                                              ORDER BY m.number, m.name) FROM m), '[]'::jsonb)
                 END)
  );
END $$;


REVOKE ALL ON FUNCTION app.chief_set_in_place(uuid, uuid, boolean), app.line_view_for(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.chief_set_in_place(uuid, uuid, boolean) TO app_rls;
