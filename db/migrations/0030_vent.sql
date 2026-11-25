-- Vent. Plan de chasse : plage de directions favorables (d'où vient le vent,
-- en degrés, sens horaire de wind_from_min à wind_from_max ; les deux vides :
-- tous vents). Battue : vent prévu à sa création (Open-Meteo), pour mémoire.
ALTER TABLE hunt_plans
  ADD COLUMN wind_from_min smallint CHECK (wind_from_min BETWEEN 0 AND 359),
  ADD COLUMN wind_from_max smallint CHECK (wind_from_max BETWEEN 0 AND 359),
  ADD CONSTRAINT hunt_plans_wind_range CHECK ((wind_from_min IS NULL) = (wind_from_max IS NULL));

ALTER TABLE hunts
  ADD COLUMN wind_from_deg  smallint CHECK (wind_from_deg BETWEEN 0 AND 359),
  ADD COLUMN wind_speed_kmh smallint CHECK (wind_speed_kmh BETWEEN 0 AND 400),
  ADD COLUMN wind_gust_kmh  smallint CHECK (wind_gust_kmh BETWEEN 0 AND 400);
