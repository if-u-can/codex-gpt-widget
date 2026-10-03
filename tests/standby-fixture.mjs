// An external isolated harness drives host lifecycle and stop through real IPC.
// Keep this process alive without discovering or launching the user's Codex.
import fs from 'node:fs';
import path from 'node:path';
export async function verifyDesktop({ app, getWindow, dataDir }) {
  const request = path.join(dataDir, 'standby-force-destroy.request');
  const timer = setInterval(() => {
    if (!fs.existsSync(request)) return;
    fs.unlinkSync(request);
    const window = getWindow();
    if (window && !window.isDestroyed()) window.destroy();
  }, 100);
  app.once('will-quit', () => clearInterval(timer));
}
