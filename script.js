/**
 * VoiceScribe Pro - Continuous Voice-to-Text Application
 * Core Logic: Web Speech API with self-healing continuous listening,
 * duplicate prevention, multi-language support, and comprehensive UI state management.
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
  // Controls
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

  // Statistics
  const wordCountEl = document.getElementById('wordCount');
  const charCountEl = document.getElementById('charCount');
  const elapsedTimeEl = document.getElementById('elapsedTime');
  const restartCountEl = document.getElementById('restartCount');

  // Editor
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

  // ---------------------------------------------------------------------------
  // 3. Application State Variables
  // ---------------------------------------------------------------------------
  let recognition = null;
  let isListening = false;
  let isPaused = false;
  let shouldAutoRestart = false; // Flag to control whether onend should automatically restart
  let isRestarting = false;
  let restartAttempts = 0;
  let totalRestarts = 0;
  let restartTimeoutId = null;

  // Language mapping
  let currentLanguage = languageSelect ? languageSelect.value : 'en-IN';

  // Timer Variables
  let timerIntervalId = null;
  let timerStartTime = 0;
  let accumulatedTime = 0; // in milliseconds

  // Editor Font Size State
  let currentFontSize = 16; // in px

  // Consecutive error tracking (prevents rapid restart loops on permanent failures)
  let consecutiveErrorCount = 0;
  const MAX_CONSECUTIVE_ERRORS = 4;
  const RESTART_DELAY_MS = 300;

  // ---------------------------------------------------------------------------
  // 4. Initial Setup & Validation
  // ---------------------------------------------------------------------------
  function initializeApp() {
    setupEventListeners();
    updateButtonStates('idle');
    updateStats();

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

    // Inform user if served via file:/// protocol instead of localhost/https
    if (window.location.protocol === 'file:') {
      showAlert(
        'warning',
        'Local File Protocol Detected',
        'You are running this application directly via file:///. In Google Chrome, microphone permissions may be restricted unless served through localhost (e.g., VS Code Live Server) or HTTPS.'
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

      // Event: Speech Results (Final and Interim)
      rec.onresult = handleSpeechResult;

      // Event: Recognition Started
      rec.onstart = handleRecognitionStart;

      // Event: Recognition Ended (Session closed by browser or user)
      rec.onend = handleRecognitionEnd;

      // Event: Recognition Errors
      rec.onerror = handleRecognitionError;

      return rec;
    } catch (err) {
      console.error('Failed to create SpeechRecognition instance:', err);
      showAlert('error', 'Initialization Error', 'Failed to initialize speech recognition engine: ' + err.message);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Speech Recognition Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Fired when the speech recognition engine successfully starts listening.
   */
  function handleRecognitionStart() {
    isListening = true;
    isRestarting = false;
    consecutiveErrorCount = 0; // Reset error streak on successful start

    document.body.classList.add('is-listening');
    updateStatusBadge('listening', 'Listening');
    updateButtonStates('listening');
    startListeningTimer();

    const langName = getLanguageDisplayName(currentLanguage);
    micStateMessage.innerHTML = `Microphone is active in <strong>${langName}</strong>. Speak clearly...`;
    hideInterimBadge();
  }

  /**
   * Processes speech recognition results with duplicate prevention and live interim previews.
   */
  function handleSpeechResult(event) {
    let finalSentence = '';
    let interimSentence = '';

    // Loop through the results starting from event.resultIndex
    // This is crucial: processing only new items prevents re-appending already committed phrases.
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        finalSentence += transcript;
      } else {
        interimSentence += transcript;
      }
    }

    // 1. Process Finalized Text
    if (finalSentence.trim().length > 0) {
      commitFinalTranscript(finalSentence);
      hideInterimBadge();
    }

    // 2. Process Interim (In-Progress) Text
    if (interimSentence.trim().length > 0) {
      showInterimBadge(interimSentence);
    } else if (finalSentence.trim().length > 0) {
      hideInterimBadge();
    }

    updateStats();
  }

  /**
   * Safely appends finalized speech to the editor while preserving existing text
   * and formatting spacing smoothly.
   */
  function commitFinalTranscript(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Get current raw editor content
    const currentText = textEditor.innerText;

    // Check if we need leading whitespace
    let separator = ' ';
    if (currentText.length === 0 || currentText.endsWith('\n') || currentText.endsWith(' ')) {
      separator = '';
    }

    // Capitalize first letter if it's the start of text or follows terminal punctuation (. ? !)
    let formattedText = trimmed;
    if (currentText.length === 0 || /[.!?]\s*$/.test(currentText)) {
      formattedText = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }

    // Append to contenteditable without destroying focus or selection
    if (currentText.length === 0) {
      textEditor.innerText = formattedText;
    } else {
      textEditor.innerText = currentText + separator + formattedText;
    }

    // Scroll editor to bottom so user always sees newest words
    textEditor.scrollTop = textEditor.scrollHeight;
  }

  /**
   * Displays the temporary interim transcript in the floating indicator.
   */
  function showInterimBadge(interimText) {
    interimTextPreview.textContent = interimText;
    interimBadge.style.display = 'flex';
  }

  /**
   * Hides the interim preview badge when speech is finalized or stopped.
   */
  function hideInterimBadge() {
    interimBadge.style.display = 'none';
    interimTextPreview.textContent = '';
  }

  /**
   * Fired when the speech recognition session ends.
   * Handles safe, automatic restarting if the user still wants listening active.
   */
  function handleRecognitionEnd() {
    hideInterimBadge();

    // Case 1: User explicitly paused the microphone
    if (isPaused) {
      document.body.classList.remove('is-listening');
      updateStatusBadge('paused', 'Paused');
      updateButtonStates('paused');
      pauseListeningTimer();
      micStateMessage.innerHTML = 'Microphone is paused. Click <strong>Resume</strong> or the Mic button to continue.';
      return;
    }

    // Case 2: User explicitly clicked Stop or disabled continuous mode
    if (!shouldAutoRestart) {
      isListening = false;
      document.body.classList.remove('is-listening');
      updateStatusBadge('idle', 'Stopped');
      updateButtonStates('idle');
      stopListeningTimer();
      micStateMessage.innerHTML = 'Microphone stopped. Click <strong>Start Listening</strong> to begin again.';
      return;
    }

    // Case 3: Recognition stopped unexpectedly (silence cutoff, browser timeout, temporary network glitch)
    // Execute safe, automatic restart!
    handleAutoRestart();
  }

  /**
   * Executes safe automatic restart with delay and loop prevention.
   */
  function handleAutoRestart() {
    // If consecutive errors are too high, halt restart loop to protect browser
    if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
      console.warn('Exceeded maximum consecutive recognition errors. Halting auto-restart.');
      shouldAutoRestart = false;
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

    // Clear any previous restart timeout
    if (restartTimeoutId) clearTimeout(restartTimeoutId);

    restartTimeoutId = setTimeout(() => {
      if (!shouldAutoRestart || isPaused) return;

      try {
        if (recognition) {
          recognition.abort(); // Clear prior native instance cleanly
        }
        recognition = createRecognitionInstance();
        if (recognition) {
          recognition.start();
        }
      } catch (err) {
        console.error('Error during auto-restart:', err);
        consecutiveErrorCount++;
        // Retry once more with a longer delay if needed
        if (shouldAutoRestart && consecutiveErrorCount < MAX_CONSECUTIVE_ERRORS) {
          handleAutoRestart();
        }
      }
    }, RESTART_DELAY_MS);
  }

  /**
   * Fired when an error occurs in the recognition engine.
   */
  function handleRecognitionError(event) {
    const error = event.error;
    console.warn('Speech Recognition Event Error:', error);

    // Error: no-speech
    // Normal occurrence when user remains silent. Chrome closes session and fires onend.
    // We let onend trigger the smooth auto-restart without showing an alarming error banner!
    if (error === 'no-speech') {
      micStateMessage.innerHTML = 'Waiting for speech input...';
      return;
    }

    // Error: aborted
    // Normal occurrence when .stop() or .abort() is explicitly invoked by code.
    if (error === 'aborted') {
      return;
    }

    // Fatal Error: Microphone permission denied or blocked
    if (error === 'not-allowed' || error === 'service-not-allowed') {
      shouldAutoRestart = false;
      isListening = false;
      isPaused = false;
      consecutiveErrorCount = MAX_CONSECUTIVE_ERRORS;

      showAlert(
        'error',
        'Microphone Access Denied',
        'Microphone permission was denied by the browser or system. Please click the lock or camera/mic icon in your browser address bar, set Microphone to "Allow", and refresh or click Start.'
      );

      document.body.classList.remove('is-listening');
      updateStatusBadge('error', 'Permission Denied');
      updateButtonStates('idle');
      stopListeningTimer();
      micStateMessage.innerHTML = '<span style="color: var(--rose-600); font-weight: 700;">Microphone permission denied.</span> Please grant microphone access in browser settings.';
      return;
    }

    // Fatal Error: Audio capture device missing
    if (error === 'audio-capture') {
      shouldAutoRestart = false;
      isListening = false;
      consecutiveErrorCount = MAX_CONSECUTIVE_ERRORS;

      showAlert(
        'error',
        'No Microphone Found',
        'No audio recording device was detected. Please connect a working microphone or headset to your computer and try again.'
      );

      document.body.classList.remove('is-listening');
      updateStatusBadge('error', 'No Mic Detected');
      updateButtonStates('idle');
      stopListeningTimer();
      micStateMessage.innerHTML = '<span style="color: var(--rose-600);">No microphone detected.</span> Please connect an audio input device.';
      return;
    }

    // Network error: Chrome connects to Google speech servers
    if (error === 'network') {
      consecutiveErrorCount++;
      showToast('Network issue connecting to Google speech services. Retrying...', 'warning');
      micStateMessage.innerHTML = 'Network issue connecting to speech recognition server. Retrying...';
      return;
    }

    // Other unexpected errors
    consecutiveErrorCount++;
    showToast(`Speech recognition issue: ${error}`, 'info');
  }

  // ---------------------------------------------------------------------------
  // 7. Microphone Control Actions
  // ---------------------------------------------------------------------------

  /**
   * Starts continuous voice recognition session.
   */
  function startListening() {
    if (!isSpeechSupported) return;

    // Reset error streak and flags
    consecutiveErrorCount = 0;
    shouldAutoRestart = true;
    isPaused = false;

    // Create fresh instance if not exists
    if (!recognition) {
      recognition = createRecognitionInstance();
    }

    try {
      recognition.lang = currentLanguage;
      recognition.start();
      showToast(`Started listening in ${getLanguageDisplayName(currentLanguage)}`, 'info');
    } catch (err) {
      // If already started or aborting, recreate and start
      console.warn('Recognition start exception, recreating instance...', err);
      try {
        recognition.abort();
        recognition = createRecognitionInstance();
        recognition.start();
      } catch (innerErr) {
        console.error('Fatal start error:', innerErr);
        showAlert('error', 'Start Error', 'Unable to start speech recognition: ' + innerErr.message);
      }
    }
  }

  /**
   * Pauses continuous voice recognition session without losing transcribed content or timer.
   */
  function pauseListening() {
    if (!isListening && !isRestarting) return;

    isPaused = true;
    shouldAutoRestart = false; // Do not auto-restart while paused
    if (restartTimeoutId) clearTimeout(restartTimeoutId);

    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        console.warn('Error stopping on pause:', e);
      }
    }

    showToast('Voice dictation paused', 'info');
  }

  /**
   * Resumes listening after being paused.
   */
  function resumeListening() {
    if (!isPaused) return;

    isPaused = false;
    shouldAutoRestart = true;
    consecutiveErrorCount = 0;

    if (!recognition) {
      recognition = createRecognitionInstance();
    }

    try {
      recognition.lang = currentLanguage;
      recognition.start();
      showToast('Voice dictation resumed', 'info');
    } catch (err) {
      console.warn('Resume error, resetting instance:', err);
      recognition = createRecognitionInstance();
      recognition.start();
    }
  }

  /**
   * Stops continuous voice recognition session completely and halts auto-restart.
   */
  function stopListening() {
    shouldAutoRestart = false; // Prevents onend from restarting
    isPaused = false;
    isListening = false;
    isRestarting = false;

    if (restartTimeoutId) clearTimeout(restartTimeoutId);

    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        console.warn('Error on explicit stop:', e);
      }
    }

    document.body.classList.remove('is-listening');
    updateStatusBadge('idle', 'Stopped');
    updateButtonStates('idle');
    stopListeningTimer();
    hideInterimBadge();
    micStateMessage.innerHTML = 'Microphone stopped. Click <strong>Start Listening</strong> to begin again.';
    showToast('Voice recognition stopped', 'info');
  }

  /**
   * Toggles between Start and Stop when clicking the central hero mic button.
   */
  function toggleMicHero() {
    if (isListening || isRestarting) {
      stopListening();
    } else if (isPaused) {
      resumeListening();
    } else {
      startListening();
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Language Management
  // ---------------------------------------------------------------------------
  function handleLanguageChange(event) {
    const newLang = event.target.value;
    const oldLang = currentLanguage;
    currentLanguage = newLang;

    showToast(`Language set to ${getLanguageDisplayName(newLang)}`, 'info');

    // If currently listening, seamlessly switch language by restarting the session
    if (isListening && !isPaused) {
      try {
        shouldAutoRestart = true;
        if (recognition) {
          recognition.abort();
        }
        recognition = createRecognitionInstance();
        recognition.lang = currentLanguage;
        recognition.start();
      } catch (err) {
        console.error('Error switching language on the fly:', err);
      }
    } else if (recognition) {
      recognition.lang = currentLanguage;
    }
  }

  function getLanguageDisplayName(code) {
    switch (code) {
      case 'en-IN': return 'English (India)';
      case 'en-US': return 'English (US)';
      case 'ta-IN': return 'Tamil (தமிழ்)';
      case 'hi-IN': return 'Hindi (हिन्दी)';
      default: return code;
    }
  }

  // ---------------------------------------------------------------------------
  // 9. Editor Operations: Copy, Download, Clear, Punctuation & Font Size
  // ---------------------------------------------------------------------------

  /**
   * Copies transcribed text to clipboard with modern API and reliable fallback.
   */
  async function copyTextToClipboard() {
    const text = textEditor.innerText.trim();

    if (!text) {
      showToast('Editor is empty. Nothing to copy!', 'warning');
      return;
    }

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure origins
        const textarea = document.createElement('textarea');
        textarea.value = text;
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

  /**
   * Downloads transcribed text as a formatted .txt file.
   */
  function downloadTextFile() {
    const text = textEditor.innerText.trim();

    if (!text) {
      showToast('Editor is empty. Nothing to download!', 'warning');
      return;
    }

    const now = new Date();
    const dateStamp = now.toISOString().slice(0, 10);
    const timeStamp = now.toTimeString().slice(0, 5).replace(':', '-');
    const fileName = `VoiceScribe_Transcript_${dateStamp}_${timeStamp}.txt`;

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
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

  /**
   * Opens the confirmation dialog before wiping editor content.
   */
  function promptClearText() {
    const text = textEditor.innerText.trim();
    if (!text) {
      showToast('Editor is already empty!', 'info');
      return;
    }
    clearConfirmModal.style.display = 'flex';
  }

  function confirmClearText() {
    textEditor.innerHTML = '';
    hideInterimBadge();
    updateStats();
    clearConfirmModal.style.display = 'none';
    showToast('All text cleared', 'info');
  }

  function cancelClearText() {
    clearConfirmModal.style.display = 'none';
  }

  /**
   * Quick-inserts punctuation chips into the editor.
   */
  function handlePunctuationInsert(punct) {
    const currentText = textEditor.innerText;
    let separator = '';

    if (punct === '.' || punct === ',' || punct === '?' || punct === '!') {
      // Remove trailing whitespace before punctuation if any
      textEditor.innerText = currentText.replace(/\s+$/, '') + punct + ' ';
    } else {
      // New line / paragraph
      textEditor.innerText = currentText + punct;
    }

    textEditor.scrollTop = textEditor.scrollHeight;
    updateStats();
    textEditor.focus();
  }

  /**
   * Font size adjustments for the text editor.
   */
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
  // 10. Word & Character Counter
  // ---------------------------------------------------------------------------
  function updateStats() {
    const text = textEditor.innerText.trim();

    // Characters count
    charCountEl.textContent = text.length;

    // Word count calculation (handles multiline, spaces, tabs, and Indic languages)
    if (text.length === 0) {
      wordCountEl.textContent = '0';
    } else {
      const words = text.split(/\s+/).filter(word => word.length > 0);
      wordCountEl.textContent = words.length;
    }
  }

  // ---------------------------------------------------------------------------
  // 11. Timer Implementation (Accuracy via Performance/Date)
  // ---------------------------------------------------------------------------
  function startListeningTimer() {
    if (timerIntervalId) return; // Already running

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

  function resetTimer() {
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
    accumulatedTime = 0;
    renderElapsedTime(0);
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
  // 12. UI State & Status Helpers
  // ---------------------------------------------------------------------------

  /**
   * Updates status badge appearance (Idle, Listening, Paused, Restarting, Error).
   */
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
      restartRecoveryStatus.textContent = shouldAutoRestart ? 'Active' : 'Standby';
      restartRecoveryStatus.style.color = 'var(--slate-600)';
    }
  }

  /**
   * Manages enabled/disabled states of Start, Pause, Resume, and Stop buttons.
   */
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
      // idle or stopped
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

  // ---------------------------------------------------------------------------
  // 13. Toasts & Alert Banners
  // ---------------------------------------------------------------------------
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

    // Editor live typing & paste sync for word/char counting
    textEditor.addEventListener('input', () => {
      if (!textEditor.innerText.trim()) {
        textEditor.innerHTML = '';
      }
      updateStats();
    });
    textEditor.addEventListener('keyup', updateStats);
    textEditor.addEventListener('paste', () => {
      setTimeout(() => {
        if (!textEditor.innerText.trim()) {
          textEditor.innerHTML = '';
        }
        updateStats();
      }, 10);
    });

    // Editor actions
    copyBtn.addEventListener('click', copyTextToClipboard);
    downloadBtn.addEventListener('click', downloadTextFile);
    clearBtn.addEventListener('click', promptClearText);

    // Clear confirmation modal
    confirmClearBtn.addEventListener('click', confirmClearText);
    cancelClearBtn.addEventListener('click', cancelClearText);
    clearConfirmModal.addEventListener('click', (e) => {
      if (e.target === clearConfirmModal) cancelClearText();
    });

    // Font sizing
    fontSizeIncBtn.addEventListener('click', () => changeFontSize(2));
    fontSizeDecBtn.addEventListener('click', () => changeFontSize(-2));
    fontSizeResetBtn.addEventListener('click', resetFontSize);

    // Punctuation helper chips
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

    // Warn user before leaving page if speech content exists
    window.addEventListener('beforeunload', (e) => {
      if (textEditor.innerText.trim().length > 10) {
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
