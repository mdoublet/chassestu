-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0025_types_de_lieux.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0025_types_de_lieux.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0025_types_de_lieux.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0024_photo_lieu_appli_navigation.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0024_photo_lieu_appli_navigation.sql';
  END IF;
END $guard$;

-- ==================== 0025_types_de_lieux.sql ====================
-- Types de lieux libres : en plus de cabane, restaurant, parking et autre,
-- le président peut saisir ses propres types (salle des fêtes, carrefour…),
-- reproposés ensuite (types déjà utilisés par l'association).
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_kind_check;
ALTER TABLE places ADD CONSTRAINT places_kind_check CHECK (length(btrim(kind)) BETWEEN 1 AND 40);

INSERT INTO schema_migrations (name, checksum) VALUES ('0025_types_de_lieux.sql', '42b6dccfeff5102729c18c5dad77490e6502a75244211cb3a95018c6b6ccc849');

COMMIT;
