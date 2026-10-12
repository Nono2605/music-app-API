import { RateLimiter } from "./rateLimit";

// Échecs d'authentification par adresse IP : au-delà de la limite, on répond 429 SANS interroger
// Supabase Auth (chaque vérification de jeton est un appel réseau). Seuls les jetons refusés
// comptent ; un jeton absent ou valide ne compte jamais, donc les utilisateurs légitimes qui
// partagent l'adresse du serveur web ne sont pas touchés.
export const AUTH_FAILURE_WINDOW_MS = 10 * 60_000;
export const AUTH_FAILURE_MAX = 100;

export class AuthFailureTracker {
  private readonly limiter: RateLimiter;

  constructor(now?: () => number, max: number = AUTH_FAILURE_MAX, windowMs: number = AUTH_FAILURE_WINDOW_MS) {
    this.limiter = new RateLimiter(windowMs, max, now);
  }

  blocked(ip: string): boolean {
    return this.limiter.isOverLimit(ip);
  }

  record(ip: string): void {
    this.limiter.hit(ip);
  }

  sweep(): number {
    return this.limiter.sweep();
  }
}

export const authFailures = new AuthFailureTracker();
setInterval(() => authFailures.sweep(), 60_000).unref();
