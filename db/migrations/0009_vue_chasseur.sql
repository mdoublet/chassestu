-- Vue chasseur pour tous, espèces chassées / prélèvements, mises à jour
-- automatiques des écrans.
--
-- * hunts.revision : numéro de version d'une battue, augmenté à chaque
--   changement (battue, participants, postes du jour, attributions, espèces,
--   prélèvements). Les écrans ouverts le consultent et se rechargent s'il change.
-- * hunt_species : espèces chassables lors de la battue, avec quota éventuel.
-- * hunt_harvests : prélèvements de la battue (tableau du jour, pas un carnet
--   individuel : celui-ci relève du projet de saisie des prises). Un
--   participant déclare les siens ; le responsable gère tout.
-- * app.hunt_view : fiche de la battue, pour un participant (son poste, ses
--   voisins) ou pour un responsable non convoqué (vue d'ensemble).

ALTER TABLE hunts ADD COLUMN revision bigint NOT NULL DEFAULT 0;

CREATE TABLE hunt_species (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id(),
  hunt_id   uuid NOT NULL,
  species   text NOT NULL CHECK (length(btrim(species)) BETWEEN 1 AND 60),
  quota     integer CHECK (quota BETWEEN 0 AND 999),   -- NULL : sans limite fixée
  PRIMARY KEY (hunt_id, species),
  FOREIGN KEY (tenant_id, hunt_id) REFERENCES hunts (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE hunt_harvests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id(),
  hunt_id        uuid NOT NULL,
  species        text NOT NULL CHECK (length(btrim(species)) BETWEEN 1 AND 60),
  category       text NOT NULL DEFAULT 'indetermine' CHECK (category IN ('male', 'femelle', 'jeune', 'indetermine')),
  participant_id uuid,                                   -- tireur
  notes          text NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  recorded_by    text REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, hunt_id) REFERENCES hunts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hunt_id, participant_id) REFERENCES hunt_participants (hunt_id, id) ON DELETE SET NULL (participant_id)
);
CREATE INDEX hunt_harvests_hunt_idx ON hunt_harvests (hunt_id, created_at);

-- ---------------------------------------------------------------------------
-- Numéro de version des battues
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.bump_hunt_revision() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE hunts SET revision = revision + 1 WHERE id = coalesce(NEW.hunt_id, OLD.hunt_id);
  RETURN NULL;
END $$;

CREATE FUNCTION app.hunt_own_revision() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision = OLD.revision THEN
    NEW.revision := OLD.revision + 1;   -- modification directe de la battue
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hunts_revision BEFORE UPDATE ON hunts FOR EACH ROW EXECUTE FUNCTION app.hunt_own_revision();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hunt_participants', 'hunt_posts', 'hunt_assignments', 'hunt_species', 'hunt_harvests'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_revision AFTER INSERT OR UPDATE OR DELETE ON %1$I
                    FOR EACH ROW EXECUTE FUNCTION app.bump_hunt_revision()', t);
  END LOOP;
END $$;

-- Journal d'audit : le numéro de version n'est pas une modification à tracer.
CREATE OR REPLACE FUNCTION app.audit_trigger() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_diff jsonb;
  v_tenant uuid;
BEGIN
  v_tenant := CASE WHEN TG_TABLE_NAME = 'tenants' THEN (v_row ->> 'id')::uuid
                   ELSE (v_row ->> 'tenant_id')::uuid END;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_tenant) THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(o.key, jsonb_build_object('old', o.value, 'new', n.value))
      INTO v_diff
      FROM jsonb_each(v_old) o
      JOIN jsonb_each(v_new) n USING (key)
     WHERE o.value IS DISTINCT FROM n.value
       AND o.key NOT IN ('updated_at', 'revision');
    IF v_diff IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    v_diff := v_row;
  END IF;

  INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff)
  VALUES (v_tenant, app.current_user_id(), lower(TG_OP), TG_TABLE_NAME,
          coalesce(v_row ->> 'id', v_row ->> 'user_id'), v_diff);
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER hunt_harvests_audit AFTER INSERT OR UPDATE OR DELETE ON hunt_harvests
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

-- ---------------------------------------------------------------------------
-- Prélèvements déclarés par un participant (le responsable passe par la RLS)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.declare_harvest(p_hunt uuid, p_species text, p_category text, p_notes text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_participant uuid;
  v_id uuid;
BEGIN
  SELECT hp.id INTO v_participant FROM hunt_participants hp JOIN hunts h ON h.id = hp.hunt_id
   WHERE hp.hunt_id = p_hunt AND hp.user_id = app.current_user_id()
     AND h.tenant_id = app.current_tenant_id();
  IF v_participant IS NULL THEN
    RAISE EXCEPTION 'NOT_INVITED: vous ne participez pas à cette battue' USING ERRCODE = '42501';
  END IF;
  IF (SELECT status FROM hunts WHERE id = p_hunt) <> 'en_cours' THEN
    RAISE EXCEPTION 'HUNT_NOT_RUNNING: on déclare un prélèvement pendant la battue' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hunt_harvests (tenant_id, hunt_id, species, category, participant_id, notes, recorded_by)
  SELECT h.tenant_id, p_hunt, btrim(p_species), coalesce(p_category, 'indetermine'), v_participant, coalesce(p_notes, ''), app.current_user_id()
    FROM hunts h WHERE h.id = p_hunt
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Retirer sa propre déclaration (erreur de saisie), pendant la battue.
CREATE FUNCTION app.withdraw_harvest(p_harvest uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM hunt_harvests hh USING hunts h
   WHERE hh.id = p_harvest AND h.id = hh.hunt_id AND h.status = 'en_cours'
     AND hh.recorded_by = app.current_user_id() AND h.tenant_id = app.current_tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: déclaration introuvable ou battue terminée' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Fiche de la battue (vue chasseur)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.hunt_view(p_hunt uuid, p_participant uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_h      hunts%ROWTYPE;
  v_p      hunt_participants%ROWTYPE;
  v_all    boolean;
  v_post   uuid;
  v_pub    boolean;
BEGIN
  SELECT * INTO v_h FROM hunts WHERE id = p_hunt;
  IF p_participant IS NOT NULL THEN
    SELECT * INTO v_p FROM hunt_participants WHERE id = p_participant AND hunt_id = p_hunt;
  END IF;
  SELECT show_all_posts INTO v_all FROM tenants WHERE id = v_h.tenant_id;
  v_pub := v_h.assignments_published_at IS NOT NULL;
  SELECT a.post_id INTO v_post FROM hunt_assignments a WHERE a.participant_id = v_p.id AND v_pub;

  RETURN (
  WITH day_posts AS (
    SELECT p.id, p.number, p.name, row_number() OVER (ORDER BY p.number) AS rk,
           (SELECT string_agg(coalesce(u.display_name, x.guest_name), ' et ' ORDER BY coalesce(u.display_name, x.guest_name))
              FROM hunt_assignments a JOIN hunt_participants x ON x.id = a.participant_id
              LEFT JOIN users u ON u.id = x.user_id
             WHERE a.hunt_id = v_h.id AND a.post_id = p.id) AS occupant
      FROM hunt_posts hp JOIN posts p ON p.id = hp.post_id
     WHERE hp.hunt_id = v_h.id
  ), mine AS (SELECT rk FROM day_posts WHERE id = v_post)
  SELECT jsonb_build_object(
    'revision', v_h.revision,
    'hunt', jsonb_build_object(
      'id', v_h.id, 'date', v_h.date, 'meeting_time', to_char(v_h.meeting_time, 'HH24:MI'),
      'meeting_place', v_h.meeting_place, 'meeting_point', ST_AsGeoJSON(v_h.meeting_point, 7)::jsonb,
      'briefing', v_h.briefing, 'status', v_h.status, 'started_at', v_h.started_at, 'ended_at', v_h.ended_at,
      'assignments_published', v_pub,
      'leader', (SELECT display_name FROM users WHERE id = v_h.leader_user_id),
      'chefs_de_ligne', (SELECT coalesce(jsonb_agg(coalesce(u.display_name, x.guest_name)), '[]')
                           FROM hunt_participants x LEFT JOIN users u ON u.id = x.user_id
                          WHERE x.hunt_id = v_h.id AND x.role = 'chef_de_ligne'),
      'present_count', (SELECT count(*) FROM hunt_participants x WHERE x.hunt_id = v_h.id AND x.present),
      'posted_count', (SELECT count(*) FROM hunt_participants x WHERE x.hunt_id = v_h.id AND x.present AND x.role = 'poste')),
    'territory', (SELECT jsonb_build_object('name', t.name, 'geom', ST_AsGeoJSON(t.geom, 7)::jsonb)
                    FROM territories t WHERE t.id = v_h.territory_id),
    'exclusion', (SELECT ST_AsGeoJSON(z.geom, 7)::jsonb FROM exclusion_zones z WHERE z.territory_id = v_h.territory_id),
    'reserves', (SELECT coalesce(jsonb_agg(ST_AsGeoJSON(r.geom, 7)::jsonb), '[]')
                   FROM reserve_zones r WHERE r.territory_id = v_h.territory_id),
    'me', CASE WHEN v_p.id IS NULL THEN NULL ELSE jsonb_build_object(
      'participant_id', v_p.id,
      'name', coalesce((SELECT display_name FROM users WHERE id = v_p.user_id), v_p.guest_name),
      'role', v_p.role, 'response', v_p.response, 'present', v_p.present, 'guest', v_p.user_id IS NULL) END,
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
    -- Participant : voisins (ou toute la ligne si l'association le permet).
    -- Responsable non convoqué : toute la ligne.
    'neighbors', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'number', d.number, 'name', d.name, 'occupant', d.occupant,
                     'side', CASE WHEN m.rk IS NULL THEN NULL WHEN d.rk < m.rk THEN 'gauche' ELSE 'droite' END) ORDER BY d.number), '[]')
                    FROM day_posts d LEFT JOIN mine m ON true
                   WHERE v_pub AND d.id IS DISTINCT FROM v_post
                     AND (p_participant IS NULL OR v_all OR (m.rk IS NOT NULL AND abs(d.rk - m.rk) = 1))),
    'show_all_posts', v_all OR p_participant IS NULL,
    'species', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                   's', s.species, 'quota', s.quota,
                   'taken', (SELECT count(*) FROM hunt_harvests hh WHERE hh.hunt_id = v_h.id AND hh.species = s.species))
                   ORDER BY s.species), '[]')
                  FROM hunt_species s WHERE s.hunt_id = v_h.id),
    'harvests', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'id', hh.id, 'species', hh.species, 'category', hh.category, 'notes', hh.notes,
                    'shooter', coalesce(u.display_name, x.guest_name),
                    'post_number', (SELECT p.number FROM hunt_assignments a JOIN posts p ON p.id = a.post_id
                                     WHERE a.participant_id = hh.participant_id),
                    'mine', hh.recorded_by IS NOT NULL AND hh.recorded_by = (SELECT user_id FROM hunt_participants WHERE id = v_p.id),
                    'at', hh.created_at) ORDER BY hh.created_at DESC), '[]')
                   FROM hunt_harvests hh
                   LEFT JOIN hunt_participants x ON x.id = hh.participant_id
                   LEFT JOIN users u ON u.id = x.user_id
                  WHERE hh.hunt_id = v_h.id)
  ));
END $$;

-- Les anciennes fiches délèguent à la nouvelle.
CREATE OR REPLACE FUNCTION app.hunt_sheet(p_participant uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT app.hunt_view(hp.hunt_id, hp.id) FROM hunt_participants hp WHERE hp.id = p_participant
  $$;

-- Membre convoqué : sa fiche ; président ou responsable : vue d'ensemble.
CREATE FUNCTION app.view_hunt(p_hunt uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_pid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hunts WHERE id = p_hunt AND tenant_id = app.current_tenant_id()) THEN
    RETURN NULL;
  END IF;
  SELECT hp.id INTO v_pid FROM hunt_participants hp
   WHERE hp.hunt_id = p_hunt AND hp.user_id = app.current_user_id() AND p_hunt IN (SELECT app.my_hunt_ids());
  IF v_pid IS NOT NULL THEN
    RETURN app.hunt_view(p_hunt, v_pid);
  END IF;
  IF app.has_role('president', 'responsable') THEN
    RETURN app.hunt_view(p_hunt, NULL);
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hunt_species', 'hunt_harvests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$s_select ON %1$I FOR SELECT TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id())
                             AND (app.has_role('president', 'responsable') OR hunt_id IN (SELECT app.my_hunt_ids())))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_write ON %1$I FOR ALL TO app_rls
                      USING (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president', 'responsable'))
                      WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.has_role('president', 'responsable'))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rls', t);
  END LOOP;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rls;
