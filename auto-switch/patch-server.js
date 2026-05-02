const fs = require('fs');

const file = '/app/auto-switch/server.js';

let s = fs.readFileSync(file, 'utf8');

function replaceOnce(from, to, name) {
  if (s.includes(to)) {
    console.log(`[patch-server] already patched: ${name}`);
    return;
  }

  if (!s.includes(from)) {
    console.warn(`[patch-server] target not found: ${name}`);
    return;
  }

  s = s.replace(from, to);
  console.log(`[patch-server] patched: ${name}`);
}

function replaceAll(from, to, name) {
  let count = 0;

  while (s.includes(from)) {
    s = s.replace(from, to);
    count++;
  }

  console.log(`[patch-server] patched ${name}: ${count}`);
}

// 1. 加进程级异常兜底
replaceOnce(
`const { StringDecoder } = require('string_decoder');

// ==================== 配置区 ====================`,
`const { StringDecoder } = require('string_decoder');

// ==================== 进程级异常兜底 ====================
//
// 尽量避免单个未捕获异常导致 auto-switch 直接退出。
// OOM 内存爆掉仍然会被 Koyeb 杀掉，这个兜不住。
//
process.on('uncaughtException', err => {
  console.error('[auto-switch] uncaughtException:', err);
});

process.on('unhandledRejection', err => {
  console.error('[auto-switch] unhandledRejection:', err);
});

// ==================== 配置区 ====================`,
'process exception handlers'
);

// 2. 加 backpressure 函数
replaceOnce(
`// ==================== 上游代理 ====================

function isSSEResponse(headers, preferSSE) {`,
`// ==================== 下游写入反压处理 ====================
//
// 客户端接收慢时，res.write() 会返回 false。
// 如果不暂停上游，数据会堆在 Node 内存里，容易 OOM 或中途断流。
//
function writeWithBackpressure(res, upstreamRes, chunk) {
  if (res.writableEnded) return;

  const ok = res.write(chunk);

  if (!ok && upstreamRes && typeof upstreamRes.pause === 'function') {
    try {
      upstreamRes.pause();
    } catch (_) {}

    res.once('drain', () => {
      if (!res.writableEnded) {
        try {
          upstreamRes.resume();
        } catch (_) {}
      }
    });
  }
}

// ==================== 上游代理 ====================

function isSSEResponse(headers, preferSSE) {`,
'writeWithBackpressure'
);

// 3. 精准替换几个高风险 res.write
replaceAll(
`if (!res.writableEnded) {
      res.write(chunk);
    }`,
`if (!res.writableEnded) {
      writeWithBackpressure(res, upstreamRes, chunk);
    }`,
'raw chunk write'
);

replaceAll(
`if (transformed && !res.writableEnded) {
      res.write(transformed);
    }`,
`if (transformed && !res.writableEnded) {
      writeWithBackpressure(res, upstreamRes, transformed);
    }`,
'transformed write'
);

replaceAll(
`if (tailOutput && !res.writableEnded) {
      res.write(tailOutput);
    }`,
`if (tailOutput && !res.writableEnded) {
      writeWithBackpressure(res, upstreamRes, tailOutput);
    }`,
'tailOutput write'
);

replaceAll(
`if (chunk && !res.writableEnded) {
        res.write(chunk);
      }`,
`if (chunk && !res.writableEnded) {
        writeWithBackpressure(res, upstreamRes, chunk);
      }`,
'pending chunk write'
);

replaceAll(
`} else if (req.method !== 'HEAD' && !res.writableEnded) {
        res.write(outgoingChunk);
      }`,
`} else if (req.method !== 'HEAD' && !res.writableEnded) {
        writeWithBackpressure(res, upstreamRes, outgoingChunk);
      }`,
'outgoingChunk write'
);

replaceAll(
`} else if (req.method !== 'HEAD' && !res.writableEnded) {
        res.write(outgoingEvent);
      }`,
`} else if (req.method !== 'HEAD' && !res.writableEnded) {
        writeWithBackpressure(res, upstreamRes, outgoingEvent);
      }`,
'outgoingEvent write'
);

// 4. 修复 proxyRequestEarlySSE 里面 req.close 误杀上游的问题
replaceOnce(
`  req.on('close', () => {
    try {
      upstreamReq.destroy();
    } catch (_) {}

    clearInterval(heartbeatInterval);
  });`,
`  res.on('close', () => {
    clearInterval(heartbeatInterval);

    if (res.writableEnded) {
      return;
    }

    try {
      upstreamReq.destroy();
    } catch (_) {}
  });`,
'early SSE close handler'
);

// 5. 修复 proxyRequest 里面 req.close 误杀上游的问题
replaceOnce(
`  req.on('close', () => {
    try {
      upstreamReq.destroy();
    } catch (_) {}
  });`,
` .on('close', () => {
    if (res.writableEnded) {
      return;
    }

    try {
      upstreamReq.destroy();
    } catch (_) {}
  });`,
'normal proxy close handler'
);

// 6. 流式请求/rm_sp/er_sc 强制 identity，避免 gzip/br 影响 SSE 和内容检测
replaceOnce(
`    const finalBody = bodyOverride || bodyBuffer;
    const headers = buildUpstreamHeaders(req.headers, finalBody);

    // 如果是流式请求，且没有 er_sc，需要尽早开始响应并发送心跳。`,
`    const finalBody = bodyOverride || bodyBuffer;
    const headers = buildUpstreamHeaders(req.headers, finalBody);

    // 流式请求、rm_sp、er_sc 都尽量要求上游不要 gzip/br 压缩。
    // 否则 SSE 可能异常，rm_sp/er_sc 也无法可靠处理。
    if (requestWantsStream || removeLeadingSpace || emptyReturnStatusCode) {
      headers['accept-encoding'] = 'identity';
    }

    // 如果是流式请求，且没有 er_sc，需要尽早开始响应并发送心跳。`,
'accept-encoding identity'
);

fs.writeFileSync(file, s);
console.log('[patch-server] done');
