// FILE: auth-api/src/app/api/paragraph_variants/route.js
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, Schema } from "@/db";
import { and, eq, desc } from "drizzle-orm";

const { stories, paragraphVariantBatches, paragraphVariants } = Schema;

export async function GET(req) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const storyId       = url.searchParams.get("storyId");
  const sectionIndex  = Number(url.searchParams.get("sectionIndex"));
  const paragraphIndex= Number(url.searchParams.get("paragraphIndex"));
  const revisionId    = url.searchParams.get("revisionId"); // 👈 può esserci o no

  if (!storyId || Number.isNaN(sectionIndex) || Number.isNaN(paragraphIndex)) {
    return NextResponse.json({ error: "missing params" }, { status: 400 });
  }

  // 1) check ownership
  const [story] = await db
    .select()
    .from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, session.user.id)))
    .limit(1);
  if (!story) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // helper per caricare batches + variants
  async function loadBatches({ withRevision }) {
    const conds = [
      eq(paragraphVariantBatches.storyId, storyId),
      eq(paragraphVariantBatches.sectionIndex, sectionIndex),
      eq(paragraphVariantBatches.paragraphIndex, paragraphIndex),
    ];
    if (withRevision && revisionId) {
      // solo i batch nati su quella revisione
      conds.push(eq(paragraphVariantBatches.revisionId, revisionId));
    }

    const batches = await db
      .select()
      .from(paragraphVariantBatches)
      .where(and(...conds))
      .orderBy(desc(paragraphVariantBatches.createdAt));

    const items = [];
    for (const b of batches) {
      const vars = await db
        .select()
        .from(paragraphVariants)
        .where(eq(paragraphVariants.batchId, b.id))
        .orderBy(paragraphVariants.rank);

      // normalizziamo i testi già qui
      const cleanVars = vars.map(v => ({
        ...v,
        text: (() => {
          const t = (v.text || "").trim();
          try {
            const j = JSON.parse(t);
            if (j?.text) return j.text;
          } catch {}
          return t;
        })(),
      }));

      items.push({ batch: b, variants: cleanVars });
    }
    return items;
  }

  // 2) prima prova: SOLO su quella revisione
  let items = await loadBatches({ withRevision: true });

  // 3) fallback: se non c'è nulla su quella revisione, prendi TUTTO (comportamento vecchio)
  if (!items.length) {
    items = await loadBatches({ withRevision: false });
  }

  return NextResponse.json({ items });
}
