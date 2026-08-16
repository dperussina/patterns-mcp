# parse-dont-validate

## errors=first

roles: core, example, test
parse-order-example.ts: ~ function handle
parse-order-example.ts: ~ function report
parse-order.test-d.ts: ~ import "./parse-order.js"#2
parse-order.test-d.ts: - type FailureIsNonEmpty
parse-order.test.ts: - describe("accumulating")
parse-order.test.ts: ~ describe("what it refuses, and where it says the problem is")
parse-order.test.ts: + describe("stopping at the first problem")
parse-order.ts: ~ function nonEmptyArrayOf
parse-order.ts: ~ function record
parse-order.ts: ~ function reject
parse-order.ts: ~ type OrderParseResult

## combinators=false

roles: core
parse-order.ts: - const orderFields
parse-order.ts: - const orderId
parse-order.ts: - const orderQuantity
parse-order.ts: - const text
parse-order.ts: - function nonEmptyArrayOf
parse-order.ts: ~ function parseOrder
parse-order.ts: - function record
parse-order.ts: ~ function succeed
parse-order.ts: ~ interface OrderProblem
parse-order.ts: - type OrderParser
parse-order.ts: - type Parsed
parse-order.ts: - type ParsedOrder
parse-order.ts: + function othersOf
parse-order.ts: + function parseId
parse-order.ts: + function parseLines
parse-order.ts: + function parseQuantity
parse-order.ts: + interface ParsedOrder

## includeTests=false

roles: test
-file parse-order.test-d.ts
-file parse-order.test.ts
