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
