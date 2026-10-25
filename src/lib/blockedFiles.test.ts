import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BLOCKED_FILE_MESSAGE, isBlockedChecksum, type BlockedDb } from "./blockedFiles";

const HASH = "a".repeat(64);

function dbReturning(result: { data: unknown[] | null; error: unknown }, calls: unknown[][] = []): BlockedDb {
  return {
    from: (table) => ({
      select: (columns) => ({
        eq: (column, value) => {
          calls.push([table, columns, column, value]);
          const query = { limit: () => query, then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve) };
          return query as never;
        },
      }),
    }),
  };
}

describe("isBlockedChecksum", () => {
  it("vrai quand l'empreinte est dans la liste, en interrogeant blocked_files par checksum", async () => {
    const calls: unknown[][] = [];
    assert.equal(await isBlockedChecksum(HASH, dbReturning({ data: [{ id: "x" }], error: null }, calls)), true);
    assert.deepEqual(calls[0], ["blocked_files", "id", "checksum", HASH]);
  });

  it("faux quand elle n'y est pas", async () => {
    assert.equal(await isBlockedChecksum(HASH, dbReturning({ data: [], error: null })), false);
    assert.equal(await isBlockedChecksum(HASH, dbReturning({ data: null, error: null })), false);
  });

  it("une empreinte mal formée n'interroge même pas la base", async () => {
    const calls: unknown[][] = [];
    for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), HASH + "0"]) {
      assert.equal(await isBlockedChecksum(bad, dbReturning({ data: [{ id: "x" }], error: null }, calls)), false);
    }
    assert.equal(calls.length, 0);
  });

  it("table absente (migration pas appliquée) : rien n'est bloqué", async () => {
    assert.equal(await isBlockedChecksum(HASH, dbReturning({ data: null, error: { code: "42P01" } })), false);
    assert.equal(await isBlockedChecksum(HASH, dbReturning({ data: null, error: { code: "PGRST205" } })), false);
  });

  it("toute autre panne remonte : on refuse l'envoi plutôt que de laisser passer un fichier bloqué", async () => {
    const boom = { code: "57014", message: "timeout" };
    await assert.rejects(() => isBlockedChecksum(HASH, dbReturning({ data: null, error: boom })), (err) => err === boom);
  });
});

describe("BLOCKED_FILE_MESSAGE", () => {
  it("ne dit ni pourquoi, ni à la suite de quoi", () => {
    assert.doesNotMatch(BLOCKED_FILE_MESSAGE, /claim|rights|copyright|takedown|block/i);
  });
});
