// FILE: src/components/PdfViewer.jsx
import { useEffect, useRef } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";

// ✅ Usa SEMPRE il worker .js come asset (no .mjs)
import workerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
GlobalWorkerOptions.workerSrc = workerUrl;

// Converte rettangoli normalizzati (0..1) in coordinate canvas, invertendo la Y (PDF origin in basso-sx)
function mapRectToCanvas(r, viewport) {
  let x, y, w, h;
  if (Array.isArray(r)) {
    const [x1, y1, x2, y2] = r;
    x = x1; y = y1; w = (x2 - x1); h = (y2 - y1);
  } else {
    ({ x, y, w, h } = r);
  }
  const rx = x * viewport.width;
  const ry = (1 - y - h) * viewport.height; // 👈 inversione asse Y
  const rw = w * viewport.width;
  const rh = h * viewport.height;
  return { x: rx, y: ry, w: rw, h: rh };
}

export default function PdfViewer({
  url,
  page = 1,
  scale = null,           // opzionale: se passato, ignora fit-to-width
  highlights = [],        // [{x,y,w,h}] 0..1 o [{page, rects:[[x1,y1,x2,y2],...]}]
  autoScroll = true,      // porta in vista il primo highlight della pagina
  onError = () => {},     // error callback
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const pdfRef = useRef(null);
  const renderTaskRef = useRef(null);
  const resizeObsRef = useRef(null);
  const renderToken = useRef(0);

  // Carica / scarica PDF quando cambia l'URL
  useEffect(() => {
    let canceled = false;
    (async () => {
      if (!url) return;
      try {
        try { await renderTaskRef.current?.cancel(); } catch {}
        renderTaskRef.current = null;

        try { await pdfRef.current?.destroy(); } catch {}
        pdfRef.current = null;

        const loadingTask = getDocument({ url });
        const pdf = await loadingTask.promise;
        if (canceled) {
          try { await pdf?.destroy(); } catch {}
          return;
        }
        pdfRef.current = pdf;
        await renderPage(); // primo render
      } catch (e) {
        console.error("[PdfViewer] load error:", e);
        onError?.(e);
      }
    })();
    return () => {
      canceled = true;
      try { renderTaskRef.current?.cancel(); } catch {}
      renderTaskRef.current = null;
      (async () => { try { await pdfRef.current?.destroy(); } catch {} })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Rerender su page / highlights / scale
  useEffect(() => {
    if (pdfRef.current) renderPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, scale, highlights]);

  // Rerender su resize del contenitore (solo se non usi scale fissa)
  useEffect(() => {
    if (!containerRef.current || scale) return;
    const ro = new ResizeObserver(() => renderPage());
    ro.observe(containerRef.current);
    resizeObsRef.current = ro;
    return () => { try { ro.disconnect(); } catch {} };
  }, [scale]);

  // Normalizza i rettangoli per la pagina corrente
  function rectsForCurrentPage() {
    if (!highlights) return [];
    // formato 2: [{page, rects:[[x1,y1,x2,y2], ...]}, ...]
    if (Array.isArray(highlights) && highlights.length && typeof highlights[0] === "object" && "rects" in (highlights[0] || {})) {
      const hit = highlights.find(h => Number(h.page || 1) === Number(page));
      if (!hit || !Array.isArray(hit.rects)) return [];
      return hit.rects; // lascio gli array; li mapperemo dopo
    }
    // formato 1: [{x,y,w,h}, ...] -> assume pagina corrente
    if (Array.isArray(highlights) && highlights.length && "x" in (highlights[0] || {})) {
      return highlights.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    }
    return [];
  }

  async function renderPage() {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!pdf || !canvas || !container) return;

    const tok = ++renderToken.current;

    try { await renderTaskRef.current?.cancel(); } catch {}
    renderTaskRef.current = null;

    const pdfPage = await pdf.getPage(page);
    if (tok !== renderToken.current) return;

    // viewport
    const unscaled = pdfPage.getViewport({ scale: 1 });
    const targetW = container.clientWidth || 800;
    const effScale = Number(scale) > 0 ? Number(scale) : (targetW / unscaled.width);
    const viewport = pdfPage.getViewport({ scale: effScale });

    // canvas sizing
    const ctx = canvas.getContext("2d");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = "100%";
    canvas.style.height = `${Math.ceil(viewport.height)}px`;

    // bg bianco
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // render PDF
    const task = pdfPage.render({ canvasContext: ctx, viewport });
    renderTaskRef.current = task;
    await task.promise.catch(() => {}); // cancellabile
    if (tok !== renderToken.current) return;

    // highlights (0..1 -> px con inversione Y)
    const rectsRaw = rectsForCurrentPage();
    if (rectsRaw.length) {
      const rects = rectsRaw.map(r => mapRectToCanvas(r, viewport));

      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#ffe200";
      for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffc400";
      for (const r of rects) ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();

      // auto-scroll del primo rect
      if (autoScroll) {
        const r0 = rects[0];
        const canvasBox = canvas.getBoundingClientRect();
        const pageY = window.scrollY + canvasBox.top + r0.y - 80; // padding top
        try {
          window.scrollTo({ top: Math.max(0, pageY), behavior: "smooth" });
        } catch {
          window.scrollTo(0, Math.max(0, pageY));
        }
      }
    }
  }

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        position: "relative",
        overflow: "auto",
        borderRadius: 12,
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
