const connectDB = require('./dbConnect');
const cron = require('node-cron');

connectDB();

// fetch fitbit data
const fetchFitbitData = async (user) => {
  try {
    const { accessToken } = user;

    // get fitbit data using access token
    const response = await fetch('https://api.fitbit.com/1/user/-/activities/date/today.json', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error('Error fetching Fitbit data');
    }

    const fitbitData = await response.json();
    console.log('Fitbit data for user:', user.username, fitbitData);

    // saving data to db（TODO）
    // await saveFitbitDataToDB(user, fitbitData);

  } catch (error) {
    console.error('Error fetching Fitbit data for user', user.username, error);
  }
};


// fetch data every hour
cron.schedule('*/1 * * * *', async () => {
  try {
    const response = await fetch('http://localhost:5000/api/login/authorized-users');
    const users = await response.json();

    if (!response.ok) {
      throw new Error(users.message || 'Error fetching authorized users');
    }

    console.log('Authorized users fetched:', users);

    for (const user of users) {
      await fetchFitbitData(user);
    }

  } catch (error) {
    console.error('Error:', error);
  }
});



console.log('data sync service is running...');