const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXECUTOR_TEXT_FORMAT,
  PLANNER_TEXT_FORMAT,
} = require("../agentConfigs");

function collectObjectSchemaViolations(schema, rootLabel) {
  const violations = [];

  function visit(node, path) {
    if (!node || typeof node !== "object") return;

    const type = node.type;
    const hasProperties = node.properties && typeof node.properties === "object";
    const isObjectSchema = type === "object"
      || (Array.isArray(type) && type.includes("object"))
      || hasProperties;

    if (isObjectSchema && node.additionalProperties !== false) {
      violations.push(path || rootLabel);
    }

    if (hasProperties) {
      Object.entries(node.properties).forEach(([key, child]) => {
        visit(child, `${path}.properties.${key}`);
      });
    }

    if (node.items) {
      if (Array.isArray(node.items)) {
        node.items.forEach((child, idx) => visit(child, `${path}.items[${idx}]`));
      } else {
        visit(node.items, `${path}.items`);
      }
    }

    ["oneOf", "anyOf", "allOf"].forEach((keyword) => {
      const entries = node[keyword];
      if (Array.isArray(entries)) {
        entries.forEach((child, idx) => visit(child, `${path}.${keyword}[${idx}]`));
      }
    });

    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      visit(node.additionalProperties, `${path}.additionalProperties`);
    }

    if (node.patternProperties && typeof node.patternProperties === "object") {
      Object.entries(node.patternProperties).forEach(([key, child]) => {
        visit(child, `${path}.patternProperties.${key}`);
      });
    }

    if (node.definitions && typeof node.definitions === "object") {
      Object.entries(node.definitions).forEach(([key, child]) => {
        visit(child, `${path}.definitions.${key}`);
      });
    }

    if (node.$defs && typeof node.$defs === "object") {
      Object.entries(node.$defs).forEach(([key, child]) => {
        visit(child, `${path}.$defs.${key}`);
      });
    }
  }

  visit(schema, rootLabel);
  return violations;
}

test("planner/executor schemas require additionalProperties: false on object nodes", () => {
  const executorViolations = collectObjectSchemaViolations(EXECUTOR_TEXT_FORMAT.schema, "executor");
  const plannerViolations = collectObjectSchemaViolations(PLANNER_TEXT_FORMAT.schema, "planner");

  assert.equal(
    executorViolations.length,
    0,
    `Executor schema missing additionalProperties: false at ${executorViolations.join(", ")}`
  );
  assert.equal(
    plannerViolations.length,
    0,
    `Planner schema missing additionalProperties: false at ${plannerViolations.join(", ")}`
  );
});

test("executor chart_spec.option is stringified JSON", () => {
  const optionSchema =
    EXECUTOR_TEXT_FORMAT.schema?.properties?.chart_spec?.properties?.option || null;
  assert.equal(optionSchema?.type, "string");
});
