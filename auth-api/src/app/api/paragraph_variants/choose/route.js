// FILE: auth-api/src/app/api/paragraph_variants/choose/route.js
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, Schema } from "@/db";
import { and, eq, desc } from "drizzle-orm";

const {
  stories,
  storyRevisions,
  paragraphVariantBatches,
  paragraphVariants,
} = Schema;

/* -------------------- helpers -------------------- */
async function loadOwnedStory(userId, storyId) {
  const [s] = await db
    .select()
    .from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, userId)))
    .limit(1);
  return s || null;
}

async function loadRevisionById(storyId, revId) {
  const [rev] = await db
    .select()
    .from(storyRevisions)
    .where(and(eq(storyRevisions.id, revId), eq(storyRevisions.storyId, storyId)))
    .limit(1);
  return rev || null;
}

async function getDefaultRevision(story) {
  if (!story) return null;
  if (story.currentRevisionId) {
    const [rev] = await db
      .select()
      .from(storyRevisions)
      .where(eq(storyRevisions.id, story.currentRevisionId))
      .limit(1);
    return rev || null;
  }
  const [rev] = await db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.storyId, story.id))
    .orderBy(desc(storyRevisions.createdAt))
    .limit(1);
  return rev || null;
}

function splitIntoParagraphs(txt) {
  const s = (txt || "").toString().replace(/\r\n/g, "\n").trim();
  if (!s) return [];
  let parts = s
    .split(/\n{2,}|\r?\n\s*\r?\n/g)
    .map((t) => t.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    parts = s
      .split(/([.!?])\s+(?=[A-ZÀ-ÖØ-Ý])/g)
      .reduce((acc, chunk, i, arr) => {
        if (/[.!?]/.test(chunk) && arr[i + 1]) acc.push((arr[i - 1] || "") + chunk);
        else if (i === arr.length - 1) acc.push(chunk);
        return acc;
      }, [])
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return parts;
}

function normalizeSectionsForParagraphs(sectionsRaw = []) {
  return (sectionsRaw || []).map((sec, i) => {
    const baseText =
      (typeof sec?.text === "string" && sec.text) ||
      (typeof sec?.narrative === "string" && sec.narrative) ||
      "";

    // 1) prendi i paragrafi, qualsiasi tipo siano, e trasformali in stringhe pulite
    let paragraphs = Array.isArray(sec?.paragraphs) ? sec.paragraphs : [];
    paragraphs = paragraphs
      .map((p) => {
        if (typeof p === "string") return p.trim();
        if (p && typeof p.text === "string") return p.text.trim();
        return "";
      })
      .filter(Boolean);

    // 2) se ancora troppo pochi, prova a risplittare dal testo
    if (paragraphs.length <= 1) {
      const resplit = splitIntoParagraphs(baseText);
      if (resplit.length) paragraphs = resplit;
    }

    // 3) se proprio non c'è nulla, usa il testo intero come unico paragrafo
    if (!paragraphs.length && baseText) {
      paragraphs = [baseText];
    }

    const joined = paragraphs.join("\n\n");

    return {
      ...sec,
      id: String(sec?.id ?? sec?.sectionId ?? i),
      title: sec?.title || `Section ${i + 1}`,
      paragraphs,          // <-- sempre array di stringhe
      text: joined,        // testo coerente
      narrative:
        typeof sec?.narrative === "string" && sec.narrative.trim()
          ? sec.narrative
          : joined,
    };
  });
}


function materialize(story, rev) {
  let sections = Array.isArray(rev?.sections) ? rev.sections : [];
  if ((!sections || sections.length === 0) && rev?.content) {
    let c = rev.content;
    if (typeof c === "string") {
      try {
        c = JSON.parse(c);
      } catch {
        c = null;
      }
    }
    if (c && Array.isArray(c.sections)) sections = c.sections;
  }
  if (!Array.isArray(sections)) sections = [];
  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    visibility: story.visibility,
    current_revision_id: story.currentRevisionId,
    persona: rev?.persona ?? null,
    meta: (rev?.meta && typeof rev.meta === "object") ? rev.meta : null,
    sections,
    content: rev?.content ?? null,
    notes: rev?.notes ?? null,
  };
}

function sanitizeMaybeJsonGarbage(text) {
  const t = (text || "").trim();
  try {
    const j = JSON.parse(t);
    if (j?.sections?.[0]?.text) return j.sections[0].text;
    if (j?.text) return j.text;
  } catch {}
  const stripped = t.replace(/^\s*\{[\s\S]*?\}\s*/g, "").trim();
  return stripped || t;
}

/* -------------------- POST /api/paragraph_variants/choose -------------------- */
export async function POST(req) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }

    const storyId = String(body?.storyId || body?.story_id || "");
    const batchId = String(body?.batchId || body?.batch_id || "");
    const variantId = String(body?.variantId || body?.variant_id || "");
    const baseRevisionId = body?.baseRevisionId || body?.base_revision_id || null;

    if (!storyId) return NextResponse.json({ error: "missing storyId" }, { status: 400 });
    if (!batchId) return NextResponse.json({ error: "missing batchId" }, { status: 400 });
    if (!variantId) return NextResponse.json({ error: "missing variantId" }, { status: 400 });

    const s = await loadOwnedStory(session.user.id, storyId);
    if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

    // batch
    const [batch] = await db
      .select()
      .from(paragraphVariantBatches)
      .where(and(eq(paragraphVariantBatches.id, batchId), eq(paragraphVariantBatches.storyId, s.id)))
      .limit(1);
    if (!batch) return NextResponse.json({ error: "batch not found" }, { status: 404 });

    // variant nel batch
    const [variant] = await db
      .select()
      .from(paragraphVariants)
      .where(and(eq(paragraphVariants.id, variantId), eq(paragraphVariants.batchId, batch.id)))
      .limit(1);
    if (!variant) return NextResponse.json({ error: "variant not found in batch" }, { status: 404 });

    // ------------------- REVISIONE BASE CORRETTA -------------------
    let baseRev;

    // 1) Se il batch ha baseRevisionId → è quella la revisione giusta
    if (batch.baseRevisionId) {
      const [rev] = await db
        .select()
        .from(storyRevisions)
        .where(
          and(
            eq(storyRevisions.id, batch.baseRevisionId),
            eq(storyRevisions.storyId, s.id)
          )
        )
        .limit(1);

      if (!rev) {
        return NextResponse.json(
          { error: "base revision not found for batch" },
          { status: 409 }
        );
      }

      baseRev = rev;
    } 
    else {
      // 2) Fallback → usa la revisione corrente della storia
      const [rev] = await db
        .select()
        .from(storyRevisions)
        .where(eq(storyRevisions.id, s.currentRevisionId))
        .limit(1);

      if (!rev) {
        return NextResponse.json(
          { error: "story has no current revision" },
          { status: 409 }
        );
      }

      baseRev = rev;
    }

    // ora prevRev è sicuramente la revisione giusta
    const prevRev = baseRev;


    if (!prevRev) return NextResponse.json({ error: "no revision to apply on" }, { status: 409 });

    // estrai contenuto/sections in modo robusto
    let effContentObj = null;
    if (prevRev?.content && typeof prevRev.content === "object") {
      effContentObj = prevRev.content;
    } else if (prevRev?.content && typeof prevRev.content === "string") {
      try {
        effContentObj = JSON.parse(prevRev.content);
      } catch {
        effContentObj = null;
      }
    }
    const prevSectionsRaw = Array.isArray(effContentObj?.sections)
      ? effContentObj.sections
      : Array.isArray(prevRev?.sections)
      ? prevRev.sections
      : [];

    if (!Array.isArray(prevSectionsRaw) || prevSectionsRaw.length === 0) {
      return NextResponse.json({ error: "no sections in base revision" }, { status: 409 });
    }

    const normSections = normalizeSectionsForParagraphs(prevSectionsRaw);

    const sectionIndex =
      Number.isInteger(batch?.sectionIndex) ? batch.sectionIndex :
      Number.isInteger(batch?.section_index) ? batch.section_index :
      Number.isInteger(batch?.secIndex) ? batch.secIndex :
      null;

    const paragraphIndex =
      Number.isInteger(batch?.paragraphIndex) ? batch.paragraphIndex :
      Number.isInteger(batch?.paragraph_index) ? batch.paragraph_index :
      Number.isInteger(batch?.paraIndex) ? batch.paraIndex :
      null;

    if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= normSections.length) {
      return NextResponse.json({ error: "invalid section index in batch" }, { status: 400 });
    }
    const sec = normSections[sectionIndex];
    if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0 || paragraphIndex >= sec.paragraphs.length) {
      return NextResponse.json({ error: "invalid paragraph index in batch" }, { status: 400 });
    }

    // applica testo
    const chosenText = sanitizeMaybeJsonGarbage(variant.text || "");
    if (!chosenText.trim()) return NextResponse.json({ error: "empty variant text" }, { status: 400 });

    const nextSections = normSections.map((secItem, i) => {
      if (i !== sectionIndex) return secItem;
      const nextParas = [...secItem.paragraphs];
      nextParas[paragraphIndex] = chosenText;
      const joined = nextParas.join("\n\n");
      return {
        ...secItem,
        paragraphs: nextParas,
        text: joined,
        narrative: joined,
      };
    });

    // merge meta sicuro, con badge lastParagraphEdit e NOTE per il tab Versions
    const safePrevMeta = (prevRev && typeof prevRev.meta === "object" && prevRev.meta) ? prevRev.meta : {};
    const updatedMeta = {
      ...safePrevMeta,
      lastParagraphEdit: {
        ...(safePrevMeta?.lastParagraphEdit || {}),
        at: new Date().toISOString(),
        sectionIndex,
        paragraphIndex,
        chosenVariantId: variant.id,
        chosenBatchId: batch.id,
      },
      // messaggio “umano” visibile nel tab Versions
      notes: safePrevMeta?.notes || `Adopted paragraph variant (sec=${sectionIndex + 1}, ¶=${paragraphIndex + 1})`,
    };

    const updatedContentToSave = {
      ...(effContentObj && typeof effContentObj === "object" ? effContentObj : {}),
      sections: nextSections,
      markdown: undefined,
    };

    await db
      .update(storyRevisions)
      .set({
        content: updatedContentToSave,
        meta: updatedMeta,
        updatedAt: new Date(),
        notes: `Adopted paragraph variant (sec=${sectionIndex + 1}, ¶=${paragraphIndex + 1})`,
      })
      .where(eq(storyRevisions.id, prevRev.id));

    
    if (!s.currentRevisionId || s.currentRevisionId !== prevRev.id) {
      await db
        .update(stories)
        .set({ currentRevisionId: prevRev.id, updatedAt: new Date() })
        .where(eq(stories.id, s.id));
    }

    const [updatedStoryRow] = await db
      .select()
      .from(stories)
      .where(eq(stories.id, s.id))
      .limit(1);

    const [updatedRevRow] = await db
      .select()
      .from(storyRevisions)
      .where(eq(storyRevisions.id, prevRev.id))
      .limit(1);

    // aggiorna batch (qualunque naming abbia lo schema)
    const batchUpdateSet =
      (paragraphVariantBatches?.chosenVariantId && paragraphVariantBatches?.chosenAt)
        ? { chosenVariantId: variant.id, chosenAt: new Date() }
        : (paragraphVariantBatches?.chosen_variant_id && paragraphVariantBatches?.chosen_at)
          ? { chosen_variant_id: variant.id, chosen_at: new Date() }
          : {};

    if (Object.keys(batchUpdateSet).length > 0) {
      await db
        .update(paragraphVariantBatches)
        .set(batchUpdateSet)
        .where(eq(paragraphVariantBatches.id, batch.id));
    }

    return NextResponse.json(materialize(updatedStoryRow, updatedRevRow), { status: 200 });
  } catch (err) {
    console.error("[paragraph_variants/choose] fatal:", err);
    const isDev = process.env.NODE_ENV !== "production";
    return NextResponse.json(
      { error: "internal", detail: isDev ? String(err?.message || err) : "server error" },
      { status: 500 }
    );
  }
}
