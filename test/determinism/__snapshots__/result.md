# result

## includeTests=false

roles: test
-file order-result.test.ts

## includeAsync=false

roles: core
order-result.ts: - function andThenAsync
order-result.ts: - function fromPromise
order-result.ts: - function mapAsync

## includeCollections=false

roles: core, test
order-result.test.ts: - describe("OrderResult collections")
order-result.test.ts: ~ import "./order-result.js"
order-result.ts: - function all
order-result.ts: - function partition
