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
