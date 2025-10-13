// FILE: auth-api/src/app/api/regen_sections_vm/route.js
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, Schema } from "@/db/index.js";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ✅ Allunga i timeout HTTP di Undici (fetch in Node/Next usa Undici)
import { setGlobalDispatcher, Agent } from "undici";
setGlobalDispatcher(new Agent({
  // tempo per stabilire la connessione
  connect: { timeout: 60_000 },     // 60s
  // tempo massimo per ricevere gli HEADER della risposta
  headersTimeout: 600_000,          // 10 minuti
  // tempo massimo per leggere il BODY (0 = disabilitato)
  bodyTimeout: 0,                   // nessun timeout sul body
  keepAliveTimeout: 120_000,        // opzionale
}));

const { stories, storyRevisions } = Schema;

const REMOTE_GPU_URL = (process.env.REMOTE_GPU_URL || "").replace(/\/$/, "");
const REMOTE_API_KEY = process.env.REMOTE_API_KEY || process.env.REMOTE_APIKEY || "";

/* ===================== Helpers DB ===================== */
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

/* ===================== Helpers contenuto ===================== */
function sectionsFromRev(rev) {
  let secs = Array.isArray(rev?.sections) ? rev.sections : [];
  let content = rev?.content;
  if ((!secs || secs.length === 0) && content) {
    if (typeof content === "string") {
      try { content = JSON.parse(content); } catch { content = null; }
    }
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
    .map((id) => idToIdx.get(String(id)))
    .filter((i) => Number.isInteger(i))
    .sort((a, b) => a - b);
}

function buildCleanedText(sections) {
  const blocks = (sections || [])
    .map((s) => {
      const h = s?.title ? `# ${String(s.title).trim()}\n\n` : "";
      const raw =
        typeof s?.text === "string" ? s.text
        : typeof s?.narrative === "string" ? s.narrative
        : "";
      return (h + (raw || "")).trim();
    })
    .filter(Boolean);
  return blocks.join("\n\n");
}

function toOutlineMinimal(sections) {
  return (sections || []).map((s, i) => ({
    title: String(s?.title ?? `Section ${i + 1}`),
    description: typeof s?.description === "string" ? s.description : "",
  }));
}

function ensureParagraphsFromText(text) {
  const t = (text || "").trim();
  if (!t) return [];
  const parts = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (parts.length) return parts;
  // fallback: split su fine frase con maiuscola successiva
  return t.split(/(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Ý])/).map((p) => p.trim()).filter(Boolean);
}

function adaptSectionPatch(patch, fallback) {
  const raw = (patch?.text ?? patch?.narrative ?? "").trim();
  return {
    ...fallback,
    title: patch?.title ?? fallback?.title ?? "",
    text: raw,
    narrative: raw,
    paragraphs: Array.isArray(patch?.paragraphs) && patch.paragraphs.length
      ? patch.paragraphs
      : ensureParagraphsFromText(raw),
    visible: fallback?.visible !== false,
  };
}

/* ===================== Handler ===================== */
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

    if (!storyId) {
      return NextResponse.json({ error: "Missing storyId" }, { status: 400 });
    }
    if (sectionIds && targetsIn) {
      return NextResponse.json({ error: "Specify either sectionIds or targets, not both." }, { status: 400 });
    }

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
    if (sectionIds) {
      targets = mapIdsToIndexes(baseSections, sectionIds);
    } else if (targetsIn) {
      targets = targetsIn
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < baseSections.length)
        .sort((a, b) => a - b);
    }
    if (!targets.length) {
      return NextResponse.json({ error: "no valid targets" }, { status: 400 });
    }

    // 3) derive inputs: text/persona/outline/knobs dalla base
    const persona = baseRev?.persona || "General Public";
    const cleaned_text = baseRev?.meta?.paperText || buildCleanedText(baseSections);
    const outline = toOutlineMinimal(baseSections);

    const prevUpstream = (baseRev?.meta?.upstreamParams) || {};
    const bodyTop = body || {};

    // manopole usate solo sui target (non globali)
    const temp = Number(bodyTop.temp ?? knobs.temp ?? prevUpstream.temp ?? 0.0);
    const top_p = Number(bodyTop.top_p ?? knobs.top_p ?? prevUpstream.top_p ?? 0.9);
    const lengthPreset = String(
      bodyTop.length_preset ?? knobs.lengthPreset ?? prevUpstream.lengthPreset ?? "medium"
    );

    // 4) payload per la VM
    const vmBody = {
        persona,
        title: s.title || "Paper",
        text: cleaned_text, 
        sections: baseSections, 
        targets,
        temp,
        top_p,
        length_preset: lengthPreset,
        // opzionali (passali solo se definiti)
        ...(prevUpstream?.retriever       !== undefined ? { retriever:       prevUpstream.retriever }       : {}),
        ...(prevUpstream?.retriever_model !== undefined ? { retriever_model: prevUpstream.retriever_model } : {}),
        ...(prevUpstream?.k               !== undefined ? { k:               prevUpstream.k }               : {}),
        ...(prevUpstream?.max_ctx_chars   !== undefined ? { max_ctx_chars:   prevUpstream.max_ctx_chars }   : {}),
        ...(prevUpstream?.seg_words       !== undefined ? { seg_words:       prevUpstream.seg_words }       : {}),
        ...(prevUpstream?.overlap_words   !== undefined ? { overlap_words:   prevUpstream.overlap_words }   : {}),
        ...(knobs?.retriever              !== undefined ? { retriever:       knobs.retriever }              : {}),
        ...(knobs?.retriever_model        !== undefined ? { retriever_model: knobs.retriever_model }        : {}),
        ...(knobs?.k                      !== undefined ? { k:               knobs.k }                      : {}),
        ...(knobs?.max_ctx_chars          !== undefined ? { max_ctx_chars:   knobs.max_ctx_chars }          : {}),
        ...(knobs?.seg_words              !== undefined ? { seg_words:       knobs.seg_words }              : {}),
        ...(knobs?.overlap_words          !== undefined ? { overlap_words:   knobs.overlap_words }          : {}),
      };      

    // 5) POST alla VM
    let vmRes;
    try {
      vmRes = await fetch(`${REMOTE_GPU_URL}/api/regen_sections_vm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(REMOTE_API_KEY ? { "X-API-Key": REMOTE_API_KEY } : {}),
        },
        body: JSON.stringify(vmBody),
        cache: "no-store",
        // ⬇️ tieni il timeout alto (qui 12 minuti); se preferisci, rimuovi del tutto il signal
        signal: AbortSignal.timeout(12 * 60 * 1000),
      });
    } catch (e) {
      // Timeout lato client (AbortSignal / Undici)
      if (String(e?.name || "").includes("Timeout")) {
        return NextResponse.json(
          { error: "GPU service timeout", detail: "The upstream generation did not answer in time." },
          { status: 504 }
        );
      }
      throw e;
    }

    // 6) leggi risposta e gestisci errori
    const raw = await vmRes.text().catch(() => "");
    let vmData; try { vmData = raw ? JSON.parse(raw) : {}; } catch { vmData = { raw }; }

    if (!vmRes.ok) {
      console.error("[VM PARTIAL REGEN] status", vmRes.status, "detail:", vmData?.detail || vmData);
      return NextResponse.json(
        { error: "GPU service error", detail: vmData?.detail || vmData },
        { status: vmRes.status }
      );
    }

    // 7) merge sezioni:
    //    - se VM ritorna array → sostituisci tutto
    //    - se ritorna dizionario { "index": patch } → applica patch su baseSections
    let mergedSections = baseSections.slice();
    if (vmData && vmData.sections && typeof vmData.sections === "object" && !Array.isArray(vmData.sections)) {
      for (const k of Object.keys(vmData.sections)) {
        const i = Number(k);
        if (Number.isInteger(i) && i >= 0 && i < mergedSections.length) {
          mergedSections[i] = adaptSectionPatch(vmData.sections[k], mergedSections[i]);
        }
      }
    } else if (Array.isArray(vmData.sections)) {
      mergedSections = vmData.sections;
    }

    // 8) Meta: eredita + note + parent + traccia ultima partial-regen
    const mergedMeta = {
      ...(baseRev?.meta || {}),
      ...(vmData?.meta || {}),
      ...(notes ? { notes } : {}),
      ...(baseRev?.id ? { parentRevisionId: baseRev.id } : {}),
      lastPartialRegen: {
        at: new Date().toISOString(),
        targets,
        lengthPreset,
        temp,
      },
    };

    // 9) salva nuova revisione e aggiorna lo story
    const content = { sections: mergedSections };
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
      .where(eq(stories.id, s.id))
      .returning();

    return NextResponse.json(materialize(updatedStory, inserted));
  } catch (err) {
    console.error("[POST /api/regen_sections_vm] error:", err);
    return NextResponse.json(
      { error: "internal error", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}
