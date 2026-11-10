/**
 * API Client for interacting with the License Management API
 */

import type {
  Env,
  CreateLicenseRequest,
  CreateLicenseResponse,
  ApiError,
  BulkDisableLicensesRequest,
  BulkDisableLicensesResponse,
  LicenseDisabledReason,
} from './types';

/**
 * API Client class for license operations
 */
export class LicenseApiClient {
  private baseUrl: string;
  private keyId: string;
  private privateKey: string;

  constructor(baseUrl: string, keyId: string, privateKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.keyId = keyId;
    this.privateKey = privateKey;
  }

  /**
   * Create authorization header by signing the request
   */
  private async createAuthHeader(
    method: string,
    urlPath: string,
    body: any
  ): Promise<string> {
    const timestamp = Date.now();
    const bodyString = body ? JSON.stringify(body) : '{}';
    const message = `${method}:${urlPath}:${bodyString}:${timestamp}`;

    // Import the key for signing
    const key = await crypto.subtle.importKey(
      'pkcs8',
      this.pemToArrayBuffer(this.privateKey),
      { name: 'Ed25519' },
      false,
      ['sign']
    );

    // Sign the message
    const messageBuffer = new TextEncoder().encode(message);
    const signatureBuffer = await crypto.subtle.sign(
      { name: 'Ed25519' },
      key,
      messageBuffer
    );

    // Convert signature to base64
    const signature = this.arrayBufferToBase64(signatureBuffer);

    return `M2M ${this.keyId}:${timestamp}:${signature}`;
  }

  /**
   * Convert PEM format to ArrayBuffer
   */
  private pemToArrayBuffer(pem: string): ArrayBuffer {
    const b64 = pem
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\s/g, '');
    const binaryString = atob(b64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Convert ArrayBuffer to base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Create and assign a license to a user
   * @param userId - The user ID
   * @param licenseData - License creation parameters
   * @returns The created license response
   */
  async createLicense(
    userId: string,
    licenseData: CreateLicenseRequest
  ): Promise<CreateLicenseResponse> {
    const urlPath = `/api/v1/users/${userId}/licenses`;
    const url = `${this.baseUrl}${urlPath}`;
    const authHeader = await this.createAuthHeader('POST', urlPath, licenseData);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(licenseData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData: ApiError;
      
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = {
          statusCode: response.status,
          message: errorText || response.statusText,
        };
      }

      throw new Error(
        `Failed to create license: ${errorData.message || response.statusText} (Status: ${response.status})`
      );
    }

    // API returns 201 on success
    if (response.status === 201) {
      // Some APIs return empty body on 201, handle both cases
      const text = await response.text();
      if (text) {
        try {
          return JSON.parse(text);
        } catch {
          // If parsing fails, return a basic success response
          return {
            id: 'created',
            product_id: licenseData.product_id,
            license_type: licenseData.license_type,
          };
        }
      }
      // Return basic success response for empty body
      return {
        id: 'created',
        product_id: licenseData.product_id,
        license_type: licenseData.license_type,
      };
    }

    return await response.json();
  }

  /**
   * Get user by email (if such endpoint exists)
   * Note: This may need to be implemented or adapted based on your API
   * @param email - User email
   * @returns User ID or null if not found
   */
  async getUserByEmail(email: string): Promise<string | null> {
    try {
      // Per API docs: GET /api/v1/users?email={email}
      const urlPath = `/api/v1/users?email=${encodeURIComponent(email)}`;
      const url = `${this.baseUrl}${urlPath}`;
      const authHeader = await this.createAuthHeader('GET', urlPath, null);
      
      console.log(`getUserByEmail: Looking up user for email ${email}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const text = await response.text();
        
        if (!text) {
          console.log(`getUserByEmail: Empty response for ${email}`);
          return null;
        }
        
        console.log(`getUserByEmail: Raw API response for ${email}:`, text.substring(0, 500));
        
        const parsed = JSON.parse(text) as { data?: Array<{ id?: string; email?: string }> } | { id?: string } | Array<{ id?: string }>;
        
        // Check for {data: [...]} wrapper structure
        if (parsed && typeof parsed === 'object' && 'data' in parsed && Array.isArray(parsed.data)) {
          console.log(`getUserByEmail: Response has ${parsed.data.length} users`);
          if (parsed.data.length > 0 && parsed.data[0].id) {
            console.log(`getUserByEmail: Found user ${parsed.data[0].id} for ${email}`);
            return parsed.data[0].id;
          } else {
            console.log(`getUserByEmail: User not found (empty data array) for ${email}`);
          }
        }
        // Check for direct {id: ...} structure
        else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'id' in parsed && parsed.id) {
          console.log(`getUserByEmail: Found user ${parsed.id} for ${email}`);
          return parsed.id;
        }
        // Check for direct array structure
        else if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].id) {
          console.log(`getUserByEmail: Found user ${parsed[0].id} for ${email}`);
          return parsed[0].id;
        } else {
          console.log(`getUserByEmail: Unexpected response structure for ${email}:`, JSON.stringify(parsed).substring(0, 200));
        }
      } else {
        const errorText = await response.text();
        console.error(`getUserByEmail: API returned ${response.status} for ${email}:`, errorText);
      }

      return null;
    } catch (error) {
      console.error(`getUserByEmail: Exception for ${email}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * Create a new user (if such endpoint exists)
   * Note: This may need to be implemented based on your API
   * @param email - User email
   * @param firstName - User's first name
   * @param lastName - User's last name
   * @returns Created user ID or null if failed
   */
  async createUser(
    email: string,
    firstName?: string,
    lastName?: string
  ): Promise<string | null> {
    try {
      // Example implementation (adapt to your API):
      const urlPath = `/api/v1/users`;
      const url = `${this.baseUrl}${urlPath}`;
      const requestBody = {
        email,
        first_name: firstName,
        last_name: lastName,
      };
      const authHeader = await this.createAuthHeader('POST', urlPath, requestBody);
      
      console.log(`createUser: Creating user for ${email}`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const data = await response.json() as { id?: string };
        if (data && data.id) {
          console.log(`createUser: Successfully created user ${data.id} for ${email}`);
          return data.id;
        } else {
          console.error(`createUser: Response OK but no id in data for ${email}:`, JSON.stringify(data));
        }
      } else if (response.status === 409) {
        const errorText = await response.text();
        console.log(`createUser: User already exists (409) for ${email}, response:`, errorText.substring(0, 300));
        
        // Try to parse the error response - it might contain the user ID
        try {
          const errorData = JSON.parse(errorText);
          if (errorData && errorData.id) {
            console.log(`createUser: Found user ID ${errorData.id} in 409 response`);
            return errorData.id;
          }
        } catch (e) {
          // Ignore parse errors
        }
        
        // User already exists, try to get them again
        await new Promise(resolve => setTimeout(resolve, 100));
        return await this.getUserByEmail(email);
      } else {
        const errorText = await response.text();
        console.error(`createUser: API returned ${response.status} for ${email}:`, errorText);
      }

      return null;
    } catch (error) {
      console.error(`createUser: Exception for ${email}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * Get or create a user by email
   * @param email - User email
   * @param firstName - User's first name (for creation)
   * @param lastName - User's last name (for creation)
   * @returns User ID or null if failed
   */
  async getOrCreateUser(
    email: string,
    firstName?: string,
    lastName?: string
  ): Promise<string | null> {
    // Try to get existing user
    let userId = await this.getUserByEmail(email);
    
    if (userId) {
      return userId;
    }

    // If user doesn't exist, try to create
    console.log(`User with email ${email} not found, attempting to create...`);
    userId = await this.createUser(email, firstName, lastName);
    
    if (userId) {
      console.log(`Successfully created user with ID: ${userId}`);
      return userId;
    }

    console.error(`Failed to get or create user for email: ${email}`);
    return null;
  }

  /**
   * Look up a product by SKU
   * @param sku - The product SKU
   * @returns Product ID or null if not found
   */
  async getProductBySku(sku: string): Promise<string | null> {
    try {
      // Filter by identifier - API searches series, name, or identifier fields
      const urlPath = `/api/v1/products?filter=${encodeURIComponent(sku)}`;
      const url = `${this.baseUrl}${urlPath}`;
      const authHeader = await this.createAuthHeader('GET', urlPath, null);
      
      console.log(`Looking up product by SKU: ${sku}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const text = await response.text();
        
        if (!text) {
          console.log(`No product found for SKU: ${sku}`);
          return null;
        }
        
        const parsed = JSON.parse(text);
        
        // Check for {data: [...]} wrapper structure (like users endpoint)
        if (parsed && typeof parsed === 'object' && 'data' in parsed && Array.isArray(parsed.data)) {
          if (parsed.data.length > 0 && parsed.data[0].id) {
            const productId = parsed.data[0].id;
            console.log(`Found product ID ${productId} for SKU ${sku}`);
            return productId;
          }
        }
        // Check for direct array structure
        else if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].id) {
          const productId = parsed[0].id;
          console.log(`Found product ID ${productId} for SKU ${sku}`);
          return productId;
        }
        
        console.log(`No product found for SKU: ${sku}`);
      } else {
        console.log(`Product lookup failed with status ${response.status} for SKU: ${sku}`);
      }

      return null;
    } catch (error) {
      console.error(`Error looking up product by SKU ${sku}:`, error);
      return null;
    }
  }

  /**
   * Disable multiple licenses in bulk
   * @param licenseIds - Array of license IDs to disable
   * @param reason - Reason for disabling the licenses
   * @returns Response with count of updated licenses
   */
  async disableLicenses(
    licenseIds: string[],
    reason: LicenseDisabledReason = 'CancelledOrder'
  ): Promise<BulkDisableLicensesResponse> {
    try {
      const urlPath = `/api/v1/licenses/bulk-update`;
      const url = `${this.baseUrl}${urlPath}`;
      const requestBody: BulkDisableLicensesRequest = {
        license_ids: licenseIds,
        disabled: true,
        disabled_reason: reason,
      };
      const authHeader = await this.createAuthHeader('PATCH', urlPath, requestBody);
      
      console.log(`Disabling ${licenseIds.length} license(s) with reason: ${reason}`);
      
      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const data = await response.json() as BulkDisableLicensesResponse;
        console.log(`Successfully disabled ${data.updated_count} license(s)`);
        if (data.failed_license_ids.length > 0) {
          console.warn(`Failed to disable ${data.failed_license_ids.length} license(s):`, data.errors);
        }
        return data;
      } else {
        const errorText = await response.text();
        console.error(`Failed to disable licenses (${response.status}):`, errorText);
        throw new Error(`Failed to disable licenses: ${errorText}`);
      }
    } catch (error) {
      console.error(`Exception while disabling licenses:`, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

/**
 * Factory function to create API client from environment
 * @param env - Environment variables
 * @returns LicenseApiClient instance
 */
export function createApiClient(env: Env): LicenseApiClient {
  return new LicenseApiClient(env.API_BASE_URL, env.API_KEY_ID, env.API_PRIVATE_KEY);
}
