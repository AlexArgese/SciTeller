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
            We curated a paper→story dataset to learn how scientific content is adapted for different
            readers. Sources include peer-reviewed blog posts and tech media.
            Every item links a scientific paper to multiple public-facing
            stories about that paper.
          </p>
          <p className={styles.bulletLike}>
            <strong>Scope:</strong> 62 papers · 249 stories collected · <strong>190</strong> selected after filtering.
          </p>
          <p className={styles.bulletLike}>
            <strong>Selection criteria:</strong> English; 100–3600 words; story focuses on the paper; low AI-generated
            score; near-duplicate removal via sentence-transformer embeddings; persona labels from source + LLM.
          </p>
          <p className={styles.bulletLike}>
            <strong>Enriched metadata:</strong> schema.org-aligned JSON (title, DOI, media, sections), readability
            (<code>FRES/FKGL</code> composite 0–100), structure signals (intro/method/results/conclusion), similarity
            links, persona tags, and review ratings.
          </p>
        </div>
        <div className={styles.colMedia}>
          <img src="/dataset.png" alt="Dataset overview" className={styles.imgBox} />
        </div>
      </section>

      {/* MODEL (flipped) */}
      <section className={`${styles.column}`}>
        <div className={styles.colText}>
          <h2 className={styles.h2}>The Model Pipeline</h2>
          <p>
            SciTeller uses a two-stage generation flow, orchestrated by a backend. First we
            extract clean text and sections from the PDF; then we generate an outline and write the story.
          </p>
          <p className={styles.bulletLike}>
            <strong>DocParsing → PDF to text:</strong> robust section detection and normalization (Abstract,
            Introduction, Method, Experiments/Results, Conclusion, …); token stats drive chunking.
          </p>
          <p className={styles.bulletLike}>
            <strong>Splitter (finetuend Qwen-7B):</strong> produces a concise 5 section outline (title + 1–2 sentence description),
            tailored to the chosen persona.
          </p>
          <p className={styles.bulletLike}>
            <strong>Storyteller (finetuend Qwen-32B):</strong> generates a 5-section narrative with persona-adapted tone and
            complexity, returning strict JSON. Retrieval/selection keeps inputs within token limits.
          </p>
          <p className={styles.bulletLike}>
            <strong>Hallucination controls:</strong> “no invented names/affiliations”, entity checks against paper
            context, repetition penalties, and a composite evaluation metric (StoryScore).
          </p>
        </div>
        <div className={styles.colMedia}>
          <img src="/model.png" alt="Model overview" style={{marginTop:"2em"}} />
        </div>
      </section>

      {/* EVALUATION */}
      <section className={styles.row}>
        <div className={styles.colText}>
          <h2 className={styles.h2}>Evaluation</h2>
          <p>
            The model performance was assessed through a composite metric called <em>StoryScore</em>, 
            specifically designed for scientific storytelling tasks. It combines multiple dimensions 
            of quality (from factual accuracy to narrative structure) into a single quantitative score.
          </p>
          <p className={styles.bulletLike} style={{marginLeft:'1em'}}>
            <strong>BERTScore:</strong> semantic similarity between the generated story and the paper text, 
            measured using contextual embeddings (<em>roberta-large</em>).
          </p>
          <p className={styles.bulletLike} style={{marginLeft:'1em'}}>
            <strong>Context Recall:</strong> lexical recall between tokens in the story and tokens in the paper, 
            evaluating factual coverage.
          </p>
          <p className={styles.bulletLike} style={{marginLeft:'1em'}}>
            <strong>Title Match:</strong> checks if the 5 generated section titles exactly match the outline titles.
          </p>
          <p className={styles.bulletLike} style={{marginLeft:'1em'}}>
            <strong>No Repetition:</strong> penalizes repeated n-grams to encourage fluency and narrative coherence.
          </p>
          <p className={styles.bulletLike} style={{marginLeft:'1em'}}>
            <strong>No Hallucination:</strong> penalizes entities (e.g., names, institutions) not present in the paper 
            context, ensuring factual grounding.
          </p>
          <p>
            The <em>StoryScore</em> provides a balanced measure of structural correctness, fluency, and factual alignment, 
            allowing consistent comparison across models and checkpoints.
          </p>
        </div>

        <div className={styles.colMedia}>
          <img src="/storyscore.png" alt="StoryScore formule" />
        </div>
      </section>

      {/* CREDITS */}
      <section className={styles.credits}>
        <h2 className={styles.h2}>Credits</h2>

        {/* AUTHOR */}
        <div className={styles.personBlock}>
          <div className={styles.personName}>Alex Argese</div>
            <p className={styles.personText}>
              Internship project: <em>AI Scientist Storyteller (SciTeller)</em>. Responsible for dataset
              curation, model fine-tuning (Qwen-7B / Qwen-32B), and full system development (frontend, backend, and GPU service).
            </p>
          <ul className={styles.linkList}>
            <li>
              <a href="mailto:argese@eurecom.fr" target="_blank" rel="noreferrer">
                Email
              </a>
            </li>
            <li>
              <a href="https://alexargese.github.io" target="_blank" rel="noreferrer">
                Portfolio
              </a>
            </li>
            <li>
              <a href="https://github.com/AlexArgese/ai-scientist-storyteller" target="_blank" rel="noreferrer">
                Project Repository
              </a>
            </li>
          </ul>
        </div>

        {/* SUPERVISORS */}
        <div className={styles.supervisors}>
          <div className={styles.supTitle}>Supervisors</div>
          <ul className={styles.supList}>
            <li>
              <div className={styles.supName}>Prof. Raphaël Troncy (EURECOM)</div>
              <p>Associate professor in the Department of Data Science at EURECOM</p>
              <ul className={styles.linkList}>
                <li style={{border:0}}>
                  <a
                    href="https://www.eurecom.fr/en/people/troncy-raphael"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Profile
                  </a>
                </li>
              </ul>
            </li>

            <li>
              <div className={styles.supName}>Dr. Pasquale Lisena (EURECOM)</div>
              <p>Research Fellow in the Data Science department at EURECOM</p>
              <ul className={styles.linkList}>
                <li style={{border:0}}>
                  <a
                    href="https://www.eurecom.fr/en/people/lisena-pasquale"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Profile
                  </a>
                </li>
              </ul>
            </li>

            <li>
              <div className={styles.supName}>Prof. Luigi De Russis (Politecnico di Torino)</div>
              <p>Vice Head of Department of Control and Computer Engineering and Associate Professor at Politecnico di Torino</p>
              <ul className={styles.linkList}>
                <li style={{border:0}}>
                  <a
                    href="https://www.polito.it/en/staff?p=luigi.derussis"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Profile
                  </a>
                </li>
              </ul>
            </li>
          </ul>
        </div>
        {/* INSTITUTIONS */}
        <section className={styles.institutions}>
          <h2 className={styles.h2}>Institutions</h2>

          <div className={styles.instLogos}>
            <div className={styles.logoBox}>
              <a  href='https://www.eurecom.fr/'
                  target="_blank"
                  rel="noreferrer">
                <img src="/eurecom.png" alt="EURECOM"/>
              </a>
            </div>
            <div className={styles.logoBox}>
              <a  href='https://www.polito.it/'
                    target="_blank"
                    rel="noreferrer">
                <img src="/polito.png" alt="Politecnico di Torino" />
              </a>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
