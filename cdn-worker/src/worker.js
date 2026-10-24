// Worker Cloudflare du CDN audio (cdn.vynl.li).
//
// Sert les fichiers AAC du bucket R2 « vynlmusic » (liaison AUDIO), SEULEMENT à qui présente une adresse signée par
// l'API (lib/cdnToken.ts) : ?e=<expiration>&s=<signature>. Le bucket reste privé, jamais lisible sans ce Worker.
//
//  * le jeton est vérifié avant tout (HMAC-SHA256, secret CDN_TOKEN_SECRET) : adresse fausse, modifiée ou expirée = 403 ;
//  * le fichier est gardé dans le cache du serveur Cloudflare le plus proche, SOUS UNE CLÉ SANS LE JETON : chaque
//    nouveau jeton profite du même cache. Les demandes de plages d'octets (avancer dans un morceau) sont servies
//    depuis le cache ; au premier passage, la plage vient de R2 et le fichier entier est mis en cache en tâche de fond ;
//  * uniquement GET, HEAD et OPTIONS.
//
// Un seul fichier, sans dépendance : il se colle tel quel dans l'éditeur de Workers de Cloudflare.

const encoder = new TextEncoder();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

// Mêmes règles que isSafeCdnKey (src/lib/cdnToken.ts).
export function isSafeKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 300) return false;
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key)) return false;
  return !key.split("/").some((part) => part === "." || part === "..");
}

function base64urlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// signature = base64url( HMAC-SHA256( secret, "<clé>\n<expiration>" ) ), comparée en temps constant par WebCrypto.
export async function verifyCdnToken(secret, key, expires, signature, nowSeconds) {
  if (!secret) return { ok: false, reason: "not_configured" };
  if (!isSafeKey(key)) return { ok: false, reason: "bad_key" };
  if (typeof expires !== "string" || !/^\d{1,12}$/.test(expires)) return { ok: false, reason: "bad_expiry" };
  if (Number(expires) <= nowSeconds) return { ok: false, reason: "expired" };
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return { ok: false, reason: "bad_signature" };

  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", cryptoKey, base64urlToBytes(signature), encoder.encode(`${key}\n${expires}`));
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}

// « bytes=0- », « bytes=100-199 », « bytes=-500 » ; tout le reste (plusieurs plages, forme inconnue) : null, donc le fichier entier.
export function parseRange(header) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, start, end] = match;
  if (start === "" && end === "") return null;
  if (start === "") return Number(end) > 0 ? { suffix: Number(end) } : null;
  const offset = Number(start);
  if (end === "") return { offset };
  const last = Number(end);
  return last >= offset ? { offset, length: last - offset + 1 } : null;
}

// Les octets réellement servis pour une plage sur un fichier de `size` octets, ou null si elle est hors du fichier.
export function resolveRange(range, size) {
  let start;
  let end;
  if ("suffix" in range) {
    start = Math.max(0, size - range.suffix);
    end = size - 1;
  } else {
    start = range.offset;
    end = "length" in range ? Math.min(range.offset + range.length - 1, size - 1) : size - 1;
  }
  return start >= size || end < start ? null : { start, end };
}

function plain(status, text, extra = {}) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...extra },
  });
}

function objectHeaders(object) {
  const headers = new Headers(CORS);
  if (typeof object.writeHttpMetadata === "function") object.writeHttpMetadata(headers);
  if (!headers.get("Content-Type")) headers.set("Content-Type", "audio/mp4");
  headers.set("Accept-Ranges", "bytes");
  // Le fichier d'une clé ne change jamais (une nouvelle version a une nouvelle clé) : cache d'un an, immuable.
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return headers;
}

// Met le fichier ENTIER dans le cache (pour les prochaines demandes, plages comprises), sauf s'il y est déjà.
async function fillCache(cache, plainRequest, env, key) {
  if (await cache.match(plainRequest)) return;
  const full = await env.AUDIO.get(key);
  if (!full) return;
  const headers = objectHeaders(full);
  headers.set("Content-Length", String(full.size));
  await cache.put(plainRequest, new Response(full.body, { status: 200, headers }));
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "Method not allowed", { Allow: "GET, HEAD, OPTIONS" });
    }

    const url = new URL(request.url);
    let key;
    try {
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return plain(400, "Bad request");
    }
    if (!isSafeKey(key)) return plain(404, "Not found");

    const check = await verifyCdnToken(env.CDN_TOKEN_SECRET, key, url.searchParams.get("e"), url.searchParams.get("s"), Math.floor(Date.now() / 1000));
    if (!check.ok) return check.reason === "not_configured" ? plain(503, "Not configured") : plain(403, "Forbidden");

    if (request.method === "HEAD") {
      const head = await env.AUDIO.head(key);
      if (!head) return plain(404, "Not found");
      const headers = objectHeaders(head);
      headers.set("Content-Length", String(head.size));
      return new Response(null, { status: 200, headers });
    }

    // Clé de cache SANS le jeton : tous les jetons d'un même fichier partagent la même copie.
    const cache = caches.default;
    const plainRequest = new Request(`${url.origin}/${key}`);
    const cached = await cache.match(new Request(plainRequest, { headers: request.headers }));
    if (cached) return cached;

    const range = parseRange(request.headers.get("Range"));
    let object;
    try {
      object = await env.AUDIO.get(key, range ? { range } : undefined);
    } catch {
      return plain(416, "Range not satisfiable");
    }
    if (!object) return plain(404, "Not found");

    const headers = objectHeaders(object);

    if (range) {
      const bytes = resolveRange(range, object.size);
      if (!bytes) return plain(416, "Range not satisfiable", { "Content-Range": `bytes */${object.size}` });
      headers.set("Content-Range", `bytes ${bytes.start}-${bytes.end}/${object.size}`);
      headers.set("Content-Length", String(bytes.end - bytes.start + 1));
      ctx.waitUntil(fillCache(cache, plainRequest, env, key));
      return new Response(object.body, { status: 206, headers });
    }

    headers.set("Content-Length", String(object.size));
    const [toClient, toCache] = object.body.tee();
    ctx.waitUntil(cache.put(plainRequest, new Response(toCache, { status: 200, headers: new Headers(headers) })));
    return new Response(toClient, { status: 200, headers });
  },
};
