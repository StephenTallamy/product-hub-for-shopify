/**
 * Utility functions for webhook validation, data processing, and error handling
 */

import type { Env, LicenseType } from './types';

/**
 * Validate the webhook signature from Shopify
 * Shopify uses HMAC-SHA256 with base64 encoding
 * @param request - The incoming request
 * @param secret - The webhook secret
 * @returns Whether the signature is valid
 */
export async function validateWebhookSignature(
  request: Request,
  secret: string
): Promise<boolean> {
  const signature = request.headers.get('X-Shopify-Hmac-Sha256');
  
  if (!signature) {
    console.warn('No webhook signature found in request');
    return false;
  }

  // Clone the request to read the body without consuming it
  const clonedRequest = request.clone();
  const body = await clonedRequest.text();

  try {
    // Create HMAC-SHA256 signature
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(body);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    
    // Convert to base64 (Shopify uses base64, not hex)
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const base64Hash = btoa(String.fromCharCode(...hashArray));

    return signature === base64Hash;
  } catch (error) {
    console.error('Error validating webhook signature:', error);
    return false;
  }
}

/**
 * Get license type from environment or use default
 * @param env - Environment variables
 * @param override - Optional override value
 * @returns Valid license type
 */
export function getLicenseType(env: Env, override?: string): LicenseType {
  const type = override || env.DEFAULT_LICENSE_TYPE || 'Standard';
  const validTypes: LicenseType[] = ['Standard', 'NFR', 'Free', 'Subscription'];
  
  if (validTypes.includes(type as LicenseType)) {
    return type as LicenseType;
  }
  
  console.warn(`Invalid license type "${type}", defaulting to "Standard"`);
  return 'Standard';
}

/**
 * Validate Shopify webhook payload structure
 * @param payload - The webhook payload
 * @returns Whether the payload is valid
 */
export function isValidWebhookPayload(payload: any): boolean {
  return (
    payload &&
    typeof payload === 'object' &&
    payload.id &&
    Array.isArray(payload.line_items) &&
    payload.line_items.length > 0
  );
}

/**
 * Create a JSON response
 * @param data - Response data
 * @param status - HTTP status code
 * @returns Response object
 */
export function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Create an error response
 * @param error - Error message
 * @param status - HTTP status code
 * @param details - Optional error details
 * @returns Response object
 */
export function errorResponse(error: string, status = 500, details?: any): Response {
  return jsonResponse(
    {
      success: false,
      error,
      ...(details && { details }),
    },
    status
  );
}

/**
 * Sanitize email address
 * @param email - Email to sanitize
 * @returns Sanitized email or null if invalid
 */
export function sanitizeEmail(email: string): string | null {
  if (!email || typeof email !== 'string') {
    return null;
  }
  
  const trimmedEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  if (emailRegex.test(trimmedEmail)) {
    return trimmedEmail;
  }
  
  return null;
}

/**
 * Log structured data for debugging
 * @param level - Log level
 * @param message - Log message
 * @param data - Additional data to log
 */
export function log(level: 'info' | 'warn' | 'error', message: string, data?: any): void {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...(data && { data }),
  };
  
  console[level](JSON.stringify(logEntry));
}
