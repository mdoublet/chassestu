-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0002_lot1_cartographie.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0002_lot1_cartographie.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0002_lot1_cartographie.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0001_lot0_socle.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0001_lot0_socle.sql';
  END IF;
END $guard$;

-- ==================== 0002_lot1_cartographie.sql ====================
-- Lot 1 — Éditeur cartographique
-- Territoires, zones de réserve, parkings, postes et chemins d'accès.
--
-- Géométries en WGS84 (SRID 4326). Les règles d'intégrité spatiale sont
-- vérifiées en base (source de vérité) : l'API les vérifie aussi pour
-- renvoyer des messages clairs, et le client pour le retour visuel.
-- Les zones d'exclusion de 150 m arrivent au lot 2.

-- Limites de taille des géométries (protection de l'API et de la base).
-- 10 000 sommets suffisent largement pour un territoire de chasse.

CREATE TABLE territories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  notes      text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  geom       geometry(Polygon, 4326) NOT NULL
             CHECK (ST_IsValid(geom) AND ST_NPoints(geom) <= 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX territories_tenant_idx ON territories (tenant_id);
CREATE INDEX territories_geom_gix ON territories USING gist (geom);

CREATE TABLE reserve_zones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id uuid NOT NULL,
  name         text NOT NULL DEFAULT 'Réserve' CHECK (length(name) <= 200),
  reason       text NOT NULL DEFAULT '' CHECK (length(reason) <= 1000),
  geom         geometry(Polygon, 4326) NOT NULL
               CHECK (ST_IsValid(geom) AND ST_NPoints(geom) <= 10000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX reserve_zones_territory_idx ON reserve_zones (territory_id);
CREATE INDEX reserve_zones_geom_gix ON reserve_zones USING gist (geom);

CREATE TABLE parkings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id uuid NOT NULL,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  geom         geometry(Point, 4326) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX parkings_territory_idx ON parkings (territory_id);

CREATE TABLE posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id uuid NOT NULL,
  number       integer NOT NULL CHECK (number BETWEEN 1 AND 999),
  name         text NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  geom         geometry(Point, 4326) NOT NULL,
  parking_id   uuid,
  access_path  geometry(LineString, 4326)
               CHECK (access_path IS NULL OR (ST_IsValid(access_path) AND ST_NPoints(access_path) <= 5000)),
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 2000),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (territory_id, number) DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parking_id) REFERENCES parkings (tenant_id, id) ON DELETE SET NULL (parking_id)
);
CREATE INDEX posts_territory_idx ON posts (territory_id);
CREATE INDEX posts_geom_gix ON posts USING gist (geom);

-- ---------------------------------------------------------------------------
-- Intégrité spatiale
-- Les erreurs portent un code stable en préfixe du message (ex.
-- POST_OUTSIDE_TERRITORY) que l'API traduit en message utilisateur.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.check_territory() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_numbers text;
BEGIN
  SELECT string_agg(p.number::text, ', ' ORDER BY p.number) INTO v_numbers
    FROM posts p WHERE p.territory_id = NEW.id AND NOT ST_Covers(NEW.geom, p.geom);
  IF v_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'TERRITORY_EXCLUDES_POSTS: les postes % seraient hors du territoire', v_numbers
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER territories_check BEFORE UPDATE OF geom ON territories
  FOR EACH ROW EXECUTE FUNCTION app.check_territory();

CREATE FUNCTION app.check_reserve_zone() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_numbers text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM territories t
                  WHERE t.id = NEW.territory_id AND ST_Intersects(t.geom, NEW.geom)) THEN
    RAISE EXCEPTION 'RESERVE_OUTSIDE_TERRITORY: la réserve doit intersecter le territoire'
      USING ERRCODE = '23514';
  END IF;
  SELECT string_agg(p.number::text, ', ' ORDER BY p.number) INTO v_numbers
    FROM posts p WHERE p.territory_id = NEW.territory_id AND ST_Intersects(NEW.geom, p.geom);
  IF v_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'RESERVE_CONTAINS_POSTS: la réserve contiendrait les postes %', v_numbers
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reserve_zones_check BEFORE INSERT OR UPDATE OF geom, territory_id ON reserve_zones
  FOR EACH ROW EXECUTE FUNCTION app.check_reserve_zone();

CREATE FUNCTION app.check_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM territories t
                  WHERE t.id = NEW.territory_id AND ST_Covers(t.geom, NEW.geom)) THEN
    RAISE EXCEPTION 'POST_OUTSIDE_TERRITORY: le poste est hors du territoire'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM reserve_zones r
              WHERE r.territory_id = NEW.territory_id AND ST_Intersects(r.geom, NEW.geom)) THEN
    RAISE EXCEPTION 'POST_IN_RESERVE: le poste est dans une zone de réserve'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.parking_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM parkings pk WHERE pk.id = NEW.parking_id AND pk.territory_id = NEW.territory_id) THEN
    RAISE EXCEPTION 'PARKING_OTHER_TERRITORY: le parking appartient à un autre territoire'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER posts_check BEFORE INSERT OR UPDATE OF geom, territory_id, parking_id ON posts
  FOR EACH ROW EXECUTE FUNCTION app.check_post();

-- ---------------------------------------------------------------------------
-- Horodatage et audit
-- ---------------------------------------------------------------------------
CREATE TRIGGER territories_touch BEFORE UPDATE ON territories FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER reserve_zones_touch BEFORE UPDATE ON reserve_zones FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER parkings_touch BEFORE UPDATE ON parkings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER posts_touch BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER territories_audit AFTER INSERT OR UPDATE OR DELETE ON territories
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER reserve_zones_audit AFTER INSERT OR UPDATE OR DELETE ON reserve_zones
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER parkings_audit AFTER INSERT OR UPDATE OR DELETE ON parkings
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER posts_audit AFTER INSERT OR UPDATE OR DELETE ON posts
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

-- ---------------------------------------------------------------------------
-- RLS : lecture par tout membre du tenant, écriture par le président.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['territories', 'reserve_zones', 'parkings', 'posts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$s_select ON %1$I FOR SELECT TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_write ON %1$I FOR ALL TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
                      WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rls', t);
  END LOOP;
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0002_lot1_cartographie.sql', 'efadb1722242b501c4f8d51d7e0ac9c7e953c5aaea5920e8559c43fdb356e555');

COMMIT;
