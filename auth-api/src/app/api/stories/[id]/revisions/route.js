// auth-api/src/app/api/stories/[id]/revisions/route.js
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, Schema } from '@/db/index.js';
import { and, desc, eq } from 'drizzle-orm';

const { stories, storyRevisions } = Schema;

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
  const versions = rows.map(r => ({
    id: r.id,
    createdAt: r.createdAt,
    persona: r.persona,
    meta: r.meta || {},
    notes: r.meta?.notes || null, 
  }));

  return NextResponse.json(versions);
}
