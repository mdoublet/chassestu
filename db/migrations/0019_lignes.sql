-- Lignes de postes : un groupe nommé de postes d'un territoire (certains
-- postes n'appartiennent à aucune ligne). Le chef de ligne est un chasseur
-- comme les autres (il reçoit un poste) ; sa ligne est celle de son poste, et
-- il voit les chasseurs de cette ligne. Chaque posté voit son chef de ligne.

CREATE TABLE post_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  territory_id uuid NOT NULL,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (territory_id, name),
  UNIQUE (territory_id, id),
  FOREIGN KEY (tenant_id, territory_id) REFERENCES territories (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX post_lines_tenant_idx ON post_lines (tenant_id);
CREATE TRIGGER post_lines_touch BEFORE UPDATE ON post_lines FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER post_lines_audit AFTER INSERT OR UPDATE OR DELETE ON post_lines FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

ALTER TABLE post_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_lines_select ON post_lines FOR SELECT TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY post_lines_write ON post_lines FOR ALL TO app_rls
  USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president'));
GRANT SELECT, INSERT, UPDATE, DELETE ON post_lines TO app_rls;

ALTER TABLE posts ADD COLUMN line_id uuid;
ALTER TABLE posts ADD CONSTRAINT posts_line_fk FOREIGN KEY (territory_id, line_id)
  REFERENCES post_lines (territory_id, id) ON DELETE SET NULL (line_id);
CREATE INDEX posts_line_idx ON posts (line_id);

-- ---------------------------------------------------------------------------
-- Le chef de ligne reçoit un poste comme un posté.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.check_hunt_assignment() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM hunts WHERE id = NEW.hunt_id) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: l''attribution n''est possible que pendant la battue (en cours)'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'hunt_assignments' THEN
    IF NOT EXISTS (SELECT 1 FROM hunt_participants hp
                    WHERE hp.id = NEW.participant_id AND hp.present AND hp.role IN ('poste', 'chef_de_ligne')) THEN
      RAISE EXCEPTION 'PARTICIPANT_NOT_POSTED: seul un chasseur présent, posté ou chef de ligne, reçoit un poste'
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

CREATE OR REPLACE FUNCTION app.participant_changed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.present OR NEW.role NOT IN ('poste', 'chef_de_ligne') THEN
    DELETE FROM hunt_assignments WHERE participant_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Ligne d'un participant (postes publiés) : nom, chefs de ligne ; pour un
-- chef de ligne, les chasseurs de sa ligne (lui compris) et leur mise en place.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.line_view_for(p_hunt uuid, p_dp uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hp   hunt_participants%ROWTYPE;
  v_line post_lines%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hunts h WHERE h.id = p_hunt AND h.assignments_published_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_hp FROM hunt_participants WHERE hunt_id = p_hunt AND day_participant_id = p_dp;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT l.* INTO v_line FROM hunt_assignments a JOIN posts p ON p.id = a.post_id JOIN post_lines l ON l.id = p.line_id
   WHERE a.hunt_id = p_hunt AND a.participant_id = v_hp.id;
  IF NOT FOUND THEN
    RETURN CASE WHEN v_hp.role = 'chef_de_ligne' THEN jsonb_build_object('name', NULL, 'chief', true, 'chiefs', '[]'::jsonb, 'members', '[]'::jsonb) END;
  END IF;
  RETURN (
    WITH m AS (
      SELECT coalesce(u.display_name, hp.guest_name) AS name, hp.role, p.number, p.name AS post_name,
             hp.in_place_at, hp.id = v_hp.id AS me
        FROM hunt_assignments a
        JOIN posts p ON p.id = a.post_id
        JOIN hunt_participants hp ON hp.id = a.participant_id
        LEFT JOIN users u ON u.id = hp.user_id
       WHERE a.hunt_id = p_hunt AND p.line_id = v_line.id)
    SELECT jsonb_build_object(
      'name', v_line.name,
      'chief', v_hp.role = 'chef_de_ligne',
      'chiefs', coalesce((SELECT jsonb_agg(jsonb_build_object('name', m.name, 'post_number', m.number, 'me', m.me) ORDER BY m.number)
                            FROM m WHERE m.role = 'chef_de_ligne'), '[]'::jsonb),
      'members', CASE WHEN v_hp.role = 'chef_de_ligne' THEN
                   coalesce((SELECT jsonb_agg(jsonb_build_object('name', m.name, 'post_number', m.number, 'post_name', m.post_name,
                                                                 'in_place_at', m.in_place_at, 'chief', m.role = 'chef_de_ligne', 'me', m.me)
                                              ORDER BY m.number, m.name) FROM m), '[]'::jsonb)
                 END)
  );
END $$;

/** Ligne du membre connecté dans une battue. */
CREATE FUNCTION app.my_line(p_hunt uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.line_view_for(p_hunt, hp.day_participant_id)
    FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
   WHERE hp.hunt_id = p_hunt AND hp.user_id = app.current_user_id() AND h.tenant_id = app.current_tenant_id()
$$;

/** Ligne d'un invité (lien personnel) dans la battue en cours de sa journée. */
CREATE FUNCTION app.guest_line(p_token_hash text, p_hunt uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.line_view_for(p_hunt, dp.id)
    FROM day_participants dp JOIN hunt_days d ON d.id = dp.day_id JOIN hunts h ON h.day_id = d.id
   WHERE dp.guest_token_hash = p_token_hash AND d.status IN ('convoquee', 'en_cours') AND h.id = p_hunt
$$;

REVOKE ALL ON FUNCTION app.line_view_for(uuid, uuid), app.my_line(uuid), app.guest_line(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_line(uuid), app.guest_line(text, uuid) TO app_rls;
