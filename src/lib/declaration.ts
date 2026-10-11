// Déclarations de provenance IA : règle PURE (aucune base) pour être testable seule.

interface DeclarationContent {
  provenance: string;
  description: string | null;
}

// Un nouvel enregistrement identique à la dernière déclaration n'apporte rien à
// l'historique : le créateur a seulement cliqué deux fois sur « Save ». On n'ajoute
// donc une ligne que si la provenance ou la description a vraiment changé.
//
// Conséquence voulue : si un admin a REFUSÉ la dernière déclaration, la renvoyer à
// l'identique ne la rétablit pas (sinon un simple « Save » contournerait le refus) ;
// il faut la modifier, ce qui crée une nouvelle déclaration.
export function isUnchangedDeclaration(latest: DeclarationContent | null, next: DeclarationContent): boolean {
  if (!latest) return false;
  return latest.provenance === next.provenance && (latest.description ?? null) === (next.description ?? null);
}
