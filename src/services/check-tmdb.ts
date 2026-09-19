/* Проверка ключа TMDB: ищем известный фильм и смотрим, что вернулось.
 * Запуск: npm run tmdb:check
 */
/* eslint-disable no-console */
import { config } from '../lib/config.js';
import { getMovie, isTmdbConfigured, searchMovies } from './tmdb.js';

const QUERY = process.argv[2] ?? 'Интерстеллар';

if (!isTmdbConfigured()) {
  console.log('❌ TMDB_API_KEY не задан в .env');
  process.exit(1);
}

const kind = config.TMDB_API_KEY!.startsWith('ey')
  ? 'ключ доступа (v4, JWT) — уйдёт заголовком Authorization'
  : 'ключ API (v3) — уйдёт параметром api_key';
console.log(`Ключ распознан как: ${kind}`);

const found = await searchMovies(QUERY);

if (found.length === 0) {
  console.log(`\n❌ По запросу «${QUERY}» ничего не вернулось.`);
  console.log('Либо ключ неверный, либо TMDB недоступен — подробности в логах выше.');
  process.exit(1);
}

console.log(`\n✅ Нашлось вариантов: ${found.length}`);
for (const movie of found.slice(0, 5)) {
  console.log(`   ${movie.titleRu}${movie.year ? ` (${movie.year})` : ''} — tmdb:${movie.tmdbId}`);
}

const details = await getMovie(found[0]!.tmdbId);
if (!details) {
  console.log('\n❌ Карточка по id не открылась.');
  process.exit(1);
}

console.log('\nЧем заполнится карточка фильма:');
console.log(`   Название:    ${details.titleRu}`);
console.log(`   Оригинал:    ${details.titleOrig ?? '—'}`);
console.log(`   Год:         ${details.year ?? '—'}`);
console.log(`   Длительность:${details.durationMin ? ` ${details.durationMin} мин` : ' —'}`);
console.log(`   Рейтинг:     ${details.rating?.toFixed(1) ?? '—'}`);
console.log(`   Описание:    ${details.description ? `${details.description.length} символов` : '—'}`);
console.log(`   Постер:      ${details.posterUrl ?? '—'}`);
console.log(`   Жанров:      ${details.genreIds.length}`);

const gaps = [
  details.description ? undefined : 'описание',
  details.posterUrl ? undefined : 'постер',
  details.genreIds.length ? undefined : 'жанры',
].filter(Boolean);

console.log(
  gaps.length === 0
    ? '\n✅ Всё на месте — мастер заполнит карточку целиком.'
    : `\n⚠️ Не пришло: ${gaps.join(', ')}. Это заполняется вручную через «Редактировать».`,
);
