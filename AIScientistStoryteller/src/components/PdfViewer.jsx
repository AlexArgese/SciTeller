import { useEffect, useRef } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min?url";
import "pdfjs-dist/web/pdf_viewer.css";

// Worker locale (no CDN, no CORS)
GlobalWorkerOptions.workerSrc = pdfjsWorker;

/**
 * props:
 *  - url: string (meglio same-origin: es. /papers/demo.pdf)
 *  - page?: number = 1
 *  - scale?: number = 1.35
 *  - highlights?: [{x,y,w,h}] in coordinate normalizzate PDF (origine in basso-sx)
 *  - onError?: (err) => void
 */
export default function PdfViewer({ url, page = 1, scale = 1.35, highlights = [], onError }) {
  const hostRef = useRef(null);

  useEffect(() => {
    if (!url) return;
    const host = hostRef.current;
    let destroyed = false;

    (async () => {
      try {
        const loadingTask = getDocument(url);
        const pdf = await loadingTask.promise;
        const p = await pdf.getPage(page);

        const viewport = p.getViewport({ scale });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        host.innerHTML = "";
        host.style.position = "relative";
        host.style.width = `${canvas.width}px`;
        host.style.height = `${canvas.height}px`;
        host.appendChild(canvas);

        await p.render({ canvasContext: ctx, viewport }).promise;
        if (destroyed) return;

        // overlay evidenziato
        highlights.forEach((r) => {
          const x = r.x * viewport.width;
          const y = r.y * viewport.height;
          const w = r.w * viewport.width;
          const h = r.h * viewport.height;

          const div = document.createElement("div");
          div.style.position = "absolute";
          div.style.left = `${x}px`;
          div.style.top = `${viewport.height - (y + h)}px`; // inverti Y
          div.style.width = `${w}px`;
          div.style.height = `${h}px`;
          div.style.background = "rgba(255, 230, 120, 0.45)";
          div.style.boxShadow = "inset 0 0 0 1px rgba(200, 180, 60, .5)";
          div.style.borderRadius = "4px";
          div.style.pointerEvents = "none";
          host.appendChild(div);
        });
      } catch (e) {
        console.error("PDF render error:", e);
        if (onError) onError(e);
      }
    })();

    return () => { destroyed = true; };
  }, [url, page, scale, highlights, onError]);

  return (
    <div
      ref={hostRef}
      style={{
        width: "100%",
        height: "auto",
        overflow: "auto",
        borderRadius: 12,
        background: "#fff",
        boxShadow: "0 6px 24px rgba(0,0,0,.1)",
      }}
    />
  );
}
