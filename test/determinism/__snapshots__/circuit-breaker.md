# circuit-breaker

## failureCounting=rolling-window

roles: core, test
order-circuit-breaker.test.ts: ~ const policy
order-circuit-breaker.test.ts: ~ describe("what counts as a failure")
order-circuit-breaker.ts: ~ class OrderCircuitBreaker
order-circuit-breaker.ts: ~ const DEFAULT_ORDER_BREAKER_POLICY
order-circuit-breaker.ts: ~ interface OrderBreakerPolicy
order-circuit-breaker.ts: ~ type BreakerState

## halfOpen=sampled

roles: core, test
order-circuit-breaker.test.ts: ~ const policy
order-circuit-breaker.test.ts: ~ describe("opening")
order-circuit-breaker.test.ts: ~ describe("probing for recovery")
order-circuit-breaker.ts: ~ class OrderCircuitBreaker
order-circuit-breaker.ts: ~ const DEFAULT_ORDER_BREAKER_POLICY
order-circuit-breaker.ts: ~ interface OrderBreakerPolicy
order-circuit-breaker.ts: ~ type BreakerState

## includeTests=false

roles: test
-file order-circuit-breaker.test.ts
