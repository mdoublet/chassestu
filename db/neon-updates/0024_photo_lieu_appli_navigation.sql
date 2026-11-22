-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0024_photo_lieu_appli_navigation.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0024_photo_lieu_appli_navigation.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0024_photo_lieu_appli_navigation.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0023_chef_de_ligne_en_place.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0023_chef_de_ligne_en_place.sql';
  END IF;
END $guard$;

-- ==================== 0024_photo_lieu_appli_navigation.sql ====================
-- Photo d'un lieu (cabane, restaurant…), réduite par l'application avant
-- l'envoi (JPEG, quelques centaines de ko au plus). Application de navigation
-- préférée de chaque utilisateur (Google Maps, Waze, Plans d'Apple).

ALTER TABLE places ADD COLUMN photo bytea CHECK (octet_length(photo) <= 1500000);
ALTER TABLE places ADD COLUMN photo_type text CHECK (photo_type IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE places ADD COLUMN photo_updated_at timestamptz;

ALTER TABLE users ADD COLUMN nav_app text CHECK (nav_app IN ('google', 'waze', 'apple'));
GRANT UPDATE (nav_app) ON users TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0024_photo_lieu_appli_navigation.sql', '16472ce0a687c4f0100fdf91a303fc12e16e880f1deb6554f240f7eb3b879fb0');

COMMIT;
