// AIScientistStoryteller/src/components/StoryView.jsx
import { useMemo } from "react";
import styles from "./StoryView.module.css";

import Lottie from "lottie-react";
import animationData from "../assets/data.json";

function splitIntoParagraphs(txt) {
  if (!txt) return [];
  let clean = String(txt).replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();

  // prima prova: split su blocchi (doppio newline)
  let parts = clean.split(/\n{2,}|\r?\n\s*\r?\n/g);

  // fallback: split “intelligente” su frasi se sembra un blob unico
  if (parts.length === 1) {
    parts = clean
      .split(/([.!?])\s+(?=[A-ZÀ-ÖØ-Ý])/g)
      .reduce((acc, chunk, i, arr) => {
        if (/[.!?]/.test(chunk) && arr[i + 1]) acc.push((arr[i - 1] || "") + chunk);
        else if (i === arr.length - 1) acc.push(chunk);
        return acc;
      }, []);
  }
  return parts.map(s => s.trim()).filter(Boolean);
}

function slugify(s, fallback = "section") {
  const base = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  return base || fallback;
}

export default function StoryView({
  story,
  selectedParagraph,
  selectedSectionId,
  onToggleParagraph,
  onSelectSection,
  onRegisterSectionEl,
  busySectionIds = [],

  // opzionale: mostra badge con numero varianti disponibili per paragrafo
  // mappa chiave `${sectionId}:${paragraphIndex}` → number
  variantCounts = null,
}) {
  if (!story) return <div className={styles.empty}></div>;

  const storyTitle =
    (story.title && !/\.pdf$/i.test(story.title)
      ? story.title
      : story.meta?.aiTitle || story.title) ||
    story.docTitle ||
    story.paper_title ||
    "Title Story";

  const busySet = useMemo(() => new Set((busySectionIds || []).map(String)), [busySectionIds]);

  // Sezioni visibili normalizzate (id, paragraphs)
  const sections = useMemo(() => {
    const src = Array.isArray(story.sections) ? story.sections : [];
    return src
      .filter(s => s?.visible !== false)
      .map((s, i) => {
        const id = String(s.id ?? s.sectionId ?? i);

        const rawText =
          (typeof s.text === "string" && s.text) ||
          (typeof s.narrative === "string" && s.narrative) ||
          "";

        const providedParas = Array.isArray(s.paragraphs)
          ? s.paragraphs.map(p => (typeof p === "string" ? p.trim() : "")).filter(Boolean)
          : [];

        // se abbiamo 0 o 1 paragrafi lunghi → prova a risplittare
        const looksLikeSingleBlob =
          providedParas.length === 1 && (providedParas[0]?.length || 0) > 280;

        const candidateText = rawText?.trim()
          ? rawText
          : providedParas.join("\n\n");

        const needResplit = providedParas.length <= 1 || looksLikeSingleBlob;
        const paragraphs = needResplit
          ? splitIntoParagraphs(candidateText)
          : providedParas;

        return {
          ...s,
          id,
          title: s.title || `Section ${i + 1}`,
          paragraphs: paragraphs.length ? paragraphs : ["(no text)"],
        };
      });
  }, [story]);

  if (!sections.length) {
    return (
      <article>
        <h1 className={styles.title}>{storyTitle}</h1>
        <p className={styles.empty}>No section available.</p>
      </article>
    );
  }

  return (
    <article>
      <h1 className={styles.title}>{storyTitle}</h1>

      {sections.map((sec) => {
        const isBusy = busySet.has(sec.id);

        return (
          <section
            key={sec.id}
            id={`section-${sec.id}`}
            data-section-id={sec.id}
            aria-busy={isBusy ? "true" : "false"}
            className={`${styles.section}`}
            style={{ position: "relative" }}
            onClick={(e) => {
              if (isBusy) return;
              // click sul vuoto della sezione → seleziona sezione
              if (e.target?.tagName?.toLowerCase() === "p") return;
              onSelectSection?.(sec.id);
            }}
            ref={(el) => { if (el) onRegisterSectionEl?.(sec.id, el); }}
          >
            <h3
              className={styles.sectionTitle}
              onClick={(e) => {
                e.stopPropagation();
                if (!isBusy) onSelectSection?.(sec.id);
              }}
            >
              {sec.title}
            </h3>

            {isBusy ? (
              <div
                style={{
                  minHeight: 140,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign:"center",
                  opacity: 0.9,
                }}
              >
                <Lottie
                  animationData={animationData}
                  loop
                  autoplay
                  style={{ width: 120, height: 120 }}
                />
                <p>Generation of the entire section...</p>
              </div>
            ) : (
              <>
                {sec.paragraphs.map((p, idx) => {
                  const isSel =
                    selectedParagraph &&
                    selectedParagraph.sectionId === sec.id &&
                    selectedParagraph.index === idx;

                  const variantKey = `${sec.id}:${idx}`;
                  const vCount =
                    variantCounts && Number.isFinite(variantCounts[variantKey])
                      ? Number(variantCounts[variantKey])
                      : 0;

                  return (
                    <div
                      key={idx}
                      className={styles.paragraphRow}
                      data-section-id={sec.id}
                      data-paragraph-index={idx}
                    >
                      <p
                        className={`${styles.p} ${styles.pSelectable} ${isSel ? styles.pActive : ""}`}
                        onClick={() => onToggleParagraph?.(sec.id, idx, p)}
                        tabIndex={0}
                        aria-selected={isSel ? "true" : "false"}
                        title="Click to select the paragraph"
                      >
                        {p}
                      </p>

                      {/* badge varianti opzionale */}
                      {vCount > 0 && (
                        <span
                          className={styles.variantBadge}
                          title={`${vCount} available alternatives`}
                          aria-label={`${vCount} available alternatives`}
                        >
                          {vCount}
                        </span>
                      )}
                    </div>
                  );
                })}

                {sec.hasImage && <div className={styles.imageBox}>Image or table</div>}
              </>
            )}
          </section>
        );
      })}
    </article>
  );
}
