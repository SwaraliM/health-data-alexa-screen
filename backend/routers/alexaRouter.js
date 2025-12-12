const express = require("express");
const alexaRouter = express.Router();
const { getClients } = require("../websocket");
require("dotenv").config();
const { SYSTEM_CONFIG } = require("../configs/openAiSystemConfigs");
const { ENHANCED_VISUAL_CONFIG } = require("../configs/enhancedVisualConfigs");
const GPTChat = require("../GPTChat");
const User = require("../models/Users");

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("ERROR: OPENAI_API_KEY is not set in environment variables!");
  console.error("Please add OPENAI_API_KEY to your backend/.env file");
}

const gptChat = new GPTChat(apiKey, SYSTEM_CONFIG);
const enhancedVisualGPT = new GPTChat(apiKey, ENHANCED_VISUAL_CONFIG);

let state = "completed";
let gptRet = {};
let curUsername = "";

alexaRouter.get("/", (req, res) => {
  console.log("current user: " + curUsername);
  if (state === "processing") {
    //still processing
    return res.status(200).json({
      state: state,
      message: "Welcome to Alexa Router"
    });
  }
  //if state is completed
  const clients = getClients();
  const clientSocket = clients.get(curUsername);
  if (gptRet.type == "close") {
    const curGptRet = gptRet;
    console.log("close");
    gptChat.clearHistory();
    if (curUsername && clients.has(curUsername) && clientSocket) {
      const message = {
        action: "navigation",
        option: "/today-activity",
        data: {},
      };

      clientSocket.send(JSON.stringify(message));

      console.log(`Sent message to ${curUsername}:`, JSON.stringify(message));

    }
    gptRet = {};
    

    return res.status(200).json({
      state: state,
      message: curGptRet.data
    });
  } else if (gptRet.type == "reInput") {
    const curGptRet = gptRet;

    console.log("reInput");
    gptRet = {};

    return res.status(200).json({
      state: state,
      message: curGptRet.data
    });
  } else if (gptRet.type == "present") {
    const curGptRet = gptRet;
    console.log("present");

    if (curUsername && clients.has(curUsername) && clientSocket) {
      const message = {
        action: "navigation",
        option: "/general",
        data: curGptRet.data.frontend,
      };

      clientSocket.send(JSON.stringify(message));

      console.log(`Sent message to ${curUsername}:`, JSON.stringify(message));

    }
    return res.status(200).json({
      state: state,
      message: curGptRet.data.response
    });
  } else {

    console.log("unknow error");

    return res.status(200).json({
      state: state,
      message: "I didn't catch that, could you repeat your question?"
    });
  }

});


// Helper function to clean and parse JSON responses
function parseJSONResponse(response) {
  if (typeof response !== "string") {
    return response;
  }
  
  // Remove markdown code blocks if present
  response = response.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  
  // Fix unquoted property names (e.g., {type: "fetch"} -> {"type": "fetch"})
  response = response.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
  
  try {
    return JSON.parse(response);
  } catch (error) {
    console.error("JSON parse error. Original response length:", response.length);
    console.error("Parse error:", error.message);
    
    // Check if response is truncated
    if (error.message.includes("Unterminated") || error.message.includes("Unexpected end")) {
      console.warn("Response appears to be truncated. Attempting to fix...");
      
      // Extract truncation position if available
      const truncationMatch = error.message.match(/position (\d+)/);
      if (truncationMatch) {
        const truncationPos = parseInt(truncationMatch[1]);
        const beforeTruncation = response.substring(0, truncationPos);
        
        // Try to find the last complete component in the components array
        const componentsMatch = beforeTruncation.match(/"components":\[([\s\S]*)$/);
        if (componentsMatch) {
          const componentsContent = componentsMatch[1];
          // Find the last complete component object
          let braceCount = 0;
          let lastCompletePos = -1;
          let inString = false;
          let escapeNext = false;
          
          for (let i = 0; i < componentsContent.length; i++) {
            const char = componentsContent[i];
            
            if (escapeNext) {
              escapeNext = false;
              continue;
            }
            
            if (char === '\\') {
              escapeNext = true;
              continue;
            }
            
            if (char === '"' && !escapeNext) {
              inString = !inString;
              continue;
            }
            
            if (!inString) {
              if (char === '{') {
                braceCount++;
              } else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  lastCompletePos = i;
                }
              }
            }
          }
          
          if (lastCompletePos >= 0) {
            // Extract up to the last complete component
            const componentsStart = beforeTruncation.indexOf('"components":[');
            const completeComponents = componentsContent.substring(0, lastCompletePos + 1);
            const beforeComponents = beforeTruncation.substring(0, componentsStart);
            
            // Reconstruct the JSON
            let fixedResponse = beforeComponents + '"components":[' + completeComponents + ']';
            
            // Close remaining structures
            if (fixedResponse.includes('"frontend":{') && !fixedResponse.endsWith('}')) {
              fixedResponse += '}';
            }
            if (fixedResponse.includes('"data":{') && !fixedResponse.endsWith('}')) {
              fixedResponse += '}';
            }
            if (fixedResponse.startsWith('{') && !fixedResponse.endsWith('}')) {
              fixedResponse += '}';
            }
            
            // Try to parse the fixed response
            try {
              const cleaned = fixedResponse.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
              const parsed = JSON.parse(cleaned);
              console.log("Successfully parsed truncated response after removing incomplete component");
              return parsed;
            } catch (e) {
              console.error("Failed to fix truncated response:", e.message);
            }
          }
        }
      }
    }
    
    // Try to extract JSON from the response if it's wrapped in text
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const cleaned = jsonMatch[0].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
        return JSON.parse(cleaned);
      } catch (e) {
        throw new Error(`Invalid JSON format: ${error.message}`);
      }
    }
    throw error;
  }
}

async function callGPT(input) {
  console.log("callGPT");
  try {
    // No token limit - let GPT use full context window
    // Pass null to allow unlimited response length
    const maxTokens = null;
    
    let reply = await gptChat.callGPT(input, "gpt-4o", maxTokens);
    console.log("98 reply: " + JSON.stringify(reply));

    // Use improved JSON parsing with cleaning
    let replyJson = parseJSONResponse(reply);


    if (replyJson.type == "fetch") {
      const fetchedData = await fetchData(replyJson.data, curUsername);
      console.log("======" + fetchedData);

      const newInput = { type: "rawData", data: fetchedData };

      // Use higher token limit for data processing
      replyJson = await callGPT(newInput);
      
      // Store raw data for enhanced visualization
      if (replyJson && replyJson.type === "present") {
        replyJson._rawData = fetchedData;
      }
    }

    return replyJson;
  } catch (error) {
    console.error("error here:" + error.message);
    
    // Return a concise error message
    if (error.message.includes("timeout")) {
      return { type: "error", data: "That took too long. Please try a simpler question." };
    }
    
    return { type: "error", data: "Sorry, I didn't catch that. Could you repeat your question?" };
  }
}


async function fetchData(queryUrls, username) {
  console.log("url number: " + queryUrls.length);
  const combinedData = {}; // using object to store return data

  // Use localhost for internal API calls instead of API_URL (which may be ngrok URL)
  const internalApiUrl = process.env.INTERNAL_API_URL || 'http://localhost:5001';

  for (const queryUrl of queryUrls) {
    const url = `${internalApiUrl}/api/fitbit/${username}${queryUrl}`;
    try {
      console.log("Fetching Fitbit data from:", url);

      const response = await fetch(url, {
        method: "GET",
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error fetching ${url}: Status ${response.status} - ${errorText}`);
        throw new Error(
          `Error fetching data from ${url}: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      console.log(`Successfully fetched data from ${url}`);
      combinedData[url] = data; // URL as key, data as value
    } catch (error) {
      console.error("Fetch error for", url, ":", error.message);
      // write error msg to object, url as key
      combinedData[url] = { error: error.message }; // record error
    }
  }

  return combinedData;
}

// Generate enhanced visualizations asynchronously
async function generateEnhancedVisuals(rawData, userContext, username) {
  try {
    console.log("Generating enhanced visuals...");
    
    const clients = getClients();
    const clientSocket = clients.get(username);
    
    // Send status message to frontend
    if (clientSocket) {
      const statusMessage = {
        action: "status",
        message: "I am creating visuals for you, it might take a moment.",
        type: "generating"
      };
      clientSocket.send(JSON.stringify(statusMessage));
      console.log(`Sent status message to ${username}: Generating visuals`);
    }
    
    // Create input for enhanced visualization GPT
    const enhancedInput = {
      type: "enhancedVisual",
      data: rawData,
      userContext: userContext
    };
    
    // Call GPT with enhanced config (longer timeout, more tokens)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Enhanced visualization timeout")), 30000); // 30 second timeout
    });
    
    let enhancedReply;
    try {
      enhancedReply = await Promise.race([
        enhancedVisualGPT.callGPT(enhancedInput, "gpt-4o", null), // No token limit - full context window
        timeoutPromise
      ]);
    } catch (timeoutError) {
      console.error("Enhanced visualization timeout:", timeoutError.message);
      // Send error status
      if (clientSocket) {
        const errorMessage = {
          action: "status",
          message: "Visual generation took too long. Showing basic visuals instead.",
          type: "error"
        };
        clientSocket.send(JSON.stringify(errorMessage));
      }
      return null;
    }
    
    console.log("Enhanced visual reply:", enhancedReply);
    
    // Parse the enhanced response
    const enhancedJson = parseJSONResponse(enhancedReply);
    
    if (enhancedJson.type === "present" && enhancedJson.data && enhancedJson.data.frontend) {
      // Send enhanced visuals to frontend
      if (clientSocket) {
        const enhancedMessage = {
          action: "navigation",
          option: "/general",
          data: enhancedJson.data.frontend,
          replace: true // Flag to replace existing visuals
        };
        clientSocket.send(JSON.stringify(enhancedMessage));
        console.log(`Sent enhanced visuals to ${username}`);
      }
      
      return enhancedJson.data.frontend;
    }
    
    return null;
  } catch (error) {
    console.error("Error generating enhanced visuals:", error.message);
    
    // Send error status to frontend
    const clients = getClients();
    const clientSocket = clients.get(username);
    if (clientSocket) {
      const errorMessage = {
        action: "status",
        message: "Could not generate enhanced visuals. Basic visuals are shown.",
        type: "error"
      };
      clientSocket.send(JSON.stringify(errorMessage));
    }
    
    return null;
  }
}

// alexaRouter.post("/", async (req, res) => {
//   const timeoutPromise = new Promise((resolve) => {
//     setTimeout(() => {
//       resolve({ timeout: true });
//     }, 7000); // timeout limit 7 seconds
//   });
//   const mainLogicPromise = (async () => {
//     let { userInput, username } = req.body;
//     console.log("Recevied Post request from Alexa========");
//     console.log(JSON.stringify(userInput));
//     console.log(JSON.stringify(username));
//     username = username.toLowerCase();

//     const clients = getClients();
//     const clientSocket = clients.get(username);

//     if (ifWaitQuestion && userInput.data && userInput.data.toLowerCase().includes("yes")) {
//       //user want to wait
//       if (
//         asyncResults.has(username) &&
//         (asyncResults.get(username) == null || asyncResults.get(username).data == null)
//       ) {
//         console.log("line80: " );
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         ifWaitQuestion = false;
//         if (username && clients.has(username) && clientSocket) {
//           const message = {
//             action: "navigation",
//             option: "/today-activity",
//             data: {},
//           };

//           clientSocket.send(JSON.stringify(message));
//           console.log(`Sent message to ${username}:`, JSON.stringify(message));
//         }

//         return { timeout: false, data: { message: "Sorry, I didn’t catch that. Could you repeat your question?" } };
//       }

//       if (asyncResults.has(username) && asyncResults.get(username) !== null) {
//         console.log("line98: ");
//         console.log(Object.fromEntries(asyncResults));
//         const currentAsyncResult = asyncResults.get(username);
//         console.log("current " + currentAsyncResult)
//         asyncResults.delete(username);
//         console.log("line102: ");
//         console.log(Object.fromEntries(asyncResults));

//         if (username && clients.has(username) && clientSocket) {
//           const message = {
//             action: "navigation",
//             option: "/general",
//             data: currentAsyncResult.data.frontend,
//           };

//           clientSocket.send(JSON.stringify(message));

//           console.log(`Sent message to ${username}:`, JSON.stringify(message));
//         }

//         ifWaitQuestion = false;
//         return { timeout: false, data: { message: currentAsyncResult.data.response } };


//       } else {
//         const start = Date.now();
//         while (Date.now() - start < 6500) {
//           //block for 6.5 seconds
//         }
//         if (asyncResults.has(username) && asyncResults.get(username) !== null) {
//           console.log("line126: ");
//           console.log(Object.fromEntries(asyncResults));
//           return { timeout: false, data: asyncResults.get(username) };
//         } else {
//           return { timeout: true };
//         }
//       }
//     } else if (ifWaitQuestion) {
//       //use don't want to wait
//       ifWaitQuestion = false;
//       ifAbandon = true;
//       console.log("line136: " );
//       console.log(Object.fromEntries(asyncResults));
//       asyncResults.clear();

//       if (username && clients.has(username) && clientSocket) {
//         const message = {
//           action: "navigation",
//           option: "/today-activity",
//           data: {},
//         };

//         clientSocket.send(JSON.stringify(message));
//         console.log(`Sent message to ${username}:`, JSON.stringify(message));
//       }

//       return { timeout: false, data: { message: "sorry for processing so long, back to dashboard for you" } };
//     }


//     ifAbandon = false;
//     const gptRet = await callGPT(userInput);
//     if (!gptRet || typeof gptRet.type === "undefined") {
//       return { timeout: false, data: { message: "Sorry, I didn’t catch that. Could you repeat your question?" } }
//     }
//     if (gptRet.type == "close") {
//       console.log("close");
//       gptChat.clearHistory();
//       if (ifWaitQuestion) {
//         console.log("line160: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRet);
//         return { timeout: false };
//       }
//       if (ifAbandon) {
//         console.log("line165: " );
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         return { timeout: false, data: {} }
//       }
//       if (username && clients.has(username) && clientSocket) {
//         const message = {
//           action: "navigation",
//           option: "/today-activity",
//           data: {},
//         };

//         clientSocket.send(JSON.stringify(message));

//         console.log(`Sent message to ${username}:`, JSON.stringify(message));

//         ifWaitQuestion = false;
//         return { timeout: false, data: { message: gptRet.data } };
//       }
//     } else if (gptRet.type == "reInput") {

//       if (ifWaitQuestion) {
//         console.log("line186: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRet);
//         return { timeout: false };
//       }

//       if (ifAbandon) {
//         console.log("line192: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         return { timeout: false, data: {} }
//       }

//       console.log("reInput");
//       ifWaitQuestion = false;
//       return { timeout: false, data: { message: gptRet.data } };
//     } else if (gptRet.type == "fetch") {
//       console.log("fetch");
//       const fetchedData = await fetchData(gptRet.data, username);
//       console.log("======" + fetchedData);
//       const newInput = { "type": "rawData", "data": fetchedData };
//       const gptRetAfterFetch = await callGPT(newInput);

//       if (ifWaitQuestion) {
//         console.log("line208: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRetAfterFetch);
//         console.log("mark1")
//         return { timeout: false };
//       }

//       if (ifAbandon) {
//         console.log("line215: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         console.log("mark2")
//         return { timeout: false, data: {} }
//       }

//       if (username && clients.has(username) && clientSocket) {
//         const message = {
//           action: "navigation",
//           option: "/general",
//           data: gptRetAfterFetch.data.frontend,
//         };

//         clientSocket.send(JSON.stringify(message));

//         console.log(`Sent message to ${username}:`, JSON.stringify(message));

//         ifWaitQuestion = false;
//         console.log("mark3")
//         return { timeout: false, data: { message: gptRetAfterFetch.data.response } };
//       }
//     } else if (gptRet.type == "present") {
//       console.log("present");

//       if (ifWaitQuestion) {
//         console.log("line240: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRet);
//         return { timeout: false };
//       }

//       if (ifAbandon) {
//         console.log("line246: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         return { timeout: false, data: {} }
//       }

//       if (username && clients.has(username) && clientSocket) {
//         const message = {
//           action: "navigation",
//           option: "/general",
//           data: gptRet.data.frontend,
//         };

//         clientSocket.send(JSON.stringify(message));

//         console.log(`Sent message to ${username}:`, JSON.stringify(message));

//         ifWaitQuestion = false;
//         return { timeout: false, data: { message: gptRet.data.response } };
//       }
//     } else {

//       if (ifWaitQuestion) {
//         console.log("line268: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRet);
//         return { timeout: false };
//       }

//       if (ifAbandon) {
//         console.log("line274: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         return { timeout: false, data: {} }
//       }

//       console.log("unknow");

//       ifWaitQuestion = false;
//       return { timeout: false, data: { message: "error" } };
//     }
//   })();

//   const result = await Promise.race([mainLogicPromise, timeoutPromise]);

//   console.log("288Result is:")
//   console.log(JSON.stringify(result, null, 2));

//   console.log("result: " + result);

//   if (result.timeout) {
//     ifWaitQuestion = true;
//     ifAbandon = false;
//     return res.status(200).json({ message: "It is taking me a bit longer , we still need time to processe, do you want to wait?" });
//   } else {
//     ifWaitQuestion = false;
//     return res.status(200).json(result.data);
//   }



//   // try {
//   //   const gptRet = await callGPT(userInput);


//   //   const clients = getClients();
//   //   if (analysis === "back") {
//   //     const clientSocket = clients.get(username);
//   //     if (username && clients.has(username) && clientSocket) {
//   //       const message = {
//   //         action: "navigation",
//   //         option: "/today-activity",
//   //         data: {},
//   //       };

//   //       clientSocket.send(JSON.stringify(message));

//   //       console.log(`Sent message to ${username}:`, JSON.stringify(message));
//   //     }
//   //     return res.status(200).json({ message: "returned to the dashboard" });
//   //   }

//   //   if (analysis.completed == false) {
//   //     return res.status(200).json({ message: analysis.next });
//   //   }

//   //   console.log("=======analysis completed===========");

//   //   // // Step2: fetch data
//   //   const combinedData = await fetchData(analysis.next, username);

//   //   console.log("=======fetch completed===========");

//   //   // Step3: Get General Response to alexa
//   //   const alexaResponse = await getAlexaResponse(combinedData);
//   //   console.log("alexa Response: " + alexaResponse);
//   //   res.status(200).json({ message: alexaResponse });

//   //   console.log("=======response returned===========");

//   //   //Step4: send stuctured display data and analysis to frontend using websocket

//   //   if (!username || !clients.has(username)) {
//   //     return;
//   //   }

//   //   //TODO
//   //   const fetchedDataWithQuestion = {
//   //     question: analysis.question,
//   //     data: combinedData,
//   //   };
//   //   console.log(JSON.stringify(fetchedDataWithQuestion, null, 2));

//   //   const processedData = await processData(combinedData);

//   //   console.log("=======process completed===========");

//   //   const clientSocket = clients.get(username);
//   //   if (clientSocket) {
//   //     const message = processedData;

//   //     clientSocket.send(JSON.stringify(message));

//   //     console.log(`Sent message to ${username}:`, JSON.stringify(message));

//   //     return;
//   //   }
//   // } catch (error) {
//   //   console.error(error);
//   // }

//   // const clients = getClients();

//   // if (!username || !clients.has(username)) {
//   //     return res.status(400).json({ message: "No client connected with the given username." });
//   // }

//   // const clientSocket = clients.get(username);

//   // //call gpt to interpret voice input
//   // //voice input -gpt-> what endpoint should be reached
//   // //get data from api call -gpt-> analysis, stuctured data, response
//   // //response to alexa, ws to frontend(analysis and data)

//   // if (clientSocket) {
//   //     const message = {
//   //         command: command,
//   //         options: options
//   //     };

//   //     clientSocket.send(JSON.stringify(message));

//   //     console.log(`Sent message to ${username}:`, JSON.stringify(message));

//   //     return res.status(200).json({ message: "Command sent successfully" });
//   // } else {
//   //     return res.status(500).json({ message: "Failed to send command to client." });
//   // }
// });

alexaRouter.post("/", async (req, res) => {
  console.log("Received request from Alexa========");
  console.log("Request body:", JSON.stringify(req.body, null, 2));

  // Check if this is a direct Alexa request or Lambda-formatted request
  const isAlexaRequest = req.body.version && req.body.request;
  
  if (isAlexaRequest) {
    // Handle direct Alexa request
    const requestType = req.body.request.type;
    
    // Handle LaunchRequest
    if (requestType === 'LaunchRequest') {
      return res.status(200).json({
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "Welcome to Health Data. How can I assist you with your health data today?"
          },
          shouldEndSession: false
        }
      });
    }
    
    // Handle IntentRequest
    if (requestType === 'IntentRequest') {
      const intentName = req.body.request.intent.name;
      
      // Handle Stop/Cancel intents
      if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
        gptChat.clearHistory();
        return res.status(200).json({
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "Goodbye! Back to dashboard for you."
            },
            shouldEndSession: true
          }
        });
      }
      
      // Extract question from slot
      const slots = req.body.request.intent.slots;
      let question = '';
      
      if (slots && slots.question && slots.question.value) {
        question = slots.question.value;
        
        // Add intent prefix
        if (intentName === 'WhatIntent') question = "What " + question;
        else if (intentName === 'HowIntent') question = "How " + question;
        else if (intentName === 'WhoIntent') question = "Who " + question;
        else if (intentName === 'WhereIntent') question = "Where " + question;
        else if (intentName === 'WhenIntent') question = "When " + question;
        else if (intentName === 'WhyIntent') question = "Why " + question;
        else if (intentName === 'TellIntent') question = "Tell " + question;
      }
      
      if (!question) {
        return res.status(200).json({
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "I'm sorry, I didn't catch that. Could you please rephrase your question?"
            },
            shouldEndSession: false
          }
        });
      }
      
      console.log("Question extracted:", question);
      
      // Set username (hardcoded for now)
      curUsername = "amy";
      state = "processing";
      
      // Fetch user profile for personalization
      try {
        const user = await User.findOne({ username: curUsername });
        
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
        
        console.log("User context loaded:", JSON.stringify(userContext));
        
        // Process with GPT - wait for response (synchronous for direct Alexa calls)
        const userInput = { 
          type: "question", 
          data: question,
          userContext: userContext,  // Include user context!
        };
        
      try {
        // Add overall timeout of 12 seconds to allow for data fetching + GPT processing
        // Alexa HTTPS endpoints can handle up to 8s for initial response, but we allow more for async processing
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Overall request timeout")), 12000);
        });
        
        let result;
        try {
          result = await Promise.race([
            callGPT(userInput),
            timeoutPromise
          ]);
        } catch (timeoutError) {
          // If timeout occurs, check if we have a partial result
          if (gptRet && Object.keys(gptRet).length > 0 && gptRet.type !== "error") {
            console.log("Timeout occurred but using partial result:", gptRet);
            result = gptRet;
          } else {
            throw timeoutError;
          }
        }
        
        gptRet = result;
        state = "completed";
        console.log("state -> completed");
        console.log("current GptRet: " + JSON.stringify(gptRet));
        
        // Store fetched data for enhanced visuals (if available)
        let fetchedRawData = null;
        if (result.type === "present" && result._rawData) {
          fetchedRawData = result._rawData;
        }
        
        // Send to frontend via WebSocket if needed (basic visuals first)
        const clients = getClients();
        const clientSocket = clients.get(curUsername);
        
        console.log("Checking WebSocket connection:");
        console.log("- curUsername:", curUsername);
        console.log("- clients.has(curUsername):", clients.has(curUsername));
        console.log("- clientSocket:", clientSocket ? "exists" : "null");
        console.log("- result.type:", result.type);
        console.log("- result.data:", result.data ? "exists" : "null");
        console.log("- result.data.frontend:", result.data && result.data.frontend ? "exists" : "null");
        
        if (result.type === "present" && curUsername && clients.has(curUsername) && clientSocket) {
          if (result.data && result.data.frontend) {
            const message = {
              action: "navigation",
              option: "/general",
              data: result.data.frontend,
            };
            console.log(`Sending basic visuals to ${curUsername}:`, JSON.stringify(message, null, 2));
            try {
              clientSocket.send(JSON.stringify(message));
              console.log(`✅ Successfully sent basic visuals to ${curUsername}`);
            } catch (wsError) {
              console.error(`❌ Error sending WebSocket message:`, wsError);
            }
          } else {
            console.warn("⚠️ result.data.frontend is missing, cannot send to frontend");
            console.warn("Full result:", JSON.stringify(result, null, 2));
          }
        } else {
          console.warn("⚠️ Cannot send to frontend - missing requirements:");
          if (!curUsername) console.warn("  - curUsername is missing");
          if (!clients.has(curUsername)) console.warn("  - Client not connected");
          if (!clientSocket) console.warn("  - clientSocket is null");
          if (result.type !== "present") console.warn("  - result.type is not 'present':", result.type);
        }
        
        // Return appropriate response based on result type
        let speechText = "";
        let shouldEnd = false;
        
        if (result.type === "close") {
          speechText = result.data;
          shouldEnd = true;
          gptChat.clearHistory();
          
          // Navigate frontend back
          if (curUsername && clients.has(curUsername) && clientSocket) {
            const message = {
              action: "navigation",
              option: "/today-activity",
              data: {},
            };
            clientSocket.send(JSON.stringify(message));
          }
        } else if (result.type === "reInput") {
          speechText = result.data;
          shouldEnd = false;
        } else if (result.type === "present") {
          speechText = result.data.response || result.data;
          // Truncate if response is too long (more than 300 characters)
          if (speechText && speechText.length > 300) {
            speechText = speechText.substring(0, 297) + "...";
          }
          shouldEnd = false;
        } else {
          speechText = "I didn't catch that, could you repeat your question?";
          shouldEnd = false;
        }
        
        // Clear gptRet after processing
        gptRet = {};
        
        // Return response immediately (don't wait for enhanced visuals)
        const alexaResponse = {
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: speechText
            },
            shouldEndSession: shouldEnd
          }
        };
        
        // Generate enhanced visuals asynchronously (after returning response)
        // Only if we have fetched data and result is "present"
        if (result.type === "present" && fetchedRawData && curUsername) {
          // Don't await - let it run in background
          generateEnhancedVisuals(fetchedRawData, userContext, curUsername).catch(err => {
            console.error("Background enhanced visual generation failed:", err.message);
          });
        }
        
        return res.status(200).json(alexaResponse);
        
      } catch (err) {
        state = "error";
        console.error("GPT error:", err.message);
        
        // Provide concise error message
        let errorMessage = "Sorry, I had trouble processing your request. Please try again.";
        if (err.message.includes("timeout")) {
          errorMessage = "That took too long. Please try a simpler question.";
        }
        
        return res.status(200).json({
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: errorMessage
            },
            shouldEndSession: false
          }
        });
      }
      
      } catch (userFetchError) {
        console.error("Error fetching user profile:", userFetchError.message);
        
        return res.status(200).json({
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "Sorry, I had trouble accessing your profile. Please try again."
            },
            shouldEndSession: false
          }
        });
      }
    }
    
    // Handle SessionEndedRequest
    if (requestType === 'SessionEndedRequest') {
      return res.status(200).json({
        version: "1.0",
        response: {}
      });
    }
  } else {
    // Handle Lambda-formatted request (backward compatibility)
    let { userInput, username } = req.body;
    console.log("Lambda format - userInput:", JSON.stringify(userInput));
    console.log("Lambda format - username:", username);
    
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }
    
    curUsername = username.toLowerCase();
    state = "processing";
    console.log("state -> processing");

    callGPT(userInput).then(result => {
      gptRet = result;
      state = "completed";
      console.log("state -> completed");
      console.log("current GptRet: " + JSON.stringify(gptRet));
    }).catch(err => {
      state = "error";
      console.error("GPT error:", err.message);
    });

    return res.status(200).json({ message: "received immediately" });
  }
});

alexaRouter.get("/back", (req, res) => {
  console.log("close");
    gptChat.clearHistory();
    const clients = getClients();
    const clientSocket = clients.get(curUsername);
    if (curUsername && clients.has(curUsername) && clientSocket) {
      const message = {
        action: "navigation",
        option: "/today-activity",
        data: {},
      };

      clientSocket.send(JSON.stringify(message));

      console.log(`Sent message to ${curUsername}:`, JSON.stringify(message));

    }
    gptRet = {};
    state = "completed";
  return res.status(200).json({ state: state });
});


module.exports = alexaRouter;
