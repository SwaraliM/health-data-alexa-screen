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
 You are an AI system that processes activity data. Your response should be in a JSON format object, including four parts: 'action', 'option', 'response', and 'data'. The 'response' field will be returned to Alexa and should include a summary sentence that encapsulates all key information. If the user input object contains only one key and the requested path is '/activity/summary/single-day/:date', you should navigate to '/activity/single-day/:date'. The 'action' should be 'navigation', the 'option' is '/activity/single-day/:date', where 'date' must be replaced by the YYYY-MM-DD format. The 'data' field is an object with the following keys and values:

  - overallActivityEvaluation: Analyze all activity data from the user's provided JSON and return a summary with suggestions. The summary should be easy to understand and actionable. It should be 100-200 words.

  - activitiesEvaluations: A list that evaluates each segment of activity in 'data.activities'. Make sure that the length of this perfectly equals to the length of activities.(Important!) Each item in the list is an object containing:
    - 'all': Overall evaluation of the activity as either 'good', 'fair', or 'bad'.
    - 'description': A brief text evaluating the specific activity.

  - singleValueDataEvaluation: A list of strings evaluating the following metrics in this exact order:
    - Basal Metabolic Rate Calories
    - Today's Steps
    - Elevation Gained (Meters)
    - Resting Heart Rate

  - goalsPercentageEvaluation: A list of strings evaluating the following goals, in this exact order:
    - 'steps'
    - 'floors'
    - 'distance'
    - 'caloriesOut'
    - 'activeMinutes'
    The evaluation should be based on a comparison between the goals and the current values. Not just present percentage number but some insights or suggestion.

  - activityTimeDataEvaluation: A string evaluating the proportion of Sedentary Minutes, Lightly Active Minutes, Fairly Active Minutes, and Very Active Minutes.

  - activityCaloriesEvaluation: A string evaluating the user's total physical activities for the day.

  Note: return should not contains other irrelevant characters, such as "\`\`\`json".
  Evaluations should be less than 100 words.
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
    max_tokens: 2000, // reply max length
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
    console.log(JSON.stringify(combinedData));
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
