// =============================================================
// server.js — Sign Language Glove Node.js Server
// Serves web app + relays WebSocket between ESP32 and browser(s)
// Also persists sign library and provides REST + export endpoints
// =============================================================

'use strict';

const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const fs       = require('fs');
const path     = require('path');
const cors     = require('cors');

// ── Config ────────────────────────────────────────────────────
const PORT      = process.env.PORT || 3000;
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'signs.json');
const PUBLIC    = path.join(__dirname, '..', 'public');

// ── Express setup ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC));

// ── Data store ────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let signsLibrary  = {};
let libVersion    = 1;
let libUpdatedAt  = new Date().toISOString();

try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw._meta) {
      libVersion   = raw._meta.version      || 1;
      libUpdatedAt = raw._meta.last_updated || libUpdatedAt;
    }
    for (const [k, v] of Object.entries(raw)) {
      if (k !== '_meta') signsLibrary[k] = v;
    }
    console.log(`[DATA] Loaded ${Object.keys(signsLibrary).length} sign(s) — lib v${libVersion}`);
  }
} catch (e) {
  console.warn('[DATA] Could not read signs.json — starting fresh');
}

function bumpVersion() {
  libVersion++;
  libUpdatedAt = new Date().toISOString();
}

function persistLibrary() {
  try {
    const toSave = { _meta: { version: libVersion, last_updated: libUpdatedAt }, ...signsLibrary };
    fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.error('[DATA] Write error:', e.message);
  }
}

// Recompute grand average for a sign from all its sessions
function mergeSignSessions(sign) {
  const sessions = sign.sessions || [];
  if (!sessions.length) return;
  const n = sessions.length;
  const gFlex = [0, 0, 0, 0, 0];
  let gPitch = 0, gRoll = 0, gYaw = 0;
  sessions.forEach(s => {
    (s.avg_flex || []).forEach((v, i) => { gFlex[i] += v; });
    gPitch += (s.avg_pitch || 0);
    gRoll  += (s.avg_roll  || 0);
    gYaw   += (s.avg_yaw   || 0);
  });
  sign.avg_flex     = gFlex.map(v => v / n);
  sign.avg_pitch    = gPitch / n;
  sign.avg_roll     = gRoll  / n;
  sign.avg_yaw      = gYaw   / n;
  sign.session_count  = n;
  sign.total_samples  = sessions.reduce((a, s) => a + (s.sample_count || 0), 0);
}

// ── WebSocket server ──────────────────────────────────────────
const wss = new WebSocket.Server({ server });

let esp32Socket   = null;       // one ESP32 at a time
const browsers    = new Set();  // multiple browser tabs

function broadcast(clients, msg) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

function broadcastBrowsers(msg) { broadcast(browsers, msg); }
function sendESP32(msg)        {
  if (esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    esp32Socket.send(data);
  }
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] New connection from ${ip}`);

  let role = null;  // 'esp32' | 'browser'

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    // ── Role identification ────────────────────────────────
    if (msg.type === 'identify') {
      role = msg.role;
      if (role === 'esp32') {
        esp32Socket = ws;
        console.log('[WS] ESP32 connected');
        broadcastBrowsers({ type: 'esp32_status', connected: true });
        // Push cached library to ESP32 for sync
        sendESP32({ type: 'sync_library', data: signsLibrary });
      } else {
        browsers.add(ws);
        console.log(`[WS] Browser connected (total: ${browsers.size})`);
        // Give browser current state immediately
        ws.send(JSON.stringify({ type: 'library_update', data: signsLibrary, version: libVersion, last_updated: libUpdatedAt }));
        ws.send(JSON.stringify({
          type: 'esp32_status',
          connected: !!(esp32Socket && esp32Socket.readyState === WebSocket.OPEN)
        }));
      }
      return;
    }

    // ── Messages from ESP32 ───────────────────────────────
    if (ws === esp32Socket) {
      switch (msg.type) {
        case 'sensor_data':
          broadcastBrowsers(msg);           // low-latency relay
          break;

        case 'sign_saved': {
          const { label, data } = msg;
          if (label && data) {
            // Merge ESP32 averages — preserve sessions history
            if (!signsLibrary[label]) signsLibrary[label] = {};
            Object.assign(signsLibrary[label], {
              avg_flex : data.avg_flex,
              avg_pitch: data.avg_pitch,
              avg_roll : data.avg_roll,
              avg_yaw  : data.avg_yaw,
              flex_tol : data.flex_tol  || signsLibrary[label].flex_tol  || 300,
              angle_tol: data.angle_tol || signsLibrary[label].angle_tol || 30,
            });
            signsLibrary[label].sign_version  = (signsLibrary[label].sign_version || 0) + 1;
            signsLibrary[label].last_updated  = new Date().toISOString();
            bumpVersion(); persistLibrary();
            broadcastBrowsers({ type: 'library_update', data: signsLibrary, version: libVersion, last_updated: libUpdatedAt });
          }
          break;
        }

        case 'library_dump': {
          let changed = false;
          for (const [lbl, d] of Object.entries(msg.data || {})) {
            if (!signsLibrary[lbl]) { signsLibrary[lbl] = d; changed = true; }
          }
          if (changed) { bumpVersion(); persistLibrary(); }
          broadcastBrowsers({ type: 'library_update', data: signsLibrary, version: libVersion, last_updated: libUpdatedAt });
          break;
        }

        case 'calib_progress':
        case 'calib_started':
        case 'yaw_reset':
        case 'library_cleared':
          broadcastBrowsers(msg);
          break;

        default:
          broadcastBrowsers(msg);
      }
    }

    // ── Messages from Browser ────────────────────────────
    if (browsers.has(ws)) {
      switch (msg.type) {

        // ── add_session: one calibration pass for a sign ──
        case 'add_session': {
          const { label, session } = msg;
          if (!label || !session) break;
          if (!signsLibrary[label]) {
            signsLibrary[label] = { sessions: [], avg_flex: [0,0,0,0,0], avg_pitch: 0, avg_roll: 0, avg_yaw: 0, flex_tol: 300, angle_tol: 30, sign_version: 0 };
          }
          const sign = signsLibrary[label];
          if (!Array.isArray(sign.sessions)) sign.sessions = [];
          sign.sessions.push(session);
          mergeSignSessions(sign);
          sign.sign_version = (sign.sign_version || 0) + 1;
          sign.last_updated = new Date().toISOString();
          bumpVersion(); persistLibrary();
          // Relay merged averages to ESP32
          sendESP32({ type: 'save_sign', label, data: {
            avg_flex: sign.avg_flex, avg_pitch: sign.avg_pitch,
            avg_roll: sign.avg_roll, avg_yaw: sign.avg_yaw,
            flex_tol: sign.flex_tol, angle_tol: sign.angle_tol,
          }});
          broadcastBrowsers({ type: 'library_update', data: signsLibrary, version: libVersion, last_updated: libUpdatedAt });
          break;
        }

        case 'save_sign': {
          // Legacy fallback — upsert full averaged data
          const { label, data } = msg;
          if (label && data) {
            if (!signsLibrary[label]) signsLibrary[label] = {};
            Object.assign(signsLibrary[label], data);
            signsLibrary[label].sign_version = (signsLibrary[label].sign_version || 0) + 1;
            signsLibrary[label].last_updated = new Date().toISOString();
            bumpVersion(); persistLibrary();
            broadcastBrowsers({ type: 'library_update', data: signsLibrary, version: libVersion, last_updated: libUpdatedAt });
            sendESP32(msg);
          }
          break;
        }

        case 'delete_sign': {
          const { label } = msg;
          if (label) {
            delete signsLibrary[label];
            bumpVersion(); persistLibrary();
            broadcastBrowsers({ type: 'library_update', data: signsLibrary, version: libVersion, last_updated: libUpdatedAt });
            sendESP32(msg);
          }
          break;
        }

        case 'update_sign_settings': {
          const { label, flex_tol, angle_tol, newLabel } = msg;
          if (label && signsLibrary[label]) {
            const sign = signsLibrary[label];
            if (flex_tol !== undefined) sign.flex_tol = flex_tol;
            if (angle_tol !== undefined) sign.angle_tol = angle_tol;
            
            let finalLabel = label;
            if (newLabel && newLabel !== label) {
              signsLibrary[newLabel] = sign;
              delete signsLibrary[label];
              finalLabel = newLabel;
              sendESP32({ type: 'delete_sign', label });
            }
            
            bumpVersion();
            persistLibrary();
            
            // Relay to ESP32 to update its local LittleFS copy
            sendESP32({
              type: 'save_sign',
              label: finalLabel,
              data: {
                avg_flex: sign.avg_flex,
                avg_pitch: sign.avg_pitch,
                avg_roll: sign.avg_roll,
                avg_yaw: sign.avg_yaw,
                flex_tol: sign.flex_tol,
                angle_tol: sign.angle_tol
              }
            });
            
            broadcastBrowsers({ type: 'library_update', data: signsLibrary, version: libVersion, last_updated: libUpdatedAt });
          }
          break;
        }

        case 'update_lcd':
          sendESP32(msg);
          break;

        // Forward everything else to ESP32
        default:
          sendESP32(msg);
      }
    }
  });

  ws.on('close', () => {
    if (ws === esp32Socket) {
      esp32Socket = null;
      console.log('[WS] ESP32 disconnected');
      broadcastBrowsers({ type: 'esp32_status', connected: false });
    }
    browsers.delete(ws);
    console.log(`[WS] Client disconnected (browsers: ${browsers.size})`);
  });

  ws.on('error', (e) => console.error('[WS] Socket error:', e.message));
});

// ─────────────────────────────────────────────────────────────
// ▶  REST API
// ─────────────────────────────────────────────────────────────
// GET  /api/signs        — full library
app.get('/api/signs', (_req, res) => res.json(signsLibrary));

// POST /api/signs        — upsert a sign
app.post('/api/signs', (req, res) => {
  const { label, data } = req.body;
  if (!label || !data) return res.status(400).json({ error: 'label and data required' });
  signsLibrary[label] = data;
  persistLibrary();
  res.json({ success: true });
});

// DELETE /api/signs/:label
app.delete('/api/signs/:label', (req, res) => {
  delete signsLibrary[req.params.label];
  persistLibrary();
  res.json({ success: true });
});

// GET /api/status
app.get('/api/status', (_req, res) => res.json({
  esp32Connected : !!(esp32Socket && esp32Socket.readyState === WebSocket.OPEN),
  browserCount   : browsers.size,
  signCount      : Object.keys(signsLibrary).length,
  libVersion,
  libUpdatedAt,
}));

// GET /api/library/version
app.get('/api/library/version', (_req, res) => res.json({ version: libVersion, last_updated: libUpdatedAt, sign_count: Object.keys(signsLibrary).length }));

// ─────────────────────────────────────────────────────────────
// ▶  EXPORT Endpoints
// ─────────────────────────────────────────────────────────────

// ── CSV ───────────────────────────────────────────────────────
app.get('/api/export/csv', (_req, res) => {
  const rows = ['label,flex_thumb,flex_index,flex_middle,flex_ring,flex_pinky,accel_x,accel_y,accel_z,pitch,roll,yaw,flex_tol,angle_tol,timestamp'];
  for (const [label, s] of Object.entries(signsLibrary)) {
    const f = s.avg_flex || [0,0,0,0,0];
    const a = s.accel    || {};
    rows.push([
      label,
      f[0]??'', f[1]??'', f[2]??'', f[3]??'', f[4]??'',
      a.x??'', a.y??'', a.z??'',
      s.avg_pitch??'', s.avg_roll??'', s.avg_yaw??'',
      s.flex_tol??'', s.angle_tol??'',
      s.timestamp ?? ''
    ].join(','));

    // Write each session's averages as separate rows
    if (Array.isArray(s.sessions)) {
      s.sessions.forEach((sess, idx) => {
        const sf = sess.avg_flex || [];
        rows.push([
          `${label}_session${idx + 1}`,
          sf[0]??'', sf[1]??'', sf[2]??'', sf[3]??'', sf[4]??'',
          '','','',
          sess.avg_pitch??'', sess.avg_roll??'', sess.avg_yaw??'',
          s.flex_tol??'', s.angle_tol??'', sess.timestamp??''
        ].join(','));
      });
    }
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="signs_library.csv"');
  res.send(rows.join('\n'));
});

// ── JSON ──────────────────────────────────────────────────────
app.get('/api/export/json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="signs_library.json"');
  res.json(signsLibrary);
});

// ── Arduino .h header ─────────────────────────────────────────
app.get('/api/export/arduino', (_req, res) => {
  const entries = Object.entries(signsLibrary).filter(([, s]) => s.avg_flex);
  const count   = entries.length;

  let h = `// ============================================================\n`;
  h    += `// SignLanguageLib.h — Auto-generated Sign Language Library\n`;
  h    += `// Generated: ${new Date().toISOString()}\n`;
  h    += `// Signs: ${count}\n`;
  h    += `// ============================================================\n\n`;
  h    += `#ifndef SIGN_LANGUAGE_LIB_H\n#define SIGN_LANGUAGE_LIB_H\n\n`;
  h    += `#include <Arduino.h>\n#include <math.h>\n\n`;
  h    += `// ── Data types ───────────────────────────────────────────\n`;
  h    += `#define SIGN_COUNT ${count}\n\n`;
  h    += `struct SignData {\n`;
  h    += `  const char* label;\n`;
  h    += `  float       flex[5];          // ADC 0–4095: thumb,index,middle,ring,pinky\n`;
  h    += `  float       pitch, roll, yaw; // degrees\n`;
  h    += `  float       flexTol;          // Euclidean distance threshold\n`;
  h    += `  float       angleTol;         // ° per axis\n`;
  h    += `};\n\n`;
  h    += `// ── Library table ───────────────────────────────────────\n`;
  h    += `const SignData SIGN_LIBRARY[SIGN_COUNT] = {\n`;
  entries.forEach(([lbl, s], i) => {
    const f = s.avg_flex || [0,0,0,0,0];
    const p = (s.avg_pitch  || 0).toFixed(2);
    const r = (s.avg_roll   || 0).toFixed(2);
    const y = (s.avg_yaw    || 0).toFixed(2);
    const ft = (s.flex_tol  || 300).toFixed(1);
    const at = (s.angle_tol || 30).toFixed(1);
    const fStr = f.map(v => (v||0).toFixed(1)).join(', ');
    h += `  { "${lbl}", {${fStr}}, ${p}f, ${r}f, ${y}f, ${ft}f, ${at}f }${i < count-1 ? ',' : ''}\n`;
  });
  h    += `};\n\n`;
  h    += `// ── Detection function ──────────────────────────────────\n`;
  h    += `// Returns index in SIGN_LIBRARY, or -1 if no match\n`;
  h    += `// flex[5]: current ADC readings\n`;
  h    += `inline int detectSign(const float flex[5], float pitch, float roll, float yaw) {\n`;
  h    += `  (void)pitch; (void)roll; (void)yaw; // angle matching optional\n`;
  h    += `  float bestScore = 1e9f;\n`;
  h    += `  int   bestIdx   = -1;\n`;
  h    += `  for (int i = 0; i < SIGN_COUNT; i++) {\n`;
  h    += `    float score = 0.0f;\n`;
  h    += `    for (int j = 0; j < 5; j++) {\n`;
  h    += `      float d = flex[j] - SIGN_LIBRARY[i].flex[j];\n`;
  h    += `      score  += d * d;\n`;
  h    += `    }\n`;
  h    += `    score = sqrtf(score);\n`;
  h    += `    if (score < bestScore && score < SIGN_LIBRARY[i].flexTol) {\n`;
  h    += `      bestScore = score;\n`;
  h    += `      bestIdx   = i;\n`;
  h    += `    }\n`;
  h    += `  }\n`;
  h    += `  return bestIdx;\n`;
  h    += `}\n\n`;
  h    += `#endif // SIGN_LANGUAGE_LIB_H\n`;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="SignLanguageLib.h"');
  res.send(h);
});

// ── Catch-all → index.html (SPA) ─────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// ─────────────────────────────────────────────────────────────
// ▶  Start
// ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀  SignGlove Server running at http://localhost:${PORT}`);
  console.log(`📡  WebSocket relay ready`);
  console.log(`📂  Serving web app from: ${PUBLIC}`);
  console.log(`💾  Data file: ${DATA_FILE}\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌  Port ${PORT} is already in use. Try: PORT=3001 node server.js`);
  } else {
    console.error('Server error:', e);
  }
  process.exit(1);
});
