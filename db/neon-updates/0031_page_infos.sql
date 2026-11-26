-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0031_page_infos.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0031_page_infos.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0031_page_infos.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0030_vent.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0030_vent.sql';
  END IF;
END $guard$;

-- ==================== 0031_page_infos.sql ====================
-- Page d'informations de l'association (dates d'ouverture, espèces
-- chassables, règles…), affichée dans l'onglet « Infos chasse » des membres.
-- Adresse https choisie par le président ; vide : pas de page.
ALTER TABLE tenants ADD COLUMN info_url text CHECK (info_url IS NULL OR (info_url ~ '^https://' AND length(info_url) <= 500));
GRANT UPDATE (info_url) ON tenants TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0031_page_infos.sql', '2b60dbaf6a10f3257a0ca66a0ff97d020ee42ef23a31c1354b710d15cb39718a');

COMMIT;
