// FILE: src/pages/Reader.jsx
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import PdfViewer from "../components/PdfViewer.jsx";
import StoryView from "../components/StoryView.jsx";
import { getStory } from "../services/storiesApi.js";
import s from "./Reader.module.css";

const DEBUG_READER = true;
export const API_BASE = import.meta.env.VITE_API_BASE || "/svc";

export default function Reader() {
  const nav = useNavigate();
  const { state } = useLocation() || {};

  const storyId      = state?.storyId ?? null;
  const sectionIndex = Number(state?.sectionIndex ?? 0);
  const rawPdfUrl    = state?.pdfUrl ?? state?.url ?? null;

  const pdfUrl = rawPdfUrl && rawPdfUrl.startsWith("/api/")
    ? `${API_BASE}${rawPdfUrl}`
    : rawPdfUrl;

  const initialPage = Number(state?.initialPage ?? 1);
  const initialHL   = Array.isArray(state?.highlights) ? state.highlights : [];
  const altHighlights = Array.isArray(state?.altHighlights) ? state.altHighlights : [];
  const locateMeta  = state?.locateMeta || null;

  const [story, setStory] = useState(null);
  const [loading, setLoading] = useState(true);

  // Normalizza in formato: [{ page, rects: [[x1,y1,x2,y2], ...] }]
  const normalizedHighlights = useMemo(() => {
    if (Array.isArray(initialHL) && initialHL[0] && "rects" in (initialHL[0] || {})) {
      return initialHL;
    }
    if (Array.isArray(initialHL) && initialHL[0] && ("x" in (initialHL[0] || {}))) {
      const rects = initialHL.map(r => [r.x, r.y, r.x + r.w, r.y + r.h]);
      return [{ page: initialPage, rects }];
    }
    return [];
  }, [initialHL, initialPage]);

  // Tutti i match (best + alternativi) che passeremo al PdfViewer
  const matches = useMemo(() => {
    const best = normalizedHighlights?.[0]
      ? [normalizedHighlights[0]]
      : [{ page: initialPage, rects: [] }];

    const alts = (altHighlights || [])
      .filter(m => m && typeof m.page === "number" && Array.isArray(m.rects))
      .map(m => ({ page: Number(m.page), rects: m.rects }));

    return [...best, ...alts];
  }, [normalizedHighlights, altHighlights, initialPage]);

  if (DEBUG_READER) {
    console.groupCollapsed("[Reader] state from navigate");
    console.log("storyId:", storyId);
    console.log("sectionIndex:", sectionIndex);
    console.log("pdfUrl:", pdfUrl);
    console.log("initialPage:", initialPage);
    console.log("initialHL (raw):", initialHL);
    console.log("normalizedHighlights:", normalizedHighlights);
    console.log("altHighlights:", altHighlights);
    console.log("matches:", matches);
    console.log("locateMeta:", locateMeta);
    console.groupEnd();
  }

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

  const firstMatchPage = matches[0]?.page || initialPage;

  return (
    <div className={s.page}>
      <div className={s.left}>
        <div className={s.viewerCard}>
          <div className={s.viewerHead}>
            <button onClick={() => nav(-1)} className={s.backBtn}>← Back</button>
            <div className={s.pdfTag}>PDF</div>
            {/* info minimale sui match */}
            <div className={s.matchInfo}>
              {matches.length > 0 && (
                <span>
                  {matches.length} match
                  {matches.length > 1 ? "es" : ""} found
                  {locateMeta?.score != null && (
                    <> · best score {Number(locateMeta.score).toFixed(3)}</>
                  )}
                </span>
              )}
            </div>
          </div>

          <div className={s.viewerBody}>
            <PdfViewer
              url={pdfUrl}
              page={firstMatchPage}
              scale={1.15}
              highlights={matches}
              onError={() => {}}
              showMatchesList={true}   // lista laterale con TUTTI i match
            />
          </div>
        </div>
      </div>

      <div className={s.right}>
        {loading && <div style={{ opacity: .7 }}>Loading…</div>}
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
