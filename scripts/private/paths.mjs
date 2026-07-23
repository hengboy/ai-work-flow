import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

export function globalPaths() {
  const home = homedir();
  const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : resolve(home, '.config');
  const dir = resolve(configHome, 'ai-work-flow');
  return {
    dir,
    config: resolve(dir, 'config.json'),
    routing: resolve(dir, 'routing.md'),
    environments: resolve(dir, 'environments'),
    environmentMarker: resolve(dir, '.environment'),
    codexDir: resolve(home, '.codex'),
    claudeDir: resolve(home, '.claude'),
    openCodeDir: resolve(configHome, 'opencode')
  };
}
