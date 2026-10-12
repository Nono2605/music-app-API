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
