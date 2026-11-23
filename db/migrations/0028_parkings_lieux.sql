-- Parkings = lieux de l'association (type « parking »), indépendants des
-- territoires : un même parking peut desservir des postes de plusieurs
-- territoires, et tous les lieux s'affichent sur les cartes des territoires.
-- Les parkings existants deviennent des lieux publics avec le même identifiant
-- (postes, chemins et covoiturage inchangés) ; un nom déjà pris reçoit le nom
-- de son territoire entre parenthèses.


DO $$
DECLARE
  r      record;
  v_name text;
  n      int;
BEGIN
  FOR r IN SELECT pk.*, t.name AS territory_name FROM parkings pk JOIN territories t ON t.id = pk.territory_id
            ORDER BY pk.created_at, pk.id LOOP
    v_name := r.name;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM places p WHERE p.tenant_id = r.tenant_id AND p.visibility = 'public' AND p.name = v_name) LOOP
      v_name := left(r.name, 150) || ' (' || left(r.territory_name, 40) || CASE WHEN n > 1 THEN ' ' || n ELSE '' END || ')';
      n := n + 1;
    END LOOP;
    INSERT INTO places (id, tenant_id, name, kind, geom, notes, visibility, created_at, updated_at)
    VALUES (r.id, r.tenant_id, v_name, 'parking', r.geom, '', 'public', r.created_at, r.updated_at);
  END LOOP;
END $$;

ALTER TABLE posts DROP CONSTRAINT posts_tenant_id_parking_id_fkey;
ALTER TABLE posts ADD CONSTRAINT posts_tenant_id_parking_id_fkey FOREIGN KEY (tenant_id, parking_id)
  REFERENCES places (tenant_id, id) ON DELETE SET NULL (parking_id);

DROP TABLE parkings;

-- Parking d'un poste déduit de son chemin : le parking public le plus proche
-- du départ du chemin (150 m au plus), quel que soit le territoire.
CREATE OR REPLACE FUNCTION app.parking_for_path(p_territory uuid, p_post geometry, p_path geometry) RETURNS uuid
  LANGUAGE sql STABLE AS $$
  WITH ends AS (
    SELECT CASE WHEN ST_Distance(ST_StartPoint(p_path)::geography, p_post::geography)
                   >= ST_Distance(ST_EndPoint(p_path)::geography, p_post::geography)
                THEN ST_StartPoint(p_path) ELSE ST_EndPoint(p_path) END AS start
  )
  SELECT pk.id FROM places pk, ends
   WHERE pk.tenant_id = (SELECT t.tenant_id FROM territories t WHERE t.id = p_territory)
     AND pk.kind = 'parking' AND pk.visibility = 'public'
     AND ST_DWithin(pk.geom::geography, ends.start::geography, 150)
   ORDER BY ST_Distance(pk.geom::geography, ends.start::geography)
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.check_post()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_buffer   integer;
  v_outside  integer;
  v_terr     geometry;
  v_dist     double precision;
  v_extent   geometry;
BEGIN
  SELECT t.geom INTO v_terr FROM territories t WHERE t.id = NEW.territory_id;
  SELECT tn.buffer_distance_m, tn.post_max_outside_m INTO v_buffer, v_outside
    FROM tenants tn WHERE tn.id = NEW.tenant_id;

  IF NOT ST_Covers(v_terr, NEW.geom) THEN
    v_dist := ST_Distance(v_terr::geography, NEW.geom::geography);
    IF v_outside <= 0 THEN
      RAISE EXCEPTION 'POST_OUTSIDE_TERRITORY: le poste est hors du territoire'
        USING ERRCODE = '23514';
    ELSIF v_dist > v_outside THEN
      RAISE EXCEPTION 'POST_TOO_FAR_OUTSIDE: le poste est à % m du territoire (maximum % m)',
        ceil(v_dist)::int, v_outside
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Toutes les réserves de l'association, pas seulement celles du territoire.
  IF EXISTS (SELECT 1 FROM reserve_zones r
              WHERE r.tenant_id = NEW.tenant_id AND ST_Intersects(r.geom, NEW.geom)) THEN
    RAISE EXCEPTION 'POST_IN_RESERVE: le poste est dans une zone de réserve'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' OR NOT ST_Equals(NEW.geom, OLD.geom) OR NEW.territory_id <> OLD.territory_id THEN
    -- Hors du territoire, on exige que les bâtiments aient été importés autour
    -- du poste : sinon la règle des habitations ne pourrait pas être vérifiée.
    IF NOT ST_Covers(v_terr, NEW.geom) THEN
      SELECT z.dwellings_extent INTO v_extent FROM exclusion_zones z WHERE z.territory_id = NEW.territory_id;
      IF v_extent IS NULL OR NOT ST_Covers(v_extent, ST_Buffer(NEW.geom::geography, v_buffer)::geometry) THEN
        RAISE EXCEPTION 'POST_OUTSIDE_BUILDINGS: bâtiments non importés à cet endroit'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    v_dist := app.nearest_dwelling_m(NEW.territory_id, NEW.geom, v_buffer);
    IF v_dist IS NOT NULL THEN
      RAISE EXCEPTION 'POST_IN_EXCLUSION: le poste est à % m d''une habitation (minimum % m)',
        floor(v_dist)::int, v_buffer
        USING ERRCODE = '23514';
    END IF;
    NEW.invalid_reason := NULL;   -- poste déplacé à un endroit valide
  END IF;

  -- Parking : un lieu public de type « parking » de l'association (vérifié
  -- quand il est choisi ; un lieu modifié ensuite ne bloque pas le poste).
  IF NEW.parking_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.parking_id IS DISTINCT FROM OLD.parking_id)
     AND NOT EXISTS (SELECT 1 FROM places pk WHERE pk.id = NEW.parking_id AND pk.tenant_id = NEW.tenant_id
                        AND pk.kind = 'parking' AND pk.visibility = 'public') THEN
    RAISE EXCEPTION 'PARKING_NOT_A_PARKING: le lieu choisi n''est pas un parking public de l''association'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION app.battue_people(p_hunt uuid)
 RETURNS TABLE(participant_id uuid, name text, role hunt_role, guest boolean, post_number integer, parking_id uuid, parking_name text, parking_lon double precision, parking_lat double precision, has_car boolean, car_seats integer, walking_ability integer, mine boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      LEFT JOIN places pk ON pk.id = p.parking_id
     WHERE hp.hunt_id = p_hunt AND hp.present;
END $function$;

CREATE OR REPLACE FUNCTION app.hunt_view_base(p_hunt uuid, p_participant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_h      hunts%ROWTYPE;
  v_p      hunt_participants%ROWTYPE;
  v_all    boolean;
  v_post   uuid;
  v_pub    boolean;
BEGIN
  SELECT * INTO v_h FROM hunts WHERE id = p_hunt;
  IF p_participant IS NOT NULL THEN
    SELECT * INTO v_p FROM hunt_participants WHERE id = p_participant AND hunt_id = p_hunt;
  END IF;
  SELECT show_all_posts INTO v_all FROM tenants WHERE id = v_h.tenant_id;
  v_pub := v_h.assignments_published_at IS NOT NULL;
  SELECT a.post_id INTO v_post FROM hunt_assignments a WHERE a.participant_id = v_p.id AND v_pub;

  RETURN (
  WITH day_posts AS (
    SELECT p.id, p.number, p.name, row_number() OVER (ORDER BY p.number) AS rk,
           (SELECT string_agg(coalesce(u.display_name, x.guest_name), ' et ' ORDER BY coalesce(u.display_name, x.guest_name))
              FROM hunt_assignments a JOIN hunt_participants x ON x.id = a.participant_id
              LEFT JOIN users u ON u.id = x.user_id
             WHERE a.hunt_id = v_h.id AND a.post_id = p.id) AS occupant
      FROM hunt_posts hp JOIN posts p ON p.id = hp.post_id
     WHERE hp.hunt_id = v_h.id
  ), mine AS (SELECT rk FROM day_posts WHERE id = v_post)
  SELECT jsonb_build_object(
    'revision', v_h.revision,
    'hunt', jsonb_build_object(
      'id', v_h.id, 'date', v_h.date, 'meeting_time', to_char(v_h.meeting_time, 'HH24:MI'),
      'meeting_place', v_h.meeting_place, 'meeting_point', ST_AsGeoJSON(v_h.meeting_point, 7)::jsonb,
      'briefing', v_h.briefing, 'status', v_h.status, 'started_at', v_h.started_at, 'ended_at', v_h.ended_at,
      'assignments_published', v_pub,
      'leader', (SELECT display_name FROM users WHERE id = v_h.leader_user_id),
      'chefs_de_ligne', (SELECT coalesce(jsonb_agg(coalesce(u.display_name, x.guest_name)), '[]')
                           FROM hunt_participants x LEFT JOIN users u ON u.id = x.user_id
                          WHERE x.hunt_id = v_h.id AND x.role = 'chef_de_ligne'),
      'present_count', (SELECT count(*) FROM hunt_participants x WHERE x.hunt_id = v_h.id AND x.present),
      'posted_count', (SELECT count(*) FROM hunt_participants x WHERE x.hunt_id = v_h.id AND x.present AND x.role = 'poste')),
    'territory', (SELECT jsonb_build_object('name', t.name, 'geom', ST_AsGeoJSON(t.geom, 7)::jsonb)
                    FROM territories t WHERE t.id = v_h.territory_id),
    'exclusion', (SELECT ST_AsGeoJSON(z.geom, 7)::jsonb FROM exclusion_zones z WHERE z.territory_id = v_h.territory_id),
    'reserves', (SELECT coalesce(jsonb_agg(ST_AsGeoJSON(r.geom, 7)::jsonb), '[]')
                   FROM reserve_zones r WHERE r.territory_id = v_h.territory_id),
    'me', CASE WHEN v_p.id IS NULL THEN NULL ELSE jsonb_build_object(
      'participant_id', v_p.id,
      'name', coalesce((SELECT display_name FROM users WHERE id = v_p.user_id), v_p.guest_name),
      'role', v_p.role, 'response', v_p.response, 'present', v_p.present, 'guest', v_p.user_id IS NULL) END,
    'post', (SELECT jsonb_build_object(
               'number', p.number, 'name', p.name, 'instructions', p.instructions,
               'geom', ST_AsGeoJSON(p.geom, 7)::jsonb, 'access_path', ST_AsGeoJSON(p.access_path, 7)::jsonb,
               'access_path_length_m', round(ST_Length(p.access_path::geography)),
               'parking', (SELECT jsonb_build_object('name', pk.name, 'geom', ST_AsGeoJSON(pk.geom, 7)::jsonb)
                             FROM places pk WHERE pk.id = p.parking_id),
               'shared_with', (SELECT coalesce(jsonb_agg(coalesce(u.display_name, x.guest_name)), '[]')
                                 FROM hunt_assignments a JOIN hunt_participants x ON x.id = a.participant_id
                                 LEFT JOIN users u ON u.id = x.user_id
                                WHERE a.hunt_id = v_h.id AND a.post_id = p.id AND x.id <> v_p.id))
               FROM posts p WHERE p.id = v_post),
    -- Participant : voisins (ou toute la ligne si l'association le permet).
    -- Responsable non convoqué : toute la ligne.
    'neighbors', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'number', d.number, 'name', d.name, 'occupant', d.occupant,
                     'side', CASE WHEN m.rk IS NULL THEN NULL WHEN d.rk < m.rk THEN 'gauche' ELSE 'droite' END) ORDER BY d.number), '[]')
                    FROM day_posts d LEFT JOIN mine m ON true
                   WHERE v_pub AND d.id IS DISTINCT FROM v_post
                     AND (p_participant IS NULL OR v_all OR (m.rk IS NOT NULL AND abs(d.rk - m.rk) = 1))),
    'show_all_posts', v_all OR p_participant IS NULL,
    'species', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                   's', s.species, 'quota', s.quota,
                   'taken', (SELECT count(*) FROM hunt_harvests hh WHERE hh.hunt_id = v_h.id AND hh.species = s.species))
                   ORDER BY s.species), '[]')
                  FROM hunt_species s WHERE s.hunt_id = v_h.id),
    'harvests', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'id', hh.id, 'species', hh.species, 'category', hh.category, 'notes', hh.notes,
                    'shooter', coalesce(u.display_name, x.guest_name),
                    'post_number', (SELECT p.number FROM hunt_assignments a JOIN posts p ON p.id = a.post_id
                                     WHERE a.participant_id = hh.participant_id),
                    'mine', hh.recorded_by IS NOT NULL AND hh.recorded_by = (SELECT user_id FROM hunt_participants WHERE id = v_p.id),
                    'at', hh.created_at) ORDER BY hh.created_at DESC), '[]')
                   FROM hunt_harvests hh
                   LEFT JOIN hunt_participants x ON x.id = hh.participant_id
                   LEFT JOIN users u ON u.id = x.user_id
                  WHERE hh.hunt_id = v_h.id)
  ));
END $function$;
