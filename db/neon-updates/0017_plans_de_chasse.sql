-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0017_plans_de_chasse.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0017_plans_de_chasse.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0017_plans_de_chasse.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0016_consignes_particulieres.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0016_consignes_particulieres.sql';
  END IF;
END $guard$;

-- ==================== 0017_plans_de_chasse.sql ====================
-- Plans de chasse : pour un même territoire, plusieurs façons de mener la
-- traque (point de départ, tracé, point de sortie). Chaque plan de chasse a
-- sa propre grille de couverture par effectif (les postes à pourvoir changent
-- selon le sens de la traque). Une battue se fait sur un territoire ET un
-- plan de chasse : c'est lui qui donne les postes proposés.
--
-- Les grilles existantes sont rattachées à un « Plan principal » créé pour
-- chaque territoire qui en avait.

CREATE TABLE hunt_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id uuid NOT NULL,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  notes        text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  start_point  geometry(Point, 4326),      -- départ des traqueurs
  drive_path   geometry(LineString, 4326), -- tracé de la traque
  exit_point   geometry(Point, 4326),      -- sortie de la traque
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (territory_id, name),
  UNIQUE (territory_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX hunt_plans_tenant_idx ON hunt_plans (tenant_id);

CREATE TRIGGER hunt_plans_touch BEFORE UPDATE ON hunt_plans FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER hunt_plans_audit AFTER INSERT OR UPDATE OR DELETE ON hunt_plans FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

ALTER TABLE hunt_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY hunt_plans_select ON hunt_plans FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY hunt_plans_write ON hunt_plans FOR ALL TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'));
GRANT SELECT, INSERT, UPDATE, DELETE ON hunt_plans TO app_rls;

-- Grilles existantes → « Plan principal » de leur territoire.
INSERT INTO hunt_plans (tenant_id, territory_id, name)
SELECT DISTINCT tenant_id, territory_id, 'Plan principal' FROM coverage_plans;

ALTER TABLE coverage_plans ADD COLUMN hunt_plan_id uuid;
UPDATE coverage_plans cp SET hunt_plan_id = hp.id
  FROM hunt_plans hp WHERE hp.territory_id = cp.territory_id;
ALTER TABLE coverage_plans ALTER COLUMN hunt_plan_id SET NOT NULL;
ALTER TABLE coverage_plans
  ADD CONSTRAINT coverage_plans_hunt_plan_fk FOREIGN KEY (territory_id, hunt_plan_id)
    REFERENCES hunt_plans (territory_id, id) ON DELETE CASCADE;
ALTER TABLE coverage_plans DROP CONSTRAINT coverage_plans_territory_id_hunter_count_key;
ALTER TABLE coverage_plans ADD CONSTRAINT coverage_plans_plan_count_key UNIQUE (hunt_plan_id, hunter_count);

-- Plan de chasse d'une battue (facultatif : sans plan, postes choisis à la main).
ALTER TABLE hunts ADD COLUMN hunt_plan_id uuid;
ALTER TABLE hunts
  ADD CONSTRAINT hunts_hunt_plan_fk FOREIGN KEY (territory_id, hunt_plan_id)
    REFERENCES hunt_plans (territory_id, id) ON DELETE SET NULL (hunt_plan_id);

-- ---------------------------------------------------------------------------
-- Enregistrement d'une ligne de grille : désormais par plan de chasse.
-- ---------------------------------------------------------------------------
DROP FUNCTION app.save_coverage_plan(uuid, integer, uuid[]);

CREATE FUNCTION app.save_coverage_plan(p_hunt_plan uuid, p_count integer, p_posts uuid[])
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_ids       uuid[] := ARRAY(SELECT DISTINCT unnest(p_posts));
  v_territory uuid;
  v_plan      uuid;
  v_before    integer[];
  v_after     integer[];
  v_bad       text;
BEGIN
  SELECT territory_id INTO v_territory FROM hunt_plans WHERE id = p_hunt_plan;
  IF v_territory IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: plan de chasse introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF cardinality(v_ids) <> p_count THEN
    RAISE EXCEPTION 'PLAN_COUNT_MISMATCH: % poste(s) coché(s) pour % chasseur(s)', cardinality(v_ids), p_count
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) i WHERE NOT EXISTS (
               SELECT 1 FROM posts p WHERE p.id = i AND p.territory_id = v_territory)) THEN
    RAISE EXCEPTION 'PLAN_POST_OTHER_TERRITORY: un poste n''appartient pas à ce territoire'
      USING ERRCODE = '23514';
  END IF;
  SELECT string_agg(p.number::text, ', ' ORDER BY p.number) INTO v_bad
    FROM posts p WHERE p.id = ANY (v_ids) AND (NOT p.active OR p.invalid_reason IS NOT NULL);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PLAN_POST_UNAVAILABLE: poste(s) % inactif(s) ou trop près d''une habitation', v_bad
      USING ERRCODE = '23514';
  END IF;

  SELECT cp.id INTO v_plan FROM coverage_plans cp
   WHERE cp.hunt_plan_id = p_hunt_plan AND cp.hunter_count = p_count;
  IF v_plan IS NULL THEN
    INSERT INTO coverage_plans (territory_id, hunt_plan_id, hunter_count, updated_by)
    VALUES (v_territory, p_hunt_plan, p_count, app.current_user_id()) RETURNING id INTO v_plan;
  ELSE
    SELECT array_agg(p.number ORDER BY p.number) INTO v_before
      FROM coverage_plan_posts cpp JOIN posts p ON p.id = cpp.post_id WHERE cpp.plan_id = v_plan;
    UPDATE coverage_plans SET updated_by = app.current_user_id(), updated_at = now() WHERE id = v_plan;
    DELETE FROM coverage_plan_posts WHERE plan_id = v_plan;
  END IF;

  INSERT INTO coverage_plan_posts (territory_id, plan_id, post_id)
  SELECT v_territory, v_plan, i FROM unnest(v_ids) i;

  SELECT array_agg(p.number ORDER BY p.number) INTO v_after FROM posts p WHERE p.id = ANY (v_ids);
  INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff)
  SELECT t.tenant_id, app.current_user_id(), CASE WHEN v_before IS NULL THEN 'insert' ELSE 'update' END,
         'coverage_plans', v_plan::text,
         jsonb_build_object('hunt_plan_id', p_hunt_plan, 'hunter_count', p_count,
                            'posts', jsonb_build_object('old', v_before, 'new', v_after))
    FROM territories t WHERE t.id = v_territory;
  RETURN v_plan;
END $$;

REVOKE ALL ON FUNCTION app.save_coverage_plan(uuid, integer, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.save_coverage_plan(uuid, integer, uuid[]) TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0017_plans_de_chasse.sql', '68ff888e9f2732e8e7a7ebd62f9acfc45df18663666568c9d1600c1cad085520');

COMMIT;
