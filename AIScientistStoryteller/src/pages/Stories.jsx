// FILE: AIScientistStoryteller/src/pages/Stories.jsx
import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import Sidebar from "../components/Sidebar.jsx";
import StoryView from "../components/StoryView.jsx";
import ControlPanel from "../components/ControlPanel.jsx";
import PdfViewer from "../components/PdfViewer.jsx";
import styles from "./Stories.module.css";
import {
  getStories, getStory, createStory, updateStory, deleteStory,
  generateFromText, getRevisions, regenerateSelectedSections,
  regenerateParagraphVm,
  // ⬇️ API varianti
  getParagraphVariantsHistory, chooseParagraphVariant,
} from "../services/storiesApi.js";
import Loading from "../components/Loading.jsx";
export const API_BASE = import.meta.env.VITE_API_BASE || "/svc";

/* ───────────────── helpers comuni ───────────────── */
function deriveAggregatesFromSections(sections = [], base = {}) {
  const baseLen = base.lengthPreset || "medium";
  const baseTemp = typeof base.temp === "number" ? base.temp : 0;
  if (!sections.length) return { lengthLabel: baseLen, avgTemp: baseTemp, sectionsCount: 0 };
  const lens = sections.map(s => (s.lengthPreset || baseLen).toLowerCase());
  const allSame = lens.every(l => l === lens[0]);
  const temps = sections.map(s => typeof s.temp === "number" ? s.temp : baseTemp);
  return {
    lengthLabel: allSame ? lens[0] : "mix",
    avgTemp: temps.reduce((a,b)=>a+b,0)/temps.length,
    sectionsCount: sections.length,
  };
}
function guessParagraphLengthPreset(text = "") {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  if (words <= 60) return "short";
  if (words >= 110) return "long";
  return "medium";
}
function recomputeSectionFromParagraphs(section) {
  const paras = Array.isArray(section.paragraphs)
    ? section.paragraphs.map(p => (typeof p === "string" ? p : String(p || "")))
    : [];
  if (!paras.length) return section;

  // 1) lunghezze per paragrafo
  const paraPresets = paras.map(p => guessParagraphLengthPreset(p));
  const allSame = paraPresets.every(p => p === paraPresets[0]);
  const sectionLen = allSame ? paraPresets[0] : "mix";

  // 2) creatività: se la sezione ha un temp “suo” tienilo,
  // altrimenti prova a vedere se hai temp per i blocchi (se non li hai, lascia stare)
  // per semplicità: se non hai temp per-paragrafo, NON cambiare temp della sezione
  return {
    ...section,
    lengthPreset: sectionLen,
    // text / narrative coerenti
    text: paras.join("\n\n"),
    narrative: paras.join("\n\n"),
  };
}

// index di sezione da id (visibile)
function sectionIndexById(story, sectionId) {
  if (!story || !Array.isArray(story.sections)) return -1;
  return story.sections.findIndex(
    (s, i) => String(s?.id ?? s?.sectionId ?? i) === String(sectionId)
  );
}

function applyParagraphReplacement(story, { sectionId, paragraphIndex, newText }) {
  if (!story || !Array.isArray(story.sections)) return story;
  const idx = (story.sections || []).findIndex(
    s => String(s?.id ?? s?.sectionId ?? "") === String(sectionId)
  );
  if (idx < 0) return story;

  const sec = story.sections[idx] || {};
  const paras = Array.isArray(sec.paragraphs) ? [...sec.paragraphs] : [];
  if (paragraphIndex < 0 || paragraphIndex >= paras.length) return story;

  paras[paragraphIndex] = newText;

  const nextSections = [...story.sections];
  nextSections[idx] = {
    ...sec,
    paragraphs: paras,
    text: paras.join("\n\n"),
    narrative: paras.join("\n\n"),
  };

  return { ...story, sections: nextSections };
}

/* ⬇️ estrai le varianti dell’ultimo batch dal meta, se coincidono con la selezione corrente */
function lastBatchParagraphVariants(story, selectedParagraph) {
  if (!story || !selectedParagraph) return [];
  const lpe = story?.meta?.lastParagraphEdit;
  if (!lpe || !Array.isArray(lpe.candidates)) return [];

  const sameSection =
    Number(lpe.sectionIndex) === sectionIndexById(story, selectedParagraph.sectionId);
  const sameParagraph = Number(lpe.paragraphIndex) === Number(selectedParagraph.index);
  if (!sameSection || !sameParagraph) return [];

  const clean = (s) => {
    let t = String(s || "");
    t = t.replace(/^\s*\{[\s\S]*?\}\s*Human:.*$/i, "").trim();
    t = t.replace(/^\s*Assistant:\s*/i, "");
    return t.trim();
  };

  return lpe.candidates
    .map(x => (typeof x === "string" ? x : (x && typeof x.text === "string" ? x.text : "")))
    .map(clean)
    .filter(Boolean);
}

/* ⬇️ ultimo batch storicizzato per la selezione corrente (da /api/paragraph_variants) */
function lastBatchObjectsForSelection(story, variantHistory, selectedParagraph) {
  if (!selectedParagraph || !Array.isArray(variantHistory)) return { batchId: null, items: [] };

  const secIdx = sectionIndexById(story, selectedParagraph.sectionId);
  const wantedRevisionId =
    selectedParagraph.clickedRevisionId ||
    story?.current_revision_id ||
    story?.defaultVersionId ||
    null;

  const latest = variantHistory
    .filter(b => {
      const sameSectionIndex =
        Number.isInteger(b.sectionIndex) ? Number(b.sectionIndex) === Number(secIdx) : true;
      const sameSectionId = b.sectionId ? String(b.sectionId) === String(selectedParagraph.sectionId) : true;
      const sameParagraph = Number(b.paragraphIndex) === Number(selectedParagraph.index);

      // 👇 filtro anche per revisione, se il batch la espone
      const sameRevision =
        !wantedRevisionId || !b.revisionId
          ? true
          : String(b.revisionId) === String(wantedRevisionId);

      return sameSectionIndex && sameSectionId && sameParagraph && sameRevision;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  if (!latest || !Array.isArray(latest.variants)) return { batchId: null, items: [] };
  const items = latest.variants
    .map(v => ({ id: v.id, text: (typeof v.text === "string" ? v.text : "") }))
    .filter(v => v.text.trim().length);
  return { batchId: latest.id, items };
}


/* ───────────────── component ───────────────── */

export default function Stories(){
  const navigate = useNavigate();
  /* ---------- STATE & REFS (dichiarati prima dell’uso) ---------- */
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
  const [isRegenerating, setIsRegenerating] = useState(false);

  const [inlineVariantIndexByKey, setInlineVariantIndexByKey] = useState({}); // { "s1:0": 2, ... }
  const [appliedOverrides, setAppliedOverrides] = useState({}); // { "secId:idx": "testo scelto" }

  // chiavi "sectionId:paragraphIndex" che sono in rigenerazione
  const [busyParagraphKeys, setBusyParagraphKeys] = useState([]); // es: ["s1:0", "s3:2"]

  // stato per varianti (storico)
  const [variantHistory, setVariantHistory] = useState([]); // [{id, createdAt, variants:[{id,text,...}], ...}]
  const [variantLoading, setVariantLoading] = useState(false);
  const [variantError, setVariantError] = useState(null);
  const [activeRevisionId, setActiveRevisionId] = useState(null);

  // DOM refs per scroll e flash
  const storyHostRef = useRef(null);
  const sectionElsRef = useRef({});
  const flashTimersRef = useRef({});

  const prefersReducedMotion = typeof window !== "undefined"
    && window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 🔴 Selezionata la storia CORRENTE — **prima** di usarla altrove
  const selectedStory = useMemo(
    () => stories.find(s => s.id === selectedId),
    [stories, selectedId]
  );
  // quando carichi o cambi storia, punta alla sua revisione corrente
  useEffect(() => {
    if (selectedStory?.current_revision_id) {
      setActiveRevisionId(selectedStory.current_revision_id);
    } else if (selectedStory?.defaultVersionId) {
      setActiveRevisionId(selectedStory.defaultVersionId);
    } else {
      setActiveRevisionId(null);
    }
  }, [selectedStory?.id, selectedStory?.current_revision_id, selectedStory?.defaultVersionId]);


  /* ---------- MEMO/MSG che possono usare selectedStory ---------- */
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

  // ultimo batch per la selezione → alimenta il carosello inline di StoryView
  const lastBatchMemo = useMemo(() => {
    return lastBatchObjectsForSelection(selectedStory, variantHistory, selectedParagraph);
  }, [selectedStory, variantHistory, selectedParagraph, activeRevisionId]);
  

  /* ---------- EFFECTS ---------- */
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

  // Reset override/pending quando cambia versione corrente
  useEffect(() => {
    setAppliedOverrides({});
    setInlineVariantIndexByKey({});
    setSelectedParagraph(null);
    setCpStage("default");
  }, [selectedStory?.current_revision_id]);

  // (opzionale) reset anche quando cambi storia del tutto
  useEffect(() => {
    setAppliedOverrides({});
    setInlineVariantIndexByKey({});
  }, [selectedStory?.id]);

  /* ---------- VARIANTI: fetch storico per selezione ---------- */
// puoi passare esplicitamente la revisione “a cui appartiene” il paragrafo
async function refreshVariantsForSelection(story, sectionId, paragraphIndex, forcedRevisionId = null) {
  setVariantError(null);
  setVariantHistory([]);
  if (!story || paragraphIndex == null) return;

  const secIdx = sectionIndexById(story, sectionId);
  if (secIdx < 0) return;

  // 👇 se mi hai detto “questa è la revisione del paragrafo”, uso quella;
  // altrimenti cado nella globale
  const revisionToUse =
    forcedRevisionId ||
    activeRevisionId ||
    story?.current_revision_id ||
    story?.defaultVersionId ||
    null;

  setVariantLoading(true);
  try {
    const items = await getParagraphVariantsHistory({
      storyId: story.id,
      sectionIndex: secIdx,
      paragraphIndex,
      ...(revisionToUse ? { revisionId: revisionToUse } : {}),
    });
    setVariantHistory(items || []);
  } catch (e) {
    setVariantError(e?.message || "Failed loading paragraph variants.");
  } finally {
    setVariantLoading(false);
  }
}


  /* ---------- Utils UI ---------- */
  function keyFor(sectionId, index){ return `${sectionId}:${index}`; }

  function setInlineIndex(sectionId, index, variantIndex){
    setInlineVariantIndexByKey(prev => ({ ...prev, [keyFor(sectionId, index)]: variantIndex }));
  }

  const handleApplyInlineVariant = (secId, idx, text) => {
    const k = `${secId}:${idx}`;
    setAppliedOverrides(prev => ({ ...prev, [k]: String(text || "") }));
    setSelectedParagraph(p =>
      p && p.sectionId === secId && p.index === idx ? { ...p, text: String(text || "") } : p
    );
  };

  const openCPParagraphTab = () => {
    setCpStage("paragraph");
    if (!openCP) setOpenCP(true);
  };

  const closeCPOnAsyncStart = () => {
    setCpStage("default");
    setOpenCP(false);
  };

  function paraKey(sectionId, paragraphIndex){ return `${sectionId}:${paragraphIndex}`; }

  /* ---------- HANDLERS VARIANT ADOPTION ---------- */
  const handleApplyVariantPersist = useCallback(async (indexInBatch) => {
    if (!selectedStory || !selectedParagraph) return;

    const { batchId, items } = lastBatchMemo; // già filtrato su activeRevisionId
    if (!batchId || !items.length) return;

    const v = items[indexInBatch];
    if (!v?.id) return;

    try {
      const updated = await chooseParagraphVariant({
        storyId: selectedStory.id,
        batchId,
        variantId: v.id,
        baseRevisionId: activeRevisionId,
      });

      // ricarica versioni e sostituisci in stato
      let versions = [];
      try { versions = await getRevisions(selectedStory.id); } catch {}
      const withVersions = {
        ...updated,
        versions,
        defaultVersionId: updated?.current_revision_id || null,
      };
      setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));
      // punta alla nuova revisione corrente (quella appena aggiornata/applicata)
      if (withVersions?.current_revision_id) {
        setActiveRevisionId(withVersions.current_revision_id);
      }


      // aggiorna lo storico per mantenere il carosello coerente
      await refreshVariantsForSelection(
        withVersions,
        selectedParagraph.sectionId,
        selectedParagraph.index
      );

      // pulisci eventuale override locale su quel paragrafo
      setAppliedOverrides(prev => {
        const k = `${selectedParagraph.sectionId}:${selectedParagraph.index}`;
        const { [k]: _, ...rest } = prev;
        return rest;
      });

    } catch (e) {
      alert(e?.message || "Unable to adopt this variant.");
    }
  }, [
    selectedStory,
    selectedParagraph,
    variantHistory,
  ]);
  
  function handleSwitchRevision(revisionId) {
    // aggiorna lo stato della revisione attiva
    setActiveRevisionId(revisionId);
  
    // opzionale ma utile: pulisci selezione così non rimane un carosello sporco
    setSelectedParagraph(null);
    setVariantHistory([]);
    setVariantError(null);
  }
  
  async function handleChooseVariantFromHistory(batchId, variantId) {
    if (!selectedStory) return;
    try {
      const updated = await chooseParagraphVariant({
        storyId: selectedStory.id,
        batchId,
        variantId,
        baseRevisionId: activeRevisionId,
      });
      let versions = [];
      try { versions = await getRevisions(selectedStory.id); } catch {}
      const withVersions = {
        ...updated,
        versions,
        defaultVersionId: updated?.current_revision_id || null,
      };
      setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));

      if (selectedParagraph?.sectionId != null && selectedParagraph?.index != null) {
        await refreshVariantsForSelection(
          withVersions,
          selectedParagraph.sectionId,
          selectedParagraph.index,
          selectedParagraph.clickedRevisionId || activeRevisionId
        );
      }
    } catch (e) {
      alert(e?.message || "Unable to adopt this variant.");
    }
  }

  /* ---------- CRUD Stories ---------- */
  async function handleNew() {
    const s = await createStory(`Chat ${stories.length + 1}`);
    setStories(prev => [...prev, s]);
    setSelectedId(s.id);
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
      setVariantHistory([]);
      setVariantError(null);
      setVariantLoading(false);
      setAppliedOverrides({});
    }
  }

  /* ---------- UPDATE main (story/sections/paragraph) ---------- */
  async function handleUpdate(patch) {
    if (!selectedStory) return;

    if (patch?._action === "regenerate_story") {
      closeCPOnAsyncStart();
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

        const upstreamPrev = selectedStory?.meta?.upstreamParams || {};
        const temp  = (typeof patch.temp === "number") ? patch.temp : Number(upstreamPrev.temp ?? 0.0);
        const top_p = (typeof patch.top_p === "number") ? patch.top_p : Number(upstreamPrev.top_p ?? 0.9);

        const retrKnobs = {
          retriever:       upstreamPrev.retriever,
          retriever_model: upstreamPrev.retriever_model,
          k:               upstreamPrev.k,
          max_ctx_chars:   upstreamPrev.max_ctx_chars,
          seg_words:       upstreamPrev.seg_words,
          overlap_words:   upstreamPrev.overlap_words,
        };

        const adapted = await generateFromText({
          text: paperText,
          persona,
          limit_sections,
          temp,
          top_p,
          title: selectedStory?.title || selectedStory?.docTitle || "Paper",
          length_preset: patch.lengthPreset || "medium",
          ...(retrKnobs.retriever       !== undefined ? { retriever: retrKnobs.retriever }             : {}),
          ...(retrKnobs.retriever_model !== undefined ? { retriever_model: retrKnobs.retriever_model } : {}),
          ...(retrKnobs.k               !== undefined ? { k: retrKnobs.k }                             : {}),
          ...(retrKnobs.max_ctx_chars   !== undefined ? { max_ctx_chars: retrKnobs.max_ctx_chars }     : {}),
          ...(retrKnobs.seg_words       !== undefined ? { seg_words: retrKnobs.seg_words }             : {}),
          ...(retrKnobs.overlap_words   !== undefined ? { overlap_words: retrKnobs.overlap_words }     : {}),
        });

        const prevMeta = selectedStory?.meta || {};
        const nextMeta = {
          ...prevMeta,
          ...(adapted?.meta || {}),
          upstreamParams: {
            persona,
            temp,
            top_p,
            lengthPreset: patch.lengthPreset || "medium",
            limit_sections,
            ...(retrKnobs.retriever       !== undefined ? { retriever: retrKnobs.retriever }             : {}),
            ...(retrKnobs.retriever_model !== undefined ? { retriever_model: retrKnobs.retriever_model } : {}),
            ...(retrKnobs.k               !== undefined ? { k: retrKnobs.k }                             : {}),
            ...(retrKnobs.max_ctx_chars   !== undefined ? { max_ctx_chars: retrKnobs.max_ctx_chars }     : {}),
            ...(retrKnobs.seg_words       !== undefined ? { seg_words: retrKnobs.seg_words }             : {}),
            ...(retrKnobs.overlap_words   !== undefined ? { overlap_words: retrKnobs.overlap_words }     : {}),
            mode: "regen_from_text",
          },
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
        setAppliedOverrides({});
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

      closeCPOnAsyncStart();

      const baseRevisionId =
        activeRevisionId ||
        st?.current_revision_id ||
        st?.defaultVersionId ||
        null;

      // 👇 questi sono i KNOB CHE MANDIAMO AL BACKEND
      const oldUp = st?.meta?.upstreamParams || {};
      const knobs = {
        temp: Number(patch?.temp ?? oldUp?.temp ?? 0.0),
        lengthPreset: String(patch?.lengthPreset || oldUp?.lengthPreset || "medium"),
        top_p: Number(oldUp?.top_p ?? 0.9),
        retriever: oldUp?.retriever,
        retriever_model: oldUp?.retriever_model,
        k: oldUp?.k,
        max_ctx_chars: oldUp?.max_ctx_chars,
        seg_words: oldUp?.seg_words,
        overlap_words: oldUp?.overlap_words,
      };

      try {
        setBusySectionIds(sectionIds);

        const updatedFromServer = await regenerateSelectedSections(st.id, {
          sectionIds,
          ...(baseRevisionId ? { baseRevisionId } : {}),
          knobs,
          notes: patch?.notes || undefined,
        });

        // 👇 qui facciamo il MERGE invece di prendere 1:1
        const serverMeta = updatedFromServer?.meta || {};
        const prevMeta   = st?.meta || {};

        // 1) 
        const mergedUpstream = {
          ...oldUp,
          temp: knobs.temp,                       // ⬅️ forza il nuovo 0.7
          lengthPreset: knobs.lengthPreset,       // ⬅️ forza il nuovo "short"
          top_p: knobs.top_p,
          ...(serverMeta?.upstreamParams && typeof serverMeta.upstreamParams === "object"
            ? {
                ...(serverMeta.upstreamParams.retriever       != null ? { retriever: serverMeta.upstreamParams.retriever } : {}),
                ...(serverMeta.upstreamParams.retriever_model != null ? { retriever_model: serverMeta.upstreamParams.retriever_model } : {}),
                ...(serverMeta.upstreamParams.k               != null ? { k: serverMeta.upstreamParams.k } : {}),
                ...(serverMeta.upstreamParams.max_ctx_chars   != null ? { max_ctx_chars: serverMeta.upstreamParams.max_ctx_chars } : {}),
                ...(serverMeta.upstreamParams.seg_words       != null ? { seg_words: serverMeta.upstreamParams.seg_words } : {}),
                ...(serverMeta.upstreamParams.overlap_words   != null ? { overlap_words: serverMeta.upstreamParams.overlap_words } : {}),
              }
            : {}),
        };

        // 2) lastPartialRegen: questo invece è SEMPRE quello nuovo
        const lastPartialRegen = {
          targets: sectionIds,
          lengthPreset: knobs.lengthPreset,
          temp: knobs.temp,
          at: new Date().toISOString(),
        };

        const mergedMeta = {
          ...prevMeta,
          ...serverMeta,
          upstreamParams: mergedUpstream,
          lastPartialRegen,
        };

        const withMerged = {
          ...updatedFromServer,
          meta: mergedMeta,
        };
        const aggregates = deriveAggregatesFromSections(withMerged.sections, mergedMeta.upstreamParams || {});
        withMerged.meta = {
          ...withMerged.meta,
          currentAggregates: aggregates,
        };

        // ricarica versions
        let versions = [];
        try {
          versions = await getRevisions(st.id);
        } catch {}

        const withVersions = {
          ...withMerged,
          versions,
          defaultVersionId: withMerged?.current_revision_id || null,
        };

        setStories(prev =>
          prev.map(s => (s.id === withVersions.id ? withVersions : s))
        );

        if (withVersions?.current_revision_id) {
          setActiveRevisionId(withVersions.current_revision_id);
        }

        setCpStage("default");
        setSelectedParagraph(null);
        setSelectedSectionId(null);
      } catch (err) {
        console.error("regen_sections_vm failed", err);
        alert(err?.message || "Error during section regeneration.");
      } finally {
        setBusySectionIds([]);
        setAppliedOverrides({});
      }
      return;
    }


    if (patch?._action === "regen_paragraph_vm") {
      const st = selectedStory;
      if (!st) return;

      const sectionId = patch.sectionId;
      const paragraphIndex = Number(patch.paragraphIndex);
      if (sectionId === undefined || paragraphIndex === undefined || Number.isNaN(paragraphIndex)) {
        alert("Parametri mancanti per la rigenerazione del paragrafo.");
        return;
      }

      closeCPOnAsyncStart();

      const clickedRevId =
        selectedParagraph?.clickedRevisionId ||
        selectedParagraph?.baseRevisionId ||
        null;

      const baseRevisionId =
        clickedRevId ||
        activeRevisionId ||
        st?.current_revision_id ||
        st?.defaultVersionId ||
        null;

      closeCPOnAsyncStart();
      const k = paraKey(sectionId, paragraphIndex);
      setBusyParagraphKeys(prev => Array.from(new Set([ ...prev, k ])));

      try {
        const paragraphText = patch?.paragraphText || selectedParagraph?.text || "";
        const ops = patch?.ops || {};

        const res = await regenerateParagraphVm(st.id, {
          sectionId,
          paragraphIndex,
          paragraphText,
          ops,
          ...(baseRevisionId ? { baseRevisionId } : {}),
          notes: patch?.notes || "",
        });        

        // A) backend ritorna la story già aggiornata
        if (res && Array.isArray(res.sections)) {
          const aggregates = deriveAggregatesFromSections(
            res.sections,
            (res.meta && res.meta.upstreamParams) || (st.meta && st.meta.upstreamParams) || {}
          );
          const resWithAgg = {
            ...res,
            meta: {
              ...(res.meta || {}),
              currentAggregates: aggregates,
            },
          };
          let versions = [];
          try { versions = await getRevisions(st.id); } catch {}
          const withVersions = {
            ...resWithAgg,
            versions,
            defaultVersionId: resWithAgg?.current_revision_id || null,
          };
          setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));
          if (withVersions?.current_revision_id) {
             setActiveRevisionId(withVersions.current_revision_id);
          }

          // aggiorna storico varianti
          await refreshVariantsForSelection(withVersions, sectionId, paragraphIndex);
        }
        // B) backend ritorna solo alternative → applica la prima e salva
        else if (Array.isArray(res?.alternatives) && res.alternatives.length) {
          const choice = res.alternatives[0];
          const localApplied = applyParagraphReplacement(st, {
            sectionId, paragraphIndex, newText: String(choice || paragraphText),
          });
          if (localApplied) {
            const secIdx = sectionIndexById(localApplied, sectionId);
            let nextSections = localApplied.sections;
            if (secIdx >= 0) {
              nextSections = [...nextSections];
              nextSections[secIdx] = recomputeSectionFromParagraphs(nextSections[secIdx]);
            }
            const aggregates = deriveAggregatesFromSections(
              nextSections,
              (st.meta && st.meta.upstreamParams) || {}
            );
            const saved = await updateStory(st.id, {
              sections: nextSections,
              meta: {
                ...(st.meta || {}),
                upstreamParams: {
                  ...((st.meta && st.meta.upstreamParams) || {}),
                  mode: "regen_paragraph_vm",
                },
                currentAggregates: aggregates,
              },
              ...(patch.baseRevisionId ? { baseRevisionId: patch.baseRevisionId } : {}),
              ...(patch?.notes ? { notes: patch.notes } : {}),
            });
            let versions = [];
            try { versions = await getRevisions(st.id); } catch {}
            const withVersions = {
              ...saved,
              versions,
              defaultVersionId: saved?.current_revision_id || null,
            };
            setStories(prev => prev.map(s => (s.id === withVersions.id ? withVersions : s)));

            await refreshVariantsForSelection(withVersions, sectionId, paragraphIndex);
          }
        }

        // mantieni selezione per vedere le varianti
        setSelectedSectionId(sectionId);
        setSelectedParagraph({ sectionId, index: paragraphIndex, text: paragraphText });
      } catch (err) {
        console.error("regen_paragraph_vm failed", err);
        alert(err?.message || "Error during paragraph regeneration.");
      } finally {
        // ⬇️ Pulisci busy-paragrafo
        setBusyParagraphKeys(prev => prev.filter(x => x !== k));
        setAppliedOverrides({});
      }
      return;
    }

    // PATCH “normale”
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
      if (withVersions?.current_revision_id) {
         setActiveRevisionId(withVersions.current_revision_id);
      }
    } finally {
      setLoading(false);
    }
  }

  /* ---------- Selezioni UI ---------- */
  function handleToggleParagraph(sectionId, index, text) {
    const same =
      selectedParagraph &&
      selectedParagraph.sectionId === sectionId &&
      selectedParagraph.index === index;
  
    const nextSel = same
      ? null
      : {
          sectionId,
          index,
          text,
          clickedRevisionId:
            activeRevisionId ||
            selectedStory?.current_revision_id ||
            selectedStory?.defaultVersionId ||
            null,
        };
  
    const revForThisClick =
      nextSel?.clickedRevisionId ||
      activeRevisionId ||
      selectedStory?.current_revision_id ||
      selectedStory?.defaultVersionId ||
      null;
  
    if (!same && selectedStory) {
      // carica varianti per QUELLA revisione
      refreshVariantsForSelection(selectedStory, sectionId, index, revForThisClick);
    } else {
      setVariantHistory([]);
      setVariantError(null);
    }
  
    setSelectedParagraph(nextSel ? { ...nextSel, clickedRevisionId: revForThisClick } : null);
    setSelectedSectionId(sectionId);
    openCPParagraphTab();
  }  

  function handleSelectSection(sectionId) {
    setSelectedSectionId(prev => (prev === sectionId ? null : sectionId));
    setSelectedParagraph(null);
    setCpStage("default");
    setVariantHistory([]);
    setVariantError(null);
    if (!openCP) setOpenCP(true);
  }

  // ---- Locate on paper (calls backend) ----
async function locateSectionOnPaper({ story, sectionId, W = 3, topk = 8 }) {
  if (!story?.meta?.paperId) throw new Error("Missing meta.paperId");
  const secs = Array.isArray(story?.sections) ? story.sections : [];
  const idx = secs.findIndex((s, i) => String(s?.id ?? s?.sectionId ?? i) === String(sectionId));
  if (idx < 0) throw new Error("Invalid sectionId");
  const s = secs[idx] || {};

  // testo più robusto: paragraphs -> text -> narrative
  const sectionText =
    (Array.isArray(s.paragraphs) && s.paragraphs.join("\n\n")) ||
    (typeof s.text === "string" ? s.text : "") ||
    (typeof s.narrative === "string" ? s.narrative : "");

  const sectionTitle = typeof s.title === "string" ? s.title : "";

  // chiama il backend (niente storiesApi: fetch diretto qui)
  const res = await fetch(`${API_BASE}/api/locate_section`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paperId: story.meta.paperId,
      section_text: sectionText,
      section_title: sectionTitle,
      W,
      topk,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`locate_section failed (${res.status}): ${txt || "unknown error"}`);
  }
  const data = await res.json();

  // normalizza in highlights che il PdfViewer già capisce: [{ page, rects: [[x1,y1,x2,y2], ...] }]
  if (!data?.best?.page || !Array.isArray(data?.best?.bbox)) {
    // fallback minimale
    return {
      initialPage: 1,
      highlights: [{ page: 1, rects: [[0.10, 0.18, 0.90, 0.30]] }],
      alternatives: [],
    };
  }

  const bestPage = Number(data.best.page) || 1;
  const bestRect = Array.isArray(data.best.bbox) ? data.best.bbox.slice(0, 4) : [0.10, 0.18, 0.90, 0.30];

  const alternatives = Array.isArray(data.alternatives)
    ? data.alternatives
        .filter(a => a?.page && Array.isArray(a?.bbox))
        .map(a => ({ page: Number(a.page), rects: [a.bbox.slice(0, 4)] }))
    : [];

  return {
    initialPage: bestPage,
    highlights: [{ page: bestPage, rects: [bestRect] }],
    alternatives,
    meta: data?.meta || {},
  };
}

  /* ---------- PDF helpers ---------- */
  function randomHighlight() {
    const w = 0.70 + Math.random() * 0.10;
    const h = 0.045 + Math.random() * 0.015;
    const x = 0.10 + Math.random() * 0.06;
    const y = 0.20 + Math.random() * (0.75 - h);
    return [{ x, y, w, h }];
  }

  const handleReadOnPaper = async ({ sectionId } = {}) => {
    const url =
      selectedStory?.meta?.paperUrl ||
      selectedStory?.meta?.pdfUrl ||
      (selectedStory?.meta?.paperId ? `${API_BASE}/api/papers/${selectedStory.meta.paperId}/pdf` : null);

    if (!url) { alert("No PDF set for this story (meta.paperUrl)."); return; }
  
    try {
      // chiama il backend per trovare la pagina/box migliore
      const located = await locateSectionOnPaper({ story: selectedStory, sectionId, W: 3, topk: 8 });
  
      // se hai una double-side view dedicata via /reader, passa tutto allo state
      navigate("/reader", {
        state: {
          storyId: selectedStory?.id,
          sectionId,
          pdfUrl: url,
          initialPage: located.initialPage,
          highlights: located.highlights,          // [{ page, rects: [[x1,y1,x2,y2]] }]
          altHighlights: located.alternatives || [],// opzionale: alternative match
          locateMeta: located.meta || {},
        }
      });
  
      // Se invece vuoi aprire inline il PdfViewer in questa pagina, decommenta:
      // setShowPdf(true);
      // setPdfError(null);
      // setPdfHighlights(located.highlights);
  
    } catch (e) {
      console.error(e);
      // fallback: heuristics già presenti
      const secs = Array.isArray(selectedStory?.sections) ? selectedStory.sections : [];
      const idx = secs.findIndex((s, i) => String(s?.id ?? s?.sectionId ?? i) === String(sectionId));
      const sectionIndex = idx >= 0 ? idx : 0;
  
      const pageFromMeta =
        selectedStory?.meta?.anchorsBySectionId?.[sectionId]?.page ??
        secs?.[sectionIndex]?.page ??
        selectedStory?.meta?.docparse?.sections?.[sectionIndex]?.page ??
        selectedStory?.meta?.docparse?.pages_map?.[secs?.[sectionIndex]?.title || ""] ??
        1;
  
      const initialPage = Math.max(1, parseInt(pageFromMeta, 10) || 1);
      const fallbackHeaderRect = [[0.10, 0.18, 0.90, 0.12]];
  
      navigate("/reader", {
        state: {
          storyId: selectedStory?.id,
          sectionId,
          pdfUrl: url,
          initialPage,
          highlights: [{ page: initialPage, rects: fallbackHeaderRect }],
          altHighlights: [],
          locateMeta: { reason: "fallback" },
        }
      });
    }
  };
  

  const handleContinueNotes  = () => { setCpStage("notes"); };
  const handleContinueGlobal = () => { setSelectedParagraph(null); setSelectedSectionId(null); setCpStage("notes"); };

  /* ---------- Scroll helpers ---------- */
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

  /* ---------- Badge conteggio varianti ---------- */
  const variantCounts = useMemo(() => {
    if (!selectedParagraph) return null;
    const key = `${selectedParagraph.sectionId}:${selectedParagraph.index}`;
    const count = (variantHistory || [])
      .filter(b => !activeRevisionId || String(b.revisionId) === String(activeRevisionId))
      .reduce(
        (acc, b) => acc + (Array.isArray(b.variants) ? b.variants.length : 0),
      0
    );
    return { [key]: count };
  }, [variantHistory, selectedParagraph, activeRevisionId]);

  /* ---------- RENDER ---------- */
  const SIDEBAR_W = 300;
  const PANEL_W   = 380;
  const pdfUrl = selectedStory?.meta?.paperUrl || selectedStory?.meta?.pdfUrl || null;
  const showLoadingPage = loading || isRegenerating;

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
          setVariantHistory([]);
          setVariantError(null);
          setVariantLoading(false);
          setAppliedOverrides({});
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
        loading={false}
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
                page={pdfHighlights?.[0]?.page ?? 1}
                scale={1.35}
                highlights={pdfHighlights}
                onError={() => { setPdfError(true); setShowPdf(false); }}
              />            
            ) : (
              <StoryView
                story={selectedStory}
                selectedParagraph={selectedParagraph}
                selectedSectionId={selectedSectionId}
                variants={lastBatchMemo.items}
                onToggleParagraph={(secId, idx, originalText) => {
                  handleToggleParagraph(secId, idx, originalText);
                }}
                onSelectSection={handleSelectSection}
                onRegisterSectionEl={handleRegisterSectionEl}
                busySectionIds={busySectionIds}
                busyParagraphKeys={busyParagraphKeys}
                onOpenCPForParagraph={() => openCPParagraphTab()}
                // indice del carosello + setter
                inlineVariantIndex={
                  selectedParagraph
                    ? (inlineVariantIndexByKey[keyFor(selectedParagraph.sectionId, selectedParagraph.index)] || 0)
                    : 0
                }
                onSetInlineVariantIndex={(nextIndexOrUpdater) => {
                  if (!selectedParagraph) return;

                  const secId = selectedParagraph.sectionId;
                  const idx   = selectedParagraph.index;
                  const items = lastBatchMemo.items || [];

                  const currentIndex =
                    inlineVariantIndexByKey[keyFor(secId, idx)] || 0;

                  const nextIndex = (typeof nextIndexOrUpdater === "function")
                    ? nextIndexOrUpdater(currentIndex)
                    : nextIndexOrUpdater;

                  // salva l’indice
                  setInlineIndex(secId, idx, nextIndex);

                  // 🔄 aggiorna il testo mostrato nel Control Panel usando LE STESSE items del carosello
                  const choice = items[nextIndex];
                  const text = (typeof choice === "string") ? choice : (choice?.text ?? "");
                  if (text) {
                    setSelectedParagraph(p =>
                      p && p.sectionId === secId && p.index === idx
                        ? { ...p, text, clickedRevisionId: p.clickedRevisionId }
                        : p
                    );                    
                  }
                }}
                onPersistInlineVariant={handleApplyVariantPersist}
                appliedOverrides={appliedOverrides}
                onApplyInlineVariant={handleApplyInlineVariant}
                variantCounts={variantCounts}
                onReadOnPaper={handleReadOnPaper}
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

          <ControlPanel
            open={openCP}
            story={selectedStory}
            selectedParagraph={selectedParagraph}
            cpStage={cpStage}
            onContinueNotes={handleContinueNotes}
            onContinueGlobal={handleContinueGlobal}
            onReadOnPaper={handleReadOnPaper}
            onChange={handleUpdate}
            onJumpToSection={handleScrollToSection}
            onClosePanel={() => setOpenCP(false)}
            onGenerateAlternatives={({ sectionId, paragraphIndex, ops, notes }) => {
              closeCPOnAsyncStart();
              return handleUpdate({
                _action: "regen_paragraph_vm",
                sectionId,
                paragraphIndex,
                ops,
                notes,
              });
            }}
            onSwitchRevision={handleSwitchRevision}
          />
        </>
      )}
    </div>
  );
}
