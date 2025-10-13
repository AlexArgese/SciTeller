import { useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import styles from "./ControlPanel.module.css";
export default function ControlPanel({
  open,
  story,
  selectedParagraph,
  cpStage = "default",
  onContinueNotes,
  onContinueGlobal,
  onReadOnPaper,
  onChange,
  onJumpToSection,
  onClosePanel,
}) {
  const [scope, setScope] = useState("story"); // story | sections | paragraph
  useEffect(() => { setScope("story"); }, [story?.id]);

  const PILL_PAD = 12;   
  const MIN_W_SAFE = 40;  
  const SUSPICIOUS_W = 6;  
  const MAX_RETRY = 6;     

  // Scope indicator (Story/Sections/Paragraph)
  const scopeTabsRef = useRef(null);
  const scopeIndicatorRef = useRef(null);
  const scopePosRef = useRef({ x: 0, w: 0 });
  const [scopeReady, setScopeReady] = useState(false); 

  // Tabs indicator (Modify/Info/Versions/Export)
  const tabsRef = useRef(null);
  const indicatorRef = useRef(null);
  const posRef = useRef({ x: 0, w: 0 });
  const [cpReady, setCpReady] = useState(false);

  const measureGeneric = (host, activeSel, labelSel, indicatorEl) => {
    if (!host || !indicatorEl) return null;

    const active = host.querySelector(activeSel) || host.querySelector(labelSel);
    if (!active) return null;

    // se non è layouted (display:none o fuori DOM), rimandiamo
    if (active.offsetParent === null) return null;

    const label = active; // i bottoni sono l’elemento misurabile
    const c = host.getBoundingClientRect();
    const r = label.getBoundingClientRect();

    const textX = Math.round(r.left - c.left);
    const textW = Math.max(label.clientWidth || 0, Math.round(r.width));
    if (textW <= SUSPICIOUS_W) return null;

    const pillH = Math.max(indicatorEl.offsetHeight || 0, MIN_W_SAFE);
    const w = Math.max(textW + PILL_PAD * 2, pillH);
    const x = Math.max(0, textX - PILL_PAD);

    return { x, w };
  };

  // Costruisce un layout semplice a corsie per la timeline versioni.
  // versions: [{id, createdAt, meta:{ parentRevisionId? }, notes, persona, ...}]
  function layoutVersionGraph(versions, { trunkId = null } = {}) {
    // Ordine temporale (dalla più vecchia alla più nuova)
    const sorted = [...versions].sort((a,b)=> new Date(a.createdAt) - new Date(b.createdAt));
    const byId = new Map(sorted.map(v => [v.id, v]));
    const laneOf = new Map();          // id -> lane index
    const lastLaneUse = [];            // lane -> last revision id on that lane

    function firstFreeLane(excludeLane = null){
      for (let i=0; i<lastLaneUse.length; i++){
        if (i !== excludeLane && lastLaneUse[i] == null) return i;
      }
      // se nessuna libera, aggiungi una nuova corsia
      lastLaneUse.push(null);
      return lastLaneUse.length - 1;
    }

    function idsToIndexes(sections, ids) {
      const idxs = [];
      const byId = new Map(
        (sections || []).map((s, i) => [String(s.id ?? s.sectionId ?? i), i])
      );
      for (const id of ids || []) {
        const key = String(id);
        if (byId.has(key)) idxs.push(byId.get(key));
      }
      // preserva l’ordine visivo
      return idxs.sort((a, b) => a - b);
    }
    

    const out = [];
    for (const v of sorted) {
      const parentId = v?.meta?.parentRevisionId || null;
      const parentLane = parentId ? laneOf.get(parentId) ?? null : null;

      // regola: se ha un parent e la lane del parent è libera, prova a riusar la stessa
      // altrimenti piglia la prima lane libera diversa dal parent.
      let lane;
      if (parentId && parentLane != null && lastLaneUse[parentLane] === parentId) {
        lane = parentLane;
      } else {
        lane = firstFreeLane(parentLane);
      }

      laneOf.set(v.id, lane);
      lastLaneUse[lane] = v.id;

      // depth = hop-count fino alla root (solo per info/evidenziazione)
      let depth = 0, cur = v;
      while (cur?.meta?.parentRevisionId && byId.has(cur.meta.parentRevisionId)) {
        depth++; cur = byId.get(cur.meta.parentRevisionId);
      }

      const isBranch = !!(v?.meta?.parentRevisionId && (!trunkId || v.meta.parentRevisionId !== trunkId));

      out.push({
        ...v,
        lane,
        depth,
        isBranch,
      });
    }
    // vuoi vedere la più recente in alto:
    out.sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
    return out;
  }

  function findSectionById(sections, id) {
    const byId = new Map((sections||[]).map((s,i)=>[ String(s?.id ?? s?.sectionId ?? i), s ]));
    return byId.get(String(id)) || null;
  }  

  const measureScopeTarget = () => {
    return measureGeneric(
      scopeTabsRef.current,
      `.${styles.scopeBtn}.${styles.scopeActive}`,
      `.${styles.scopeBtn}`,
      scopeIndicatorRef.current
    );
  };

  const measureTarget = () => {
    return measureGeneric(
      tabsRef.current,
      `.${styles.tab}.${styles.active}`,
      `.${styles.tab}`,
      indicatorRef.current
    );
  };

  // === BLOB PATCH: posizionamento immediato (no anim) + ready flag
  const placeScopeNow = () => {
    const el = scopeIndicatorRef.current;
    const t = measureScopeTarget();
    if (!el || !t) return false;
    el.getAnimations().forEach(a => a.cancel());
    el.style.transform = `translate3d(${t.x}px, -50%, 0)`;
    el.style.width = `${t.w}px`;
    scopePosRef.current = t;
    if (!scopeReady) setScopeReady(true);
    return true;
  };

  const placeCpNow = () => {
    const el = indicatorRef.current;
    const t = measureTarget();
    if (!el || !t) return false;
    el.getAnimations().forEach(a => a.cancel());
    el.style.transform = `translate3d(${t.x}px, -50%, 0)`;
    el.style.width = `${t.w}px`;
    posRef.current = t;
    if (!cpReady) setCpReady(true);
    return true;
  };

  // retry after paint (doppio RAF + backoff fino MAX_RETRY)
  const placeScopeAfterPaint = (retries = MAX_RETRY) => {
    const tryPlace = () => {
      const ok = placeScopeNow();
      if (!ok && retries > 0) requestAnimationFrame(() => placeScopeAfterPaint(retries - 1));
    };
    requestAnimationFrame(() => requestAnimationFrame(tryPlace));
  };

  const placeCpAfterPaint = (retries = MAX_RETRY) => {
    const tryPlace = () => {
      const ok = placeCpNow();
      if (!ok && retries > 0) requestAnimationFrame(() => placeCpAfterPaint(retries - 1));
    };
    requestAnimationFrame(() => requestAnimationFrame(tryPlace));
  };

  function cap(s){ return (String(s||"").charAt(0).toUpperCase() + String(s||"").slice(1)); }
  function summarizeLastPartialRegen(story){
    const lpr = story?.meta?.lastPartialRegen;
    if (!lpr) return null;

    const secs = Array.isArray(story?.sections) ? story.sections : [];
    const secCount = secs.length;

    // targets sono indici 0-based salvati dal server
    const idxs = (lpr.targets || [])
      .map(n => Number(n))
      .filter(n => Number.isInteger(n) && n >= 0 && n < secCount);

    const names = idxs.map(i => secs[i]?.title?.trim() || `Section ${i+1}`);
    return {
      preset: String(lpr.lengthPreset || "medium"),
      temp: Number(lpr.temp ?? 0),
      sections: names,
      at: lpr.at ? new Date(lpr.at) : null,
    };
  }

  /* ================== INIT POSIZIONE (no animazione) ================== */
  // Scope indicator — init dopo il primo paint stabile
  useLayoutEffect(() => {
    if (!open) return;
    placeScopeAfterPaint();
    document?.fonts?.ready?.then(() => placeScopeAfterPaint()).catch(() => {});
  }, [open, story?.id]);

  // Tabs indicator — init dopo il primo paint stabile
  useLayoutEffect(() => {
    if (!open) return;
    placeCpAfterPaint();
    document?.fonts?.ready?.then(() => placeCpAfterPaint()).catch(() => {});
  }, [open]);


  /* ================== ANIMAZIONI SU CAMBIO STATO ================== */
  // Scope indicator — anima su cambio "scope"
  useEffect(() => {
    const el = scopeIndicatorRef.current;
    if (!el) return;
    const next = measureScopeTarget();
    if (!next) { placeScopeAfterPaint(); return; }

    const from = scopePosRef.current;
    const to = next;
    if (from.x === to.x && from.w === to.w) {
      if (!scopeReady) setScopeReady(true);
      return;
    }

    el.getAnimations().forEach(a => a.cancel());
    el.style.transform = `translate3d(${from.x}px, -50%, 0)`;
    el.style.width = `${from.w}px`;
    // reflow
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const duration = prefersReduced ? 0 : 380;
    const easing = "cubic-bezier(.22,.61,.36,1)";

    const anim = el.animate(
      [
        { transform: `translate3d(${from.x}px, -50%, 0)`, width: `${from.w}px` },
        { transform: `translate3d(${to.x}px, -50%, 0)`,   width: `${to.w}px` }
      ],
      { duration, easing, fill: "forwards" }
    );

    const blob = el.firstElementChild;
    if (blob && duration > 0) {
      blob.getAnimations().forEach(a => a.cancel());
      blob.animate(
        [
          { transform: "scaleX(.9)" },
          { transform: "scaleX(1.06)", offset: 0.45 },
          { transform: "scaleX(1)" }
        ],
        { duration: 480, easing: "cubic-bezier(.22,.75,.16,1)", fill: "both" }
      );
    }

    anim.onfinish = () => {
      el.style.transform = `translate3d(${to.x}px, -50%, 0)`;
      el.style.width = `${to.w}px`;
      scopePosRef.current = to;
      if (!scopeReady) setScopeReady(true);
    };
  }, [scope, scopeReady]);


  // Tabs indicator — anima su cambio tab
  const [tab, setTab] = useState("modify");
  useEffect(() => { if (!story && tab !== "info") setTab("info"); }, [story, tab]);

  useEffect(() => {
    const el = indicatorRef.current;
    if (!el) return;
    const next = measureTarget();
    if (!next) { placeCpAfterPaint(); return; }

    const from = posRef.current;
    const to = next;
    if (from.x === to.x && from.w === to.w) {
      if (!cpReady) setCpReady(true);
      return;
    }

    el.getAnimations().forEach(a => a.cancel());
    el.style.transform = `translate3d(${from.x}px, -50%, 0)`;
    el.style.width = `${from.w}px`;
    // reflow
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const duration = prefersReduced ? 0 : 420;
    const easing = "cubic-bezier(.22,.61,.36,1)";

    const anim = el.animate(
      [
        { transform: `translate3d(${from.x}px, -50%, 0)`, width: `${from.w}px` },
        { transform: `translate3d(${to.x}px, -50%, 0)`,   width: `${to.w}px` }
      ],
      { duration, easing, fill: "forwards" }
    );

    const blob = el.firstElementChild;
    if (blob && duration > 0) {
      blob.getAnimations().forEach(a => a.cancel());
      blob.animate(
        [
          { transform: "scaleX(.92)" },
          { transform: "scaleX(1.06)", offset: 0.45 },
          { transform: "scaleX(1)" }
        ],
        { duration: 520, easing: "cubic-bezier(.22,.75,.16,1)", fill: "both" }
      );
    }

    anim.onfinish = () => {
      el.style.transform = `translate3d(${to.x}px, -50%, 0)`;
      el.style.width = `${to.w}px`;
      posRef.current = to;
      if (!cpReady) setCpReady(true);
    };
  }, [tab, cpReady]);


  /* ================== RIALLINEI SU RESIZE / FONT ================== */
  useEffect(() => {
    const syncScope = () => placeScopeNow();
    window.addEventListener("resize", syncScope);
    document?.fonts?.ready?.then(syncScope).catch(() => {});
    return () => window.removeEventListener("resize", syncScope);
  }, []);

  useEffect(() => {
    const syncTabs = () => placeCpNow();
    window.addEventListener("resize", syncTabs);
    document?.fonts?.ready?.then(syncTabs).catch(() => {});
    return () => window.removeEventListener("resize", syncTabs);
  }, []);


  /* ================== STATO ESISTENTE (invariato) ================== */
  const sections = useMemo(() => Array.isArray(story?.sections) ? story.sections : [], [story]);
  const defaultsForInfo = useMemo(() => defaultKnobsFromMeta(story?.meta), [story?.id, story?.meta]);
  const aggForInfo = useMemo(() => aggregateStoryKnobs(sections, defaultsForInfo), [sections, defaultsForInfo]);
  const personaDefault = story?.persona || story?.meta?.persona || "Student";
  const tempDefault = getCreativity(story?.meta);           // 0..1
  const lengthPresetDefault = getLengthPreset(story?.meta);  // "short|medium|long"



  
  const lpFromMeta = story?.meta?.upstreamParams?.lengthPreset;
  const [lengthPreset, setLengthPreset] = useState(lpFromMeta || "medium");
  useEffect(() => {
    setLengthPreset(lpFromMeta || "medium");
  }, [story?.id, lpFromMeta]);  

  const [storyPersona, setStoryPersona] = useState(personaDefault);
  const [storyTemp,    setStoryTemp]    = useState(Number(tempDefault) || 0);

  const [selectedSectionIds, setSelectedSectionIds] = useState([]);
  const [sectionTemp, setSectionTemp] = useState(storyTemp);

  useEffect(() => {
    const secs = Array.isArray(sections) ? sections : [];
    if (selectedSectionIds.length === 1) {
      const sel = findSectionById(secs, selectedSectionIds[0]);
      const effLen = (sel?.lengthPreset) || (story?.meta?.upstreamParams?.lengthPreset) || "medium";
      const effTmp = (typeof sel?.temp === "number") ? sel.temp : (Number(tempDefault) || 0);
      setLengthPreset(String(effLen));
      setSectionTemp(Number(effTmp));
    } else {
      const lp = story?.meta?.upstreamParams?.lengthPreset || "medium";
      setLengthPreset(lp);
      setSectionTemp(Number(tempDefault) || 0);
    }
  }, [selectedSectionIds, story?.id, sections.length, tempDefault]);  

  useEffect(() => {
    setStoryPersona(personaDefault);
    setStoryTemp(Number(tempDefault) || 0);
  }, [personaDefault, tempDefault, story?.id]);
  
  useEffect(() => {
    setSelectedSectionIds([]);
    setSectionTemp(storyTemp);
  }, [story?.id, storyTemp]);
  

  function toggleSectionSelection(id) {
    setSelectedSectionIds(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  }
  function selectAllSections(){ setSelectedSectionIds(sections.map((s,i)=>s.id ?? s.sectionId ?? String(i))); }
  function clearSections(){ setSelectedSectionIds([]); }

  const hasParagraphSelected = !!selectedParagraph;
  const [pOps, setPOps] = useState({ paraphrase:true, simplify:false, lengthOp:"keep", temp:storyTemp, n:1 });
  useEffect(() => { setPOps(p=>({ ...p, temp:storyTemp, n:clampN(p.n) })); },
    [selectedParagraph?.sectionId, selectedParagraph?.index, story?.id, storyTemp]);

  const [pendingAction, setPendingAction] = useState(null); // {type, payload}
  const [notes, setNotes] = useState("");
  const minNotesChars = 12;

  function suggestNotes(action){
    const title = story?.title || story?.docTitle || "Current story";
    if (!action) return `Update "${title}".`;
    if (action.type === "story") {
      const lp = action.payload.lengthPreset || "medium";
      return `Regenerate ENTIRE story "${title}" as persona ${action.payload.persona}, creativity = ${action.payload.temp * 100}% and length per section = ${lp}.`;
    }    
    if (action.type === "sections") {
      const names = action.payload.sectionIds.map(id=>{
        const s = sections.find(ss => (ss.id ?? ss.sectionId ?? "") === id);
        return s?.title || `Section ${id}`;
      }).join(", ");
    
      // knobs passati dal pannello (già coerenti quando più sezioni)
      let effTemp = action.payload.temp;
      let effLP   = action.payload.lengthPreset;
    
      // se UNA sola sezione, prova a leggere override per-sezione
      if (action.payload.sectionIds.length === 1) {
        const sel = findSectionById(sections, action.payload.sectionIds[0]);
        if (typeof sel?.temp === "number") effTemp = sel.temp;
        if (sel?.lengthPreset) effLP = sel.lengthPreset;
      }

      // ✅ FIX: percentuale come numero reale (non su stringa)
      const tempPct = Number.isFinite(effTemp) ? Math.round(effTemp * 100) : null;
      return `Regenerate SECTIONS (${names}) with creativity = ${tempPct != null ? tempPct + "%" : "-"} and length per section = ${effLP}.`;
    }    
    if (action.type === "paragraph" && selectedParagraph) {
      const s = sections.find(ss => (ss.id ?? ss.sectionId) === selectedParagraph.sectionId);
      const secName = s?.title || "Selected section";
      const ops = [];
      if (action.payload.paraphrase) ops.push("paraphrase");
      if (action.payload.simplify) ops.push("simplify");
      if (action.payload.lengthOp !== "keep") ops.push(action.payload.lengthOp);
      ops.push(`temp=${action.payload.temp}`);
      ops.push(`${action.payload.n} alt`);
      return `Regenerate PARAGRAPH (${secName}, ¶${selectedParagraph.index + 1}): ${ops.join(", ")}.`;
    }
    return `Update "${title}".`;
  }

  useEffect(() => {
    if (cpStage === "notes" && pendingAction && !notes.trim()) {
      setNotes(suggestNotes(pendingAction));
    }
  }, [cpStage, pendingAction]); // eslint-disable-line

  function openNotes(action, global=false){
    setPendingAction(action);
    setNotes(suggestNotes(action));
    (global ? onContinueGlobal : onContinueNotes)?.();
  }

  async function submitWithNotes(){
    if (!pendingAction || !onChange) return;

    // Caso SEZIONI: deleghiamo tutto a Stories.jsx (mapping IDs→targets + API call)
    if (pendingAction.type === "sections") {
      await onChange({
        _action: "regenerate_sections",
        scope: "sections",
        sectionIds: pendingAction.payload.sectionIds,
        temp: clamp01(pendingAction.payload?.temp ?? sectionTemp),
        lengthPreset,
        notes: notes.trim(),
        storyId: story?.id,
      });
      setPendingAction(null);
      setNotes("");
      onClosePanel?.();
      return;
    }

    // Altri casi: lasciamo la pipeline esistente al parent
    const payload = {
      _action: mapActionToCommand(pendingAction),
      scope: pendingAction.type,
      ...pendingAction.payload,
      notes: notes.trim(),
      storyId: story?.id,
    };
    await onChange(payload);
    setPendingAction(null);
    onClosePanel?.();
    setNotes("");
  }


  const versions = Array.isArray(story?.versions) ? story.versions : [];
  const defaultVersionId = story?.defaultVersionId || story?.meta?.defaultVersionId || null;
  async function setDefaultVersion(id){ if (onChange) await onChange({ defaultVersionId: id }); }
  async function openVersion(id){ if (onChange) await onChange({ currentVersionId: id, _action: "open_version" }); }
  

  const [exportFormat, setExportFormat]   = useState("markdown");
  const [exportHeader, setExportHeader]   = useState(true);
  const [exportMedia,  setExportMedia]    = useState(false);
  const [exportMeta,   setExportMeta]     = useState(true);
  const [exportSectionIds, setExportSectionIds] = useState(()=>sections.map((s,i)=>s.id ?? s.sectionId ?? String(i)));
  useEffect(()=>{ setExportSectionIds(sections.map((s,i)=>s.id ?? s.sectionId ?? String(i))); }, [story?.id, sections.length]);
  function toggleExportSection(id){
    setExportSectionIds(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  }
  function handleExportClient(){
    if (!story) return;
    const selSections = sections.filter((s,i)=>{
      const id = s.id ?? s.sectionId ?? String(i);
      return exportSectionIds.includes(id);
    });
    const payload = buildExportPayload(story, selSections, { header: exportHeader, media: exportMedia, meta: exportMeta });
    if (exportFormat === "markdown") {
      const md = renderMarkdown(payload);
      downloadFile(slugify(payload.fileBase)+".md", "text/markdown;charset=utf-8", md);
    } else if (exportFormat === "html") {
      const html = renderHTML(payload);
      downloadFile(slugify(payload.fileBase)+".html", "text/html;charset=utf-8", html);
    } else if (exportFormat === "pdf") {
      const html = renderPrintableHTML(payload);
      const w = window.open("", "_blank");
      if (!w) return alert("Popup blocked by the browser.");
      w.document.open(); w.document.write(html); w.document.close();
      setTimeout(()=>{ try { w.print(); } catch {} }, 300);
    }
  }

  function getLengthPreset(meta){
    const p = meta?.upstreamParams?.lengthPreset;
    if (p) return p;                       // preferisci preset salvato
    const words = Number(meta?.lengthPerSection); // p.es. explain: 150
    if (isFinite(words)) {
      if (words <= 120) return "short";
      if (words >= 200) return "long";
      return "medium";
    }
    return "medium";
  }
  
  function getCreativity(meta){
    if (meta?.upstreamParams?.temp != null) return Number(meta.upstreamParams.temp); // 0..1
    if (typeof meta?.creativity === "number") return Number(meta.creativity) / 100; // explain: 0..100
    return 0.0;
  }

  function defaultKnobsFromMeta(meta){
    const up = meta?.upstreamParams || {};
    return {
      lengthPreset: String(up.lengthPreset || "medium"),
      temp: Number(up.temp ?? 0.5),
    };
  }

  function sectionKnobs(section, defaults){
    const temp = (typeof section?.temp === "number") ? section.temp : defaults.temp;
    const lengthPreset = section?.lengthPreset || defaults.lengthPreset;
    return { temp, lengthPreset };
  }

  function aggregateStoryKnobs(sections, defaults){
    const items = (sections || [])
      .filter(s => s?.visible !== false)
      .map(s => sectionKnobs(s, defaults));

    const temps = items.map(i => i.temp).filter(n => Number.isFinite(n));
    const avgTemp = temps.length ? (temps.reduce((a,b)=>a+b,0) / temps.length) : defaults.temp;

    const lengths = items.map(i => i.lengthPreset).filter(Boolean);
    const uniq = Array.from(new Set(lengths));
    const aggLength = (uniq.length === 1) ? uniq[0] : "mix";

    return { temp: avgTemp, lengthPreset: aggLength };
  }

  // ✅ FIX ROBUSTEZZA: gli aggregati “Info → Story” ignorano i fallback globali
  // quando calcolano le medie/etichette, così la rigenerazione parziale non
  // inquina i valori globali. Usiamo solo override espliciti; se assenti, fallback.
  function computeStoryAggregates(story, fallbackLength, fallbackTemp){
    const sectionsAll = Array.isArray(story?.sections) ? story.sections : [];
    const sections = sectionsAll.filter(s => s?.visible !== false);

    const baseLP   = fallbackLength || "medium";
    const baseTemp = Number(fallbackTemp ?? 0) || 0;

    // length preset: usa SOLO override espliciti; se nessuno, fallback
    const explicitLPs = sections
      .map(s => s?.lengthPreset)
      .filter(lp => typeof lp === "string" && lp.trim().length > 0);

    let lengthLabel;
    if (explicitLPs.length === 0) {
      lengthLabel = baseLP.replace(/^\w/, c => c.toUpperCase());
    } else {
      const allSame = explicitLPs.every(lp => lp === explicitLPs[0]);
      lengthLabel = allSame
        ? explicitLPs[0].replace(/^\w/, c => c.toUpperCase())
        : "Mix";
    }

    // creatività media: usa SOLO s.temp espliciti; se nessuno, fallback
    const explicitTemps = sections
      .map(s => (typeof s?.temp === "number" ? s.temp : undefined))
      .filter(t => Number.isFinite(t));

    const avgTemp = explicitTemps.length
      ? (explicitTemps.reduce((a,b)=>a+b,0) / explicitTemps.length)
      : baseTemp;

    return { lengthLabel, avgTemp };
  }  
  
  /* ---------- RENDER ---------- */

  if (cpStage === "notes" && pendingAction) {
    return (
      <aside className={`${styles.panel} ${styles.open}`}>
        <div className={styles.header}>
          <div className={styles.titleBlock}>
            <div className={styles.panelTitle}>Control Panel</div>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.noteHint}>
            Notes are required. Min {minNotesChars} characters.
          </div>
          <textarea className={styles.textarea} rows={8} value={notes} onChange={e=>setNotes(e.target.value)}/>
          <span className={notes.trim().length >= minNotesChars ? styles.ok : styles.warn}>
              {notes.trim().length}/{minNotesChars}
          </span>
          <div className={styles.noteFooter}>
          <div className={styles.noteBtns}>
              <button className={styles.ghostBtn} onClick={()=>setNotes(suggestNotes(pendingAction))}>Auto</button>
              <button className={styles.ghostBtn} onClick={()=>{ setPendingAction(null); setNotes(""); }}>Back</button>
          </div>
            <button className={styles.primary} onClick={submitWithNotes} disabled={notes.trim().length < minNotesChars}>
              Continue
            </button>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className={`${styles.panel} ${styles.open}`}>
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <div className={styles.panelTitle}>Control Panel</div>
          {/* Tabs con indicatore vetroso */}
          <div className={styles.tabs} ref={tabsRef}>
          <span
              className={`${styles.cpIndicator} ${cpReady ? styles.indicatorReady : ""}`}
              ref={indicatorRef}
              aria-hidden="true"
            />
            {["modify","info","history","export"].map(t=>(
              <button
                key={t}
                className={`${styles.tab} ${tab===t?styles.active:""}`}
                onClick={()=>setTab(t)}
                type="button"
              >
                {t === "history" ? "Versions" : t[0].toUpperCase()+t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* MODIFY */}
      {tab==="modify" && (
        <div className={styles.scroll}>
          <div className={styles.scope} ref={scopeTabsRef}>
          <span
            className={`${styles.scopeIndicator} ${scopeReady ? styles.indicatorReady : ""}`}
            ref={scopeIndicatorRef}
            aria-hidden="true"
          />
            {["story","sections","paragraph"].map(s=>(
              <button
                key={s}
                className={`${styles.scopeBtn} ${scope===s?styles.scopeActive:""}`}
                onClick={()=>setScope(s)}
                type="button"
              >
                {s[0].toUpperCase()+s.slice(1)}
              </button>
            ))}
          </div>

          {/* STORY */}
          {scope==="story" && (
            <div className={`${styles.section} ${styles.blueCard}`}>
              <div className={styles.formGrid} style={{marginTop: 0}}>
                <div>
                  <div className={styles.fieldRow}>
                    <label className={styles.label}>Length per section</label>
                    <span className={styles.valueRight}>
                      {lengthPreset[0].toUpperCase() + lengthPreset.slice(1)}
                    </span>
                  </div>

                  {/* slider a 3 step: 0=short, 1=medium, 2=long */}
                  <input
                    className={styles.range}
                    type="range"
                    min={0}
                    max={2}
                    step={1}
                    value={["short","medium","long"].indexOf(lengthPreset)}
                    onChange={(e) => {
                      const idx = Number(e.target.value);
                      setLengthPreset(["short","medium","long"][idx] || "medium");
                    }}
                    aria-label="Length preset"
                  />

                  {/* tacche opzionali sotto allo slider */}
                  <div className={styles.ticks3}>
                    <span>Short</span><span>Medium</span><span>Long</span>
                  </div>
                </div>
                <div>
                  <div className={styles.fieldRow}>
                    <label className={styles.label}>Creativity</label>
                    <span className={styles.valueRight}>{Math.round(storyTemp*100)}%</span>
                  </div>
                  <input className={styles.range} type="range" min={0} max={1} step={0.02}
                    value={storyTemp} onChange={e=>setStoryTemp(Number(e.target.value))} />
                </div>
                <div className={styles.changePersona}>
                  <label className={styles.label}>Change Persona</label>
                  <select className={styles.select} value={storyPersona} onChange={e=>setStoryPersona(e.target.value)}>
                    <option>General Public</option><option>Investor</option><option>Student</option>
                    <option>Journalist</option><option>Developer</option><option>Policy Maker</option>
                    <option>Teacher</option><option>Researcher</option>
                  </select>
                </div>
              </div>
              <div className={styles.actionsSticky}>
                <div className={styles.noteInfo}>Changing persona regenerates ALL and resets overrides.</div>
                <button
                  className={styles.primary}
                  onClick={()=>openNotes({
                    type:"story",
                    payload:{ persona:storyPersona, temp:clamp01(storyTemp), lengthPreset, resetOverrides:true }
                  }, true)}
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* SECTIONS */}
          {scope==="sections" && (
            <div className={`${styles.section} ${styles.blueCard}`}>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Choose one or more sections</label>
              </div>

              <div className={styles.sectionsList}>
                {sections.length===0 && <div className={styles.muted}>No sections.</div>}
                {sections.map((s, idx) => {
                  const id = s.id ?? s.sectionId ?? String(idx);
                  return (
                    <label key={id} className={`${styles.checkboxRow} ${selectedSectionIds.includes(id) ? styles.cbOn : ""}`}>
                      <input type="checkbox" checked={selectedSectionIds.includes(id)} onChange={()=>toggleSectionSelection(id)} />
                      <span className={styles.secTitle}>{s.title || `Section ${idx+1}`}</span>
                    </label>
                  );
                })}
              </div>

              <div className={styles.formGrid}>
                <div>
                  <div className={styles.fieldRow}>
                    <label className={styles.label}>Length per section</label>
                    <span className={styles.valueRight}>
                      {lengthPreset[0].toUpperCase() + lengthPreset.slice(1)}
                    </span>
                  </div>

                  {/* slider a 3 step: 0=short, 1=medium, 2=long */}
                  <input
                    className={styles.range}
                    type="range"
                    min={0}
                    max={2}
                    step={1}
                    value={["short","medium","long"].indexOf(lengthPreset)}
                    onChange={(e) => {
                      const idx = Number(e.target.value);
                      setLengthPreset(["short","medium","long"][idx] || "medium");
                    }}
                    aria-label="Length preset"
                  />

                  {/* tacche opzionali sotto allo slider */}
                  <div className={styles.ticks3}>
                    <span>Short</span><span>Medium</span><span>Long</span>
                  </div>
                </div>
                <div className={styles.fieldRow}>
                  <label className={styles.label}>Creativity</label>
                  <span className={styles.valueRight}>{Math.round(sectionTemp*100)}%</span>
                </div>
                <input className={styles.range} type="range" min={0} max={1} step={0.02}
                  value={sectionTemp} onChange={e=>setSectionTemp(Number(e.target.value))} />
              </div>

              <div className={styles.actionsSticky}>
                <div className={styles.noteInfo}>
                  {selectedSectionIds.length===0 ? "Select at least one section." : `${selectedSectionIds.length} selected`}
                </div>
                <button
                  className={styles.primary}
                  disabled={selectedSectionIds.length===0}
                  onClick={()=>openNotes({
                    type:"sections",
                    payload:{ sectionIds:selectedSectionIds, temp:clamp01(sectionTemp), lengthPreset }
                  })}                  
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* PARAGRAPH */}
          {scope==="paragraph" && (
            <div className={`${styles.section} ${styles.blueCard}`}>
              {!hasParagraphSelected && <div className={styles.muted}>Select a paragraph in the story to edit it here.</div>}
              {hasParagraphSelected && (
                <>
                <div className={styles.row}>
                  <button className={styles.ghostBtn} onClick={onReadOnPaper}>Read it on paper</button>
                </div>
                  <div className={styles.selectedParaBox}>
                    <div className={styles.selectedMeta}>
                      Section: <b>{findSectionTitle(sections, selectedParagraph.sectionId)}</b> · ¶ {selectedParagraph.index + 1}
                    </div>
                    <div className={styles.selectedText}>{selectedParagraph.text}</div>
                  </div>

                  <div className={styles.formGrid}>
                    <label className={styles.label}>Operations</label>
                    <div className={styles.opsRow}>
                      <label className={styles.switch}>
                        <input type="checkbox" checked={pOps.paraphrase} onChange={e=>setPOps(p=>({...p, paraphrase:e.target.checked}))} />
                        <span>Paraphrase</span>
                      </label>
                      <label className={styles.switch}>
                        <input type="checkbox" checked={pOps.simplify} onChange={e=>setPOps(p=>({...p, simplify:e.target.checked}))} />
                        <span>Simplify</span>
                      </label>
                    </div>

                    <label className={styles.label}>Length</label>
                    <div className={styles.opsRow}>
                      {["keep","shorten","lengthen"].map(v=>(
                        <label key={v} className={styles.radio}>
                          <input type="radio" name="lenop" value={v} checked={pOps.lengthOp===v} onChange={()=>setPOps(p=>({...p, lengthOp:v}))} />
                          <span>{v[0].toUpperCase()+v.slice(1)}</span>
                        </label>
                      ))}
                    </div>

                    <div className={styles.fieldRow}>
                      <label className={styles.label}>Creativity</label>
                      <span className={styles.valueRight}>{Math.round((pOps.temp ?? 0)*100)}%</span>
                    </div>
                    <input className={styles.range} type="range" min={0} max={1} step={0.02}
                      value={pOps.temp} onChange={e=>setPOps(p=>({...p, temp:Number(e.target.value)}))} />

                    <label className={styles.label}>Alternatives</label>
                    <input className={styles.input} type="number" min={1} max={3}
                      value={pOps.n} onChange={e=>setPOps(p=>({...p, n: clampN(Number(e.target.value)||1)}))} />
                  </div>

                  <div className={styles.actionsSticky}>
                    <div className={styles.noteInfo}>Generate 1–3 alternatives, then pick which one to apply.</div>
                    <button
                      className={styles.primary}
                      onClick={()=>openNotes({
                        type:"paragraph",
                        payload:{
                          sectionId:selectedParagraph.sectionId,
                          index:selectedParagraph.index,
                          paraphrase:!!pOps.paraphrase,
                          simplify:!!pOps.simplify,
                          lengthOp:pOps.lengthOp,
                          temp:clamp01(pOps.temp),
                          n:clampN(pOps.n),
                          text:selectedParagraph.text,
                        }
                      })}
                    >
                      Continue
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* INFO */}
      {tab==="info" && (
        <div className={styles.scroll}>
          <div className={styles.scope} ref={scopeTabsRef}>
            <span
              className={`${styles.scopeIndicator} ${scopeReady ? styles.indicatorReady : ""}`}
              ref={scopeIndicatorRef}
              aria-hidden="true"
            />
            {["story","sections"].map(s=>(
              <button
                key={s}
                className={`${styles.scopeBtn} ${scope===s?styles.scopeActive:""}`}
                onClick={()=>setScope(s)}
                type="button"
              >
                {s[0].toUpperCase()+s.slice(1)}
              </button>
            ))}
          </div>

          {/* INFO STORY */}
          {scope==="story" && (
            <div className={`${styles.section} ${styles.blueCard}`}>
              {!story ? (
                <div className={styles.muted}>No story selected.</div>
              ) : (
                <>
                  <div className={styles.kv}><div>Title</div>
                    <div className={styles.kvVal}>{story.title || story.docTitle || "Untitled"}</div>
                  </div>
                  <div className={styles.kv}><div>Persona</div>
                    <div className={styles.kvVal}>{personaDefault}</div>
                  </div>
                  {(() => {
                    const { lengthLabel, avgTemp } = computeStoryAggregates(
                      story,
                      lengthPresetDefault,
                      tempDefault
                    );
                    return (
                      <>
                        <div className={styles.kv}><div>Target length</div>
                          <div className={styles.kvVal}>{lengthLabel}</div>
                        </div>
                        <div className={styles.kv}><div>Creativity</div>
                          <div className={styles.kvVal}>{Math.round((avgTemp || 0) * 100)}%</div>
                        </div>
                      </>
                    );
                  })()}
                  {(() => {
                    const last = summarizeLastPartialRegen(story);
                    if (!last) return null;
                    const tempPct = isFinite(last.temp) ? Math.round(last.temp * 100) : null;
                    const when = last.at ? last.at.toLocaleString() : null;
                    return (
                      <div className={styles.kv}>
                        <div>Last partial regen</div>
                        <div className={styles.kvVal}>
                          {cap(last.preset)} @ {isFinite(last.temp) ? last.temp.toFixed(2) : "-"}
                          {tempPct != null ? ` (${tempPct}%)` : ""} · {last.sections.join(", ")}
                          {when ? ` — ${when}` : ""}
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          )}

          {/* INFO SECTIONS */}
          {scope==="sections" && (
            <div className={`${styles.section} ${styles.blueCard}`}>
              {!story ? (
                <div className={styles.muted}>No story selected.</div>
              ) : (
                <>
                  <div className={styles.h4}>Sections ({sections.length})</div>
                  <ul className={styles.infoList}>
                    {sections.map((s, idx)=> {
                      const id = s.id ?? s.sectionId ?? String(idx);
                      return (
                        <li key={id} className={styles.infoRow}>
                          <div className={styles.secLeft}>
                            <button
                              type="button"
                              className={styles.secTitle}  
                              title="Scroll to section"
                              onClick={() => onJumpToSection?.(id)}
                            >
                              {s.title || `Section ${idx+1}`}
                            </button>
                            {s.description && <div className={styles.secDesc}>{s.description}</div>}
                          </div>
                          {(() => {
                            const k = sectionKnobs(s, defaultsForInfo);
                            return (
                              <>
                                <div className={styles.kvs}><span>Creativity:</span><b>{fmt(k.temp)}</b></div>
                                <div className={styles.kvs}><span>Length:</span>
                                  <b>{String(k.lengthPreset).replace(/^\w/, c => c.toUpperCase())}</b>
                                </div>
                              </>
                            );
                          })()}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
          </div>
        )}

      {/* VERSIONS */}
      {tab==="history" && (
        <div className={styles.scroll}>
          <div className={`${styles.section} ${styles.blueCard}`}>
            {versions.length === 0 && <div className={styles.muted}>No versions yet.</div>}
            {versions.length > 0 && (
              <ul className={styles.timeline}>
                {layoutVersionGraph(versions, { trunkId: defaultVersionId }).map((v) => {
                  const isFav = v.id === defaultVersionId;
                  const title =
                    v.meta?.aiTitle ||
                    story?.title ||
                    story?.docTitle ||
                    ("v" + (v.number ?? v.id?.slice?.(-4) ?? ""));

                  return (
                    <li
                      key={v.id}
                      className={`${styles.tlItem} ${v.isBranch ? styles.isBranch : ""}`}
                      style={{ "--lane": v.lane }}
                    >
                      <span className={styles.tlNode} aria-hidden="true" />
                      <div
                        className={`${styles.tlCard} ${v.id === story?.current_revision_id ? styles.isOpen : ""}`}
                        onClick={() => openVersion(v.id)}
                        role="button" tabIndex={0}
                        onKeyDown={(e)=> (e.key==='Enter'||e.key===' ') && openVersion(v.id)}
                      >
                        <div className={styles.vRow}>
                          <div className={styles.vTitle}>{title}</div>
                          <button
                            className={`${styles.favToggle} ${isFav ? styles.favOn : ""}`}
                            title={isFav ? "Preferred" : "Set as preferred"}
                            onClick={(e)=>{ e.stopPropagation(); setDefaultVersion(v.id); }}
                            type="button"
                          >
                            ★
                          </button>
                        </div>

                        <div className={styles.vMeta}>
                          {new Date(v.createdAt).toLocaleString()} · {(v.createdBy || "system")}
                        </div>

                        <div className={styles.vPublic}>Public</div>

                        {v.notes && <div className={styles.vNotes}>{v.notes}</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* EXPORT */}
      {tab==="export" && (
        <div className={styles.scroll}>
          <div className={`${styles.section} ${styles.blueCard}`}>
            <div className={styles.formGrid}>
              <label className={styles.label}>Format</label>
              <select className={styles.select} value={exportFormat} onChange={e=>setExportFormat(e.target.value)}>
                <option value="markdown">Markdown (.md)</option>
                <option value="html">HTML (.html)</option>
                <option value="pdf">PDF (print)</option>
              </select>

              <label className={styles.label}>Header</label>
              <label className={styles.switch}>
                <input type="checkbox" checked={exportHeader} onChange={e=>setExportHeader(e.target.checked)} />
                <span>Include header (title, persona, date, version)</span>
              </label>

              <label className={styles.label}>Media</label>
              <label className={styles.switch}>
                <input type="checkbox" checked={exportMedia} onChange={e=>setExportMedia(e.target.checked)} />
                <span>Include media</span>
              </label>

              <label className={styles.label}>Metadata</label>
              <label className={styles.switch}>
                <input type="checkbox" checked={exportMeta} onChange={e=>setExportMeta(e.target.checked)} />
                <span>Include metadata</span>
              </label>
            </div>

            <div className={styles.subsection}>
              <div className={styles.h4}>Sections to export</div>
              <div className={styles.sectionsList}>
                {sections.map((s, idx) => {
                  const id = s.id ?? s.sectionId ?? String(idx);
                  return (
                    <label key={id} className={`${styles.checkboxRow}`}>
                      <input type="checkbox" checked={exportSectionIds.includes(id)} onChange={()=>toggleExportSection(id)} />
                      <span className={styles.secTitle}>{s.title || `Section ${idx+1}`}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className={styles.actionsSticky}>
              <div className={styles.noteInfo}>Export is client-side only. It never changes your data.</div>
              <button className={styles.primary} onClick={handleExportClient}>Continue</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

/* ---------------- Utils ---------------- */
function clamp01(x){ x = Number(x)||0; return Math.min(1, Math.max(0, x)); }
function clampN(n){ return Math.min(3, Math.max(1, Number(n)||1)); }
function fmt(x){ const n = Number(x); return isFinite(n) ? n.toFixed(2) : String(x ?? "-"); }
function findSectionTitle(sections, id){
  const key = String(id);
  const s = (sections||[]).find(ss => String(ss.id ?? ss.sectionId) === key);
  return s?.title || "Section";
}
function findSectionById(sections, id){
  const key = String(id);
  const byId = new Map((sections||[]).map((s,i)=>[ String(s?.id ?? s?.sectionId ?? i), s ]));
  return byId.get(key) || null;
}

function mapActionToCommand(action){
  if (!action) return "update";
  if (action.type === "story")     return "regenerate_story";
  if (action.type === "sections")  return "regenerate_sections";
  if (action.type === "paragraph") return "regenerate_paragraph";
  return "update";
}
function slugify(s){ return String(s||"story").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,""); }
function extractSectionText(s){
  if (typeof s.content === "string" && s.content.trim()) return s.content;
  if (typeof s.text === "string" && s.text.trim()) return s.text;
  if (Array.isArray(s.paragraphs) && s.paragraphs.length) return s.paragraphs.join("\n\n");
  if (Array.isArray(s.blocks) && s.blocks.length) {
    const texts = s.blocks.map(b => (typeof b === "string" ? b : (b?.text||""))).filter(Boolean);
    if (texts.length) return texts.join("\n\n");
  }
  return "(no text)";
}
function buildExportPayload(story, sections, opts){
  const title   = story?.title || story?.docTitle || "Untitled";
  const fileBase= title || "story";
  const persona = story?.persona || story?.meta?.persona || "";
  const version = story?.current_revision_id || story?.defaultVersionId || "";
  const meta = opts?.meta ? {
    id: story?.id, persona, version,
    createdAt: story?.createdAt, updatedAt: story?.updatedAt,
  } : null;
  const secData = sections.map((s, i) => ({ title: s.title || `Section ${i+1}`, text: extractSectionText(s) }));
  return { title, fileBase, persona, meta, header: !!opts?.header, sections: secData, opts };
}
function renderMarkdown(p){
  const fm = p.meta ? `---\ntitle: "${escapeYaml(p.title)}"\npersona: "${escapeYaml(p.persona)}"\nversion: "${escapeYaml(p.meta?.version||"")}"\nid: "${escapeYaml(p.meta?.id||"")}"\ncreatedAt: "${escapeYaml(p.meta?.createdAt||"")}"\nupdatedAt: "${escapeYaml(p.meta?.updatedAt||"")}"\n---\n\n` : "";
  const header = p.header ? `# ${p.title}\n\n*Persona:* ${p.persona || "-"}\n\n` : "";
  const body = p.sections.map(s => `## ${s.title}\n\n${s.text}\n`).join("\n");
  return fm + header + body;
}
function escapeYaml(s){ return String(s).replace(/"/g,'\\"'); }
function renderHTML(p){
  const metaTags = p.meta ? `
<meta name="persona" content="${esc(p.persona)}">
<meta name="version" content="${esc(p.meta?.version||"")}">
<meta name="story-id" content="${esc(p.meta?.id||"")}">` : "";
  const header = p.header ? `<header><h1>${esc(p.title)}</h1><div class="meta">Persona: ${esc(p.persona||"-")}</div></header>` : "";
  const body = p.sections.map(s => `<section><h2>${esc(s.title)}</h2><p>${nl2p(esc(s.text))}</p></section>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.title)}</title>${metaTags}
<style>
  :root{ color-scheme: light; }
  body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:820px;margin:32px auto;padding:0 16px;}
  header{margin-bottom:24px;border-bottom:1px solid #eee;padding-bottom:12px;}
  .meta{color:#666;font-size:14px;}
  h1{font-size:28px;margin:0 0 8px;}
  h2{font-size:20px;margin:20px 0 8px;}
  section{margin-bottom:18px;}
  section p{white-space:pre-wrap;}
</style></head><body>${header}${body}</body></html>`;
}
function renderPrintableHTML(p){
  const html = renderHTML(p);
  return html.replace("</style>", `
  @media print {
    body{max-width:none;margin:0;padding:0 12mm;}
    header{border:none;margin:0 0 8mm;}
    h1{font-size:22pt;}
    h2{font-size:14pt;page-break-after:avoid;}
    section{page-break-inside:avoid;}
  }
</style>`);
}
function nl2p(s){ return String(s).replace(/\n\n+/g,"</p><p>").replace(/\n/g,"<br>"); }
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function downloadFile(filename, mime, content){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click(); a.remove();
  URL.revokeObjectURL(url);
}
