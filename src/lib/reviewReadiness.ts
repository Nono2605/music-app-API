// Un morceau ou une release ne part en relecture (status « in_review ») que s'il y a
// quelque chose à relire : de l'audio. Sinon l'administrateur recevrait des morceaux
// vides qu'il ne peut ni écouter ni publier (la base refuse d'ailleurs de publier un
// morceau sans fichier). Fonctions pures : elles rendent le message de refus, ou null.

export function trackReviewProblem(audioFileCount: number): string | null {
  return audioFileCount > 0 ? null : "Add an audio file before submitting this track for review.";
}

export function releaseReviewProblem(
  tracks: { id: string; title: string }[],
  idsWithAudio: Iterable<string>
): string | null {
  if (tracks.length === 0) {
    return "Add at least one track before submitting this release for review.";
  }
  const have = new Set(idsWithAudio);
  const missing = tracks.filter((t) => !have.has(t.id));
  if (missing.length === 0) return null;

  const shown = missing.slice(0, 3).map((t) => `“${t.title}”`);
  const more = missing.length - shown.length;
  const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
  const noun = missing.length === 1 ? "1 track has" : `${missing.length} tracks have`;
  return `${noun} no audio file yet: ${list}. Add the audio on each track's page first.`;
}
