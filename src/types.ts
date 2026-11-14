/**
 * TypeScript definitions for Shopify webhooks and License API
 */

// Environment variables interface
export interface Env {
  API_BASE_URL?: string;
  API_KEY_ID: string;
  API_PRIVATE_KEY: string;
  SHOPIFY_WEBHOOK_SECRET: string;
  SHOPIFY_STORE_NAME?: string; // e.g., "mystore" from mystore.myshopify.com
  SHOPIFY_CLIENT_ID?: string; // Shopify OAuth client ID
  SHOPIFY_CLIENT_SECRET?: string; // Shopify OAuth client secret
  DEFAULT_LICENSE_TYPE?: string;
  SKU_PRODUCT_MAP?: string; // JSON string mapping Shopify SKUs to License API product IDs
  TOKEN_CACHE?: KVNamespace; // KV namespace for caching Shopify access tokens
  
  // Auth0 Management API credentials (for auto-creating user accounts)
  AUTH0_DOMAIN?: string; // e.g., "your-tenant.auth0.com"
  AUTH0_MGMT_CLIENT_ID?: string; // Management API M2M app client ID
  AUTH0_MGMT_CLIENT_SECRET?: string; // Management API M2M app client secret
  CREATE_AUTH0_ACCOUNT?: string; // "true" to create/check Auth0 accounts, "false" to disable (default: false)
  SEND_PASSWORD_SETUP_EMAIL?: string; // "true" to send password setup emails, "false" to disable (default: false)
}

// Shopify webhook payload types (orders/create or orders/paid topic)
export interface ShopifyWebhook {
  id: number;
  admin_graphql_api_id: string;
  app_id?: number;
  browser_ip?: string;
  buyer_accepts_marketing: boolean;
  cancel_reason?: string;
  cancelled_at?: string;
  cart_token?: string;
  checkout_id?: number;
  checkout_token?: string;
  closed_at?: string;
  confirmed: boolean;
  contact_email?: string;
  created_at: string;
  currency: string;
  current_subtotal_price: string;
  current_total_discounts: string;
  current_total_price: string;
  current_total_tax: string;
  customer: ShopifyCustomer;
  customer_locale?: string;
  email: string;
  financial_status: string;
  fulfillment_status?: string;
  line_items: ShopifyLineItem[];
  name: string; // Order name (e.g., "#1001")
  note?: string;
  number: number; // Order number
  order_number: number;
  payment_gateway_names?: string[];
  phone?: string;
  processed_at: string;
  processing_method?: string;
  reference?: string;
  source_name: string;
  subtotal_price: string;
  tags?: string;
  tax_lines: TaxLine[];
  taxes_included: boolean;
  test: boolean;
  token: string;
  total_discounts: string;
  total_line_items_price: string;
  total_price: string;
  total_tax: string;
  total_weight: number;
  updated_at: string;
  billing_address?: ShopifyAddress;
  shipping_address?: ShopifyAddress;
  discount_codes?: DiscountCode[];
  note_attributes?: NoteAttribute[];
  shipping_lines?: ShippingLine[];
}

export interface ShopifyCustomer {
  id: number;
  email: string;
  accepts_marketing: boolean;
  created_at: string;
  updated_at: string;
  first_name: string;
  last_name: string;
  orders_count: number;
  state: string;
  total_spent: string;
  last_order_id?: number;
  note?: string;
  verified_email: boolean;
  phone?: string;
  tags: string;
  default_address?: ShopifyAddress;
}

export interface ShopifyAddress {
  first_name: string;
  last_name: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;
  province_code?: string;
  country: string;
  country_code: string;
  zip: string;
  phone?: string;
  name?: string;
  company?: string;
}

export interface ShopifyLineItem {
  id: number;
  admin_graphql_api_id: string;
  fulfillable_quantity: number;
  fulfillment_service: string;
  fulfillment_status?: string;
  gift_card: boolean;
  grams: number;
  name: string;
  price: string;
  price_set: PriceSet;
  product_exists: boolean;
  product_id: number;
  properties: LineItemProperty[];
  quantity: number;
  requires_shipping: boolean;
  sku: string;
  taxable: boolean;
  title: string;
  total_discount: string;
  variant_id: number;
  variant_inventory_management?: string;
  variant_title?: string;
  vendor?: string;
  tax_lines: TaxLine[];
}

export interface PriceSet {
  shop_money: Money;
  presentment_money: Money;
}

export interface Money {
  amount: string;
  currency_code: string;
}

export interface LineItemProperty {
  name: string;
  value: string;
}

export interface TaxLine {
  price: string;
  rate: number;
  title: string;
  price_set?: PriceSet;
}

export interface DiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface NoteAttribute {
  name: string;
  value: string;
}

export interface ShippingLine {
  id: number;
  title: string;
  price: string;
  code: string;
  source: string;
  price_set: PriceSet;
  tax_lines: TaxLine[];
}

// License API types (based on swagger documentation)
export type LicenseType = 'Standard' | 'NFR' | 'Free' | 'Subscription';

export interface CreateLicenseRequest {
  product_id: string;
  license_type: LicenseType;
  num_activations?: number; // Optional: omit for infinite activations
  expires?: string; // Optional: ISO 8601 date-time format, omit for no expiry
}

export interface CreateLicenseResponse {
  id: string;
  product_id: string;
  license_type: LicenseType;
  num_activations?: number; // Optional: may be undefined for infinite activations
  expires?: string; // Optional: may be undefined for no expiry
  serial?: string;
  created_at?: string;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
}

// Worker response types
export interface WorkerSuccessResponse {
  success: true;
  message: string;
  licensesCreated: number;
  orderNumber: string;
  details?: any;
}

export interface WorkerErrorResponse {
  success: false;
  error: string;
  details?: any;
}

export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

// Product mapping configuration
export interface ProductMapping {
  shopifyProductId: number;
  shopifyVariantId: number;
  apiProductId: string;
  licenseType?: LicenseType;
  numActivations?: number;
  durationDays?: number;
}

// License creation job
export interface LicenseCreationJob {
  userId: string;
  productId: string;
  productName: string;
  licenseType: LicenseType;
  numActivations?: number; // Optional: omit for infinite activations
  expires?: string; // Optional: omit for no expiry
  quantity: number;
}

// Shopify refund webhook types (refunds/create topic)
export interface ShopifyRefundWebhook {
  id: number;
  order_id: number;
  created_at: string;
  note?: string;
  user_id?: number;
  processed_at: string;
  restock: boolean;
  duties?: any[];
  admin_graphql_api_id: string;
  refund_line_items: ShopifyRefundLineItem[];
  transactions: RefundTransaction[];
  order_adjustments: OrderAdjustment[];
}

export interface ShopifyRefundLineItem {
  id: number;
  line_item_id: number;
  quantity: number;
  restock_type: string;
  location_id?: number;
  subtotal: number;
  total_tax: number;
  subtotal_set: PriceSet;
  total_tax_set: PriceSet;
  line_item: ShopifyLineItem;
}

export interface RefundTransaction {
  id: number;
  order_id: number;
  kind: string;
  gateway: string;
  status: string;
  message?: string;
  created_at: string;
  amount: string;
  currency: string;
  parent_id?: number;
}

export interface OrderAdjustment {
  id: number;
  order_id: number;
  refund_id: number;
  amount: string;
  tax_amount: string;
  kind: string;
  reason: string;
  amount_set: PriceSet;
  tax_amount_set: PriceSet;
}

// License disabling types
export type LicenseDisabledReason = 
  | 'DuplicateOrder' 
  | 'CancelledOrder' 
  | 'LicenseTransfer' 
  | 'FraudulentUse' 
  | 'DeletedUser';

export interface BulkDisableLicensesRequest {
  license_ids: string[];
  disabled: boolean;
  disabled_reason?: LicenseDisabledReason;
}

export interface BulkDisableLicensesResponse {
  updated_count: number;
  failed_license_ids: string[];
  errors: string[];
}
