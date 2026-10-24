import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { isSafeKey, parseRange, resolveRange, verifyCdnToken } from "../src/worker.js";

// Vecteur partagé avec l'API (src/lib/cdnToken.test.ts) : si l'un change, l'autre doit changer.
const SECRET = "secret-de-test-pour-les-vecteurs";
const KEY = "t/00000000-0000-4000-8000-000000000001/f1-128.m4a";
const EXPIRES = 1800000000;
const SIGNATURE = "KvQbQqMJxZVWT-ySEM2ceFmQPdKJlyao_YDDooeIubQ";

const sign = (key, expires, secret = SECRET) => createHmac("sha256", secret).update(`${key}\n${expires}`).digest("base64url");

describe("verifyCdnToken", () => {
  it("accepte le vecteur de test partagé avec l'API", async () => {
    assert.equal(sign(KEY, EXPIRES), SIGNATURE);
    assert.deepEqual(await verifyCdnToken(SECRET, KEY, String(EXPIRES), SIGNATURE, 1700000000), { ok: true });
  });

  it("refuse une adresse expirée (l'expiration elle-même est refusée)", async () => {
    assert.equal((await verifyCdnToken(SECRET, KEY, String(EXPIRES), SIGNATURE, EXPIRES)).reason, "expired");
    assert.equal((await verifyCdnToken(SECRET, KEY, String(EXPIRES), SIGNATURE, EXPIRES + 1)).reason, "expired");
  });

  it("refuse un autre fichier, une autre expiration, un autre secret", async () => {
    assert.equal((await verifyCdnToken(SECRET, KEY.replace("128", "256"), String(EXPIRES), SIGNATURE, 1700000000)).reason, "bad_signature");
    assert.equal((await verifyCdnToken(SECRET, KEY, String(EXPIRES + 1), SIGNATURE, 1700000000)).reason, "bad_signature");
    assert.equal((await verifyCdnToken("autre-secret", KEY, String(EXPIRES), SIGNATURE, 1700000000)).reason, "bad_signature");
  });

  it("refuse une signature modifiée, mal formée ou absente", async () => {
    const tampered = (SIGNATURE.startsWith("K") ? "L" : "K") + SIGNATURE.slice(1);
    assert.equal((await verifyCdnToken(SECRET, KEY, String(EXPIRES), tampered, 1700000000)).reason, "bad_signature");
    assert.equal((await verifyCdnToken(SECRET, KEY, String(EXPIRES), "court", 1700000000)).reason, "bad_signature");
    assert.equal((await verifyCdnToken(SECRET, KEY, String(EXPIRES), null, 1700000000)).reason, "bad_signature");
  });

  it("refuse une expiration absente ou illisible", async () => {
    for (const bad of [null, "", "abc", "-5", "1.5", "99999999999999"]) {
      assert.equal((await verifyCdnToken(SECRET, KEY, bad, SIGNATURE, 1700000000)).reason, "bad_expiry", String(bad));
    }
  });

  it("refuse une clé dangereuse et un secret absent", async () => {
    assert.equal((await verifyCdnToken(SECRET, "../x", String(EXPIRES), SIGNATURE, 1700000000)).reason, "bad_key");
    assert.equal((await verifyCdnToken(undefined, KEY, String(EXPIRES), SIGNATURE, 1700000000)).reason, "not_configured");
    assert.equal((await verifyCdnToken("", KEY, String(EXPIRES), SIGNATURE, 1700000000)).reason, "not_configured");
  });
});

describe("isSafeKey", () => {
  it("mêmes règles que côté API", () => {
    assert.equal(isSafeKey(KEY), true);
    for (const bad of ["", "a/../b", "..", "/a", "a//b", "a b", "a%2Fb", "é", "a/b/", `a/${"x".repeat(300)}`, null, 12]) {
      assert.equal(isSafeKey(bad), false, String(bad));
    }
  });
});

describe("parseRange et resolveRange", () => {
  it("lit les trois formes de plage", () => {
    assert.deepEqual(parseRange("bytes=0-"), { offset: 0 });
    assert.deepEqual(parseRange("bytes=100-199"), { offset: 100, length: 100 });
    assert.deepEqual(parseRange("bytes=-500"), { suffix: 500 });
  });

  it("ignore ce qu'elle ne sait pas servir (le fichier entier est alors rendu)", () => {
    for (const bad of [null, "", "bytes=", "bytes=-", "bytes=5-2", "bytes=0-1,5-6", "items=0-5", "bytes=-0", "bytes=a-b"]) {
      assert.equal(parseRange(bad), null, String(bad));
    }
  });

  it("calcule les octets réellement servis", () => {
    assert.deepEqual(resolveRange({ offset: 0 }, 100), { start: 0, end: 99 });
    assert.deepEqual(resolveRange({ offset: 10, length: 10 }, 100), { start: 10, end: 19 });
    assert.deepEqual(resolveRange({ offset: 90, length: 50 }, 100), { start: 90, end: 99 });
    assert.deepEqual(resolveRange({ suffix: 5 }, 100), { start: 95, end: 99 });
    assert.deepEqual(resolveRange({ suffix: 500 }, 100), { start: 0, end: 99 });
  });

  it("une plage hors du fichier n'est pas servable", () => {
    assert.equal(resolveRange({ offset: 100 }, 100), null);
    assert.equal(resolveRange({ offset: 1000, length: 10 }, 100), null);
  });
});

// --- Le Worker complet, avec un faux R2 et un faux cache.

const FILE = Uint8Array.from({ length: 100 }, (_, index) => index);
const meta = (bytes) => ({ size: bytes.length, httpEtag: '"abc"', writeHttpMetadata: (headers) => headers.set("Content-Type", "audio/mp4") });

function makeEnv(files = new Map([[KEY, FILE]])) {
  const reads = [];
  const AUDIO = {
    async head(key) {
      const bytes = files.get(key);
      return bytes ? meta(bytes) : null;
    },
    async get(key, options) {
      reads.push({ key, options });
      const bytes = files.get(key);
      if (!bytes) return null;
      let part = bytes;
      const range = options?.range;
      if (range) {
        part = "suffix" in range ? bytes.slice(Math.max(0, bytes.length - range.suffix)) : bytes.slice(range.offset, "length" in range ? range.offset + range.length : undefined);
      }
      return { ...meta(bytes), body: new ReadableStream({ start: (controller) => (controller.enqueue(part), controller.close()) }) };
    },
  };
  return { env: { AUDIO, CDN_TOKEN_SECRET: SECRET }, reads };
}

function makeCache() {
  const store = new Map();
  return {
    store,
    async match(request) {
      const hit = store.get(new URL(request.url).pathname);
      return hit ? new Response(hit.bytes, { status: 200, headers: hit.headers }) : undefined;
    },
    async put(request, response) {
      store.set(new URL(request.url).pathname, { bytes: new Uint8Array(await response.arrayBuffer()), headers: new Headers(response.headers) });
    },
  };
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const address = (key = KEY, expires = future(), signature = sign(key, expires)) => `https://cdn.vynl.li/${key}?e=${expires}&s=${signature}`;

async function call(url, { method = "GET", headers = {}, env, ctx } = {}) {
  const context = ctx ?? { promises: [], waitUntil(promise) { this.promises.push(promise); } };
  const response = await worker.fetch(new Request(url, { method, headers }), env, context);
  await Promise.all(context.promises);
  return response;
}

describe("Worker : accès", () => {
  let cache;
  beforeEach(() => {
    cache = makeCache();
    globalThis.caches = { default: cache };
  });

  it("refuse sans jeton, avec une mauvaise signature, expiré, ou pour un autre fichier", async () => {
    const { env, reads } = makeEnv();
    assert.equal((await call(`https://cdn.vynl.li/${KEY}`, { env })).status, 403);
    assert.equal((await call(address(KEY, future(), "A".repeat(43)), { env })).status, 403);
    assert.equal((await call(address(KEY, Math.floor(Date.now() / 1000) - 10), { env })).status, 403);
    const otherFileToken = sign("t/autre/f.m4a", 9999999999);
    assert.equal((await call(address(KEY, 9999999999, otherFileToken), { env })).status, 403);
    assert.equal(reads.length, 0, "R2 n'est jamais lu sans jeton valide");
  });

  it("répond 503 si le secret n'est pas réglé, 404 pour un fichier inconnu ou une clé dangereuse", async () => {
    const { env } = makeEnv();
    assert.equal((await call(address(), { env: { ...env, CDN_TOKEN_SECRET: undefined } })).status, 503);
    const unknown = "t/inconnu/f.m4a";
    assert.equal((await call(address(unknown), { env })).status, 404);
    assert.equal((await call("https://cdn.vynl.li/a%20b.m4a?e=9999999999&s=" + "A".repeat(43), { env })).status, 404);
  });

  it("refuse les méthodes d'écriture et répond aux demandes CORS", async () => {
    const { env } = makeEnv();
    const post = await call(address(), { method: "POST", env });
    assert.equal(post.status, 405);
    const options = await call(address(), { method: "OPTIONS", env });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("Access-Control-Allow-Origin"), "*");
  });
});

describe("Worker : lecture et cache", () => {
  let cache;
  beforeEach(() => {
    cache = makeCache();
    globalThis.caches = { default: cache };
  });

  it("sert le fichier entier avec les bons en-têtes, puis le garde dans le cache", async () => {
    const { env, reads } = makeEnv();
    const response = await call(address(), { env });
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), FILE);
    assert.equal(response.headers.get("Content-Type"), "audio/mp4");
    assert.equal(response.headers.get("Accept-Ranges"), "bytes");
    assert.equal(response.headers.get("Content-Length"), "100");
    assert.match(response.headers.get("Cache-Control"), /immutable/);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(reads.length, 1);
    assert.deepEqual(cache.store.get(`/${KEY}`).bytes, FILE, "le fichier entier est en cache, sous une clé sans jeton");
  });

  it("un autre jeton valide pour le même fichier est servi depuis le cache, sans lire R2", async () => {
    const { env, reads } = makeEnv();
    await call(address(KEY, future()), { env });
    const second = await call(address(KEY, future() + 120), { env });
    assert.equal(second.status, 200);
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), FILE);
    assert.equal(reads.length, 1, "R2 n'a été lu qu'une fois");
  });

  it("une plage demandée avant le cache vient de R2 (206) et remplit le cache en tâche de fond", async () => {
    const { env, reads } = makeEnv();
    const response = await call(address(), { headers: { Range: "bytes=10-19" }, env });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 10-19/100");
    assert.equal(response.headers.get("Content-Length"), "10");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), FILE.slice(10, 20));
    assert.deepEqual(reads[0].options.range, { offset: 10, length: 10 });
    assert.deepEqual(cache.store.get(`/${KEY}`).bytes, FILE, "le fichier entier a été mis en cache après la plage");
  });

  it("sert les derniers octets (suffixe) et la fin ouverte", async () => {
    const { env } = makeEnv();
    const suffix = await call(address(), { headers: { Range: "bytes=-5" }, env });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("Content-Range"), "bytes 95-99/100");
    assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), FILE.slice(95));
    globalThis.caches = { default: makeCache() };
    const open = await call(address(), { headers: { Range: "bytes=90-" }, env: makeEnv().env });
    assert.equal(open.headers.get("Content-Range"), "bytes 90-99/100");
  });

  it("une plage hors du fichier : 416 avec la taille", async () => {
    const { env } = makeEnv();
    const response = await call(address(), { headers: { Range: "bytes=1000-2000" }, env });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("Content-Range"), "bytes */100");
  });

  it("HEAD rend les en-têtes sans corps", async () => {
    const { env } = makeEnv();
    const response = await call(address(), { method: "HEAD", env });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Length"), "100");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });
});
