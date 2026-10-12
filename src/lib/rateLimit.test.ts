import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { RateLimiter, clientIp, rateLimit, tokenKey } from "./rateLimit";
import { AuthFailureTracker } from "./authFailures";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

function fakeReq(headers: Record<string, string>, remoteAddress?: string): Request {
  return { headers, socket: { remoteAddress } } as unknown as Request;
}

function fakeRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, state };
}

describe("RateLimiter", () => {
  it("laisse passer jusqu'à la limite puis bloque", () => {
    const c = clock();
    const limiter = new RateLimiter(60_000, 3, c.now);
    assert.equal(limiter.hit("a").allowed, true);
    assert.equal(limiter.hit("a").allowed, true);
    assert.equal(limiter.hit("a").allowed, true);
    const blocked = limiter.hit("a");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 60);
  });

  it("repart de zéro quand la fenêtre est passée", () => {
    const c = clock();
    const limiter = new RateLimiter(60_000, 1, c.now);
    assert.equal(limiter.hit("a").allowed, true);
    assert.equal(limiter.hit("a").allowed, false);
    c.advance(60_000);
    assert.equal(limiter.hit("a").allowed, true);
  });

  it("indique le temps d'attente restant", () => {
    const c = clock();
    const limiter = new RateLimiter(60_000, 1, c.now);
    limiter.hit("a");
    c.advance(45_000);
    assert.equal(limiter.hit("a").retryAfterSeconds, 15);
  });

  it("les clés sont indépendantes", () => {
    const c = clock();
    const limiter = new RateLimiter(60_000, 1, c.now);
    assert.equal(limiter.hit("a").allowed, true);
    assert.equal(limiter.hit("b").allowed, true);
    assert.equal(limiter.hit("a").allowed, false);
  });

  it("isOverLimit ne compte pas et reflète la fenêtre en cours", () => {
    const c = clock();
    const limiter = new RateLimiter(60_000, 2, c.now);
    assert.equal(limiter.isOverLimit("a"), false);
    limiter.hit("a");
    assert.equal(limiter.isOverLimit("a"), false);
    limiter.hit("a");
    assert.equal(limiter.isOverLimit("a"), true);
    assert.equal(limiter.isOverLimit("a"), true, "interroger ne consomme rien");
    c.advance(60_000);
    assert.equal(limiter.isOverLimit("a"), false);
  });

  it("sweep retire les clés expirées seulement", () => {
    const c = clock();
    const limiter = new RateLimiter(60_000, 5, c.now);
    limiter.hit("vieux");
    c.advance(30_000);
    limiter.hit("recent");
    c.advance(31_000);
    assert.equal(limiter.sweep(), 1);
    assert.equal(limiter.size, 1);
  });

  it("garde-fou mémoire : au-delà du maximum de clés, on laisse passer sans mémoriser", () => {
    const c = clock();
    const limiter = new RateLimiter(60_000, 1, c.now, 2);
    limiter.hit("a");
    limiter.hit("b");
    const result = limiter.hit("c");
    assert.equal(result.allowed, true);
    assert.equal(limiter.size, 2);
  });
});

describe("tokenKey", () => {
  it("renvoie null sans jeton", () => {
    assert.equal(tokenKey(fakeReq({})), null);
    assert.equal(tokenKey(fakeReq({ authorization: "Basic abc" })), null);
    assert.equal(tokenKey(fakeReq({ authorization: "Bearer " })), null);
    assert.equal(tokenKey(fakeReq({ authorization: "Bearer    " })), null);
  });

  it("est stable pour un même jeton, différent pour deux jetons, et ne contient pas le jeton", () => {
    const a1 = tokenKey(fakeReq({ authorization: "Bearer secret-token-a" }));
    const a2 = tokenKey(fakeReq({ authorization: "Bearer secret-token-a" }));
    const b = tokenKey(fakeReq({ authorization: "Bearer secret-token-b" }));
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
    assert.match(a1 ?? "", /^[0-9a-f]{32}$/);
    assert.doesNotMatch(a1 ?? "", /secret/);
  });
});

describe("clientIp", () => {
  it("prend l'en-tête de Cloudflare quand c'est une adresse valide", () => {
    assert.equal(clientIp(fakeReq({ "cf-connecting-ip": "203.0.113.7" }, "10.0.0.1")), "203.0.113.7");
    assert.equal(clientIp(fakeReq({ "cf-connecting-ip": "2001:db8::1" }, "10.0.0.1")), "2001:db8::1");
  });

  it("ignore une valeur qui n'est pas une adresse IP", () => {
    assert.equal(clientIp(fakeReq({ "cf-connecting-ip": "not-an-ip" }, "10.0.0.1")), "10.0.0.1");
    assert.equal(clientIp(fakeReq({ "cf-connecting-ip": "1.2.3.4, 5.6.7.8" }, "10.0.0.1")), "10.0.0.1");
  });

  it("se replie sur la connexion, puis sur « unknown »", () => {
    assert.equal(clientIp(fakeReq({}, "10.0.0.9")), "10.0.0.9");
    assert.equal(clientIp(fakeReq({})), "unknown");
  });
});

describe("rateLimit (middleware)", () => {
  it("répond 429 avec Retry-After et un code stable au-delà de la limite", () => {
    const c = clock();
    const middleware = rateLimit({ windowMs: 60_000, max: 2, key: () => "k", now: c.now });
    let calls = 0;
    const next = () => void (calls += 1);

    middleware(fakeReq({}), fakeRes().res, next);
    middleware(fakeReq({}), fakeRes().res, next);
    const third = fakeRes();
    middleware(fakeReq({}), third.res, next);

    assert.equal(calls, 2);
    assert.equal(third.state.status, 429);
    assert.equal(third.state.headers["Retry-After"], "60");
    assert.equal((third.state.body as { code: string }).code, "rate_limited");
  });

  it("ne limite pas une requête sans clé (route publique sans jeton)", () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    let calls = 0;
    for (let i = 0; i < 5; i += 1) middleware(fakeReq({}), fakeRes().res, () => void (calls += 1));
    assert.equal(calls, 5);
  });

  it("limite par jeton : deux sessions ne se gênent pas", () => {
    const c = clock();
    const middleware = rateLimit({ windowMs: 60_000, max: 1, now: c.now });
    const results: Array<number | undefined> = [];
    for (const token of ["a", "a", "b"]) {
      const { res, state } = fakeRes();
      middleware(fakeReq({ authorization: `Bearer ${token}` }), res, () => results.push(200));
      if (state.status) results.push(state.status);
    }
    assert.deepEqual(results, [200, 429, 200]);
  });
});

describe("AuthFailureTracker", () => {
  it("bloque une adresse après trop d'échecs, pas avant", () => {
    const c = clock();
    const tracker = new AuthFailureTracker(c.now, 3, 60_000);
    assert.equal(tracker.blocked("1.1.1.1"), false);
    tracker.record("1.1.1.1");
    tracker.record("1.1.1.1");
    assert.equal(tracker.blocked("1.1.1.1"), false);
    tracker.record("1.1.1.1");
    assert.equal(tracker.blocked("1.1.1.1"), true);
  });

  it("n'affecte pas les autres adresses et se débloque avec la fenêtre", () => {
    const c = clock();
    const tracker = new AuthFailureTracker(c.now, 1, 60_000);
    tracker.record("1.1.1.1");
    assert.equal(tracker.blocked("1.1.1.1"), true);
    assert.equal(tracker.blocked("2.2.2.2"), false);
    c.advance(60_000);
    assert.equal(tracker.blocked("1.1.1.1"), false);
  });
});
