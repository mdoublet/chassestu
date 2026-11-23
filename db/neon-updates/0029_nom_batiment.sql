-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0029_nom_batiment.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0029_nom_batiment.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0029_nom_batiment.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0028_parkings_lieux.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0028_parkings_lieux.sql';
  END IF;
END $guard$;

-- ==================== 0029_nom_batiment.sql ====================
-- Nom d'un bâtiment, saisi par le président (ex. « Ferme des Pujols »), pour
-- le reconnaître dans la liste ; vide par défaut (libellé : usage IGN).
ALTER TABLE dwellings ADD COLUMN name text NOT NULL DEFAULT '' CHECK (length(name) <= 100);

INSERT INTO schema_migrations (name, checksum) VALUES ('0029_nom_batiment.sql', 'b43c7e965cd7dd0c9d09d462f321e85e8077480f41a390e484a51173b00822fc');

COMMIT;
