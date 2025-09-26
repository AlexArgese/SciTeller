import { NextResponse } from 'next/server';
import { auth } from '@/auth';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id, name, email, image } = session.user;
  return NextResponse.json({ id, name: name ?? null, email, avatar_url: image ?? null });
}
