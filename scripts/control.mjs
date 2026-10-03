import { ensureService, serviceRequest, stopService, launchDesktop } from '../runtime/process.mjs';
import { DATA_HOME } from '../runtime/paths.mjs';

const command = process.argv[2] || 'open';
try {
  let result;
  if (command === 'open') result = await launchDesktop();
  else if (command === 'desktop') result = await launchDesktop({ mode: 'standalone' });
  else if (command === 'follow') result = await launchDesktop({ mode: 'follow-codex' });
  else if (command === 'reset-position') { await ensureService(); result = await serviceRequest('/api/reset-position', {method:'POST',body:{}}); }
  else if (command === 'balance') result = await serviceRequest('/dsh-whale/balance.json' + (process.argv.includes('--refresh') ? '?refresh=1' : ''));
  else if (command === 'quota') { const data=await serviceRequest('/api/insights'+(process.argv.includes('--refresh')?'?refresh=1':'')); result=data.ok?{ok:true,subscription:data.subscription,tokens:data.tokens,error:data.error}:data; }
  else if (command === 'usage') result = await serviceRequest('/dsh-whale/usage-records.json');
  else if (command === 'status') result = await serviceRequest('/api/status');
  else if (command === 'stop') result = await stopService({ dataDir: DATA_HOME });
  else throw new Error('支持 open、desktop、follow、reset-position、quota、balance、usage、status、stop');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.ok === false) process.exitCode = 1;
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
