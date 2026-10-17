// La forme d'un code de genre de la liste fermée (table genres) : minuscules, chiffres et « _ ». Un module à part,
// sans client Supabase, pour que les fonctions pures de recherche restent testables sans base.
export const GENRE_CODE = /^[a-z][a-z0-9_]{1,30}$/;
