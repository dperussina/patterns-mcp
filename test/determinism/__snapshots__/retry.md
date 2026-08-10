# retry

## backoff=linear

roles: core, test
order-retry.test.ts: ~ describe("the delay schedule")
order-retry.ts: ~ const DEFAULT_ORDER_RETRY_POLICY
order-retry.ts: ~ function delayFor
order-retry.ts: ~ function retryOrder
order-retry.ts: ~ interface OrderRetryPolicy

## backoff=constant

roles: core, test
order-retry.test.ts: ~ describe("the delay schedule")
order-retry.ts: ~ const DEFAULT_ORDER_RETRY_POLICY
order-retry.ts: ~ function delayFor
order-retry.ts: ~ function retryOrder
order-retry.ts: ~ interface OrderRetryPolicy

## jitter=equal

roles: core, test
order-retry.test.ts: ~ describe("the delay schedule")
order-retry.ts: ~ function delayFor
order-retry.ts: ~ interface OrderRetryPolicy

## jitter=none

roles: core, test
order-retry.test.ts: ~ describe("the delay schedule")
order-retry.test.ts: ~ describe("the loop")
order-retry.test.ts: - function sequence
order-retry.ts: ~ function delayFor
order-retry.ts: ~ function retryOrder
order-retry.ts: ~ interface OrderRetryOptions
order-retry.ts: ~ interface OrderRetryPolicy

## cancellation=none

roles: core, example, test
order-retry-example.ts: ~ function loadProfile
order-retry.test.ts: - describe("cancellation")
order-retry.ts: ~ function delay
order-retry.ts: ~ function retryOrder
order-retry.ts: ~ interface OrderRetryOptions

## includeTests=false

roles: test
-file order-retry.test.ts
