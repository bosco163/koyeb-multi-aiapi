const http = require('http');
const https = require('https');
const { URL } = require('url');

// === 配置区 ===
const PORT = process.env.PORT || 9000;
// 若设置 API_KEY，则强制覆盖客户端 Authorization；留空则透传客户端原始 Authorization
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

function buildDirectStatusResponse(res, statusCode) {
  setCorsHeaders(res);
  res.writeHead(statusCode);
  res.end();
}

// 核心逻辑：解析模型字符串
// 支持：
// 1) baseModel[tk>=1000:targetModel]
// 2) baseModel[pt>2:targetModel]
// 3) baseModel[tk>=1000,pt>2:targetModel] (AND)
// 4) baseModel[tk>=1000:sc=403] (直接返回状态码)
function processModelString(modelStr, messages) {
  modelStr = String(modelStr || '').trim();

  const match = modelStr.match(/^([^[]+)\[([^:]+):([^\]]+)\]$/);
  if (!match) {
    return { action: 'model', model: modelStr };
  }

  const baseModel = match[1].trim();
  const conditionsStr = match[2].trim();
  const targetStr = match[3].trim();

  const parsedConditions = parseConditions(conditionsStr);
  if (!parsedConditions.valid) {
    return { action: 'model', model: modelStr };
  }

  const metrics = analyzeMessages(messages);
  const conditionMet = evaluateConditions(parsedConditions.conditions, metrics);

  console.log('[auto-switch] metrics:', JSON.stringify({
    baseModel,
    conditionsStr,
    targetStr,
    metrics,
    conditionMet
  }));

  if (!conditionMet) {
    return { action: 'model', model: baseModel };
  }

  const statusMatch = targetStr.match(/^sc\s*=\s*(\d{3})$/i);
  if (statusMatch) {
    const statusCode = parseInt(statusMatch[1], 10);
    if (statusCode >= 100 && statusCode <= 599) {
      return { action: 'status', statusCode };
    }
    return { action: 'model', model: baseModel };
  }

  return { action: 'model', model: targetStr };
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
    }

    if (!passed) return false;
  }

  return true;
}

// 更宽松的图片识别，修正 pt 参数“没反应”的常见问题
function analyzeMessages(messages) {
  let totalChars = 0;
  let cjkCount = 0;
  let imageCount = 0;

  if (Array.isArray(messages)) {
    messages.forEach(msg => {
      if (!msg || msg.content == null) return;

      let textContent = '';

      if (typeof msg.content === 'string') {
        textContent += msg.content;
      } else if (Array.isArray(msg.content)) {
        msg.content.forEach(part => {
          if (!part) return;

          // 文本
          if (part.type === 'text' && typeof part.text === 'string') {
            textContent += part.text;
            return;
          }

          // 图片：兼容多种 OpenAI/兼容格式
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

  if (totalChars > 0) {
    const text = ''; // 保留结构，不再重复拼整体文本
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
        if (cjkMatches) {
          cjkCount += cjkMatches.length;
        }
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

function parseTargetFromPath(reqUrl) {
  const urlObj = new URL(reqUrl, 'http://127.0.0.1');
  let path = urlObj.pathname;

  if (path.startsWith('/')) path = path.slice(1);

  // 去掉 /auto-switch 前缀
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

function proxyRequest(req, res, targetUrl, bodyBuffer, headers, preferSSE) {
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

  const upstreamReq = client.request(options, upstreamRes => {
    const responseHeaders = { ...upstreamRes.headers };
    responseHeaders['access-control-allow-origin'] = '*';

    res.writeHead(upstreamRes.statusCode || 500, responseHeaders);

    let heartbeatInterval = null;
    const contentType = String(upstreamRes.headers['content-type'] || '');

    if (preferSSE || contentType.includes('text/event-stream')) {
      heartbeatInterval = setInterval(() => {
        try {
          res.write(': keep-alive\n\n');
        } catch (e) {
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
  });

  upstreamReq.on('error', err => {
    console.error('[auto-switch] proxy request error:', err);
    setCorsHeaders(res);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Bad Gateway',
      message: err.message
    }));
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
      setCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'Invalid target URL'
      }));
    }

    let bodyBuffer = Buffer.alloc(0);
    let bodyOverride = null;
    let directStatusCode = null;

    if (!['GET', 'HEAD'].includes(req.method)) {
      bodyBuffer = await collectRequestBody(req);

      const contentType = String(req.headers['content-type'] || '');
      if (contentType.includes('application/json') && bodyBuffer.length > 0) {
        try {
          const requestBody = JSON.parse(bodyBuffer.toString('utf8'));

          if (requestBody.model) {
            const originalModel = String(requestBody.model).trim();
            const decision = processModelString(originalModel, requestBody.messages);

            if (decision.action === 'status') {
              directStatusCode = decision.statusCode;
              console.log(`[auto-switch] Direct Status Triggered: ${originalModel} -> HTTP ${directStatusCode}`);
            } else {
              const finalModel = decision.model;
              if (finalModel !== originalModel) {
                requestBody.model = finalModel;
                bodyOverride = Buffer.from(JSON.stringify(requestBody), 'utf8');
                console.log(`[auto-switch] Model Switch: ${originalModel} -> ${finalModel}`);
              }
            }
          }
        } catch (e) {
          console.error('[auto-switch] Request parsing failed, passing through:', e.message);
        }
      }
    }

    if (directStatusCode !== null) {
      return buildDirectStatusResponse(res, directStatusCode);
    }

    const headers = { ...req.headers };

    delete headers.host;
    delete headers['content-length'];
    delete headers['cf-connecting-ip'];
    delete headers['cf-ipcountry'];
    delete headers['cf-visitor'];
    delete headers['cf-worker'];

    const finalBody = bodyOverride || bodyBuffer;

    if (finalBody && finalBody.length > 0) {
      headers['content-length'] = Buffer.byteLength(finalBody);
    }

    if (API_KEY) {
      headers['authorization'] = `Bearer ${API_KEY}`;
    }

    const preferSSE = String(req.headers.accept || '').includes('text/event-stream');
    return proxyRequest(req, res, targetUrl, finalBody, headers, preferSSE);
  } catch (err) {
    console.error('[auto-switch] server error:', err);
    setCorsHeaders(res);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Internal Server Error',
      message: err.message
    }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[auto-switch] listening on ${PORT}`);
});
