import { access, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

const templatePath = new URL('../wrangler.toml.template', import.meta.url);
const configPath = new URL('../wrangler.toml', import.meta.url);

async function setup() {
  try {
    await access(configPath);
    console.log('wrangler.toml already exists; your local settings have been preserved.');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let namespaceId = process.argv[2];
  if (!namespaceId) {
    if (!process.stdin.isTTY) {
      throw new Error('Run npm run setup interactively, or use npm run setup -- YOUR_NAMESPACE_ID.');
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      namespaceId = await prompt.question('TOKEN_CACHE namespace ID: ');
    } finally {
      prompt.close();
    }
  }

  namespaceId = namespaceId.trim();
  if (!/^[a-f0-9]{32}$/i.test(namespaceId)) {
    throw new Error('The namespace ID must contain 32 hexadecimal characters.');
  }

  const template = await readFile(templatePath, 'utf8');
  const binding = `\n[[kv_namespaces]]\nbinding = "TOKEN_CACHE"\nid = "${namespaceId}"\n`;
  await writeFile(configPath, template + binding, { flag: 'wx' });
  console.log('Created wrangler.toml (ignored by Git). Edit this file for local deployment settings.');
}

setup().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});