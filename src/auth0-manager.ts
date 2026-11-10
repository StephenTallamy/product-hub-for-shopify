/**
 * Auth0 Management API client
 * Handles automatic user creation and password reset triggers
 */

import type { Env } from './types';

export class Auth0Manager {
  private domain: string;
  private clientId: string;
  private clientSecret: string;
  private managementToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(domain: string, clientId: string, clientSecret: string) {
    this.domain = domain;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /**
   * Get Management API access token (cached)
   */
  async getManagementToken(): Promise<string> {
    if (this.managementToken && Date.now() < this.tokenExpiry) {
      return this.managementToken;
    }

    const response = await fetch(`https://${this.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: `https://${this.domain}/api/v2/`,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get management token: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    const token = data.access_token;
    if (!token) {
      throw new Error('No access token received from Auth0');
    }
    
    this.managementToken = token;
    // Set expiry with 5-minute buffer
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;

    return token;
  }

  /**
   * Check if user exists by email
   */
  async getUserByEmail(email: string): Promise<any | null> {
    const token = await this.getManagementToken();
    
    const response = await fetch(
      `https://${this.domain}/api/v2/users-by-email?email=${encodeURIComponent(email)}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to lookup user: ${response.status} ${error}`);
    }

    const users: any[] = await response.json();
    return users.length > 0 ? users[0] : null;
  }

  /**
   * Create Auth0 user with temporary password
   * User will receive password reset email to set their own password
   */
  async createUser(email: string, name: string): Promise<any> {
    const token = await this.getManagementToken();

    // Generate strong temporary password that meets Auth0 requirements
    // (lowercase, uppercase, numbers, special chars, 16+ chars)
    const randomBytes = crypto.getRandomValues(new Uint8Array(16));
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const special = '!@#$%^&*';
    
    const tempPassword = [
      lowercase[randomBytes[0] % lowercase.length],
      uppercase[randomBytes[1] % uppercase.length],
      numbers[randomBytes[2] % numbers.length],
      special[randomBytes[3] % special.length],
      ...Array.from(randomBytes.slice(4)).map(b => {
        const allChars = lowercase + uppercase + numbers + special;
        return allChars[b % allChars.length];
      })
    ].join('');

    const response = await fetch(`https://${this.domain}/api/v2/users`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        name: name,
        password: tempPassword,
        connection: 'Username-Password-Authentication',
        email_verified: false,
        verify_email: false, // We'll send password setup email instead
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create user: ${response.status} ${error}`);
    }

    return await response.json();
  }

  /**
   * Send password setup email to new user
   * Uses Auth0's public password reset endpoint
   */
  async sendPasswordSetupEmail(email: string): Promise<void> {
    const response = await fetch(`https://${this.domain}/dbconnections/change_password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        email: email,
        connection: 'Username-Password-Authentication',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send password setup email: ${response.status} ${error}`);
    }

    // Auth0 returns a success message
    const result = await response.text();
    console.log(`Password setup email sent to ${email}: ${result}`);
  }
}

/**
 * Create Auth0Manager from environment
 */
export function createAuth0Manager(env: Env): Auth0Manager | null {
  if (!env.AUTH0_DOMAIN || !env.AUTH0_MGMT_CLIENT_ID || !env.AUTH0_MGMT_CLIENT_SECRET) {
    console.warn('Auth0 Management API credentials not configured');
    return null;
  }

  return new Auth0Manager(
    env.AUTH0_DOMAIN,
    env.AUTH0_MGMT_CLIENT_ID,
    env.AUTH0_MGMT_CLIENT_SECRET
  );
}
