// auth-api/src/auth.js
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import crypto from 'node:crypto';
import { DrizzleAdapter } from '@auth/drizzle-adapter';

import { db } from './db/index.js';
import { users, accounts, sessions, verificationTokens } from './db/schema.js';

function ensureId(u) {
  if (u && !u.id) u.id = crypto.randomUUID();
  return u;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'jwt' },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    GitHub({
      clientId: process.env.GITHUB_ID,
      clientSecret: process.env.GITHUB_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      ensureId(user);
      return true;
    },
    async session({ session, token }) {
      if (session.user && token?.sub) session.user.id = token.sub;
      return session;
    },
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
});
