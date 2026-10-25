import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { csvCell } from "./acrcloudPilot";

describe("csvCell", () => {
  it("laisse une valeur simple telle quelle, une valeur vide devient une cellule vide", () => {
    assert.equal(csvCell("track.mp3"), "track.mp3");
    assert.equal(csvCell(92), "92");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
  });

  it("met entre guillemets ce qui contient une virgule, un guillemet ou un saut de ligne, et double les guillemets", () => {
    assert.equal(csvCell("Song, part 2"), '"Song, part 2"');
    assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
    assert.equal(csvCell("a\nb"), '"a\nb"');
  });
});
