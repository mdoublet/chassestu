-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0034_voisins_en_place.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0034_voisins_en_place.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0034_voisins_en_place.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0033_infos_saison.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0033_infos_saison.sql';
  END IF;
END $guard$;

-- ==================== 0034_voisins_en_place.sql ====================
-- Vue chasseur : pour chaque poste visible (voisins, ou tous si l'association
-- le permet), l'occupant est-il déclaré en place ? (point vert / orange).

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
             WHERE a.hunt_id = v_h.id AND a.post_id = p.id) AS occupant,
           -- Occupé et déclaré en place (par le chasseur, son chef de ligne ou le GPS).
           (SELECT bool_and(x.in_place_at IS NOT NULL)
              FROM hunt_assignments a JOIN hunt_participants x ON x.id = a.participant_id
             WHERE a.hunt_id = v_h.id AND a.post_id = p.id) AS in_place
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
                     'number', d.number, 'name', d.name, 'occupant', d.occupant, 'in_place', coalesce(d.in_place, false),
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

INSERT INTO schema_migrations (name, checksum) VALUES ('0034_voisins_en_place.sql', '97349521bb84dcba274384d69efad4682b0775b9481fe805aae96153305abe23');

COMMIT;
