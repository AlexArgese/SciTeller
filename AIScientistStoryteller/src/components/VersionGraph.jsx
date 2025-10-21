// VersionGraph.jsx — “Version X” + scroll robusto + CARD a larghezza fissa + scroll orizzontale
import React, { useMemo, useRef } from "react";

// ————————————————————————————————————————————
// Utils
function normalizeChainParents(list){
  const a = [...list].sort((x,y)=> new Date(x.createdAt) - new Date(y.createdAt));
  let prevId = null;
  return a.map(v => {
    const pid =
      v?.meta?.parentRevisionId ??
      v?.parentRevisionId ??
      v?.parentId ??
      null;
    const meta = { ...(v.meta||{}) };
    if (!pid && prevId) meta.parentRevisionId = prevId;
    prevId = v.id;
    return { ...v, meta };
  });
}
const truncate = (s, n) => String(s||"").length>n ? s.slice(0,n-1)+"…" : s;

// Trova l'antenato scrollabile reale del target
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
  // fallback: documento
  return document.scrollingElement || document.documentElement;
}

// Scroll preciso dentro ad un contenitore (senza forzare il centro)
function scrollIntoViewWithin(container, target, { align = "start", behavior = "smooth" } = {}){
  if (!container || !target) return;
  const cRect = container.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();

  // distanza del target dal top del container (incluso scroll attuale)
  const relativeTop = (tRect.top - cRect.top) + container.scrollTop;
  let top = relativeTop;
  if (align === "end") {
    top = relativeTop - (container.clientHeight - tRect.height);
  } else if (align === "center") {
    top = relativeTop - (container.clientHeight/2 - tRect.height/2);
  }
  container.scrollTo({ top, behavior });
}

export default function VersionGraph({
  versions = [],
  layoutVersionGraph,
  defaultVersionId,          // ← ID del preferito persistente
  setDefaultVersion,         // ← funzione per impostare/rimuovere il preferito
  openVersion,               // ← apre/visualizza una versione (non tocca il default)
  // Nuovo: larghezza fissa card (puoi cambiare il default)
  cardWidth = 300
}) {
  const palette = ["#1E3A8A","#244393","#2B4FA5","#3560C0","#4070D8","#4C80EE","#5A8FFD"];
  const selfScrollRef = useRef(null); // se vuoi forzare un contenitore specifico

  // 1) pipeline base + ordinamento cronologico stabile
  const itemsAsc = useMemo(() => {
    const base = typeof layoutVersionGraph === "function"
      ? layoutVersionGraph(versions, { trunkId: defaultVersionId })
      : versions;
    return normalizeChainParents(base);
  }, [versions, defaultVersionId, layoutVersionGraph]);

  // 2) mappe utili
  const byId = useMemo(() => new Map(itemsAsc.map(v => [v.id, v])), [itemsAsc]);

  // 3) numerazione globale “Version X”
  const versionNumberOf = useMemo(() => {
    const m = new Map();
    itemsAsc.forEach((v, i) => m.set(v.id, i + 1));
    return m;
  }, [itemsAsc]);

  // 4) struttura ad albero + colori
  const { roots, childrenOf, colorOf } = useMemo(() => {
    const children = new Map();
    const seen = new Set(itemsAsc.map(v=>v.id));
    for (const v of itemsAsc) {
      const p = v.meta?.parentRevisionId;
      if (!p) continue;
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(v.id);
    }
    const rootsArr = itemsAsc.filter(v => !v.meta?.parentRevisionId || !seen.has(v.meta.parentRevisionId));
    const colorMap = new Map();
    rootsArr.forEach((r,i)=>colorMap.set(r.id, palette[i % palette.length]));
    const assignColor = (rootId, nodeId) => {
      colorMap.set(nodeId, colorMap.get(rootId));
      (children.get(nodeId)||[]).forEach(k=>assignColor(rootId,k));
    };
    rootsArr.forEach(r=>{
      (children.get(r.id)||[]).forEach(k=>assignColor(r.id,k));
    });
    for (const [pid, arr] of children.entries()) {
      arr.sort((a,b)=>new Date(byId.get(a)?.createdAt)-new Date(byId.get(b)?.createdAt));
    }
    return { roots: rootsArr, childrenOf: children, colorOf: colorMap };
  }, [itemsAsc]);

  const Node = ({ id }) => {
    const v = byId.get(id);
    if (!v) return null;

    const color = colorOf.get(id) || "var(--accent)";
    const kids = childrenOf.get(id) || [];
       const parentId = v.meta?.parentRevisionId;
    const isDefault = v.id === defaultVersionId;

    const versionLabel = `Version ${versionNumberOf.get(id) || "?"}`;
    const originalTitle = v.meta?.aiTitle || v.title || v.id;

    return (
      <li
        className="vg-li"
        id={"vg-" + id}
        style={{ "--vg-branch-color": color }}
      >
        <div
          className={`vg-card${isDefault ? " vg-card--fav" : ""}`}
          style={{
            borderLeftColor: color,
            "--vg-flash": color,
            "--vg-branch-color": color
          }}
          onClick={() => openVersion?.(id)}
          role="button"
          aria-label={`Open ${versionLabel}`}
          title={originalTitle ? `Original: ${originalTitle}` : versionLabel}
        >
          <div className="vg-head">
            <div className="vg-dot" style={{ background: color }} />
            <div className="vg-title">{versionLabel}</div>

            <button
              className={`vg-star ${isDefault ? "vg-star--on" : "vg-star--off"}`}
              title={isDefault ? "Favorite" : "Set as favorite"}
              onClick={(e) => {
                e.stopPropagation();
                if (!isDefault) setDefaultVersion?.(v.id);
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

                    // 1) prova a usare il contenitore dichiarato nel componente
                    let container = selfScrollRef.current;

                    // 2) se non è valido / non scrollabile, trova l’ancestor scrollabile reale del target
                    if (!container || container.scrollHeight <= container.clientHeight) {
                      container = getScrollableAncestor(el);
                    }

                    // 3) scroll allineato in alto (start), non al centro
                    scrollIntoViewWithin(container, el, { align: "start", behavior: "smooth" });

                    // 4) flash visivo
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

        {kids.length > 0 && (
          <ul className="vg-ul">
            {kids.map((cid) => (
              <Node key={cid} id={cid} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div
      ref={selfScrollRef}
      style={{
        // Cambiato: attiva scroll orizzontale
        overflowY: "auto",
        overflowX: "auto",
        borderRadius: 12,
        padding: 12,
        marginRight:12,
        // passa la width fissa via CSS var, utile se vuoi cambiarla da prop
        ["--vg-card-w"]: `${cardWidth}px`,
      }}
    >
      <style>{`
        .vg-ul { list-style:none; margin:0; padding-left:1.25rem; position:relative; }
        .vg-li { position:relative; margin:.25rem 0; }

        .vg-ul > .vg-li::before {
          content: "";
          position: absolute;
          left: 0.25rem;
          top: 0.3rem;
          bottom: 0.5rem;
          width: 2px;
          --vg-branch-line: color-mix(in oklab, var(--vg-branch-color, var(--accent)) 65%, transparent);
          background: repeating-linear-gradient(
            to bottom,
            var(--vg-branch-line) 0 6px,
            transparent 6px 12px
          );
          border-radius: 0px;
        }
        .vg-li > .vg-card::before {
          content: "";
          position: absolute;
          left: -1.25rem;
          top: 1.35rem;
          height: 2px;
          width: 1.1rem;
          --vg-branch-line: color-mix(in oklab, var(--vg-branch-color, var(--accent)) 65%, transparent);
          background: repeating-linear-gradient(
            to right,
            var(--vg-branch-line) 0 6px,
            transparent 6px 12px
          );
          border-radius: 2px;
        }

        .vg-card{
          position:relative;
          background:#fff;
          border:1px dashed var(--line-0);
          border-radius:12px;
          padding:12px;
          box-shadow:0 1px 2px rgba(0,0,0,.04);
          border-left:4px solid var(--accent,#0ea5e9);
          transition:background-color .25s ease;

          /* NUOVO: larghezza fissa e no shrink, per abilitare orizzontale se serve */
          width: var(--vg-card-w, 420px);
          max-width: none;
          box-sizing: border-box;
          flex-shrink: 0;
          display: block;
        }
        .vg-card--fav{
          background: color-mix(in oklab, var(--vg-flash, #0ea5e9) 6%, #fff);
        }

        .vg-head{display:flex;align-items:center;gap:10px;}
        .vg-dot{width:10px;height:10px;border-radius:5px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);}
        .vg-title{flex:1;font:700 14px/1.3 system-ui;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

        .vg-star{
          font-size:18px;
          background:none;border:none;cursor:pointer;line-height:1;padding:0;margin:0;user-select:none;
        }
        .vg-star--on{ color: var(--accent,#0ea5e9); }
        .vg-star--off{ color: rgba(0,0,0,.35); }
        .vg-star:hover{ transform: scale(1.08); }

        .vg-meta{margin-top:6px;font:11px/1.4 system-ui;color:#666;display:flex;gap:8px;flex-wrap:wrap;}
        .vg-parentlink{
          border:1px dashed rgba(0,0,0,.12);
          background:linear-gradient(#fdfdfd,#f8f8f8);
          color:#222;padding:4px 8px;border-radius:999px;cursor:pointer;
          font:12px/1.1 system-ui;
        }
        .vg-notes{margin-top:8px;font:12px/1.5 system-ui;color:#222;}

        .vg-flash{animation:vgBgFlash 1s ease;}
        @keyframes vgBgFlash{
          0%{background-color:color-mix(in oklab, var(--vg-flash) 18%, #fff);}
          100%{background-color:#fff;}
        }
      `}</style>

      <ul className="vg-ul" style={{ paddingLeft: 0 }}>
        {roots.map(r => <Node key={r.id} id={r.id} />)}
      </ul>
    </div>
  );
}
