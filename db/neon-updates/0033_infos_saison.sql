-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0033_infos_saison.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0033_infos_saison.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0033_infos_saison.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0032_battues_preparees.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0032_battues_preparees.sql';
  END IF;
END $guard$;

-- ==================== 0033_infos_saison.sql ====================
-- Infos de chasse d'une saison (onglet « Infos » des membres) : dates
-- d'ouverture et périodes par espèce, jours et horaires, calendrier des
-- battues, avis datés, liste de contrôle, règles. Document JSON validé par
-- l'API, modifié par le président, repris à la création de la saison suivante.
ALTER TABLE seasons ADD COLUMN regulations jsonb CHECK (regulations IS NULL OR (jsonb_typeof(regulations) = 'object' AND pg_column_size(regulations) < 500000));

INSERT INTO schema_migrations (name, checksum) VALUES ('0033_infos_saison.sql', '4e43cf28de03997456e93dd30d354e228ec1b5083f0d64ea40a14c735910cc98');

COMMIT;
