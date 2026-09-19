import { logger } from '../lib/logger.js';
import { seedDefaults } from './bootstrap.js';
import { sql } from './index.js';

try {
  await seedDefaults();
  logger.info('сиды применены');
  await sql.end();
  process.exit(0);
} catch (err) {
  logger.fatal({ err }, 'сиды не применились');
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}
