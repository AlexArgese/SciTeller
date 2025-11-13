// FILE: AIScientistStoryteller/src/components/StoryView.jsx
import { useMemo } from "react";
import styles from "./StoryView.module.css";
import Lottie from "lottie-react";
import animationData from "../assets/data.json";

function splitIntoParagraphs(txt) {
  if (!txt) return [];
  const clean = normalizeStoryText(txt);
  let parts = clean.split(/\n{2,}|\r?\n\s*\r?\n/g);
  if (parts.length === 1) {
    const chunks = clean.split(/([.!?])\s+(?=[A-ZÀ-ÖØ-Ý])/g);
    parts = chunks.reduce((acc, chunk, i, arr) => {
      if (/[.!?]/.test(chunk) && arr[i + 1]) acc.push((arr[i - 1] || "") + chunk);
      else if (i === arr.length - 1) acc.push(chunk);
      return acc;
    }, []);
  }
  return parts.map(s => s.trim()).filter(Boolean);
}
function tryParseObject(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function looksEscapedJson(str) {
  return /^\s*\{\s*\\?"title\\?"\s*:/.test(str) || /^\s*\\?\{\\?"title\\?"/.test(str);
}

/**
 * Estrae SOLO il campo `text` se `raw` contiene un wrapper tipo
 * {"title":"...","text":"..."} oppure la stessa cosa escape-ata con backslash.
 * Altrimenti ritorna `raw` com'è (ripulito).
 */
function stripJsonLikeWrapper(raw) {
  if (raw == null) return "";
  let t = String(raw).trim();

  // 0) se è già un oggetto serialized standard
  const obj0 = tryParseObject(t);
  if (obj0 && typeof obj0.text === "string") return obj0.text;

  // 1) se è un JSON escape-ato (es. con \" e \\n)
  if (looksEscapedJson(t)) {
    // unescape singolo giro e riprova il parse
    const once = t
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, "\"")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\t/g, "\t");
    const obj1 = tryParseObject(once);
    if (obj1 && typeof obj1.text === "string") return obj1.text;

    // 2) fallback regex: prendi tutto dopo text":" fino alla prossima " non-escapata
    const m = once.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/s);
    if (m) {
      return m[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\")
        .trim();
    }
  }

  // 3) altro fallback: pattern non-escapato
  const m2 = t.match(/^\s*\{\s*"title"\s*:\s*".*?",\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}\s*$/s);
  if (m2) {
    return m2[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
      .trim();
  }

  // 4) pulizia leggera se arrivano virgolette spurie all'inizio/fine
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("“") && t.endsWith("”"))) {
    t = t.slice(1, -1);
  }
  return t;
}

function normalizeStoryText(txt) {
  let s = String(txt ?? "");
  s = s.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
  s = s.replace(/？/g, "?"); // question mark pieno → ASCII
  return s.trim();
}

// ★ helper per capire qual è la revisione della story che stiamo mostrando
function getStoryRevisionId(story) {
  return (
    story?.current_revision_id ||
    story?.revisionId ||
    story?.defaultVersionId ||
    null
  );
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
  onReadOnPaper = () => {},
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

  // ★ la revisione della story che sto mostrando ORA
  const currentStoryRevisionId = getStoryRevisionId(story);

  const sections = useMemo(() => {
    const src = Array.isArray(story.sections) ? story.sections : [];
  
    return src
      .filter(s => s?.visible !== false)
      .map((s, i) => {
        const id = String(s.id ?? s.sectionId ?? i);
  
        // narrative > text, poi unwrap aggressivo
        const rawText =
          (typeof s.narrative === "string" && s.narrative.trim()) ||
          (typeof s.text === "string" && s.text.trim()) ||
          "";
  
        const unwrapped = stripJsonLikeWrapper(rawText);
        const paragraphs = splitIntoParagraphs(unwrapped);
  
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

  // ★ se il paragrafo selezionato è stato cliccato in una revisione diversa → non mostrare carosello
  const selectedParagraphRevisionId =
    selectedParagraph?.clickedRevisionId ?? null;

  const isSameRevisionAsParagraph =
    !selectedParagraphRevisionId ||
    !currentStoryRevisionId
      ? true
      : String(selectedParagraphRevisionId) === String(currentStoryRevisionId);

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
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span style={{ flex: "1 1 auto" }}>{sec.title}</span>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();          // non far “selezionare” la sezione
                  onReadOnPaper?.({ sectionId: sec.id });
                }}
                title="Read this section on paper"
                aria-label="Read this section on paper"
                style={{
                  flex: "0 0 auto",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  cursor: "pointer",
                }}
              >
                <PaperIcon />
              </button>
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

                  // ★ QUI: il carosello si vede SOLO se
                  // - il paragrafo è selezionato
                  // - ci sono varianti
                  // - la revisione del paragrafo è la stessa della story che sto mostrando
                  const showInlineCarousel =
                    isSel &&
                    isSameRevisionAsParagraph &&
                    Array.isArray(variants) &&
                    variants.length > 0;

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
                          title={
                            isSel && !isSameRevisionAsParagraph
                              ? "This paragraph belongs to an older revision. Regenerate it to get new alternatives."
                              : "Click to modify or view alternatives"
                          }
                        >
                          {effectiveText}
                          {isSel && !isSameRevisionAsParagraph && (
                            <span
                              style={{
                                display: "inline-block",
                                marginLeft: 8,
                                fontSize: "0.70rem",
                                color: "#b72b2b",
                              }}
                            >
                              (old revision)
                            </span>
                          )}
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
                onApplyPersist(index);
              } else {
                onApply?.();
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

function PaperIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
    >
      <path
        d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5L14 2zm0 1.5L18.5 8H14V3.5zM8 11h8v1.5H8V11zm0 3h8v1.5H8V14zm0 3h6v1.5H8V17z"
        fill="currentColor"
      />
    </svg>
  );
}
