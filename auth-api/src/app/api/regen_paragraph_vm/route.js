// FILE: auth-api/src/app/api/regen_paragraph_vm/route.js
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, Schema } from "@/db/index.js";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";


const { paragraphVariantBatches, paragraphVariants, stories, storyRevisions } = Schema;

const REMOTE_GPU_URL = process.env.REMOTE_GPU_URL || "";
const REMOTE_API_KEY = process.env.REMOTE_API_KEY || "";

/* -------------------- helpers DB -------------------- */
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

function materialize(story, rev) {
  let sections = Array.isArray(rev?.sections) ? rev.sections : [];
  if ((!sections || sections.length === 0) && rev?.content) {
    let c = rev.content;
    if (typeof c === "string") {
      try { c = JSON.parse(c); } catch { c = null; }
    }
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

/* -------------------- helpers contenuto -------------------- */
function splitIntoParagraphs(txt) {
  const s = (txt || "").toString().replace(/\r\n/g, "\n").trim();
  if (!s) return [];
  // prima: prova split su paragrafi (doppio newline)
  let parts = s.split(/\n{2,}|\r?\n\s*\r?\n/g).map(t => t.trim()).filter(Boolean);
  if (parts.length <= 1) {
    // fallback: spezza per frasi
    parts = s
      .split(/([.!?])\s+(?=[A-ZÀ-ÖØ-Ý])/g)
      .reduce((acc, chunk, i, arr) => {
        if (/[.!?]/.test(chunk) && arr[i + 1]) acc.push((arr[i - 1] || "") + chunk);
        else if (i === arr.length - 1) acc.push(chunk);
        return acc;
      }, [])
      .map(t => t.trim())
      .filter(Boolean);
  }
  return parts;
}

function normalizeSectionsForParagraphs(sectionsRaw = []) {
  return (sectionsRaw || []).map((sec, i) => {
    const text =
      (typeof sec?.text === "string" && sec.text) ||
      (typeof sec?.narrative === "string" && sec.narrative) ||
      "";
    let paragraphs = Array.isArray(sec?.paragraphs) ? sec.paragraphs.filter(Boolean) : [];
    if (paragraphs.length <= 1) {
      const resplit = splitIntoParagraphs(text);
      if (resplit.length) paragraphs = resplit;
    }
    if (paragraphs.length === 0 && text) paragraphs = [text];
    return {
      ...sec,
      id: String(sec?.id ?? sec?.sectionId ?? i),
      title: sec?.title || `Section ${i + 1}`,
      paragraphs,
      text: paragraphs.join("\n\n"),
    };
  });
}

function rebuildPaperTextFromSections(sections = []) {
  return (sections || [])
    .map((s, i) => {
      const h = s?.title ? `# ${String(s.title).trim()}\n\n` : `# Section ${i + 1}\n\n`;
      const raw =
        (typeof s?.text === "string" && s.text) ||
        (typeof s?.narrative === "string" && s.narrative) ||
        (Array.isArray(s?.paragraphs) ? s.paragraphs.join("\n\n") : "");
      return (h + (raw || "")).trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

/* -------------------- POST handler -------------------- */
export async function POST(req) {
  if (!REMOTE_GPU_URL) {
    return NextResponse.json(
      { error: "GPU config error", detail: "REMOTE_GPU_URL not set" },
      { status: 503 }
    );
  }

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

  const storyId = String(body?.storyId || "");
  if (!storyId) return NextResponse.json({ error: "missing storyId" }, { status: 400 });

  const s = await loadOwnedStory(session.user.id, storyId);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // baseRevision opzionale
  let baseRev = null;
  if (body?.baseRevisionId) {
    baseRev = await loadRevisionById(s.id, String(body.baseRevisionId));
    if (!baseRev) {
      return NextResponse.json({ error: "version not found" }, { status: 404 });
    }
  }
  const prevRev = baseRev || (await getDefaultRevision(s));

  // estrai sections coerenti
  let effContentObj = null;
  if (prevRev?.content && typeof prevRev.content === "object") {
    effContentObj = prevRev.content;
  } else if (prevRev?.content && typeof prevRev.content === "string") {
    try { effContentObj = JSON.parse(prevRev.content); } catch { effContentObj = null; }
  }
  const prevSectionsRaw = Array.isArray(effContentObj?.sections)
    ? effContentObj.sections
    : (Array.isArray(prevRev?.sections) ? prevRev.sections : []);
  const normSections = normalizeSectionsForParagraphs(prevSectionsRaw);

  // mappa sectionId visibile -> indice
  const allIds = normSections.map((sec) => sec.id);
  const sectionId = String(body?.sectionId ?? "");
  let sectionIndex = -1;
  if (sectionId && allIds.includes(sectionId)) {
    sectionIndex = allIds.indexOf(sectionId);
  } else if (Number.isInteger(body?.sectionIndex)) {
    sectionIndex = Number(body.sectionIndex);
  }
  if (!(sectionIndex >= 0 && sectionIndex < normSections.length)) {
    return NextResponse.json({ error: "invalid section target" }, { status: 400 });
  }

  let paragraphIndex = Number(
    body?.paragraphIndex ?? body?.index ?? body?.paragraph_index
  );  
  const sec = normSections[sectionIndex];
  if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0 || paragraphIndex >= sec.paragraphs.length) {
    return NextResponse.json({ error: "invalid paragraph index" }, { status: 400 });
  }
  // 👉 risolvi sempre un sectionId “visibile” (stringa non nulla)
  const sectionIdVisible =
    (typeof sec?.id !== "undefined" && String(sec.id)) ||
    (typeof sec?.sectionId !== "undefined" && String(sec.sectionId)) ||
    String(sectionIndex);

  // paragrafo corrente (se arriva body.text lo preferiamo come ground-truth)
  const paragraphText =
    (typeof body?.text === "string" && body.text.trim()) ||
    sec.paragraphs[paragraphIndex] ||
    "";

  // paper text per la VM (preferisci meta.paperText)
  let paperText =
    (prevRev?.meta && typeof prevRev.meta?.paperText === "string" && prevRev.meta.paperText) ||
    (s?.meta && typeof s.meta?.paperText === "string" && s.meta.paperText) ||
    rebuildPaperTextFromSections(normSections);

  // knobs & ops
  const temp = Number(body?.temp ?? body?.knobs?.temp ?? 0.0) || 0.0;
  const top_p = Number(body?.knobs?.top_p ?? 0.9) || 0.9;
  const lengthPreset =
    String(body?.lengthPreset || body?.knobs?.lengthPreset || "medium");
  const paraphrase = !!body?.paraphrase;
  const simplify = !!body?.simplify;
  const lengthOp = (body?.lengthOp || "keep"); // keep | shorten | lengthen
  const n = Math.max(1, Math.min(3, Number(body?.n || 1)));

  // payload verso GPU-backend
  const vmBody = {
    persona: prevRev?.persona || "General Public",
    paper_title: s?.title || "Story",
    cleaned_text: paperText,
    section_index: sectionIndex,
    paragraph_index: paragraphIndex,
    paragraph_text: paragraphText,
    ops: {
      paraphrase,
      simplify,
      length_op: lengthOp,
      temperature: temp,
      top_p,
      n,
      length_preset: lengthPreset,
    },
  };

  // 5) POST alla VM
  let vmRes;
  try {
    const REMOTE_GPU_URL = (process.env.REMOTE_GPU_URL || "").replace(/\/$/, "");
    if (!REMOTE_GPU_URL) {
    return NextResponse.json({ error: "GPU URL not configured" }, { status: 503 });
    }

    const section = normSections[sectionIndex];

    let paragraphs = [];
    if (Array.isArray(section?.paragraphs) && section.paragraphs.length > 0) {
        paragraphs = section.paragraphs.filter(Boolean);
    } else {
        paragraphs = splitIntoParagraphs(section?.text || section?.narrative || "");
    }

    // se l'indice richiesto è fuori range, rientra forzatamente
    if (paragraphIndex >= paragraphs.length) {
        paragraphIndex = Math.max(0, paragraphs.length - 1);
    }


    if (!paragraphs.length) {
        return NextResponse.json({ error: "empty section paragraphs" }, { status: 400 });
    }

    console.log("🚨 DEBUG PARAGRAPH REGEN", {
        section_index: sectionIndex,
        paragraph_index: paragraphIndex,
        paragraphs_count: paragraphs.length,
        first_paragraph: paragraphs[0]?.slice(0, 60),
      });

    vmRes = await fetch(`${REMOTE_GPU_URL.replace(/\/$/, '')}/api/regen_paragraph_vm`, {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        ...(REMOTE_API_KEY ? { "X-API-Key": REMOTE_API_KEY } : {}),
    },
    body: JSON.stringify({
        persona: prevRev?.persona || "General Public",
        paper_title: s?.title || "Story",
        text: paperText,  
        section: {
            title: section?.title || `Section ${sectionIndex + 1}`,
            paragraphs,
        },
        section_index: sectionIndex,
        paragraph_index: paragraphIndex,
        ops: {
            paraphrase,
            simplify,
            length_op: lengthOp,
        },
        temperature: temp,
        top_p,
        n,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(12 * 60 * 1000),
    });
  } catch (e) {
    if (String(e?.name || "").includes("Timeout")) {
      return NextResponse.json(
        { error: "GPU service timeout", detail: "The upstream generation did not answer in time." },
        { status: 504 }
      );
    }
    console.error("[POST /api/regen_paragraph_vm] fetch error:", e);
    return NextResponse.json({ error: "Upstream error", detail: String(e?.message || e) }, { status: 502 });
  }

  if (!vmRes.ok) {
    let detail = "";
    try { detail = await vmRes.text(); } catch {}
    console.error("[VM PARAGRAPH REGEN] status", vmRes.status, "detail:", detail || "(no body)");
    const status = vmRes.status === 422 ? 422 : 502;
    return NextResponse.json(
      { error: "GPU service error", detail: detail || `HTTP ${vmRes.status}` },
      { status }
    );
  }

  const vmData = await vmRes.json().catch(() => ({}));
  const alternatives = Array.isArray(vmData?.alternatives)
    ? vmData.alternatives
        .map((t) =>
          typeof t === "string"
            ? t.trim()
            : (t && typeof t.text === "string" ? t.text.trim() : "")
        )
        .filter(Boolean)
    : [];

    const batchId = randomUUID();
    
    await db.insert(paragraphVariantBatches).values({
        id: batchId,
        storyId: s.id,
        sectionId: sectionIdVisible,     
        revisionId: prevRev?.id || null,
        sectionIndex,
        paragraphIndex,
        ops: { paraphrase, simplify, lengthOp, temp, top_p, lengthPreset, n },
        createdAt: new Date(),
    });

    const variantRows = alternatives.map((text, i) => ({
    id: randomUUID(),
    batchId,
    rank: i,       
    text,
    createdAt: new Date(),
    }));
    await db.insert(paragraphVariants).values(variantRows);

  // Applica la prima alternativa come scelta di default (commit immediato)
  const chosen = alternatives[0] || paragraphText;

  // costruisci nuove sections
  const nextSections = normSections.map((secItem, i) => {
    if (i !== sectionIndex) return secItem;
    const nextParas = [...secItem.paragraphs];
    nextParas[paragraphIndex] = chosen;
    return {
      ...secItem,
      paragraphs: nextParas,
      text: nextParas.join("\n\n"),
    };
  });

  // next content JSONB coerente
  const nextContentObj = {
    ...(effContentObj && typeof effContentObj === "object" ? effContentObj : {}),
    sections: nextSections,
    markdown: undefined, // opzionale; lo omettiamo
  };

  // meta merged con traccia dell'operazione
  const mergedMeta = {
    ...(prevRev?.meta || {}),
    lastParagraphEdit: {
      at: new Date().toISOString(),
      sectionIndex,
      paragraphIndex,
      temp,
      top_p,
      lengthPreset,
      ops: { paraphrase, simplify, lengthOp },
      n,
      notes: typeof body?.notes === "string" ? body.notes : undefined,
      candidates: alternatives.slice(0, 3),
    },
  };

  // inserisci nuova revisione
  const [inserted] = await db
    .insert(storyRevisions)
    .values({
      id: randomUUID(),
      storyId: s.id,
      content: nextContentObj,
      persona: prevRev?.persona || "General Public",
      meta: mergedMeta,
      createdAt: new Date(),
    })
    .returning();

  // aggiorna puntatore in stories
  const [updated] = await db
    .update(stories)
    .set({ currentRevisionId: inserted.id, updatedAt: new Date() })
    .where(eq(stories.id, s.id))
    .returning();

  // risposta compatibile con UI (materializzata)
  return NextResponse.json({
    ...materialize(updated, inserted),
    lastParagraphVariantBatch: {
      id: batchId,
      sectionIndex,
      paragraphIndex,
      n: alternatives.length,
      variantIds: variantRows.map(v => v.id),
    },
  }, { status: 200 });  
}
