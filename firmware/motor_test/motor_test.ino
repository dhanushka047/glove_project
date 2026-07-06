// =============================================================
// motor_test.ino — MOSFET Motor Test Firmware (3s Cycle)
// Hardware: ESP32-S3
//   MOSFET control pin: GPIO 6
//   OLED I2C:           SDA=GPIO17, SCL=GPIO18
// =============================================================

#include <Arduino.h>
#include <Wire.h>

// Uncomment the display driver in use
#define USE_SH110X      // For 1.3" OLEDs
//#define USE_SSD1306   // For 0.96" OLEDs

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define I2C_ADDRESS 0x3C

#ifdef USE_SH110X
#include <Adafruit_SH110X.h>
#endif

#ifdef USE_SSD1306
#include <Adafruit_SSD1306.h>
#endif

// ═══════════════════════════════════════════════════════════════
// ▶  Pin & MOSFET Logic Configuration
// ═══════════════════════════════════════════════════════════════
#define PIN_MOTOR        6    // Gate connected to GPIO 6

// MOSFET Logic configuration:
// - P-Channel MOSFETs are active-LOW: LOW turns it ON, HIGH turns it OFF.
// - Set MOTOR_ACTIVE_LOW to true for P-Channel.
// - Set MOTOR_ACTIVE_LOW to false for standard N-Channel (HIGH = ON, LOW = OFF).
#define MOTOR_ACTIVE_LOW  true 

#define PIN_SDA          17   // I2C SDA
#define PIN_SCL          18   // I2C SCL

// ═══════════════════════════════════════════════════════════════
// ▶  Globals
// ═══════════════════════════════════════════════════════════════
#ifdef USE_SH110X
#define OLED_WHITE SH110X_WHITE
#define OLED_BLACK SH110X_BLACK
Adafruit_SH1106G display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
#endif

#ifdef USE_SSD1306
#define OLED_WHITE SSD1306_WHITE
#define OLED_BLACK SSD1306_BLACK
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
#endif

bool motorOn = false;
unsigned long lastSwitchTime = 0;
const unsigned long intervalMs = 3000; // 3 seconds (3000ms)

// ═══════════════════════════════════════════════════════════════
// ▶  OLED Rendering
// ═══════════════════════════════════════════════════════════════
void updateOLED() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(OLED_WHITE);
  
  // Header
  display.setCursor(16, 4);
  display.print("MOTOR CYCLER TEST");
  display.drawFastHLine(0, 14, SCREEN_WIDTH, OLED_WHITE);

  // Status
  display.setCursor(4, 24);
  display.print("Motor State: ");
  if (motorOn) {
    display.print("RUNNING");
  } else {
    display.print("STOPPED");
  }

  // Speed / Drive level
  display.setCursor(4, 38);
  display.print("Pin Output:  ");
  if (MOTOR_ACTIVE_LOW) {
    display.print(motorOn ? "LOW (ON)" : "HIGH (OFF)");
  } else {
    display.print(motorOn ? "HIGH (ON)" : "LOW (OFF)");
  }

  // Visual Speed Bar
  display.drawRect(4, 52, 120, 8, OLED_WHITE);
  if (motorOn) {
    display.fillRect(6, 54, 116, 4, OLED_WHITE);
  }

  display.display();
}

// Helper to write to motor pin based on MOSFET type logic
void setMotorState(bool turnOn) {
  motorOn = turnOn;
  if (MOTOR_ACTIVE_LOW) {
    // P-Channel: LOW gate voltage turns it ON
    digitalWrite(PIN_MOTOR, turnOn ? LOW : HIGH);
  } else {
    // N-Channel: HIGH gate voltage turns it ON
    digitalWrite(PIN_MOTOR, turnOn ? HIGH : LOW);
  }
}

// ═══════════════════════════════════════════════════════════════
// ▶  setup()
// ═══════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("=========================================");
  Serial.println("   ESP32-S3 MOSFET Motor 3s Cycle Test   ");
  Serial.println("=========================================");
  Serial.printf( "MOSFET Pin : GPIO %d\n", PIN_MOTOR);
  Serial.printf( "MOSFET Type: %s (%s)\n", 
                 MOTOR_ACTIVE_LOW ? "P-CH" : "N-CH",
                 MOTOR_ACTIVE_LOW ? "Active-LOW / P-Channel" : "Active-HIGH / N-Channel");
  Serial.println("OLED SDA   : GPIO 17");
  Serial.println("OLED SCL   : GPIO 18");
  Serial.println("Cycle      : 3s ON / 3s OFF repeating");
  Serial.println("=========================================");

  // Configure Motor Pin
  pinMode(PIN_MOTOR, OUTPUT);
  setMotorState(false); // Start with motor off

  // Initialize I2C and display
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);

  #ifdef USE_SH110X
  display.begin(I2C_ADDRESS, true);
  #endif
  #ifdef USE_SSD1306
  display.begin(SSD1306_SWITCHCAPVCC, I2C_ADDRESS);
  #endif

  display.clearDisplay();
  display.display();

  // Print first state and render
  Serial.printf("[MOTOR] OFF (%s) - 3 seconds start\n", MOTOR_ACTIVE_LOW ? "Pin HIGH" : "Pin LOW");
  lastSwitchTime = millis();
  updateOLED();
}

// ═══════════════════════════════════════════════════════════════
// ▶  loop()
// ═══════════════════════════════════════════════════════════════
void loop() {
  unsigned long now = millis();
  
  if (now - lastSwitchTime >= intervalMs) {
    lastSwitchTime = now;
    bool nextState = !motorOn;
    setMotorState(nextState);

    if (motorOn) {
      Serial.printf("[MOTOR] ON (%s) - 3 seconds start\n", MOTOR_ACTIVE_LOW ? "Pin LOW" : "Pin HIGH");
    } else {
      Serial.printf("[MOTOR] OFF (%s) - 3 seconds start\n", MOTOR_ACTIVE_LOW ? "Pin HIGH" : "Pin LOW");
    }

    updateOLED();
  }
}
