// FILE: src/pages/Reader.jsx
import { useEffect, useMemo, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import PdfViewer from "../components/PdfViewer.jsx";
import StoryView from "../components/StoryView.jsx";
import { getStory } from "../services/storiesApi.js";
import s from "./Reader.module.css";
export const API_BASE = import.meta.env.VITE_API_BASE || "/svc";

export default function Reader(){
  const nav = useNavigate();
  const { state } = useLocation() || {};
  const storyId      = state?.storyId ?? null;
  const sectionIndex = Number(state?.sectionIndex ?? 0);
  const rawPdfUrl = state?.pdfUrl ?? state?.url ?? null;
  const pdfUrl = rawPdfUrl && rawPdfUrl.startsWith("/api/")
    ? `${API_BASE}${rawPdfUrl}`  
    : rawPdfUrl;

  // best match
  const initialPage    = Number(state?.initialPage ?? 1);
  const initialHL      = Array.isArray(state?.highlights) ? state.highlights : [];
  // alternative matches (opzionale)
  const altHighlights  = Array.isArray(state?.altHighlights) ? state.altHighlights : [];
  const locateMeta     = state?.locateMeta || null;

  const [story, setStory] = useState(null);
  const [loading, setLoading] = useState(true);

  // ⬇️ Stato per navigare tra i match (best + alternative)
  // Ogni match è del tipo { page, rects: [[x1,y1,x2,y2], ...] }
  const allMatches = useMemo(() => {
    const best = (initialHL?.[0] && typeof initialHL[0].page === "number")
      ? [{ page: Number(initialHL[0].page), rects: Array.isArray(initialHL[0].rects) ? initialHL[0].rects : [] }]
      : [{ page: initialPage, rects: [] }];
    const alts = (altHighlights || [])
      .filter(m => m && typeof m.page === "number" && Array.isArray(m.rects))
      .map(m => ({ page: Number(m.page), rects: m.rects }));
    return [...best, ...alts]; // indice 0 = best
  }, [initialPage, initialHL, altHighlights]);

  const [matchIndex, setMatchIndex] = useState(0);
  const currentMatch = allMatches[Math.min(Math.max(0, matchIndex), allMatches.length - 1)] || { page: initialPage, rects: [] };

  // carica la storia completa per mostrare la sezione a destra
  useEffect(() => {
    (async () => {
      if (!storyId) { setLoading(false); return; }
      try {
        const s = await getStory(storyId);
        setStory(s || null);
      } finally {
        setLoading(false);
      }
    })();
  }, [storyId]);

  // prendi solo la sezione richiesta (fallback: tutte)
  const sectionOnlyStory = useMemo(() => {
    if (!story || !Array.isArray(story.sections)) return story;
    if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= story.sections.length) return story;
    const sec = story.sections[sectionIndex];
    return { ...story, sections: [sec] };
  }, [story, sectionIndex]);

  // UI: comandi per navigare tra i match
  const canPrev = matchIndex > 0;
  const canNext = matchIndex < (allMatches.length - 1);
  const goPrev = useCallback(() => { if (canPrev) setMatchIndex(i => Math.max(0, i - 1)); }, [canPrev]);
  const goNext = useCallback(() => { if (canNext) setMatchIndex(i => Math.min(allMatches.length - 1, i + 1)); }, [canNext, allMatches.length]);

  if (!state || !pdfUrl) {
    return (
      <div className={s.missingWrap}>
        <button onClick={() => nav(-1)} className={s.missingBack}>← Back</button>
        <div className={s.missingCard}>
          Missing navigation state. Open this page via “Read section on paper”.
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.left}>
        <div className={s.viewerCard}>
          <div className={s.viewerHead}>
            <button onClick={() => nav(-1)} className={s.backBtn}>← Back</button>
            <div className={s.pdfTag}>PDF</div>

            {/* ─── Barra match/navigator ─── */}
            <div className={s.matchBar}>
              <span className={s.matchLabel}>
                Match {Math.min(matchIndex + 1, allMatches.length)} / {allMatches.length}
                {locateMeta?.score != null && matchIndex === 0 ? (
                  <span className={s.metaHint}> · score: {Number(locateMeta.score).toFixed(3)}</span>
                ) : null}
              </span>
              <div className={s.matchButtons}>
                <button
                  className={s.navBtn}
                  onClick={goPrev}
                  disabled={!canPrev}
                  title="Previous match"
                >‹</button>
                <button
                  className={s.navBtn}
                  onClick={goNext}
                  disabled={!canNext}
                  title="Next match"
                >›</button>
              </div>
              {/* pulsanti diretti per saltare a un match specifico */}
              <div className={s.dotStrip}>
                {allMatches.map((m, idx) => (
                  <button
                    key={`dot-${idx}-${m.page}`}
                    className={`${s.dotBtn} ${idx === matchIndex ? s.dotActive : ""}`}
                    title={idx === 0 ? `Best match (page ${m.page})` : `Alt ${idx} (page ${m.page})`}
                    onClick={() => setMatchIndex(idx)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className={s.viewerBody}>
            <PdfViewer
              url={pdfUrl}
              page={currentMatch.page}
              scale={1.15}
              // Il viewer accetta un array di highlights; passiamo SOLO quello corrente
              highlights={[{ page: currentMatch.page, rects: currentMatch.rects || [] }]}
              onError={() => {}}
            />
          </div>
        </div>
      </div>

      <div className={s.right}>
        {loading && <div style={{opacity:.7}}>Loading…</div>}
        {!loading && sectionOnlyStory && (
          <StoryView
            story={sectionOnlyStory}
            selectedParagraph={null}
            selectedSectionId={sectionOnlyStory?.sections?.[0]?.id ?? null}
            variants={[]}
            onToggleParagraph={() => {}}
            onSelectSection={() => {}}
            onRegisterSectionEl={() => {}}
            busySectionIds={[]}
            busyParagraphKeys={[]}
            onOpenCPForParagraph={() => {}}
            inlineVariantIndex={0}
            onSetInlineVariantIndex={() => {}}
            onPersistInlineVariant={() => {}}
            appliedOverrides={{}}
            onApplyInlineVariant={() => {}}
            variantCounts={null}
          />
        )}
      </div>
    </div>
  );
}
