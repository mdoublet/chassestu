-- Types de lieux libres : en plus de cabane, restaurant, parking et autre,
-- le président peut saisir ses propres types (salle des fêtes, carrefour…),
-- reproposés ensuite (types déjà utilisés par l'association).
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_kind_check;
ALTER TABLE places ADD CONSTRAINT places_kind_check CHECK (length(btrim(kind)) BETWEEN 1 AND 40);
