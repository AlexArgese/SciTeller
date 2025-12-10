// auth-api/src/app/api/stories/[id]/route.js
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, Schema } from '@/db/index.js';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from "node:crypto";

const { stories, storyRevisions } = Schema;

function mergeSections(prevSections = [], patchSections = []) {
  const max = Math.max(prevSections.length, patchSections.length);
  const out = [];
  for (let i = 0; i < max; i++) {
    const prev = prevSections[i] || {};
    const next = patchSections[i];
    out[i] = next ? { ...prev, ...next } : prev;
  }
  return out;
}
function clean(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined)
  );
}
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
  let sections = Array.isArray(rev?.sections) ? rev.sections : [];
  if ((!sections || sections.length === 0) && rev?.content) {
    let c = rev.content;
    if (typeof c === "string") { try { c = JSON.parse(c); } catch { c = null; } }
    if (c && Array.isArray(c.sections)) sections = c.sections;
  }

  const meta = rev?.meta ?? {};
  const aggregates = computeAggregatesFromSections(sections, meta);

  const clientSections = normalizeSectionsForClient(sections);

  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    visibility: story.visibility,
    current_revision_id: story.currentRevisionId,
    persona: rev?.persona ?? null,
    meta: {
      ...meta,
      currentAggregates: aggregates,
    },
    sections: clientSections,
    content: rev?.content ?? null,
  };
}



function resolveBaseKnobs(meta = {}) {
  const up = meta.upstreamParams || {};
  const st = meta.storytellerParams || meta.storyteller_params || {};

  let baseLen =
    st.length_preset ||
    st.lengthPreset ||
    up.lengthPreset ||
    meta.lengthPreset ||
    null;

  if (!baseLen) {
    const words = Number(meta.lengthPerSection);
    if (Number.isFinite(words)) {
      if (words <= 120) baseLen = "short";
      else if (words >= 200) baseLen = "long";
      else baseLen = "medium";
    } else {
      baseLen = "medium";
    }
  }

  let baseTemp =
    typeof st.temperature === "number" ? st.temperature : null;

  if (baseTemp == null && typeof up.temp === "number") {
    baseTemp = up.temp;
  }

  if (baseTemp == null && typeof meta.creativity === "number") {
    baseTemp = meta.creativity / 100;
  }

  if (baseTemp == null && typeof meta.currentAggregates?.avgTemp === "number") {
    baseTemp = meta.currentAggregates.avgTemp;
  }

  if (!Number.isFinite(baseTemp)) baseTemp = 0;

  return { baseLen, baseTemp };
}

function computeSectionAggregates(section, sectionDefaults) {
  const paras = Array.isArray(section.paragraphs) ? section.paragraphs : [];

  if (!paras.length) {
    return {
      lengthLabel: sectionDefaults.lengthPreset || "medium",
      avgTemp: sectionDefaults.temp || 0,
    };
  }

  const effLens = paras.map((p) =>
    String(p.lengthPreset || sectionDefaults.lengthPreset || "medium").toLowerCase()
  );

  const allSameLen = effLens.every((l) => l === effLens[0]);
  const lengthLabel = allSameLen ? effLens[0] : "mix";

  const temps = paras.map((p) =>
    typeof p.temp === "number" ? p.temp : sectionDefaults.temp
  );

  const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;

  return { lengthLabel, avgTemp };
}

function computeAggregatesFromSections(sections, meta = {}) {
  const { baseLen, baseTemp } = resolveBaseKnobs(meta);

  if (!Array.isArray(sections) || sections.length === 0) {
    return {
      lengthLabel: baseLen,
      avgTemp: baseTemp,
      sectionsCount: 0,
    };
  }

  const sectionDefaults = { lengthPreset: baseLen, temp: baseTemp };

  const effLens = [];
  const temps = [];

  for (const s of sections) {
    const secBase = {
      lengthPreset: s.lengthPreset || baseLen,
      temp: typeof s.temp === "number" ? s.temp : baseTemp,
    };

    if (
      Array.isArray(s.paragraphs) &&
      s.paragraphs.some((p) => p && (p.temp != null || p.lengthPreset))
    ) {
      const { lengthLabel, avgTemp } = computeSectionAggregates(s, secBase);
      effLens.push(lengthLabel);
      temps.push(avgTemp);
    } else {
      effLens.push(String(secBase.lengthPreset || "medium").toLowerCase());
      temps.push(secBase.temp);
    }
  }

  const allSame = effLens.every((l) => l === effLens[0]);
  const lengthLabel = allSame ? effLens[0] : "mix";
  const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;

  return {
    lengthLabel,
    avgTemp,
    sectionsCount: sections.length,
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
      ? prevSections
      : (sectionsProvided
          ? mergeSections(prevSections, patch.sections) 
          : prevSections);

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
            const raw = Array.isArray(sec.paragraphs)
              ? sec.paragraphs.join("\n\n")
              : (sec.text || sec.narrative || "");

            return (h + raw).trim();
          })
          .filter(Boolean)
          .join("\n\n")
        : "";


    // 🔁 costruisci SEMPRE un oggetto JSONB con dentro sections (+ opzionale markdown)
    let nextContentObj;
    if (has("content") && patch.content && typeof patch.content === "object") {
      const secs = Array.isArray(patch.content.sections) ? patch.content.sections : nextSections;
      nextContentObj = clean({ ...patch.content, sections: secs });
    } else {
    const markdown = nextSections.length ? buildContent(nextSections) : "";
    nextContentObj = clean({
      sections: nextSections,
      markdown: markdown || null,
    });    
  }

  const revisionalChange =
    (has("sections") && !sectionsExplicitButEmpty) || has("persona") || has("meta") || has("content");

  let rev = prevRev;
  if (revisionalChange) {
    const parentId = baseRev?.id || null;

    // 👇 1) calcolo gli aggregati SULLE SEZIONI CHE STIAMO PER SALVARE
    const aggregates = computeAggregatesFromSections(nextSections, nextMeta);

    // 👇 2) li metto dentro la meta della revisione
    const isFullRegen = Array.isArray(nextSections) && nextSections.length > 0; // puoi specializzarlo
    let mergedMeta = {
      ...(nextMeta ?? {}),
      currentAggregates: aggregates,
      ...(parentId ? { parentRevisionId: parentId } : {}),
    };
    
    if (!isFullRegen) {
      mergedMeta.lastPartialRegen = nextMeta.lastPartialRegen ?? null;
    }
    
    mergedMeta = clean(mergedMeta);
    
  
    // 👇 3) salvo la revisione con la meta già “pulita”
    const [inserted] = await db.insert(storyRevisions).values({
      id: randomUUID(),
      storyId: s.id,
      content: nextContentObj,     // JSONB oggetto
      persona: nextPersona ?? "General Public",
      meta: mergedMeta,
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
      .set(clean(nextStoryFields))
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

function splitTextIntoParagraphs(txt = "") {
  const s = String(txt || "").replace(/\r\n/g, "\n").trim();
  if (!s) return [];
  // prima: righe vuote
  let parts = s.split(/\n{2,}/).map(t => t.trim()).filter(Boolean);
  if (parts.length <= 1) {
    // fallback: frasi
    parts = s
      .split(/(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Ý])/)
      .map(t => t.trim())
      .filter(Boolean);
  }
  return parts;
}


function normalizeSectionsForClient(sections = []) {
  return (sections || []).map((sec, i) => {
    let paras = Array.isArray(sec.paragraphs)
      ? sec.paragraphs
          .map((p) =>
            typeof p === "string" ? p : (p && p.text ? String(p.text) : "")
          )
          .filter(Boolean)
      : [];

    let text = sec.text || sec.narrative || "";

    // 🔴 SE c'è 0 o 1 paragrafo ma il testo è lungo → rispezza
    if ((paras.length === 0 || paras.length === 1) && text) {
      const rebuilt = splitTextIntoParagraphs(text);
      if (rebuilt.length > 1) {
        paras = rebuilt;
      }
    }

    // Se text è [object Object] o vuoto, rigeneralo dai paragrafi
    if ((!text || /\[object Object]/.test(String(text))) && paras.length > 0) {
      text = paras.join("\n\n");
    }

    return {
      ...sec,
      paragraphs: paras,
      text,
    };
  });
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
