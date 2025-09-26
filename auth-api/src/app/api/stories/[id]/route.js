// auth-api/src/app/api/stories/[id]/route.js
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, Schema } from '@/db/index.js';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from "node:crypto";

const { stories, storyRevisions } = Schema;

async function loadOwnedStory(userId, storyId) {
  const [s] = await db
    .select()
    .from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, userId)))
    .limit(1);
  return s || null;
}

async function loadRevisionById(storyId, revId) {
  const [rev] = await db.select().from(storyRevisions)
    .where(and(eq(storyRevisions.id, revId), eq(storyRevisions.storyId, storyId)))
    .limit(1);
  return rev || null;
}

async function getDefaultRevision(story) {
  if (!story) return null;
  if (story.currentRevisionId) {
    const [rev] = await db.select().from(storyRevisions)
      .where(eq(storyRevisions.id, story.currentRevisionId)).limit(1);
    return rev || null;
  }
  const [rev] = await db.select().from(storyRevisions)
    .where(eq(storyRevisions.storyId, story.id))
    .orderBy(desc(storyRevisions.createdAt)).limit(1);
  return rev || null;
}

function materialize(story, rev) {
  // prova: colonna sections → poi content JSON → altrimenti []
  let sections = Array.isArray(rev?.sections) ? rev.sections : [];
  if ((!sections || sections.length === 0) && rev?.content) {
    let c = rev.content;
    if (typeof c === "string") { try { c = JSON.parse(c); } catch { c = null; } }
    if (c && Array.isArray(c.sections)) sections = c.sections;
  }

  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    visibility: story.visibility,
    current_revision_id: story.currentRevisionId,
    persona: rev?.persona ?? null,
    meta: rev?.meta ?? null,
    sections,
    content: rev?.content ?? null,
  };
}



export async function GET(_req, { params }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const s = await loadOwnedStory(session.user.id, params.id);
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const rev = await getDefaultRevision(s);
  return NextResponse.json(materialize(s, rev));
}

export async function PATCH(req, { params }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    const storyId = params?.id;
    if (!storyId) return new Response(JSON.stringify({ error: "Missing story id" }), { status: 400 });

    const s = await loadOwnedStory(session.user.id, storyId);
    if (!s) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

    const patch = await req.json();

    // 0) Apertura versione specifica senza creare nuove revisioni
    if (patch?.currentVersionId && typeof patch.currentVersionId === "string") {
      const rev = await loadRevisionById(s.id, patch.currentVersionId);
      if (!rev) {
        return new Response(JSON.stringify({ error: "version not found" }), { status: 404 });
      }
      const [updated] = await db.update(stories)
        .set({ currentRevisionId: rev.id, updatedAt: new Date() })
        .where(eq(stories.id, s.id))
        .returning();
      return new Response(JSON.stringify(materialize(updated, rev)), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }

    // 0bis) Imposta preferita (★). Usiamo la stessa colonna currentRevisionId.
    if (patch?.defaultVersionId && typeof patch.defaultVersionId === "string") {
      const rev = await loadRevisionById(s.id, patch.defaultVersionId);
      if (!rev) {
        return new Response(JSON.stringify({ error: "version not found" }), { status: 404 });
      }
      const [updated] = await db.update(stories)
        .set({ currentRevisionId: rev.id, updatedAt: new Date() })
        .where(eq(stories.id, s.id))
        .returning();
      return new Response(JSON.stringify(materialize(updated, rev)), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }


    // 2) revisione di partenza: se arriva baseRevisionId usala, altrimenti current/ultima
    let baseRev = null;
    if (patch?.baseRevisionId) {
      const [cand] = await db
        .select()
        .from(storyRevisions)
        .where(and(eq(storyRevisions.id, patch.baseRevisionId), eq(storyRevisions.storyId, s.id)))
        .limit(1);
      baseRev = cand || null;
    }

    let [prevRev] = baseRev
      ? [baseRev]
      : (s.currentRevisionId
          ? await db.select().from(storyRevisions).where(eq(storyRevisions.id, s.currentRevisionId)).limit(1)
          : await db.select().from(storyRevisions)
              .where(eq(storyRevisions.storyId, s.id))
              .orderBy(desc(storyRevisions.createdAt))
              .limit(1));

    // helper
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

    // ⬇️ NEW: tratta "sections: []" come NON inviato (se il client non passa anche 'content')
    const sectionsExplicitButEmpty =
      has("sections") && Array.isArray(patch.sections) && patch.sections.length === 0 && !has("content");

    const sectionsProvided =
      has("sections") && Array.isArray(patch.sections) && patch.sections.length > 0;

    // leggi la revisione corrente (prevRev) come fai già

    // fallback dalle sezioni della revisione corrente;
    // in più, se non ci sono in colonna, prova a estrarle da 'content' JSON
    let prevSections =
      Array.isArray(prevRev?.sections) ? prevRev.sections : [];

    if ((!prevSections || prevSections.length === 0) && prevRev?.content) {
      let c = prevRev.content;
      if (typeof c === "string") { try { c = JSON.parse(c); } catch { c = null; } }
      if (c && Array.isArray(c.sections)) prevSections = c.sections;
    }

    // ⬇️ la regola definitiva
    const nextSections = sectionsExplicitButEmpty
      ? prevSections                              // IGNORA lo svuotamento involontario
      : (sectionsProvided ? patch.sections : prevSections);

    // 4) PERSONA e META: preserva se assenti nel patch
    const nextPersona = has("persona") ? patch.persona : (prevRev?.persona ?? null);

    // 👇 NEW: non azzerare meta se arriva {} o null
    const metaExplicitButEmpty =
      has("meta") && (
        patch.meta == null ||
        (typeof patch.meta === "object" && Object.keys(patch.meta).length === 0)
      );

    const nextMeta = metaExplicitButEmpty
      ? (prevRev?.meta ?? {})
      : (has("meta") ? (patch.meta ?? {}) : (prevRev?.meta ?? {}));


    // 5) CONTENT: se non arriva, costruiscilo dalle sections; se nemmeno quelle, mantieni il precedente
    const buildContent = (secs) =>
    Array.isArray(secs)
      ? secs.map((sec) => {
          const h = sec?.title ? `# ${String(sec.title).trim()}\n\n` : "";
          const raw = typeof sec?.text === "string"
            ? sec.text
            : (typeof sec?.narrative === "string" ? sec.narrative : "");
          return (h + (raw || "")).trim();
        }).filter(Boolean).join("\n\n")
      : "";

    // 🔁 costruisci SEMPRE un oggetto JSONB con dentro sections (+ opzionale markdown)
    let nextContentObj;
    if (has("content") && patch.content && typeof patch.content === "object") {
    // se il client ti manda già un oggetto, prendilo (ma assicurati delle sections)
    const secs = Array.isArray(patch.content.sections) ? patch.content.sections : nextSections;
    nextContentObj = { ...patch.content, sections: secs };
    } else {
    const markdown = nextSections.length ? buildContent(nextSections) : "";
    nextContentObj = {
      sections: nextSections,      // <— QUI vivono le sezioni
      markdown: markdown || undefined, // opzionale, utile per debug
    };
    }

    const revisionalChange =
    (has("sections") && !sectionsExplicitButEmpty) || has("persona") || has("meta") || has("content");

    let rev = prevRev;
    if (revisionalChange) {
      const parentId = baseRev?.id || null;
      const mergedMeta = {
        ...(nextMeta ?? {}),
        ...(parentId ? { parentRevisionId: parentId } : {}),
      };
    
      const [inserted] = await db.insert(storyRevisions).values({
        id: randomUUID(),
        storyId: s.id,
        content: nextContentObj,     // JSONB oggetto
        persona: nextPersona ?? "General Public",
        meta: mergedMeta,            // 👈 include parentRevisionId se presente
        createdAt: new Date(),
      }).returning();
      rev = inserted;
    }

    // 7) aggiorna la riga 'stories' (titolo + puntatore revisione se creata)
    const preferTitle = (t) => typeof t === "string" && t.trim() && !/\.pdf$/i.test(t);
    const nextStoryFields = { updatedAt: new Date() };
    if (revisionalChange) nextStoryFields.currentRevisionId = rev.id;

    if (preferTitle(patch.title)) {
      nextStoryFields.title = patch.title.trim();
    } else if (preferTitle(patch?.meta?.aiTitle)) {
      nextStoryFields.title = patch.meta.aiTitle.trim();
    }

    const [updated] = await db.update(stories)
      .set(nextStoryFields)
      .where(eq(stories.id, s.id))
      .returning();

    // 8) risposta compatibile con la UI
    const effRev = rev ?? prevRev;
    const effContent = effRev?.content && typeof effRev.content === "object" ? effRev.content : null;

    return new Response(JSON.stringify({
      ...updated,
      persona: effRev?.persona ?? null,
      meta:    effRev?.meta ?? null,
      sections: Array.isArray(effContent?.sections) ? effContent.sections : [],
      content:  effContent, // puoi anche ometterlo, ma così vedi cosa c'è
    }), { status: 200, headers: { "Content-Type": "application/json" } });


  } catch (err) {
    console.error("[PATCH /api/stories/:id] error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", detail: String(err?.message || err) }),
      { status: 500 }
    );
  }
}




export async function DELETE(_req, { params }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const s = await loadOwnedStory(session.user.id, params.id);
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await db.delete(storyRevisions).where(eq(storyRevisions.storyId, s.id));
  await db.delete(stories).where(eq(stories.id, s.id));
  return new NextResponse(null, { status: 204 });
}
