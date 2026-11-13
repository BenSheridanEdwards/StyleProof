import { loadStyleMap, saveStyleMap } from '../dist/capture.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';

/** Shell scripts and package scripts need inspection before they can prove a Node server. */
export function nodeWebServer(command) {
  if (typeof command !== 'string' || /[;&|<>`$\n]/u.test(command)) return false;
  const words = command.trim().split(/\s+/u);
  const executable = words.shift()?.split('/').at(-1);
  if (['node', 'tsx', 'ts-node'].includes(executable)) return true;
  if (!['npm', 'pnpm', 'npx'].includes(executable)) return false;
  if (words[0] === 'exec') words.shift();
  return ['next', 'vite', 'nuxt', 'astro'].includes(words[0]);
}

/** External servers cannot be instrumented by this capture. */
export function serverCoverageConfig(server, directory, reuseExistingServer) {
  return {
    ...server,
    reuseExistingServer,
    ...(!reuseExistingServer && nodeWebServer(server.command)
      ? { env: { ...server.env, NODE_V8_COVERAGE: directory } }
      : {}),
  };
}

/** Read only local app scripts. Missing or unreadable maps never prove execution. */
export function readServerCoverage(directory, projectRoot) {
  if (!fs.existsSync(directory)) return [];
  const scripts = [];
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    try {
      for (const entry of JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).result) {
        const script = resolveServerScript(entry, projectRoot);
        if (script) scripts.push(script);
      }
    } catch {
      // Incomplete shutdown files are not execution evidence.
    }
  }
  return scripts;
}

function resolveServerScript(entry, projectRoot) {
  if (!entry.url.startsWith('file:')) return;
  const filename = fileURLToPath(entry.url);
  const relative = path.relative(projectRoot, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes('node_modules')) return;
  const generated = fs.readFileSync(filename, 'utf8');
  const reference = [...generated.matchAll(/sourceMappingURL=([^\s]+)/gu)].at(-1)?.[1];
  if (!reference) return;
  const mapUrl = new URL(reference, entry.url);
  const raw =
    mapUrl.protocol === 'data:'
      ? Buffer.from(mapUrl.href.split(',')[1], 'base64').toString('utf8')
      : fs.readFileSync(fileURLToPath(mapUrl), 'utf8');
  const files = mapScriptCoverage(
    entry,
    generated,
    JSON.parse(raw),
    mapUrl.protocol === 'data:' ? entry.url : mapUrl.href,
    { projectRoot },
  );
  return compactScriptEvidence({ url: relative.replaceAll('\\', '/'), status: 'mapped', files });
}

export function persistServerCoverage(targetDir, projectRoot) {
  const coverageDirectory = path.join(targetDir, 'server-v8');
  const serverScripts = readServerCoverage(coverageDirectory, projectRoot);
  if (fs.existsSync(coverageDirectory)) {
    for (const name of fs.readdirSync(coverageDirectory)) {
      if (name.endsWith('.json')) fs.unlinkSync(path.join(coverageDirectory, name));
    }
    fs.rmdirSync(coverageDirectory);
  }
  if (serverScripts.length) {
    for (const name of fs.readdirSync(targetDir).filter((name) => /\.json(?:\.gz)?$/u.test(name))) {
      const filename = path.join(targetDir, name);
      const map = loadStyleMap(filename);
      if (!map.scriptReach) continue;
      map.scriptReach.scripts.push(...serverScripts);
      saveStyleMap(filename, map);
    }
  }
}
