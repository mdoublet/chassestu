-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0003_lot2_habitations.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0003_lot2_habitations.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0003_lot2_habitations.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0002_lot1_cartographie.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0002_lot1_cartographie.sql';
  END IF;
END $guard$;

-- ==================== 0003_lot2_habitations.sql ====================
-- Lot 2 — Règle des 150 m : habitations, zones d'exclusion, contrôle des postes.
--
-- * dwellings : bâtiments importés de la BD TOPO (IGN) ou ajoutés à la main.
--   Tout bâtiment compte comme habitation (approche prudente) ; le président
--   peut en ignorer un avec une raison obligatoire (tracé dans l'audit).
-- * exclusion_zones : zone non chassable = union des tampons des habitations
--   non ignorées, découpée au territoire. TABLE et non vue matérialisée : une
--   vue matérialisée ne supporte pas la RLS. Elle est recalculée par
--   déclencheur à chaque modification d'habitation, de territoire ou de
--   distance (tenants.buffer_distance_m).
-- * posts.invalid_reason : un poste rendu illégal par une nouvelle habitation
--   ou une distance plus grande est marqué invalide (pas supprimé).
-- Les distances sont calculées en geography (mètres), jamais en degrés.

-- Bande d'avertissement au-delà de la distance minimale (150 → 200 m par défaut).
CREATE FUNCTION app.warning_margin_m() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 50 $$;

ALTER TABLE posts ADD COLUMN invalid_reason text;          -- NULL = poste valide

CREATE TABLE dwellings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id           uuid NOT NULL,
  source                 text NOT NULL CHECK (source IN ('bdtopo', 'manuel')),
  source_id              text,                                   -- identifiant BD TOPO (cleabs)
  geom                   geometry(Geometry, 4326) NOT NULL
                         CHECK (ST_IsValid(geom)
                                AND GeometryType(geom) IN ('POINT', 'POLYGON', 'MULTIPOLYGON')
                                AND ST_NPoints(geom) <= 5000),
  usage                  text NOT NULL DEFAULT '' CHECK (length(usage) <= 200),
  likely_non_residential boolean NOT NULL DEFAULT false,         -- pré-signalement (usage BD TOPO)
  comment                text NOT NULL DEFAULT '' CHECK (length(comment) <= 1000),
  ignored                boolean NOT NULL DEFAULT false,
  ignored_reason         text CHECK (length(ignored_reason) <= 500),
  ignored_by             text REFERENCES users (id) ON DELETE SET NULL,
  ignored_at             timestamptz,
  missing_since          timestamptz,                            -- absent de la BD TOPO au dernier import
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (territory_id, source_id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT dwellings_ignored_reason CHECK (NOT ignored OR length(btrim(coalesce(ignored_reason, ''))) >= 3),
  CONSTRAINT dwellings_source_id CHECK (source = 'manuel' OR source_id IS NOT NULL)
);
CREATE INDEX dwellings_territory_idx ON dwellings (territory_id);
CREATE INDEX dwellings_geom_gix ON dwellings USING gist (geom);

CREATE TABLE exclusion_zones (
  territory_id      uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  geom              geometry(MultiPolygon, 4326),   -- NULL : aucune habitation
  warning_geom      geometry(MultiPolygon, 4326),   -- bande d'avertissement, hors zone d'exclusion
  area_ha           double precision NOT NULL DEFAULT 0,
  buffer_distance_m integer NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  dwellings_extent  geometry(Geometry, 4326),        -- zone couverte par le dernier import BD TOPO
  dwellings_refreshed_at timestamptz,
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX exclusion_zones_tenant_idx ON exclusion_zones (tenant_id);

-- ---------------------------------------------------------------------------
-- Calcul de la zone d'exclusion et validité des postes
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER : écrit exclusion_zones (aucun droit d'écriture pour
-- app_rls) ; ne fait que recalculer des données dérivées du territoire.
CREATE FUNCTION app.refresh_exclusion(p_territory uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_t      territories%ROWTYPE;
  v_buffer integer;
  v_excl   geometry;
  v_warn   geometry;
BEGIN
  SELECT * INTO v_t FROM territories WHERE id = p_territory;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT buffer_distance_m INTO v_buffer FROM tenants WHERE id = v_t.tenant_id;

  SELECT ST_Union(ST_Buffer(d.geom::geography, v_buffer)::geometry),
         ST_Union(ST_Buffer(d.geom::geography, v_buffer + app.warning_margin_m())::geometry)
    INTO v_excl, v_warn
    FROM dwellings d
   WHERE d.territory_id = p_territory AND NOT d.ignored;

  IF v_excl IS NOT NULL THEN
    v_excl := ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Intersection(v_t.geom, v_excl)), 3));
    v_warn := ST_Multi(ST_CollectionExtract(ST_MakeValid(
                ST_Difference(ST_Intersection(v_t.geom, v_warn), v_excl)), 3));
    IF ST_IsEmpty(v_excl) THEN v_excl := NULL; END IF;
    IF ST_IsEmpty(v_warn) THEN v_warn := NULL; END IF;
  END IF;

  INSERT INTO exclusion_zones AS z (territory_id, tenant_id, geom, warning_geom, area_ha, buffer_distance_m, computed_at)
  VALUES (p_territory, v_t.tenant_id, v_excl, v_warn,
          coalesce(ST_Area(v_excl::geography) / 10000, 0), v_buffer, now())
  ON CONFLICT (territory_id) DO UPDATE
     SET geom = EXCLUDED.geom, warning_geom = EXCLUDED.warning_geom, area_ha = EXCLUDED.area_ha,
         buffer_distance_m = EXCLUDED.buffer_distance_m, computed_at = EXCLUDED.computed_at;

  -- Distance exacte (geography) plutôt que le polygone approché du tampon.
  UPDATE posts p
     SET invalid_reason = x.reason
    FROM (SELECT p2.id,
                 CASE WHEN EXISTS (SELECT 1 FROM dwellings d
                                    WHERE d.territory_id = p_territory AND NOT d.ignored
                                      AND ST_DWithin(d.geom::geography, p2.geom::geography, v_buffer))
                      THEN 'EXCLUSION' END AS reason
            FROM posts p2 WHERE p2.territory_id = p_territory) x
   WHERE p.id = x.id AND p.invalid_reason IS DISTINCT FROM x.reason;
END $$;

-- Enregistre la zone couverte par un import BD TOPO (président du tenant courant).
CREATE FUNCTION app.mark_dwellings_imported(p_territory uuid, p_radius_m double precision) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE exclusion_zones z
       SET dwellings_extent = ST_Buffer(t.geom::geography, p_radius_m)::geometry,
           dwellings_refreshed_at = now()
      FROM territories t
     WHERE t.id = p_territory AND z.territory_id = t.id
       AND t.tenant_id = app.current_tenant_id() AND app.has_role('president')
  $$;

-- Distance (m) à l'habitation non ignorée la plus proche d'un point, ou NULL.
CREATE FUNCTION app.nearest_dwelling_m(p_territory uuid, p_point geometry, p_max double precision)
  RETURNS double precision LANGUAGE sql STABLE AS $$
    SELECT min(ST_Distance(d.geom::geography, p_point::geography))
      FROM dwellings d
     WHERE d.territory_id = p_territory AND NOT d.ignored
       AND ST_DWithin(d.geom::geography, p_point::geography, p_max)
  $$;

-- Contrôle des postes : on remplace la fonction du lot 1 pour ajouter la règle
-- des habitations (refus à l'enregistrement, message avec la distance).
CREATE OR REPLACE FUNCTION app.check_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_buffer integer;
  v_dist   double precision;
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
  -- Règle des habitations : vérifiée quand le poste est créé ou déplacé (un
  -- poste invalidé par une nouvelle habitation reste modifiable : nom, consignes…).
  IF TG_OP = 'INSERT' OR NOT ST_Equals(NEW.geom, OLD.geom) OR NEW.territory_id <> OLD.territory_id THEN
    SELECT t.buffer_distance_m INTO v_buffer FROM tenants t WHERE t.id = NEW.tenant_id;
    v_dist := app.nearest_dwelling_m(NEW.territory_id, NEW.geom, v_buffer);
    IF v_dist IS NOT NULL THEN
      RAISE EXCEPTION 'POST_IN_EXCLUSION: le poste est à % m d''une habitation (minimum % m)',
        floor(v_dist)::int, v_buffer
        USING ERRCODE = '23514';
    END IF;
    NEW.invalid_reason := NULL;   -- poste déplacé à un endroit valide
  END IF;
  IF NEW.parking_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM parkings pk WHERE pk.id = NEW.parking_id AND pk.territory_id = NEW.territory_id) THEN
    RAISE EXCEPTION 'PARKING_OTHER_TERRITORY: le parking appartient à un autre territoire'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Recalcul après modification des habitations (un recalcul par instruction,
-- pas par ligne : un import compte des centaines de bâtiments).
CREATE FUNCTION app.dwellings_changed() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    FOR v_id IN SELECT DISTINCT territory_id FROM old_rows LOOP PERFORM app.refresh_exclusion(v_id); END LOOP;
  ELSE
    FOR v_id IN SELECT DISTINCT territory_id FROM new_rows LOOP PERFORM app.refresh_exclusion(v_id); END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER dwellings_ins AFTER INSERT ON dwellings REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.dwellings_changed();
CREATE TRIGGER dwellings_upd AFTER UPDATE ON dwellings REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.dwellings_changed();
CREATE TRIGGER dwellings_del AFTER DELETE ON dwellings REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.dwellings_changed();

-- Ignorer / réactiver : qui, quand ; la raison est effacée à la réactivation.
CREATE FUNCTION app.dwellings_ignore_stamp() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ignored AND NOT OLD.ignored THEN
    NEW.ignored_by := app.current_user_id();
    NEW.ignored_at := now();
  ELSIF NOT NEW.ignored THEN
    NEW.ignored_reason := NULL;
    NEW.ignored_by := NULL;
    NEW.ignored_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dwellings_ignore BEFORE UPDATE ON dwellings
  FOR EACH ROW EXECUTE FUNCTION app.dwellings_ignore_stamp();
CREATE TRIGGER dwellings_touch BEFORE UPDATE ON dwellings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Audit : choix du président (ignorer, réactiver, ajout/suppression manuels),
-- pas chaque ligne d'un import automatique (résumé journalisé par l'API).
CREATE TRIGGER dwellings_audit_upd AFTER UPDATE ON dwellings
  FOR EACH ROW WHEN (OLD.ignored IS DISTINCT FROM NEW.ignored
                     OR OLD.ignored_reason IS DISTINCT FROM NEW.ignored_reason
                     OR OLD.comment IS DISTINCT FROM NEW.comment
                     OR (NEW.source = 'manuel' AND NOT ST_Equals(OLD.geom, NEW.geom)))
  EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER dwellings_audit_manual_ins AFTER INSERT ON dwellings
  FOR EACH ROW WHEN (NEW.source = 'manuel') EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER dwellings_audit_manual_del AFTER DELETE ON dwellings
  FOR EACH ROW WHEN (OLD.source = 'manuel') EXECUTE FUNCTION app.audit_trigger();

-- Territoire créé ou redessiné, distance modifiée : recalcul.
CREATE FUNCTION app.territory_exclusion() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.refresh_exclusion(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER territories_exclusion_ins AFTER INSERT ON territories
  FOR EACH ROW EXECUTE FUNCTION app.territory_exclusion();
CREATE TRIGGER territories_exclusion_upd AFTER UPDATE OF geom ON territories
  FOR EACH ROW EXECUTE FUNCTION app.territory_exclusion();

CREATE FUNCTION app.tenant_buffer_changed() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM territories WHERE tenant_id = NEW.id LOOP
    PERFORM app.refresh_exclusion(v_id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER tenants_buffer_changed AFTER UPDATE OF buffer_distance_m ON tenants
  FOR EACH ROW WHEN (OLD.buffer_distance_m IS DISTINCT FROM NEW.buffer_distance_m)
  EXECUTE FUNCTION app.tenant_buffer_changed();

-- Zones des territoires existants.
DO $$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM territories LOOP PERFORM app.refresh_exclusion(v_id); END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RLS et droits
-- ---------------------------------------------------------------------------
ALTER TABLE dwellings ENABLE ROW LEVEL SECURITY;
ALTER TABLE exclusion_zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY dwellings_select ON dwellings FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY dwellings_write ON dwellings FOR ALL TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'));
CREATE POLICY exclusion_zones_select ON exclusion_zones FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON dwellings TO app_rls;
GRANT SELECT ON exclusion_zones TO app_rls;   -- écriture : app.refresh_exclusion uniquement
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0003_lot2_habitations.sql', 'ee5c1330e6161e031776992c07cd17e1c98e43c020b4d7c4b8abcc753d765b38');

COMMIT;
