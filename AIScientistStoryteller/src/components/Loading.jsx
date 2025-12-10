import { useEffect, useMemo, useState } from "react";
import styles from "./Loading.module.css";

import Lottie from "lottie-react";
import animationData from "../assets/data.json";

/**
 * Full-page Loading screen.
 */
export default function Loading({
  title = "AI Scientist Storyteller",
  subtitle = "Working…",
  phase = "generic",
  extractMsgs = ["Extracting…"],
  storyMsgs = ["Generating…"],
  genericMsgs = ["Loading…"],
  timeline = [],
  currentStep = -1,
  inQueue = false,
  progress = 0,
}) {
  const pct = Math.round((progress || 0) * 100);
  const TICK_MS = 2600;
  const PHASE_CHANGE_FREEZE_MS = 3200;

  const activeMsgs = useMemo(() => {
    if (phase === "extract") return extractMsgs?.length ? extractMsgs : ["Extracting…"];
    if (phase === "story")   return storyMsgs?.length ? storyMsgs : ["Generating…"];
    return genericMsgs?.length ? genericMsgs : ["Loading…"];
  }, [phase, extractMsgs, storyMsgs, genericMsgs]);

  const [tickIndex, setTickIndex] = useState(0);
  const [freeze, setFreeze] = useState(true);

  useEffect(() => {
    setTickIndex(0);
    setFreeze(true);

    const tFreeze = setTimeout(() => setFreeze(false), PHASE_CHANGE_FREEZE_MS);
    const tTicker = setInterval(() => {
      setTickIndex((i) => {
        if (freeze) return i;
        return (i + 1) % activeMsgs.length;
      });
    }, TICK_MS);

    return () => {
      clearTimeout(tFreeze);
      clearInterval(tTicker);
    };
  }, [phase, activeMsgs.length, freeze]);

  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-busy="true" aria-live="polite">
        <div className={styles.hero}>
          <h1 className={styles.h1}>{title}</h1>
          <p className={styles.heroP}>{subtitle}</p>
        </div>

        <div className={styles.body}>
          <div className={styles.center}>
            <div className={styles.loadingContainer}>
              <Lottie
                animationData={animationData}
                loop
                autoplay
                style={{ width: 200, height: 200 }}
              />
            </div>
          </div>

          {/* Progress bar orizzontale */}
          <div className={styles.progressRow}>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressFill}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={styles.progressLabel}>
              {inQueue ? "In queue…" : `${pct}%`}
            </span>
          </div>

          <div className={`${styles.ticker} ${styles.glass}`} aria-live="polite">
            <div key={`${phase}-${tickIndex}`} className={styles.tick}>
              {activeMsgs[tickIndex] || "Starting…"}
            </div>
          </div>

          {Array.isArray(timeline) && timeline.length > 0 && (
            <div className={styles.timeline}>
              {timeline.map((t, i) => (
                <div
                  key={i}
                  className={styles.timelineItem}
                  aria-current={i === currentStep ? "step" : undefined}
                >
                  <span className={styles.timelineBullet}>
                    {i < currentStep ? "✓" : i === currentStep ? "•" : "○"}
                  </span>
                  <span className={styles.timelineText}>
                    {`${i + 1}. ${t}`}
                  </span>
                </div>
              ))}
            </div>
          )}

          {inQueue && (
            <div className={styles.queueNotice}>
              The server is currently busy with other users.
              <br />
              You are now in queue — your request will start automatically.
            </div>
          )}

          <div className={styles.caption}>
            Please keep this tab open while we work.
          </div>
        </div>
      </section>
    </main>
  );
}
