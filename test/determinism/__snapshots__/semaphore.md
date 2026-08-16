# semaphore

## cancellation=none

roles: core, example, test
order-semaphore-example.ts: ~ function uploadAll
order-semaphore.test.ts: - describe("OrderSemaphore cancellation")
order-semaphore.test.ts: ~ import "./order-semaphore.js"
order-semaphore.ts: ~ class OrderSemaphore
order-semaphore.ts: - class OrderSemaphoreAbortedError
order-semaphore.ts: ~ interface Waiter

## weighted=true

roles: core, example, test
order-semaphore-example.ts: ~ function uploadAll
order-semaphore-example.ts: ~ interface Upload
order-semaphore.test.ts: ~ describe("OrderSemaphore cancellation")
order-semaphore.test.ts: ~ describe("OrderSemaphore ordering")
order-semaphore.test.ts: ~ describe("OrderSemaphore permits")
order-semaphore.test.ts: ~ describe("OrderSemaphore")
order-semaphore.test.ts: + describe("OrderSemaphore weights")
order-semaphore.ts: ~ class OrderSemaphore
order-semaphore.ts: ~ interface Waiter

## includeTests=false

roles: test
-file order-semaphore.test.ts
