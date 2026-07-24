import { fail } from './shared.mjs';

export const MARKER_START = '<!-- ai-work-flow:agents:begin -->';
export const MARKER_END = '<!-- ai-work-flow:agents:end -->';

function markerBlock() {
  return `${MARKER_START}\n## AI Work Flow 代理\n\n仅当使用 **Coordinator** 代理时，遵循 \`~/.config/ai-work-flow/routing.md\` 进行子代理委派。其他代理模式下保持原生行为，按需调用子代理。\n${MARKER_END}\n`;
}

export function updateManagedMarker(source, path) {
  const starts = (source.match(new RegExp(MARKER_START, 'g')) || []).length;
  const ends = (source.match(new RegExp(MARKER_END, 'g')) || []).length;
  if (starts !== ends || starts > 1) fail(`Cannot safely update workflow marker in ${path}. Repair the marker block manually.`);
  if (starts === 1) {
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return source.replace(new RegExp(`${escape(MARKER_START)}[\\s\\S]*?${escape(MARKER_END)}\\n?`), markerBlock());
  }
  return `${source.replace(/\s*$/, '')}${source.trim() ? '\n\n' : ''}${markerBlock()}`;
}
