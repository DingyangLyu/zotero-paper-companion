/* Paper Companion — model providers.
 * Direct HTTP APIs are the fast path (streaming, ~1–3 s to first token).
 * Local agent CLIs (Codex / Claude Code / OpenCode) remain available, but
 * every call starts a whole agent process, so they are much slower. */
(function (g) {
  'use strict';

  const KINDS = {
    anthropic: {label: 'Anthropic Messages 兼容 API', api: true},
    openai: {label: 'OpenAI Chat Completions 兼容 API', api: true},
    responses: {label: 'OpenAI Responses API', api: true},
    codex: {label: 'Codex CLI', cli: true, binary: 'codex'},
    claude: {label: 'Claude Code CLI', cli: true, binary: 'claude'},
    opencode: {label: 'OpenCode CLI', cli: true, binary: 'opencode'},
  };
  const CLI_KINDS = Object.keys(KINDS).filter(k => KINDS[k].cli);
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const MAX_REPLY = 200000;

  function isAPI(provider) {
    return !!KINDS[provider?.kind]?.api;
  }

  function endpoint(provider) {
    let url;
    try {
      url = new URL(String(provider.baseURL || '').trim());
    } catch (_) {
      throw new Error('API 地址无效，应类似 https://api.example.com/v1');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new Error('API 地址需使用 HTTPS（本机接口可用 HTTP）');
    if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、查询参数或片段');
    const suffix = provider.kind === 'anthropic' ? '/messages' : provider.kind === 'responses' ? '/responses' : '/chat/completions';
    return url.href.replace(/\/$/, '').replace(/\/(?:chat\/completions|responses|messages)$/, '') + suffix;
  }

  // task: 'translate' | 'chat'. Translation never asks for extended thinking:
  // a thinking model otherwise spends 10+ s before the first visible token.
  function buildRequest(provider, model, prompt, {key = '', task = 'chat', thinking = true} = {}) {
    if (!model) throw new Error(`请在设置中为「${provider.name}」填写模型名称`);
    const headers = {'Content-Type': 'application/json'};
    const quick = task === 'translate' || !thinking;
    let body;
    if (provider.kind === 'anthropic') {
      if (key) headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      body = {model, max_tokens: task === 'translate' ? 2048 : 8192, stream: true, system: prompt.system, messages: prompt.messages};
      if (quick) body.thinking = {type: 'disabled'};
    } else if (provider.kind === 'responses') {
      if (key) headers.Authorization = 'Bearer ' + key;
      body = {model, stream: true, store: false, instructions: prompt.system, input: prompt.messages};
    } else {
      if (key) headers.Authorization = 'Bearer ' + key;
      body = {model, stream: true, messages: [{role: 'system', content: prompt.system}, ...prompt.messages]};
    }
    return {url: endpoint(provider), headers, body};
  }

  // One parsed SSE/JSON event → {text, thinking}. Throws on provider errors.
  function parseEvent(kind, e) {
    if (e?.error || e?.type === 'error' || e?.type === 'response.failed') {
      throw new Error(e.error?.message || e.response?.error?.message || e.message || 'API 返回错误');
    }
    if (kind === 'anthropic') {
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') return {text: e.delta.text || ''};
      if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') return {thinking: true};
      if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') return {thinking: true};
      return null;
    }
    if (kind === 'responses') {
      if (e.type === 'response.output_text.delta') return {text: e.delta || ''};
      if (/^response\.reasoning/.test(e.type || '')) return {thinking: true};
      return null;
    }
    const delta = e.choices?.[0]?.delta;
    if (delta?.content) return {text: delta.content};
    if (delta?.reasoning_content || delta?.reasoning) return {thinking: true};
    return null;
  }

  function wholeText(kind, json) {
    if (json?.error) throw new Error(json.error.message || 'API 返回错误');
    if (kind === 'anthropic') return (json.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    if (kind === 'responses') return (json.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('');
    return json.choices?.[0]?.message?.content || '';
  }

  function httpError(status, detail) {
    const hint = {
      400: '请求被拒绝（模型名称或参数可能不受支持）',
      401: 'API Key 无效或已过期',
      403: '没有权限使用该接口或模型',
      404: '接口地址或模型不存在，请检查 Base URL 和模型名称',
      408: '服务端超时',
      413: '请求内容过长，请减少上下文',
      429: '请求过于频繁或额度已用完',
    }[status] || (status >= 500 ? '服务端暂时不可用' : '请求失败');
    const message = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return new Error(`${hint}（HTTP ${status}）${message ? '：' + g.PCCore.redact(message) : ''}`);
  }

  class LineBuffer {
    constructor(onLine, max = 1048576) {
      this.buffer = '';
      this.onLine = onLine;
      this.max = max;
    }
    push(chunk) {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).replace(/\r$/, '');
        this.buffer = this.buffer.slice(i + 1);
        if (line.length > this.max) throw new Error('引擎消息过长');
        this.onLine(line);
      }
      if (this.buffer.length > this.max) throw new Error('引擎消息过长');
    }
    end() {
      if (this.buffer) this.onLine(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    }
  }

  // Server-sent events: "data:" lines accumulate until a blank line.
  function sseParser(onData) {
    let data = [];
    const flush = () => {
      if (!data.length) return;
      const payload = data.join('\n');
      data = [];
      onData(payload);
    };
    const lines = new LineBuffer(line => {
      if (line === '') flush();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    });
    return {push: c => lines.push(c), end: () => { lines.end(); flush(); }};
  }

  async function send(request, opts) {
    try {
      return await opts.fetch(request.url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
        signal: opts.signal, credentials: 'omit',
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new Error('无法连接到 ' + new URL(request.url).host + '：' + (e.message || e) + '（检查网络或代理）');
    }
  }

  async function runAPI(provider, model, prompt, opts) {
    const request = buildRequest(provider, model, prompt, opts);
    let response = await send(request, opts);
    if (response.status === 400 && request.body.thinking) {
      // Some Anthropic-compatible servers reject the thinking switch.
      delete request.body.thinking;
      response = await send(request, opts);
    }
    if (!response.ok) {
      let detail = '';
      try {
        const raw = await response.text();
        try { detail = JSON.parse(raw).error?.message || raw; } catch (_) { detail = raw; }
      } catch (_) {}
      throw httpError(response.status, detail);
    }
    let text = '';
    const add = part => {
      if (!part) return;
      if (part.thinking && !text) opts.onThinking?.();
      if (part.text) {
        text += part.text;
        if (text.length > MAX_REPLY) throw new Error('回复超过长度限制');
        opts.onText(text);
      }
    };
    if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
      text = wholeText(provider.kind, await response.json());
      if (!text) throw new Error('API 没有返回文本');
      opts.onText(text);
      return text;
    }
    let done = false;
    const parser = sseParser(payload => {
      if (payload === '[DONE]') { done = true; return; }
      let event;
      try { event = JSON.parse(payload); } catch (_) { return; }
      add(parseEvent(provider.kind, event));
    });
    const reader = response.body.getReader();
    const decoder = new opts.TextDecoder();
    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        parser.push(decoder.decode(chunk.value, {stream: true}));
      }
      parser.push(decoder.decode());
      parser.end();
    } finally {
      reader.cancel().catch(() => {});
    }
    if (!text.trim()) throw new Error('API 没有返回文本');
    return text;
  }

  function cliPlan(kind, model, {effort = '', task = 'chat'} = {}) {
    const args = {
      codex: () => {
        const e = task === 'translate' ? 'low' : effort;
        return ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
          ...(model ? ['--model', model] : []),
          ...(EFFORTS.includes(e) ? ['-c', 'model_reasoning_effort=' + JSON.stringify(e)] : []), '-'];
      },
      claude: () => ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        ...(model ? ['--model', model] : [])],
      opencode: () => ['run', '--pure', '--format', 'json', ...(model ? ['--model', model] : [])],
    }[kind];
    if (!args) throw new Error('未知的本地引擎：' + kind);
    const environment = {NO_COLOR: '1', TERM: 'dumb'};
    if (kind === 'opencode') {
      Object.assign(environment, {
        OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_MDNS: 'true',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({permission: {'*': 'deny'}}),
      });
    }
    return {args: args(), environment};
  }

  // One JSON line from a CLI → {text, replace} or null.
  function cliEvent(kind, e) {
    if (kind === 'codex') {
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') return {text: e.item.text || ''};
      if (['error', 'turn.failed'].includes(e.type)) throw new Error(e.message || e.error?.message || 'Codex 请求失败');
    } else if (kind === 'claude') {
      if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') return {text: e.event.delta.text || ''};
      if (e.type === 'result') {
        if (e.is_error) throw new Error(e.result || 'Claude Code 请求失败');
        return {text: e.result || '', replace: true};
      }
    } else if (kind === 'opencode') {
      if (e.type === 'text') return {text: e.part?.text || ''};
      if (e.type === 'error') throw new Error(e.error?.data?.message || e.error?.message || 'OpenCode 请求失败');
    }
    return null;
  }

  async function runCLI(provider, model, prompt, opts) {
    if (!provider.path) throw new Error(`没有找到 ${provider.name} 的可执行文件，请在设置中选择路径`);
    const {Subprocess} = g.ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    const plan = cliPlan(provider.kind, model, {effort: provider.effort, task: opts.task});
    const proc = await Subprocess.call({
      command: provider.path, arguments: plan.args, workdir: opts.workdir,
      environmentAppend: true, environment: {...plan.environment, PATH: opts.path}, stderr: 'pipe',
    });
    const kill = () => { try { proc.kill(); } catch (_) {} };
    opts.signal.addEventListener('abort', kill, {once: true});
    if (opts.signal.aborted) kill();
    let text = '';
    let stderr = '';
    const lines = new LineBuffer(line => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch (_) { return; }
      const update = cliEvent(provider.kind, event);
      if (!update?.text) return;
      text = update.replace ? update.text : text + update.text;
      if (text.length > MAX_REPLY) throw new Error('回复超过长度限制');
      opts.onText(text);
    });
    const out = (async () => {
      let chunk;
      while ((chunk = await proc.stdout.readString())) {
        if (opts.signal.aborted) break;
        lines.push(chunk);
      }
      lines.end();
    })();
    const err = (async () => {
      let chunk;
      while ((chunk = await proc.stderr.readString())) stderr = (stderr + chunk).slice(-4000);
    })();
    try {
      await proc.stdin.write(g.PCCore.flatten(prompt));
      await proc.stdin.close();
      await Promise.all([out, err]);
      const result = await proc.wait();
      if (opts.signal.aborted) throw new Error('已停止');
      if (result.exitCode !== 0) throw new Error(g.PCCore.redact(stderr.trim().split('\n').slice(-3).join(' ')) || `${provider.name} 退出，代码 ${result.exitCode}`);
      if (!text.trim()) throw new Error(`${provider.name} 没有返回文本；请检查它的登录状态和模型`);
      return text;
    } catch (e) {
      kill();
      await proc.wait().catch(() => {});
      throw e;
    } finally {
      opts.signal.removeEventListener('abort', kill);
    }
  }

  function run(provider, model, prompt, opts) {
    return isAPI(provider) ? runAPI(provider, model, prompt, opts) : runCLI(provider, model, prompt, opts);
  }

  // Codex app-server model/list → picker entries.
  function codexModelList(result) {
    if (!Array.isArray(result?.data)) throw new Error('Codex 模型目录格式不正确');
    return result.data.slice(0, 100)
      .filter(m => !m.hidden && typeof m.model === 'string' && m.model.length <= 200 && !/[\x00-\x20]/.test(m.model))
      .map(m => ({id: m.model, name: String(m.displayName || m.model).slice(0, 200), isDefault: m.isDefault === true,
        effort: EFFORTS.includes(m.defaultReasoningEffort) ? m.defaultReasoningEffort : ''}));
  }

  // Strip // and /* */ comments (outside strings) from OpenCode's JSONC config.
  function stripJSONComments(source) {
    let out = '';
    let inString = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      const n = source[i + 1];
      if (inString) {
        out += c;
        if (c === '\\') out += source[++i] || '';
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
        out += c;
      } else if (c === '/' && n === '/') {
        while (i < source.length && source[i] !== '\n') i++;
        out += '\n';
      } else if (c === '/' && n === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i++;
      } else {
        out += c;
      }
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
  }

  // API providers that OpenCode already has a base URL and literal key for.
  function opencodeCandidates(config) {
    const result = [];
    for (const [id, p] of Object.entries(config?.provider || {})) {
      const baseURL = p?.options?.baseURL;
      const key = p?.options?.apiKey;
      if (typeof baseURL !== 'string' || typeof key !== 'string' || !key || /^\{(env|file):/.test(key)) continue;
      const npm = String(p.npm || '');
      const kind = id === 'anthropic' || npm.includes('anthropic') ? 'anthropic' : 'openai';
      const models = Object.keys(p.models || {}).filter(m => !Array.isArray(p.whitelist) || p.whitelist.includes(m));
      const modelNames = Object.fromEntries(models.filter(m => typeof p.models[m]?.name === 'string').map(m => [m, p.models[m].name.slice(0, 80)]));
      result.push({source: id, name: p.name || id, kind, baseURL, models: models.slice(0, 50), modelNames, key});
    }
    return result;
  }

  const api = {
    KINDS, CLI_KINDS, EFFORTS, isAPI, endpoint, buildRequest, parseEvent, wholeText, httpError, LineBuffer,
    sseParser, runAPI, cliPlan, cliEvent, runCLI, run, codexModelList, stripJSONComments, opencodeCandidates,
  };
  g.PCProviders = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
