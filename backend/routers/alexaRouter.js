const express = require("express");
const alexaRouter = express.Router();
const { getClients } = require("../websocket");
require("dotenv").config();
const { SYSTEM_CONFIG } = require("../configs/openAiSystemConfigs");
const GPTChat = require("../GPTChat");

const apiKey =
  "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";
const gptChat = new GPTChat(apiKey, SYSTEM_CONFIG);

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


async function callGPT(input) {
  console.log("callGPT");
  try {
    let reply = await gptChat.callGPT(input);
    console.log("98 reply: " + JSON.stringify(reply));

    let replyJson = typeof reply === "string" ? JSON.parse(reply) : reply;


    if (replyJson.type == "fetch") {
      const fetchedData = await fetchData(replyJson.data, curUsername);
      console.log("======" + fetchedData);

      const newInput = { type: "rawData", data: fetchedData };

      replyJson = await callGPT(newInput);
    }

    return replyJson;
  } catch (error) {
    console.error("error here:" + error.message);
    return { type: "error", data: "Sorry, I didn’t catch that. Could you repeat your question?" };
  }
}


async function fetchData(queryUrls, username) {
  console.log("url number: " + queryUrls.length);
  const combinedData = {}; // using object to store return data

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

      combinedData[url] = data; // URL as key, data as value
    } catch (error) {
      console.error("Fetch error:", error.message);
      // write error msg to object, url as key
      combinedData[url] = { error: error.message }; // record error
    }
  }

  return combinedData;
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
  let { userInput, username } = req.body;
  console.log("Recevied Post request from Alexa========");
  console.log(JSON.stringify(userInput));
  console.log(JSON.stringify(username));
  curUsername = username.toLowerCase();
  state = "processing";
  console.log("state -> processing");

  // ⏱️ 不等待 callGPT
  callGPT(userInput).then(result => {
    gptRet = result;
    state = "completed";
    console.log("state -> completed");
    console.log("current GptRet: " + JSON.stringify(gptRet));
  }).catch(err => {
    state = "error";
    console.error("GPT error:", err.message);
  });

  return res.status(200).json({ message: "received immediately" }); // ✅ 立即返回
});


module.exports = alexaRouter;
