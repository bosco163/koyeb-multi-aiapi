const http = require('http');
const https = require('https');
const { URL } = require('url');
const { StringDecoder } = require('string_decoder');

// ==================== 配置区 ====================

const PORT = Number(process.env.PORT || 9000);

// 若设置 API_KEY，则强制覆盖客户端 Authorization。
// 留空则透传客户端 Authorization。
// 特殊规则：API_KEY === "no_key" 时，上游发送 Bearer 空 token。
const API_KEY = process.env.API_KEY || '';

// 每张图片固定估算 token
const FIXED_IMAGE_TOKENS = Number(process.env.FIXED_IMAGE_TOKENS || 85);

// 最大请求体，默认 100MB。多张 base64 图片时需要足够大。
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 100 * 1024 * 1024);

// 上游超时，默认 1 小时
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 3600 * 1000);

// SSE 心跳间隔，默认 15 秒
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15000);

// =================================================

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function handleOptions(res) {
  setCorsHeaders(res);
  res.writeHead(204);
  res.end();
}

function sendJson(res, reqMethod, statusCode, payload) {
  if (res.writableEnded) return;

  setCorsHeaders(res);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });

  if (reqMethod === 'HEAD') return res.end();

  res.end(body);
}

function buildDirectStatusResponse(res, reqMethod, statusCode) {
  if (res.writableEnded) return;

  setCorsHeaders(res);
  res.writeHead(statusCode);

  if (reqMethod === 'HEAD') return res.end();

  res.end();
}

// ==================== 模型字符串处理 ====================
//
// 支持：
// model[rm_sp]
// model[tk>=1000:target]
// model[pt>2:target]
// model[tk>=1000,pt>2:target]
// model[tk>=1000:sc=403]
// model[er_sc:429]
// 可混合 rm_sp 和 er_sc
//

function processModelString(modelStr, messages) {
  const rawModel = String(modelStr || '').trim();

  const removeLeadingSpace = /\[rm_sp\]/i.test(rawModel);

  let emptyReturnStatusCode = null;
  const erMatch = rawModel.match(/\[er_sc\s*:\s*(\d{3})\]/i);
  if (erMatch) {
    const code = parseInt(erMatch[1], 10);
    if (code >= 100 && code <= 599) {
      emptyReturnStatusCode = code;
    }
  }

  modelStr = rawModel
    .replace(/\[rm_sp\]/gi, '')
    .replace(/\[er_sc\s*:\s*\d{3}\]/gi, '')
    .trim();

  const match = modelStr.match(/^([^[]+)\[([^:]+):([^\]]+)\]$/);
  if (!match) {
    return {
      action: 'model',
      model: modelStr,
      removeLeadingSpace,
      emptyReturnStatusCode
    };
  }

  const baseModel = match[1].trim();
  const conditionsStr = match[2].trim();
  const targetStr = match[3].trim();

  const parsedConditions = parseConditions(conditionsStr);
  if (!parsedConditions.valid) {
    return {
      action: 'model',
      model: modelStr,
      removeLeadingSpace,
      emptyReturnStatusCode
    };
  }

  const metrics = analyzeMessages(messages);
  const conditionMet = evaluateConditions(parsedConditions.conditions, metrics);

  console.log('[auto-switch] metrics:', JSON.stringify({
    baseModel,
    conditionsStr,
    targetStr,
    metrics,
    conditionMet,
    removeLeadingSpace,
    emptyReturnStatusCode
  }));

  if (!conditionMet) {
    return {
      action: 'model',
      model: baseModel,
      removeLeadingSpace,
      emptyReturnStatusCode
    };
  }

  const statusMatch = targetStr.match(/^sc\s*=\s*(\d{3})$/i);
  if (statusMatch) {
    const statusCode = parseInt(statusMatch[1], 10);
    if (statusCode >= 100 && statusCode <= 599) {
      return {
        action: 'status',
        statusCode,
        removeLeadingSpace,
        emptyReturnStatusCode
      };
    }
  }

  return {
    action: 'model',
    model: targetStr,
    removeLeadingSpace,
    emptyReturnStatusCode
  };
}

function parseConditions(conditionsStr) {
  const parts = String(conditionsStr || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { valid: false, conditions: [] };
  }

  const conditions = [];
  const seenTypes = new Set();

  for (const part of parts) {
    const m = part.match(/^(tk|pt)\s*(>=|<=|>|<|==)\s*(\d+)$/i);
    if (!m) {
      return { valid: false, conditions: [] };
    }

    const type = m[1].toLowerCase();
    const operator = m[2];
    const threshold = parseInt(m[3], 10);

    if (seenTypes.has(type)) {
      return { valid: false, conditions: [] };
    }

    seenTypes.add(type);
    conditions.push({ type, operator, threshold });
  }

  return { valid: true, conditions };
}

function evaluateConditions(conditions, metrics) {
  for (const condition of conditions) {
    let actualValue;

    if (condition.type === 'tk') {
      actualValue = metrics.estimatedTokens;
    } else if (condition.type === 'pt') {
      actualValue = metrics.imageCount;
    } else {
      return false;
    }

    let passed = false;

    switch (condition.operator) {
      case '>=':
        passed = actualValue >= condition.threshold;
        break;
      case '>':
        passed = actualValue > condition.threshold;
        break;
      case '<=':
        passed = actualValue <= condition.threshold;
        break;
      case '<':
        passed = actualValue < condition.threshold;
        break;
      case '==':
        passed = actualValue === condition.threshold;
        break;
      default:
        passed = false;
        break;
    }

    if (!passed) return false;
  }

  return true;
}

function analyzeMessages(messages) {
  let totalChars = 0;
  let cjkCount = 0;
  let imageCount = 0;

  if (!Array.isArray(messages)) {
    return {
      imageCount: 0,
      estimatedTokens: 0
    };
  }

  for (const msg of messages) {
    if (!msg || msg.content == null) continue;

    if (typeof msg.content === 'string') {
      const textContent = msg.content;
      totalChars += textContent.length;

      const cjkMatches = textContent.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
      if (cjkMatches) cjkCount += cjkMatches.length;
      continue;
    }

    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part) continue;

        const isImagePart =
          part.type === 'image_url' ||
          part.type === 'image' ||
          part.type === 'input_image' ||
          !!part.image_url ||
          !!part.image ||
          !!part.input_image ||
          typeof part.image_url?.url === 'string' ||
          typeof part.url === 'string' && /^https?:\/\//i.test(part.url) ||
          typeof part.url === 'string' && /^data:image\//i.test(part.url);

        if (isImagePart) {
          imageCount++;
          continue;
        }

        let textContent = '';

        if (typeof part.text === 'string') {
          textContent += part.text;
        }

        if (typeof part.content === 'string') {
          textContent += part.content;
        }

        if (textContent) {
          totalChars += textContent.length;
          const cjkMatches = textContent.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
          if (cjkMatches) cjkCount += cjkMatches.length;
        }
      }
    }
  }

  const nonCjkCount = totalChars - cjkCount;
  const textTokens = cjkCount * 1.5 + nonCjkCount / 4.0;
  const totalTokens = textTokens + imageCount * FIXED_IMAGE_TOKENS;

  return {
    imageCount,
    estimatedTokens: Math.ceil(totalTokens * 1.05)
  };
}

// ==================== 请求体收集 ====================

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', chunk => {
      total += chunk.length;

      if (total > MAX_BODY_BYTES) {
        reject(new Error(`Request body too large. Max ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', reject);
  });
}

function collectResponseBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    stream.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    stream.on('error', reject);
  });
}

// ==================== URL 解析 ====================

function parseTargetFromPath(reqUrl) {
  const urlObj = new URL(reqUrl, 'http://127.0.0.1');
  let path = urlObj.pathname;

  if (path.startsWith('/')) path = path.slice(1);

  if (path.startsWith('auto-switch/')) {
    path = path.slice('auto-switch/'.length);
  } else if (path === 'auto-switch') {
    path = '';
  }

  let upstreamUrlStr = '';

  if (path.startsWith('https://') || path.startsWith('http://')) {
    const firstSlashIndex = path.indexOf('/', path.indexOf('://') + 3);

    if (firstSlashIndex !== -1) {
      upstreamUrlStr = path.substring(0, firstSlashIndex);
      path = path.substring(firstSlashIndex);
    } else {
      upstreamUrlStr = path;
      path = '/';
    }
  } else {
    const firstSlashIndex = path.indexOf('/');

    if (firstSlashIndex !== -1) {
      upstreamUrlStr = 'https://' + path.substring(0, firstSlashIndex);
      path = path.substring(firstSlashIndex);
    } else {
      upstreamUrlStr = 'https://' + path;
      path = '/';
    }
  }

  return upstreamUrlStr + path + urlObj.search;
}

// ==================== API Key 处理 ====================

function normalizeApiKeyValue(apiKey) {
  const value = String(apiKey == null ? '' : apiKey).trim();
  return value === 'no_key' ? '' : value;
}

function normalizeAuthorizationHeader(authHeader) {
  if (typeof authHeader !== 'string') return authHeader;

  const trimmed = authHeader.trim();
  if (!trimmed) return authHeader;

  const schemeMatch = trimmed.match(/^(\S+)\s+(.+)$/);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    const token = schemeMatch[2].trim();

    if (token === 'no_key') {
      return `${scheme} `;
    }

    return authHeader;
  }

  if (trimmed === 'no_key') {
    return '';
  }

  return authHeader;
}

// ==================== rm_sp 处理 ====================

function createLeadingSpaceState() {
  return {
    started: Object.create(null)
  };
}

function stripLeadingSpacesOnce(value, state, logicalKey) {
  if (typeof value !== 'string') return value;

  if (state.started[logicalKey]) {
    return value;
  }

  const stripped = value.replace(/^ +/, '');

  if (stripped.length > 0) {
    state.started[logicalKey] = true;
  }

  return stripped;
}

function trimLeadingSpaceInLogicalItem(item, state, logicalKey) {
  if (typeof item === 'string') {
    return stripLeadingSpacesOnce(item, state, logicalKey);
  }

  if (!item || typeof item !== 'object') {
    return item;
  }

  const fields = ['text', 'content', 'output_text', 'reasoning', 'reasoning_content'];

  for (const field of fields) {
    if (typeof item[field] === 'string') {
      item[field] = stripLeadingSpacesOnce(item[field], state, `${logicalKey}.${field}`);
    }
  }

  return item;
}

function trimLeadingSpaceInLogicalValue(value, state, logicalKey) {
  if (typeof value === 'string') {
    return stripLeadingSpacesOnce(value, state, logicalKey);
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = trimLeadingSpaceInLogicalItem(value[i], state, `${logicalKey}[${i}]`);
    }

    return value;
  }

  if (value && typeof value === 'object') {
    return trimLeadingSpaceInLogicalItem(value, state, logicalKey);
  }

  return value;
}

function applyRemoveLeadingSpaceToFields(obj, state, logicalPrefix) {
  if (!obj || typeof obj !== 'object') return;

  const fields = ['content', 'text', 'output_text', 'reasoning', 'reasoning_content'];

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      obj[field] = trimLeadingSpaceInLogicalValue(obj[field], state, `${logicalPrefix}.${field}`);
    }
  }
}

function applyRemoveLeadingSpaceToResponsePayload(payload, state) {
  if (!payload || typeof payload !== 'object') return payload;

  applyRemoveLeadingSpaceToFields(payload, state, 'root');

  if (payload.delta && typeof payload.delta === 'object') {
    applyRemoveLeadingSpaceToFields(payload.delta, state, 'root.delta');
  }

  if (payload.message && typeof payload.message === 'object') {
    applyRemoveLeadingSpaceToFields(payload.message, state, 'root.message');
  }

  if (Array.isArray(payload.choices)) {
    payload.choices.forEach((choice, idx) => {
      if (!choice || typeof choice !== 'object') return;

      const choiceKey = `choices.${idx}`;

      applyRemoveLeadingSpaceToFields(choice, state, choiceKey);

      if (choice.delta && typeof choice.delta === 'object') {
        applyRemoveLeadingSpaceToFields(choice.delta, state, `${choiceKey}.delta`);
      }

      if (choice.message && typeof choice.message === 'object') {
        applyRemoveLeadingSpaceToFields(choice.message, state, `${choiceKey}.message`);
      }
    });
  }

  return payload;
}

// ==================== empty return 检测 ====================

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function extractTextFromContentArray(content) {
  if (!Array.isArray(content)) return '';

  let out = '';

  for (const part of content) {
    if (!part) continue;

    if (typeof part === 'string') {
      out += part;
      continue;
    }

    if (typeof part.text === 'string') out += part.text;
    if (typeof part.content === 'string') out += part.content;
    if (typeof part.output_text === 'string') out += part.output_text;
    if (typeof part.reasoning === 'string') out += part.reasoning;
    if (typeof part.reasoning_content === 'string') out += part.reasoning_content;
  }

  return out;
}

function payloadHasVisibleContent(payload) {
  if (!payload || typeof payload !== 'object') return false;

  if (hasNonEmptyString(payload.content)) return true;
  if (hasNonEmptyString(payload.text)) return true;
  if (hasNonEmptyString(payload.output_text)) return true;
  if (hasNonEmptyString(payload.reasoning)) return true;
  if (hasNonEmptyString(payload.reasoning_content)) return true;

  const directArrayText =
    extractTextFromContentArray(payload.content) +
    extractTextFromContentArray(payload.output);

  if (directArrayText.trim() !== '') return true;

  if (payload.message && payloadHasVisibleContent(payload.message)) return true;
  if (payload.delta && payloadHasVisibleContent(payload.delta)) return true;

  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      if (!choice || typeof choice !== 'object') continue;

      if (payloadHasVisibleContent(choice)) return true;
      if (choice.message && payloadHasVisibleContent(choice.message)) return true;
      if (choice.delta && payloadHasVisibleContent(choice.delta)) return true;
    }
  }

  return false;
}

function detectEmptyReturnFromJsonBuffer(rawBuffer, contentType) {
  if (!rawBuffer || rawBuffer.length === 0) {
    return true;
  }

  const text = rawBuffer.toString('utf8');
  const ct = String(contentType || '').toLowerCase();

  const looksLikeJson =
    ct.includes('application/json') ||
    ct.includes('+json') ||
    /^[\s\r\n]*[\[{]/.test(text);

  if (!looksLikeJson) return false;

  try {
    const payload = JSON.parse(text);
    return !payloadHasVisibleContent(payload);
  } catch (_) {
    return false;
  }
}

function parseSSEEventPayload(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  let hasDataLine = false;
  let joinedData = '';

  for (const line of lines) {
    const match = line.match(/^data:\s?(.*)$/);
    if (!match) continue;

    hasDataLine = true;
    joinedData += (joinedData ? '\n' : '') + match[1];
  }

  if (!hasDataLine) {
    return {
      hasDataLine: false,
      isDone: false,
      payload: null
    };
  }

  if (joinedData.trim() === '[DONE]') {
    return {
      hasDataLine: true,
      isDone: true,
      payload: null
    };
  }

  try {
    return {
      hasDataLine: true,
      isDone: false,
      payload: JSON.parse(joinedData)
    };
  } catch (_) {
    return {
      hasDataLine: true,
      isDone: false,
      payload: null
    };
  }
}

function detectEmptyReturnFromSSEBuffer(rawBuffer) {
  if (!rawBuffer || rawBuffer.length === 0) return true;

  const text = rawBuffer.toString('utf8');
  const events = text.split(/\r?\n\r?\n/);

  for (const rawEvent of events) {
    if (!rawEvent) continue;

    const parsed = parseSSEEventPayload(rawEvent);
    if (!parsed.hasDataLine || parsed.isDone || !parsed.payload) continue;

    if (payloadHasVisibleContent(parsed.payload)) {
      return false;
    }
  }

  return true;
}

function buildEmptyReturnStatusResponse(res, reqMethod, statusCode) {
  return sendJson(res, reqMethod, statusCode, {
    error: 'Empty Return',
    message: 'Upstream returned 200 but no model content was produced'
  });
}

// ==================== SSE 转换 ====================

function processSSEEventWithRmSp(rawEvent, state) {
  if (!rawEvent) return '';

  const lines = rawEvent.split(/\r?\n/);
  let hasDataLine = false;
  let joinedData = '';

  for (const line of lines) {
    const match = line.match(/^data:\s?(.*)$/);
    if (!match) continue;

    hasDataLine = true;
    joinedData += (joinedData ? '\n' : '') + match[1];
  }

  if (!hasDataLine) return rawEvent;
  if (joinedData.trim() === '[DONE]') return rawEvent;

  try {
    const payload = JSON.parse(joinedData);
    const transformed = applyRemoveLeadingSpaceToResponsePayload(payload, state);
    const serialized = JSON.stringify(transformed);

    const rebuiltLines = [];
    let inserted = false;

    for (const line of lines) {
      if (/^data:/.test(line)) {
        if (!inserted) {
          rebuiltLines.push(`data: ${serialized}`);
          inserted = true;
        }
      } else {
        rebuiltLines.push(line);
      }
    }

    return rebuiltLines.join('\n');
  } catch (_) {
    return rawEvent;
  }
}

function transformSSEText(chunkText, rmState, sseState) {
  sseState.buffer += chunkText;

  let output = '';

  while (true) {
    const match = sseState.buffer.match(/\r?\n\r?\n/);
    if (!match) break;

    const boundaryIndex = match.index;
    const boundaryLength = match[0].length;
    const rawEvent = sseState.buffer.slice(0, boundaryIndex);

    sseState.buffer = sseState.buffer.slice(boundaryIndex + boundaryLength);

    output += processSSEEventWithRmSp(rawEvent, rmState) + '\n\n';
  }

  return output;
}

function transformBufferedResponse(rawBuffer, contentType, state) {
  if (!rawBuffer || rawBuffer.length === 0) return rawBuffer;

  const text = rawBuffer.toString('utf8');
  const ct = String(contentType || '').toLowerCase();

  const looksLikeJson =
    ct.includes('application/json') ||
    ct.includes('+json') ||
    /^[\s\r\n]*[\[{]/.test(text);

  if (!looksLikeJson) return rawBuffer;

  try {
    const payload = JSON.parse(text);
    const transformed = applyRemoveLeadingSpaceToResponsePayload(payload, state);
    return Buffer.from(JSON.stringify(transformed), 'utf8');
  } catch (e) {
    console.warn('[auto-switch] rm_sp non-stream response parse failed, returning raw body:', e.message);
    return rawBuffer;
  }
}

// ==================== SSE 心跳 ====================

function startSSEHeartbeat(res, intervalMs = HEARTBEAT_INTERVAL_MS) {
  const timer = setInterval(() => {
    try {
      if (!res.writableEnded) {
        res.write(': keep-alive\n\n');
      }
    } catch (_) {
      clearInterval(timer);
    }
  }, intervalMs);

  res.on('close', () => clearInterval(timer));
  res.on('finish', () => clearInterval(timer));

  return timer;
}

function writeSSEError(res, statusCode, message) {
  if (res.writableEnded) return;

  const payload = {
    error: {
      message: message || 'Upstream error',
      type: 'upstream_error',
      code: statusCode
    }
  };

  res.write(`event: error\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write(`data: [DONE]\n\n`);
}

// ==================== 上游代理 ====================

function isSSEResponse(headers, preferSSE) {
  const contentType = String(headers['content-type'] || '');
  return contentType.includes('text/event-stream') || (!contentType && preferSSE);
}

function buildUpstreamHeaders(reqHeaders, finalBody) {
  const headers = { ...reqHeaders };

  delete headers.host;
  delete headers['content-length'];
  delete headers['transfer-encoding'];

  delete headers['cf-connecting-ip'];
  delete headers['cf-ipcountry'];
  delete headers['cf-visitor'];
  delete headers['cf-worker'];

  if (finalBody && finalBody.length > 0) {
    headers['content-length'] = Buffer.byteLength(finalBody);
  }

  if (API_KEY !== '') {
    const normalizedApiKey = normalizeApiKeyValue(API_KEY);
    headers['authorization'] = `Bearer ${normalizedApiKey}`;
  } else if (typeof headers['authorization'] === 'string') {
    const normalizedAuthorization = normalizeAuthorizationHeader(headers['authorization']);

    if (normalizedAuthorization === '') {
      delete headers['authorization'];
    } else {
      headers['authorization'] = normalizedAuthorization;
    }
  }

  return headers;
}

function pipeRawUpstreamResponse(upstreamRes, req, res, preferSSE) {
  const responseHeaders = { ...upstreamRes.headers };

  responseHeaders['access-control-allow-origin'] = '*';
  responseHeaders['x-accel-buffering'] = 'no';

  const shouldHeartbeat = isSSEResponse(upstreamRes.headers, preferSSE);

  if (shouldHeartbeat) {
    delete responseHeaders['content-length'];
  }

  res.writeHead(upstreamRes.statusCode || 500, responseHeaders);

  if (req.method === 'HEAD') {
    upstreamRes.resume();
    upstreamRes.on('end', () => res.end());
    return;
  }

  let heartbeatInterval = null;

  if (shouldHeartbeat) {
    heartbeatInterval = startSSEHeartbeat(res);
  }

  upstreamRes.on('data', chunk => {
    if (!res.writableEnded) {
      res.write(chunk);
    }
  });

  upstreamRes.on('end', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (!res.writableEnded) res.end();
  });

  upstreamRes.on('error', err => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    console.error('[auto-switch] upstream stream error:', err);
    try {
      if (!res.writableEnded) res.end();
    } catch (_) {}
  });

  res.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  });
}

function pipeUpstreamResponseWithRmSpSSEStreaming(upstreamRes, req, res) {
  const responseHeaders = { ...upstreamRes.headers };

  responseHeaders['access-control-allow-origin'] = '*';
  responseHeaders['x-accel-buffering'] = 'no';
  delete responseHeaders['content-length'];

  res.writeHead(upstreamRes.statusCode || 500, responseHeaders);

  if (req.method === 'HEAD') {
    upstreamRes.resume();
    upstreamRes.on('end', () => res.end());
    return;
  }

  const rmState = createLeadingSpaceState();
  const sseState = { buffer: '' };
  const decoder = new StringDecoder('utf8');

  const heartbeatInterval = startSSEHeartbeat(res);

  upstreamRes.on('data', chunk => {
    const decoded = decoder.write(chunk);
    const transformed = transformSSEText(decoded, rmState, sseState);

    if (transformed && !res.writableEnded) {
      res.write(transformed);
    }
  });

  upstreamRes.on('end', () => {
    let tailOutput = '';

    const finalDecoded = decoder.end();
    if (finalDecoded) {
      tailOutput += transformSSEText(finalDecoded, rmState, sseState);
    }

    if (sseState.buffer) {
      tailOutput += processSSEEventWithRmSp(sseState.buffer, rmState);
      sseState.buffer = '';
    }

    if (tailOutput && !res.writableEnded) {
      res.write(tailOutput);
    }

    clearInterval(heartbeatInterval);

    if (!res.writableEnded) {
      res.end();
    }
  });

  upstreamRes.on('error', err => {
    clearInterval(heartbeatInterval);
    console.error('[auto-switch] upstream rm_sp SSE error:', err);

    try {
      if (!res.writableEnded) res.end();
    } catch (_) {}
  });
}

function pipeUpstreamResponseWithRmSpBuffered(upstreamRes, req, res) {
  const chunks = [];
  const rmState = createLeadingSpaceState();

  upstreamRes.on('data', chunk => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  upstreamRes.on('end', () => {
    const responseHeaders = { ...upstreamRes.headers };

    responseHeaders['access-control-allow-origin'] = '*';
    delete responseHeaders['content-length'];
    delete responseHeaders['transfer-encoding'];

    const rawBuffer = Buffer.concat(chunks);
    const finalBuffer = transformBufferedResponse(
      rawBuffer,
      responseHeaders['content-type'],
      rmState
    );

    responseHeaders['content-length'] = Buffer.byteLength(finalBuffer);

    res.writeHead(upstreamRes.statusCode || 500, responseHeaders);

    if (req.method === 'HEAD') {
      return res.end();
    }

    res.end(finalBuffer);
  });

  upstreamRes.on('error', err => {
    console.error('[auto-switch] upstream rm_sp buffered error:', err);

    if (!res.headersSent) {
      sendJson(res, req.method, 502, {
        error: 'Bad Gateway',
        message: err.message
      });
    } else {
      try {
        res.end();
      } catch (_) {}
    }
  });
}

async function pipeBufferedWithEmptyReturnCheck(upstreamRes, req, res, removeLeadingSpace, emptyReturnStatusCode) {
  const responseHeaders = { ...upstreamRes.headers };

  responseHeaders['access-control-allow-origin'] = '*';
  delete responseHeaders['content-length'];
  delete responseHeaders['transfer-encoding'];

  const upstreamStatus = upstreamRes.statusCode || 500;
  const rawBuffer = await collectResponseBody(upstreamRes);

  if (emptyReturnStatusCode && upstreamStatus === 200) {
    const isEmpty = detectEmptyReturnFromJsonBuffer(rawBuffer, responseHeaders['content-type']);

    if (isEmpty) {
      console.warn(`[auto-switch] empty return detected, converting 200 -> ${emptyReturnStatusCode}`);
      return buildEmptyReturnStatusResponse(res, req.method, emptyReturnStatusCode);
    }
  }

  let finalBuffer = rawBuffer;

  if (removeLeadingSpace) {
    const rmState = createLeadingSpaceState();

    finalBuffer = transformBufferedResponse(
      rawBuffer,
      responseHeaders['content-type'],
      rmState
    );
  }

  responseHeaders['content-length'] = Buffer.byteLength(finalBuffer);

  res.writeHead(upstreamStatus, responseHeaders);

  if (req.method === 'HEAD') {
    return res.end();
  }

  res.end(finalBuffer);
}

function pipeSSEWithEarlyContentDetection(upstreamRes, req, res, removeLeadingSpace, emptyReturnStatusCode) {
  const upstreamStatus = upstreamRes.statusCode || 500;
  const responseHeaders = { ...upstreamRes.headers };

  responseHeaders['access-control-allow-origin'] = '*';
  responseHeaders['x-accel-buffering'] = 'no';
  delete responseHeaders['content-length'];

  const decoder = new StringDecoder('utf8');
  const rmState = createLeadingSpaceState();
  const parseState = { buffer: '' };
  const pendingOutputChunks = [];

  let streamingStarted = false;
  let heartbeatInterval = null;

  function startStreamingNow() {
    if (streamingStarted) return;

    streamingStarted = true;

    res.writeHead(upstreamStatus, responseHeaders);

    if (req.method === 'HEAD') {
      return;
    }

    heartbeatInterval = startSSEHeartbeat(res);

    for (const chunk of pendingOutputChunks) {
      if (chunk && !res.writableEnded) {
        res.write(chunk);
      }
    }

    pendingOutputChunks.length = 0;
  }

  function processDecodedText(decodedText) {
    parseState.buffer += decodedText;

    while (true) {
      const match = parseState.buffer.match(/\r?\n\r?\n/);
      if (!match) break;

      const boundaryIndex = match.index;
      const boundaryLength = match[0].length;
      const rawEvent = parseState.buffer.slice(0, boundaryIndex);
      const sep = parseState.buffer.slice(boundaryIndex, boundaryIndex + boundaryLength);

      parseState.buffer = parseState.buffer.slice(boundaryIndex + boundaryLength);

      const parsed = parseSSEEventPayload(rawEvent);

      let outgoingEvent = rawEvent;

      if (removeLeadingSpace) {
        outgoingEvent = processSSEEventWithRmSp(rawEvent, rmState);
      }

      const outgoingChunk = outgoingEvent + sep;
      const hasContent = !!(parsed.payload && payloadHasVisibleContent(parsed.payload));

      if (!streamingStarted) {
        pendingOutputChunks.push(outgoingChunk);

        if (hasContent || upstreamStatus !== 200 || !emptyReturnStatusCode) {
          startStreamingNow();
        }
      } else if (req.method !== 'HEAD' && !res.writableEnded) {
        res.write(outgoingChunk);
      }
    }
  }

  upstreamRes.on('data', chunk => {
    const decoded = decoder.write(chunk);

    if (decoded) {
      processDecodedText(decoded);
    }
  });

  upstreamRes.on('end', () => {
    const finalDecoded = decoder.end();

    if (finalDecoded) {
      processDecodedText(finalDecoded);
    }

    if (parseState.buffer) {
      const rawEvent = parseState.buffer;
      const parsed = parseSSEEventPayload(rawEvent);

      let outgoingEvent = rawEvent;

      if (removeLeadingSpace) {
        outgoingEvent = processSSEEventWithRmSp(rawEvent, rmState);
      }

      const hasContent = !!(parsed.payload && payloadHasVisibleContent(parsed.payload));

      if (!streamingStarted) {
        pendingOutputChunks.push(outgoingEvent);

        if (hasContent || upstreamStatus !== 200 || !emptyReturnStatusCode) {
          startStreamingNow();
        }
      } else if (req.method !== 'HEAD' && !res.writableEnded) {
        res.write(outgoingEvent);
      }

      parseState.buffer = '';
    }

    if (!streamingStarted) {
      const fullText = pendingOutputChunks.join('');
      const isEmpty = detectEmptyReturnFromSSEBuffer(Buffer.from(fullText, 'utf8'));

      if (emptyReturnStatusCode && upstreamStatus === 200 && isEmpty) {
        console.warn(`[auto-switch] empty SSE return detected, converting 200 -> ${emptyReturnStatusCode}`);
        return buildEmptyReturnStatusResponse(res, req.method, emptyReturnStatusCode);
      }

      startStreamingNow();
    }

    if (heartbeatInterval) clearInterval(heartbeatInterval);

    if (!res.writableEnded) {
      res.end();
    }
  });

  upstreamRes.on('error', err => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    console.error('[auto-switch] upstream SSE er_sc error:', err);

    if (!res.headersSent) {
      sendJson(res, req.method, 502, {
        error: 'Bad Gateway',
        message: err.message
      });
    } else {
      try {
        if (!res.writableEnded) res.end();
      } catch (_) {}
    }
  });

  res.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  });
}

// 重点：提前启动 SSE 响应。
// 这样即使上游迟迟没有返回 headers，也会先给客户端发送 heartbeat，避免空闲超时。
// 注意：这种模式无法保留上游原始 HTTP 状态码，错误会以 SSE event:error 形式返回。
function proxyRequestEarlySSE(req, res, targetUrl, bodyBuffer, headers, removeLeadingSpace) {
  const urlObj = new URL(targetUrl);
  const client = urlObj.protocol === 'https:' ? https : http;

  const options = {
    protocol: urlObj.protocol,
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: req.method,
    headers
  };

  setCorsHeaders(res);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });

  if (req.method === 'HEAD') {
    return res.end();
  }

  res.write(': connected\n\n');

  const heartbeatInterval = startSSEHeartbeat(res);

  const upstreamReq = client.request(options, upstreamRes => {
    const upstreamStatus = upstreamRes.statusCode || 500;

    if (upstreamStatus < 200 || upstreamStatus >= 300) {
      collectResponseBody(upstreamRes)
        .then(buf => {
          const msg = buf.toString('utf8') || `Upstream status ${upstreamStatus}`;
          writeSSEError(res, upstreamStatus, msg);
          clearInterval(heartbeatInterval);
          if (!res.writableEnded) res.end();
        })
        .catch(err => {
          writeSSEError(res, 502, err.message);
          clearInterval(heartbeatInterval);
          if (!res.writableEnded) res.end();
        });

      return;
    }

    if (removeLeadingSpace) {
      const rmState = createLeadingSpaceState();
      const sseState = { buffer: '' };
      const decoder = new StringDecoder('utf8');

      upstreamRes.on('data', chunk => {
        const decoded = decoder.write(chunk);
        const transformed = transformSSEText(decoded, rmState, sseState);

        if (transformed && !res.writableEnded) {
          res.write(transformed);
        }
      });

      upstreamRes.on('end', () => {
        let tailOutput = '';

        const finalDecoded = decoder.end();
        if (finalDecoded) {
          tailOutput += transformSSEText(finalDecoded, rmState, sseState);
        }

        if (sseState.buffer) {
          tailOutput += processSSEEventWithRmSp(sseState.buffer, rmState);
          sseState.buffer = '';
        }

        if (tailOutput && !res.writableEnded) {
          res.write(tailOutput);
        }

        clearInterval(heartbeatInterval);

        if (!res.writableEnded) {
          res.end();
        }
      });
    } else {
      upstreamRes.on('data', chunk => {
        if (!res.writableEnded) {
          res.write(chunk);
        }
      });

      upstreamRes.on('end', () => {
        clearInterval(heartbeatInterval);

        if (!res.writableEnded) {
          res.end();
        }
      });
    }

    upstreamRes.on('error', err => {
      console.error('[auto-switch] early SSE upstream response error:', err);
      writeSSEError(res, 502, err.message);
      clearInterval(heartbeatInterval);

      if (!res.writableEnded) {
        res.end();
      }
    });
  });

  upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    console.error('[auto-switch] early SSE upstream request timeout');
    upstreamReq.destroy(new Error('Upstream request timeout'));
  });

  upstreamReq.on('error', err => {
    console.error('[auto-switch] early SSE proxy request error:', err);

    writeSSEError(res, 502, err.message);

    clearInterval(heartbeatInterval);

    if (!res.writableEnded) {
      res.end();
    }
  });

  req.on('close', () => {
    try {
      upstreamReq.destroy();
    } catch (_) {}

    clearInterval(heartbeatInterval);
  });

  if (bodyBuffer && bodyBuffer.length > 0) {
    upstreamReq.write(bodyBuffer);
  }

  upstreamReq.end();
}

function proxyRequest(req, res, targetUrl, bodyBuffer, headers, preferSSE, removeLeadingSpace, emptyReturnStatusCode) {
  const urlObj = new URL(targetUrl);
  const client = urlObj.protocol === 'https:' ? https : http;

  if (removeLeadingSpace || emptyReturnStatusCode) {
    headers['accept-encoding'] = 'identity';
  }

  const options = {
    protocol: urlObj.protocol,
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: req.method,
    headers
  };

  const upstreamReq = client.request(options, upstreamRes => {
    const contentEncoding = String(upstreamRes.headers['content-encoding'] || '').trim().toLowerCase();
    const responseIsEncoded = !!contentEncoding && contentEncoding !== 'identity';
    const sse = isSSEResponse(upstreamRes.headers, preferSSE);

    if (!removeLeadingSpace && !emptyReturnStatusCode) {
      return pipeRawUpstreamResponse(upstreamRes, req, res, preferSSE);
    }

    if (responseIsEncoded) {
      console.warn('[auto-switch] response transform/check skipped because upstream response is encoded:', contentEncoding);
      return pipeRawUpstreamResponse(upstreamRes, req, res, preferSSE);
    }

    if (removeLeadingSpace && !emptyReturnStatusCode) {
      if (sse) {
        return pipeUpstreamResponseWithRmSpSSEStreaming(upstreamRes, req, res);
      }

      return pipeUpstreamResponseWithRmSpBuffered(upstreamRes, req, res);
    }

    if (emptyReturnStatusCode) {
      if (sse) {
        return pipeSSEWithEarlyContentDetection(
          upstreamRes,
          req,
          res,
          removeLeadingSpace,
          emptyReturnStatusCode
        );
      }

      pipeBufferedWithEmptyReturnCheck(
        upstreamRes,
        req,
        res,
        removeLeadingSpace,
        emptyReturnStatusCode
      ).catch(err => {
        console.error('[auto-switch] buffered empty-return handling error:', err);

        if (!res.headersSent) {
          sendJson(res, req.method, 502, {
            error: 'Bad Gateway',
            message: err.message
          });
        } else {
          try {
            res.end();
          } catch (_) {}
        }
      });

      return;
    }

    return pipeRawUpstreamResponse(upstreamRes, req, res, preferSSE);
  });

  upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    console.error('[auto-switch] upstream request timeout');
    upstreamReq.destroy(new Error('Upstream request timeout'));
  });

  upstreamReq.on('error', err => {
    console.error('[auto-switch] proxy request error:', err);

    if (!res.headersSent) {
      sendJson(res, req.method, 502, {
        error: 'Bad Gateway',
        message: err.message
      });
    } else {
      try {
        if (!res.writableEnded) res.end();
      } catch (_) {}
    }
  });

  req.on('close', () => {
    try {
      upstreamReq.destroy();
    } catch (_) {}
  });

  if (bodyBuffer && bodyBuffer.length > 0) {
    upstreamReq.write(bodyBuffer);
  }

  upstreamReq.end();
}

// ==================== 主服务 ====================

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      return handleOptions(res);
    }

    const targetUrl = parseTargetFromPath(req.url);

    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      return sendJson(res, req.method, 400, {
        error: 'Invalid target URL'
      });
    }

    let bodyBuffer = Buffer.alloc(0);
    let bodyOverride = null;
    let directStatusCode = null;
    let removeLeadingSpace = false;
    let emptyReturnStatusCode = null;
    let requestWantsStream = String(req.headers.accept || '').includes('text/event-stream');

    if (!['GET', 'HEAD'].includes(req.method)) {
      try {
        bodyBuffer = await collectRequestBody(req);
      } catch (e) {
        console.error('[auto-switch] collect request body failed:', e.message);

        if (/too large/i.test(e.message)) {
          return sendJson(res, req.method, 413, {
            error: 'Payload Too Large',
            message: e.message
          });
        }

        throw e;
      }

      const contentType = String(req.headers['content-type'] || '');

      if (contentType.includes('application/json') && bodyBuffer.length > 0) {
        try {
          const requestBody = JSON.parse(bodyBuffer.toString('utf8'));

          if (requestBody.stream === true) {
            requestWantsStream = true;
          }

          if (requestBody.model) {
            const originalModel = String(requestBody.model).trim();
            const decision = processModelString(originalModel, requestBody.messages);

            removeLeadingSpace = !!decision.removeLeadingSpace;
            emptyReturnStatusCode = decision.emptyReturnStatusCode || null;

            if (decision.action === 'status') {
              directStatusCode = decision.statusCode;
              console.log(`[auto-switch] Direct Status Triggered: ${originalModel} -> HTTP ${directStatusCode}`);
            } else {
              const finalModel = decision.model;

              requestBody.model = finalModel;
              bodyOverride = Buffer.from(JSON.stringify(requestBody), 'utf8');

              if (finalModel !== originalModel) {
                console.log(`[auto-switch] Model Rewrite: ${originalModel} -> ${finalModel}`);
              }

              if (removeLeadingSpace || emptyReturnStatusCode) {
                console.log(`[auto-switch] flags enabled: rm_sp=${removeLeadingSpace}, er_sc=${emptyReturnStatusCode || ''}, model=${finalModel}`);
              }
            }
          }
        } catch (e) {
          console.error('[auto-switch] Request parsing failed, passing through:', e.message);
        }
      }
    }

    if (directStatusCode !== null) {
      return buildDirectStatusResponse(res, req.method, directStatusCode);
    }

    const finalBody = bodyOverride || bodyBuffer;
    const headers = buildUpstreamHeaders(req.headers, finalBody);

    // 如果是流式请求，且没有 er_sc，需要尽早开始响应并发送心跳。
    // er_sc 需要先判断是否空回复，所以不能提前固定返回 200。
    if (requestWantsStream && !emptyReturnStatusCode) {
      return proxyRequestEarlySSE(
        req,
        res,
        targetUrl,
        finalBody,
        headers,
        removeLeadingSpace
      );
    }

    return proxyRequest(
      req,
      res,
      targetUrl,
      finalBody,
      headers,
      requestWantsStream,
      removeLeadingSpace,
      emptyReturnStatusCode
    );
  } catch (err) {
    console.error('[auto-switch] server error:', err);

    if (!res.headersSent) {
      return sendJson(res, req.method, 500, {
        error: 'Internal Server Error',
        message: err.message
      });
    }

    try {
      if (!res.writableEnded) res.end();
    } catch (_) {}
  }
});

// 关闭或放大 Node.js 自身超时，避免长请求被 Node 断掉
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 0;

server.on('clientError', (err, socket) => {
  console.error('[auto-switch] client error:', err.message);

  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch (_) {}
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[auto-switch] listening on ${PORT}`);
  console.log(`[auto-switch] MAX_BODY_BYTES=${MAX_BODY_BYTES}`);
  console.log(`[auto-switch] UPSTREAM_TIMEOUT_MS=${UPSTREAM_TIMEOUT_MS}`);
  console.log(`[auto-switch] HEARTBEAT_INTERVAL_MS=${HEARTBEAT_INTERVAL_MS}`);
});
