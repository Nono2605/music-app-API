import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isoDay, parseStatsRange } from "./statsRange";

// 10 oct. 2026, milieu de journée UTC.
const now = new Date("2026-10-10T12:34:56Z");

describe("parseStatsRange", () => {
  it("sans paramètre : 30 jours par défaut", () => {
    const r = parseStatsRange(undefined, now)!;
    assert.equal(r.key, "30d");
    assert.equal(r.days, 30);
  });

  it("la fenêtre finit à minuit UTC de demain (borne haute exclue) et couvre aujourd'hui", () => {
    const r = parseStatsRange("30d", now)!;
    assert.equal(r.to.toISOString(), "2026-10-11T00:00:00.000Z");
    assert.equal(r.from.toISOString(), "2026-09-11T00:00:00.000Z");
    assert.equal(isoDay(r.from), "2026-09-11");
    // dernier jour inclus = la veille de la borne exclue
    assert.equal(isoDay(new Date(r.to.getTime() - 1)), "2026-10-10");
  });

  it("la période précédente a la même durée et touche la fenêtre sans la chevaucher", () => {
    const r = parseStatsRange("7d", now)!;
    assert.equal(r.previousTo.getTime(), r.from.getTime());
    assert.equal(r.previousTo.getTime() - r.previousFrom.getTime(), r.to.getTime() - r.from.getTime());
    assert.equal(r.previousFrom.toISOString(), "2026-09-27T00:00:00.000Z");
  });

  it("accepte 7d, 30d et 90d", () => {
    assert.deepEqual(
      ["7d", "30d", "90d"].map((k) => parseStatsRange(k, now)!.days),
      [7, 30, 90]
    );
  });

  it("à 23:59:59 UTC, la fenêtre est la même qu'à midi : le jour ne bouge pas avant minuit", () => {
    const late = parseStatsRange("30d", new Date("2026-10-10T23:59:59Z"))!;
    assert.equal(late.to.toISOString(), "2026-10-11T00:00:00.000Z");
    const next = parseStatsRange("30d", new Date("2026-10-11T00:00:00Z"))!;
    assert.equal(next.to.toISOString(), "2026-10-12T00:00:00.000Z");
  });

  it("passe correctement un changement de mois et d'année", () => {
    const r = parseStatsRange("7d", new Date("2027-01-02T08:00:00Z"))!;
    assert.equal(r.to.toISOString(), "2027-01-03T00:00:00.000Z");
    assert.equal(r.from.toISOString(), "2026-12-27T00:00:00.000Z");
  });

  it("refuse tout ce qui n'est pas une des trois valeurs", () => {
    for (const bad of ["", "1d", "30", "30D", "365d", "30d ", ["30d"], 30, null, {}]) {
      assert.equal(parseStatsRange(bad, now), null, JSON.stringify(bad));
    }
  });
});
