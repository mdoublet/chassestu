-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0008_notifications.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0008_notifications.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0008_notifications.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0007_admin_associations.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0007_admin_associations.sql';
  END IF;
END $guard$;

-- ==================== 0008_notifications.sql ====================
-- Notifications : alertes dans l'application (cloche) et notifications push.
--
-- * notifications : une alerte par destinataire (convocation, annulation,
--   attribution, début et fin de battue). Visible seulement par son
--   destinataire ; créée par app.notify_users (responsables de la battue).
-- * push_subscriptions : appareils où l'utilisateur a autorisé les
--   notifications push (une ligne par navigateur / téléphone).
-- * app_secrets : clés VAPID (signature des notifications push), générées
--   par l'API au premier usage ; jamais lisibles directement par app_rls.

CREATE TABLE app_secrets (
  name       text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_secrets ENABLE ROW LEVEL SECURITY;   -- aucune politique : accès par fonctions seulement

CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND length(endpoint) <= 2000),
  p256dh       text NOT NULL CHECK (length(p256dh) <= 200),
  auth         text NOT NULL CHECK (length(auth) <= 100),
  user_agent   text CHECK (length(user_agent) <= 300),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  failures     integer NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hunt_id    uuid REFERENCES hunts (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (length(kind) <= 40),
  title      text NOT NULL CHECK (length(title) <= 200),
  body       text NOT NULL DEFAULT '' CHECK (length(body) <= 1000),
  url        text NOT NULL DEFAULT '#/' CHECK (url ~ '^#/' AND length(url) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Fonctions
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.vapid_keys() RETURNS TABLE (public_key text, private_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT (SELECT value FROM app_secrets WHERE name = 'vapid_public'),
           (SELECT value FROM app_secrets WHERE name = 'vapid_private')
     WHERE app.current_user_id() IS NOT NULL
  $$;

-- Enregistre les clés VAPID si elles n'existent pas encore (premier usage).
CREATE FUNCTION app.init_vapid_keys(p_public text, p_private text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_secrets WHERE name = 'vapid_public') THEN
    INSERT INTO app_secrets (name, value) VALUES ('vapid_public', p_public), ('vapid_private', p_private)
    ON CONFLICT (name) DO NOTHING;
  END IF;
END $$;

-- Un appareil = un abonnement ; s'il change d'utilisateur (téléphone partagé),
-- il passe au nouvel utilisateur connecté.
CREATE FUNCTION app.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  VALUES (app.current_user_id(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  ON CONFLICT (endpoint) DO UPDATE
     SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent, failures = 0;
END $$;

-- Alertes aux participants d'une battue. p_items : [{user_id, title, body}].
-- Réservé au président / responsable du tenant de la battue ; seuls les
-- membres convoqués à cette battue peuvent être destinataires. Renvoie, pour
-- l'envoi push, les appareils des destinataires.
CREATE FUNCTION app.notify_users(p_hunt uuid, p_kind text, p_url text, p_items jsonb)
  RETURNS TABLE (user_id text, title text, body text, endpoint text, p256dh text, auth text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT h.tenant_id INTO v_tenant FROM hunts h WHERE h.id = p_hunt;
  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM app.current_tenant_id()
     OR NOT app.has_role('president', 'responsable') THEN
    RAISE EXCEPTION 'FORBIDDEN: notification non autorisée' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    WITH items AS (
      SELECT i.user_id, left(i.title, 200) AS title, left(coalesce(i.body, ''), 1000) AS body
        FROM jsonb_to_recordset(p_items) AS i(user_id text, title text, body text)
       WHERE EXISTS (SELECT 1 FROM hunt_participants hp WHERE hp.hunt_id = p_hunt AND hp.user_id = i.user_id)
    ), ins AS (
      INSERT INTO notifications (tenant_id, user_id, hunt_id, kind, title, body, url)
      SELECT v_tenant, items.user_id, p_hunt, p_kind, items.title, items.body, p_url FROM items
      RETURNING notifications.user_id, notifications.title, notifications.body
    )
    SELECT ins.user_id, ins.title, ins.body, s.endpoint, s.p256dh, s.auth
      FROM ins LEFT JOIN push_subscriptions s ON s.user_id = ins.user_id;
END $$;

-- Résultat d'un envoi push : appareil désabonné (404/410) → supprimé ;
-- échecs répétés → supprimé au-delà de 10.
CREATE FUNCTION app.push_result(p_endpoint text, p_ok boolean, p_gone boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_gone THEN
    DELETE FROM push_subscriptions WHERE endpoint = p_endpoint;
  ELSIF p_ok THEN
    UPDATE push_subscriptions SET last_used_at = now(), failures = 0 WHERE endpoint = p_endpoint;
  ELSE
    UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = p_endpoint;
    DELETE FROM push_subscriptions WHERE endpoint = p_endpoint AND failures > 10;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS : chacun ne voit que ses alertes et ses appareils.
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_own ON notifications FOR SELECT TO app_rls
  USING (user_id = (SELECT app.current_user_id()));
CREATE POLICY notifications_read ON notifications FOR UPDATE TO app_rls
  USING (user_id = (SELECT app.current_user_id()))
  WITH CHECK (user_id = (SELECT app.current_user_id()));
CREATE POLICY push_subscriptions_own ON push_subscriptions FOR ALL TO app_rls
  USING (user_id = (SELECT app.current_user_id()))
  WITH CHECK (user_id = (SELECT app.current_user_id()));

GRANT SELECT ON notifications TO app_rls;
GRANT UPDATE (read_at) ON notifications TO app_rls;
GRANT SELECT, DELETE ON push_subscriptions TO app_rls;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0008_notifications.sql', '22d202b5c2c9eaae86aa98e7030b5dbf1e49bc7204279ec6ae4a770000b564e7');

COMMIT;
