(function () {
  "use strict";

  const SCRIPT_VERSION = "0.1.13";

  if (window.__MOM_LIVE_CAPTURE_LOADED__ && window.__MOM_LIVE_CAPTURE_VERSION__ === SCRIPT_VERSION) {
    return;
  }
  if (window.__MOM_LIVE_CAPTURE_LOADED__) {
    document.getElementById("mom-live-capture")?.remove();
  }
  window.__MOM_LIVE_CAPTURE_LOADED__ = true;
  window.__MOM_LIVE_CAPTURE_VERSION__ = SCRIPT_VERSION;

  const DEFAULT_API_BASE = "http://127.0.0.1:8000";
  const DASHBOARD_URL = "http://127.0.0.1:5173";
  const SCAN_INTERVAL_MS = 900;
  const MAX_TEXT_LENGTH = 1000000;
  const CAPTION_TEXT_WINDOW = 500000;
  const ACTIVE_SESSION_KEY = "mom.activeSession";
  const MAX_PENDING_SEGMENTS = 5000;
  const MAX_BOTTOM_TEXT_LENGTH = 10000;
  const MAX_CANDIDATES_PER_SCAN = 4;
  const NO_CAPTION_WARNING_MS = 5000;
  const NO_CAPTION_RECOVERY_MS = 8000;

  const state = {
    apiBase: window.localStorage.getItem("mom.apiBase") || DEFAULT_API_BASE,
    captureStartedAt: 0,
    isCapturing: false,
    isConnected: false,
    meetingId: null,
    meetingCode: meetingCode(),
    observer: null,
    scanTimer: null,
    retryTimer: null,
    nodeIds: new WeakMap(),
    nextNodeId: 1,
    activeCaptions: new Map(),
    sentCount: 0,
    pendingSegments: [],
    previewSegments: [],
    lastCandidateAt: 0,
    lastRecoveryAt: 0,
    nodeSnapshots: new WeakMap(),
  };

  const ui = createPanel();
  window.setInterval(render, 1000);
  render();
  restoreActiveSession().catch((error) => {
    renderStatus(errorMessage(error));
    render();
  });

  function createPanel() {
    const root = document.createElement("div");
    root.id = "mom-live-capture";
    root.innerHTML = `
      <div class="mom-panel">
        <div class="mom-head">
          <div class="mom-title">
            <strong>MOM Live Capture</strong>
            <span>Google Meet captions · v${SCRIPT_VERSION}</span>
          </div>
          <span class="mom-pill" data-role="state">Idle</span>
        </div>
        <div class="mom-live-strip">
          <span class="mom-record-dot" data-role="record-dot"></span>
          <div class="mom-wave" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
            <span></span>
            <span></span>
          </div>
          <span class="mom-timer" data-role="timer">00:00</span>
        </div>
        <div class="mom-row">
          <label for="mom-api-base">Backend</label>
          <input id="mom-api-base" type="text" autocomplete="off" />
        </div>
        <div class="mom-actions">
          <button class="mom-button primary" type="button" data-action="start">Start</button>
          <button class="mom-button danger" type="button" data-action="stop">Stop</button>
          <button class="mom-button" type="button" data-action="test">Test</button>
        </div>
        <div class="mom-meta">
          <span data-role="count">0 updates</span>
          <a class="mom-link" href="${DASHBOARD_URL}" target="_blank" rel="noreferrer">Open MOM</a>
        </div>
        <div class="mom-transcript" data-role="transcript">
          <div class="mom-transcript-empty">Live captions will appear here.</div>
        </div>
        <div class="mom-status" data-role="status">Start capture after captions are enabled.</div>
      </div>
    `;

    document.documentElement.appendChild(root);

    const apiInput = root.querySelector("#mom-api-base");
    apiInput.value = state.apiBase;
    apiInput.addEventListener("change", () => {
      state.apiBase = normalizeApiBase(apiInput.value);
      apiInput.value = state.apiBase;
      window.localStorage.setItem("mom.apiBase", state.apiBase);
      renderStatus("Backend updated.");
    });

    root.querySelector('[data-action="start"]').addEventListener("click", startCapture);
    root.querySelector('[data-action="stop"]').addEventListener("click", stopCapture);
    root.querySelector('[data-action="test"]').addEventListener("click", sendTestSegment);

    return root;
  }

  async function startCapture() {
    if (state.isCapturing) {
      return;
    }

    try {
      if (state.meetingId) {
        state.isCapturing = true;
        state.captureStartedAt = state.captureStartedAt || Date.now();
        startObserver();
        persistActiveSession();
        renderStatus("Resumed capture for the active MOM meeting.");
        render();
        return;
      }

      renderStatus("Connecting to MOM backend...");
      const meeting = await postJson("/api/live-meetings", {
        title: meetingTitle(),
        source: "google_meet",
        meeting_code: state.meetingCode,
        source_url: window.location.href,
      });

      state.meetingId = meeting.id;
      state.captureStartedAt = Date.now();
      state.isCapturing = true;
      state.sentCount = 0;
      state.activeCaptions.clear();
      state.pendingSegments = [];
      state.previewSegments = [];
      state.isConnected = true;

      startObserver();
      persistActiveSession();
      renderStatus("Capturing. Keep Google Meet captions turned on.");
      render();
    } catch (error) {
      renderStatus(errorMessage(error));
      render();
    }
  }

  async function stopCapture() {
    if (!state.meetingId) {
      stopObserver();
      stopRetryTimer();
      state.isCapturing = false;
      state.isConnected = false;
      clearActiveSession();
      render();
      return;
    }

    const meetingId = state.meetingId;
    stopObserver();
    state.isCapturing = false;

    try {
      await flushPendingSegments();
      renderStatus("Finishing live meeting...");
      await postJson(`/api/live-meetings/${meetingId}/finish`, {});
      state.meetingId = null;
      state.isConnected = false;
      state.pendingSegments = [];
      state.previewSegments = [];
      stopRetryTimer();
      clearActiveSession();
      renderStatus("Finished. Open MOM to generate notes.");
    } catch (error) {
      persistActiveSession();
      renderStatus(`${errorMessage(error)} Click Stop again after the backend is reachable.`);
    } finally {
      render();
    }
  }

  async function sendTestSegment() {
    if (!state.meetingId) {
      renderStatus("Start capture before sending a test segment.");
      return;
    }

    await sendSegment({
      speaker: "MOM Test",
      text: "This is a test live caption segment from the MOM extension.",
      external_id: `mom-test-${Date.now()}`,
      is_final: true,
    });
  }

  function startObserver() {
    stopObserver();

    state.observer = new MutationObserver(() => {
      scheduleScan();
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    state.scanTimer = window.setInterval(scanCaptions, SCAN_INTERVAL_MS);
    startRetryTimer();
    scanCaptions();
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.scanTimer) {
      window.clearInterval(state.scanTimer);
      state.scanTimer = null;
    }
  }

  function startRetryTimer() {
    if (state.retryTimer) {
      return;
    }
    state.retryTimer = window.setInterval(() => {
      flushPendingSegments().catch(() => undefined);
    }, 2500);
  }

  function stopRetryTimer() {
    if (state.retryTimer) {
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }
  }

  function scheduleScan() {
    if (!state.isCapturing || state.pendingScan) {
      return;
    }
    state.pendingScan = true;
    window.setTimeout(() => {
      state.pendingScan = false;
      scanCaptions();
    }, 250);
  }

  function scanCaptions() {
    if (!state.isCapturing) {
      return;
    }

    const candidates = findCaptionCandidates();
    const missingForMs = Date.now() - state.lastCandidateAt;
    if (candidates.length === 0 && missingForMs > NO_CAPTION_RECOVERY_MS && Date.now() - state.lastRecoveryAt > NO_CAPTION_RECOVERY_MS) {
      recoverCaptionScanner();
      return;
    }
    if (candidates.length === 0 && missingForMs > NO_CAPTION_WARNING_MS) {
      renderStatus("Reconnecting to Google Meet captions...");
      render();
    }
    for (const candidate of candidates) {
      state.lastCandidateAt = Date.now();
      trackCaption(candidate);
    }
  }

  function recoverCaptionScanner() {
    state.lastRecoveryAt = Date.now();
    state.nodeSnapshots = new WeakMap();
    renderStatus("Refreshing caption scanner...");
    stopObserver();
    window.setTimeout(() => {
      if (!state.isCapturing) {
        return;
      }
      startObserver();
      scanCaptions();
    }, 350);
    render();
  }

  function findCaptionCandidates() {
    const selectors = [
      '[aria-live="polite"]',
      '[aria-live="assertive"]',
      '[role="log"]',
      "[data-message-text]",
      "div",
      "span",
    ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
    const extracted = [];

    for (const node of nodes) {
      if (ui.contains(node) || !isVisible(node)) {
        continue;
      }

      const rect = node.getBoundingClientRect();
      const rawText = normalizeText(node.innerText || node.textContent || "");
      if (!looksLikeCaptionBlock(rawText, rect, node)) {
        continue;
      }

      const parsed = parseCaptionText(rawText);
      if (!parsed || isRejectedCaption(parsed)) {
        continue;
      }
      if (!isLikelyLiveCaptionNode(node) && !looksLikeCaptionText(parsed.text)) {
        continue;
      }
      const freshness = nodeTextFreshness(node, parsed.text);

      extracted.push({
        node,
        speaker: parsed.speaker,
        text: parsed.text,
        score: captionScore(node, rect, parsed) - Math.min(45, freshness.stableMs / 1000),
      });
    }

    if (!hasStrongCaptionCandidate(extracted)) {
      extracted.push(...findBottomTextCandidates());
    }
    extracted.sort((a, b) => b.score - a.score);
    return uniqueCaptionCandidates(extracted).slice(0, MAX_CANDIDATES_PER_SCAN);
  }

  function findBottomTextCandidates() {
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        const text = normalizeText(textNode.nodeValue || "");
        if (text.length < 3 || text.length > MAX_BOTTOM_TEXT_LENGTH) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = textNode.parentElement;
        if (!parent || ui.contains(parent) || !isVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest("button,input,textarea,select,nav,header,aside,menu")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    let checked = 0;
    while ((node = walker.nextNode()) && checked < 1200) {
      checked += 1;
      const parent = node.parentElement;
      if (!parent) continue;
      const rect = parent.getBoundingClientRect();
      const text = normalizeText(node.nodeValue || "");
      if (!looksLikeBottomCaptionText(text, rect)) {
        continue;
      }
      const parsed = parseCaptionText(text);
      if (!parsed || isRejectedCaption(parsed)) {
        continue;
      }
      if (!looksLikeCaptionText(parsed.text)) {
        continue;
      }
      const freshness = nodeTextFreshness(parent, parsed.text);
      candidates.push({
        node: parent,
        speaker: parsed.speaker,
        text: parsed.text,
        score: 75 + Math.max(0, rect.top / 20) - Math.min(35, freshness.stableMs / 1000),
      });
    }

    return candidates;
  }

  function trackCaption(candidate) {
    const elapsed = Math.max(0, (Date.now() - state.captureStartedAt) / 1000);
    const text = cleanCaptionText(candidate.text);
    if (!text) {
      return;
    }

    const captionKey = candidate.speaker || "Speaker";
    const active = state.activeCaptions.get(captionKey);
    const isSameCaption = active && captionsOverlap(active.text, text);

    if (!isSameCaption) {
      state.activeCaptions.set(captionKey, {
        speaker: candidate.speaker,
        text,
        externalId: `meet-caption-${Date.now()}-${hashText(`${candidate.speaker}:${text}`)}`,
        start: elapsed,
        lastSentText: "",
      });
    }

    const current = state.activeCaptions.get(captionKey);
    current.text = mergeCaptionText(current.text, text);
    if (current.speaker === "Speaker" && candidate.speaker !== "Speaker") {
      current.speaker = candidate.speaker;
    }

    if (current.text === current.lastSentText) {
      return;
    }

    current.lastSentText = current.text;
    sendSegment({
      speaker: current.speaker,
      text: current.text,
      start: current.start,
      end: elapsed,
      external_id: current.externalId,
      is_final: true,
    }).catch((error) => {
      renderStatus(errorMessage(error));
    });
  }

  async function sendSegment(segment) {
    if (!state.meetingId) {
      return;
    }

    const elapsed = Math.max(0, (Date.now() - state.captureStartedAt) / 1000);
    const payload = {
      speaker: segment.speaker || "Speaker",
      text: segment.text,
      start: segment.start ?? elapsed,
      end: segment.end ?? elapsed,
      external_id: segment.external_id,
      source: "google_meet",
      is_final: segment.is_final !== false,
    };

    rememberPreviewSegment(payload);

    try {
      await postJson(`/api/live-meetings/${state.meetingId}/segments`, payload);
      state.sentCount += 1;
      state.isConnected = true;
      persistActiveSession();
      renderStatus(state.pendingSegments.length ? "Capturing captions. Retrying queued updates..." : "Capturing captions...");
      render();
    } catch (error) {
      state.isConnected = false;
      queuePendingSegment(payload);
      renderStatus(`${errorMessage(error)} Queued ${state.pendingSegments.length} update${state.pendingSegments.length === 1 ? "" : "s"}.`);
      render();
      throw error;
    }
  }

  async function postJson(path, payload) {
    const response = await fetch(`${state.apiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let detail = `MOM backend returned ${response.status}`;
      try {
        const data = await response.json();
        detail = data.detail || detail;
      } catch (_) {
        // Keep the generic status message.
      }
      throw new Error(detail);
    }

    return response.json();
  }

  async function getJson(path) {
    const response = await fetch(`${state.apiBase}${path}`);
    if (!response.ok) {
      const error = new Error(`MOM backend returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function restoreActiveSession() {
    const session = readActiveSession();
    if (!session?.meetingId) {
      return;
    }
    if (session.meetingCode && state.meetingCode && session.meetingCode !== state.meetingCode) {
      return;
    }

    state.apiBase = normalizeApiBase(session.apiBase || state.apiBase);
    state.meetingId = session.meetingId;
    state.captureStartedAt = session.captureStartedAt || Date.now();
    state.sentCount = session.sentCount || 0;
    state.pendingSegments = Array.isArray(session.pendingSegments) ? session.pendingSegments : [];
    state.previewSegments = Array.isArray(session.previewSegments) ? session.previewSegments : [];

    const apiInput = ui.querySelector("#mom-api-base");
    apiInput.value = state.apiBase;

    try {
      const meeting = await getJson(`/api/meetings/${state.meetingId}`);
      if (meeting.status === "completed" || meeting.status === "failed") {
        clearActiveSession();
        state.meetingId = null;
        state.pendingSegments = [];
        state.previewSegments = [];
        state.isCapturing = false;
        state.isConnected = false;
        renderStatus("Previous MOM live session is already finished.");
        render();
        return;
      }
      state.isCapturing = true;
      state.isConnected = true;
      startObserver();
      renderStatus("Reconnected to the active MOM live meeting.");
    } catch (error) {
      if (error?.status === 404) {
        clearActiveSession();
        state.meetingId = null;
        state.pendingSegments = [];
        state.previewSegments = [];
        state.isCapturing = false;
        state.isConnected = false;
        renderStatus("Previous MOM live session was not found. Start a new capture.");
        render();
        return;
      }
      state.isCapturing = false;
      state.isConnected = false;
      persistActiveSession();
      renderStatus("MOM backend is not reachable. Click Resume when it is back.");
    }

    render();
  }

  function readActiveSession() {
    try {
      return JSON.parse(window.localStorage.getItem(ACTIVE_SESSION_KEY) || "null");
    } catch (_) {
      return null;
    }
  }

  function persistActiveSession() {
    if (!state.meetingId) {
      return;
    }
    window.localStorage.setItem(
      ACTIVE_SESSION_KEY,
      JSON.stringify({
        meetingId: state.meetingId,
        meetingCode: state.meetingCode,
        apiBase: state.apiBase,
        captureStartedAt: state.captureStartedAt,
        sentCount: state.sentCount,
        pendingSegments: state.pendingSegments.slice(-MAX_PENDING_SEGMENTS),
        previewSegments: state.previewSegments.slice(-5),
      }),
    );
  }

  function clearActiveSession() {
    window.localStorage.removeItem(ACTIVE_SESSION_KEY);
  }

  function queuePendingSegment(payload) {
    state.pendingSegments.push(payload);
    if (state.pendingSegments.length > MAX_PENDING_SEGMENTS) {
      state.pendingSegments = state.pendingSegments.slice(-MAX_PENDING_SEGMENTS);
    }
    persistActiveSession();
  }

  async function flushPendingSegments() {
    if (!state.meetingId || state.pendingSegments.length === 0) {
      return;
    }

    const pending = [...state.pendingSegments];
    state.pendingSegments = [];
    for (const payload of pending) {
      try {
        await postJson(`/api/live-meetings/${state.meetingId}/segments`, payload);
        state.sentCount += 1;
        state.isConnected = true;
      } catch (error) {
        state.pendingSegments.unshift(payload, ...pending.slice(pending.indexOf(payload) + 1));
        if (state.pendingSegments.length > MAX_PENDING_SEGMENTS) {
          state.pendingSegments = state.pendingSegments.slice(-MAX_PENDING_SEGMENTS);
        }
        state.isConnected = false;
        persistActiveSession();
        render();
        throw error;
      }
    }
    persistActiveSession();
    render();
  }

  function rememberPreviewSegment(segment) {
    const externalId = segment.external_id || `${segment.speaker}:${segment.start}`;
    const preview = {
      external_id: externalId,
      speaker: segment.speaker || "Speaker",
      text: segment.text || "",
      start: segment.start || 0,
    };
    const existingIndex = state.previewSegments.findIndex((item) => item.external_id === externalId);
    if (existingIndex >= 0) {
      state.previewSegments[existingIndex] = preview;
    } else {
      state.previewSegments.push(preview);
    }
    state.previewSegments = state.previewSegments.slice(-5);
    persistActiveSession();
    render();
  }

  function parseCaptionText(rawText) {
    const sourceText = normalizeText(rawText).slice(-CAPTION_TEXT_WINDOW);
    const lines = sourceText
      .split("\n")
      .map((line) => normalizeText(line))
      .filter(Boolean);

    if (lines.length >= 2 && looksLikeSpeaker(lines[0])) {
      return {
        speaker: lines[0],
        text: cleanCaptionText(lines.slice(1).join(" ")),
      };
    }

    const colonMatch = sourceText.match(/^([^:]{2,60}):\s+(.+)$/);
    if (colonMatch && looksLikeSpeaker(colonMatch[1])) {
      return {
        speaker: normalizeText(colonMatch[1]),
        text: cleanCaptionText(colonMatch[2]),
      };
    }

    const selfMatch = sourceText.match(/^(You)\s+(.+)$/i);
    if (selfMatch) {
      return {
        speaker: "You",
        text: cleanCaptionText(selfMatch[2]),
      };
    }

    const speakerPrefix = splitLeadingParticipantLabel(sourceText);
    if (speakerPrefix) {
      return {
        speaker: speakerPrefix.speaker,
        text: cleanCaptionText(speakerPrefix.text),
      };
    }

    return {
      speaker: "Speaker",
      text: cleanCaptionText(sourceText),
    };
  }

  function looksLikeCaptionBlock(text, rect, node) {
    if (text.length < 3) {
      return false;
    }
    if (text.length > MAX_TEXT_LENGTH && !isLikelyLiveCaptionNode(node)) {
      return false;
    }
    const likelyCaptionNode = isLikelyLiveCaptionNode(node);
    if (rect.width < (likelyCaptionNode ? 40 : 80) || rect.height < 8 || rect.height > 360) {
      return false;
    }
    if (rect.top < window.innerHeight * 0.25) {
      return false;
    }
    if (node === document.body || node === document.documentElement) {
      return false;
    }
    if (node.querySelectorAll("button,input,textarea,select").length > 0) {
      return false;
    }
    return true;
  }

  function looksLikeBottomCaptionText(text, rect) {
    if (rect.width < 35 || rect.height < 8 || rect.height > 90) {
      return false;
    }
    if (rect.top < window.innerHeight * 0.42) {
      return false;
    }
    if (text.split(/\s+/).length > 80) {
      return false;
    }
    return /[A-Za-z]/.test(text);
  }

  function looksLikeCaptionText(text) {
    const cleaned = cleanCaptionText(text);
    const lower = cleaned.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    if (!cleaned || isUiNoiseText(cleaned)) {
      return false;
    }
    if (words.length >= 4) {
      return true;
    }
    if (/[.!?]$/.test(cleaned)) {
      return true;
    }
    const allowedShortStarts = new Set([
      "yeah",
      "yes",
      "no",
      "okay",
      "ok",
      "hey",
      "hi",
      "hello",
      "thanks",
      "thank",
      "i",
      "im",
      "i'm",
      "you",
      "we",
      "so",
      "and",
      "but",
      "are",
      "can",
      "do",
      "did",
      "what",
      "how",
      "why",
      "right",
    ]);
    return words.length > 0 && allowedShortStarts.has(words[0]);
  }

  function isUiNoiseText(text) {
    const cleaned = cleanCaptionText(text);
    const lower = cleaned.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    const languageNames = new Set([
      "english",
      "hindi",
      "spanish",
      "french",
      "german",
      "portuguese",
      "japanese",
      "korean",
      "chinese",
    ]);
    if (languageNames.has(lower)) {
      return true;
    }
    if (state.meetingCode && lower === state.meetingCode) {
      return true;
    }
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(cleaned)) {
      return true;
    }
    if (words.length >= 1 && words.length <= 3 && looksLikeParticipantLabel(words)) {
      return true;
    }
    return false;
  }

  function captionScore(node, rect, parsed) {
    let score = 0;
    if (node.getAttribute("aria-live")) score += 100;
    if (node.getAttribute("role") === "log") score += 80;
    if (node.hasAttribute("data-message-text")) score += 60;
    if (parsed.speaker !== "Speaker") score += 30;
    score += Math.max(0, rect.top / 20);
    score -= Math.max(0, node.childElementCount - 4) * 6;
    return score;
  }

  function isLikelyLiveCaptionNode(node) {
    return Boolean(
      node.getAttribute("aria-live") ||
        node.getAttribute("role") === "log" ||
        node.hasAttribute("data-message-text"),
    );
  }

  function nodeTextFreshness(node, text) {
    const key = cleanCaptionText(text).toLowerCase();
    const now = Date.now();
    const previous = state.nodeSnapshots.get(node);
    if (!previous || previous.key !== key) {
      state.nodeSnapshots.set(node, { key, since: now });
      return { stableMs: 0 };
    }
    return { stableMs: now - previous.since };
  }

  function uniqueCaptionCandidates(candidates) {
    const seen = new Set();
    const unique = [];

    const sorted = [...candidates].sort((a, b) => cleanCaptionText(b.text).length - cleanCaptionText(a.text).length);
    for (const candidate of sorted) {
      const signature = cleanCaptionText(candidate.text).toLowerCase();
      if (seen.has(signature)) {
        continue;
      }
      if (
        unique.some((existing) => {
          const existingSignature = cleanCaptionText(existing.text).toLowerCase();
          return existingSignature.includes(signature) || signature.includes(existingSignature);
        })
      ) {
        continue;
      }
      seen.add(signature);
      unique.push(candidate);
    }

    return unique;
  }

  function hasStrongCaptionCandidate(candidates) {
    return candidates.some((candidate) => {
      const text = cleanCaptionText(candidate.text);
      return candidate.score >= 85 && text.split(/\s+/).length >= 4 && !isUiNoiseText(text);
    });
  }

  function captionsOverlap(previous, next) {
    const a = cleanCaptionText(previous).toLowerCase();
    const b = cleanCaptionText(next).toLowerCase();
    if (!a || !b) {
      return false;
    }
    if (a === b || a.startsWith(b) || b.startsWith(a)) {
      return true;
    }
    if ((a.length >= 24 && b.includes(a)) || (b.length >= 24 && a.includes(b))) {
      return true;
    }

    const aWords = a.split(" ");
    const bWords = b.split(" ");
    const maxOverlap = Math.min(40, aWords.length, bWords.length);
    for (let size = maxOverlap; size >= 4; size -= 1) {
      if (
        aWords.slice(-size).join(" ") === bWords.slice(0, size).join(" ") ||
        bWords.slice(-size).join(" ") === aWords.slice(0, size).join(" ")
      ) {
        return true;
      }
    }

    return false;
  }

  function mergeCaptionText(previous, next) {
    const a = cleanCaptionText(previous);
    const b = cleanCaptionText(next);
    if (!a) return b;
    if (!b) return a;
    if (a === b) return a;
    if (b.startsWith(a)) return b;
    if (a.startsWith(b)) return a;
    if (a.length >= 24 && b.includes(a)) return b;
    if (b.length >= 24 && a.includes(b)) return a;

    const aWords = a.split(" ");
    const bWords = b.split(" ");
    const maxOverlap = Math.min(40, aWords.length, bWords.length);
    for (let size = maxOverlap; size >= 4; size -= 1) {
      if (aWords.slice(-size).join(" ").toLowerCase() === bWords.slice(0, size).join(" ").toLowerCase()) {
        return [...aWords, ...bWords.slice(size)].join(" ");
      }
      if (bWords.slice(-size).join(" ").toLowerCase() === aWords.slice(0, size).join(" ").toLowerCase()) {
        return [...bWords, ...aWords.slice(size)].join(" ");
      }
    }

    return b.length >= a.length ? b : a;
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity || "1") > 0
    );
  }

  function isRejectedCaption(parsed) {
    const speaker = parsed.speaker.toLowerCase();
    const text = parsed.text;
    const lower = text.toLowerCase();
    if (speaker === "pin" || speaker === "dial-in") {
      return true;
    }
    if (
      lower === "you" ||
      isUiNoiseText(text) ||
      lower.startsWith("joined as ") ||
      lower.startsWith("language ") ||
      lower.includes("meeting host") ||
      lower === "live captions have been turned off" ||
      lower.startsWith("turn off microphone")
    ) {
      return true;
    }
    if (looksLikeRepeatedShortName(text)) {
      return true;
    }
    if (looksLikeNameOnly(text)) {
      return true;
    }
    if (/^[\d\s()+#-]{7,}$/.test(text)) {
      return true;
    }

    const rejected = [
      "mom live capture",
      "start capture",
      "stop capture",
      "open mom",
      "google meet captions",
      "live captions will appear",
      "capturing captions",
      "or share this joining info with others you want in the meeting",
      "end the call or just leave",
      "just leave the call",
      "leave the call if you don't want to end it",
      "leave the call if you don’t want to end it",
      "end it for everyone else",
      "turn on captions",
      "turn off captions",
      "meeting details",
      "copy joining info",
      "present now",
      "raise hand",
      "more options",
      "leave call",
      "turn off camera",
      "turn on camera",
      "turn on microphone",
      "turn off microphone",
      "show everyone",
      "activities",
      "host controls",
    ];
    return rejected.some((item) => lower.includes(item));
  }

  function looksLikeSpeaker(value) {
    if (!value || value.length > 60) {
      return false;
    }
    if (/[.!?]$/.test(value)) {
      return false;
    }
    return /[A-Za-z]/.test(value);
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanCaptionText(value) {
    return normalizeText(value)
      .replace(/^You\s+/i, "")
      .replace(/^Speaker\s+/i, "")
      .trim();
  }

  function looksLikeRepeatedShortName(value) {
    const words = cleanCaptionText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (![2, 4, 6].includes(words.length)) {
      return false;
    }
    const half = words.length / 2;
    return words.slice(0, half).join(" ") === words.slice(half).join(" ");
  }

  function splitLeadingParticipantLabel(value) {
    const words = cleanCaptionText(value).split(/\s+/).filter(Boolean);
    for (let size = 2; size <= Math.min(4, words.length - 1); size += 1) {
      const prefix = words.slice(0, size);
      const remainder = words.slice(size);
      if (looksLikeParticipantLabel(prefix) && startsLikeCaption(remainder)) {
        return {
          speaker: prefix.join(" "),
          text: remainder.join(" "),
        };
      }
    }
    return null;
  }

  function looksLikeNameOnly(value) {
    const words = cleanCaptionText(value)
      .replace(/\([^)]*\)/g, "")
      .split(/\s+/)
      .filter(Boolean);
    const commonCaptionWords = new Set([
      "yeah",
      "yes",
      "no",
      "okay",
      "ok",
      "so",
      "and",
      "but",
      "in",
      "the",
      "from",
      "here",
      "heres",
      "hey",
      "hi",
      "thanks",
      "we",
      "i",
      "you",
      "it",
      "is",
    ]);
    if (words.some((word) => commonCaptionWords.has(word.toLowerCase()))) {
      return false;
    }
    return words.length >= 2 && words.length <= 4 && looksLikeParticipantLabel(words);
  }

  function looksLikeParticipantLabel(words) {
    if (words.length < 2) {
      return false;
    }

    const normalized = words.map((word) => word.replace(/[^A-Za-z]/g, "")).filter(Boolean);
    if (normalized.length !== words.length) {
      return false;
    }

    const commonCaptionStarts = new Set([
      "yeah",
      "yes",
      "no",
      "okay",
      "ok",
      "so",
      "and",
      "but",
      "in",
      "the",
      "from",
      "here",
      "heres",
      "hey",
      "hi",
      "thanks",
      "we",
      "i",
      "you",
      "it",
      "is",
    ]);
    if (commonCaptionStarts.has(normalized[0].toLowerCase())) {
      return false;
    }

    return normalized.every((word) => word.length <= 3 || /^[A-Z]/.test(word));
  }

  function startsLikeCaption(words) {
    if (!words.length) {
      return false;
    }
    const first = words[0].replace(/[^A-Za-z]/g, "").toLowerCase();
    const commonStarts = new Set([
      "yeah",
      "yes",
      "no",
      "okay",
      "ok",
      "so",
      "and",
      "but",
      "in",
      "the",
      "from",
      "here",
      "heres",
      "hey",
      "hi",
      "thanks",
      "we",
      "i",
      "im",
      "you",
      "it",
      "is",
    ]);
    return commonStarts.has(first);
  }

  function normalizeApiBase(value) {
    const trimmed = normalizeText(value) || DEFAULT_API_BASE;
    return trimmed.replace(/\/+$/, "");
  }

  function meetingTitle() {
    const title = normalizeText(document.title).replace(/\s*-\s*Google Meet\s*$/i, "");
    const code = meetingCode();
    return title || (code ? `Meet - ${code}` : "Google Meet live meeting");
  }

  function meetingCode() {
    const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return match ? match[1].toLowerCase() : "";
  }

  function getNodeId(node) {
    if (!state.nodeIds.has(node)) {
      state.nodeIds.set(node, state.nextNodeId);
      state.nextNodeId += 1;
    }
    return state.nodeIds.get(node);
  }

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function render() {
    const statePill = ui.querySelector('[data-role="state"]');
    const count = ui.querySelector('[data-role="count"]');
    const start = ui.querySelector('[data-action="start"]');
    const stop = ui.querySelector('[data-action="stop"]');
    const test = ui.querySelector('[data-action="test"]');
    const apiInput = ui.querySelector("#mom-api-base");
    const transcript = ui.querySelector('[data-role="transcript"]');
    const timer = ui.querySelector('[data-role="timer"]');
    const recordDot = ui.querySelector('[data-role="record-dot"]');

    const hasActiveMeeting = Boolean(state.meetingId);
    statePill.textContent = state.isCapturing
      ? `Live #${state.meetingId}`
      : hasActiveMeeting
        ? `Paused #${state.meetingId}`
        : "Idle";
    statePill.dataset.state = state.isCapturing ? "live" : hasActiveMeeting ? "paused" : "idle";
    count.textContent = `${state.sentCount} sent · ${state.pendingSegments.length} queued`;
    start.textContent = hasActiveMeeting && !state.isCapturing ? "Resume" : "Start";
    start.disabled = state.isCapturing;
    stop.disabled = !hasActiveMeeting;
    test.disabled = !state.isCapturing;
    apiInput.disabled = hasActiveMeeting;
    timer.textContent = state.captureStartedAt && hasActiveMeeting
      ? formatTimer((Date.now() - state.captureStartedAt) / 1000)
      : "00:00";
    recordDot.dataset.state = state.isCapturing ? "live" : hasActiveMeeting ? "paused" : "idle";

    if (state.previewSegments.length === 0) {
      transcript.innerHTML = `<div class="mom-transcript-empty">Live captions will appear here.</div>`;
    } else {
      transcript.innerHTML = state.previewSegments
        .map(
          (segment) => `
            <div class="mom-transcript-line">
              <span>${escapeHtml(segment.speaker)}</span>
              <p>${escapeHtml(segment.text)}</p>
            </div>
          `,
        )
        .join("");
    }
  }

  function renderStatus(message) {
    ui.querySelector('[data-role="status"]').textContent = message;
  }

  function errorMessage(error) {
    if (error instanceof TypeError) {
      return `Could not reach MOM backend at ${state.apiBase}.`;
    }
    return error instanceof Error ? error.message : "Unexpected MOM capture error.";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTimer(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
})();
