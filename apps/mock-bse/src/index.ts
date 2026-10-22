import path from 'node:path';
import dotenv from 'dotenv';
import { createMockApp } from './app';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const port = Number(process.env.MOCK_PORT ?? 4001);
const seedCount = Number(process.env.MOCK_SEED_COUNT ?? 5000);
const msPerRow = Number(process.env.MOCK_MS_PER_ROW ?? 180);
const maxResponseMs = Number(process.env.MOCK_MAX_RESPONSE_MS ?? 30_000);
const failRate = Number(process.env.MOCK_FAIL_RATE ?? 0);

const { app, store } = createMockApp({ seedCount, msPerRow, maxResponseMs, failRate });

const server = app.listen(port, () => {
  const pullMinutes = (store.trades.length * msPerRow) / 60_000;
  console.log(
    `[mock-bse] listening on :${port} | ${store.trades.length} trades | ${msPerRow}ms/row | ` +
      `full pull ~${pullMinutes.toFixed(1)} min | socket cap ${maxResponseMs}ms`
  );
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
