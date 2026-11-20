-- 1. Président adjoint : mandat temporaire donné par le président. Pendant le
--    mandat, le membre a les droits du président (app.current_member_role()
--    renvoie 'president'), sauf modifier les droits des autres : rôles, retrait
--    de membres, mandats, invitations à un autre rôle que chasseur.
-- 2. Responsable de battue (hunts.leader_user_id) : voit qui est en place et
--    peut lancer et arrêter sa battue depuis la vue chasseur.

ALTER TABLE memberships ADD COLUMN deputy_until timestamptz;
GRANT UPDATE (deputy_until) ON memberships TO app_rls; -- écriture : politique memberships_update (président en titre)

/** Rôle effectif : 'president' pendant un mandat d'adjoint. */
CREATE FUNCTION app.effective_role(p_role member_role, p_deputy_until timestamptz) RETURNS member_role
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_deputy_until IS NOT NULL AND p_deputy_until > now() THEN 'president'::member_role ELSE p_role END
$$;

CREATE OR REPLACE FUNCTION app.current_member_role() RETURNS member_role
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT app.effective_role(m.role, m.deputy_until) FROM memberships m
     WHERE m.tenant_id = app.requested_tenant_id()
       AND m.user_id = app.current_user_id()
  $$;

/** L'appelant est-il président adjoint (et non président en titre) ? */
CREATE FUNCTION app.is_deputy() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT coalesce((SELECT m.role <> 'president' AND m.deputy_until > now() FROM memberships m
                      WHERE m.tenant_id = app.requested_tenant_id() AND m.user_id = app.current_user_id()), false)
  $$;

-- Droits des autres : président en titre seulement.
DROP POLICY memberships_update ON memberships;
CREATE POLICY memberships_update ON memberships FOR UPDATE TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president') AND NOT app.is_deputy())
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
DROP POLICY memberships_delete ON memberships;
CREATE POLICY memberships_delete ON memberships FOR DELETE TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND ((app.has_role('president') AND NOT app.is_deputy()) OR user_id = (SELECT app.current_user_id())));
DROP POLICY invitations_all ON invitations;
CREATE POLICY invitations_all ON invitations FOR ALL TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president')
              AND (role = 'chasseur' OR NOT app.is_deputy()));

-- ---------------------------------------------------------------------------
-- Responsable de battue
-- ---------------------------------------------------------------------------

/** Président / responsable, ou responsable désigné de cette battue. */
CREATE FUNCTION app.can_lead_hunt(p_hunt uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM hunts h WHERE h.id = p_hunt AND h.tenant_id = app.current_tenant_id()
                   AND (app.has_role('president', 'responsable') OR h.leader_user_id = app.current_user_id()))
$$;

/** Début ou fin de battue par son responsable désigné (droits du président sinon). */
CREATE FUNCTION app.lead_hunt_action(p_hunt uuid, p_action text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  h hunts%ROWTYPE;
BEGIN
  SELECT * INTO h FROM hunts WHERE id = p_hunt;
  IF NOT FOUND OR NOT app.can_lead_hunt(p_hunt) THEN
    RAISE EXCEPTION 'FORBIDDEN: vous n''êtes pas responsable de cette battue' USING ERRCODE = '42501';
  END IF;
  IF h.status <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_BAD_STATUS: la battue est terminée' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'debut' THEN
    IF h.assignments_published_at IS NULL THEN
      RAISE EXCEPTION 'ASSIGNMENTS_NOT_PUBLISHED: publiez les postes avant de lancer la battue' USING ERRCODE = '23514';
    END IF;
    UPDATE hunts SET started_at = coalesce(started_at, now()) WHERE id = p_hunt;
  ELSIF p_action = 'fin' THEN
    UPDATE hunts SET status = 'terminee' WHERE id = p_hunt;
    -- Le regroupement précédent ne vaut plus : un nouveau sera annoncé.
    UPDATE hunt_days SET regroup_at = NULL WHERE id = h.day_id;
  ELSE
    RAISE EXCEPTION 'VALIDATION: action inconnue' USING ERRCODE = '22023';
  END IF;
END $$;

/** Mise en place des postés, pour le responsable de la battue. */
CREATE FUNCTION app.hunt_readiness(p_hunt uuid)
  RETURNS TABLE (post_number int, post_name text, participant_name text, in_place_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app.can_lead_hunt(p_hunt) THEN
    RAISE EXCEPTION 'FORBIDDEN: vous n''êtes pas responsable de cette battue' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT p.number::int, p.name, coalesce(u.display_name, hp.guest_name), hp.in_place_at
      FROM hunt_posts hpo
      JOIN posts p ON p.id = hpo.post_id
      LEFT JOIN hunt_assignments a ON a.post_id = hpo.post_id AND a.hunt_id = hpo.hunt_id
      LEFT JOIN hunt_participants hp ON hp.id = a.participant_id
      LEFT JOIN users u ON u.id = hp.user_id
     WHERE hpo.hunt_id = p_hunt
     ORDER BY p.number, 3;
END $$;

-- Alertes de battue : aussi envoyées par son responsable désigné.
CREATE OR REPLACE FUNCTION app.notify_users(p_hunt uuid, p_kind text, p_url text, p_items jsonb)
  RETURNS TABLE (user_id text, title text, body text, endpoint text, p256dh text, auth text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
  v_day uuid;
BEGIN
  SELECT h.tenant_id, h.day_id INTO v_tenant, v_day FROM hunts h WHERE h.id = p_hunt;
  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM app.current_tenant_id() OR NOT app.can_lead_hunt(p_hunt) THEN
    RAISE EXCEPTION 'FORBIDDEN: notification non autorisée' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    WITH items AS (
      SELECT i.user_id, left(i.title, 200) AS title, left(coalesce(i.body, ''), 1000) AS body
        FROM jsonb_to_recordset(p_items) AS i(user_id text, title text, body text)
       WHERE EXISTS (SELECT 1 FROM hunt_participants hp WHERE hp.hunt_id = p_hunt AND hp.user_id = i.user_id)
          OR EXISTS (SELECT 1 FROM hunts x WHERE x.id = p_hunt AND x.leader_user_id = i.user_id)
    ), ins AS (
      INSERT INTO notifications (tenant_id, user_id, hunt_id, day_id, kind, title, body, url)
      SELECT v_tenant, items.user_id, p_hunt, v_day, p_kind, items.title, items.body, p_url FROM items
      RETURNING notifications.user_id, notifications.title, notifications.body
    )
    SELECT ins.user_id, ins.title, ins.body, s.endpoint, s.p256dh, s.auth
      FROM ins LEFT JOIN push_subscriptions s ON s.user_id = ins.user_id;
END $$;

REVOKE ALL ON FUNCTION app.effective_role(member_role, timestamptz), app.is_deputy(), app.can_lead_hunt(uuid),
  app.lead_hunt_action(uuid, text), app.hunt_readiness(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.effective_role(member_role, timestamptz), app.is_deputy(), app.can_lead_hunt(uuid),
  app.lead_hunt_action(uuid, text), app.hunt_readiness(uuid), app.notify_users(uuid, text, text, jsonb) TO app_rls;
