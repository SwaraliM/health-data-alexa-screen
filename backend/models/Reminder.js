const mongoose = require("mongoose");

const scheduleRuleSchema = new mongoose.Schema({
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
}, { _id: false });

const reminderSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    enum: ["medication", "activity", "task", "hydration", "sleep", "custom"],
    default: "custom",
  },
  source: {
    type: String,
    enum: ["alexa", "app", "system"],
    default: "app",
  },
  status: {
    type: String,
    enum: ["active", "paused", "archived"],
    default: "active",
    index: true,
  },
  schedule: {
    timezone: {
      type: String,
      default: "America/New_York",
    },
    rules: {
      type: [scheduleRuleSchema],
      default: [],
    },
  },
  payload: {
    suggestion: {
      type: String,
      default: "",
    },
    targetMetric: {
      type: String,
      default: "",
    },
    medicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Medication",
      default: null,
    },
    voicePromptTemplate: {
      type: String,
      default: "",
    },
  },
  delivery: {
    popup: {
      type: Boolean,
      default: true,
    },
    alexaVoice: {
      type: Boolean,
      default: true,
    },
  },
  lastTriggeredAt: {
    type: Date,
    default: null,
  },
  nextTriggerAt: {
    type: Date,
    default: null,
    index: true,
  },
  retryPending: {
    type: Boolean,
    default: false,
  },
  retryAt: {
    type: Date,
    default: null,
  },
  currentDueAt: {
    type: Date,
    default: null,
  },
  adherence: [{
    dueAt: {
      type: Date,
      required: true,
    },
    action: {
      type: String,
      enum: ["due", "taken", "snoozed", "missed", "done"],
      required: true,
    },
    actedAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, { timestamps: true });

reminderSchema.index({ username: 1, status: 1, nextTriggerAt: 1 });

const Reminder = mongoose.model("Reminder", reminderSchema);
module.exports = Reminder;
