import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldBreakdown, shapeBreakdown, shapeDaily, shapeTotals, toNumber } from "./statsShape";

describe("toNumber", () => {
  it("accepte nombres et textes numériques (numeric de PostgREST), sinon 0", () => {
    assert.equal(toNumber(12), 12);
    assert.equal(toNumber("800.000"), 800);
    for (const bad of [undefined, null, "abc", NaN, Infinity]) assert.equal(toNumber(bad), 0);
  });
});

describe("shapeTotals / shapeDaily", () => {
  it("normalise une ligne de totaux, et une ligne absente donne des zéros", () => {
    assert.deepEqual(shapeTotals({ plays: "7", starts: 8, listeners: 3, seconds: "800.000", saves: 2, new_followers: 2 }), {
      plays: 7,
      starts: 8,
      listeners: 3,
      seconds: 800,
      saves: 2,
      new_followers: 2,
    });
    assert.deepEqual(shapeTotals(undefined), { plays: 0, starts: 0, listeners: 0, seconds: 0, saves: 0, new_followers: 0 });
  });

  it("garde la date en texte AAAA-MM-JJ et les compteurs en nombres", () => {
    assert.deepEqual(shapeDaily([{ day: "2026-10-09", plays: 4, listeners: "2", seconds: "560.000" }]), [
      { day: "2026-10-09", plays: 4, listeners: 2, seconds: 560 },
    ]);
  });
});

describe("foldBreakdown", () => {
  const row = (key: string, plays: number) => ({ key, plays, seconds: plays * 10 });

  it("laisse tel quel quand il y a moins de clés que la limite", () => {
    assert.deepEqual(foldBreakdown([row("FR", 5), row("BE", 1)], 8), [row("FR", 5), row("BE", 1)]);
  });

  it("regroupe la queue sous « other » et additionne plays et secondes", () => {
    const out = foldBreakdown([row("A", 9), row("B", 8), row("C", 3), row("D", 2)], 2);
    assert.deepEqual(out, [row("A", 9), row("B", 8), { key: "other", plays: 5, seconds: 50 }]);
  });

  it("garde « unknown » à part et en dernier, jamais dans les premiers ni dans « other »", () => {
    const out = foldBreakdown([row("unknown", 50), row("A", 9), row("B", 8), row("C", 3)], 2);
    assert.deepEqual(
      out.map((r) => r.key),
      ["A", "B", "other", "unknown"]
    );
    assert.equal(out.at(-1)!.plays, 50);
  });

  it("départage les égalités par la clé : un résultat identique d'un appel à l'autre", () => {
    const a = foldBreakdown([row("B", 4), row("A", 4)], 8);
    const b = foldBreakdown([row("A", 4), row("B", 4)], 8);
    assert.deepEqual(a, b);
    assert.equal(a[0].key, "A");
  });

  it("liste vide -> liste vide", () => {
    assert.deepEqual(foldBreakdown([], 8), []);
  });
});

describe("shapeBreakdown", () => {
  it("range les lignes par dimension et ignore une dimension inconnue", () => {
    const out = shapeBreakdown([
      { dimension: "source", key: "album", plays: 3, seconds: "470" },
      { dimension: "country", key: "FR", plays: 5, seconds: 580 },
      { dimension: "device", key: "unknown", plays: 1, seconds: 120 },
      { dimension: "intrus", key: "x", plays: 9, seconds: 9 },
    ]);
    assert.deepEqual(out.source, [{ key: "album", plays: 3, seconds: 470 }]);
    assert.deepEqual(out.country, [{ key: "FR", plays: 5, seconds: 580 }]);
    assert.deepEqual(out.device, [{ key: "unknown", plays: 1, seconds: 120 }]);
  });
});
