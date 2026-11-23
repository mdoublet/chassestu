-- Nom d'un bâtiment, saisi par le président (ex. « Ferme des Pujols »), pour
-- le reconnaître dans la liste ; vide par défaut (libellé : usage IGN).
ALTER TABLE dwellings ADD COLUMN name text NOT NULL DEFAULT '' CHECK (length(name) <= 100);
