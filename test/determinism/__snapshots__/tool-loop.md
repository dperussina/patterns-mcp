# tool-loop

## execution=sequential

roles: core, test
tool-loop.test.ts: - describe("running the calls together")
tool-loop.test.ts: + describe("running the calls in order")
tool-loop.ts: ~ function answerCalls
tool-loop.ts: ~ type JsonSchema

## onToolError=throw

roles: core, example, test
tool-loop-example.ts: ~ function handle
tool-loop-example.ts: ~ import "./tool-loop.js"
tool-loop.test.ts: ~ describe("a tool that failed")
tool-loop.test.ts: ~ describe("the transcript")
tool-loop.test.ts: ~ import "./tool-loop.js"
tool-loop.ts: ~ function answerCalls
tool-loop.ts: ~ function answerOf
tool-loop.ts: - function failedResult
tool-loop.ts: ~ function reasonOf
tool-loop.ts: ~ function runToolLoop
tool-loop.ts: ~ type JsonSchema
tool-loop.ts: + class ToolFailedError

## stopConditions=false

roles: core, example, test
tool-loop-example.ts: ~ function handle
tool-loop-example.ts: ~ function requestFor
tool-loop-example.ts: ~ import "./tool-loop.js"
tool-loop.test.ts: - describe("stopping early")
tool-loop.test.ts: ~ describe("the ways a run ends")
tool-loop.test.ts: ~ import "./tool-loop.js"
tool-loop.ts: - function hasToolCall
tool-loop.ts: - function repeatedCall
tool-loop.ts: ~ function runToolLoop
tool-loop.ts: - function tokenBudget
tool-loop.ts: ~ interface ToolLoopRequest
tool-loop.ts: - type StopCondition
tool-loop.ts: ~ type StopReason

## includeTests=false

roles: test
-file tool-loop.test.ts
