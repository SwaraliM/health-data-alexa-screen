const express = require("express");
const connectDB = require("./dbConnect");
const loginRouter = require("./routers/loginRouter");
const fitbitRouter = require("./routers/fitbitRouter");
const medicationRouter = require("./routers/medicationRouter");
const alexaRouter = require("./routers/alexaRouter");
const app = express();
const cors = require("cors");
const { createWebSocketServer } = require('./websocket'); 




connectDB();

const router = express.Router();
router.use("/login", loginRouter);
router.use("/fitbit", fitbitRouter);
router.use("/med", medicationRouter);
router.use("/alexa", alexaRouter);
app.use(cors());
app.use("/", router);

module.exports = {
  router,
  createWebSocketServer
};
