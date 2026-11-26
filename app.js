/* =====================================================================
   AI Study Assistant  (HTML + CSS + vanilla JS only, BYOK)
   The user pastes their own API key. The provider is detected from the
   key format, so no key or backend is ever stored in this repository.
   Sections: 1 Config | 2 Helpers | 3 Theme | 4 API key | 5 Prompt |
             6 API call | 7 Parse/validate | 8 Renderers | 9 History |
             10 Progress | 11 Events
   ===================================================================== */

/* ---------- 1. Config ---------- */
const MAX_CHARS = 8000;
const WARN_CHARS = 6000;

// One entry per supported provider. Edit model names here if one is retired.
// `model` = default; `fallback` = list used if the live model list cannot be fetched.
// The live list (listUrl) only returns models that are currently available.
const PROVIDERS = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    model: 'gemini-2.5-flash',
    fallback: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    matches: (k) => /^AIza/.test(k),
    listUrl: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    listHeaders: (key) => ({ 'x-goog-api-key': key }),
    parseModels: (json) => (json?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      // text models only (JSON mode needs Gemini family; skip audio/image/embedding variants)
      .filter((id) => id.startsWith('gemini') && !/tts|image|embedding|live|audio|robotics|computer-use|aqa|learnlm/.test(id)),
    request(key, prompt, model) {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        },
      };
    },
    extract: (json) => json?.candidates?.[0]?.content?.parts?.[0]?.text,
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    model: 'llama-3.3-70b-versatile',
    fallback: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    matches: (k) => /^gsk_/.test(k),
    listUrl: 'https://api.groq.com/openai/v1/models',
    listHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: (json) => (json?.data || []).map((m) => m.id)
      .filter((id) => !/whisper|tts|guard|orpheus|playai|embed/.test(id)),
    request: (key, prompt, model) => openAiStyle('https://api.groq.com/openai/v1/chat/completions', key, prompt, model),
    extract: (json) => json?.choices?.[0]?.message?.content,
  },
  xai: {
    id: 'xai',
    name: 'xAI Grok',
    model: 'grok-3-mini',
    fallback: ['grok-3-mini', 'grok-3'],
    matches: (k) => /^xai-/.test(k),
    listUrl: 'https://api.x.ai/v1/models',
    listHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: (json) => (json?.data || []).map((m) => m.id).filter((id) => !/image|imagine|video/.test(id)),
    request: (key, prompt, model) => openAiStyle('https://api.x.ai/v1/chat/completions', key, prompt, model),
    extract: (json) => json?.choices?.[0]?.message?.content,
  },
};

// Groq and xAI both use the OpenAI chat-completions format.
function openAiStyle(url, key, prompt, model) {
  return {
    url,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: {
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    },
  };
}

const STYLE_TEXT = {
  standard: 'Write a clear, balanced summary.',
  eli10: 'Explain like I am 10 years old: very simple words, short sentences, friendly analogies.',
  exam: 'Be exam-focused: key definitions, formulas, likely exam points, in tight bullet-like sentences.',
  detailed: 'Be detailed and thorough, covering all important concepts and their relationships.',
};

/* ---------- 2. Helpers / DOM refs ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  apiKey: $('apiKey'), showKey: $('show-key'), saveKey: $('saveApiKey'), providerInfo: $('provider-info'),
  modelSelect: $('model'), modelNote: $('model-note'),
  notes: $('notes-input'), charCount: $('char-count'), style: $('style'), difficulty: $('difficulty'),
  generate: $('generate'), regenerate: $('regenerate'), loading: $('loading'), status: $('status'),
  outputs: $('outputs'), summary: $('summary'), quiz: $('quiz'), flashcards: $('flashcards'),
  knownCount: $('known-count'), copy: $('copy-summary'), download: $('download-summary'), speak: $('speak-summary'),
  progress: $('progress'), historyList: $('history-list'), historyEmpty: $('history-empty'),
  historySearch: $('history-search'), clearHistory: $('clear-history'), theme: $('toggle-theme'),
};

let isBusy = false;      // true while a request is running (blocks double clicks)
let lastRequest = null;  // {notes, style, difficulty} used by Regenerate

class AppError extends Error {} // errors with a message safe to show the user

function showStatus(message, type = 'info') {
  el.status.textContent = message;
  el.status.className = `status ${type}`;
  el.status.hidden = false;
}
function clearStatus() { el.status.hidden = true; el.status.textContent = ''; }

function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
// Storage can be full or blocked (private mode): never let that crash the app.
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { showStatus('Could not save to browser storage (it may be full or blocked).', 'error'); }
}

/* ---------- 3. Theme ---------- */
function applyTheme(theme) {
  document.body.classList.toggle('dark', theme === 'dark');
  el.theme.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  el.theme.setAttribute('aria-pressed', String(theme === 'dark'));
  localStorage.setItem('theme', theme);
}

/* ---------- 4. API key / provider detection ---------- */
function detectProvider(key) {
  return Object.values(PROVIDERS).find((p) => p.matches(key)) || null;
}

function updateProviderInfo() {
  const key = el.apiKey.value.trim();
  if (!key) {
    el.providerInfo.textContent = 'No key entered. The provider is detected automatically from your key. Stored only in this browser.';
    return;
  }
  const p = detectProvider(key);
  el.providerInfo.textContent = p
    ? `Detected provider: ${p.name}.`
    : 'Key format not recognised. Supported: Gemini (AIza...), Groq (gsk_...), xAI Grok (xai-...).';
}

/* Model dropdown: filled from the provider's live model list (so retired models are not offered). */
let modelRequestId = 0; // ignores stale responses if the key changes mid-request

function selectedModel(provider) { return el.modelSelect.value || provider.model; }

function fillModels(provider, ids, note) {
  el.modelSelect.replaceChildren();
  if (!provider) {
    el.modelSelect.add(new Option('Enter a valid key first', ''));
    el.modelSelect.disabled = true;
    el.modelNote.textContent = '';
    return;
  }
  const unique = [...new Set(ids)];
  unique.forEach((id) => el.modelSelect.add(new Option(id, id)));
  const saved = localStorage.getItem(`model:${provider.id}`);
  el.modelSelect.value = unique.includes(saved) ? saved : unique.includes(provider.model) ? provider.model : unique[0];
  el.modelSelect.disabled = false;
  el.modelNote.textContent = note;
}

async function loadModels() {
  const key = el.apiKey.value.trim();
  const provider = detectProvider(key);
  const myId = ++modelRequestId;
  if (!provider) { fillModels(null, []); return; }

  fillModels(provider, provider.fallback, 'Loading available models...');
  try {
    const res = await fetch(provider.listUrl, { headers: provider.listHeaders(key) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = provider.parseModels(await res.json()).sort().reverse(); // newest versions first
    if (myId !== modelRequestId) return;
    if (!ids.length) throw new Error('empty list');
    fillModels(provider, ids, `${ids.length} models currently available for your key.`);
  } catch {
    if (myId !== modelRequestId) return;
    fillModels(provider, provider.fallback, 'Could not load the live model list (check your key / connection). Showing common models.');
  }
}

let modelTimer;
const loadModelsSoon = () => { clearTimeout(modelTimer); modelTimer = setTimeout(loadModels, 600); };

function updateButtons() {
  const ready = el.apiKey.value.trim() && el.notes.value.trim();
  el.generate.disabled = isBusy || !ready;
  el.regenerate.disabled = isBusy || !lastRequest || !el.apiKey.value.trim();
}

/* ---------- 5. Prompt ---------- */
function buildPrompt(notes, style, difficulty) {
  return `You are a study assistant. Turn the notes below into study material.
Style for the summary: ${STYLE_TEXT[style] || STYLE_TEXT.standard}
Quiz difficulty: ${difficulty}.

Reply ONLY with valid JSON, no markdown, in exactly this format:
{
  "summary": "string",
  "quiz": [
    { "question": "string", "options": ["A", "B", "C", "D"], "answer": "must be exactly one of the options" }
  ],
  "flashcards": [ { "front": "string", "back": "string" } ]
}
Rules: exactly 5 quiz questions with 4 options each; 6 to 10 flashcards.

Notes:
"""${notes}"""`;
}

/* ---------- 6. API call ---------- */
async function callAI(key, prompt) {
  const provider = detectProvider(key);
  if (!provider) {
    throw new AppError('Unrecognised API key format. Use a Gemini (AIza...), Groq (gsk_...) or xAI Grok (xai-...) key.');
  }
  const { url, headers, body } = provider.request(key, prompt, selectedModel(provider));

  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    // fetch only rejects on network failure / CORS / offline
    throw new AppError('Network error: could not reach the AI service. Check your internet connection and try again.');
  }

  if (!response.ok) throw new AppError(describeHttpError(response.status, provider.name));

  let json;
  try { json = await response.json(); }
  catch { throw new AppError('The AI service sent a response that is not valid JSON.'); }

  console.log('Raw AI response:', json); // handy while learning the response shape
  const text = provider.extract(json);
  if (typeof text !== 'string' || !text.trim()) {
    throw new AppError('The AI returned an empty reply (it may have been blocked). Try again or rephrase your notes.');
  }
  return text;
}

function describeHttpError(status, providerName) {
  if (status === 400) return `${providerName} rejected the request (400). Your API key may be invalid, or the notes are unsuitable.`;
  if (status === 401 || status === 403) return `${providerName} says your API key is wrong or not allowed (${status}). Check the key in Settings.`;
  if (status === 404) return `${providerName} could not find the model (404). The model name in app.js may be retired.`;
  if (status === 429) return `Rate limit reached (429). You are sending too many requests or hit the free quota. Wait a minute and retry.`;
  if (status >= 500) return `${providerName} is having problems (${status}). Please try again later.`;
  return `Unexpected error from ${providerName} (HTTP ${status}).`;
}

/* ---------- 7. Parse + validate ---------- */
function parseAIResponse(text) {
  // Strip ```json fences and any chatter around the JSON object.
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new AppError('The AI reply was not in the expected JSON format. Please try again.');
  cleaned = cleaned.slice(start, end + 1);

  let data;
  try { data = JSON.parse(cleaned); }
  catch { throw new AppError('The AI reply was not valid JSON. Please try again.'); }
  return validateStudyData(data);
}

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

function validateStudyData(data) {
  if (!data || !isText(data.summary)) throw new AppError('The AI reply is missing the summary. Please try again.');
  if (!Array.isArray(data.quiz) || data.quiz.length === 0) throw new AppError('The AI reply is missing the quiz questions. Please try again.');
  if (!Array.isArray(data.flashcards) || data.flashcards.length === 0) throw new AppError('The AI reply is missing the flashcards. Please try again.');

  const quiz = data.quiz.map((q) => {
    if (!q || !isText(q.question) || !Array.isArray(q.options) || q.options.length < 2 || !q.options.every(isText)) {
      throw new AppError('A quiz question in the AI reply is malformed. Please try again.');
    }
    const options = q.options.map(String);
    let answer = String(q.answer ?? '').trim();
    // Accept a letter ("B") instead of the full option text.
    const letter = answer.match(/^([A-Za-z])[).:]?$/);
    if (letter && options[letter[1].toUpperCase().charCodeAt(0) - 65]) answer = options[letter[1].toUpperCase().charCodeAt(0) - 65];
    const matched = options.find((o) => o.trim().toLowerCase() === answer.toLowerCase());
    if (!matched) throw new AppError('A quiz answer in the AI reply does not match its options. Please try again.');
    return { question: q.question, options, answer: matched };
  });

  const flashcards = data.flashcards.map((c) => {
    if (!c || !isText(c.front) || !isText(c.back)) throw new AppError('A flashcard in the AI reply is malformed. Please try again.');
    return { front: String(c.front), back: String(c.back) };
  });

  return { summary: data.summary.trim(), quiz, flashcards };
}

/* ---------- 8. Renderers (textContent only: AI output is never trusted as HTML) ---------- */
let knownCards = new Set();

function renderSummary(text) { el.summary.textContent = text; }

function renderQuiz(quiz) {
  el.quiz.replaceChildren();
  const form = document.createElement('form');
  const resultP = document.createElement('p');
  resultP.className = 'quiz-result';
  resultP.setAttribute('role', 'status');

  quiz.forEach((q, i) => {
    const fs = document.createElement('fieldset');
    fs.className = 'quiz-q';
    const legend = document.createElement('legend');
    legend.textContent = `${i + 1}. ${q.question}`;
    fs.appendChild(legend);

    q.options.forEach((opt) => {
      const label = document.createElement('label');
      label.className = 'quiz-opt';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = `q${i}`; radio.value = opt;
      label.append(radio, document.createTextNode(opt));
      fs.appendChild(label);
    });
    form.appendChild(fs);
  });

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Submit quiz';
  form.append(submit, resultP);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let score = 0;
    quiz.forEach((q, i) => {
      const labels = [...form.querySelectorAll(`input[name="q${i}"]`)].map((r) => r.parentElement);
      labels.forEach((label) => {
        const radio = label.querySelector('input');
        radio.disabled = true;
        label.classList.remove('correct', 'wrong');
        if (radio.value === q.answer) label.classList.add('correct'); // always show the right answer
        else if (radio.checked) label.classList.add('wrong');
      });
      if (form.querySelector(`input[name="q${i}"]:checked`)?.value === q.answer) score++;
    });
    resultP.textContent = `Your score: ${score} / ${quiz.length}. Correct answers are highlighted in green.`;
    submit.disabled = true;
    recordScore(score, quiz.length);
  });

  el.quiz.appendChild(form);
}

function renderFlashcards(cards) {
  el.flashcards.replaceChildren();
  knownCards = new Set();
  cards.forEach((card, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'flashcard-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flashcard';
    // aria-label must carry the visible side's text, otherwise screen readers only hear "Flashcard N".
    const label = (flipped) => `Flashcard ${i + 1}, ${flipped ? 'answer' : 'question'}: ${flipped ? card.back : card.front}. Press to flip.`;
    btn.setAttribute('aria-label', label(false));
    const front = document.createElement('span'); front.className = 'face front'; front.textContent = card.front;
    const back = document.createElement('span'); back.className = 'face back'; back.textContent = card.back;
    front.setAttribute('aria-hidden', 'true'); back.setAttribute('aria-hidden', 'true');
    btn.append(front, back);
    btn.addEventListener('click', () => {
      const flipped = btn.classList.toggle('flipped');
      btn.setAttribute('aria-label', label(flipped));
    });

    const known = document.createElement('button');
    known.type = 'button';
    known.className = 'secondary known-btn';
    known.textContent = 'Known';
    known.setAttribute('aria-pressed', 'false');
    known.addEventListener('click', () => {
      const on = known.getAttribute('aria-pressed') !== 'true';
      known.setAttribute('aria-pressed', String(on));
      if (on) knownCards.add(i); else knownCards.delete(i);
      updateKnownCount(cards.length);
    });

    wrap.append(btn, known);
    el.flashcards.appendChild(wrap);
  });
  updateKnownCount(cards.length);
}

function updateKnownCount(total) { el.knownCount.textContent = `You know ${knownCards.size} of ${total} cards.`; }

function renderAll(data) {
  stopSpeaking();
  renderSummary(data.summary);
  renderQuiz(data.quiz);
  renderFlashcards(data.flashcards);
  el.outputs.hidden = false;
  activateTab('summary');
}

/* Tabs (ARIA tablist with arrow-key support) */
function activateTab(name) {
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`${tab.dataset.tab}-panel`).hidden = !on;
  });
}

/* Summary tools */
async function copySummary() {
  try {
    await navigator.clipboard.writeText(el.summary.textContent);
    showStatus('Summary copied to clipboard.', 'success');
  } catch {
    showStatus('Could not copy. Select the summary text and copy it manually.', 'error');
  }
}

function downloadSummary() {
  const blob = new Blob([el.summary.textContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'summary.txt';
  a.click();
  URL.revokeObjectURL(url);
}

function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  el.speak.setAttribute('aria-pressed', 'false');
  el.speak.textContent = 'Read aloud';
}

function toggleSpeak() {
  if (!('speechSynthesis' in window)) { showStatus('Your browser does not support text to speech.', 'error'); return; }
  if (el.speak.getAttribute('aria-pressed') === 'true') { stopSpeaking(); return; }
  const utter = new SpeechSynthesisUtterance(el.summary.textContent);
  utter.onend = stopSpeaking;
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
  el.speak.setAttribute('aria-pressed', 'true');
  el.speak.textContent = 'Stop reading';
}

/* ---------- 9. History ---------- */
// Drop corrupted entries (missing data) so one bad record cannot break the page.
const getHistory = () => {
  const raw = readStore('history', []);
  return Array.isArray(raw) ? raw.filter((h) => h && h.data && isText(h.data.summary) && Array.isArray(h.data.quiz) && Array.isArray(h.data.flashcards)) : [];
};

function saveToHistory(entry) {
  const history = getHistory();
  history.unshift(entry);
  writeStore('history', history.slice(0, 50)); // keep the 50 most recent
  renderHistory();
}

function renderHistory() {
  const term = el.historySearch.value.trim().toLowerCase();
  const all = getHistory();
  const history = all.filter((h) => !term || `${h.title} ${h.notes} ${h.data.summary}`.toLowerCase().includes(term));
  el.historyList.replaceChildren();
  el.historyEmpty.hidden = history.length > 0;
  el.historyEmpty.textContent = all.length ? 'No history matches your search.' : 'No saved generations yet.';

  history.forEach((entry) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = entry.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${new Date(entry.timestamp).toLocaleString()} · ${entry.provider} · ${entry.style} · ${entry.difficulty}`;
    btn.appendChild(meta);
    btn.addEventListener('click', () => {
      el.notes.value = entry.notes;
      el.style.value = entry.style;
      el.difficulty.value = entry.difficulty;
      lastRequest = { notes: entry.notes, style: entry.style, difficulty: entry.difficulty };
      onNotesInput();
      renderAll(entry.data);
      showStatus('Loaded from history.', 'info');
    });
    li.appendChild(btn);
    el.historyList.appendChild(li);
  });
}

/* ---------- 10. Quiz progress ---------- */
function recordScore(score, total) {
  const scores = readStore('quizScores', []);
  scores.push({ timestamp: Date.now(), score, total });
  writeStore('quizScores', scores.slice(-100));
  renderProgress();
}

function renderProgress() {
  const scores = readStore('quizScores', []);
  if (!scores.length) { el.progress.textContent = 'No quizzes taken yet.'; return; }
  const pct = scores.map((s) => Math.round((s.score / s.total) * 100));
  const avg = Math.round(pct.reduce((a, b) => a + b, 0) / pct.length);
  const recent = pct.slice(-5).map((p) => `${p}%`).join(', ');
  el.progress.textContent = `Quizzes taken: ${scores.length}. Average: ${avg}%. Best: ${Math.max(...pct)}%. Last results: ${recent}.`;
}

/* ---------- 11. Main flow + events ---------- */
async function generate(request) {
  const key = el.apiKey.value.trim();
  clearStatus();

  // Input validation: each case gives its own message.
  if (!key) return showStatus('No API key: paste your key in Settings first.', 'error');
  if (!request.notes.trim()) return showStatus('Your notes are empty. Paste notes or type a topic.', 'error');
  if (request.notes.length > MAX_CHARS) return showStatus(`Your notes are too long (max ${MAX_CHARS} characters).`, 'error');
  if (isBusy) return; // guard against double submit

  isBusy = true;
  el.loading.hidden = false;
  updateButtons();

  try {
    const prompt = buildPrompt(request.notes.trim(), request.style, request.difficulty);
    const text = await callAI(key, prompt);
    const data = parseAIResponse(text);

    lastRequest = request;
    renderAll(data);
    saveToHistory({
      id: Date.now(),
      timestamp: Date.now(),
      title: request.notes.trim().slice(0, 60) + (request.notes.trim().length > 60 ? '...' : ''),
      notes: request.notes,
      style: request.style,
      difficulty: request.difficulty,
      provider: detectProvider(key).name,
      data,
    });
    showStatus('Study material ready.', 'success');
  } catch (err) {
    console.error(err);
    showStatus(err instanceof AppError ? err.message : 'Something unexpected went wrong. Please try again.', 'error');
  } finally {
    isBusy = false;
    el.loading.hidden = true;
    updateButtons();
  }
}

function onNotesInput() {
  const len = el.notes.value.length;
  let msg = `${len} / ${MAX_CHARS} characters`;
  if (len > MAX_CHARS) msg += ' - too long, please shorten your notes.';
  else if (len >= WARN_CHARS) msg += ' - getting long, the AI may cut details.';
  el.charCount.textContent = msg;
  el.charCount.classList.toggle('warn', len >= WARN_CHARS);
  updateButtons();
}

el.theme.addEventListener('click', () => applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark'));

el.showKey.addEventListener('click', () => {
  const show = el.apiKey.type === 'password';
  el.apiKey.type = show ? 'text' : 'password';
  el.showKey.textContent = show ? 'Hide' : 'Show';
  el.showKey.setAttribute('aria-pressed', String(show));
});

el.apiKey.addEventListener('input', () => { updateProviderInfo(); updateButtons(); loadModelsSoon(); });

el.modelSelect.addEventListener('change', () => {
  const p = detectProvider(el.apiKey.value.trim());
  if (p) localStorage.setItem(`model:${p.id}`, el.modelSelect.value);
});

el.saveKey.addEventListener('click', () => {
  const key = el.apiKey.value.trim();
  if (key) { localStorage.setItem('apiKey', key); showStatus('API key saved in this browser only.', 'success'); }
  else { localStorage.removeItem('apiKey'); showStatus('API key removed.', 'info'); }
  updateProviderInfo();
  updateButtons();
});

el.notes.addEventListener('input', onNotesInput);

el.generate.addEventListener('click', () => generate({ notes: el.notes.value, style: el.style.value, difficulty: el.difficulty.value }));
el.regenerate.addEventListener('click', () => lastRequest && generate(lastRequest));

document.querySelectorAll('[role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  tab.addEventListener('keydown', (e) => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(tab);
    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
    if (next) { e.preventDefault(); activateTab(next.dataset.tab); next.focus(); }
  });
});

el.copy.addEventListener('click', copySummary);
el.download.addEventListener('click', downloadSummary);
el.speak.addEventListener('click', toggleSpeak);
el.historySearch.addEventListener('input', renderHistory);

el.clearHistory.addEventListener('click', () => {
  if (!getHistory().length) return showStatus('History is already empty.', 'info');
  if (confirm('Delete all saved history?')) {
    localStorage.removeItem('history');
    renderHistory();
    showStatus('History cleared.', 'info');
  }
});

/* ---------- Init ---------- */
applyTheme(localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
el.apiKey.value = localStorage.getItem('apiKey') || '';
updateProviderInfo();
loadModels();
onNotesInput();
renderHistory();
renderProgress();