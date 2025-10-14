import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./Navbar.module.css";
import { getMe, signOut } from "../services/authApi";
import GooeyNav from './GooeyNav'

const items = [
  { label: "New Story", href: "/" },
  { label: "My Stories", href: "/stories" },
  { label: "About", href: "/about" },
];

export default function Navbar() {
  const location = useLocation();
  const isLogin = location.pathname.startsWith("/login");

  const tabsRef = useRef(null);
  const headerRef = useRef(null);
  const underlineRef = useRef(null);

  // bubble sizing
  const PILL_PAD = 12;       // padding orizzontale della pill
  const SUSPICIOUS_W = 6;    // misura testo troppo piccola → retry
  const MIN_W_SAFE = 40;     // fallback se non abbiamo ancora l'altezza

  const [me, setMe] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const btnRef = useRef(null);
  const menuListRef = useRef(null);

  const [indicatorReady, setIndicatorReady] = useState(false);
  const posRef = useRef({ x: 0, w: 0 });

  const measureTarget = () => {
    const tabsEl = tabsRef.current;
    const bubbleEl = underlineRef.current;
    if (!tabsEl || !bubbleEl) return null;
  
    const activeLink =
      tabsEl.querySelector(`.${styles.link}.active`) ||
      tabsEl.querySelector(`.${styles.link}`);
    if (!activeLink) return null;
  
    const label = activeLink.querySelector(`.${styles.label}`) || activeLink;
  
    const c = tabsEl.getBoundingClientRect();
    const r = label.getBoundingClientRect();
  
    const textX = Math.round(r.left - c.left);
    const textW = Math.max(0, Math.round(r.width));
  
    // altezza reale (per clamp) con fallback
    const pillH = Math.max(bubbleEl.offsetHeight || 0, MIN_W_SAFE);
  
    // larghezza = testo + padding, ma MAI meno dell'altezza (niente “pallina”)
    const w = Math.max(textW + PILL_PAD * 2, pillH);
    const x = Math.max(0, textX - PILL_PAD);
  
    return { x, w };
  };
  

  const placeNow = () => {
    const el = underlineRef.current;
    const t = measureTarget();
    if (!el || !t) return false;
  
    el.getAnimations().forEach(a => a.cancel());
    el.style.transform = `translate3d(${t.x}px, 0, 0)`;
    el.style.width = `${t.w}px`;
    posRef.current = { x: t.x, w: t.w };
    if (!indicatorReady) setIndicatorReady(true);
    return true;
  };
  
  const placeAfterPaint = () => {
    requestAnimationFrame(() => requestAnimationFrame(placeNow));
  };

  // mount: prima misura dopo paint
  useLayoutEffect(() => {
    if (isLogin) return;
    placeAfterPaint();
  }, [isLogin]);


  // animazione tra posizioni quando la misura è pronta
  useEffect(() => {
    if (isLogin) return;
    const el = underlineRef.current;
    if (!el) return;
  
    const next = measureTarget();
    if (!next) { placeAfterPaint(); return; }
  
    const from = posRef.current;
    const to = next;
    if (from.x === to.x && from.w === to.w) {
      if (!indicatorReady) setIndicatorReady(true);
      return;
    }
  
    el.getAnimations().forEach(a => a.cancel());
    el.style.transform = `translate3d(${from.x}px, 0, 0)`;
    el.style.width = `${from.w}px`;
    // force layout
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;
  
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  
    const duration = prefersReduced ? 0 : 520;
    const easing = "cubic-bezier(.22,.61,.36,1)";
  
    const ink = el.animate(
      [
        { transform: `translate3d(${from.x}px, 0, 0)`, width: `${from.w}px` },
        { transform: `translate3d(${to.x}px, 0, 0)`,   width: `${to.w}px` }
      ],
      { duration, easing, fill: "forwards" }
    );
  
    ink.onfinish = () => {
      el.style.transform = `translate3d(${to.x}px, 0, 0)`;
      el.style.width = `${to.w}px`;
      posRef.current = to;
      if (!indicatorReady) setIndicatorReady(true);
    };
  }, [location.pathname, isLogin, indicatorReady]);
  

  // resize / fonts / load
  useEffect(() => {
    const sync = () => placeNow();
    const ro = new ResizeObserver(sync);
    if (tabsRef.current) ro.observe(tabsRef.current);
    window.addEventListener("resize", sync);
    document?.fonts?.ready?.then(() => placeAfterPaint()).catch(() => {});
    window.addEventListener("load", placeAfterPaint);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("load", placeAfterPaint);
    };
  }, []);

  // watch class changes inside tabs (per aria-current/class active)
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const mo = new MutationObserver(() => placeAfterPaint());
    mo.observe(el, { attributes: true, subtree: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  // set CSS var --nav-h
  useLayoutEffect(() => {
    const setVar = () => {
      if (headerRef.current) {
        document.documentElement.style.setProperty("--nav-h", `${headerRef.current.offsetHeight}px`);
      }
    };
    setVar();
    window.addEventListener("resize", setVar);
    return () => window.removeEventListener("resize", setVar);
  }, []);

  // auth
  useEffect(() => {
    getMe()
      .then((u) => {
        setMe(u);
        if (!u) {
          try {
            localStorage.removeItem("guest:stories:index");
            for (const k of Object.keys(localStorage)) {
              if (k.startsWith("guest:story:")) localStorage.removeItem(k);
            }
          } catch {}
        }
      })
      .catch(() => setMe(null));
  }, []);

  // menu handlers
  useEffect(() => {
    const onDoc = (e) => {
      if (!menuOpen) return;
      const t = e.target;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onEsc = (e) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const list = menuListRef.current;
    if (!list) return;
    const first = list.querySelector(`.${styles.menuItem}`);
    const h = first ? first.offsetHeight : 44;
    list.style.setProperty("--hover-h", h + "px");
    const logoutEl = list.querySelector(`.${styles.menuItemLogout}`);
    const y0 = logoutEl ? logoutEl.offsetTop : 0;
    list.style.setProperty("--hover-y", y0 + "px");
    list.style.setProperty("--hover-op", "1");
  }, [menuOpen]);

  const handleEnterItem = (e) => {
    const el = e.currentTarget;
    const list = menuListRef.current;
    if (!el || !list) return;
    list.style.setProperty("--hover-y", el.offsetTop + "px");
    list.style.setProperty("--hover-op", "1");
    if (el.dataset.role === "logout") list.classList.add(styles.isOverLogout);
    else list.classList.remove(styles.isOverLogout);
  };

  const doLogout = async () => {
    try {
      setMenuOpen(false);
      setConfirmOpen(false);
      setMe(null);
      await signOut("/");
    } catch {
      window.location.reload();
    }
  };

  const Tabs = () => (
    <nav className={styles.tabs} ref={tabsRef} aria-label="Primary">
      <span
        className={`${styles.underline} ${indicatorReady ? styles.underlineReady : ""}`}
        ref={underlineRef}
        aria-hidden="true"
      >
        <span className={styles.stroke} />
      </span>

      <NavLink to="/" end className={({ isActive }) => `${styles.link} ${isActive ? "active" : ""}`}>
        <span className={styles.label}>New story</span>
      </NavLink>

      <NavLink to="/stories" className={({ isActive }) => `${styles.link} ${isActive ? "active" : ""}`}>
        <span className={styles.label}>My stories</span>
      </NavLink>

      <NavLink to="/about" className={({ isActive }) => `${styles.link} ${isActive ? "active" : ""}`}>
        <span className={styles.label}>About</span>
      </NavLink>
    </nav>
  );

  return (
    <>
      <header ref={headerRef} className={styles.navbar} role="banner">
        <div className={styles.nav}>
  
          <div className={styles.left}>
            <img className={styles.logo} src="logoNObg2.png" />
            <NavLink to="/" end className={styles.brand} title="Home" aria-label="SciTeller, Home">
              <span className={styles.brandTxt}>SciTeller</span>
            </NavLink>
          </div>
  
          {!isLogin && <Tabs />}
  
          <div className={styles.right}>
            {me ? (
              <div className={styles.avatarWrap}>
                <button
                  ref={btnRef}
                  className={styles.avatarBtn}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen ? "true" : "false"}
                  aria-label="Account menu"
                  onClick={() => setMenuOpen((v) => !v)}
                  title={me?.name || me?.login || "Account"}
                >
                  <img src={me?.avatar_url} alt="" className={styles.avatarImg} width={28} height={28}/>
                </button>
  
                {menuOpen && (
                  <div
                    ref={menuRef}
                    role="menu"
                    className={`${styles.menu} ${styles.menuLeft}`}
                    aria-label="Account menu"
                  >
                    <div className={styles.menuArrow} aria-hidden />
                    <div className={styles.menuHeader}>
                      <img src={me?.avatar_url} alt="" className={styles.menuAvatar} width={32} height={32}/>
                      <div>
                        <div className={styles.menuName}>{me?.name || me?.login || "Account"}</div>
                        {me?.email && <div className={styles.menuSub}>{me.email}</div>}
                      </div>
                    </div>
  
                    <div
                      className={styles.menuList}
                      ref={menuListRef}
                      onMouseLeave={() => {
                        const list = menuListRef.current;
                        if (!list) return;
                        const logoutEl = list.querySelector(`.${styles.menuItemLogout}`);
                        const y0 = logoutEl ? logoutEl.offsetTop : 0;
                        list.style.setProperty("--hover-y", y0 + "px");
                        list.style.setProperty("--hover-op", "1");
                        list.classList.remove(styles.isOverLogout);
                      }}>
                      <div className={styles.menuHover} aria-hidden="true" />
                      <button
                        className={`${styles.menuItem} ${styles.menuItemLogout}`}
                        role="menuitem"
                        data-role="logout"
                        onMouseEnter={handleEnterItem}
                        onClick={() => { setConfirmOpen(true); }}
                      >
                        Logout
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                className={`${styles.btn} ${styles.chip}`}
                onClick={() => { window.location.href = "/login"; }}
                title="Login"
              >
                Login
              </button>
            )}
          </div>
        </div>
      </header>
  
      {confirmOpen && (
        <div className={styles.confirmOverlay} role="presentation" onClick={() => setConfirmOpen(false)}>
          <div className={styles.confirmDialog} role="dialog" aria-modal="true" aria-labelledby="logout-title" aria-describedby="logout-desc" onClick={(e) => e.stopPropagation()}>
            <div className={styles.confirmHeader}>
              <div className={styles.confirmIcon} aria-hidden>⚠️</div>
              <h3 id="logout-title" className={styles.confirmTitle}>Log out?</h3>
            </div>
            <p id="logout-desc" className={styles.confirmText}>You will be signed out from this device.</p>
            <div className={styles.confirmActions}>
              <button className={`${styles.modalBtn} ${styles.modalBtnGhost}`} onClick={() => setConfirmOpen(false)} autoFocus>Cancel</button>
              <button className={`${styles.modalBtn} ${styles.modalBtnPrimary}`} onClick={doLogout}>Logout</button>
            </div>
          </div>
        </div>
      )}
    </>
  );  
}
