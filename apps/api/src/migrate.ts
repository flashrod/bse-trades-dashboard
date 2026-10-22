import { query } from './db';
import { SCHEMA_SQL } from './schema';

export async function migrate(): Promise<void> {
  await query(SCHEMA_SQL);
  await query(`DELETE FROM events WHERE created_at < now() - interval '2 days'`);
}

if (require.main === module) {
  migrate()
    .then(async () => {
      console.log('[api] schema ready');
      const { closePool } = await import('./db');
      await closePool();
    })
    .catch((error) => {
      console.error('[api] migration failed', error);
      process.exit(1);
    });
}
