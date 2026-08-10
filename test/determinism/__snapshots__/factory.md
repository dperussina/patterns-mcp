# factory

## registration=dynamic

roles: core, example, test
order-factory-example.ts: + const withOvernight
order-factory-example.ts: + function cutoffHour
order-factory-example.ts: + interface OvernightShipment
order-factory.test.ts: ~ describe("createOrderFactory")
order-factory.ts: ~ function createOrderFactory
order-factory.ts: ~ interface OrderFactory

## errorMode=throw

roles: core, example, test
order-factory-example.ts: ~ function describe
order-factory-example.ts: ~ import "./order-factory.js"
order-factory.test.ts: ~ describe("createOrderFactory")
order-factory.test.ts: ~ import "./order-factory.js"
order-factory.ts: ~ function createOrderFactory
order-factory.ts: ~ interface OrderFactory
order-factory.ts: - type OrderOutcome
order-factory.ts: + class UnknownOrderKindError

## context=true

roles: core, example, test
order-factory-example.ts: ~ const shipments
order-factory-example.ts: + interface ShipmentRates
order-factory.test.ts: ~ describe("createOrderFactory")
order-factory.test.ts: ~ function build
order-factory.test.ts: + interface Deps
order-factory.ts: ~ function createOrderFactory
order-factory.ts: ~ interface OrderFactory
order-factory.ts: ~ type OrderCreator
order-factory.ts: ~ type OrderCreators

## includeTests=false

roles: test
-file order-factory.test.ts
