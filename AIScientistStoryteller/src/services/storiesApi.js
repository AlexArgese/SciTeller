// AIScientistStoryteller/src/services/storiesApi.js
const API_BASE = import.meta.env.VITE_API_BASE || "/svc";

// ---- helpers comuni ----
async function callApi(url, opts = {}) {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store', ...opts });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, ok: r.ok, data, raw: r };
}

// ---- guest storage (ephemeral: vive finché non ricarichi la pagina) ----
const G_INDEX = 'guest:stories:index';
const G_PREFIX = 'guest:story:';

function gLoadIndex() { try { return JSON.parse(localStorage.getItem(G_INDEX)) || []; } catch { return []; } }
function gSaveIndex(idx) { localStorage.setItem(G_INDEX, JSON.stringify(idx)); }

function gList() {
  const idx = gLoadIndex();
  return idx.map(({ id }) => {
    try { return JSON.parse(localStorage.getItem(G_PREFIX + id)); } catch { return null; }
  }).filter(Boolean);
}

function gCreate(title = 'Story') {
  const id = String(Date.now());
  const now = new Date().toISOString();
  const item = {
    id, title, createdAt: now, updatedAt: now,
    visibility: 'private', current_revision_id: null,
    persona: null, meta: null, sections: [],
  };
  const idx = gLoadIndex(); idx.unshift({ id, title, createdAt: now }); gSaveIndex(idx);
  localStorage.setItem(G_PREFIX + id, JSON.stringify(item));
  return item;
}

function gUpdate(id, patch = {}) {
  const cur = JSON.parse(localStorage.getItem(G_PREFIX + id));
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  localStorage.setItem(G_PREFIX + id, JSON.stringify(next));
  // aggiorna titolo nell'indice
  const idx = gLoadIndex(); const it = idx.find(x => x.id === id);
  if (it && patch.title) { it.title = patch.title; gSaveIndex(idx); }
  return next;
}

function gDelete(id) {
  const idx = gLoadIndex().filter(x => x.id !== id);
  gSaveIndex(idx);
  localStorage.removeItem(G_PREFIX + id);
}

// ---------- NORMALIZZAZIONE NUOVO SCHEMA (sections[{title, text}]) ----------
function splitIntoParagraphs(txt) {
  return (txt || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}|\r?\n\s*\r?\n/g)   // paragrafi su doppio newline
    .map(s => s.trim())
    .filter(Boolean);
}

export function adaptTwoStageResponse(data) {
  const docTitle = data?.docTitle || data?.paper_title || data?.title || "Story";
  const title    = data?.title || data?.paper_title || docTitle || "Story";
  const persona  = data?.persona || "General Public";
  const sections = (data?.sections || []).map((s, i) => adaptTwoStageSection(s, i));
  return { docTitle, title, persona, sections, meta: data?.meta || {} };
}

// helper piccolo per riuso
function adaptTwoStageSection(s, i = 0) {
  const raw =
    (typeof s?.text === "string" && s.text) ||
    (typeof s?.narrative === "string" && s.narrative) ||
    "";
  return {
    id: s?.id ?? i,
    title: s?.title || `Section ${i + 1}`,
    text: raw,
    narrative: raw,
    paragraphs: Array.isArray(s?.paragraphs) && s.paragraphs.length
      ? s.paragraphs
      : splitIntoParagraphs(raw),
    visible: s?.visible !== false,
    hasImage: !!s?.hasImage,
  };
}



function patchFromAdapted(adapted) {
  return {
    title: adapted.title || adapted.docTitle || "Story",
    persona: adapted.persona || "General Public",
    sections: adapted.sections || [],
    meta: adapted.meta || null,
  };
}


// ---- API DB (authed) ----
// NB: ogni funzione prova il DB e, se riceve 401, fa FALLBACK guest.

export async function getStories() {
  const { status, ok, data } = await callApi('/api/stories');
  if (status === 401) return gList();           // non loggato → usa guest
  if (!ok) throw new Error(data?.error || 'Failed GET /api/stories');
  return data;
}

export async function getStory(id) {
  if (!id) throw new Error("getStory: missing id");

  const res = await fetch(`/api/stories/${encodeURIComponent(id)}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });

  const text = await res.text().catch(() => "");
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = typeof data?.error === "string" ? data.error : text || `GET /api/stories/${id} failed (${res.status})`;
    throw new Error(msg);
  }

  return data; // { id, title, sections, persona, meta, ... }
}

export async function createStory(title = 'Story') {
  const { status, ok, data } = await callApi('/api/stories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (status === 401) return gCreate(title);    // fallback guest
  if (!ok) throw new Error(data?.error || 'Failed POST /api/stories');
  return data;
}

// Se patch contiene {sections/meta/persona} sul DB crea una nuova revisione.
// In guest invece facciamo un semplice merge.
export async function updateStory(id, patch) {
  const res = await fetch(`/api/stories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(patch),
  });

  if (res.status === 401) {
    // fallback guest: merge “semplice”
    return gUpdate(id, patch);
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}



export async function deleteStory(id) {
  const { status, ok, data } = await callApi(`/api/stories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (status === 401) return gDelete(id);        // fallback guest
  if (status === 204) return;
  if (!ok) throw new Error(data?.error || 'Failed DELETE /api/stories/:id');
  return data;
}

// ---------- CHIAMATE MODELLO (nuovo flusso a 2 stadi) ----------
// RITORNANO la Story già adattata per la UI, così eviti "(no text)"

export async function generateFromText({
  text, persona, title = "Paper", limit_sections = 5, temp = 0.0, top_p = 0.9,
  length_preset = "medium", words = 0,
  // NEW (opzionali)
  retriever, retriever_model, k, max_ctx_chars, seg_words, overlap_words,
}) {
  const url = `${API_BASE}/api/generate_from_text`;
  const body = {
    text, persona, title, limit_sections, temp, top_p, length_preset, words,
    ...(retriever !== undefined ? { retriever } : {}),
    ...(retriever_model !== undefined ? { retriever_model } : {}),
    ...(k !== undefined ? { k } : {}),
    ...(max_ctx_chars !== undefined ? { max_ctx_chars } : {}),
    ...(seg_words !== undefined ? { seg_words } : {}),
    ...(overlap_words !== undefined ? { overlap_words } : {}),
  };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || data?.error || `Failed POST /api/generate_from_text (${res.status})`);
  return adaptTwoStageResponse(data);
}



export async function explainFromPdf({ file, persona, limit_sections = 5, temp = 0.0, top_p = 0.9, title_style = 'canonical', title_max_words = 0 }) {
  const fd = new FormData();
  fd.set('persona', persona);
  fd.set('file', file, file.name);
  fd.set('length', 'medium');
  fd.set('limit_sections', String(limit_sections));
  fd.set('temp', String(temp));
  fd.set('top_p', String(top_p));


  const url = `${API_BASE}/api/explain`;
  const res = await fetch(url, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || data?.error || 'Failed POST /api/explain');
  return adaptTwoStageResponse(data);
}


// Convenienze: chiamano il modello e AGGIORNANO subito la story (DB o guest)
export async function explainAndUpdateStory(storyId, args) {
  const adapted = await explainFromPdf(args);
  const patch = patchFromAdapted(adapted);
  return updateStory(storyId, patch);
}

export async function generateTextAndUpdateStory(storyId, args) {
  const adapted = await generateFromText(args);  // {title, persona, sections, meta?}

  // salva anche i parametri scelti dall’utente dentro meta.upstreamParams
  const patch = {
    title: adapted.title || adapted.docTitle || "Story",
    persona: args.persona || adapted.persona || "General Public",
    sections: Array.isArray(adapted.sections) ? adapted.sections : [],
    meta: {
      ...(adapted.meta || {}),
      upstreamParams: {
        // quello che l’utente ha scelto nel Control Panel
        temp: Number(args.temp ?? 0),
        top_p: Number(args.top_p ?? 0.9),
        lengthPreset: String(args.length_preset || "medium"),
        words: Number(args.words || 0) || undefined,
        limit_sections: Number(args.limit_sections || 5),
        persona: String(args.persona || "General Public"),
      },
      aiTitle: adapted.title || null,
      docTitle: adapted.docTitle || null,
    },
    ...(args.baseRevisionId ? { baseRevisionId: args.baseRevisionId } : null),
  };

  return updateStory(storyId, patch);
}


export async function getRevisions(storyId) {
  const res = await fetch(`/api/stories/${encodeURIComponent(storyId)}/revisions`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json(); // [{id,createdAt,persona,meta:{parentRevisionId,...}}]
}


// Rigenera usando outline esistente (salta lo splitter)
export async function regenerateWithOutline({
  text,        
  persona,
  title = "Story",  
  outline,         
  temp = 0.0,
  top_p = 1.0,
  retriever, retriever_model, k, max_ctx_chars, seg_words, overlap_words,
}) {
  const url = `${API_BASE}/api/regen_vm`;
  const body = {
    persona,
    text,      
    outline,          
    title,          
    length: "medium",   
    temp,
    top_p,
    ...(retriever       !== undefined ? { retriever } : {}),
    ...(retriever_model !== undefined ? { retriever_model } : {}),
    ...(k               !== undefined ? { k } : {}),
    ...(max_ctx_chars   !== undefined ? { max_ctx_chars } : {}),
    ...(seg_words       !== undefined ? { seg_words } : {}),
    ...(overlap_words   !== undefined ? { overlap_words } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || data?.error || "Failed POST /api/two_stage_story_from_outline");
  return adaptTwoStageResponse(data);
}

// Convenienza: prende story corrente e la rigenera
export async function regenerateAndUpdateStory(storyId, {
  text, persona, title, outline,
  temp = 0.0, top_p = 1.0,
  retriever, retriever_model, k, max_ctx_chars, seg_words, overlap_words,
  baseRevisionId,
}) {
  const adapted = await regenerateWithOutline({
    text, persona, title, outline,
    temp, top_p, retriever, retriever_model, k, max_ctx_chars, seg_words, overlap_words,
  });

  const patch = {
    // ✅ mantieni SEMPRE il titolo esistente passato in input
    title: title || "Story",
    persona: persona || adapted.persona || "General Public",
    sections: Array.isArray(adapted.sections) ? adapted.sections : [],
    meta: {
      ...(adapted.meta || {}),
      upstreamParams: {
        temp: Number(temp ?? 0),
        top_p: Number(top_p ?? 1.0),
        persona: String(persona || "General Public"),
        retriever, retriever_model, k, max_ctx_chars, seg_words, overlap_words,
        mode: "regen_from_outline",
      },
      // salviamo comunque l'eventuale titolo AI come riferimento, ma non lo usiamo
      aiTitle: adapted.title || null,
      docTitle: adapted.docTitle || null,
    },
    ...(baseRevisionId ? { baseRevisionId } : null),
  };

  return updateStory(storyId, patch);
}

// Rigenerazione parziale — chiama l'endpoint Next.js (auth-api)
export async function regenerateSelectedSections(
  storyId,
  { sectionIds = [], baseRevisionId = null, knobs = {}, notes = "" }
) {
  const body = {
    storyId: String(storyId),
    ...(Array.isArray(sectionIds) && sectionIds.length ? { sectionIds } : {}),
    ...(baseRevisionId ? { baseRevisionId: String(baseRevisionId) } : {}),
    ...(notes ? { notes: String(notes) } : {}),
    ...(knobs && typeof knobs === "object" ? { knobs } : {}),
  };

  const res = await fetch(`/api/regen_sections_vm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(body),
  });

  const raw = await res.text().catch(() => "");
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

  if (!res.ok) {
    const msg = data?.error || data?.detail || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data; // story materializzata (id, title, sections, persona, meta, ...)
}
