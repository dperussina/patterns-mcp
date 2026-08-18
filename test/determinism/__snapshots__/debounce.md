# debounce

## edge=leading

roles: core, test
order-debounce.test.ts: ~ describe("debounceOrder controls")
order-debounce.test.ts: ~ describe("debounceOrder results")
order-debounce.test.ts: ~ describe("debounceOrder")
order-debounce.test.ts: ~ import "./order-debounce.js"
order-debounce.ts: ~ function debounceOrder

## edge=both

roles: core, test
order-debounce.test.ts: ~ describe("debounceOrder controls")
order-debounce.test.ts: ~ describe("debounceOrder results")
order-debounce.test.ts: ~ describe("debounceOrder")
order-debounce.ts: ~ function debounceOrder

## result=void

roles: core, example, test
order-debounce-example.ts: ~ function searchAsYouType
order-debounce-example.ts: ~ import "./order-debounce.js"
order-debounce.test.ts: ~ describe("debounceOrder arguments")
order-debounce.test.ts: ~ describe("debounceOrder controls")
order-debounce.test.ts: - describe("debounceOrder results")
order-debounce.test.ts: ~ describe("debounceOrder")
order-debounce.test.ts: ~ function harness
order-debounce.test.ts: - function ignore
order-debounce.test.ts: ~ import "./order-debounce.js"
order-debounce.test.ts: + describe("debounceOrder failures")
order-debounce.ts: - class OrderDebounceCancelledError
order-debounce.ts: ~ function debounceOrder
order-debounce.ts: ~ interface OrderDebounceOptions
order-debounce.ts: ~ interface OrderDebounced
order-debounce.ts: - interface Settler

## maxWait=true

roles: core, example, test
order-debounce-example.ts: ~ function searchAsYouType
order-debounce.test.ts: ~ describe("debounceOrder arguments")
order-debounce.test.ts: ~ describe("debounceOrder results")
order-debounce.test.ts: ~ function harness
order-debounce.test.ts: + describe("debounceOrder ceiling")
order-debounce.ts: ~ function debounceOrder
order-debounce.ts: ~ interface OrderDebounceOptions

## includeTests=false

roles: test
-file order-debounce.test.ts
