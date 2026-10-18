import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { firstRelation } from "./relation";

describe("firstRelation", () => {
  it("rend l'objet tel quel", () => {
    assert.deepEqual(firstRelation({ id: "a" }), { id: "a" });
  });

  it("prend le premier élément d'un tableau", () => {
    assert.deepEqual(firstRelation([{ id: "a" }, { id: "b" }]), { id: "a" });
  });

  it("rend null pour une relation absente ou un tableau vide", () => {
    assert.equal(firstRelation(null), null);
    assert.equal(firstRelation(undefined), null);
    assert.equal(firstRelation([]), null);
  });
});
