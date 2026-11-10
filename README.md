# Shopify Product Hub Integration

This service integrates Shopify with the Gorilla Engine Product Hub licensing system to enable automatic licensing of products ordered via Shopify.

The service provides the following functions:

1. Receives Shopify order webhooks and issues one Product Hub license per matched item quantity.
2. Finds or creates Product Hub users using the customer's email address.
3. Optionally finds or creates Auth0 users after successful license creation, with optional password setup emails.
4. Records license IDs in Shopify order notes and disables the recorded licenses when a refund webhook arrives.

Licensing works independently of Auth0.

## Requirements

| Requirement | Details |
|---|---|
| Node.js and npm | Node.js 22.12.0 or later, with npm; a current LTS release is recommended |
| Cloudflare | An account with Workers enabled |
| Shopify | A store, webhook signing secret, and app credentials for Admin API order access |
| Gorilla Product Hub | API base URL, key ID, and Ed25519 private key |
| Auth0 | Optional; required only for Auth0 user provisioning |

## Configuration

### 1. Create an API Key in Gorilla Product Hub

1. Log in to [Gorilla Product Hub](https://producthub.ujam.com)
2. Click the **cog icon** near the top right and select **Manufacture API Keys**
3. Click **New API Key** and enter a meaningful description (e.g. *Shopify integration*)
4. Copy the generated **private key**; this is only shown once
5. Save the API key
6. Find the newly created key in the list and copy its **ID**

### 2. Configure the Worker

1. Open a terminal in the repository directory
2. Install dependencies and sign in to Cloudflare:

```sh
npm install
npx wrangler login
```

3. Create a Cloudflare KV namespace to cache Shopify access tokens between webhook requests:

```sh
npx wrangler kv namespace create TOKEN_CACHE
```

4. Run setup and paste the returned namespace ID when prompted:

```sh
npm run setup
```

> NOTE: Setup generates [wrangler.toml](wrangler.toml) from [wrangler.toml.template](wrangler.toml.template). Git ignores the generated file, so your namespace ID and deployment settings stay local. Wrangler uses this file automatically. Running setup again preserves your settings.

5. Configure the Product Hub connection, pasting the private key and key ID when prompted:

```sh
printf '%s' 'https://producthub.ujam.com' | npm run secret -- API_BASE_URL
npm run secret -- API_PRIVATE_KEY
npm run secret -- API_KEY_ID
```

> NOTE: The private key must be in PKCS#8 PEM format. Never commit real credentials.

6. In the generated local configuration, leave `DEFAULT_LICENSE_TYPE = "Standard"`, or choose `NFR`, `Free`, or `Subscription`

> NOTE: Licenses are created with unlimited activations and no expiry.

### 3. Configure the Shopify App

1. Create a Shopify app that supports the **client-credentials token flow**
2. Give the app `read_orders` and `write_orders` access scopes and install it on your store
3. Copy the app's **client ID** and **client secret**
4. Set the store name and app credentials, pasting each value when prompted:

```sh
npm run secret -- SHOPIFY_STORE_NAME
npm run secret -- SHOPIFY_CLIENT_ID
npm run secret -- SHOPIFY_CLIENT_SECRET
```

> NOTE: `SHOPIFY_STORE_NAME` is the store subdomain only, e.g. `your-store` from `your-store.myshopify.com`. These credentials allow the worker to record license IDs on orders and retrieve them for refunds.

### 4. Set Up Auth0 User Accounts (Optional)

For licensing only, leave `CREATE_AUTH0_ACCOUNT = "false"`. Product Hub users are still created; Auth0 is not called.

To also create Auth0 accounts for customers:

1. Create an Auth0 **Machine-to-Machine application**
2. Authorize it for the **Management API** with `read:users` and `create:users`
3. Enable the `Username-Password-Authentication` database connection for the application
4. In the generated local configuration, set `CREATE_AUTH0_ACCOUNT = "true"`
5. Set the Auth0 domain and application credentials:

```sh
npm run secret -- AUTH0_DOMAIN
npm run secret -- AUTH0_MGMT_CLIENT_ID
npm run secret -- AUTH0_MGMT_CLIENT_SECRET
```

6. In the generated local configuration, leave `SEND_PASSWORD_SETUP_EMAIL = "false"`, or set it to `"true"` and configure Auth0 email delivery to send password setup emails to newly created users

> NOTE: Use the Auth0 hostname without `https://`. Password setup emails use the same application client ID. Existing users do not receive another setup email. Keep `SEND_PASSWORD_SETUP_EMAIL` explicit; omitting it enables emails when Auth0 provisioning is enabled.

> NOTE: Auth0 account creation does not configure end-user authentication for Product Hub license activation. Auth0 failures are logged without undoing licenses already created.

### 5. Enable Licensing on Products

For each Shopify product that should issue a Gorilla Engine license on purchase:

1. In Shopify admin, go to **Products** and edit the product
2. Set each variant's **SKU** to match the corresponding Product Hub product's **Identifier**
3. Click **Save**

> NOTE: Create the corresponding product in Gorilla Product Hub first. Products are looked up using the SKU filter and the first returned product is used. Items without a matching product are skipped.

### 6. Deploy the Worker and Configure Shopify Webhooks

1. Build and deploy the worker:

```sh
npm run build
npm run deploy
```

2. Copy the worker URL shown by Wrangler and append `/webhook`
3. In Shopify, configure an **Order payment** (`orders/paid`) webhook to POST JSON to that URL
4. Configure a **Refund create** (`refunds/create`) webhook to POST JSON to the same URL
5. Copy the signing secret Shopify uses for these webhooks and set it on the worker:

```sh
npm run secret -- SHOPIFY_WEBHOOK_SECRET
```

> NOTE: The URL should look like `https://YOUR-WORKER.workers.dev/webhook`. Use the webhook signing secret, which may differ from your Shopify app client secret. Never set it to `dev-bypass`, which disables signature verification.

> NOTE: You can use `orders/create` instead of `orders/paid`, but do not subscribe to both. Duplicate order deliveries can issue duplicate licenses. Do not subscribe unrelated topics.

> NOTE: The worker replaces order notes and note attributes when recording license activity. Keep the **License IDs** attribute intact; refunds use it to disable all licenses recorded for the order, including for partial refunds.