// AIScientistStoryteller/src/services/explainApi.js
const API_BASE = import.meta.env.VITE_API_BASE || "/svc";

function adaptTwoStageResponse(data) {
  return {
    title:    data?.title || data?.docTitle || "Story",
    docTitle: data?.docTitle || null,
    persona:  data?.persona || "General Public",
    sections: data?.sections || [],
    meta:     data?.meta || {},
  };
}
// Piccola cache in memoria: paperId -> paperText
const paperTextCache = new Map();

export function cachePaperText(paperId, text) {
  if (!paperId || !text) return;
  try {
    paperTextCache.set(String(paperId), String(text));
  } catch {}
}

export function getCachedPaperText(paperId) {
  if (!paperId) return null;
  return paperTextCache.get(String(paperId)) || null;
}

export async function explainPdf({ file, persona, options = {}, jobId = null }) {
  if (!file) throw new Error("Nessun PDF selezionato");

  const fd = new FormData();
  fd.append("persona", persona || "Student");
  fd.append("file", file);
  if (jobId) fd.append("jobId", String(jobId));


  if (options.length) fd.append("length", options.length);
  if (options.limit_sections != null) fd.append("limit_sections", String(options.limit_sections));
  if (options.temp != null) fd.append("temp", String(options.temp));
  if (options.top_p != null) fd.append("top_p", String(options.top_p));
  if (options.preset) fd.append("preset", options.preset);
  if (options.k != null) fd.append("k", String(options.k));
  if (options.max_ctx_chars != null) fd.append("max_ctx_chars", String(options.max_ctx_chars));
  if (options.retriever) fd.append("retriever", options.retriever);
  if (options.retriever_model) fd.append("retriever_model", options.retriever_model);
  if (options.seg_words != null) fd.append("seg_words", String(options.seg_words));
  if (options.overlap_words != null) fd.append("overlap_words", String(options.overlap_words));

  const url = `${API_BASE}/api/explain`;
  console.debug("[explainPdf] POST", url, { persona, hasFile: !!file, options });

  // niente credentials qui, per evitare CORS con allow_origins="*"
  const res = await fetch(url, { method: "POST", body: fd });

  const text = await res.text().catch(() => "");
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  console.debug("[explainPdf] raw data.meta:", data?.meta);
  console.debug("[explainPdf] has paperText?", !!data?.meta?.paperText);

  if (!res.ok) {
    console.error("[explainPdf] HTTP error", res.status, data);
    const msg = typeof data?.detail === "string" ? data.detail : text || `Explain API error ${res.status}`;
    throw new Error(msg);
  }
  return adaptTwoStageResponse(data);
}

export async function explainPdfAndUpdate(storyId, { file, persona, options = {}, jobId = null }) {
  const adapted = await explainPdf({ file, persona, options, jobId });
  const aiTitle = (adapted?.title || "").trim();

  if (adapted?.meta?.paperId && adapted?.meta?.paperText) {
    cachePaperText(adapted.meta.paperId, adapted.meta.paperText);
  }


  // 1) prendo la story corrente (se esiste) solo per MERGIARE meta extra
  let current = null;
  try {
    const r = await fetch(`/api/stories/${encodeURIComponent(storyId)}`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    });
    current = r.ok ? await r.json() : null;
  } catch {}

  const prevMeta      = current?.meta || {};
  const explainedMeta = adapted?.meta || {};

  // 2) MERGE meta, ma lasciando vincere SEMPRE quello di /api/explain
  const mergedMeta = {
    // roba vecchia della story (note, upstreamParams, ecc.)
    ...prevMeta,

    // quello che arriva da /api/explain (paperText, paperId, paperUrl, outline, storytellerParams…)
    ...explainedMeta,

    // se explain NON avesse paperId/paperUrl, usiamo quelli vecchi come fallback
    ...(explainedMeta.paperId  ? {} : (prevMeta.paperId  ? { paperId:  prevMeta.paperId }  : {})),
    ...(explainedMeta.paperUrl ? {} : (prevMeta.paperUrl ? { paperUrl: prevMeta.paperUrl } : {})),

    docTitle: adapted?.docTitle || explainedMeta.docTitle || prevMeta.docTitle || null,
    aiTitle,
  };

  const patch = {
    title: aiTitle || current?.title || "Story",
    persona: adapted?.persona || current?.persona || "General Public",
    sections: Array.isArray(adapted?.sections) ? adapted.sections : [],
    meta: mergedMeta,
  };

  console.debug("[explainPdfAndUpdate] PATCH meta.paperId:", patch.meta.paperId);
  console.debug("[explainPdfAndUpdate] PATCH has paperText?", !!patch.meta.paperText);

  const r = await fetch(`/api/stories/${encodeURIComponent(storyId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(patch),
  });

  const t = await r.text().catch(() => "");
  let d; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }

  if (r.status === 401) return adapted;
  if (!r.ok) {
    console.error("[explainPdfAndUpdate] PATCH fallita:", r.status, t);
    return adapted;
  }
  return d;
}


export async function intakePaper({ file, link }) {
  const url = `${API_BASE}/api/papers/intake`;

  if (file) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const res = await fetch(url, { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || data?.error || "Failed POST /api/papers/intake (file)");
    return { paperId: data.paper_id, paperUrl: data.paper_url, dedup: !!data.dedup };
  }

  if (link) {
    // ⬇️ INVIARE COME FORM-DATA, NON JSON
    const fd = new FormData();
    fd.append("link", link);
    const res = await fetch(url, { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || data?.error || "Failed POST /api/papers/intake (link)");
    return { paperId: data.paper_id, paperUrl: data.paper_url, dedup: !!data.dedup };
  }

  throw new Error("intakePaper: need file or link");
}

export async function attachPaperToStory(storyId, { file, link }) {
  if (!storyId) throw new Error("attachPaperToStory: missing storyId");
  if (!file && !link) throw new Error("attachPaperToStory: pass file or link");

  // 1) intake → ottieni { paperId, paperUrl }
  const { paperId, paperUrl } = await intakePaper({ file, link });

  // 2) prendi la story corrente per preservare il meta esistente
  const getRes = await fetch(`/api/stories/${encodeURIComponent(storyId)}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  const story = await getRes.json().catch(() => ({}));
  if (!getRes.ok) throw new Error(story?.detail || "Unable to load story to update meta");

  // 🔴 se c'è già paperText, NON toccare nulla
  if (story?.meta?.paperText) {
    console.debug("[attachPaperToStory] story has paperText, skip overriding paperId/paperUrl");
    return {
      paperId: story.meta.paperId,
      paperUrl: story.meta.paperUrl,
    };
  }

  const nextMeta = {
    ...(story?.meta || {}),
    paperId,
    paperUrl, // usato da Stories.jsx → handleReadOnPaper
  };

  const patch = { meta: nextMeta };
  const upRes = await fetch(`/api/stories/${encodeURIComponent(storyId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(patch),
  });
  const upd = await upRes.json().catch(() => ({}));
  if (!upRes.ok) throw new Error(upd?.detail || "Failed to attach paper to story");

  return { paperId, paperUrl };
}
