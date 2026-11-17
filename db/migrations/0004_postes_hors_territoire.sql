-- Postes hors du territoire.
--
-- Un poste peut être placé hors du territoire, jusqu'à
-- tenants.post_max_outside_m (200 m par défaut, 0 = interdit), toujours en
-- respectant la distance aux habitations. Conséquences :
-- * les bâtiments sont importés assez loin pour couvrir cette marge
--   (app.import_radius_m) ; un poste hors du territoire à un endroit où les
--   bâtiments n'ont pas été importés est refusé (pas de contrôle « à l'aveugle ») ;
-- * la zone non chassable est découpée à la « zone des postes »
--   (territoire + marge) pour être visible là où l'on peut poster ; sa
--   surface (area_ha) reste mesurée sur le seul territoire ;
-- * un poste ne peut être dans aucune réserve de l'association (y compris
--   celles des territoires voisins).

ALTER TABLE tenants
  ADD COLUMN post_max_outside_m integer NOT NULL DEFAULT 200
  CHECK (post_max_outside_m BETWEEN 0 AND 500);
GRANT UPDATE (post_max_outside_m) ON tenants TO app_rls;

ALTER TABLE exclusion_zones
  ADD COLUMN post_area geometry(Geometry, 4326);   -- territoire + marge autorisée pour les postes

-- Rayon d'import des bâtiments autour d'un territoire : la marge des postes,
-- plus la distance et la bande d'avertissement autour d'eux (300 m au moins).
CREATE FUNCTION app.import_radius_m(p_tenant uuid) RETURNS double precision
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT greatest(300, post_max_outside_m + buffer_distance_m + app.warning_margin_m() + 20)::double precision
      FROM tenants WHERE id = p_tenant
  $$;

-- Zone où un poste peut être placé : le territoire, élargi de la marge.
CREATE FUNCTION app.post_area(p_geom geometry, p_max_outside integer) RETURNS geometry
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN p_max_outside <= 0 THEN p_geom
                ELSE ST_Buffer(p_geom::geography, p_max_outside)::geometry END
  $$;

CREATE OR REPLACE FUNCTION app.refresh_exclusion(p_territory uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_t       territories%ROWTYPE;
  v_buffer  integer;
  v_outside integer;
  v_area    geometry;
  v_excl    geometry;
  v_warn    geometry;
  v_inside  geometry;
BEGIN
  SELECT * INTO v_t FROM territories WHERE id = p_territory;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT buffer_distance_m, post_max_outside_m INTO v_buffer, v_outside FROM tenants WHERE id = v_t.tenant_id;
  v_area := app.post_area(v_t.geom, v_outside);

  SELECT ST_Union(ST_Buffer(d.geom::geography, v_buffer)::geometry),
         ST_Union(ST_Buffer(d.geom::geography, v_buffer + app.warning_margin_m())::geometry)
    INTO v_excl, v_warn
    FROM dwellings d
   WHERE d.territory_id = p_territory AND NOT d.ignored;

  IF v_excl IS NOT NULL THEN
    v_inside := ST_MakeValid(ST_Intersection(v_t.geom, v_excl));   -- pour la surface
    v_excl := ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Intersection(v_area, v_excl)), 3));
    v_warn := ST_Multi(ST_CollectionExtract(ST_MakeValid(
                ST_Difference(ST_Intersection(v_area, v_warn), v_excl)), 3));
    IF ST_IsEmpty(v_excl) THEN v_excl := NULL; END IF;
    IF ST_IsEmpty(v_warn) THEN v_warn := NULL; END IF;
  END IF;

  INSERT INTO exclusion_zones AS z (territory_id, tenant_id, geom, warning_geom, post_area, area_ha, buffer_distance_m, computed_at)
  VALUES (p_territory, v_t.tenant_id, v_excl, v_warn, v_area,
          coalesce(ST_Area(v_inside::geography) / 10000, 0), v_buffer, now())
  ON CONFLICT (territory_id) DO UPDATE
     SET geom = EXCLUDED.geom, warning_geom = EXCLUDED.warning_geom, post_area = EXCLUDED.post_area,
         area_ha = EXCLUDED.area_ha, buffer_distance_m = EXCLUDED.buffer_distance_m,
         computed_at = EXCLUDED.computed_at;

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

CREATE OR REPLACE FUNCTION app.check_post() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_buffer   integer;
  v_outside  integer;
  v_terr     geometry;
  v_dist     double precision;
  v_extent   geometry;
BEGIN
  SELECT t.geom INTO v_terr FROM territories t WHERE t.id = NEW.territory_id;
  SELECT tn.buffer_distance_m, tn.post_max_outside_m INTO v_buffer, v_outside
    FROM tenants tn WHERE tn.id = NEW.tenant_id;

  IF NOT ST_Covers(v_terr, NEW.geom) THEN
    v_dist := ST_Distance(v_terr::geography, NEW.geom::geography);
    IF v_outside <= 0 THEN
      RAISE EXCEPTION 'POST_OUTSIDE_TERRITORY: le poste est hors du territoire'
        USING ERRCODE = '23514';
    ELSIF v_dist > v_outside THEN
      RAISE EXCEPTION 'POST_TOO_FAR_OUTSIDE: le poste est à % m du territoire (maximum % m)',
        ceil(v_dist)::int, v_outside
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Toutes les réserves de l'association, pas seulement celles du territoire.
  IF EXISTS (SELECT 1 FROM reserve_zones r
              WHERE r.tenant_id = NEW.tenant_id AND ST_Intersects(r.geom, NEW.geom)) THEN
    RAISE EXCEPTION 'POST_IN_RESERVE: le poste est dans une zone de réserve'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' OR NOT ST_Equals(NEW.geom, OLD.geom) OR NEW.territory_id <> OLD.territory_id THEN
    -- Hors du territoire, on exige que les bâtiments aient été importés autour
    -- du poste : sinon la règle des habitations ne pourrait pas être vérifiée.
    IF NOT ST_Covers(v_terr, NEW.geom) THEN
      SELECT z.dwellings_extent INTO v_extent FROM exclusion_zones z WHERE z.territory_id = NEW.territory_id;
      IF v_extent IS NULL OR NOT ST_Covers(v_extent, ST_Buffer(NEW.geom::geography, v_buffer)::geometry) THEN
        RAISE EXCEPTION 'POST_OUTSIDE_BUILDINGS: bâtiments non importés à cet endroit'
          USING ERRCODE = '23514';
      END IF;
    END IF;
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

-- Contour modifié : les postes doivent rester dans la zone des postes.
CREATE OR REPLACE FUNCTION app.check_territory() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_numbers text;
  v_outside integer;
BEGIN
  SELECT post_max_outside_m INTO v_outside FROM tenants WHERE id = NEW.tenant_id;
  SELECT string_agg(p.number::text, ', ' ORDER BY p.number) INTO v_numbers
    FROM posts p
   WHERE p.territory_id = NEW.id
     AND NOT ST_Covers(NEW.geom, p.geom)
     AND (v_outside <= 0 OR ST_Distance(NEW.geom::geography, p.geom::geography) > v_outside);
  IF v_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'TERRITORY_EXCLUDES_POSTS: les postes % seraient trop loin du territoire', v_numbers
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Recalcul quand la distance OU la marge hors territoire change.
DROP TRIGGER tenants_buffer_changed ON tenants;
CREATE TRIGGER tenants_buffer_changed AFTER UPDATE OF buffer_distance_m, post_max_outside_m ON tenants
  FOR EACH ROW WHEN (OLD.buffer_distance_m IS DISTINCT FROM NEW.buffer_distance_m
                     OR OLD.post_max_outside_m IS DISTINCT FROM NEW.post_max_outside_m)
  EXECUTE FUNCTION app.tenant_buffer_changed();

-- Zones existantes : découpe à la zone des postes.
DO $$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM territories LOOP PERFORM app.refresh_exclusion(v_id); END LOOP;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;
