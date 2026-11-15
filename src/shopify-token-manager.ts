/**
 * Shopify Token Manager
 * Handles automatic fetching and caching of Shopify access tokens
 */

import type { Env } from './types';
import { log } from './utils';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

interface EncryptedCachedToken {
  version: 1;
  iv: string;
  ciphertext: string;
}

const KV_KEY = 'shopify_access_token';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry
const AES_GCM_IV_LENGTH = 12;

export class ShopifyTokenManager {
  private storeName: string;
  private clientId: string;
  private clientSecret: string;
  private kvNamespace?: KVNamespace;
  private memoryCache?: CachedToken;
  private encryptionKey?: Promise<CryptoKey>;
  private tokenEncryptionKey?: string;

  constructor(env: Env) {
    if (!env.SHOPIFY_STORE_NAME) {
      throw new Error('SHOPIFY_STORE_NAME is required');
    }
    if (!env.SHOPIFY_CLIENT_ID) {
      throw new Error('SHOPIFY_CLIENT_ID is required');
    }
    if (!env.SHOPIFY_CLIENT_SECRET) {
      throw new Error('SHOPIFY_CLIENT_SECRET is required');
    }

    this.storeName = env.SHOPIFY_STORE_NAME;
    this.clientId = env.SHOPIFY_CLIENT_ID;
    this.clientSecret = env.SHOPIFY_CLIENT_SECRET;
    this.kvNamespace = env.TOKEN_CACHE;
    this.tokenEncryptionKey = env.TOKEN_ENCRYPTION_KEY;
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getAccessToken(): Promise<string> {
    // Check memory cache first
    if (this.memoryCache && this.isTokenValid(this.memoryCache)) {
      return this.memoryCache.accessToken;
    }

    // Check KV cache
    if (this.kvNamespace) {
      await this.getEncryptionKey();
      const cached = await this.kvNamespace.get(KV_KEY);
      if (cached) {
        try {
          const decrypted = await this.decryptCachedToken(cached);
          if (this.isTokenValid(decrypted)) {
            this.memoryCache = decrypted;
            return decrypted.accessToken;
          }
        } catch (error) {
          log('warn', 'Discarding an unreadable or legacy Shopify token cache entry', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await this.kvNamespace.delete(KV_KEY);
      }
    }

    // Need to fetch a new token
    return await this.fetchAndCacheToken();
  }

  /**
   * Check if a cached token is still valid
   */
  private isTokenValid(cached: CachedToken): boolean {
    const now = Date.now();
    // Consider token invalid if it expires within REFRESH_BUFFER_MS
    return cached.expiresAt > (now + REFRESH_BUFFER_MS);
  }

  private getEncryptionKey(): Promise<CryptoKey> {
    if (!this.encryptionKey) {
      this.encryptionKey = this.importEncryptionKey();
    }
    return this.encryptionKey;
  }

  private async importEncryptionKey(): Promise<CryptoKey> {
    const encodedKey = this.tokenEncryptionKey;
    if (!encodedKey) {
      throw new Error('TOKEN_ENCRYPTION_KEY is required when TOKEN_CACHE is configured');
    }

    let rawKey: Uint8Array;
    try {
      const binaryKey = atob(encodedKey);
      rawKey = Uint8Array.from(binaryKey, character => character.charCodeAt(0));
    } catch {
      throw new Error('TOKEN_ENCRYPTION_KEY must be base64-encoded 32-byte key material');
    }
    if (rawKey.byteLength !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be base64-encoded 32-byte key material');
    }

    return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  private async encryptCachedToken(token: CachedToken): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
    const plaintext = new TextEncoder().encode(JSON.stringify(token));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.getEncryptionKey(), plaintext);
    const ciphertext = String.fromCharCode(...new Uint8Array(encrypted));
    return JSON.stringify({
      version: 1,
      iv: btoa(String.fromCharCode(...iv)),
      ciphertext: btoa(ciphertext),
    } satisfies EncryptedCachedToken);
  }

  private async decryptCachedToken(value: string): Promise<CachedToken> {
    const encrypted = JSON.parse(value) as Partial<EncryptedCachedToken>;
    if (encrypted.version !== 1 || typeof encrypted.iv !== 'string' || typeof encrypted.ciphertext !== 'string') {
      throw new Error('Unsupported token cache format');
    }

    const ivBytes = Uint8Array.from(atob(encrypted.iv), character => character.charCodeAt(0));
    if (ivBytes.byteLength !== AES_GCM_IV_LENGTH) {
      throw new Error('Invalid token cache IV');
    }
    const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), character => character.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, await this.getEncryptionKey(), ciphertext);
    const token = JSON.parse(new TextDecoder().decode(plaintext)) as CachedToken;
    if (typeof token.accessToken !== 'string' || typeof token.expiresAt !== 'number') {
      throw new Error('Invalid decrypted token cache payload');
    }
    return token;
  }

  /**
   * Fetch a new access token from Shopify and cache it
   */
  private async fetchAndCacheToken(): Promise<string> {
    const url = `https://${this.storeName}.myshopify.com/admin/oauth/access_token`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch Shopify access token (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      access_token: string;
      scope: string;
      expires_in: number;
    };

    // Calculate expiration timestamp
    const expiresAt = Date.now() + (data.expires_in * 1000);

    const cachedToken: CachedToken = {
      accessToken: data.access_token,
      expiresAt,
    };

    // Store in memory cache
    this.memoryCache = cachedToken;

    // Store in KV cache
    if (this.kvNamespace) {
      await this.kvNamespace.put(KV_KEY, await this.encryptCachedToken(cachedToken), {
        expirationTtl: data.expires_in,
      });
    }

    console.log('Fetched new Shopify access token, expires at:', new Date(expiresAt).toISOString());

    return cachedToken.accessToken;
  }
}
