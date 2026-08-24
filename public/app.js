// ============================================
// eTalk -- Fixed P2P Video Call
// Fixes applied:
// 1. Race condition: deterministic offer assignment (server-side)
// 2. Perfect negotiation: makingOffer + ignoreOffer guards
// 3. Auto-retry with TURN relay on connection failure
// 4. Proper cleanup on end-call
// 5. Socket error handlers (connect_error, connect_timeout)
// 6. ICE candidate queue + flush pattern
// 7. Connection state machine with helpful error messages
// ============================================

const socket = io(window.location.origin, {
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  autoConnect: true
});

// === DOM Elements ===
const pinScreen = document.getElementById('pin-screen');
const previewScreen = document.getElementById('preview-screen');
const waitingScreen = document.getElementById('waiting-screen');
const callScreen = document.getElementById('call-screen');
const reconnectScreen = document.getElementById('reconnect-screen');

const pinInput = document.getElementById('pin-input');
const joinBtn = document.getElementById('join-btn');
const errorMsg = document.getElementById('error-msg');

const previewVideo = document.getElementById('preview-video');
const previewToggleAudio = document.getElementById('preview-toggle-audio');
const previewToggleVideo = document.getElementById('preview-toggle-video');
const cancelPreviewBtn = document.getElementById('cancel-preview-btn');
const confirmJoinBtn = document.getElementById('confirm-join-btn');
const recordingDot = document.getElementById('recording-dot');

const waitingPin = document.getElementById('waiting-pin');
const cancelWaitBtn = document.getElementById('cancel-wait-btn');

const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const toggleAudioBtn = document.getElementById('toggle-audio-btn');
const toggleVideoBtn = document.getElementById('toggle-video-btn');
const screenShareBtn = document.getElementById('screen-share-btn');
const endCallBtn = document.getElementById('end-call-btn');
const connectionStatus = document.getElementById('connection-status');
const remoteMuted = document.getElementById('remote-muted');
const remoteScreenIndicator = document.getElementById('remote-screen-share-indicator');
const callTimer = document.getElementById('call-timer');
const localRecDot = document.getElementById('local-rec-dot');
const connectionQuality = document.getElementById('connection-quality');

const reconnectBtn = document.getElementById('reconnect-btn');
const reconnectCancelBtn = document.getElementById('reconnect-cancel-btn');

// === State ===
let localStream = null;
let peerConnection = null;
let currentPin = null;
let isAudioEnabled = true;
let isVideoEnabled = true;
let isScreenSharing = false;
let screenStream = null;
let originalVideoTrack = null;
let remoteAudioEnabled = true;
let callStartTime = null;
let timerInterval = null;
let isInCall = false;
let makingOffer = false;
let ignoreOffer = false;
let polite = false;
let iceCandidateQueue = [];
let isAudioOnly = false;
let retryCount = 0;
let isRelayMode = false;

// Hide screen share on mobile
if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
  screenShareBtn.classList.add('hidden');
}

// ============================================
// ICE SERVERS -- Multiple TURN for Nigeria
// ============================================
//
// TIER 1: Your own TURN server (most reliable)
//   Replace YOUR_TURN_IP with your Oracle Cloud VPS IP
//   Set up following the guide in SETUP.md
//
// TIER 2: Open Relay (free, 20GB/month)
//   No signup needed, works out of the box
//
// TIER 3: Backup free TURN servers
//   Less reliable but good as fallback
//
// ============================================

function getIceServers(relayOnly = false) {
  const config = {
    iceServers: [
      // Google STUN (always works for discovery)
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },

      // === TIER 1: YOUR OWN TURN SERVER ===
      // Uncomment and fill in after setting up Oracle Cloud VPS
      // {
      //   urls: 'turn:YOUR_TURN_IP:3478?transport=udp',
      //   username: 'etalkuser',
      //   credential: 'etalkpass123'
      // },
      // {
      //   urls: 'turn:YOUR_TURN_IP:3478?transport=tcp',
      //   username: 'etalkuser',
      //   credential: 'etalkpass123'
      // },
      // {
      //   urls: 'turns:YOUR_TURN_IP:5349?transport=tcp',
      //   username: 'etalkuser',
      //   credential: 'etalkpass123'
      // },

      // === TIER 2: Open Relay (free, no signup) ===
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:80?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },

      // === TIER 3: Backup free TURN ===
      {
        urls: 'turn:numb.viagenie.ca:3478',
        username: 'webrtc@live.com',
        credential: 'muazkh'
      },
      {
        urls: 'turn:turn.anyfirewall.com:443?transport=tcp',
        username: 'webrtc',
        credential: 'webrtc'
      }
    ],
    iceCandidatePoolSize: 10
  };

  // If normal connection fails, force TURN relay only
  // This bypasses symmetric NAT and mobile carrier blocks
  if (relayOnly) {
    config.iceTransportPolicy = 'relay';
  }

  return config;
}

// ============================================
// AUDIO CONSTRAINTS -- Maximum Echo Suppression
// ============================================
function getAudioConstraints() {
  return {
    echoCancellation: { exact: true },
    noiseSuppression: { exact: true },
    autoGainControl: { exact: true },
    channelCount: 1,
    sampleRate: 44100,
    sampleSize: 16
  };
}

// ============================================
// PIN INPUT
// ============================================
pinInput.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  joinBtn.disabled = e.target.value.length !== 4;
  errorMsg.textContent = '';
});

pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && pinInput.value.length === 4) {
    startPreview();
  }
});

joinBtn.addEventListener('click', startPreview);

// ============================================
// PREVIEW SCREEN
// ============================================
async function startPreview() {
  const pin = pinInput.value.trim();
  if (!/^\d{4}$/.test(pin)) {
    errorMsg.textContent = 'Please enter exactly 4 digits';
    return;
  }
  currentPin = pin;

  try {
    stopLocalStream();
    localStream = await getMediaStream();
    isAudioOnly = false;
  } catch (err) {
    console.error('Video access denied, trying audio-only:', err);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: getAudioConstraints()
      });
      isAudioOnly = true;
    } catch (err2) {
      errorMsg.textContent = 'Microphone access denied. Please allow access in browser settings.';
      return;
    }
  }

  previewVideo.srcObject = localStream;
  recordingDot.classList.toggle('hidden', isAudioOnly || !isVideoEnabled);
  showScreen('preview');
}

function getMediaStream() {
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user'
    },
    audio: getAudioConstraints()
  });
}

previewToggleAudio.addEventListener('click', () => {
  if (!localStream) return;
  isAudioEnabled = !isAudioEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = isAudioEnabled);
  previewToggleAudio.classList.toggle('active', isAudioEnabled);
});

previewToggleVideo.addEventListener('click', () => {
  if (!localStream || isAudioOnly) return;
  isVideoEnabled = !isVideoEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = isVideoEnabled);
  previewToggleVideo.classList.toggle('active', isVideoEnabled);
  recordingDot.classList.toggle('hidden', !isVideoEnabled);
});

cancelPreviewBtn.addEventListener('click', () => {
  stopLocalStream();
  resetToPinScreen();
});

confirmJoinBtn.addEventListener('click', () => {
  showScreen('waiting');
  waitingPin.textContent = currentPin;
  socket.emit('join-room', currentPin);
});

// ============================================
// WAITING SCREEN
// ============================================
cancelWaitBtn.addEventListener('click', () => {
  if (currentPin) socket.emit('end-call', currentPin);
  cleanup();
  resetToPinScreen();
});

// ============================================
// RECONNECT SCREEN
// ============================================
reconnectBtn.addEventListener('click', () => {
  if (currentPin) {
    socket.connect();
    socket.emit('join-room', currentPin);
    showScreen('waiting');
  }
});

reconnectCancelBtn.addEventListener('click', () => {
  cleanup();
  resetToPinScreen();
});

// ============================================
// CALL CONTROLS
// ============================================
toggleAudioBtn.addEventListener('click', () => {
  if (!localStream) return;
  isAudioEnabled = !isAudioEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = isAudioEnabled);
  toggleAudioBtn.classList.toggle('active', isAudioEnabled);
  socket.emit('toggle-audio', { pin: currentPin, enabled: isAudioEnabled });
});

toggleVideoBtn.addEventListener('click', () => {
  if (!localStream || isAudioOnly) return;
  isVideoEnabled = !isVideoEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = isVideoEnabled);
  toggleVideoBtn.classList.toggle('active', isVideoEnabled);
  localRecDot.classList.toggle('hidden', !isVideoEnabled);
  socket.emit('toggle-video', { pin: currentPin, enabled: isVideoEnabled });
});

screenShareBtn.addEventListener('click', toggleScreenShare);
endCallBtn.addEventListener('click', () => {
  socket.emit('end-call', currentPin);
  endCallLocal();
});

// ============================================
// SCREEN SHARING
// ============================================
async function toggleScreenShare() {
  if (!navigator.mediaDevices.getDisplayMedia) return;

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false
      });

      const screenTrack = screenStream.getVideoTracks()[0];
      const senders = peerConnection?.getSenders() || [];
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');

      if (videoSender && localStream) {
        originalVideoTrack = localStream.getVideoTracks()[0];
        await videoSender.replaceTrack(screenTrack);
        localStream.removeTrack(originalVideoTrack);
        localStream.addTrack(screenTrack);
        localVideo.srcObject = localStream;
      }

      isScreenSharing = true;
      screenShareBtn.classList.add('active');
      socket.emit('screen-share', { pin: currentPin, enabled: true });

      screenTrack.onended = () => stopScreenShare();
    } catch (err) {
      console.error('Screen share failed:', err);
    }
  } else {
    stopScreenShare();
  }
}

async function stopScreenShare() {
  if (!isScreenSharing) return;

  const screenTrack = screenStream?.getVideoTracks()[0];
  if (screenTrack) screenTrack.stop();

  if (originalVideoTrack && peerConnection && localStream) {
    const senders = peerConnection.getSenders();
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (videoSender) await videoSender.replaceTrack(originalVideoTrack);

    const currentScreenTrack = localStream.getVideoTracks()[0];
    if (currentScreenTrack) localStream.removeTrack(currentScreenTrack);
    localStream.addTrack(originalVideoTrack);
    localVideo.srcObject = localStream;
  }

  screenStream = null;
  originalVideoTrack = null;
  isScreenSharing = false;
  screenShareBtn.classList.remove('active');
  socket.emit('screen-share', { pin: currentPin, enabled: false });
}

// ============================================
// WEBRTC -- Perfect Negotiation + Auto Retry
// ============================================

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.onnegotiationneeded = null;
    peerConnection.close();
    peerConnection = null;
  }
  iceCandidateQueue = [];
  makingOffer = false;
  ignoreOffer = false;
}

async function createPeerConnection(forceRelay = false) {
  closePeerConnection();

  const config = getIceServers(forceRelay);
  peerConnection = new RTCPeerConnection(config);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.ontrack = (event) => {
    const [remoteStream] = event.streams;
    if (remoteStream) {
      remoteVideo.srcObject = remoteStream;
      remoteVideo.play().catch(() => {});
      updateConnectionStatus('Connected');
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && currentPin) {
      socket.emit('ice-candidate', { pin: currentPin, candidate: event.candidate });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('Connection state:', state);

    if (state === 'connected') {
      updateConnectionStatus('Connected');
      startCallTimer();
      retryCount = 0;
      isRelayMode = false;
    } else if (state === 'disconnected') {
      updateConnectionStatus('Reconnecting...');
    } else if (state === 'failed') {
      handleConnectionFailed();
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const iceState = peerConnection.iceConnectionState;
    console.log('ICE state:', iceState);
    if (iceState === 'failed') {
      handleConnectionFailed();
    }
  };

  peerConnection.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      const offer = await peerConnection.createOffer();
      if (peerConnection.signalingState !== 'stable') return;
      await peerConnection.setLocalDescription(offer);
      socket.emit('offer', { pin: currentPin, offer: offer });
    } catch (err) {
      console.error('Negotiation error:', err);
    } finally {
      makingOffer = false;
    }
  };
}

// ============================================
// CONNECTION FAILURE HANDLER -- Auto Retry
// ============================================
function handleConnectionFailed() {
  if (retryCount === 0 && !isRelayMode) {
    // First failure: try again with TURN relay only
    retryCount++;
    isRelayMode = true;
    updateConnectionStatus('Retrying with relay...');
    console.log('Connection failed. Retrying with TURN relay only...');

    setTimeout(async () => {
      if (isInCall) {
        closePeerConnection();
        await createPeerConnection(true); // force relay
        if (!polite) {
          // We make the offer
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          socket.emit('offer', { pin: currentPin, offer: offer });
        }
        // If polite, we wait for new offer from other side
      }
    }, 1000);
  } else if (retryCount >= 1) {
    // Second failure: show helpful message
    updateConnectionStatus('Connection failed');
    showConnectionFailedToast();
  }
}

function showConnectionFailedToast() {
  const old = document.querySelector('.connection-failed-toast');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.className = 'connection-failed-toast';
  toast.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px;">Could not connect</div>
    <div style="font-size:13px;line-height:1.5;">
      Try these fixes:<br/>
      1. Both switch to mobile data (MTN/Glo/Airtel)<br/>
      2. One person use VPN<br/>
      3. Try again in 1 minute<br/>
      4. Set up your own TURN server (see SETUP.md)
    </div>
    <button onclick="this.parentElement.remove()" style="margin-top:10px;padding:6px 16px;background:#00a884;border:none;border-radius:6px;color:white;cursor:pointer;">Got it</button>
  `;
  document.body.appendChild(toast);

  setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, 15000);
}

async function flushIceQueue() {
  while (iceCandidateQueue.length > 0 && peerConnection && peerConnection.remoteDescription) {
    const c = iceCandidateQueue.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(c));
    } catch (err) {
      console.error('Error adding queued ICE candidate:', err);
    }
  }
}

async function handleOffer(offer, from) {
  const readyForOffer = !makingOffer &&
    (peerConnection ? peerConnection.signalingState === 'stable' : true);

  ignoreOffer = !polite && !readyForOffer;

  if (ignoreOffer) {
    console.log('Ignoring impolite offer');
    return;
  }

  if (!peerConnection) await createPeerConnection(isRelayMode);

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  await flushIceQueue();

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('answer', { pin: currentPin, answer: answer });
}

async function handleAnswer(answer) {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  await flushIceQueue();
}

async function handleIceCandidate(candidate) {
  if (!peerConnection) {
    iceCandidateQueue.push(candidate);
    return;
  }
  if (!peerConnection.remoteDescription) {
    iceCandidateQueue.push(candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    if (!ignoreOffer) {
      console.error('Error adding ICE candidate:', err);
    }
  }
}

// ============================================
// CALL TIMER
// ============================================
function startCallTimer() {
  if (timerInterval) return;
  callStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    callTimer.textContent = mins + ':' + secs;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  callStartTime = null;
  callTimer.textContent = '00:00';
}

// ============================================
// CLEANUP
// ============================================
function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (previewVideo) previewVideo.srcObject = null;
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
}

function cleanup() {
  closePeerConnection();
  stopLocalStream();
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  originalVideoTrack = null;
  isScreenSharing = false;
  screenShareBtn.classList.remove('active');
  currentPin = null;
  isAudioEnabled = true;
  isVideoEnabled = true;
  isAudioOnly = false;
  isInCall = false;
  polite = false;
  retryCount = 0;
  isRelayMode = false;
  stopCallTimer();
  updateConnectionStatus('Connecting...');
  remoteMuted.classList.add('hidden');
  remoteScreenIndicator.classList.add('hidden');
  connectionQuality.classList.add('hidden');
  toggleAudioBtn.classList.add('active');
  toggleVideoBtn.classList.add('active');
  localRecDot.classList.remove('hidden');
  recordingDot.classList.add('hidden');
  const oldToast = document.querySelector('.connection-failed-toast');
  if (oldToast) oldToast.remove();
}

function endCallLocal() {
  cleanup();
  resetToPinScreen();
}

function resetToPinScreen() {
  showScreen('pin');
  pinInput.value = '';
  joinBtn.disabled = true;
  waitingPin.textContent = '';
  errorMsg.textContent = '';
}

function showScreen(name) {
  [pinScreen, previewScreen, waitingScreen, callScreen, reconnectScreen].forEach(s => s.classList.remove('active'));
  if (name === 'pin') pinScreen.classList.add('active');
  if (name === 'preview') previewScreen.classList.add('active');
  if (name === 'waiting') waitingScreen.classList.add('active');
  if (name === 'call') callScreen.classList.add('active');
  if (name === 'reconnect') reconnectScreen.classList.add('active');
}

function updateConnectionStatus(text) {
  connectionStatus.textContent = text;
  connectionStatus.style.display = text ? 'block' : 'none';
  if (text === 'Connected') {
    setTimeout(() => { connectionStatus.style.display = 'none'; }, 2500);
  }
}

// ============================================
// ENTER CALL SCREEN
// ============================================
function enterCallScreen() {
  showScreen('call');
  isInCall = true;
  if (localStream && localVideo) {
    localVideo.srcObject = localStream;
  }
  if (localRecDot) {
    localRecDot.classList.toggle('hidden', !isVideoEnabled || isAudioOnly);
  }
}

// ============================================
// VISIBILITY CHANGE -- Camera recovery
// ============================================
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !isInCall || isAudioOnly) return;
  const videoTrack = localStream?.getVideoTracks()[0];
  if (videoTrack && videoTrack.readyState === 'ended') {
    try {
      const newStream = await getMediaStream();
      const newTrack = newStream.getVideoTracks()[0];
      const oldTrack = localStream.getVideoTracks()[0];
      if (peerConnection) {
        const sender = peerConnection.getSenders().find(s => s.track === oldTrack);
        if (sender) await sender.replaceTrack(newTrack);
      }
      localStream.removeTrack(oldTrack);
      oldTrack.stop();
      localStream.addTrack(newTrack);
      localVideo.srcObject = localStream;
    } catch (err) {
      console.error('Failed to re-acquire camera:', err);
    }
  }
});

// ============================================
// SOCKET EVENTS
// ============================================

socket.on('waiting', (msg) => {
  console.log(msg);
});

socket.on('user-joined', async (data) => {
  console.log('User joined:', data.from, 'shouldOffer:', data.shouldOffer);
  enterCallScreen();
  polite = !data.shouldOffer;
  retryCount = 0;
  isRelayMode = false;

  if (data.shouldOffer) {
    await createPeerConnection();
  }
});

socket.on('offer', async (data) => {
  console.log('Received offer from:', data.from);
  await handleOffer(data.offer, data.from);
});

socket.on('answer', async (data) => {
  console.log('Received answer from:', data.from);
  await handleAnswer(data.answer);
});

socket.on('ice-candidate', async (data) => {
  await handleIceCandidate(data.candidate);
});

socket.on('toggle-audio', (data) => {
  remoteAudioEnabled = data.enabled;
  remoteMuted.classList.toggle('hidden', remoteAudioEnabled);
});

socket.on('toggle-video', (data) => {
  // Visual feedback if needed
});

socket.on('screen-share', (data) => {
  remoteScreenIndicator.classList.toggle('hidden', !data.enabled);
});

socket.on('call-ended', () => {
  alert('The other person ended the call');
  endCallLocal();
});

socket.on('user-left', () => {
  updateConnectionStatus('Other person left');
  closePeerConnection();
  remoteVideo.srcObject = null;
  stopCallTimer();
});

socket.on('error', (msg) => {
  if (msg.includes('full')) {
    cleanup();
    resetToPinScreen();
  }
  errorMsg.textContent = msg;
});

// FIX: Added missing socket error handlers
socket.on('disconnect', (reason) => {
  console.log('Socket disconnected:', reason);
  if (isInCall) {
    showScreen('reconnect');
  }
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
  errorMsg.textContent = 'Server connection failed. Please try again.';
});

socket.on('connect_timeout', () => {
  console.error('Connection timeout');
  errorMsg.textContent = 'Server not responding. Please check your internet.';
});

socket.on('reconnect', () => {
  console.log('Socket reconnected');
});

socket.on('reconnect_failed', () => {
  showScreen('reconnect');
});

// ============================================
// SAFETY
// ============================================
window.addEventListener('beforeunload', (e) => {
  if (isInCall) {
    e.preventDefault();
    e.returnValue = '';
  }
});
