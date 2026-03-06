/**
 * backend/routers/fitbitRouter.js
 *
 * Fitbit proxy endpoints.
 *
 * Refactor goals:
 * - Remove repetitive "fetch + expired_token retry" boilerplate.
 * - Keep every endpoint behavior identical, but easier to read and maintain.
 *
 * IMPORTANT:
 * These endpoints should stay fast and predictable because the Alexa QnA path relies on them.
 */

const express = require("express");
const fitbitRouter = express.Router();

const User = require("../models/Users");
const { USER_NOT_FOUNT, SERVER_ERROR, TOKEN_INVALID } = require("../../utils/constants");

/** -------------------------------------------------------------------------
 * Token refresh
 * ---------------------------------------------------------------------- */

/**
 * Refreshes a user's Fitbit access token using their refresh token.
 * Updates the User document in MongoDB.
 */
const renewAccessToken = async (user) => {
  const clientId = process.env.FITBIT_CLIENT_ID;
  const clientSecret = process.env.FITBIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("FITBIT_CLIENT_ID / FITBIT_CLIENT_SECRET not configured");
  }

  const encodedCredentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const refreshResponse = await fetch("https://api.fitbit.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodedCredentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: user.refreshToken,
    }),
  });

  const refreshData = await refreshResponse.json().catch(() => ({}));

  if (!refreshResponse.ok) {
    throw new Error("Failed to refresh access token");
  }

  user.accessToken = refreshData.access_token;
  user.refreshToken = refreshData.refresh_token;
  user.tokenExpiry = Date.now() + Number(refreshData.expires_in || 0) * 1000;
  await user.save();

  return refreshData.access_token;
};

/** -------------------------------------------------------------------------
 * Shared Fitbit request helper
 * ---------------------------------------------------------------------- */

/**
 * Performs a GET to Fitbit, automatically retrying once if the access token is expired.
 * Returns parsed JSON.
 */
async function fitbitGetJson(user, url) {
  let accessToken = user.accessToken;

  const doFetch = async (token) => {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    // Fitbit often returns JSON error bodies even for non-2xx.
    const data = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, data };
  };

  let attempt = await doFetch(accessToken);

  // If token expired, refresh and retry exactly once.
  const errorType = attempt?.data?.errors?.[0]?.errorType;
  if (!attempt.ok && errorType === "expired_token") {
    accessToken = await renewAccessToken(user);
    attempt = await doFetch(accessToken);
  }

  if (attempt.ok) return attempt.data;

  // Normalize errors to a single shape for callers.
  const details = attempt?.data?.errors?.[0]?.message || "Fitbit request failed";
  const err = new Error(details);
  err.status = attempt.status || 500;
  err.errorType = attempt?.data?.errors?.[0]?.errorType || "unknown";
  throw err;
}

/**
 * Load a User from MongoDB. Returns a 404 response if not found.
 */
async function requireUser(req, res) {
  const username = String(req.params?.username || "").trim().toLowerCase();
  const user = await User.findOne({ username });
  if (!user) {
    res.status(404).json({ message: USER_NOT_FOUNT });
    return null;
  }
  return user;
}

/**
 * Standard Express error handler for this router.
 */
function handleRouteError(res, error) {
  if (error?.errorType === "invalid_token") {
    return res.status(401).json({ message: TOKEN_INVALID, error: error.message });
  }
  const status = Number(error?.status) || 500;
  return res.status(status).json({ message: SERVER_ERROR, error: error.message });
}

/** -------------------------------------------------------------------------
 * Activity endpoints
 * ---------------------------------------------------------------------- */

/**
 * GET /:username/activities/summary/:date
 * Fitbit: /1/user/-/activities/date/:date.json
 */
fitbitRouter.get("/:username/activities/summary/:date", async (req, res) => {
  const { date } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const json = await fitbitGetJson(user, `https://api.fitbit.com/1/user/-/activities/date/${date}.json`);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/**
 * GET /:username/activities/goals/:period
 * Fitbit: /1/user/-/activities/goals/:period.json
 */
fitbitRouter.get("/:username/activities/goals/:period", async (req, res) => {
  const { period } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  const validPeriods = ["daily", "weekly"];
  if (!validPeriods.includes(period)) {
    return res.status(400).json({ message: "Invalid period. Use: daily or weekly." });
  }

  try {
    const json = await fitbitGetJson(user, `https://api.fitbit.com/1/user/-/activities/goals/${period}.json`);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/**
 * GET /:username/activities/favorite
 * Fitbit: /1/user/-/activities/favorite.json
 */
fitbitRouter.get("/:username/activities/favorite", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const json = await fitbitGetJson(user, "https://api.fitbit.com/1/user/-/activities/favorite.json");
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/**
 * GET /:username/activities/frequent
 * Fitbit: /1/user/-/activities/frequent.json
 */
fitbitRouter.get("/:username/activities/frequent", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const json = await fitbitGetJson(user, "https://api.fitbit.com/1/user/-/activities/frequent.json");
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/**
 * GET /:username/activities/life-time
 * Fitbit: /1/user/-/activities.json
 */
fitbitRouter.get("/:username/activities/life-time", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const json = await fitbitGetJson(user, "https://api.fitbit.com/1/user/-/activities.json");
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/**
 * GET /:username/activities/recent
 * Fitbit: /1/user/-/activities/recent.json
 */
fitbitRouter.get("/:username/activities/recent", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const json = await fitbitGetJson(user, "https://api.fitbit.com/1/user/-/activities/recent.json");
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/**
 * GET /:username/activities/period/:resource/date/:date/:period
 * Fitbit: /1/user/-/activities/:resource/date/:date/:period.json
 */
fitbitRouter.get("/:username/activities/period/:resource/date/:date/:period", async (req, res) => {
  const { resource, date, period } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  const validResources = [
    "calories", "steps", "distance", "floors", "elevation",
    "minutesSedentary", "minutesLightlyActive", "minutesFairlyActive", "minutesVeryActive",
    "activityCalories",
  ];
  const validPeriods = ["1d", "7d", "30d", "1w", "1m", "3m", "6m", "1y"];

  if (!validResources.includes(resource)) {
    return res.status(400).json({ message: `Invalid resource. Valid: ${validResources.join(", ")}` });
  }
  if (!validPeriods.includes(period)) {
    return res.status(400).json({ message: `Invalid period. Valid: ${validPeriods.join(", ")}` });
  }

  try {
    const url = `https://api.fitbit.com/1/user/-/activities/${resource}/date/${date}/${period}.json`;
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/**
 * GET /:username/activities/range/:resource/date/:startDate/:endDate
 * Fitbit: /1/user/-/activities/:resource/date/:startDate/:endDate.json
 */
fitbitRouter.get("/:username/activities/range/:resource/date/:startDate/:endDate", async (req, res) => {
  const { resource, startDate, endDate } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  const validResources = [
    "calories", "steps", "distance", "floors", "elevation",
    "minutesSedentary", "minutesLightlyActive", "minutesFairlyActive", "minutesVeryActive",
    "activityCalories",
  ];
  if (!validResources.includes(resource)) {
    return res.status(400).json({ message: `Invalid resource. Valid: ${validResources.join(", ")}` });
  }

  try {
    const url = `https://api.fitbit.com/1/user/-/activities/${resource}/date/${startDate}/${endDate}.json`;
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/** -------------------------------------------------------------------------
 * Body endpoints
 * ---------------------------------------------------------------------- */

/**
 * GET /:username/body/log/:goalType/goal
 * Fitbit: /1/user/-/body/log/:goalType/goal.json
 */
fitbitRouter.get("/:username/body/log/:goalType/goal", async (req, res) => {
  const { goalType } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  const validGoalTypes = ["weight", "fat"];
  if (!validGoalTypes.includes(goalType)) {
    return res.status(400).json({ message: `Invalid goalType. Valid: ${validGoalTypes.join(", ")}` });
  }

  try {
    const url = `https://api.fitbit.com/1/user/-/body/log/${goalType}/goal.json`;
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/** -------------------------------------------------------------------------
 * Heart endpoints
 * ---------------------------------------------------------------------- */

/**
 * GET /:username/heart/period/date/:date/:period
 * Fitbit: /1/user/-/activities/heart/date/:date/:period.json
 */
fitbitRouter.get("/:username/heart/period/date/:date/:period", async (req, res) => {
  const { date, period } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  const validPeriods = ["1d", "7d", "30d", "1w", "1m"];
  if (!validPeriods.includes(period)) {
    return res.status(400).json({ message: `Invalid period. Valid: ${validPeriods.join(", ")}` });
  }

  try {
    const url = `https://api.fitbit.com/1/user/-/activities/heart/date/${date}/${period}.json`;
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/**
 * GET /:username/heart/range/date/:startDate/:endDate
 * Fitbit: /1/user/-/activities/heart/date/:startDate/:endDate.json
 */
fitbitRouter.get("/:username/heart/range/date/:startDate/:endDate", async (req, res) => {
  const { startDate, endDate } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const url = `https://api.fitbit.com/1/user/-/activities/heart/date/${startDate}/${endDate}.json`;
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/** -------------------------------------------------------------------------
 * HRV endpoints
 * ---------------------------------------------------------------------- */

fitbitRouter.get("/:username/hrv/single-day/date/:date", async (req, res) => {
  const { date } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const url = `https://api.fitbit.com/1/user/-/hrv/date/${date}.json`;
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

fitbitRouter.get("/:username/hrv/range/date/:startDate/:endDate", async (req, res) => {
  const { startDate, endDate } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const url = `https://api.fitbit.com/1/user/-/hrv/date/${startDate}/${endDate}.json`;
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/** -------------------------------------------------------------------------
 * Sleep endpoints
 * ---------------------------------------------------------------------- */

fitbitRouter.get("/:username/sleep/goal", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const url = "https://api.fitbit.com/1.2/user/-/sleep/goal.json";
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

fitbitRouter.get("/:username/sleep/single-day/date/:date", async (req, res) => {
  const { date } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const url = `https://api.fitbit.com/1.2/user/-/sleep/date/${date}.json`;
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

fitbitRouter.get("/:username/sleep/range/date/:startDate/:endDate", async (req, res) => {
  const { startDate, endDate } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const url = `https://api.fitbit.com/1.2/user/-/sleep/date/${startDate}/${endDate}.json`;
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/** -------------------------------------------------------------------------
 * New endpoints
 * ---------------------------------------------------------------------- */
// profile endpoint
fitbitRouter.get("/:username/profile", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const url = "https://api.fitbit.com/1/user/-/profile.json";
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

// devices
fitbitRouter.get("/:username/devices", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const url = "https://api.fitbit.com/1/user/-/devices.json";
    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

//intraday heart rate
fitbitRouter.get("/:username/heart/intraday/:date", async (req, res) => {
  const { date } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const url =
      `https://api.fitbit.com/1/user/-/activities/heart/date/${date}/1d/1min.json`;

    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

//intraday activity
fitbitRouter.get("/:username/activities/intraday/:resource/:date", async (req, res) => {
  const { resource, date } = req.params;
  const user = await requireUser(req, res);
  if (!user) return;

  const validResources = ["steps", "calories", "distance", "floors", "elevation"];

  if (!validResources.includes(resource)) {
    return res.status(400).json({ message: "Invalid resource" });
  }

  try {
    const url =
      `https://api.fitbit.com/1/user/-/activities/${resource}/date/${date}/1d/1min.json`;

    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

/**
 * Generic Fitbit proxy
 *
 * GET /:username/raw/*
 *
 * Example:
 * /api/fitbit/amy/raw/1/user/-/devices.json
 * /api/fitbit/amy/raw/1/user/-/activities/heart/date/2024-01-01/1d.json
 */
fitbitRouter.get("/:username/raw/*", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const fitbitPath = req.params[0];
    const url = `https://api.fitbit.com/${fitbitPath}`;

    const json = await fitbitGetJson(user, url);
    return res.status(200).json(json);
  } catch (error) {
    return handleRouteError(res, error);
  }
});

module.exports = fitbitRouter;