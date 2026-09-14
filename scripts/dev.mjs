import { spawn } from 'node:child_process';
const children = [
  spawn(
    process.execPath,
    ['--experimental-sqlite', '--env-file-if-exists=.env', 'server/index.mjs'],
    { stdio: 'inherit' },
  ),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
    stdio: 'inherit',
  }),
];
function stop() {
  children.forEach((c) => c.kill('SIGTERM'));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((c) =>
  c.on('exit', (code) => {
    stop();
    process.exitCode = code || 0;
  }),
);
