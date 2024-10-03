const axios = require('axios');
const connectDB = require('./dbConnect');

async function fetchData() {
  try {
    const response = await axios.get('https://api.example.com/data');
    console.log('Fetched data:', response.data);
  } catch (error) {
    console.error('Error fetching data:', error);
  }
}

// connectDB();

// fetch data every hour
setInterval(fetchData, 60 * 60 * 1000);

console.log('data sync service is running...');