# stream-accumulator

## truncation=report

roles: core, example, test
stream-accumulator-example.ts: ~ function showStreamedAnswer
stream-accumulator-example.ts: ~ import "./stream-accumulator.js"
stream-accumulator.test.ts: ~ describe("a stream that stopped early")
stream-accumulator.test.ts: ~ import "./stream-accumulator.js"
stream-accumulator.ts: - class TruncatedStreamError
stream-accumulator.ts: ~ function accumulateStream
stream-accumulator.ts: ~ type FinishReason

## progress=false

roles: core, example, test
stream-accumulator-example.ts: ~ function showStreamedAnswer
stream-accumulator-example.ts: ~ import "./stream-accumulator.js"#2
stream-accumulator.test.ts: - describe("watching it arrive")
stream-accumulator.test.ts: ~ import "./stream-accumulator.js"#2
stream-accumulator.ts: ~ function accumulateStream
stream-accumulator.ts: - function snapshotOf
stream-accumulator.ts: ~ interface AccumulateOptions
stream-accumulator.ts: - interface SnapshotCall
stream-accumulator.ts: - interface StreamSnapshot

## includeTests=false

roles: test
-file stream-accumulator.test.ts
