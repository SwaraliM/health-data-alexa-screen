const express = require("express");
const fitbitRouter = express.Router();
const User = require("../models/Users");
const { USER_NOT_FOUNT, SERVER_ERROR, TOKEN_INVALID } = require("../../utils/constants");


/*************************Activity********************************/
/**
 * Get Daily Activity Summary
 * Retrieves a summary and list of a user’s activities and activity log entries for a given day.
 * Scope: activity
 * GET	/1/user/[user-id]/activities/date/[date].json
*/
fitbitRouter.get("/:username/activities/summary/:date", async (req, res) => {
  const { username } = req.params;
  const { date } = req.params;

  try {
    // searching access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: USER_NOT_FOUNT });
    }

    const accessToken = user.accessToken;

    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities/date/${date}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error(error);
    if (error.response && error.response.status === 401) {
      return res
        .status(401)
        .json({ message: TOKEN_INVALID });
    }

    res.status(500).json({ message: SERVER_ERROR });
  }
});

/**
 * Get Activity Goals
 * Retrieves a user's current daily or weekly activity goals.
*/
fitbitRouter.get("/:username/activities/goals/:period", async (req, res) => {
  const { username } = req.params;
  const { period } = req.params;

  // Validate period parameter
  const validPeriods = ["daily", "weekly"];
  if (!validPeriods.includes(period)) {
    return res.status(400).json({ message: "Invalid period. Supported values are daily or weekly." });
  }

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get activity goals data
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities/goals/${period}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error(error);
    if (error.response && error.response.status === 401) {
      return res.status(401).json({ message: "Token is invalid." });
    }

    res.status(500).json({ message: "Server error." });
  }
});

/**
 * Get Favorite Activities
 * Retrieves a list of a user's favorite activities.
*/
fitbitRouter.get("/:username/activities/favorite", async (req, res) => {
  const { username } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;


    // Call Fitbit API to get favorite activities
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities/favorite.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error(error);
    if (error.response && error.response.status === 401) {
      return res.status(401).json({ message: "Token is invalid." });
    }

    res.status(500).json({ message: "Server error." });
  }
});


/**
 * Get Frequent Activities
 * Retrieves a list of a user's frequent activities.
 * Scope: activity
*/
fitbitRouter.get("/:username/activities/frequent", async (req, res) => {
  const { username } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get frequent activities
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities/frequent.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});


/**
 * Get Lifetime Stats
 * Retrieves the user's activity statistics.
 * Scope: activity
*/
fitbitRouter.get("/:username/activities/life-time", async (req, res) => {
  const { username } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get all activities
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

/**
 * Get Recent Activity Types
 * Retrieves a list of a user's recent activities types logged with some details of the last activity log of that type.
 * Scope: activity
*/
fitbitRouter.get("/:username/activities/recent", async (req, res) => {
  const { username } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get recent activities
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities/recent.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

/**
 * Get Activity Time Series by Date
 * Retrieves the activity data for a given resource over a period of time by specifying a date and time period. The response will include only the daily summary values.
 * Scope: activity
 * date	required	The end date of the period specified in the format yyyy-MM-dd or today.
*/
fitbitRouter.get("/:username/activities/period/:resource/date/:date/:period", async (req, res) => {
  const { username, resource, date, period } = req.params;

  // Validate resource parameter
  const validResources = [
    "activityCalories", 
    "calories", 
    "caloriesBMR", 
    "distance", 
    "elevation", 
    "floors", 
    "minutesSedentary", 
    "minutesLightlyActive", 
    "minutesFairlyActive", 
    "minutesVeryActive", 
    "steps", 
    "swimming-strokes", 
    "tracker/activityCalories", 
    "tracker/calories", 
    "tracker/distance", 
    "tracker/elevation", 
    "tracker/floors", 
    "tracker/minutesSedentary", 
    "tracker/minutesLightlyActive", 
    "tracker/minutesFairlyActive", 
    "tracker/minutesVeryActive", 
    "tracker/steps"
  ];

  if (!validResources.includes(resource)) {
    return res.status(400).json({ message: "Invalid resource. Supported values are: " + validResources.join(", ") });
  }

  // Validate period parameter
  const validPeriods = ["1d", "7d", "30d", "1w", "1m", "3m", "6m", "1y"];
  if (!validPeriods.includes(period)) {
    return res.status(400).json({ message: "Invalid period. Supported values are: " + validPeriods.join(", ") });
  }

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get specific activity resource data
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities/${resource}/date/${date}/${period}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

/**
 * Get Activity Time Series by Date Range
 * Retrieves the activity data for a given resource over a period of time by specifying a date range. The response will include only the daily summary values.
 * Scope: activity
*/
fitbitRouter.get("/:username/activities/range/:resource/date/:startDate/:endDate", async (req, res) => {
  const { username, resource, startDate, endDate } = req.params;

  // Validate resource parameter
  const validResources = [
    "activityCalories", 
    "calories", 
    "caloriesBMR", 
    "distance", 
    "elevation", 
    "floors", 
    "minutesSedentary", 
    "minutesLightlyActive", 
    "minutesFairlyActive", 
    "minutesVeryActive", 
    "steps", 
    "swimming-strokes", 
    "tracker/activityCalories", 
    "tracker/calories", 
    "tracker/distance", 
    "tracker/elevation", 
    "tracker/floors", 
    "tracker/minutesSedentary", 
    "tracker/minutesLightlyActive", 
    "tracker/minutesFairlyActive", 
    "tracker/minutesVeryActive", 
    "tracker/steps"
  ];

  if (!validResources.includes(resource)) {
    return res.status(400).json({ message: "Invalid resource. Supported values are: " + validResources.join(", ") });
  }

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get specific activity resource data for the date range
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities/${resource}/date/${startDate}/${endDate}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});


/*************************Body********************************/

/**
 * Get Body Goals
 * Retrieves a user's body fat and weight goals.
 * Scope: weight
 * goal-type	required	Supported: weight | fat
*/
fitbitRouter.get("/:username/body/log/:goalType/goal", async (req, res) => {
  const { username, goalType } = req.params;

  // Validate goalType parameter
  const validGoalTypes = ["weight", "fat"];
  if (!validGoalTypes.includes(goalType)) {
    return res.status(400).json({ message: "Invalid goal type. Supported values are: " + validGoalTypes.join(", ") });
  }

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get the specified body log goal
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/body/log/${goalType}/goal.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});


/*************************Heart Rate********************************/

/**
 * Get Heart Rate Time Series by Date
 * Retrieves the heart rate time series data over a period of time by specifying a date and time period. The response will include only the daily summary values.
 * Scope: heartrate
*/
fitbitRouter.get("/:username/heart/period/date/:date/:period", async (req, res) => {
  const { username, date, period } = req.params;

  // Validate period parameter
  const validPeriods = ["1d", "7d", "30d", "1w", "1m"];
  if (!validPeriods.includes(period)) {
    return res.status(400).json({ message: "Invalid period. Supported values are: " + validPeriods.join(", ") });
  }

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get heart rate activity data
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities/heart/date/${date}/${period}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});


/**
 * Get Heart Rate Time Series by Date Range
 * Retrieves the heart rate time series data over a period of time by specifying a date range. The response will include only the daily summary values.
 * Scope: heartrate
*/
fitbitRouter.get("/:username/heart/range/date/:startDate/:endDate", async (req, res) => {
  const { username, startDate, endDate } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get heart rate time series data
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/activities/heart/date/${startDate}/${endDate}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});


/*************************Heart Rate Variability (HRV)********************************/
/**
 * Get HRV Summary by Date
 * This endpoint returns the Heart Rate Variability (HRV) data for a single date. HRV data applies specifically to a user’s “main sleep,” which is the longest single period of time asleep on a given date.
*/
fitbitRouter.get("/:username/hrv/single-day/date/:date", async (req, res) => {
  const { username, date } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get HRV data for the specified date
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/hrv/date/${date}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

/**
 * Get HRV Summary by Interval
 * This endpoint returns the Heart Rate Variability (HRV) data for a date range. HRV data applies specifically to a user’s “main sleep,” which is the longest single period of time asleep on a given date.
 * Single date measurements are provided at the end of a period of sleep. The data returned can and often does reflects a sleep period that began the day before. For example, if you request a daily HRV rate for 2021-12-22, it may include measurements that were taken the previous night on 2021-12-21 when the user fell asleep.
 * It uses units that correspond to the Accept-Language header provided.
 * Scope: heartrate
*/
fitbitRouter.get("/:username/hrv/range/date/:startDate/:endDate", async (req, res) => {
  const { username, startDate, endDate } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get HRV data for the specified date range
    const response = await fetch(
      `https://api.fitbit.com/1/user/-/hrv/date/${startDate}/${endDate}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});


/*************************Sleep********************************/
/**
 * Get Sleep Goal
 * Returns a user's current sleep goal.
 * Scope: sleep
*/
fitbitRouter.get("/:username/sleep/goal", async (req, res) => {
  const { username } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get the user's sleep goal
    const response = await fetch(
      `https://api.fitbit.com/1.2/user/-/sleep/goal.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});


/**
 * Get Sleep Log by Date
 * This endpoint returns a list of a user's sleep log entries for a given date. The data returned can include sleep periods that began on the previous date. 
*/
fitbitRouter.get("/:username/sleep/single-day/date/:date", async (req, res) => {
  const { username, date } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get sleep log for the specified date
    const response = await fetch(
      `https://api.fitbit.com/1.2/user/-/sleep/date/${date}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

/**
 * Get Sleep Log by Date Range
 * This endpoint returns a list of a user's sleep log entries for a date range. The data returned for either date can include a sleep period that ended that date but began on the previous date. 
*/
fitbitRouter.get("/:username/sleep/range/date/:startDate/:endDate", async (req, res) => {
  const { username, startDate, endDate } = req.params;

  try {
    // Find the user's access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const accessToken = user.accessToken;

    // Call Fitbit API to get sleep log for the specified date range
    const response = await fetch(
      `https://api.fitbit.com/1.2/user/-/sleep/date/${startDate}/${endDate}.json`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorResponse = await response.json();
      console.error("Error Response:", errorResponse);
      throw new Error("Error fetching Fitbit data");
    }

    const fitbitData = await response.json();
    res.status(200).json(fitbitData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});




module.exports = fitbitRouter;



