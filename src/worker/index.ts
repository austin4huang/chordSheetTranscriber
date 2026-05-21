// Cloudflare Worker entry. Serves two things:
//   * /api/fetch?url=… — server-side fetch proxy for the URL-import flow.
//     Public CORS proxies (allorigins.win / corsproxy.io) are unreliable and
//     in particular tend to 403 requests originating from workers.dev / other
//     cloud origins, breaking the deployed app even when it works locally.
//   * Everything else — delegated to the static SPA assets binding so the
//     React app renders normally (the SPA fallback lives in wrangler.jsonc).
//
// /api/fetch defends against being used as a free public proxy with two
// layers: an Origin/Referer/Sec-Fetch-Site allow-list (blocks drive-by abuse)
// and a Workers Rate Limit binding (caps per-IP request rate so even a
// determined scripted attacker can't burn the daily request quota).

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  // Cloudflare Workers Rate Limit binding. May be `undefined` in dev
  // environments (e.g., when the binding isn't wired up); the proxy treats
  // a missing binding as "no limit" rather than failing closed, so local
  // development keeps working.
  RATE_LIMITER?: {
    limit(opts: { key: string }): Promise<{ success: boolean }>;
  };
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
    if (url.pathname === "/api/fetch") return proxyFetch(request, env, url);
    return env.ASSETS.fetch(request);
  },
};

async function proxyFetch(
  request: Request,
  env: Env,
  reqUrl: URL,
): Promise<Response> {
  // Layer 1: only accept calls that look like they came from our own SPA.
  // A spoofed header is trivial, but every basic drive-by abuser (curl,
  // hot-linked from another site, scraping libraries) gets stopped here.
  if (!isSameSite(request, reqUrl.origin)) {
    return errorJson(403, "Forbidden");
  }

  // Layer 2: per-IP rate limit. Generous enough that a human importing
  // songs at any realistic pace stays well under, but anything scripted
  // hits the wall in seconds. Skipped (open) when the binding isn't
  // configured in the current environment — see Env.RATE_LIMITER.
  if (env.RATE_LIMITER) {
    const ip =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For") ||
      "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return errorJson(429, "Too many import requests, please slow down.");
    }
  }

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

/** Allow only requests that look same-site to our own origin. Browsers set
 *  `Sec-Fetch-Site: same-origin` for fetch() calls from a same-origin script,
 *  which is the canonical signal. Older browsers may not send it — fall back
 *  to the Origin header (set on all CORS-eligible requests) and then to
 *  Referer (set on most navigations). A request that lands here with none of
 *  the three is hand-crafted (curl/scripts) and not from a real user. */
function isSameSite(request: Request, myOrigin: string): boolean {
  const sfs = request.headers.get("Sec-Fetch-Site");
  if (sfs) return sfs === "same-origin";
  const origin = request.headers.get("Origin");
  if (origin) return origin === myOrigin;
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      return new URL(referer).origin === myOrigin;
    } catch {
      return false;
    }
  }
  return false;
}

function errorJson(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
