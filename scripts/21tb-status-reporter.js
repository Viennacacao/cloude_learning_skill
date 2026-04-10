const fs = require('fs');
const path = require('path');

const LOG_COLORS = {
  info: '\x1b[36m',
  success: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createSessionId(scriptName) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${scriptName}-${stamp}-${process.pid}`;
}

function toPlainJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return { serializationError: error.message };
  }
}

function mergeState(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }

  const output = target && typeof target === 'object' && !Array.isArray(target)
    ? { ...target }
    : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = mergeState(output[key], value);
    } else {
      output[key] = value;
    }
  }

  return output;
}

function createRunReporter({ scriptName, jsonMode = false, baseDir }) {
  const runtimeDir = baseDir || path.join(__dirname, '..', 'runtime-logs');
  ensureDir(runtimeDir);

  const sessionId = createSessionId(scriptName);
  const eventLogPath = path.join(runtimeDir, `${sessionId}.events.jsonl`);
  const statePath = path.join(runtimeDir, `${sessionId}.state.json`);

  fs.writeFileSync(eventLogPath, '', 'utf-8');

  let state = {
    sessionId,
    scriptName,
    jsonMode,
    status: 'starting',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: {
      eventLogPath,
      statePath,
    },
  };

  function writeState() {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  function writeHumanLog(message, level = 'info') {
    const time = new Date().toLocaleTimeString();
    const color = LOG_COLORS[level] || LOG_COLORS.info;
    const stream = jsonMode ? process.stderr : process.stdout;
    stream.write(`${color}[${time}] ${message}${LOG_COLORS.reset}\n`);
  }

  function emit(eventType, payload = {}, level = 'info') {
    const safePayload = toPlainJson(payload) || {};
    const event = {
      type: eventType,
      level,
      timestamp: new Date().toISOString(),
      sessionId,
      scriptName,
      ...safePayload,
    };

    fs.appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, 'utf-8');
    state = mergeState(state, {
      lastEvent: event,
      status: safePayload.status || state.status,
    });
    writeState();

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }

    return event;
  }

  function updateState(patch = {}) {
    const safePatch = toPlainJson(patch) || {};
    state = mergeState(state, safePatch);
    writeState();
    return state;
  }

  function log(message, level = 'info', options = {}) {
    writeHumanLog(message, level);
    if (options.eventType) {
      emit(options.eventType, {
        message,
        ...(options.payload || {}),
      }, level);
    }
  }

  function getState() {
    return toPlainJson(state) || {};
  }

  function close(status = 'completed', extra = {}) {
    updateState({
      status,
      finishedAt: new Date().toISOString(),
      ...toPlainJson(extra),
    });
    emit('run_finished', {
      status,
      ...toPlainJson(extra),
    }, status === 'failed' ? 'error' : 'success');
  }

  writeState();
  emit('run_initialized', {
    status: 'starting',
    files: {
      eventLogPath,
      statePath,
    },
  }, 'info');

  return {
    sessionId,
    eventLogPath,
    statePath,
    jsonMode,
    emit,
    log,
    close,
    getState,
    updateState,
  };
}

module.exports = {
  createRunReporter,
};
