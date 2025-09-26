import { useNavigate } from "react-router-dom";
import styles from "./Sidebar.module.css";

function displayTitle(s) {
  const t = s?.title || `Chat ${s?.id}`;
  if (/\.pdf$/i.test(t)) {
    return s?.meta?.aiTitle || t;
  }
  return t;
}

export default function Sidebar({
  items = [],
  selectedId,
  onSelect,
  onDelete,
  loading = false,
}) {
  const navigate = useNavigate();

  return (
    <aside className={`${styles.wrap} sidebarWrap`} aria-label="Stories sidebar">
      <div className={styles.panel}>
        {/* area scrollabile */}
        <div
          className={styles.scroll}
          role="listbox"
          aria-label="Stories list"
          aria-busy={loading ? "true" : "false"}
        >
          {loading && <div className={styles.loading}>Loading…</div>}

          {!loading && items.length === 0 && (
            <div className={styles.empty}>No stories yet.</div>
          )}

          {items.map((s) => {
            const active = selectedId === s.id;
            return (
              <div
                key={s.id}
                role="option"
                aria-selected={active}
                tabIndex={0}
                className={`${styles.item} ${active ? styles.active : ""}`}
                onClick={() => onSelect && onSelect(s.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect && onSelect(s.id);
                  }
                }}
              >
                <span className={styles.itemTitle}>{displayTitle(s)}</span>

                <button
                  className={styles.deleteBtn}
                  title="Delete story"
                  disabled={loading}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!onDelete || loading) return;
                    const ok = window.confirm(`Delete "${displayTitle(s)}"?`);
                    if (ok) onDelete(s.id);
                  }}
                  aria-label={`Delete ${displayTitle(s)}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
                       viewBox="0 0 24 24" fill="none" stroke="#000000"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4
                             a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                </button>
              </div>
            );
          })}
        </div>

        {/* footer fisso (NON scrolla) */}
        <div className={styles.footer}>
          <button
            className={styles.newBtn}
            onClick={() => navigate("/")}
            aria-label="Go to New Story"
          >
            + New Story
          </button>
        </div>
      </div>
    </aside>
  );
}
