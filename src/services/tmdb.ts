import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const API = 'https://api.themoviedb.org/3';
const IMAGE = 'https://image.tmdb.org/t/p/w500';
const TIMEOUT_MS = 8000;

export type TmdbMovie = {
  tmdbId: number;
  titleRu: string;
  titleOrig: string | undefined;
  year: number | undefined;
  description: string | undefined;
  rating: number | undefined;
  durationMin: number | undefined;
  posterUrl: string | undefined;
  /** id жанров TMDB — совпадают с genres.tmdb_id в нашей базе. */
  genreIds: number[];
};

type SearchItem = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
  vote_average?: number;
  genre_ids?: number[];
};

type Details = SearchItem & {
  runtime?: number | null;
  genres?: { id: number; name: string }[];
};

export const isTmdbConfigured = (): boolean => Boolean(config.TMDB_API_KEY);

/**
 * Ищет фильм по названию. Пустой массив — и когда ничего не нашлось,
 * и когда TMDB недоступен: мастер в обоих случаях предложит ручной ввод.
 */
export async function searchMovies(query: string, limit = 5): Promise<TmdbMovie[]> {
  const data = await request<{ results?: SearchItem[] }>('/search/movie', {
    query,
    include_adult: 'false',
  });
  if (!data?.results?.length) return [];
  return data.results.slice(0, limit).map(toMovie);
}

/** Подробности: длительность и жанры есть только здесь, в выдаче поиска их нет. */
export async function getMovie(tmdbId: number): Promise<TmdbMovie | undefined> {
  const data = await request<Details>(`/movie/${tmdbId}`, {});
  return data ? toMovie(data) : undefined;
}

function toMovie(item: Details): TmdbMovie {
  const year = item.release_date ? Number(item.release_date.slice(0, 4)) : undefined;
  return {
    tmdbId: item.id,
    // У редких фильмов русского названия нет — тогда остаётся оригинальное.
    titleRu: item.title || item.original_title || 'Без названия',
    titleOrig: item.original_title || undefined,
    year: Number.isFinite(year) ? year : undefined,
    description: item.overview || undefined,
    rating: item.vote_average || undefined,
    durationMin: item.runtime ?? undefined,
    posterUrl: item.poster_path ? `${IMAGE}${item.poster_path}` : undefined,
    genreIds: item.genres?.map((g) => g.id) ?? item.genre_ids ?? [],
  };
}

async function request<T>(path: string, params: Record<string, string>): Promise<T | undefined> {
  const apiKey = config.TMDB_API_KEY;
  if (!apiKey) return undefined;

  const url = new URL(API + path);
  url.searchParams.set('language', 'ru-RU');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // v3-ключ идёт параметром, v4-токен (JWT) — заголовком.
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey.startsWith('ey')) headers['Authorization'] = `Bearer ${apiKey}`;
  else url.searchParams.set('api_key', apiKey);

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      logger.warn({ path, status: res.status }, 'TMDB ответил ошибкой');
      return undefined;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ path, err }, 'TMDB недоступен');
    return undefined;
  }
}
