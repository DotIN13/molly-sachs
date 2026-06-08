const { spawn } = require('child_process');
const path = require('path');

const backendDir = path.join(__dirname, '..', '..', 'backend');
const pythonBin = process.platform === 'win32'
    ? path.join(backendDir, 'venv', 'Scripts', 'python.exe')
    : path.join(backendDir, 'venv', 'bin', 'python');

const proc = spawn(pythonBin, [
    '-m', 'uvicorn', 'main:app',
    '--host', '0.0.0.0',
    '--port', '8000',
    '--reload',
], {
    cwd: backendDir,
    stdio: 'inherit',
});

proc.on('close', (code) => {
    process.exit(code || 0);
});
