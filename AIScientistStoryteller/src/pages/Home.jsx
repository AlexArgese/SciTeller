import { useRef, useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { explainPdfAndUpdate } from "../services/explainApi.js";
import { createStory, updateStory, deleteStory } from "../services/storiesApi.js";
import styles from "./Home.module.css";
import Loading from "../components/Loading.jsx";

// ===== Personas (icone stilizzate + caption dinamica) =====
const PERSONAS = [
  "General Public","Investor","Student","Journalist",
  "Developer","Policy Maker","Teacher","Researcher",
];

const PERSONA_META = {
  "General Public": { tone: "Plain-language", context: "General audience", Icon: GeneralPublicIcon },
  "Investor": { tone: "Concise & impact-focused", context: "Business / ROI", Icon: InvestorIcon },
  "Student": { tone: "Simplified academic", context: "Educational use", Icon: StudentIcon },
  "Journalist": { tone: "Clear & news-oriented", context: "Media coverage", Icon: JournalistIcon },
  "Developer": { tone: "Technical & actionable", context: "Implementation details", Icon: DeveloperIcon },
  "Policy Maker": { tone: "Brief & evidence-based", context: "Policy implications", Icon: PolicyIcon },
  "Teacher": { tone: "Didactic & structured", context: "Classroom explanation", Icon: TeacherIcon },
  "Researcher": { tone: "Academic & rigorous", context: "Research insights", Icon: ResearcherIcon },
};

// === Icone stilizzate (SVG semplici, no emoji) ===
function baseSvg(props) { return { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", ...props }; }
function GeneralPublicIcon(props){ return (<svg {...baseSvg(props)}><circle cx="8" cy="12" r="3"/><circle cx="16" cy="12" r="3"/><path d="M3 20c1.5-3 4-5 7-5M21 20c-1.5-3-4-5-7-5"/></svg>); }
function InvestorIcon(props){ return (<svg {...baseSvg(props)}><path d="M3 17h18"/><path d="M7 17V7l4 3 6-5v12"/></svg>); }
function StudentIcon(props){ return (<svg {...baseSvg(props)}><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M12 11v6"/><path d="M6 13v4a6 3 0 0 0 12 0v-4"/></svg>); }
function JournalistIcon(props){ return (<svg {...baseSvg(props)}><rect x="3" y="4" width="14" height="16" rx="2"/><path d="M7 8h6M7 12h6M7 16h4"/><path d="M17 8h4v8a4 4 0 0 1-4 4"/></svg>); }
function DeveloperIcon(props){ return (<svg {...baseSvg(props)}><path d="M8 9l-4 3 4 3"/><path d="M16 9l4 3-4 3"/><path d="M12 8l-2 8"/></svg>); }
function PolicyIcon(props){ return (<svg {...baseSvg(props)}><path d="M6 3h12v6H6z"/><path d="M6 9v12h12V9"/><path d="M10 13h4M10 17h4"/></svg>); }
function TeacherIcon(props){ return (<svg {...baseSvg(props)}><path d="M4 19V6l8-3 8 3v13"/><path d="M12 22v-9"/><path d="M7 9h10"/></svg>); }
function ResearcherIcon(props){ return (<svg {...baseSvg(props)}><circle cx="10" cy="10" r="5"/><path d="M14.5 14.5L21 21"/></svg>); }

// ===== Messaggi di stato lettura/generazione =====
const TICK_MS = 2600;
const PHASE_CHANGE_FREEZE_MS = 3200;
const EXTRACT_TO_STORY_GUARD_MS = 7000;

const UploadIcon = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="5" y="3" width="14" height="18" rx="3" fill="none" stroke="#000" strokeWidth="2"/>
    <path d="M12 9v8M9.5 11.5 12 9l2.5 2.5" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const ChevronDown = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
    <path d="M5 7l5 6 5-6" fill="#000"/>
  </svg>
);

// ===================== Helpers link -> File (con proxy) =====================
const PDF_PROXY =
  import.meta.env?.VITE_PDF_PROXY || "/api/proxy/pdf";

function toArxivPdfUrlIfNeeded(raw = "") {
  let url;
  try { url = new URL(raw); } catch { return raw; }
  if (!/arxiv\.org$/i.test(url.hostname)) return raw;
  const p = url.pathname;
  if (p.startsWith("/abs/")) {
    const id = p.replace(/^\/abs\//, "");
    return `https://arxiv.org/pdf/${id}.pdf`;
  }
  if (p.startsWith("/pdf/")) {
    return raw.endsWith(".pdf") ? raw : `${raw}.pdf`;
  }
  return raw;
}

function filenameFromContentDisposition(headerValue) {
  if (!headerValue) return null;
  const m = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(headerValue);
  const name = m?.[1] || m?.[2] || m?.[3];
  if (!name) return null;
  try { return decodeURIComponent(name); } catch { return name; }
}

async function fetchViaProxyAsFile(targetUrl) {
  const proxied = `${PDF_PROXY}?url=${encodeURIComponent(targetUrl)}`;
  const resp = await fetch(proxied, { method: "GET" });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(msg || "Proxy error while fetching PDF");
  }
  const cd = resp.headers.get("content-disposition");
  let name =
    filenameFromContentDisposition(cd) ||
    targetUrl.split("/").pop()?.split("#")[0]?.split("?")[0] ||
    "document.pdf";
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  const blob = await resp.blob();
  if (!(blob && (blob.type?.includes("pdf") || /\.pdf$/i.test(name)))) {
    throw new Error("File is not a PDF");
  }
  return new File([blob], name, { type: "application/pdf" });
}

async function fetchPdfAsFile(rawUrl) {
  const url = toArxivPdfUrlIfNeeded(String(rawUrl).trim());
  if (!/^https?:\/\//i.test(url)) throw new Error("Invalid URL");
  return fetchViaProxyAsFile(url);
}

/* ========== normalizzazione sezioni (come tua versione) ========== */
function normalizeFromApiSections(apiSections) { /* …non usata qui… */ return apiSections; }

export default function Home() {
  const fileRef = useRef(null);
  const dropRef = useRef(null);

  const [pdfName, setPdfName] = useState("");
  const [link, setLink] = useState("");
  const [persona, setPersona] = useState("");

  const [isDragging, setIsDragging] = useState(false);

  const navigate = useNavigate();
  const [fileObj, setFileObj] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  // ===== PHASED STATUS =====
  const [phase, setPhase] = useState("idle");
  const [tickIndex, setTickIndex] = useState(0);
  const sseRef = useRef(null);
  const freezeRef = useRef(false);
  const guardTimerRef = useRef(null);
  const tickerTimerRef = useRef(null);

  const extractMsgs = useMemo(
    () => [
      "Extracting text…",
      "Detecting structure and headings…",
      "Collecting figures and captions…",
      "Cleaning layout and artifacts…",
    ],
    []
  );
  const storyMsgs = useMemo(
    () => [
      "Generating storyline…",
      "Identifying key sections…",
      "Drafting the first section…",
      "Adapting tone to persona…",
      "Refining transitions…",
    ],
    []
  );

  const activeMsgs = phase === "extract" ? extractMsgs : phase === "story" ? storyMsgs : [];

  useEffect(() => {
    setTickIndex(0);
    freezeRef.current = true;
    const freezeT = setTimeout(() => { freezeRef.current = false; }, PHASE_CHANGE_FREEZE_MS);

    if (tickerTimerRef.current) clearInterval(tickerTimerRef.current);

    if (isLoading && activeMsgs.length > 0) {
      tickerTimerRef.current = setInterval(() => {
        if (freezeRef.current) return;
        setTickIndex((i) => (i + 1) % activeMsgs.length);
      }, TICK_MS);
    }

    return () => {
      clearTimeout(freezeT);
      if (tickerTimerRef.current) clearInterval(tickerTimerRef.current);
    };
  }, [isLoading, phase, activeMsgs.length]);

  const RE_START_DOCPARSE = /start\s*docparse/i;
  const RE_START_STORY = /(docparse\s*ok[^]*?start\s*story)|(^\s*start\s*story)/i;

  const handleBackendLog = (line = "") => {
    const L = String(line);
    if (RE_START_DOCPARSE.test(L)) {
      if (phase !== "extract") setPhase("extract");
    } else if (RE_START_STORY.test(L)) {
      if (phase !== "story") setPhase("story");
    }
  };

  const attachExplainLogsSSE = (jobId) => {
    try {
      const es = new EventSource(`/api/explain/logs?jobId=${encodeURIComponent(jobId)}`);
      sseRef.current = es;
      es.onmessage = (ev) => { if (ev?.data) handleBackendLog(ev.data); };
      es.onerror = () => { es.close(); };
    } catch {}
  };

  useEffect(() => {
    if (guardTimerRef.current) {
      clearTimeout(guardTimerRef.current);
      guardTimerRef.current = null;
    }
    if (isLoading && phase === "extract") {
      guardTimerRef.current = setTimeout(() => {
        setPhase((p) => (p === "extract" ? "story" : p));
      }, EXTRACT_TO_STORY_GUARD_MS);
    }
    return () => { if (guardTimerRef.current) clearTimeout(guardTimerRef.current); };
  }, [isLoading, phase]);

  useEffect(() => {
    document.body.setAttribute("data-route", "home");
    return () => {
      document.body.removeAttribute("data-route");
      try { sseRef.current?.close?.(); } catch {}
      if (guardTimerRef.current) clearTimeout(guardTimerRef.current);
      if (tickerTimerRef.current) clearInterval(tickerTimerRef.current);
    };
  }, []);

  // ---------- Drag & Drop handlers ----------
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;

    const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
    const onEnter = (e) => { prevent(e); setIsDragging(true); };
    const onOver  = (e) => { prevent(e); setIsDragging(true); };
    const onLeave = (e) => { prevent(e); setIsDragging(false); };
    const onDrop  = (e) => {
      prevent(e);
      setIsDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type === "application/pdf") {
        setPdfName(file.name);
        setFileObj(file);
      }
    };

    el.addEventListener("dragenter", onEnter);
    el.addEventListener("dragover", onOver);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragenter", onEnter);
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  // --- persona → opzioni storyteller (coerenti con infer_from_splits.py) ---
  function optionsForPersona(persona) {
    const capTemp = (t) => Math.min(t, 0.7);
    const base = { top_p: 0.85 }; // clamp lato FE per coerenza

    switch (persona) {
      case "General Public":
        return { ...base, preset: "short", k: 3, max_ctx_chars: 1400, temperature: capTemp(0.5) };
      case "Investor":
        return { ...base, preset: "short", k: 3, max_ctx_chars: 1600, temperature: capTemp(0.6) };
      case "Student":
        return { ...base, preset: "medium", k: 4, max_ctx_chars: 1800, temperature: capTemp(0.5) };
      case "Journalist":
        return { ...base, preset: "medium", k: 4, max_ctx_chars: 2000, temperature: capTemp(0.5) };
      case "Developer":
        return { ...base, preset: "medium", k: 5, max_ctx_chars: 2400, temperature: capTemp(0.4) };
      case "Policy Maker":
        return { ...base, preset: "medium", k: 5, max_ctx_chars: 2200, temperature: capTemp(0.4) };
      case "Teacher":
        return { ...base, preset: "long", k: 6, max_ctx_chars: 2600, temperature: capTemp(0.35) };
      case "Researcher":
        return { ...base, preset: "long", k: 6, max_ctx_chars: 3000, temperature: capTemp(0.3) };
      default:
        return { ...base, preset: "medium", k: 4, max_ctx_chars: 1800, temperature: capTemp(0.5) };
    }
  }

  // ----------------- click handler: locale o link -> File (via proxy) -----------------
  const handleGenerate = async () => {
    if (isLoading) return;

    const step1Done = Boolean(fileObj || link.trim());
    const step2Done = Boolean(persona);
    if (!(step1Done && step2Done)) return;

    try {
      setIsLoading(true);
      setPhase("extract");
      handleBackendLog("[/api/explain] start docparse");

      // 1) prepara il PDF (upload o proxy)
      let pdfFile = fileObj;
      if (!pdfFile && link.trim()) {
        pdfFile = await fetchPdfAsFile(link.trim());
        setPdfName(pdfFile.name);
      }

      // 2) opzioni AI (auto in base alla persona)
      const o = optionsForPersona(persona);

      // Se il tuo backend si aspetta questi nomi, tienili così (coerenti con two_stage_app/infer_from_splits):
      const options = {
        preset: o.preset,                 // short|medium|long
        k: o.k,                           // top-k paragrafi per sezione
        max_ctx_chars: o.max_ctx_chars,   // budget contesto per sezione
        temperature: o.temperature,       // creatività controllata
        top_p: o.top_p,                   // clamp 0.85
        limit_sections: 5,
        title_style: "didactic",
        title_max_words: 6,
      };


      // 3) crea story provvisoria (solo ora)
      const provisional = pdfFile?.name || "Story";
      const created = await createStory(provisional);

      try {
        // 4) genera **e salva**
        await explainPdfAndUpdate(created.id, { file: pdfFile, persona, options });
        // 5) ok → vai alle stories
        navigate("/stories");
      } catch (innerErr) {
        try { await deleteStory(created.id); } catch {}
        throw innerErr;
      }
    } catch (err) {
      console.error(err);
      alert(err.message || "Error during generation");
      setPhase("idle");
      setIsLoading(false);
    }
  };

  const PersonaCurrentIcon = persona ? (PERSONA_META[persona]?.Icon || GeneralPublicIcon) : null;
  const personaTone = persona ? (PERSONA_META[persona]?.tone ?? "Auto") : null;
  const personaContext = persona ? (PERSONA_META[persona]?.context ?? "General use") : null;

  const step1Done = Boolean(fileObj || link.trim());
  const step2Done = Boolean(persona);
  const canGenerate = step1Done && step2Done;

  if (isLoading) {
    return (
      <Loading
        title="AI Scientist Storyteller"
        subtitle={`Generating your story for persona “${persona || "…"}”.`}
        phase={phase === "extract" ? "extract" : "story"}
        extractMsgs={[
          "Extracting text…",
          "Detecting structure and headings…",
          "Collecting figures and captions…",
          "Cleaning layout and artifacts…",
        ]}
        storyMsgs={[
          "Generating storyline…",
          "Identifying key sections…",
          "Drafting the first section…",
          "Adapting tone to persona…",
          "Refining transitions…",
        ]}
        genericMsgs={["Working…"]}
      />
    );
  }

  return (
    <main className="container">
      <section className={styles.panel}>
        <div className={styles.hero}>
          <h1>AI Scientist Storyteller</h1>
          <p>
            Upload a scientific paper and get a tailored narrative for your audience.
            Pick a persona, set the context, and generate a clear, engaging story.
          </p>
        </div>

        {/* STEP 1 - Upload / Link */}
        <div className={styles.step}>
          <div className={`${styles.ball} ${styles.chip} ${step1Done ? styles.ballDone : ""}`}>1</div>
          <div className={styles.body}>
            <div className={styles.row}>
              <div
                ref={dropRef}
                className={`${styles.input} ${styles.glass}`}
                role="button"
                tabIndex={0}
                aria-label="Upload a PDF via drag and drop or file picker"
                onClick={() => fileRef.current?.click()}
                onKeyDown={(e) => { if (e.key === "Enter") fileRef.current?.click(); }}
                style={isDragging ? { outline: "2px solid rgba(99, 102, 241, .4)" } : undefined}
              >
                <UploadIcon />
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setPdfName(f.name);
                      setFileObj(f);
                    }
                  }}
                  style={{ display: "none" }}
                />
                <button className={styles.ghost} aria-label="Choose a PDF">
                  {pdfName || (isDragging ? "Drop your PDF here" : "Drop a PDF or click to choose")}
                </button>
              </div>

              <div className={styles.or}>or</div>

              <div className={`${styles.glass} ${styles.grow}`}>
                <input
                  className={styles.text}
                  type="url"
                  inputMode="url"
                  placeholder="Paste the link"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  aria-label="Paste a PDF or arXiv link"
                />
              </div>
            </div>
          </div>
        </div>

        {/* STEP 2 - Persona */}
        <div className={styles.step}>
          <div className={` ${styles.chip} ${step2Done ? styles.ballDone : styles.ball}`}>2</div>
          <div className={`${styles.body} ${styles.step2}`}>
            <div className={`${styles.select} ${styles.glass}`}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginRight: 10 }}>
                {PersonaCurrentIcon ? <PersonaCurrentIcon /> : <span aria-hidden="true" style={{ width:20,height:20,display:"inline-block" }} />}
              </div>
              <select
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                className={styles.selectEl}
                aria-label="Choose persona"
              >
                <option value="">Choose Persona...</option>
                {PERSONAS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <ChevronDown />
            </div>

            <div className={styles.caption}>
              {persona
                ? <>Tone: {personaTone}, Context: {personaContext}</>
                : <>Select a persona to adapt tone and context.</>}
            </div>
          </div>
        </div>

        {/* STEP 3 - CTA */}
        <div className={styles.step}>
          <div className={`${styles.ball} ${styles.chip} ${canGenerate ? styles.ballDone : ""}`}>3</div>
          <div className={styles.body}>
            <div className={styles.center}>
              <button
                className={styles.cta}
                disabled={!canGenerate}
                onClick={handleGenerate}
                style={{
                  opacity: canGenerate ? 1 : 0.4,
                  cursor: canGenerate ? "pointer" : "not-allowed",
                }}
              >
                GENERATE STORY
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
