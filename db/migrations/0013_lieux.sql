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
