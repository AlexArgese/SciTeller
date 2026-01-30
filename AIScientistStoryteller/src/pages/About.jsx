import styles from "./About.module.css";
import { useEffect } from "react";

export default function About() {
  useEffect(() => {
    document.body.setAttribute("data-route", "about");
    return () => {
      document.body.removeAttribute("data-route");
    };
  }, []);

  return (
    <main className={styles.page}>
      {/* HERO */}
      <section className={styles.hero}>
        <h1 className={styles.title}>AI Scientist Storyteller</h1>
        <p className={styles.lead}>
          SciTeller turns research papers into clear, engaging stories tailored to different audiences
          (student, developer, journalist, policy maker, researcher…).
          It reads the PDF and writes a persona-adapted narrative you can review, edit, and
          regenerate at any level, from full story to paragraph.
        </p>
      </section>

      {/* DATASET */}
      <section className={styles.row}>
        <div className={styles.colText}>
          <h2 className={styles.h2}>The Dataset</h2>
          <p>
            The dataset couples scientific articles with public-facing stories
            that explain them. Each paper is included only if there is at least
            one human-written article (blog post, news piece, technical explainer)
            that explicitly discusses its contribution.
          </p>
          <p>
            Scientific papers are parsed from PDF into structured Markdown
            (sections, paragraphs, bounding boxes), while stories are extracted
            from HTML pages, cleaned, de-duplicated and normalised at
            paragraph level. Both sides share a unified text format so they can
            be aligned and used for training.
          </p>
          <p className={styles.bulletLike}>
            <strong>Scope:</strong> 62 scientific papers, collected across three
            domains (AI for entertainment & media, accessibility, and health) ·{" "}
            249 candidate stories · <strong>190</strong> stories retained after
            filtering for length, language, structure, human authorship and
            factual consistency.
          </p>
          <p className={styles.bulletLike}>
            <strong>Story–paper alignment:</strong> every story is segmented into
            paragraphs and aligned to the underlying paper at a coarse level
            (e.g., introduction, method, experiments, conclusion). This reveals
            how human authors reorganise scientific content into accessible
            narratives and provides supervision signals for both planning and
            storytelling.
          </p>
          <p className={styles.bulletLike}>
            <strong>Personas:</strong> eight audience profiles are derived from
            communication literature and mapped onto stories (general public,
            student, journalist, policy maker, teacher, investor, researcher &
            engineer). Missing persona–paper combinations are filled by LLM-based
            synthetic outlines under strict constraints, ensuring full coverage.
          </p>
          <p className={styles.bulletLike}>
            <strong>Final training material:</strong> 496 persona-specific
            outlines for the Splitter and 818 five-section stories (4,090 refined
            sections) for the Storyteller, each grounded in a real paper and a
            target persona.
          </p>
        </div>
        <div className={styles.colMedia}>
          <img
            src="/dataset.png"
            alt="Overview of the paper–story dataset"
            className={styles.imgBox}
          />
        </div>
      </section>

      {/* MODEL PIPELINE */}
      <section className={styles.column}>
        <div className={styles.colText}>
          <h2 className={styles.h2}>The Splitter–Storyteller Pipeline</h2>
          <p>
            SciTeller is explicitly modular. Instead of asking a single model to
            “read and tell a story” in one step, the system separates{" "}
            <em>planning</em> from <em>narration</em>. This reduces hallucinations,
            improves controllability, and makes the whole process easier to
            inspect and debug.
          </p>
          <p className={styles.bulletLike}>
            <strong>1. Document parsing & segmentation:</strong> PDFs are parsed
            into Markdown with section headings, paragraphs and page-level
            metadata. A logical hierarchy (Abstract, Introduction, Method,
            Experiments/Results, Conclusion, etc.) is reconstructed and used to
            drive retrieval and grounding.
          </p>
          <p className={styles.bulletLike}>
            <strong>2. Splitter (Qwen2.5–7B):</strong> given
            the cleaned paper text and a target persona, the Splitter produces a
            compact outline: typically 5 sections, each with a concise title and
            a 1–2 sentence description. The outline is persona-aware (what to
            emphasise, which details to surface) and constrained to remain
            faithful to the article.
          </p>
          <p className={styles.bulletLike}>
            <strong>3. Retrieval</strong> for each outline item, the system
            retrieves the most relevant paragraphs from the paper using
            similarity search over the segmented text. This keeps inputs within
            the context window and ensures that each section is grounded in a
            focused subset of the article rather than in the entire PDF.
          </p>
          <p className={styles.bulletLike}>
            <strong>4. Storyteller (Qwen2.5–32B, QLoRA 4-bit):</strong> the
            Storyteller receives the persona specification, the Splitter outline
            and the retrieved context, and generates a JSON story with 5
            sections. Each section reuses the outline title verbatim and expands
            it into 8–10 sentences of persona-adapted, grounded narrative.
          </p>
          <p className={styles.bulletLike}>
            <strong>Hallucination controls & constraints:</strong> prompts
            explicitly forbid invented datasets, numbers, institutions or author
            names; only entities present in the retrieved context are allowed.
            Additional checks penalise unsupported PERSON/ORG entities and
            repeated n-grams, and outputs must be valid JSON to be accepted by
            the platform.
          </p>
        </div>
        <div className={styles.colMedia}>
          <img
            src="/AI_scientist_pipeline.png"
            alt="High-level Splitter–Storyteller pipeline"
            style={{ marginTop: "2em" , maxWidth: "60%" }}
            className={styles.imgBox}
          />
        </div>
      </section>

      {/* EVALUATION */}
      <section className={styles.row}>
        <div className={styles.colText}>
          <h2 className={styles.h2}>Evaluation & StoryScore</h2>
          <p>
            The system is evaluated quantitatively on a held-out test set and
            qualitatively through a user study. The main automatic metric is{" "}
            <em>StoryScore</em>, a composite score specifically designed for
            scientific storytelling. It combines semantic faithfulness, coverage,
            structural fidelity, fluency and hallucination control into a single
            value in [0, 1].
          </p>

          <p className={styles.bulletLike} style={{ marginLeft: "1em" }}>
            <strong>BERTScore:</strong> measures semantic similarity between the
            generated story and the source paper using contextual embeddings. It
            captures whether the main ideas are preserved even when the style or
            persona changes.
          </p>
          <p className={styles.bulletLike} style={{ marginLeft: "1em" }}>
            <strong>Context Recall:</strong> token-level recall between story and
            paper, used as a proxy for factual coverage (how much of the paper’s
            vocabulary and key terms appear in the story).
          </p>
          <p className={styles.bulletLike} style={{ marginLeft: "1em" }}>
            <strong>Title Coverage & JSON validity:</strong> checks that the 5
            generated section titles exactly match the Splitter outline and that
            the output is a well-formed JSON object with the expected schema.
          </p>
          <p className={styles.bulletLike} style={{ marginLeft: "1em" }}>
            <strong>No Repetition:</strong> penalises repeated n-grams and
            looping patterns, encouraging fluent, varied text instead of
            sections that re-summarise the entire paper over and over.
          </p>
          <p className={styles.bulletLike} style={{ marginLeft: "1em" }}>
            <strong>No Hallucination:</strong> compares PERSON and ORG entities
            in the story against those in the paper; entities that only appear in
            the story are treated as hallucinations and lower the score.
          </p>
        </div>

        <div className={styles.colMedia}>
          <img
            src="/StoryScore.png"
            alt="StoryScore formula and components"
            className={styles.imgBox}
          />
        </div>
      </section>
    </main>
  );
}

