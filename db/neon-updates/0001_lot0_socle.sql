-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0001_lot0_socle.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0001_lot0_socle.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0001_lot0_socle.sql';
  END IF;
END $guard$;

-- ==================== 0001_lot0_socle.sql ====================
-- Lot 0 — Socle multi-tenant
-- Tenants, utilisateurs, appartenances, invitations, journal d'audit et
-- isolation par Row Level Security.
--
-- Principe d'isolation :
--   * l'API se connecte avec le rôle propriétaire (neondb_owner sur Neon,
--     qui a BYPASSRLS) mais exécute CHAQUE transaction après
--     `SET LOCAL ROLE app_rls`, un rôle sans BYPASSRLS et non propriétaire
--     des tables : la RLS s'applique donc toujours ;
--   * l'API pose app.user_id et app.tenant_id via set_config(..., true) ;
--   * app.current_tenant_id() ne renvoie le tenant demandé QUE si
--     l'utilisateur en est membre : un tenant_id forgé ne donne accès à rien.
--
-- Les fonctions SECURITY DEFINER appartiennent au propriétaire des tables
-- et contournent donc la RLS : elles doivent rester courtes et vérifier
-- elles-mêmes leurs préconditions.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- Rôle applicatif
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Le rôle qui exécute les migrations (et l'API) doit pouvoir faire SET ROLE.
DO $$
BEGIN
  EXECUTE format('GRANT app_rls TO %I', current_user);
EXCEPTION WHEN others THEN
  RAISE NOTICE 'GRANT app_rls TO % ignoré : %', current_user, SQLERRM;
END $$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO app_rls;
GRANT USAGE ON SCHEMA public TO app_rls;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
CREATE TYPE member_role AS ENUM ('president', 'responsable', 'chasseur');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             text PRIMARY KEY,                 -- identifiant du fournisseur d'auth
  display_name   text NOT NULL DEFAULT '' CHECK (length(display_name) <= 120),
  email          text CHECK (length(email) <= 320),
  phone          text CHECK (length(phone) <= 40),
  is_super_admin boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind                 text NOT NULL DEFAULT 'acca' CHECK (kind IN ('acca', 'societe', 'autre')),
  departement          text CHECK (departement ~ '^([0-9]{2}|2A|2B|97[1-6])$'),
  buffer_distance_m    integer NOT NULL DEFAULT 150 CHECK (buffer_distance_m BETWEEN 50 AND 1000),
  gps_tolerance_m      integer NOT NULL DEFAULT 30 CHECK (gps_tolerance_m BETWEEN 5 AND 200),
  position_retention_h integer NOT NULL DEFAULT 24 CHECK (position_retention_h BETWEEN 1 AND 720),
  show_all_posts       boolean NOT NULL DEFAULT false, -- les chasseurs voient-ils tous les postes ?
  created_by           text REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  role       member_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX memberships_tenant_idx ON memberships (tenant_id);

-- ---------------------------------------------------------------------------
-- Fonctions de contexte (lues par les politiques RLS)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.current_user_id() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;

CREATE FUNCTION app.requested_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Tenant courant, seulement si l'utilisateur courant en est membre.
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.tenant_id FROM memberships m
     WHERE m.tenant_id = app.requested_tenant_id()
       AND m.user_id = app.current_user_id()
  $$;

CREATE FUNCTION app.current_member_role() RETURNS member_role
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.role FROM memberships m
     WHERE m.tenant_id = app.requested_tenant_id()
       AND m.user_id = app.current_user_id()
  $$;

CREATE FUNCTION app.has_role(VARIADIC roles member_role[]) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(app.current_member_role() = ANY (roles), false) $$;

CREATE FUNCTION app.is_super_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT coalesce((SELECT is_super_admin FROM users WHERE id = app.current_user_id()), false) $$;

-- Tables dépendant du tenant courant (DEFAULT app.current_tenant_id()).
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,         -- SHA-256 du jeton ; le jeton n'est jamais stocké
  role        member_role NOT NULL DEFAULT 'chasseur',
  max_uses    integer CHECK (max_uses > 0), -- NULL = illimité (lien partagé dans un groupe)
  use_count   integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_by  text REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id);

CREATE TABLE audit_log (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  actor_id  text,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  at        timestamptz NOT NULL DEFAULT now(),
  diff      jsonb
);
CREATE INDEX audit_log_tenant_at_idx ON audit_log (tenant_id, at DESC);

-- ---------------------------------------------------------------------------
-- Déclencheurs génériques
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Journal d'audit : enregistre les colonnes modifiées (ancienne et nouvelle valeur).
-- SECURITY DEFINER : le journal doit s'écrire même quand la ligne modifiée
-- fait perdre l'accès au tenant (ex. un membre qui quitte l'association).
CREATE FUNCTION app.audit_trigger() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_diff jsonb;
  v_tenant uuid;
BEGIN
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

  v_tenant := CASE WHEN TG_TABLE_NAME = 'tenants' THEN (v_row ->> 'id')::uuid
                   ELSE (v_row ->> 'tenant_id')::uuid END;

  INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff)
  VALUES (v_tenant, app.current_user_id(), lower(TG_OP), TG_TABLE_NAME,
          coalesce(v_row ->> 'id', v_row ->> 'user_id'), v_diff);
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER tenants_audit AFTER UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER memberships_audit AFTER INSERT OR UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log   ENABLE ROW LEVEL SECURITY;

-- users : soi-même, et les membres du tenant courant.
CREATE POLICY users_select ON users FOR SELECT TO app_rls
  USING (id = (SELECT app.current_user_id())
         OR EXISTS (SELECT 1 FROM memberships m
                     WHERE m.user_id = users.id
                       AND m.tenant_id = (SELECT app.current_tenant_id())));
CREATE POLICY users_insert ON users FOR INSERT TO app_rls
  WITH CHECK (id = (SELECT app.current_user_id()) AND NOT is_super_admin);
CREATE POLICY users_update ON users FOR UPDATE TO app_rls
  USING (id = (SELECT app.current_user_id()))
  WITH CHECK (id = (SELECT app.current_user_id()));
CREATE POLICY users_delete ON users FOR DELETE TO app_rls
  USING (id = (SELECT app.current_user_id()));

-- tenants : ceux dont on est membre ; modification par le président.
CREATE POLICY tenants_select ON tenants FOR SELECT TO app_rls
  USING (EXISTS (SELECT 1 FROM memberships m
                  WHERE m.tenant_id = tenants.id
                    AND m.user_id = (SELECT app.current_user_id()))
         OR (SELECT app.is_super_admin()));
CREATE POLICY tenants_update ON tenants FOR UPDATE TO app_rls
  USING (id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
  WITH CHECK (id = (SELECT app.current_tenant_id()));

-- memberships : celles du tenant courant + les siennes (sélecteur de tenant).
CREATE POLICY memberships_select ON memberships FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id())
         OR user_id = (SELECT app.current_user_id()));
CREATE POLICY memberships_update ON memberships FOR UPDATE TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY memberships_delete ON memberships FOR DELETE TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND (app.has_role('president') OR user_id = (SELECT app.current_user_id())));
-- Pas d'INSERT direct : uniquement via app.accept_invitation / app.create_tenant.

CREATE POLICY invitations_all ON invitations FOR ALL TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'));

CREATE POLICY audit_select ON audit_log FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'));
CREATE POLICY audit_insert ON audit_log FOR INSERT TO app_rls
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Opérations privilégiées (SECURITY DEFINER)
-- ---------------------------------------------------------------------------

-- Création d'un tenant par le super-admin, avec un lien d'invitation
-- « président » à usage unique (le jeton est généré par l'API).
CREATE FUNCTION app.create_tenant(p_name text, p_kind text, p_departement text,
                                  p_president_token_hash text, p_expires_at timestamptz)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN: réservé au super-admin' USING ERRCODE = '42501';
  END IF;
  INSERT INTO tenants (name, kind, departement, created_by)
  VALUES (p_name, coalesce(p_kind, 'acca'), p_departement, app.current_user_id())
  RETURNING id INTO v_id;
  INSERT INTO invitations (tenant_id, token_hash, role, max_uses, expires_at, created_by)
  VALUES (v_id, p_president_token_hash, 'president', 1, p_expires_at, app.current_user_id());
  RETURN v_id;
END $$;

-- Aperçu d'une invitation (avant de l'accepter : l'utilisateur n'est pas membre).
CREATE FUNCTION app.invitation_preview(p_token_hash text)
  RETURNS TABLE (tenant_name text, role member_role, valid boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.name, i.role,
           (i.revoked_at IS NULL AND i.expires_at > now()
            AND (i.max_uses IS NULL OR i.use_count < i.max_uses))
      FROM invitations i JOIN tenants t ON t.id = i.tenant_id
     WHERE i.token_hash = p_token_hash
  $$;

-- Acceptation : rattache l'utilisateur courant au tenant. Si l'utilisateur
-- est déjà membre, on garde le rôle le plus élevé.
CREATE FUNCTION app.accept_invitation(p_token_hash text)
  RETURNS TABLE (tenant_id uuid, role member_role)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_inv invitations%ROWTYPE;
  v_user text := app.current_user_id();
BEGIN
  IF v_user IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = v_user) THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv FROM invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_inv.revoked_at IS NOT NULL OR v_inv.expires_at <= now()
     OR (v_inv.max_uses IS NOT NULL AND v_inv.use_count >= v_inv.max_uses) THEN
    RAISE EXCEPTION 'INVITATION_INVALID' USING ERRCODE = 'P0001';
  END IF;

  -- L'ordre de l'enum définit la hiérarchie : president < responsable < chasseur.
  INSERT INTO memberships AS m (user_id, tenant_id, role)
  VALUES (v_user, v_inv.tenant_id, v_inv.role)
  ON CONFLICT (user_id, tenant_id) DO UPDATE
     SET role = LEAST(m.role, EXCLUDED.role);

  UPDATE invitations SET use_count = use_count + 1 WHERE id = v_inv.id;

  RETURN QUERY SELECT m.tenant_id, m.role FROM memberships m
                WHERE m.user_id = v_user AND m.tenant_id = v_inv.tenant_id;
END $$;

-- Associations dont l'utilisateur courant est le seul président (empêche de
-- laisser une association sans président en quittant ou en supprimant son compte).
CREATE FUNCTION app.sole_president_tenants() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT m.tenant_id FROM memberships m
     WHERE m.user_id = app.current_user_id() AND m.role = 'president'
       AND NOT EXISTS (SELECT 1 FROM memberships o
                        WHERE o.tenant_id = m.tenant_id AND o.role = 'president'
                          AND o.user_id <> m.user_id)
  $$;

-- ---------------------------------------------------------------------------
-- Droits du rôle applicatif
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;

GRANT SELECT, INSERT, DELETE ON users TO app_rls;
GRANT UPDATE (display_name, email, phone) ON users TO app_rls;  -- jamais is_super_admin
GRANT SELECT ON tenants TO app_rls;
GRANT UPDATE (name, kind, departement, buffer_distance_m, gps_tolerance_m,
              position_retention_h, show_all_posts) ON tenants TO app_rls;
GRANT SELECT, DELETE ON memberships TO app_rls;
GRANT UPDATE (role) ON memberships TO app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO app_rls;
GRANT SELECT, INSERT ON audit_log TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0001_lot0_socle.sql', '2298ec2b990713d3068c9fb57c43d681d5ee953fb1456c3597dc4a5db3961daf');

COMMIT;
