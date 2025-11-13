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

  let current = null;
  try {
    const r = await fetch(`/api/stories/${encodeURIComponent(storyId)}`, {
      method: "GET", credentials: "include", cache: "no-store",
    });
    current = r.ok ? await r.json() : null;
  } catch {}

  const patch = {
    title: aiTitle,
    persona: adapted?.persona || "General Public",
    sections: Array.isArray(adapted?.sections) ? adapted.sections : [],
    meta: {
      ...(adapted?.meta || {}),
      ...(current?.meta?.paperId ? { paperId: current.meta.paperId } : {}),
      ...(current?.meta?.paperUrl ? { paperUrl: current.meta.paperUrl } : {}),
      docTitle: adapted?.docTitle || null,
      aiTitle,
    },
  };

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

  const nextMeta = {
    ...(story?.meta || {}),
    paperId,
    paperUrl, // 👈 usato da Stories.jsx → handleReadOnPaper
  };

  // 3) PATCH con il meta aggiornato
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