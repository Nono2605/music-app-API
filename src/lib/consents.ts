// Consentements et acceptations d'un compte (table `consents`, migration
// 20261013000000_privacy_consents_and_retention.sql).
//
// Règle PURE (aucune base, aucune variable d'environnement) pour être testable seule ; la
// lecture et l'écriture sont dans modules/privacy/routes.ts.
//
// Principe : on AJOUTE une ligne à chaque décision, on ne modifie jamais. L'état actuel d'un
// compte pour une finalité est sa ligne la plus récente. Deux finalités sont obligatoires
// pour utiliser Vynl (conditions et politique, âge minimum) ; les autres sont facultatives
// et ne s'affichent que si on les active (PRIVACY_OPTIONAL_PURPOSES) : tant que Vynl ne
// montre pas de publicité personnalisée, on ne demande rien d'inutile.

export const TERMS_PURPOSE = "terms";

// Les finalités facultatives que l'API sait enregistrer. Une nouvelle finalité s'ajoute ici
// (aucune migration : la colonne `purpose` est un texte).
export const KNOWN_OPTIONAL_PURPOSES = ["ads_personalization", "analytics"] as const;

// Version du texte affiché (politique, conditions) : une étiquette choisie par l'équipe,
// ex. « 2026-10 » ou « 2026-10-draft ». Juste un identifiant sûr, pas une date à interpréter.
export const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

// Âge minimum : 16 ans partout dans l'UE est la valeur sûre (le RGPD laisse chaque État le
// fixer entre 13 et 16). À confirmer par un juriste pour la Suisse et le lancement.
export const DEFAULT_MIN_AGE = 16;
const MIN_AGE_BOUNDS = [13, 18] as const;

const CLIENT_SOURCES = ["welcome", "settings"] as const;
type ClientSource = (typeof CLIENT_SOURCES)[number];

export interface PrivacyConfig {
  minAge: number;
  // Finalités facultatives activées (sous-ensemble de KNOWN_OPTIONAL_PURPOSES).
  optionalPurposes: string[];
}

export function parsePrivacyConfig(minAgeRaw: string | undefined, purposesRaw: string | undefined): PrivacyConfig {
  const parsed = Number.parseInt(minAgeRaw ?? "", 10);
  const minAge =
    Number.isInteger(parsed) && parsed >= MIN_AGE_BOUNDS[0] && parsed <= MIN_AGE_BOUNDS[1] ? parsed : DEFAULT_MIN_AGE;

  const requested = (purposesRaw ?? "")
    .split(",")
    .map((purpose) => purpose.trim())
    .filter(Boolean);
  const optionalPurposes = [...new Set(requested)].filter((purpose) =>
    (KNOWN_OPTIONAL_PURPOSES as readonly string[]).includes(purpose)
  );

  return { minAge, optionalPurposes };
}

// La finalité « j'ai l'âge minimum » porte le seuil dans son nom : si le seuil change, plus
// personne n'a la nouvelle finalité et l'écran d'accueil le redemande, sans migration.
export function agePurpose(minAge: number): string {
  return `age_${minAge}`;
}

export interface ConsentRecord {
  purpose: string;
  granted: boolean;
  policy_version: string;
  created_at: string;
}

// La décision la plus récente de chaque finalité. À date égale, la dernière de la liste gagne.
export function latestByPurpose(rows: readonly ConsentRecord[]): Map<string, ConsentRecord> {
  const latest = new Map<string, ConsentRecord>();
  for (const row of rows) {
    const current = latest.get(row.purpose);
    if (!current || Date.parse(row.created_at) >= Date.parse(current.created_at)) latest.set(row.purpose, row);
  }
  return latest;
}

export interface PrivacyState {
  policy_version: string;
  min_age: number;
  // Faut-il montrer l'écran d'accueil (conditions + âge) ?
  needs_acceptance: boolean;
  terms_accepted_at: string | null;
  age_confirmed: boolean;
  // Les choix facultatifs activés ; granted = null : jamais demandé.
  choices: { purpose: string; granted: boolean | null }[];
}

// Les conditions doivent avoir été acceptées pour la version ACTUELLE du texte (un nouveau
// texte se redemande) ; l'âge, lui, ne change pas avec le texte : une fois confirmé, il vaut.
export function privacyState(rows: readonly ConsentRecord[], version: string, config: PrivacyConfig): PrivacyState {
  const latest = latestByPurpose(rows);
  const terms = latest.get(TERMS_PURPOSE);
  const age = latest.get(agePurpose(config.minAge));

  const termsAccepted = Boolean(terms?.granted && terms.policy_version === version);
  const ageConfirmed = Boolean(age?.granted);

  return {
    policy_version: version,
    min_age: config.minAge,
    needs_acceptance: !(termsAccepted && ageConfirmed),
    terms_accepted_at: termsAccepted ? terms!.created_at : null,
    age_confirmed: ageConfirmed,
    choices: config.optionalPurposes.map((purpose) => ({ purpose, granted: latest.get(purpose)?.granted ?? null })),
  };
}

export interface ParsedConsentInput {
  version: string;
  acceptTerms: boolean;
  ageAttested: boolean;
  choices: Record<string, boolean>;
  source: ClientSource | "api";
}

export type Parsed<T> = ({ ok: true } & T) | { ok: false; error: string };

// Le corps de POST /me/consents. Tout vient du client : on valide tout, et une valeur
// inattendue refuse la requête entière plutôt que d'en enregistrer la moitié.
export function parseConsentInput(body: unknown, config: PrivacyConfig): Parsed<{ input: ParsedConsentInput }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Invalid body" };
  const { policy_version, accept_terms, age_attested, choices, source } = body as Record<string, unknown>;

  if (typeof policy_version !== "string" || !VERSION_PATTERN.test(policy_version)) {
    return { ok: false, error: "policy_version is missing or invalid" };
  }
  // On ne retire ni les conditions ni l'âge par cette route : seule la suppression du compte
  // met fin à l'acceptation. Seul « true » est donc admis.
  if (accept_terms !== undefined && accept_terms !== true) return { ok: false, error: "accept_terms can only be true" };
  if (age_attested !== undefined && age_attested !== true) return { ok: false, error: "age_attested can only be true" };

  const parsedChoices: Record<string, boolean> = {};
  if (choices !== undefined) {
    if (typeof choices !== "object" || choices === null || Array.isArray(choices)) {
      return { ok: false, error: "choices must be an object" };
    }
    for (const [purpose, value] of Object.entries(choices)) {
      if (!config.optionalPurposes.includes(purpose)) return { ok: false, error: "choices contains an unknown or disabled purpose" };
      if (typeof value !== "boolean") return { ok: false, error: "each choice must be true or false" };
      parsedChoices[purpose] = value;
    }
  }

  const acceptTerms = accept_terms === true;
  const ageAttested = age_attested === true;
  if (!acceptTerms && !ageAttested && Object.keys(parsedChoices).length === 0) {
    return { ok: false, error: "Nothing to record" };
  }

  const chosenSource = CLIENT_SOURCES.find((candidate) => candidate === source) ?? "api";
  return { ok: true, input: { version: policy_version, acceptTerms, ageAttested, choices: parsedChoices, source: chosenSource } };
}

export interface ConsentRowToInsert {
  purpose: string;
  granted: boolean;
  policy_version: string;
  source: string;
}

// Les lignes à ajouter pour que l'état du compte reflète la demande, et SEULEMENT celles-là :
// renvoyer deux fois la même demande n'ajoute rien (le bouton « Accept » cliqué deux fois,
// ou le même écran sur deux appareils, ne pollue pas l'historique).
export function rowsToInsert(
  existing: readonly ConsentRecord[],
  input: ParsedConsentInput,
  config: PrivacyConfig
): Parsed<{ rows: ConsentRowToInsert[] }> {
  const latest = latestByPurpose(existing);
  const rows: ConsentRowToInsert[] = [];
  const add = (purpose: string, granted: boolean) =>
    rows.push({ purpose, granted, policy_version: input.version, source: input.source });

  const agePurposeKey = agePurpose(config.minAge);
  const ageAlreadyConfirmed = Boolean(latest.get(agePurposeKey)?.granted);

  // Accepter les conditions suppose l'âge : confirmé dans cette demande ou avant.
  if (input.acceptTerms && !input.ageAttested && !ageAlreadyConfirmed) {
    return { ok: false, error: `Confirming that you are at least ${config.minAge} is required` };
  }

  if (input.ageAttested && !ageAlreadyConfirmed) add(agePurposeKey, true);

  if (input.acceptTerms) {
    const terms = latest.get(TERMS_PURPOSE);
    if (!terms?.granted || terms.policy_version !== input.version) add(TERMS_PURPOSE, true);
  }

  for (const [purpose, granted] of Object.entries(input.choices)) {
    // Un choix ne se réenregistre que s'il change : sa version de texte n'a pas d'importance.
    if (latest.get(purpose)?.granted !== granted) add(purpose, granted);
  }

  return { ok: true, rows };
}
