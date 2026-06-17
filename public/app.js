/* ============================================================
   app.js — SignGlove Web Application
   Handles: WebSocket, Three.js 3D cube, flex bars,
            calibration wizard, library, test mode, export
   ============================================================ */
'use strict';

// ═══════════════════════════════════════════════════════════════
// ▶  Global State
// ═══════════════════════════════════════════════════════════════
const APP = {
  // Connection
  ws      : null,
  wsUrl   : localStorage.getItem('glove_ws_url') || `ws://${location.hostname || 'localhost'}:${location.port || 3000}`,
  serverOk: false,
  esp32Ok : false,

  // Live sensor data
  flex    : [0, 0, 0, 0, 0],
  pitch   : 0,
  roll    : 0,
  yaw     : 0,
  accel   : { x: 0, y: 0, z: 0 },
  detected: null,

  // Gyroscope-Only IMU state
  gyroRaw: { x: 0, y: 0, z: 0 },
  gyroCalibrated: { x: 0, y: 0, z: 0 },
  gyroOffsets: { x: 0, y: 0, z: 0 },
  gyroCalibrating: false,
  gyroCalibrationSamples: [],
  gyroLastTimestamp: 0,
  
  // Axis remapping configurations (startup presets)
  remap: {
    xSrc: 'x', xInv: true,  // Logical X (Roll) = -Physical X
    ySrc: 'y', yInv: false, // Logical Y (Pitch) = Physical Y
    zSrc: 'z', zInv: true   // Logical Z (Yaw) = -Physical Z
  },
  viewMode: 'cube', // 'cube' or 'board'
  chartBuffer: {
    x: Array(200).fill(0),
    y: Array(200).fill(0),
    z: Array(200).fill(0)
  },

  // Library
  library : {},
  libVersion : 1,

  // Navigation
  view    : 'dashboard',

  // Calibration wizard
  calib: {
    phase            : 'idle',   // idle | countdown | recording | done
    label            : '',
    countdownVal     : 3,
    samples          : [],
    samplesPerSession: 20,  // user-configurable
    sessionsTarget   : 3,   // user-configurable
    sessionsCompleted: 0,
    sessionResults   : [],  // per-session averages
    result           : null,
    timer            : null,
  },

  // Detection rolling buffer — 20-sample average before matching
  detectionBuf    : [],
  detectionBufSize: 20,

  // Test mode
  testHistory   : [],
  _lastDetected : null,
  totalDetects  : 0,

  // Sentence Typing State
  typing: {
    holdDuration: 1.2,
    cooldownDuration: 2.0,
    activeGesture: null,
    holdStart: 0,
    cooldownEnd: 0,
    isPaused: false,
    lastActionTime: 0
  },
  dictionary: [],

  // Stats
  fpsCounter    : { frames: 0, lastTime: Date.now() },
  peakPitch     : 0,
};

// ═══════════════════════════════════════════════════════════════
// ▶  WebSocket Manager
// ═══════════════════════════════════════════════════════════════
function connectWS(url) {
  if (APP.ws) { try { APP.ws.close(); } catch (_) {} }
  APP.wsUrl = url || APP.wsUrl;
  updateServerDot('connecting');

  try {
    APP.ws = new WebSocket(APP.wsUrl);
  } catch (e) {
    console.warn('[WS] Cannot create socket:', e.message);
    updateServerDot('offline');
    scheduleReconnect();
    return;
  }

  APP.ws.onopen = () => {
    console.log('[WS] Connected to server');
    APP.serverOk = true;
    updateServerDot('online');
    showToast('Connected to server', 'success');
    localStorage.setItem('glove_ws_url', APP.wsUrl);
    APP.ws.send(JSON.stringify({ type: 'identify', role: 'browser' }));
    document.getElementById('current-ws-url').textContent = APP.wsUrl;
  };

  APP.ws.onclose = () => {
    console.warn('[WS] Disconnected');
    APP.serverOk = false;
    APP.esp32Ok  = false;
    updateServerDot('offline');
    updateESP32Dot(false);
    scheduleReconnect();
  };

  APP.ws.onerror = () => {
    APP.serverOk = false;
    updateServerDot('offline');
  };

  APP.ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };
}

function scheduleReconnect() {
  setTimeout(() => { if (!APP.serverOk) connectWS(); }, 3500);
}

function sendWS(obj) {
  if (APP.ws && APP.ws.readyState === WebSocket.OPEN) {
    APP.ws.send(JSON.stringify(obj));
  }
}

// ─── Message dispatcher ────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'sensor_data':
      onSensorData(msg);
      break;

    case 'esp32_status': {
      const wasConnected = APP.esp32Ok;
      APP.esp32Ok = !!msg.connected;
      updateESP32Dot(APP.esp32Ok);
      if (APP.esp32Ok && !wasConnected) {
        startGyroCalibration();
      }
      break;
    }

    case 'library_update':
      setLibrary(msg.data || {}, msg.version, msg.last_updated);
      break;

    case 'calib_started':
      console.log('[WS] ESP32 confirmed calib start');
      break;

    case 'calib_progress':
      // ESP32 sends independent progress — we trust our own counter
      break;

    case 'sign_saved':
      if (APP.calib.phase === 'recording' || APP.calib.phase === 'done') {
        finishCalib(msg.label);
      }
      break;

    case 'yaw_reset':
      showToast('Yaw reset to 0°', 'info');
      break;

    case 'library_cleared':
      setLibrary({});
      showToast('Library cleared on ESP32', 'warning');
      break;

    default:
      break;
  }
}

// ═══════════════════════════════════════════════════════════════
// ▶  Status Indicators
// ═══════════════════════════════════════════════════════════════
function updateServerDot(state) {
  const dot  = document.getElementById('server-dot');
  const lbl  = document.getElementById('server-label');
  dot.classList.toggle('online', state === 'online');
  lbl.textContent = state === 'online' ? 'Server Online' : state === 'connecting' ? 'Connecting…' : 'Server Offline';
}

function updateESP32Dot(ok) {
  const dot = document.getElementById('esp32-dot');
  const lbl = document.getElementById('esp32-label');
  dot.classList.toggle('online', ok);
  lbl.textContent = ok ? 'ESP32 Online' : 'ESP32 Offline';
}

// ═══════════════════════════════════════════════════════════════
// ▶  Sensor Data Handler
// ═══════════════════════════════════════════════════════════════
function onSensorData(data) {
  APP.flex  = data.flex  || APP.flex;
  APP.accel = data.accel || APP.accel;

  // Process Gyroscope-Only IMU data
  APP.gyroRaw = data.gyro || { x: 0, y: 0, z: 0 };
  let remapped = applyGyroRemapping(APP.gyroRaw);
  
  if (APP.gyroCalibrating) {
    handleGyroCalibration(remapped);
  } else {
    // Subtract calibrated bias offsets
    let gx_cal = remapped.x - APP.gyroOffsets.x;
    let gy_cal = remapped.y - APP.gyroOffsets.y;
    let gz_cal = remapped.z - APP.gyroOffsets.z;

    // Apply noise gate / deadband to filter out micro-drift
    const DEADBAND = 0.4;
    APP.gyroCalibrated.x = Math.abs(gx_cal) < DEADBAND ? 0 : gx_cal;
    APP.gyroCalibrated.y = Math.abs(gy_cal) < DEADBAND ? 0 : gy_cal;
    APP.gyroCalibrated.z = Math.abs(gz_cal) < DEADBAND ? 0 : gz_cal;

    // Perform pure dead-reckoning integration to estimate current orientation
    const nowTime = performance.now();
    if (APP.gyroLastTimestamp === 0) {
      APP.gyroLastTimestamp = nowTime;
    } else {
      const dt = (nowTime - APP.gyroLastTimestamp) / 1000;
      APP.gyroLastTimestamp = nowTime;
      if (dt < 0.2) { // Guard against giant time jumps
        APP.roll  += APP.gyroCalibrated.x * dt;
        APP.pitch += APP.gyroCalibrated.y * dt;
        APP.yaw   += APP.gyroCalibrated.z * dt;
      }
    }

    // Update telemetry charts buffers
    updateChartBuffers(APP.gyroCalibrated.x, APP.gyroCalibrated.y, APP.gyroCalibrated.z);
    updateGyroUI();
  }

  // Auto-mark ESP32 online when data arrives (handles missed identify)
  if (!APP.esp32Ok) {
    APP.esp32Ok = true;
    updateESP32Dot(true);
  }

  // Rolling detection buffer — accumulate N live samples, then match
  APP.detectionBuf.push([...APP.flex]);
  if (APP.detectionBuf.length > APP.detectionBufSize) APP.detectionBuf.shift();
  if (APP.detectionBuf.length >= APP.detectionBufSize) {
    const avgFlex = [0, 0, 0, 0, 0];
    APP.detectionBuf.forEach(s => s.forEach((v, i) => { avgFlex[i] += v; }));
    avgFlex.forEach((_, i) => { avgFlex[i] /= APP.detectionBufSize; });
    APP.detected = detectSignLocally(avgFlex);
  } else {
    APP.detected = data.detected ?? null; // fall back to ESP32 until buffer fills
  }

  // FPS counter
  APP.fpsCounter.frames++;
  const now = Date.now();
  if (now - APP.fpsCounter.lastTime >= 1000) {
    document.getElementById('stat-fps').textContent = APP.fpsCounter.frames + ' Hz';
    APP.fpsCounter.frames  = 0;
    APP.fpsCounter.lastTime = now;
  }

  // Peak pitch
  const absPitch = Math.abs(APP.pitch);
  if (absPitch > APP.peakPitch) {
    APP.peakPitch = absPitch;
    document.getElementById('stat-pitch-max').textContent = APP.peakPitch.toFixed(1) + '°';
  }

  // Update all UI sections
  updateFlexBars('flex-bars', APP.flex);
  updateAngleDisplay();
  updateCube(APP.pitch, APP.roll, APP.yaw);
  updateDetectedBanner(APP.detected);

  // Per-view updates
  if (APP.view === 'test')      updateTestMode();
  if (APP.view === 'calibrate' && APP.calib.phase === 'recording') recordCalibSample();
  if (APP.view === 'typing')     handleTypingFrame();

  // Test flex bars (always update if visible)
  updateFlexBars('test-flex-bars', APP.flex);
  updateFlexBars('mini-flex-bars', APP.flex);
}

// ═══════════════════════════════════════════════════════════════
// ▶  Three.js — 3D Orientation Cube
// ═══════════════════════════════════════════════════════════════
let THREE_scene, THREE_camera, THREE_renderer, THREE_group, THREE_activeModel;
let THREE_cubeMesh, THREE_boardMesh;

function initCube() {
  const container = document.getElementById('cube-container');
  const W = container.clientWidth  || 380;
  const H = container.clientHeight || 280;

  THREE_scene = new THREE.Scene();

  THREE_camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);
  THREE_camera.position.set(0, 1.5, 5);
  THREE_camera.lookAt(0, 0, 0);

  THREE_renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  THREE_renderer.setSize(W, H);
  THREE_renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  THREE_renderer.setClearColor(0x000000, 0);
  container.appendChild(THREE_renderer.domElement);

  // ── Lighting ────────────────────────────────────────────────
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  THREE_scene.add(ambient);

  const dirA = new THREE.DirectionalLight(0x7c5cfc, 1.2);
  dirA.position.set(4, 6, 5);
  THREE_scene.add(dirA);

  const dirB = new THREE.DirectionalLight(0x2979ff, 0.8);
  dirB.position.set(-4, -4, 5);
  THREE_scene.add(dirB);

  const dirC = new THREE.DirectionalLight(0x00e5ff, 0.5);
  dirC.position.set(0, -6, -3);
  THREE_scene.add(dirC);

  // ── Group ───────────────────────────────────────────────────
  THREE_group = new THREE.Group();
  THREE_scene.add(THREE_group);

  // ── Build Cube Model ────────────────────────────────────────
  const geo = new THREE.BoxGeometry(2, 2, 2);
  const faceLabels = ['R', 'L', 'T', 'B', 'F', 'K'];
  const faceColors = [
    0x7c5cfc, 0x5a40d8,
    0x2979ff, 0x1860e0,
    0x00bcd4, 0x7b1fa2,
  ];
  const materials = faceColors.map((col, i) =>
    new THREE.MeshLambertMaterial({
      color: col,
      map: makeTextTexture(faceLabels[i], col),
    })
  );
  THREE_cubeMesh = new THREE.Mesh(geo, materials);

  // ── Build Board Model ───────────────────────────────────────
  buildBoardModel();

  // ── Set default model ──────────────────────────────────────
  THREE_activeModel = THREE_cubeMesh;
  THREE_group.add(THREE_activeModel);

  // ── Grid ────────────────────────────────────────────────────
  const grid = new THREE.GridHelper(8, 8, 0x2a2a5a, 0x1a1a3a);
  grid.position.y = -1.8;
  THREE_scene.add(grid);

  // ── Axes helper (small) ─────────────────────────────────────
  const axes = new THREE.AxesHelper(1.5);
  THREE_scene.add(axes);

  // ── Animate loop ────────────────────────────────────────────
  function animate() {
    requestAnimationFrame(animate);
    THREE_renderer.render(THREE_scene, THREE_camera);
  }
  animate();

  // Resize observer
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight || 280;
    THREE_camera.aspect = w / h;
    THREE_camera.updateProjectionMatrix();
    THREE_renderer.setSize(w, h);
  });
  ro.observe(container);
}

function buildBoardModel() {
  THREE_boardMesh = new THREE.Group();
  
  // PCB Substrate (Green board)
  const pcbGeo = new THREE.BoxGeometry(1.8, 0.08, 3.0);
  const pcbMat = new THREE.MeshPhongMaterial({ color: 0x064e3b, shininess: 30 });
  const pcb = new THREE.Mesh(pcbGeo, pcbMat);
  THREE_boardMesh.add(pcb);
  
  // Gold connection pins along the sides
  const pinMat = new THREE.MeshPhongMaterial({ color: 0xd97706, metalness: 0.9, roughness: 0.1 });
  const pinGeo = new THREE.BoxGeometry(0.1, 0.1, 0.06);
  for (let z = -1.3; z <= 1.3; z += 0.2) {
    const pinL = new THREE.Mesh(pinGeo, pinMat);
    pinL.position.set(-0.85, 0, z);
    THREE_boardMesh.add(pinL);
    
    const pinR = new THREE.Mesh(pinGeo, pinMat);
    pinR.position.set(0.85, 0, z);
    THREE_boardMesh.add(pinR);
  }
  
  // ESP32-S3 Module (Metallic main chip)
  const espGeo = new THREE.BoxGeometry(1.0, 0.12, 1.1);
  const espMat = new THREE.MeshPhongMaterial({ color: 0x27272a, metalness: 0.8, roughness: 0.2 });
  const esp = new THREE.Mesh(espGeo, espMat);
  esp.position.set(0, 0.08, 0.4);
  THREE_boardMesh.add(esp);
  
  // MPU6050 (Small black chip)
  const imuGeo = new THREE.BoxGeometry(0.4, 0.08, 0.4);
  const imuMat = new THREE.MeshPhongMaterial({ color: 0x18181b, shininess: 80 });
  const imu = new THREE.Mesh(imuGeo, imuMat);
  imu.position.set(0, 0.06, -0.6);
  THREE_boardMesh.add(imu);
  
  // White screenprint arrow on PCB
  const arrowGeo = new THREE.ConeGeometry(0.12, 0.3, 4);
  const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const arrow = new THREE.Mesh(arrowGeo, arrowMat);
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.051, -1.0);
  THREE_boardMesh.add(arrow);
  
  const shaftGeo = new THREE.BoxGeometry(0.05, 0.01, 0.3);
  const shaft = new THREE.Mesh(shaftGeo, arrowMat);
  shaft.position.set(0, 0.051, -0.8);
  THREE_boardMesh.add(shaft);
  
  // USB-C Connector (Metallic silver)
  const usbGeo = new THREE.BoxGeometry(0.5, 0.15, 0.3);
  const usbMat = new THREE.MeshPhongMaterial({ color: 0x94a3b8, metalness: 0.9, roughness: 0.15 });
  const usb = new THREE.Mesh(usbGeo, usbMat);
  usb.position.set(0, 0.05, -1.45);
  THREE_boardMesh.add(usb);
}

function setActiveModel(mode) {
  if (!THREE_group) return;
  THREE_group.remove(THREE_activeModel);
  if (mode === 'cube') {
    THREE_activeModel = THREE_cubeMesh;
  } else {
    THREE_activeModel = THREE_boardMesh;
  }
  THREE_group.add(THREE_activeModel);
}

function makeTextTexture(text, baseColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  // background
  ctx.fillStyle = '#' + baseColor.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, 128, 128);
  // border
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, 116, 116);
  // letter
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 64px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

function updateCube(pitch, roll, yaw) {
  if (!THREE_group) return;   // only skip if Three.js group not ready
  const pitchRad = pitch * (Math.PI / 180);
  const rollRad  = roll  * (Math.PI / 180);
  const yawRad   = yaw   * (Math.PI / 180);
  
  THREE_group.rotation.set(0, 0, 0);
  THREE_group.rotation.order = 'YXZ';
  
  THREE_group.rotation.x = pitchRad;
  THREE_group.rotation.y = -yawRad; // Invert yaw to match standard visual expectation
  THREE_group.rotation.z = -rollRad; // Invert roll to match visual bank direction
}

// ═══════════════════════════════════════════════════════════════
// ▶  Angle Display
// ═══════════════════════════════════════════════════════════════
function updateAngleDisplay() {
  document.getElementById('val-pitch').textContent = APP.pitch.toFixed(1) + '°';
  document.getElementById('val-roll').textContent  = APP.roll.toFixed(1)  + '°';
  document.getElementById('val-yaw').textContent   = ((APP.yaw % 360 + 360) % 360).toFixed(1)   + '°';
  document.getElementById('val-ax').textContent    = APP.accel.x.toFixed(2);
  document.getElementById('val-ay').textContent    = APP.accel.y.toFixed(2);
  document.getElementById('val-az').textContent    = APP.accel.z.toFixed(2);
}

// ═══════════════════════════════════════════════════════════════
// ▶  Gyroscope-Only IMU Logic
// ═══════════════════════════════════════════════════════════════

function applyGyroRemapping(raw) {
  const remapped = { x: 0, y: 0, z: 0 };
  
  const mapX = APP.remap.xSrc;
  const invX = APP.remap.xInv ? -1 : 1;
  
  const mapY = APP.remap.ySrc;
  const invY = APP.remap.yInv ? -1 : 1;
  
  const mapZ = APP.remap.zSrc;
  const invZ = APP.remap.zInv ? -1 : 1;
  
  remapped.x = raw[mapX] * invX;
  remapped.y = raw[mapY] * invY;
  remapped.z = raw[mapZ] * invZ;
  
  return remapped;
}

function startGyroCalibration() {
  APP.gyroCalibrating = true;
  APP.gyroCalibrationSamples = [];
  const btn = document.getElementById('btn-tare-gyro');
  if (btn) {
    btn.classList.add('active');
    btn.style.background = 'rgba(0, 240, 255, 0.1)';
    btn.style.borderColor = 'var(--color-z)';
    btn.querySelector('span').textContent = 'Calibrating (0%)…';
  }
  showToast('Calibration started. Keep the IMU glove still.', 'info');
}

function handleGyroCalibration(remapped) {
  APP.gyroCalibrationSamples.push({ ...remapped });
  const targetSamples = 200;
  const progress = Math.round((APP.gyroCalibrationSamples.length / targetSamples) * 100);
  
  const btn = document.getElementById('btn-tare-gyro');
  if (btn) {
    btn.querySelector('span').textContent = `Calibrating (${progress}%)…`;
  }
  
  if (APP.gyroCalibrationSamples.length >= targetSamples) {
    const sums = { x: 0, y: 0, z: 0 };
    APP.gyroCalibrationSamples.forEach(s => {
      sums.x += s.x;
      sums.y += s.y;
      sums.z += s.z;
    });
    
    const count = APP.gyroCalibrationSamples.length;
    APP.gyroOffsets.x = sums.x / count;
    APP.gyroOffsets.y = sums.y / count;
    APP.gyroOffsets.z = sums.z / count;
    
    APP.gyroCalibrating = false;
    APP.gyroCalibrationSamples = [];
    
    if (btn) {
      btn.classList.remove('active');
      btn.style.background = 'transparent';
      btn.style.borderColor = 'var(--glass-border)';
      btn.querySelector('span').textContent = 'Tare Gyro Bias';
    }
    
    resetGyroOrientation();
    showToast('Gyro calibration done successfully!', 'success');
  }
}

function resetGyroOrientation() {
  APP.pitch = 0;
  APP.roll  = 0;
  APP.yaw   = 0;
  showToast('Orientation reset to 0°', 'success');
}

function updateGyroUI() {
  const valGx = document.getElementById('val-gx');
  const valGy = document.getElementById('val-gy');
  const valGz = document.getElementById('val-gz');
  
  if (valGx) valGx.textContent = APP.gyroCalibrated.x.toFixed(1);
  if (valGy) valGy.textContent = APP.gyroCalibrated.y.toFixed(1);
  if (valGz) valGz.textContent = APP.gyroCalibrated.z.toFixed(1);
  
  const mapToPercent = (val, max) => Math.min(100, Math.max(0, (Math.abs(val) / max) * 100));
  
  const barGx = document.getElementById('bar-gx');
  const barGy = document.getElementById('bar-gy');
  const barGz = document.getElementById('bar-gz');
  
  if (barGx) barGx.style.width = `${mapToPercent(APP.gyroCalibrated.x, 250)}%`;
  if (barGy) barGy.style.width = `${mapToPercent(APP.gyroCalibrated.y, 250)}%`;
  if (barGz) barGz.style.width = `${mapToPercent(APP.gyroCalibrated.z, 250)}%`;
}

function updateChartBuffers(x, y, z) {
  APP.chartBuffer.x.push(x);
  APP.chartBuffer.x.shift();
  APP.chartBuffer.y.push(y);
  APP.chartBuffer.y.shift();
  APP.chartBuffer.z.push(z);
  APP.chartBuffer.z.shift();
}

let chartContext = null;
let chartAnimationId = null;

function initChart() {
  const canvas = document.getElementById('chart-canvas');
  if (!canvas) return;
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
  chartContext = canvas.getContext('2d');
  
  window.addEventListener('resize', () => {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
  });
  
  renderChart();
}

function renderChart() {
  chartAnimationId = requestAnimationFrame(renderChart);
  if (!chartContext) return;
  
  const ctx = chartContext;
  const canvas = document.getElementById('chart-canvas');
  if (!canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  
  ctx.clearRect(0, 0, w, h);
  
  // Grid Lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 1; i < gridLines; i++) {
    const yPos = (h / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(0, yPos);
    ctx.lineTo(w, yPos);
    ctx.stroke();
    
    if (i === 2) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.beginPath();
      ctx.moveTo(0, yPos);
      ctx.lineTo(w, yPos);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    }
  }
  
  const scale = h / 600;
  
  const drawLine = (dataBuffer, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    const len = dataBuffer.length;
    const step = w / (len - 1);
    
    for (let i = 0; i < len; i++) {
      let val = dataBuffer[i];
      let yVal = (h / 2) - (val * scale);
      yVal = Math.max(2, Math.min(h - 2, yVal));
      
      if (i === 0) {
        ctx.moveTo(0, yVal);
      } else {
        ctx.lineTo(i * step, yVal);
      }
    }
    ctx.stroke();
    
    ctx.shadowBlur = 6;
    ctx.shadowColor = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.shadowBlur = 0;
  };
  
  drawLine(APP.chartBuffer.x, '#ff3366'); // X axis
  drawLine(APP.chartBuffer.y, '#00ff87'); // Y axis
  drawLine(APP.chartBuffer.z, '#00f0ff'); // Z axis
}

function initGyroIMU() {
  const btnCube = document.getElementById('btn-view-cube');
  const btnBoard = document.getElementById('btn-view-board');
  if (btnCube && btnBoard) {
    btnCube.onclick = () => {
      btnCube.classList.add('active');
      btnCube.style.background = 'rgba(124,92,252,0.15)';
      btnCube.style.color = 'var(--accent-1)';
      btnBoard.classList.remove('active');
      btnBoard.style.background = 'rgba(0,0,0,0.3)';
      btnBoard.style.color = 'var(--text-secondary)';
      APP.viewMode = 'cube';
      setActiveModel('cube');
    };
    btnBoard.onclick = () => {
      btnBoard.classList.add('active');
      btnBoard.style.background = 'rgba(124,92,252,0.15)';
      btnBoard.style.color = 'var(--accent-1)';
      btnCube.classList.remove('active');
      btnCube.style.background = 'rgba(0,0,0,0.3)';
      btnCube.style.color = 'var(--text-secondary)';
      APP.viewMode = 'board';
      setActiveModel('board');
    };
  }

  const btnTare = document.getElementById('btn-tare-gyro');
  if (btnTare) {
    btnTare.onclick = () => {
      startGyroCalibration();
    };
  }
  const btnReset = document.getElementById('btn-reset-view');
  if (btnReset) {
    btnReset.onclick = () => {
      resetGyroOrientation();
    };
  }

  const mapX = document.getElementById('remap-x-src');
  const mapY = document.getElementById('remap-y-src');
  const mapZ = document.getElementById('remap-z-src');
  const invX = document.getElementById('remap-x-inv');
  const invY = document.getElementById('remap-y-inv');
  const invZ = document.getElementById('remap-z-inv');

  const updateRemapConfig = () => {
    if (mapX) APP.remap.xSrc = mapX.value;
    if (mapY) APP.remap.ySrc = mapY.value;
    if (mapZ) APP.remap.zSrc = mapZ.value;
    if (invX) APP.remap.xInv = invX.checked;
    if (invY) APP.remap.yInv = invY.checked;
    if (invZ) APP.remap.zInv = invZ.checked;
  };

  [mapX, mapY, mapZ, invX, invY, invZ].forEach(el => {
    if (el) el.addEventListener('change', updateRemapConfig);
  });

  const presetDefault = document.getElementById('btn-preset-default');
  const presetSideways = document.getElementById('btn-preset-sideways');
  const presetFlat = document.getElementById('btn-preset-inverted');

  const setPresetUI = (px, ix, py, iy, pz, iz) => {
    if (mapX) mapX.value = px;
    if (invX) invX.checked = ix;
    if (mapY) mapY.value = py;
    if (invY) invY.checked = iy;
    if (mapZ) mapZ.value = pz;
    if (invZ) invZ.checked = iz;
    updateRemapConfig();
  };

  const clearPresetsActive = () => {
    [presetDefault, presetSideways, presetFlat].forEach(p => {
      if (p) p.classList.remove('active');
    });
  };

  if (presetDefault) {
    presetDefault.onclick = () => {
      clearPresetsActive();
      presetDefault.classList.add('active');
      setPresetUI('x', true, 'y', false, 'z', true);
      showToast('Loaded default remapping preset', 'info');
    };
  }
  if (presetSideways) {
    presetSideways.onclick = () => {
      clearPresetsActive();
      presetSideways.classList.add('active');
      setPresetUI('y', false, 'x', true, 'z', false);
      showToast('Loaded sideways remapping preset', 'info');
    };
  }
  if (presetFlat) {
    presetFlat.onclick = () => {
      clearPresetsActive();
      presetFlat.classList.add('active');
      setPresetUI('x', false, 'y', false, 'z', false);
      showToast('Loaded flat/normal remapping preset', 'info');
    };
  }

  initChart();
}

// ═══════════════════════════════════════════════════════════════
// ▶  Flex Sensor Bars
// ═══════════════════════════════════════════════════════════════
const FINGER_NAMES   = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const FINGER_COLORS  = ['#7c5cfc', '#2979ff', '#00bcd4', '#00e676', '#ff9100'];

function initFlexBars(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '';
  FINGER_NAMES.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'flex-bar-item';
    row.innerHTML = `
      <span class="flex-bar-name">${name}</span>
      <div class="flex-bar-track">
        <div class="flex-bar-fill" id="${id}-fill-${i}"
             style="background: linear-gradient(90deg, ${FINGER_COLORS[i]}88, ${FINGER_COLORS[i]});"></div>
      </div>
      <span class="flex-bar-val" id="${id}-val-${i}">0</span>
    `;
    el.appendChild(row);
  });
}

function updateFlexBars(id, flex) {
  if (!flex) return;
  flex.forEach((v, i) => {
    const fill = document.getElementById(`${id}-fill-${i}`);
    const val  = document.getElementById(`${id}-val-${i}`);
    if (fill) fill.style.width = ((v / 4095) * 100).toFixed(1) + '%';
    if (val)  val.textContent = Math.round(v);
  });
}

// ═══════════════════════════════════════════════════════════════
// ▶  Detection Banner
// ═══════════════════════════════════════════════════════════════
function updateDetectedBanner(label) {
  const banner = document.getElementById('detected-banner');
  const letter = document.getElementById('detected-letter');
  const ticker = document.getElementById('header-detected');

  if (label) {
    banner.classList.add('show');
    letter.textContent = label;
    ticker.textContent = label;
    if (label !== APP._lastDetected) {
      APP.totalDetects++;
      document.getElementById('stat-detects').textContent = APP.totalDetects;
    }
  } else {
    banner.classList.remove('show');
    ticker.textContent = '—';
  }
}

// ═══════════════════════════════════════════════════════════════
// ▶  Browser-side Detection (20-sample averaged buffer)
// ═══════════════════════════════════════════════════════════════
function angleDiff(a, b) {
  let diff = (a - b) % 360;
  if (diff < -180) diff += 360;
  if (diff > 180) diff -= 360;
  return Math.abs(diff);
}

function detectSignLocally(avgFlex) {
  let bestScore = 1e9;
  let bestLabel = null;
  for (const [label, sign] of Object.entries(APP.library)) {
    if (!Array.isArray(sign.avg_flex)) continue;

    // Check orientation match with wrap-around support (Pitch and Roll only)
    const dp = angleDiff(APP.pitch, sign.avg_pitch || 0);
    const dr = angleDiff(APP.roll,  sign.avg_roll || 0);

    if (dp > (sign.angle_tol || 30) || dr > (sign.angle_tol || 30)) {
      continue; // Skip if hand orientation does not match calibrated angles
    }

    let score = 0;
    for (let i = 0; i < 5; i++) {
      const d = avgFlex[i] - sign.avg_flex[i];
      score += d * d;
    }
    score = Math.sqrt(score);
    if (score < bestScore && score < (sign.flex_tol || 300)) {
      bestScore = score;
      bestLabel = label;
    }
  }
  return bestLabel;
}

// ═══════════════════════════════════════════════════════════════
// ▶  Library Management
// ═══════════════════════════════════════════════════════════════
function setLibrary(data, version, lastUpdated) {
  APP.library    = data || {};
  APP.libVersion = version || APP.libVersion || 1;
  const count = Object.keys(APP.library).length;
  document.getElementById('library-count-badge').textContent   = count;
  document.getElementById('library-count-display').textContent = `${count} sign${count !== 1 ? 's' : ''}`;
  document.getElementById('stat-signs').textContent = count;
  document.getElementById('info-signs').textContent = count;
  // Library version badge
  const vBadge = document.getElementById('lib-version-badge');
  if (vBadge) {
    vBadge.textContent = `v${APP.libVersion}`;
    if (lastUpdated) vBadge.title = `Last updated: ${new Date(lastUpdated).toLocaleString()}`;
  }
  renderLibraryTable();
}

function renderLibraryTable(filter = '') {
  const tbody = document.getElementById('library-tbody');
  const keys  = Object.keys(APP.library)
    .filter(k => !filter || k.toLowerCase().includes(filter.toLowerCase()))
    .sort();

  if (keys.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty-row">${filter ? 'No matching signs.' : 'No signs yet — head to Calibrate!'}</td></tr>`;
    return;
  }

  tbody.innerHTML = keys.map(label => {
    const s        = APP.library[label];
    const f        = s.avg_flex || [0, 0, 0, 0, 0];
    const ts       = s.last_updated || s.timestamp
      ? new Date(s.last_updated || s.timestamp).toLocaleDateString() : '—';
    const sessions  = s.session_count ?? (s.sessions?.length ?? '—');
    const totalSamp = s.total_samples ?? '—';
    const signVer   = s.sign_version ? `v${s.sign_version}` : '—';
    return `
      <tr>
        <td><span class="label-badge">${label}</span></td>
        ${f.map(v => `<td>${Math.round(v)}</td>`).join('')}
        <td>${(s.avg_pitch || 0).toFixed(1)}°</td>
        <td>${(s.avg_roll  || 0).toFixed(1)}°</td>
        <td>${(s.avg_yaw   || 0).toFixed(1)}°</td>
        <td><span class="session-chip">${sessions}&nbsp;sess &middot; ${totalSamp}&nbsp;samp</span></td>
        <td><span class="ver-chip">${signVer}</span></td>
        <td><span class="date-chip">${ts}</span></td>
        <td>
          <div class="library-actions">
            <button class="btn btn-outline btn-sm" onclick="editSignSettings('${label}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteSign('${label}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function deleteSign(label) {
  if (!confirm(`Delete sign "${label}"?`)) return;
  sendWS({ type: 'delete_sign', label });
  delete APP.library[label];
  setLibrary(APP.library);
  showToast(`"${label}" deleted`, 'warning');
}

// ═══════════════════════════════════════════════════════════════
// ▶  Calibration Wizard
// ═══════════════════════════════════════════════════════════════
const CIRC = 2 * Math.PI * 52;  // circumference for r=52 ring

function initCalibration() {
  // A–Z + 0–9 quick buttons
  const grid = document.getElementById('quick-grid');
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').forEach(ch => {
    const btn = document.createElement('button');
    btn.className = 'quick-btn';
    btn.textContent = ch;
    btn.title = `Record "${ch}"`;
    btn.onclick = () => {
      document.getElementById('calib-label-input').value = ch;
      document.getElementById('calib-label-input').focus();
    };
    grid.appendChild(btn);
  });

  // Action quick pick buttons
  const actionGrid = document.getElementById('action-quick-grid');
  if (actionGrid) {
    const actions = ['SPACE', 'BACKSPACE', 'RESET', 'HOLD', 'ENTER', 'SPEAK'];
    actions.forEach(act => {
      const btn = document.createElement('button');
      btn.className = 'quick-btn';
      btn.style.width = 'auto';
      btn.style.padding = '0 12px';
      btn.textContent = act;
      btn.title = `Record Action "${act}"`;
      btn.onclick = () => {
        document.getElementById('calib-label-input').value = act;
        document.getElementById('calib-label-input').focus();
      };
      actionGrid.appendChild(btn);
    });
  }

  document.getElementById('calib-start-btn').onclick  = startCalib;
  document.getElementById('calib-label-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') startCalib();
  });
  document.getElementById('btn-record-another').onclick = resetCalib;
  document.getElementById('btn-view-library').onclick   = () => switchView('library');
}

function startCalib() {
  const raw = document.getElementById('calib-label-input').value.trim().toUpperCase();
  if (!raw) { showToast('Enter a sign label first', 'error'); return; }

  // Read user-configured session parameters
  APP.calib.samplesPerSession  = Math.max(5,  parseInt(document.getElementById('samples-per-session').value) || 20);
  APP.calib.sessionsTarget     = Math.max(1,  parseInt(document.getElementById('sessions-target').value)    || 3);
  APP.calib.sessionsCompleted  = 0;
  APP.calib.sessionResults     = [];
  APP.calib.label              = raw;
  APP.calib.phase              = 'countdown';
  APP.calib.samples            = [];

  beginCountdown();
}

function beginCountdown() {
  APP.calib.countdownVal = 3;
  setWizardStep(2);
  document.getElementById('calib-lbl-2').textContent  = APP.calib.label;
  document.getElementById('countdown-num').textContent = '3';
  animateCountdownRing(3, 3);
  updateSessionBadges();
  setWizardProgress(2);

  clearInterval(APP.calib.timer);
  APP.calib.timer = setInterval(() => {
    APP.calib.countdownVal--;
    const numEl = document.getElementById('countdown-num');
    numEl.textContent = APP.calib.countdownVal > 0 ? APP.calib.countdownVal : 'GO!';
    animateCountdownRing(APP.calib.countdownVal, 3);
    if (APP.calib.countdownVal <= 0) {
      clearInterval(APP.calib.timer);
      startRecording();
    }
  }, 1000);
}

function updateSessionBadges() {
  const text = `Session ${APP.calib.sessionsCompleted + 1} / ${APP.calib.sessionsTarget}`;
  ['session-badge', 'session-badge-3'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  });
}

function animateCountdownRing(remaining, total) {
  const arc = document.getElementById('ring-arc');
  if (!arc) return;
  const pct = remaining / total;
  arc.style.strokeDashoffset = CIRC * (1 - pct);
}

function startRecording() {
  APP.calib.phase   = 'recording';
  APP.calib.samples = [];

  setWizardStep(3);
  setWizardProgress(3);
  document.getElementById('calib-lbl-3').textContent       = APP.calib.label;
  document.getElementById('calib-progress-txt').textContent = `0 / ${APP.calib.samplesPerSession} samples`;
  document.getElementById('record-progress-fill').style.width = '0%';
  updateSessionBadges();

  // Tell ESP32 to start its own recording loop
  sendWS({ type: 'start_recording', label: APP.calib.label });
}

function recordCalibSample() {
  if (APP.calib.phase !== 'recording') return;
  if (APP.calib.samples.length >= APP.calib.samplesPerSession) return;

  APP.calib.samples.push({
    flex : [...APP.flex],
    pitch: APP.pitch,
    roll : APP.roll,
    yaw  : APP.yaw,
  });

  const n   = APP.calib.samples.length;
  const pct = (n / APP.calib.samplesPerSession) * 100;
  document.getElementById('calib-progress-txt').textContent  = `${n} / ${APP.calib.samplesPerSession} samples`;
  document.getElementById('record-progress-fill').style.width = pct.toFixed(1) + '%';

  if (n >= APP.calib.samplesPerSession) {
    APP.calib.phase = 'done';
    sendWS({ type: 'stop_recording' });
    processCalibSamples();
  }
}

function processCalibSamples() {
  const S = APP.calib.samples;
  const n = S.length;
  const avgFlex = [0, 0, 0, 0, 0];
  let avgPitch = 0, avgRoll = 0, avgYaw = 0;

  S.forEach(s => {
    for (let i = 0; i < 5; i++) avgFlex[i] += s.flex[i];
    avgPitch += s.pitch;
    avgRoll  += s.roll;
    avgYaw   += s.yaw;
  });
  for (let i = 0; i < 5; i++) avgFlex[i] /= n;
  avgPitch /= n; avgRoll /= n; avgYaw /= n;

  // Build this session's result
  const sessionResult = {
    id          : APP.calib.sessionsCompleted + 1,
    avg_flex    : avgFlex,
    avg_pitch   : avgPitch,
    avg_roll    : avgRoll,
    avg_yaw     : avgYaw,
    sample_count: n,
    timestamp   : new Date().toISOString(),
  };

  APP.calib.sessionsCompleted++;
  APP.calib.sessionResults.push(sessionResult);

  // Send session to server — server merges & broadcasts
  sendWS({ type: 'add_session', label: APP.calib.label, session: sessionResult });

  // Optimistic local merge preview
  mergeSessionsLocally(APP.calib.label, APP.calib.sessionResults);

  const remaining = APP.calib.sessionsTarget - APP.calib.sessionsCompleted;
  if (remaining > 0) {
    showToast(`Session ${APP.calib.sessionsCompleted}/${APP.calib.sessionsTarget} recorded ✔`, 'success');
    APP.calib.phase   = 'countdown';
    APP.calib.samples = [];
    setTimeout(() => beginCountdown(), 1400);
  } else {
    // All sessions done
    APP.calib.result = APP.library[APP.calib.label] || {};
    APP.calib.phase  = 'done';
    finishCalib(APP.calib.label);
  }
}

// Merge all session results into a grand average in local library preview
function mergeSessionsLocally(label, sessions) {
  if (!sessions.length) return;
  const n = sessions.length;
  const gFlex = [0, 0, 0, 0, 0];
  let gPitch = 0, gRoll = 0, gYaw = 0;
  sessions.forEach(s => {
    s.avg_flex.forEach((v, i) => { gFlex[i] += v; });
    gPitch += s.avg_pitch;
    gRoll  += s.avg_roll;
    gYaw   += s.avg_yaw;
  });
  APP.library[label] = {
    avg_flex     : gFlex.map(v => v / n),
    avg_pitch    : gPitch / n,
    avg_roll     : gRoll  / n,
    avg_yaw      : gYaw   / n,
    flex_tol     : 300,
    angle_tol    : 30,
    sessions     : sessions,
    session_count: n,
    total_samples: sessions.reduce((a, s) => a + s.sample_count, 0),
    sign_version : n,
    last_updated : new Date().toISOString(),
  };
  setLibrary(APP.library, APP.libVersion, null);
}

function finishCalib(label) {
  if (APP.calib.phase !== 'done') return;
  setWizardStep(4);
  setWizardProgress(4);
  document.getElementById('saved-label-display').textContent = label;

  const statsEl = document.getElementById('saved-stats-row');
  const r = APP.calib.result;
  if (r && statsEl) {
    statsEl.innerHTML = `
      <div class="saved-stat"><label>Samples</label><span>${APP.calib.samples.length}</span></div>
      <div class="saved-stat"><label>Avg Pitch</label><span>${r.avg_pitch.toFixed(1)}°</span></div>
      <div class="saved-stat"><label>Avg Roll</label><span>${r.avg_roll.toFixed(1)}°</span></div>
      <div class="saved-stat"><label>Avg Yaw</label><span>${r.avg_yaw.toFixed(1)}°</span></div>
    `;
  }
  showToast(`"${label}" saved successfully!`, 'success');
}

function resetCalib() {
  clearInterval(APP.calib.timer);
  APP.calib.phase             = 'idle';
  APP.calib.samples           = [];
  APP.calib.result            = null;
  APP.calib.sessionsCompleted = 0;
  APP.calib.sessionResults    = [];
  document.getElementById('calib-label-input').value = '';
  setWizardStep(1);
  setWizardProgress(1);
}

function setWizardStep(n) {
  document.querySelectorAll('.calib-step').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById(`calib-step-${n}`);
  if (target) target.classList.remove('hidden');
}

function setWizardProgress(active) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`wp${i}`);
    const ln = el?.nextElementSibling;
    if (!el) continue;
    el.classList.toggle('done',   i < active);
    el.classList.toggle('active', i === active);
    if (ln && ln.classList.contains('wp-line')) {
      ln.classList.toggle('done', i < active);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ▶  Test Mode
// ═══════════════════════════════════════════════════════════════
function updateTestMode() {
  const display = document.getElementById('test-big-display');
  const confFill = document.getElementById('conf-fill');
  const confLbl  = document.getElementById('conf-label');

  if (APP.detected) {
    const sign = APP.library[APP.detected];
    let confidence = 0;
    if (sign?.avg_flex) {
      let dist = 0;
      for (let i = 0; i < 5; i++) {
        const d = APP.flex[i] - sign.avg_flex[i];
        dist += d * d;
      }
      dist = Math.sqrt(dist);
      confidence = Math.max(0, Math.min(100, 100 - (dist / (sign.flex_tol || 300)) * 100));
    }

    if (APP.detected !== APP._lastDetected) {
      display.innerHTML = `<span class="test-sign-letter">${APP.detected}</span>`;
      APP._lastDetected = APP.detected;

      // Add to history
      APP.testHistory.unshift({ label: APP.detected, time: new Date().toLocaleTimeString() });
      if (APP.testHistory.length > 12) APP.testHistory.pop();
      renderTestHistory();
    }

    confFill.style.width = confidence.toFixed(0) + '%';
    confLbl.textContent  = `Confidence: ${confidence.toFixed(0)}%`;

  } else {
    if (APP._lastDetected !== null) {
      display.innerHTML = `<span class="test-dash">—</span>`;
      APP._lastDetected = null;
      confFill.style.width = '0%';
      confLbl.textContent  = 'Confidence: —';
    }
  }
}

function renderTestHistory() {
  const list = document.getElementById('history-list');
  if (!APP.testHistory.length) {
    list.innerHTML = '<div class="history-empty">No detections yet</div>';
    return;
  }
  list.innerHTML = APP.testHistory.map(h => `
    <div class="history-item">
      <span class="history-lbl">${h.label}</span>
      <span class="history-time">${h.time}</span>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════
// ▶  Navigation
// ═══════════════════════════════════════════════════════════════
function switchView(id) {
  APP.view = id;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`view-${id}`)?.classList.add('active');
  document.getElementById(`nav-${id}`)?.classList.add('active');

  // Trigger re-init for test mode history
  if (id === 'test') renderTestHistory();

  // Initialize word lists and screen syncing for Sentence Typing View
  if (id === 'typing') {
    updateTypingState();
    renderDictWordList();
  }
}

// ═══════════════════════════════════════════════════════════════
// ▶  Export
// ═══════════════════════════════════════════════════════════════
function initExport() {
  document.getElementById('btn-export-csv').onclick = () => {
    window.open('/api/export/csv', '_blank');
    showToast('Downloading CSV…', 'info');
  };
  document.getElementById('btn-export-json').onclick = () => {
    window.open('/api/export/json', '_blank');
    showToast('Downloading JSON…', 'info');
  };
  document.getElementById('btn-export-arduino').onclick = () => {
    window.open('/api/export/arduino', '_blank');
    showToast('Downloading SignLanguageLib.h…', 'info');
  };
  document.getElementById('btn-apply-ws').onclick = () => {
    const url = document.getElementById('ws-url-input').value.trim();
    if (url) { connectWS(url); showToast('Reconnecting…', 'info'); }
  };
}

// ═══════════════════════════════════════════════════════════════
// ▶  Connect Modal
// ═══════════════════════════════════════════════════════════════
function initModal() {
  const modal  = document.getElementById('connect-modal');
  const openBtn = document.getElementById('connect-btn');
  const cancelBtn = document.getElementById('modal-cancel');
  const connectBtn = document.getElementById('modal-connect');

  openBtn.onclick = () => modal.classList.add('open');
  cancelBtn.onclick = () => modal.classList.remove('open');

  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('open');
  });

  connectBtn.onclick = () => {
    const ip   = document.getElementById('modal-ip').value.trim();
    const port = document.getElementById('modal-port').value.trim() || '3000';
    if (!ip) { showToast('Enter a server IP', 'error'); return; }
    connectWS(`ws://${ip}:${port}`);
    modal.classList.remove('open');
    showToast(`Connecting to ${ip}:${port}…`, 'info');
  };

  // Enter key in modal
  document.getElementById('modal-port').addEventListener('keydown', e => {
    if (e.key === 'Enter') connectBtn.click();
  });
}

// ═══════════════════════════════════════════════════════════════
// ▶  Toast Notifications
// ═══════════════════════════════════════════════════════════════
function showToast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span>${msg}</span>`;
  container.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  }, 3200);
}



// ═══════════════════════════════════════════════════════════════
// ▶  Init — DOMContentLoaded
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  // Navigation
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // 3D cube & Gyro IMU
  initCube();
  initGyroIMU();

  // Flex bar groups
  initFlexBars('flex-bars');
  initFlexBars('test-flex-bars');
  initFlexBars('mini-flex-bars');

  // Calibration
  initCalibration();
  setWizardStep(1);
  setWizardProgress(1);

  // Export
  initExport();

  // Modal
  initModal();

  // Library search
  document.getElementById('library-search').addEventListener('input', e => {
    renderLibraryTable(e.target.value);
  });

  // Reset yaw
  document.getElementById('reset-yaw-btn').addEventListener('click', () => {
    sendWS({ type: 'reset_yaw' });
    showToast('Yaw reset sent', 'info');
  });

  // Clear test history
  document.getElementById('clear-history-btn').addEventListener('click', () => {
    APP.testHistory = [];
    renderTestHistory();
    showToast('History cleared', 'info');
  });

  // WS URL input preset
  document.getElementById('ws-url-input').value = APP.wsUrl;

  // Pre-fill modal
  document.getElementById('modal-ip').value   = location.hostname;
  document.getElementById('modal-port').value = location.port || '3000';

  // Connect to server
  connectWS();

  // Load library from REST (backup if WS late)
  fetch('/api/signs')
    .then(r => r.json())
    .then(data => { if (Object.keys(data).length > 0) setLibrary(data); })
    .catch(() => {});

  // Also fetch initial version
  fetch('/api/library/version')
    .then(r => r.json())
    .then(d => {
      APP.libVersion = d.version || 1;
      const vBadge = document.getElementById('lib-version-badge');
      if (vBadge) vBadge.textContent = `v${APP.libVersion}`;
    })
    .catch(() => {});

  // Status poll for info panel
  setInterval(() => {
    fetch('/api/status').then(r => r.json()).then(d => {
      document.getElementById('info-browsers').textContent = d.browserCount;
      document.getElementById('info-signs').textContent = d.signCount;
      if (d.esp32Connected !== APP.esp32Ok) {
        APP.esp32Ok = d.esp32Connected;
        updateESP32Dot(APP.esp32Ok);
      }
    }).catch(() => {});
  }, 4000);

  // Initialize Sentence Typing View
  initTypingView();

  // Initialize Edit Sign Modal
  initEditSignModal();

  console.log('%c🧤 SignGlove Dashboard Ready', 'color:#7c5cfc;font-size:16px;font-weight:bold;');
});

// ═══════════════════════════════════════════════════════════════
// ▶  Sentence Typing Logic & Auto-Suggestions
// ═══════════════════════════════════════════════════════════════

function initTypingView() {
  // Load word bank from localStorage
  const storedDict = localStorage.getItem('glove_word_bank');
  if (storedDict) {
    try { APP.dictionary = JSON.parse(storedDict); } catch (_) { initializeDefaultDict(); }
  } else {
    initializeDefaultDict();
  }

  // Handle settings sliders
  const holdSlider = document.getElementById('hold-duration-input');
  const holdValEl  = document.getElementById('hold-duration-val');
  if (holdSlider && holdValEl) {
    holdSlider.oninput = () => {
      APP.typing.holdDuration = parseFloat(holdSlider.value);
      holdValEl.textContent = APP.typing.holdDuration.toFixed(1) + 's';
    };
    APP.typing.holdDuration = parseFloat(holdSlider.value);
  }

  const cooldownSlider = document.getElementById('cooldown-input');
  const cooldownValEl  = document.getElementById('cooldown-val');
  if (cooldownSlider && cooldownValEl) {
    cooldownSlider.oninput = () => {
      APP.typing.cooldownDuration = parseFloat(cooldownSlider.value);
      cooldownValEl.textContent = APP.typing.cooldownDuration.toFixed(1) + 's';
    };
    APP.typing.cooldownDuration = parseFloat(cooldownSlider.value);
  }

  // Manual actions
  document.getElementById('btn-space-sentence').onclick     = () => insertChar(' ');
  document.getElementById('btn-backspace-sentence').onclick = () => insertBackspace();
  document.getElementById('btn-clear-sentence').onclick     = () => clearTyping();
  document.getElementById('btn-speak-sentence').onclick     = () => speakSentence();
  document.getElementById('btn-enter-sentence').onclick     = () => {
    const firstChip = document.querySelector('.suggestion-chip:not(.empty)');
    if (firstChip) {
      selectSuggestion(firstChip.textContent, false); // no TTS play on manual enter
    }
  };

  // Add word to dictionary
  document.getElementById('btn-add-dict-word').onclick = () => {
    const input = document.getElementById('dict-new-word');
    const word = input.value.trim().toUpperCase();
    if (!word) return;
    if (!/^[A-Z]+$/.test(word)) {
      showToast('Words must contain A-Z letters only', 'error');
      return;
    }
    if (APP.dictionary.includes(word)) {
      showToast('Word already in dictionary', 'warning');
      return;
    }
    APP.dictionary.push(word);
    APP.dictionary.sort();
    localStorage.setItem('glove_word_bank', JSON.stringify(APP.dictionary));
    renderDictWordList();
    updateTypingState();
    input.value = '';
    showToast(`"${word}" added to word bank`, 'success');
  };

  // Keyboard support in dict textinput
  document.getElementById('dict-new-word').onkeydown = (e) => {
    if (e.key === 'Enter') document.getElementById('btn-add-dict-word').click();
  };

  // Setup text area live updates
  document.getElementById('typing-textarea').oninput = () => {
    updateTypingState();
  };

  renderDictWordList();
  updateTypingState();
  initTTS();
}

let ttsVoices = [];
function initTTS() {
  const select = document.getElementById('tts-voice-select');
  if (!select) return;

  function populateVoiceList() {
    if (typeof speechSynthesis === 'undefined') return;
    ttsVoices = speechSynthesis.getVoices();
    
    select.innerHTML = '<option value="">Default System Voice</option>';
    
    const savedVoiceName = localStorage.getItem('glove_tts_voice');
    
    ttsVoices.forEach(voice => {
      const option = document.createElement('option');
      option.textContent = `${voice.name} (${voice.lang})`;
      option.value = voice.name;
      if (savedVoiceName === voice.name) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  }

  populateVoiceList();
  if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populateVoiceList;
  }

  select.onchange = (e) => {
    localStorage.setItem('glove_tts_voice', e.target.value);
    showToast(`Voice changed: ${e.target.value || 'Default'}`, 'info');
  };
}

function initializeDefaultDict() {
  APP.dictionary = [
    'HELLO', 'WORLD', 'SIGN', 'GLOVE', 'PROJECT', 'ESP32', 
    'COMPUTER', 'LANGUAGE', 'YES', 'NO', 'THANK', 'YOU', 
    'HELP', 'PLEASE', 'GOOD', 'MORNING', 'WELCOME', 'FRIEND',
    'HOW', 'ARE', 'I', 'AM', 'FINE', 'BAD', 'GREAT', 'NAME',
    'WHAT', 'WHERE', 'WHEN', 'WHY', 'WHO'
  ];
  APP.dictionary.sort();
  localStorage.setItem('glove_word_bank', JSON.stringify(APP.dictionary));
}

function renderDictWordList() {
  const el = document.getElementById('dict-word-list');
  if (!el) return;
  el.innerHTML = APP.dictionary.map(word => `
    <span class="dict-word-chip">
      ${word}
      <button onclick="removeDictWord('${word}')" aria-label="Remove word">&times;</button>
    </span>
  `).join('');
}

function removeDictWord(word) {
  APP.dictionary = APP.dictionary.filter(w => w !== word);
  localStorage.setItem('glove_word_bank', JSON.stringify(APP.dictionary));
  renderDictWordList();
  updateTypingState();
  showToast(`"${word}" removed from dictionary`, 'warning');
}

// Auto-suggestions engine based on last word fragment
function updateTypingState() {
  const textarea = document.getElementById('typing-textarea');
  if (!textarea) return;
  const text = textarea.value;

  // Find prefix of last word
  const words = text.split(/[\s\n]+/);
  const lastWord = words[words.length - 1].toUpperCase();

  let matches = [];
  if (lastWord.length > 0) {
    matches = APP.dictionary.filter(w => w.startsWith(lastWord));
  } else {
    // If empty last word, suggest common words
    matches = APP.dictionary.slice(0, 4);
  }

  // Take top 4 suggestions
  const topMatches = matches.slice(0, 4);
  const grid = document.getElementById('suggestions-grid');
  if (grid) {
    grid.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const w = topMatches[i];
      const btn = document.createElement('button');
      if (w) {
        btn.className = 'suggestion-chip';
        btn.textContent = w;
        btn.onclick = () => selectSuggestion(w);
      } else {
        btn.className = 'suggestion-chip empty';
        btn.textContent = '--';
      }
      grid.appendChild(btn);
    }
  }

  // Send update to LCD screen
  syncLCD(text, topMatches);
}

function selectSuggestion(word, playTTS = true) {
  const textarea = document.getElementById('typing-textarea');
  if (!textarea) return;
  const text = textarea.value;

  // Replace last word fragment with selected suggestion
  const words = text.split(/\s+/);
  words[words.length - 1] = word;
  
  // Update textarea
  textarea.value = words.join(' ') + ' ';
  textarea.focus();
  
  // TTS speak selected word
  if (playTTS) {
    speakWord(word);
  }

  updateTypingState();
}

function speakWord(word) {
  const ttsToggle = document.getElementById('tts-toggle');
  if (ttsToggle && ttsToggle.checked && word.trim()) {
    const s = new SpeechSynthesisUtterance(word);
    s.rate = 1.0;
    
    // Set custom voice if selected
    const select = document.getElementById('tts-voice-select');
    if (select && select.value && typeof speechSynthesis !== 'undefined') {
      const voice = speechSynthesis.getVoices().find(v => v.name === select.value);
      if (voice) s.voice = voice;
    }
    
    window.speechSynthesis.speak(s);
  }
}

function speakSentence() {
  const textarea = document.getElementById('typing-textarea');
  if (!textarea) return;
  const sentence = textarea.value.trim();
  if (!sentence) {
    showToast('Nothing to speak!', 'warning');
    return;
  }
  const s = new SpeechSynthesisUtterance(sentence);
  s.rate = 1.0;
  
  // Set custom voice if selected
  const select = document.getElementById('tts-voice-select');
  if (select && select.value && typeof speechSynthesis !== 'undefined') {
    const voice = speechSynthesis.getVoices().find(v => v.name === select.value);
    if (voice) s.voice = voice;
  }
  
  window.speechSynthesis.speak(s);
}

function clearTyping() {
  const textarea = document.getElementById('typing-textarea');
  if (textarea) textarea.value = '';
  updateTypingState();
  showToast('Sentence cleared', 'info');
}

function insertBackspace() {
  const textarea = document.getElementById('typing-textarea');
  if (!textarea) return;
  const text = textarea.value;
  if (text.length > 0) {
    textarea.value = text.slice(0, -1);
    updateTypingState();
  }
}

function insertChar(char) {
  const textarea = document.getElementById('typing-textarea');
  if (!textarea) return;
  
  // Append char
  textarea.value += char;
  textarea.focus();

  // If space entered, speak the word just completed
  if (char === ' ') {
    const words = textarea.value.trim().split(/\s+/);
    const lastWord = words[words.length - 1];
    if (lastWord) speakWord(lastWord);
  }

  updateTypingState();
}

// Relays typing lines to the ESP32 via WS update_lcd command
function syncLCD(text, suggestions) {
  // Line 0: Last 20 characters of sentence
  let l0 = text;
  if (l0.length > 20) l0 = l0.substring(l0.length - 20);
  else l0 = l0.padEnd(20, ' ');

  // Line 1: Active detected gesture and timer progress
  let l1 = 'Act: None';
  if (APP.detected) {
    const pct = APP.typing.activeGesture === APP.detected && APP.typing.holdStart > 0
      ? Math.round(Math.min(100, ((Date.now() - APP.typing.holdStart) / (APP.typing.holdDuration * 1000)) * 100))
      : 0;
    l1 = `Gesture: ${APP.detected} (${pct}%)`;
  }
  if (APP.typing.isPaused) l1 = '[DETECTION HELD]';

  // Line 2 & 3: Suggestions
  const s1 = suggestions[0] || '';
  const s2 = suggestions[1] || '';
  const s3 = suggestions[2] || '';
  const s4 = suggestions[3] || '';

  const l2 = `1:${s1.substring(0,8).padEnd(8,' ')} 2:${s2.substring(0,8)}`;
  const l3 = `3:${s3.substring(0,8).padEnd(8,' ')} 4:${s4.substring(0,8)}`;

  sendWS({
    type: 'update_lcd',
    lines: [l0, l1, l2, l3]
  });
}

// Frame timer loop for typing view called from onSensorData
function handleTypingFrame() {
  const progressContainer = document.getElementById('hold-progress-container');
  const progressFill = document.getElementById('typing-hold-fill');
  const progressLbl  = document.getElementById('hold-progress-label');
  const stateLabel    = document.getElementById('typing-state-lbl');

  if (stateLabel) {
    stateLabel.textContent = APP.typing.isPaused ? 'Paused' : 'Active';
    stateLabel.className = 'typing-status' + (APP.typing.isPaused ? ' paused' : '');
  }

  if (APP.typing.isPaused) {
    if (progressContainer) progressContainer.classList.remove('show');
    return;
  }

  // Handle gesture cooldown
  const now = Date.now();
  if (now < APP.typing.cooldownEnd) {
    if (progressContainer) progressContainer.classList.remove('show');
    return;
  }

  if (APP.detected) {
    if (APP.typing.activeGesture !== APP.detected) {
      // New gesture detected
      APP.typing.activeGesture = APP.detected;
      APP.typing.holdStart = now;
    }

    const elapsed = (now - APP.typing.holdStart) / 1000;
    const pct = Math.min(100, (elapsed / APP.typing.holdDuration) * 100);

    if (progressContainer && progressFill && progressLbl) {
      progressContainer.classList.add('show');
      progressFill.style.width = pct.toFixed(1) + '%';
      progressLbl.textContent = `Hold gesture: ${APP.detected} (${pct.toFixed(0)}%)`;
    }

    if (elapsed >= APP.typing.holdDuration) {
      // Register gesture input!
      const gestureName = APP.detected.toLowerCase();
      
      // Control gestures
      if (gestureName === 'space') {
        insertChar(' ');
        showToast('Gesture: Space', 'info');
      } else if (gestureName === 'backspace') {
        insertBackspace();
        showToast('Gesture: Backspace', 'info');
      } else if (gestureName === 'reset') {
        clearTyping();
        showToast('Gesture: Reset Text', 'info');
      } else if (gestureName === 'detection hold' || gestureName === 'hold') {
        APP.typing.isPaused = !APP.typing.isPaused;
        showToast(APP.typing.isPaused ? 'Typing paused' : 'Typing active', 'warning');
      } else if (gestureName === 'speak') {
        speakSentence();
        showToast('Gesture: Speak Sentence', 'success');
      } else if (gestureName === 'enter') {
        const firstChip = document.querySelector('.suggestion-chip:not(.empty)');
        if (firstChip) {
          const firstWord = firstChip.textContent;
          selectSuggestion(firstWord, false); // select 1st suggestion, no TTS play
          showToast(`Gesture: Enter -> "${firstWord}"`, 'success');
        } else {
          showToast('Gesture: Enter (No suggestions)', 'warning');
        }
      } else {
        // Character gesture (default length is 1 or short word)
        insertChar(APP.detected);
        showToast(`Gesture: Typed "${APP.detected}"`, 'success');
      }

      // Start cooldown
      APP.typing.cooldownEnd = Date.now() + (APP.typing.cooldownDuration * 1000);
      APP.typing.activeGesture = null;
      APP.typing.holdStart = 0;
      if (progressContainer) progressContainer.classList.remove('show');
    }
  } else {
    // No gesture detected
    APP.typing.activeGesture = null;
    APP.typing.holdStart = 0;
    if (progressContainer) progressContainer.classList.remove('show');
  }
}

// ═══════════════════════════════════════════════════════════════
// ▶  Sign Settings Edit Modal (CRUD operations)
// ═══════════════════════════════════════════════════════════════

function initEditSignModal() {
  const modal = document.getElementById('edit-sign-modal');
  const cancelBtn = document.getElementById('edit-modal-cancel');
  const saveBtn = document.getElementById('edit-modal-save');

  // Cancel closes modal
  cancelBtn.onclick = () => modal.classList.remove('open');
  
  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('open');
  });

  // Wire up slider inputs within modal to update label values
  const flexSlider = document.getElementById('edit-sign-flextol');
  const flexValEl = document.getElementById('edit-sign-flextol-val');
  if (flexSlider && flexValEl) {
    flexSlider.oninput = () => {
      flexValEl.textContent = flexSlider.value;
    };
  }

  const angleSlider = document.getElementById('edit-sign-angletol');
  const angleValEl = document.getElementById('edit-sign-angletol-val');
  if (angleSlider && angleValEl) {
    angleSlider.oninput = () => {
      angleValEl.textContent = angleSlider.value + '°';
    };
  }

  // Handle save clicks
  saveBtn.onclick = () => {
    const originalLabel = document.getElementById('edit-sign-original-label').value;
    const rawNewLabel    = document.getElementById('edit-sign-label').value.trim();
    const flexTol       = parseInt(flexSlider.value);
    const angleTol      = parseInt(angleSlider.value);

    if (!rawNewLabel) {
      showToast('Label name cannot be empty', 'error');
      return;
    }

    const newLabel = rawNewLabel.toUpperCase();

    // Check for collision with an existing label that isn't the original
    if (newLabel !== originalLabel && APP.library[newLabel]) {
      showToast(`A sign named "${newLabel}" already exists`, 'error');
      return;
    }

    // Send update command to server
    sendWS({
      type: 'update_sign_settings',
      label: originalLabel,
      newLabel: newLabel,
      flex_tol: flexTol,
      angle_tol: angleTol
    });

    // Update locally
    const sign = APP.library[originalLabel];
    if (sign) {
      sign.flex_tol = flexTol;
      sign.angle_tol = angleTol;
      if (newLabel !== originalLabel) {
        APP.library[newLabel] = sign;
        delete APP.library[originalLabel];
      }
    }
    
    setLibrary(APP.library);
    modal.classList.remove('open');
    showToast(`Settings for "${newLabel}" updated`, 'success');
  };
}

function editSignSettings(label) {
  const sign = APP.library[label];
  if (!sign) return;

  const modal = document.getElementById('edit-sign-modal');
  
  // Set hidden variables and text fields
  document.getElementById('edit-sign-original-label').value = label;
  document.getElementById('edit-sign-label').value = label;

  // Set flex slider
  const flexSlider = document.getElementById('edit-sign-flextol');
  const flexValEl = document.getElementById('edit-sign-flextol-val');
  const flexVal = sign.flex_tol || 300;
  if (flexSlider && flexValEl) {
    flexSlider.value = flexVal;
    flexValEl.textContent = flexVal;
  }

  // Set angle slider
  const angleSlider = document.getElementById('edit-sign-angletol');
  const angleValEl = document.getElementById('edit-sign-angletol-val');
  const angleVal = sign.angle_tol || 30;
  if (angleSlider && angleValEl) {
    angleSlider.value = angleVal;
    angleValEl.textContent = angleVal + '°';
  }

  // Open modal window
  modal.classList.add('open');
}

