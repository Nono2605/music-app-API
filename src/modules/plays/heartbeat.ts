// Calcul des secondes écoutées à partir des battements de cœur du lecteur.
//
// C'est la règle qui décide de l'argent versé aux artistes (spec :
// docs/SPEC_REMUNERATION.md, sections 5 et 6) : fonction PURE, sans base ni
// réseau, pour pouvoir la tester sur des chronologies d'écoute et des tentatives
// de triche.
//
// Principe : le lecteur envoie des battements { seq, position, état }. Le temps
// écoulé entre deux battements n'est crédité que si le PRÉCÉDENT disait que la
// lecture tournait, et jamais plus que :
//   - l'avancée de la position (un saut en arrière ne rapporte rien),
//   - le temps réellement écoulé côté serveur (une lecture accélérée, ou un
//     client qui ment, ne crée pas de secondes : au plus 1 seconde par seconde).
// Un battement perdu ne fait donc rien perdre : le suivant crédite tout
// l'intervalle d'après la position atteinte.

export type HeartbeatState = "playing" | "paused" | "ended" | "closed";
export type StoredState = "started" | HeartbeatState;

export const HEARTBEAT_EVERY_SECONDS = 15;
/** D1 : une écoute est qualifiée à 30 s (ou le morceau entier s'il est plus court). */
export const QUALIFY_AFTER_SECONDS = 30;
/** Plafond d'une lecture dont la durée du morceau est inconnue. */
export const MAX_VALIDATED_WITHOUT_DURATION = 4 * 60 * 60;

export interface PlayState {
  last_heartbeat_at: string;
  last_position_seconds: number;
  last_state: StoredState;
  last_seq: number;
  validated_seconds: number;
  track_duration_seconds: number | null;
  qualified: boolean;
  ended_at: string | null;
}

export interface Heartbeat {
  seq: number;
  position_seconds: number;
  state: HeartbeatState;
}

export interface PlayUpdate {
  validated_seconds: number;
  last_heartbeat_at: string;
  last_position_seconds: number;
  last_state: HeartbeatState;
  last_seq: number;
  qualified?: true;
  qualified_at?: string;
  ended_at?: string;
  completed?: boolean;
}

export type HeartbeatOutcome =
  | { kind: "closed" } // la lecture est déjà terminée : rien à faire
  | { kind: "duplicate" } // battement déjà vu (ou plus ancien) : ignoré
  | { kind: "applied"; update: PlayUpdate; credited_seconds: number };

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Seuil de qualification. Un morceau de moins de 30 s est qualifié quand il a
 * été écouté en entier ; 1 s de tolérance, car le dernier battement arrive un
 * peu avant la toute fin.
 */
export function qualifyThreshold(trackDurationSeconds: number | null): number {
  if (trackDurationSeconds !== null && trackDurationSeconds < QUALIFY_AFTER_SECONDS) {
    return Math.max(trackDurationSeconds - 1, 0.5);
  }
  return QUALIFY_AFTER_SECONDS;
}

export function applyHeartbeat(play: PlayState, heartbeat: Heartbeat, now: Date): HeartbeatOutcome {
  if (play.ended_at !== null) return { kind: "closed" };
  if (heartbeat.seq <= play.last_seq) return { kind: "duplicate" };

  const elapsed = Math.max(0, (now.getTime() - Date.parse(play.last_heartbeat_at)) / 1000);
  const advance = heartbeat.position_seconds - play.last_position_seconds;
  const credit = play.last_state === "playing" ? Math.max(0, Math.min(advance, elapsed)) : 0;

  // Jamais plus que la durée du morceau dans UNE lecture : se replacer sans
  // cesse au début ne fait pas gonfler le total. Réécouter = nouvelle lecture.
  const cap = play.track_duration_seconds ?? MAX_VALIDATED_WITHOUT_DURATION;
  const validated = round3(Math.min(play.validated_seconds + credit, cap));

  const at = now.toISOString();
  const ends = heartbeat.state === "ended" || heartbeat.state === "closed";
  const becomesQualified = !play.qualified && validated >= qualifyThreshold(play.track_duration_seconds);

  const update: PlayUpdate = {
    validated_seconds: validated,
    last_heartbeat_at: at,
    last_position_seconds: round3(heartbeat.position_seconds),
    last_state: heartbeat.state,
    last_seq: heartbeat.seq,
    ...(becomesQualified ? { qualified: true as const, qualified_at: at } : {}),
    ...(ends ? { ended_at: at, completed: heartbeat.state === "ended" } : {}),
  };
  return { kind: "applied", update, credited_seconds: round3(validated - play.validated_seconds) };
}
