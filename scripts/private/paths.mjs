import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

export function globalPaths() {
  const home = homedir();
  const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : resolve(home, '.config');
  const dir = resolve(configHome, 'ai-work-flow');
  const environments = resolve(dir, 'environments');
  return {
    dir,
    routing: resolve(dir, 'routing.md'),
    environments,
    defaultEnvironment: resolve(environments, 'default.json'),
    environmentMarker: resolve(dir, '.environment'),
    codexDir: resolve(home, '.codex'),
    claudeDir: resolve(home, '.claude'),
    openCodeDir: resolve(configHome, 'opencode')
  };
}
