import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { releaseReviewProblem, trackReviewProblem } from "./reviewReadiness";

describe("trackReviewProblem", () => {
  it("sans fichier audio : refusé, avec un message clair", () => {
    assert.match(trackReviewProblem(0)!, /Add an audio file/);
  });
  it("avec au moins un fichier : accepté", () => {
    assert.equal(trackReviewProblem(1), null);
    assert.equal(trackReviewProblem(3), null);
  });
});

describe("releaseReviewProblem", () => {
  const t = (id: string, title: string) => ({ id, title });

  it("sans aucun morceau : refusé", () => {
    assert.match(releaseReviewProblem([], [])!, /at least one track/);
  });
  it("tous les morceaux ont de l'audio : accepté", () => {
    assert.equal(releaseReviewProblem([t("a", "A"), t("b", "B")], ["a", "b", "intrus"]), null);
  });
  it("un morceau sans audio est nommé", () => {
    assert.equal(
      releaseReviewProblem([t("a", "Intro"), t("b", "Outro")], ["a"]),
      "1 track has no audio file yet: “Outro”. Add the audio on each track's page first."
    );
  });
  it("au plus trois noms, puis « and N more »", () => {
    const tracks = ["1", "2", "3", "4", "5"].map((n) => t(n, `T${n}`));
    assert.equal(
      releaseReviewProblem(tracks, []),
      "5 tracks have no audio file yet: “T1”, “T2”, “T3” and 2 more. Add the audio on each track's page first."
    );
  });
  it("accepte n'importe quel itérable d'identifiants", () => {
    assert.equal(releaseReviewProblem([t("a", "A")], new Set(["a"])), null);
  });
});
