-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0013_lieux.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0013_lieux.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0013_lieux.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0012_journees.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0012_journees.sql';
  END IF;
END $guard$;

-- ==================== 0013_lieux.sql ====================
-- Lieux de l'association (cabane, restaurant, autre), indépendants des
-- territoires : points de rendez-vous et de regroupement réutilisables, en
-- plus des parkings des territoires. Gérés par le président, visibles des membres.

CREATE TABLE places (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind       text NOT NULL DEFAULT 'autre' CHECK (kind IN ('cabane', 'restaurant', 'autre')),
  geom       geometry(Point, 4326) NOT NULL,
  notes      text NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TRIGGER places_touch BEFORE UPDATE ON places FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER places_audit AFTER INSERT OR UPDATE OR DELETE ON places FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

ALTER TABLE places ENABLE ROW LEVEL SECURITY;
CREATE POLICY places_select ON places FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY places_write ON places FOR ALL TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'));
GRANT SELECT, INSERT, UPDATE, DELETE ON places TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0013_lieux.sql', '71676f509b8dc65f8e9bb4c859cfbc665997c48eb4fc8026116062ada86b7d82');

COMMIT;
