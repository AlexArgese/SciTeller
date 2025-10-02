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

export async function explainPdf({ file, persona, options = {} }) {
  if (!file) throw new Error("Nessun PDF selezionato");

  const fd = new FormData();
  fd.append("persona", persona || "Student");
  fd.append("file", file);

  if (options.length) fd.append("length", options.length);
  if (options.limit_sections != null) fd.append("limit_sections", String(options.limit_sections));
  if (options.temp != null) fd.append("temp", String(options.temp));
  if (options.top_p != null) fd.append("top_p", String(options.top_p));
  if (options.title_style) fd.append("title_style", options.title_style);
  if (options.title_max_words != null) fd.append("title_max_words", String(options.title_max_words));

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

export async function explainPdfAndUpdate(storyId, { file, persona, options = {} }) {
  const adapted = await explainPdf({ file, persona, options }); 

  const aiTitle = (adapted?.title || "").trim();

  const patch = {
    title: aiTitle,
    persona: adapted?.persona || "General Public",
    sections: Array.isArray(adapted?.sections) ? adapted.sections : [],
    meta: {
      ...(adapted?.meta || {}),
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
