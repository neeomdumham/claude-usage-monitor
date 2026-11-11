#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnrollResponse } from '@usage-monitor/contracts';
import { loadState, saveState, HOME } from './state.ts';
import { runDaemon } from './daemon.ts';
import { runStatusline } from './statusline.ts';
import { runClaude } from './launcher.ts';

const [cmd, ...args] = process.argv.slice(2);
const settingsPath = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
const bridgeCommand = `"${process.execPath}" "${fileURLToPath(import.meta.url)}" statusline`;

async function enroll(serverUrl: string, code: string) {
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('server must use https outside localhost');
  }
  const res = await fetch(new URL('/api/enroll', url), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  const { installationId, token } = EnrollResponse.parse(await res.json());
  saveState({
    serverUrl: url.origin, installationId, token, otlpPort: 47318, policy: null,
    droppedCount: 0, chainedStatusLine: null, statuslineBridge: false,
  });
  console.log(`enrolled as installation ${installationId}; state in ${HOME}`);
}

// Wraps (never replaces) any existing statusLine; a timestamped backup of settings.json is kept.
function installStatusline() {
  const state = loadState();
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  if (settings.statusLine?.command === bridgeCommand) return console.log('already installed');
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`);
  state.chainedStatusLine = settings.statusLine?.type === 'command' ? settings.statusLine.command : null;
  state.statuslineBridge = true;
  saveState(state);
  settings.statusLine = { ...(settings.statusLine ?? {}), type: 'command', command: bridgeCommand };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('status-line bridge installed', state.chainedStatusLine ? '(chained to previous command)' : '');
}

function uninstallStatusline() {
  const state = loadState();
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (settings.statusLine?.command !== bridgeCommand) return console.log('bridge not installed; nothing changed');
  copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`);
  if (state.chainedStatusLine) settings.statusLine.command = state.chainedStatusLine;
  else delete settings.statusLine;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  state.statuslineBridge = false;
  state.chainedStatusLine = null;
  saveState(state);
  console.log('status-line bridge removed; previous command restored');
}

switch (cmd) {
  case 'enroll': await enroll(args[0], args[1]); break;
  case 'daemon': await runDaemon(); break;
  case 'statusline': runStatusline(); break;
  case 'install-statusline': installStatusline(); break;
  case 'uninstall-statusline': uninstallStatusline(); break;
  case 'claude': runClaude(args); break;
  default:
    console.log('usage: usage-monitor <enroll URL CODE | daemon | claude [args] | install-statusline | uninstall-statusline>');
    process.exit(cmd ? 1 : 0);
}
