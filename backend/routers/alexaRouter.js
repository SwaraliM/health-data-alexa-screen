const express = require("express");
const alexaRouter = express.Router();
const {getClients} = require('../websocket');


alexaRouter.post("/command", (req, res) => {
    const { command, options, username } = req.body;

    if (!username || !clients.has(username)) {
        return res.status(400).json({ message: "No client connected with the given username." });
    }

    const clientSocket = clients.get(username);

    if (clientSocket) {
        const message = {
            command: command,
            options: options
        };

        clientSocket.send(JSON.stringify(message));

        console.log(`Sent message to ${username}:`, JSON.stringify(message));

        return res.status(200).json({ message: "Command sent successfully" });
    } else {
        return res.status(500).json({ message: "Failed to send command to client." });
    }
});

module.exports = alexaRouter;
