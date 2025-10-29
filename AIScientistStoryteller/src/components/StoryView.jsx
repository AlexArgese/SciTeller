// FILE: AIScientistStoryteller/src/components/StoryView.jsx
import { useMemo } from "react";
import styles from "./StoryView.module.css";
import Lottie from "lottie-react";
import animationData from "../assets/data.json";

function splitIntoParagraphs(txt) {
  if (!txt) return [];
  let clean = String(txt).replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
  let parts = clean.split(/\n{2,}|\r?\n\s*\r?\n/g);
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

export default function StoryView({
  story,
  selectedParagraph,
  selectedSectionId,
  onToggleParagraph,
  onSelectSection,
  onRegisterSectionEl,
  busySectionIds = [],
  busyParagraphKeys = [],
  variantCounts = null,
  onOpenCPForParagraph = () => {},

  // ⬇️ inline variants (ultimo batch del paragrafo selezionato)
  variants = [],
  inlineVariantIndex = 0,
  onSetInlineVariantIndex = () => {},

  // ⬇️ NUOVO: applicazioni locali, no-version
  appliedOverrides = {}, // { ["<secId>:<idx>"]: "<testo applicato>" }
  onApplyInlineVariant = () => {}, // (secId, idx, text) => void
  onPersistInlineVariant = () => {}, // ✅ VIENE DAL PARENT (Stories)
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
  const busyParaSet = useMemo(() => new Set(busyParagraphKeys || []), [busyParagraphKeys]);


  const sections = useMemo(() => {
    const src = Array.isArray(story.sections) ? story.sections : [];
  
    return src
      .filter(s => s?.visible !== false)
      .map((s, i) => {
        const id = String(s.id ?? s.sectionId ?? i);
  
        // FONTE DI VERITÀ UNICA: narrative > text
        const sourceText =
          (typeof s.narrative === "string" && s.narrative.trim()) ||
          (typeof s.text === "string" && s.text.trim()) ||
          "";
  
        // Sempre risplittare dal testo corrente
        const paragraphs = splitIntoParagraphs(sourceText);
  
        return {
          ...s,
          id,
          title: s.title || `Section ${i + 1}`,
          paragraphs: paragraphs.length ? paragraphs : ["(no text)"],
        };
      });
  }, [story, story?.revisionId, story?.updatedAt]);
  

  if (!sections.length) {
    return (
      <article>
        <h1 className={styles.title}>{storyTitle}</h1>
        <p className={styles.empty}>No section available.</p>
      </article>
    );
  }

  const sel = selectedParagraph
    ? { secId: String(selectedParagraph.sectionId), idx: Number(selectedParagraph.index) }
    : null;

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
              // Ignora click interni al carosello
              if (e.target?.closest?.(`.${styles.inlineCarousel}`)) return;
              // Ignora click sul paragrafo (gestito dal suo handler)
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
                <Lottie animationData={animationData} loop autoplay style={{ width: 120, height: 120 }} />
                <p>Generation of the entire section...</p>
              </div>
            ) : (
              <>
                {sec.paragraphs.map((p, idx) => {
                  const isSel = sel && sel.secId === sec.id && sel.idx === idx;

                  const key = `${sec.id}:${idx}`;

                  // ⬇️ se c’è un'applicazione locale, mostriamo quella
                  const effectiveText = (appliedOverrides && appliedOverrides[key]) ? appliedOverrides[key] : p;

                  const vCount = variantCounts && Number.isFinite(variantCounts[key]) ? Number(variantCounts[key]) : 0;
                  const showInlineCarousel = isSel && Array.isArray(variants) && variants.length > 0;

                  const isParaBusy = busyParaSet.has(key);
                  const pKey = `${sec.id}:${idx}:${(effectiveText || "").slice(0, 30)}`;

                  return (
                    <div key={pKey} className={styles.paragraphRow} data-section-id={sec.id} data-paragraph-index={idx}>
                      {isParaBusy ? (
                        // loader...
                        <div className={styles.paraBusyCard}>
                          <Lottie animationData={animationData} loop autoplay style={{ width: 72, height: 72 }} />
                          <div className={styles.paraBusyText}>
                            Regenerating paragraph {idx + 1} of the section “{sec.title}”…
                          </div>
                        </div>
                      ) : !showInlineCarousel ? (
                        <p
                          className={`${styles.p} ${styles.pSelectable} ${isSel ? styles.pActive : ""}`}
                          onClick={() => onToggleParagraph?.(sec.id, idx, effectiveText)}
                          tabIndex={0}
                          aria-selected={isSel ? "true" : "false"}
                          title="Click to modify or view alternatives"
                        >
                          {effectiveText}
                        </p>
                      ) : (
                        <InlineParagraphCarousel
                          items={variants}
                          index={inlineVariantIndex}
                          onPrev={() => onSetInlineVariantIndex((inlineVariantIndex - 1 + variants.length) % variants.length)}
                          onNext={() => onSetInlineVariantIndex((inlineVariantIndex + 1) % variants.length)}
                          onClickText={(e) => {
                            e?.stopPropagation?.();
                            onToggleParagraph?.(sec.id, idx, null); // chiude il carosello
                          }}
                          onApplyPersist={(i) => {
                            // 1) applica localmente (preview immediata)
                            const chosen = variants[i];
                            const chosenText = (typeof chosen === "string") ? chosen : (chosen?.text ?? "");
                            if (chosenText) onApplyInlineVariant?.(sec.id, idx, chosenText);

                            // 2) delega il salvataggio (crea/adotta revisione)
                            onPersistInlineVariant?.(i);

                            // 3) chiudi il carosello (deseleziona)
                            onToggleParagraph?.(sec.id, idx, null);
                          }}
                        />
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

/* ─────────────────────────────
   Carosello inline minimal con frecce
   ───────────────────────────── */
   function InlineParagraphCarousel({
    items = [],
    index = 0,
    onPrev,
    onNext,
    onClickText,        // chiude il carosello (toggle paragrafo)
    onApply,            // legacy (applicazione locale)
    onApplyPersist,     // salva su backend (parent fa tutto)
  }) {
    const cur = items[index];
    const text = typeof cur === "string" ? cur : (cur?.text ?? "");
  
    return (
      <div className={styles.inlineCarousel} role="group" aria-label="Paragraph alternatives">
        <button
          className={styles.navBtnLeft}
          type="button"
          onClick={(e)=>{ e.stopPropagation(); onPrev?.(); }}
          aria-label="Previous alternative"
        >‹</button>
  
        <div
          className={styles.inlineCard}
          onClick={(e)=>{ e.stopPropagation(); onClickText?.(e); }}
          title="Click to deselect this paragraph"
        >
          <button
            type="button"
            className={styles.selectBadge}
            onClick={(e)=>{ 
              e.stopPropagation();
              if (typeof onApplyPersist === "function") {
                onApplyPersist(index);   // <-- delega al parent (nessun accesso a variantHistory qui)
              } else {
                onApply?.();             // fallback locale
              }
            }}
            aria-label="Select this alternative"
            title="Select this alternative"
          >
            ✓
          </button>
  
          <div className={styles.inlineIndex}>#{index + 1}/{items.length}</div>
          <div className={styles.inlineText}>{text}</div>
        </div>
  
        <button
          className={styles.navBtn}
          type="button"
          onClick={(e)=>{ e.stopPropagation(); onNext?.(); }}
          aria-label="Next alternative"
        >›</button>
      </div>
    );
  }  