-- Administration de la plateforme : liste des associations et suppression.
--
-- Réservé au super-administrateur (vérifié dans chaque fonction). La
-- suppression d'une association efface toutes ses données (territoires,
-- plans, battues, journal…) par cascade. En option, elle supprime aussi les
-- utilisateurs qui n'appartiennent à AUCUNE autre association ; ne sont
-- jamais supprimés : les membres d'autres associations, les
-- super-administrateurs et l'administrateur qui agit.

-- Journal d'audit : ignorer les lignes supprimées en cascade avec leur
-- association (le journal de l'association disparaît avec elle).
CREATE OR REPLACE FUNCTION app.audit_trigger() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_diff jsonb;
  v_tenant uuid;
BEGIN
  v_tenant := CASE WHEN TG_TABLE_NAME = 'tenants' THEN (v_row ->> 'id')::uuid
                   ELSE (v_row ->> 'tenant_id')::uuid END;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_tenant) THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(o.key, jsonb_build_object('old', o.value, 'new', n.value))
      INTO v_diff
      FROM jsonb_each(v_old) o
      JOIN jsonb_each(v_new) n USING (key)
     WHERE o.value IS DISTINCT FROM n.value
       AND o.key NOT IN ('updated_at');
    IF v_diff IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    v_diff := v_row;
  END IF;

  INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff)
  VALUES (v_tenant, app.current_user_id(), lower(TG_OP), TG_TABLE_NAME,
          coalesce(v_row ->> 'id', v_row ->> 'user_id'), v_diff);
  RETURN coalesce(NEW, OLD);
END $$;

CREATE FUNCTION app.assert_super_admin() RETURNS void
  LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN: réservé au super-administrateur' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE FUNCTION app.admin_list_tenants()
  RETURNS TABLE (id uuid, name text, kind text, departement text, created_at timestamptz,
                 members integer, presidents text, territories integer, hunts integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM app.assert_super_admin();
  RETURN QUERY
    SELECT t.id, t.name, t.kind, t.departement, t.created_at,
           (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id),
           (SELECT string_agg(coalesce(nullif(u.display_name, ''), u.email, u.id), ', ' ORDER BY u.display_name)
              FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.tenant_id = t.id AND m.role = 'president'),
           (SELECT count(*)::int FROM territories x WHERE x.tenant_id = t.id),
           (SELECT count(*)::int FROM hunts h WHERE h.tenant_id = t.id)
      FROM tenants t
     ORDER BY t.name;
END $$;

-- Membres d'une association, et ce que deviendrait chacun si on la supprimait.
CREATE FUNCTION app.admin_tenant_members(p_tenant uuid)
  RETURNS TABLE (user_id text, name text, email text, role member_role, other_tenants integer, deletable boolean, kept_reason text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM app.assert_super_admin();
  RETURN QUERY
    SELECT u.id, coalesce(nullif(u.display_name, ''), u.email, u.id), u.email, m.role,
           (SELECT count(*)::int FROM memberships o WHERE o.user_id = u.id AND o.tenant_id <> p_tenant) AS other,
           x.reason IS NULL,
           x.reason
      FROM memberships m JOIN users u ON u.id = m.user_id,
           LATERAL (SELECT CASE
                      WHEN u.id = app.current_user_id() THEN 'vous-même'
                      WHEN u.is_super_admin THEN 'super-administrateur'
                      WHEN EXISTS (SELECT 1 FROM memberships o WHERE o.user_id = u.id AND o.tenant_id <> p_tenant)
                        THEN 'membre d''une autre association'
                    END AS reason) x
     WHERE m.tenant_id = p_tenant
     ORDER BY x.reason IS NULL DESC, 2;
END $$;

-- Supprime l'association et, si demandé, ses utilisateurs « exclusifs ».
-- Renvoie les identifiants des utilisateurs supprimés (pour supprimer aussi
-- leur compte de connexion chez le fournisseur d'identité).
CREATE FUNCTION app.admin_delete_tenant(p_tenant uuid, p_delete_users boolean)
  RETURNS text[]
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_users text[] := '{}';
BEGIN
  PERFORM app.assert_super_admin();
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'NOT_FOUND: association introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF p_delete_users THEN
    SELECT coalesce(array_agg(user_id), '{}') INTO v_users
      FROM app.admin_tenant_members(p_tenant) WHERE deletable;
  END IF;
  DELETE FROM tenants WHERE id = p_tenant;          -- cascade : toutes les données de l'association
  DELETE FROM users WHERE id = ANY (v_users);
  RETURN v_users;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;
