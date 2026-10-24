import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_CONCURRENCY, MAX_SECONDS, parseLoadArgs, percentile, summarize } from "./loadStats";

describe("percentile", () => {
  it("rend le rang le plus proche d'une liste triée", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(sorted, 50), 50);
    assert.equal(percentile(sorted, 95), 95);
    assert.equal(percentile(sorted, 99), 99);
    assert.equal(percentile(sorted, 100), 100);
  });

  it("une liste vide ou à un seul élément", () => {
    assert.equal(percentile([], 95), 0);
    assert.equal(percentile([42], 1), 42);
    assert.equal(percentile([42], 99), 42);
  });
});

describe("summarize", () => {
  it("compte les erreurs (réseau et statuts hors 2xx) et le débit", () => {
    const summary = summarize(
      [
        { ms: 100, status: 200 },
        { ms: 200, status: 200 },
        { ms: 300, status: 429 },
        { ms: 400, status: 0 },
      ],
      2
    );
    assert.equal(summary.requests, 4);
    assert.equal(summary.errors, 2);
    assert.equal(summary.errorRate, 0.5);
    assert.equal(summary.perSecond, 2);
    assert.equal(summary.max, 400);
    assert.deepEqual(summary.statuses, { "200": 2, "429": 1, "0": 1 });
  });

  it("aucune requête : des zéros, pas de division par zéro", () => {
    const summary = summarize([], 0);
    assert.equal(summary.requests, 0);
    assert.equal(summary.errorRate, 0);
    assert.equal(summary.perSecond, 0);
    assert.equal(summary.max, 0);
  });
});

describe("parseLoadArgs", () => {
  it("exige une cible : aucune par défaut", () => {
    assert.throws(() => parseLoadArgs([]), /--url/);
  });

  it("valeurs par défaut prudentes", () => {
    assert.deepEqual(parseLoadArgs(["--url=http://localhost:4000/chemin"]), { url: "http://localhost:4000", concurrency: 10, seconds: 20 });
  });

  it("plafonne la concurrence et la durée", () => {
    const args = parseLoadArgs(["--url=http://localhost:4000", "--concurrency=5000", "--seconds=99999"]);
    assert.equal(args.concurrency, MAX_CONCURRENCY);
    assert.equal(args.seconds, MAX_SECONDS);
  });

  it("refuse la production sans --allow-production", () => {
    for (const url of ["https://api.vynl.ch", "https://www.vynl.ch", "https://music-app-api-9cjg.onrender.com"]) {
      assert.throws(() => parseLoadArgs([`--url=${url}`]), /production/, url);
      assert.equal(parseLoadArgs([`--url=${url}`, "--allow-production"]).url, url);
    }
  });

  it("refuse une adresse illisible, un autre protocole ou un nombre invalide", () => {
    assert.throws(() => parseLoadArgs(["--url=pas une adresse"]), /illisible/);
    assert.throws(() => parseLoadArgs(["--url=ftp://localhost"]), /http/);
    assert.throws(() => parseLoadArgs(["--url=http://localhost", "--concurrency=0"]), /positif/);
    assert.throws(() => parseLoadArgs(["--url=http://localhost", "--seconds=abc"]), /positif/);
  });
});
