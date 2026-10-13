/**
 * VoiceScribe Pro - Continuous Voice-to-Text Application
 * Core Logic: Web Speech API with mobile-compatible duplicate prevention,
 * strict index finalization, separate interim & final transcript state machines,
 * safe continuous automatic restarting, and multi-language support.
 */

'use strict';

(function () {
  // ---------------------------------------------------------------------------
  // 1. Browser Compatibility & Speech API Detection
  // ---------------------------------------------------------------------------
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isSpeechSupported = !!SpeechRecognition;

  // ---------------------------------------------------------------------------
  // 2. DOM Elements
  // ---------------------------------------------------------------------------
  // Microphone Controls
  const micHeroBtn = document.getElementById('micHeroBtn');
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const resumeBtn = document.getElementById('resumeBtn');
  const stopBtn = document.getElementById('stopBtn');
  const languageSelect = document.getElementById('languageSelect');

  // Status & Indicators
  const statusIndicator = document.getElementById('statusIndicator');
  const statusLabel = document.getElementById('statusLabel');
  const micStateMessage = document.getElementById('micStateMessage');
  const restartRecoveryStatus = document.getElementById('restartRecoveryStatus');

  // Speech Statistics
  const wordCountEl = document.getElementById('wordCount');
  const charCountEl = document.getElementById('charCount');
  const elapsedTimeEl = document.getElementById('elapsedTime');
  const restartCountEl = document.getElementById('restartCount');

  // Editor Surface & Tools
  const textEditor = document.getElementById('textEditor');
  const interimBadge = document.getElementById('interimBadge');
  const interimTextPreview = document.getElementById('interimTextPreview');
  const copyBtn = document.getElementById('copyBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const clearBtn = document.getElementById('clearBtn');
  const fontSizeDecBtn = document.getElementById('fontSizeDecBtn');
  const fontSizeIncBtn = document.getElementById('fontSizeIncBtn');
  const fontSizeResetBtn = document.getElementById('fontSizeResetBtn');

  // Modals & Banners
  const alertBanner = document.getElementById('alertBanner');
  const alertTitle = document.getElementById('alertTitle');
  const alertMessage = document.getElementById('alertMessage');
  const alertCloseBtn = document.getElementById('alertCloseBtn');

  const clearConfirmModal = document.getElementById('clearConfirmModal');
  const cancelClearBtn = document.getElementById('cancelClearBtn');
  const confirmClearBtn = document.getElementById('confirmClearBtn');

  const infoModal = document.getElementById('infoModal');
  const infoModalBtn = document.getElementById('infoModalBtn');
  const closeInfoModalBtn = document.getElementById('closeInfoModalBtn');
  const dismissInfoModalBtn = document.getElementById('dismissInfoModalBtn');

  const toastContainer = document.getElementById('toastContainer');
  const punctuationChips = document.querySelectorAll('.punct-chip');
  const langPills = document.querySelectorAll('.lang-pill');

  // ---------------------------------------------------------------------------
  // 3. Application State Variables
  // ---------------------------------------------------------------------------
  // Native Recognition & State Control
  let recognition = null;
  let isRecognitionActive = false; // Indicates if native recognition instance is alive
  let isListening = false;         // Indicates user intent to be actively listening
  let isPaused = false;            // Indicates user clicked Pause
  let isRestarting = false;        // Indicates transient restarting state
  let totalRestarts = 0;
  let restartTimeoutId = null;

  // Transcript Buffers (Kept strictly separated to prevent mobile repetitions)
  let finalTranscript = '';        // Cumulative committed finalized text
  let interimTranscript = '';      // Temporary in-progress speech preview
  let finalizedIndices = new Set();// Tracks event.results indices already finalized in current session

  // Language mapping
  let currentLanguage = languageSelect ? languageSelect.value : 'ta-IN';

  // Timer Variables
  let timerIntervalId = null;
  let timerStartTime = 0;
  let accumulatedTime = 0;         // in milliseconds

  // Editor Font Size State
  let currentFontSize = 16;        // in px

  // Error streak guards
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 4;
  const RESTART_DELAY_MS = 350;    // Safe delay giving mobile Android audio HAL time to release

  // ---------------------------------------------------------------------------
  // 4. Initial Setup & Validation
  // ---------------------------------------------------------------------------
  function initializeApp() {
    setupEventListeners();
    applyLanguage(currentLanguage, false);
    updateButtonStates('idle');
    renderTranscripts();

    if (!isSpeechSupported) {
      showAlert(
        'error',
        'Browser Speech Recognition Unsupported',
        'Your browser does not support the Web Speech API. Please open this app in Google Chrome, Microsoft Edge, or a Chromium-based browser on desktop or Android.'
      );
      disableAllControls();
      updateStatusBadge('error', 'Unsupported');
      micStateMessage.innerHTML = '<strong>Speech Recognition Unsupported.</strong> Please use Google Chrome or Microsoft Edge.';
      return;
    }

    // Check if served directly via file:/// protocol
    if (window.location.protocol === 'file:') {
      showAlert(
        'warning',
        'Local File Protocol Detected',
        'You are running this application directly via file:///. In Google Chrome and Android Chrome, microphone permissions may be restricted unless served through localhost (e.g. VS Code Live Server) or HTTPS.'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Speech Recognition Instance Factory
  // ---------------------------------------------------------------------------
  function createRecognitionInstance() {
    if (!isSpeechSupported) return null;

    try {
      const rec = new SpeechRecognition();
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang = currentLanguage;

      rec.onresult = handleSpeechResult;
      rec.onstart = handleRecognitionStart;
      rec.onend = handleRecognitionEnd;
      rec.onerror = handleRecognitionError;

      return rec;
    } catch (err) {
      console.error('Failed to create SpeechRecognition instance:', err);
      showAlert('error', 'Initialization Error', 'Failed to initialize speech recognition engine: ' + err.message);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Speech Recognition Result Processing (Mobile-Optimized & Duplicate-Free)
  // ---------------------------------------------------------------------------

  /**
   * Core result handler:
   * - Eliminates Android Chrome duplicate bug where event.resultIndex is stuck at 0.
   * - Uses finalizedIndices Set to ensure each result index is committed at most once.
   * - Rebuilds interimTranscript from scratch each event so interim words never multiply.
   */
  function handleSpeechResult(event) {
    let newlyFinalizedText = '';
    interimTranscript = '';

    // Inspect all results provided in this event
    for (let i = 0; i < event.results.length; ++i) {
      const result = event.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        // Guard against duplicate processing of already finalized indices
        if (!finalizedIndices.has(i)) {
          finalizedIndices.add(i);
          const cleanTranscript = transcript.trim();
          if (cleanTranscript.length > 0) {
            newlyFinalizedText += (newlyFinalizedText ? ' ' : '') + cleanTranscript;
          }
        }
      } else {
        // Collect current in-progress non-final phrases
        interimTranscript += transcript;
      }
    }

    // Commit newly finalized segments to cumulative finalTranscript
    if (newlyFinalizedText.trim().length > 0) {
      appendFinalTranscript(newlyFinalizedText.trim());
    }

    // Render both final and interim to UI
    renderTranscripts();
  }

  /**
   * Safely appends newly finalized text to finalTranscript with intelligent
   * spacing and punctuation capitalization without repeating previous text.
   */
  function appendFinalTranscript(newText) {
    if (!newText) return;

    if (!finalTranscript || finalTranscript.trim().length === 0) {
      finalTranscript = formatSentenceStart(newText);
    } else {
      let separator = ' ';
      if (finalTranscript.endsWith('\n') || finalTranscript.endsWith(' ')) {
        separator = '';
      }

      // If previous text ended with sentence-terminating punctuation (. ? !), capitalize start
      const trimmedFinal = finalTranscript.trim();
      if (/[.!?]$/.test(trimmedFinal)) {
        newText = formatSentenceStart(newText);
      }

      finalTranscript = finalTranscript + separator + newText;
    }
  }

  /**
   * Capitalizes first character for Latin languages (leaves Tamil/Hindi unchanged).
   */
  function formatSentenceStart(text) {
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /**
   * Renders finalized and interim transcripts to the editor and floating badge.
   * Interim text is shown with distinct styling and is never committed to finalTranscript
   * until the browser flags it as isFinal.
   */
  function renderTranscripts() {
    const trimmedFinal = finalTranscript;
    const trimmedInterim = interimTranscript.trim();

    if (trimmedInterim.length > 0) {
      let separator = '';
      if (trimmedFinal.length > 0 && !trimmedFinal.endsWith(' ') && !trimmedFinal.endsWith('\n')) {
        separator = ' ';
      }

      // Display final text followed by highlighted interim preview in the editor
      textEditor.innerHTML = escapeHtml(trimmedFinal) + separator +
        '<span class="editor-interim" style="color: var(--teal-600); font-style: italic; opacity: 0.88;">' +
        escapeHtml(trimmedInterim) + '</span>';

      showInterimBadge(trimmedInterim);
    } else {
      if (trimmedFinal.length > 0) {
        textEditor.innerText = trimmedFinal;
      } else {
        textEditor.innerHTML = ''; // Empty allows CSS :empty placeholder to display cleanly
      }
      hideInterimBadge();
    }

    // Auto-scroll to ensure latest spoken text is visible
    textEditor.scrollTop = textEditor.scrollHeight;

    // Update real-time word and character counters
    updateStats();
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/\n/g, '<br>');
  }

  function showInterimBadge(interimText) {
    interimTextPreview.textContent = interimText;
    interimBadge.style.display = 'flex';
  }

  function hideInterimBadge() {
    interimBadge.style.display = 'none';
    interimTextPreview.textContent = '';
  }

  // ---------------------------------------------------------------------------
  // 7. Recognition Session Lifecycle & Auto-Restart Logic
  // ---------------------------------------------------------------------------

  function handleRecognitionStart() {
    isRecognitionActive = true;
    isRestarting = false;
    consecutiveErrors = 0;
    finalizedIndices.clear(); // Clear indices for this new recognition session

    document.body.classList.add('is-listening');
    updateStatusBadge('listening', 'Listening');
    updateButtonStates('listening');
    startListeningTimer();

    const langName = getLanguageDisplayName(currentLanguage);
    micStateMessage.innerHTML = currentLanguage.startsWith('ta')
      ? `மைக் இயக்கத்தில் உள்ளது: <strong>${langName}</strong>. தெளிவாகப் பேசுங்கள்...`
      : `Microphone is active in <strong>${langName}</strong>. Speak clearly...`;
  }

  /**
   * Fired when recognition session ends (silence timeout, browser reset, or user stop).
   */
  function handleRecognitionEnd() {
    isRecognitionActive = false;

    // On mobile Android Chrome, if session ended abruptly with uncommitted interim text,
    // safely commit it so the last spoken sentence is never lost.
    if (interimTranscript.trim().length > 0) {
      appendFinalTranscript(interimTranscript.trim());
      interimTranscript = '';
      renderTranscripts();
    } else {
      hideInterimBadge();
    }

    finalizedIndices.clear();

    // Case 1: User explicitly paused
    if (isPaused) {
      document.body.classList.remove('is-listening');
      updateStatusBadge('paused', 'Paused');
      updateButtonStates('paused');
      pauseListeningTimer();
      micStateMessage.innerHTML = 'Microphone is paused. Click <strong>Resume</strong> or the Mic button to continue.';
      return;
    }

    // Case 2: User explicitly stopped listening
    if (!isListening) {
      document.body.classList.remove('is-listening');
      updateStatusBadge('idle', 'Stopped');
      updateButtonStates('idle');
      stopListeningTimer();
      micStateMessage.innerHTML = 'Microphone stopped. Click <strong>Start Listening</strong> to begin again.';
      return;
    }

    // Case 3: Session ended unexpectedly while user wants active listening -> Auto-restart!
    scheduleAutoRestart();
  }

  /**
   * Schedules a safe, non-overlapping restart with backoff to accommodate mobile audio drivers.
   */
  function scheduleAutoRestart() {
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.warn('Exceeded maximum consecutive recognition errors. Halting auto-restart.');
      isListening = false;
      document.body.classList.remove('is-listening');
      updateStatusBadge('error', 'Error');
      updateButtonStates('idle');
      stopListeningTimer();
      micStateMessage.innerHTML = '<strong>Automatic restart suspended.</strong> Please check microphone permissions or internet connection and click Start.';
      return;
    }

    isRestarting = true;
    totalRestarts++;
    restartCountEl.textContent = totalRestarts;

    updateStatusBadge('restarting', 'Restarting...');
    micStateMessage.innerHTML = 'Restoring speech connection... Keep speaking.';

    if (restartTimeoutId) clearTimeout(restartTimeoutId);

    restartTimeoutId = setTimeout(() => {
      if (!isListening || isPaused) return;
      startRecognitionSession();
    }, RESTART_DELAY_MS);
  }

  /**
   * Initiates a single, clean recognition instance, ensuring prior instances are fully torn down.
   */
  function startRecognitionSession() {
    if (!isSpeechSupported) return;
    if (!isListening || isPaused) return;

    // Safely tear down existing instance to prevent overlapping sessions
    if (recognition) {
      try {
        recognition.onresult = null;
        recognition.onend = null;
        recognition.onerror = null;
        recognition.onstart = null;
        recognition.abort();
      } catch (e) {
        console.warn('Error during instance cleanup:', e);
      }
      recognition = null;
      isRecognitionActive = false;
    }

    finalizedIndices.clear();
    recognition = createRecognitionInstance();
    if (!recognition) return;

    try {
      recognition.start();
    } catch (err) {
      console.warn('Recognition start exception, retrying safely:', err);
      isRecognitionActive = false;
      consecutiveErrors++;
      if (isListening && !isPaused && consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
        scheduleAutoRestart();
      }
    }
  }

  /**
   * Error handler for speech recognition.
   */
  function handleRecognitionError(event) {
    const error = event.error;
    console.warn('Speech Recognition Error:', error);

    // 'no-speech': Standard silence event in Web Speech API. onend will handle smooth recovery.
    if (error === 'no-speech') {
      micStateMessage.innerHTML = 'Waiting for speech input...';
      return;
    }

    // 'aborted': Occurs when abort() is explicitly invoked.
    if (error === 'aborted') {
      return;
    }

    // Fatal: Permission denied
    if (error === 'not-allowed' || error === 'service-not-allowed') {
      isListening = false;
      isPaused = false;
      consecutiveErrors = MAX_CONSECUTIVE_ERRORS;

      showAlert(
        'error',
        'Microphone Access Denied',
        'Microphone permission was denied by the browser or operating system. Please allow microphone access in your browser address bar settings and click Start.'
      );

      document.body.classList.remove('is-listening');
      updateStatusBadge('error', 'Permission Denied');
      updateButtonStates('idle');
      stopListeningTimer();
      micStateMessage.innerHTML = '<span style="color: var(--rose-600); font-weight: 700;">Microphone permission denied.</span> Please grant microphone access.';
      return;
    }

    // Fatal: Audio capture hardware missing
    if (error === 'audio-capture') {
      isListening = false;
      consecutiveErrors = MAX_CONSECUTIVE_ERRORS;

      showAlert(
        'error',
        'No Microphone Found',
        'No audio recording device was detected. Please connect a working microphone or headset and try again.'
      );

      document.body.classList.remove('is-listening');
      updateStatusBadge('error', 'No Mic Detected');
      updateButtonStates('idle');
      stopListeningTimer();
      micStateMessage.innerHTML = '<span style="color: var(--rose-600);">No microphone detected.</span> Please connect an audio input device.';
      return;
    }

    // Network error: Chrome connects to Google cloud speech servers
    if (error === 'network') {
      consecutiveErrors++;
      showToast('Network issue connecting to Google speech services. Retrying...', 'warning');
      micStateMessage.innerHTML = 'Network issue connecting to speech recognition server. Retrying...';
      return;
    }

    consecutiveErrors++;
    showToast(`Speech recognition issue: ${error}`, 'info');
  }

  // ---------------------------------------------------------------------------
  // 8. User Control Actions: Start, Pause, Resume, Stop
  // ---------------------------------------------------------------------------

  function startListening() {
    if (!isSpeechSupported) return;

    consecutiveErrors = 0;
    isListening = true;
    isPaused = false;

    startRecognitionSession();
    showToast(`Started listening in ${getLanguageDisplayName(currentLanguage)}`, 'info');
  }

  function pauseListening() {
    if (!isListening) return;

    isPaused = true;

    if (restartTimeoutId) {
      clearTimeout(restartTimeoutId);
      restartTimeoutId = null;
    }

    // Commit any in-progress interim text so it is not lost while paused
    if (interimTranscript.trim().length > 0) {
      appendFinalTranscript(interimTranscript.trim());
      interimTranscript = '';
      renderTranscripts();
    }

    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        try { recognition.abort(); } catch (e2) {}
      }
    }
    isRecognitionActive = false;

    document.body.classList.remove('is-listening');
    updateStatusBadge('paused', 'Paused');
    updateButtonStates('paused');
    pauseListeningTimer();
    hideInterimBadge();
    micStateMessage.innerHTML = 'Microphone is paused. Click <strong>Resume</strong> or the Mic button to continue.';
    showToast('Voice dictation paused', 'info');
  }

  function resumeListening() {
    if (!isPaused) return;

    isPaused = false;
    isListening = true;
    consecutiveErrors = 0;

    startRecognitionSession();
    showToast('Voice dictation resumed', 'info');
  }

  function stopListening() {
    isListening = false;
    isPaused = false;
    isRestarting = false;

    if (restartTimeoutId) {
      clearTimeout(restartTimeoutId);
      restartTimeoutId = null;
    }

    // Commit any leftover interim speech before shutting down
    if (interimTranscript.trim().length > 0) {
      appendFinalTranscript(interimTranscript.trim());
      interimTranscript = '';
      renderTranscripts();
    }

    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        try { recognition.abort(); } catch (e2) {}
      }
    }
    isRecognitionActive = false;

    document.body.classList.remove('is-listening');
    updateStatusBadge('idle', 'Stopped');
    updateButtonStates('idle');
    stopListeningTimer();
    hideInterimBadge();
    micStateMessage.innerHTML = 'Microphone stopped. Click <strong>Start Listening</strong> to begin again.';
    showToast('Voice recognition stopped', 'info');
  }

  function toggleMicHero() {
    if (isListening && !isPaused) {
      stopListening();
    } else if (isPaused) {
      resumeListening();
    } else {
      startListening();
    }
  }

  // ---------------------------------------------------------------------------
  // 9. Language Management & Localization
  // ---------------------------------------------------------------------------

  function applyLanguage(newLang, notify = true) {
    currentLanguage = newLang;

    // Synchronize select dropdown
    if (languageSelect && languageSelect.value !== newLang) {
      languageSelect.value = newLang;
    }

    // Synchronize quick select pill active states
    if (langPills) {
      langPills.forEach(pill => {
        if (pill.getAttribute('data-lang') === newLang) {
          pill.classList.add('active');
        } else {
          pill.classList.remove('active');
        }
      });
    }

    // Update dynamic editor placeholder
    if (newLang.startsWith('ta')) {
      textEditor.setAttribute('data-placeholder', "உங்கள் குரல் தமிழில் உடனுக்குடன் இங்கே எழுதப்படும்... 'Start Listening' அல்லது மைக் பொத்தானை அழுத்தவும்...");
    } else if (newLang.startsWith('hi')) {
      textEditor.setAttribute('data-placeholder', "आपके बोले गए शब्द यहां वास्तविक समय में दिखाई देंगे... 'Start Listening' पर क्लिक करें...");
    } else {
      textEditor.setAttribute('data-placeholder', "Your spoken words will appear here continuously in real time. Click 'Start Listening' and speak into your microphone...");
    }

    const langName = getLanguageDisplayName(newLang);

    if (notify) {
      showToast(`Language set to ${langName}`, 'info');
    }

    // If currently listening, seamlessly switch language by restarting the session
    if (isListening && !isPaused) {
      micStateMessage.innerHTML = newLang.startsWith('ta')
        ? `மைக் இயக்கத்தில் உள்ளது: <strong>${langName}</strong>. தெளிவாகப் பேசுங்கள்...`
        : `Microphone is active in <strong>${langName}</strong>. Speak clearly...`;

      startRecognitionSession();
    }
  }

  function handleLanguageChange(event) {
    applyLanguage(event.target.value, true);
  }

  function getLanguageDisplayName(code) {
    switch (code) {
      case 'ta-IN': return 'தமிழ் - இந்தியா / Tamil (India)';
      case 'ta-LK': return 'தமிழ் - இலங்கை / Tamil (Sri Lanka)';
      case 'ta-SG': return 'தமிழ் - சிங்கப்பூர் / Tamil (Singapore)';
      case 'ta-MY': return 'தமிழ் - மலேசியா / Tamil (Malaysia)';
      case 'en-IN': return 'English (India)';
      case 'en-US': return 'English (US)';
      case 'en-GB': return 'English (UK)';
      case 'hi-IN': return 'हिन्दी - भारत / Hindi (India)';
      default: return code;
    }
  }

  // ---------------------------------------------------------------------------
  // 10. Editor Actions: Manual Typing Sync, Copy, Download, Clear, Punctuation
  // ---------------------------------------------------------------------------

  /**
   * Synchronizes manual user typing in the editor into finalTranscript,
   * cleanly stripping out any active interim preview span so interim speech
   * doesn't get baked into finalTranscript prematurely.
   */
  function syncEditorManualEdits() {
    const clone = textEditor.cloneNode(true);
    const interimSpan = clone.querySelector('.editor-interim');
    if (interimSpan) {
      interimSpan.remove();
    }
    finalTranscript = clone.innerText;

    if (!finalTranscript.trim()) {
      finalTranscript = '';
      if (!interimTranscript.trim()) {
        textEditor.innerHTML = '';
      }
    }
    updateStats();
  }

  async function copyTextToClipboard() {
    const textToCopy = (finalTranscript + (interimTranscript ? ' ' + interimTranscript : '')).trim();

    if (!textToCopy) {
      showToast('Editor is empty. Nothing to copy!', 'warning');
      return;
    }

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = textToCopy;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      showToast('Transcribed text copied to clipboard!', 'success');
    } catch (err) {
      console.error('Failed to copy text:', err);
      showToast('Failed to copy to clipboard', 'error');
    }
  }

  function downloadTextFile() {
    const textToExport = (finalTranscript + (interimTranscript ? ' ' + interimTranscript : '')).trim();

    if (!textToExport) {
      showToast('Editor is empty. Nothing to download!', 'warning');
      return;
    }

    const now = new Date();
    const dateStamp = now.toISOString().slice(0, 10);
    const timeStamp = now.toTimeString().slice(0, 5).replace(':', '-');
    const fileName = `VoiceScribe_Transcript_${dateStamp}_${timeStamp}.txt`;

    const blob = new Blob([textToExport], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast(`Downloaded as "${fileName}"`, 'success');
  }

  function promptClearText() {
    const currentTotal = (finalTranscript + (interimTranscript ? ' ' + interimTranscript : '')).trim();
    if (!currentTotal) {
      showToast('Editor is already empty!', 'info');
      return;
    }
    clearConfirmModal.style.display = 'flex';
  }

  function confirmClearText() {
    finalTranscript = '';
    interimTranscript = '';
    finalizedIndices.clear();
    textEditor.innerHTML = '';
    hideInterimBadge();
    updateStats();
    clearConfirmModal.style.display = 'none';
    showToast('All text cleared', 'info');
  }

  function cancelClearText() {
    clearConfirmModal.style.display = 'none';
  }

  function handlePunctuationInsert(punct) {
    if (!punct) return;

    // If there was any pending interim, commit it first
    if (interimTranscript.trim().length > 0) {
      appendFinalTranscript(interimTranscript.trim());
      interimTranscript = '';
    }

    if (punct === '.' || punct === ',' || punct === '?' || punct === '!') {
      finalTranscript = finalTranscript.replace(/\s+$/, '') + punct + ' ';
    } else {
      // New paragraph or connector word
      finalTranscript = finalTranscript + punct;
    }

    renderTranscripts();
    textEditor.focus();
  }

  function changeFontSize(delta) {
    currentFontSize = Math.min(28, Math.max(13, currentFontSize + delta));
    textEditor.style.fontSize = `${currentFontSize}px`;
    fontSizeResetBtn.textContent = `${currentFontSize}px`;
  }

  function resetFontSize() {
    currentFontSize = 16;
    textEditor.style.fontSize = `${currentFontSize}px`;
    fontSizeResetBtn.textContent = `${currentFontSize}px`;
  }

  // ---------------------------------------------------------------------------
  // 11. Word & Character Counter
  // ---------------------------------------------------------------------------
  function updateStats() {
    const totalText = (finalTranscript + (interimTranscript ? ' ' + interimTranscript : '')).trim();

    charCountEl.textContent = totalText.length;

    if (totalText.length === 0) {
      wordCountEl.textContent = '0';
    } else {
      const words = totalText.split(/\s+/).filter(word => word.length > 0);
      wordCountEl.textContent = words.length;
    }
  }

  // ---------------------------------------------------------------------------
  // 12. Listening Timer
  // ---------------------------------------------------------------------------
  function startListeningTimer() {
    if (timerIntervalId) return;

    timerStartTime = Date.now();
    timerIntervalId = setInterval(() => {
      const currentElapsed = accumulatedTime + (Date.now() - timerStartTime);
      renderElapsedTime(currentElapsed);
    }, 500);
  }

  function pauseListeningTimer() {
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
      accumulatedTime += Date.now() - timerStartTime;
    }
    renderElapsedTime(accumulatedTime);
  }

  function stopListeningTimer() {
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
      accumulatedTime += Date.now() - timerStartTime;
    }
    renderElapsedTime(accumulatedTime);
  }

  function renderElapsedTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const pad = (n) => String(n).padStart(2, '0');

    if (hours > 0) {
      elapsedTimeEl.textContent = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    } else {
      elapsedTimeEl.textContent = `${pad(minutes)}:${pad(seconds)}`;
    }
  }

  // ---------------------------------------------------------------------------
  // 13. UI State & Status Helpers
  // ---------------------------------------------------------------------------
  function updateStatusBadge(statusClass, labelText) {
    statusIndicator.className = 'status-indicator status-' + statusClass;
    statusLabel.textContent = labelText;

    if (statusClass === 'listening') {
      restartRecoveryStatus.textContent = 'Active (Listening)';
      restartRecoveryStatus.style.color = 'var(--teal-600)';
    } else if (statusClass === 'restarting') {
      restartRecoveryStatus.textContent = 'Re-establishing session...';
      restartRecoveryStatus.style.color = 'var(--primary-600)';
    } else if (statusClass === 'paused') {
      restartRecoveryStatus.textContent = 'Paused';
      restartRecoveryStatus.style.color = 'var(--amber-600)';
    } else {
      restartRecoveryStatus.textContent = isListening ? 'Active' : 'Standby';
      restartRecoveryStatus.style.color = 'var(--slate-600)';
    }
  }

  function updateButtonStates(state) {
    if (!isSpeechSupported) {
      disableAllControls();
      return;
    }

    if (state === 'listening') {
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      resumeBtn.disabled = true;
      stopBtn.disabled = false;
      micHeroBtn.setAttribute('title', 'Click to Stop Listening');
    } else if (state === 'paused') {
      startBtn.disabled = true;
      pauseBtn.disabled = true;
      resumeBtn.disabled = false;
      stopBtn.disabled = false;
      micHeroBtn.setAttribute('title', 'Click to Resume Listening');
    } else {
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      resumeBtn.disabled = true;
      stopBtn.disabled = true;
      micHeroBtn.setAttribute('title', 'Click to Start Listening');
    }
  }

  function disableAllControls() {
    startBtn.disabled = true;
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    stopBtn.disabled = true;
    micHeroBtn.disabled = true;
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.parentElement.removeChild(toast);
      }
    }, 3000);
  }

  function showAlert(type, title, text) {
    alertBanner.className = `alert-banner alert-${type}`;
    alertTitle.textContent = title;
    alertMessage.textContent = text;
    alertBanner.style.display = 'block';
  }

  function hideAlert() {
    alertBanner.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // 14. Event Listeners Wiring
  // ---------------------------------------------------------------------------
  function setupEventListeners() {
    // Microphone buttons
    micHeroBtn.addEventListener('click', toggleMicHero);
    startBtn.addEventListener('click', startListening);
    pauseBtn.addEventListener('click', pauseListening);
    resumeBtn.addEventListener('click', resumeListening);
    stopBtn.addEventListener('click', stopListening);

    // Language dropdown
    languageSelect.addEventListener('change', handleLanguageChange);

    // Quick language pill selector buttons
    if (langPills) {
      langPills.forEach((pill) => {
        pill.addEventListener('click', () => {
          const lang = pill.getAttribute('data-lang');
          applyLanguage(lang, true);
        });
      });
    }

    // Editor manual typing & paste synchronization
    textEditor.addEventListener('input', syncEditorManualEdits);
    textEditor.addEventListener('keyup', syncEditorManualEdits);
    textEditor.addEventListener('paste', () => {
      setTimeout(syncEditorManualEdits, 10);
    });

    // Editor toolbar actions
    copyBtn.addEventListener('click', copyTextToClipboard);
    downloadBtn.addEventListener('click', downloadTextFile);
    clearBtn.addEventListener('click', promptClearText);

    // Clear confirmation modal
    confirmClearBtn.addEventListener('click', confirmClearText);
    cancelClearBtn.addEventListener('click', cancelClearText);
    clearConfirmModal.addEventListener('click', (e) => {
      if (e.target === clearConfirmModal) cancelClearText();
    });

    // Font size controls
    fontSizeIncBtn.addEventListener('click', () => changeFontSize(2));
    fontSizeDecBtn.addEventListener('click', () => changeFontSize(-2));
    fontSizeResetBtn.addEventListener('click', resetFontSize);

    // Quick punctuation & connector chips
    punctuationChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const punct = chip.getAttribute('data-punct');
        handlePunctuationInsert(punct);
      });
    });

    // Info guide modal
    infoModalBtn.addEventListener('click', () => {
      infoModal.style.display = 'flex';
    });
    closeInfoModalBtn.addEventListener('click', () => {
      infoModal.style.display = 'none';
    });
    dismissInfoModalBtn.addEventListener('click', () => {
      infoModal.style.display = 'none';
    });
    infoModal.addEventListener('click', (e) => {
      if (e.target === infoModal) infoModal.style.display = 'none';
    });

    // Alert banner close
    alertCloseBtn.addEventListener('click', hideAlert);

    // Keyboard shortcuts (Escape closes modals)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        clearConfirmModal.style.display = 'none';
        infoModal.style.display = 'none';
      }
    });

    // Warn user before leaving page if significant content exists
    window.addEventListener('beforeunload', (e) => {
      if (finalTranscript.trim().length > 10) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 15. Bootstrap Execution
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', initializeApp);
})();
