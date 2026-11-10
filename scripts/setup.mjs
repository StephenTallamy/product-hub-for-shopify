import { access, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const templatePath = new URL('../wrangler.toml.template', import.meta.url);
const configPath = new URL('../wrangler.toml', import.meta.url);
const require = createRequire(import.meta.url);
const execute = promisify(execFile);

async function findNamespaceId() {
  const packagePath = require.resolve('wrangler/package.json');
  const wranglerPackage = JSON.parse(await readFile(packagePath, 'utf8'));
  const executable = resolve(dirname(packagePath), wranglerPackage.bin.wrangler);
  let output;
  try {
    output = await execute(process.execPath, [
      executable, 'kv', 'namespace', 'list', '--config', fileURLToPath(templatePath),
    ], { cwd: fileURLToPath(new URL('../', import.meta.url)) });
  } catch (error) {
    throw new Error(`Could not list Cloudflare KV namespaces. Run npx wrangler login and check your account access.\n${error.stderr || error.message}`);
  }

  const namespaces = JSON.parse(output.stdout);
  const matches = namespaces.filter(namespace => namespace.title === 'TOKEN_CACHE');
  if (matches.length === 0) {
    throw new Error('TOKEN_CACHE was not found. Run npx wrangler kv namespace create TOKEN_CACHE, then run setup again.');
  }
  if (matches.length > 1) {
    throw new Error('Multiple TOKEN_CACHE namespaces were found. Use npm run setup -- YOUR_NAMESPACE_ID to select one.');
  }
  return matches[0].id;
}

async function setup() {
  try {
    await access(configPath);
    console.log('wrangler.toml already exists; your local settings have been preserved.');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const namespaceId = (process.argv[2] || await findNamespaceId()).trim();
  if (!/^[a-f0-9]{32}$/i.test(namespaceId)) {
    throw new Error('The namespace ID must contain 32 hexadecimal characters.');
  }

  const template = await readFile(templatePath, 'utf8');
  const binding = `\n[[kv_namespaces]]\nbinding = "TOKEN_CACHE"\nid = "${namespaceId}"\n`;
  await writeFile(configPath, template.trimEnd() + '\n' + binding, { flag: 'wx' });
  console.log('Created wrangler.toml (ignored by Git). Edit this file for local deployment settings.');
}

setup().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});