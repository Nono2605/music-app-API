// L'heure vue par la logique métier. Un objet plutôt qu'un appel direct à
// `new Date()` pour que les tests puissent la remplacer : valider des secondes
// d'écoute sur une chronologie de plusieurs minutes sans attendre.
export const clock = {
  now: (): Date => new Date(),
};
