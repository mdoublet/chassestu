-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0014_mobilite_membres.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0014_mobilite_membres.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0014_mobilite_membres.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0013_lieux.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0013_lieux.sql';
  END IF;
END $guard$;

-- ==================== 0014_mobilite_membres.sql ====================
-- Le président et les responsables peuvent renseigner la marche et la voiture
-- d'un membre de leur association (chasseurs qui n'utilisent pas l'appli).
CREATE FUNCTION app.set_member_mobility(p_user text, p_set_walk boolean, p_walk smallint,
                                        p_set_car boolean, p_car boolean, p_set_seats boolean, p_seats smallint)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app.has_role('president', 'responsable')
     OR NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = p_user AND tenant_id = app.current_tenant_id()) THEN
    RAISE EXCEPTION 'NOT_FOUND: membre introuvable' USING ERRCODE = 'P0002';
  END IF;
  UPDATE users SET
    walking_ability = CASE WHEN p_set_walk THEN p_walk ELSE walking_ability END,
    has_car = CASE WHEN p_set_car THEN p_car ELSE has_car END,
    car_seats = CASE WHEN p_set_seats THEN p_seats ELSE car_seats END
   WHERE id = p_user;
END $$;
REVOKE ALL ON FUNCTION app.set_member_mobility(text, boolean, smallint, boolean, boolean, boolean, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_member_mobility(text, boolean, smallint, boolean, boolean, boolean, smallint) TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0014_mobilite_membres.sql', 'a93ccb887873dc9c3c798f8a43935dd5d8c90f88adfd0be0350b080bc531ff3d');

COMMIT;
