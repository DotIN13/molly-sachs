const { spawn, execSync } = require('child_process');
const path = require('path');

const backendDir = path.join(__dirname, '..', '..', 'backend');
const pythonBin = process.platform === 'win32'
    ? path.join(backendDir, 'venv', 'Scripts', 'python.exe')
    : path.join(backendDir, 'venv', 'bin', 'python');

const proc = spawn(pythonBin, [
    '-m', 'uvicorn', 'main:app',
    '--host', '0.0.0.0',
    '--port', process.env.BACKEND_PORT || '8000',
    '--reload',
], {
    cwd: backendDir,
    stdio: 'inherit',
});

function killChild() {
    if (proc.pid) {
        try {
            if (process.platform === 'win32') {
                execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
            } else {
                proc.kill('SIGTERM');
            }
        } catch (e) {
            // process may already be dead
        }
    }
}

process.on('SIGINT', () => {
    killChild();
    process.exit(0);
});

process.on('SIGTERM', () => {
    killChild();
    process.exit(0);
});

proc.on('close', (code) => {
    process.exit(code || 0);
});
