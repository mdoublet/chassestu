-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0020_categorie_membre.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0020_categorie_membre.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0020_categorie_membre.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0019_lignes.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0019_lignes.sql';
  END IF;
END $guard$;

-- ==================== 0020_categorie_membre.sql ====================
-- Catégorie habituelle d'un membre dans l'association : chasseur (posté),
-- traqueur, ou autre (accompagnateur…). Sert à ranger les listes de
-- convocation et donne le rôle par défaut dans une battue (traqueur).
ALTER TABLE memberships ADD COLUMN usual_role text NOT NULL DEFAULT 'chasseur'
  CHECK (usual_role IN ('chasseur', 'traqueur', 'autre'));

-- Président et organisateurs la renseignent (ce n'est pas un droit).
CREATE FUNCTION app.set_member_usual_role(p_user text, p_role text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app.has_role('president', 'responsable') THEN
    RAISE EXCEPTION 'FORBIDDEN: réservé au président et aux organisateurs' USING ERRCODE = '42501';
  END IF;
  UPDATE memberships SET usual_role = p_role WHERE user_id = p_user AND tenant_id = app.current_tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: membre introuvable' USING ERRCODE = 'P0002';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.set_member_usual_role(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_member_usual_role(text, text) TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0020_categorie_membre.sql', '61fe3add620d54b4521904c71214e41322da7b24470bc27efde8c8d699dd56e1');

COMMIT;
