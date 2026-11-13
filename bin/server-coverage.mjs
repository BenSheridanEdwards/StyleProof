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
