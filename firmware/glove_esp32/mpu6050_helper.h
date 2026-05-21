// =============================================================
// mpu6050_helper.h — MPU6050 wrapper using TinyMPU6050 lib
// Install: Arduino Library Manager → search "TinyMPU6050"
//          Author: Gabriel Milan
// I2C pins: SDA=8, SCL=9  (set in main sketch via Wire.begin)
// =============================================================
#pragma once

#include <Wire.h>
#include <TinyMPU6050.h>

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
    Serial.println("[IMU] Initializing TinyMPU6050...");
    _mpu.Initialize();
    
    Serial.println("[IMU] MPU6050 found ✓");
    Serial.println("[IMU] Calibrating — keep glove STILL for 3s...");
    delay(1000);   // settle time
    _mpu.Calibrate();   // auto-calibrate accel + gyro offsets

    Serial.println("[IMU] Calibration done ✓");
    _yawOffset = 0.0f;
    return true;
  }

  // ── Update (call every loop tick) ────────────────────────
  void update() {
    _mpu.Execute();

    pitch  = _mpu.GetAngX();
    roll   = _mpu.GetAngY();
    yaw    = _mpu.GetAngZ() - _yawOffset;

    accelX = _mpu.GetAccX();
    accelY = _mpu.GetAccY();
    accelZ = _mpu.GetAccZ();

    gyroX  = _mpu.GetGyroX();
    gyroY  = _mpu.GetGyroY();
    gyroZ  = _mpu.GetGyroZ();
  }

  // ── Reset yaw to zero ────────────────────────────────────
  void resetYaw() {
    _yawOffset = _mpu.GetAngZ();
    yaw = 0.0f;
  }

private:
  MPU6050 _mpu   = MPU6050(Wire);
  float _yawOffset = 0.0f;
};
