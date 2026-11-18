-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0011_guidage.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0011_guidage.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0011_guidage.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0010_positions.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0010_positions.sql';
  END IF;
END $guard$;

-- ==================== 0011_guidage.sql ====================
-- Lot 5 (suite) : « Je suis en place » et données de guidage dans la fiche.
--
-- * hunt_participants.in_place_at : confirmation manuelle du chasseur (utile
--   quand le GPS est mauvais), transmise au responsable. Effacée si son poste
--   change. Membres : app.set_in_place ; invités : app.guest_set_in_place.
-- * La fiche (app.hunt_view) ajoute me.in_place et la tolérance GPS de
--   l'association (le guidage des invités en a besoin, ils n'ont pas d'API).

ALTER TABLE hunt_participants ADD COLUMN in_place_at timestamptz;

CREATE FUNCTION app.set_in_place_for(p_participant uuid, p_in_place boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT h.status FROM hunts h JOIN hunt_participants hp ON hp.hunt_id = h.id WHERE hp.id = p_participant) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: la confirmation se fait pendant la battue' USING ERRCODE = '23514';
  END IF;
  IF p_in_place AND NOT EXISTS (SELECT 1 FROM hunt_assignments WHERE participant_id = p_participant) THEN
    RAISE EXCEPTION 'NO_POST: aucun poste ne vous est attribué' USING ERRCODE = '23514';
  END IF;
  UPDATE hunt_participants SET in_place_at = CASE WHEN p_in_place THEN coalesce(in_place_at, now()) END
   WHERE id = p_participant AND (in_place_at IS NULL) = p_in_place;
END $$;
REVOKE EXECUTE ON FUNCTION app.set_in_place_for(uuid, boolean) FROM PUBLIC;

CREATE FUNCTION app.set_in_place(p_hunt uuid, p_in_place boolean) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.set_in_place_for(app.my_participant_id(p_hunt), p_in_place);
$$;

-- Invité : le lien (empreinte du jeton) fait foi. Renvoie false si le lien n'est plus valable.
CREATE FUNCTION app.guest_set_in_place(p_token_hash text, p_in_place boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v uuid;
BEGIN
  SELECT hp.id INTO v FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
   WHERE hp.guest_token_hash = p_token_hash AND h.status IN ('publiee', 'en_cours');
  IF v IS NULL THEN
    RETURN false;
  END IF;
  PERFORM app.set_in_place_for(v, p_in_place);
  RETURN true;
END $$;

-- Changement de poste : la confirmation ne vaut plus.
CREATE FUNCTION app.reset_in_place() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'INSERT' OR NEW.post_id IS DISTINCT FROM OLD.post_id THEN
    UPDATE hunt_participants SET in_place_at = NULL
     WHERE id = coalesce(NEW.participant_id, OLD.participant_id) AND in_place_at IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER hunt_assignments_reset_in_place AFTER INSERT OR UPDATE OR DELETE ON hunt_assignments
  FOR EACH ROW EXECUTE FUNCTION app.reset_in_place();

-- Fiche : on enrichit la fonction existante sans la réécrire.
ALTER FUNCTION app.hunt_view(uuid, uuid) RENAME TO hunt_view_base;
CREATE FUNCTION app.hunt_view(p_hunt uuid, p_participant uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v jsonb := app.hunt_view_base(p_hunt, p_participant);
BEGIN
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  v := v || jsonb_build_object('gps_tolerance_m',
         (SELECT t.gps_tolerance_m FROM hunts h JOIN tenants t ON t.id = h.tenant_id WHERE h.id = p_hunt));
  IF jsonb_typeof(v -> 'me') = 'object' THEN
    v := jsonb_set(v, '{me,in_place}', to_jsonb((SELECT in_place_at IS NOT NULL FROM hunt_participants WHERE id = p_participant)));
  END IF;
  RETURN v;
END $$;
-- Correctif de sécurité : la fiche brute ne vérifie pas l'appelant ; seules
-- les fonctions d'accès (view_hunt, my_hunt_sheet, guest_hunt_sheet), qui
-- vérifient l'association, le convoqué ou le lien, peuvent l'appeler.
REVOKE EXECUTE ON FUNCTION app.hunt_view_base(uuid, uuid), app.hunt_view(uuid, uuid), app.hunt_sheet(uuid)
  FROM PUBLIC, app_rls;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_in_place(uuid, boolean), app.guest_set_in_place(text, boolean) TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0011_guidage.sql', '83a56838223c6b94b019ef3fae0dd6826914f9ea047f522e780977086c317a60');

COMMIT;
