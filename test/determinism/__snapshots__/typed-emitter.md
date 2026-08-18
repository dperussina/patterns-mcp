# typed-emitter

## dispatch=async

roles: core, example, test
order-emitter-example.ts: ~ function record
order-emitter-example.ts: ~ function refusesAMistypedPayload
order-emitter-example.ts: ~ function refusesAnIncompletePayload
order-emitter-example.ts: ~ function refusesAnUnknownEvent
order-emitter.test-d.ts: ~ type EmitReturns
order-emitter.test.ts: ~ describe("a failing subscriber")
order-emitter.test.ts: ~ describe("a registry changed while it is being read")
order-emitter.test.ts: ~ describe("once")
order-emitter.test.ts: ~ describe("subscribing and emitting")
order-emitter.test.ts: ~ describe("unsubscribing")
order-emitter.ts: ~ class TypedEmitter
order-emitter.ts: ~ type EventHandler

## errors=propagate

roles: core, example, test
order-emitter-example.ts: ~ const orders
order-emitter-example.ts: - function refusesAMissingErrorSink
order-emitter-example.ts: - function report
order-emitter-example.ts: - import "./order-emitter.js"#2
order-emitter-example.ts: + function refusesAnErrorSink
order-emitter.test.ts: ~ describe("a failing subscriber")
order-emitter.test.ts: - function collector
order-emitter.test.ts: ~ function emitter
order-emitter.test.ts: + function failureOf
order-emitter.ts: ~ class TypedEmitter
order-emitter.ts: - interface EmitterOptions

## includeTests=false

roles: test
-file order-emitter.test-d.ts
-file order-emitter.test.ts
