import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cdnSignature, isSafeCdnKey, parseCdnConfig, signCdnUrl } from "./cdnToken";

// Vecteur partagé avec le Worker (cdn-worker/test/token.test.js) : si l'un change, l'autre doit changer.
const SECRET = "secret-de-test-pour-les-vecteurs";
const KEY = "t/00000000-0000-4000-8000-000000000001/f1-128.m4a";
const EXPIRES = 1800000000;
const SIGNATURE = "KvQbQqMJxZVWT-ySEM2ceFmQPdKJlyao_YDDooeIubQ";

describe("cdnSignature", () => {
  it("reproduit le vecteur de test partagé avec le Worker", () => {
    assert.equal(cdnSignature(SECRET, KEY, EXPIRES), SIGNATURE);
  });

  it("change si la clé, l'expiration ou le secret change", () => {
    assert.notEqual(cdnSignature(SECRET, KEY + "x", EXPIRES), SIGNATURE);
    assert.notEqual(cdnSignature(SECRET, KEY, EXPIRES + 1), SIGNATURE);
    assert.notEqual(cdnSignature(SECRET + "x", KEY, EXPIRES), SIGNATURE);
  });

  it("n'a que des caractères sûrs pour une adresse (base64url, sans « = »)", () => {
    assert.match(cdnSignature(SECRET, KEY, EXPIRES), /^[A-Za-z0-9_-]{43}$/);
  });
});

describe("signCdnUrl", () => {
  it("assemble l'adresse avec l'expiration et la signature", () => {
    assert.equal(signCdnUrl("https://cdn.vynl.li", KEY, SECRET, EXPIRES), `https://cdn.vynl.li/${KEY}?e=${EXPIRES}&s=${SIGNATURE}`);
  });

  it("accepte une base avec « / » final", () => {
    assert.equal(signCdnUrl("https://cdn.vynl.li/", KEY, SECRET, EXPIRES), `https://cdn.vynl.li/${KEY}?e=${EXPIRES}&s=${SIGNATURE}`);
  });

  it("refuse de signer une clé dangereuse", () => {
    for (const bad of ["../secret", "/t/a.m4a", "t//a.m4a", "t/a b.m4a", "t/a?x=1", ""]) {
      assert.throws(() => signCdnUrl("https://cdn.vynl.li", bad, SECRET, EXPIRES), /Unsafe/, bad);
    }
  });
});

describe("isSafeCdnKey", () => {
  it("accepte les clés de fichiers du CDN", () => {
    assert.equal(isSafeCdnKey(KEY), true);
    assert.equal(isSafeCdnKey("t/abc/file.m4a"), true);
  });

  it("refuse les chemins qui remontent, les espaces, les caractères spéciaux et les clés trop longues", () => {
    for (const bad of ["a/../b", "..", ".", "a/./b", "a b", "a%2Fb", "a\\b", "é.m4a", "a/b/", `a/${"x".repeat(300)}`]) {
      assert.equal(isSafeCdnKey(bad), false, bad);
    }
  });
});

describe("parseCdnConfig", () => {
  it("garde l'origine de l'adresse et le secret", () => {
    assert.deepEqual(parseCdnConfig("https://cdn.vynl.li/", " secret "), { baseUrl: "https://cdn.vynl.li", secret: "secret" });
    assert.deepEqual(parseCdnConfig("https://cdn.vynl.li/un/chemin?x=1", "s"), { baseUrl: "https://cdn.vynl.li", secret: "s" });
  });

  it("éteint le CDN s'il manque l'adresse ou le secret", () => {
    assert.equal(parseCdnConfig(undefined, "s"), undefined);
    assert.equal(parseCdnConfig("https://cdn.vynl.li", undefined), undefined);
    assert.equal(parseCdnConfig("", "s"), undefined);
    assert.equal(parseCdnConfig("https://cdn.vynl.li", "  "), undefined);
  });

  it("refuse une adresse illisible ou en http (sauf vers la machine locale)", () => {
    assert.equal(parseCdnConfig("pas une adresse", "s"), undefined);
    assert.equal(parseCdnConfig("http://cdn.vynl.li", "s"), undefined);
    assert.deepEqual(parseCdnConfig("http://localhost:8787", "s"), { baseUrl: "http://localhost:8787", secret: "s" });
  });
});
