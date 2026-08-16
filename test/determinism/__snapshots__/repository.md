# repository

## pagination=offset

roles: core, example, test
order-repository-example.ts: ~ function openOrders
order-repository.test.ts: ~ describe("paging")
repository-core.ts: ~ const COMPARISON
repository-core.ts: ~ function createMemoryStore
repository-core.ts: ~ function createRepository
repository-core.ts: ~ interface ListOptions
repository-core.ts: ~ interface Page
repository-core.ts: ~ interface StoreQuery

## pagination=none

roles: core, example, test
order-repository-example.ts: ~ function openOrders
order-repository.test.ts: ~ describe("filtering")
order-repository.test.ts: - describe("paging")
order-repository.test.ts: + describe("listing")
repository-core.ts: ~ const COMPARISON
repository-core.ts: ~ function createMemoryStore
repository-core.ts: ~ function createRepository
repository-core.ts: ~ interface ListOptions
repository-core.ts: - interface Page
repository-core.ts: ~ interface Repository
repository-core.ts: ~ interface StoreQuery

## idStyle=plain

roles: binding, example, test
order-repository-example.ts: ~ function openOrders
order-repository-example.ts: ~ import "./order-repository.js"
order-repository.test.ts: ~ describe("filtering")
order-repository.test.ts: ~ describe("paging")
order-repository.test.ts: ~ describe("reading")
order-repository.test.ts: ~ describe("writing")
order-repository.test.ts: ~ function seeded
order-repository.test.ts: ~ import "./order-repository.js"
order-repository.ts: - const orderIdBrand
order-repository.ts: - function orderId
order-repository.ts: ~ type OrderId

## emitScope=core-only

roles: binding, example, test
+file repository-core-example.ts
+file repository-core.test.ts
-file order-repository-example.ts
-file order-repository.test.ts
-file order-repository.ts

## emitScope=binding-only

refused: missing_required_option

## includeTests=false

roles: test
-file order-repository.test.ts
