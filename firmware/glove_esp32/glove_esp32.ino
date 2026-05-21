// =============================================================
// glove_esp32.ino — Sign Language Glove Firmware
// Hardware: ESP32-S3
//   Flex sensors: A1(GPIO1), A3(GPIO3), A5(GPIO5), A7(GPIO7), A2(GPIO2)
//   MPU6050:     SDA=GPIO8, SCL=GPIO9
//   Button:      GPIO0 (boot button — trigger calibration)
//
// Libraries required (install via Arduino Library Manager):
//   - ArduinoWebsockets  (by Gil Maimon)
//   - ArduinoJson        (by Benoit Blanchon)
//   - LittleFS           (built-in ESP32 core)
// =============================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient_Generic.h>  // WebSockets_Generic library (already installed)
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Wire.h>
#include "mpu6050_helper.h"

// ═══════════════════════════════════════════════════════════════
// ▶  USER CONFIGURATION — update before flashing
// ═══════════════════════════════════════════════════════════════
const char* WIFI_SSID     = "Dineth's A56";       // ← change
const char* WIFI_PASSWORD = "12345678";   // ← change
const char* SERVER_HOST   = "10.224.249.202";        // ← Node.js server IP
const int   SERVER_PORT   = 3000;

// ═══════════════════════════════════════════════════════════════
// ▶  Pin Definitions
// ═══════════════════════════════════════════════════════════════
// Flex sensor ADC pins (ESP32-S3 uses GPIO numbers)
#define PIN_FLEX_THUMB   A1   // A1
#define PIN_FLEX_INDEX   A3   // A3
#define PIN_FLEX_MIDDLE  A5   // A5
#define PIN_FLEX_RING    A7   // A7
#define PIN_FLEX_PINKY   A2   // A2

// MPU6050 I2C
#define PIN_SDA          8
#define PIN_SCL          9

// Button (boot button — LOW when pressed)
#define PIN_BUTTON       0

// ═══════════════════════════════════════════════════════════════
// ▶  Constants
// ═══════════════════════════════════════════════════════════════
#define SENSOR_PERIOD_MS   20     // 50 Hz sensor sampling
#define SEND_PERIOD_MS     50     // 20 Hz WebSocket streaming
#define CALIB_SAMPLES      50     // samples averaged per sign
#define MAX_SIGNS          64
#define SIGNS_FILE         "/signs.json"

// ═══════════════════════════════════════════════════════════════
// ▶  Data Structures
// ═══════════════════════════════════════════════════════════════
struct SignRecord {
  char  label[8];
  float avg_flex[5];     // thumb, index, middle, ring, pinky (ADC 0–4095)
  float avg_pitch;
  float avg_roll;
  float avg_yaw;
  float flex_tol;        // Euclidean distance threshold for flex
  float angle_tol;       // degrees tolerance per axis
  bool  valid;
};

struct CalibSample {
  float flex[5];
  float pitch, roll, yaw;
};

// ═══════════════════════════════════════════════════════════════
// ▶  Globals
// ═══════════════════════════════════════════════════════════════
WebSocketsClient wsClient;
MPU6050Helper    imu;

SignRecord   signLib[MAX_SIGNS];
int          signCount      = 0;

// Live sensor state
float        curFlex[5]     = {0};
float        curPitch, curRoll, curYaw;

// Calibration state
bool         calibActive    = false;
char         calibLabel[8]  = "";
CalibSample  calibBuf[CALIB_SAMPLES];
int          calibIdx       = 0;

// Timers
unsigned long lastSensorTime = 0;
unsigned long lastSendTime   = 0;

// Button debounce
bool         btnLastState   = HIGH;
unsigned long btnPressTime  = 0;

// WS state
bool         wsConnected    = false;

// ═══════════════════════════════════════════════════════════════
// ▶  LittleFS — Persistence
// ═══════════════════════════════════════════════════════════════
void loadLibrary() {
  if (!LittleFS.exists(SIGNS_FILE)) {
    Serial.println("[FS] No signs.json — starting fresh");
    return;
  }
  File f = LittleFS.open(SIGNS_FILE, "r");
  if (!f) return;

  DynamicJsonDocument doc(32768);
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) { Serial.println("[FS] Parse error in signs.json"); return; }

  signCount = 0;
  for (JsonPair kv : doc.as<JsonObject>()) {
    if (signCount >= MAX_SIGNS) break;
    SignRecord& s = signLib[signCount];
    strncpy(s.label, kv.key().c_str(), 7);
    s.label[7] = '\0';
    JsonObject d = kv.value().as<JsonObject>();
    JsonArray  fa = d["avg_flex"].as<JsonArray>();
    for (int i = 0; i < 5 && i < (int)fa.size(); i++) s.avg_flex[i] = fa[i].as<float>();
    s.avg_pitch  = d["avg_pitch"]  | 0.0f;
    s.avg_roll   = d["avg_roll"]   | 0.0f;
    s.avg_yaw    = d["avg_yaw"]    | 0.0f;
    s.flex_tol   = d["flex_tol"]   | 300.0f;
    s.angle_tol  = d["angle_tol"]  | 30.0f;
    s.valid = true;
    signCount++;
  }
  Serial.printf("[FS] Loaded %d sign(s)\n", signCount);
}

void saveLibrary() {
  DynamicJsonDocument doc(32768);
  for (int i = 0; i < signCount; i++) {
    if (!signLib[i].valid) continue;
    JsonObject d  = doc.createNestedObject(signLib[i].label);
    JsonArray  fa = d.createNestedArray("avg_flex");
    for (int j = 0; j < 5; j++) fa.add(signLib[i].avg_flex[j]);
    d["avg_pitch"] = signLib[i].avg_pitch;
    d["avg_roll"]  = signLib[i].avg_roll;
    d["avg_yaw"]   = signLib[i].avg_yaw;
    d["flex_tol"]  = signLib[i].flex_tol;
    d["angle_tol"] = signLib[i].angle_tol;
  }
  File f = LittleFS.open(SIGNS_FILE, "w");
  if (!f) { Serial.println("[FS] Cannot open signs.json for write"); return; }
  serializeJson(doc, f);
  f.close();
  Serial.println("[FS] Library saved to flash");
}

// ═══════════════════════════════════════════════════════════════
// ▶  Sign Library Helpers
// ═══════════════════════════════════════════════════════════════
void upsertSign(const char* label, float* flex, float pitch, float roll, float yaw) {
  // Update existing
  for (int i = 0; i < signCount; i++) {
    if (strcmp(signLib[i].label, label) == 0) {
      for (int j = 0; j < 5; j++) signLib[i].avg_flex[j] = flex[j];
      signLib[i].avg_pitch = pitch;
      signLib[i].avg_roll  = roll;
      signLib[i].avg_yaw   = yaw;
      saveLibrary();
      return;
    }
  }
  // Insert new
  if (signCount >= MAX_SIGNS) { Serial.println("[LIB] Library full!"); return; }
  SignRecord& s = signLib[signCount++];
  strncpy(s.label, label, 7);
  s.label[7] = '\0';
  for (int j = 0; j < 5; j++) s.avg_flex[j] = flex[j];
  s.avg_pitch  = pitch;
  s.avg_roll   = roll;
  s.avg_yaw    = yaw;
  s.flex_tol   = 300.0f;
  s.angle_tol  = 30.0f;
  s.valid = true;
  saveLibrary();
}

void deleteSign(const char* label) {
  for (int i = 0; i < signCount; i++) {
    if (strcmp(signLib[i].label, label) == 0) {
      signLib[i].valid = false;
    }
  }
  saveLibrary();
}

int detectSign(float* flex, float pitch, float roll, float yaw) {
  float bestScore = 1e9f;
  int   bestIdx   = -1;
  for (int i = 0; i < signCount; i++) {
    if (!signLib[i].valid) continue;
    float score = 0;
    for (int j = 0; j < 5; j++) {
      float d = flex[j] - signLib[i].avg_flex[j];
      score += d * d;
    }
    score = sqrtf(score);
    if (score < bestScore && score < signLib[i].flex_tol) {
      bestScore = score;
      bestIdx   = i;
    }
  }
  return bestIdx;
}

// ═══════════════════════════════════════════════════════════════
// ▶  Sensor Reading
// ═══════════════════════════════════════════════════════════════
void readSensors() {
  curFlex[0] = (float)analogRead(PIN_FLEX_THUMB);
  curFlex[1] = (float)analogRead(PIN_FLEX_INDEX);
  curFlex[2] = (float)analogRead(PIN_FLEX_MIDDLE);
  curFlex[3] = (float)analogRead(PIN_FLEX_RING);
  curFlex[4] = (float)analogRead(PIN_FLEX_PINKY);
  imu.update();
  curPitch = imu.pitch;
  curRoll  = imu.roll;
  curYaw   = imu.yaw;
}

// ═══════════════════════════════════════════════════════════════
// ▶  WebSocket — Send Helpers
// ═══════════════════════════════════════════════════════════════
void wsSend(const String& s) {
  if (wsConnected) wsClient.sendTXT(s);
}

void sendSensorData() {
  if (!wsConnected) return;
  StaticJsonDocument<512> doc;
  doc["type"]  = "sensor_data";
  JsonArray fa = doc.createNestedArray("flex");
  for (int i = 0; i < 5; i++) fa.add(curFlex[i]);
  JsonObject accel = doc.createNestedObject("accel");
  accel["x"] = imu.accelX; accel["y"] = imu.accelY; accel["z"] = imu.accelZ;
  JsonObject gyro  = doc.createNestedObject("gyro");
  gyro["x"]  = imu.gyroX;  gyro["y"]  = imu.gyroY;  gyro["z"]  = imu.gyroZ;
  doc["pitch"] = curPitch;
  doc["roll"]  = curRoll;
  doc["yaw"]   = curYaw;
  int det = detectSign(curFlex, curPitch, curRoll, curYaw);
  if (det >= 0) doc["detected"] = signLib[det].label;
  else           doc["detected"] = nullptr;
  String out; serializeJson(doc, out);
  wsClient.sendTXT(out);
}

void sendLibraryDump() {
  if (!wsConnected) return;
  DynamicJsonDocument doc(32768);
  doc["type"] = "library_dump";
  JsonObject data = doc.createNestedObject("data");
  for (int i = 0; i < signCount; i++) {
    if (!signLib[i].valid) continue;
    JsonObject d  = data.createNestedObject(signLib[i].label);
    JsonArray  fa = d.createNestedArray("avg_flex");
    for (int j = 0; j < 5; j++) fa.add(signLib[i].avg_flex[j]);
    d["avg_pitch"] = signLib[i].avg_pitch;
    d["avg_roll"]  = signLib[i].avg_roll;
    d["avg_yaw"]   = signLib[i].avg_yaw;
    d["flex_tol"]  = signLib[i].flex_tol;
    d["angle_tol"] = signLib[i].angle_tol;
  }
  String out; serializeJson(doc, out);
  wsClient.sendTXT(out);
}

// ═══════════════════════════════════════════════════════════════
// ▶  WebSocket — Command Processing
// ═══════════════════════════════════════════════════════════════
void processCommand(JsonDocument& doc) {
  const char* type = doc["type"];
  if (!type) return;

  // ── start_recording ─────────────────────────────────────
  if (strcmp(type, "start_recording") == 0) {
    const char* lbl = doc["label"];
    if (lbl) {
      strncpy(calibLabel, lbl, 7); calibLabel[7] = '\0';
      calibIdx    = 0;
      calibActive = true;
      Serial.printf("[CALIB] Recording: %s\n", calibLabel);
      wsSend("{\"type\":\"calib_started\"}");
    }
  }

  // ── stop_recording ───────────────────────────────────────
  else if (strcmp(type, "stop_recording") == 0) {
    calibActive = false;
    Serial.println("[CALIB] Stopped");
  }

  // ── save_sign  (browser already computed averages) ───────
  else if (strcmp(type, "save_sign") == 0) {
    const char* lbl = doc["label"];
    JsonObject  d   = doc["data"].as<JsonObject>();
    if (lbl && d) {
      float flex[5] = {0};
      JsonArray fa = d["avg_flex"].as<JsonArray>();
      for (int i = 0; i < 5 && i < (int)fa.size(); i++) flex[i] = fa[i].as<float>();
      upsertSign(lbl, flex, d["avg_pitch"] | 0.0f, d["avg_roll"] | 0.0f, d["avg_yaw"] | 0.0f);
      StaticJsonDocument<128> ack;
      ack["type"]  = "sign_saved";
      ack["label"] = lbl;
      String out; serializeJson(ack, out);
      wsSend(out);
    }
  }

  // ── delete_sign ──────────────────────────────────────────
  else if (strcmp(type, "delete_sign") == 0) {
    const char* lbl = doc["label"];
    if (lbl) { deleteSign(lbl); Serial.printf("[LIB] Deleted: %s\n", lbl); }
  }

  // ── sync_library (server merges its cache → ESP32) ───────
  else if (strcmp(type, "sync_library") == 0) {
    JsonObject data = doc["data"].as<JsonObject>();
    for (JsonPair kv : data) {
      float flex[5] = {0};
      JsonArray fa = kv.value()["avg_flex"].as<JsonArray>();
      for (int i = 0; i < 5 && i < (int)fa.size(); i++) flex[i] = fa[i].as<float>();
      upsertSign(kv.key().c_str(), flex,
                 kv.value()["avg_pitch"] | 0.0f,
                 kv.value()["avg_roll"]  | 0.0f,
                 kv.value()["avg_yaw"]   | 0.0f);
    }
    sendLibraryDump();   // Echo merged lib back to server
  }

  // ── request_library ──────────────────────────────────────
  else if (strcmp(type, "request_library") == 0) {
    sendLibraryDump();
  }

  // ── reset_yaw ────────────────────────────────────────────
  else if (strcmp(type, "reset_yaw") == 0) {
    imu.resetYaw();
    wsSend("{\"type\":\"yaw_reset\"}");
  }
}

// ═══════════════════════════════════════════════════════════════
// ▶  WebSocket Event Callback
// ═══════════════════════════════════════════════════════════════
void onWebSocketEvent(WStype_t eventType, uint8_t* payload, size_t length) {
  switch (eventType) {
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to ws://%s:%d\n", SERVER_HOST, SERVER_PORT);
      wsConnected = true;
      // Identify role
      wsClient.sendTXT("{\"type\":\"identify\",\"role\":\"esp32\"}");
      break;

    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected — retrying in 3s...");
      wsConnected = false;
      break;

    case WStype_TEXT: {
      DynamicJsonDocument doc(8192);
      DeserializationError err = deserializeJson(doc, payload, length);
      if (!err) processCommand(doc);
      break;
    }

    case WStype_ERROR:
      Serial.println("[WS] Error");
      break;

    default: break;
  }
}

// ═══════════════════════════════════════════════════════════════
// ▶  Calibration Recording (called every SENSOR_PERIOD_MS)
// ═══════════════════════════════════════════════════════════════
void handleCalibration() {
  if (!calibActive) return;
  if (calibIdx >= CALIB_SAMPLES) return;

  CalibSample& s = calibBuf[calibIdx++];
  for (int i = 0; i < 5; i++) s.flex[i] = curFlex[i];
  s.pitch = curPitch;
  s.roll  = curRoll;
  s.yaw   = curYaw;

  // Send progress
  if (wsConnected) {
    StaticJsonDocument<64> prog;
    prog["type"]     = "calib_progress";
    prog["current"]  = calibIdx;
    prog["total"]    = CALIB_SAMPLES;
    String out; serializeJson(prog, out);
    wsClient.sendTXT(out);
  }

  if (calibIdx >= CALIB_SAMPLES) {
    // Average samples
    float avgFlex[5] = {0};
    float avgPitch = 0, avgRoll = 0, avgYaw = 0;
    for (int i = 0; i < CALIB_SAMPLES; i++) {
      for (int j = 0; j < 5; j++) avgFlex[j] += calibBuf[i].flex[j];
      avgPitch += calibBuf[i].pitch;
      avgRoll  += calibBuf[i].roll;
      avgYaw   += calibBuf[i].yaw;
    }
    for (int j = 0; j < 5; j++) avgFlex[j] /= CALIB_SAMPLES;
    avgPitch /= CALIB_SAMPLES;
    avgRoll  /= CALIB_SAMPLES;
    avgYaw   /= CALIB_SAMPLES;

    upsertSign(calibLabel, avgFlex, avgPitch, avgRoll, avgYaw);
    calibActive = false;

    // Send confirmation with data
    DynamicJsonDocument doc(512);
    doc["type"]  = "sign_saved";
    doc["label"] = calibLabel;
    JsonObject data = doc.createNestedObject("data");
    JsonArray  fa   = data.createNestedArray("avg_flex");
    for (int j = 0; j < 5; j++) fa.add(avgFlex[j]);
    data["avg_pitch"] = avgPitch;
    data["avg_roll"]  = avgRoll;
    data["avg_yaw"]   = avgYaw;
    String out; serializeJson(doc, out);
    wsSend(out);
    Serial.printf("[CALIB] Done: %s\n", calibLabel);
  }
}

// ═══════════════════════════════════════════════════════════════
// ▶  Button Handler  (short press → trigger calibration for last label)
// ═══════════════════════════════════════════════════════════════
void handleButton() {
  bool state = digitalRead(PIN_BUTTON);
  if (btnLastState == HIGH && state == LOW) {
    btnPressTime  = millis();
  }
  if (btnLastState == LOW && state == HIGH) {
    unsigned long held = millis() - btnPressTime;
    if (held > 50 && held < 1500) {
      // Short press: reset yaw
      imu.resetYaw();
      Serial.println("[BTN] Short press — yaw reset");
      wsSend("{\"type\":\"yaw_reset\"}");
    } else if (held >= 1500) {
      // Long press: clear library
      Serial.println("[BTN] Long press — clearing library!");
      signCount = 0;
      LittleFS.remove(SIGNS_FILE);
      wsSend("{\"type\":\"library_cleared\"}");
    }
  }
  btnLastState = state;
}

// ═══════════════════════════════════════════════════════════════
// ▶  setup()
// ═══════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n╔══════════════════════════════╗");
  Serial.println("║  Sign Language Glove v1.0    ║");
  Serial.println("╚══════════════════════════════╝");

  // LittleFS
  if (!LittleFS.begin(true)) {
    Serial.println("[FS] Mount FAILED — formatting...");
    LittleFS.format();
    LittleFS.begin(true);
  }
  loadLibrary();

  // I2C + MPU6050
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);   // 400 kHz fast mode
  if (!imu.begin()) {
    Serial.println("[IMU] MPU6050 NOT found — check wiring!");
  }

  // ADC: 12-bit, 11dB (0–3.6V range)
  analogSetAttenuation(ADC_11db);

  // Button
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  // WiFi
  Serial.printf("[WiFi] Connecting to: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint8_t attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500); Serial.print("."); attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] FAILED — running offline (library still works)");
  }

  // WebSocket
  wsClient.begin(SERVER_HOST, SERVER_PORT, "/");
  wsClient.onEvent(onWebSocketEvent);
  wsClient.setReconnectInterval(3000);
  wsClient.enableHeartbeat(10000, 3000, 3);   // ping every 10s

  Serial.println("─────────────────────────────────");
  Serial.printf( "  WS Target : ws://%s:%d\n", SERVER_HOST, SERVER_PORT);
  Serial.printf( "  Dashboard : http://%s:%d\n", SERVER_HOST, SERVER_PORT);
  Serial.println("─────────────────────────────────");
  Serial.println("[SETUP] All systems ready! Connecting to server…");
}

// ═══════════════════════════════════════════════════════════════
// ▶  loop()
// ═══════════════════════════════════════════════════════════════
void loop() {
  wsClient.loop();
  handleButton();

  unsigned long now = millis();

  // Read sensors at 50 Hz
  if (now - lastSensorTime >= SENSOR_PERIOD_MS) {
    lastSensorTime = now;
    readSensors();
    handleCalibration();
  }

  // Stream sensor data at 20 Hz
  if (now - lastSendTime >= SEND_PERIOD_MS) {
    lastSendTime = now;
    sendSensorData();
  }
}
