-- Page d'informations de l'association (dates d'ouverture, espèces
-- chassables, règles…), affichée dans l'onglet « Infos chasse » des membres.
-- Adresse https choisie par le président ; vide : pas de page.
ALTER TABLE tenants ADD COLUMN info_url text CHECK (info_url IS NULL OR (info_url ~ '^https://' AND length(info_url) <= 500));
GRANT UPDATE (info_url) ON tenants TO app_rls;
