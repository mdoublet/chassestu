// Recrée une base de test vierge (depuis un modèle contenant PostGIS) et
// applique toutes les migrations. Voir README « Tests ».
import pg from 'pg';
// @ts-expect-error module JS sans types
import { migrate } from '../../db/migrate.mjs';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://neondb_owner:local@localhost:5432/chassestu_test';

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  // Garde-fou : ce script SUPPRIME la base. Jamais sur une base qui n'est pas de test.
  if (!/test/i.test(dbName) || /neon\.tech$/.test(url.hostname)) {
    throw new Error(`Refus de réinitialiser « ${dbName} » sur ${url.hostname} : base de test locale uniquement.`);
  }
  const template = process.env.TEST_TEMPLATE_DB ?? 'postgis_template';

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE "${template}"`);
  } finally {
    await admin.end();
  }

  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await migrate(client, { log: () => {} });
  } finally {
    await client.end();
  }
}
