import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isStreamQuality, pickRendition, renditionKey } from "./renditions";
import { isSafeCdnKey } from "./cdnToken";

const r128 = { storage_key: "k-128", bitrate_kbps: 128 };
const r256 = { storage_key: "k-256", bitrate_kbps: 256 };

describe("pickRendition", () => {
  it("rend la version voulue quand elle existe", () => {
    assert.equal(pickRendition([r128, r256], "standard"), r128);
    assert.equal(pickRendition([r256, r128], "high"), r256);
  });

  it("se rabat sur la plus proche quand la version voulue manque", () => {
    assert.equal(pickRendition([r128], "high"), r128);
    assert.equal(pickRendition([r256], "standard"), r256);
  });

  it("rend null sans aucune version", () => {
    assert.equal(pickRendition([], "standard"), null);
  });

  it("à égalité de distance, prend le débit le plus bas", () => {
    const r192 = { storage_key: "k-192", bitrate_kbps: 192 };
    const r64 = { storage_key: "k-64", bitrate_kbps: 64 };
    // Voulu 128 : 64 et 192 sont à 64 de distance chacun.
    assert.equal(pickRendition([r192, r64], "standard"), r64);
    assert.equal(pickRendition([r64, r192], "standard"), r64);
  });
});

describe("isStreamQuality", () => {
  it("n'accepte que standard et high", () => {
    assert.equal(isStreamQuality("standard"), true);
    assert.equal(isStreamQuality("high"), true);
    for (const bad of ["HIGH", "low", "", 128, null, undefined, {}]) assert.equal(isStreamQuality(bad), false);
  });
});

describe("renditionKey", () => {
  it("compose t/<morceau>/<fichier>-<débit>.m4a, une clé que le CDN accepte", () => {
    const key = renditionKey("00000000-0000-4000-8000-000000000001", "f0000000-0000-4000-8000-000000000001", 128);
    assert.equal(key, "t/00000000-0000-4000-8000-000000000001/f0000000-0000-4000-8000-000000000001-128.m4a");
    assert.equal(isSafeCdnKey(key), true);
  });
});
