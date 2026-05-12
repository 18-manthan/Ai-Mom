(function () {
  "use strict";

  if (window.__MOM_LIVE_CAPTURE_LOADED__) {
    return;
  }
  window.__MOM_LIVE_CAPTURE_LOADED__ = true;

  const DEFAULT_API_BASE = "http://127.0.0.1:8000";
  const DASHBOARD_URL = "http://127.0.0.1:5173";
  const SCAN_INTERVAL_MS = 900;
  const MAX_TEXT_LENGTH = 1400;

  const state = {
    apiBase: window.localStorage.getItem("mom.apiBase") || DEFAULT_API_BASE,
    captureStartedAt: 0,
    isCapturing: false,
    meetingId: null,
    observer: null,
    scanTimer: null,
    nodeIds: new WeakMap(),
    nextNodeId: 1,
    activeCaption: null,
    sentCount: 0,
  };

  const ui = createPanel();
  render();

  function createPanel() {
    const root = document.createElement("div");
    root.id = "mom-live-capture";
    root.innerHTML = `
      <div class="mom-panel">
        <div class="mom-head">
          <div class="mom-title">
            <strong>MOM Live Capture</strong>
            <span>Google Meet captions</span>
          </div>
          <span class="mom-pill" data-role="state">Idle</span>
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
      renderStatus("Connecting to MOM backend...");
      const meeting = await postJson("/api/live-meetings", {
        title: meetingTitle(),
        source: "google_meet",
      });

      state.meetingId = meeting.id;
      state.captureStartedAt = Date.now();
      state.isCapturing = true;
      state.sentCount = 0;
      state.activeCaption = null;

      startObserver();
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
      state.isCapturing = false;
      render();
      return;
    }

    const meetingId = state.meetingId;
    stopObserver();
    state.isCapturing = false;
    state.meetingId = null;

    try {
      renderStatus("Finishing live meeting...");
      await postJson(`/api/live-meetings/${meetingId}/finish`, {});
      renderStatus("Finished. Open MOM to generate notes.");
    } catch (error) {
      renderStatus(errorMessage(error));
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
    if (candidates.length > 0) {
      trackCaption(candidates[0]);
    }
  }

  function findCaptionCandidates() {
    const selectors = [
      '[aria-live="polite"]',
      '[aria-live="assertive"]',
      '[role="log"]',
      "[data-message-text]",
      "div",
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

      extracted.push({
        node,
        speaker: parsed.speaker,
        text: parsed.text,
        score: captionScore(node, rect, parsed),
      });
    }

    extracted.sort((a, b) => b.score - a.score);
    return uniqueCaptionCandidates(extracted).slice(0, 1);
  }

  function trackCaption(candidate) {
    const elapsed = Math.max(0, (Date.now() - state.captureStartedAt) / 1000);
    const text = cleanCaptionText(candidate.text);
    if (!text) {
      return;
    }

    const active = state.activeCaption;
    const isSameCaption = active && captionsOverlap(active.text, text);

    if (!isSameCaption) {
      state.activeCaption = {
        speaker: candidate.speaker,
        text,
        externalId: `meet-caption-${Date.now()}-${hashText(`${candidate.speaker}:${text}`)}`,
        start: elapsed,
        lastSentText: "",
      };
    }

    const current = state.activeCaption;
    if (text.length >= current.text.length) {
      current.text = text;
    }
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

    await postJson(`/api/live-meetings/${state.meetingId}/segments`, payload);
    state.sentCount += 1;
    renderStatus("Capturing captions...");
    render();
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

  function parseCaptionText(rawText) {
    const lines = rawText
      .split("\n")
      .map((line) => normalizeText(line))
      .filter(Boolean);

    if (lines.length >= 2 && looksLikeSpeaker(lines[0])) {
      return {
        speaker: lines[0],
        text: cleanCaptionText(lines.slice(1).join(" ")),
      };
    }

    const colonMatch = rawText.match(/^([^:]{2,60}):\s+(.+)$/);
    if (colonMatch && looksLikeSpeaker(colonMatch[1])) {
      return {
        speaker: normalizeText(colonMatch[1]),
        text: cleanCaptionText(colonMatch[2]),
      };
    }

    const selfMatch = rawText.match(/^(You)\s+(.+)$/i);
    if (selfMatch) {
      return {
        speaker: "You",
        text: cleanCaptionText(selfMatch[2]),
      };
    }

    const speakerPrefix = splitLeadingParticipantLabel(rawText);
    if (speakerPrefix) {
      return {
        speaker: speakerPrefix.speaker,
        text: cleanCaptionText(speakerPrefix.text),
      };
    }

    return {
      speaker: "Speaker",
      text: cleanCaptionText(rawText),
    };
  }

  function looksLikeCaptionBlock(text, rect, node) {
    if (text.length < 3 || text.length > MAX_TEXT_LENGTH) {
      return false;
    }
    if (rect.width < 120 || rect.height < 12 || rect.height > 260) {
      return false;
    }
    if (rect.top < window.innerHeight * 0.28) {
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

  function uniqueCaptionCandidates(candidates) {
    const seen = new Set();
    const unique = [];

    for (const candidate of candidates) {
      const signature = cleanCaptionText(candidate.text).toLowerCase();
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      unique.push(candidate);
    }

    return unique;
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

    const aWords = a.split(" ");
    const bWords = b.split(" ");
    const overlapSize = Math.min(8, aWords.length, bWords.length);
    if (overlapSize < 4) {
      return false;
    }

    return (
      aWords.slice(-overlapSize).join(" ") === bWords.slice(0, overlapSize).join(" ") ||
      bWords.slice(-overlapSize).join(" ") === aWords.slice(0, overlapSize).join(" ")
    );
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
      "turn on captions",
      "meeting details",
      "copy joining info",
      "present now",
      "raise hand",
      "more options",
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
    return title || "Google Meet live meeting";
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

    statePill.textContent = state.isCapturing ? `Live #${state.meetingId}` : "Idle";
    statePill.dataset.state = state.isCapturing ? "live" : "idle";
    count.textContent = `${state.sentCount} update${state.sentCount === 1 ? "" : "s"}`;
    start.disabled = state.isCapturing;
    stop.disabled = !state.isCapturing;
    test.disabled = !state.isCapturing;
    apiInput.disabled = state.isCapturing;
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
})();
