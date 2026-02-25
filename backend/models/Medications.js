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
