import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashIp, parseClientInfo, parseCountry, parseDevice } from "./clientInfo";

const now = new Date("2026-10-10T12:00:00Z");

describe("parseCountry", () => {
  it("accepte un code à deux lettres, quelle que soit la casse", () => {
    assert.equal(parseCountry("FR"), "FR");
    assert.equal(parseCountry(" be "), "BE");
  });

  it("refuse l'inconnu, le faux pays et le n'importe quoi", () => {
    for (const bad of [undefined, "", "F", "FRA", "XX", "T1", "1A", "F R", "FR; drop table", ["", "FR"]]) {
      assert.equal(parseCountry(bad as string | string[] | undefined), null, JSON.stringify(bad));
    }
  });

  it("si l'en-tête est répété, prend la première valeur", () => {
    assert.equal(parseCountry(["de", "fr"]), "DE");
  });
});

describe("parseDevice", () => {
  const UA = {
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    androidPhone: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
    androidTablet: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  };

  it("distingue mobile, tablette et ordinateur", () => {
    assert.equal(parseDevice(UA.iphone), "mobile");
    assert.equal(parseDevice(UA.androidPhone), "mobile");
    assert.equal(parseDevice(UA.ipad), "tablet");
    assert.equal(parseDevice(UA.androidTablet), "tablet"); // Android sans « Mobile » = tablette
    assert.equal(parseDevice(UA.mac), "desktop");
    assert.equal(parseDevice(UA.windows), "desktop");
  });

  it("pas de user-agent -> inconnu (null), pas « desktop » par défaut", () => {
    assert.equal(parseDevice(undefined), null);
    assert.equal(parseDevice("   "), null);
  });
});

describe("hashIp", () => {
  it("sans secret : pas d'empreinte (jamais un hash non salé)", () => {
    assert.equal(hashIp("203.0.113.7", undefined, now), null);
    assert.equal(hashIp("203.0.113.7", "", now), null);
  });

  it("ne contient jamais l'IP et a toujours la même longueur", () => {
    const h = hashIp("203.0.113.7", "secret", now)!;
    assert.equal(h.length, 32);
    assert.ok(!h.includes("203"));
    assert.match(h, /^[0-9a-f]{32}$/);
  });

  it("stable dans la journée, différent d'un jour à l'autre et d'une IP à l'autre", () => {
    const a = hashIp("203.0.113.7", "secret", now);
    assert.equal(a, hashIp("203.0.113.7", "secret", new Date("2026-10-10T23:59:59Z")));
    assert.notEqual(a, hashIp("203.0.113.7", "secret", new Date("2026-10-11T00:00:00Z")));
    assert.notEqual(a, hashIp("203.0.113.8", "secret", now));
    assert.notEqual(a, hashIp("203.0.113.7", "autre-secret", now));
  });

  it("accepte IPv4 et IPv6, refuse le reste", () => {
    assert.ok(hashIp("2001:db8::1", "s", now));
    for (const bad of [undefined, "", "not an ip", "1.2.3.4, 5.6.7.8", "x".repeat(60)]) {
      assert.equal(hashIp(bad, "s", now), null, String(bad));
    }
  });
});

describe("parseClientInfo", () => {
  it("lit les trois en-têtes x-vynl-client-*", () => {
    const info = parseClientInfo(
      {
        "x-vynl-client-country": "fr",
        "x-vynl-client-ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
        "x-vynl-client-ip": "203.0.113.7",
      },
      { ipHashSecret: "s", now }
    );
    assert.equal(info.country_code, "FR");
    assert.equal(info.device_type, "mobile");
    assert.match(info.ip_hash!, /^[0-9a-f]{32}$/);
  });

  it("en-têtes absents : tout à null, la lecture démarre quand même", () => {
    assert.deepEqual(parseClientInfo({}, { ipHashSecret: "s", now }), {
      country_code: null,
      device_type: null,
      ip_hash: null,
    });
  });
});
