import { build } from 'esbuild';
await build({ entryPoints: ['src/extension/extension.ts'], outfile: 'out/extension.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true });
await build({ entryPoints: ['tests/extension/suite.ts'], outfile: 'out/tests/suite.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });

await build({ entryPoints: ['tests/extension/live.ts'], outfile: 'out/tests/live.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
