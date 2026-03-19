const express = require("express");
const loginRouter = express.Router();
const User = require("../models/Users");
const {
  LOGIN_SUCCESS,
  LOGIN_FAILURE,
  SERVER_ERROR,
  USER_NOT_FOUNT,
  TOKEN_SAVE_SUCCESS,
} = require("../../utils/constants");


loginRouter.post("/", async (req, res) => {
  const { username, password } = req.body;

  try {
    // Find the user by username
    const user = await User.findOne({ username });
    // Check if the user exists and the password matches
    if (user && user.password == password) {
      // Login successful, return user authorization status and relevant info
      res.status(200).json({
        message: LOGIN_SUCCESS,
        isAuthorized: user.isAuthorized,
        accessToken: user.accessToken || null, // Return token if user is authorized
        refreshToken: user.refreshToken || null,
        tokenExpiry: user.tokenExpiry || null, // Return token expiry date if available
      });
      return;
    } else {
      // Login failed, return login failure
      res.status(200).json({
        message: LOGIN_FAILURE,
      });
      return;
    }
  } catch (error) {
    // Handle database query errors
    res.status(500).json({ error: SERVER_ERROR });
    return;
  }
});

loginRouter.post("/save-token", async (req, res) => {
  const { username, accessToken, refreshToken, tokenExpiry } = req.body;

  if (!username || !accessToken || !refreshToken) {
    return res.status(400).json({ message: "username, accessToken, and refreshToken are required." });
  }

  try {
    const name = String(username).trim();
    const nameRegex = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const user = await User.findOneAndUpdate(
      { username: nameRegex },
      {
        accessToken,
        refreshToken,
        tokenExpiry: tokenExpiry != null ? tokenExpiry : undefined,
        isAuthorized: true,
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: USER_NOT_FOUNT });
    }

    res.status(200).json({ message: TOKEN_SAVE_SUCCESS, user });
  } catch (error) {
    console.error("Error saving token:", error);
    res.status(500).json({ message: SERVER_ERROR });
  }
});

loginRouter.get("/authorized-users", async (req, res) => {
  try {
    // search for all authorized users
    const users = await User.find({ isAuthorized: true });

    if (!users || users.length === 0) {
      return res.status(404).json({ message: USER_NOT_FOUNT });
    }

    res.status(200).json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ message: SERVER_ERROR });
  }
});

// loginRouter.get("/another-route", (req, res) => {
//   res.send("Another route response");
// });

module.exports = loginRouter;
