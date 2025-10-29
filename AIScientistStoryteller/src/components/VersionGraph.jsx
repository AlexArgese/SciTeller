// VersionGraph.jsx — Linear (35→1) + indent inverso + rami "ReactFlow-like" (curve morbide) con colore unico
import React, { useMemo, useRef, useLayoutEffect, useEffect, useState } from "react";

/* =============== Utils =============== */

function normalizeChainParents(list){
  const asc = [...list].sort((x,y)=> new Date(x.createdAt) - new Date(y.createdAt));
  let prevId = null;
  const patched = new Map();
  for (const v of asc) {
    const pid =
      v?.meta?.parentRevisionId ??
      v?.parentRevisionId ??
      v?.parentId ??
      null;
    if (!pid && prevId) {
      const meta = { ...(v.meta||{}) };
      meta.parentRevisionId = prevId;
      patched.set(v.id, meta);
    }
    prevId = v.id;
  }
  return list.map(v => patched.has(v.id) ? { ...v, meta: patched.get(v.id) } : v);
}

const truncate = (s, n) => String(s||"").length>n ? s.slice(0,n-1)+"…" : s;

function getScrollableAncestor(el){
  let node = el?.parentElement;
  while (node && node !== document.body){
    const style = getComputedStyle(node);
    const canScrollY = /(auto|scroll)/.test(style.overflowY);
    if (canScrollY && node.scrollHeight > node.clientHeight){
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function scrollIntoViewWithin(container, target, { align = "start", behavior = "smooth" } = {}){
  if (!container || !target) return;
  const cRect = container.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  const relativeTop = (tRect.top - cRect.top) + container.scrollTop;
  let top = relativeTop;
  if (align === "end") top = relativeTop - (container.clientHeight - tRect.height);
  else if (align === "center") top = relativeTop - (container.clientHeight/2 - tRect.height/2);
  container.scrollTo({ top, behavior });
}

/* Somma offsetLeft/Top fino ad ancestor (.vg-canvas) */
function offsetToAncestor(node, ancestor){
  let x = 0, y = 0;
  let el = node;
  while (el && el !== ancestor) {
    x += el.offsetLeft;
    y += el.offsetTop;
    el = el.offsetParent;
  }
  return { x, y };
}

/* =============== Component =============== */

export default function VersionGraph({
  versions = [],
  layoutVersionGraph,
  defaultVersionId,
  setDefaultVersion,
  openVersion,
  cardWidth = 300,
}) {
  // Colore unico per tutto (rami, dot, bordi); usa --accent se definito
  const EDGE_COLOR = "#1E3A8A";

  const scrollRef  = useRef(null);    // contenitore scrollabile
  const canvasRef  = useRef(null);    // sistema di riferimento
  const cardRefs   = useRef(new Map());
  const [edges, setEdges] = useState([]);

  // base
  const itemsRaw = useMemo(() => {
    const base = typeof layoutVersionGraph === "function"
      ? layoutVersionGraph(versions, { trunkId: defaultVersionId })
      : versions;
    return base || [];
  }, [versions, defaultVersionId, layoutVersionGraph]);

  const itemsWithParents = useMemo(() => normalizeChainParents(itemsRaw), [itemsRaw]);

  // newest → oldest (35,34,…,1)
  const itemsDesc = useMemo(
    () => [...itemsWithParents].sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt)),
    [itemsWithParents]
  );

  const byId = useMemo(() => new Map(itemsDesc.map(v => [v.id, v])), [itemsDesc]);

  const versionNumberOf = useMemo(() => {
    const m = new Map();
    const total = itemsDesc.length;
    itemsDesc.forEach((v, i) => m.set(v.id, total - i));
    return m;
  }, [itemsDesc]);

  // profondità genealogica (per indent inverso)
  const depthOf = useMemo(() => {
    const memo = new Map();
    const visiting = new Set();
    const getDepth = (id) => {
      if (memo.has(id)) return memo.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const p = byId.get(id)?.meta?.parentRevisionId;
      const d = (p && byId.has(p)) ? (getDepth(p) + 1) : 0;
      memo.set(id, d);
      visiting.delete(id);
      return d;
    };
    for (const v of itemsDesc) getDepth(v.id);
    return memo;
  }, [itemsDesc, byId]);

  const maxDepth = Math.max(...depthOf.values(), 0);

  // Colore unico per tutti i nodi
  const colorOf = useMemo(() => {
    const m = new Map();
    for (const v of itemsDesc) m.set(v.id, EDGE_COLOR);
    return m;
  }, [itemsDesc]);

  /* ---- Calcolo edges: curve "ReactFlow-like" ma con start/end esatti ----
     Per ogni parent→child:
     - x = right del child (attacco verticale sulla colonna del figlio)
     - yTop   = top del parent  (angolo in alto a dx del parent)
     - yBottom= bottom del child (angolo in basso a dx del child)
     Path: M x,yTop  C x+k,yTop  x+k,yBottom  x,yBottom
     → piccola “pancia” verso destra che arrotonda l’attaccatura.
  */
  const recalcEdges = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const k = 18; // raggio/ampiezza curva laterale (regola qui lo “stile ReactFlow”)
    const next = [];
    for (const v of itemsDesc) {
      const childId = v.id;
      const parentId = v?.meta?.parentRevisionId;
      if (!parentId || !byId.has(parentId)) continue;

      const childEl  = cardRefs.current.get(childId);
      const parentEl = cardRefs.current.get(parentId);
      if (!childEl || !parentEl) continue;

      const pc = offsetToAncestor(parentEl, canvas);
      const cc = offsetToAncestor(childEl,  canvas);

      const x  = cc.x + childEl.offsetWidth;   // colonna destra del child (stessa per start/end)
      const yTop    = pc.y;                          // top del parent
      const yBottom = cc.y + childEl.offsetHeight - 6;   // bottom del child

      const d = `M ${x},${yTop} C ${x+k},${yTop} ${x+k},${yBottom} ${x},${yBottom}`;

      next.push({
        key: `${childId}->${parentId}`,
        d,
        color: EDGE_COLOR,
      });
    }
    setEdges(next);
  };

  const recalcSoon = () => {
    requestAnimationFrame(() => requestAnimationFrame(recalcEdges));
  };

  useLayoutEffect(() => {
    recalcSoon();

    const scrollEl = scrollRef.current;
    const canvasEl = canvasRef.current;
    if (!scrollEl || !canvasEl) return;

    const ro = new ResizeObserver(() => recalcSoon());
    ro.observe(canvasEl);
    ro.observe(document.documentElement);

    const onScroll = () => recalcSoon();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    return () => {
      ro.disconnect();
      scrollEl.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsDesc.length]);

  useEffect(() => { recalcSoon(); });

  // dimensioni canvas per lo svg
  const canvasSize = (() => {
    const el = canvasRef.current;
    if (!el) return { w: 0, h: 0 };
    const list = el.querySelector(".vg-root");
    const w = Math.max(el.clientWidth,  list?.scrollWidth  || 0);
    const h = Math.max(el.clientHeight, list?.scrollHeight || 0);
    return { w, h };
  })();

  // pulizia ref a ogni render
  cardRefs.current.clear();

  return (
    <div
      ref={scrollRef}
      style={{
        overflow: "auto",
        borderRadius: 12,
        padding: 12,
        marginRight: 12,
        ["--vg-card-w"]: `${cardWidth}px`,
        ["--vg-indent"]: "28px",
        ["--accent"]: "#1E3A8A",
      }}
    >
      <div ref={canvasRef} className="vg-canvas" style={{ position:"relative", width:"max-content" }}>
        <style>{`
          .vg-root{
            list-style:none;
            margin:0;
            padding:0;
            display:flex;
            flex-direction:column;        /* 35 → 1 dall'alto al basso */
            align-items:flex-start;
            gap:.25rem;
            position:relative;
            z-index:2;
            width:max-content;
          }
          .vg-li{position:relative;margin:.25rem 0;width:max-content;}

          .vg-card{
            position:relative;
            background:#fff;
            border:1px dashed var(--line-0,rgba(0,0,0,.12));
            border-radius:12px;
            padding:12px;
            box-shadow:0 1px 2px rgba(0,0,0,.04);
            border-left:4px solid var(--accent,#2457ff); /* colore unico */
            width:var(--vg-card-w,420px);
            max-width:none;
            box-sizing:border-box;
            display:block;
            /* indent inverso: più recente a sx, più vecchie a dx */
            margin-left:calc((var(--vg-maxdepth,0) - var(--vg-depth,0)) * var(--vg-indent,28px));
          }
          .vg-card--fav{
            background:color-mix(in oklab,var(--vg-flash,#2457ff) 6%,#fff);
          }

          .vg-head{display:flex;align-items:center;gap:10px;}
          .vg-dot{width:10px;height:10px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08); background: var(--accent,#2457ff);} /* colore unico */
          .vg-title{flex:1;font:700 14px/1.3 system-ui;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
          .vg-star{font-size:18px;background:none;border:none;cursor:pointer;line-height:1;padding:0;margin:0;user-select:none;}
          .vg-star--on{color:var(--accent,#2457ff);}
          .vg-star--off{color:rgba(0,0,0,.35);}
          .vg-meta{margin-top:6px;font:11px/1.4 system-ui;color:#666;display:flex;gap:8px;flex-wrap:wrap;}
          .vg-parentlink{border:1px dashed rgba(0,0,0,.12);background:linear-gradient(#fdfdfd,#f8f8f8);color:#222;border-radius:999px;cursor:pointer;font:12px/1.1 system-ui;}
          .vg-notes{margin-top:8px;font:12px/1.5 system-ui;color:#222;}
          .vg-flash{animation:vgBgFlash 1s ease;}
          @keyframes vgBgFlash{0%{background-color:color-mix(in oklab,var(--vg-flash) 18%,#fff);}100%{background-color:#fff;}}

          .vg-edges{position:absolute; left:0; top:0; z-index:1; pointer-events:none;}
        `}</style>

        {/* Layer connettori: curve morbide (start/end precisi) */}
        <svg
          className="vg-edges"
          width={canvasSize.w}
          height={canvasSize.h}
          viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}
        >
          {edges.map(e => (
            <path
              key={e.key}
              d={e.d}
              fill="none"
              stroke={e.color}
              strokeWidth="2.25"
              strokeLinecap="round"
              opacity="0.95"
            />
          ))}
        </svg>

        {/* Lista lineare 35→…→1 con indent inverso */}
        <ul className="vg-root">
          {itemsDesc.map(v => {
            const id = v.id;
            const parentId = v?.meta?.parentRevisionId;
            const isDefault = id === defaultVersionId;
            const color = EDGE_COLOR; 
            const depth = depthOf.get(id) || 0;
            const versionLabel = `Version ${versionNumberOf.get(id) || "?"}`;
            const originalTitle = v?.meta?.aiTitle || v?.title || v?.id;

            return (
              <li key={id} className="vg-li" id={"vg-"+id}>
                <div
                  ref={(el)=>{ if (el) cardRefs.current.set(id, el); }}
                  className={`vg-card${isDefault ? " vg-card--fav" : ""}`}
                  style={{
                    borderLeftColor: color,
                    ["--vg-flash"]: color,
                    ["--vg-depth"]: depth,
                    ["--vg-maxdepth"]: maxDepth
                  }}
                  onClick={() => openVersion?.(id)}
                  role="button"
                  aria-label={`Open ${versionLabel}`}
                  title={originalTitle ? `Original: ${originalTitle}` : versionLabel}
                >
                  <div className="vg-head">
                    <div className="vg-dot" />
                    <div className="vg-title">{versionLabel}</div>
                    <button
                      className={`vg-star ${isDefault ? "vg-star--on" : "vg-star--off"}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isDefault) setDefaultVersion?.(id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (isDefault) setDefaultVersion?.(null);
                      }}
                    >
                      {isDefault ? "★" : "☆"}
                    </button>
                  </div>

                  <div className="vg-meta">
                    <span>{new Date(v.createdAt).toLocaleString()}</span>
                    {v.createdBy && <span>· {v.createdBy}</span>}
                    {parentId && byId.has(parentId) && (
                      <>
                        <span>· Parent:</span>
                        <button
                          className="vg-parentlink"
                          onClick={(e) => {
                            e.stopPropagation();
                            const el = document.getElementById("vg-" + parentId);
                            if (!el) return;
                            let container = scrollRef.current;
                            if (!container || container.scrollHeight <= container.clientHeight) {
                              container = getScrollableAncestor(el);
                            }
                            scrollIntoViewWithin(container, el, { align: "start", behavior: "smooth" });
                            const card = el.querySelector(".vg-card");
                            if (card) {
                              card.classList.add("vg-flash");
                              setTimeout(() => card.classList.remove("vg-flash"), 900);
                            }
                          }}
                          title={`Go to parent (Original: ${truncate(byId.get(parentId)?.title || parentId, 80)})`}
                        >
                          {`Version ${versionNumberOf.get(parentId) ?? "?"}`}
                        </button>
                      </>
                    )}
                  </div>

                  {v.notes && <div className="vg-notes">{v.notes}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
