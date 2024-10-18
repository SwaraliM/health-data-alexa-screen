const express = require("express");
const alexaRouter = express.Router();
const {getClients} = require('../websocket');


alexaRouter.post("/", (req, res) => {
    let { question, username } = req.body;
    username = username.toLowerCase();
    console.log(question);
    res.status(200).json({ speakOutput: "Command sent successfully" });

    // const clients = getClients();

    // if (!username || !clients.has(username)) {
    //     return res.status(400).json({ message: "No client connected with the given username." });
    // }

    // const clientSocket = clients.get(username);

    // //call gpt to interpret voice input
    // //voice input -gpt-> what endpoint should be reached
    // //get data from api call -gpt-> analysis, stuctured data, response
    // //response to alexa, ws to frontend(analysis and data)

    // if (clientSocket) {
    //     const message = {
    //         command: command,
    //         options: options
    //     };

    //     clientSocket.send(JSON.stringify(message));

    //     console.log(`Sent message to ${username}:`, JSON.stringify(message));

    //     return res.status(200).json({ message: "Command sent successfully" });
    // } else {
    //     return res.status(500).json({ message: "Failed to send command to client." });
    // }
});

module.exports = alexaRouter;
