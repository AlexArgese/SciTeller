// auth-api/src/app/api/stories/[id]/revisions/route.js
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, Schema } from '@/db/index.js';
import { and, desc, eq } from 'drizzle-orm';

const { stories, storyRevisions } = Schema;

// 👇 stessa funzione che abbiamo messo nell’altra route
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

  const effLens = sections.map(s => (s?.lengthPreset ? s.lengthPreset.toLowerCase() : baseLen.toLowerCase()));
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

  // minimal shape for UI timeline
  const versions = rows.map(r => {
    const meta = r.meta || {};

    // 👇 se l’aggregato NON c’è, lo proviamo a ricostruire
    let currentAggregates = meta.currentAggregates || meta.aggregates || null;

    if (!currentAggregates) {
      // le sections in questa route molto spesso NON ci sono,
      // ma proviamo a leggerle da content, se è JSON
      let sections = [];
      if (r.content) {
        let c = r.content;
        if (typeof c === "string") {
          try { c = JSON.parse(c); } catch { c = null; }
        }
        if (c && Array.isArray(c.sections)) {
          sections = c.sections;
        }
      }
      currentAggregates = computeAggregatesFromSections(sections, meta);
    }

    return {
      id: r.id,
      createdAt: r.createdAt,
      persona: r.persona,
      meta: {
        ...meta,
        currentAggregates,              // 👈 aggiunto
      },
      notes: meta?.notes || null,
    };
  });

  return NextResponse.json(versions);
}
