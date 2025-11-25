// FILE: src/components/PdfViewer.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";

const DEBUG_PDF = true;

// ✅ worker .js
import workerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
GlobalWorkerOptions.workerSrc = workerUrl;

/* ───────── helpers ───────── */

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function toXYWH(rect) {
  // Caso 1: array [x1,y1,x2,y2] in coordinate normalizzate PDF (origine in basso)
  if (Array.isArray(rect) && rect.length >= 4) {
    let [x1, y1, x2, y2] = rect.map(clamp01);

    // assicuriamoci che x1<x2, y1<y2
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];

    const w = Math.max(0, x2 - x1);
    const h = Math.max(0, y2 - y1);

    // ⚠️ docparse usa origine in basso: facciamo flip su Y
    // y_top (canvas) = 1 - y2
    const yTop = 1 - y2;

    return { x: x1, y: yTop, w, h };
  }

  // Caso 2: oggetto {x,y,w,h} già in top-left normalizzato (come usato altrove)
  if (rect && typeof rect === "object") {
    return {
      x: clamp01(rect.x),
      y: clamp01(rect.y),
      w: clamp01(rect.w),
      h: clamp01(rect.h),
    };
  }

  return { x: 0, y: 0, w: 0, h: 0 };
}

function mapRectToCanvas(r, viewport) {
  const { x, y, w, h } = toXYWH(r);
  return {
    x: x * viewport.width,
    y: y * viewport.height, // origine top-left
    w: w * viewport.width,
    h: h * viewport.height,
  };
}

if (!window.__PDFVIEWER_BEACON__) {
  window.__PDFVIEWER_BEACON__ = "top-left-origin";
  console.info("[PdfViewer] loaded (origin=top-left, no Y flip)");
}

/* ───────── component ───────── */

export default function PdfViewer({
  url,
  page: controlledPage = null,      // pagina iniziale
  scale = null,                      // se null → fit-to-width
  highlights = [],                   // [{page, rects:[[x1,y1,x2,y2],...], label?, score?}, ...]
  autoScroll = true,
  onError = () => {},
  showMatchesList = true,
}) {
  const outerRef = useRef(null);
  const containerRef = useRef(null);
  const pdfRef = useRef(null);
  const pageCanvasesRef = useRef({});          // { [p]: <canvas> }
  const pageViewportCache = useRef({});        // { [p]: viewport }
  const renderTasksRef = useRef({});           // { [p]: renderTask }
  const pageVersionRef = useRef({});           // { [p]: version counter }  ⟵ FIX qui
  const resizeObsRef = useRef(null);

  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);

    // Normalizza URL: se è remoto, passa dal proxy backend per evitare CORS
    const resolvedUrl = useMemo(() => {
      if (!url) return null;
  
      const isAbsoluteHttp = /^https?:\/\//i.test(url);
      const isBackend = url.startsWith("/svc/") || url.startsWith("/api/");
  
      // se è un link esterno (es. https://papers.miccai.org/...), usa il proxy
      if (isAbsoluteHttp && !isBackend) {
        return `/svc/api/pdf-proxy?url=${encodeURIComponent(url)}`;
      }
  
      // se è un URL del tuo backend, usalo diretto
      return url;
    }, [url]);
  

  /* ─── normalize highlights per pagina ─── */

  const perPageRects = useMemo(() => {
    const map = new Map(); // p -> array di bbox([x1,y1,x2,y2])
    const add = (p, rectArray) => {
      const list = map.get(p) || [];
      rectArray.forEach((r) => list.push(r));
      map.set(p, list);
    };

    if (Array.isArray(highlights) && highlights.length) {
      if ("rects" in (highlights[0] || {})) {
        highlights.forEach((h) => {
          const p = Number(h.page || 1);
          if (Array.isArray(h.rects) && h.rects.length) add(p, h.rects);
        });
      } else if ("x" in (highlights[0] || {})) {
        // vecchio formato {x,y,w,h} → pagina 1
        add(
          1,
          highlights.map((r) => [r.x, r.y, r.x + r.w, r.y + r.h])
        );
      }
    }
    return map;
  }, [highlights]);

  useEffect(() => {
    if (!controlledPage) return;
    setCurrentPage(controlledPage);
    scrollToPage(controlledPage, { behavior: "auto" });
    renderOnePage(controlledPage);
  }, [controlledPage]);

  const matchesList = useMemo(() => {
    const items = [];
    if (Array.isArray(highlights) && highlights.length && "rects" in (highlights[0] || {})) {
      highlights.forEach((h, i) => {
        (h.rects || []).forEach((r, k) => {
          items.push({
            key: `${i}:${k}`,
            page: Number(h.page || 1),
            rect: r,
            score: typeof h.score === "number" ? h.score : null,
          });
        });
      });
    }
  
    // 🔽 Ordina per score decrescente, poi per pagina
    items.sort((a, b) => {
      const sa = typeof a.score === "number" ? a.score : -Infinity;
      const sb = typeof b.score === "number" ? b.score : -Infinity;
      if (sa === sb) return a.page - b.page;
      return sb - sa;
    });
  
    return items;
  }, [highlights]);
  

  /* ─── load PDF ─── */

  useEffect(() => {
    let canceled = false;
    (async () => {
      if (!resolvedUrl) return;
      setIsLoading(true);

      try {
        const loadingTask = getDocument({ url: resolvedUrl });
        const pdf = await loadingTask.promise;
        if (canceled) return;
        pdfRef.current = pdf;
        setNumPages(pdf.numPages);

        await renderAllPages();

        const startPage = controlledPage || firstMatchPage(perPageRects) || 1;
        setCurrentPage(startPage);
        if (autoScroll) scrollToPage(startPage, { behavior: "auto" });
      } catch (e) {
        console.error("[PdfViewer] load error:", e);
        onError?.(e);
      } finally {
        if (!canceled) setIsLoading(false);
      }
    })();

    return () => {
      canceled = true;
      try {
        Object.values(renderTasksRef.current).forEach((t) => t?.cancel?.());
      } catch {}
      (async () => {
        try { await pdfRef.current?.destroy?.(); } catch {}
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedUrl]);

  // Re-render tutte le pagine quando cambiano gli highlights o la scala
  useEffect(() => {
    if (!pdfRef.current) return;
    renderAllPages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, highlights]);

  // ResizeObserver per fit-to-width
  useEffect(() => {
    if (!containerRef.current || scale) return;
    const ro = new ResizeObserver(() => renderAllPages());
    ro.observe(containerRef.current);
    resizeObsRef.current = ro;
    return () => { try { ro.disconnect(); } catch {} };
  }, [scale]);

  /* ─── render ─── */

  async function renderOnePage(p) {
    const pdf = pdfRef.current;
    const container = containerRef.current;
    if (!pdf || !container) return;

    // versione per-pagina (non invalida le altre)  ⟵ FIX
    const v = (pageVersionRef.current[p] = (pageVersionRef.current[p] || 0) + 1);

    // assicurati che il canvas esista
    const canvas = pageCanvasesRef.current[p];
    if (!canvas) return;

    // cancella eventuale render precedente della stessa pagina
    try { await renderTasksRef.current[p]?.cancel?.(); } catch {}
    renderTasksRef.current[p] = null;

    const pdfPage = await pdf.getPage(p);
    if (v !== pageVersionRef.current[p]) return;

    const unscaled = pdfPage.getViewport({ scale: 1 });
    const effScale = Number(scale) > 0 ? Number(scale) : (container.clientWidth / unscaled.width);
    const dpr = window.devicePixelRatio || 1;

    const viewport = pdfPage.getViewport({ scale: effScale });
    pageViewportCache.current[p] = viewport;

    const ctx = canvas.getContext("2d");
    // HiDPI: dimensioni reali * dpr
    canvas.width  = Math.ceil(viewport.width  * dpr);
    canvas.height = Math.ceil(viewport.height * dpr);
    canvas.style.width  = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    const task = pdfPage.render({ canvasContext: ctx, viewport });
    renderTasksRef.current[p] = task;
    await task.promise.catch(() => {});
    if (v !== pageVersionRef.current[p]) return;

    const rectsRaw = perPageRects.get(p) || [];
    const rects = rectsRaw.map((r) => mapRectToCanvas(r, viewport));

    // fill + stroke evidenziazioni
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = "#ffe200";
    rects.forEach((r) => ctx.fillRect(r.x, r.y, r.w, r.h));
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = "#ffc400";
    ctx.lineWidth = 2;
    rects.forEach((r) => ctx.strokeRect(r.x, r.y, r.w, r.h));
    ctx.restore();

    if (DEBUG_PDF && rectsRaw.length) {
      const vp = { w: viewport.width, h: viewport.height };
      console.groupCollapsed(`[PdfViewer] page ${p} rects (${rects.length})`);
      rects.forEach((r, i) => {
        const area = ((r.w * r.h) / (vp.w * vp.h) * 100).toFixed(1);
        console.log(i, r, "area %:", area);
      });
      console.groupEnd();
    }
  }

  async function renderAllPages() {
    const pdf = pdfRef.current;
    if (!pdf) return;
    for (let p = 1; p <= pdf.numPages; p++) {
      // render sequenziale ma senza invalidarsi a vicenda
      await renderOnePage(p);
    }
  }

  /* ─── navigation ─── */

  function firstMatchPage(map) {
    for (const [p, rects] of map.entries()) {
      if (rects.length) return p;
    }
    return null;
  }

  function scrollToPage(p, { behavior = "smooth" } = {}) {
    const cont = containerRef.current;
    const el = document.getElementById(`pdf-page-${p}`);
    if (!cont || !el) return;
    const top = el.offsetTop - 24;
    cont.scrollTo({ top, behavior });
  }

  function jumpToMatch(item) {
    const p = Number(item.page || 1);
    setCurrentPage(p);
    renderOnePage(p);        // assicura highlights aggiornati
    scrollToPage(p);
  }

  const hasPrev = currentPage > 1;
  const hasNext = currentPage < numPages;

  /* ─── UI ─── */

  return (
    <div
      ref={outerRef}
      style={{
        display: "grid",
        gridTemplateColumns: showMatchesList ? "1fr 260px" : "1fr",
        gap: 12,
        width: "100%",
      }}
    >
      {/* Viewer */}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            background: "#f6f7fb",
            borderRadius: 10,
            marginBottom: 8,
          }}
        >
          <button
            disabled={!hasPrev}
            onClick={() => {
              const p = Math.max(1, currentPage - 1);
              setCurrentPage(p);
              scrollToPage(p);
            }}
          >
            ‹
          </button>

          <div style={{ flex: 1, textAlign: "center" }}>
            {isLoading ? "Loading…" : `Page ${currentPage} / ${numPages || "?"}`}
          </div>

          <button
            disabled={!hasNext}
            onClick={() => {
              const p = Math.min(numPages, currentPage + 1);
              setCurrentPage(p);
              scrollToPage(p);
            }}
          >
            ›
          </button>
        </div>

        {/* Pagine */}
        <div
          ref={containerRef}
          style={{
            width: "100%",
            overflow: "auto",
            border: "1px solid #ececec",
            borderRadius: 10,
            padding: 10,
            background: "#fff",
            maxHeight: "80vh",
          }}
        >
          {Array.from({ length: numPages || 0 }, (_, i) => {
            const p = i + 1;
            return (
              <div id={`pdf-page-${p}`} key={p} style={{ marginBottom: 16 }}>
                <canvas
                  ref={(el) => {
                    if (el) {
                      pageCanvasesRef.current[p] = el;
                      renderOnePage(p);
                    } else {
                      delete pageCanvasesRef.current[p];
                    }
                  }}
                  style={{
                    width: "100%",
                    borderRadius: 8,
                    boxShadow: "0 1px 2px rgba(0,0,0,.04)",
                    display: "block",
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Sidebar matches */}
      {showMatchesList && (
        <aside
          style={{
            border: "1px solid #ececec",
            borderRadius: 10,
            padding: 10,
            background: "#fff",
            maxHeight: "80vh",
            overflow: "auto",
          }}
        >
          <h4>Matches ({matchesList.length})</h4>
          {matchesList.map((m, i) => (
            <button
              key={m.key || i}
              onClick={() => jumpToMatch(m)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                marginBottom: 8,
                borderRadius: 8,
                background: m.page === currentPage ? "#f6f9ff" : "#fff",
                border: "1px solid #eee",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {`Match ${i + 1}`}
              </div>
              <div style={{ fontSize: 12, color: "#666" }}>
                Page {m.page}
                {typeof m.score === "number"
                  ? ` • Score ${m.score.toFixed(3)}`
                  : ""}
              </div>
            </button>
          ))}
        </aside>
      )}
    </div>
  );
}
