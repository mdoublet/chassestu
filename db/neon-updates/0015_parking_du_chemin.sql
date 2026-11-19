-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0015_parking_du_chemin.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0015_parking_du_chemin.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0015_parking_du_chemin.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0014_mobilite_membres.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0014_mobilite_membres.sql';
  END IF;
END $guard$;

-- ==================== 0015_parking_du_chemin.sql ====================
-- Parking d'un poste déduit de son chemin d'accès : le chemin part du parking.
-- Départ = l'extrémité du chemin la plus éloignée du poste ; on rattache le
-- parking du territoire le plus proche de ce départ, s'il est à moins de 150 m.
-- Un parking choisi explicitement dans la même modification est respecté.

CREATE FUNCTION app.parking_for_path(p_territory uuid, p_post geometry, p_path geometry) RETURNS uuid
  LANGUAGE sql STABLE AS $$
  WITH ends AS (
    SELECT CASE WHEN ST_Distance(ST_StartPoint(p_path)::geography, p_post::geography)
                   >= ST_Distance(ST_EndPoint(p_path)::geography, p_post::geography)
                THEN ST_StartPoint(p_path) ELSE ST_EndPoint(p_path) END AS start
  )
  SELECT pk.id FROM parkings pk, ends
   WHERE pk.territory_id = p_territory
     AND ST_DWithin(pk.geom::geography, ends.start::geography, 150)
   ORDER BY ST_Distance(pk.geom::geography, ends.start::geography)
   LIMIT 1
$$;

CREATE FUNCTION app.post_parking_from_path() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
BEGIN
  IF NEW.access_path IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.access_path IS NOT DISTINCT FROM OLD.access_path
                           OR NEW.parking_id IS DISTINCT FROM OLD.parking_id) THEN
    RETURN NEW;   -- chemin inchangé, ou parking choisi à la main en même temps
  END IF;
  IF TG_OP = 'INSERT' AND NEW.parking_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  v := app.parking_for_path(NEW.territory_id, NEW.geom, NEW.access_path);
  IF v IS NOT NULL THEN
    NEW.parking_id := v;
  END IF;
  RETURN NEW;
END $$;
-- Nom choisi pour passer avant posts_check (ordre alphabétique), qui vérifie le parking.
CREATE TRIGGER posts_auto_parking BEFORE INSERT OR UPDATE OF access_path, parking_id ON posts
  FOR EACH ROW EXECUTE FUNCTION app.post_parking_from_path();

-- Rattrapage : postes qui ont un chemin mais pas de parking.
UPDATE posts SET parking_id = app.parking_for_path(territory_id, geom, access_path)
 WHERE access_path IS NOT NULL AND parking_id IS NULL
   AND app.parking_for_path(territory_id, geom, access_path) IS NOT NULL;

REVOKE ALL ON FUNCTION app.parking_for_path(uuid, geometry, geometry), app.post_parking_from_path() FROM PUBLIC;
-- Appelée par le déclencheur avec les droits de l'utilisateur (lecture des parkings, sous RLS).
GRANT EXECUTE ON FUNCTION app.parking_for_path(uuid, geometry, geometry) TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0015_parking_du_chemin.sql', 'a1750819b88d2931315b2c2cec8be20ece505742d719d82b14d56fec07b86782');

COMMIT;
