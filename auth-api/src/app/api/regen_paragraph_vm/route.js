// FILE: auth-api/src/app/api/regen_paragraph_vm/route.js
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, Schema } from "@/db/index.js";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";

const { paragraphVariantBatches, paragraphVariants, stories, storyRevisions } = Schema;

const REMOTE_GPU_URL = (process.env.REMOTE_GPU_URL || "").replace(/\/$/, "");
const REMOTE_API_KEY = process.env.REMOTE_API_KEY || process.env.REMOTE_APIKEY || "";

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

  const rawMeta = rev?.meta ?? {};
  const currentAggregates =
    rawMeta.currentAggregates ||
    computeAggregatesFromSections(sections, rawMeta);

  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    visibility: story.visibility,
    current_revision_id: story.currentRevisionId,
    persona: rev?.persona ?? null,
    meta: { ...rawMeta, currentAggregates },
    sections,
    content: rev?.content ?? null,
    notes: rev?.notes ?? null,
  };
}

/* ----------------- idempotenza ----------------- */
function buildRequestFingerprint({
  storyId, baseRevisionId, sectionIndex, paragraphIndex, paragraphText,
  temp, top_p, lengthPreset, paraphrase, simplify, lengthOp, n
}) {
  const payload = {
    storyId, baseRevisionId, sectionIndex, paragraphIndex,
    paragraphText, temp, top_p, lengthPreset, paraphrase, simplify, lengthOp, n
  };
  const s = JSON.stringify(payload);
  return createHash("sha256").update(s).digest("hex");
}

async function findRecentRevisionByFingerprint(storyId, fingerprint) {
  if (!fingerprint) return null;
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
  const rows = await db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.storyId, storyId))
    .orderBy(desc(storyRevisions.createdAt))
    .limit(10);

  for (const r of rows) {
    const f = r?.meta?.lastParagraphEdit?.requestKey || r?.meta?.lastParagraphEdit?.fingerprint;
    if (f && f === fingerprint && new Date(r.createdAt) > twoMinutesAgo) {
      return r;
    }
  }
  return null;
}

/* -------------------- helpers contenuto -------------------- */
function splitIntoParagraphs(txt) {
  const s = (txt || "").toString().replace(/\r\n/g, "\n").trim();
  if (!s) return [];
  let parts = s.split(/\n{2,}|\r?\n\s*\r?\n/g).map(t => t.trim()).filter(Boolean);
  if (parts.length <= 1) {
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
function computeAggregatesFromSections(sections, meta = {}) {
  const up = meta?.upstreamParams || {};
  const baseLen = up.lengthPreset || "medium";
  const baseTemp = typeof up.temp === "number" ? up.temp : 0;

  if (!Array.isArray(sections) || sections.length === 0) {
    return {
      lengthLabel: baseLen,
      avgTemp: baseTemp,
      sectionsCount: 0,
    };
  }

  const effLens = sections.map(s =>
    s?.lengthPreset ? s.lengthPreset.toLowerCase() : baseLen.toLowerCase()
  );
  const allSame = effLens.every(l => l === effLens[0]);
  const lengthLabel = allSame ? effLens[0] : "mix";

  const temps = sections.map(s =>
    typeof s?.temp === "number" ? s.temp : baseTemp
  );
  const avgTemp = temps.reduce((a,b)=>a+b,0) / temps.length;

  return {
    lengthLabel,
    avgTemp,
    sectionsCount: sections.length,
  };
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
  const sectionIdVisible =
    (typeof sec?.id !== "undefined" && String(sec.id)) ||
    (typeof sec?.sectionId !== "undefined" && String(sec.sectionId)) ||
    String(sectionIndex);

  // paragrafo corrente
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
  const top_p = Number(body?.top_p ?? body?.knobs?.top_p ?? 0.9) || 0.9;
  const lengthPreset = String(body?.lengthPreset || body?.knobs?.lengthPreset || "medium");
  const paraphrase = !!body?.paraphrase;
  const simplify = !!body?.simplify;
  let lengthOp = (body?.lengthOp || "keep");
  if (lengthOp === "keep") {
    if (lengthPreset === "short") {
      lengthOp = "shorten";
    } else if (lengthPreset === "long") {
      lengthOp = "lengthen";
    }
  }
  const n = Math.max(1, Math.min(3, Number(body?.n || 1)));

  // idempotency key
  const clientKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : null;
  const fingerprint = clientKey || buildRequestFingerprint({
    storyId: s.id,
    baseRevisionId: prevRev?.id || null,
    sectionIndex,
    paragraphIndex,
    paragraphText,
    temp, top_p, lengthPreset, paraphrase, simplify, lengthOp, n
  });

  const existing = await findRecentRevisionByFingerprint(s.id, fingerprint);
  if (existing) {
    const [updatedSame] = await db
      .update(stories)
      .set({ currentRevisionId: existing.id, updatedAt: new Date() })
      .where(eq(stories.id, s.id))
      .returning();

    return NextResponse.json(
      {
        ...materialize(updatedSame, existing),
        lastParagraphVariantBatch: null,
      },
      { status: 200 }
    );
  }

  // prepara payload
  const sectionObj = normSections[sectionIndex];

  let paragraphs = Array.isArray(sectionObj?.paragraphs) && sectionObj.paragraphs.length > 0
    ? sectionObj.paragraphs.filter(Boolean)
    : splitIntoParagraphs(sectionObj?.text || sectionObj?.narrative || "");

  if (paragraphIndex >= paragraphs.length) {
    paragraphIndex = Math.max(0, paragraphs.length - 1);
  }

  const paragraphsClean = paragraphs.map((p) => {
    try {
      const o = JSON.parse(p);
      if (o && Array.isArray(o.alternatives) && o.alternatives[0]?.text) {
        return String(o.alternatives[0].text).trim();
      }
    } catch {}
    return String(p).trim();
  });

  if (!paragraphsClean.length) {
    console.error("[regen_paragraph_vm] No paragraphs to regenerate", sectionObj);
    return NextResponse.json({ error: "empty section paragraphs" }, { status: 400 });
  }

  const vmBody = {
    persona: prevRev?.persona || "General Public",
    paper_title: s?.title || "Story",
    text: paperText,
    cleaned_text: paperText,
    section: {
      title: sectionObj?.title || `Section ${sectionIndex + 1}`,
      paragraphs: paragraphsClean,
    },
    section_index: sectionIndex,
    paragraph_index: paragraphIndex,
    temperature: (temp ?? 0.3),
    temp:        (temp ?? 0.3),
    top_p:       (top_p ?? 0.9),
    n: Math.max(1, Math.min(3, Number(n || 1))),
    length_preset: lengthPreset,
    ops: {
      paraphrase,
      simplify,
      length_op: lengthOp,
    },
  };

  // ---- chiamata alla VM ----
  let allAlternatives = [];
  try {
    const res = await fetch(`${REMOTE_GPU_URL}/api/regen_paragraph_vm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(REMOTE_API_KEY ? { "X-API-Key": REMOTE_API_KEY } : {}),
      },
      body: JSON.stringify(vmBody),
      cache: "no-store",
      signal: AbortSignal.timeout(12 * 60 * 1000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[VM PARAGRAPH REGEN] failed`, res.status, detail);
      return NextResponse.json({ error: "Upstream error", detail }, { status: res.status });
    }

    const responseData = await res.json().catch(() => ({}));
    const altListRaw = Array.isArray(responseData?.alternatives)
      ? responseData.alternatives.map(a =>
          typeof a === "string" ? a.trim() : (a?.text?.trim() || "")
        )
      : [];

    const hasCJK = (s) => /[\u3400-\u9FFF]/.test(s);
    const trimToWords = (s, max = 110) => {
      const words = (s || "").split(/\s+/);
      if (words.length <= max) return s;
      const cut = words.slice(0, max).join(" ");
      const m = cut.match(/^[\s\S]*[.!?](?:\s|$)/);
      return (m ? m[0] : cut).trim();
    };

    let alts = altListRaw.filter(t => t && !hasCJK(t));
    if (!alts.length) alts = [paragraphText];
    if (String(lengthOp) === "shorten") {
      alts = alts.map(t => trimToWords(t, 40));
    }

    allAlternatives = alts;
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

  if (!allAlternatives.length) {
    allAlternatives = [paragraphText];
  }
  const maxByN = Math.max(1, Math.min(Number(n || 1), 3));
  const alternatives = allAlternatives.slice(0, maxByN);
  const effectiveN = alternatives.length;

  const batchId = randomUUID();
  await db.insert(paragraphVariantBatches).values({
    id: batchId,
    storyId: s.id,
    sectionId: sectionIdVisible,
    revisionId: prevRev?.id || null,
    sectionIndex,
    paragraphIndex,
    ops: { paraphrase, simplify, lengthOp, temp, top_p, lengthPreset, n: effectiveN },
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

  // Applica la prima alternativa
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
      temp,
      lengthPreset,
    };
  });   

  const nextContentObj = {
    ...(effContentObj && typeof effContentObj === "object" ? effContentObj : {}),
    sections: nextSections,
    markdown: undefined,
  };

  // NOTE DELL’UTENTE (stringa)
  const userNotes = (typeof body?.notes === "string" && body.notes.trim())
    ? body.notes.trim()
    : null;

  // meta merged con traccia operazione + MIRROR notes in meta.notes
  const baseMeta = prevRev?.meta || {};

  // ricalcola aggregati dopo il cambio del paragrafo
  const currentAggregates =
    baseMeta.currentAggregates ||
    computeAggregatesFromSections(nextSections, baseMeta);

  const mergedMeta = {
    ...baseMeta,
    currentAggregates,
    lastParagraphEdit: {
      at: new Date().toISOString(),
      sectionIndex,
      paragraphIndex,
      temp,
      top_p,
      lengthPreset,
      ops: { paraphrase, simplify, lengthOp },
      n: effectiveN,
      notes: userNotes || undefined,
      candidates: alternatives,
      requestKey: fingerprint,
      fingerprint,
    },
    ...(userNotes ? { notes: userNotes } : {}),
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
      // tieni anche il top-level notes (utile per vecchie UIs / audit)
      notes: userNotes || `Regenerate PARAGRAPH (${sectionObj?.title || `Section ${sectionIndex+1}`}, ¶${paragraphIndex+1}):`
        + ` ${paraphrase ? "paraphrase, " : ""}${simplify ? "simplify, " : ""}`
        + `len=${lengthPreset}, temp=${(temp ?? 0).toFixed(2)}, ${effectiveN} alt.`,
      createdAt: new Date(),
    })
    .returning();

  // aggiorna puntatore in stories
  const [updated] = await db
    .update(stories)
    .set({ currentRevisionId: inserted.id, updatedAt: new Date() })
    .where(eq(stories.id, s.id))
    .returning();

  return NextResponse.json({
    ...materialize(updated, inserted),
    lastParagraphVariantBatch: {
      id: batchId,
      sectionIndex,
      paragraphIndex,
      n: effectiveN,
      variantIds: variantRows.map(v => v.id),
    },
  }, { status: 200 });
}
