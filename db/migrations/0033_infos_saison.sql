-- Infos de chasse d'une saison (onglet « Infos » des membres) : dates
-- d'ouverture et périodes par espèce, jours et horaires, calendrier des
-- battues, avis datés, liste de contrôle, règles. Document JSON validé par
-- l'API, modifié par le président, repris à la création de la saison suivante.
ALTER TABLE seasons ADD COLUMN regulations jsonb CHECK (regulations IS NULL OR (jsonb_typeof(regulations) = 'object' AND pg_column_size(regulations) < 500000));
