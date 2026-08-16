# typestate

## representation=distinct

roles: core, example, test
order-state-example.ts: ~ function addIfStillOpen
order-state-example.ts: ~ function describe
order-state-example.ts: ~ function refundIfSettled
order-state-example.ts: - function refusesADetachedOperation
order-state-example.ts: ~ function refusesAddingAfterSubmission
order-state-example.ts: ~ function refusesCrossStateAssignment
order-state-example.ts: - function refusesFabricatingAState
order-state-example.ts: ~ function refusesRefundingBeforePayment
order-state-example.ts: ~ function refusesSkippingAState
order-state-example.ts: ~ function settle
order-state-example.ts: ~ function theSameValueTwice
order-state-example.ts: ~ import "./order-state.js"
order-state-example.ts: ~ import "./order-state.js"#2
order-state.test-d.ts: - function narrowingReachesTheOperations
order-state.test-d.ts: ~ import "./order-state.js"
order-state.test-d.ts: ~ import "./order-state.js"#2
order-state.test-d.ts: ~ type EveryStateBelongsToAnyOrder
order-state.test-d.ts: ~ type OrderDraftIsNotOrderSubmitted
order-state.test-d.ts: ~ type OrderSubmittedIsNotOrderDraft
order-state.test-d.ts: ~ type PayArrives
order-state.test-d.ts: ~ type SubmitArrives
order-state.test.ts: ~ describe("a superseded value")
order-state.test.ts: ~ describe("the workflow")
order-state.test.ts: ~ import "./order-state.js"
order-state.ts: - class Order
order-state.ts: ~ type AnyOrder
order-state.ts: ~ type OrderState
order-state.ts: + function add
order-state.ts: + function count
order-state.ts: + function draft
order-state.ts: + function pay
order-state.ts: + function refund
order-state.ts: + function submit
order-state.ts: + interface OrderDraft
order-state.ts: + interface OrderPaid
order-state.ts: + interface OrderSubmitted

## staleGuard=false

roles: core, example, test
order-state-example.ts: ~ function theSameValueTwice
order-state.test.ts: - describe("a superseded value")
order-state.test.ts: ~ import "./order-state.js"
order-state.test.ts: ~ import "vitest"
order-state.test.ts: + describe("without the stale guard")
order-state.ts: ~ class Order
order-state.ts: - class StaleOrderError
order-state.ts: - const consumed
order-state.ts: - function take

## includeTests=false

roles: test
-file order-state.test-d.ts
-file order-state.test.ts
