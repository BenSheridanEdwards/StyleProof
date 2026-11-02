import { createRequire } from 'node:module';
import path from 'node:path';

export function projectPlaywright(cwd = process.cwd()) {
  try {
    return createRequire(path.join(cwd, 'package.json')).resolve('@playwright/test/cli');
  } catch {
    throw new Error(`could not resolve @playwright/test/cli from ${cwd}; install @playwright/test in this project`);
  }
}
