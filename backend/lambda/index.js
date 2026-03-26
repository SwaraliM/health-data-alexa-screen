/* *
 * This sample demonstrates handling intents from an Alexa skill using the Alexa Skills Kit SDK (v2).
 * Please visit https://alexa.design/cookbook for additional examples on implementing slots, dialog management,
 * session persistence, api calls, and more.
 * */
const Alexa = require('ask-sdk-core');
const AWS = require("aws-sdk");
const axios = require('axios');
const ddbAdapter = require('ask-sdk-dynamodb-persistence-adapter');
const moment = require('moment-timezone');
const break_audio = "  <break time='10s'/>  ";
const pauseDuration = break_audio.repeat(18);
const SmallPauseDuration = break_audio.repeat(3);
let repromptText = " I'm still here whenever you're ready. Just say something and we can keep going. " + pauseDuration + " What would you like to know? ";

//let medCounter = 0;
//let remCounter = 0;
//let repeating = [  ];

var followUp = "false";
var tryAgain = "false";
const timeOut = 5500;
const sayIt = 1000;
// API CALL FOR BACKEND
const apiCall = 'YOUR_API_URL_HERE';
var questionAsked = false;
var countQuestion = 0;
/*const config = new Configuration({
    apiKey: keys.OPEN_AI_KEY
});

const openai = new OpenAIApi(config);
*/

var start = true;
var smallTalk = "It's taking me a bit longer. Hang in there. okay?";
var smallTalkResonse = " ";


//var index_ques = 20;
//const index_max = 29;
//var fillers = [];//["Let me check that!", "searching!", "looking it up!", "fetching that!", "I'll quickly look that up!", "let me check!", "I'm on it!", "Give me a sec!", "Hold tight, looking!"];
//var filler_questions = [];//["How are you today?", "How's your day going?","Are you a morning person or a night owl?", "Did you do anything new today?", "What is your favorite food?", "What's your favorite hobby or pastime?", "Do you enjoy outdoor activities like hiking, biking, or camping?" ,"Do you have any pets?", "Have you seen any good movies or TV shows lately?", "Any specific plans for today?", "What's a good book that you have read?", "What's your favourite way to relax?", "Do you have any favorite travel destinations or dream places to visit?", "How do you unwind?", "Are you watching any shows recently?", "Do you listen to recent news?", "What's been the highlight of your week so far?", "Have you tried any new activities recently?", "Do you enjoy going outside?","Do you follow any sports or sporting events?", "Do you like to keep to yourself?", "How has the world changed since you were growing up?", "What are your plans for the day?", "Any interesting plans for next weekend?", "Do you have a favorite dessert?", "Do you know how to cook?", "What kind of music do you like?",  "Are there any skills you've been meaning to learn or improve?", "Are you a fan of any particular TV show or movie genre?", "How do you like to celebrate special occasions or milestones?"];

//const meanwhile =["In the meantime... ","I am working on that, meanwhile... ","While I do that for you... ","As I work on that... ","While I am doing that... ", "While we wait... "];
const fillers =  ["Okay", "Sure", "Got it", "Right", "Gotcha", "Alright"];
//["Let me work that!", "getting that!", "working on that!", "fetching that!", "I'll quickly look that up!", "let me work on it!", "I'm on it!", "Give me a sec!", "Hold tight!"];
/*filler_questions = ["How are you today?", "How's your day going?", "Have you tried any new activities recently?", "Do you follow any sports or sporting events?",  "Do you like to keep to yourself?",
"How has the world changed since you were growing up?", "What are your plans for the day?", "Any interesting plans for next weekend?", "Do you have a favorite dessert?", "Do you know how to cook?",
"What kind of music do you like?",  "Are there any skills you've been meaning to learn or improve?", "Are you a fan of any particular TV show or movie genre?", "How do you like to celebrate special occasions or milestones?", "Do you have any favorite travel destinations or dream places to visit?"];
}*/
/*const filler_questions = ["What's been the highlight of your week so far?", "Do you enjoy going outside?", "Are you a morning person or a night owl?", "Did you do anything new today?", "What's your typical day like?",
        "What is your favorite food?", "What's your favorite hobby or pastime?", "Do you enjoy outdoor activities like hiking, biking, or camping?" ,"Do you have any pets?", "Have you seen any good movies or TV shows lately?",
        "Any specific plans for today?", "What's a good book that you have read?", "What's your favourite way to relax?", "Are you watching any shows recently?", "Have you eaten at a good restaurant recently?",
        "How are you today?", "How's your day going?", "Have you tried any new activities recently?", "Do you follow any sports or sporting events?",  "Do you like to keep to yourself?",
        "How has the world changed since you were growing up?", "What are your plans for the day?", "Any plans for next weekend?", "Do you have a favorite dessert?", "Do you know how to cook?",
        "What kind of music do you like?",  "Are there any skills you've been meaning to learn or improve?", "Are you a fan of any particular TV show or movie genre?", "How do you like to celebrate special occasions or milestones?", "What is your favorite place in the world?"];
    */
const smallTalkFillers1 = ["Just a moment, ", "Almost there, ", "Give me one more second, ", "Working on that for you, " ];
const smallTalkFillers2 = ["I appreciate your patience. ", "thanks for waiting. ", "I'll have it shortly. ", "nearly done. "];
const smallTalkFillers3 = ["", ""]
//const intro_hi = ["Hello! ", "Hi! ", "Hey! ", "Welcome! "]
//const intro_agent =["I am an intelligent conversational assistant designed to present requested information. ",
//"I am an intelligent virtual agent programmed to provide you with the requested information to the best of my ability. ",
//"I am an AI assistant intended to furnish relevant information on request. ",
//"As an intelligent voice assistant my purpose is to provide requested information as accurately as possible. ",
//"I am here to provide information. "];
//const intro = ['How can I assist you today?', 'What do you wanna know?', 'What questions do you have?', 'What would you like to know?'  ];
//const intro = ['Are you still there? ', 'Are you still with me? ', 'I am waiting for your response. ', 'I am ready when you are. '];
//const other = ['Any other questions for me? ', 'What else can I help you with? ', 'Anything else you\'d like to know? ', 'Anything else? '];
const bye = ["Goodbye!", "Untill next time!", "Take care!", "Stay safe!", "Bye!", "Have a good one!"];
//var meanwhile = [];//["In the meantime... ","I am looking it up, meanwhile... ","While I get that for you... ","As I get that for you... ","While I am fetching that... ", "While we wait... "];
//const acknowledge = ["Hmm. Interesting. ", "Well, that's intriguing, moving on. ", "Noted, moving forward. ", "Thanks for sharing, coming back on track. ", "Hmm, I see, back to the topic. ", "Well, alright back to matter at hand. "];
//const acknowledge = ["Hmm... ", "Well... ", "Thanks for sharing... ", "Got it... ", " I see... ", "Alright... "];




const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
     async handle(handlerInput) {
        //const index = Math.floor(Math.random() * 3);
        //const index_hi = Math.floor(Math.random() * 3);
        //const index_agent = Math.floor(Math.random() * 4);
        //const index_error = Math.floor(Math.random() * 5);
        let speakOutput = "Starting here" ;//intro_hi[index_hi] + intro_agent[index_agent]  + intro[index];

        //const speakOutput = 'Hello! I am an AI language model. How can I assist you today?';
        tryAgain = "false";

        //saving counter
        /*const attributesManager = handlerInput.attributesManager;
        let attributes = {"counter":0,
            "medicationReminderIds": medicationReminderIds}

        attributesManager.setPersistentAttributes(attributes);
        await attributesManager.savePersistentAttributes();*/

        ////reading counter
        /*const attributesManager2 = handlerInput.attributesManager;
        let attributes2 = await attributesManager2.getPersistentAttributes() || {};
        //console.log('attributes is: ', attributes);

        const counter = attributes.hasOwnProperty('counter')? attributes.counter : 0;
        medicationReminderIds = attributes.medicationReminderIds || {}; // Default to an empty object if not found*/



        ///////////////////////Get information from sheets about person etc...

        //let apiUrl = apiInfoCall;
        //var speakOutput2 = "Anything else I can help with?";
        //let counter = 0;




        //let medicationList =[];
        //medicationList = JSON.parse(jsonString);


        speakOutput = "Hi there! I'm your health assistant. You can ask me anything about your health data, like how you've been sleeping or how active you've been.";
    //" + infoReceived.data.summaryGPT + "


        start = true;

        // for breaking. Say Alexa to continue
        /*for (let i = 0; i < 18; i++) {
                speakOutput += break_audio;
            }
            speakOutput += " Are you still there? Should we continue?";*/
        questionAsked = false;
        //const index2 = Math.floor(Math.random() * 3);
        //const index3 = Math.floor(Math.random() * 3);
        //let reprompting = intro[index2];
        //let reprompting2 = other[index3];
        let reprompting = 'Should I continue? ';
        if (!questionAsked){
            //speakOutput = speakOutput + pauseDuration  + " Are you still there? Should we continue?";
            //reprompting = reprompting + "Whenever you are ready to respond, say Alexa and proceed. " + pauseDuration + reprompting2;
            reprompting = " I'm here whenever you're ready. What would you like to know? " + pauseDuration + " Feel free to ask me anything about your health. ";


        }
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(reprompting)
            .getResponse();
    }
};

/*const NavigateHomeIntentHandler ={
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
        && Alexa.getIntentName(handlerInput.requestEnvelope) === 'NavigateHomeIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'How can I assist you?';
        gptTurboMessage =  [{role:"system", content: "You are an AI assistant."}];
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};*/

//AMAZON.NavigateHomeIntent
//


const AskChatGPTIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AskChatGPTIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhatIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhoIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhereIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhenIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhyIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhichIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhoseIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'HowIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'DoIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'HaveIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'CouldIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AreIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'TellIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'YesIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'NoIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'NextIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'One'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Two'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Three'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Four'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Five'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Six'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Seven'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Eight'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Nine'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Ten'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Eleven'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Twelve'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Breakfast'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Lunch'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Dinner'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Morning'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Evening'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Night'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Noon'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'Afternoon'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'setIntent'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'bedtime'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'waketime'
      || Alexa.getIntentName(handlerInput.requestEnvelope) === 'UpdateIntent');
  },
  async handle(handlerInput) {
    let startTime = Date.now();
    var question =
            Alexa.getSlotValue(handlerInput.requestEnvelope, 'question');
    if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhatIntent'){
        question = "What " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'HowIntent'){
        question = "How " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhoIntent'){
        question = "Who " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhereIntent'){
        question = "Where " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhenIntent'){
        question = "When " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhichIntent'){
        question = "Which " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhoseIntent'){
        question = "Whose " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhyIntent'){
        question = "Why " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'DoIntent'){
        question = "Do " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'HaveIntent'){
        question = "Have " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'CouldIntent'){
        question = "Should " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AreIntent'){
        question = "Are " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'TellIntent'){
        question = "Tell " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'YesIntent'){
        question = "Yes " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'NoIntent'){
        question = "No " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'NextIntent'){
        question = "Next " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'One'){
        question = "One " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Two'){
        question = "Two " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Three'){
        question = "Three " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Four'){
        question = "Four " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Five'){
        question = "Five " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Six'){
        question = "Six " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Seven'){
        question = "Seven " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Eight'){
        question = "Eight " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Nine'){
        question = "Nine " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Ten'){
        question = "Ten " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Eleven'){
        question = "Eleven " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Twelve'){
        question = "Twelve " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Breakfast'){
        question = "Breakfast " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Lunch'){
        question = "Lunch " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Dinner'){
        question = "Dinner " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Morning'){
        question = "Morning " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Noon'){
        question = "Noon " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Afternoon'){
        question = "Afternoon " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Evening'){
        question = "Evening " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'Night'){
        question = "Night " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'setIntent'){
        question = "Set " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'bedtime'){
        question = "Bedtime " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'waketime'){
        question = "Wake up " + question;
    }
    else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'UpdateIntent'){
        question = "Update " + question;
    }
    //tryAgain = "false";
    ////// Progressive call
    countQuestion += 1;
    const timeoutId = setTimeout(() => {
      //console.log('API call not completed within 3 seconds. so sending a progressive call ');
      // Reject the API response promise to handle the timeout scenario
      //apiResponseReject(new Error('API call timed out'));
      // Make the API call to mark the directive as complete
         //working
        let progressiveApiResponsePromise = axios.post('https://api.amazonalexa.com/v1/directives', request, {
          headers: {
            Authorization: `Bearer ${apiAccessToken}`,
            'Content-Type': 'application/json'
          }
        })
        .then(response => {
          console.log('Directive sent successfully!');
        })
        .catch(error => {
          console.error('Error sending directive:', error);
        });

   //flagProgressiveAPI = true;


    },sayIt);


    //////////


    let apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
    //var speakOutput2 = "Anything else I can help with?";
    //let counter = 0;

    if(start){
        question = "start " + question;
        smallTalk = "While I am getting that, how are you today?"
        start = false;
    }
    else {
        question = "smallTalk question asked:" + smallTalk + " smallTalk response: "+ smallTalkResonse + "user query: " + question;
    }

    let apiResponsePromise = axios.post(apiUrl, JSON.stringify(question), {
      headers: {
        //Authorization: authToken,
        'Content-Type': 'application/json',
        accept: '*/*',
      },
    });

    //////// working code
    //progressive call

   // Get the API access token and request ID
    const apiAccessToken = handlerInput.requestEnvelope.context.System.apiAccessToken;
    const requestId = handlerInput.requestEnvelope.request.requestId;


    const index_filler = Math.floor(Math.random() * 8);
    const repromptText2 = fillers[index_filler];


   const directive = {
      type: 'VoicePlayer.Speak',
      speech: repromptText2, //+ '<break time="5s"/>' + 'still looking',
    };
    const request = {
      header: {
        requestId: requestId
      },
      directive: directive
    };
    /////////////////////////////////////

    var speakOutput = await apiResponsePromise;
    //smallTalk = speakOutput.data.smallTalk;
    //followUp = "true";
    let currentTime = Date.now();
    //speakOutput.data.GPTresponse === "Still working on that"
    while ( speakOutput.data.GPTresponse === "Still working on that" && currentTime-startTime < timeOut){
        //counter++;
        tryAgain = "true";
        const apiUrl =apiCall+followUp+'&tryAgain='+tryAgain;


        // Send progressive directive with filler text to keep user engaged while polling
        const STindex1 = Math.floor(Math.random() * smallTalkFillers1.length);
        const STindex2 = Math.floor(Math.random() * smallTalkFillers2.length);
        const STindex3 = Math.floor(Math.random() * smallTalkFillers3.length);
        const pollingFiller = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3];

        const pollingDirective = {
          type: 'VoicePlayer.Speak',
          speech: pollingFiller,
        };
        const pollingRequest = {
          header: {
            requestId: requestId
          },
          directive: pollingDirective
        };

        axios.post('https://api.amazonalexa.com/v1/directives', pollingRequest, {
          headers: {
            Authorization: `Bearer ${apiAccessToken}`,
            'Content-Type': 'application/json'
          }
        }).catch(error => {
          console.error('Error sending polling directive:', error);
        });

        let apiResponsePromise = axios.post(apiUrl,  JSON.stringify("trying again"), {
          headers: {
            //Authorization: authToken,
            'Content-Type': 'application/json',
            accept: '*/*',
          },
    });
    speakOutput = await apiResponsePromise;
    //smallTalk = speakOutput.data.smallTalk;
    currentTime = Date.now();
    //tryAgain = "false";
    /*if (speakOutput.data === "Still working on that"){
        tryAgain = "true";
        speakOutput.data = "Taking a bit longer than expected. Should I check again?";
    }*/
    }
    clearTimeout(timeoutId);
    if (followUp === "false"){
        followUp = "true";
    }
    //var repromptText = "";
    if (speakOutput.data.GPTresponse  === "Still working on that"){
        tryAgain = "true";
        repromptText = "It's taking a little longer than usual. I'll keep working on it. Just say anything when you're ready." + pauseDuration + " I'm here whenever you need me.";
        /*const index_meanwhile = Math.floor(Math.random() * 6);
        const attributesManager = handlerInput.attributesManager;
        let attributes = await attributesManager.getPersistentAttributes() || {};
        var counter = attributes.hasOwnProperty('counter')? attributes.counter : 0;
        speakOutput.data.GPTresponse = meanwhile[index_meanwhile] + filler_questions[counter];
        if (counter >= index_max)
        {
            counter = -1;
        }
        counter++;
        //attributes = {"counter":counter};
        attributes.counter = counter; // Update the persistent attribute
        attributesManager.setPersistentAttributes(attributes);
        await attributesManager.savePersistentAttributes();
        */
        if (questionAsked || countQuestion < 2)
        {
            const STindex1 = Math.floor(Math.random() * 3);
            const STindex2 = Math.floor(Math.random() * 3);
            const STindex3 = Math.floor(Math.random() * 1);
            smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
            //smallTalk = "It's taking me a bit longer. Are you still here? ";

        }
        else if (countQuestion >= 2)
        {
            if (speakOutput.data.smallTalk.length === 0)
            {
                const STindex1 = Math.floor(Math.random() * 3);
                const STindex2 = Math.floor(Math.random() * 3);
                const STindex3 = Math.floor(Math.random() * 1);
                smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
            }
            else{
                smallTalk = speakOutput.data.smallTalk;
            }
            //smallTalk = speakOutput.data.smallTalk;
            countQuestion = 0;
            //countQuestion += 1; // add everytime you get smallTalk from sheets
        }
        speakOutput.data.GPTresponse = smallTalk;
        questionAsked = true;


        //handlerInput.requestEnvelope = 'TryAgain';
        //return TryAgainIntentHandler(handlerInput);
    }
    else{
        if (questionAsked)
        {
            //const index4 = Math.floor(Math.random() * 5);
            //speakOutput.data.GPTresponse =  acknowledge[index4] + speakOutput.data.GPTresponse;
            smallTalkResonse = question + ". ";
            //countQuestion -= 1; // subtract everytime you get potential user response for smallTalk
            questionAsked = false;
        }
        else
        {
            smallTalk = " ";
            smallTalkResonse = " ";
        }
        tryAgain = "false";
        //followUp = "true";
        //const index2 = Math.floor(Math.random() * 3);
        //repromptText = other[index2];
        //const index2 = Math.floor(Math.random() * 3);
        //const index3 = Math.floor(Math.random() * 3);
        //repromptText = intro[index2] + "Whenever you are ready to respond, say Alexa and continue. " + pauseDuration + other[index3];
        repromptText = " I'm here whenever you're ready. What would you like to know? " + pauseDuration + " Feel free to ask me anything about your health.";

        speakOutput.data.GPTresponse = speakOutput.data.GPTresponse + SmallPauseDuration;

    }


    //if (!questionAsked){
        //speakOutput.data.GPTresponse = speakOutput.data.GPTresponse + pauseDuration  + " Are you still there? Should we continue?";
    //}



    return handlerInput.responseBuilder
      .speak(speakOutput.data.GPTresponse) //"chat "  +tryAgain +
      .reprompt(repromptText)
      .getResponse();

  }
};

const TryAgainIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent'
            || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.YesIntent'
            || Alexa.getIntentName(handlerInput.requestEnvelope) === 'WaitIntent');
    },
    async handle(handlerInput) {
        //tryAgain = "true";
        let statement = "";
        if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent'){
            statement = "Resume ";
        }
        else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.YesIntent'){
            statement = "Yes ";
        }
        else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'WaitIntent'){
            statement = "Wait ";
        }
        let startTime = Date.now();
        //const index2 = Math.floor(Math.random() * 3);
        const index = Math.floor(Math.random() * 3);
        //let repromptText = other[index2];
        //let speakText = other[index];
        let speakText = '';
        let repromptText = '';
        //let speakText = "What else can I help you with.";
        //let repromptText = "What else can I help you with";
        //if (tryAgain === "true"){
        countQuestion += 1;
        const timeoutId = setTimeout(() => {
          //console.log('API call not completed within 3 seconds. so sending a progressive call ');
          // Reject the API response promise to handle the timeout scenario
          //apiResponseReject(new Error('API call timed out'));
          // Make the API call to mark the directive as complete
             //working
            let progressiveApiResponsePromise = axios.post('https://api.amazonalexa.com/v1/directives', request, {
              headers: {
                Authorization: `Bearer ${apiAccessToken}`,
                'Content-Type': 'application/json'
              }
            })
            .then(response => {
              console.log('Directive sent successfully!');
            })
            .catch(error => {
              console.error('Error sending directive:', error);
            });

       //flagProgressiveAPI = true;


        },sayIt);
        //////////
        const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
        //let counter = 0;
        let apiResponsePromise2 = axios.post(apiUrl,"\"" + statement + "\"", {
          headers: {
            'Content-Type': 'application/json',
            accept: '*/*',
          },
        });


        //////// working code
        //progressive call

       // Get the API access token and request ID
        const apiAccessToken = handlerInput.requestEnvelope.context.System.apiAccessToken;
        const requestId = handlerInput.requestEnvelope.request.requestId;


        const index_filler = Math.floor(Math.random() * 8);
        const repromptText2 = fillers[index_filler];


       const directive = {
          type: 'VoicePlayer.Speak',
          speech: repromptText2, //+ '<break time="5s"/>' + 'still looking',
        };
        const request = {
          header: {
            requestId: requestId
          },
          directive: directive
        };
        /////////////////////////////////////

        var speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;
        let currentTime = Date.now();
        while (speakOutput2.data.GPTresponse  === "Still working on that" && currentTime-startTime < timeOut){
            tryAgain = "true";
            //counter++;
            const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
            let apiResponsePromise2 = axios.post(apiUrl, "\"" + statement + "\"", {
              headers: {
                //Authorization: authToken,
                'Content-Type': 'application/json',
                accept: '*/*',
              },
        });
        speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;

        currentTime = Date.now();
        /*if (speakOutput2.data === "Still working on that"){
            tryAgain = "true";
            speakOutput2.data= "It's taking a bit longer. Should I continue?"
        }*/
        }
        clearTimeout(timeoutId);
        //var repromptText = "";
        if (speakOutput2.data.GPTresponse  === "Still working on that"){
            tryAgain = "true";
            repromptText = "It's taking a little longer than usual. I'll keep working on it. Just say anything when you're ready." + pauseDuration + " I'm here whenever you need me.";

            /*const index_meanwhile = Math.floor(Math.random() * 6);
            const attributesManager = handlerInput.attributesManager;
            let attributes = await attributesManager.getPersistentAttributes() || {};
            var counter = attributes.hasOwnProperty('counter')? attributes.counter : 0;
            speakText = meanwhile[index_meanwhile] + filler_questions[counter];
            if (counter >= index_max)
            {
                counter = -1;
            }
            counter++;
            //attributes = {"counter":counter};
            attributes.counter = counter; // Update the persistent attribute
            attributesManager.setPersistentAttributes(attributes);
            await attributesManager.savePersistentAttributes();*/
            if (questionAsked || countQuestion < 2)
            {
                const STindex1 = Math.floor(Math.random() * 3);
                const STindex2 = Math.floor(Math.random() * 3);
                const STindex3 = Math.floor(Math.random() * 1);
                smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                //smallTalk = "It's taking me a bit longer. Are you still here? ";

            }
            else if (countQuestion >= 2)
            {
                if (speakOutput2.data.smallTalk.length === 0)
                {
                    const STindex1 = Math.floor(Math.random() * 3);
                    const STindex2 = Math.floor(Math.random() * 3);
                    const STindex3 = Math.floor(Math.random() * 1);
                    smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                }
                else{
                    smallTalk = speakOutput2.data.smallTalk;
                }
                countQuestion = 0;
            }
            speakText = smallTalk;
            questionAsked = true;

        }
        else{
            tryAgain = "false";
            //smallTalk = speakOutput2.data.smallTalk;
            //const index2 = Math.floor(Math.random() * 3);
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = intro[index2] + "Whenever you are ready to respond, say Alexa and proceed. " + pauseDuration + other[index3];
             repromptText = " I'm here whenever you're ready. What would you like to know? " + pauseDuration + " Feel free to ask me anything about your health.";
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = other[index3];
            //repromptText = "What else would you like to know?";
            if (questionAsked)
            {
                //const index4 = Math.floor(Math.random() * 5);
                speakText = speakOutput2.data.GPTresponse; //acknowledge[index4] +
                questionAsked = false;
            }
            else{
                smallTalk = " ";
                smallTalkResonse = " ";
                speakText = speakOutput2.data.GPTresponse;
            }
            /*if (persona === "TRUE")
            {
               return handlerInput.responseBuilder.speak(speakOutput2.data.GPTresponse).getResponse(); // notice we send an empty response
            }*/

        }

        speakText = speakText + SmallPauseDuration;

        //if (!questionAsked){
        //    speakText = speakText + pauseDuration  + " Are you still there? Should we continue?";
        //}

        return handlerInput.responseBuilder
            .speak(speakText)
            .reprompt(repromptText)
            .getResponse();
    }
};

const NoIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NoIntent'
            || Alexa.getIntentName(handlerInput.requestEnvelope) === 'TryAgainIntent');
    },
    async handle(handlerInput) {
        //tryAgain = "true";
        let statement = "";
        if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NoIntent'){
            statement = "No";
        }
        else if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'TryAgainIntent'){
            statement = " ";
        }
        let startTime = Date.now();
        const index2 = Math.floor(Math.random() * 3);
        const index = Math.floor(Math.random() * 3);
        //let repromptText = other[index2];
        let speakText = ' ';
        countQuestion += 1;
        //let speakText = "What else can I help you with.";
        //let repromptText = "What else can I help you with";
        //if (tryAgain === "true"){
        const timeoutId = setTimeout(() => {
          //console.log('API call not completed within 3 seconds. so sending a progressive call ');
          // Reject the API response promise to handle the timeout scenario
          //apiResponseReject(new Error('API call timed out'));
          // Make the API call to mark the directive as complete
             //working
            let progressiveApiResponsePromise = axios.post('https://api.amazonalexa.com/v1/directives', request, {
              headers: {
                Authorization: `Bearer ${apiAccessToken}`,
                'Content-Type': 'application/json'
              }
            })
            .then(response => {
              console.log('Directive sent successfully!');
            })
            .catch(error => {
              console.error('Error sending directive:', error);
            });

       //flagProgressiveAPI = true;


        },sayIt);
        //////////
        const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
        //let counter = 0;
        let apiResponsePromise2 = axios.post(apiUrl,"\"" +  statement + "\"", {
          headers: {
            'Content-Type': 'application/json',
            accept: '*/*',
          },
        });


        //////// working code
        //progressive call

       // Get the API access token and request ID
        const apiAccessToken = handlerInput.requestEnvelope.context.System.apiAccessToken;
        const requestId = handlerInput.requestEnvelope.request.requestId;


        const index_filler = Math.floor(Math.random() * 8);
        const repromptText2 = fillers[index_filler];


       const directive = {
          type: 'VoicePlayer.Speak',
          speech: repromptText2, //+ '<break time="5s"/>' + 'still looking',
        };
        const request = {
          header: {
            requestId: requestId
          },
          directive: directive
        };
        /////////////////////////////////////

        var speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;
        let currentTime = Date.now();
        while (speakOutput2.data.GPTresponse  === "Still working on that" && currentTime-startTime < timeOut){
            tryAgain = "true";
            //counter++;
            const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
            let apiResponsePromise2 = axios.post(apiUrl, "\"" + statement + "\"", {
              headers: {
                //Authorization: authToken,
                'Content-Type': 'application/json',
                accept: '*/*',
              },
        });
        speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;
        currentTime = Date.now();
        /*if (speakOutput2.data === "Still working on that"){
            tryAgain = "true";
            speakOutput2.data= "It's taking a bit longer. Should I continue?"
        }*/
        }
        clearTimeout(timeoutId);
        //var repromptText = "";
        if (speakOutput2.data.GPTresponse  === "Still working on that"){
            tryAgain = "true";
            repromptText = "It's taking a little longer than usual. I'll keep working on it. Just say anything when you're ready." + pauseDuration + " I'm here whenever you need me.";
            /*const index_meanwhile = Math.floor(Math.random() * 6);
            const attributesManager = handlerInput.attributesManager;
            let attributes = await attributesManager.getPersistentAttributes() || {};
            var counter = attributes.hasOwnProperty('counter')? attributes.counter : 0;
            speakText = meanwhile[index_meanwhile] + filler_questions[counter];
            if (counter >= index_max)
            {
                counter = -1;
            }
            counter++;
            //attributes = {"counter":counter};
            attributes.counter = counter; // Update the persistent attribute
            attributesManager.setPersistentAttributes(attributes);
            await attributesManager.savePersistentAttributes();*/
            if (questionAsked || countQuestion < 2)
            {
                const STindex1 = Math.floor(Math.random() * 3);
                const STindex2 = Math.floor(Math.random() * 3);
                const STindex3 = Math.floor(Math.random() * 1);
                smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                //smallTalk = "It's taking me a bit longer. Are you still here? ";

            }
            else if (countQuestion >= 2)
            {
                if (speakOutput2.data.smallTalk.length === 0)
                {
                    const STindex1 = Math.floor(Math.random() * 3);
                    const STindex2 = Math.floor(Math.random() * 3);
                    const STindex3 = Math.floor(Math.random() * 1);
                    smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                }
                else{
                    smallTalk = speakOutput2.data.smallTalk;
                }
                //smallTalk = speakOutput2.data.smallTalk;
                countQuestion = 0;
            }
            speakText = smallTalk;
            questionAsked = true;

        }
        else{
            tryAgain = "false";
            //smallTalk = speakOutput2.data.smallTalk;
            //const index2 = Math.floor(Math.random() * 3);
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = intro[index2] + "Whenever you are ready to respond, say Alexa and proceed. " + pauseDuration + other[index3];
            repromptText = " I'm here whenever you're ready. What would you like to know? " + pauseDuration + " Feel free to ask me anything about your health.";
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = other[index3];
            //repromptText = "What else would you like to know?";
            if (questionAsked)
            {
                //const index4 = Math.floor(Math.random() * 5);
                speakText = speakOutput2.data.GPTresponse; //acknowledge[index4] +
                questionAsked = false;
            }
            else{
                smallTalk = " ";
                smallTalkResonse = " ";
                speakText = speakOutput2.data.GPTresponse;
            }
            /*if (persona === "TRUE")
            {
               return handlerInput.responseBuilder.speak(speakOutput2.data.GPTresponse).getResponse(); // notice we send an empty response
            }*/

        }
        speakText = speakText + SmallPauseDuration;


       // if (!questionAsked){
        //    speakText = speakText + pauseDuration  + " Are you still there? Should we continue?";
        //}

        return handlerInput.responseBuilder
        .speak(speakText)
        .reprompt(repromptText)
        .getResponse();

        //}
        //else{

            /*
            if (persona === "TRUE"){
                await handleMedicationReminder(handlerInput);

            }
            const index_bye = Math.floor(Math.random() * 5);
            const speakOutput = "If that's all" + bye[index_bye];
            return handlerInput.responseBuilder
                .speak(speakOutput)
                .reprompt("")
                .getResponse();*/
        //}
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'Is there something else you would like to know? Try saying chatbot before your question if you are trying to ask the voice assistant something';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent'
                || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
    },
    handle(handlerInput) {
        const speakOutput = 'Goodbye!';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .getResponse();
    }
};
/* *
 * FallbackIntent triggers when a customer says something that doesn't map to any intents in your skill
 * It must also be defined in the language model (if the locale supports it)
 * This handler can be safely added but will be ingnored in locales that do not support it yet
 * */
const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
    },
    async handle(handlerInput) {
        let startTime = Date.now();
        var speakText = 'Sorry, I don\'t know about that. Try saying echo or chatbot before your question if you are trying to ask the voice assistant something.';
        let statement ="";
        //var repromptText = 'Anything else I can help you with';
        //const index3 = Math.floor(Math.random() * 3);
        //var repromptText = other[index3];
        //if (tryAgain === "true"){
        countQuestion += 1;
        const timeoutId = setTimeout(() => {
          //console.log('API call not completed within 3 seconds. so sending a progressive call ');
          // Reject the API response promise to handle the timeout scenario
          //apiResponseReject(new Error('API call timed out'));
          // Make the API call to mark the directive as complete
             //working
            let progressiveApiResponsePromise = axios.post('https://api.amazonalexa.com/v1/directives', request, {
              headers: {
                Authorization: `Bearer ${apiAccessToken}`,
                'Content-Type': 'application/json'
              }
            })
            .then(response => {
              console.log('Directive sent successfully!');
            })
            .catch(error => {
              console.error('Error sending directive:', error);
            });

       //flagProgressiveAPI = true;


        },sayIt);
        //////////
        const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
        //let counter = 0;
        let apiResponsePromise2 = axios.post(apiUrl,"\"" + statement + "\"", {
          headers: {
            'Content-Type': 'application/json',
            accept: '*/*',
          },
        });


        //////// working code
        //progressive call

       // Get the API access token and request ID
        const apiAccessToken = handlerInput.requestEnvelope.context.System.apiAccessToken;
        const requestId = handlerInput.requestEnvelope.request.requestId;


        const index_filler = Math.floor(Math.random() * 8);
        const repromptText2 = fillers[index_filler];


       const directive = {
          type: 'VoicePlayer.Speak',
          speech: repromptText2, //+ '<break time="5s"/>' + 'still looking',
        };
        const request = {
          header: {
            requestId: requestId
          },
          directive: directive
        };
        /////////////////////////////////////

        var speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;
        let currentTime = Date.now();
        while (speakOutput2.data.GPTresponse  === "Still working on that" && currentTime-startTime < timeOut){
            tryAgain = "true";
            //counter++;
            const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
            let apiResponsePromise2 = axios.post(apiUrl, "\"" + statement + "\"", {
              headers: {
                //Authorization: authToken,
                'Content-Type': 'application/json',
                accept: '*/*',
              },
        });
        speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;
        currentTime = Date.now();
        /*if (speakOutput2.data === "Still working on that"){
            tryAgain = "true";
            speakOutput2.data= "It's taking a bit longer. Should I continue?"
        }*/
        }
        clearTimeout(timeoutId);
        //var repromptText = "";
        if (speakOutput2.data.GPTresponse  === "Still working on that"){
            tryAgain = "true";
            //repromptText = "Should I continue? " + pauseDuration + " Should I continue?";
             repromptText = "It's taking a little longer than usual. I'll keep working on it. Just say anything when you're ready." + pauseDuration + " I'm here whenever you need me.";
            /*const index_meanwhile = Math.floor(Math.random() * 6);
            const attributesManager = handlerInput.attributesManager;
            let attributes = await attributesManager.getPersistentAttributes() || {};
            var counter = attributes.hasOwnProperty('counter')? attributes.counter : 0;
            speakText = meanwhile[index_meanwhile] + filler_questions[counter];
            if (counter >= index_max)
            {
                counter = -1;
            }
            counter++;
            //attributes = {"counter":counter};
            attributes.counter = counter; // Update the persistent attribute
            attributesManager.setPersistentAttributes(attributes);
            await attributesManager.savePersistentAttributes();*/
            if (questionAsked || countQuestion < 2)
            {
                const STindex1 = Math.floor(Math.random() * 3);
                const STindex2 = Math.floor(Math.random() * 3);
                const STindex3 = Math.floor(Math.random() * 1);
                smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                //smallTalk = "It's taking me a bit longer. Are you still here? ";

            }
            else if (countQuestion >= 2)
            {
                if (speakOutput2.data.smallTalk.length === 0)
                {
                    const STindex1 = Math.floor(Math.random() * 3);
                    const STindex2 = Math.floor(Math.random() * 3);
                    const STindex3 = Math.floor(Math.random() * 1);
                    smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                }
                else{
                    smallTalk = speakOutput2.data.smallTalk;
                }
                countQuestion = 0;
            }
            speakText = smallTalk;
            questionAsked = true;

        }
        else{
            tryAgain = "false";
            //smallTalk = speakOutput2.data.smallTalk;
            //const index2 = Math.floor(Math.random() * 3);
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = intro[index2] + "Whenever you are ready to respond, say Alexa and proceed. " + pauseDuration + other[index3];
            repromptText = " I'm here whenever you're ready. What would you like to know? " + pauseDuration + " Feel free to ask me anything about your health.";
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = other[index3];
            //repromptText = "What else would you like to know?";
            if (questionAsked)
            {
                //const index4 = Math.floor(Math.random() * 5);
                speakText = speakOutput2.data.GPTresponse; //acknowledge[index4] +
                questionAsked = false;
            }
            else{
                smallTalk = " ";
                smallTalkResonse = " ";
                speakText = speakOutput2.data.GPTresponse;
            }
            /*if (persona === "TRUE")
            {
               return handlerInput.responseBuilder.speak(speakOutput2.data.GPTresponse).getResponse(); // notice we send an empty response
            }*/

        }
        speakText = speakText + SmallPauseDuration;


        //if (!questionAsked){
        //    speakText = speakText + pauseDuration  + " Are you still there? Should we continue?";
        //}

        return handlerInput.responseBuilder
            .speak(speakText) //"fallback" +
            .reprompt(repromptText)
            .getResponse();
    }
};
/* *
 * SessionEndedRequest notifies that a session was ended. This handler will be triggered when a currently open
 * session is closed for one of the following reasons: 1) The user says "exit" or "quit". 2) The user does not
 * respond or says something that does not match an intent defined in your voice model. 3) An error occurs
 * */
const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        console.log(`~~~~ Session ended: ${JSON.stringify(handlerInput.requestEnvelope)}`);
        // Any cleanup logic goes here.
        tryAgain = "false";
        followUp = "false";
        return handlerInput.responseBuilder.getResponse(); // notice we send an empty response
    }
};
/* *
 * The intent reflector is used for interaction model testing and debugging.
 * It will simply repeat the intent the user said. You can create custom handlers for your intents
 * by defining them above, then also adding them to the request handler chain below
 * */
const IntentReflectorHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
    },
    async handle(handlerInput) {
        let startTime = Date.now();
        var speakText = 'Sorry, I don\'t know about that. Try saying echo or chatbot before your question if you are trying to ask the voice assistant something.';
        let statement = " ";
        //var repromptText = 'Anything else I can help you with';
        const index3 = Math.floor(Math.random() * 3);
        //var repromptText = other[index3];
        //if (tryAgain === "true"){
        countQuestion += 1;
        const timeoutId = setTimeout(() => {
          //console.log('API call not completed within 3 seconds. so sending a progressive call ');
          // Reject the API response promise to handle the timeout scenario
          //apiResponseReject(new Error('API call timed out'));
          // Make the API call to mark the directive as complete
             //working
            let progressiveApiResponsePromise = axios.post('https://api.amazonalexa.com/v1/directives', request, {
              headers: {
                Authorization: `Bearer ${apiAccessToken}`,
                'Content-Type': 'application/json'
              }
            })
            .then(response => {
              console.log('Directive sent successfully!');
            })
            .catch(error => {
              console.error('Error sending directive:', error);
            });

       //flagProgressiveAPI = true;


        },sayIt);
        //////////
        const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
        //let counter = 0;
        let apiResponsePromise2 = axios.post(apiUrl,"\"" +  statement + "\"", {
          headers: {
            'Content-Type': 'application/json',
            accept: '*/*',
          },
        });


        //////// working code
        //progressive call

       // Get the API access token and request ID
        const apiAccessToken = handlerInput.requestEnvelope.context.System.apiAccessToken;
        const requestId = handlerInput.requestEnvelope.request.requestId;


        const index_filler = Math.floor(Math.random() * 8);
        const repromptText2 = fillers[index_filler];


       const directive = {
          type: 'VoicePlayer.Speak',
          speech: repromptText2, //+ '<break time="5s"/>' + 'still looking',
        };
        const request = {
          header: {
            requestId: requestId
          },
          directive: directive
        };
        /////////////////////////////////////

        var speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;
        let currentTime = Date.now();
        while (speakOutput2.data.GPTresponse  === "Still working on that" && currentTime-startTime < timeOut){
            tryAgain = "true";
            //counter++;
            const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
            let apiResponsePromise2 = axios.post(apiUrl, "\"" + statement + "\"", {
              headers: {
                //Authorization: authToken,
                'Content-Type': 'application/json',
                accept: '*/*',
              },
        });
        speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;
        currentTime = Date.now();
        /*if (speakOutput2.data === "Still working on that"){
            tryAgain = "true";
            speakOutput2.data= "It's taking a bit longer. Should I continue?"
        }*/
        }
        clearTimeout(timeoutId);
        //var repromptText = "";
        if (speakOutput2.data.GPTresponse  === "Still working on that"){
            tryAgain = "true";
            //repromptText = "Should I continue? " + pauseDuration + " Should I continue?";
             repromptText = "It's taking a little longer than usual. I'll keep working on it. Just say anything when you're ready." + pauseDuration + " I'm here whenever you need me.";
            /*const index_meanwhile = Math.floor(Math.random() * 6);
            const attributesManager = handlerInput.attributesManager;
            let attributes = await attributesManager.getPersistentAttributes() || {};
            var counter = attributes.hasOwnProperty('counter')? attributes.counter : 0;
            speakText = meanwhile[index_meanwhile] + filler_questions[counter];
            if (counter >= index_max)
            {
                counter = -1;
            }
            counter++;
            //attributes = {"counter":counter};
            attributes.counter = counter; // Update the persistent attribute
            attributesManager.setPersistentAttributes(attributes);
            await attributesManager.savePersistentAttributes();*/
            if (questionAsked || countQuestion < 2)
            {
                const STindex1 = Math.floor(Math.random() * 3);
                const STindex2 = Math.floor(Math.random() * 3);
                const STindex3 = Math.floor(Math.random() * 1);
                smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                //smallTalk = "It's taking me a bit longer. Are you still here? ";

            }
            else if (countQuestion >= 2)
            {
                if (speakOutput2.data.smallTalk.length === 0)
                {
                    const STindex1 = Math.floor(Math.random() * 3);
                    const STindex2 = Math.floor(Math.random() * 3);
                    const STindex3 = Math.floor(Math.random() * 1);
                    smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                }
                else{
                    smallTalk = speakOutput2.data.smallTalk;
                }
                //smallTalk = speakOutput2.data.smallTalk;
                countQuestion = 0;
            }
            speakText = smallTalk;
            questionAsked = true;

        }
        else{
            tryAgain = "false";
            //smallTalk = speakOutput2.data.smallTalk;
            //const index2 = Math.floor(Math.random() * 3);
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = intro[index2] + "Whenever you are ready to respond, say Alexa and proceed. " + pauseDuration + other[index3];
            repromptText = " I'm here whenever you're ready. What would you like to know? " + pauseDuration + " Feel free to ask me anything about your health.";
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = other[index3];
            //repromptText = "What else would you like to know?";
            if (questionAsked)
            {
                //const index4 = Math.floor(Math.random() * 5);
                speakText = speakOutput2.data.GPTresponse; //acknowledge[index4] +
                questionAsked = false;
            }
            else{
                smallTalk = " ";
                smallTalkResonse = " ";
                speakText = speakOutput2.data.GPTresponse;
            }
            /*if (persona === "TRUE")
            {
               return handlerInput.responseBuilder.speak(speakOutput2.data.GPTresponse).getResponse(); // notice we send an empty response
            }*/

        }
        speakText = speakText + SmallPauseDuration;


        //if (!questionAsked){
        //    speakText = speakText + pauseDuration  + " Are you still there? Should we continue?";
        //}

        return handlerInput.responseBuilder
            .speak(speakText) //"fallback" +
            .reprompt(repromptText)
            .getResponse();
    }
        //const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
        //const speakOutput = `You just triggered ${intentName}`;

        //return handlerInput.responseBuilder
         //   .speak(speakOutput)
            //.reprompt('add a reprompt if you want to keep the session open for the user to respond')
         //   .getResponse();
//}
};
/**
 * Generic error handling to capture any syntax or routing errors. If you receive an error
 * stating the request handler chain is not found, you have not implemented a handler for
 * the intent being invoked or included it in the skill builder below
 * */
const ErrorHandler = {
    canHandle() {
        return true;
    },
    async handle(handlerInput, error) {
        var tempError = JSON.stringify(error.message);
        //const speakOutput = 'Sorry, I had trouble doing what you asked. Please try again.' + tempError ;
        console.log(`~~~~ Error handled: ${JSON.stringify(error)}`);
        //tryAgain = "false";
        let startTime = Date.now();
        var speakText = 'Sorry, I had trouble doing what you asked. Please try again.' + tempError + 'Try saying echo or chatbot before your question if you are trying to ask the voice assistant something.';
        let statement = " ";
        //var repromptText = 'Anything else I can help you with';
        //const index3 = Math.floor(Math.random() * 3);
        //var repromptText = other[index3];
        //if (tryAgain === "true"){
        countQuestion += 1;
        const timeoutId = setTimeout(() => {
          //console.log('API call not completed within 3 seconds. so sending a progressive call ');
          // Reject the API response promise to handle the timeout scenario
          //apiResponseReject(new Error('API call timed out'));
          // Make the API call to mark the directive as complete
             //working
            let progressiveApiResponsePromise = axios.post('https://api.amazonalexa.com/v1/directives', request, {
              headers: {
                Authorization: `Bearer ${apiAccessToken}`,
                'Content-Type': 'application/json'
              }
            })
            .then(response => {
              console.log('Directive sent successfully!');
            })
            .catch(error => {
              console.error('Error sending directive:', error);
            });

       //flagProgressiveAPI = true;


        },sayIt);
        //////////
        const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
        //let counter = 0;
        let apiResponsePromise2 = axios.post(apiUrl,"\"" +  statement + "\"", {
          headers: {
            'Content-Type': 'application/json',
            accept: '*/*',
          },
        });


        //////// working code
        //progressive call

       // Get the API access token and request ID
        const apiAccessToken = handlerInput.requestEnvelope.context.System.apiAccessToken;
        const requestId = handlerInput.requestEnvelope.request.requestId;


        const index_filler = Math.floor(Math.random() * 8);
        const repromptText2 = fillers[index_filler];


       const directive = {
          type: 'VoicePlayer.Speak',
          speech: repromptText2, //+ '<break time="5s"/>' + 'still looking',
        };
        const request = {
          header: {
            requestId: requestId
          },
          directive: directive
        };
        /////////////////////////////////////

        var speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;
        let currentTime = Date.now();
        while (speakOutput2.data.GPTresponse  === "Still working on that" && currentTime-startTime < timeOut){
            tryAgain = "true";
            //counter++;
            const apiUrl = apiCall+followUp+'&tryAgain='+tryAgain;
            let apiResponsePromise2 = axios.post(apiUrl, "\"" + statement + "\"", {
              headers: {
                //Authorization: authToken,
                'Content-Type': 'application/json',
                accept: '*/*',
              },
        });
        speakOutput2 = await apiResponsePromise2;
        //smallTalk = speakOutput2.data.smallTalk;
        currentTime = Date.now();
        /*if (speakOutput2.data === "Still working on that"){
            tryAgain = "true";
            speakOutput2.data= "It's taking a bit longer. Should I continue?"
        }*/
        }
        clearTimeout(timeoutId);
        //var repromptText = "";
        if (speakOutput2.data.GPTresponse  === "Still working on that"){
            tryAgain = "true";
            //repromptText = "Should I continue? " + pauseDuration + " Should I continue?";
            repromptText = "It's taking a little longer than usual. I'll keep working on it. Just say anything when you're ready." + pauseDuration + " I'm here whenever you need me.";
            /*const index_meanwhile = Math.floor(Math.random() * 6);
            const attributesManager = handlerInput.attributesManager;
            let attributes = await attributesManager.getPersistentAttributes() || {};
            var counter = attributes.hasOwnProperty('counter')? attributes.counter : 0;
            speakText = meanwhile[index_meanwhile] + filler_questions[counter];
            if (counter >= index_max)
            {
                counter = -1;
            }
            counter++;
            //attributes = {"counter":counter};
            attributes.counter = counter; // Update the persistent attribute
            attributesManager.setPersistentAttributes(attributes);
            await attributesManager.savePersistentAttributes();*/
            if (questionAsked || countQuestion < 2)
            {
                const STindex1 = Math.floor(Math.random() * 3);
                const STindex2 = Math.floor(Math.random() * 3);
                const STindex3 = Math.floor(Math.random() * 1);
                smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                //smallTalk = "It's taking me a bit longer. Are you still here? ";

            }
            else if (countQuestion >= 2)
            {
                if (speakOutput2.data.smallTalk.length === 0)
                {
                    const STindex1 = Math.floor(Math.random() * 3);
                    const STindex2 = Math.floor(Math.random() * 3);
                    const STindex3 = Math.floor(Math.random() * 1);
                    smallTalk = smallTalkFillers1[STindex1] + smallTalkFillers2[STindex2] + smallTalkFillers3[STindex3] ;
                }
                else{
                    smallTalk = speakOutput2.data.smallTalk;
                }
                //smallTalk = speakOutput2.data.smallTalk;
                countQuestion = 0;
            }
            speakText = smallTalk;
            questionAsked = true;

        }
        else{
            tryAgain = "false";
            //smallTalk = speakOutput2.data.smallTalk;
            //const index2 = Math.floor(Math.random() * 3);
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = intro[index2] + "Whenever you are ready to respond, say Alexa and proceed. " + pauseDuration + other[index3];
            repromptText = " I'm here whenever you're ready. What would you like to know? " + pauseDuration + " Feel free to ask me anything about your health.";
            //const index3 = Math.floor(Math.random() * 3);
            //repromptText = other[index3];
            //repromptText = "What else would you like to know?";
            if (questionAsked)
            {
                //const index4 = Math.floor(Math.random() * 5);
                speakText = speakOutput2.data.GPTresponse; //acknowledge[index4] +
                questionAsked = false;
            }
            else{
                smallTalk = " ";
                smallTalkResonse = " ";
                speakText = speakOutput2.data.GPTresponse;
            }
            /*if (persona === "TRUE")
            {
               return handlerInput.responseBuilder.speak(speakOutput2.data.GPTresponse).getResponse(); // notice we send an empty response
            }*/

        }
        speakText = speakText + SmallPauseDuration;


        //if (!questionAsked){
         //   speakText = speakText + pauseDuration  + " Are you still there? Should we continue?";
        //}

        return handlerInput.responseBuilder
            .speak(speakText)
            .reprompt(repromptText)
            .getResponse();
    }
};

/**
 * This handler acts as the entry point for your skill, routing all request and response
 * payloads to the handlers above. Make sure any new handlers or interceptors you've
 * defined are included below. The order matters - they're processed top to bottom
 * */
exports.handler = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        AskChatGPTIntentHandler,
        TryAgainIntentHandler,
        NoIntentHandler,
        HelpIntentHandler,
        CancelAndStopIntentHandler,
        FallbackIntentHandler,
        SessionEndedRequestHandler,
        IntentReflectorHandler)
        //NavigateHomeIntentHandler)
    .addErrorHandlers(
        ErrorHandler)
    .withApiClient(new Alexa.DefaultApiClient())
    .withPersistenceAdapter(
        new ddbAdapter.DynamoDbPersistenceAdapter({
            tableName: process.env.DYNAMODB_PERSISTENCE_TABLE_NAME,
            createTable: false,
            dynamoDBClient: new AWS.DynamoDB({apiVersion: 'latest', region: process.env.DYNAMODB_PERSISTENCE_REGION})
        })
    )
    .lambda();
