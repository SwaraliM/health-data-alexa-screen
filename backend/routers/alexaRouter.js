const express = require("express");
const alexaRouter = express.Router();

alexaRouter.post("/command", (req, res) => {
    console.log(JSON.stringify(req.body, null, 2));
    res.status(200).json({ message: "Command received successfully" });
});

module.exports = alexaRouter;
