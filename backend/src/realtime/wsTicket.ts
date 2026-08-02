import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PROTOCOL_VERSION, REALTIME_SUBPROTOCOL } from '@shared/realtime';

export interface WsTicketIdentity {
  userId: string;
  name: string;
  exp: number;
}

export interface WsTicketClaims {
  aud: 'near-chat-ws';
  userId: string;
  name: string;
  jti: string;
  iat: number;
  exp: number;
  leaseExp: number;
}

export interface IssuedWsTicket {
  ticket: string;
  expiresAt: string;
  leaseExpiresAt: string;
  protocol: typeof REALTIME_SUBPROTOCOL;
  version: typeof PROTOCOL_VERSION;
}

interface WsTicketServiceOptions {
  now?: () => Date;
  ttlSeconds?: number;
  secret?: string;
}

const encode = (value: string): string => Buffer.from(value).toString('base64url');
const decode = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

const ticketSecret = (): string => {
  const secret = process.env.WS_TICKET_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('WS_TICKET_SECRET is not defined in production environment.');
  }
  return 'default-dev-ws-ticket-secret';
};

export class WsTicketService {
  private readonly now: () => Date;
  private readonly ttlSeconds: number;
  private readonly secret: string;
  private readonly consumed = new Map<string, { expiresAt: number; replayContext?: string }>();

  constructor(options: WsTicketServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlSeconds = options.ttlSeconds ?? 45;
    this.secret = options.secret ?? ticketSecret();
  }

  async issue(identity: WsTicketIdentity): Promise<IssuedWsTicket> {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (identity.exp <= nowSeconds) throw new Error('WS_ACCESS_EXPIRED');

    const expiresAtSeconds = Math.min(identity.exp, nowSeconds + this.ttlSeconds);
    const claims: WsTicketClaims = {
      aud: 'near-chat-ws',
      userId: identity.userId,
      name: identity.name,
      jti: randomUUID(),
      iat: nowSeconds,
      exp: expiresAtSeconds,
      leaseExp: identity.exp,
    };
    const payload = encode(JSON.stringify(claims));
    const signature = this.sign(payload);
    return {
      ticket: `${payload}.${signature}`,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      leaseExpiresAt: new Date(identity.exp * 1000).toISOString(),
      protocol: REALTIME_SUBPROTOCOL,
      version: PROTOCOL_VERSION,
    };
  }

  async consume(ticket: string, replayContext?: string): Promise<WsTicketClaims> {
    const [payload, signature, extra] = ticket.split('.');
    if (!payload || !signature || extra !== undefined || !this.signatureMatches(payload, signature)) {
      throw new Error('WS_TICKET_INVALID');
    }

    let claims: WsTicketClaims;
    try {
      claims = JSON.parse(decode(payload)) as WsTicketClaims;
    } catch {
      throw new Error('WS_TICKET_INVALID');
    }

    if (
      claims.aud !== 'near-chat-ws'
      || typeof claims.userId !== 'string'
      || typeof claims.name !== 'string'
      || typeof claims.jti !== 'string'
      || typeof claims.exp !== 'number'
      || typeof claims.leaseExp !== 'number'
    ) {
      throw new Error('WS_TICKET_INVALID');
    }

    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    this.pruneConsumed(nowSeconds);
    if (claims.exp <= nowSeconds || claims.leaseExp <= nowSeconds) {
      throw new Error('WS_TICKET_EXPIRED');
    }
    const previous = this.consumed.get(claims.jti);
    if (previous) {
      if (replayContext && previous.replayContext === replayContext) return claims;
      throw new Error('WS_TICKET_REPLAYED');
    }
    this.consumed.set(claims.jti, {
      expiresAt: claims.exp,
      ...(replayContext ? { replayContext } : {}),
    });
    return claims;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  private signatureMatches(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private pruneConsumed(nowSeconds: number): void {
    for (const [jti, consumed] of this.consumed) {
      if (consumed.expiresAt <= nowSeconds) this.consumed.delete(jti);
    }
  }
}
