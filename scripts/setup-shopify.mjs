import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';

const root = fileURLToPath(new URL('../', import.meta.url));
const appDirectory = resolve(root, '.shopify-setup');
const appConfigPath = resolve(appDirectory, 'shopify.app.toml');
const require = createRequire(import.meta.url);
const cliPackage = '@shopify/cli@5.0.1';

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function run(command, args, input) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolveCommand();
      else reject(new Error(`${command} failed (${signal || code}). Setup stopped; fix the error and run it again.`));
    });
    if (input !== undefined) {
      child.stdin.on('error', reject);
      child.stdin.end(input);
    }
  });
}

function shopify(args) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(npm, ['exec', '--yes', `--package=${cliPackage}`, '--', 'shopify', ...args, '--path', appDirectory]);
}

async function setupShopify() {
  if (!process.stdin.isTTY) {
    throw new Error('Run npm run setup:shopify in an interactive terminal.');
  }
  if (!await exists(resolve(root, 'wrangler.toml'))) {
    throw new Error('Run npm run setup first to generate your Cloudflare configuration.');
  }

  await mkdir(appDirectory, { recursive: true });
  const packagePath = resolve(appDirectory, 'package.json');
  if (!await exists(packagePath)) {
    await writeFile(packagePath, JSON.stringify({ name: 'product-hub-shopify-setup', private: true }, null, 2) + '\n', { flag: 'wx' });
  }

  if (!await exists(appConfigPath)) {
    console.log('Sign in to Shopify and create or select a dedicated Product Hub app in the organization that owns your store.');
    await shopify(['app', 'config', 'link']);
  }

  const config = parse(await readFile(appConfigPath, 'utf8'));
  if (typeof config.client_id !== 'string' || !config.client_id) {
    throw new Error('Shopify did not return an app client ID. Link the app again before continuing.');
  }
  config.application_url ||= 'https://shopify.dev/apps/default-app-home';
  config.embedded ??= false;
  config.access_scopes ??= {};
  const scopes = (config.access_scopes.scopes || '').split(',').map(scope => scope.trim()).filter(Boolean);
  config.access_scopes.scopes = [...new Set([...scopes, 'read_orders', 'write_orders'])].join(',');
  await writeFile(appConfigPath, stringify(config));

  console.log('Review and confirm the Shopify release. This publishes app configuration, not the Cloudflare worker.');
  await shopify(['app', 'deploy']);
  await shopify(['app', 'info']);

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let storeName;
  try {
    storeName = (await prompt.question('Shopify store subdomain (without .myshopify.com): ')).trim();
  } finally {
    prompt.close();
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(storeName)) {
    throw new Error('Enter the store subdomain only, such as your-store, then run setup again.');
  }

  const wranglerPackagePath = require.resolve('wrangler/package.json');
  const wranglerPackage = JSON.parse(await readFile(wranglerPackagePath, 'utf8'));
  const wrangler = resolve(dirname(wranglerPackagePath), wranglerPackage.bin.wrangler);
  await run(process.execPath, [wrangler, 'secret', 'put', 'SHOPIFY_STORE_NAME'], storeName);
  await run(process.execPath, [wrangler, 'secret', 'put', 'SHOPIFY_CLIENT_ID'], config.client_id);

  console.log('Shopify app configuration saved. Continue with the remaining Shopify setup steps in README.md.');
}

setupShopify().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});