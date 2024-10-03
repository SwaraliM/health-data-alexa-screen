const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true, 
  },
  password: {
    type: String,
    required: true,
  },
  isAuthorized: {
    type: Boolean,
    default: false,
  },
  accessToken: {
    type: String,
    required: false,
  },
  refreshToken: {
    type: String,
    required: false,
  },
  tokenExpiry: {
    type: Date,
    required: false,
  },
});

const User = mongoose.model('User', userSchema);

module.exports = User;
