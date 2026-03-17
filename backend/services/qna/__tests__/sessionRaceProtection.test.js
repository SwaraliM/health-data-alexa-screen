const test = require("node:test");
const assert = require("node:assert/strict");

const sessionService = require("../sessionService");

function resetUser(username = "amy") {
  sessionService.clearSessionState(username);
}

test.beforeEach(() => {
  resetUser("amy");
});

test("beginRequest tracks latest request and flags overlap", () => {
  const first = sessionService.beginRequest({
    username: "amy",
    source: "alexa",
    requestKey: "req_1",
  });
  assert.equal(first.ok, true);
  assert.equal(first.concurrentDetected, false);

  const second = sessionService.beginRequest({
    username: "amy",
    source: "web",
    requestKey: "req_2",
  });
  assert.equal(second.ok, true);
  assert.equal(second.concurrentDetected, true);

  const state = sessionService.getActiveSessionState("amy");
  assert.equal(state.latestRequestKey, "req_2");
  assert.equal(state.activeRequestCount >= 1, true);
});

test("isCurrentRequest enforces request ownership per user and bundle", () => {
  sessionService.beginRequest({
    username: "amy",
    source: "alexa",
    requestKey: "req_a",
  });
  sessionService.setRequestBundleOwnership({
    username: "amy",
    requestKey: "req_a",
    bundleId: "bundle_1",
  });

  assert.equal(sessionService.isCurrentRequest({
    username: "amy",
    requestKey: "req_a",
    bundleId: "bundle_1",
  }), true);

  sessionService.beginRequest({
    username: "amy",
    source: "alexa",
    requestKey: "req_b",
  });
  sessionService.setRequestBundleOwnership({
    username: "amy",
    requestKey: "req_b",
    bundleId: "bundle_1",
  });

  assert.equal(sessionService.isCurrentRequest({
    username: "amy",
    requestKey: "req_a",
    bundleId: "bundle_1",
  }), false);
  assert.equal(sessionService.isCurrentRequest({
    username: "amy",
    requestKey: "req_b",
    bundleId: "bundle_1",
  }), true);
});

test("endRequest clears active request tracking without dropping latest key", () => {
  sessionService.beginRequest({
    username: "amy",
    source: "alexa",
    requestKey: "req_3",
  });
  sessionService.endRequest({
    username: "amy",
    requestKey: "req_3",
    status: "completed",
    bundleId: "bundle_3",
  });

  const state = sessionService.getActiveSessionState("amy");
  assert.equal(state.activeRequestCount, 0);
  assert.equal(state.latestRequestKey, "req_3");
});
