import pino from 'pino';
import { config, isProduction } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

export type Logger = typeof logger;
