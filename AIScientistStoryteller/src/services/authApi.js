// src/services/authApi.js
export async function getMe() {
    const r = await fetch('/api/me?ts=' + Date.now(), {
      credentials: 'include',
      cache: 'no-store',
    });
    if (r.status === 401) return null;
    if (!r.ok) throw new Error('Failed /api/me');
    return r.json();
  }
  
  async function getCsrfToken() {
    const r = await fetch('/api/auth/csrf', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!r.ok) throw new Error('Failed /api/auth/csrf');
    const data = await r.json();
    return data.csrfToken;
  }
  
  export async function signOut(redirectTo = '/') {
    try {
      const csrfToken = await getCsrfToken();
      await fetch('/api/auth/signout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrfToken, callbackUrl: redirectTo })
      });
    } catch (e) {
      console.error('signOut error (continuo comunque con redirect):', e);
    } finally {
      // Hard redirect: forza remount della SPA e rilettura cookie
      window.location.replace(redirectTo);
    }
  }
  