import { asc, eq } from 'drizzle-orm';
import { db } from '../index.js';
import { genres, plans } from '../schema.js';

export type Genre = typeof genres.$inferSelect;
export type Plan = typeof plans.$inferSelect;

export async function listGenres(): Promise<Genre[]> {
  return db.select().from(genres).orderBy(asc(genres.nameRu));
}

export async function listActivePlans(): Promise<Plan[]> {
  return db.select().from(plans).where(eq(plans.isActive, true)).orderBy(asc(plans.sort));
}

export async function getPlanByCode(code: string): Promise<Plan | undefined> {
  return db.query.plans.findFirst({ where: eq(plans.code, code) });
}

export async function getPlan(id: number): Promise<Plan | undefined> {
  return db.query.plans.findFirst({ where: eq(plans.id, id) });
}

/** Все тарифы, включая выключенные — для админки. */
export async function listPlans(): Promise<Plan[]> {
  return db.select().from(plans).orderBy(asc(plans.sort), asc(plans.id));
}

export async function createPlan(input: {
  code: string;
  title: string;
  days: number;
  priceStars: number;
}): Promise<Plan> {
  const [row] = await db
    .insert(plans)
    .values({ ...input, isActive: false, sort: input.days })
    .returning();
  return row!;
}

export async function updatePlan(
  id: number,
  patch: Partial<typeof plans.$inferInsert>,
): Promise<Plan | undefined> {
  const [row] = await db.update(plans).set(patch).where(eq(plans.id, id)).returning();
  return row;
}

export async function deletePlan(id: number): Promise<void> {
  await db.delete(plans).where(eq(plans.id, id));
}
