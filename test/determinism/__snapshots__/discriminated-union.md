# discriminated-union

## dispatch=record

roles: core, example, test
order-event-example.ts: ~ function notify
order-event-example.ts: - function refusesAnIncompleteSwitch
order-event-example.ts: ~ import "./order-event.js"
order-event-example.ts: + function refusesAnIncompleteDispatch
order-event.test-d.ts: ~ import "./order-event.js"
order-event.test-d.ts: ~ import "./order-event.js"#2
order-event.test-d.ts: ~ type KindsAreTheTags
order-event.test-d.ts: + function handlerParameters
order-event.test.ts: ~ describe("a value from outside the type system")
order-event.test.ts: ~ import "./order-event.js"
order-event.ts: - function assertNever
order-event.ts: ~ function summarise
order-event.ts: ~ type OrderEventKind
order-event.ts: + function match
order-event.ts: + type OrderEventHandlers

## guards=false

roles: core, example, test
order-event-example.ts: - function carriers
order-event-example.ts: ~ import "./order-event.js"
order-event.test-d.ts: - function shippedOnly
order-event.test-d.ts: ~ import "./order-event.js"
order-event.test-d.ts: - type PredicateNarrowsAnArray
order-event.test.ts: - describe("the predicates")
order-event.test.ts: ~ import "./order-event.js"
order-event.ts: - function isOrderCancelled
order-event.ts: - function isOrderPlaced
order-event.ts: - function isOrderShipped

## includeTests=false

roles: test
-file order-event.test-d.ts
-file order-event.test.ts
