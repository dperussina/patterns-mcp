# token-bucket

## waiting=wait

roles: core, example, test
order-token-bucket-example.ts: - function admit
order-token-bucket-example.ts: ~ import "./order-token-bucket.js"
order-token-bucket-example.ts: - interface Decision
order-token-bucket-example.ts: + function throttled
order-token-bucket.test.ts: ~ describe("OrderTokenBucket arguments")
order-token-bucket.test.ts: ~ describe("OrderTokenBucket retry advice")
order-token-bucket.test.ts: ~ describe("OrderTokenBucket")
order-token-bucket.test.ts: ~ function clock
order-token-bucket.test.ts: ~ import "./order-token-bucket.js"
order-token-bucket.test.ts: ~ import "vitest"
order-token-bucket.test.ts: ~ interface TestClock
order-token-bucket.test.ts: + describe("OrderTokenBucket cancellation")
order-token-bucket.test.ts: + describe("OrderTokenBucket order")
order-token-bucket.test.ts: + function drain
order-token-bucket.ts: ~ class OrderTokenBucket
order-token-bucket.ts: ~ const orderSystemClock
order-token-bucket.ts: ~ interface OrderTokenBucketClock
order-token-bucket.ts: + class OrderTokenWaitAbortedError
order-token-bucket.ts: + interface Waiter

## keyed=true

roles: core, example, test
order-token-bucket-example.ts: ~ function admit
order-token-bucket-example.ts: ~ import "./order-token-bucket.js"
order-token-bucket.test.ts: - describe("OrderTokenBucket arguments")
order-token-bucket.test.ts: - describe("OrderTokenBucket retry advice")
order-token-bucket.test.ts: - describe("OrderTokenBucket")
order-token-bucket.test.ts: ~ function harness
order-token-bucket.test.ts: ~ import "./order-token-bucket.js"
order-token-bucket.test.ts: + describe("OrderKeyedTokenBucket arguments")
order-token-bucket.test.ts: + describe("OrderKeyedTokenBucket keys")
order-token-bucket.test.ts: + describe("OrderKeyedTokenBucket retry advice")
order-token-bucket.test.ts: + describe("OrderKeyedTokenBucket")
order-token-bucket.ts: - class OrderTokenBucket
order-token-bucket.ts: ~ interface OrderTokenBucketOptions
order-token-bucket.ts: + class Bucket
order-token-bucket.ts: + class OrderKeyedTokenBucket
order-token-bucket.ts: + const INITIAL_SWEEP_AT

## includeTests=false

roles: test
-file order-token-bucket.test.ts
