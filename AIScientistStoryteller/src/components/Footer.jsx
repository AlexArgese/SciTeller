import { useEffect, useRef } from "react";
import styles from "./Footer.module.css";

export default function Footer() {
  const ref = useRef(null);
  useEffect(() => {
    const setVar = () => {
      if (ref.current) {
        document.documentElement.style.setProperty("--footer-h", `${ref.current.offsetHeight}px`);
      }
    };
    setVar();
    window.addEventListener("resize", setVar);
    return () => window.removeEventListener("resize", setVar);
  }, []);

  return (
    <footer ref={ref} className={`${styles.footer}`}> 
      <div className={styles.logo}>Logo</div>
      <div className={styles.copy}>© 2025 AI Scientist Storyteller</div>
      <a className={styles.gh} href="https://github.com/AlexArgese/ai-scientist-storyteller.git" target="_blank" rel="noreferrer" aria-label="GitHub">
        <svg width="32" height="32" viewBox="0 0 24 24" aria-hidden>
          <path fill="#000" d="M12 .5a12 12 0 0 0-3.79 23.4c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.4-1.34-1.77-1.34-1.77-1.09-.74.08-.72.08-.72 1.2.09 1.83 1.23 1.83 1.23 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.23-3.22-.12-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.17.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.23v3.31c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" />
        </svg>
      </a>
    </footer>
  );
}
