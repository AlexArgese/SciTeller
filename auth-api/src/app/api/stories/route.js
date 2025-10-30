// auth-api/src/app/api/stories/route.js
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, Schema } from '@/db/index.js';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const { stories, storyRevisions } = Schema;

async function getDefaultRevision(story) {
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

// 👇 helper per ricostruire se il backend vecchio non lo aveva salvato
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

function materialize(story, rev) {
  // recupero sezioni dalla revisione
  let sections = rev?.content?.sections ?? [];
  // recupero meta
  const meta = rev?.meta ?? {};

  // se l’aggregato non c’è, lo ricostruisco
  const currentAggregates =
    meta.currentAggregates ||
    meta.aggregates ||
    computeAggregatesFromSections(sections, meta);

  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    visibility: story.visibility,
    current_revision_id: story.currentRevisionId,
    persona: rev?.persona ?? null,
    // 👇 metto dentro anche gli aggregates calcolati
    meta: {
      ...meta,
      currentAggregates,
    },
    sections,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = await db
    .select()
    .from(stories)
    .where(eq(stories.userId, session.user.id))
    .orderBy(desc(stories.createdAt));

  const out = [];
  for (const s of rows) {
    const rev = await getDefaultRevision(s);
    out.push(materialize(s, rev));
  }
  return NextResponse.json(out);
}

export async function POST(req) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const title = (body.title || 'Story').toString().slice(0, 200);

  const id = randomUUID();
  const now = new Date();

  await db.insert(stories).values({
    id,
    userId: session.user.id,
    title,
    createdAt: now,
    updatedAt: now,
    visibility: 'private',
  });

  // nessuna revisione ancora
  return NextResponse.json({
    id, title, createdAt: now, updatedAt: now,
    visibility: 'private',
    current_revision_id: null,
    persona: null,
    // 👇 metto già la forma che si aspetta il frontend
    meta: {
      currentAggregates: {
        lengthLabel: "medium",
        avgTemp: 0,
        sectionsCount: 0,
      },
    },
    sections: [],
  });
}
