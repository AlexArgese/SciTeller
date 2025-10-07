import { useEffect, useMemo, useState } from "react";
import styles from "./Login.module.css";

export default function Login() {
  const [csrf, setCsrf] = useState("");

  useEffect(() => {
    document.body.setAttribute("data-route", "login");
    return () => document.body.removeAttribute("data-route");
  }, []);

  // preleva il CSRF token (imposta anche il cookie di sessione CSRF)
  useEffect(() => {
    fetch("/api/auth/csrf", { credentials: "include" })
      .then(r => r.json())
      .then(d => setCsrf(d?.csrfToken || ""))
      .catch(() => setCsrf(""));
  }, []);

  const callbackUrl = useMemo(
    () => window.location.origin + "/stories",
    []
  );

  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  const errorMap = {
    Configuration: "Auth non configurata (NEXTAUTH_URL/SECRET o redirect provider).",
    OAuthSignin: "Errore all’avvio dell’OAuth (credenziali).",
    OAuthCallback: "Errore nel callback (redirect URI/domìni autorizzati).",
    OAuthAccountNotLinked: "Email già usata con altro provider: usa quello originale.",
    AccessDenied: "Accesso negato dal provider.",
    Default: "Si è verificato un problema. Riprova.",
  };

  return (
    <main className="container">
      <section className={styles.panel} aria-labelledby="login-title">
        <header className={styles.hero}>
          <h1 id="login-title">Sign in</h1>
          <p className={styles.sub}>
            Choose a provider to continue. You’ll be redirected back to your stories.
          </p>
        </header>

        {error && (
          <div className={styles.alert} role="status" aria-live="polite">
            <strong>Login error:</strong> {errorMap[error] || errorMap.Default}
          </div>
        )}

        <div className={styles.actions}>
          {/* GOOGLE — POST + CSRF */}
          <form method="POST" action="/api/auth/signin/google" className={styles.form}>
            <input type="hidden" name="csrfToken" value={csrf} />
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <button type="submit" className={`${styles.btn} ${styles.google}`}>
              <span className={styles.icn} aria-hidden>
                <svg viewBox="0 0 48 48" width="20" height="20">
                  <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.9 0-12.5-5.6-12.5-12.5S17.1 11 24 11c3.2 0 6.2 1.2 8.5 3.2l5.7-5.7C34.3 4.9 29.4 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.3-.4-3.5z"/>
                  <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.8 16.2 19 13 24 13c3.2 0 6.2 1.2 8.5 3.2l5.7-5.7C34.3 4.9 29.4 3 24 3 16.2 3 9.5 7.4 6.3 14.7z"/>
                  <path fill="#4CAF50" d="M24 45c5.2 0 10-2 13.5-5.2l-6.2-5.1c-2 1.4-4.5 2.3-7.3 2.3-5.2 0-9.7-3.3-11.3-8l-6.5 5C9.4 40.7 16.1 45 24 45z"/>
                  <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.7 2-2.1 3.8-3.9 5.1l6.2 5.1C39.1 39 45 34.5 45 24c0-1.2-.1-2.3-.4-3.5z"/>
                </svg>
              </span>
              Continue with Google
            </button>
          </form>

          {/* GITHUB — POST + CSRF */}
          <form method="POST" action="/api/auth/signin/github" className={styles.form}>
            <input type="hidden" name="csrfToken" value={csrf} />
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <button type="submit" className={`${styles.btn} ${styles.github}`}>
              <span className={styles.icn} aria-hidden>
                <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.63 5.47 7.71.4.08.55-.18.55-.39 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.5-2.69-.96-.09-.24-.48-.97-.82-1.17-.28-.15-.68-.52-.01-.53.63-.01 1.08.59 1.23.84.72 1.21 1.87.87 2.33.66.07-.53.28-.87.51-1.07-1.78-.21-3.64-.92-3.64-4.09 0-.9.31-1.64.82-2.22-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.85.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.07 2.2-.85 2.2-.85.44 1.1.16 1.92.08 2.12.51.58.82 1.33.82 2.22 0 3.18-1.87 3.87-3.65 4.08.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.47.55.39C13.71 14.76 16 11.72 16 8.13 16 3.64 12.42 0 8 0z"/>
                </svg>
              </span>
              Continue with GitHub
            </button>
          </form>
        </div>

        <p className={styles.note}>
        </p>
      </section>
    </main>
  );
}
