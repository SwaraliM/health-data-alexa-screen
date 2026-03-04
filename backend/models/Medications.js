const mongoose = require("mongoose");

const medicationSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  dosage: {
    type: String,
    required: true,
  },
  form: {
    type: String,
    enum: ["tablet", "capsule", "syrup", "injection", "other"],
    required: true,
  },
  instructions: {
    type: String,
    required: true,
  },
  sideEffects: {
    type: [String],
    default: [],
  },
  note: {
    type: String,
    default: "",
  },
  schedule: {
    timezone: {
      type: String,
      default: "America/New_York",
    },
    rules: [{
      type: {
        type: String,
        enum: ["once", "daily", "weekdays", "weekly", "monthly", "interval"],
        default: "daily",
      },
      startAt: {
        type: Date,
        default: Date.now,
      },
      timeOfDay: {
        type: String,
        default: "08:00",
      },
      daysOfWeek: {
        type: [Number],
        default: [],
      },
      dayOfMonth: {
        type: Number,
        default: null,
      },
      intervalDays: {
        type: Number,
        default: null,
      },
      active: {
        type: Boolean,
        default: true,
      },
    }],
    defaultDueWindowMin: {
      type: Number,
      default: 30,
    },
  },
  pillVisual: {
    iconKey: {
      type: String,
      enum: ["tablet", "capsule", "syrup", "injection", "other"],
      default: "tablet",
    },
    accentColor: {
      type: String,
      default: "#3b82f6",
    },
  },
  // Medication confirmation tracking
  confirmations: [{
    date: {
      type: String, // YYYY-MM-DD format
      required: true,
    },
    taken: {
      type: Boolean,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  }],
});

const Medication = mongoose.model("Medication", medicationSchema);

module.exports = Medication;
