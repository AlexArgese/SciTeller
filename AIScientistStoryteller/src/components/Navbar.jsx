import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { getMe, signOut } from "../services/authApi";
import styles from "./Navbar.module.css";

const NAV_ITEMS = [
  { label: "New Story", href: "/" },
  { label: "My Stories", href: "/stories" },
  { label: "About", href: "/about" },
];

export default function Navbar() {
  const location = useLocation();
  const isLoginPage = location.pathname.startsWith("/login");

  const [me, setMe] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const tabsRef = useRef(null);
  const indicatorRef = useRef(null);
  const hoverTimer = useRef(null);

  // fetch utente
  useEffect(() => {
    getMe().then(setMe).catch(() => setMe(null));
  }, []);

  // indicator animato
  useEffect(() => {
    if (isLoginPage || !tabsRef.current || !indicatorRef.current) return;
    const active = tabsRef.current.querySelector(`.${styles.linkActive}`);
    if (!active) return;

    const { offsetLeft, offsetWidth } = active;
    indicatorRef.current.style.transform = `translateX(${offsetLeft}px)`;
    indicatorRef.current.style.width = `${offsetWidth}px`;
  }, [location.pathname, isLoginPage]);

  // chiudi menu al cambio rotta
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // chiudi con ESC
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const handleLogout = async () => {
    await signOut("/");
    setMe(null);
    setConfirmLogout(false);
  };

  // hover helpers (ritardo chiusura per evitare flicker)
  const openMenu = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setMenuOpen(true);
  };

  const closeMenu = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setMenuOpen(false), 120);
  };

  const toggleMenuOnClick = () => setMenuOpen((v) => !v);

  return (
    <>
      <header className={styles.navbar}>
        <div className={styles.inner}>
          {/* LEFT: brand */}
          <div className={styles.left}>
            <img src="logoNObg2.png" alt="logo" className={styles.logo} />
            <NavLink to="/" className={styles.brand}>
              SciTeller
            </NavLink>
          </div>

          {/* CENTER: tabs */}
          {!isLoginPage && (
            <nav ref={tabsRef} className={styles.tabs}>
              <span className={styles.indicator} ref={indicatorRef} />
              {NAV_ITEMS.map(({ label, href }) => (
                <NavLink
                  key={href}
                  to={href}
                  end={href === "/"}
                  className={({ isActive }) =>
                    `${styles.link} ${isActive ? styles.linkActive : ""}`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          )}

          {/* RIGHT: login/avatar */}
          <div className={styles.right}>
            {me ? (
              <div
                className={styles.avatarWrap}
                onMouseEnter={openMenu}
                onMouseLeave={closeMenu}
                onFocus={openMenu}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget)) {
                    closeMenu();
                  }
                }}
              >
                <button
                  className={styles.avatarBtn}
                  onClick={toggleMenuOnClick}
                >
                  <img
                    src={me.avatar_url}
                    alt={me.name}
                    className={styles.avatarImg}
                  />
                </button>

                {menuOpen && (
                  <div className={styles.menu}>
                    <div className={styles.menuHeader}>
                      <div>
                        <div className={styles.menuName}>{me.name}</div>
                        {me.email && (
                          <div className={styles.menuEmail}>{me.email}</div>
                        )}
                      </div>
                    </div>
                    <button
                      className={styles.menuItem}
                      onClick={() => setConfirmLogout(true)}
                    >
                      Logout
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                className={styles.btn}
                onClick={() => (window.location.href = "/login")}
              >
                Login
              </button>
            )}
          </div>
        </div>
      </header>

      {/* MODAL LOGOUT */}
      {confirmLogout && (
        <div
          className={styles.confirmOverlay}
          onClick={() => setConfirmLogout(false)}
        >
          <div
            className={styles.confirmDialog}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={styles.confirmTitle}>Log out?</h3>
            <p className={styles.confirmText}>
              You will be signed out from this device.
            </p>
            <div className={styles.confirmActions}>
              <button
                className={styles.modalBtnGhost}
                onClick={() => setConfirmLogout(false)}
              >
                Cancel
              </button>
              <button
                className={styles.modalBtnPrimary}
                onClick={handleLogout}
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
