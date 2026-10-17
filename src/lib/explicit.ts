// Contenu explicite : les règles, sans base (testées par explicit.test.ts).
//
// Un morceau est explicite si son créateur l'a déclaré (`tracks.explicit`). Un album ou un single
// l'est dès qu'un de ses morceaux publiés l'est. L'auditeur peut refuser ce contenu dans ses
// réglages (`profiles.explicit_content`, vrai par défaut) :
//  - les listes du catalogue le masquent quand la webapp passe `?explicit=false` ;
//  - le démarrage d'une lecture (POST /plays) le refuse, quelle que soit la liste d'où il vient
//    (playlist, favoris, lien direct) : c'est ce contrôle-là qui fait foi.

/** `?explicit=false` : la liste ne doit contenir aucun contenu explicite. Toute autre valeur : tout est permis. */
export function hidesExplicit(query: Record<string, unknown>): boolean {
  return query.explicit === "false";
}

/** Un album (ou un single) est explicite dès qu'un de ses morceaux l'est. */
export function anyExplicit(tracks: readonly { explicit?: boolean | null }[] | null | undefined): boolean {
  return (tracks ?? []).some((track) => track.explicit === true);
}

/**
 * L'auditeur accepte-t-il le contenu explicite ? Sans profil (ou colonne illisible) : oui, comme
 * le réglage par défaut. Seul un `false` explicite le refuse.
 */
export function allowsExplicit(profile: { explicit_content?: boolean | null } | null | undefined): boolean {
  return profile?.explicit_content !== false;
}
