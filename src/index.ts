/**
 * Cloudflare Worker for Shopify to License API Integration
 * 
 * This worker receives webhook notifications from Shopify when an order is created/paid,
 * extracts the product information, and creates licenses via the License Management API.
 */

import type {
  Env,
  ShopifyWebhook,
  ShopifyRefundWebhook,
  LicenseCreationJob,
  WorkerSuccessResponse,
} from './types';

import { createApiClient } from './api-client';
import { ShopifyTokenManager } from './shopify-token-manager';
import {
  validateWebhookSignature,
  isValidWebhookPayload,
  getLicenseType,
  sanitizeEmail,
  jsonResponse,
  errorResponse,
  log,
} from './utils';

/**
 * Main worker fetch handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return errorResponse('Method not allowed. Use POST.', 405);
    }

    // Check if the request is for the webhook endpoint
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/webhook')) {
      return errorResponse('Invalid endpoint. Use /webhook', 404);
    }

    try {
      const isValid = env.SHOPIFY_WEBHOOK_SECRET === 'dev-bypass' 
        ? true 
        : await validateWebhookSignature(request, env.SHOPIFY_WEBHOOK_SECRET);
      
      if (!isValid) {
        log('warn', 'Invalid webhook signature');
        return errorResponse('Invalid webhook signature', 401);
      }

      // Check webhook topic to route to appropriate handler
      const topic = request.headers.get('X-Shopify-Topic');
      
      if (topic === 'refunds/create') {
        // Handle refund webhook
        const refundPayload: ShopifyRefundWebhook = await request.json();
        return await handleRefundWebhook(refundPayload, env);
      }
      
      // Default: Handle order creation/payment webhook
      const payload: ShopifyWebhook = await request.json();
      return await handleOrderWebhook(payload, env);

    } catch (error) {
      log('error', 'Unexpected error processing webhook', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return errorResponse(
        'Internal server error processing webhook',
        500,
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  },
};

/**
 * Handle order creation/payment webhook - create licenses
 * @param payload - Shopify order webhook payload
 * @param env - Environment variables
 * @returns Response indicating success or failure
 */
async function handleOrderWebhook(payload: ShopifyWebhook, env: Env): Promise<Response> {
  try {
    // Parse webhook payload
    log('info', `Received webhook for order ${payload.order_number}`, {
      orderId: payload.id,
      orderNumber: payload.order_number,
      orderName: payload.name,
    });

      // Validate payload structure
      if (!isValidWebhookPayload(payload)) {
        log('error', 'Invalid webhook payload structure', payload);
        return errorResponse('Invalid webhook payload', 400);
      }

      // Extract order data
      const customerEmail = sanitizeEmail(payload.email || payload.customer?.email);

      if (!customerEmail) {
        log('warn', 'Order has no customer email - skipping license creation', { 
          orderId: payload.id,
          orderNumber: payload.order_number,
          email: payload.email,
          customerEmail: payload.customer?.email 
        });
        return jsonResponse({
          success: true,
          message: 'Order received but no customer email found - skipped license creation',
          orderNumber: payload.order_number || payload.name,
        }, 200);
      }

      // Initialize API client
      const apiClient = createApiClient(env);

      // Get or create user
      log('info', `Looking up user ${customerEmail}`);
      const firstName = payload.customer?.first_name || payload.billing_address?.first_name;
      const lastName = payload.customer?.last_name || payload.billing_address?.last_name;
      
      const userId = await apiClient.getOrCreateUser(customerEmail, firstName, lastName);

      if (!userId) {
        log('error', 'Failed to get or create user', { email: customerEmail });
        return errorResponse(
          'Failed to get or create user. Please check API configuration and user endpoints.',
          500,
          { email: customerEmail }
        );
      }

      // Process line items and create license jobs
      const licenseJobs: LicenseCreationJob[] = [];

      for (const lineItem of payload.line_items) {
        let productId = null;

        if (lineItem.sku) {
          productId = await apiClient.getProductBySku(lineItem.sku);
        }

        if (!productId) {
          continue; // Skip this item
        }

        // Get license configuration (can be customized per product)
        const licenseType = getLicenseType(env);
        // Note: Omitting num_activations and expires for infinite activations and no expiry

        // Create a license job for each quantity
        for (let i = 0; i < lineItem.quantity; i++) {
          licenseJobs.push({
            userId,
            productId,
            productName: lineItem.name,
            licenseType,
            quantity: lineItem.quantity,
          });
        }
      }

      if (licenseJobs.length === 0) {
        log('warn', 'No valid products found in order', {
          orderId: payload.id,
          orderNumber: payload.order_number,
          orderName: payload.name,
        });
        return errorResponse(
          'No valid products found in order. Ensure products have valid product IDs in SKU or line item properties.',
          400,
          {
            orderNumber: payload.order_number,
            orderName: payload.name,
            lineItems: payload.line_items.map(item => ({
              name: item.name,
              sku: item.sku,
              productId: item.product_id,
              variantId: item.variant_id,
            })),
          }
        );
      }

      // Create licenses
      log('info', `Creating ${licenseJobs.length} license(s)`, {
        userId,
        orderNumber: payload.order_number,
        orderName: payload.name,
      });

      const results = [];
      const errors = [];

      for (const job of licenseJobs) {
        try {
          const license = await apiClient.createLicense(job.userId, {
            product_id: job.productId,
            license_type: job.licenseType,
            // Omitting num_activations and expires for infinite activations and no expiry
          });

          log('info', 'License created successfully', {
            productId: job.productId,
            productName: job.productName,
            licenseId: license.id,
          });

          results.push({
            productId: job.productId,
            productName: job.productName,
            licenseId: license.id,
            success: true,
          });
        } catch (error) {
          log('error', 'Failed to create license', {
            productId: job.productId,
            productName: job.productName,
            error: error instanceof Error ? error.message : String(error),
          });

          errors.push({
            productId: job.productId,
            productName: job.productName,
            error: error instanceof Error ? error.message : String(error),
            success: false,
          });
        }
      }

      // Prepare response
      const successCount = results.length;
      const errorCount = errors.length;

      if (errorCount > 0 && successCount === 0) {
        // All failed
        log('error', 'All license creations failed', {
          orderNumber: payload.order_number,
          orderName: payload.name,
          errors,
        });

        return errorResponse(
          'Failed to create any licenses',
          500,
          {
            orderNumber: payload.order_number,
            orderName: payload.name,
            errors,
          }
        );
      }

      // If licenses were created successfully and Auth0 account creation is enabled, ensure Auth0 account exists
      const shouldCreateAuth0Account = env.CREATE_AUTH0_ACCOUNT === 'true';
      if (successCount > 0 && shouldCreateAuth0Account) {
        try {
          const { createAuth0Manager } = await import('./auth0-manager');
          const auth0Manager = createAuth0Manager(env);
          
          if (auth0Manager) {
            // Check if user already exists in Auth0
            const existingUser = await auth0Manager.getUserByEmail(customerEmail);
            
            if (!existingUser) {
              log('info', `Creating Auth0 account for ${customerEmail}`);
              
              // Create the customer's name from available data
              const customerName = [firstName, lastName].filter(Boolean).join(' ') || customerEmail.split('@')[0];
              
              // Create Auth0 user
              const newUser = await auth0Manager.createUser(customerEmail, customerName);
              log('info', `Auth0 account created for ${customerEmail}`, {
                auth0UserId: newUser.user_id,
              });
              
              // Send password setup email if enabled (defaults to disabled)
              if (env.SEND_PASSWORD_SETUP_EMAIL !== 'false') {
                await auth0Manager.sendPasswordSetupEmail(customerEmail);
                log('info', `Password setup email sent to ${customerEmail}`);
              } else {
                log('info', `Password setup email disabled (SEND_PASSWORD_SETUP_EMAIL=false)`);
              }
            } else {
              log('info', `Auth0 account already exists for ${customerEmail}`, {
                auth0UserId: existingUser.user_id,
              });
            }
          }
        } catch (error) {
          log('error', 'Failed to create/verify Auth0 account', {
            email: customerEmail,
            error: error instanceof Error ? error.message : String(error),
          });
          // Don't fail the whole request if Auth0 account creation fails
          // Licenses are already created, Auth0 is supplementary
        }
      }
      else if (successCount > 0) {
        log('info', `Auth0 account creation skipped (CREATE_AUTH0_ACCOUNT=${env.CREATE_AUTH0_ACCOUNT ?? 'undefined'})`);
      }

      // If licenses were created successfully, add a note to the Shopify order
      if (successCount > 0 && env.SHOPIFY_STORE_NAME && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET) {
        try {
          const tokenManager = new ShopifyTokenManager(env);
          await addOrderNote(payload.id, results, env, tokenManager);
          log('info', 'Added license note to Shopify order', {
            orderId: payload.id,
            orderNumber: payload.order_number,
          });
        } catch (error) {
          log('error', 'Failed to add note to Shopify order', {
            orderId: payload.id,
            orderNumber: payload.order_number,
            error: error instanceof Error ? error.message : String(error),
          });
          // Don't fail the whole request if note addition fails
        }
      }

      // At least some succeeded
      const response: WorkerSuccessResponse = {
        success: true,
        message: `Successfully created ${successCount} license(s)${errorCount > 0 ? ` (${errorCount} failed)` : ''}`,
        licensesCreated: successCount,
        orderNumber: `${payload.order_number}`,
        details: {
          results,
          ...(errorCount > 0 && { errors }),
        },
      };

      log('info', 'Webhook processed successfully', {
        orderNumber: payload.order_number,
        orderName: payload.name,
        successCount,
        errorCount,
      });

      return jsonResponse(response, 200);
    } catch (error) {
      log('error', 'Unexpected error processing order webhook', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return errorResponse(
        'Internal server error processing order webhook',
        500,
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
}

/**
 * Add a note to a Shopify order documenting the licenses that were created
 * @param orderId - Shopify order ID
 * @param licenses - Array of successfully created licenses
 * @param env - Environment variables
 * @param tokenManager - Shopify token manager for auto-refreshing access tokens
 */
async function addOrderNote(
  orderId: number,
  licenses: Array<{ productId: string; productName: string; licenseId: string; success: boolean }>,
  env: Env,
  tokenManager: ShopifyTokenManager
): Promise<void> {
  const accessToken = await tokenManager.getAccessToken();
  
  // Build the note content
  const licenseCount = licenses.length;
  const itemText = licenseCount === 1 ? 'license has' : 'licenses have';
  
  let noteContent = `${licenseCount} ${itemText} been issued\n\nItems:\n`;
  
  for (const license of licenses) {
    noteContent += `• ${license.productName}\n  License ID: ${license.licenseId}\n`;
  }
  
  noteContent += '\nService: Automatic License Provisioning';
  
  // Store license IDs in note_attributes for later retrieval during refunds
  const licenseIds = licenses.map(l => l.licenseId).join(',');
  
  // Add note to the order
  const noteUrl = `https://${env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2025-04/orders/${orderId}.json`;
  const notePayload = {
    order: {
      id: orderId,
      note_attributes: [
        {
          name: 'Licenses Issued',
          value: new Date().toISOString()
        },
        {
          name: 'License IDs',
          value: licenseIds
        }
      ],
      note: noteContent
    }
  };
  
  const response = await fetch(noteUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify(notePayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to add note to Shopify order (${response.status}): ${errorText}`);
  }
  
  console.log(`Successfully added license note to order ${orderId} with ${licenses.length} license ID(s)`);
}

/**
 * Handle refund webhook - disable licenses associated with the refunded order
 * @param payload - Shopify refund webhook payload
 * @param env - Environment variables
 * @returns Response indicating success or failure
 */
async function handleRefundWebhook(payload: ShopifyRefundWebhook, env: Env): Promise<Response> {
  try {
    log('info', `Received refund webhook for order ${payload.order_id}`, {
      refundId: payload.id,
      orderId: payload.order_id,
      refundedItemCount: payload.refund_line_items.length,
    });

    // Initialize API client and token manager
    const apiClient = createApiClient(env);
    const tokenManager = new ShopifyTokenManager(env);
    const accessToken = await tokenManager.getAccessToken();

    // Fetch the order to get license IDs from note_attributes
    const orderUrl = `https://${env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2025-04/orders/${payload.order_id}.json`;
    const orderResponse = await fetch(orderUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
    });

    if (!orderResponse.ok) {
      const errorText = await orderResponse.text();
      log('error', 'Failed to fetch order for refund', {
        orderId: payload.order_id,
        status: orderResponse.status,
        error: errorText,
      });
      return errorResponse(`Failed to fetch order ${payload.order_id}`, orderResponse.status);
    }

    const orderData = await orderResponse.json() as { order: { note_attributes?: Array<{ name: string; value: string }> } };
    
    // Extract license IDs from note_attributes
    const licenseIdsAttr = orderData.order.note_attributes?.find(attr => attr.name === 'License IDs');
    
    if (!licenseIdsAttr || !licenseIdsAttr.value) {
      log('warn', 'No license IDs found in order note_attributes', {
        orderId: payload.order_id,
        refundId: payload.id,
      });
      return jsonResponse({
        success: true,
        message: 'No licenses to disable - order has no associated licenses',
      }, 200);
    }

    // Parse license IDs (stored as comma-separated string)
    const licenseIds = licenseIdsAttr.value.split(',').map(id => id.trim()).filter(id => id.length > 0);
    
    if (licenseIds.length === 0) {
      log('warn', 'Empty license IDs list', {
        orderId: payload.order_id,
        refundId: payload.id,
      });
      return jsonResponse({
        success: true,
        message: 'No licenses to disable',
      }, 200);
    }

    log('info', `Disabling ${licenseIds.length} license(s) for refunded order`, {
      orderId: payload.order_id,
      refundId: payload.id,
      licenseIds: licenseIds,
    });

    // Disable the licenses
    const disableResult = await apiClient.disableLicenses(licenseIds, 'CancelledOrder');

    log('info', 'Licenses disabled', {
      orderId: payload.order_id,
      refundId: payload.id,
      updatedCount: disableResult.updated_count,
      failedCount: disableResult.failed_license_ids.length,
    });

    // Add a note to the order documenting the license deactivation
    const refundNoteContent = `${disableResult.updated_count} license(s) have been disabled due to refund\n\nDisabled License IDs:\n${licenseIds.map(id => `• ${id}`).join('\n')}\n\nReason: Order Refunded\nRefund ID: ${payload.id}`;
    
    const noteUrl = `https://${env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2025-04/orders/${payload.order_id}.json`;
    const notePayload = {
      order: {
        id: payload.order_id,
        note_attributes: [
          {
            name: 'Licenses Disabled',
            value: new Date().toISOString()
          }
        ],
        note: refundNoteContent
      }
    };
    
    const noteResponse = await fetch(noteUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify(notePayload),
    });

    if (!noteResponse.ok) {
      log('warn', 'Failed to add refund note to order', {
        orderId: payload.order_id,
        status: noteResponse.status,
      });
      // Don't fail the whole request if note addition fails
    } else {
      log('info', 'Added refund note to Shopify order', {
        orderId: payload.order_id,
      });
    }

    return jsonResponse({
      success: true,
      message: `Successfully disabled ${disableResult.updated_count} license(s)`,
      disabledCount: disableResult.updated_count,
      failedCount: disableResult.failed_license_ids.length,
      details: {
        licenseIds: licenseIds,
        failedLicenseIds: disableResult.failed_license_ids,
        errors: disableResult.errors,
      },
    }, 200);

  } catch (error) {
    log('error', 'Unexpected error processing refund webhook', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      refundId: payload.id,
      orderId: payload.order_id,
    });

    return errorResponse(
      'Internal server error processing refund webhook',
      500,
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

