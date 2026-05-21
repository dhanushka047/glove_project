# 🧤 SignGlove — Sign Language Detection System

A full-stack sign language recording and detection system using an ESP32-S3 glove with flex sensors + MPU6050 IMU.

## Hardware

| Component | Pin |
|-----------|-----|
| Flex Thumb  | GPIO 1 (A1) |
| Flex Index  | GPIO 3 (A3) |
| Flex Middle | GPIO 5 (A5) |
| Flex Ring   | GPIO 7 (A7) |
| Flex Pinky  | GPIO 2 (A2) |
| MPU6050 SDA | GPIO 8 |
| MPU6050 SCL | GPIO 9 |
| Button      | GPIO 0 (Boot button) |

## Quick Start

### 1. Start the Node.js Server

```bash
cd server
npm install
npm start
```

Open browser at **http://localhost:3000**

### 2. Flash the ESP32-S3

Edit `firmware/glove_esp32/glove_esp32.ino` and update:
```cpp
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_HOST   = "192.168.1.100";  // Your PC's IP
```

**Required Arduino Libraries** (install via Library Manager):
- `arduinoWebSockets` by Markus Sattler
- `ArduinoJson` by Benoit Blanchon

Flash to ESP32-S3 using Arduino IDE 2.x.

### 3. Connect

In the web dashboard, click **Connect** and enter your server's IP. The ESP32 and browser connect to the same Node.js server automatically.

## Features

| Feature | Description |
|---------|-------------|
| **Live Dashboard** | Real-time 3D orientation cube + 5-finger flex sensor bars |
| **Calibrate** | Step-by-step wizard: enter label → countdown → record → save |
| **Library** | View, search, and delete all recorded signs |
| **Test Mode** | Real-time sign detection with confidence bar |
| **Export CSV** | All signs + raw samples for ML/analysis |
| **Export JSON** | Full library backup |
| **Export Arduino .h** | Plug-and-play C++ header for any Arduino board |

## Button Behaviours (GPIO 0)

| Press | Action |
|-------|--------|
| Short press (< 1.5s) | Reset yaw to 0° |
| Long press (≥ 1.5s)  | Clear all signs from ESP32 flash |

## Data Format

Each sign is stored as:
```json
{
  "A": {
    "avg_flex": [1234, 2100, 1800, 1500, 1100],
    "avg_pitch": -12.3,
    "avg_roll": 5.1,
    "avg_yaw": 0.0,
    "flex_tol": 300,
    "angle_tol": 30,
    "timestamp": "2026-05-21T13:00:00Z",
    "samples": [...]
  }
}
```

## Sync Strategy

- Signs are persisted on **both** ESP32 (LittleFS) and **server** (`server/data/signs.json`)
- On ESP32 reconnect: server pushes its library to ESP32 for merge
- ESP32 echoes back merged library → server updates → all browsers notified

## Directory Structure

```
glove_project/
├── firmware/
│   └── glove_esp32/
│       ├── glove_esp32.ino      ← Main Arduino sketch
│       └── mpu6050_helper.h     ← Lightweight MPU6050 driver
├── server/
│   ├── server.js                ← Node.js Express + WebSocket relay
│   ├── package.json
│   └── data/
│       └── signs.json           ← Auto-created library cache
└── public/
    ├── index.html               ← Single-page web app
    ├── style.css                ← Dark glassmorphism UI
    └── app.js                   ← Frontend logic + Three.js
```
