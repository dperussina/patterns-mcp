# decorator

## dispatch=proxy

roles: core, example, test
order-decorator-example.ts: - const ledgerMethods
order-decorator-example.ts: ~ function auditedLedger
order-decorator-example.ts: ~ import "./order-decorator.js"#2
order-decorator-example.ts: + function passesThroughData
order-decorator.test.ts: - const counterMethods
order-decorator.test.ts: ~ describe("layerOrderDecorations")
order-decorator.test.ts: ~ function build
order-decorator.test.ts: ~ import "./order-decorator.js"#2
order-decorator.ts: ~ function decorateOrder
order-decorator.ts: - function memberNames
order-decorator.ts: - type OrderMethods

## stacking=false

roles: core, example, test
order-decorator-example.ts: ~ function auditedLedger
order-decorator-example.ts: - function authorising
order-decorator-example.ts: ~ import "./order-decorator.js"
order-decorator.test.ts: - describe("layerOrderDecorations")
order-decorator.test.ts: ~ import "./order-decorator.js"
order-decorator.ts: - function layerOrderDecorations

## includeTests=false

roles: test
-file order-decorator.test.ts
