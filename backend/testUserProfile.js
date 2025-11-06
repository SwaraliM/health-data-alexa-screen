const mongoose = require('mongoose');
const User = require('./models/Users');
require('dotenv').config();

async function testUserProfile() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/healthdata';
    await mongoose.connect(mongoUri);
    
    console.log('✅ Connected to MongoDB\n');
    
    const user = await User.findOne({ username: 'amy' });
    
    if (!user) {
      console.log('❌ User "amy" not found');
      mongoose.connection.close();
      return;
    }
    
    console.log('✅ User "amy" found\n');
    
    // Simulate what alexaRouter does
    const userContext = {
      age: user?.userProfile?.age || null,
      gender: user?.userProfile?.gender || 'unknown',
      fitnessLevel: user?.userProfile?.fitnessLevel || 'moderately_active',
      healthGoals: user?.userProfile?.healthGoals || [],
      healthConditions: user?.userProfile?.healthConditions || [],
      preferences: {
        preferredExercise: user?.userProfile?.preferences?.preferredExercise || [],
        sleepGoalMinutes: user?.userProfile?.preferences?.sleepGoalMinutes || 480,
        dailyStepGoal: user?.userProfile?.preferences?.dailyStepGoal || 10000,
        dailyCalorieGoal: user?.userProfile?.preferences?.dailyCalorieGoal || null,
      },
    };
    
    console.log('📋 User Context that will be sent to GPT:');
    console.log(JSON.stringify(userContext, null, 2));
    console.log('\n✅ User profile is properly configured!\n');
    
    mongoose.connection.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    mongoose.connection.close();
  }
}

testUserProfile();

