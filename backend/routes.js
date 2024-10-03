const express = require("express");
const router = express.Router();
const User = require('./models/Users');
const { LOGIN_SUCCESS, LOGIN_FAILURE,SERVER_ERROR } = require('../utils/constants');

router.get("/", (req, res) => {
  res.send("Hello World from Backend");
});

router.post("/login", async (req, res) => {
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
                message:LOGIN_FAILURE
            });
            return;
        }
    } catch (error) {
        // Handle database query errors
        res.status(500).json({ error: SERVER_ERROR });
        return;
    }
});

// router.get("/another-route", (req, res) => {
//   res.send("Another route response");
// });

module.exports = router;
