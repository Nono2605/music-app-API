import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  authenticateToken,
  classifyAuthError,
  identityFromClaims,
  isWellFormedJwt,
  type AuthenticateDeps,
  type Identity,
  type LocalResult,
} from "./accessToken";

const ISSUER = "https://example.supabase.co/auth/v1";
const NOW = 1_800_000_000;
// Un jeton qui a la FORME d'un JWT (trois morceaux en base64url, deux objets JSON) ; sa signature n'est pas contrôlée ici.
const TOKEN = ["eyJhbGciOiJFUzI1NiJ9", "e30", "c2ln"].join(".");
const USER: Identity = { id: "11111111-1111-1111-1111-111111111111", email: "a@example.com" };

const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: "authenticated",
  role: "authenticated",
  sub: USER.id,
  email: USER.email,
  exp: NOW + 3600,
  ...over,
});

describe("identityFromClaims", () => {
  it("accepte un jeton d'utilisateur complet", () => {
    assert.deepEqual(identityFromClaims(goodClaims(), ISSUER, NOW), USER);
  });

  it("accepte une audience donnée sous forme de liste", () => {
    assert.deepEqual(identityFromClaims(goodClaims({ aud: ["x", "authenticated"] }), ISSUER, NOW), USER);
  });

  it("n'exige pas d'e-mail", () => {
    assert.deepEqual(identityFromClaims(goodClaims({ email: undefined }), ISSUER, NOW), { id: USER.id, email: undefined });
    assert.deepEqual(identityFromClaims(goodClaims({ email: "" }), ISSUER, NOW), { id: USER.id, email: undefined });
  });

  it("refuse la clé « anon » du projet, qui n'a ni utilisateur ni rôle authenticated", () => {
    assert.equal(identityFromClaims({ iss: ISSUER, role: "anon", aud: "authenticated", exp: NOW + 3600 }, ISSUER, NOW), null);
  });

  it("refuse un autre émetteur, une autre audience, un autre rôle", () => {
    assert.equal(identityFromClaims(goodClaims({ iss: "https://autre.supabase.co/auth/v1" }), ISSUER, NOW), null);
    assert.equal(identityFromClaims(goodClaims({ aud: "autre" }), ISSUER, NOW), null);
    assert.equal(identityFromClaims(goodClaims({ aud: undefined }), ISSUER, NOW), null);
    assert.equal(identityFromClaims(goodClaims({ role: "service_role" }), ISSUER, NOW), null);
  });

  it("refuse un jeton sans utilisateur", () => {
    assert.equal(identityFromClaims(goodClaims({ sub: undefined }), ISSUER, NOW), null);
    assert.equal(identityFromClaims(goodClaims({ sub: "" }), ISSUER, NOW), null);
    assert.equal(identityFromClaims(goodClaims({ sub: 42 }), ISSUER, NOW), null);
  });

  it("refuse un jeton expiré ou sans expiration", () => {
    assert.equal(identityFromClaims(goodClaims({ exp: NOW }), ISSUER, NOW), null);
    assert.equal(identityFromClaims(goodClaims({ exp: NOW - 1 }), ISSUER, NOW), null);
    assert.equal(identityFromClaims(goodClaims({ exp: undefined }), ISSUER, NOW), null);
    assert.equal(identityFromClaims(goodClaims({ exp: String(NOW + 3600) }), ISSUER, NOW), null);
  });

  it("refuse ce qui n'est pas un objet", () => {
    for (const bad of [null, undefined, "x", 12, []]) assert.equal(identityFromClaims(bad, ISSUER, NOW), null);
  });
});

describe("isWellFormedJwt", () => {
  it("reconnaît la forme d'un JWT", () => {
    assert.equal(isWellFormedJwt(TOKEN), true);
  });

  it("refuse ce qui n'a pas cette forme", () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "abc.def.ghi", "e30.e30", "e30.e30.", "e30.W10.c2ln", "e30.bnVsbA.c2ln", "e30.e30.s ig"]) {
      assert.equal(isWellFormedJwt(bad), false, bad);
    }
  });
});

describe("classifyAuthError", () => {
  it("un jeton invalide, expiré ou mal formé est un refus", () => {
    assert.equal(classifyAuthError({ name: "AuthInvalidJwtError", status: 400 }), "invalid");
  });

  it("un refus de Supabase Auth (4xx) est un refus, sauf la limite de débit", () => {
    assert.equal(classifyAuthError({ name: "AuthApiError", status: 401 }), "invalid");
    assert.equal(classifyAuthError({ name: "AuthApiError", status: 403 }), "invalid");
    assert.equal(classifyAuthError({ name: "AuthApiError", status: 429 }), "unavailable");
  });

  it("une panne n'est pas un refus", () => {
    assert.equal(classifyAuthError({ name: "AuthRetryableFetchError", status: 0 }), "unavailable");
    assert.equal(classifyAuthError({ name: "AuthApiError", status: 503 }), "unavailable");
    assert.equal(classifyAuthError(new Error("réseau")), "unavailable");
    assert.equal(classifyAuthError(null), "unavailable");
    assert.equal(classifyAuthError(undefined), "unavailable");
  });
});

// Un « service » qui compte ses appels : permet de vérifier si Supabase Auth a été interrogé.
function fakeService(answer: Identity | null) {
  const calls: string[] = [];
  return {
    calls,
    service: async (token: string) => (calls.push(token), answer),
  };
}

const deps = (over: Partial<AuthenticateDeps> & Pick<AuthenticateDeps, "service">): AuthenticateDeps => ({
  local: null,
  issuer: ISSUER,
  nowSeconds: () => NOW,
  ...over,
});

describe("authenticateToken : décisions", () => {
  it("vérification locale éteinte : Supabase Auth décide, comme avant", async () => {
    const s = fakeService(USER);
    assert.deepEqual(await authenticateToken("t", deps({ service: s.service })), USER);
    assert.equal(s.calls.length, 1);

    const refused = fakeService(null);
    assert.equal(await authenticateToken("t", deps({ service: refused.service })), null);
  });

  it("jeton valide en local : aucun appel à Supabase Auth", async () => {
    const s = fakeService(null);
    const local = async (): Promise<LocalResult> => ({ claims: goodClaims() });
    assert.deepEqual(await authenticateToken(TOKEN, deps({ local, service: s.service })), USER);
    assert.equal(s.calls.length, 0);
  });

  it("jeton invalide pour la bibliothèque : refusé sans appel à Supabase Auth", async () => {
    const s = fakeService(USER);
    const local = async (): Promise<LocalResult> => ({ error: { name: "AuthInvalidJwtError", status: 400 } });
    assert.equal(await authenticateToken(TOKEN, deps({ local, service: s.service })), null);
    assert.equal(s.calls.length, 0);
  });

  it("signature bonne mais contenu refusé (clé anon, mauvais émetteur) : Supabase Auth tranche", async () => {
    const s = fakeService(null);
    const local = async (): Promise<LocalResult> => ({ claims: goodClaims({ role: "anon", sub: undefined }) });
    assert.equal(await authenticateToken(TOKEN, deps({ local, service: s.service })), null);
    assert.equal(s.calls.length, 1);
  });

  it("panne de la vérification locale (réseau, 5xx, limite, exception) : Supabase Auth tranche", async () => {
    for (const local of [
      async (): Promise<LocalResult> => ({ error: { name: "AuthRetryableFetchError", status: 0 } }),
      async (): Promise<LocalResult> => ({ error: { name: "AuthApiError", status: 503 } }),
      async (): Promise<LocalResult> => ({ error: { name: "AuthApiError", status: 429 } }),
      async (): Promise<LocalResult> => {
        throw new Error("réseau");
      },
    ]) {
      const s = fakeService(USER);
      assert.deepEqual(await authenticateToken(TOKEN, deps({ local, service: s.service })), USER);
      assert.equal(s.calls.length, 1);
    }
  });

  it("jeton qui n'a pas la forme d'un JWT : refusé sans aucun appel", async () => {
    const s = fakeService(USER);
    let localCalls = 0;
    const local = async (): Promise<LocalResult> => (localCalls++, { claims: goodClaims() });
    for (const bad of ["", "  ", "pas-un-jeton", "a.b", "a.b.c.d", "abc.def.ghi", "e30.e30"]) {
      assert.equal(await authenticateToken(bad, deps({ local, service: s.service })), null);
    }
    assert.equal(localCalls, 0);
    assert.equal(s.calls.length, 0);
  });

  it("exception SyntaxError de la bibliothèque : refusé sans appel à Supabase Auth", async () => {
    const s = fakeService(USER);
    const local = async (): Promise<LocalResult> => {
      throw new SyntaxError("Unexpected token");
    };
    assert.equal(await authenticateToken(TOKEN, deps({ local, service: s.service })), null);
    assert.equal(s.calls.length, 0);
  });

  it("vérification locale éteinte : la forme du jeton n'est pas contrôlée, Supabase Auth décide", async () => {
    const s = fakeService(null);
    assert.equal(await authenticateToken("pas-un-jeton", deps({ service: s.service })), null);
    assert.equal(s.calls.length, 1);
  });

  it("un jeton qui expire pendant la requête n'est pas accepté en local", async () => {
    const s = fakeService(null);
    const local = async (): Promise<LocalResult> => ({ claims: goodClaims({ exp: NOW - 1 }) });
    assert.equal(await authenticateToken(TOKEN, deps({ local, service: s.service })), null);
    assert.equal(s.calls.length, 1);
  });
});

// --- Avec la vraie bibliothèque : signature ES256 contrôlée par supabase-js avec une clé générée ici.

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function makeKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" };
  return { privateKey, jwk, kid };
}

function signJwt(payload: Record<string, unknown>, key: { privateKey: KeyObject; kid: string }) {
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.kid }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${b64url(signature)}`;
}

describe("authenticateToken : signature réelle (supabase-js getClaims)", () => {
  const projectKey = makeKey("project-key");
  const strangerKey = makeKey("project-key"); // même identifiant, autre clé : signature fausse
  const auth = createClient("https://example.supabase.co", "test-key", { auth: { autoRefreshToken: false, persistSession: false } }).auth;

  const local = async (token: string): Promise<LocalResult> => {
    const { data, error } = await auth.getClaims(token, { jwks: { keys: [projectKey.jwk as never] } });
    return error || !data ? { error } : { claims: data.claims };
  };
  const nowS = Math.floor(Date.now() / 1000);
  const real = (service: AuthenticateDeps["service"]): AuthenticateDeps => ({ local, service, issuer: ISSUER });

  it("jeton signé par la clé du projet : accepté sans appel à Supabase Auth", async () => {
    const s = fakeService(null);
    const token = signJwt(goodClaims({ exp: nowS + 3600 }), projectKey);
    assert.deepEqual(await authenticateToken(token, real(s.service)), USER);
    assert.equal(s.calls.length, 0);
  });

  it("jeton signé par une autre clé : refusé sans appel à Supabase Auth", async () => {
    const s = fakeService(USER);
    const token = signJwt(goodClaims({ exp: nowS + 3600 }), strangerKey);
    assert.equal(await authenticateToken(token, real(s.service)), null);
    assert.equal(s.calls.length, 0);
  });

  it("jeton expiré : refusé sans appel à Supabase Auth", async () => {
    const s = fakeService(USER);
    const token = signJwt(goodClaims({ exp: nowS - 60 }), projectKey);
    assert.equal(await authenticateToken(token, real(s.service)), null);
    assert.equal(s.calls.length, 0);
  });

  it("contenu modifié après signature : refusé sans appel à Supabase Auth", async () => {
    const s = fakeService(USER);
    const token = signJwt(goodClaims({ exp: nowS + 3600, sub: "22222222-2222-2222-2222-222222222222" }), projectKey);
    const [h, , sig] = token.split(".");
    const forged = `${h}.${b64url(JSON.stringify(goodClaims({ exp: nowS + 3600, sub: USER.id })))}.${sig}`;
    assert.equal(await authenticateToken(forged, real(s.service)), null);
    assert.equal(s.calls.length, 0);
  });

  it("jeton mal formé : refusé sans appel à Supabase Auth", async () => {
    const s = fakeService(USER);
    for (const bad of ["pas-un-jeton", "a.b", "a.b.c.d", "", "....."]) {
      assert.equal(await authenticateToken(bad, real(s.service)), null);
    }
    assert.equal(s.calls.length, 0);
  });

  it("clé « anon » signée par le projet : jamais acceptée en local", async () => {
    const s = fakeService(null);
    const token = signJwt({ iss: ISSUER, role: "anon", ref: "example", exp: nowS + 3600 }, projectKey);
    assert.equal(await authenticateToken(token, real(s.service)), null);
    assert.equal(s.calls.length, 1); // Supabase Auth a tranché
  });
});
