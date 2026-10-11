// Résultat de l'insertion d'un morceau dans une playlist (POST /playlists/:id/tracks).
// La table playlist_tracks a une contrainte unique (playlist_id, track_id) : ajouter deux
// fois le même morceau n'est pas une erreur, c'est « déjà dedans », et la route le dit au
// lieu de répondre pareil dans les deux cas. Toute autre erreur reste une erreur.

export type AddTrackOutcome = "added" | "duplicate";

const UNIQUE_VIOLATION = "23505";

export function addTrackOutcome(error: { code?: string } | null): AddTrackOutcome {
  if (!error) return "added";
  if (error.code === UNIQUE_VIOLATION) return "duplicate";
  throw error;
}
