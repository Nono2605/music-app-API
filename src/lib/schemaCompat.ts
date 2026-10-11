// L'API peut être déployée un peu avant qu'une migration SQL soit appliquée à la
// base (c'est toi qui l'appliques). Ces tests de code d'erreur permettent aux
// routes qui utilisent une colonne ou une fonction récente de continuer à
// répondre pendant ce laps de temps, au lieu de tomber en 500.

type PgError = { code?: string } | null | undefined;

// Colonne absente : Postgres 42703 (PostgREST le relaie tel quel), PGRST204 dans le cache de schéma.
export function isMissingColumn(err: unknown): boolean {
  const code = (err as PgError)?.code;
  return code === "42703" || code === "PGRST204";
}

// Fonction absente : Postgres 42883, PostgREST PGRST202.
export function isMissingFunction(err: unknown): boolean {
  const code = (err as PgError)?.code;
  return code === "42883" || code === "PGRST202";
}
