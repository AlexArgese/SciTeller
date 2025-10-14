import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, Schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const { stories, storyRevisions, paragraphVariantBatches, paragraphVariants } = Schema;

// util
function splitIntoParagraphs(txt) {
  const s = (txt || "").toString().replace(/\r\n/g, "\n").trim();
  if (!s) return [];
  let parts = s.split(/\n{2,}|\r?\n\s*\r?\n/g).map(t => t.trim()).filter(Boolean);
  if (parts.length <= 1) {
    parts = s.split(/([.!?])\s+(?=[A-ZÀ-ÖØ-Ý])/g).reduce((acc, chunk, i, arr) => {
      if (/[.!?]/.test(chunk) && arr[i + 1]) acc.push((arr[i - 1] || "") + chunk);
      else if (i === arr.length - 1) acc.push(chunk);
      return acc;
    }, []).map(t=>t.trim()).filter(Boolean);
  }
  return parts;
}

function sanitizeMaybeJsonGarbage(text) {
  const t = (text || "").trim();
  // se sembra JSON con "sections", prova estrazione
  try {
    const j = JSON.parse(t);
    if (j?.sections?.[0]?.text) return j.sections[0].text;
    if (j?.text) return j.text;
  } catch {}
  // se contiene blocchi JSON + prompt, tieni solo la parte "più lunga" non-JSON
  const stripped = t.replace(/^\s*\{[\s\S]*?\}\s*/g, "").trim();
  return stripped || t;
}

export async function POST(req) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body = {};
  try { body = await req.json(); } catch {}
  const { storyId, batchId, variantId } = body || {};
  if (!storyId || !batchId || !variantId) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  const [story] = await db.select().from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, session.user.id))).limit(1);
  if (!story) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [batch] = await db.select().from(paragraphVariantBatches)
    .where(and(eq(paragraphVariantBatches.id, batchId), eq(paragraphVariantBatches.storyId, storyId))).limit(1);
  if (!batch) return NextResponse.json({ error: "batch not found" }, { status: 404 });

  const [variant] = await db.select().from(paragraphVariants)
    .where(and(eq(paragraphVariants.id, variantId), eq(paragraphVariants.batchId, batchId))).limit(1);
  if (!variant) return NextResponse.json({ error: "variant not found" }, { status: 404 });

  // carica ultima revisione "materializzata"
  const [rev] = await db.select().from(Schema.storyRevisions)
    .where(eq(Schema.storyRevisions.id, story.currentRevisionId)).limit(1);
  const content = (typeof rev.content === "object" ? rev.content : JSON.parse(rev.content));
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const si = batch.sectionIndex;
  const pi = batch.paragraphIndex;
  if (!sections[si]) return NextResponse.json({ error: "section out of range" }, { status: 400 });

  // sanifica testo
  const chosenText = sanitizeMaybeJsonGarbage(variant.text);
  // ricalcola paragraphs coerenti per la sezione target
  const sec = sections[si];
  const paragraphs = Array.isArray(sec.paragraphs) && sec.paragraphs.length
    ? [...sec.paragraphs]
    : splitIntoParagraphs(sec.text || sec.narrative || "");

  if (!(pi >= 0 && pi < paragraphs.length)) {
    return NextResponse.json({ error: "paragraph out of range" }, { status: 400 });
  }
  paragraphs[pi] = chosenText;

  const nextSections = sections.map((s, idx) =>
    idx === si
      ? { ...s, paragraphs, text: paragraphs.join("\n\n") }
      : s
  );

  const nextContentObj = { ...content, sections: nextSections };

  // nuova revisione
  const newRevId = randomUUID();
  const [inserted] = await db.insert(storyRevisions).values({
    id: newRevId,
    storyId: story.id,
    content: nextContentObj,
    persona: rev?.persona || "General Public",
    meta: {
      ...(rev?.meta || {}),
      lastParagraphEdit: {
        at: new Date().toISOString(),
        sectionIndex: si,
        paragraphIndex: pi,
        chosenVariantId: variant.id,
        batchId: batch.id,
      },
    },
    createdAt: new Date(),
  }).returning();

  // aggiorna lo story pointer + marca scelto nel batch
  await db.update(stories)
    .set({ currentRevisionId: inserted.id, updatedAt: new Date() })
    .where(eq(stories.id, story.id));

  await db.update(paragraphVariantBatches)
    .set({ chosenVariantId: variant.id, chosenAt: new Date() })
    .where(eq(paragraphVariantBatches.id, batch.id));

  return NextResponse.json({
    ...inserted,
    materialized: {
      id: story.id,
      title: story.title,
      sections: nextSections,
      current_revision_id: inserted.id,
    }
  });
}
