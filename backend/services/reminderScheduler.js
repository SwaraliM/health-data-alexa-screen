const Reminder = require("../models/Reminder");
const Medication = require("../models/Medications");
const NudgeEvent = require("../models/NudgeEvent");
const User = require("../models/Users");
const { getClients } = require("../websocket");
const { nextDateForRule } = require("./reminderUtils");

let schedulerTimer = null;
let nudgeTimer = null;

function inQuietHours(now = new Date()) {
  const hours = now.getHours();
  return hours >= 21 || hours < 7;
}

async function dispatchReminder(reminder, retry = false) {
  const clients = getClients();
  const clientSocket = clients.get(reminder.username);
  if (!clientSocket) return;

  let medication = null;
  if (reminder.payload?.medicationId) {
    medication = await Medication.findById(reminder.payload.medicationId);
  }

  const dueAt = reminder.currentDueAt || new Date();
  const title = reminder.title || (medication ? `Take ${medication.name}` : "Reminder");
  const voicePrompt = reminder.payload?.voicePromptTemplate
    || (medication
      ? `It's time to take your ${medication.name}.`
      : `Reminder: ${title}`);

  clientSocket.send(JSON.stringify({
    action: "reminderDue",
    reminderId: String(reminder._id),
    category: reminder.category,
    title,
    dueTime: dueAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    medication: medication ? {
      id: medication._id,
      name: medication.name,
      dosage: medication.dosage,
      form: medication.form,
      instructions: medication.instructions,
    } : null,
    pillVisual: medication ? medication.pillVisual : null,
    visualKey: reminder.payload?.visualKey || (medication ? "pill" : "bell"),
    retry,
    voicePrompt,
    cta: retry ? "Follow-up reminder" : "Reminder",
  }));
}

async function processDueReminders() {
  const now = new Date();
  const dueReminders = await Reminder.find({
    status: "active",
    nextTriggerAt: { $ne: null, $lte: now },
  }).limit(20);

  for (const reminder of dueReminders) {
    const rule = reminder.schedule?.rules?.find((r) => r.active) || reminder.schedule?.rules?.[0];
    if (!rule) continue;

    const dueAt = new Date();
    reminder.lastTriggeredAt = dueAt;
    reminder.currentDueAt = dueAt;
    reminder.adherence.push({ dueAt, action: "due", actedAt: dueAt });

    await dispatchReminder(reminder, false);

    if (reminder.category === "medication") {
      reminder.retryPending = true;
      reminder.retryAt = new Date(dueAt.getTime() + 15 * 60 * 1000);
    } else {
      reminder.retryPending = false;
      reminder.retryAt = null;
    }

    reminder.nextTriggerAt = nextDateForRule(rule, dueAt);
    await reminder.save();
  }
}

async function processRetries() {
  const now = new Date();
  const retryCandidates = await Reminder.find({
    status: "active",
    category: "medication",
    retryPending: true,
    retryAt: { $ne: null, $lte: now },
  }).limit(20);

  for (const reminder of retryCandidates) {
    await dispatchReminder(reminder, true);
    reminder.adherence.push({
      dueAt: reminder.currentDueAt || now,
      action: "missed",
      actedAt: now,
    });
    reminder.retryPending = false;
    reminder.retryAt = null;
    await reminder.save();
  }
}

async function maybeSendGentleNudges() {
  if (inQuietHours()) return;

  const clients = getClients();
  const usernames = [...clients.keys()];
  if (usernames.length === 0) return;

  const now = new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  for (const username of usernames) {
    const sentToday = await NudgeEvent.countDocuments({
      username,
      sentAt: { $gte: windowStart },
    });
    if (sentToday >= 2) {
      await NudgeEvent.create({
        username,
        nudgeType: "activity",
        reason: "Suppressed due to max daily nudge cap",
        suppressedReason: "daily_limit",
      });
      continue;
    }

    const clientSocket = clients.get(username);
    if (!clientSocket) continue;

    const user = await User.findOne({ username });
    const stepGoal = user?.userProfile?.preferences?.dailyStepGoal || 10000;
    const suggestion = `Try a quick 10 minute walk to move toward your ${stepGoal.toLocaleString()} step goal.`;

    clientSocket.send(JSON.stringify({
      action: "nudge",
      suggestion: "Gentle activity nudge",
      details: suggestion,
      voicePrompt: suggestion,
      promptMood: true,
      category: "activity",
    }));

    await NudgeEvent.create({
      username,
      nudgeType: "activity",
      reason: "Gentle JIT movement prompt",
      fitbitSnapshot: { dailyStepGoal: stepGoal },
      sentAt: now,
      response: "none",
    });
  }
}

function startReminderScheduler() {
  const runCycle = async () => {
    try {
      await processDueReminders();
      await processRetries();
    } catch (err) {
      console.error("Reminder scheduler error:", err.message);
    }
  };

  if (!schedulerTimer) {
    runCycle();
    schedulerTimer = setInterval(runCycle, 30 * 1000);
  }

  if (!nudgeTimer) {
    nudgeTimer = setInterval(async () => {
      try {
        await maybeSendGentleNudges();
      } catch (err) {
        console.error("Nudge scheduler error:", err.message);
      }
    }, 60 * 60 * 1000);
  }
}

module.exports = {
  startReminderScheduler,
};
