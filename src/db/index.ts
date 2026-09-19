import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config, isProduction } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { onShutdown } from '../lib/shutdown.js';
import * as schema from './schema.js';

export const sql = postgres(config.DATABASE_URL, {
  max: isProduction ? 10 : 4,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: (notice) => logger.debug({ notice: notice.message }, 'postgres notice'),
});

export const db = drizzle(sql, { schema });

onShutdown('postgres', async () => {
  await sql.end({ timeout: 5 });
});

/** Проверка связи с базой на старте — лучше упасть сразу, чем на первом запросе. */
export async function assertDbReachable(): Promise<void> {
  const [row] = await sql<{ version: string }[]>`select version()`;
  logger.info({ version: row?.version?.split(',')[0] }, 'postgres подключён');
}

export { schema };
