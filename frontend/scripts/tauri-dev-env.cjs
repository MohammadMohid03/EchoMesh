const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const mode = process.argv[2] === 'build' ? 'build' : 'dev';

if (process.platform !== 'win32') {
  const result = spawnSync('npx', ['tauri', mode], { stdio: 'inherit', shell: true });
  process.exit(result.status ?? 1);
}

const candidates = [
  'C:\\Program Files\\Microsoft Visual Studio\\18\\BuildTools\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\Community\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Community\\Common7\\Tools\\VsDevCmd.bat',
];

const vsDevCmd = process.env.VSDEVCMD_PATH || candidates.find(existsSync);

if (!vsDevCmd) {
  console.error('Could not find VsDevCmd.bat. Install Visual Studio C++ Build Tools, then retry.');
  process.exit(1);
}

const tauriBin = join('node_modules', '.bin', 'tauri.cmd');
const tauriCommand = existsSync(tauriBin) ? `"${tauriBin}" ${mode}` : `npx tauri ${mode}`;
const command = `call "${vsDevCmd}" -arch=x64 -host_arch=x64 && ${tauriCommand}`;
const result = spawnSync(command, {
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
