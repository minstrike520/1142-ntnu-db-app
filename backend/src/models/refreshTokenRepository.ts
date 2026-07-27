import { SQL } from "bun";
import defaultSql from "./db";
import type { IRefreshTokenRepository, RefreshToken } from './IRefreshTokenRepository';

export interface RefreshTokenRow {
  token_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  revoked_at?: Date | null;
  replaced_by?: string | null;
}

export class RefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private sql: SQL = defaultSql) {}

  private mapRow(row: RefreshTokenRow): RefreshToken {
    return {
      tokenId: row.token_id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at ?? null,
      replacedBy: row.replaced_by ?? null,
    };
  }

  async create(data: { userId: string; tokenHash: string; expiresAt: Date }): Promise<RefreshToken> {
    const rows = await this.sql<RefreshTokenRow[]>`
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
      VALUES (${data.userId}, ${data.tokenHash}, ${data.expiresAt})
      RETURNING *
    `;
    return this.mapRow(rows[0]);
  }

  async findByHash(tokenHash: string): Promise<RefreshToken | null> {
    const rows = await this.sql<RefreshTokenRow[]>`
      SELECT * FROM refresh_tokens WHERE token_hash = ${tokenHash}
    `;
    if (rows.length === 0) return null;
    return this.mapRow(rows[0]);
  }

  async revoke(tokenId: string, replacedByTokenId?: string): Promise<void> {
    await this.sql`
      UPDATE refresh_tokens
      SET revoked_at = NOW(), replaced_by = COALESCE(${replacedByTokenId || null}, replaced_by)
      WHERE token_id = ${tokenId}
    `;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.sql`
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `;
  }

  async rotate(
    oldTokenId: string,
    data: { userId: string; tokenHash: string; expiresAt: Date },
  ): Promise<RefreshToken> {
    let newToken: RefreshToken | null = null;
    await this.sql.begin(async (tx) => {
      const inserted = await tx<RefreshTokenRow[]>`
        INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
        VALUES (${data.userId}, ${data.tokenHash}, ${data.expiresAt})
        RETURNING *
      `;
      newToken = this.mapRow(inserted[0]);
      await tx`
        UPDATE refresh_tokens
        SET revoked_at = NOW(), replaced_by = ${newToken.tokenId}
        WHERE token_id = ${oldTokenId}
      `;
    });
    return newToken!;
  }
}
