-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- Mise à jour d’une base existante : migration 0027_photos_stockage_objets.sql seule.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0027_photos_stockage_objets.sql') THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', '0027_photos_stockage_objets.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0026_lieux_des_chasseurs.sql') THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', '0026_lieux_des_chasseurs.sql';
  END IF;
END $guard$;

-- ==================== 0027_photos_stockage_objets.sql ====================
-- Photos des lieux dans le stockage d'objets (Neon Object Storage) : la base
-- ne garde que la clé de l'objet. La colonne `photo` reste en repli (stockage
-- non configuré) et le temps de recopier les photos existantes, ce que l'API
-- fait à leur première lecture.
ALTER TABLE places ADD COLUMN photo_key text CHECK (length(photo_key) BETWEEN 1 AND 300);

-- Recopie d'une photo vers le stockage : tout membre qui la lit peut la
-- déplacer (sans droit de modifier le lieu), seulement si elle est encore en base.
CREATE FUNCTION app.move_place_photo(p_place uuid, p_key text) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE places SET photo_key = p_key, photo = NULL
     WHERE id = p_place AND tenant_id = app.current_tenant_id() AND photo IS NOT NULL AND photo_key IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;
REVOKE ALL ON FUNCTION app.move_place_photo(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.move_place_photo(uuid, text) TO app_rls;

INSERT INTO schema_migrations (name, checksum) VALUES ('0027_photos_stockage_objets.sql', '3780d38cbc99df1157abb8c0c5e173f13b603be9fe057ef3cfb305ba8f982443');

COMMIT;
