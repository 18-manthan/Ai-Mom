(function () {
  "use strict";

  const SCRIPT_VERSION = "0.1.26";

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
  const PANEL_POSITION_KEY = "mom.panelPosition";
  const PANEL_MINIMIZED_KEY = "mom.panelMinimized";
  const MAX_PENDING_SEGMENTS = 5000;
  const MAX_PREVIEW_SEGMENTS = 80;
  const MAX_RENDERED_PREVIEW_SEGMENTS = 18;
  const MAX_BOTTOM_TEXT_LENGTH = 10000;
  const MAX_CANDIDATES_PER_SCAN = 4;
  const NO_CAPTION_WARNING_MS = 5000;
  const NO_CAPTION_RECOVERY_MS = 8000;
  const AUTO_CAPTURE_ENABLED = true;
  const AUTO_ENABLE_CAPTIONS = true;
  const AUTO_CAPTURE_INTERVAL_MS = 2000;
  const MEETING_END_GRACE_MS = 5000;

  const state = {
    apiBase: window.localStorage.getItem("mom.apiBase") || DEFAULT_API_BASE,
    platform: detectPlatform(),
    captureStartedAt: 0,
    isCapturing: false,
    isConnected: false,
    isEnding: false,
    meetingId: null,
    meetingCode: meetingCode(),
    observer: null,
    scanTimer: null,
    retryTimer: null,
    autoMonitorTimer: null,
    autoEndTimer: null,
    segmentControllers: new Set(),
    nodeIds: new WeakMap(),
    nextNodeId: 1,
    activeCaptions: new Map(),
    sentCount: 0,
    pendingSegments: [],
    previewSegments: [],
    lastCandidateAt: 0,
    lastRecoveryAt: 0,
    nodeSnapshots: new WeakMap(),
    nodeSpeakers: new WeakMap(),
    autoCaptionAttempted: false,
    autoStartInFlight: false,
    restoreInFlight: false,
    meetingWasActive: false,
    userPaused: false,
    userEndedSession: false,
    isMinimized: window.localStorage.getItem(PANEL_MINIMIZED_KEY) === "true",
  };

  let nativeCaptionStyle = null;
  let teamsMenuStyle = null;

  const ui = createPanel();
  startAutoCaptureMonitor();
  window.addEventListener("beforeunload", () => {
    if (state.autoMonitorTimer) {
      window.clearInterval(state.autoMonitorTimer);
    }
    if (state.autoEndTimer) {
      window.clearTimeout(state.autoEndTimer);
    }
    showNativeCaptions();
    showTeamsMenus();
  });
  window.setInterval(render, 1000);
  render();
  restoreActiveSession().catch((error) => {
    renderStatus(errorMessage(error));
    render();
  });

  function createPanel() {
    const root = document.createElement("div");
    root.id = "mom-live-capture";
    root.dataset.visible = shouldShowPanel() ? "true" : "false";
    root.innerHTML = `
      <div class="mom-panel">
        <div class="mom-head" data-drag-handle="true">
          <div class="mom-title">
            <strong>iMann</strong>
            <span>${platformLabel()} captions · v${SCRIPT_VERSION}</span>
          </div>
          <div class="mom-state-cluster">
            <span class="mom-status-dot" data-role="record-dot"></span>
            <span class="mom-pill" data-role="state">Idle</span>
            <span class="mom-timer" data-role="timer">00:00</span>
            <button class="mom-icon-button" type="button" data-action="minimize" title="Minimize">−</button>
          </div>
        </div>

        <input id="mom-api-base" class="mom-hidden-input" type="hidden" autocomplete="off" />

        <div class="mom-tabs">
          <button class="mom-tab selected" type="button">Live Transcript</button>
          <a class="mom-tab" href="${DASHBOARD_URL}" target="_blank" rel="noreferrer">Ask iMann AI</a>
        </div>

        <div class="mom-live-workspace">
          <div class="mom-transcript" data-role="transcript">
            <div class="mom-transcript-empty">
              <strong>Live captions will appear here.</strong>
              <span>Join a meeting. iMann starts transcription automatically.</span>
            </div>
          </div>
        </div>

        <div class="mom-status" data-role="status">Waiting for an active ${platformLabel()} call...</div>

        <div class="mom-bottom-meta">
          <span data-role="count">0 sent · 0 queued</span>
        </div>

        <div class="mom-dock">
          <button class="mom-dock-button pause" type="button" data-action="pause">Pause</button>
          <a class="mom-dock-button open" href="${DASHBOARD_URL}" target="_blank" rel="noreferrer">Open</a>
        </div>
      </div>
      <div class="mom-mini" data-drag-handle="true">
        <span class="mom-record-dot" data-role="mini-record-dot"></span>
        <div class="mom-mini-body">
          <strong data-role="mini-state">Idle</strong>
          <span data-role="mini-preview">iMann capture ready</span>
        </div>
        <span class="mom-mini-timer" data-role="mini-timer">00:00</span>
        <button class="mom-icon-button" type="button" data-action="expand" title="Expand">↗</button>
      </div>
    `;

    document.documentElement.appendChild(root);
    restorePanelPosition(root);
    setupPanelDragging(root);

    const apiInput = root.querySelector("#mom-api-base");
    apiInput.value = state.apiBase;
    apiInput.addEventListener("change", () => {
      state.apiBase = normalizeApiBase(apiInput.value);
      apiInput.value = state.apiBase;
      window.localStorage.setItem("mom.apiBase", state.apiBase);
      renderStatus("Backend updated.");
    });

    root.querySelector('[data-action="pause"]').addEventListener("click", togglePauseResume);
    root.querySelector('[data-action="minimize"]').addEventListener("click", () => setMinimized(true));
    root.querySelector('[data-action="expand"]').addEventListener("click", () => setMinimized(false));

    return root;
  }

  function setMinimized(value) {
    state.isMinimized = value;
    window.localStorage.setItem(PANEL_MINIMIZED_KEY, String(value));
    render();
  }

  function restorePanelPosition(root) {
    try {
      const position = JSON.parse(window.localStorage.getItem(PANEL_POSITION_KEY) || "null");
      if (!position || typeof position.left !== "number" || typeof position.top !== "number") {
        return;
      }
      const left = clamp(position.left, 8, window.innerWidth - 80);
      const top = clamp(position.top, 8, window.innerHeight - 64);
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    } catch (_) {
      window.localStorage.removeItem(PANEL_POSITION_KEY);
    }
  }

  function setupPanelDragging(root) {
    let dragState = null;

    root.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest("[data-drag-handle]");
      const interactive = event.target.closest("button,a,input,textarea,select");
      if (!handle || interactive) {
        return;
      }

      const rect = root.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      root.setPointerCapture(event.pointerId);
      root.classList.add("is-dragging");
      event.preventDefault();
    });

    root.addEventListener("pointermove", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      const rect = root.getBoundingClientRect();
      const left = clamp(event.clientX - dragState.offsetX, 8, window.innerWidth - rect.width - 8);
      const top = clamp(event.clientY - dragState.offsetY, 8, window.innerHeight - rect.height - 8);
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    });

    root.addEventListener("pointerup", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      root.releasePointerCapture(event.pointerId);
      root.classList.remove("is-dragging");
      dragState = null;
      const rect = root.getBoundingClientRect();
      window.localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    });

    window.addEventListener("resize", () => restorePanelPosition(root));
  }

  function startAutoCaptureMonitor() {
    if (!AUTO_CAPTURE_ENABLED || state.autoMonitorTimer) {
      return;
    }

    const tick = () => {
      const active = isMeetingActive();

      if (active) {
        state.meetingWasActive = true;
        if (state.autoEndTimer) {
          window.clearTimeout(state.autoEndTimer);
          state.autoEndTimer = null;
        }
        if (!state.meetingId && !state.autoStartInFlight && !state.userPaused && !state.userEndedSession && !state.isEnding) {
          const session = readActiveSession();
          if (sessionMatchesCurrentPage(session) && !state.restoreInFlight) {
            restoreActiveSession().catch((error) => {
              renderStatus(errorMessage(error));
              render();
            });
            return;
          }
          startCapture({ automatic: true }).catch((error) => {
            renderStatus(errorMessage(error));
            render();
          });
        }
        return;
      }

      if (!active && state.meetingWasActive) {
        state.meetingWasActive = false;
        state.userPaused = false;
        state.userEndedSession = false;
        if (state.meetingId && !state.isEnding && !state.autoEndTimer) {
          renderStatus("Meeting ended. Finalizing transcription...");
          render();
          state.autoEndTimer = window.setTimeout(() => {
            state.autoEndTimer = null;
            if (!isMeetingActive() && state.meetingId) {
              endCapture({ automatic: true }).catch((error) => {
                renderStatus(errorMessage(error));
                render();
              });
            }
          }, MEETING_END_GRACE_MS);
        }
      }
    };

    state.autoMonitorTimer = window.setInterval(tick, AUTO_CAPTURE_INTERVAL_MS);
    window.setTimeout(tick, 800);
  }

  async function startCapture(options = {}) {
    if (state.isCapturing || state.isEnding || state.autoStartInFlight) {
      return;
    }
    if (options.automatic && state.userEndedSession) {
      return;
    }

    state.autoStartInFlight = true;
    try {
      if (state.meetingId) {
        state.isCapturing = true;
        state.isEnding = false;
        state.userPaused = false;
        state.captureStartedAt = state.captureStartedAt || Date.now();
        startObserver();
        ensurePlatformCaptions().catch((error) => renderStatus(errorMessage(error)));
        persistActiveSession();
        renderStatus("Resumed capture for the active iMann meeting.");
        render();
        return;
      }

      renderStatus(options.automatic ? "Meeting detected. Starting iMann transcription..." : "Connecting to iMann backend...");
      const meeting = await postJson("/api/live-meetings", {
        title: meetingTitle(),
        source: platformSource(),
        meeting_code: state.meetingCode,
        source_url: window.location.href,
      });

      state.meetingId = meeting.id;
      state.captureStartedAt = Date.now();
      state.isCapturing = true;
      state.isEnding = false;
      state.userPaused = false;
      state.userEndedSession = false;
      state.sentCount = 0;
      state.activeCaptions.clear();
      state.pendingSegments = [];
      state.previewSegments = [];
      state.isConnected = true;

      startObserver();
      ensurePlatformCaptions().catch((error) => renderStatus(errorMessage(error)));
      persistActiveSession();
      renderStatus(`Capturing. iMann will try to keep ${platformLabel()} captions hidden.`);
      render();
    } catch (error) {
      renderStatus(errorMessage(error));
      render();
    } finally {
      state.autoStartInFlight = false;
    }
  }

  function togglePauseResume() {
    if (!state.meetingId || state.isEnding) {
      return;
    }

    if (!state.isCapturing) {
      startCapture({ automatic: false }).catch((error) => {
        renderStatus(errorMessage(error));
        render();
      });
      return;
    }

    stopObserver();
    state.isCapturing = false;
    state.userPaused = true;
    persistActiveSession();
    renderStatus("Paused. Click Resume to continue this transcription session.");
    render();
  }

  async function endCapture(options = {}) {
    if (state.isEnding) {
      renderStatus("Ending is already in progress...");
      render();
      return;
    }

    if (!state.meetingId) {
      stopObserver();
      stopRetryTimer();
      abortSegmentRequests();
      state.isCapturing = false;
      state.isConnected = false;
      state.isEnding = false;
      state.autoCaptionAttempted = false;
      state.userPaused = false;
      state.userEndedSession = !options.automatic;
      showNativeCaptions();
      showTeamsMenus();
      clearActiveSession();
      render();
      return;
    }

    const meetingId = state.meetingId;
    state.isEnding = true;
    stopObserver();
    stopRetryTimer();
    state.pendingScan = false;
    state.isCapturing = false;
    state.userPaused = false;
    state.userEndedSession = !options.automatic;
    renderStatus("Ending capture...");
    render();

    try {
      renderStatus("Ending capture and saving queued updates...");
      try {
        await flushPendingSegments();
      } catch (flushError) {
        renderStatus(`${errorMessage(flushError)} Finalizing with the captions already saved.`);
      }
      renderStatus("Finishing live meeting...");
      await postJson(`/api/live-meetings/${meetingId}/finish`, {});
      state.meetingId = null;
      state.isConnected = false;
      state.isEnding = false;
      state.pendingSegments = [];
      state.previewSegments = [];
      state.autoCaptionAttempted = false;
      state.userPaused = false;
      showNativeCaptions();
      showTeamsMenus();
      clearActiveSession();
      renderStatus(options.automatic ? "Meeting ended. Transcription saved." : "Finished. Open iMann to generate notes.");
    } catch (error) {
      state.isEnding = false;
      persistActiveSession();
      if (options.automatic) {
        renderStatus(`${errorMessage(error)} Retrying final save shortly...`);
        if (!state.autoEndTimer) {
          state.autoEndTimer = window.setTimeout(() => {
            state.autoEndTimer = null;
            if (!isMeetingActive() && state.meetingId) {
              endCapture({ automatic: true }).catch((retryError) => {
                renderStatus(errorMessage(retryError));
                render();
              });
            }
          }, MEETING_END_GRACE_MS);
        }
      } else {
        renderStatus(errorMessage(error));
      }
    } finally {
      render();
    }
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
      renderStatus(`Reconnecting to ${platformLabel()} captions...`);
      render();
    }
    for (const candidate of candidates) {
      state.lastCandidateAt = Date.now();
      trackCaption(candidate);
    }
  }

  async function ensurePlatformCaptions() {
    if (!AUTO_ENABLE_CAPTIONS || state.autoCaptionAttempted) {
      return;
    }
    state.autoCaptionAttempted = true;

    if (state.platform === "microsoft_teams") {
      const enabled = await autoEnableTeamsCaptions();
      renderStatus(
        enabled
          ? "Capturing Teams captions. Native captions are hidden from view."
          : "Capturing. If Teams captions do not appear, enable live captions once manually.",
      );
      render();
      return;
    }

    const enabled = await autoEnableMeetCaptions();
    renderStatus(
      enabled
        ? "Capturing Google Meet captions. Native captions are hidden from view."
        : "Capturing. If Meet captions do not appear, enable captions once manually.",
    );
    render();
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

  function findPlatformCaptionCandidates() {
    if (state.platform === "microsoft_teams") {
      return findTeamsCaptionCandidates();
    }
    if (state.platform === "google_meet") {
      return findMeetCaptionCandidates();
    }
    return [];
  }

  function findMeetCaptionCandidates() {
    const candidates = [];
    const roots = Array.from(document.querySelectorAll('[role="region"][aria-label="Captions"], [aria-label="Captions"]'));

    for (const root of roots) {
      const rows = Array.from(root.querySelectorAll(".nMcdL"));
      if (rows.length > 0) {
        for (const row of rows) {
          const speaker = normalizeSpeakerName(row.querySelector(".NWpY1d")?.textContent || "") || "Speaker";
          const text = cleanCaptionText(row.querySelector(".ygicle")?.textContent || "");
          if (!text || !looksLikeCaptionText(text)) {
            continue;
          }
          candidates.push({
            node: row,
            speaker,
            text,
            score: 220,
          });
        }
        continue;
      }

      const parsed = parseCaptionText(root.innerText || root.textContent || "", root);
      if (parsed && !isRejectedCaption(parsed) && looksLikeCaptionText(parsed.text)) {
        candidates.push({
          node: root,
          speaker: parsed.speaker,
          text: parsed.text,
          score: 180,
        });
      }
    }

    return candidates;
  }

  function findTeamsCaptionCandidates() {
    const candidates = [];
    const captions = Array.from(document.querySelectorAll('[data-tid="closed-caption-text"]'));

    for (const caption of captions.slice(-8)) {
      const text = cleanCaptionText(caption.textContent || "");
      if (!text || !looksLikeCaptionText(text)) {
        continue;
      }
      const message = caption.closest(".fui-ChatMessageCompact, [role='listitem'], [role='group']") || caption.parentElement;
      const speaker =
        normalizeSpeakerName(message?.querySelector?.('[data-tid="author"]')?.textContent || "") ||
        extractSpeakerFromCaptionNode(caption, text) ||
        "Speaker";
      candidates.push({
        node: caption,
        speaker,
        text,
        score: 220,
      });
    }

    if (candidates.length > 0) {
      return candidates;
    }
    return [];
  }

  async function autoEnableMeetCaptions() {
    const enabledButton = findButtonByLabelOrText(["turn off captions", "captions are on"]);
    if (enabledButton) {
      hideNativeCaptions();
      return true;
    }

    const button = await waitForElement(() => findButtonByLabelOrText(["turn on captions"]), 10000);
    if (!button) {
      return false;
    }

    button.click();
    await sleep(900);
    hideNativeCaptions();
    return true;
  }

  async function autoEnableTeamsCaptions() {
    if (document.querySelector('[data-tid="closed-caption-text"]')) {
      hideNativeCaptions();
      return true;
    }

    const directCaptionButton = findButtonByLabelOrText(["turn on live captions", "turn on captions", "live captions"]);
    if (directCaptionButton && !buttonText(directCaptionButton).includes("turn off")) {
      directCaptionButton.click();
      await sleep(900);
      hideNativeCaptions();
      return true;
    }

    const moreButton = findTeamsMoreButton();
    if (!moreButton) {
      return false;
    }

    hideTeamsMenus();
    moreButton.click();
    await sleep(900);

    const languageAndSpeech = findButtonByLabelOrText(["language and speech", "language & speech", "speech"]);
    if (!languageAndSpeech) {
      showTeamsMenus();
      return false;
    }

    languageAndSpeech.click();
    const captionButton = await waitForElement(() => findTeamsLiveCaptionButton(), 10000);
    if (!captionButton) {
      showTeamsMenus();
      return false;
    }

    const text = buttonText(captionButton);
    if (!text.includes("turn off")) {
      captionButton.click();
    }

    await sleep(1000);
    hideNativeCaptions();
    showTeamsMenus();
    return true;
  }

  function hideNativeCaptions() {
    if (nativeCaptionStyle) {
      return;
    }

    nativeCaptionStyle = document.createElement("style");
    nativeCaptionStyle.id = "mom-hide-native-captions";

    if (state.platform === "microsoft_teams") {
      nativeCaptionStyle.textContent = `
        [role="log"],
        [data-tid*="caption" i],
        [class*="caption" i] {
          position: fixed !important;
          top: -9999px !important;
          left: -9999px !important;
          width: 1px !important;
          height: 1px !important;
          max-width: 1px !important;
          max-height: 1px !important;
          overflow: hidden !important;
          pointer-events: none !important;
        }
      `;
    } else {
      nativeCaptionStyle.textContent = `
        [role="region"][aria-label="Captions"] {
          position: fixed !important;
          top: -9999px !important;
          left: -9999px !important;
          width: 1px !important;
          height: 1px !important;
          max-width: 1px !important;
          max-height: 1px !important;
          overflow: hidden !important;
          pointer-events: none !important;
        }
      `;
    }

    document.head.appendChild(nativeCaptionStyle);
  }

  function showNativeCaptions() {
    nativeCaptionStyle?.remove();
    nativeCaptionStyle = null;
  }

  function hideTeamsMenus() {
    if (teamsMenuStyle) {
      return;
    }
    teamsMenuStyle = document.createElement("style");
    teamsMenuStyle.id = "mom-hide-teams-caption-menu";
    teamsMenuStyle.textContent = `
      .fui-MenuPopover,
      [data-popover-open="true"] {
        position: fixed !important;
        left: -10000px !important;
        top: -10000px !important;
      }
    `;
    document.head.appendChild(teamsMenuStyle);
  }

  function showTeamsMenus() {
    teamsMenuStyle?.remove();
    teamsMenuStyle = null;
  }

  function findTeamsMoreButton() {
    return (
      document.querySelector("#callingButtons-showMoreBtn") ||
      findButtonByLabelOrText(["more actions", "more options", "more"])
    );
  }

  function findTeamsLiveCaptionButton() {
    return (
      document.querySelector('[data-inp="closed-captions-button"]') ||
      findButtonByLabelOrText(["turn on live captions", "turn off live captions", "turn on captions", "turn off captions", "live captions"])
    );
  }

  function isMeetingActive() {
    if (state.platform === "microsoft_teams") {
      return Boolean(
        document.querySelector('[data-tid="call-controls"]') ||
          document.querySelector("#callingButtons-showMoreBtn") ||
          findButtonByLabelOrText(["leave call", "leave meeting", "hang up", "end call"])
      );
    }

    return Boolean(
      findButtonByLabelOrText(["leave call", "leave meeting"])
    );
  }

  function shouldShowPanel() {
    if (state.platform !== "microsoft_teams") {
      return true;
    }
    return Boolean(
      state.meetingId ||
        state.isEnding ||
        state.autoStartInFlight ||
        isMeetingActive() ||
        isTeamsIncomingCallVisible()
    );
  }

  function isTeamsIncomingCallVisible() {
    if (
      findButtonByLabelOrText([
        "accept call",
        "accept with audio",
        "accept with video",
        "answer call",
        "decline call",
        "reject call",
      ])
    ) {
      return true;
    }

    if (!findTextInVisibleBody(["incoming call", "is calling", "calling you", "wants you to join", "calling..."])) {
      return false;
    }

    return Boolean(findButtonByLabelOrText(["accept", "answer", "decline", "join call", "join now"]));
  }

  function findTextInVisibleBody(needles) {
    const text = normalizeText(document.body?.innerText || "").toLowerCase();
    return needles.some((needle) => text.includes(needle));
  }

  function findButtonByLabelOrText(needles) {
    const normalizedNeedles = needles.map((needle) => needle.toLowerCase());
    const elements = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]'));
    return elements.find((element) => {
      const text = buttonText(element);
      return normalizedNeedles.some((needle) => text.includes(needle));
    }) || null;
  }

  function buttonText(element) {
    return normalizeText(
      `${element?.getAttribute?.("aria-label") || ""} ${element?.getAttribute?.("title") || ""} ${element?.textContent || ""}`,
    ).toLowerCase();
  }

  async function waitForElement(resolveElement, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const element = resolveElement();
      if (element) {
        return element;
      }
      await sleep(300);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function findCaptionCandidates() {
    const platformCandidates = findPlatformCaptionCandidates();
    if (platformCandidates.length > 0) {
      return uniqueCaptionCandidates(platformCandidates).slice(0, MAX_CANDIDATES_PER_SCAN);
    }
    if (state.platform === "microsoft_teams") {
      return [];
    }

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

      const parsed = parseCaptionText(rawText, node);
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
      const parsed = parseCaptionText(text, parent);
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

    const speaker = resolveCandidateSpeaker(candidate);
    const captionKey = speaker === "Speaker" ? `Speaker:${getNodeId(candidate.node)}` : speaker;
    const active = state.activeCaptions.get(captionKey);
    const isSameCaption = active && captionsOverlap(active.text, text);

    if (!isSameCaption) {
      state.activeCaptions.set(captionKey, {
        speaker,
        text,
        externalId: `meet-caption-${Date.now()}-${hashText(`${captionKey}:${text}`)}`,
        start: elapsed,
        lastSentText: "",
      });
    }

    const current = state.activeCaptions.get(captionKey);
    current.text = mergeCaptionText(current.text, text);
    if (current.speaker === "Speaker" && speaker !== "Speaker") {
      current.speaker = speaker;
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
    if (!state.meetingId || state.isEnding) {
      return;
    }

    const elapsed = Math.max(0, (Date.now() - state.captureStartedAt) / 1000);
    const payload = {
      speaker: normalizeSpeakerName(segment.speaker) || "Speaker",
      text: segment.text,
      start: segment.start ?? elapsed,
      end: segment.end ?? elapsed,
      external_id: segment.external_id,
      source: platformSource(),
      is_final: segment.is_final !== false,
    };

    rememberPreviewSegment(payload);

    const controller = new AbortController();
    state.segmentControllers.add(controller);
    try {
      await postJson(`/api/live-meetings/${state.meetingId}/segments`, payload, { signal: controller.signal });
      if (state.isEnding || !state.meetingId) {
        return;
      }
      state.sentCount += 1;
      state.isConnected = true;
      persistActiveSession();
      renderStatus(state.pendingSegments.length ? "Capturing captions. Retrying queued updates..." : "Capturing captions...");
      render();
    } catch (error) {
      if (error?.name === "AbortError" || state.isEnding || !state.meetingId) {
        return;
      }
      state.isConnected = false;
      queuePendingSegment(payload);
      renderStatus(`${errorMessage(error)} Queued ${state.pendingSegments.length} update${state.pendingSegments.length === 1 ? "" : "s"}.`);
      render();
      throw error;
    } finally {
      state.segmentControllers.delete(controller);
    }
  }

  function abortSegmentRequests() {
    for (const controller of state.segmentControllers) {
      controller.abort();
    }
    state.segmentControllers.clear();
  }

  async function postJson(path, payload, options = {}) {
    const response = await fetch(`${state.apiBase}${path}`, {
      method: "POST",
      cache: "no-store",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let detail = `iMann backend returned ${response.status}`;
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
    const response = await fetch(`${state.apiBase}${path}`, { cache: "no-store" });
    if (!response.ok) {
      const error = new Error(`iMann backend returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function restoreActiveSession() {
    const session = readActiveSession();
    if (!sessionMatchesCurrentPage(session)) {
      return;
    }
    if (!isMeetingActive()) {
      renderStatus(`Waiting for an active ${platformLabel()} call. iMann will start after you join.`);
      render();
      return;
    }
    if (state.restoreInFlight) {
      return;
    }

    state.restoreInFlight = true;

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
        state.isEnding = false;
        renderStatus("Previous MOM live session is already finished.");
        render();
        return;
      }
      state.isCapturing = true;
      state.isConnected = true;
      state.isEnding = false;
      startObserver();
      ensurePlatformCaptions().catch((error) => renderStatus(errorMessage(error)));
      renderStatus("Reconnected to the active MOM live meeting.");
    } catch (error) {
      if (error?.status === 404) {
        clearActiveSession();
        state.meetingId = null;
        state.pendingSegments = [];
        state.previewSegments = [];
        state.isCapturing = false;
        state.isConnected = false;
        state.isEnding = false;
        renderStatus("Previous MOM live session was not found. Start a new capture.");
        render();
        return;
      }
      state.isCapturing = false;
      state.isConnected = false;
      state.isEnding = false;
      persistActiveSession();
      renderStatus("iMann backend is not reachable. Click Resume when it is back.");
    } finally {
      state.restoreInFlight = false;
      render();
    }
  }

  function sessionMatchesCurrentPage(session) {
    if (!session?.meetingId) {
      return false;
    }
    if (session.platform && session.platform !== state.platform) {
      return false;
    }
    if (session.meetingCode && state.meetingCode && session.meetingCode !== state.meetingCode) {
      return false;
    }
    return true;
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
        platform: state.platform,
        meetingCode: state.meetingCode,
        apiBase: state.apiBase,
        captureStartedAt: state.captureStartedAt,
        sentCount: state.sentCount,
        pendingSegments: state.pendingSegments.slice(-MAX_PENDING_SEGMENTS),
        previewSegments: state.previewSegments.slice(-MAX_PREVIEW_SEGMENTS),
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
      const lastIndex = state.previewSegments.length - 1;
      const last = state.previewSegments[lastIndex];
      if (shouldMergePreview(last, preview)) {
        state.previewSegments[lastIndex] = mergePreviewSegment(last, preview);
      } else {
        state.previewSegments.push(preview);
      }
    }
    state.previewSegments = compactPreviewSegments(state.previewSegments).slice(-MAX_PREVIEW_SEGMENTS);
    persistActiveSession();
    render();
  }

  function previewSegmentsForDisplay() {
    return compactPreviewSegments(state.previewSegments).slice(-MAX_RENDERED_PREVIEW_SEGMENTS);
  }

  function compactPreviewSegments(segments) {
    const knownSpeakers = knownPreviewSpeakers(segments);
    const compacted = [];
    for (const segment of segments) {
      const text = normalizeText(segment.text);
      if (!text) {
        continue;
      }
      const preview = {
        ...segment,
        speaker: normalizeSpeakerLabel(segment.speaker || "Speaker"),
        text,
      };
      const splitSegments = splitEmbeddedSpeakerTurns(preview, knownSpeakers);
      for (const splitSegment of splitSegments) {
        appendCompactedPreview(compacted, splitSegment);
      }
    }
    return compacted;
  }

  function appendCompactedPreview(compacted, preview) {
    const text = normalizeText(preview.text);
    if (!text) {
      return;
    }
    const normalized = {
      ...preview,
      speaker: normalizeSpeakerLabel(preview.speaker || "Speaker"),
      text,
    };

    for (let index = compacted.length - 1; index >= Math.max(0, compacted.length - 40); index -= 1) {
      const previous = compacted[index];
      if (shouldMergePreview(previous, normalized)) {
        compacted[index] = mergePreviewSegment(previous, normalized);
        return;
      }
    }

    compacted.push(normalized);
  }

  function knownPreviewSpeakers(segments) {
    const speakers = [];
    for (const segment of segments) {
      const speaker = normalizeSpeakerLabel(segment.speaker || "");
      if (isRealSpeakerName(speaker) && !speakers.includes(speaker)) {
        speakers.push(speaker);
      }
      for (const embeddedSpeaker of discoverEmbeddedSpeakers(segment.text || "")) {
        if (isRealSpeakerName(embeddedSpeaker) && !speakers.includes(embeddedSpeaker)) {
          speakers.push(embeddedSpeaker);
        }
      }
    }
    return speakers.sort((a, b) => b.length - a.length);
  }

  function discoverEmbeddedSpeakers(text) {
    const cleaned = cleanCaptionText(text);
    if (!cleaned) {
      return [];
    }
    const captionStarts = [
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
      "great",
      "have",
      "here",
      "heres",
      "hello",
      "hey",
      "hi",
      "good",
      "thanks",
      "we",
      "i",
      "im",
      "you",
      "it",
      "is",
      "now",
      "please",
    ].join("|");
    const pattern = new RegExp(
      `(?:^|[.!?]\\s+)([A-Z][A-Za-z]*(?:\\s+[A-Z][A-Za-z]*){1,3})(?::)?\\s+(?=(?:${captionStarts})\\b)`,
      "g",
    );
    const speakers = [];
    for (const match of cleaned.matchAll(pattern)) {
      const speaker = normalizeSpeakerLabel(match[1]);
      if (isRealSpeakerName(speaker) && !speakers.includes(speaker)) {
        speakers.push(speaker);
      }
    }
    return speakers;
  }

  function isRealSpeakerName(speaker) {
    const lower = normalizeText(speaker).toLowerCase();
    if (!lower || lower === "speaker" || lower === "you" || lower === "participants" || lower.startsWith("language ")) {
      return false;
    }
    const first = lower.split(/\s+/)[0]?.replace(/[^a-z]/g, "") || "";
    if (isCommonCaptionStart(first)) {
      return false;
    }
    return speaker.split(/\s+/).filter(Boolean).length >= 2;
  }

  function splitEmbeddedSpeakerTurns(segment, knownSpeakers) {
    const text = cleanCaptionText(segment.text);
    if (!text || knownSpeakers.length === 0) {
      return [segment];
    }

    const matches = [];
    for (const speaker of knownSpeakers) {
      const escaped = escapeRegExp(speaker);
      const pattern = new RegExp(`(?:^|(?<=[.!?]\\s))(${escaped})(?::)?\\s+`, "gi");
      for (const match of text.matchAll(pattern)) {
        matches.push({
          index: match.index + match[0].indexOf(match[1]),
          end: match.index + match[0].length,
          speaker,
        });
      }
    }

    if (matches.length === 0) {
      const split = splitLeadingParticipantLabel(text);
      if (!split) {
        return [segment];
      }
      const speaker = normalizeSpeakerLabel(split.speaker);
      return [{ ...segment, speaker, text: stripRepeatedSpeakerPrefixes(split.text, speaker) }];
    }

    matches.sort((a, b) => (a.index === b.index ? b.end - a.end : a.index - b.index));
    const deduped = [];
    let lastEnd = -1;
    for (const match of matches) {
      if (match.index < lastEnd) {
        continue;
      }
      deduped.push(match);
      lastEnd = match.end;
    }

    const start = Number(segment.start) || 0;
    const parts = [];
    const prefix = text.slice(0, deduped[0].index).trim();
    if (prefix) {
      parts.push({ ...segment, text: prefix });
    }

    deduped.forEach((match, index) => {
      const nextStart = deduped[index + 1]?.index ?? text.length;
      const turnText = stripRepeatedSpeakerPrefixes(text.slice(match.end, nextStart).trim(), match.speaker);
      if (turnText) {
        parts.push({
          ...segment,
          speaker: normalizeSpeakerLabel(match.speaker),
          text: turnText,
        });
      }
    });

    return parts.map((part, index) => ({
      ...part,
      start: start + index * 0.01,
    }));
  }

  function shouldMergePreview(previous, next) {
    if (!previous || !next) {
      return false;
    }
    if (normalizeSpeaker(previous.speaker) !== normalizeSpeaker(next.speaker)) {
      return false;
    }
    const previousText = normalizeText(previous.text);
    const nextText = normalizeText(next.text);
    if (!previousText || !nextText) {
      return false;
    }
    return captionsOverlap(previousText, nextText) || previousText.includes(nextText) || nextText.includes(previousText);
  }

  function mergePreviewSegment(previous, next) {
    const previousText = normalizeText(previous.text);
    const nextText = normalizeText(next.text);
    const mergedText = mergeCaptionText(previousText, nextText);
    return {
      ...previous,
      ...next,
      speaker: next.speaker && next.speaker !== "Speaker" ? next.speaker : previous.speaker,
      start: Math.min(Number(previous.start) || 0, Number(next.start) || 0),
      text: mergedText.length >= previousText.length ? mergedText : previousText,
    };
  }

  function normalizeSpeaker(value) {
    return normalizeSpeakerLabel(value || "Speaker").toLowerCase();
  }

  function normalizeSpeakerLabel(value) {
    const cleaned = normalizeText(value || "Speaker").replace(/[\s:,-]+$/g, "");
    if (!cleaned) {
      return "Speaker";
    }
    const words = cleaned.split(/\s+/).filter(Boolean);
    while (words.length > 2) {
      const last = words[words.length - 1].replace(/[^A-Za-z]/g, "").toLowerCase();
      if (isCommonCaptionStart(last) || new Set(["how", "what", "when", "where", "why", "who", "which"]).has(last)) {
        words.pop();
        continue;
      }
      break;
    }
    return words.join(" ") || "Speaker";
  }

  function stripRepeatedSpeakerPrefixes(text, speaker) {
    const cleanSpeaker = normalizeText(speaker).replace(/[\s:,-]+$/g, "");
    if (!cleanSpeaker) {
      return normalizeText(text);
    }
    const pattern = new RegExp(`(?:^|(?<=[.!?]\\s))(${escapeRegExp(cleanSpeaker)})(?::)?\\s+`, "gi");
    return normalizeText(text).replace(pattern, "").replace(/\s+/g, " ").trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function parseCaptionText(rawText, node = null) {
    const sourceText = normalizeText(rawText).slice(-CAPTION_TEXT_WINDOW);
    const lines = sourceText
      .split("\n")
      .map((line) => normalizeText(line))
      .filter(Boolean);

    if (lines.length >= 2 && looksLikeSpeaker(lines[0])) {
      const explicitSpeaker = normalizeSpeakerName(lines[0]);
      if (!explicitSpeaker) {
        return {
          speaker: "Speaker",
          text: cleanCaptionText(lines.slice(1).join(" ")),
        };
      }
      return {
        speaker: explicitSpeaker,
        text: cleanCaptionText(lines.slice(1).join(" ")),
      };
    }

    const colonMatch = sourceText.match(/^([^:]{2,60}):\s+(.+)$/);
    if (colonMatch && looksLikeSpeaker(colonMatch[1])) {
      const explicitSpeaker = normalizeSpeakerName(colonMatch[1]);
      if (!explicitSpeaker) {
        return {
          speaker: "Speaker",
          text: cleanCaptionText(colonMatch[2]),
        };
      }
      return {
        speaker: explicitSpeaker,
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
      const explicitSpeaker = normalizeSpeakerName(speakerPrefix.speaker);
      return {
        speaker: explicitSpeaker || "Speaker",
        text: cleanCaptionText(speakerPrefix.text),
      };
    }

    return {
      speaker: "Speaker",
      text: cleanCaptionText(sourceText),
    };
  }

  function extractSpeakerFromCaptionNode(node, captionText) {
    if (!node) {
      return "";
    }

    const containers = [];
    let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    for (let depth = 0; current && depth < 5; depth += 1) {
      containers.push(current);
      current = current.parentElement;
    }

    for (const container of containers) {
      const attributeSpeaker = speakerFromAttributes(container, captionText);
      if (attributeSpeaker) {
        return attributeSpeaker;
      }
    }

    for (const container of containers) {
      const childSpeaker = speakerFromChildLabels(container, captionText);
      if (childSpeaker) {
        return childSpeaker;
      }
    }

    return "";
  }

  function speakerFromAttributes(node, captionText) {
    const attributes = [
      "aria-label",
      "title",
      "data-sender-name",
      "data-participant-name",
      "data-display-name",
      "data-name",
    ];
    for (const attribute of attributes) {
      const value = normalizeText(node.getAttribute?.(attribute) || "");
      const speaker = speakerFromMixedLabel(value, captionText);
      if (speaker) {
        return speaker;
      }
    }
    return "";
  }

  function speakerFromChildLabels(container, captionText) {
    const children = Array.from(container.querySelectorAll("span,div")).slice(0, 24);
    const captionLower = cleanCaptionText(captionText).toLowerCase();
    for (const child of children) {
      if (!isVisible(child)) {
        continue;
      }
      const text = normalizeText(child.innerText || child.textContent || "");
      const textLower = text.toLowerCase();
      if (
        !text ||
        text.length > 80 ||
        captionLower.includes(textLower) ||
        (captionLower.length >= 3 && textLower.includes(captionLower))
      ) {
        continue;
      }
      const speaker = normalizeSpeakerName(text);
      if (speaker) {
        return speaker;
      }
    }
    return "";
  }

  function speakerFromMixedLabel(value, captionText) {
    if (!value) {
      return "";
    }
    const cleanedCaption = cleanCaptionText(captionText).toLowerCase();
    const parts = value
      .split(/[,|•·\n]/)
      .map((part) => normalizeText(part))
      .filter(Boolean);
    for (const part of [value, ...parts]) {
      const cleaned = cleanCaptionText(part);
      if (!cleaned || cleanedCaption.includes(cleaned.toLowerCase())) {
        continue;
      }
      const withoutStatus = cleaned
        .replace(/\b(is speaking|speaking|presenting|muted|camera is off|meeting host)\b/gi, "")
        .replace(/\([^)]*\)/g, "")
        .trim();
      const speaker = normalizeSpeakerName(withoutStatus);
      if (speaker) {
        return speaker;
      }
    }
    return "";
  }

  function resolveCandidateSpeaker(candidate) {
    const speaker = normalizeSpeakerName(candidate.speaker);
    if (speaker && speaker !== "Speaker") {
      return speaker;
    }
    return "Speaker";
  }

  function normalizeSpeakerName(value) {
    const cleaned = normalizeText(value)
      .replace(/\([^)]*\)/g, "")
      .replace(/\b(you are presenting|your presentation|presentation|meeting host|host)\b/gi, "")
      .replace(/\b(is speaking|speaking|muted|camera is off)\b/gi, "")
      .trim();
    if (!cleaned || cleaned.length > 60) {
      return "";
    }
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length > 4) {
      return "";
    }
    const lower = cleaned.toLowerCase();
    if (lower === "speaker") {
      return "Speaker";
    }
    if (isBadSpeakerLabel(cleaned)) {
      return "";
    }
    if (looksLikeCaptionSpeakerFalsePositive(words)) {
      return "";
    }
    if (!looksLikeSpeaker(cleaned)) {
      return "";
    }
    return cleaned;
  }

  function looksLikeCaptionSpeakerFalsePositive(words) {
    const first = (words[0] || "").toLowerCase().replace(/[^a-z]/g, "");
    const second = (words[1] || "").toLowerCase().replace(/[^a-z]/g, "");
    const sentenceStarts = new Set([
      "a",
      "an",
      "as",
      "and",
      "are",
      "but",
      "can",
      "could",
      "do",
      "does",
      "for",
      "from",
      "good",
      "here",
      "how",
      "if",
      "in",
      "is",
      "it",
      "its",
      "let",
      "lets",
      "now",
      "okay",
      "ok",
      "outside",
      "right",
      "so",
      "that",
      "thats",
      "the",
      "there",
      "this",
      "to",
      "what",
      "when",
      "where",
      "why",
      "we",
      "you",
    ]);
    if (first === "you") {
      return false;
    }
    if (sentenceStarts.has(first)) {
      return true;
    }
    return first === "it" && second === "s";
  }

  function isBadSpeakerLabel(value) {
    const lower = normalizeText(value).toLowerCase();
    const badLabels = new Set([
      "captions",
      "live transcript",
      "google meet captions",
      "live captions",
      "meeting details",
      "present now",
      "raise hand",
      "more options",
      "activities",
      "host controls",
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
    if (badLabels.has(lower)) {
      return true;
    }
    if (lower.startsWith("language ")) {
      return true;
    }
    if (state.meetingCode && lower === state.meetingCode) {
      return true;
    }
    return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(value);
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
    const a = captionCompareKey(previous);
    const b = captionCompareKey(next);
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
    const aKey = captionCompareKey(a);
    const bKey = captionCompareKey(b);
    if (!a) return b;
    if (!b) return a;
    if (a === b) return a;
    if (bKey.startsWith(aKey)) return b;
    if (aKey.startsWith(bKey)) return a;
    if (aKey.length >= 24 && bKey.includes(aKey)) return b;
    if (bKey.length >= 24 && aKey.includes(bKey)) return a;

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

  function captionCompareKey(value) {
    return cleanCaptionText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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
      lower.startsWith("participants ") ||
      lower.includes("domain_disabled") ||
      lower.includes(" visitor") ||
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
      "participants",
      "domain_disabled",
      "calling...",
      "leaving...",
      "have left the call",
      "meeting with ",
      "https://",
      "http://",
      "www.",
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
      .replace(/^language\s+(?:english|hindi|spanish|french|german|portuguese|japanese|korean|chinese)\s+/i, "")
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
      if (
        (looksLikeParticipantLabel(prefix) || looksLikeLowercaseParticipantPrefix(prefix, remainder)) &&
        startsLikeCaption(remainder)
      ) {
        return {
          speaker: prefix.join(" ").replace(/[\s:,-]+$/, ""),
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
      "great",
      "have",
      "here",
      "heres",
      "hello",
      "hey",
      "hi",
      "good",
      "thanks",
      "we",
      "i",
      "you",
      "it",
      "is",
      "its",
      "itself",
      "thats",
      "lets",
      "let",
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
    if (words.some((word) => /[.!?]/.test(word))) {
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
      "great",
      "have",
      "here",
      "heres",
      "hello",
      "hey",
      "hi",
      "good",
      "thanks",
      "we",
      "i",
      "you",
      "it",
      "is",
      "its",
      "itself",
      "thats",
      "lets",
      "let",
    ]);
    if (commonCaptionStarts.has(normalized[0].toLowerCase())) {
      return false;
    }

    return normalized.every((word) => word.length <= 3 || /^[A-Z]/.test(word));
  }

  function looksLikeLowercaseParticipantPrefix(prefix, remainder) {
    if (prefix.length < 2 || prefix.length > 3 || !startsLikeCaption(remainder)) {
      return false;
    }
    const normalized = prefix.map((word) => word.replace(/[^A-Za-z]/g, "")).filter(Boolean);
    if (normalized.length !== prefix.length) {
      return false;
    }
    const first = normalized[0].toLowerCase();
    if (isCommonCaptionStart(first)) {
      return false;
    }
    return normalized.every((word) => {
      const lower = word.toLowerCase();
      return word === lower && word.length >= 2 && word.length <= 24 && !isCommonCaptionStart(lower);
    });
  }

  function startsLikeCaption(words) {
    if (!words.length) {
      return false;
    }
    const first = words[0].replace(/[^A-Za-z]/g, "").toLowerCase();
    return isCommonCaptionStart(first);
  }

  function isCommonCaptionStart(word) {
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
      "great",
      "have",
      "here",
      "heres",
      "hello",
      "hey",
      "hi",
      "good",
      "thanks",
      "we",
      "i",
      "im",
      "you",
      "it",
      "is",
      "now",
      "please",
    ]);
    return commonStarts.has(word);
  }

  function normalizeApiBase(value) {
    const trimmed = normalizeText(value) || DEFAULT_API_BASE;
    return trimmed.replace(/\/+$/, "");
  }

  function detectPlatform() {
    const host = window.location.hostname.toLowerCase();
    if (host === "meet.google.com") {
      return "google_meet";
    }
    if (
      host === "teams.microsoft.com" ||
      host.endsWith(".teams.microsoft.com") ||
      host === "teams.cloud.microsoft" ||
      host.endsWith(".teams.cloud.microsoft") ||
      host === "teams.live.com" ||
      host.endsWith(".teams.live.com")
    ) {
      return "microsoft_teams";
    }
    return "unknown";
  }

  function platformSource() {
    return state.platform === "microsoft_teams" ? "microsoft_teams" : "google_meet";
  }

  function platformLabel() {
    return state.platform === "microsoft_teams" ? "Microsoft Teams" : "Google Meet";
  }

  function meetingTitle() {
    const title = normalizeText(document.title)
      .replace(/\s*-\s*Google Meet\s*$/i, "")
      .replace(/\s*\|\s*Microsoft Teams\s*$/i, "")
      .replace(/\s*-\s*Microsoft Teams\s*$/i, "");
    const code = meetingCode();
    if (title) {
      return title;
    }
    if (state.platform === "microsoft_teams") {
      return code ? `Teams - ${code}` : "Microsoft Teams live meeting";
    }
    return code ? `Meet - ${code}` : "Google Meet live meeting";
  }

  function meetingCode() {
    if (detectPlatform() === "microsoft_teams") {
      const explicitMatch = decodeURIComponent(window.location.href).match(/19:meeting_([^@/?#]+)/i);
      if (explicitMatch) {
        return `teams-${hashText(explicitMatch[1])}`;
      }
      return `teams-${hashText(window.location.origin + window.location.pathname)}`;
    }
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
    ui.dataset.visible = shouldShowPanel() ? "true" : "false";
    ui.dataset.minimized = state.isMinimized ? "true" : "false";

    const statePill = ui.querySelector('[data-role="state"]');
    const count = ui.querySelector('[data-role="count"]');
    const pause = ui.querySelector('[data-action="pause"]');
    const apiInput = ui.querySelector("#mom-api-base");
    const transcript = ui.querySelector('[data-role="transcript"]');
    const timer = ui.querySelector('[data-role="timer"]');
    const recordDot = ui.querySelector('[data-role="record-dot"]');
    const miniState = ui.querySelector('[data-role="mini-state"]');
    const miniPreview = ui.querySelector('[data-role="mini-preview"]');
    const miniTimer = ui.querySelector('[data-role="mini-timer"]');
    const miniRecordDot = ui.querySelector('[data-role="mini-record-dot"]');

    const hasActiveMeeting = Boolean(state.meetingId);
    const stateText = state.isEnding
      ? `Ending #${state.meetingId}`
      : state.isCapturing
      ? `Live #${state.meetingId}`
      : hasActiveMeeting
        ? `Paused #${state.meetingId}`
        : "Idle";
    const elapsed = state.captureStartedAt && hasActiveMeeting
      ? formatTimer((Date.now() - state.captureStartedAt) / 1000)
      : "00:00";

    statePill.textContent = stateText;
    statePill.dataset.state = state.isCapturing ? "live" : hasActiveMeeting ? "paused" : "idle";
    count.textContent = `${state.sentCount} sent · ${state.pendingSegments.length} queued`;
    pause.textContent = hasActiveMeeting && !state.isCapturing ? "Resume" : "Pause";
    pause.disabled = !hasActiveMeeting || state.isEnding;
    apiInput.disabled = hasActiveMeeting;
    timer.textContent = elapsed;
    recordDot.dataset.state = state.isCapturing ? "live" : hasActiveMeeting ? "paused" : "idle";
    miniState.textContent = stateText;
    miniTimer.textContent = elapsed;
    miniRecordDot.dataset.state = state.isCapturing ? "live" : hasActiveMeeting ? "paused" : "idle";

    const renderedPreviewSegments = previewSegmentsForDisplay();
    if (renderedPreviewSegments.length === 0) {
      transcript.innerHTML = `<div class="mom-transcript-empty">Live captions will appear here.</div>`;
      miniPreview.textContent = hasActiveMeeting ? `${state.sentCount} sent · ${state.pendingSegments.length} queued` : "iMann capture ready";
    } else {
      const latest = renderedPreviewSegments[renderedPreviewSegments.length - 1];
      miniPreview.textContent = latest.text || `${state.sentCount} sent · ${state.pendingSegments.length} queued`;
      transcript.innerHTML = renderedPreviewSegments
        .map(
          (segment) => `
            <div class="mom-transcript-line">
              <span>${escapeHtml(segment.speaker)}</span>
              <p>${escapeHtml(segment.text)}</p>
            </div>
          `,
        )
        .join("");
      scrollTranscriptToBottom(transcript);
    }
  }

  function renderStatus(message) {
    ui.querySelector('[data-role="status"]').textContent = message;
  }

  function scrollTranscriptToBottom(transcript) {
    transcript.scrollTop = transcript.scrollHeight;
    window.requestAnimationFrame(() => {
      transcript.scrollTop = transcript.scrollHeight;
    });
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function errorMessage(error) {
    if (error instanceof TypeError) {
      return `Could not reach iMann backend at ${state.apiBase}.`;
    }
    return error instanceof Error ? error.message : "Unexpected iMann capture error.";
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
