import readline from 'node:readline';
import path from 'node:path';
import { serviceRequest, launchDesktop } from './process.mjs';
import { VERSION } from './paths.mjs';

const toolSpecs = [
  { name: 'gpt_quota', description: '查询 Codex 五小时、每周订阅额度、重置时间及可用重置次数。额度百分比来自本机官方日志快照；重置次数单独读取官方服务，无法读取时明确为未知。', inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: '重新扫描本机日志并刷新官方可用重置次数' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'gpt_usage', description: '查询本机已观测 token 与挂件今日、近七天和历史用量账本。逐模型金额为配置价格估算。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'gpt_balance', description: '查询 API 模式的余额、币种及本机记录的今日已消耗金额。ChatGPT 订阅额度请使用 gpt_quota。', inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: '立即从配置的 API 刷新' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'gpt_status', description: '查询大肥龙挂件的窗口跟随和会话监听状态，不返回密钥。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'gpt_open', description: '显示大肥龙透明桌面挂件。角色、音效、泡泡模板及资源管理在挂件菜单中设置。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
];

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function dispatch(message) {
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'codex-gpt-widget', version: VERSION } };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: toolSpecs };
    else if (method === 'resources/list' || method === 'resources/templates/list') result = method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] };
    else if (method === 'tools/call') {
      const args = params.arguments || {};
      let output;
      if (params.name === 'gpt_quota') {
        const data = await serviceRequest('/api/insights' + (args.refresh ? '?refresh=1' : ''));
        output = data.ok ? { ok: true, subscription: data.subscription, tokens: data.tokens, error: data.error } : data;
      }
      else if (params.name === 'gpt_balance') output = await serviceRequest('/dsh-whale/balance.json' + (args.refresh ? '?refresh=1' : ''));
      else if (params.name === 'gpt_usage') {
        const [ledger, data] = await Promise.all([serviceRequest('/dsh-whale/usage-records.json'), serviceRequest('/api/insights')]);
        output = data.ok ? { ok: true, tokens: data.tokens, ledger } : data;
      }
      else if (params.name === 'gpt_status') output = await serviceRequest('/api/status');
      else if (params.name === 'gpt_open') {
        output = await launchDesktop();
      } else throw new Error('未知工具');
      result = { content: [{ type: 'text', text: JSON.stringify(output) }], isError: output.ok === false };
    } else { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return; }
    send({ jsonrpc: '2.0', id, result });
  } catch { send({ jsonrpc: '2.0', id, error: { code: -32603, message: '挂件操作失败，请确认 Codex 桌面应用和自动跟随组件已运行' } }); }
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (line.length > 1024 * 1024) return;
  try { const message = JSON.parse(line); if (message.jsonrpc === '2.0') dispatch(message); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
});
input.on('close', () => process.exit(0));
