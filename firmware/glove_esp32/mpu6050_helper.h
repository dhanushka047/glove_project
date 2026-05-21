// =============================================================
// mpu6050_helper.h — MPU6050 wrapper using MPU6050_light lib
// Install: Arduino Library Manager → search "MPU6050_light"
//          Author: rfetick
// I2C pins: SDA=8, SCL=9  (set in main sketch via Wire.begin)
// =============================================================
#pragma once

#include <Wire.h>
#include <MPU6050_light.h>

class MPU6050Helper {
public:
  // Euler angles (degrees) — matches same names as before
  float pitch = 0.0f;
  float roll  = 0.0f;
  float yaw   = 0.0f;

  // Accelerometer (g)
  float accelX = 0.0f;
  float accelY = 0.0f;
  float accelZ = 0.0f;

  // Gyro (°/s)
  float gyroX = 0.0f;
  float gyroY = 0.0f;
  float gyroZ = 0.0f;

  // ── Initialise ───────────────────────────────────────────
  bool begin() {
    byte status = _mpu.begin();
    if (status != 0) {
      Serial.printf("[IMU] MPU6050 error code: %d\n", status);
      Serial.println("[IMU] Check wiring: SDA=GPIO8  SCL=GPIO9");
      return false;
    }
    Serial.println("[IMU] MPU6050 found ✓");
    Serial.println("[IMU] Calibrating — keep glove STILL for 3s...");

    delay(1000);   // settle time
    _mpu.calcOffsets(true, true);   // auto-calibrate accel + gyro

    Serial.println("[IMU] Calibration done ✓");
    _yawOffset = 0.0f;
    return true;
  }

  // ── Update (call every loop tick) ────────────────────────
  void update() {
    _mpu.update();

    pitch  = _mpu.getAngleX();
    roll   = _mpu.getAngleY();
    yaw    = _mpu.getAngleZ() - _yawOffset;

    accelX = _mpu.getAccX();
    accelY = _mpu.getAccY();
    accelZ = _mpu.getAccZ();

    gyroX  = _mpu.getGyroX();
    gyroY  = _mpu.getGyroY();
    gyroZ  = _mpu.getGyroZ();
  }

  // ── Reset yaw to zero ────────────────────────────────────
  void resetYaw() {
    _yawOffset = _mpu.getAngleZ();
    yaw = 0.0f;
  }

private:
  MPU6050 _mpu   = MPU6050(Wire);
  float _yawOffset = 0.0f;
};
