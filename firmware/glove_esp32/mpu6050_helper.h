// =============================================================
// mpu6050_helper.h — MPU6050 wrapper using raw I2C (Wire.h)
// skipping accelerometer registers to optimize bus transfer.
// =============================================================
#pragma once

#include <Wire.h>

#define MPU6050_ADDR         0x68
#define MPU6050_SMPLRT_DIV   0x19
#define MPU6050_CONFIG       0x1A
#define MPU6050_GYRO_CONFIG  0x1B
#define MPU6050_ACCEL_CONFIG 0x1C
#define MPU6050_PWR_MGMT_1   0x6B
#define MPU6050_WHO_AM_I     0x75
#define MPU6050_DATA_START   0x43 // GYRO_XOUT_H
#define MPU6050_ACCEL_START  0x3B // ACCEL_XOUT_H

#define GYRO_SCALE           65.5f

class MPU6050Helper {
public:
  // Integrated Orientation (degrees)
  float pitch = 0.0f;
  float roll  = 0.0f;
  float yaw   = 0.0f;

  // Accelerometer (g) - set to 0.0f since registers are skipped
  float accelX = 0.0f;
  float accelY = 0.0f;
  float accelZ = 0.0f;

  // Gyro rates (°/s)
  float gyroX = 0.0f;
  float gyroY = 0.0f;
  float gyroZ = 0.0f;

  // ── Initialise ───────────────────────────────────────────
  bool begin(int sda = 17, int scl = 18) {
    _sda = sda;
    _scl = scl;
    Serial.println("[IMU] Initializing MPU6050 (Direct Wire, Gyro-Only)...");
    
    // Check connection
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(MPU6050_WHO_AM_I);
    if (Wire.endTransmission() != 0) {
      Serial.println("[IMU] ERROR: MPU6050 not found on I2C bus! Check SDA/SCL pins.");
      return false;
    }

    // Wake up MPU6050
    if (!writeRegister(MPU6050_PWR_MGMT_1, 0x00)) {
      Serial.println("[IMU] ERROR: Wake up failed.");
      return false;
    }

    // Set sample rate divider to 7 (125Hz output)
    writeRegister(MPU6050_SMPLRT_DIV, 0x07);

    // Set Digital Low Pass Filter (DLPF) to ~42Hz bandwidth
    writeRegister(MPU6050_CONFIG, 0x03);

    // Set Gyroscope Full Scale Range to +/- 500 deg/s
    writeRegister(MPU6050_GYRO_CONFIG, 0x08);

    // Set Accelerometer Full Scale Range to +/- 4g (for completeness)
    writeRegister(MPU6050_ACCEL_CONFIG, 0x08);

    Serial.println("[IMU] MPU6050 configured successfully ✓");
    
    // Calibrate offsets
    calibrateOffsets();

    _lastTime = millis();
    return true;
  }

  // ── Update (call every loop tick) ────────────────────────
  void update() {
    bool success = false;

    // Read 14 bytes starting from ACCEL_XOUT_H (0x3B)
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(MPU6050_ACCEL_START);
    if (Wire.endTransmission(false) == 0) {
      Wire.requestFrom(MPU6050_ADDR, 14, true);

      if (Wire.available() == 14) {
        // Retrieve values (MSB first, then LSB)
        int16_t raw_ax = (Wire.read() << 8) | Wire.read();
        int16_t raw_ay = (Wire.read() << 8) | Wire.read();
        int16_t raw_az = (Wire.read() << 8) | Wire.read();
        int16_t raw_temp = (Wire.read() << 8) | Wire.read(); // Read and discard temp
        int16_t raw_gx = (Wire.read() << 8) | Wire.read();
        int16_t raw_gy = (Wire.read() << 8) | Wire.read();
        int16_t raw_gz = (Wire.read() << 8) | Wire.read();

        // Convert accelerometer to physical units (g)
        // AFS_SEL = 1 is configured (range +/- 4g), which has sensitivity 8192 LSB/g
        accelX = raw_ax / 8192.0f;
        accelY = raw_ay / 8192.0f;
        accelZ = raw_az / 8192.0f;

        // Convert gyroscope to physical units (deg/s)
        gyroX = raw_gx / GYRO_SCALE;
        gyroY = raw_gy / GYRO_SCALE;
        gyroZ = raw_gz / GYRO_SCALE;

        // Perform sensor fusion / integration on the ESP32
        integrateOrientation();
        success = true;
        _consecutiveFailures = 0;
      }
    }

    if (!success) {
      // Reset gyro rates to 0 on failure to prevent stale data runaway integration
      gyroX = 0.0f;
      gyroY = 0.0f;
      gyroZ = 0.0f;

      _consecutiveFailures++;
      if (_consecutiveFailures >= 10) {
        Serial.printf("[IMU] Warning: %d consecutive I2C read failures. Re-initializing Wire bus...\n", _consecutiveFailures);
        Wire.begin(_sda, _scl);
        Wire.setClock(400000);
        // Re-initialize registers in case sensor power-cycled
        writeRegister(MPU6050_PWR_MGMT_1, 0x00);
        writeRegister(MPU6050_SMPLRT_DIV, 0x07);
        writeRegister(MPU6050_CONFIG, 0x03);
        writeRegister(MPU6050_GYRO_CONFIG, 0x08);
        writeRegister(MPU6050_ACCEL_CONFIG, 0x08);
        _consecutiveFailures = 0;
      }
    }
  }

  // ── Reset orientations to zero ───────────────────────────
  void resetYaw() {
    pitch = 0.0f;
    roll  = 0.0f;
    yaw   = 0.0f;
    Serial.println("[IMU] ESP32-side orientation integration reset.");
  }

  void calibrateOffsets() {
    Serial.println("[IMU] Calibrating gyroscope — keep glove STILL for 2s...");
    float sumX = 0, sumY = 0, sumZ = 0;
    int targetSamples = 200;
    int validSamples = 0;
    
    for (int i = 0; i < targetSamples; i++) {
      Wire.beginTransmission(MPU6050_ADDR);
      Wire.write(MPU6050_DATA_START);
      if (Wire.endTransmission(false) == 0) {
        Wire.requestFrom(MPU6050_ADDR, 6, true);
        if (Wire.available() == 6) {
          int16_t raw_gx = (Wire.read() << 8) | Wire.read();
          int16_t raw_gy = (Wire.read() << 8) | Wire.read();
          int16_t raw_gz = (Wire.read() << 8) | Wire.read();
          
          sumX += raw_gx / GYRO_SCALE;
          sumY += raw_gy / GYRO_SCALE;
          sumZ += raw_gz / GYRO_SCALE;
          validSamples++;
        }
      }
      delay(10);
    }
    
    if (validSamples > 0) {
      _biasX = sumX / validSamples;
      _biasY = sumY / validSamples;
      _biasZ = sumZ / validSamples;
    }
    
    Serial.printf("[IMU] Gyro biases (from %d samples): X=%.2f, Y=%.2f, Z=%.2f\n", validSamples, _biasX, _biasY, _biasZ);
  }

private:
  unsigned long _lastTime = 0;
  int _sda = 17;
  int _scl = 18;
  int _consecutiveFailures = 0;
  
  // Gyro biases calculated during startup
  float _biasX = 0.0f;
  float _biasY = 0.0f;
  float _biasZ = 0.0f;

  bool writeRegister(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(reg);
    Wire.write(value);
    return (Wire.endTransmission() == 0);
  }

  void integrateOrientation() {
    unsigned long now = millis();
    float dt = (now - _lastTime) / 1000.0f;
    _lastTime = now;

    // Guard against timing anomalies
    if (dt > 0.2f || dt <= 0.0f) return;

    // Apply offset calibration
    float gx_cal = gyroX - _biasX;
    float gy_cal = gyroY - _biasY;
    float gz_cal = gyroZ - _biasZ;

    // Apply noise gate / deadband to filter out micro-drift when stationary
    const float DEADBAND = 0.8f;
    float clean_gx = (fabs(gx_cal) < DEADBAND) ? 0.0f : gx_cal;
    float clean_gy = (fabs(gy_cal) < DEADBAND) ? 0.0f : gy_cal;
    float clean_gz = (fabs(gz_cal) < DEADBAND) ? 0.0f : gz_cal;

    // Remap physical axes to logical visualization coordinates
    // Logical X (Roll): Physical X (Inverted)
    // Logical Y (Pitch): Physical Y (Normal)
    // Logical Z (Yaw): Physical Z (Inverted)
    float logical_gx = -clean_gx;
    float logical_gy = clean_gy;
    float logical_gz = -clean_gz;

    // Calculate pitch and roll angles from the accelerometer (in degrees)
    float accelPitch = atan2(-accelX, sqrt(accelY * accelY + accelZ * accelZ)) * 57.29578f;
    float accelRoll  = atan2(accelY, accelZ) * 57.29578f;

    // Apply remapped signs to accelerometer reference:
    // since logical_gy = clean_gy, logical pitch is normal
    float targetPitch = accelPitch;
    // since logical_gx = -clean_gx, logical roll is inverted
    float targetRoll = -accelRoll;

    // Calculate total acceleration magnitude (in g)
    float forceMagnitude = sqrt(accelX * accelX + accelY * accelY + accelZ * accelZ);

    // Complementary Filter: 98% Gyro, 2% Accelerometer.
    // Only apply accelerometer reference when the sensor is relatively static (magnitude near 1.0g)
    // to prevent dynamic motion acceleration from corrupting the tilt calculation.
    if (forceMagnitude > 0.5f && forceMagnitude < 1.5f) {
      pitch = 0.98f * (pitch + logical_gy * dt) + 0.02f * targetPitch;
      roll  = 0.98f * (roll + logical_gx * dt) + 0.02f * targetRoll;
    } else {
      pitch += logical_gy * dt;
      roll  += logical_gx * dt;
    }

    // Yaw cannot be corrected with accelerometer (requires magnetometer).
    // We integrate it directly.
    yaw += logical_gz * dt;
  }
};
