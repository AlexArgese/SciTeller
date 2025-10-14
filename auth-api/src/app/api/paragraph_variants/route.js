import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, Schema } from "@/db";
import { and, eq, desc } from "drizzle-orm";

const { stories, paragraphVariantBatches, paragraphVariants } = Schema;

export async function GET(req) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const storyId = url.searchParams.get("storyId");
  const sectionIndex = Number(url.searchParams.get("sectionIndex"));
  const paragraphIndex = Number(url.searchParams.get("paragraphIndex"));

  if (!storyId || Number.isNaN(sectionIndex) || Number.isNaN(paragraphIndex))
    return NextResponse.json({ error: "missing params" }, { status: 400 });

  const [story] = await db.select().from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, session.user.id))).limit(1);
  if (!story) return NextResponse.json({ error: "not found" }, { status: 404 });

  const batches = await db.select().from(paragraphVariantBatches)
    .where(and(
      eq(paragraphVariantBatches.storyId, storyId),
      eq(paragraphVariantBatches.sectionIndex, sectionIndex),
      eq(paragraphVariantBatches.paragraphIndex, paragraphIndex),
    ))
    .orderBy(desc(paragraphVariantBatches.createdAt));

  // attach variants
  const byBatch = {};
  for (const b of batches) {
    const vars = await db.select().from(paragraphVariants)
      .where(eq(paragraphVariants.batchId, b.id))
      .orderBy(paragraphVariants.rank);
    byBatch[b.id] = { batch: b, variants: vars };
  }

  return NextResponse.json({ items: Object.values(byBatch) });
}
