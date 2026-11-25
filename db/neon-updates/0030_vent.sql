-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0030_vent.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0030_vent.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0030_vent.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0029_nom_batiment.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0029_nom_batiment.sql';
  END IF;
END $guard$;

-- ==================== 0030_vent.sql ====================
-- Vent. Plan de chasse : plage de directions favorables (d'où vient le vent,
-- en degrés, sens horaire de wind_from_min à wind_from_max ; les deux vides :
-- tous vents). Battue : vent prévu à sa création (Open-Meteo), pour mémoire.
ALTER TABLE hunt_plans
  ADD COLUMN wind_from_min smallint CHECK (wind_from_min BETWEEN 0 AND 359),
  ADD COLUMN wind_from_max smallint CHECK (wind_from_max BETWEEN 0 AND 359),
  ADD CONSTRAINT hunt_plans_wind_range CHECK ((wind_from_min IS NULL) = (wind_from_max IS NULL));

ALTER TABLE hunts
  ADD COLUMN wind_from_deg  smallint CHECK (wind_from_deg BETWEEN 0 AND 359),
  ADD COLUMN wind_speed_kmh smallint CHECK (wind_speed_kmh BETWEEN 0 AND 400),
  ADD COLUMN wind_gust_kmh  smallint CHECK (wind_gust_kmh BETWEEN 0 AND 400);

INSERT INTO schema_migrations (name, checksum) VALUES ('0030_vent.sql', '5aea43c42b1112128b0284db990b43bc92af446409c9f5e496a47e3ab22e1b7e');

COMMIT;
