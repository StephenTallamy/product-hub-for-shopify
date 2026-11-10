/**
 * Shopify Token Manager
 * Handles automatic fetching and caching of Shopify access tokens
 */

import type { Env } from './types';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

const KV_KEY = 'shopify_access_token';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

export class ShopifyTokenManager {
  private storeName: string;
  private clientId: string;
  private clientSecret: string;
  private kvNamespace?: KVNamespace;
  private memoryCache?: CachedToken;

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
      const cached = await this.kvNamespace.get(KV_KEY, 'json') as CachedToken | null;
      if (cached && this.isTokenValid(cached)) {
        this.memoryCache = cached;
        return cached.accessToken;
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
      await this.kvNamespace.put(KV_KEY, JSON.stringify(cachedToken), {
        expirationTtl: data.expires_in,
      });
    }

    console.log('Fetched new Shopify access token, expires at:', new Date(expiresAt).toISOString());

    return cachedToken.accessToken;
  }
}
