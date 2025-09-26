// app/api/proxy/pdf/route.js
export const dynamic = "force-dynamic";        // no cache durante lo sviluppo
export const runtime = "nodejs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "http://localhost:5173", // Vite dev
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, *",
  "Vary": "Origin",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function normalizeArxiv(url) {
  try {
    const u = new URL(url);
    if (/arxiv\.org$/i.test(u.hostname)) {
      if (u.pathname.startsWith("/abs/")) {
        const id = u.pathname.replace(/^\/abs\//, "");
        return `https://arxiv.org/pdf/${id}.pdf`;
      }
      if (u.pathname.startsWith("/pdf/") && !u.pathname.endsWith(".pdf")) {
        return `${u.origin}${u.pathname}.pdf${u.search}`;
      }
    }
  } catch {}
  return url;
}

function filenameFromCD(cd) {
  if (!cd) return null;
  const m = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(cd);
  const raw = m?.[1] || m?.[2] || m?.[3];
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const input = searchParams.get("url");
    if (!input) {
      return new Response("Missing url", { status: 400, headers: CORS_HEADERS });
    }
    if (!/^https?:\/\//i.test(input)) {
      return new Response("Invalid url", { status: 400, headers: CORS_HEADERS });
    }

    const target = normalizeArxiv(input);

    const upstream = await fetch(target, {
      method: "GET",
      // evita cache durante dev
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PDFProxy/1.0)" },
    });

    if (!upstream.ok) {
      const msg = await upstream.text().catch(() => upstream.statusText);
      return new Response(msg || "Upstream error", {
        status: upstream.status,
        headers: CORS_HEADERS,
      });
    }

    const arrayBuf = await upstream.arrayBuffer();
    const ct = upstream.headers.get("content-type") || "application/pdf";
    const cd = upstream.headers.get("content-disposition");

    let filename =
      filenameFromCD(cd) ||
      target.split("/").pop()?.split("#")[0]?.split("?")[0] ||
      "document.pdf";
    if (!/\.pdf$/i.test(filename)) filename += ".pdf";

    return new Response(Buffer.from(arrayBuf), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": ct.includes("pdf") ? ct : "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response(e?.message || "Proxy failure", {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
}
