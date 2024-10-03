const express = require("express");
const router = express.Router();

router.get("/", (req, res) => {
  res.send("Hello World from Backend");
});

// router.get("/another-route", (req, res) => {
//   res.send("Another route response");
// });

module.exports = router;
