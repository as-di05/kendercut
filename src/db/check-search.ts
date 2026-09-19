/* Проверка, что поиск действительно работает: словоформы, опечатки, регистр.
 * Прогонять после переезда базы или смены локали — молчаливая поломка
 * pg_trgm иначе всплывёт только на живых пользователях.
 * Вставляет несколько фильмов и удаляет их за собой.
 */
/* eslint-disable no-console */
import { inArray } from 'drizzle-orm';
import { db, sql } from './index.js';
import { films } from './schema.js';
import { searchFilms } from './repositories/films.js';

const FIXTURES = [
  { titleRu: 'Интерстеллар', titleOrig: 'Interstellar', year: 2014, rating: 8.4 },
  { titleRu: 'Властелин колец: Братство Кольца', titleOrig: 'The Lord of the Rings', year: 2001, rating: 8.4 },
  { titleRu: 'Матрица', titleOrig: 'The Matrix', year: 1999, rating: 8.2 },
  { titleRu: 'Зелёная миля', titleOrig: 'The Green Mile', year: 1999, rating: 8.5 },
];

const inserted = await db
  .insert(films)
  .values(
    FIXTURES.map((f, i) => ({
      ...f,
      storageChatId: -1000000000000 - i,
      storageMessageId: 900 + i,
      fileUniqueId: `test-fixture-${i}`,
      isPublished: true,
    })),
  )
  .returning({ id: films.id });

const CASES: [string, string][] = [
  ['интерстелар', 'опечатка (пропущена буква)'],
  ['ИНТЕРСТЕЛЛАР', 'другой регистр'],
  ['властелин колец', 'точное совпадение слов'],
  ['кольцо', 'словоформа: ищем «кольцо», в названии «Кольца»'],
  ['matrix', 'по оригинальному названию'],
  ['зеленая миля', 'без буквы ё'],
  ['мтарица', 'перестановка букв'],
  ['совершенно другой фильм', 'ничего не должно найтись'],
];

for (const [query, note] of CASES) {
  const found = await searchFilms(query, 3);
  const titles = found.map((f) => f.titleRu).join(' | ') || '—';
  console.log(`${found.length ? '✅' : '⬜'} "${query}"  — ${note}\n     ${titles}`);
}

await db.delete(films).where(inArray(films.id, inserted.map((r) => r.id)));
console.log('\nтестовые записи удалены');
await sql.end();
