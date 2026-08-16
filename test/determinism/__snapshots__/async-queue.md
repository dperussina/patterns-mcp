# async-queue

## ordering=priority

roles: core, example, test
order-queue-example.ts: ~ function indexAll
order-queue.test.ts: ~ describe("OrderQueue ordering")
order-queue.ts: ~ class OrderQueue
order-queue.ts: ~ interface OrderQueueEntry

## bounded=true

roles: core, example, test
order-queue-example.ts: ~ function indexAll
order-queue-example.ts: ~ import "./order-queue.js"
order-queue.test.ts: ~ describe("OrderQueue draining")
order-queue.test.ts: ~ describe("OrderQueue failures")
order-queue.test.ts: ~ describe("OrderQueue ordering")
order-queue.test.ts: ~ describe("OrderQueue")
order-queue.test.ts: ~ import "./order-queue.js"
order-queue.test.ts: ~ import "vitest"
order-queue.test.ts: + describe("OrderQueue backlog")
order-queue.ts: ~ class OrderQueue
order-queue.ts: ~ interface OrderQueueSnapshot
order-queue.ts: + class OrderQueueFullError

## failures=sink

roles: core, example, test
order-queue-example.ts: ~ function indexAll
order-queue.test.ts: ~ describe("OrderQueue draining")
order-queue.test.ts: ~ describe("OrderQueue failures")
order-queue.test.ts: ~ describe("OrderQueue ordering")
order-queue.test.ts: ~ describe("OrderQueue")
order-queue.test.ts: + const reported
order-queue.test.ts: + const sink
order-queue.ts: ~ class OrderQueue

## includeTests=false

roles: test
-file order-queue.test.ts
