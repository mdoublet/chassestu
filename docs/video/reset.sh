#!/bin/bash
# Base de démonstration vierge : association, président (profil vide), 7 membres.
set -e
pkill -f node-server.ts || true
sleep 1
psql -q postgresql://neondb_owner:local@localhost/chassestu_dev -c "DROP DATABASE IF EXISTS chassestu_demo" -c "CREATE DATABASE chassestu_demo"
su postgres -c "psql -q -d chassestu_demo -c 'CREATE EXTENSION IF NOT EXISTS postgis'"
cd /home/user/chassestu/api
DATABASE_URL=postgresql://neondb_owner:local@localhost/chassestu_demo APP_ORIGIN=http://localhost:5173 NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt setsid nohup npx tsx src/node-server.ts > /tmp/claude-0/api-demo.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do curl -s -o /dev/null localhost:8787/api/health && break; sleep 1; done
for u in michel:Michel jean:Jean paul:Paul luc:Luc pierre:Pierre andre:Andre sophie:Sophie marc:Marc; do curl -s -o /dev/null -H "Authorization: Bearer dev:${u%%:*}:${u#*:}" localhost:8787/api/me; done
psql -q postgresql://neondb_owner:local@localhost/chassestu_demo <<'SQL'
INSERT INTO tenants (name, kind, departement) VALUES ('ACCA de Saint-Aubin', 'acca', '11');
INSERT INTO memberships (user_id, tenant_id, role, usual_role)
SELECT u, (SELECT id FROM tenants LIMIT 1), CASE WHEN u = 'dev_michel' THEN 'president'::member_role ELSE 'chasseur'::member_role END,
       CASE WHEN u IN ('dev_sophie', 'dev_marc') THEN 'traqueur' ELSE 'chasseur' END
  FROM unnest(ARRAY['dev_michel','dev_jean','dev_paul','dev_luc','dev_pierre','dev_andre','dev_sophie','dev_marc']) u;
UPDATE users SET display_name = 'André' WHERE id = 'dev_andre';
UPDATE users SET walking_ability = v.w, has_car = v.c, car_seats = v.s
  FROM (VALUES ('dev_jean',5,true,3),('dev_paul',2,false,0),('dev_luc',4,true,2),('dev_pierre',3,true,1),('dev_andre',4,false,0),('dev_sophie',5,true,2),('dev_marc',5,false,0)) v(id,w,c,s)
 WHERE users.id = v.id;
SQL
echo "base de démo prête"
