CREATE TABLE IF NOT EXISTS "papers" (
  "id" text PRIMARY KEY NOT NULL,
  "source_type" text NOT NULL,
  "url" text,
  "file_path" text,
  "sha256" text,
  "doi" text,
  "title" text,
  "first_author" text,
  "title_first_norm" text,
  "created_at" timestamp with time zone DEFAULT now()
);
ALTER TABLE "papers"
  ADD CONSTRAINT papers_source_type_check
  CHECK (source_type = ANY (ARRAY['upload'::text, 'link'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS papers_doi_uq
  ON "papers" (lower(doi))
  WHERE doi IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS papers_sha256_uq
  ON "papers" (sha256)
  WHERE sha256 IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS papers_title_first_uq
  ON "papers" (title_first_norm)
  WHERE title_first_norm IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS papers_url_uq
  ON "papers" (lower(url))
  WHERE url IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paragraph_variant_batches" (
  "id" text PRIMARY KEY NOT NULL,
  "story_id" text NOT NULL,
  "base_revision_id" text,
  "section_id" text NOT NULL,
  "section_index" integer NOT NULL,
  "paragraph_index" integer NOT NULL,
  "ops_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paragraph_variants" (
  "id" text PRIMARY KEY NOT NULL,
  "batch_id" text NOT NULL,
  "text" text NOT NULL,
  "rank" integer DEFAULT 0 NOT NULL,
  "applied_revision_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
