const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); 

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URL, {});
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1); // Exit the process with failure
  }
};

module.exports = connectDB;
