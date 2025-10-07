import { useEffect, useMemo, useState, useRef } from "react";
import Sidebar from "../components/Sidebar.jsx";
import StoryView from "../components/StoryView.jsx";
import ControlPanel from "../components/ControlPanel.jsx";
import PdfViewer from "../components/PdfViewer.jsx";
import styles from "./Stories.module.css";
import {
  getStories, getStory, createStory, updateStory, deleteStory,
  generateFromText, getRevisions, regenerateSelectedSections,
} from "../services/storiesApi.js";
import Loading from "../components/Loading.jsx";

// --- mapping sezioni selezionate (IDs visibili) -> indici assoluti nell'array sections
function resolveTargetsFromIds(story, sectionIds = []) {
  const all = Array.isArray(story?.sections) ? story.sections : [];
  const visible = all.map((s, i) => ({ s, i })).filter(({ s }) => s?.visible !== false);
  const visIdToAbsIndex = new Map(
    visible.map(({ s, i }) => [ (s.id ?? s.sectionId ?? String(i)), i ])
  );
  return (sectionIds || [])
    .map(id => visIdToAbsIndex.get(id))
    .filter(i => Number.isInteger(i));
}

function getPaperTextFromStory(story) {
  // preferisci quello messo dal backend in meta.paperText (ex explain/generate)
  const t = story?.meta?.paperText;
  if (typeof t === "string" && t.trim()) return t;

  // fallback: ricostruisci dal contenuto corrente
  const sections = Array.isArray(story?.sections) ? story.sections : [];
  return sections
    .map((s, i) => {
      const h = s?.title ? `# ${String(s.title).trim()}\n\n` : `# Section ${i + 1}\n\n`;
      const raw =
        (typeof s?.text === "string" && s.text) ||
        (typeof s?.narrative === "string" && s.narrative) ||
        (Array.isArray(s?.paragraphs) ? s.paragraphs.join("\n\n") : "");
      return (h + (raw || "")).trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

// helper: map ID → indici ordinati
function idsToIndexes(sections, ids) {
  const byId = new Map(
    (sections || []).map((s, i) => [String(s?.id ?? s?.sectionId ?? i), i])
  );
  const idxs = [];
  for (const id of ids || []) {
    const key = String(id);
    if (byId.has(key)) idxs.push(byId.get(key));
  }
  return idxs.sort((a, b) => a - b);
}

export default function Stories(){
  const [stories, setStories] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [openCP, setOpenCP] = useState(false);
  const [loading, setLoading] = useState(true);

  const [selectedParagraph, setSelectedParagraph] = useState(null);
  const [selectedSectionId, setSelectedSectionId] = useState(null);
  const [cpStage, setCpStage] = useState("default");

  const [showPdf, setShowPdf] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  const [pdfHighlights, setPdfHighlights] = useState([]);

  const [busySectionIds, setBusySectionIds] = useState([]);

  const [regenTargets, setRegenTargets] = useState([]);

  // pagina di mezzo anche durante rigenerazione
  const [isRegenerating, setIsRegenerating] = useState(false);

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

  // DOM refs per scroll e flash
  const storyHostRef = useRef(null);
  const sectionElsRef = useRef({});
  const flashTimersRef = useRef({});

  const prefersReducedMotion = typeof window !== "undefined"
    && window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Primo fetch
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const list = await getStories();
        setStories(list);
        const firstId = list[0]?.id ?? null;
        setSelectedId(firstId);
        if (firstId) {
          const full = await getStory(firstId);
          let versions = [];
          try { versions = await getRevisions(firstId); } catch {}
          const withVersions = {
            ...full,
            versions,
            defaultVersionId: full?.current_revision_id || null,
          };
          setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    document.body.setAttribute("data-route", "stories");
    return () => document.body.removeAttribute("data-route");
  }, []);

  useEffect(() => {
    return () => {
      Object.values(flashTimersRef.current || {}).forEach((t) => t && clearTimeout(t));
      flashTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    sectionElsRef.current = {};
    Object.values(flashTimersRef.current || {}).forEach((t) => t && clearTimeout(t));
    flashTimersRef.current = {};
  }, [selectedId]);

  const selectedStory = useMemo(
    () => stories.find(s => s.id === selectedId),
    [stories, selectedId]
  );

  async function handleNew() {
    const s = await createStory(`Chat ${stories.length + 1}`);
    setStories(prev => [...prev, s]);
    setSelectedId(s.id);
  }

  async function handleUpdate(patch) {
    if (!selectedStory) return;

    if (patch?._action === "regenerate_story") {
      const paperText = selectedStory?.meta?.paperText;
      if (!paperText || typeof paperText !== "string" || !paperText.trim()) {
        alert("Sorgente non disponibile per la rigenerazione.\nRicarica il PDF e rigenera da capo.");
        return;
      }

      try {
        setIsRegenerating(true);

        const persona = patch.persona || selectedStory.persona || "Student";
        const limit_sections =
          (Array.isArray(selectedStory?.sections) && selectedStory.sections.length)
            ? selectedStory.sections.length
            : 5;
        const temp  = (typeof patch.temp === "number") ? patch.temp : 0.0;

        const adapted = await generateFromText({
          text: paperText,
          persona,
          limit_sections,
          temp,
          top_p: 0.9,
          title: selectedStory?.title || selectedStory?.docTitle || "Paper",
          length_preset: patch.lengthPreset || "medium",
        });

        const prevMeta = selectedStory?.meta || {};
        const nextMeta = {
          ...prevMeta,
          ...(adapted?.meta || {}),
          upstreamParams: { persona, temp, lengthPreset: patch.lengthPreset || "medium", mode: "regen_from_text" },
          aiTitle: adapted?.title || null,
          ...(patch?.notes ? { notes: patch.notes } : {}),
        };

        const keepTitle =
          (selectedStory?.title && selectedStory.title.trim()) ||
          (selectedStory?.docTitle && selectedStory.docTitle.trim()) ||
          "Story";

        const updated = await updateStory(selectedStory.id, {
          title: keepTitle,
          persona: adapted?.persona || persona,
          sections: Array.isArray(adapted?.sections) ? adapted.sections : [],
          meta: nextMeta,
          ...(patch.baseRevisionId ? { baseRevisionId: patch.baseRevisionId } : {}),
        });

        let versions = [];
        try { versions = await getRevisions(selectedStory.id); } catch {}
        const withVersions = {
          ...updated,
          versions,
          defaultVersionId: updated?.current_revision_id || null,
        };

        setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));
        setCpStage("default");
        setSelectedParagraph(null);
        setSelectedSectionId(null);
      } catch (err) {
        console.error(err);
        alert(err?.message || "Errore durante la rigenerazione.");
      } finally {
        setIsRegenerating(false);
      }
      return;
    }

    if (patch?._action === "regenerate_sections") {
      const st = selectedStory;
      if (!st) return;
    
      const sectionIds = Array.isArray(patch.sectionIds) ? patch.sectionIds : [];
      if (sectionIds.length === 0) {
        alert("Nessuna sezione valida da rigenerare.");
        return;
      }
    
      // calcola targets (indici 0-based) a partire dagli ID selezionati
      const sections = Array.isArray(st?.sections) ? st.sections : [];
      const targets = idsToIndexes(sections, sectionIds);
    
      // spinner SOLO sulle sezioni selezionate (usa gli ID, come già fai nello StoryView)
      setBusySectionIds(sectionIds);
    
      // costruisci il body richiesto dal FastAPI
      const args = {
        text: getPaperTextFromStory(st),
        persona: st?.persona || st?.meta?.persona || "General Public",
        title: st?.title || st?.docTitle || "Story",
        sections,                      // array completo corrente
        targets,                       // indici delle sezioni da rigenerare
        temp: Number(patch?.temp ?? st?.meta?.upstreamParams?.temp ?? 0),
        top_p: Number(st?.meta?.upstreamParams?.top_p ?? 0.9),
        // se vuoi: retriever / k / ecc. (opzionali) → aggiungili qui
      };
    
      try {
        // CHIAMA il backend FastAPI (usando la funzione già exportata dai services)
        const updatedStoryShape = await regenerateSelectedSections(st.id, args);
        // `updatedStoryShape` = { persona, title, sections, meta }
    
        // Salva come nuova revisione nel DB (PATCH /api/stories/:id)
        const patchSave = {
          title: st?.title || updatedStoryShape?.title || "Story",
          persona: updatedStoryShape?.persona || args.persona,
          sections: Array.isArray(updatedStoryShape?.sections) ? updatedStoryShape.sections : sections,
          meta: {
            ...(st?.meta || {}),
            ...(updatedStoryShape?.meta || {}),
            upstreamParams: {
              ...(updatedStoryShape?.meta?.upstreamParams || {}),
              mode: "regen_partial_vm",
              temp: args.temp,
              top_p: args.top_p,
              lengthPreset: String(patch?.lengthPreset || st?.meta?.upstreamParams?.lengthPreset || "medium"),
              targets,
            },
          },
          baseRevisionId: st?.current_revision_id || null,
        };
    
        const saved = await updateStory(st.id, patchSave);
    
        // ricarica timeline versioni
        let versions = [];
        try { versions = await getRevisions(st.id); } catch {}
        const withVersions = { ...saved, versions, defaultVersionId: saved?.current_revision_id || null };
    
        setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));
        setCpStage("default");
        setSelectedParagraph(null);
        setSelectedSectionId(null);
      } catch (err) {
        console.error("regen_sections_vm failed", err);
        alert(err?.message || "Error during section regeneration.");
      } finally {
        setBusySectionIds([]);
      }
      return;
    }    

    setLoading(true);
    try {
      await updateStory(selectedStory.id, patch);
      const full = await getStory(selectedStory.id);
      let versions = [];
      try { versions = await getRevisions(selectedStory.id); } catch {}
      const withVersions = {
        ...full,
        versions,
        defaultVersionId: full?.current_revision_id || null,
      };
      setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));
    } finally {
      setLoading(false);
    }
  }

  async function handleRegenSelectedSection() {
    const st = selectedStory;
    if (!st) return;
    if (!selectedSectionId) {
      alert("First select a section to regenerate.");
      return;
    }
  
    const sectionId = selectedSectionId;
    const baseRevisionId = st?.current_revision_id || st?.defaultVersionId || null;
  
    const upstream = st?.meta?.upstreamParams || {};
    const knobs = {
      temp: Number(upstream?.temp ?? 0.0),
      lengthPreset: String(upstream?.lengthPreset || "medium"),
      top_p: Number(upstream?.top_p ?? 0.9),
      retriever: upstream?.retriever,
      retriever_model: upstream?.retriever_model,
      k: upstream?.k,
      max_ctx_chars: upstream?.max_ctx_chars,
      seg_words: upstream?.seg_words,
      overlap_words: upstream?.overlap_words,
    };
  
    try {
      // 👇 niente overlay globale, solo spinner sulla sezione
      setBusySectionIds([sectionId]);
  
      const updated = await regenerateSelectedSections(st.id, {
        sectionIds: [sectionId],
        baseRevisionId,
        notes: "",
        ...knobs,
      });
  
      let versions = [];
      try { versions = await getRevisions(st.id); } catch {}
      const withVersions = { ...updated, versions, defaultVersionId: updated?.current_revision_id || null };
      setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));
      setSelectedSectionId(null);
    } catch (err) {
      console.error(err);
      alert(err?.message || "Error during section regeneration.");
    } finally {
      setBusySectionIds([]);
    }
  }
  

  async function handleDelete(id) {
    await deleteStory(id);
    const next = await getStories();
    setStories(next);
    if (id === selectedId) {
      setSelectedId(next[0]?.id ?? null);
      setSelectedParagraph(null);
      setSelectedSectionId(null);
      setCpStage("default");
      setShowPdf(false);
      setPdfError(null);
      setPdfHighlights([]);
    }
  }

  function handleToggleParagraph(sectionId, index, text) {
    const same = selectedParagraph &&
      selectedParagraph.sectionId === sectionId &&
      selectedParagraph.index === index;

    setSelectedParagraph(same ? null : { sectionId, index, text });
    setSelectedSectionId(sectionId);
    setCpStage("default");
    if (!openCP) setOpenCP(true);
  }

  function handleSelectSection(sectionId) {
    setSelectedSectionId(prev => (prev === sectionId ? null : sectionId));
    setSelectedParagraph(null); // deseleziona eventuale paragrafo
    setCpStage("default");
    if (!openCP) setOpenCP(true);
  }

  function randomHighlight() {
    const w = 0.70 + Math.random() * 0.10;
    const h = 0.045 + Math.random() * 0.015;
    const x = 0.10 + Math.random() * 0.06;
    const y = 0.20 + Math.random() * (0.75 - h);
    return [{ x, y, w, h }];
  }

  const handleReadOnPaper = () => {
    const url = selectedStory?.meta?.pdfUrl;
    setPdfError(null);
    const sameOrigin = url && (url.startsWith("/") || new URL(url, window.location.origin).origin === window.location.origin);
    if (!sameOrigin) {
      alert("Questo PDF è da dominio esterno. Per la preview inline, metti il file in /public (es. /papers/demo.pdf) oppure usa un proxy lato server.");
      return;
    }
    setPdfHighlights(randomHighlight());
    setShowPdf(true);
  };

  const handleContinueNotes  = () => { setCpStage("notes"); };
  const handleContinueGlobal = () => { setSelectedParagraph(null); setSelectedSectionId(null); setCpStage("notes"); };

  const SIDEBAR_W = 300;
  const PANEL_W   = 380;

  const pdfUrl = selectedStory?.meta?.pdfUrl || null;

  const handleRegisterSectionEl = (id, el) => {
    if (el) sectionElsRef.current[id] = el;
    else delete sectionElsRef.current[id];
  };

  const doScrollAndFlash = (el, id) => {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    const prev = flashTimersRef.current[id];
    if (prev) { clearTimeout(prev); flashTimersRef.current[id] = null; el.classList.remove("sectionFlash"); el.offsetHeight; }
    el.classList.add("sectionFlash");
    const durationMs = prefersReducedMotion ? 16 : 1000;
    const t = setTimeout(() => { el.classList.remove("sectionFlash"); flashTimersRef.current[id] = null; }, durationMs);
    flashTimersRef.current[id] = t;
  };

  const handleScrollToSection = (id) => {
    const byRef = sectionElsRef.current[id];
    if (byRef) { doScrollAndFlash(byRef, id); return; }
    const allSecs = Array.isArray(selectedStory?.sections) ? selectedStory.sections : [];
    const visible = allSecs.map((s, i) => ({ s, i })).filter(({ s }) => s?.visible !== false);
    const ids = visible.map(({ s, i }) => (s.id ?? s.sectionId ?? String(i)));
    const idx = ids.indexOf(id);
    if (idx === -1) return;
    const host = storyHostRef.current;
    if (!host) return;
    const domSecs = host.querySelectorAll("article section");
    const target = domSecs && domSecs[idx];
    if (target) doScrollAndFlash(target, id);
  };

  const showLoadingPage = loading || isRegenerating;

  // ⬇️ Quando c'è loading, NON montiamo nulla: solo la pagina Loading
  if (showLoadingPage) {
    return (
      <Loading
        title="AI Scientist Storyteller"
        subtitle={`${
          selectedStory?.persona
            ? `Working for persona “${selectedStory.persona}”.`
            : isRegenerating
            ? "Regenerating story…"
            : "Loading story…"
        }`}
        phase={isRegenerating ? "story" : "generic"}
        extractMsgs={extractMsgs}
        storyMsgs={storyMsgs}
        genericMsgs={["Loading…"]}
      />
    );
  }

  return (
    <div
      className={`${styles.page} ${openCP ? styles.withPanel : styles.noPanel}`}
      style={{ "--sidebar-w": `${SIDEBAR_W}px`, "--panel-w": openCP ? `${PANEL_W}px` : "0px" }}
    >
      <Sidebar
        items={stories}
        selectedId={selectedId}
        onSelect={async (id) => {
          setBusySectionIds([]);
          setSelectedId(id);
          setSelectedParagraph(null);
          setSelectedSectionId(null);
          setCpStage("default");
          setShowPdf(false);
          setPdfError(null);
          setPdfHighlights([]);
          setLoading(true);
          try {
            const full = await getStory(id);
            let versions = [];
            try { versions = await getRevisions(id); } catch {}
            const withVersions = {
              ...full,
              versions,
              defaultVersionId: full?.current_revision_id || null,
            };
            setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));
          } finally {
            setLoading(false);
          }
        }}
        onNew={handleNew}
        onDelete={handleDelete}
        loading={false /* non serve spinner interno: usiamo la pagina Loading */}
      />

      <main className={styles.centerCol}>
        <div className={styles.centerInner}>
          <div className={styles.card} ref={storyHostRef}>
            {pdfError && (
              <div style={{
                margin: "8px 0 14px",
                padding: "10px 14px",
                borderRadius: 10,
                background: "#fff1f1",
                color: "#a40000",
                boxShadow: "0 1px 2px rgba(0,0,0,.06)"
              }}>
                Errore nel rendering del PDF (probabile CORS). Metti il file in <code>/public</code> (es. <code>/papers/demo.pdf</code>) oppure usa un proxy.
              </div>
            )}

            {showPdf && pdfUrl ? (
              <PdfViewer
                url={pdfUrl}
                page={1}
                scale={1.35}
                highlights={pdfHighlights}
                onError={() => { setPdfError(true); setShowPdf(false); }}
              />
            ) : (
              <StoryView
                story={selectedStory}
                selectedParagraph={selectedParagraph}
                selectedSectionId={selectedSectionId}
                onToggleParagraph={handleToggleParagraph}
                onSelectSection={handleSelectSection}
                onRegisterSectionEl={handleRegisterSectionEl}
                busySectionIds={busySectionIds}
              />
            )}
          </div>
        </div>
      </main>

      {selectedStory && (
        <>
          <button
            className={openCP ? styles.reopenHandle : styles.recloseHandle}
            onClick={() => setOpenCP(o => !o)}
            aria-expanded={openCP}
          >
            {openCP ? "›" : "‹"}
          </button>

          {selectedSectionId && (
            <button
              style={{ position:"absolute", right: 20, bottom: 20, zIndex: 2 }}
              onClick={handleRegenSelectedSection}
              title="Rigenera solo questa sezione (mantiene le altre)"
            >
              Rigenera sezione
            </button>
          )}

          <ControlPanel
            open={openCP}
            story={selectedStory}
            selectedParagraph={selectedParagraph}
            cpStage={cpStage}
            onContinueNotes={handleContinueNotes}
            onContinueGlobal={handleContinueGlobal}
            onReadOnPaper={handleReadOnPaper}
            onChange={handleUpdate}
            onChangeSections={(next) => handleUpdate({ sections: next })}
            onJumpToSection={handleScrollToSection}
          />
        </>
      )}

    </div>
  );
}
