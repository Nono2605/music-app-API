import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerConfig } from "./config";

const full = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };

describe("parseWorkerConfig", () => {
  it("lit les réglages et prend le bucket et la pause par défaut", () => {
    const result = parseWorkerConfig(full, "/bin/ffmpeg-static");
    assert.deepEqual(result, {
      ok: true,
      config: { r2: { accountId: "acc", accessKeyId: "key", secretAccessKey: "secret", bucket: "vynlmusic" }, ffmpegPath: "/bin/ffmpeg-static", pollSeconds: 10 },
    });
  });

  it("FFMPEG_PATH l'emporte sur le ffmpeg du paquet ; bucket et pause réglables", () => {
    const result = parseWorkerConfig({ ...full, FFMPEG_PATH: "/usr/bin/ffmpeg", R2_BUCKET: "autre", TRANSCODE_POLL_SECONDS: "30" }, "/bin/ffmpeg-static");
    assert.equal(result.ok && result.config.ffmpegPath, "/usr/bin/ffmpeg");
    assert.equal(result.ok && result.config.r2.bucket, "autre");
    assert.equal(result.ok && result.config.pollSeconds, 30);
  });

  it("une pause absurde retombe sur 10 secondes", () => {
    for (const value of ["0", "1", "301", "abc", "-5", ""]) {
      const result = parseWorkerConfig({ ...full, TRANSCODE_POLL_SECONDS: value }, "/f");
      assert.equal(result.ok && result.config.pollSeconds, 10, value);
    }
  });

  it("liste ce qui manque, sans jamais citer une valeur", () => {
    assert.deepEqual(parseWorkerConfig({}, null), { ok: false, missing: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "FFMPEG_PATH"] });
    assert.deepEqual(parseWorkerConfig({ ...full, R2_SECRET_ACCESS_KEY: "   " }, "/f"), { ok: false, missing: ["R2_SECRET_ACCESS_KEY"] });
  });
});
