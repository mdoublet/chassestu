-- Case « Consignes particulières » d'un poste : signalée par ⚠ dans l'éditeur
-- (comme des consignes contenant le mot « attention »).
ALTER TABLE posts ADD COLUMN special_instructions boolean NOT NULL DEFAULT false;
