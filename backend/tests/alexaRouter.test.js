const test = require("node:test");
const assert = require("node:assert/strict");

const alexaRouter = require("../routers/alexaRouter");

const testHooks = alexaRouter._test;

function createPayload(voiceAnswer) {
  return {
    answer_ready: true,
    voice_answer_source: "gpt",
    voice_answer: voiceAnswer,
    spoken_answer: voiceAnswer,
    summary: {
      shortSpeech: voiceAnswer,
      shortText: voiceAnswer,
    },
  };
}

function createRes() {
  return {
    body: null,
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };
}

test.beforeEach(() => {
  testHooks.resetState();
});

test("resume_pending resolves the active pending job by username", async () => {
  testHooks.qnaJobs.set("req-pending", {
    requestId: "req-pending",
    username: "amy",
    question: "How did I sleep?",
    status: "pending",
    result: null,
    visualPayload: null,
    error: null,
  });
  testHooks.setResumableJob("amy", {
    requestId: "req-pending",
    status: "pending",
    delivered: false,
  });

  const res = createRes();
  await testHooks.handleControl("amy", {
    type: "control",
    action: "resume_pending",
  }, res);

  assert.equal(res.body.status, "pending");
  assert.equal(res.body.requestId, "req-pending");
  assert.equal(res.body.answer_ready, false);
  assert.equal(res.body.voice_answer, "");
});

test("resume_pending returns a ready answer once and then reports nothing pending", async () => {
  const payload = createPayload("Your sleep answer is ready.");
  testHooks.qnaJobs.set("req-ready", {
    requestId: "req-ready",
    username: "amy",
    question: "How did I sleep?",
    status: "ready",
    result: payload,
    visualPayload: payload,
    error: null,
  });
  testHooks.setResumableJob("amy", {
    requestId: "req-ready",
    status: "ready",
    delivered: false,
  });

  const firstRes = createRes();
  await testHooks.handleControl("amy", {
    type: "control",
    action: "resume_pending",
  }, firstRes);

  assert.equal(firstRes.body.status, "ready");
  assert.equal(firstRes.body.answer_ready, true);
  assert.equal(firstRes.body.voice_answer, "Your sleep answer is ready.");
  assert.equal(testHooks.getResumableJob("amy"), null);

  const secondRes = createRes();
  await testHooks.handleControl("amy", {
    type: "control",
    action: "resume_pending",
  }, secondRes);

  assert.equal(secondRes.body.status, "error");
  assert.equal(secondRes.body.answer_ready, false);
  assert.match(secondRes.body.voice_answer, /no pending answer right now/i);
});

test("poll_pending clears a ready answer so continue does not replay it", async () => {
  const payload = createPayload("This answer was already spoken.");
  testHooks.qnaJobs.set("req-spoken", {
    requestId: "req-spoken",
    username: "amy",
    question: "How did I sleep?",
    status: "ready",
    result: payload,
    visualPayload: payload,
    error: null,
  });
  testHooks.setResumableJob("amy", {
    requestId: "req-spoken",
    status: "ready",
    delivered: false,
  });

  const pollRes = createRes();
  await testHooks.handleControl("amy", {
    type: "control",
    action: "poll_pending",
    requestId: "req-spoken",
  }, pollRes);

  assert.equal(pollRes.body.status, "ready");
  assert.equal(pollRes.body.answer_ready, true);
  assert.equal(testHooks.getResumableJob("amy"), null);

  const resumeRes = createRes();
  await testHooks.handleControl("amy", {
    type: "control",
    action: "resume_pending",
  }, resumeRes);

  assert.equal(resumeRes.body.status, "error");
  assert.match(resumeRes.body.voice_answer, /no pending answer right now/i);
});

test("resume_pending rejects a stale requestId when a newer active job has replaced it", async () => {
  const oldPayload = createPayload("Old answer.");
  testHooks.qnaJobs.set("req-old", {
    requestId: "req-old",
    username: "amy",
    question: "Old question",
    status: "ready",
    result: oldPayload,
    visualPayload: oldPayload,
    error: null,
  });
  testHooks.qnaJobs.set("req-new", {
    requestId: "req-new",
    username: "amy",
    question: "New question",
    status: "pending",
    result: null,
    visualPayload: null,
    error: null,
  });
  testHooks.setResumableJob("amy", {
    requestId: "req-new",
    status: "pending",
    delivered: false,
  });

  const res = createRes();
  await testHooks.handleControl("amy", {
    type: "control",
    action: "resume_pending",
    requestId: "req-old",
  }, res);

  assert.equal(res.body.status, "error");
  assert.match(res.body.voice_answer, /no pending answer right now/i);
});
