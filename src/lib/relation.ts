// Selon les types générés, PostgREST renvoie une relation many-to-one en objet ou en tableau d'un
// élément : on accepte les deux et on rend toujours un objet (ou null).
export function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
