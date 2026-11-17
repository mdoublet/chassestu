-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- À exécuter UNE FOIS sur une base vide, dans l’éditeur SQL de Neon.
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

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0002_lot1_cartographie.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0002_lot1_cartographie.sql';
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

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0003_lot2_habitations.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0003_lot2_habitations.sql';
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

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0004_postes_hors_territoire.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0004_postes_hors_territoire.sql';
  END IF;
END $guard$;

-- ==================== 0004_postes_hors_territoire.sql ====================
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

INSERT INTO schema_migrations (name, checksum) VALUES ('0004_postes_hors_territoire.sql', 'b8de712ed440e57352ff8ca5241fc507359a6fd08963b171cf448cd1df226b35');

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0005_lot3_plans_couverture.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0005_lot3_plans_couverture.sql';
  END IF;
END $guard$;

-- ==================== 0005_lot3_plans_couverture.sql ====================
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

INSERT INTO schema_migrations (name, checksum) VALUES ('0005_lot3_plans_couverture.sql', '6af67a8580c5a9c6069a172570b11bd43207279ad3d3eeff1c559c89a0f65b91');

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0006_lot4_battues.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0006_lot4_battues.sql';
  END IF;
END $guard$;

-- ==================== 0006_lot4_battues.sql ====================
-- Lot 4 — Battue et attribution des postes.
--
-- Cycle de vie : brouillon → publiée → en cours → terminée ; annulée depuis
-- brouillon ou publiée. Les postes du jour et leur attribution n'existent
-- qu'en cours. Un chasseur ne voit une battue que s'il y est convoqué et
-- qu'elle n'est plus en brouillon ; un invité sans compte y accède par un lien
-- personnel (jeton) valable pour cette seule battue, jusqu'à sa clôture.

CREATE TYPE hunt_status AS ENUM ('brouillon', 'publiee', 'en_cours', 'terminee', 'annulee');
CREATE TYPE hunt_role AS ENUM ('poste', 'traqueur', 'chef_de_ligne');

CREATE TABLE hunts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id             uuid NOT NULL,
  date                     date NOT NULL,
  meeting_time             time NOT NULL DEFAULT '08:00',
  meeting_point            geometry(Point, 4326),
  meeting_place            text NOT NULL DEFAULT '' CHECK (length(meeting_place) <= 200),
  briefing                 text NOT NULL DEFAULT '' CHECK (length(briefing) <= 5000),
  leader_user_id           text REFERENCES users (id) ON DELETE SET NULL,
  status                   hunt_status NOT NULL DEFAULT 'brouillon',
  assignments_published_at timestamptz,
  started_at               timestamptz,   -- « Début de battue »
  ended_at                 timestamptz,   -- « Fin de battue » (statut terminée)
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (territory_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX hunts_tenant_date_idx ON hunts (tenant_id, date DESC);

CREATE TABLE hunt_participants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant_id(),
  hunt_id          uuid NOT NULL,
  user_id          text REFERENCES users (id) ON DELETE CASCADE,
  guest_name       text CHECK (length(btrim(guest_name)) BETWEEN 1 AND 120),
  role             hunt_role NOT NULL DEFAULT 'poste',
  response         text CHECK (response IN ('present', 'absent')),   -- réponse à la convocation
  present          boolean NOT NULL DEFAULT false,                   -- coché au rond du matin
  guest_token_hash text UNIQUE,                                      -- lien invité (empreinte SHA-256)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, user_id),
  UNIQUE (hunt_id, id),
  FOREIGN KEY (tenant_id, hunt_id) REFERENCES hunts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT participant_member_or_guest CHECK ((user_id IS NULL) <> (guest_name IS NULL)),
  CONSTRAINT guest_token_only_for_guests CHECK (guest_token_hash IS NULL OR user_id IS NULL)
);
CREATE INDEX hunt_participants_user_idx ON hunt_participants (user_id);

-- Postes couverts ce jour-là (proposition du plan, modifiable sans toucher au plan).
CREATE TABLE hunt_posts (
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  hunt_id      uuid NOT NULL,
  territory_id uuid NOT NULL,
  post_id      uuid NOT NULL,
  PRIMARY KEY (hunt_id, post_id),
  FOREIGN KEY (tenant_id, hunt_id) REFERENCES hunts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (territory_id, hunt_id) REFERENCES hunts (territory_id, id) ON DELETE CASCADE,
  FOREIGN KEY (territory_id, post_id) REFERENCES posts (territory_id, id) ON DELETE CASCADE
);

CREATE TABLE hunt_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id(),
  hunt_id        uuid NOT NULL,
  post_id        uuid NOT NULL,
  participant_id uuid NOT NULL,
  locked         boolean NOT NULL DEFAULT false,   -- conservé par le tirage au sort
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, participant_id),                -- un poste par chasseur
  FOREIGN KEY (tenant_id, hunt_id) REFERENCES hunts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hunt_id, post_id) REFERENCES hunt_posts (hunt_id, post_id) ON DELETE CASCADE,
  FOREIGN KEY (hunt_id, participant_id) REFERENCES hunt_participants (hunt_id, id) ON DELETE CASCADE
);
CREATE INDEX hunt_assignments_post_idx ON hunt_assignments (hunt_id, post_id);

-- ---------------------------------------------------------------------------
-- Règles
-- ---------------------------------------------------------------------------

-- Postes du jour et attribution : seulement en cours ; au plus deux chasseurs
-- par poste (doublon choisi par le responsable) ; chasseur présent et posté.
CREATE FUNCTION app.check_hunt_assignment() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM hunts WHERE id = NEW.hunt_id) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: l''attribution n''est possible que pendant la battue (en cours)'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'hunt_assignments' THEN
    IF NOT EXISTS (SELECT 1 FROM hunt_participants hp
                    WHERE hp.id = NEW.participant_id AND hp.present AND hp.role = 'poste') THEN
      RAISE EXCEPTION 'PARTICIPANT_NOT_POSTED: seul un chasseur présent et posté reçoit un poste'
        USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM hunt_assignments a
         WHERE a.hunt_id = NEW.hunt_id AND a.post_id = NEW.post_id AND a.id <> NEW.id) >= 2 THEN
      RAISE EXCEPTION 'POST_FULL: deux chasseurs au plus par poste'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hunt_assignments_check BEFORE INSERT OR UPDATE ON hunt_assignments
  FOR EACH ROW EXECUTE FUNCTION app.check_hunt_assignment();
CREATE TRIGGER hunt_posts_check BEFORE INSERT ON hunt_posts
  FOR EACH ROW EXECUTE FUNCTION app.check_hunt_assignment();

-- Un chasseur qui n'est plus présent ou plus posté perd son poste.
CREATE FUNCTION app.participant_changed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.present OR NEW.role <> 'poste' THEN
    DELETE FROM hunt_assignments WHERE participant_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER hunt_participants_changed AFTER UPDATE OF present, role ON hunt_participants
  FOR EACH ROW EXECUTE FUNCTION app.participant_changed();

-- Transitions de statut autorisées.
CREATE FUNCTION app.check_hunt_status() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'brouillon' AND NEW.status IN ('publiee', 'annulee'))
    OR (OLD.status = 'publiee'   AND NEW.status IN ('en_cours', 'annulee', 'brouillon'))
    OR (OLD.status = 'en_cours'  AND NEW.status = 'terminee')) THEN
    RAISE EXCEPTION 'HUNT_BAD_TRANSITION: passage de « % » à « % » impossible', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'terminee' THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hunts_status BEFORE UPDATE OF status ON hunts
  FOR EACH ROW EXECUTE FUNCTION app.check_hunt_status();
CREATE TRIGGER hunts_touch BEFORE UPDATE ON hunts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Audit des battues et des attributions.
CREATE TRIGGER hunts_audit AFTER INSERT OR UPDATE OR DELETE ON hunts
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER hunt_assignments_audit AFTER INSERT OR UPDATE OR DELETE ON hunt_assignments
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

-- ---------------------------------------------------------------------------
-- Accès des chasseurs et des invités
-- ---------------------------------------------------------------------------

-- Battues (hors brouillon) auxquelles l'utilisateur courant est convoqué.
-- SECURITY DEFINER : évite la récursion des politiques sur hunt_participants.
CREATE FUNCTION app.my_hunt_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT hp.hunt_id FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
     WHERE hp.user_id = app.current_user_id() AND h.status <> 'brouillon'
       AND h.tenant_id = app.current_tenant_id()
  $$;

-- Réponse à une convocation (battue publiée).
CREATE FUNCTION app.respond_hunt(p_hunt uuid, p_response text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_response NOT IN ('present', 'absent') THEN
    RAISE EXCEPTION 'INVALID: réponse inconnue' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hunts WHERE id = p_hunt AND status = 'publiee'
                    AND tenant_id = app.current_tenant_id()) THEN
    RAISE EXCEPTION 'HUNT_NOT_OPEN: on ne répond qu''à une battue publiée' USING ERRCODE = '23514';
  END IF;
  UPDATE hunt_participants SET response = p_response
   WHERE hunt_id = p_hunt AND user_id = app.current_user_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_INVITED: vous n''êtes pas convoqué à cette battue' USING ERRCODE = '42501';
  END IF;
END $$;

-- Fiche d'un participant : battue, son poste et ses voisins (si les
-- attributions sont publiées), de quoi dessiner la carte. Appelée par
-- app.my_hunt_sheet (membre) et app.guest_hunt_sheet (invité), qui vérifient l'accès.
CREATE FUNCTION app.hunt_sheet(p_participant uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_p      hunt_participants%ROWTYPE;
  v_h      hunts%ROWTYPE;
  v_all    boolean;
  v_post   uuid;
  v_result jsonb;
BEGIN
  SELECT * INTO v_p FROM hunt_participants WHERE id = p_participant;
  SELECT * INTO v_h FROM hunts WHERE id = v_p.hunt_id;
  SELECT show_all_posts INTO v_all FROM tenants WHERE id = v_h.tenant_id;
  SELECT a.post_id INTO v_post FROM hunt_assignments a
   WHERE a.participant_id = v_p.id AND v_h.assignments_published_at IS NOT NULL;

  WITH day_posts AS (
    SELECT p.id, p.number, p.name,
           row_number() OVER (ORDER BY p.number) AS rk,
           (SELECT string_agg(coalesce(u.display_name, x.guest_name), ' et ' ORDER BY coalesce(u.display_name, x.guest_name))
              FROM hunt_assignments a JOIN hunt_participants x ON x.id = a.participant_id
              LEFT JOIN users u ON u.id = x.user_id
             WHERE a.hunt_id = v_h.id AND a.post_id = p.id) AS occupant
      FROM hunt_posts hp JOIN posts p ON p.id = hp.post_id
     WHERE hp.hunt_id = v_h.id
  ), mine AS (SELECT rk FROM day_posts WHERE id = v_post)
  SELECT jsonb_build_object(
    'hunt', jsonb_build_object(
      'id', v_h.id, 'date', v_h.date, 'meeting_time', to_char(v_h.meeting_time, 'HH24:MI'),
      'meeting_place', v_h.meeting_place, 'meeting_point', ST_AsGeoJSON(v_h.meeting_point, 7)::jsonb,
      'briefing', v_h.briefing, 'status', v_h.status, 'started_at', v_h.started_at, 'ended_at', v_h.ended_at,
      'assignments_published', v_h.assignments_published_at IS NOT NULL,
      'leader', (SELECT display_name FROM users WHERE id = v_h.leader_user_id),
      'chefs_de_ligne', (SELECT coalesce(jsonb_agg(coalesce(u.display_name, x.guest_name)), '[]')
                           FROM hunt_participants x LEFT JOIN users u ON u.id = x.user_id
                          WHERE x.hunt_id = v_h.id AND x.role = 'chef_de_ligne')),
    'territory', (SELECT jsonb_build_object('name', t.name, 'geom', ST_AsGeoJSON(t.geom, 7)::jsonb)
                    FROM territories t WHERE t.id = v_h.territory_id),
    'exclusion', (SELECT ST_AsGeoJSON(z.geom, 7)::jsonb FROM exclusion_zones z WHERE z.territory_id = v_h.territory_id),
    'reserves', (SELECT coalesce(jsonb_agg(ST_AsGeoJSON(r.geom, 7)::jsonb), '[]')
                   FROM reserve_zones r WHERE r.territory_id = v_h.territory_id),
    'me', jsonb_build_object(
      'name', coalesce((SELECT display_name FROM users WHERE id = v_p.user_id), v_p.guest_name),
      'role', v_p.role, 'response', v_p.response, 'present', v_p.present, 'guest', v_p.user_id IS NULL),
    'post', (SELECT jsonb_build_object(
               'number', p.number, 'name', p.name, 'instructions', p.instructions,
               'geom', ST_AsGeoJSON(p.geom, 7)::jsonb, 'access_path', ST_AsGeoJSON(p.access_path, 7)::jsonb,
               'access_path_length_m', round(ST_Length(p.access_path::geography)),
               'parking', (SELECT jsonb_build_object('name', pk.name, 'geom', ST_AsGeoJSON(pk.geom, 7)::jsonb)
                             FROM parkings pk WHERE pk.id = p.parking_id),
               'shared_with', (SELECT coalesce(jsonb_agg(coalesce(u.display_name, x.guest_name)), '[]')
                                 FROM hunt_assignments a JOIN hunt_participants x ON x.id = a.participant_id
                                 LEFT JOIN users u ON u.id = x.user_id
                                WHERE a.hunt_id = v_h.id AND a.post_id = p.id AND x.id <> v_p.id))
               FROM posts p WHERE p.id = v_post),
    -- Voisins (poste précédent et suivant dans la ligne du jour) : information de
    -- sécurité. Tous les postes si l'association l'a choisi.
    'neighbors', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'number', d.number, 'name', d.name, 'occupant', d.occupant,
                     'side', CASE WHEN d.rk < m.rk THEN 'gauche' ELSE 'droite' END) ORDER BY d.number), '[]')
                    FROM day_posts d, mine m
                   WHERE v_h.assignments_published_at IS NOT NULL
                     AND d.id <> v_post AND (v_all OR abs(d.rk - m.rk) = 1)),
    'show_all_posts', v_all
  ) INTO v_result;
  RETURN v_result;
END $$;

CREATE FUNCTION app.my_hunt_sheet(p_hunt uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT app.hunt_sheet(hp.id) FROM hunt_participants hp
     WHERE hp.hunt_id = p_hunt AND hp.user_id = app.current_user_id()
       AND p_hunt IN (SELECT app.my_hunt_ids())
  $$;

-- Lien invité : valable tant que la battue est publiée ou en cours.
CREATE FUNCTION app.guest_hunt_sheet(p_token_hash text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT app.hunt_sheet(hp.id) FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
     WHERE hp.guest_token_hash = p_token_hash AND h.status IN ('publiee', 'en_cours')
  $$;

-- ---------------------------------------------------------------------------
-- RLS : président et responsables gèrent les battues ; un chasseur voit
-- celles auxquelles il est convoqué (hors brouillon), en lecture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hunts', 'hunt_participants', 'hunt_posts', 'hunt_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$s_select ON %1$I FOR SELECT TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id())
                             AND (app.has_role('president', 'responsable')
                                  OR %2$s IN (SELECT app.my_hunt_ids())))$p$,
                   t, CASE WHEN t = 'hunts' THEN 'id' ELSE 'hunt_id' END);
    EXECUTE format($p$CREATE POLICY %1$s_write ON %1$I FOR ALL TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president', 'responsable'))
                      WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president', 'responsable'))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rls', t);
  END LOOP;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0006_lot4_battues.sql', 'f426149cd8b1513a0b82758c26b4239c60907d802225bb4629d38966f6abdc49');

COMMIT;
