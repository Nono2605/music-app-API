// Provenance déclarable (décision du 12 oct. 2026) : la bêta de Vynl est 100 % IA, la musique
// « human » n'est ni proposée ni acceptée. La valeur reste dans l'énumération de la base
// (Postgres ne retire pas une valeur d'énumération, et l'historique des déclarations est
// conservé tel quel) : le refus se fait donc ici, à l'entrée de l'API.
export const DECLARABLE_PROVENANCES = ["ai", "hybrid"] as const;
export type DeclarableProvenance = (typeof DECLARABLE_PROVENANCES)[number];

export function isDeclarableProvenance(value: unknown): value is DeclarableProvenance {
  return typeof value === "string" && (DECLARABLE_PROVENANCES as readonly string[]).includes(value);
}

// Le cas « human » a son propre message : l'artiste comprend que ce n'est pas une faute de saisie.
export function provenanceError(field: string, value: unknown): string {
  return value === "human"
    ? `${field}: human-made music is not accepted for now (Vynl publishes AI-generated music only)`
    : `${field} must be one of ${DECLARABLE_PROVENANCES.join(", ")}`;
}

// ---------------------------------------------------------------------------------------------
// Mise en attente (décision du 12 oct. 2026) : la bêta publie de la musique 100 % IA seulement.
// Un morceau déclaré « hybrid » est ENREGISTRÉ mais ne peut pas partir en relecture ; un morceau
// sans déclaration non plus. Même règle que l'admin (src/lib/moderation.ts, ACCEPTED_PROVENANCES),
// qui reste la barrière avant la publication : ici on évite seulement de laisser un morceau
// bloqué sans explication dans la file de relecture.
// Changer cette liste est un changement de code, relu et testé : c'est une décision juridique.
// ---------------------------------------------------------------------------------------------
export const ACCEPTED_PROVENANCES: readonly string[] = ["ai"];

export interface LatestDeclaration {
  provenance: string;
  status?: string | null;
}

// Le message de refus, ou null si la dernière déclaration permet la relecture.
export function declarationProblem(latest: LatestDeclaration | null | undefined): string | null {
  if (!latest) {
    return "Declare how this track was made before submitting it for review: the beta accepts AI-generated music only.";
  }
  if (latest.status === "rejected") {
    return "The AI declaration for this track was rejected. Update the declaration before submitting it for review.";
  }
  if (!ACCEPTED_PROVENANCES.includes(latest.provenance)) {
    return "The beta accepts AI-generated music only. This track stays saved with its current declaration, but it cannot be submitted for review yet.";
  }
  return null;
}

// Lignes triées de la PLUS RÉCENTE à la plus ancienne : on garde la première de chaque morceau.
export function latestDeclarations<T extends { track_id: string }>(rows: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) if (!latest.has(row.track_id)) latest.set(row.track_id, row);
  return latest;
}

export function releaseDeclarationProblem(
  tracks: { id: string; title: string }[],
  latestByTrack: Map<string, LatestDeclaration>
): string | null {
  const blocked = tracks.filter((track) => declarationProblem(latestByTrack.get(track.id)) !== null);
  if (blocked.length === 0) return null;

  const shown = blocked.slice(0, 3).map((track) => `“${track.title}”`);
  const more = blocked.length - shown.length;
  const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
  const noun = blocked.length === 1 ? "1 track cannot" : `${blocked.length} tracks cannot`;
  return `${noun} be reviewed yet: ${list}. The beta accepts tracks declared as AI-generated only; check each track's AI declaration.`;
}
