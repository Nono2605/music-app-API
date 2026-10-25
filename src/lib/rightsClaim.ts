// Le formulaire public de signalement des ayants droit (spec 15.3, C4) : validation du formulaire, garde-fous
// contre l'abus, et dépôt en base. Pur (la base est injectée) pour être testé sans réseau.
//
// Le formulaire est PUBLIC (pas de compte) : tout y est donc borné (longueurs, valeurs permises), un champ piège
// attrape les robots, et un plafond global par heure protège la base d'un déluge. La réponse ne répète jamais ce
// qui a été envoyé ; elle ne donne que le numéro de dossier.
import { isMissingTable } from "./schemaCompat";

export const CLAIM_CAPACITIES = ["owner", "agent", "performer"] as const;
export const CLAIM_TYPES = ["recording", "composition", "voice_or_likeness", "name_or_trademark", "other"] as const;

export type ClaimCapacity = (typeof CLAIM_CAPACITIES)[number];
export type ClaimType = (typeof CLAIM_TYPES)[number];

// Mêmes bornes que les contraintes de la table rights_claims (migration 20261025000002).
const LIMITS = {
  name: { min: 1, max: 120 },
  email: { min: 3, max: 254 },
  organization: { min: 1, max: 120 },
  trackReference: { min: 1, max: 500 },
  originalWork: { min: 1, max: 2000 },
  description: { min: 20, max: 4000 },
} as const;

export const CLAIMS_PER_HOUR_LIMIT = 100;

export interface ClaimRow {
  claimant_name: string;
  claimant_email: string;
  claimant_organization: string | null;
  capacity: ClaimCapacity;
  claim_type: ClaimType;
  track_reference: string;
  original_work: string;
  description: string;
  good_faith_statement: true;
}

export type ClaimValidation =
  | { ok: true; spam: true }
  | { ok: true; spam: false; row: ClaimRow }
  | { ok: false; field: string; error: string };

// Caractères de contrôle (sauf retour à la ligne et tabulation) : jamais dans un texte de formulaire.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Un « chez-quelqu'un@domaine.tld » raisonnable ; la base vérifie une forme encore plus large.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(CONTROL_CHARS, "").trim() : undefined;
}

// Points de code, comme char_length de Postgres (un émoji compte un, pas deux).
function length(value: string): number {
  return Array.from(value).length;
}

export function validateClaim(body: unknown): ClaimValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, field: "body", error: "The form could not be read." };
  }
  const input = body as Record<string, unknown>;

  // Champ piège : invisible pour une personne, rempli par un robot. On fait comme si de rien n'était.
  if (clean(input.website)) return { ok: true, spam: true };

  const fail = (field: string, error: string): ClaimValidation => ({ ok: false, field, error });
  const bounded = (field: string, label: string, raw: unknown, limits: { min: number; max: number }): string | ClaimValidation => {
    const value = clean(raw);
    if (value === undefined || length(value) < limits.min) {
      return fail(field, limits.min <= 1 ? `${label} is required.` : `${label} must be at least ${limits.min} characters.`);
    }
    if (length(value) > limits.max) return fail(field, `${label} must be at most ${limits.max} characters.`);
    return value;
  };

  const name = bounded("name", "Your name", input.name, LIMITS.name);
  if (typeof name !== "string") return name;
  const email = bounded("email", "Your e-mail address", input.email, LIMITS.email);
  if (typeof email !== "string") return email;
  if (!EMAIL.test(email)) return fail("email", "Please enter a valid e-mail address.");

  let organization: string | null = null;
  const rawOrganization = clean(input.organization);
  if (rawOrganization) {
    const checked = bounded("organization", "Organization", rawOrganization, LIMITS.organization);
    if (typeof checked !== "string") return checked;
    organization = checked;
  }

  if (!CLAIM_CAPACITIES.includes(input.capacity as ClaimCapacity)) return fail("capacity", "Please say in what capacity you are writing.");
  if (!CLAIM_TYPES.includes(input.claim_type as ClaimType)) return fail("claim_type", "Please choose what your claim is about.");

  const trackReference = bounded("track_reference", "The track concerned", input.track_reference, LIMITS.trackReference);
  if (typeof trackReference !== "string") return trackReference;
  const originalWork = bounded("original_work", "The original work", input.original_work, LIMITS.originalWork);
  if (typeof originalWork !== "string") return originalWork;
  const description = bounded("description", "The description", input.description, LIMITS.description);
  if (typeof description !== "string") return description;

  if (input.good_faith !== true) {
    return fail("good_faith", "Please confirm that the information is accurate and that you are entitled to act.");
  }

  return {
    ok: true,
    spam: false,
    row: {
      claimant_name: name,
      claimant_email: email,
      claimant_organization: organization,
      capacity: input.capacity as ClaimCapacity,
      claim_type: input.claim_type as ClaimType,
      track_reference: trackReference,
      original_work: originalWork,
      description,
      good_faith_statement: true,
    },
  };
}

// Le numéro de dossier donné au demandeur : « RC-00012 ».
export function claimReference(claimNumber: number | string): string {
  return `RC-${String(claimNumber).padStart(5, "0")}`;
}

export interface ClaimDb {
  /** Nombre de signalements reçus depuis cette date. */
  countSince(sinceIso: string): Promise<number>;
  insert(row: ClaimRow): Promise<{ claim_number: number }>;
}

export interface ClaimResponse {
  status: number;
  body: Record<string, unknown>;
}

// Le dépôt d'un signalement. `random` n'est là que pour fabriquer le faux numéro rendu aux robots.
export async function submitClaim(
  db: ClaimDb,
  body: unknown,
  now: Date,
  random: () => number = Math.random
): Promise<ClaimResponse> {
  const checked = validateClaim(body);
  if (!checked.ok) return { status: 400, body: { error: checked.error, field: checked.field } };
  if (checked.spam) return { status: 201, body: { reference: claimReference(Math.floor(random() * 99999) + 1) } };

  try {
    const sinceIso = new Date(now.getTime() - 3_600_000).toISOString();
    if ((await db.countSince(sinceIso)) >= CLAIMS_PER_HOUR_LIMIT) {
      return { status: 429, body: { error: "We are receiving a very large number of claims right now. Please try again in an hour.", code: "claims_busy" } };
    }
    const saved = await db.insert(checked.row);
    return { status: 201, body: { reference: claimReference(saved.claim_number) } };
  } catch (err) {
    // La migration n'est pas encore appliquée : le formulaire est indisponible, pas cassé.
    if (isMissingTable(err)) return { status: 503, body: { error: "This form is temporarily unavailable. Please try again later.", code: "unavailable" } };
    throw err;
  }
}
