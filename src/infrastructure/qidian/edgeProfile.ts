import { join } from 'node:path';

export function edgeProfile(): string {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('WindowsEdgeRequired');
  // A clean profile owned by IdlePage only: no Edge account, no sync (see dedicatedEdgeArguments).
  // The earlier qidian-probe/manual-edge-profile was signed in and synced by Edge; it is left untouched.
  return join(process.env.LOCALAPPDATA, 'IdlePage/edge-profile');
}
