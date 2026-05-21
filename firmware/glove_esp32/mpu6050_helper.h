// =============================================================
// mpu6050_helper.h — Lightweight MPU6050 Driver for ESP32-S3
// Complementary filter: pitch, roll, yaw from accel + gyro
// I2C pins: SDA=8, SCL=9  (configured in main sketch)
// =============================================================
#pragma once

#include <Wire.h>
#include <math.h>

// ── MPU6050 Register Map ──────────────────────────────────────
#define MPU6050_ADDR          0x68
#define REG_PWR_MGMT_1        0x6B
#define REG_SMPLRT_DIV        0x19
#define REG_CONFIG            0x1A
#define REG_GYRO_CONFIG       0x1B
#define REG_ACCEL_CONFIG      0x1C
#define REG_ACCEL_XOUT_H      0x3B
#define REG_GYRO_XOUT_H       0x43
#define REG_WHO_AM_I          0x75

// ── Scale factors ─────────────────────────────────────────────
#define ACCEL_SCALE_2G        16384.0f   // ±2g  → LSB/g
#define GYRO_SCALE_250        131.0f     // ±250°/s → LSB/(°/s)

// ── Complementary filter coefficient ────────────────────────
#define CF_ALPHA              0.96f      // 96% gyro / 4% accel

class MPU6050Helper {
public:
  // Calibrated outputs (g / °/s)
  float accelX, accelY, accelZ;
  float gyroX,  gyroY,  gyroZ;

  // Euler angles (degrees)
  float pitch, roll, yaw;

  // Raw 16-bit readings
  int16_t rawAx, rawAy, rawAz;
  int16_t rawGx, rawGy, rawGz;

  // Gyro bias (auto-calibrated on begin())
  float gyroBiasX, gyroBiasY, gyroBiasZ;

  // ── Initialise sensor ──────────────────────────────────────
  bool begin(uint8_t addr = MPU6050_ADDR, uint16_t calibSamples = 200) {
    _addr = addr;

    // Wake up (clear sleep bit)
    writeReg(REG_PWR_MGMT_1, 0x00);
    delay(150);

    // Verify WHO_AM_I (0x68 or 0x72 for MPU6050 variants)
    uint8_t who = readReg(REG_WHO_AM_I);
    if (who != 0x68 && who != 0x72 && who != 0x70) {
      Serial.printf("[IMU] WHO_AM_I=0x%02X — device not found!\n", who);
      return false;
    }
    Serial.printf("[IMU] MPU6050 found (WHO_AM_I=0x%02X)\n", who);

    // Sample rate divider: 1kHz / (1+9) = 100 Hz internal
    writeReg(REG_SMPLRT_DIV, 9);

    // DLPF: 44 Hz bandwidth (smooth but ~4.9ms delay)
    writeReg(REG_CONFIG, 0x03);

    // Gyro full-scale: ±250 °/s
    writeReg(REG_GYRO_CONFIG, 0x00);

    // Accel full-scale: ±2 g
    writeReg(REG_ACCEL_CONFIG, 0x00);

    delay(100);

    // Auto-calibrate gyro bias (device must be still!)
    Serial.println("[IMU] Calibrating gyro — keep glove still...");
    calibrateGyro(calibSamples);
    Serial.printf("[IMU] Gyro bias: Gx=%.2f Gy=%.2f Gz=%.2f °/s\n",
                  gyroBiasX, gyroBiasY, gyroBiasZ);

    _lastTime = micros();
    pitch = roll = yaw = 0.0f;
    return true;
  }

  // ── Read & filter ─────────────────────────────────────────
  void update() {
    uint8_t buf[14];
    readBytes(REG_ACCEL_XOUT_H, buf, 14);

    rawAx = (int16_t)((buf[0] << 8) | buf[1]);
    rawAy = (int16_t)((buf[2] << 8) | buf[3]);
    rawAz = (int16_t)((buf[4] << 8) | buf[5]);
    // buf[6..7] = temp — skip
    rawGx = (int16_t)((buf[8]  << 8) | buf[9]);
    rawGy = (int16_t)((buf[10] << 8) | buf[11]);
    rawGz = (int16_t)((buf[12] << 8) | buf[13]);

    // Scale
    accelX = rawAx / ACCEL_SCALE_2G;
    accelY = rawAy / ACCEL_SCALE_2G;
    accelZ = rawAz / ACCEL_SCALE_2G;
    gyroX  = (rawGx / GYRO_SCALE_250) - gyroBiasX;
    gyroY  = (rawGy / GYRO_SCALE_250) - gyroBiasY;
    gyroZ  = (rawGz / GYRO_SCALE_250) - gyroBiasZ;

    // dt
    unsigned long now = micros();
    float dt = (now - _lastTime) / 1000000.0f;
    _lastTime = now;
    if (dt <= 0.0f || dt > 0.5f) dt = 0.01f;

    // Accel-based pitch & roll (degrees)
    float accelPitch = atan2f(accelY, sqrtf(accelX * accelX + accelZ * accelZ)) * RAD_TO_DEG;
    float accelRoll  = atan2f(-accelX, accelZ) * RAD_TO_DEG;

    // Complementary filter
    pitch = CF_ALPHA * (pitch + gyroX * dt) + (1.0f - CF_ALPHA) * accelPitch;
    roll  = CF_ALPHA * (roll  + gyroY * dt) + (1.0f - CF_ALPHA) * accelRoll;
    yaw  += gyroZ * dt;   // Gyro-only (no magnetometer — drifts over time)
  }

  // ── Reset yaw ─────────────────────────────────────────────
  void resetYaw() { yaw = 0.0f; }

  // ── Return temperature (°C) ───────────────────────────────
  float getTemperatureC() {
    uint8_t buf[2];
    readBytes(0x41, buf, 2);
    int16_t raw = (int16_t)((buf[0] << 8) | buf[1]);
    return raw / 340.0f + 36.53f;
  }

private:
  uint8_t _addr;
  unsigned long _lastTime;

  // ── Gyro auto-calibration ─────────────────────────────────
  void calibrateGyro(uint16_t n) {
    double sumX = 0, sumY = 0, sumZ = 0;
    for (uint16_t i = 0; i < n; i++) {
      uint8_t buf[6];
      readBytes(REG_GYRO_XOUT_H, buf, 6);
      sumX += (int16_t)((buf[0] << 8) | buf[1]);
      sumY += (int16_t)((buf[2] << 8) | buf[3]);
      sumZ += (int16_t)((buf[4] << 8) | buf[5]);
      delay(4);
    }
    gyroBiasX = (float)(sumX / n) / GYRO_SCALE_250;
    gyroBiasY = (float)(sumY / n) / GYRO_SCALE_250;
    gyroBiasZ = (float)(sumZ / n) / GYRO_SCALE_250;
  }

  // ── I2C helpers ───────────────────────────────────────────
  void writeReg(uint8_t reg, uint8_t val) {
    Wire.beginTransmission(_addr);
    Wire.write(reg);
    Wire.write(val);
    Wire.endTransmission();
  }

  uint8_t readReg(uint8_t reg) {
    Wire.beginTransmission(_addr);
    Wire.write(reg);
    Wire.endTransmission(false);
    Wire.requestFrom(_addr, (uint8_t)1);
    return Wire.available() ? Wire.read() : 0;
  }

  void readBytes(uint8_t reg, uint8_t* buf, uint8_t len) {
    Wire.beginTransmission(_addr);
    Wire.write(reg);
    Wire.endTransmission(false);
    Wire.requestFrom(_addr, len);
    for (uint8_t i = 0; i < len && Wire.available(); i++) {
      buf[i] = Wire.read();
    }
  }
};
