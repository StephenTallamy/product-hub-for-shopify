import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const templatePath = new URL('../wrangler.toml.template', import.meta.url);
const configPath = new URL('../wrangler.toml', import.meta.url);
const require = createRequire(import.meta.url);
const execute = promisify(execFile);

async function getWranglerExecutable() {
  const packagePath = require.resolve('wrangler/package.json');
  const wranglerPackage = JSON.parse(await readFile(packagePath, 'utf8'));
  return resolve(dirname(packagePath), wranglerPackage.bin.wrangler);
}

async function selectAccount(executable) {
  let output;
  try {
    output = await execute(process.execPath, [executable, 'whoami', '--json']);
  } catch (error) {
    throw new Error(`Could not list Cloudflare accounts. Run npx wrangler login and check your account access.\n${error.stderr || error.message}`);
  }

  const { accounts } = JSON.parse(output.stdout);
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('No accessible Cloudflare accounts were found. Check your login and account permissions.');
  }

  let account;
  if (accounts.length === 1) {
    account = accounts[0];
  } else {
    if (!process.stdin.isTTY) {
      throw new Error('Multiple Cloudflare accounts are available. Run setup interactively to select one.');
    }
    console.log('Select the Cloudflare account where the worker will be deployed:');
    accounts.forEach((candidate, index) => console.log(`${index + 1}. ${candidate.name} (${candidate.id})`));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let selection;
    try {
      selection = (await prompt.question('Account number: ')).trim();
    } finally {
      prompt.close();
    }
    if (!/^[1-9]\d*$/.test(selection) || Number(selection) > accounts.length) {
      throw new Error('Invalid Cloudflare account selection. Run setup again.');
    }
    account = accounts[Number(selection) - 1];
  }

  if (typeof account.id !== 'string' || !/^[a-f0-9]{32}$/i.test(account.id)) {
    throw new Error('Cloudflare returned an invalid account ID.');
  }
  console.log(`Using Cloudflare account: ${account.name} (${account.id})`);
  return account.id;
}

async function findNamespaceId(executable, accountId, requestedId) {
  const directory = await mkdtemp(resolve(tmpdir(), 'product-hub-wrangler-'));
  const accountConfig = resolve(directory, 'wrangler.toml');
  try {
    await writeFile(accountConfig, `account_id = "${accountId}"\n`, { flag: 'wx' });
    const options = { cwd: fileURLToPath(new URL('../', import.meta.url)) };
    const listNamespaces = async () => {
      const output = await execute(process.execPath, [
        executable, 'kv', 'namespace', 'list', '--config', accountConfig,
      ], options);
      return JSON.parse(output.stdout);
    };

    let namespaces = await listNamespaces();
    if (requestedId) {
      if (!/^[a-f0-9]{32}$/i.test(requestedId)) {
        throw new Error('The namespace ID must contain 32 hexadecimal characters.');
      }
      const selected = namespaces.find(namespace => namespace.id === requestedId);
      if (!selected) {
        throw new Error('The supplied namespace ID was not found in the selected Cloudflare account.');
      }
      console.log(`Using existing namespace ${selected.title}`);
      return requestedId;
    }

    let matches = namespaces.filter(namespace => namespace.title === 'TOKEN_CACHE');
    let created = false;
    if (matches.length === 0) {
      console.log('Creating TOKEN_CACHE in the selected Cloudflare account...');
      await execute(process.execPath, [
        executable, 'kv', 'namespace', 'create', 'TOKEN_CACHE', '--config', accountConfig,
      ], options);
      console.log('Created namespace TOKEN_CACHE');
      created = true;
      namespaces = await listNamespaces();
      matches = namespaces.filter(namespace => namespace.title === 'TOKEN_CACHE');
      if (matches.length === 0) {
        throw new Error('TOKEN_CACHE was created but could not be found. Run setup again.');
      }
    }
    if (matches.length > 1) {
      throw new Error('Multiple TOKEN_CACHE namespaces were found. Use npm run setup -- YOUR_NAMESPACE_ID to select one.');
    }
    if (!created) console.log('Using existing namespace TOKEN_CACHE');
    return matches[0].id;
  } catch (error) {
    throw new Error(`Could not configure the Cloudflare KV namespace.\n${error.stderr || error.message}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function setup() {
  try {
    await access(configPath);
    console.log('wrangler.toml already exists; your local settings have been preserved. Check that account_id is set to your intended Cloudflare account.');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const executable = await getWranglerExecutable();
  const accountId = await selectAccount(executable);
  const namespaceId = (await findNamespaceId(executable, accountId, process.argv[2]?.trim())).trim();
  if (!/^[a-f0-9]{32}$/i.test(namespaceId)) {
    throw new Error('The namespace ID must contain 32 hexadecimal characters.');
  }

  let hostname = '';
  if (process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      hostname = (await prompt.question('Custom worker hostname (e.g. licenses.example.com; leave blank to skip): ')).trim().toLowerCase();
    } finally {
      prompt.close();
    }
  }
  if (hostname && (hostname.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname))) {
    throw new Error('Enter a valid hostname without a scheme, port, or path, such as licenses.example.com.');
  }

  const template = await readFile(templatePath, 'utf8');
  const binding = `\n[[kv_namespaces]]\nbinding = "TOKEN_CACHE"\nid = "${namespaceId}"\n`;
  const route = hostname ? `\n[[routes]]\npattern = "${hostname}"\ncustom_domain = true\n` : '';
  await writeFile(configPath, `account_id = "${accountId}"\n` + template.trimEnd() + '\n' + binding + route, { flag: 'wx' });
  console.log('Created wrangler.toml (ignored by Git). Edit this file for local deployment settings.');
}

setup().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});