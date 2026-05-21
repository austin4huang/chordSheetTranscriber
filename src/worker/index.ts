// Cloudflare Worker entry. Serves two things:
//   * /api/fetch?url=… — server-side fetch proxy for the URL-import flow.
//     Public CORS proxies (allorigins.win / corsproxy.io) are unreliable and
//     in particular tend to 403 requests originating from workers.dev / other
//     cloud origins, breaking the deployed app even when it works locally.
//   * Everything else — delegated to the static SPA assets binding so the
//     React app renders normally (the SPA fallback lives in wrangler.jsonc).

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

// Only ever proxy these hosts. The browser-import flow targets Ultimate-Guitar
// exclusively, and locking this down keeps the route from becoming an open
// proxy that anyone could abuse for unrelated traffic.
const ALLOWED_HOSTS = new Set([
  "tabs.ultimate-guitar.com",
  "www.ultimate-guitar.com",
]);

// A real-browser UA so UG doesn't reject the request as "automated."
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/fetch") return proxyFetch(url);
    return env.ASSETS.fetch(request);
  },
};

async function proxyFetch(reqUrl: URL): Promise<Response> {
  const target = reqUrl.searchParams.get("url");
  if (!target) return errorJson(400, "Missing ?url parameter");
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return errorJson(400, "Invalid URL");
  }
  if (parsed.protocol !== "https:")
    return errorJson(400, "Only https:// URLs are accepted");
  if (!ALLOWED_HOSTS.has(parsed.hostname))
    return errorJson(403, `Host not allowed: ${parsed.hostname}`);

  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    return errorJson(502, `Upstream fetch failed: ${(err as Error).message}`);
  }

  // Pass the body through verbatim; the importer only needs the raw HTML.
  // Cache-Control: no-store so a stale UG page doesn't get pinned in any
  // intermediate cache (Cloudflare's edge generally won't cache a Worker
  // response anyway, but be explicit).
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorJson(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
