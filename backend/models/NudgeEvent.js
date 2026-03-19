const mongoose = require("mongoose");

const nudgeEventSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    index: true,
  },
  nudgeType: {
    type: String,
    enum: ["activity", "sleep", "medication", "hydration", "custom"],
    default: "custom",
  },
  reason: {
    type: String,
    required: true,
  },
  fitbitSnapshot: {
    type: Object,
    default: {},
  },
  sentAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  response: {
    type: String,
    enum: ["accepted", "dismissed", "snoozed", "none"],
    default: "none",
  },
  suppressedReason: {
    type: String,
    default: "",
  },
});

const NudgeEvent = mongoose.model("NudgeEvent", nudgeEventSchema);
module.exports = NudgeEvent;
