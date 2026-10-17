// Provenance IA telle que le public la voit (badges « AI-generated » / « AI-assisted » de
// l'app d'écoute). Fonctions PURES : aucune base, pour les tester seules.
//
// Règle, la même que l'admin (voir declarationState dans la modération) : la déclaration la
// plus récente du morceau fait foi ; une déclaration écartée par un administrateur (« rejected »)
// ne s'affiche pas ; le statut « pending_review » ou « approved » ne compte pas. Seules les
// provenances « ai » et « hybrid » ont un badge : « human » n'est plus acceptée (décision du
// 12 oct. 2026) et un morceau sans déclaration n'affiche rien.

export type PublicProvenance = "ai" | "hybrid";

export interface DeclarationLike {
  provenance: string;
  status?: string | null;
}

export function publicProvenance(latest: DeclarationLike | null | undefined): PublicProvenance | null {
  if (!latest || latest.status === "rejected") return null;
  return latest.provenance === "ai" || latest.provenance === "hybrid" ? latest.provenance : null;
}

// Un album : « ai » seulement si TOUS ses morceaux sont déclarés 100 % IA. Dès qu'il y en a un
// qui ne l'est pas (hybride, ou sans déclaration utilisable) alors qu'un autre porte une
// provenance, l'album n'est plus entièrement généré : « hybrid » (AI-assisted). Aucun morceau
// avec une provenance, ou aucun morceau : pas de badge.
export function albumProvenance(tracks: readonly (PublicProvenance | null)[]): PublicProvenance | null {
  if (tracks.length === 0 || tracks.every((p) => p === null)) return null;
  return tracks.every((p) => p === "ai") ? "ai" : "hybrid";
}

/** Découpe une liste en lots (les listes d'identifiants de l'URL d'une requête ont une longueur limitée). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("chunk size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
