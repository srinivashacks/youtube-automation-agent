const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

function runKokoro(text, outputPath, logger) {
  const inputPath = outputPath.replace(/\.[^.]+$/, '.txt');
  const python = process.env.KOKORO_PYTHON || path.join(process.cwd(), 'kokoro-env', 'Scripts', 'python.exe');
  const script = path.join(__dirname, '..', 'scripts', 'kokoro_tts.py');
  const voice = process.env.KOKORO_VOICE || 'am_michael';
  const speed = process.env.KOKORO_SPEED || '1.0';

  return (async () => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(inputPath, text, 'utf8');

    return new Promise((resolve, reject) => {
      const child = spawn(python, [script, '--input', inputPath, '--output', outputPath, '--voice', voice, '--speed', speed], {
        windowsHide: true,
        env: process.env,
      });

      let stderr = '';
      child.stdout.on('data', data => {
        const line = data.toString().trim();
        if (line && logger) logger.info(`Kokoro: ${line}`);
      });
      child.stderr.on('data', data => {
        stderr += data.toString();
      });
      child.on('error', reject);
      child.on('close', async code => {
        await fs.unlink(inputPath).catch(() => {});
        if (code !== 0) {
          reject(new Error(`Kokoro exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        const stats = await fs.stat(outputPath).catch(() => null);
        if (!stats || stats.size === 0) {
          reject(new Error('Kokoro completed but produced no audio file'));
          return;
        }
        resolve(outputPath);
      });
    });
  })();
}

module.exports = { runKokoro };
