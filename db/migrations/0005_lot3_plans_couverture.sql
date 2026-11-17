-- Lot 3 — Plans de couverture par effectif.
--
-- Pour chaque territoire, le président définit explicitement la liste des
-- postes à couvrir pour chaque nombre de chasseurs postés. Les listes ne
-- sont pas emboîtées : rien n'est déduit d'un plan à l'autre.
--
-- * Un plan s'enregistre en entier via app.save_coverage_plan (nombre de
--   postes = effectif, postes actifs et valides du même territoire).
-- * Un plan devient « invalide » (signalé en rouge) si l'un de ses postes est
--   ensuite invalidé (règle des habitations), désactivé ou supprimé : la
--   validité est calculée à la lecture, le plan n'est jamais modifié en silence.

-- Clé permettant de lier un poste à un plan du MÊME territoire.
ALTER TABLE posts ADD CONSTRAINT posts_territory_id_id_key UNIQUE (territory_id, id);

CREATE TABLE coverage_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id uuid NOT NULL,
  hunter_count integer NOT NULL CHECK (hunter_count BETWEEN 1 AND 999),
  updated_by   text REFERENCES users (id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (territory_id, hunter_count),
  UNIQUE (territory_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX coverage_plans_tenant_idx ON coverage_plans (tenant_id);

CREATE TABLE coverage_plan_posts (
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id uuid NOT NULL,
  plan_id      uuid NOT NULL,
  post_id      uuid NOT NULL,
  PRIMARY KEY (plan_id, post_id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (territory_id, plan_id) REFERENCES coverage_plans (territory_id, id) ON DELETE CASCADE,
  FOREIGN KEY (territory_id, post_id) REFERENCES posts (territory_id, id) ON DELETE CASCADE
);
CREATE INDEX coverage_plan_posts_post_idx ON coverage_plan_posts (post_id);

-- ---------------------------------------------------------------------------
-- Enregistrement d'un plan complet (droits de l'appelant : RLS appliquée)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.save_coverage_plan(p_territory uuid, p_count integer, p_posts uuid[])
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_ids     uuid[] := ARRAY(SELECT DISTINCT unnest(p_posts));
  v_plan    uuid;
  v_before  integer[];
  v_after   integer[];
  v_bad     text;
BEGIN
  IF cardinality(v_ids) <> p_count THEN
    RAISE EXCEPTION 'PLAN_COUNT_MISMATCH: % poste(s) coché(s) pour % chasseur(s)', cardinality(v_ids), p_count
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) i WHERE NOT EXISTS (
               SELECT 1 FROM posts p WHERE p.id = i AND p.territory_id = p_territory)) THEN
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
   WHERE cp.territory_id = p_territory AND cp.hunter_count = p_count;
  IF v_plan IS NULL THEN
    INSERT INTO coverage_plans (territory_id, hunter_count, updated_by)
    VALUES (p_territory, p_count, app.current_user_id()) RETURNING id INTO v_plan;
  ELSE
    SELECT array_agg(p.number ORDER BY p.number) INTO v_before
      FROM coverage_plan_posts cpp JOIN posts p ON p.id = cpp.post_id WHERE cpp.plan_id = v_plan;
    UPDATE coverage_plans SET updated_by = app.current_user_id(), updated_at = now() WHERE id = v_plan;
    DELETE FROM coverage_plan_posts WHERE plan_id = v_plan;
  END IF;

  INSERT INTO coverage_plan_posts (territory_id, plan_id, post_id)
  SELECT p_territory, v_plan, i FROM unnest(v_ids) i;

  SELECT array_agg(p.number ORDER BY p.number) INTO v_after FROM posts p WHERE p.id = ANY (v_ids);
  INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff)
  SELECT t.tenant_id, app.current_user_id(), CASE WHEN v_before IS NULL THEN 'insert' ELSE 'update' END,
         'coverage_plans', v_plan::text,
         jsonb_build_object('hunter_count', p_count, 'posts', jsonb_build_object('old', v_before, 'new', v_after))
    FROM territories t WHERE t.id = p_territory;
  RETURN v_plan;
END $$;

-- ---------------------------------------------------------------------------
-- RLS : lecture par tout membre (le responsable de battue s'en sert),
-- écriture par le président.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coverage_plans', 'coverage_plan_posts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$s_select ON %1$I FOR SELECT TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_write ON %1$I FOR ALL TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
                      WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rls', t);
  END LOOP;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;
