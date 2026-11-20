-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0016_consignes_particulieres.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0016_consignes_particulieres.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0016_consignes_particulieres.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0015_parking_du_chemin.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0015_parking_du_chemin.sql';
  END IF;
END $guard$;

-- ==================== 0016_consignes_particulieres.sql ====================
-- Case « Consignes particulières » d'un poste : signalée par ⚠ dans l'éditeur
-- (comme des consignes contenant le mot « attention »).
ALTER TABLE posts ADD COLUMN special_instructions boolean NOT NULL DEFAULT false;

INSERT INTO schema_migrations (name, checksum) VALUES ('0016_consignes_particulieres.sql', '12af5dd11c46336f40eea56dbc7d6f3dc511a67857bc6bd774a193ce66b52d87');

COMMIT;
