-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0021_saisons.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0021_saisons.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0021_saisons.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0020_categorie_membre.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0020_categorie_membre.sql';
  END IF;
END $guard$;

-- ==================== 0021_saisons.sql ====================
-- Saisons de chasse (ex. « 2026-2027 »). L'association a une saison en cours.
-- * Espèces de la saison : quota total sur la saison et quota par défaut par
--   battue (repris à la première battue de chaque journée).
-- * Territoires, plans de chasse, lieux et membres sont RATTACHÉS à une saison
--   (tables de liens, sans copie : un territoire modifié l'est pour toutes les
--   saisons). Un élément créé est rattaché à la saison en cours.
-- * Journées (et donc battues et prélèvements) : saison en cours à la création.
-- * Nouvelle saison : rattachements et espèces repris de la saison précédente.

CREATE TABLE seasons (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 50),
  starts_on  date NOT NULL,
  ends_on    date NOT NULL CHECK (ends_on > starts_on),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

ALTER TABLE tenants ADD COLUMN current_season_id uuid;
ALTER TABLE tenants ADD CONSTRAINT tenants_current_season_fk FOREIGN KEY (id, current_season_id)
  REFERENCES seasons (tenant_id, id) ON DELETE SET NULL (current_season_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE season_species (
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id(),
  season_id     uuid NOT NULL,
  species       text NOT NULL CHECK (length(btrim(species)) BETWEEN 1 AND 60),
  season_quota  integer CHECK (season_quota BETWEEN 0 AND 9999), -- NULL : sans limite fixée
  battue_quota  integer CHECK (battue_quota BETWEEN 0 AND 999),  -- par défaut à chaque battue
  position      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (season_id, species),
  FOREIGN KEY (tenant_id, season_id) REFERENCES seasons (tenant_id, id) ON DELETE CASCADE
);

-- Clés composites pour des liens du même tenant.
ALTER TABLE places ADD CONSTRAINT places_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE hunt_plans ADD CONSTRAINT hunt_plans_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE season_territories (
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  season_id    uuid NOT NULL,
  territory_id uuid NOT NULL,
  PRIMARY KEY (season_id, territory_id),
  FOREIGN KEY (tenant_id, season_id) REFERENCES seasons (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE season_hunt_plans (
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  season_id    uuid NOT NULL,
  hunt_plan_id uuid NOT NULL,
  PRIMARY KEY (season_id, hunt_plan_id),
  FOREIGN KEY (tenant_id, season_id) REFERENCES seasons (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, hunt_plan_id) REFERENCES hunt_plans (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE season_places (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id(),
  season_id uuid NOT NULL,
  place_id  uuid NOT NULL,
  PRIMARY KEY (season_id, place_id),
  FOREIGN KEY (tenant_id, season_id) REFERENCES seasons (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, place_id) REFERENCES places (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE season_members (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id(),
  season_id uuid NOT NULL,
  user_id   text NOT NULL,
  PRIMARY KEY (season_id, user_id),
  FOREIGN KEY (tenant_id, season_id) REFERENCES seasons (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tenant_id) REFERENCES memberships (user_id, tenant_id) ON DELETE CASCADE
);

ALTER TABLE hunt_days ADD COLUMN season_id uuid;
ALTER TABLE hunt_days ADD CONSTRAINT hunt_days_season_fk FOREIGN KEY (tenant_id, season_id) REFERENCES seasons (tenant_id, id);
CREATE INDEX hunt_days_season_idx ON hunt_days (season_id);

-- RLS : lecture par tout membre, écriture par le président.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seasons', 'season_species', 'season_territories', 'season_hunt_plans', 'season_places', 'season_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$s_select ON %1$I FOR SELECT TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_write ON %1$I FOR ALL TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
                      WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rls', t);
  END LOOP;
END $$;

/** Saison en cours de l'association courante. */
CREATE FUNCTION app.current_season() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT current_season_id FROM tenants WHERE id = app.current_tenant_id()
$$;

-- ---------------------------------------------------------------------------
-- Saison couvrant une date : « 2026-2027 » du 1er juillet au 30 juin.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.season_bounds(p_day date, OUT name text, OUT starts_on date, OUT ends_on date)
  LANGUAGE sql IMMUTABLE AS $$
  SELECT y::text || '-' || (y + 1)::text, make_date(y, 7, 1), make_date(y + 1, 6, 30)
    FROM (SELECT CASE WHEN extract(month FROM p_day) >= 7 THEN extract(year FROM p_day)::int
                      ELSE extract(year FROM p_day)::int - 1 END AS y) s
$$;

/**
 * Nouvelle saison (droits du président) : espèces et rattachements repris de
 * p_copy_from (par défaut la saison en cours). Elle ne devient pas la saison
 * en cours d'elle-même.
 */
CREATE FUNCTION app.create_season(p_name text, p_starts date, p_ends date, p_copy_from uuid)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_from   uuid;
  v_id     uuid;
BEGIN
  IF v_tenant IS NULL OR NOT app.has_role('president') THEN
    RAISE EXCEPTION 'FORBIDDEN: réservé au président' USING ERRCODE = '42501';
  END IF;
  v_from := coalesce(p_copy_from, (SELECT current_season_id FROM tenants WHERE id = v_tenant));
  IF v_from IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seasons WHERE id = v_from AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'NOT_FOUND: saison introuvable' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO seasons (tenant_id, name, starts_on, ends_on) VALUES (v_tenant, p_name, p_starts, p_ends) RETURNING id INTO v_id;
  IF v_from IS NOT NULL THEN
    INSERT INTO season_species (tenant_id, season_id, species, season_quota, battue_quota, position)
      SELECT v_tenant, v_id, species, season_quota, battue_quota, position FROM season_species WHERE season_id = v_from;
    INSERT INTO season_territories (tenant_id, season_id, territory_id) SELECT v_tenant, v_id, territory_id FROM season_territories WHERE season_id = v_from;
    INSERT INTO season_hunt_plans (tenant_id, season_id, hunt_plan_id) SELECT v_tenant, v_id, hunt_plan_id FROM season_hunt_plans WHERE season_id = v_from;
    INSERT INTO season_places (tenant_id, season_id, place_id) SELECT v_tenant, v_id, place_id FROM season_places WHERE season_id = v_from;
    INSERT INTO season_members (tenant_id, season_id, user_id) SELECT v_tenant, v_id, user_id FROM season_members WHERE season_id = v_from;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION app.set_current_season(p_season uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app.has_role('president') THEN
    RAISE EXCEPTION 'FORBIDDEN: réservé au président' USING ERRCODE = '42501';
  END IF;
  UPDATE tenants SET current_season_id = p_season
   WHERE id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM seasons WHERE id = p_season AND tenant_id = tenants.id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: saison introuvable' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Rattachements automatiques à la saison en cours (quel que soit l'auteur).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.attach_to_current_season() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_season uuid := (SELECT current_season_id FROM tenants WHERE id = NEW.tenant_id);
BEGIN
  IF v_season IS NULL THEN RETURN NULL; END IF;
  CASE TG_TABLE_NAME
    WHEN 'territories' THEN INSERT INTO season_territories (tenant_id, season_id, territory_id) VALUES (NEW.tenant_id, v_season, NEW.id) ON CONFLICT DO NOTHING;
    WHEN 'hunt_plans' THEN INSERT INTO season_hunt_plans (tenant_id, season_id, hunt_plan_id) VALUES (NEW.tenant_id, v_season, NEW.id) ON CONFLICT DO NOTHING;
    WHEN 'places' THEN INSERT INTO season_places (tenant_id, season_id, place_id) VALUES (NEW.tenant_id, v_season, NEW.id) ON CONFLICT DO NOTHING;
    WHEN 'memberships' THEN INSERT INTO season_members (tenant_id, season_id, user_id) VALUES (NEW.tenant_id, v_season, NEW.user_id) ON CONFLICT DO NOTHING;
  END CASE;
  RETURN NULL;
END $$;
CREATE TRIGGER territories_season AFTER INSERT ON territories FOR EACH ROW EXECUTE FUNCTION app.attach_to_current_season();
CREATE TRIGGER hunt_plans_season AFTER INSERT ON hunt_plans FOR EACH ROW EXECUTE FUNCTION app.attach_to_current_season();
CREATE TRIGGER places_season AFTER INSERT ON places FOR EACH ROW EXECUTE FUNCTION app.attach_to_current_season();
CREATE TRIGGER memberships_season AFTER INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION app.attach_to_current_season();

CREATE FUNCTION app.day_season() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.season_id := coalesce(NEW.season_id, (SELECT current_season_id FROM tenants WHERE id = NEW.tenant_id));
  RETURN NEW;
END $$;
CREATE TRIGGER hunt_days_season BEFORE INSERT ON hunt_days FOR EACH ROW EXECUTE FUNCTION app.day_season();

-- Toute nouvelle association démarre avec la saison du jour.
CREATE FUNCTION app.tenant_first_season() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b record := app.season_bounds(current_date);
  v_id uuid;
BEGIN
  INSERT INTO seasons (tenant_id, name, starts_on, ends_on) VALUES (NEW.id, b.name, b.starts_on, b.ends_on) RETURNING id INTO v_id;
  INSERT INTO season_species (tenant_id, season_id, species, position)
    SELECT NEW.id, v_id, s, i FROM unnest(ARRAY['Sanglier', 'Chevreuil']) WITH ORDINALITY AS x(s, i);
  UPDATE tenants SET current_season_id = v_id WHERE id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER tenants_first_season AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION app.tenant_first_season();

-- ---------------------------------------------------------------------------
-- Associations existantes : saison du jour, avec tout ce qui existe.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t record;
  b record := app.season_bounds(current_date);
  v_id uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO seasons (tenant_id, name, starts_on, ends_on) VALUES (t.id, b.name, b.starts_on, b.ends_on) RETURNING id INTO v_id;
    UPDATE tenants SET current_season_id = v_id WHERE id = t.id;
    INSERT INTO season_territories (tenant_id, season_id, territory_id) SELECT t.id, v_id, id FROM territories WHERE tenant_id = t.id;
    INSERT INTO season_hunt_plans (tenant_id, season_id, hunt_plan_id) SELECT t.id, v_id, id FROM hunt_plans WHERE tenant_id = t.id;
    INSERT INTO season_places (tenant_id, season_id, place_id) SELECT t.id, v_id, id FROM places WHERE tenant_id = t.id;
    INSERT INTO season_members (tenant_id, season_id, user_id) SELECT t.id, v_id, user_id FROM memberships WHERE tenant_id = t.id;
    UPDATE hunt_days SET season_id = v_id WHERE tenant_id = t.id;
    INSERT INTO season_species (tenant_id, season_id, species, position)
      SELECT t.id, v_id, s, row_number() OVER (ORDER BY min(o), s)
        FROM (SELECT 'Sanglier' AS s, 0 AS o UNION ALL SELECT 'Chevreuil', 1
              UNION ALL SELECT DISTINCT hs.species, 2 FROM hunt_species hs WHERE hs.tenant_id = t.id
              UNION ALL SELECT DISTINCT hh.species, 2 FROM hunt_harvests hh WHERE hh.tenant_id = t.id) x
       GROUP BY s;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION app.current_season(), app.season_bounds(date), app.create_season(text, date, date, uuid), app.set_current_season(uuid),
  app.attach_to_current_season(), app.day_season(), app.tenant_first_season() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.season_bounds(date), app.create_season(text, date, date, uuid), app.set_current_season(uuid), app.current_season() TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0021_saisons.sql', '6e420bc0958d392c93692aa931a0800be401172f09d390bf945a15b65553aff0');

COMMIT;
