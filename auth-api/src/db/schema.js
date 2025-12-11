//auth-api/src/db/schema.js
import { pgTable, text, timestamp, primaryKey, boolean, integer, jsonb, uuid } from 'drizzle-orm/pg-core';

/** ===== Auth.js (Drizzle Adapter) ===== */
export const users = pgTable('users', {
  id: text('id').primaryKey(),                  // crypto.randomUUID()
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { withTimezone: true }),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const accounts = pgTable('accounts', {
  userId: text('user_id').notNull(),
  type: text('type').notNull(),                 // 'oauth'
  provider: text('provider').notNull(),         // 'google' | 'github'
  providerAccountId: text('provider_account_id').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: integer('expires_at'),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
}, (t) => ({
  pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
}));

// Non usata con sessionStrategy 'jwt', ma la teniamo per compatibilità adapter
export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id').notNull(),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable('verification_tokens', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.identifier, t.token] }),
}));

/** ===== App tables ===== */
export const stories = pgTable('stories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  visibility: text('visibility').notNull().default('private'),   // 'private' | 'unlisted' | 'public'
  currentRevisionId: text('current_revision_id'),                // null => default = last revision
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const storyRevisions = pgTable('story_revisions', {
  id: text('id').primaryKey(),
  storyId: text('story_id').notNull(),
  parentRevisionId: text('parent_revision_id'),
  persona: text('persona').notNull(),
  meta: jsonb('meta').notNull(),       // { docTitle, lengthPerSection, creativity, ...}
  content: jsonb('content').notNull(), // snapshot completo: { sections: [{title,narrative}, ...], ...}
  model: text('model'),
  params: jsonb('params'),
  changeSummary: text('change_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const storyShares = pgTable('story_shares', {
  id: text('id').primaryKey(),
  storyId: text('story_id').notNull(),
  shareToken: uuid('share_token').notNull().unique(),
  canEdit: boolean('can_edit').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdByUserId: text('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const paragraphVariantBatches = pgTable('paragraph_variant_batches', {
  id: text('id').primaryKey(),                      
  storyId: text('story_id').notNull(),             
  baseRevisionId: text('base_revision_id'),         
  sectionId: text('section_id').notNull(),          
  sectionIndex: integer('section_index').notNull(),   
  paragraphIndex: integer('paragraph_index').notNull(),
  opsJson: jsonb('ops_json').notNull().default({}),  
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const paragraphVariants = pgTable('paragraph_variants', {
  id: text('id').primaryKey(),                       
  batchId: text('batch_id').notNull(),              
  text: text('text').notNull(),                   
  rank: integer('rank').notNull().default(0),       
  appliedRevisionId: text('applied_revision_id'),   
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const papers = pgTable('papers', {
  id: text('id').primaryKey(),
  sourceType: text('source_type').notNull(),
  url: text('url'),
  filePath: text('file_path'),
  sha256: text('sha256'),
  doi: text('doi'),
  title: text('title'),
  firstAuthor: text('first_author'),
  titleFirstNorm: text('title_first_norm'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
