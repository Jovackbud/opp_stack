const { logInfo, logError } = require('./ops');

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5-mini',
  gemini: 'gemini-2.5-flash',
  openai_compatible: 'gemma-3-4b-it',
};

function providerName() {
  return String(process.env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();
}

function apiKeyFor(name) {
  return process.env[name] || process.env.LLM_API_KEY || '';
}

function modelFor(task) {
  const provider = providerName();
  const taskKey = task ? `LLM_${String(task).toUpperCase()}_MODEL` : '';
  return process.env[taskKey] || process.env.LLM_MODEL || DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
}

async function generateText({ prompt, maxTokens = 1000, task = 'default', json = false }) {
  if (!prompt || typeof prompt !== 'string') throw new Error('LLM prompt must be a non-empty string');
  const provider = providerName();
  const model = modelFor(task);
  const startedAt = Date.now();

  try {
    let output;
    if (provider === 'anthropic' || provider === 'claude') {
      output = await callAnthropic({ prompt, maxTokens, model });
    } else if (provider === 'openai') {
      output = await callOpenAI({ prompt, maxTokens, model, json });
    } else if (provider === 'gemini') {
      output = await callGemini({ prompt, maxTokens, model, json });
    } else if (provider === 'openai_compatible' || provider === 'gemma' || provider === 'local') {
      output = await callOpenAICompatible({ prompt, maxTokens, model, json });
    } else {
      throw new Error(`Unsupported LLM_PROVIDER "${provider}"`);
    }
    logInfo('llm_request_completed', { provider, model, task, json, elapsedMs: Date.now() - startedAt });
    return output;
  } catch (err) {
    logError('llm_request_failed', err, { provider, model, task, json, elapsedMs: Date.now() - startedAt });
    throw err;
  }
}

async function callAnthropic({ prompt, maxTokens, model }) {
  const apiKey = apiKeyFor('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY or LLM_API_KEY');
  const data = await postJson('https://api.anthropic.com/v1/messages', {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  }, {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  });
  return data.content?.map(part => part.text || '').join('') || '';
}

async function callOpenAI({ prompt, maxTokens, model, json }) {
  const apiKey = apiKeyFor('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY or LLM_API_KEY');
  const body = {
    model,
    input: prompt,
    max_output_tokens: maxTokens,
    store: false,
  };
  if (json) body.text = { format: { type: 'json_object' } };

  const data = await postJson('https://api.openai.com/v1/responses', body, {
    Authorization: `Bearer ${apiKey}`,
  });
  return data.output_text || extractOpenAIText(data);
}

async function callGemini({ prompt, maxTokens, model, json }) {
  const apiKey = apiKeyFor('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY or LLM_API_KEY');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };

  const data = await postJson(endpoint, body, { 'x-goog-api-key': apiKey });
  return data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
}

async function callOpenAICompatible({ prompt, maxTokens, model, json }) {
  const baseUrl = String(process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const apiKey = process.env.LLM_API_KEY || 'local';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  const data = await postJson(`${baseUrl}/chat/completions`, body, {
    Authorization: `Bearer ${apiKey}`,
  });
  return data.choices?.[0]?.message?.content || '';
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 30000)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function extractOpenAIText(data) {
  return (data.output || [])
    .flatMap(item => item.content || [])
    .map(content => content.text || '')
    .join('');
}

module.exports = { generateText, modelFor, providerName };
