// auth-api/src/app/api/stories/[id]/revisions/route.js
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, Schema } from '@/db/index.js';
import { and, desc, eq } from 'drizzle-orm';

const { stories, storyRevisions } = Schema;

// stessi helper logici di /api/stories/[id]/route.js
function resolveBaseKnobs(meta = {}) {
  const up = meta.upstreamParams || {};
  const st = meta.storytellerParams || meta.storyteller_params || {};

  // ---- lengthPreset ----
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

  // ---- temp (0–1) ----
  let baseTemp =
    typeof st.temperature === "number" ? st.temperature : null;

  if (baseTemp == null && typeof up.temp === "number") {
    baseTemp = up.temp;
  }
  if (baseTemp == null && typeof meta.creativity === "number") {
    // vecchio formato: 30 → 0.3
    baseTemp = meta.creativity / 100;
  }
  if (
    baseTemp == null &&
    typeof meta.currentAggregates?.avgTemp === "number"
  ) {
    baseTemp = meta.currentAggregates.avgTemp;
  }
  if (!Number.isFinite(baseTemp)) baseTemp = 0;

  return { baseLen, baseTemp };
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

  // lunghezze effettive per ogni sezione: override > base
  const effLens = sections.map((s) =>
    String(s?.lengthPreset || baseLen || "medium").toLowerCase()
  );
  const allSame = effLens.every((l) => l === effLens[0]);
  const lengthLabel = allSame ? effLens[0] : "mix";

  // creatività effettiva per ogni sezione: override > base
  const temps = sections.map((s) =>
    typeof s?.temp === "number" ? s.temp : baseTemp
  );
  const avgTemp =
    temps.reduce((a, b) => a + b, 0) / temps.length;

  return {
    lengthLabel,
    avgTemp,
    sectionsCount: sections.length,
  };
}

export async function GET(_req, { params }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // check ownership
  const [s] = await db.select().from(stories)
    .where(and(eq(stories.id, params.id), eq(stories.userId, session.user.id)))
    .limit(1);
  if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const rows = await db.select().from(storyRevisions)
  .where(eq(storyRevisions.storyId, s.id))
  .orderBy(desc(storyRevisions.createdAt));

  const versions = rows
    .map(r => {
      const meta = r.meta || {};
      let sections = [];

      if (r.content) {
        let c = r.content;
        if (typeof c === "string") {
          try { c = JSON.parse(c); } catch { c = null; }
        }
        if (c && Array.isArray(c.sections)) {
          sections = c.sections;
        }
      } else if (Array.isArray(r.sections)) {
        sections = r.sections;
      }

      // 👇 SCARTA le revisioni completamente vuote
      if (!sections || sections.length === 0) {
        return null;
      }

      let currentAggregates = meta.currentAggregates ?? null;
      if (!currentAggregates || typeof currentAggregates !== "object") {
        currentAggregates = computeAggregatesFromSections(sections, meta);
      }

      return {
        id: r.id,
        createdAt: r.createdAt,
        persona: r.persona,
        meta: {
          ...meta,
          currentAggregates,
        },
        notes: meta?.notes || null,
      };
    })
    .filter(Boolean);   // 👈 rimuove i null

  return NextResponse.json(versions);
}
