import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://filmfinder:filmfinder@localhost:5433/filmfinder',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
