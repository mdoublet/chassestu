-- Photo d'un lieu (cabane, restaurant…), réduite par l'application avant
-- l'envoi (JPEG, quelques centaines de ko au plus). Application de navigation
-- préférée de chaque utilisateur (Google Maps, Waze, Plans d'Apple).

ALTER TABLE places ADD COLUMN photo bytea CHECK (octet_length(photo) <= 1500000);
ALTER TABLE places ADD COLUMN photo_type text CHECK (photo_type IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE places ADD COLUMN photo_updated_at timestamptz;

ALTER TABLE users ADD COLUMN nav_app text CHECK (nav_app IN ('google', 'waze', 'apple'));
GRANT UPDATE (nav_app) ON users TO app_rls;
