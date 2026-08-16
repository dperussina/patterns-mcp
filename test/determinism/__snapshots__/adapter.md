# adapter

## direction=two-way

roles: core, example, test
order-adapter-example.ts: ~ const invoices
order-adapter-example.ts: ~ import "./order-adapter.js"
order-adapter-example.ts: + const toRow
order-adapter-example.ts: + function rowFor
order-adapter.test.ts: ~ const packing
order-adapter.test.ts: ~ const widgets
order-adapter.test.ts: ~ describe("andThen")
order-adapter.test.ts: ~ describe("createOrderAdapter")
order-adapter.test.ts: + const toRow
order-adapter.test.ts: + const toWidget
order-adapter.test.ts: + describe("back")
order-adapter.ts: ~ function chain
order-adapter.ts: ~ function createOrderAdapter
order-adapter.ts: ~ interface OrderAdapter

## errorMode=throw

roles: core, example, test
order-adapter-example.ts: ~ function readInvoice
order-adapter-example.ts: ~ function readInvoices
order-adapter-example.ts: ~ import "./order-adapter.js"
order-adapter.test.ts: ~ function failedFields
order-adapter.test.ts: ~ function problemsOf
order-adapter.test.ts: ~ function valueOf
order-adapter.test.ts: ~ import "./order-adapter.js"
order-adapter.test.ts: ~ import "./order-adapter.js"#2
order-adapter.test.ts: + describe("OrderAdaptError")
order-adapter.ts: ~ function chain
order-adapter.ts: ~ function describeOrderAdaptFailure
order-adapter.ts: ~ function many
order-adapter.ts: ~ function one
order-adapter.ts: ~ interface OrderAdapter
order-adapter.ts: - type OrderAdaptOutcome
order-adapter.ts: + class OrderAdaptError
order-adapter.ts: + function raise

## includeTests=false

roles: test
-file order-adapter.test.ts
