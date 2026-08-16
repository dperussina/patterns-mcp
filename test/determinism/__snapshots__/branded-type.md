# branded-type

## base=number

roles: core, example, test
+file order-quantity-example.ts
+file order-quantity.test-d.ts
+file order-quantity.test.ts
+file order-quantity.ts
-file order-id-example.ts
-file order-id.test-d.ts
-file order-id.test.ts
-file order-id.ts

## construction=result

roles: core, example, test
order-id-example.ts: ~ function fromRequest
order-id-example.ts: ~ import "./order-id.js"#2
order-id.test-d.ts: - type ConstructorReturnsTheBrand
order-id.test-d.ts: + type ConstructorCarriesTheBrand
order-id.test.ts: ~ describe("orderId")
order-id.ts: ~ function orderId
order-id.ts: + interface OrderIdProblem
order-id.ts: + type OrderIdResult

## construction=cast

roles: core, example, test
order-id-example.ts: - function fromRequest
order-id-example.ts: ~ function fromStore
order-id-example.ts: - function refusesAnUncheckedValue
order-id-example.ts: ~ import "./order-id.js"
order-id.test-d.ts: - function narrows
order-id.test-d.ts: ~ import "./order-id.js"
order-id.test-d.ts: - import "./order-id.js"#2
order-id.test-d.ts: - type ConstructorReturnsTheBrand
order-id.test-d.ts: - type GuardNarrows
order-id.test.ts: - describe("orderId")
order-id.test.ts: ~ import "./order-id.js"
order-id.test.ts: ~ import "vitest"
order-id.ts: - function isOrderId
order-id.ts: - function orderId
order-id.ts: ~ function unsafeOrderId

## includeTests=false

roles: test
-file order-id.test-d.ts
-file order-id.test.ts
