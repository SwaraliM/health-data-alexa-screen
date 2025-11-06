const mongoose = require('mongoose');
const User = require('./models/Users');
require('dotenv').config();

async function setupUserProfile() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URI || 'mongodb://localhost:27017/healthdata';
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log('✅ Connected to MongoDB');
    
    // Update Amy's profile with sample data
    const result = await User.findOneAndUpdate(
      { username: 'amy' },
      {
        $set: {
          'userProfile.age': 28,
          'userProfile.gender': 'female',
          'userProfile.fitnessLevel': 'moderately_active',
          'userProfile.healthGoals': ['improve_cardio', 'better_sleep'],
          'userProfile.healthConditions': ['none'],
          'userProfile.preferences.preferredExercise': ['running', 'yoga'],
          'userProfile.preferences.sleepGoalMinutes': 480,
          'userProfile.preferences.dailyStepGoal': 10000,
          'userProfile.preferences.dailyCalorieGoal': 2000,
        }
      },
      { new: true }
    );
    
    if (result) {
      console.log('✅ User profile updated successfully for:', result.username);
      console.log('\n📋 Profile details:');
      console.log('   Age:', result.userProfile?.age || 'Not set');
      console.log('   Gender:', result.userProfile?.gender || 'Not set');
      console.log('   Fitness Level:', result.userProfile?.fitnessLevel || 'Not set');
      console.log('   Health Goals:', result.userProfile?.healthGoals || []);
      console.log('   Health Conditions:', result.userProfile?.healthConditions || []);
      console.log('   Preferred Exercise:', result.userProfile?.preferences?.preferredExercise || []);
      console.log('   Sleep Goal (minutes):', result.userProfile?.preferences?.sleepGoalMinutes || 'Not set');
      console.log('   Daily Step Goal:', result.userProfile?.preferences?.dailyStepGoal || 'Not set');
      console.log('   Daily Calorie Goal:', result.userProfile?.preferences?.dailyCalorieGoal || 'Not set');
    } else {
      console.log('❌ User "amy" not found in database');
      console.log('   Make sure the user exists before running this script');
    }
    
    mongoose.connection.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    mongoose.connection.close();
    process.exit(1);
  }
}

setupUserProfile();

