const express = require("express");
const Reminder = require("../models/Reminder");
const { parseReminderTextToRule, nextDateForRule } = require("../services/reminderUtils");
const { getClients } = require("../websocket");
const { SERVER_ERROR } = require("../../utils/constants");

const reminderRouter = express.Router();

function deriveReminderVisualKey(title = "", category = "custom") {
  const lower = String(title || "").toLowerCase();
  if (category === "medication" || /\b(med|medicine|pill|tablet|capsule)\b/.test(lower)) return "pill";
  if (/\bdoctor|appointment|clinic|hospital\b/.test(lower)) return "doctor";
  if (/\bcardio|walk|run|exercise|workout|gym\b/.test(lower)) return "activity";
  if (/\bwater|hydrate|hydration\b/.test(lower)) return "hydration";
  if (/\bsleep|bed|nap\b/.test(lower)) return "sleep";
  return "bell";
}

function normalizeRule(inputRule = {}, now = new Date()) {
  const parsed = parseReminderTextToRule(inputRule.recurrenceText || "", now);
  const merged = {
    ...parsed,
    ...inputRule,
    startAt: inputRule.startAt ? new Date(inputRule.startAt) : parsed.startAt,
  };
  if (!Array.isArray(merged.daysOfWeek)) merged.daysOfWeek = [];
  return merged;
}

reminderRouter.post("/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const {
      title,
      category = "custom",
      source = "app",
      recurrenceText = "",
      schedule = {},
      payload = {},
      delivery = {},
    } = req.body || {};

    if (!title || String(title).trim().length === 0) {
      return res.status(400).json({ message: "title is required" });
    }

    const now = new Date();
    const rawRule = schedule?.rules?.[0] || { recurrenceText };
    const rule = normalizeRule(rawRule, now);
    const nextTriggerAt = nextDateForRule(rule, now);

    const reminder = await Reminder.create({
      username,
      title: String(title).trim(),
      category,
      source,
      schedule: {
        timezone: schedule?.timezone || "America/New_York",
        rules: [rule],
      },
      payload,
      delivery: {
        popup: delivery.popup !== false,
        alexaVoice: delivery.alexaVoice !== false,
      },
      nextTriggerAt,
    });
    reminder.payload = {
      ...reminder.payload,
      visualKey: reminder.payload?.visualKey || deriveReminderVisualKey(reminder.title, reminder.category),
    };
    await reminder.save();

    return res.status(201).json(reminder);
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

// Opens the reminder creation workflow on the main app UI.
reminderRouter.post("/:username/open-create", (req, res) => {
  const { username } = req.params;
  try {
    const clients = getClients();
    const clientSocket = clients.get(username);
    if (!clientSocket) {
      return res.status(404).json({
        message: `No active UI session found for ${username}`,
      });
    }

    clientSocket.send(JSON.stringify({
      action: "navigation",
      option: "/reminder?mode=create",
    }));

    return res.status(200).json({
      message: "Reminder create workflow opened",
      route: "/reminder?mode=create",
    });
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

reminderRouter.get("/:username", async (req, res) => {
  const { username } = req.params;
  const categoryQuery = String(req.query.category || "").trim().toLowerCase();
  try {
    const findQuery = {
      username,
      status: { $ne: "archived" },
    };

    if (categoryQuery) {
      findQuery.category = categoryQuery;
    }

    const reminders = await Reminder.find(findQuery).sort({ nextTriggerAt: 1 });
    return res.status(200).json(reminders);
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

async function acknowledgeReminder({ username, reminderId, action = "done", snoozeMinutes = 10 }) {
  const reminder = await Reminder.findOne({ _id: reminderId, username });
  if (!reminder) {
    return { status: 404, body: { message: "Reminder not found" } };
  }

  const now = new Date();
  reminder.adherence.push({
    dueAt: reminder.currentDueAt || now,
    action,
    actedAt: now,
  });
  reminder.retryPending = false;
  reminder.retryAt = null;

  if (action === "snoozed") {
    reminder.nextTriggerAt = new Date(now.getTime() + Math.max(1, Number(snoozeMinutes)) * 60 * 1000);
  }

  await reminder.save();
  return { status: 200, body: { message: "Reminder updated", reminder } };
}

reminderRouter.patch("/:username/:reminderId", async (req, res) => {
  const { username, reminderId } = req.params;
  try {
    const reminder = await Reminder.findOne({ _id: reminderId, username });
    if (!reminder) {
      return res.status(404).json({ message: "Reminder not found" });
    }

    const {
      title,
      status,
      schedule,
      payload,
      delivery,
    } = req.body || {};

    if (title != null) reminder.title = String(title);
    if (status != null) reminder.status = status;
    if (payload != null) reminder.payload = { ...reminder.payload, ...payload };
    if (delivery != null) reminder.delivery = { ...reminder.delivery, ...delivery };
    if (schedule?.rules?.[0]) {
      const rule = normalizeRule(schedule.rules[0], new Date());
      reminder.schedule = {
        timezone: schedule?.timezone || reminder.schedule?.timezone || "America/New_York",
        rules: [rule],
      };
      reminder.nextTriggerAt = nextDateForRule(rule, new Date());
    }

    await reminder.save();
    return res.status(200).json(reminder);
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

reminderRouter.delete("/:username/:reminderId", async (req, res) => {
  const { username, reminderId } = req.params;
  try {
    const reminder = await Reminder.findOne({ _id: reminderId, username });
    if (!reminder) {
      return res.status(404).json({ message: "Reminder not found" });
    }
    reminder.status = "archived";
    await reminder.save();
    return res.status(200).json({ message: "Reminder archived" });
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

reminderRouter.post("/:username/:reminderId/ack", async (req, res) => {
  const { username, reminderId } = req.params;
  const { action = "done", snoozeMinutes = 10 } = req.body || {};
  try {
    const result = await acknowledgeReminder({ username, reminderId, action, snoozeMinutes });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

reminderRouter.post("/:username/:reminderId/markTaken", async (req, res) => {
  const { username, reminderId } = req.params;
  try {
    const result = await acknowledgeReminder({ username, reminderId, action: "taken" });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

reminderRouter.post("/:username/:reminderId/complete", async (req, res) => {
  const { username, reminderId } = req.params;
  try {
    const result = await acknowledgeReminder({ username, reminderId, action: "done" });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

reminderRouter.post("/:username/:reminderId/snooze", async (req, res) => {
  const { username, reminderId } = req.params;
  const { snoozeMinutes = 10 } = req.body || {};
  try {
    const result = await acknowledgeReminder({ username, reminderId, action: "snoozed", snoozeMinutes });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

module.exports = reminderRouter;
