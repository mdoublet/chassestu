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
