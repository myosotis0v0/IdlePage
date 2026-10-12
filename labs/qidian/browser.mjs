import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function openPublicBrowser() {
  return chromium.launch({ channel: 'msedge', headless: true, chromiumSandbox: true });
}

export async function openManualSession() {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share');
  const profile = join(base, 'IdlePage', 'qidian-probe', 'edge-profile');
  await mkdir(profile, { recursive: true });
  // Dedicated profile: never use or export the user's normal browser profile.
  return chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: false, viewport: null, chromiumSandbox: true,
    acceptDownloads: false,
  });
}
