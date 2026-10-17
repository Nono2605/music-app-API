import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isItemType, parseItem, parseLibraryParams, playlistVisibleTo } from "./page";

const ID = "0b9f2c4e-6c1a-4f5d-9a77-3e2d8c1b5a40";

describe("parseLibraryParams", () => {
  it("sans type : tous les types, 100 éléments par défaut", () => {
    assert.deepEqual(parseLibraryParams({}), { limit: 100, offset: 0, q: "", type: null });
  });

  it("lit le type, limit et offset", () => {
    const params = parseLibraryParams({ type: "album", limit: "50", offset: "100" });
    assert.equal(params?.type, "album");
    assert.equal(params?.limit, 50);
    assert.equal(params?.offset, 100);
  });

  it("un type inconnu ou en double est refusé", () => {
    assert.equal(parseLibraryParams({ type: "podcast" }), null);
    assert.equal(parseLibraryParams({ type: ["track", "album"] }), null);
    assert.equal(parseLibraryParams({ type: "" }), null);
  });
});

describe("parseItem", () => {
  it("accepte un type connu avec un UUID", () => {
    assert.deepEqual(parseItem("track", ID), { type: "track", id: ID });
  });

  it("refuse un type inconnu ou un identifiant qui n'est pas un UUID", () => {
    assert.equal(parseItem("podcast", ID), null);
    assert.equal(parseItem("track", "not-a-uuid"), null);
    assert.equal(parseItem(undefined, ID), null);
  });
});

describe("isItemType", () => {
  it("connaît les quatre types", () => {
    for (const type of ["track", "album", "artist", "playlist"]) assert.equal(isItemType(type), true);
    assert.equal(isItemType("Track"), false);
  });
});

describe("playlistVisibleTo", () => {
  it("publique : visible de tous", () => {
    assert.equal(playlistVisibleTo("u1", { owner_id: "u2", is_public: true }), true);
  });

  it("privée : visible de son auteur seulement", () => {
    assert.equal(playlistVisibleTo("u1", { owner_id: "u1", is_public: false }), true);
    assert.equal(playlistVisibleTo("u1", { owner_id: "u2", is_public: false }), false);
    assert.equal(playlistVisibleTo("u1", {}), false);
  });
});
