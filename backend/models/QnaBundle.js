/**
 * backend/models/QnaBundle.js
 *
 * Phase 1 persistence model for lightweight QnA bundle memory.
 * This intentionally keeps several fields flexible (Mixed) because
 * planner/executor payload formats will evolve during migration.
 */

const mongoose = require("mongoose");

const BUNDLE_STATUSES = [
  "active",
  "partial",
  "ready",
  "completed",
  "archived",
  "released",
  "failed",
];

const qnaBundleSchema = new mongoose.Schema(
  {
    // Public bundle identifier used by orchestrator/services.
    bundleId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Username/session owner of this bundle.
    username: {
      type: String,
      required: true,
      index: true,
    },

    // Bundle lifecycle state.
    status: {
      type: String,
      enum: BUNDLE_STATUSES,
      default: "active",
      index: true,
    },

    // Original user question that created the bundle.
    question: {
      type: String,
      default: "",
    },

    // Optional lineage link when bundle is branched from another bundle.
    parentBundleId: {
      type: String,
      default: null,
      index: true,
    },

    // Planner JSON output (kept flexible for phased migration).
    plannerOutput: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Metric keys resolved/requested for Fitbit fetching.
    metricsRequested: {
      type: [String],
      default: [],
    },

    // Raw Fitbit payload cache keyed by metric or endpoint.
    rawFitbitCache: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Lightweight aligned table prepared for downstream GPT usage.
    normalizedTable: {
      type: mongoose.Schema.Types.Mixed,
      default: [],
    },

    // Stages emitted by future executor flow.
    stages: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },

    // Responses API previous_response_id hook for next stage continuation.
    executorResponseId: {
      type: String,
      default: null,
    },

    // Pointer to current stage for progressive reveal.
    currentStageIndex: {
      type: Number,
      default: 0,
    },

    // Optional completion marker (set when moved to completed).
    completedAt: {
      type: Date,
      default: null,
    },

    // Optional archive marker for explicit lifecycle policy.
    archivedAt: {
      type: Date,
      default: null,
    },

    // Optional release marker for reusable-bundle lifecycle.
    releasedAt: {
      type: Date,
      default: null,
    },

    // Optional lineage metadata for branch/new transitions.
    lineage: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    // createdAt + updatedAt are required for active bundle recency lookup.
    timestamps: true,
  }
);

// Explicit indexes for Phase 1 query patterns and future migration safety.
qnaBundleSchema.index({ bundleId: 1 });
qnaBundleSchema.index({ username: 1 });
qnaBundleSchema.index({ status: 1 });
qnaBundleSchema.index({ updatedAt: -1 });
qnaBundleSchema.index({ username: 1, status: 1, updatedAt: -1 });

qnaBundleSchema.statics.BUNDLE_STATUSES = BUNDLE_STATUSES;

const QnaBundle = mongoose.model("QnaBundle", qnaBundleSchema);

module.exports = QnaBundle;
