const { SERVER_ERROR } = require('../../utils/constants');
const Medication = require('../models/Medications');
const Reminder = require('../models/Reminder');
const User = require('../models/Users');
const { getClients } = require('../websocket');
const { getCurrentDate } = require('../../frontend/src/utils/getCurrentDate');
const { parseReminderTextToRule, nextDateForRule } = require("../services/reminderUtils");
const express = require("express");
const medicationRouter = express.Router();

medicationRouter.get("/all/:username", async (req, res) => {
    const { username } = req.params;

    try {
      const medications = await Medication.find({ username: username });

      res.status(200).json(medications); 
    } catch (error) {
      res.status(500).json({ error: SERVER_ERROR, details: error });
    }
});

medicationRouter.post("/:username/schedule/:medicationId", async (req, res) => {
  const { username, medicationId } = req.params;
  const { recurrenceText = "every day at 8 AM", timezone = "America/New_York" } = req.body || {};

  try {
    const medication = await Medication.findById(medicationId);
    if (!medication) {
      return res.status(404).json({ message: "Medication not found" });
    }
    if (medication.username !== username) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    const rule = parseReminderTextToRule(recurrenceText, new Date());
    medication.schedule = {
      timezone,
      rules: [rule],
      defaultDueWindowMin: 30,
    };
    medication.pillVisual = {
      iconKey: medication.form || "tablet",
      accentColor: medication.pillVisual?.accentColor || "#3b82f6",
    };
    await medication.save();

    const nextTriggerAt = nextDateForRule(rule, new Date());
    const reminder = await Reminder.findOneAndUpdate(
      { username, "payload.medicationId": medication._id, status: { $ne: "archived" } },
      {
        username,
        title: `Take ${medication.name}`,
        category: "medication",
        source: "app",
        schedule: {
          timezone,
          rules: [rule],
        },
        payload: {
          medicationId: medication._id,
          voicePromptTemplate: `It's time to take your ${medication.name}. ${medication.instructions}`,
        },
        delivery: {
          popup: true,
          alexaVoice: true,
        },
        nextTriggerAt,
        status: "active",
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return res.status(200).json({
      message: "Medication schedule saved",
      medication,
      reminder,
    });
  } catch (error) {
    console.error("Error saving medication schedule:", error);
    res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

medicationRouter.get("/:username/schedule", async (req, res) => {
  const { username } = req.params;
  try {
    const reminders = await Reminder.find({
      username,
      category: "medication",
      status: { $ne: "archived" },
    }).sort({ nextTriggerAt: 1 });
    return res.status(200).json(reminders);
  } catch (error) {
    res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

// Manual demo trigger: Medication reminder
medicationRouter.post("/reminder/:username", async (req, res) => {
  const { username } = req.params;

  try {
    const medications = await Medication.find({ username: username });
    
    if (medications.length === 0) {
      return res.status(404).json({ message: 'No medications found for this user' });
    }

    // Get first medication for demo (or could be specified in body)
    const medication = medications[0];
    const clients = getClients();
    const clientSocket = clients.get(username);

    if (clientSocket) {
      const reminderMessage = {
        action: "reminder",
        medication: {
          id: medication._id,
          name: medication.name,
          dosage: medication.dosage,
          form: medication.form,
          instructions: medication.instructions,
        },
        voicePrompt: `It's time to take your ${medication.name}. ${medication.instructions}`,
      };

      clientSocket.send(JSON.stringify(reminderMessage));
      console.log(`Sent medication reminder to ${username}`);
      
      return res.status(200).json({ 
        message: "Reminder sent",
        medication: medication.name,
        voicePrompt: reminderMessage.voicePrompt
      });
    } else {
      return res.status(404).json({ message: 'User not connected via WebSocket' });
    }
  } catch (error) {
    console.error("Error sending medication reminder:", error);
    res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

// Confirm medication taken
medicationRouter.post("/confirm/:medicationId", async (req, res) => {
  const { medicationId } = req.params;
  const { username, taken } = req.body; // taken: true/false

  try {
    const medication = await Medication.findById(medicationId);
    
    if (!medication) {
      return res.status(404).json({ message: 'Medication not found' });
    }

    if (medication.username !== username) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const today = getCurrentDate();
    const now = new Date();
    
    // Add confirmation
    medication.confirmations.push({
      date: today,
      taken: taken === true,
      timestamp: now,
    });

    await medication.save();

    await Reminder.updateMany(
      {
        username,
        "payload.medicationId": medication._id,
        status: { $ne: "archived" },
      },
      {
        $set: {
          retryPending: false,
          retryAt: null,
        },
        $push: {
          adherence: {
            dueAt: now,
            action: taken === true ? "taken" : "snoozed",
            actedAt: now,
          },
        },
      },
    );

    return res.status(200).json({ 
      message: taken ? "Medication confirmed as taken" : "Reminder scheduled for later",
      confirmation: {
        date: today,
        taken: taken,
        timestamp: new Date(),
      }
    });
  } catch (error) {
    console.error("Error confirming medication:", error);
    res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

// Manual demo trigger: Exercise nudge
medicationRouter.post("/nudge/:username", async (req, res) => {
  const { username } = req.params;

  try {
    const user = await User.findOne({ username: username });
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const clients = getClients();
    const clientSocket = clients.get(username);

    if (clientSocket) {
      // Simple nudge message (could be enhanced with actual activity data)
      const nudgeMessage = {
        action: "nudge",
        suggestion: "Light cardio + hydration focus",
        details: "A 20-30 minute walk would help you reach your daily goal.",
        voicePrompt: "Consider light cardio today. A 20 to 30 minute walk would help you reach your daily goal.",
        promptMood: true, // Flag to prompt mood check-in
      };

      clientSocket.send(JSON.stringify(nudgeMessage));
      console.log(`Sent exercise nudge to ${username}`);
      
      return res.status(200).json({ 
        message: "Nudge sent",
        suggestion: nudgeMessage.suggestion,
        voicePrompt: nudgeMessage.voicePrompt
      });
    } else {
      return res.status(404).json({ message: 'User not connected via WebSocket' });
    }
  } catch (error) {
    console.error("Error sending exercise nudge:", error);
    res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

// Mood check-in (once daily)
medicationRouter.post("/mood/:username", async (req, res) => {
  const { username } = req.params;
  const { mood } = req.body; // mood: 'Good' | 'Okay' | 'Low'

  try {
    if (!['Good', 'Okay', 'Low'].includes(mood)) {
      return res.status(400).json({ message: 'Invalid mood value. Must be Good, Okay, or Low' });
    }

    const user = await User.findOne({ username: username });
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const today = getCurrentDate();
    
    // Check if mood already recorded today
    const existingMood = user.userProfile.moodCheckIns.find(
      (checkIn) => checkIn.date === today
    );

    if (existingMood) {
      // Update existing mood
      existingMood.mood = mood;
      existingMood.timestamp = new Date();
    } else {
      // Add new mood check-in
      user.userProfile.moodCheckIns.push({
        date: today,
        mood: mood,
        timestamp: new Date(),
      });
    }

    await user.save();

    return res.status(200).json({ 
      message: "Mood check-in recorded",
      mood: mood,
      date: today,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Error recording mood check-in:", error);
    res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});
  
module.exports = medicationRouter;
