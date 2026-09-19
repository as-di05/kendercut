import { logger } from '../lib/logger.js';
import { onShutdown } from '../lib/shutdown.js';

/**
 * Запускает задачу по расписанию: сразу и дальше каждые `intervalMs`.
 *
 * Очередей вроде BullMQ здесь намеренно нет. Всё, что боту нужно делать
 * регулярно, — это пройтись по таблице и разобрать просроченное; состояние
 * уже лежит в базе и переживает перезапуск, а отдельный воркер с Redis-очередью
 * добавил бы процесс, конфиг и точку отказа, ничего не дав взамен.
 */
export function every(name: string, intervalMs: number, tick: () => Promise<unknown>): void {
  let running = false;

  const run = async (): Promise<void> => {
    // Прошлый проход ещё идёт — второй параллельно не запускаем.
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      logger.error({ err, job: name }, 'фоновая задача упала');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  onShutdown(`job:${name}`, () => clearInterval(timer));

  void run();
}
