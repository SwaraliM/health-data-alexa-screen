const express = require("express");
const alexaRouter = express.Router();
const { getClients } = require("../websocket");
require("dotenv").config();

const apiUrl = "https://api.openai.com/v1/chat/completions";
const apiKey =
  "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";

async function analyzeQuestion(question) {
  // system information
  const systemConfig = `You are an AI system designed to handle requests for activity data. 
  If the user asks for activity data for a specific date, return the following endpoint: \"/activities/summary/:date\". 
  Always ensure the date is in the YYYY-MM-DD format, and never use words like 'today' directly; instead, convert it to the current date.
   If the user does not specify a date, infer it based on context or use common sense. 
   Ensure the response is formatted as JSON (url(s) list), and only include the necessary values to process with JSON.parse. 
   Do not include the "\`\`\`json" in response.
   Do not include irrelevant data or extra information in the output.`;

  const systemMessage = {
    role: "system",
    content: systemConfig,
  };
  // question the user raise
  const userMessage = {
    role: "user",
    content: question,
  };

  // OpenAI request payload
  const requestBody = {
    model: "gpt-4o", // model
    messages: [systemMessage, userMessage],
    max_tokens: 150, // reply max length
  };

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();
  const dataContentString = data.choices[0].message.content.trim();
  console.log("=====analysis=======" + dataContentString);
  const queries = JSON.parse(dataContentString);
  return queries;
}

async function fetchData(queryUrls, username) {
  console.log("url number:&&&&& " + queryUrls.length);
  const combinedData = {}; // 使用对象存储结果

  for (const queryUrl of queryUrls) {
    const url = `${process.env.API_URL}/api/fitbit/${username}${queryUrl}`;
    try {
      console.log(url);

      const response = await fetch(url, {
        method: "GET",
      });

      if (!response.ok) {
        throw new Error(
          `Error fetching data from ${url}: ${response.statusText}`
        );
      }

      const data = await response.json();

      combinedData[url] = data; // 将 URL 作为键，数据作为值存入对象
    } catch (error) {
      console.error("Fetch error:", error.message);
      // 将错误信息记录到 combinedData 中，键为 URL
      combinedData[url] = { error: error.message }; // 记录错误
    }
  }

  return combinedData; // 返回所有请求的数据
}

async function processData(combinedData) {
  const systemConfig = `
  You are an AI system that processes activity data. If the user input object contains only one key and the requested path is '/activities/summary/single-day/:date', you should navigate to '/activity/single-day/:date'. Return an object that includes the following structure:

  {
   \\"command\\": \\"navigation\\",
    \\"navigation\\": \\"/activities/summary/:date\\",
    \\"data\\": {
       \\"overallActivityEvaluation\\": \\"Use the provided activity data to generate a concise, meaningful analysis of the user's daily performance. This should highlight key aspects like calories burned, steps taken, sedentary behavior, and any suggestions for improvement. Keep the analysis objective yet insightful. Word length <= 100.\\",
      \\"activityData\\": [
        {
          \\"name\\": \\"Interval Workout\\",
          \\"detail\\": [
            {\\"title\\": \\"Calorie - 10\\", \\"icon\\": \\"<FireOutlined style={{ color: 'red' }} />\\"},
            {\\"title\\": \\"Steps - 0\\", \\"icon\\": \\"<CheckCircleOutlined style={{ color: 'green' }} />\\"},
            {\\"title\\": \\"Duration - 10 minutes 37 seconds\\", \\"icon\\": \\"<ClockCircleOutlined />\\"},
            {\\"title\\": \\"Start Time - 14:56\\", \\"icon\\": \\"<ClockCircleOutlined />\\"},
            {
              \\"title\\": \\"Evaluation - Bad\\",
              \\"description\\": \\"Your Interval Workout was low in intensity with minimal calorie burn and no recorded steps. Consider increasing intensity or duration next time for better results.\\",
              \\"icon\\": \\"<FrownOutlined style={{ color: 'red' }} />\\"
            }
          ]
        }
      ],
      \\"singleValueData\\": [
        {\\"key\\": \\"Basal Metabolic Rate Calories\\", \\"value\\": \\"1288\\", \\"description\\": \\"Your basal metabolic rate indicates how much energy you burn at rest. To maintain this, balance your diet and activity level.\\"},
        {\\"key\\": \\"Today's Steps\\", \\"value\\": \\"5351\\", \\"description\\": \\"You've made some progress today, but you are still far from your step goal. Try adding more walking to your routine.\\"},
        {\\"key\\": \\"Elevation Gained (Meters)\\", \\"value\\": \\"9.144\\", \\"description\\": \\"You gained a small elevation today. Incorporating more uphill activities can boost your cardiovascular health.\\"},
        {\\"key\\": \\"Resting Heart Rate\\", \\"value\\": \\"82\\", \\"description\\": \\"Your resting heart rate is slightly elevated. Consider relaxation techniques to help lower it.\\}
      ],
      \\"activityTimeData\\": [
        {\\"type\\": \\"Sedentary Minutes\\", \\"value\\": \\"1340\\"},
        {\\"type\\": \\"Lightly Active Minutes\\", \\"value\\": \\"50\\"},
        {\\"type\\": \\"Fairly Active Minutes\\", \\"value\\": \\"42\\"},
        {\\"type\\": \\"Very Active Minutes\\", \\"value\\": \\"8\\"}
      ],
      \\"activityTimeEvaluation\\": \\"You have spent most of the day sedentary with minimal active minutes. Increasing physical activity, even light movement, can significantly improve your health.\\",
      \\"goalPercentage\\": [
        {\\"name\\": \\"Steps\\", \\"goal\\": 10000, \\"current\\": 6351, \\"description\\": \\"You are making progress, but you're still short of your goal. Aim for a brisk walk or an evening workout to close the gap.\\"},
        {\\"name\\": \\"Floors\\", \\"goal\\": 10, \\"current\\": 2, \\"description\\": \\"You've climbed a few floors, but there's room to push further to meet your goal.\\"},
        {\\"name\\": \\"Distance (km)\\", \\"goal\\": 8.05, \\"current\\": 2.7632, \\"description\\": \\"You covered some ground today, but you are still far from your target. Consider incorporating more physical activities.\\},
        {\\"name\\": \\"Calories Burned\\", \\"goal\\": 2588, \\"current\\": 1656, \\"description\\": \\"Good progress! You are over halfway to your calorie-burning goal, keep it up!\\"},
        {\\"name\\": \\"Active Minutes\\", \\"goal\\": 30, \\"current\\": 100, \\"description\\": \\"Great job! You've exceeded your active minutes goal for the day. Keep maintaining this level of activity.\\}
      ],
      \\"activityCalories\\": [
        {\\"name\\": \\"Interval Workout\\", \\"calories\\": 10},
        {\\"name\\": \\"Workout (Session 1)\\", \\"calories\\": 27},
        {\\"name\\": \\"Bike\\", \\"calories\\": 70},
        {\\"name\\": \\"Workout (Session 2)\\", \\"calories\\": 49},
        {\\"name\\": \\"Run (Session 1)\\", \\"calories\\": 137},
        {\\"name\\": \\"Run (Session 2)\\", \\"calories\\": 114}
      ],
      \\"activityCaloriesEvaluation\\": \\"Today, you burned a total of 337 calories through a mix of interval workouts, running, and biking. Running was your most effective activity, while other activities showed less intensity. Consider increasing the duration or intensity of those workouts to enhance your results.\\"
    }
      "response": "Activity page is opened. Make sure to keep a balanced routine by reducing sedentary time and increasing higher-intensity activities."
}
1. overallActivityEvaluation: This provides an overall evaluation for all the activity data of the user for the specific day. The evaluation aims to give the user an understanding of their activity patterns and where they can make adjustments to meet their fitness goals.

2. activityData: This contains detailed information about specific workouts or activities the user has performed. For each activity, there are key metrics such as calories burned, steps taken, duration, and evaluation of the workout’s effectiveness. This helps the user see how each activity contributes to their overall fitness. The structure of detail should not be changed but specific values. If user has more than one activity in a day, display them all with the structure.

3. singleValueData: This section highlights single metrics related to the user’s overall activity. Examples include Basal Metabolic Rate (BMR) calories, total steps taken for the day, elevation gained, and resting heart rate. Each metric is accompanied by a description that explains its significance and provides personalized advice for the user to maintain or improve their performance. This list length should not be changed.

4. activityTimeData: This presents the time spent in various activity intensity levels throughout the day. Categories include Sedentary, Lightly Active, Fairly Active, and Very Active minutes. The data gives the user insights into how much time they spend moving versus being sedentary, helping them track their overall activity levels. This list length should not be changed.

5. activityTimeEvaluation: This provides a concise evaluation of the user’s activity time data. It highlights whether the user has spent too much time sedentary or has achieved a healthy balance between light and vigorous activities. The evaluation includes suggestions on how to increase activity levels if needed.

6. goalPercentage: This section tracks progress towards specific fitness goals, such as steps, floors climbed, distance covered, calories burned, and active minutes. For each goal, the data shows both the target and the current achievement. Descriptions provide personalized feedback based on the user's performance relative to each goal, helping the user stay motivated and focused on meeting their targets.

7. activityCalories: This lists the calories burned during different activities throughout the day, such as workouts, biking, and running. Each activity is shown with its associated calorie expenditure, giving the user a breakdown of which activities contributed the most to their daily calorie burn.

8. activityCaloriesEvaluation: This is an evaluation of the user’s overall calorie burn for the day, based on the activities they performed. It highlights which activities were most effective in terms of calorie expenditure and offers suggestions for improving less effective workouts to maximize overall fitness results."

9. response: This indicates that the activity page is opened. The activity page provides a comprehensive overview of the user’s daily activity, helping the user understand key metrics such as steps, calories, and active minutes. It also offers actionable insights and suggestions for improving activity patterns, making it easier for the user to meet their fitness and health goals.


Note: 
All specific values should be replaced by the info in the combined data following the provided structure.
return format should be JSON,
Do not include the "\`\`\`json" in response.
  `;

  const systemMessage = {
    role: "system",
    content: systemConfig,
  };
  // question the user raise
  const userMessage = {
    role: "user",
    content: JSON.stringify(combinedData),
  };

  // OpenAI request payload
  const requestBody = {
    model: "gpt-4o", // model
    messages: [systemMessage, userMessage],
    max_tokens: 5000, // reply max length
  };

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();
  const dataContentString = data.choices[0].message.content.trim();
  const processedData = JSON.parse(dataContentString);
  console.log("=====process=======" + JSON.stringify(processedData, null, 2));
  return processedData;
}

alexaRouter.post("/", async (req, res) => {
  let { question, username } = req.body;
  username = username.toLowerCase();
  /*************for test*********/
  // console.log(question);
  // res.status(200).json({ speakOutput: "Command sent successfully" });
  /*************for test*********/

  try {
    // Step1:analysis question, return list of endpoints
    //example of analysis: ["/activities/summary/2023-10-13","/hrv/range/date/2023-10-06/2023-10-13"]
    const queryUrls = await analyzeQuestion(question);

    // // Step2: fetch data
    const combinedData = await fetchData(queryUrls, username);
    console.log("combined data len: ", Object.keys(combinedData).length);

    // Step3: analyze combined data, return analysis, stuctured display data
    const processedData = await processData(combinedData);

    //Step4: send stuctured display data and analysis to frontend using websocket

    const clients = getClients();

    if (!username || !clients.has(username)) {
      return res
        .status(400)
        .json({ message: "No client connected with the given username." });
    }

    const clientSocket = clients.get(username);
    if (clientSocket) {
      const message = processedData;

      clientSocket.send(JSON.stringify(message));

      console.log(`Sent message to ${username}:`, JSON.stringify(message));

      //Step5: send back analysis to alexa to speak out
      return res.status(200).json({ message: processedData.response });
  } else {
      return res.status(500).json({ message: "Failed to send command to client." });
  }



  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ success: false, message: "Error processing the request." });
  }

  // const clients = getClients();

  // if (!username || !clients.has(username)) {
  //     return res.status(400).json({ message: "No client connected with the given username." });
  // }

  // const clientSocket = clients.get(username);

  // //call gpt to interpret voice input
  // //voice input -gpt-> what endpoint should be reached
  // //get data from api call -gpt-> analysis, stuctured data, response
  // //response to alexa, ws to frontend(analysis and data)

  // if (clientSocket) {
  //     const message = {
  //         command: command,
  //         options: options
  //     };

  //     clientSocket.send(JSON.stringify(message));

  //     console.log(`Sent message to ${username}:`, JSON.stringify(message));

  //     return res.status(200).json({ message: "Command sent successfully" });
  // } else {
  //     return res.status(500).json({ message: "Failed to send command to client." });
  // }
});

module.exports = alexaRouter;
