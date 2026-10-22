import { config } from './config';
import { closePool, query, waitForDb } from './db';
import { migrate } from './migrate';
import { createApiApp } from './routes';
import { startPull } from './puller';

async function bootstrap(): Promise<void> {
  await waitForDb();
  await migrate();

  // A process that died mid-pull leaves a 'running' row behind. The partial
  // unique index would block every future pull, so mark it interrupted;
  // starting a new pull resumes from the durable cursor.
  await query(
    `UPDATE pulls
        SET status = 'interrupted',
            finished_at = coalesce(finished_at, now()),
            error = coalesce(error, 'service restarted before the pull finished')
      WHERE status = 'running'`
  );


  const app = createApiApp();
  const server = app.listen(config.port, () => {
    console.log(
      `[api] listening on :${config.port} | mock=${config.mockUrl} | ` +
        `slice=${config.sliceHours}h page=${config.pageLimit} | origins=${config.frontendOrigins.join(',') || 'none'}`
    );
  });

  if (config.autoStartPull) {
    const existing = await query<{ count: number }>(`SELECT count(*)::int AS count FROM trades`);
    if ((existing.rows[0]?.count ?? 0) > 0) {
      console.log('[api] auto-start skipped: tape already populated');
    } else {
      startPull()
        .then((id) => console.log(`[api] auto-started first pull ${id}`))
        .catch((error) => console.error(`[api] auto-start failed: ${(error as Error).message}`));
    }
  }

  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal} received, shutting down`);
    server.close();
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error('[api] fatal startup error', error);
  process.exit(1);
});
