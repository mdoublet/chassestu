// Accès base : chaque action ouvre UNE transaction qui
//   1. bascule sur le rôle app_rls (soumis à la RLS),
//   2. pose app.user_id et app.tenant_id (portée transaction),
//   3. exécute les requêtes de l'action.
// Le pool est compatible `pg` : pilote serverless Neon en production,
// node-postgres dans les tests.

export interface DbClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
}

export interface DbPool {
  connect(): Promise<DbClient>;
}

export interface Tx {
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T>;
  maybeOne<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T | null>;
  execute(text: string, params?: unknown[]): Promise<number>;
}

export interface DbContext {
  userId: string | null;
  tenantId: string | null;
}

export async function withTx<T>(pool: DbPool, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const tx: Tx = {
    async query(text, params) {
      return (await client.query(text, params)).rows;
    },
    async one(text, params) {
      const rows = (await client.query(text, params)).rows;
      if (rows.length !== 1) throw new Error(`one() attendait 1 ligne, reçu ${rows.length}`);
      return rows[0];
    },
    async maybeOne(text, params) {
      return (await client.query(text, params)).rows[0] ?? null;
    },
    async execute(text, params) {
      return (await client.query(text, params)).rowCount ?? 0;
    },
  };
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_rls');
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)",
      [ctx.userId ?? '', ctx.tenantId ?? ''],
    );
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
