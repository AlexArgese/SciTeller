import styles from "./About.module.css";
import { useEffect } from "react";

export default function About() {
    useEffect(() => {
        document.body.setAttribute("data-route", "about");
        return () => {
            document.body.removeAttribute("data-route");
        };
    }, []);

  return (
    <main className={`${styles.page}`}>
      {/* HERO */}
      <section className={styles.hero}>
        <h1 className={styles.title}>AI Scientist Storyteller</h1>
        <p className={styles.lead}>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec interdum nisi imperdiet enim rutrum,
          euismod molestie mauris fringilla. Fusce ac scelerisque arcu. Orci varius natoque penatibus et magnis
          dis parturient montes, nascetur ridiculus mus. Mauris luctus lacinia nulla et eleifend. Morbi rutrum
          gravida tortor in tristique. Integer tortor lectus, posuere id aliquet eget, condimentum id turpis.
          Pellentesque aliquet commodo ipsum euismod malesuada. Quisque malesuada elit nisi, quis ullamcorper
          odio suscipit et. Maecenas vitae accumsan massa, vitae vulputate libero.
        </p>
      </section>

      {/* DATASET */}
      <section className={styles.row}>
        <div className={styles.colText}>
          <h2 className={styles.h2}>The Dataset</h2>
          <p>
            Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec interdum nisi imperdiet enim rutrum,
            euismod molestie mauris fringilla. Fusce ac scelerisque arcu. Orci varius natoque penatibus et magnis
            dis parturient montes, nascetur ridiculus mus. Mauris luctus lacinia nulla et eleifend. Morbi rutrum
            gravida tortor in tristique. Integer tortor lectus, posuere id aliquet eget, condimentum id turpis.
            Pellentesque aliquet commodo ipsum euismod malesuada. Quisque malesuada elit nisi, quis ullamcorper
            odio suscipit et. Maecenas vitae accumsan massa, vitae vulputate libero.
          </p>
        </div>
        <div className={styles.colMedia}>
          <div className={styles.imgBox}><span>Image</span></div>
        </div>
      </section>

      {/* MODEL (flipped) */}
      <section className={`${styles.row} ${styles.flip}`}>
        <div className={styles.colMedia}>
          <div className={styles.imgBox}><span>Image</span></div>
        </div>
        <div className={styles.colText}>
          <h2 className={styles.h2}>The Model</h2>
          <p>
            Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec interdum nisi imperdiet enim rutrum,
            euismod molestie mauris fringilla. Fusce ac scelerisque arcu. Orci varius natoque penatibus et magnis
            dis parturient montes, nascetur ridiculus mus. Mauris luctus lacinia nulla et eleifend. Morbi rutrum
            gravida tortor in tristique. Integer tortor lectus, posuere id aliquet eget, condimentum id turpis.
            Pellentesque aliquet commodo ipsum euismod malesuada. Quisque malesuada elit nisi, quis ullamcorper
            odio suscipit et. Maecenas vitae accumsan massa, vitae vulputate libero.
          </p>
        </div>
      </section>

      {/* EVALUATION */}
      <section className={styles.row}>
        <div className={styles.colText}>
          <h2 className={styles.h2}>The Evaluation</h2>
          <p>
            Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec interdum nisi imperdiet enim rutrum,
            euismod molestie mauris fringilla. Fusce ac scelerisque arcu. Orci varius natoque penatibus et magnis
            dis parturient montes, nascetur ridiculus mus. Mauris luctus lacinia nulla et eleifend. Morbi rutrum
            gravida tortor in tristique. Integer tortor lectus, posuere id aliquet eget, condimentum id turpis.
            Pellentesque aliquet commodo ipsum euismod malesuada. Quisque malesuada elit nisi, quis ullamcorper
            odio suscipit et. Maecenas vitae accumsan massa, vitae vulputate libero.
          </p>
        </div>
        <div className={styles.colMedia}>
          <div className={styles.imgBox}><span>Image</span></div>
        </div>
      </section>

      {/* CREDITS */}
      <section className={styles.credits}>
        <h2 className={styles.h2}>Credits & Institutions</h2>

        <div className={styles.personBlock}>
          <div className={styles.personName}>Alex Argese</div>
          <p className={styles.personText}>
            Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec interdum nisi imperdiet enim rutrum,
            euismod molestie mauris fringilla.
          </p>
          <div className={styles.linksLabel}>Links</div>
        </div>

        <div className={styles.supervisors}>
          <div className={styles.supTitle}>Supervisor</div>
          <ul className={styles.supList}>
            <li>
              <div className={styles.supName}>Prof. Raphaël Troncy</div>
              <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec interdum nisi imperdiet enim rutrum,
                euismod molestie mauris fringilla.</p>
              <div className={styles.linksLabel}>Links</div>
            </li>
            <li>
              <div className={styles.supName}>Dr. Pasquale Lisena</div>
              <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec interdum nisi imperdiet enim rutrum,
                euismod molestie mauris fringilla.</p>
              <div className={styles.linksLabel}>Links</div>
            </li>
            <li>
              <div className={styles.supName}>Prof. Luigi De Russis</div>
              <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec interdum nisi imperdiet enim rutrum,
                euismod molestie mauris fringilla.</p>
              <div className={styles.linksLabel}>Links</div>
            </li>
          </ul>
        </div>
      </section>

      {/* INSTITUTIONS */}
      <section className={styles.institutions}>
        <div className={styles.instTitle}>Institutions</div>

        {/* Se hai i loghi in /public/logos/... li metti qui.
            In caso contrario restano dei box placeholder eleganti */}
        <div className={styles.instLogos}>
          <div className={styles.logoBox}>
            {/* esempio: <img src="/logos/eurecom.png" alt="EURECOM" /> */}
            <span>EURECOM</span>
          </div>
          <div className={styles.logoBox}>
            {/* esempio: <img src="/logos/polito.png" alt="Politecnico di Torino" /> */}
            <span>Politecnico di Torino</span>
          </div>
        </div>
      </section>
    </main>
  );
}
