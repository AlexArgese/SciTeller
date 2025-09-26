// auth-api/src/app/api/stories/route.js
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, Schema } from '@/db/index.js';
import { and, desc, eq } from 'drizzle-orm';

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

function materialize(story, rev) {
  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    visibility: story.visibility,
    current_revision_id: story.currentRevisionId,
    persona: rev?.persona ?? null,
    meta: rev?.meta ?? null,
    sections: rev?.content?.sections ?? [],
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

  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(stories).values({
    id,
    userId: session.user.id,
    title,
    createdAt: now,
    updatedAt: now,
  });

  // nessuna revisione ancora
  return NextResponse.json({
    id, title, createdAt: now, updatedAt: now,
    visibility: 'private',
    current_revision_id: null,
    persona: null, meta: null, sections: [],
  });
}
