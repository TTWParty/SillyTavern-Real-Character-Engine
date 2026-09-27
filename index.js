import {
  eventSource,
  event_types,
  saveSettingsDebounced,
  saveChatDebounced,
  saveChat,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

const EXTENSION_NAME = 'real_character_engine';
const EXTENSION_DISPLAY_NAME = '拟真角色模拟引擎';

const DEFAULT_SETTINGS = {
  enabled: true,
  serverUrl: 'http://127.0.0.1:4000',
  enableBurstMessaging: true,
  typingSpeedMultiplier: 1.0,
  showFloatingHud: true,
  hudPosition: { right: 24, bottom: 90 },
  hudCollapsed: false,
  enableAutonomy: false,
  autonomyIntervalSeconds: 60,
  enableMessageBadge: true,
};

let isGenerating = false;
let autonomyTimer = null;
let currentTelemetry = null;

// ==================== Settings Helper ====================
function getSettings() {
  if (!extension_settings[EXTENSION_NAME]) {
    extension_settings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
  }
  return extension_settings[EXTENSION_NAME];
}

function updateSettings(patch) {
  Object.assign(getSettings(), patch);
  saveSettingsDebounced();
}

function getUserName() {
  const ctx = getContext?.();
  return ctx?.name2 || ctx?.user_name || '玩家';
}

function getCurrentCharacter() {
  const ctx = getContext?.();
  if (!ctx || ctx.characterId === undefined || !ctx.characters) return null;
  return ctx.characters[ctx.characterId] || null;
}

// ==================== Backend Health & Sync ====================
async function checkBackendConnection() {
  const settings = getSettings();
  const statusEl = document.getElementById('rce-connection-status');
  if (statusEl) {
    statusEl.className = 'rce-status-badge rce-status-pending';
    statusEl.textContent = '检测中...';
  }

  const start = Date.now();
  try {
    const res = await fetch(`${settings.serverUrl}/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latency = Date.now() - start;
    if (statusEl) {
      statusEl.className = 'rce-status-badge rce-status-online';
      statusEl.textContent = `在线 (${latency}ms)`;
    }
    return true;
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'rce-status-badge rce-status-offline';
      statusEl.textContent = '服务离线';
    }
    return false;
  }
}

async function syncCharacterCardToBackend() {
  const char = getCurrentCharacter();
  if (!char) {
    if (typeof toastr !== 'undefined') toastr.warning('未选中有效角色卡');
    return;
  }

  const settings = getSettings();
  try {
    const res = await fetch(`${settings.serverUrl}/api/st/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        characterCard: {
          name: char.name,
          description: char.description || '',
          personality: char.personality || '',
          scenario: char.scenario || '',
          first_mes: char.first_mes || '',
          mes_example: char.mes_example || '',
        },
        userText: '（同步角色人设基线）',
        chatHistory: [],
      }),
    });
    const result = await res.json();
    if (result.ok) {
      if (typeof toastr !== 'undefined') toastr.success(`角色「${char.name}」认知数据库同步成功`);
      await fetchCharacterTelemetry(char.name);
    }
  } catch (err) {
    console.error(`[${EXTENSION_NAME}] Sync failed:`, err);
    if (typeof toastr !== 'undefined') toastr.error(`同步失败: ${err.message || err}`);
  }
}

async function fetchCharacterTelemetry(charName) {
  if (!charName) return;
  const settings = getSettings();
  try {
    const res = await fetch(`${settings.serverUrl}/api/st/telemetry/${encodeURIComponent(charName)}`);
    if (!res.ok) return;
    const json = await res.json();
    if (json.ok && json.data) {
      updateHudWithPersistedData(json.data);
    }
  } catch (err) {
    console.warn(`[${EXTENSION_NAME}] Telemetry query failed:`, err);
  }
}

// ==================== Cognitive HUD Component ====================
function ensureFloatingHud() {
  let hud = document.getElementById('rce-floating-hud');
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'rce-floating-hud';
    const settings = getSettings();
    hud.style.right = `${settings.hudPosition?.right || 24}px`;
    hud.style.bottom = `${settings.hudPosition?.bottom || 90}px`;
    document.body.appendChild(hud);
    initHudDraggable(hud);
  }
  renderHudContent();
}

function initHudDraggable(hudEl) {
  let isDragging = false;
  let startX, startY, initialRight, initialBottom;

  const header = hudEl;
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.rce-hud-btn') || e.target.closest('.rce-hud-body')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = hudEl.getBoundingClientRect();
    initialRight = window.innerWidth - rect.right;
    initialBottom = window.innerHeight - rect.bottom;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    const newRight = Math.max(10, Math.min(window.innerWidth - 100, initialRight - deltaX));
    const newBottom = Math.max(10, Math.min(window.innerHeight - 100, initialBottom - deltaY));
    hudEl.style.right = `${newRight}px`;
    hudEl.style.bottom = `${newBottom}px`;
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      const rect = hudEl.getBoundingClientRect();
      updateSettings({
        hudPosition: {
          right: Math.round(window.innerWidth - rect.right),
          bottom: Math.round(window.innerHeight - rect.bottom),
        },
      });
    }
  });
}

function renderHudContent() {
  const hud = document.getElementById('rce-floating-hud');
  if (!hud) return;
  const settings = getSettings();
  if (!settings.showFloatingHud) {
    hud.style.display = 'none';
    return;
  }
  hud.style.display = 'block';

  const char = getCurrentCharacter();
  const charName = char?.name || '未选角色';

  if (settings.hudCollapsed) {
    hud.innerHTML = `
      <div class="rce-hud-pill" id="rce-hud-pill-btn" title="点击展开拟真认知监视器">
        <div class="rce-pill-dot"></div>
        <div class="rce-pill-title">RCE 认知模拟</div>
        <div class="rce-pill-meta">${escapeHtml(charName)}</div>
      </div>
    `;
    document.getElementById('rce-hud-pill-btn')?.addEventListener('click', () => {
      updateSettings({ hudCollapsed: false });
      renderHudContent();
    });
    return;
  }

  const tel = currentTelemetry || {};
  const spotlight = tel.cognitiveSpotlight || {};
  const systemOne = tel.systemOne || {};
  const rel = tel.relationship || {};
  const emo = tel.emotion || {};
  const mask = tel.maskDissonance || {};

  const focusType = spotlight.focusType || '情境感知与议程推进';
  const salience = Math.round((spotlight.salienceScore ?? 0.3) * 100);
  const memoryOccupancy = Math.min(4, Math.round((spotlight.workingMemoryOccupancy ?? 0.25) * 4));
  const microText = systemOne.microReaction || systemOne.coarseInstinct || '心神平稳，专注当前对话';
  const tone = systemOne.emotionalTone || 'neutral';
  const pressure = systemOne.pressureLevel || 'low';

  const trustPercent = Math.round(((rel.trust ?? 0.5) + 1) * 50);
  const affectionPercent = Math.round(((rel.affection ?? 0.3) + 1) * 50);
  const resentmentPercent = Math.round((rel.resentment ?? 0) * 100);
  const intimacyPercent = Math.round((rel.intimacy ?? 0.3) * 100);

  hud.innerHTML = `
    <div class="rce-hud-panel">
      <div class="rce-hud-header">
        <div class="rce-hud-title-box">
          <div class="rce-pill-dot"></div>
          <span class="rce-hud-title">${escapeHtml(charName)} · 认知监视器</span>
        </div>
        <div class="rce-hud-controls">
          <button class="rce-hud-btn" id="rce-hud-collapse-btn" title="收起为悬浮球">_</button>
        </div>
      </div>
      <div class="rce-hud-body">
        <!-- System 1 Micro Section -->
        <div class="rce-hud-section">
          <div class="rce-hud-section-title">
            <span>System 1 潜意识微反应</span>
            <span>警戒: ${pressure.toUpperCase()}</span>
          </div>
          <div class="rce-system-one-box">
            <div class="rce-micro-text">${escapeHtml(microText)}</div>
            <div class="rce-tag-row">
              <span class="rce-tag">语调: ${tone}</span>
              ${systemOne.coarseInstinct ? `<span class="rce-tag">本能: ${systemOne.coarseInstinct}</span>` : ''}
              ${mask.isLeaking ? `<span class="rce-tag rce-tag-warning">人格面具泄漏: ${mask.leakageSeverity}</span>` : ''}
            </div>
          </div>
        </div>

        <!-- Cognitive Spotlight Section -->
        <div class="rce-hud-section">
          <div class="rce-hud-section-title">
            <span>认知聚光灯 · 工作记忆</span>
            <span>焦距: ${salience}%</span>
          </div>
          <div class="rce-meter-group">
            <div class="rce-meter-row">
              <div class="rce-meter-label-row">
                <span>当前注意力焦点: ${escapeHtml(focusType)}</span>
              </div>
              <div class="rce-meter-bar-bg">
                <div class="rce-meter-bar-fill rce-fill-spotlight" style="width: ${salience}%"></div>
              </div>
            </div>
            <div class="rce-meter-row">
              <div class="rce-meter-label-row">
                <span>工作记忆槽位 (米勒定律 4 槽位)</span>
                <span>${memoryOccupancy} / 4 占用</span>
              </div>
              <div class="rce-memory-slots">
                <div class="rce-memory-slot ${memoryOccupancy >= 1 ? 'occupied' : ''}"></div>
                <div class="rce-memory-slot ${memoryOccupancy >= 2 ? 'occupied' : ''}"></div>
                <div class="rce-memory-slot ${memoryOccupancy >= 3 ? 'occupied' : ''}"></div>
                <div class="rce-memory-slot ${memoryOccupancy >= 4 ? 'occupied' : ''}"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- PADS Emotion State -->
        <div class="rce-hud-section">
          <div class="rce-hud-section-title">PADS 动力学情感向量</div>
          <div class="rce-pads-grid">
            <div class="rce-pads-item">
              <div class="rce-pads-key">愉悦 (P)</div>
              <div class="rce-pads-val">${formatNum(emo.valence, 0.1)}</div>
            </div>
            <div class="rce-pads-item">
              <div class="rce-pads-key">激活 (A)</div>
              <div class="rce-pads-val">${formatNum(emo.arousal, 0.2)}</div>
            </div>
            <div class="rce-pads-item">
              <div class="rce-pads-key">支配 (D)</div>
              <div class="rce-pads-val">${formatNum(emo.dominance, 0.5)}</div>
            </div>
            <div class="rce-pads-item">
              <div class="rce-pads-key">安全 (S)</div>
              <div class="rce-pads-val">${formatNum(emo.safety, 0.8)}</div>
            </div>
            <div class="rce-pads-item">
              <div class="rce-pads-key">抑制 (I)</div>
              <div class="rce-pads-val">${formatNum(emo.inhibition, 0.4)}</div>
            </div>
            <div class="rce-pads-item">
              <div class="rce-pads-key">状态</div>
              <div class="rce-pads-val">稳定</div>
            </div>
          </div>
        </div>

        <!-- Relational Dynamics -->
        <div class="rce-hud-section">
          <div class="rce-hud-section-title">人际关系动力学</div>
          <div class="rce-meter-group">
            <div class="rce-meter-row">
              <div class="rce-meter-label-row">
                <span>信任度</span>
                <span>${trustPercent}%</span>
              </div>
              <div class="rce-meter-bar-bg">
                <div class="rce-meter-bar-fill rce-fill-trust" style="width: ${trustPercent}%"></div>
              </div>
            </div>
            <div class="rce-meter-row">
              <div class="rce-meter-label-row">
                <span>喜爱度</span>
                <span>${affectionPercent}%</span>
              </div>
              <div class="rce-meter-bar-bg">
                <div class="rce-meter-bar-fill rce-fill-affection" style="width: ${affectionPercent}%"></div>
              </div>
            </div>
            ${resentmentPercent > 0 ? `
              <div class="rce-meter-row">
                <div class="rce-meter-label-row">
                  <span style="color:#ef4444;font-weight:600;">怨念张力 (Resentment)</span>
                  <span style="color:#ef4444;font-weight:600;">${resentmentPercent}%</span>
                </div>
                <div class="rce-meter-bar-bg">
                  <div class="rce-meter-bar-fill rce-fill-resentment" style="width: ${resentmentPercent}%"></div>
                </div>
              </div>
            ` : ''}
            <div class="rce-meter-row">
              <div class="rce-meter-label-row">
                <span>亲密度</span>
                <span>${intimacyPercent}%</span>
              </div>
              <div class="rce-meter-bar-bg">
                <div class="rce-meter-bar-fill rce-fill-intimacy" style="width: ${intimacyPercent}%"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('rce-hud-collapse-btn')?.addEventListener('click', () => {
    updateSettings({ hudCollapsed: true });
    renderHudContent();
  });
}

function updateHudWithPersistedData(data) {
  if (!data) return;
  currentTelemetry = {
    relationship: data.relationship,
    emotion: data.character?.emotion,
    cognitiveSpotlight: {
      focusType: data.character?.explicitGoals?.[0] || '情境推进',
      salienceScore: 0.3,
      workingMemoryOccupancy: 0.25,
    },
    systemOne: {
      microReaction: '情绪平稳，专注人际交互',
      emotionalTone: 'neutral',
      pressureLevel: 'low',
    },
  };
  renderHudContent();
}

function formatNum(val, fallback) {
  const n = typeof val === 'number' ? val : fallback;
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== Animated Typing Indicator ====================
function showTypingIndicator(charName, avatarUrl) {
  removeTypingIndicator();
  const chatEl = document.getElementById('chat');
  if (!chatEl) return;

  const bubble = document.createElement('div');
  bubble.id = 'rce-typing-indicator-node';
  bubble.className = 'mes rce-typing-bubble';
  bubble.innerHTML = `
    ${avatarUrl ? `<img class="avatar" src="${avatarUrl}" />` : ''}
    <div class="rce-typing-dots">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <span class="rce-typing-label">${escapeHtml(charName)} 正在输入...</span>
  `;
  chatEl.appendChild(bubble);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function removeTypingIndicator() {
  const bubble = document.getElementById('rce-typing-indicator-node');
  if (bubble) bubble.remove();
}

// ==================== Generation Interception Engine ====================
function attachSendInterception() {
  const sendBtn = document.getElementById('send_but');
  const textarea = document.getElementById('send_textarea');

  if (sendBtn) {
    sendBtn.addEventListener('click', handleUserSendClick, true);
  }
  if (textarea) {
    textarea.addEventListener('keydown', handleUserTextareaKeydown, true);
  }
}

function handleUserSendClick(e) {
  const settings = getSettings();
  if (!settings.enabled) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  triggerRceGeneration();
}

function handleUserTextareaKeydown(e) {
  const settings = getSettings();
  if (!settings.enabled) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    triggerRceGeneration();
  }
}

async function triggerRceGeneration() {
  if (isGenerating) return;
  const textarea = document.getElementById('send_textarea');
  if (!textarea) return;
  const userText = textarea.value.trim();
  if (!userText) return;

  const char = getCurrentCharacter();
  if (!char) {
    if (typeof toastr !== 'undefined') toastr.warning('未选择有效角色，无法生成');
    return;
  }

  isGenerating = true;
  textarea.value = '';

  const ctx = getContext?.();
  const chat = ctx?.chat || [];
  const userName = getUserName();

  // 1. Append user message locally
  const userMsg = {
    is_user: true,
    is_system: false,
    name: userName,
    mes: userText,
    send_date: new Date().toISOString(),
  };
  chat.push(userMsg);
  if (typeof saveChatDebounced === 'function') saveChatDebounced();
  appendMessageToDom(userMsg, chat.length - 1);

  // 2. Prepare context payload
  const settings = getSettings();
  const recentHistory = chat.slice(-20).map((m) => ({
    is_user: !!m.is_user,
    name: m.name,
    mes: m.mes,
  }));

  const charCard = {
    name: char.name,
    description: char.description || '',
    personality: char.personality || '',
    scenario: char.scenario || '',
    first_mes: char.first_mes || '',
    mes_example: char.mes_example || '',
  };

  // 3. Show Typing Indicator
  const avatarUrl = char.avatar ? `/characters/${char.avatar}` : '';
  showTypingIndicator(char.name, avatarUrl);

  try {
    const res = await fetch(`${settings.serverUrl}/api/st/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        characterCard: charCard,
        chatHistory: recentHistory.slice(0, -1),
        userText: userText,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`服务返回错误 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.message || '引擎推理未成功');
    }

    // 4. Update HUD Telemetry
    if (data.telemetry) {
      currentTelemetry = data.telemetry;
      renderHudContent();
    }

    // 5. Sequential Burst Messaging Sequence
    const burstFrames = (data.burstFrames && data.burstFrames.length > 0)
      ? data.burstFrames
      : [{ text: data.text, typingDelayMs: 600 }];

    if (settings.enableBurstMessaging && burstFrames.length > 1) {
      for (let i = 0; i < burstFrames.length; i++) {
        const frame = burstFrames[i];
        const delay = Math.max(200, Math.round((frame.typingDelayMs || 800) / settings.typingSpeedMultiplier));
        showTypingIndicator(char.name, avatarUrl);
        await new Promise((r) => setTimeout(r, delay));
        removeTypingIndicator();

        const frameMsg = {
          is_user: false,
          is_system: false,
          name: char.name,
          mes: frame.text,
          send_date: new Date().toISOString(),
          extra: i === burstFrames.length - 1 ? { rce_telemetry: data.telemetry } : {},
        };
        chat.push(frameMsg);
        appendMessageToDom(frameMsg, chat.length - 1);
        if (typeof saveChatDebounced === 'function') saveChatDebounced();
      }
    } else {
      const delay = Math.min(1200, Math.max(300, Math.round(data.text.length * 15 / settings.typingSpeedMultiplier)));
      await new Promise((r) => setTimeout(r, delay));
      removeTypingIndicator();

      const finalMsg = {
        is_user: false,
        is_system: false,
        name: char.name,
        mes: data.text,
        send_date: new Date().toISOString(),
        extra: { rce_telemetry: data.telemetry },
      };
      chat.push(finalMsg);
      appendMessageToDom(finalMsg, chat.length - 1);
      if (typeof saveChatDebounced === 'function') saveChatDebounced();
    }
  } catch (err) {
    removeTypingIndicator();
    console.error(`[${EXTENSION_NAME}] Turn generation error:`, err);
    if (typeof toastr !== 'undefined') {
      toastr.error(`拟真引擎生成失败: ${err.message || err}`);
    }
  } finally {
    isGenerating = false;
    removeTypingIndicator();
  }
}

function appendMessageToDom(msg, index) {
  const chatEl = document.getElementById('chat');
  if (!chatEl) return;

  const char = getCurrentCharacter();
  const avatarUrl = msg.is_user ? '' : (char?.avatar ? `/characters/${char.avatar}` : '');

  const msgDiv = document.createElement('div');
  msgDiv.className = `mes ${msg.is_user ? 'is_user' : ''}`;
  msgDiv.setAttribute('mesid', String(index));

  let stampHtml = '';
  if (!msg.is_user && msg.extra?.rce_telemetry && getSettings().enableMessageBadge) {
    const t = msg.extra.rce_telemetry;
    const focus = t.cognitiveSpotlight?.focusType || '情境推进';
    const instinct = t.systemOne?.coarseInstinct || '稳健';
    stampHtml = `
      <div class="rce-message-stamp" title="点击查看本轮认知聚光灯与 System 1 微反应快照">
        <div class="rce-stamp-left">
          <div class="rce-stamp-dot"></div>
          <span>[RCE 拟真快照 · 焦点: ${escapeHtml(focus)} | 本能: ${escapeHtml(instinct)}]</span>
        </div>
        <span>12-Layer Sim</span>
      </div>
    `;
  }

  msgDiv.innerHTML = `
    ${avatarUrl ? `<img class="avatar" src="${avatarUrl}" />` : ''}
    <div class="ch_name"><b>${escapeHtml(msg.name)}</b></div>
    <div class="mes_text">${escapeHtml(msg.mes)}</div>
    ${stampHtml}
  `;

  msgDiv.querySelector('.rce-message-stamp')?.addEventListener('click', () => {
    if (msg.extra?.rce_telemetry) {
      currentTelemetry = msg.extra.rce_telemetry;
      updateSettings({ hudCollapsed: false, showFloatingHud: true });
      renderHudContent();
    }
  });

  chatEl.appendChild(msgDiv);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ==================== Autonomy Pulse Loop ====================
function setupAutonomyLoop() {
  if (autonomyTimer) {
    clearInterval(autonomyTimer);
    autonomyTimer = null;
  }

  const settings = getSettings();
  if (!settings.enableAutonomy) return;

  const intervalMs = Math.max(10, settings.autonomyIntervalSeconds || 60) * 1000;
  autonomyTimer = setInterval(async () => {
    if (isGenerating) return;
    const char = getCurrentCharacter();
    if (!char) return;

    try {
      const res = await fetch(`${settings.serverUrl}/api/st/autonomy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characterId: char.name,
          sessionId: `session_st_${char.name}`,
        }),
      });
      const data = await res.json();
      if (data.ok && !data.idle && data.result) {
        console.log(`[${EXTENSION_NAME}] Autonomous pulse executed:`, data.result);
        const text = data.result.text || data.result.actionDescription;
        if (text) {
          const ctx = getContext?.();
          const chat = ctx?.chat || [];
          const autoMsg = {
            is_user: false,
            is_system: false,
            name: char.name,
            mes: text,
            send_date: new Date().toISOString(),
          };
          chat.push(autoMsg);
          appendMessageToDom(autoMsg, chat.length - 1);
          if (typeof saveChatDebounced === 'function') saveChatDebounced();
        }
      }
    } catch (err) {
      console.warn(`[${EXTENSION_NAME}] Autonomy pulse check error:`, err);
    }
  }, intervalMs);
}

// ==================== UI Binding ====================
function bindSettingsDrawer() {
  const settings = getSettings();

  const masterEl = document.getElementById('rce-master-enabled');
  if (masterEl) {
    masterEl.checked = !!settings.enabled;
    masterEl.addEventListener('change', (e) => {
      updateSettings({ enabled: e.target.checked });
      if (typeof toastr !== 'undefined') {
        toastr.info(`拟真引擎接管已${e.target.checked ? '开启' : '关闭'}`);
      }
    });
  }

  const serverUrlEl = document.getElementById('rce-server-url');
  if (serverUrlEl) {
    serverUrlEl.value = settings.serverUrl || 'http://127.0.0.1:4000';
    serverUrlEl.addEventListener('change', (e) => {
      updateSettings({ serverUrl: e.target.value.trim() });
      checkBackendConnection();
    });
  }

  document.getElementById('rce-test-connection-btn')?.addEventListener('click', checkBackendConnection);

  const burstEl = document.getElementById('rce-burst-enabled');
  if (burstEl) {
    burstEl.checked = !!settings.enableBurstMessaging;
    burstEl.addEventListener('change', (e) => updateSettings({ enableBurstMessaging: e.target.checked }));
  }

  const speedEl = document.getElementById('rce-typing-speed');
  const speedValEl = document.getElementById('rce-typing-speed-val');
  if (speedEl && speedValEl) {
    speedEl.value = String(settings.typingSpeedMultiplier || 1.0);
    speedValEl.textContent = `${speedEl.value}x`;
    speedEl.addEventListener('input', (e) => {
      speedValEl.textContent = `${e.target.value}x`;
      updateSettings({ typingSpeedMultiplier: parseFloat(e.target.value) });
    });
  }

  const hudEl = document.getElementById('rce-hud-enabled');
  if (hudEl) {
    hudEl.checked = !!settings.showFloatingHud;
    hudEl.addEventListener('change', (e) => {
      updateSettings({ showFloatingHud: e.target.checked });
      renderHudContent();
    });
  }

  const badgeEl = document.getElementById('rce-message-badge-enabled');
  if (badgeEl) {
    badgeEl.checked = !!settings.enableMessageBadge;
    badgeEl.addEventListener('change', (e) => updateSettings({ enableMessageBadge: e.target.checked }));
  }

  const autonomyEl = document.getElementById('rce-autonomy-enabled');
  if (autonomyEl) {
    autonomyEl.checked = !!settings.enableAutonomy;
    autonomyEl.addEventListener('change', (e) => {
      updateSettings({ enableAutonomy: e.target.checked });
      setupAutonomyLoop();
    });
  }

  const intervalEl = document.getElementById('rce-autonomy-interval');
  const intervalValEl = document.getElementById('rce-autonomy-interval-val');
  if (intervalEl && intervalValEl) {
    intervalEl.value = String(settings.autonomyIntervalSeconds || 60);
    intervalValEl.textContent = `${intervalEl.value}s`;
    intervalEl.addEventListener('input', (e) => {
      intervalValEl.textContent = `${e.target.value}s`;
      updateSettings({ autonomyIntervalSeconds: parseInt(e.target.value, 10) });
      setupAutonomyLoop();
    });
  }

  document.getElementById('rce-trigger-pulse-now-btn')?.addEventListener('click', async () => {
    const feedback = document.getElementById('rce-pulse-feedback');
    if (feedback) feedback.textContent = '脉冲激发中...';
    const char = getCurrentCharacter();
    if (!char) {
      if (feedback) feedback.textContent = '未选角色';
      return;
    }
    try {
      const res = await fetch(`${settings.serverUrl}/api/st/autonomy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId: char.name, sessionId: `session_st_${char.name}` }),
      });
      const data = await res.json();
      if (feedback) {
        feedback.textContent = data.ok ? (data.idle ? '自主思考已结算（当前无需发言）' : '自主行动已生成！') : '脉冲未触发';
      }
    } catch (err) {
      if (feedback) feedback.textContent = '激发失败';
    }
  });

  document.getElementById('rce-sync-card-btn')?.addEventListener('click', syncCharacterCardToBackend);
}

async function mountSettingsDrawer() {
  if (document.getElementById('rce-extension-settings')) return;
  try {
    const htmlUrl = new URL('settings.html', import.meta.url).href;
    const res = await fetch(htmlUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const tryInject = () => {
      if (document.getElementById('rce-extension-settings')) return true;
      const target = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
      if (target) {
        target.insertAdjacentHTML('beforeend', html);
        bindSettingsDrawer();
        setupDrawerAccordion();
        return true;
      }
      return false;
    };

    if (!tryInject()) {
      let count = 0;
      const timer = setInterval(() => {
        count++;
        if (tryInject() || count > 30) {
          clearInterval(timer);
        }
      }, 500);
    }
  } catch (err) {
    console.error(`[${EXTENSION_NAME}] Failed to load settings.html:`, err);
  }
}

function setupDrawerAccordion() {
  const toggle = document.querySelector('#rce-extension-settings .inline-drawer-toggle');
  const content = document.querySelector('#rce-extension-settings .inline-drawer-content');
  const icon = document.querySelector('#rce-extension-settings .inline-drawer-icon');
  if (toggle && content) {
    toggle.addEventListener('click', () => {
      const isVisible = content.style.display !== 'none' && getComputedStyle(content).display !== 'none';
      content.style.display = isVisible ? 'none' : 'block';
      if (icon) {
        icon.classList.toggle('fa-circle-chevron-down', isVisible);
        icon.classList.toggle('fa-circle-chevron-up', !isVisible);
      }
    });
  }
}

function mountOptionsEntry() {
  const menu = document.querySelector('#options .options-content');
  if (!(menu instanceof HTMLElement) || document.getElementById('option_rce_engine')) return;

  const item = document.createElement('a');
  item.id = 'option_rce_engine';
  item.innerHTML = '<i class="fa-lg fa-solid fa-brain"></i><span>拟真角色引擎</span>';
  item.addEventListener('click', (event) => {
    event.preventDefault();
    const options = document.getElementById('options');
    if (options) options.style.display = 'none';

    const extBtn = document.getElementById('extensions_button');
    if (extBtn) extBtn.click();

    setTimeout(() => {
      const drawer = document.getElementById('rce-extension-settings');
      if (drawer) {
        drawer.scrollIntoView({ behavior: 'smooth' });
        const content = drawer.querySelector('.inline-drawer-content');
        if (content && (content.style.display === 'none' || getComputedStyle(content).display === 'none')) {
          drawer.querySelector('.inline-drawer-toggle')?.click();
        }
      }
    }, 250);
  });

  menu.insertBefore(item, document.getElementById('option_back_to_main') || menu.firstChild);
}

// ==================== Lifecycle Initialization ====================
jQuery(async () => {
  try {
    console.info(`[${EXTENSION_NAME}] Initializing Real Character Simulation Engine extension...`);
    await mountSettingsDrawer();
    mountOptionsEntry();
    ensureFloatingHud();
    attachSendInterception();
    checkBackendConnection();
    setupAutonomyLoop();

    const char = getCurrentCharacter();
    if (char) {
      fetchCharacterTelemetry(char.name);
    }

    if (eventSource && event_types) {
      eventSource.on(event_types.CHAT_CHANGED, () => {
        const c = getCurrentCharacter();
        if (c) {
          fetchCharacterTelemetry(c.name);
        }
      });

      eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
        const ctx = getContext?.();
        const msg = ctx?.chat?.[id];
        if (msg?.extra?.rce_telemetry) {
          currentTelemetry = msg.extra.rce_telemetry;
          renderHudContent();
        }
      });
    }

    console.info(`[${EXTENSION_NAME}] Real Character Simulation Engine ready.`);
  } catch (err) {
    console.error(`[${EXTENSION_NAME}] Initialization error:`, err);
  }
});
