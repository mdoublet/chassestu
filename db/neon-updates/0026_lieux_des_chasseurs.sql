-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0026_lieux_des_chasseurs.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0026_lieux_des_chasseurs.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0026_lieux_des_chasseurs.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0025_types_de_lieux.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0025_types_de_lieux.sql';
  END IF;
END $guard$;

-- ==================== 0026_lieux_des_chasseurs.sql ====================
-- Lieux ajoutés par les chasseurs : chacun peut enregistrer ses propres lieux
-- (avec photo). Un lieu d'un chasseur est privé (visible de lui et du
-- président) jusqu'à ce que le président le rende public pour tous.
ALTER TABLE places ADD COLUMN created_by text REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE places ADD COLUMN visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private'));

-- Noms uniques parmi les lieux publics, et parmi les lieux privés d'un même auteur.
ALTER TABLE places DROP CONSTRAINT places_tenant_id_name_key;
CREATE UNIQUE INDEX places_public_name_key ON places (tenant_id, name) WHERE visibility = 'public';
CREATE UNIQUE INDEX places_private_name_key ON places (tenant_id, created_by, name) WHERE visibility = 'private';

DROP POLICY places_select ON places;
DROP POLICY places_write ON places;
-- Lecture : lieux publics ; les siens ; tous pour le président.
CREATE POLICY places_select ON places FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND (visibility = 'public' OR created_by = (SELECT app.current_user_id()) OR app.has_role('president')));
-- Création : tout membre ; un lieu public seulement par le président.
CREATE POLICY places_insert ON places FOR INSERT TO app_rls
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
              AND (app.has_role('president') OR (visibility = 'private' AND created_by = (SELECT app.current_user_id()))));
-- Modification, suppression : le président ; l'auteur tant que son lieu est privé.
CREATE POLICY places_update ON places FOR UPDATE TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND (app.has_role('president') OR (visibility = 'private' AND created_by = (SELECT app.current_user_id()))))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
              AND (app.has_role('president') OR (visibility = 'private' AND created_by = (SELECT app.current_user_id()))));
CREATE POLICY places_delete ON places FOR DELETE TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND (app.has_role('president') OR (visibility = 'private' AND created_by = (SELECT app.current_user_id()))));

INSERT INTO schema_migrations (name, checksum) VALUES ('0026_lieux_des_chasseurs.sql', '988b291d372dae97cb858e43da403d5a2230c4c8a776afd7315567fe6777469c');

COMMIT;
