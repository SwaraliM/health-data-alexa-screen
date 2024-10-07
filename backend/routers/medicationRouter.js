const { SERVER_ERROR } = require('../../utils/constants');
const Medication = require('../models/Medications');
const express = require("express");
const medicationRouter = express.Router();

medicationRouter.get("/all/:username", async (req, res) => {
    const { username } = req.params;

    try {
      const medications = await Medication.find({ username: username });

      if (medications.length === 0) {
        return res.status(404).json({ message: 'No medications found for this user' });
      }

      res.status(200).json(medications); 
    } catch (error) {
      res.status(500).json({ error: SERVER_ERROR, details: error });
    }
});
  
module.exports = medicationRouter;