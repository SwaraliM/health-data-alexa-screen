const mongoose = require('mongoose');
const User = require('./models/Users');
require('dotenv').config();

async function checkAndSetupUser() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URI || 'mongodb://localhost:27017/healthdata';
    await mongoose.connect(mongoUri);
    
    console.log('✅ Connected to MongoDB');
    
    // Check what users exist
    const users = await User.find({}, 'username isAuthorized');
    console.log('\n📋 Existing users in database:');
    if (users.length === 0) {
      console.log('   No users found');
    } else {
      users.forEach(user => {
        console.log(`   - ${user.username} (Authorized: ${user.isAuthorized})`);
      });
    }
    
    // Try to find or create Amy
    let amy = await User.findOne({ username: 'amy' });
    
    if (!amy) {
      console.log('\n⚠️  User "amy" not found. Creating...');
      amy = await User.create({
        username: 'amy',
        password: 'hashedpassword123',  // In production, this should be properly hashed
        isAuthorized: true,
      });
      console.log('✅ User "amy" created');
    }
    
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
    
    console.log('\n✅ User profile updated successfully for:', result.username);
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
    
    mongoose.connection.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    mongoose.connection.close();
    process.exit(1);
  }
}

checkAndSetupUser();

