import { join } from 'node:path';

export function edgeProfile(): string {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('WindowsEdgeRequired');
  return join(process.env.LOCALAPPDATA, 'IdlePage/qidian-probe/manual-edge-profile');
}
