---
name: principle-test-behavior-not-implementation
description: "Review whether tests protect observable behavior and can detect concrete regressions."
disable-model-invocation: true
---

# Test Behavior, Not Implementation

Exercise the interface that owns the behavior and assert what its caller can observe. Name the condition, the promise, and a plausible defect the assertion would catch.

Try a targeted negative control when the answer is unclear. Returning `undefined` can catch a test that never checks a required result. It cannot tell you whether a test detects a wrong but well-formed result. For a validator that must return no diagnostics for valid source, use an empty-list assertion and check that invalid source reports the expected diagnostic.

Check these patterns before changing a test.

- **Weak assertion.** Assert the value, type, absence, or failure the contract calls for. A truthiness or length check can be enough when that is the observable promise.
- **Interaction only.** Check the payload or state when it represents the outcome. Keep call and ordering assertions when the interaction itself is a protocol contract.
- **Self-referential expectation.** Use an independent expected result when both sides exercise the same implementation.
- **Constant pin.** Exercise the behavior controlled by the value. Keep the literal assertion when downstream consumers depend on that exact value.
- **Fixture asserts fixture.** Verify that the subject actually ran and that the assertion observes its output or side effects.

Rewrite a weak assertion around the maintained behavior. Remove a test only when the behavior is obsolete or another test detects the same defect at the owning interface. Preserve real absence checks, cross-table invariants, and compiler assertions.
