// callAI — the single brain entry point. In production it calls the Anthropic
// API with the OWNER's server-side key (one key serves every buyer; buyers set
// up nothing). For local dev with no key, it falls back to the `claude` CLI.
require('./env');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MODEL = () => process.env.TEAMZERO_MODEL || 'claude-sonnet-5';

// `tier` picks the cheapest capable model per task:
//   'research' → Sonnet (web search + reasoning); 'draft' → Haiku (3x cheaper).
async function callAI(prompt, { allowWeb = false, maxTokens = 1500, timeoutMs, tier = 'research' } = {}) {
  if (process.env.ANTHROPIC_API_KEY) return callAPI(prompt, { allowWeb, maxTokens, tier });
  if (process.env.ALLOW_CLI_FALLBACK === '1') return callCLI(prompt, { allowWeb, timeoutMs, tier });
  throw new Error('No ANTHROPIC_API_KEY set (and CLI fallback disabled). Set the key in .env.');
}

function modelFor(tier) {
  if (tier === 'draft') return process.env.TEAMZERO_DRAFT_MODEL || 'claude-haiku-4-5';
  return process.env.TEAMZERO_MODEL || 'claude-sonnet-5';
}

// ---- production path: Anthropic Messages API via fetch (no SDK dependency) ----
async function callAPI(prompt, { allowWeb, maxTokens, tier }) {
  const body = {
    model: modelFor(tier),
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  // Drafting is a simple, bounded task — turn thinking off so we don't pay for
  // reasoning tokens the task doesn't need. (Haiku ignores an unset thinking
  // field = off; Sonnet needs it explicit.)
  if (tier === 'draft') body.thinking = { type: 'disabled' };
  // web_search_20260209 (dynamic filtering) is supported on Sonnet 5 / Opus 5 /
  // 4.8; falls back cleanly, and is more token-efficient than the older variant.
  if (allowWeb) body.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Anthropic API ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  // Concatenate all text blocks (web-search responses interleave tool blocks).
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text;
}

// ---- dev path: local claude CLI (freedom-engine trick) ----
let CLAUDE = null;
function findClaude() {
  if (CLAUDE) return CLAUDE;
  const cands = [
    process.env.CLAUDE_PATH,
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe'),
    '/usr/local/bin/claude', '/usr/bin/claude',
  ].filter(Boolean);
  const hit = cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } });
  CLAUDE = hit ? { cmd: hit, shell: hit.endsWith('.cmd') } : { cmd: 'claude', shell: true };
  return CLAUDE;
}
function callCLI(prompt, { allowWeb, timeoutMs, tier }) {
  return new Promise((resolve, reject) => {
    const cliModel = tier === 'draft' ? 'haiku' : (process.env.TEAMZERO_MODEL_CLI || 'sonnet');
    const args = ['-p', '--model', cliModel];
    if (allowWeb) args.push('--allowedTools', 'WebSearch,WebFetch');
    const spec = findClaude();
    const child = spawn(spec.shell ? `"${spec.cmd}"` : spec.cmd, args, { shell: spec.shell, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('AI call timed out.')); }, timeoutMs || 9 * 60 * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      if (/not logged in/i.test(err + out)) return reject(new Error('Local claude CLI not logged in.'));
      reject(new Error(err.trim() || `claude exited ${code}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function aiMode() {
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  if (process.env.ALLOW_CLI_FALLBACK === '1') return 'cli';
  return 'none';
}

module.exports = { callAI, aiMode };
