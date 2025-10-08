// auth-api/src/app/api/regen_sections_vm/route.js
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, Schema } from "@/db/index.js";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const { stories, storyRevisions } = Schema;

const REMOTE_GPU_URL = (process.env.REMOTE_GPU_URL || "").replace(/\/$/, "");
const REMOTE_API_KEY = process.env.REMOTE_API_KEY || process.env.REMOTE_APIKEY || "";

// ---- helpers DB ----
async function loadOwnedStory(userId, storyId) {
  const [s] = await db.select().from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, userId))).limit(1);
  return s || null;
}
async function loadRevisionById(storyId, revId) {
  const [rev] = await db.select().from(storyRevisions)
    .where(and(eq(storyRevisions.id, revId), eq(storyRevisions.storyId, storyId))).limit(1);
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
function sectionsFromRev(rev) {
  let secs = Array.isArray(rev?.sections) ? rev.sections : [];
  let content = rev?.content;
  if ((!secs || secs.length === 0) && content) {
    if (typeof content === "string") { try { content = JSON.parse(content); } catch { content = null; } }
    if (content && Array.isArray(content.sections)) secs = content.sections;
  }
  return Array.isArray(secs) ? secs : [];
}
function materialize(story, rev) {
  const content = (rev?.content && typeof rev.content === "object") ? rev.content : null;
  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    visibility: story.visibility,
    current_revision_id: story.currentRevisionId,
    persona: rev?.persona ?? null,
    meta: rev?.meta ?? null,
    sections: Array.isArray(content?.sections) ? content.sections : [],
    content,
  };
}
function mapIdsToIndexes(sections, ids = []) {
  const idToIdx = new Map(
    (sections || []).map((s, i) => [String(s.id ?? s.sectionId ?? i), i])
  );
  return (ids || [])
    .map(id => idToIdx.get(String(id)))
    .filter(i => Number.isInteger(i))
    .sort((a, b) => a - b);
}
function buildCleanedText(sections) {
  const blocks = (sections || []).map((s) => {
    const h = s?.title ? `# ${String(s.title).trim()}\n\n` : "";
    const raw = typeof s?.text === "string"
      ? s.text
      : (typeof s?.narrative === "string" ? s.narrative : "");
    return (h + (raw || "")).trim();
  }).filter(Boolean);
  return blocks.join("\n\n");
}

export async function POST(req) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!REMOTE_GPU_URL) {
      return NextResponse.json({ error: "GPU URL not configured" }, { status: 503 });
    }

    const body = await req.json().catch(() => ({}));
    const storyId = String(body.storyId || "");
    const baseRevisionId = body.baseRevisionId ? String(body.baseRevisionId) : null;
    const sectionIds = Array.isArray(body.sectionIds) ? body.sectionIds : null;
    const targetsIn = Array.isArray(body.targets) ? body.targets : null;
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    const knobs = typeof body.knobs === "object" && body.knobs ? body.knobs : {};

    if (!storyId) return NextResponse.json({ error: "Missing storyId" }, { status: 400 });

    // 1) ownership + base revision
    const s = await loadOwnedStory(session.user.id, storyId);
    if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

    const baseRev = baseRevisionId
      ? await loadRevisionById(s.id, baseRevisionId)
      : await getDefaultRevision(s);

    if (!baseRev) return NextResponse.json({ error: "base revision not found" }, { status: 404 });

    const baseSections = sectionsFromRev(baseRev);
    if (!Array.isArray(baseSections) || baseSections.length === 0) {
      return NextResponse.json({ error: "base revision has no sections" }, { status: 400 });
    }

    // 2) mapping sectionIds -> targets (sulla revisione di base)
    let targets = [];
    if (sectionIds) targets = mapIdsToIndexes(baseSections, sectionIds);
    else if (targetsIn) {
      targets = targetsIn.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 0 && n < baseSections.length)
                        .sort((a,b)=>a-b);
    }
    if (!targets.length) return NextResponse.json({ error: "no valid targets" }, { status: 400 });

    // 3) derive inputs: text/persona/title/outline/knobs dalla base
    const persona = baseRev?.persona || "General Public";
    const title = s?.title || "Story";
    const cleaned_text = baseRev?.meta?.paperText || buildCleanedText(baseSections);

    const bodyTop = body || {};
    const up = (baseRev?.meta?.upstreamParams) || {};

    const temp = Number(
        bodyTop.temp ??
        knobs.temp ??
        up.temp ??
        0.0
    );

    const top_p = Number(
        bodyTop.top_p ??
        knobs.top_p ??
        up.top_p ??
        0.9
    );

    const lengthPreset = String(
        bodyTop.length_preset ??
        knobs.lengthPreset ??
        up.lengthPreset ??
        "medium"
    );

    // costruiamo il payload per la VM con i valori effettivi
    const vmBody = {
        text: cleaned_text,
        persona,
        title,
        sections: baseSections,
        targets,
        temp,
        top_p,
        length_preset: lengthPreset,
        retriever:        (bodyTop.retriever ?? knobs.retriever ?? up.retriever),
        retriever_model:  (bodyTop.retriever_model ?? knobs.retriever_model ?? up.retriever_model),
        k:                (bodyTop.k ?? knobs.k ?? up.k),
        max_ctx_chars:    (bodyTop.max_ctx_chars ?? knobs.max_ctx_chars ?? up.max_ctx_chars),
        seg_words:        (bodyTop.seg_words ?? knobs.seg_words ?? up.seg_words),
        overlap_words:    (bodyTop.overlap_words ?? knobs.overlap_words ?? up.overlap_words),
    };

    // 4) call VM
    const vmRes = await fetch(`${REMOTE_GPU_URL}/api/regen_sections_vm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(REMOTE_API_KEY ? { "X-API-Key": REMOTE_API_KEY } : {}),
      },
      body: JSON.stringify(vmBody),
    });
    const vmData = await vmRes.json().catch(() => ({}));
    if (!vmRes.ok) {
      return NextResponse.json({ error: "GPU service error", detail: vmData?.detail || vmData }, { status: vmRes.status });
    }

    const newSections = Array.isArray(vmData.sections) ? vmData.sections : baseSections;

    const targetsSet = new Set(targets || []);
    const usedTemp   = (typeof temp === "number") ? temp : 0.5;
    const usedPreset = String(lengthPreset || "medium");

    const stampedSections = newSections.map((sec, i) => {
    if (targetsSet.has(i)) {
        return {
        ...sec,
        temp: usedTemp,          
        lengthPreset: usedPreset,  
        };
    }
    return { ...sec };
    });


    const prevUpstream = (baseRev?.meta?.upstreamParams) || {};

    const upstreamParams = {
        ...prevUpstream,
        temp,
        top_p,
        lengthPreset,
        retriever:       vmBody.retriever       ?? prevUpstream.retriever,
        retriever_model: vmBody.retriever_model ?? prevUpstream.retriever_model,
        k:               vmBody.k               ?? prevUpstream.k,
        max_ctx_chars:   vmBody.max_ctx_chars   ?? prevUpstream.max_ctx_chars,
        seg_words:       vmBody.seg_words       ?? prevUpstream.seg_words,
        overlap_words:   vmBody.overlap_words   ?? prevUpstream.overlap_words,
        mode: "regen_partial_vm",
        targets,
      };

    const mergedMeta = {
        ...(baseRev?.meta || {}),
        upstreamParams, 
        lastPartialRegen: {
            temp, top_p, lengthPreset, targets,
            at: new Date().toISOString(),
        },
        ...(notes ? { notes } : {}),
        ...(baseRev?.id ? { parentRevisionId: baseRev.id } : {}),
    };


    const content = { sections: stampedSections };
    const [inserted] = await db.insert(storyRevisions).values({
      id: randomUUID(),
      storyId: s.id,
      content,
      persona,
      meta: mergedMeta,
      createdAt: new Date(),
    }).returning();

    const [updatedStory] = await db.update(stories)
      .set({ currentRevisionId: inserted.id, updatedAt: new Date() })
      .where(eq(stories.id, s.id)).returning();

    return NextResponse.json(materialize(updatedStory, inserted));
  } catch (err) {
    console.error("[POST /api/regen_sections_vm] error:", err);
    return NextResponse.json({ error: "internal error", detail: String(err?.message || err) }, { status: 500 });
  }
}
