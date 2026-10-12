import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";

// Limitation de débit, en mémoire (une instance de l'API : à remplacer par un stockage partagé,
// Redis par exemple, si l'API passe sur plusieurs instances).
//
// Pourquoi PAR JETON et non par adresse IP : la webapp et le Studio appellent l'API depuis LEUR
// serveur (voir clientInfo.ts), donc l'adresse vue ici est celle du serveur web, partagée par tous
// les utilisateurs. Une limite par IP les bloquerait tous ensemble. Le jeton de session, lui,
// identifie une session (il change à chaque renouvellement, environ une fois par heure).
//
// L'adresse IP ne sert qu'à compter les ÉCHECS d'authentification (authFailures.ts), pour ne pas
// laisser quelqu'un faire appeler Supabase Auth en boucle avec de faux jetons.
//
// Limite connue : les routes publiques sans jeton (catalogue) ne sont pas limitées ici ; la
// webapp devra s'authentifier auprès de l'API (secret partagé) avant qu'on puisse les limiter par IP.

export interface HitResult {
  allowed: boolean;
  resetAt: number;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
    // Garde-fou mémoire : au-delà, on ne mémorise plus de nouvelle clé (on laisse passer plutôt
    // que de bloquer des utilisateurs légitimes).
    private readonly maxKeys: number = 100_000
  ) {}

  hit(key: string): HitResult {
    const now = this.now();
    let bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && this.buckets.size >= this.maxKeys) {
        this.sweep();
        if (this.buckets.size >= this.maxKeys) return { allowed: true, resetAt: now + this.windowMs, retryAfterSeconds: 0 };
      }
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    const allowed = bucket.count <= this.max;
    return {
      allowed,
      resetAt: bucket.resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  // Sans incrémenter : la clé a-t-elle déjà atteint sa limite dans la fenêtre en cours ?
  isOverLimit(key: string): boolean {
    const bucket = this.buckets.get(key);
    return !!bucket && bucket.resetAt > this.now() && bucket.count >= this.max;
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}

// Clé = empreinte du jeton de session (jamais le jeton lui-même en mémoire). Sans jeton : pas de limite ici.
export function tokenKey(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

// Cloudflare est devant l'API et écrase cet en-tête : un client ne peut pas le falsifier en passant
// par lui. Repli : l'adresse de la connexion (développement local).
export function clientIp(req: Request): string {
  const forwarded = req.headers["cf-connecting-ip"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (value && isIP(value.trim())) return value.trim();
  return req.socket.remoteAddress ?? "unknown";
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  key?: (req: Request) => string | null;
  now?: () => number;
}

export function rateLimit({ windowMs, max, key = tokenKey, now }: RateLimitOptions) {
  const limiter = new RateLimiter(windowMs, max, now);
  const timer = setInterval(() => limiter.sweep(), Math.min(windowMs, 60_000));
  timer.unref();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const k = key(req);
    if (k === null) return next();
    const result = limiter.hit(k);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly.", code: "rate_limited" });
    }
    next();
  };
}
