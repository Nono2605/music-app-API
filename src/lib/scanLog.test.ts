import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { duplicateFileScan, nameSimilarityScans, recordScans, type ScanDb } from "./scanLog";
import { isMissingTable } from "./schemaCompat";
import { toSimilarNames } from "./artistNameCheck";

function silently<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  return fn().finally(() => void (console.error = original));
}

describe("recordScans", () => {
  it("écrit les lignes dans track_scans", async () => {
    const inserted: unknown[] = [];
    const db: ScanDb = { from: (table) => ({ insert: async (rows) => (inserted.push([table, rows]), { error: null }) }) };
    await recordScans([duplicateFileScan({ trackId: "t", artistId: "a", matchedTrackId: "m", matchedFileId: "f" })], db);
    assert.equal((inserted[0] as [string, unknown[]])[0], "track_scans");
    assert.equal(((inserted[0] as [string, unknown[]])[1] as unknown[]).length, 1);
  });

  it("ne fait rien (et n'appelle pas la base) sans enregistrement", async () => {
    let called = false;
    const db: ScanDb = { from: () => ({ insert: async () => ((called = true), { error: null }) }) };
    await recordScans([], db);
    assert.equal(called, false);
  });

  it("ne lève jamais : table absente, erreur d'écriture ou exception", async () => {
    const record = duplicateFileScan({ trackId: "t", artistId: "a", matchedTrackId: "m", matchedFileId: "f" });
    await silently(() => recordScans([record], { from: () => ({ insert: async () => ({ error: { code: "42P01" } }) }) }));
    await silently(() => recordScans([record], { from: () => ({ insert: async () => ({ error: { message: "boom" } }) }) }));
    await silently(() => recordScans([record], { from: () => ({ insert: async () => { throw new Error("réseau"); } }) }));
  });
});

describe("contenu des enregistrements", () => {
  it("un fichier dupliqué : échec, score 1, référence au morceau trouvé, aucune donnée personnelle", () => {
    const scan = duplicateFileScan({ trackId: "t", artistId: "a", matchedTrackId: "m", matchedFileId: "" });
    assert.equal(scan.result, "fail");
    assert.equal(scan.check_kind, "file_hash");
    assert.equal(scan.score, 1);
    assert.equal(scan.matched_track_id, "m");
    assert.equal(scan.detail?.matched_file_id, null);
  });

  it("une ressemblance de nom : avertissement, une ligne par nom proche, score arrondi", () => {
    const scans = nameSimilarityScans("a1", [
      { artist_id: "x", name: "Daft Punk", similarity: 0.7345678 },
      { artist_id: "y", name: "Daft Punks", similarity: 0.6 },
    ]);
    assert.equal(scans.length, 2);
    assert.equal(scans[0].result, "warn");
    assert.equal(scans[0].score, 0.735);
    assert.equal(scans[0].matched_artist_id, "x");
    assert.equal(scans[0].detail?.matched_name, "Daft Punk");
    assert.deepEqual(nameSimilarityScans("a1", []), []);
  });
});

describe("isMissingTable", () => {
  it("reconnaît les codes Postgres et PostgREST", () => {
    assert.equal(isMissingTable({ code: "42P01" }), true);
    assert.equal(isMissingTable({ code: "PGRST205" }), true);
    assert.equal(isMissingTable({ code: "23505" }), false);
    assert.equal(isMissingTable(null), false);
  });
});

describe("toSimilarNames", () => {
  it("garde les lignes valides et convertit la similarité en nombre", () => {
    assert.deepEqual(toSimilarNames([{ artist_id: "x", name: "Daft Punk", similarity: "0.73" }]), [
      { artist_id: "x", name: "Daft Punk", similarity: 0.73 },
    ]);
  });
  it("ignore ce qui n'est pas une ligne valide", () => {
    assert.deepEqual(toSimilarNames(null), []);
    assert.deepEqual(toSimilarNames("x"), []);
    assert.deepEqual(toSimilarNames([{ name: "sans id", similarity: 0.7 }, { artist_id: "x", name: "ok", similarity: "abc" }]), []);
  });
});
