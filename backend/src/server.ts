import { buildApp } from './app.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';
import type { Store } from './store/types.js';

const env = process.env;

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const store: Store = env.DATABASE_URL ? await PostgresStore.connect(env.DATABASE_URL) : new MemoryStore();

const app = await buildApp({
  store,
  ingestToken: env.NODE_ENV === 'production' ? required('INGEST_TOKEN') : (env.INGEST_TOKEN ?? 'dev-ingest-token'),
  adminToken: env.NODE_ENV === 'production' ? required('ADMIN_TOKEN') : (env.ADMIN_TOKEN ?? 'dev-admin-token'),
  firmwareDir: env.FIRMWARE_DIR,
  logger: true,
});

app.log.info(`storage: ${env.DATABASE_URL ? 'postgres' : 'memory (set DATABASE_URL to persist)'}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await store.close();
    process.exit(0);
  });
}

await app.listen({ host: env.HOST ?? '0.0.0.0', port: Number(env.PORT ?? 3000) });
