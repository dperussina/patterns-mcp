# gateway

## transport=port-only

roles: adapter, example
-file order-gateway-fetch.ts
order-gateway-example.ts: ~ const invoices
order-gateway-example.ts: - import "./order-gateway-fetch.js"
order-gateway-example.ts: ~ import "./order-gateway.js"#2
order-gateway-example.ts: + const client

## errorMode=throw

roles: core, example, test
order-gateway-example.ts: ~ function currentTotalCents
order-gateway-example.ts: ~ function loadInvoice
order-gateway-example.ts: ~ function raiseInvoice
order-gateway-example.ts: ~ import "./order-gateway.js"
order-gateway.test.ts: ~ describe("createOrderGateway")
order-gateway.test.ts: ~ describe("failures")
order-gateway.test.ts: ~ function failureOf
order-gateway.test.ts: ~ function failureOfKind
order-gateway.test.ts: ~ function valueOf
order-gateway.test.ts: ~ import "./order-gateway.js"
order-gateway.test.ts: ~ import "./order-gateway.js"#2
order-gateway.ts: ~ function createOrderGateway
order-gateway.ts: ~ function describeOrderGatewayFailure
order-gateway.ts: ~ interface OrderGateway
order-gateway.ts: - type OrderCallOutcome
order-gateway.ts: + class OrderGatewayError

## cancellation=none

roles: adapter, core, example, test
order-gateway-example.ts: ~ const invoices
order-gateway-example.ts: ~ function retryable
order-gateway-fetch.ts: ~ function createOrderFetchTransport
order-gateway.test.ts: ~ describe("failures")
order-gateway.ts: - function classify
order-gateway.ts: ~ function createOrderGateway
order-gateway.ts: ~ function describeOrderGatewayFailure
order-gateway.ts: - function startDeadline
order-gateway.ts: - interface Deadline
order-gateway.ts: ~ interface OrderCallOptions
order-gateway.ts: ~ interface OrderGatewayConfig
order-gateway.ts: ~ type OrderGatewayFailure
order-gateway.ts: ~ type OrderTransport

## includeTests=false

roles: test
-file order-gateway.test.ts
