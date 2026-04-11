const http = require('http');
const https = require('https');
const { URL } = require('url');
const { StringDecoder } = require('string_decoder');

// === 配置区 ===
const PORT = process.env.PORT || 9000;
// 若设置 API_KEY，则强制覆盖客户端 Authorization；留空则透传客户端原始 Authorization
// 特殊规则：若 API_KEY === "no_key"，则上游实际发送空 token（Bearer 后为空）
const API_KEY = process.env.API_KEY || '';
// 每张图片固定估算 Token
const FIXED_IMAGE_TOKENS = 85;

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
  setCorsHeaders(res);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': body.length
  });

  if (reqMethod === 'HEAD') {
    return res.end();
  }

  res.end(body);
}

function buildDirectStatusResponse(res, reqMethod, statusCode) {
  setCorsHeaders(res);
  res.writeHead(statusCode);

  if (reqMethod === 'HEAD') {
    return res.end();
  }

  res.end();
}

// 核心逻辑：解析模型字符串
// 支持：
// 0) baseModel[rm_sp]
// 1) baseModel[tk>=1000:targetModel]
// 2) baseModel[pt>2:targetModel]
// 3) baseModel[tk>=1000,pt>2:targetModel] (AND)
// 4) baseModel[tk>=1000:sc=403] (直接返回状态码)
// 5) [rm_sp] 可与以上规则混搭
// 6) [er_sc:429] 若上游 200 且 AI 空回，则改为指定状态码
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

  // 移除功能标签，避免传给上游
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

    return {
      action: 'model',
      model: baseModel,
      removeLeadingSpace,
      emptyReturnStatusCode
    };
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

  if (Array.isArray(messages)) {
    messages.forEach(msg => {
      if (!msg || msg.content == null) return;

      if (Array.isArray(msg.content)) {
        msg.content.forEach(part => {
          if (!part) return;

          const isImagePart =
            part.type === 'image_url' ||
            part.type === 'image' ||
            part.type === 'input_image' ||
            !!part.image_url ||
            !!part.image ||
            !!part.input_image ||
            (typeof part.url === 'string' && /^https?:\/\//i.test(part.url)) ||
            (typeof part.url === 'string' && /^data:image\//i.test(part.url));

          if (isImagePart) {
            imageCount++;
          }
        });
      }
    });
  }

  if (Array.isArray(messages)) {
    messages.forEach(msg => {
      if (!msg || msg.content == null) return;

      let textContent = '';
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && part.type === 'text' && typeof part.text === 'string') {
            textContent += part.text;
          }
        }
      }

      if (textContent) {
        totalChars += textContent.length;
        const cjkMatches = textContent.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
        if (cjkMatches) cjkCount += cjkMatches.length;
      }
    });
  }

  const nonCjkCount = totalChars - cjkCount;
  const textTokens = (cjkCount * 1.5) + (nonCjkCount / 4.0);
  const totalTokens = textTokens + (imageCount * FIXED_IMAGE_TOKENS);

  return {
    imageCount,
    estimatedTokens: Math.ceil(totalTokens * 1.05)
  };
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function collectResponseBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

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

// ========== API Key 处理 ==========

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

// ========== rm_sp 处理 ==========

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

  if (typeof item.text === 'string') {
    item.text = stripLeadingSpacesOnce(item.text, state, `${logicalKey}.text`);
  }

  if (typeof item.content === 'string') {
    item.content = stripLeadingSpacesOnce(item.content, state, `${logicalKey}.content`);
  }

  if (typeof item.output_text === 'string') {
    item.output_text = stripLeadingSpacesOnce(item.output_text, state, `${logicalKey}.output_text`);
  }

  if (typeof item.reasoning === 'string') {
    item.reasoning = stripLeadingSpacesOnce(item.reasoning, state, `${logicalKey}.reasoning`);
  }

  if (typeof item.reasoning_content === 'string') {
    item.reasoning_content = stripLeadingSpacesOnce(item.reasoning_content, state, `${logicalKey}.reasoning_content`);
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
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

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

// ========== empty return 检测 ==========
// 认 reasoning / reasoning_content 也算“AI 已回复”

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

    if (typeof part.text === 'string') {
      out += part.text;
      continue;
    }

    if (typeof part.content === 'string') {
      out += part.content;
      continue;
    }

    if (typeof part.output_text === 'string') {
      out += part.output_text;
      continue;
    }

    if (typeof part.reasoning === 'string') {
      out += part.reasoning;
      continue;
    }

    if (typeof part.reasoning_content === 'string') {
      out += part.reasoning_content;
      continue;
    }
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

  if (payload.message && typeof payload.message === 'object') {
    if (payloadHasVisibleContent(payload.message)) return true;
  }

  if (payload.delta && typeof payload.delta === 'object') {
    if (payloadHasVisibleContent(payload.delta)) return true;
  }

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

  if (!looksLikeJson) {
    return false;
  }

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
    return { hasDataLine: false, isDone: false, payload: null };
  }

  if (joinedData.trim() === '[DONE]') {
    return { hasDataLine: true, isDone: true, payload: null };
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

  if (!hasDataLine) {
    return rawEvent;
  }

  if (joinedData.trim() === '[DONE]') {
    return rawEvent;
  }

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

function transformSSEBuffer(rawBuffer, rmState) {
  if (!rawBuffer || rawBuffer.length === 0) return rawBuffer;

  const decoder = new StringDecoder('utf8');
  let text = decoder.write(rawBuffer);
  text += decoder.end();

  const parts = text.split(/(\r?\n\r?\n)/);
  let out = '';

  for (let i = 0; i < parts.length; i += 2) {
    const eventText = parts[i] || '';
    const sep = parts[i + 1] || '';
    if (!eventText && !sep) continue;
    out += processSSEEventWithRmSp(eventText, rmState) + sep;
  }

  return Buffer.from(out, 'utf8');
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

// ========== 上游代理 ==========

function isSSEResponse(headers, preferSSE) {
  const contentType = String(headers['content-type'] || '');
  return contentType.includes('text/event-stream') || (!contentType && preferSSE);
}

function pipeRawUpstreamResponse(upstreamRes, req, res, preferSSE) {
  const responseHeaders = { ...upstreamRes.headers };
  responseHeaders['access-control-allow-origin'] = '*';

  let heartbeatInterval = null;
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

  if (shouldHeartbeat) {
    heartbeatInterval = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch (_) {
        clearInterval(heartbeatInterval);
      }
    }, 20000);
  }

  upstreamRes.on('data', chunk => {
    res.write(chunk);
  });

  upstreamRes.on('end', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    res.end();
  });

  upstreamRes.on('error', err => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    console.error('[auto-switch] upstream stream error:', err);
    try { res.end(); } catch (_) {}
  });

  res.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  });
}

// 只有 rm_sp，且是 SSE：保持真正流式
function pipeUpstreamResponseWithRmSpSSEStreaming(upstreamRes, req, res) {
  const responseHeaders = { ...upstreamRes.headers };
  responseHeaders['access-control-allow-origin'] = '*';
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

  let heartbeatInterval = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (_) {
      clearInterval(heartbeatInterval);
    }
  }, 20000);

  upstreamRes.on('data', chunk => {
    const decoded = decoder.write(chunk);
    const transformed = transformSSEText(decoded, rmState, sseState);
    if (transformed) {
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

    if (tailOutput) {
      res.write(tailOutput);
    }

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    res.end();
  });

  upstreamRes.on('error', err => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    console.error('[auto-switch] upstream rm_sp SSE error:', err);
    try { res.end(); } catch (_) {}
  });

  res.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  });
}

// 只有 rm_sp，且非 SSE：缓冲改 JSON
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
    sendJson(res, req.method, 502, {
      error: 'Bad Gateway',
      message: err.message
    });
  });
}

// 有 er_sc 且非 SSE：缓冲判断
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

// 有 er_sc 且 SSE：先观察；一旦 AI 真开始回复（包括 reasoning），立即切换到流式转发
function pipeSSEWithEarlyContentDetection(upstreamRes, req, res, removeLeadingSpace, emptyReturnStatusCode) {
  const upstreamStatus = upstreamRes.statusCode || 500;
  const responseHeaders = { ...upstreamRes.headers };
  responseHeaders['access-control-allow-origin'] = '*';
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

    heartbeatInterval = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch (_) {
        clearInterval(heartbeatInterval);
      }
    }, 20000);

    for (const chunk of pendingOutputChunks) {
      if (chunk) res.write(chunk);
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
      } else if (req.method !== 'HEAD') {
        res.write(outgoingChunk);
      }
    }
  }

  upstreamRes.on('data', chunk => {
    const decoded = decoder.write(chunk);
    if (decoded) processDecodedText(decoded);
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
      } else if (req.method !== 'HEAD') {
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
    res.end();
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
      try { res.end(); } catch (_) {}
    }
  });

  res.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  });
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
          try { res.end(); } catch (_) {}
        }
      });
      return;
    }

    return pipeRawUpstreamResponse(upstreamRes, req, res, preferSSE);
  });

  upstreamReq.on('error', err => {
    console.error('[auto-switch] proxy request error:', err);
    sendJson(res, req.method, 502, {
      error: 'Bad Gateway',
      message: err.message
    });
  });

  if (bodyBuffer && bodyBuffer.length > 0) {
    upstreamReq.write(bodyBuffer);
  }

  upstreamReq.end();
}

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

    if (!['GET', 'HEAD'].includes(req.method)) {
      bodyBuffer = await collectRequestBody(req);

      const contentType = String(req.headers['content-type'] || '');
      if (contentType.includes('application/json') && bodyBuffer.length > 0) {
        try {
          const requestBody = JSON.parse(bodyBuffer.toString('utf8'));

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

    const headers = { ...req.headers };

    delete headers.host;
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    delete headers['cf-connecting-ip'];
    delete headers['cf-ipcountry'];
    delete headers['cf-visitor'];
    delete headers['cf-worker'];

    const finalBody = bodyOverride || bodyBuffer;

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

    const preferSSE = String(req.headers.accept || '').includes('text/event-stream');

    return proxyRequest(
      req,
      res,
      targetUrl,
      finalBody,
      headers,
      preferSSE,
      removeLeadingSpace,
      emptyReturnStatusCode
    );
  } catch (err) {
    console.error('[auto-switch] server error:', err);
    return sendJson(res, req.method, 500, {
      error: 'Internal Server Error',
      message: err.message
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[auto-switch] listening on ${PORT}`);
});
