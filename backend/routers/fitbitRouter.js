const express = require("express");
const fitbitRouter = express.Router();
const User = require("../models/Users");
const { USER_NOT_FOUNT, SERVER_ERROR, TOKEN_INVALID } = require("../../utils/constants");

fitbitRouter.get("/:username/activities/today", async (req, res) => {
  const { username } = req.params;

  try {
    // 查找用户的 access token
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: USER_NOT_FOUNT });
    }

    const accessToken = user.accessToken;

    const response = await fetch(
      "https://api.fitbit.com/1/user/-/activities/date/today.json",
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

module.exports = fitbitRouter;
