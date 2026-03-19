const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true, 
  },
  password: {
    type: String,
    required: true,
  },
  isAuthorized: {
    type: Boolean,
    default: false,
  },
  accessToken: {
    type: String,
    required: false,
  },
  refreshToken: {
    type: String,
    required: false,
  },
  tokenExpiry: {
    type: String,
    required: false,
  },
  // User Profile for personalization
  userProfile: {
    age: {
      type: Number,
      required: false,
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other', 'prefer_not_to_say'],
      required: false,
    },
    fitnessLevel: {
      type: String,
      enum: ['sedentary', 'lightly_active', 'moderately_active', 'very_active', 'athlete'],
      default: 'moderately_active',
    },
    healthGoals: {
      type: [String],
      default: [],
      // Examples: 'weight_loss', 'muscle_gain', 'improve_cardio', 'better_sleep', 'stress_reduction'
    },
    healthConditions: {
      type: [String],
      default: [],
      // Examples: 'diabetes', 'hypertension', 'heart_disease', 'asthma', 'none'
    },
    preferences: {
      preferredExercise: {
        type: [String],
        default: [],
        // Examples: 'running', 'swimming', 'cycling', 'walking', 'weightlifting', 'yoga'
      },
      sleepGoalMinutes: {
        type: Number,
        default: 480,  // 8 hours
      },
      dailyStepGoal: {
        type: Number,
        default: 10000,
      },
      dailyCalorieGoal: {
        type: Number,
        required: false,
      },
    },
    // Mood check-in tracking (once daily)
    moodCheckIns: [{
      date: {
        type: String, // YYYY-MM-DD format
        required: true,
      },
      mood: {
        type: String,
        enum: ['Good', 'Okay', 'Low'],
        required: true,
      },
      timestamp: {
        type: Date,
        default: Date.now,
      },
    }],
  },
});

const User = mongoose.model('User', userSchema);

module.exports = User;
