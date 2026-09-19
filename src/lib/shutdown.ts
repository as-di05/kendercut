import { logger } from './logger.js';

type Hook = { name: string; run: () => Promise<void> | void };

const hooks: Hook[] = [];
let shuttingDown = false;

/** Регистрирует ресурс, который нужно закрыть при остановке (БД, Redis, воркеры). */
export function onShutdown(name: string, run: Hook['run']): void {
  hooks.push({ name, run });
}

type Options = {
  timeoutMs?: number;
  /**
   * Что сделать перед остановкой из-за необработанной ошибки.
   * Вынесено в колбэк, а не вызывается отсюда напрямую: всё, чем можно
   * кого-то оповестить, само регистрируется здесь через onShutdown,
   * и импорт в обратную сторону замкнул бы модули в кольцо.
   */
  onFatal?: (reason: string, err: unknown) => Promise<void>;
};

export function installShutdownHandlers({ timeoutMs = 10_000, onFatal }: Options = {}): void {
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'останавливаемся');

    const force = setTimeout(() => {
      logger.error({ timeoutMs }, 'не уложились в таймаут, выходим принудительно');
      process.exit(1);
    }, timeoutMs);
    force.unref();

    // В обратном порядке: закрываем сначала то, что подняли последним.
    for (const hook of [...hooks].reverse()) {
      try {
        await hook.run();
        logger.debug({ hook: hook.name }, 'закрыт');
      } catch (err) {
        logger.error({ hook: hook.name, err }, 'ошибка при закрытии');
      }
    }

    clearTimeout(force);
    logger.info('остановлены штатно');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  const die = (reason: string) => (err: unknown) => {
    logger.fatal({ err }, reason);
    // Оповещаем до остановки: после process.exit отправлять уже нечем.
    const notified = onFatal?.(reason, err) ?? Promise.resolve();
    void notified.catch(() => undefined).finally(() => void shutdown(reason));
  };

  process.on('uncaughtException', die('uncaughtException'));
  process.on('unhandledRejection', die('unhandledRejection'));
}
