const express = require("express");
const alexaRouter = express.Router();
const { getClients } = require("../websocket");
require("dotenv").config();

const apiUrl = "https://api.openai.com/v1/chat/completions";
const apiKey =
  "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";

async function analyzeQuestion(question) {
  // system information
  const systemConfig = `
I have the following endpoints available to query Fitbit data:

1. **Activity Endpoints:**
   - **Daily Activity Summary:** \`/activities/summary/[date]\` - Retrieves a summary of a user’s activities for a given day. 
     - **Parameters:** \`[date]\` - The date in the format YYYY-MM-DD.
   - **Activity Goals:** \`/activities/goals/[period]\` - Retrieves a user's current daily or weekly activity goals.
     - **Parameters:** \`[period]\` - Must be either \`daily\` or \`weekly\`.
   - **Favorite Activities:** \`/activities/favorite\` - Retrieves a list of a user's favorite activities.
   - **Frequent Activities:** \`/activities/frequent\` - Retrieves a list of a user's frequent activities.
   - **Lifetime Stats:** \`/activities/life-time\` - Retrieves the user's activity statistics.
   - **Recent Activity Types:** \`/activities/recent\` - Retrieves a list of a user's recent activities.
   - **Activity Time Series by Date:** \`/activities/period/[resource]/date/[date]/[period]\` - Retrieves specific activity data over a specified date and period.
     - **Parameters:** 
       - \`[resource]\` - Must be one of the following: \`activityCalories\`, \`calories\`, \`caloriesBMR\`, \`distance\`, \`elevation\`, \`floors\`, \`minutesSedentary\`, \`minutesLightlyActive\`, \`minutesFairlyActive\`, \`minutesVeryActive\`, \`steps\`, \`swimming-strokes\`, \`tracker/activityCalories\`, \`tracker/calories\`, \`tracker/distance\`, \`tracker/elevation\`, \`tracker/floors\`, \`tracker/minutesSedentary\`, \`tracker/minutesLightlyActive\`, \`tracker/minutesFairlyActive\`, \`tracker/minutesVeryActive\`, \`tracker/steps\`.
       - \`[date]\` - The end date in the format YYYY-MM-DD or specify today's date using the correct format.
       - \`[period]\` - Must be one of: \`1d\`, \`7d\`, \`30d\`, \`1w\`, \`1m\`, \`3m\`, \`6m\`, \`1y\`.
   - **Activity Time Series by Date Range:** \`/activities/range/[resource]/date/[startDate]/[endDate]\` - Retrieves specific activity data over a specified date range.
     - **Parameters:** 
       - \`[resource]\` - Same as above.
       - \`[startDate]\` - The start date in the format YYYY-MM-DD.
       - \`[endDate]\` - The end date in the format YYYY-MM-DD.

2. **Body Endpoints:**
   - **Body Goals:** \`/body/log/[goalType]/goal\` - Retrieves a user's body fat and weight goals.
     - **Parameters:** \`[goalType]\` - Must be either \`weight\` or \`fat\`.

3. **Heart Rate Endpoints:**
   - **Heart Rate Time Series by Date:** \`/heart/period/date/[date]/[period]\` - Retrieves heart rate data over a specified date and period.
     - **Parameters:**
       - \`[date]\` - The date in the format YYYY-MM-DD.
       - \`[period]\` - Must be one of: \`1d\`, \`7d\`, \`30d\`, \`1w\`, \`1m\`.
   - **Heart Rate Time Series by Date Range:** \`/heart/range/date/[startDate]/[endDate]\` - Retrieves heart rate data over a specified date range.
     - **Parameters:**
       - \`[startDate]\` - The start date in the format YYYY-MM-DD.
       - \`[endDate]\` - The end date in the format YYYY-MM-DD.

4. **Heart Rate Variability (HRV) Endpoints:**
   - **HRV Summary by Date:** \`/hrv/single-day/date/[date]\` - Retrieves HRV data for a single date.
     - **Parameters:** \`[date]\` - The date in the format YYYY-MM-DD.
   - **HRV Summary by Interval:** \`/hrv/range/date/[startDate]/[endDate]\` - Retrieves HRV data for a date range.
     - **Parameters:**
       - \`[startDate]\` - The start date in the format YYYY-MM-DD.
       - \`[endDate]\` - The end date in the format YYYY-MM-DD.

5. **Sleep Endpoints:**
   - **Sleep Goal:** \`/sleep/goal\` - Returns a user's current sleep goal.
   - **Sleep Log by Date:** \`/sleep/single-day/date/[date]\` - Returns a user's sleep log entries for a given date.
     - **Parameters:** \`[date]\` - The date in the format YYYY-MM-DD.
   - **Sleep Log by Date Range:** \`/sleep/range/date/[startDate]/[endDate]\` - Returns a user's sleep log entries for a date range.
     - **Parameters:**
       - \`[startDate]\` - The start date in the format YYYY-MM-DD.
       - \`[endDate]\` - The end date in the format YYYY-MM-DD.

**Note:** 
  - If parameters need to be filled, please infer reasonable values based on user input or common sense. For example, if a user asks, "What is my recent health data?" it is reasonable to assume "recent" refers to the last week (7 days ago to today), so you can fill the date parameters accordingly.
  - Always convert any user input regarding dates to the YYYY-MM-DD format. Do not use the word "today" directly; instead, convert it to the current date in the correct format.
  - Make sure to accurately reflect the current date in your queries to avoid errors.
  - I will use JSON.parse to process the data.choices[0].message.content.trim(), make sure the return format is correct without any irrelevant value.

Please select the endpoints to query based on the user question. The return format should be JSON farmat contains a list of endpoints like this and with proper parameters specified: ["/activities/summary/2024-10-18", "/sleep/goal"].

Attention: return format should strictly follow the rules, should not contain other information.
`;

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

  console.log("combinedData:", JSON.stringify(combinedData, null, 2));
  return combinedData; // 返回所有请求的数据
}

async function processData(combinedData){
    const systemConfig = `return json format key a, value test`;

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
    //   const processedData = JSON.parse(dataContentString);
      console.log("=====process=======" + JSON.stringify(dataContentString, null ,2));
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
    console.log("combined data type: ", typeof combinedData);

    // Step3: analyze combined data, return analysis, stuctured display data
    const processedData = await processData(combinedData);

    //Step4: send stuctured display data and analysis to frontend using websocket

    //Step5: send back analysis to alexa to speak out

    res.status(200).json(processedData);
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
