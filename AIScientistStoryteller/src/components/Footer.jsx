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
      <div className={styles.copy}>© 2025 | EURECOM </div>
      <img className={styles.logo} src="logoNObg2.png" />
      <div className={styles.copy}>AI Scientist Storyteller</div>
    </footer>
  );
}
