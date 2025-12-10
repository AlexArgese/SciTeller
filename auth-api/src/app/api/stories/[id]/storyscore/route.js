// FILE: auth-api/src/app/api/stories/[id]/storyscore/route.js

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, Schema } from "@/db/index.js";
import { and, eq, desc } from "drizzle-orm";
import { spawn } from "node:child_process";
import path from "node:path";

const { stories, storyRevisions } = Schema;

/* ============================================================
   HELPERS
   ============================================================ */

async function loadOwnedStory(userId, storyId) {
  const [s] = await db.select()
    .from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, userId)))
    .limit(1);
  return s || null;
}

async function loadCurrentRevision(story) {
  if (!story) return null;

  // 1. se c’è una currentRevisionId → usa quella
  if (story.currentRevisionId) {
    const [rev] = await db.select()
      .from(storyRevisions)
      .where(eq(storyRevisions.id, story.currentRevisionId))
      .limit(1);
    return rev || null;
  }

  // 2. altrimenti prendi la PIÙ RECENTE
  const [rev] = await db.select()
    .from(storyRevisions)
    .where(eq(storyRevisions.storyId, story.id))
    .orderBy(desc(storyRevisions.createdAt))
    .limit(1);

  return rev || null;
}

// Legge sections dalla revisione (da column "content.sections")
function extractSections(rev) {
  if (!rev) return [];
  if (Array.isArray(rev.sections)) return rev.sections;

  if (rev.content) {
    let c = rev.content;
    if (typeof c === "string") {
      try { c = JSON.parse(c); } catch { c = null; }
    }
    if (c && Array.isArray(c.sections)) return c.sections;
  }
  return [];
}

// Legge outline da meta (molto variabile nel tuo sistema)
function extractOutline(meta = {}) {
  return (
    meta.outline ||
    meta.story_outline ||
    meta.outlineFromSplitter ||
    meta.split_obj_sections ||
    []
  );
}

// Legge paperText o cleaned_text dal meta
function extractPaperText(meta = {}) {
  return (
    meta.paperText ||
    meta.cleaned_text ||
    meta.paperMarkdown ||
    meta.markdown ||
    ""
  );
}

/* ============================================================
   WRAPPER: chiama Python compute_story_score.py con spawn
   ============================================================ */

async function callBackendStoryScore(payload) {
    const BACKEND_URL = "http://backend:8000";
  
    const res = await fetch(`${BACKEND_URL}/api/storyscore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  
    if (!res.ok) {
      const t = await res.text();
      throw new Error("Backend storyscore failed: " + t);
    }
  
    return res.json();
}
  
  

/* ============================================================
   POST /api/stories/:id/storyscore
   ============================================================ */

export async function POST(req, { params }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const storyId = params?.id;
    if (!storyId) {
      return NextResponse.json({ error: "missing id" }, { status: 400 });
    }

    // 1) carica la storia
    const story = await loadOwnedStory(session.user.id, storyId);
    if (!story) return NextResponse.json({ error: "not found" }, { status: 404 });

    // 2) carica revisione attiva
    const rev = await loadCurrentRevision(story);
    if (!rev)
      return NextResponse.json({ error: "no revision" }, { status: 400 });

    // 3) estrai tutti i campi necessari
    const sections = extractSections(rev);
    const meta = rev.meta || {};

    const outline = extractOutline(meta);
    const paper_markdown = extractPaperText(meta);
    const persona = rev.persona || "General Public";
    const paper_title = story.title || meta.docTitle || "Paper";

    // 4) prepara payload per python
    const payload = {
      outline,
      sections,
      persona,
      paper_title,
      paper_markdown,
    };

    // 5) chiama Python
    const result = await callBackendStoryScore(payload);

    // 6) restituisci risultato
    return NextResponse.json(result);

  } catch (err) {
    console.error("[storyscore] ERROR:", err);
    return NextResponse.json(
      { error: "internal", detail: String(err) },
      { status: 500 }
    );
  }
}
