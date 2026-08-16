# unit-of-work

## tracking=snapshot

roles: core, example, test
order-collection-example.ts: ~ function abandonOrder
order-collection-example.ts: ~ function refusesImpossibleChanges
order-collection-example.ts: ~ function settleOrders
order-collection-example.ts: ~ interface Order
order-collection.test.ts: ~ describe("one transaction, or none of it")
order-collection.test.ts: ~ describe("what a change is")
order-collection.test.ts: ~ describe("what it refuses")
order-collection.test.ts: ~ function change
order-collection.test.ts: ~ function statusOf
order-collection.test.ts: ~ function totalOf
order-collection.test.ts: ~ import "./unit-of-work-core.js"
unit-of-work-core.ts: - class RemovedRecordError
unit-of-work-core.ts: ~ class UnitOfWork
unit-of-work-core.ts: ~ function operationFor
unit-of-work-core.ts: ~ interface Registration
unit-of-work-core.ts: ~ interface Tracked
unit-of-work-core.ts: ~ type Fields
unit-of-work-core.ts: - type Patch
unit-of-work-core.ts: + class KeyChangedError
unit-of-work-core.ts: + function assertKeyIntact
unit-of-work-core.ts: + function changedFields
unit-of-work-core.ts: + type Draft

## concurrency=none

roles: binding, core, example, test
order-collection-example.ts: ~ function demonstrate
order-collection-example.ts: - function refusesASuppliedVersion
order-collection-example.ts: ~ interface Order
order-collection.test.ts: ~ describe("one transaction, or none of it")
order-collection.test.ts: ~ function seeded
order-collection.test.ts: ~ import "./unit-of-work-core.js"
order-collection.ts: ~ import "./unit-of-work-core.js"
order-collection.ts: ~ interface OrderRecord
order-collection.ts: ~ interface OrderTracking
unit-of-work-core.ts: - class ConcurrencyError
unit-of-work-core.ts: ~ class UnitOfWork
unit-of-work-core.ts: ~ function createMemoryStore
unit-of-work-core.ts: ~ function operationFor
unit-of-work-core.ts: ~ interface Registration
unit-of-work-core.ts: - interface Versioned
unit-of-work-core.ts: ~ type Fields
unit-of-work-core.ts: - type NewRecord
unit-of-work-core.ts: ~ type Operation
unit-of-work-core.ts: ~ type Patch
unit-of-work-core.ts: ~ type Storable

## emitScope=core-only

roles: binding, example, test
+file unit-of-work-core-example.ts
+file unit-of-work-core.test.ts
-file order-collection-example.ts
-file order-collection.test.ts
-file order-collection.ts

## emitScope=binding-only

refused: missing_required_option

## includeTests=false

roles: test
-file order-collection.test.ts
