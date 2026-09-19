import { logger } from '../lib/logger.js';
import { applyMigrations } from './bootstrap.js';
import { sql } from './index.js';

try {
  await applyMigrations();
  await sql.end();
  process.exit(0);
} catch (err) {
  logger.fatal({ err }, 'миграции не применились');
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}
