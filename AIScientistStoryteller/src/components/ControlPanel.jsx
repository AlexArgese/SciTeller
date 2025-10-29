// FILE: src/components/ControlPanel.jsx
import { useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import styles from "./ControlPanel.module.css";
import VersionGraph from "./VersionGraph"

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
  // 👇️ tolti: tutto ciò che riguarda variants/history/choose/apply
  setCpStage = () => {},
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
    if (active.offsetParent === null) return null;

    const label = active;
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

  function layoutVersionGraph(versions, { trunkId = null } = {}) {
    const sortedAsc = [...versions].sort((a,b)=> new Date(a.createdAt) - new Date(b.createdAt));
  
    const byId = new Map(sortedAsc.map(v => [v.id, v]));
    const laneOf = new Map();
    const lastLaneUse = [];
    function firstFreeLane(excludeLane = null){
      for (let i=0; i<lastLaneUse.length; i++){
        if (i !== excludeLane && lastLaneUse[i] == null) return i;
      }
      lastLaneUse.push(null);
      return lastLaneUse.length - 1;
    }
    const out = [];
    for (const v of sortedAsc) {
      const parentId = v?.meta?.parentRevisionId || null;
      const parentLane = parentId ? laneOf.get(parentId) ?? null : null;
      const lane = (parentId && parentLane!=null && lastLaneUse[parentLane]===parentId)
        ? parentLane : firstFreeLane(parentLane);
      laneOf.set(v.id, lane);
      lastLaneUse[lane] = v.id;
  
      let depth = 0, cur = v;
      while (cur?.meta?.parentRevisionId && byId.has(cur.meta.parentRevisionId)) {
        depth++; cur = byId.get(cur.meta.parentRevisionId);
      }
      const isBranch = !!(v?.meta?.parentRevisionId && (!trunkId || v.meta.parentRevisionId !== trunkId));
      out.push({ ...v, lane, depth, isBranch });
    }
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
    const idxs = (lpr.targets || []).map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n < secCount);
    const names = idxs.map(i => secs[i]?.title?.trim() || `Section ${i+1}`);
    return {
      preset: String(lpr.lengthPreset || "medium"),
      temp: Number(lpr.temp ?? 0),
      sections: names,
      at: lpr.at ? new Date(lpr.at) : null,
    };
  }

  useLayoutEffect(() => {
    if (!open) return;
    placeScopeAfterPaint();
    document?.fonts?.ready?.then(() => placeScopeAfterPaint()).catch(() => {});
  }, [open, story?.id]);

  useLayoutEffect(() => {
    if (!open) return;
    placeCpAfterPaint();
    document?.fonts?.ready?.then(() => placeCpAfterPaint()).catch(() => {});
  }, [open]);

  const [tab, setTab] = useState("modify");
  useEffect(() => { if (!story && tab !== "info") setTab("info"); }, [story, tab]);
  useEffect(() => { if (open && selectedParagraph && scope !== "paragraph") setScope("paragraph"); }, [open, selectedParagraph]);

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
    el.offsetWidth;
    const prefersReduced = typeof window !== "undefined" &&
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    el.offsetWidth;
    const prefersReduced = typeof window !== "undefined" &&
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

  useEffect(() => {
    if (!story) return;
    console.groupCollapsed("[CP] story payload", story?.id);
    console.log("title:", story?.title || story?.docTitle);
    console.log("id:", story?.id);
    console.log("persona:", story?.persona, "meta.persona:", story?.meta?.persona);
    console.log("meta.upstreamParams:", story?.meta?.upstreamParams);
    console.log("meta.lengthPerSection:", story?.meta?.lengthPerSection);
    console.log("meta.creativity:", story?.meta?.creativity);
    console.log("sections (count):", Array.isArray(story?.sections) ? story.sections.length : 0);
    console.log("versions (count):", Array.isArray(story?.versions) ? story.versions.length : 0);
    console.log("updatedAt:", story?.updatedAt, "createdAt:", story?.createdAt);
    console.groupEnd();
  }, [story?.id, story?.updatedAt]);

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

  const sections = useMemo(() => Array.isArray(story?.sections) ? story.sections : [], [story]);
  const defaultsForInfo = useMemo(() => defaultKnobsFromMeta(story?.meta), [story?.id, story?.meta]);
  useMemo(() => aggregateStoryKnobs(sections, defaultsForInfo), [sections, defaultsForInfo]);
  const personaDefault = story?.persona || story?.meta?.persona || "Student";
  const tempDefault = getCreativity(story?.meta);
  const lengthPresetDefault = getLengthPreset(story?.meta);

  const lpFromMeta = story?.meta?.upstreamParams?.lengthPreset;
  const [lengthPreset, setLengthPreset] = useState(lpFromMeta || "medium");
  useEffect(() => { setLengthPreset(lpFromMeta || "medium"); }, [story?.id, lpFromMeta]);

  const [storyPersona, setStoryPersona] = useState(personaDefault);
  const [storyTemp,    setStoryTemp]    = useState(Number(tempDefault) || 0);
  useEffect(() => {
    setStoryTemp(quantizeTemp01(Number(tempDefault) || 0));
  }, [personaDefault, tempDefault, story?.id]);
  
  // quando resetti le sezioni in base allo story
  useEffect(() => { setSelectedSectionIds([]); setSectionTemp(quantizeTemp01(storyTemp)); }, [story?.id, storyTemp]);

  const [selectedSectionIds, setSelectedSectionIds] = useState([]);
  const [sectionTemp, setSectionTemp] = useState(storyTemp);
  useEffect(() => {
    const secs = Array.isArray(sections) ? sections : [];
    if (selectedSectionIds.length === 1) {
      const sel = findSectionById(secs, selectedSectionIds[0]);
      const effLen = (sel?.lengthPreset) || (story?.meta?.upstreamParams?.lengthPreset) || "medium";
      const effTmp = (typeof sel?.temp === "number") ? sel.temp : (Number(tempDefault) || 0);
      setLengthPreset(String(effLen));
      setSectionTemp(quantizeTemp01(Number(effTmp)));
    } else {
      const lp = story?.meta?.upstreamParams?.lengthPreset || "medium";
      setLengthPreset(lp);
      setSectionTemp(quantizeTemp01(Number(tempDefault) || 0));
    }
  }, [selectedSectionIds, story?.id, sections.length, tempDefault]);  
  useEffect(() => { setStoryPersona(personaDefault); setStoryTemp(Number(tempDefault) || 0); }, [personaDefault, tempDefault, story?.id]);
  useEffect(() => { setSelectedSectionIds([]); setSectionTemp(storyTemp); }, [story?.id, storyTemp]);

  function toggleSectionSelection(id) {
    setSelectedSectionIds(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  }
  function selectAllSections(){ setSelectedSectionIds(sections.map((s,i)=>s.id ?? s.sectionId ?? String(i))); }
  function clearSections(){ setSelectedSectionIds([]); }

  const hasParagraphSelected = !!selectedParagraph;
  const [pOps, setPOps] = useState({ paraphrase:true, simplify:false, temp:storyTemp, n:1 });
  useEffect(() => {
    setPOps(p => ({ ...p, n: clampN(p.n) }));
  }, [selectedParagraph?.sectionId, selectedParagraph?.index, story?.id]);

  const [pendingAction, setPendingAction] = useState(null);
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
      let effTemp = action.payload.temp;
      let effLP   = action.payload.lengthPreset;
      if (action.payload.sectionIds.length === 1) {
        const sel = findSectionById(sections, action.payload.sectionIds[0]);
        if (typeof sel?.temp === "number") effTemp = sel.temp;
        if (sel?.lengthPreset) effLP = sel.lengthPreset;
      }
      const tempPct = Number.isFinite(effTemp) ? Math.round(effTemp * 100) : null;
      return `Regenerate SECTIONS (${names}) with creativity = ${tempPct != null ? tempPct + "%" : "-"} and length per section = ${effLP}.`;
    }
    if (action.type === "paragraph" && selectedParagraph) {
      const s = sections.find(ss => (ss.id ?? ss.sectionId) === selectedParagraph.sectionId);
      const secName = s?.title || "Selected section";
      const o = action.payload?.ops || {};
      const bits = [];
      if (o.paraphrase) bits.push("paraphrase");
      if (o.simplify) bits.push("simplify");
      if (o.length_preset) bits.push(`len=${o.length_preset}`);
      if (Number.isFinite(o.temp)) bits.push(`temp=${o.temp}`);
      if (Number.isFinite(o.n)) bits.push(`${o.n} alt`);
      return `Regenerate PARAGRAPH (${secName}, ¶${selectedParagraph.index + 1}): ${bits.join(", ")}.`;
    }
    return `Update "${title}".`;
  }
  useEffect(() => {
    if (cpStage === "notes" && pendingAction && !notes.trim()) {
      setNotes(suggestNotes(pendingAction));
    }
  }, [cpStage, pendingAction]); // eslint-disable-line
  function openNotes(action, global=false){
    const baseRevisionId = story?.current_revision_id || story?.defaultVersionId || null;
    setPendingAction({
      ...action,
      payload: { ...(action?.payload||{}), ...(baseRevisionId ? { baseRevisionId } : {}) }
    });
    setNotes(suggestNotes(action));
    (global ? onContinueGlobal : onContinueNotes)?.();
  }
  async function submitWithNotes(){
    if (!pendingAction || !onChange) return;
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

  // ===== Varianti (ultimo batch) — RIMOSSE dal pannello =====

  const versions = Array.isArray(story?.versions) ? story.versions : [];
  const defaultVersionId = story?.defaultVersionId || story?.meta?.defaultVersionId || null;
  async function setDefaultVersion(id){ if (onChange) await onChange({ defaultVersionId: id }); }
  async function openVersion(id){ if (onChange) await onChange({ currentVersionId: id, _action: "open_version" }); }

  const [exportFormat, setExportFormat] = useState("markdown");
  const [exportHeader, setExportHeader] = useState(true);
  const [exportMedia,  setExportMedia] = useState(false);
  const [exportMeta,   setExportMeta]  = useState(true);
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
    const payload = buildExportPayload(
      story,
      selSections,
      { header: exportHeader,
        // media: exportMedia,
        meta: exportMeta } 
    );
    if (exportFormat === "markdown") {
      const md = renderMarkdown(payload);
      downloadFile(slugify(payload.fileBase)+".md", "text/markdown;charset=utf-8", md);
    } else if (exportFormat === "html") {
      const html = renderHTML(payload);
      const w = window.open("", "_blank");
      if (!w) return alert("Popup blocked by the browser.");
      w.document.open(); w.document.write(html); w.document.close();
    } else if (exportFormat === "pdf") {
      const html = renderPrintableHTML(payload);
      const w = window.open("", "_blank");
      if (!w) return alert("Popup blocked by the browser.");
      w.document.open(); w.document.write(html); w.document.close();
      setTimeout(()=>{ try { w.print(); } catch {} }, 300);
    }
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
          <div className={styles.noteHint}>Notes are required. Min {minNotesChars} characters.</div>
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
            <span className={`${styles.cpIndicator} ${cpReady ? styles.indicatorReady : ""}`} ref={indicatorRef} aria-hidden="true" />
            {["modify","info","history","export"].map(t=>(
              <button key={t} className={`${styles.tab} ${tab===t?styles.active:""}`} onClick={()=>setTab(t)} type="button">
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
            <span className={`${styles.scopeIndicator} ${scopeReady ? styles.indicatorReady : ""}`} ref={scopeIndicatorRef} aria-hidden="true" />
            {["story","sections","paragraph"].map(s=>(
              <button key={s} className={`${styles.scopeBtn} ${scope===s?styles.scopeActive:""}`} onClick={()=>setScope(s)} type="button">
                {s[0].toUpperCase()+s.slice(1)}
              </button>
            ))}
          </div>

          {/* STORY */}
          {scope==="story" && (
            <StoryControls
              lengthPreset={lengthPreset}
              setLengthPreset={setLengthPreset}
              storyTemp={storyTemp}
              setStoryTemp={setStoryTemp}
              storyPersona={storyPersona}
              setStoryPersona={setStoryPersona}
              onContinue={(payload)=>openNotes({ type:"story", payload }, true)}
            />
          )}

          {/* SECTIONS */}
          {scope==="sections" && (
            <SectionsControls
              sections={sections}
              selectedSectionIds={selectedSectionIds}
              toggleSectionSelection={toggleSectionSelection}
              lengthPreset={lengthPreset}
              setLengthPreset={setLengthPreset}
              sectionTemp={sectionTemp}
              setSectionTemp={setSectionTemp}
              onContinue={(payload)=>openNotes({ type:"sections", payload })}
            />
          )}

          {/* PARAGRAPH */}
          {scope==="paragraph" && (
            <ParagraphControls
              story={story}
              sections={sections}
              selectedParagraph={selectedParagraph}
              pOps={pOps}
              setPOps={setPOps}
              lengthPreset={lengthPreset}
              onReadOnPaper={onReadOnPaper}
              onGenerate={(payload)=>openNotes({ type:"paragraph", payload })}
            />
          )}
        </div>
      )}

      {/* INFO */}
      {tab==="info" && (
        <InfoTab
          story={story}
          scopeTabsRef={scopeTabsRef}
          scopeIndicatorRef={scopeIndicatorRef}
          scopeReady={scopeReady}
          setScope={setScope}
          scope={scope}
          lengthPresetDefault={lengthPresetDefault}
          tempDefault={tempDefault}
          summarizeLastPartialRegen={summarizeLastPartialRegen}
          computeStoryAggregates={computeStoryAggregates}
          defaultsForInfo={defaultsForInfo}
          sections={sections}
          onJumpToSection={onJumpToSection}
        />
      )}

      {/* VERSIONS */}
      {tab==="history" && (
        <div className={styles.scroll}>
          <div className={`${styles.section} ${styles.blueCard}`} style={{padding:0}}>
            {versions.length === 0 && <div className={styles.muted}>No versions yet.</div>}
            {versions.length>0 && (
              <VersionGraph
                versions={versions}
                layoutVersionGraph={layoutVersionGraph}
                defaultVersionId={defaultVersionId}
                openVersion={openVersion}
                setDefaultVersion={setDefaultVersion}
                newestOnTop={true}
              />
            )}
          </div>
        </div>
      )}

      {/* EXPORT */}
      {tab==="export" && (
        <ExportTab
          story={story}
          sections={sections}
          exportFormat={exportFormat}
          setExportFormat={setExportFormat}
          exportHeader={exportHeader}
          setExportHeader={setExportHeader}
          exportMedia={exportMedia}
          setExportMedia={setExportMedia}
          exportMeta={exportMeta}
          setExportMeta={setExportMeta}
          exportSectionIds={exportSectionIds}
          setExportSectionIds={setExportSectionIds}
          toggleExportSection={toggleExportSection}
          handleExportClient={handleExportClient}
        />
      )}
    </aside>
  );
}

/* ---------------- Subcomponenti “puliti” ---------------- */

function StoryControls({ lengthPreset, setLengthPreset, storyTemp, setStoryTemp, storyPersona, setStoryPersona, onContinue }) {
  return (
    <div className={`${styles.section} ${styles.blueCard}`}>
      <div className={styles.formGrid} style={{marginTop: 0}}>
        <div>
          <div className={styles.fieldRow}>
            <label className={styles.label}>Length per section</label>
            <span className={styles.valueRight}>{capFirst(lengthPreset)}</span>
          </div>
          <input className={styles.range} type="range" min={0} max={2} step={1}
            value={["short","medium","long"].indexOf(lengthPreset)}
            onChange={(e)=>setLengthPreset(["short","medium","long"][Number(e.target.value)] || "medium")}
            aria-label="Length preset"
          />
          <div className={styles.ticks3}><span>Short</span><span>Medium</span><span>Long</span></div>
        </div>
        <div>
          <div className={styles.fieldRow}><label className={styles.label}>Creativity</label><span className={styles.valueRight}>{Math.round(storyTemp*100)}%</span></div>
          <input className={styles.range} type="range" min={0} max={1} step={0.1} value={storyTemp} onChange={e=>setStoryTemp(Number(e.target.value))} />
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
        <button className={styles.primary} onClick={()=>onContinue({ persona:storyPersona, temp:clamp01(storyTemp), lengthPreset, resetOverrides:true })}>Continue</button>
      </div>
    </div>
  );
}

function SectionsControls({
  sections, selectedSectionIds, toggleSectionSelection,
  lengthPreset, setLengthPreset, sectionTemp, setSectionTemp, onContinue
}) {
  return (
    <div className={`${styles.section} ${styles.blueCard}`}>
      <div className={styles.fieldRow}><label className={styles.label}>Choose one or more sections</label></div>
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
          <div className={styles.fieldRow}><label className={styles.label}>Length per section</label><span className={styles.valueRight}>{capFirst(lengthPreset)}</span></div>
          <input className={styles.range} type="range" min={0} max={2} step={1}
            value={["short","medium","long"].indexOf(lengthPreset)}
            onChange={(e)=>setLengthPreset(["short","medium","long"][Number(e.target.value)] || "medium")}
            aria-label="Length preset" />
          <div className={styles.ticks3}><span>Short</span><span>Medium</span><span>Long</span></div>
        </div>
        <div>
          <div className={styles.fieldRow}><label className={styles.label}>Creativity</label><span className={styles.valueRight}>{Math.round(sectionTemp*100)}%</span></div>
          <input className={styles.range} type="range" min={0} max={1} step={0.1} value={sectionTemp} onChange={e=>setSectionTemp(Number(e.target.value))} />
        </div>
      </div>

      <div className={styles.actionsSticky}>
        <div className={styles.noteInfo}>{selectedSectionIds.length===0 ? "Select at least one section." : `${selectedSectionIds.length} selected`}</div>
        <button className={styles.primary} disabled={selectedSectionIds.length===0}
          onClick={()=>onContinue({ sectionIds:selectedSectionIds, temp:clamp01(sectionTemp), lengthPreset })}>
          Continue
        </button>
      </div>
    </div>
  );
}

function ParagraphControls({
  story, sections, selectedParagraph,
  pOps, setPOps, lengthPreset,
  onReadOnPaper, onGenerate,
}) {
  const has = !!selectedParagraph;

  // Preset lunghezza locale per il paragrafo
  const [pLenPreset, setPLenPreset] = useState(lengthPreset || "medium");
  useEffect(() => { setPLenPreset(lengthPreset || "medium"); },
    [lengthPreset, selectedParagraph?.index, selectedParagraph?.sectionId, story?.id]);

  const presetToIdx = (lp) => Math.max(0, ["short","medium","long"].indexOf(String(lp || "medium")));
  const idxToPreset = (i) => (["short","medium","long"][Number(i)] || "medium");

  return (
    <div className={`${styles.section} ${styles.blueCard}`}>
      {!has && <div className={styles.muted}>Select a paragraph in the story to edit it here.</div>}
      {has && (
        <>
          <div className={styles.selectedParaBox}>
            <div className={styles.rowMeta}>
              <div className={styles.selectedMeta} style={{marginTop:"6px"}}>
                Section: <b>{findSectionTitle(sections, selectedParagraph.sectionId)}</b> 
              </div>
              <div className={styles.selectedMeta} style={{fontSize:"1.5em"}}>
                <b>¶ {selectedParagraph.index + 1}</b>
              </div>
            </div>
            <div className={styles.selectedText}>{selectedParagraph.text}</div>
          </div>

          <div className={styles.formGrid}>
            <div>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Length</label>
                <span className={styles.valueRight}>{capFirst(pLenPreset)}</span>
              </div>
              <input
                className={styles.range}
                type="range"
                min={0}
                max={2}
                step={1}
                value={presetToIdx(pLenPreset)}
                onChange={(e)=>setPLenPreset(idxToPreset(e.target.value))}
                aria-label="Length preset"
              />
              <div className={styles.ticks3}><span>Short</span><span>Medium</span><span>Long</span></div>
            </div>

            <div>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Creativity</label>
                <span className={styles.valueRight}>{Math.round((pOps.temp ?? 0)*100)}%</span>
              </div>
              <input
                className={styles.range}
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={pOps.temp}
                onChange={e=>setPOps(p=>({...p, temp:Number(e.target.value)}))}
              />
            </div>

            <div>
              <label className={styles.label}>Alternatives</label>
              <input
                className={styles.range}
                type="range"
                min={1}
                max={3}
                step={1}
                value={pOps.n}
                onChange={(e)=>setPOps(p=>({...p, n: clampN(Number(e.target.value)||1)}))}
                aria-label="Number of alternatives"
              />
              <div className={styles.ticks3}><span>1</span><span>2</span><span>3</span></div>
            </div>
          </div>

          <div className={styles.actionsSticky}>
            <div className={styles.noteInfo}>
              Generate 1–3 alternatives, then pick and apply directly in the story.
            </div>
            <button
              className={styles.primary}
              onClick={() =>
                onGenerate({
                  sectionId: selectedParagraph.sectionId,
                  paragraphIndex: selectedParagraph.index,
                  paragraphText: selectedParagraph.text,
                  ops: {
                    paraphrase: !!pOps.paraphrase,
                    simplify: !!pOps.simplify,
                    temp: clamp01(pOps.temp),
                    n: clampN(pOps.n),
                    top_p: 0.9,
                    length_preset: pLenPreset,
                    length_op: pLenPreset === "short" ? "shorten" : pLenPreset === "long"  ? "lengthen" : "keep",
                  },
                })
              }
            >
              Continue
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- Info/History/Export come prima ---------------- */

function InfoTab({
  story,
  scopeTabsRef,
  scopeIndicatorRef,
  scopeReady,
  setScope,
  scope,
  lengthPresetDefault,
  tempDefault,
  summarizeLastPartialRegen,
  computeStoryAggregates,
  defaultsForInfo,
  sections,
  onJumpToSection,
}) {
  return (
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
            {capFirst(s)}
          </button>
        ))}
      </div>

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
                <div className={styles.kvVal}>{story?.persona || story?.meta?.persona || "Student"}</div>
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
                      {capFirst(last.preset)} @ {isFinite(last.temp) ? last.temp.toFixed(2) : "-"}
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

      {scope==="sections" && (
        <div className={`${styles.section} ${styles.blueCard}`}>
          {!story ? (
            <div className={styles.muted}>No story selected.</div>
          ) : (
            <>
              <ul className={styles.infoList}>
              {sections.map((s, idx)=> {
                  const id = s.id ?? s.sectionId ?? String(idx);
                  const k = sectionKnobs(s, defaultsForInfo);
                  const hasTempOverride = typeof s?.temp === "number";
                  const hasLenOverride  = !!s?.lengthPreset;

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

                      <div className={styles.kvs}>
                        <span>Creativity:</span>
                        <b title={hasTempOverride ? "Section override" : "Inherited from story"}>
                          {fmt(k.temp)}{hasTempOverride ? " •" : ""}
                        </b>
                      </div>

                      <div className={styles.kvs}>
                        <span>Length:</span>
                        <b title={hasLenOverride ? "Section override" : "Inherited from story"}>
                          {capFirst(String(k.lengthPreset))}{hasLenOverride ? " •" : ""}
                        </b>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ExportTab({
  story,
  sections,
  exportFormat, setExportFormat,
  exportHeader, setExportHeader,
  exportMedia, setExportMedia,
  exportMeta, setExportMeta,
  exportSectionIds, setExportSectionIds,
  toggleExportSection,
  handleExportClient,
}) {
  const total = sections.length;
  const selectedCount = exportSectionIds.length;

  return (
    <div className={styles.scroll}>
      <div className={`${styles.section} ${styles.blueCard}`}>

        <div className={styles.subsection}>
          <div className={styles.h4}>Options</div>

          <div className={styles.formGrid} style={{marginTop: 0}}>
            <div>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Format</label>
                <span className={styles.valueRight}>
                  {exportFormat === "markdown" ? "Markdown" :
                   exportFormat === "html"     ? "HTML"     :
                   exportFormat === "pdf"      ? "PDF (print)" : "-"}
                </span>
              </div>
              <select
                className={styles.select}
                value={exportFormat}
                onChange={e=>setExportFormat(e.target.value)}
                aria-label="Export format"
              >
                <option value="markdown">Markdown (.md)</option>
                <option value="html">HTML (.html)</option>
                <option value="pdf">PDF (print)</option>
              </select>
            </div>

            <div>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Header</label>
                <span className={styles.valueRight}>{exportHeader ? "Included" : "Excluded"}</span>
              </div>
              <label className={styles.switch}>
                <input
                  type="checkbox"
                  checked={exportHeader}
                  onChange={e=>setExportHeader(e.target.checked)}
                />
                <span>Include title, persona, date, version</span>
              </label>
            </div>

            <div>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Metadata</label>
                <span className={styles.valueRight}>{exportMeta ? "Included" : "Excluded"}</span>
              </div>
              <label className={styles.switch}>
                <input
                  type="checkbox"
                  checked={exportMeta}
                  onChange={e=>setExportMeta(e.target.checked)}
                />
                <span>Include id, persona, version, timestamps</span>
              </label>
            </div>
          </div>

          <div className={styles.noteInfo}>
            Export is client-side only and does not modify your story.
          </div>
        </div>

        <div className={styles.subsection}>
          <div className={styles.h4}>Sections to export</div>

          <div className={styles.sectionsList}>
            {sections.map((s, idx) => {
              const id = s.id ?? s.sectionId ?? String(idx);
              const title = s.title || `Section ${idx+1}`;
              return (
                <label key={id} className={styles.checkboxRow} title={title}>
                  <input
                    type="checkbox"
                    checked={exportSectionIds.includes(id)}
                    onChange={()=>toggleExportSection(id)}
                    aria-label={`Toggle ${title}`}
                  />
                  <span className={styles.secTitle}>{title}</span>
                </label>
              );
            })}
            {total === 0 && <div className={styles.muted}>No sections.</div>}
          </div>
        </div>

        <div className={styles.actionsSticky}>
          <div className={styles.noteInfo}>
            The exported file opens in a new tab (HTML/PDF) or downloads locally (Markdown).
          </div>
          <button
            className={styles.primary}
            onClick={handleExportClient}
            disabled={selectedCount === 0}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Utils ---------------- */
function clamp01(x){ x = Number(x)||0; return Math.min(1, Math.max(0, x)); }
function clampN(n){ return Math.min(3, Math.max(1, Number(n)||1)); }
function quantizeTemp01(x){
  x = Math.min(1, Math.max(0, Number(x)||0));
  return Math.round(x * 10) / 10; // scatti del 10%
}
function fmt(x){ const n = Number(x); return isFinite(n) ? n.toFixed(2) : String(x ?? "-"); }
function findSectionTitle(sections, id){
  const key = String(id);
  const s = (sections||[]).find(ss => String(ss.id ?? ss.sectionId) === key);
  return s?.title || "Section";
}
function capFirst(s){ return String(s||"").replace(/^\w/, m => m.toUpperCase()); }

function getLengthPreset(meta){
  const p = meta?.upstreamParams?.lengthPreset;
  if (p) return p;
  const words = Number(meta?.lengthPerSection);
  if (isFinite(words)) {
    if (words <= 120) return "short";
    if (words >= 200) return "long";
    return "medium";
  }
  return "medium";
}
function getCreativity(meta){
  if (meta?.upstreamParams?.temp != null) return quantizeTemp01(meta.upstreamParams.temp);
  if (typeof meta?.creativity === "number") return quantizeTemp01(Number(meta.creativity) / 100);
  return 0.0;
}
function defaultKnobsFromMeta(meta, sectionCount = null){
  const up = meta?.upstreamParams || {};
  const hasTargets = Array.isArray(up.targets) && up.targets.length > 0;
  const baseLP   = getLengthPreset(meta);
  const baseTemp = getCreativity(meta);
  if (hasTargets) {
    return {
      lengthPreset: String(baseLP || "medium"),
      temp: Number(isFinite(baseTemp) ? baseTemp : 0),
    };
  }
  return {
    lengthPreset: String(up.lengthPreset || baseLP || "medium"),
    temp: Number(isFinite(up.temp) ? up.temp : (isFinite(baseTemp) ? baseTemp : 0)),
  };
}
function sectionKnobs(section, defaults){
  const temp = (typeof section?.temp === "number") ? section.temp : defaults.temp;
  const lengthPreset = section?.lengthPreset || defaults.lengthPreset;
  return { temp, lengthPreset };
}
function aggregateStoryKnobs(sections, defaults){
  const items = (sections || []).filter(s => s?.visible !== false).map(s => sectionKnobs(s, defaults));
  const temps = items.map(i => i.temp).filter(n => Number.isFinite(n));
  const avgTemp = temps.length ? (temps.reduce((a,b)=>a+b,0) / temps.length) : defaults.temp;
  const lengths = items.map(i => i.lengthPreset).filter(Boolean);
  const uniq = Array.from(new Set(lengths));
  const aggLength = (uniq.length === 1) ? uniq[0] : "mix";
  return { temp: avgTemp, lengthPreset: aggLength };
}
function computeStoryAggregates(story, fallbackLength, fallbackTemp){
  const sectionsAll = Array.isArray(story?.sections) ? story.sections : [];
  const sections = sectionsAll.filter(s => s?.visible !== false);
  const baseLP   = fallbackLength || "medium";
  const baseTemp = Number(fallbackTemp ?? 0) || 0;
  const explicitLPs = sections.map(s => s?.lengthPreset).filter(lp => typeof lp === "string" && lp.trim().length > 0);
  let lengthLabel;
  if (explicitLPs.length === 0) lengthLabel = capFirst(baseLP);
  else {
    const allSame = explicitLPs.every(lp => lp === explicitLPs[0]);
    lengthLabel = allSame ? capFirst(explicitLPs[0]) : "Mix";
  }
  const explicitTemps = sections.map(s => (typeof s?.temp === "number" ? s.temp : undefined)).filter(t => Number.isFinite(t));
  const avgTemp = explicitTemps.length ? (explicitTemps.reduce((a,b)=>a+b,0) / explicitTemps.length) : baseTemp;
  return { lengthLabel, avgTemp };
}
function mapActionToCommand(action){
  if (!action) return "update";
  if (action.type === "story")     return "regenerate_story";
  if (action.type === "sections")  return "regenerate_sections";
  if (action.type === "paragraph") return "regen_paragraph_vm";
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
